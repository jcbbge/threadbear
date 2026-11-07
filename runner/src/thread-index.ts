// The sidebar table (step 6 part 2, docs/step6-plan.md): this runner's
// threads as small `threadIndex` rows in the backend, and the other
// runners' rows watched live and handed to the Mac app as
// `remoteThreads.updated`, so the app lists every runner's threads and only
// talks to another runner while one of its threads is open. Runners never
// talk to each other; the backend is between them.
//
// A row is written only when something a sidebar row shows changes. The
// preview line and the last activity time go up with it but never cause a
// write by themselves: they move all through a turn, and a write is what
// re-runs every watching query.
import fs from 'node:fs';
import path from 'node:path';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { ThreadSummary } from './protocol.ts';
import type { Notification } from './runner.ts';
import { digest } from './sync-cache.ts';
import { forbiddenText, type Post, type Subscribe } from './sync.ts';

export type IndexRow = {
  threadId: string;
  title: string;
  cwd: string;
  accountId: string;
  provider: string;
  model?: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
  preview: string;
  createdAt: string;
  lastActivityAt: string;
  snoozedUntil?: string;
  archivedAt?: string;
  starredAt?: string;
  startedBy?: { kind: string; label: string; icon?: string; threadTitle?: string; why?: string };
  asked?: string;
};

// What the Mac app gets (docs/protocol.md, "Other runners' threads").
export type RemoteRunner = { id: string; name: string; icon?: string; online: boolean; lastSeenAt: string; rpcUrl?: string; tokenFile?: string };
export type RemoteThread = IndexRow & { runnerId: string };
// `order`: Mike's runner order (backend API 58), every runner's id, this
// one's too, for the app's Settings > Runners. Left out before it's heard.
export type RemoteThreads = { runners: RemoteRunner[]; threads: RemoteThread[]; order?: string[] };

type RawRunner = { runnerId: string; name: string; icon?: string; lastSeenAt: number; rpcUrl?: string };
type SinceRow = RemoteThread & { updatedMs?: number; deleted?: boolean };

const FLUSH_MS = 1000;
const BATCH = 50;
// As on the phone: not heard from for this long is offline.
const ONLINE_MS = 3 * 60_000;
// The other runners' threads are watched only while a Mac app is
// connected, and for a while after it goes, so an app relaunching doesn't
// start the watch again. Each re-run of that watch reads every one of the
// other runners' rows, so a runner nobody looks at (Bruce, with no app)
// watching a busy Mac's 500 threads was three quarters of the backend's
// database reads (docs/convex-backend.md, "Usage and the free plan").
const WATCH_CHECK_MS = 15_000;
const UNWATCH_AFTER_MS = 2 * 60_000;

export function toIndexRow(t: ThreadSummary, withStartedBy = true, withStars = true, withAsked = true): IndexRow {
  const row: IndexRow = {
    threadId: t.id,
    title: t.title,
    cwd: t.cwd,
    accountId: t.accountId,
    provider: t.provider,
    status: t.status,
    needsYou: t.needsYou,
    unread: t.lastSeq > t.lastSeenSeq,
    preview: t.preview,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
  };
  if (t.model) row.model = t.model;
  if (t.snoozedUntil) row.snoozedUntil = t.snoozedUntil;
  if (t.archivedAt) row.archivedAt = t.archivedAt;
  if (withStars && t.starredAt) row.starredAt = t.starredAt;
  // Changes only when Mike sends, which moves the status anyway, so it
  // costs no writes of its own.
  if (withAsked && t.asked) row.asked = t.asked;
  if (withStartedBy && t.startedBy) {
    // Not the thread's id: only the row's tooltip uses this, by that title.
    const { kind, label, icon, threadTitle, why } = t.startedBy;
    row.startedBy = { kind, label, ...(icon ? { icon } : {}), ...(threadTitle ? { threadTitle } : {}), ...(why ? { why } : {}) };
  }
  return row;
}

// The part of a row that decides whether it's written.
function writeKey(r: IndexRow): string {
  const { preview: _p, lastActivityAt: _l, ...rest } = r;
  return digest(JSON.stringify(rest));
}

// Where another runner's token goes on this Mac, copied in once, so the app
// can open its threads (`tokenFile` on RemoteRunner).
export function runnerTokenFile(home: string, runnerId: string): string {
  return path.join(home, 'secrets', 'runners', `${runnerId}.token`);
}

export class ThreadIndex {
  private deps: {
    post: Post;
    subscribe?: Subscribe;
    key?: string;
    runnerId: string;
    home: string;
    host: { list(include: ('inbox' | 'snoozed' | 'archived')[]): ThreadSummary[]; onNotification(fn: (n: Notification) => void): () => void };
    publish?: (n: Notification) => void;
    clock: Clock;
    log: Logger;
    // Whether the backend's validator knows startedBy (API 23). It would turn
    // the whole batch down otherwise, and the sidebar would stop updating.
    takesStartedBy?: () => boolean;
    takesStars?: () => boolean;
    // Whether it knows `asked` (API 32).
    takesAsked?: () => boolean;
    // Whether the backend can answer with only the rows changed since the
    // last answer (API 29). Without it, every re-run reads every row.
    takesSince?: () => boolean;
    // Whether the backend has the runner order for the main key (API 58).
    takesOrder?: () => boolean;
    // Whether a Mac app is connected to this runner. Only an app shows the
    // other runners' threads, so with none there's nothing to watch them
    // for. Left out, they're always watched.
    appConnected?: () => boolean;
    // What was sent before the runner last stopped (sync-cache.ts): a start
    // then writes only what changed, and doesn't read every row to prune.
    seed?: () => { at: number; rows: Record<string, string>; removed?: string[]; archived?: boolean } | undefined;
    onSent?: () => void;
    // A thread finishing on the release that handed over (sync.ts SyncDeps).
    elsewhere?: (threadId: string) => boolean;
  };
  private running = false;
  private sent = new Map<string, string>(); // threadId -> writeKey as sent
  private fullAt = 0;
  private removing: string[] = []; // on their way: saved with the rest
  private dirty = new Map<string, IndexRow>();
  private removed = new Set<string>();
  private full = true;
  private timer?: TimerHandle;
  private flushing = false;
  private unlisten?: () => void;
  private unsubscribe?: () => void;
  private remote: RemoteThreads = { runners: [], threads: [] };
  // Mike's runner order, watched with the other runners (API 58).
  private order?: string[];
  private unsubOrder?: () => void;
  // A backend before API 54 dropped a runner key's archived rows while this
  // remembered them as sent: they go once more, then this says so (snapshot).
  private archivedSent = false;
  private archivedWanted = false;
  // The backend said this runner's key can't read other runners' threads.
  private refused = false;
  // Whether the list has had the backend's answer since the watch started
  // (or been refused), so the agent tools wait for it only until then.
  private answered = false;
  private watchTimer?: TimerHandle;
  private appGoneAt?: number;
  // Watching only what changed (API 29): the other runners, their rows by
  // thread, and per runner the newest updatedMs heard, which the rows
  // subscription asks from. A runner with no entry gets all its rows.
  private watchingSince = false;
  private runnersHeard: RawRunner[] = [];
  private rows = new Map<string, Map<string, RemoteThread>>();
  private since = new Map<string, number>();
  private rowsKey?: string;
  private unsubRows?: () => void;

  constructor(deps: ThreadIndex['deps']) {
    this.deps = deps;
  }

  /** Once a heartbeat says the backend has the table (API 12). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.full = true;
    const seed = this.deps.seed?.();
    if (seed) {
      this.sent = new Map(Object.entries(seed.rows));
      this.fullAt = seed.at;
      this.archivedSent = seed.archived === true;
      this.full = false;
      const here = new Set(this.deps.host.list(['inbox', 'snoozed', 'archived']).map((t) => t.id));
      for (const id of seed.removed ?? []) if (!here.has(id)) this.removed.add(id);
      // One the file says is up whose thread isn't here (nor finishing on the
      // release before): deleted while sync wasn't listening. A start from the
      // file has no full write to drop it. Written again if it turns up.
      for (const id of [...this.sent.keys()]) {
        if (here.has(id) || this.deps.elsewhere?.(id)) continue;
        this.sent.delete(id);
        this.removed.add(id);
      }
    }
    for (const t of this.deps.host.list(['inbox', 'snoozed', 'archived'])) this.mark(t);
    this.unlisten = this.deps.host.onNotification((n) => {
      if (n.method === 'thread.updated') this.mark(n.params.thread);
      else if (n.method === 'thread.deleted') {
        this.dirty.delete(n.params.threadId);
        this.sent.delete(n.params.threadId);
        this.removed.add(n.params.threadId);
        this.deps.onSent?.();
      } else return;
      this.schedule();
    });
    if (this.archivedWanted) {
      this.archivedWanted = false;
      this.resendArchived();
    }
    this.schedule(0);
    this.appGoneAt = undefined;
    if (this.deps.appConnected) this.checkWatch();
    else this.watch();
    this.deps.log.info('thread index on', { threads: this.dirty.size, watching: Boolean(this.unsubscribe) });
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
    this.watchTimer?.cancel();
    this.watchTimer = undefined;
    this.unlisten?.();
    this.unwatch();
  }

  /** remoteThreads.list. Empty until the backend has answered. An app
   * asks for it as it connects, so this starts the watch at once rather
   * than at the next check; the answer comes as remoteThreads.updated. */
  list(): RemoteThreads {
    if (this.running) {
      this.appGoneAt = undefined;
      this.watch();
    }
    return this.withTokens(this.remote);
  }

  /** Whether the list has had an answer (or a refusal) to give, for a caller that can wait a moment for one. */
  heard(): boolean {
    return this.answered || !this.running || !this.deps.subscribe;
  }

  /** What was last heard, without starting the watch or looking for token files (relay.ts asks on every request). */
  current(): RemoteThreads {
    return this.remote;
  }

  private watch(): void {
    if (this.unsubscribe || !this.deps.subscribe || this.refused) return;
    // What was heard before may be old by now: the tools wait for this watch's answer.
    this.answered = false;
    const failed = (e: Error) => this.watchFailed(e);
    this.watchOrder();
    this.watchingSince = this.deps.takesSince?.() ?? false;
    if (this.watchingSince) {
      // A heartbeat re-runs only this small read; the rows are watched
      // apart, from where the last answer left off (resubscribeRows).
      this.unsubscribe = this.deps.subscribe('sync:otherRunnersList', { key: this.deps.key, runnerId: this.deps.runnerId }, (v) => this.onRunners(v), failed);
      return;
    }
    this.unsubscribe = this.deps.subscribe('sync:otherRunnersThreads', { key: this.deps.key, runnerId: this.deps.runnerId }, (v) => {
      // The whole list in one answer (before API 29). With API 29,
      // onRunners and onRows say when it's in, as both come through onRemote.
      this.answered = true;
      this.onRemote(v);
    }, failed);
  }

  // What was last heard stays, so an app connecting again sees the other
  // runners' threads straight away, and the watch then brings them up to date.
  private unwatch(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubOrder?.();
    this.unsubOrder = undefined;
    this.unsubRows?.();
    this.unsubRows = undefined;
    this.rowsKey = undefined;
    this.since.clear();
    this.rows.clear();
    this.runnersHeard = [];
  }

  // One small row, re-run only when Mike moves a runner. A failure leaves
  // the app's list in the order it had, so it's only logged.
  private watchOrder(): void {
    if (this.unsubOrder || !this.deps.subscribe || !this.deps.takesOrder?.()) return;
    this.unsubOrder = this.deps.subscribe(
      'sync:runnerOrder',
      { key: this.deps.key },
      (v) => {
        this.order = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        this.remote = { ...this.remote, order: this.order };
        this.deps.publish?.({ method: 'remoteThreads.updated', params: this.withTokens(this.remote) });
      },
      (e) => this.deps.log.warn('the runner order subscription failed', { error: String(e) }),
    );
  }

  private onRunners(v: unknown): void {
    this.runnersHeard = Array.isArray(v) ? (v as RawRunner[]) : [];
    if (!this.runnersHeard.length) this.answered = true;
    const ids = new Set(this.runnersHeard.map((r) => r.runnerId));
    for (const id of [...this.rows.keys()]) if (!ids.has(id)) this.rows.delete(id);
    for (const id of [...this.since.keys()]) if (!ids.has(id)) this.since.delete(id);
    this.resubscribeRows();
    this.publishHeard();
  }

  // Asks again from the newest row heard. The first answer after that is
  // only the row(s) at that time, already had; a change re-runs it with
  // just the changed rows, which moves `since` on and asks again.
  private resubscribeRows(): void {
    if (!this.deps.subscribe) return;
    const asked = this.runnersHeard.map((r) => (this.since.has(r.runnerId) ? { runnerId: r.runnerId, since: this.since.get(r.runnerId)! } : { runnerId: r.runnerId }));
    const key = JSON.stringify(asked);
    if (key === this.rowsKey) return;
    this.unsubRows?.();
    this.unsubRows = undefined;
    this.rowsKey = key;
    if (!asked.length) return;
    this.unsubRows = this.deps.subscribe(
      'sync:threadIndexSince',
      { key: this.deps.key, runners: asked },
      (v) => {
        if (this.rowsKey === key) this.onRows(v, asked);
      },
      (e) => this.watchFailed(e),
    );
  }

  // Only the owner key reads other runners' threads (docs/protocol.md,
  // "Runner keys"): with a runner key the watch is off for good, said
  // once, and this runner's app lists only its own threads. Writing this
  // runner's own rows carries on.
  private watchFailed(e: Error): void {
    // Nothing more coming to wait for: the tools use what was last heard.
    this.answered = true;
    const refused = forbiddenText(e);
    if (!refused) {
      this.deps.log.warn('the other runners’ threads subscription failed', { error: String(e) });
      return;
    }
    if (!this.refused) this.deps.log.info('not watching the other runners’ threads: this runner has a runner key, and only the main Mac’s key reads them', { error: refused });
    this.refused = true;
    this.unwatch();
  }

  private onRows(v: unknown, asked: { runnerId: string; since?: number }[]): void {
    this.answered = true;
    const got = Array.isArray(v) ? (v as SinceRow[]) : [];
    for (const a of asked) {
      const mine = got.filter((r) => r.runnerId === a.runnerId);
      // All of its rows: what was held for it goes.
      const rows = a.since === undefined ? new Map<string, RemoteThread>() : (this.rows.get(a.runnerId) ?? new Map<string, RemoteThread>());
      let newest = this.since.get(a.runnerId) ?? 0;
      for (const r of mine) {
        const { updatedMs, deleted, ...row } = r;
        if (updatedMs !== undefined && updatedMs > newest) newest = updatedMs;
        if (deleted) rows.delete(row.threadId);
        else rows.set(row.threadId, row);
      }
      this.rows.set(a.runnerId, rows);
      this.since.set(a.runnerId, newest);
    }
    this.publishHeard();
    this.resubscribeRows();
  }

  private publishHeard(): void {
    this.onRemote({ runners: this.runnersHeard, threads: [...this.rows.values()].flatMap((m) => [...m.values()]) });
  }

  private checkWatch(): void {
    if (!this.running || !this.deps.appConnected) return;
    const now = this.deps.clock.now();
    if (this.deps.appConnected()) {
      this.appGoneAt = undefined;
      if (!this.unsubscribe && !this.refused) {
        this.watch();
        this.deps.log.info('watching the other runners’ threads: an app is connected');
      }
    } else if (this.unsubscribe) {
      this.appGoneAt ??= now;
      if (now - this.appGoneAt >= UNWATCH_AFTER_MS) {
        this.unwatch();
        this.deps.log.info('stopped watching the other runners’ threads: no app connected');
      }
    }
    this.watchTimer = this.deps.clock.setTimeout(() => this.checkWatch(), WATCH_CHECK_MS);
  }

  /** For sync-cache.ts: undefined until a full write has finished. */
  snapshot(): { at: number; rows: Record<string, string>; removed?: string[]; archived?: boolean } | undefined {
    if (this.full || !this.fullAt) return undefined;
    return { at: this.fullAt, rows: Object.fromEntries(this.sent), ...(this.archivedSent ? { archived: true } : {}), ...(this.removed.size || this.removing.length ? { removed: [...new Set([...this.removed, ...this.removing])] } : {}) };
  }

  /** The deployment doesn't know this runner: everything goes again. */
  forgetSent(): void {
    if (!this.running) return;
    this.sent.clear();
    this.full = true;
    for (const t of this.deps.host.list(['inbox', 'snoozed', 'archived'])) this.mark(t);
    this.schedule();
  }

  /** The backend got new enough for what rows held back: they go again. */
  /** Once a backend keeps a runner key's archived rows (API 54): those it dropped go again, once. */
  resendArchived(): void {
    if (this.archivedSent) return;
    // Heard before the index has started (the heartbeat comes first): at start.
    if (!this.running) {
      this.archivedWanted = true;
      return;
    }
    this.archivedSent = true;
    let n = 0;
    for (const t of this.deps.host.list(['archived'])) {
      if (!t.archivedAt) continue;
      this.sent.delete(t.id);
      this.mark(t);
      n++;
    }
    if (n) this.deps.log.info('thread index: sending archived threads again', { threads: n });
    this.schedule();
  }

  refresh(): void {
    if (!this.running) return;
    // Now able to watch only what changed: start the watch over that way.
    if (this.unsubscribe && !this.watchingSince && this.deps.takesSince?.()) {
      this.unwatch();
      this.watch();
    }
    // The backend's taken the runner order since the watch began.
    if (this.unsubscribe) this.watchOrder();
    for (const t of this.deps.host.list(['inbox', 'snoozed', 'archived'])) this.mark(t);
    this.schedule();
  }

  private mark(t: ThreadSummary): void {
    const row = toIndexRow(t, this.deps.takesStartedBy?.() ?? true, this.deps.takesStars?.() ?? true, this.deps.takesAsked?.() ?? true);
    if (this.sent.get(t.id) === writeKey(row)) {
      this.dirty.delete(t.id);
      return;
    }
    this.removed.delete(t.id);
    this.removing = this.removing.filter((id) => id !== t.id);
    this.dirty.set(t.id, row);
  }

  private schedule(ms = FLUSH_MS): void {
    if (!this.running || this.timer) return;
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
  }

  private async flush(): Promise<void> {
    if (!this.running || this.flushing) return;
    if (!this.dirty.size && !this.removed.size && !this.full) return;
    this.flushing = true;
    const rows = [...this.dirty.values()];
    this.removing = [...this.removed];
    const full = this.full;
    this.dirty.clear();
    this.removed.clear();
    try {
      const keep = full ? this.deps.host.list(['inbox', 'snoozed', 'archived']).map((t) => t.id) : undefined;
      for (let i = 0; i < Math.max(rows.length, 1); i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const last = i + BATCH >= rows.length;
        await this.deps.post('mutation', 'sync:setThreadIndex', {
          key: this.deps.key,
          runnerId: this.deps.runnerId,
          rows: batch,
          removed: last ? this.removing : [],
          ...(last && keep ? { keep } : {}),
        });
        for (const r of batch) this.sent.set(r.threadId, writeKey(r));
      }
      if (full) {
        this.full = false;
        this.fullAt = this.deps.clock.now();
      }
      const wentAny = this.removing.length > 0;
      this.removing = [];
      if (rows.length || wentAny || full) this.deps.onSent?.();
    } catch (e) {
      // Put back what didn't go, unless something newer is waiting.
      for (const r of rows) if (!this.dirty.has(r.threadId) && this.sent.get(r.threadId) !== writeKey(r)) this.dirty.set(r.threadId, r);
      for (const id of this.removing) this.removed.add(id);
      this.removing = [];
      this.deps.log.warn('could not write the thread index; trying again', { error: String(e) });
      this.flushing = false;
      this.schedule(15_000);
      return;
    }
    this.flushing = false;
    if (this.dirty.size || this.removed.size) this.schedule();
  }

  private onRemote(v: unknown): void {
    const value = v as { runners?: RawRunner[]; threads?: RemoteThread[] } | null;
    const now = this.deps.clock.now();
    this.remote = {
      runners: (value?.runners ?? [])
        .filter((r) => r.lastSeenAt > 0 || (value?.threads ?? []).some((t) => t.runnerId === r.runnerId))
        .map((r) => ({
          id: r.runnerId,
          name: r.name,
          ...(r.icon ? { icon: r.icon } : {}),
          online: now - r.lastSeenAt < ONLINE_MS,
          lastSeenAt: new Date(r.lastSeenAt).toISOString(),
          ...(r.rpcUrl ? { rpcUrl: r.rpcUrl } : {}),
        })),
      threads: value?.threads ?? [],
      ...(this.order ? { order: this.order } : {}),
    };
    this.deps.publish?.({ method: 'remoteThreads.updated', params: this.withTokens(this.remote) });
  }

  // The token file is named only when it's there: no file, no way in.
  private withTokens(r: RemoteThreads): RemoteThreads {
    return {
      ...r,
      threads: r.threads,
      runners: r.runners.map((x) => {
        const file = runnerTokenFile(this.deps.home, x.id);
        return fs.existsSync(file) ? { ...x, tokenFile: file } : x;
      }),
    };
  }
}
