// Other runners' threads through the backend (docs/protocol.md, "Other
// runners' threads through the backend"; full Convex step 5). The Mac app
// asks its own runner about another runner's thread as it would about one of
// this runner's, and this answers from the backend: the thread's message rows
// become transcript events, and what the app does to it (send, approve, stop,
// archive) goes to that runner as a `commands` row, as the phone's does. The
// app needs no Convex of its own and no link to the other Mac.
//
// The backend has a thread's text, one line per tool call, its open approval
// and its card. A tool row's result says the output is kept on that runner, and
// carries `heldBack: { seq }`: opening that tool in the app asks for it
// (threads.heldBody), and if that runner has full sync on (docs/full-convex.md
// step 4) its output comes from the backend, once, as more events for the row.
//
// Seqs. The rows' seqs are the other runner's event seqs, with gaps where
// events weren't mirrored. Each row's seq s becomes eight here: 8s a
// turn.started, 8s+1 the row's own event, 8s+2 a tool's result, 8s+3 and
// 8s+4 a card from an older runner that didn't say its seq (placed after the
// newest row when first seen) and its answer (or else a fetched tool's diffs),
// 8s+5 and 8s+6 a fetched tool's real call and result, 8s+7 its turn's end. A card
// whose event seq p is known goes at 8p+1 and its answer at 8p+2 (p is never
// a row's seq). So events made up from a row sit right beside it and stay in
// order, and every one has a seq of its own. The app takes these threads' events with gaps
// and late ones (ThreadFeed's sparse mode), and pages by these seqs.
//
// Reads (docs/full-convex.md, "Read rules"): a thread is watched only while
// an app has it subscribed, through a 15-row tail and its one threads row;
// older rows are read once by page and kept here, and a tail that skips past
// what's held reads the gap once rather than leave a hole.
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { Notification } from './runner.ts';
import type { RemoteThread, RemoteThreads } from './thread-index.ts';
import fs from 'node:fs';
import { convexUploader, type Post, type Subscribe, type Upload } from './sync.ts';
import { ErrorCode, RpcError, remoteCreateMode, type ImageRef } from './protocol.ts';
import { seal } from './secrets.ts';

export const SCALE = 8;
// The thread's row says it has stopped a moment before its last messages
// arrive (the other runner writes rows, then messages): its turn ends only
// once it has said so for this long.
const SETTLE_MS = 4000;
const TAIL = 15;
// How long a change made from here outranks the other runner's row in
// replies (Relay.changed): the row catches up within seconds.
const CHANGED_MS = 60_000;
// Reading a shared thread's link from its row: an older runner writes the
// row with its next batch rather than at once.
const SHARE_READS = 5;
const SHARE_READ_MS = 1000;
// Hibernating until that runner restarts (runner.ts's UNTIL_RESTART, not
// imported so this module doesn't load the whole runner).
const UNTIL_RESTART = '9999-12-31T00:00:00.000Z';
const PAGE = 50;
// A watch nobody has subscribed for this long stops; its rows stay a while,
// so opening the thread again reads only what's new.
const IDLE_MS = 60_000;
const FORGET_MS = 30 * 60_000;
const SWEEP_MS = 15_000;
// How long an action waits to hear the other runner took it.
const TAKE_MS = 20_000;
const CALL_MS = 30_000;

// sync:remoteBody's answer: null, or one that's gone, says nothing new.
export type HeldBody =
  | { state: 'text'; text: string; ok?: boolean; truncated?: boolean; input?: string; diffs?: string; images?: number; cut?: boolean }
  | { state: 'withheld'; reason?: string }
  | { state: 'expired' }
  | null;

export type RelayRow = {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  origin?: string;
  toolKind?: string;
  summary?: boolean;
  turn?: string;
  wokeBy?: { kind: string; description: string }[];
  at: string;
};
type Page = { messages: RelayRow[]; hasMore: boolean };

type Pending =
  | { approvalId: string; kind: 'approval'; seq?: number; name: string; title: string; options: string[]; inputSummary?: string }
  | { approvalId: string; kind: 'question'; seq?: number; questions: unknown[] }
  | { approvalId: string; kind: 'secret'; seq?: number; label: string; reason: string; placeholder?: string; key: string };
export type RelayThreadRow = {
  runnerId: string;
  status: string;
  needs?: 'you' | 'nothing';
  pendingApproval?: Pending;
  asks?: { action: string; why?: string; reply?: string; options?: string[]; suggested?: number; links?: { title: string; url: string }[]; ticked?: boolean }[];
  asksSeq?: number;
  next?: string[];
  lastActivityAt?: string;
  // Whether it's shared (the threads row's `share`; the sidebar's table has none).
  share?: { access?: string; slug?: unknown };
};

// slot: the request's relay seq; the answer goes at slot + 1.
export type Card = { pending: Pending; slot: number; resolved?: { decision: string; message?: string } };
type Watch = {
  threadId: string;
  runnerId: string;
  rows: Map<number, RelayRow>;
  olderMore: boolean;
  loaded: boolean;
  row: RelayThreadRow | null;
  cards: Map<string, Card>;
  // What Mike answered from here, for the card's resolution.
  decided: Map<string, { decision: string; message?: string }>;
  // Tools opened in the app, each fetched once (threads.heldBody).
  bodies: Map<number, HeldBody>;
  // Seqs already given to the app, in pages or live.
  given: Set<number>;
  unsub: (() => void)[];
  idleSince?: number;
  usedAt: number;
  filling?: Promise<void>;
  // Rows a tail skipped that couldn't all be read yet: tried again with the next tail.
  hole?: { after: number; until: number };
  // When the row last said it isn't running (SETTLE_MS), and the timer that emits then.
  stoppedAt?: number;
  settleTimer?: TimerHandle;
  // When it was last read whole (load or refresh), so an events-then-subscribe doesn't read twice.
  readAt?: number;
  // The share the app was last told of (noteRow), as JSON.
  shareSaid?: string;
};

export type RelayEvent = { seq: number; ts: string; threadId: string; turnId?: string; type: string; [k: string]: unknown };

export type RelaySource = { post: Post; subscribe?: Subscribe; key: string };
export type RelayDeps = {
  // The backend, with the owner key; undefined while sync is off or the
  // backend is older than API 44 (sync.ts relaySource).
  source: () => RelaySource | undefined;
  // Other runners and their threads, as the sidebar has them (thread-index.ts).
  remote: () => RemoteThreads;
  publish: (n: Notification) => void;
  // Whether an app connection is subscribed to the thread (rpc.ts).
  subscribed: (threadId: string) => boolean;
  clock: Clock;
  log: Logger;
  // Pictures pasted on this Mac go to file storage for the other runner to
  // fetch, as the phone's photos do (tests pass a fake).
  upload?: Upload;
  readFile?: (path: string) => Uint8Array;
};

// What the other runner takes per picture (sync.ts MAX_PHONE_IMAGE_BYTES)
// and per message (convex/relay.ts MAX_RELAY_IMAGES).
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES = 6;

const RUNNING = new Set(['running', 'starting', 'waiting']);
const TOOL_NAMES: Record<string, string> = { command: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', search: 'Grep', web: 'WebFetch', task: 'Task' };

/** A thread's held rows and row as transcript events, oldest first, in relay seqs. Pure, so a page and the live stream agree. */
export function relayEvents(threadId: string, rows: RelayRow[], row: RelayThreadRow | null, cards: Card[], olderMore: boolean, runnerName: string, settled = true, bodies?: Map<number, HeldBody>): RelayEvent[] {
  const out: RelayEvent[] = [];
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  // Stopped only once it has said so for a moment (SETTLE_MS).
  const running = row ? RUNNING.has(row.status) || !settled : true;
  const env = (seq: number, r: RelayRow, body: Record<string, unknown>): RelayEvent => ({ seq, ts: r.at, threadId, ...(r.turn ? { turnId: r.turn } : {}), ...body }) as RelayEvent;
  const turnStart = new Map<string, string>();
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const base = r.seq * SCALE;
    if (r.turn && (prev ? prev.turn !== r.turn : !olderMore)) {
      out.push(env(base, r, { type: 'turn.started', turnId: r.turn, ...(r.wokeBy ? { wokeBy: r.wokeBy } : {}) }));
    }
    if (r.turn && !turnStart.has(r.turn)) turnStart.set(r.turn, r.at);
    if (r.role === 'user') {
      out.push(env(base + 1, r, { type: 'user.message', text: r.text, images: [], ...(r.origin === 'phone' || r.origin === 'runner' || r.origin === 'schedule' ? { origin: r.origin } : {}) }));
    } else if (r.role === 'assistant') {
      out.push(env(base + 1, r, { type: 'assistant.text', itemId: `relay-${r.seq}`, text: r.text, ...(r.summary ? { summary: true } : {}) }));
    } else {
      const kind = r.toolKind ?? 'other';
      const itemId = `relay-${r.seq}`;
      out.push(env(base + 1, r, { type: 'tool.call', itemId, name: TOOL_NAMES[kind] ?? 'Tool', kind, title: r.text, input: {} }));
      // Finished once anything follows it, or its turn has ended.
      if (next || !running) {
        out.push(env(base + 2, r, { type: 'tool.result', itemId, ok: true, text: `The output is kept on ${runnerName}.`, truncated: false, images: [], heldBack: { seq: r.seq } }));
        const body = bodies?.get(r.seq);
        if (body?.state === 'withheld') {
          out.push(env(base + 6, r, { type: 'tool.result', itemId, ok: true, text: `This is kept on ${runnerName}: what this tool read or ran can hold secrets, so its output doesn't go through Convex.`, truncated: false, images: [] }));
        } else if (body?.state === 'text') {
          // The app fills in the row it has from these, by itemId.
          let input: Record<string, unknown> = {};
          try {
            const parsed = body.input ? JSON.parse(body.input) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
          } catch {
            // Shown without it.
          }
          out.push(env(base + 5, r, { type: 'tool.call', itemId, name: TOOL_NAMES[kind] ?? 'Tool', kind, title: r.text, input }));
          let diffs: { path: string; hunks: unknown[] }[] = [];
          try {
            const parsed = body.diffs ? JSON.parse(body.diffs) : [];
            if (Array.isArray(parsed)) diffs = parsed.filter((d) => typeof d?.path === 'string').map((d) => ({ path: d.path, hunks: Array.isArray(d.hunks) ? d.hunks : [] }));
          } catch {
            // Likewise.
          }
          // Two seqs for diffs, unless an old runner's card is on them. A tool that
          // changed more files says which.
          const free = [base + 3, base + 4].filter((seq) => !cards.some((c) => c.slot === seq || c.slot + 1 === seq));
          const shown = diffs.slice(0, free.length);
          shown.forEach((d, n) => out.push(env(free[n]!, r, { type: 'edit.diff', itemId, path: d.path, hunks: d.hunks })));
          const more = diffs.slice(shown.length).map((d) => d.path);
          const pictures = body.images ? `${body.images === 1 ? '1 picture is' : `${body.images} pictures are`} kept on ${runnerName}.` : '';
          const notes = [more.length ? `Also changed: ${more.join(', ')}` : '', pictures].filter(Boolean).join('\n');
          out.push(env(base + 6, r, { type: 'tool.result', itemId, ok: body.ok !== false, text: body.text + (notes ? `${body.text ? '\n\n' : ''}${notes}` : ''), truncated: body.truncated === true || body.cut === true, images: [] }));
        }
      }
    }
    const ends = r.turn && (next ? next.turn !== r.turn : row !== null && !running);
    if (ends) {
      const started = Date.parse(turnStart.get(r.turn!) ?? r.at);
      const last = !next;
      // Each with its `ticked: true`, as the summary has them: the relay
      // has no seq after the turn's end for an asks.ticked, and without
      // them a finished checklist read as outstanding again.
      const asks = last && row?.needs === 'you' && row.asks?.length ? row.asks.map(({ ticked, ...a }) => (ticked ? { ...a, ticked: true } : a)) : undefined;
      out.push(
        env(base + 7, r, {
          type: 'turn.completed',
          turnId: r.turn,
          outcome: 'completed',
          durationMs: Math.max(0, Date.parse(r.at) - (Number.isFinite(started) ? started : Date.parse(r.at))),
          ...(last && row?.needs ? { needs: row.needs } : {}),
          ...(asks ? { asks } : {}),
          ...(last && row?.needs === 'nothing' && row.next?.length ? { next: row.next } : {}),
        }),
      );
    }
  }
  // Cards go where their event was: in the turn of the row before them.
  for (const c of cards) {
    const before = [...sorted].reverse().find((r) => r.seq * SCALE <= c.slot);
    const at = before?.at ?? row?.lastActivityAt ?? new Date(0).toISOString();
    const turn = before?.turn ? { turnId: before.turn } : {};
    const p = c.pending;
    const body =
      p.kind === 'approval'
        ? { type: 'approval.requested', approvalId: p.approvalId, name: p.name, title: p.title, input: p.inputSummary ? { [inputKey(p.name, p.inputSummary)]: p.inputSummary } : {}, options: p.options }
        : p.kind === 'question'
          ? { type: 'question.requested', approvalId: p.approvalId, questions: p.questions }
          : { type: 'secret.requested', approvalId: p.approvalId, label: p.label, reason: p.reason, ...(p.placeholder ? { placeholder: p.placeholder } : {}) };
    out.push({ seq: c.slot, ts: at, threadId, ...turn, ...body } as RelayEvent);
    if (c.resolved) out.push({ seq: c.slot + 1, ts: at, threadId, ...turn, type: 'approval.resolved', approvalId: p.approvalId, ...c.resolved } as RelayEvent);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Brings a tail into the held rows. `gapAfter`: the tail starts past what's held, and the rows after it must be read. */
export function mergeTail(rows: Map<number, RelayRow>, tail: Page): { gapAfter?: number } {
  const newest = rows.size ? Math.max(...rows.keys()) : undefined;
  const first = tail.messages[0]?.seq;
  const gap = tail.hasMore && first !== undefined && newest !== undefined && first > newest && !rows.has(first);
  for (const m of tail.messages) rows.set(m.seq, m);
  return gap ? { gapAfter: newest } : {};
}

// Said before anything was queued for the other runner, so nothing can
// come of it there (cross-runner.ts hands a claim back on these).
export function notSent(e: unknown): unknown {
  if (e && typeof e === 'object') (e as { notSent?: boolean }).notSent = true;
  return e;
}
export function wasNotSent(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { notSent?: boolean }).notSent);
}

export class Relay {
  private deps: RelayDeps;
  private watches = new Map<string, Watch>();
  // Threads made from here that the sidebar's list doesn't have yet.
  private made = new Map<string, RemoteThread>();
  // Changes the other runner has made for us that its backend row may not
  // show yet, kept a while so each reply carries them all: otherwise a
  // markSeen answered after an archive, from the row that isn't archived
  // yet, put the thread back in the app's inbox. Each field goes once the
  // row shows it (so a later change from the phone isn't hidden) or after
  // CHANGED_MS, whichever is first.
  private changed = new Map<string, Map<keyof RemoteThread, { value: unknown; at: number }>>();
  private sweepTimer?: TimerHandle;
  private reads = 0;
  // What those reads brought back, as JSON bytes (about what Convex bills
  // for the rows they read), so the relay's I/O can be measured.
  private bytes = 0;

  constructor(deps: RelayDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.sweepTimer?.cancel();
    this.sweepTimer = undefined;
    for (const w of this.watches.values()) this.unwatch(w);
    this.watches.clear();
  }

  /** Another runner's thread the sidebar lists, which this answers for. */
  owns(threadId: string): boolean {
    return Boolean(this.deps.source() && this.find(threadId));
  }

  private src(): RelaySource {
    const s = this.deps.source();
    if (!s) throw new RpcError(ErrorCode.other, "This Mac's runner can't reach other runners through Convex now (sync is off, or Convex hasn't updated yet).");
    return s;
  }

  status(): { watching: number; held: number; reads: number; bytes: number } {
    let held = 0;
    for (const w of this.watches.values()) held += w.rows.size;
    return { watching: [...this.watches.values()].filter((w) => w.unsub.length).length, held, reads: this.reads, bytes: this.bytes };
  }

  private find(threadId: string): RemoteThread | undefined {
    const listed = this.deps.remote().threads.find((t) => t.threadId === threadId);
    if (listed) {
      this.made.delete(threadId);
      return listed;
    }
    return this.made.get(threadId);
  }

  /**
   * Another runner's thread as a ThreadSummary, from its sidebar row, as the
   * app makes one (RemoteThreads.swift, `RemoteThread.summary`): no seqs in
   * the row, so an unread one is lastSeq 1 and lastSeenSeq 0.
   */
  private summary(threadId: string): Record<string, unknown> {
    const t = this.withChanges(threadId, this.find(threadId));
    const thread: Record<string, unknown> = {
      id: threadId,
      title: t.title ?? '',
      cwd: t.cwd ?? '',
      accountId: t.accountId ?? '',
      provider: t.provider || 'claude',
      status: t.status ?? 'idle',
      needsYou: t.needsYou ?? false,
      preview: t.preview ?? '',
      lastSeq: t.unread ? 1 : 0,
      lastSeenSeq: 0,
      runnerId: t.runnerId,
    };
    for (const k of ['model', 'createdAt', 'lastActivityAt', 'snoozedUntil', 'archivedAt', 'starredAt', 'startedBy', 'asked'] as const) {
      if (t[k] !== undefined) thread[k] = t[k];
    }
    if (t.lastActivityAt) thread.updatedAt = t.lastActivityAt;
    if (t.snoozedUntil === UNTIL_RESTART) thread.snoozedUntilRestart = true;
    return thread;
  }

  /** The row with the changes made from here that it doesn't show yet (`changed`). */
  private withChanges<T extends Partial<RemoteThread>>(threadId: string, row: T | undefined): T {
    const kept = this.changed.get(threadId);
    if (!kept) return { ...row } as T;
    const now = this.deps.clock.now();
    const t: Record<string, unknown> = { ...row };
    for (const [k, c] of kept) {
      if (now - c.at >= CHANGED_MS || (row && shows(k, row[k], c.value))) kept.delete(k);
      else t[k] = c.value;
    }
    if (!kept.size) this.changed.delete(threadId);
    return t as T;
  }

  /**
   * The sidebar's list of other runners' threads (remoteThreads.list and
   * .updated) with the changes made from here on it, as the replies have
   * them: a list sent because some other thread changed, before this one's
   * row had caught up, put a thread just archived here back in the inbox.
   */
  overlay(remote: RemoteThreads): RemoteThreads {
    if (!this.changed.size) return remote;
    return { ...remote, threads: remote.threads.map((t) => (this.changed.has(t.threadId) ? this.withChanges(t.threadId, t) : t)) };
  }

  /** The thread's share as that runner's backend row has it: "people" (API 7) reads as off. */
  private async shareOf(threadId: string): Promise<Share | undefined> {
    const row = (await this.read('relay:remoteThread', { threadId })) as Pick<RelayThreadRow, 'share'> | null;
    return toShare(row?.share);
  }

  /**
   * A watched thread's share, said to the app as it changes there (the
   * website's Stop sharing or New link), and on first reading the row if
   * it's shared: the app keeps the last share it heard of through the
   * sidebar's rows, which never have one, so without this it showed a
   * dead link.
   */
  private noteShare(w: Watch): void {
    if (!w.row) return;
    const share = toShare(w.row.share);
    const said = JSON.stringify(share ?? null);
    if (said === w.shareSaid) return;
    const first = w.shareSaid === undefined;
    w.shareSaid = said;
    if (first && !share) return;
    this.deps.publish({ method: 'thread.updated', params: { thread: { ...this.summary(w.threadId), ...(share ? { share } : {}) } } } as unknown as Notification);
  }

  /** The share once the row shows it as asked, read a few times while the row catches up. */
  private async sharedAs(w: Watch, access: 'off' | 'link', notSlug?: string): Promise<Share | undefined> {
    for (let i = 0; ; i++) {
      const share = await this.shareOf(w.threadId);
      if (share && share.access === access && share.slug !== notSlug) {
        // Said in this reply, so not again when the watch sees the row.
        w.shareSaid = JSON.stringify(share);
        return share;
      }
      // Off with no link ever made: nothing to show, and nothing to wait for.
      if (access === 'off' && !share) return undefined;
      if (i >= SHARE_READS - 1) break;
      await new Promise<void>((r) => this.deps.clock.setTimeout(() => r(), SHARE_READ_MS));
    }
    // Not "done" without it: the app keeps the share it had, so an off it
    // can't confirm would still show the link as on.
    const name = this.runnerName(w.runnerId);
    throw new RpcError(ErrorCode.other, access === 'link'
      ? `${name} has shared it, but its link hasn't reached Convex yet. Open Share again in a moment.`
      : `${name} has stopped sharing it, but Convex doesn't show that yet. Open Share again in a moment.`);
  }

  /** A change the other runner has done, for replies until its row shows it (`changed`). */
  private remember(threadId: string, patch: Partial<RemoteThread>): void {
    const at = this.deps.clock.now();
    const kept = this.changed.get(threadId) ?? new Map();
    for (const [k, value] of Object.entries(patch)) kept.set(k as keyof RemoteThread, { value, at });
    this.changed.set(threadId, kept);
  }

  private runner(runnerId: string) {
    return this.deps.remote().runners.find((r) => r.id === runnerId);
  }

  private runnerName(runnerId: string): string {
    return this.runner(runnerId)?.name ?? 'the other runner';
  }

  private watch(threadId: string): Watch {
    let w = this.watches.get(threadId);
    const t = this.find(threadId);
    if (!t) throw new RpcError(ErrorCode.threadNotFound, `No thread ${threadId}.`);
    if (!w) {
      w = { threadId, runnerId: t.runnerId, rows: new Map(), bodies: new Map(), olderMore: true, loaded: false, row: null, cards: new Map(), decided: new Map(), given: new Set(), unsub: [], usedAt: this.deps.clock.now() };
      this.watches.set(threadId, w);
    }
    w.usedAt = this.deps.clock.now();
    this.sweepSoon();
    return w;
  }

  private async read(fn: string, args: Record<string, unknown>): Promise<unknown> {
    this.reads++;
    const src = this.src();
    const out = await src.post('query', fn, { key: src.key, ...args });
    this.bytes += JSON.stringify(out ?? null).length;
    return out;
  }

  private events(w: Watch): RelayEvent[] {
    const settled = w.stoppedAt === undefined || this.deps.clock.now() - w.stoppedAt >= SETTLE_MS;
    return relayEvents(w.threadId, [...w.rows.values()], w.row, [...w.cards.values()], w.olderMore, this.runnerName(w.runnerId), settled, w.bodies);
  }

  // The row's open card, kept so it stays in the transcript once answered;
  // one that's gone from the row has been answered (here, there or on the phone).
  private noteRow(w: Watch, row: RelayThreadRow | null, live = false): void {
    const wasRunning = w.row ? RUNNING.has(w.row.status) : true;
    w.row = row;
    this.noteShare(w);
    const running = row ? RUNNING.has(row.status) : true;
    // Ends its turn once its last messages have had a moment to arrive.
    if (!running && wasRunning && live) this.settle(w);
    else if (running) w.stoppedAt = undefined;
    const open = row?.pendingApproval;
    if (open && !w.cards.has(open.approvalId)) {
      // An older runner doesn't say the card's seq: after the newest row.
      // Two slots after each row (3 and 5), each with its answer one after.
      const newest = w.rows.size ? Math.max(...w.rows.keys()) : 0;
      const used = new Set([...w.cards.values()].map((c) => c.slot));
      const slot = open.seq !== undefined ? open.seq * SCALE + 1 : [3, 5].map((k) => newest * SCALE + k).find((s) => !used.has(s));
      if (slot !== undefined) w.cards.set(open.approvalId, { pending: open, slot });
    }
    for (const [id, c] of w.cards) {
      if (c.resolved || open?.approvalId === id) continue;
      c.resolved = w.decided.get(id) ?? { decision: c.pending.kind === 'approval' ? 'allow' : 'answered', message: `Answered on ${this.runnerName(w.runnerId)} or the phone.` };
    }
  }

  private async refresh(w: Watch): Promise<void> {
    const newest = w.rows.size ? Math.max(...w.rows.keys()) : 0;
    const [row] = await Promise.all([
      this.read('relay:remoteThread', { threadId: w.threadId }),
      (async () => {
        let after = newest;
        for (;;) {
          const page = (await this.read('relay:remoteMessages', { threadId: w.threadId, afterSeq: after, limit: PAGE })) as Page;
          for (const m of page.messages) w.rows.set(m.seq, m);
          const last = page.messages[page.messages.length - 1]?.seq;
          if (last === undefined || !page.hasMore) break;
          after = last;
        }
      })(),
    ]);
    this.noteRow(w, row as RelayThreadRow | null);
    w.readAt = this.deps.clock.now();
  }

  private settle(w: Watch): void {
    w.stoppedAt = this.deps.clock.now();
    w.settleTimer?.cancel();
    w.settleTimer = this.deps.clock.setTimeout(() => {
      w.settleTimer = undefined;
      this.emit(w);
    }, SETTLE_MS);
  }

  private async load(w: Watch): Promise<void> {
    if (w.loaded) {
      // Not watched (nobody subscribed since): what's held may be old, so
      // read what's come since, once, as a tail would have.
      if (!w.unsub.length && this.deps.clock.now() - (w.readAt ?? 0) > 2000) await this.refresh(w);
      return;
    }
    const [row, page] = await Promise.all([this.read('relay:remoteThread', { threadId: w.threadId }), this.read('relay:remoteMessages', { threadId: w.threadId, limit: PAGE })]);
    const p = page as Page;
    for (const m of p.messages) w.rows.set(m.seq, m);
    w.olderMore = p.hasMore;
    const r = row as RelayThreadRow | null;
    this.noteRow(w, r);
    // Stopped only just now: its last messages may still be on their way.
    w.readAt = this.deps.clock.now();
    if (r && !RUNNING.has(r.status) && r.lastActivityAt && this.deps.clock.now() - Date.parse(r.lastActivityAt) < SETTLE_MS) this.settle(w);
    w.loaded = true;
  }

  // threads.events, in relay seqs.
  private async page(w: Watch, p: { afterSeq?: number; beforeSeq?: number; limit?: number }) {
    await this.load(w);
    const limit = Math.max(1, Math.min(p.limit ?? 200, 2000));
    if (p.beforeSeq !== undefined) {
      // Older rows, read once each, until there are enough or none are left.
      const realBefore = Math.ceil(p.beforeSeq / SCALE);
      let have = [...w.rows.keys()].filter((s) => s < realBefore).length;
      while (have < Math.ceil(limit / 2) && w.olderMore) {
        const oldest = Math.min(...w.rows.keys());
        const older = (await this.read('relay:remoteMessages', { threadId: w.threadId, beforeSeq: oldest, limit: PAGE })) as Page;
        for (const m of older.messages) w.rows.set(m.seq, m);
        w.olderMore = older.hasMore;
        if (!older.messages.length) break;
        have += older.messages.length;
      }
    }
    const all = this.events(w);
    let events: RelayEvent[];
    if (p.afterSeq !== undefined) events = all.filter((e) => e.seq > p.afterSeq! && (p.beforeSeq === undefined || e.seq < p.beforeSeq)).slice(0, limit);
    else if (p.beforeSeq !== undefined) events = all.filter((e) => e.seq < p.beforeSeq!).slice(-limit);
    else events = all.slice(-limit);
    for (const e of events) w.given.add(e.seq);
    const atStart = !w.olderMore && (events.length === 0 || events[0]!.seq === all[0]?.seq);
    return {
      events,
      firstSeq: events[0]?.seq ?? 0,
      lastSeq: events.length ? events[events.length - 1]!.seq : (all[all.length - 1]?.seq ?? 0),
      inProgress: [],
      relay: { runnerId: w.runnerId, runnerName: this.runnerName(w.runnerId), ...(atStart ? { atStart: true } : {}) },
    };
  }

  private live(w: Watch): void {
    w.idleSince = undefined;
    const src = this.deps.source();
    if (w.unsub.length || !src?.subscribe) return;
    const failed = (e: Error) => this.deps.log.warn('relay watch failed', { threadId: w.threadId, error: String(e) });
    w.unsub.push(
      src.subscribe('relay:remoteTail', { key: src.key, threadId: w.threadId, limit: TAIL }, (v) => void this.onTail(w, v as Page), failed),
      src.subscribe('relay:remoteThread', { key: src.key, threadId: w.threadId }, (v) => {
        this.reads++;
        this.bytes += JSON.stringify(v ?? null).length;
        this.noteRow(w, v as RelayThreadRow | null, true);
        this.emit(w);
      }, failed),
    );
    this.deps.log.info('relay watching', { threadId: w.threadId, runnerId: w.runnerId });
  }

  private unwatch(w: Watch): void {
    for (const u of w.unsub) u();
    w.unsub = [];
    w.settleTimer?.cancel();
    w.settleTimer = undefined;
  }

  private async onTail(w: Watch, tail: Page): Promise<void> {
    this.reads++;
    this.bytes += JSON.stringify(tail).length;
    const { gapAfter } = mergeTail(w.rows, tail);
    if (gapAfter !== undefined) {
      // More arrived than the tail covers (the Mac slept, the watch was
      // off): what's between is read once, so the transcript has no hole.
      const until = tail.messages[0]!.seq;
      w.hole = { after: Math.min(w.hole?.after ?? gapAfter, gapAfter), until: Math.max(w.hole?.until ?? until, until) };
    }
    if (w.hole && !w.filling) {
      const fill = this.fill(w);
      w.filling = fill;
      try {
        await fill;
      } finally {
        if (w.filling === fill) w.filling = undefined;
      }
    }
    this.emit(w);
  }

  // Reads a hole's rows page by page, however many: bounded by the thread,
  // and each read once. One that fails stays a hole, tried with the next tail.
  private async fill(w: Watch): Promise<void> {
    try {
      while (w.hole) {
        const { after } = w.hole;
        const page = (await this.read('relay:remoteMessages', { threadId: w.threadId, afterSeq: after, limit: PAGE })) as Page;
        for (const m of page.messages) w.rows.set(m.seq, m);
        const last = page.messages[page.messages.length - 1]?.seq;
        // Against the hole as it is now: a tail meanwhile may have made it longer.
        const until = w.hole?.until ?? 0;
        if (last === undefined || !page.hasMore || last >= until) w.hole = undefined;
        else w.hole = { after: last, until };
      }
    } catch (e) {
      this.deps.log.warn('relay could not fill a gap', { threadId: w.threadId, error: String(e) });
    }
  }

  // Everything not yet given to the app from the oldest it has on: new rows,
  // and what's late (a tool's result once the next row comes, a card's answer).
  private emit(w: Watch): void {
    if (!w.loaded || !w.given.size) return;
    const from = Math.min(...w.given);
    for (const e of this.events(w)) {
      if (e.seq < from || w.given.has(e.seq)) continue;
      w.given.add(e.seq);
      this.deps.publish({ method: 'thread.event', params: { threadId: w.threadId, event: e } } as unknown as Notification);
    }
  }

  private sweepSoon(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = this.deps.clock.setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
    }, SWEEP_MS);
  }

  private sweep(): void {
    const now = this.deps.clock.now();
    for (const [id, kept] of this.changed) {
      for (const [k, c] of kept) if (now - c.at >= CHANGED_MS) kept.delete(k);
      if (!kept.size) this.changed.delete(id);
    }
    for (const [id, w] of this.watches) {
      if (this.deps.subscribed(id)) {
        w.idleSince = undefined;
        w.usedAt = now;
        continue;
      }
      w.idleSince ??= now;
      if (w.unsub.length && now - w.idleSince >= IDLE_MS) {
        this.unwatch(w);
        this.deps.log.info('relay stopped watching', { threadId: id });
      }
      if (!w.unsub.length && now - w.usedAt >= FORGET_MS) this.watches.delete(id);
    }
    if (this.watches.size) this.sweepSoon();
  }

  // ---------------------------------------------------------------- actions

  /**
   * The app's pictures (files this Mac's runner can read) put in file
   * storage, as storage ids for a send or create command. The other runner
   * fetches them as it does the phone's photos, and the backend deletes
   * them once it has (sync:finishCommand).
   */
  private async uploadImages(runnerId: string, raw: unknown): Promise<string[]> {
    if (!Array.isArray(raw) || !raw.length) return [];
    const runner = this.runner(runnerId);
    const name = runner?.name ?? 'the other runner';
    if (runner && !runner.online) throw new RpcError(ErrorCode.other, `${name} is offline, so that can't reach it now.`);
    if (raw.length > MAX_IMAGES) throw new RpcError(ErrorCode.other, `At most ${MAX_IMAGES} pictures can go to ${name} in one message.`);
    const src = this.src();
    const read = this.deps.readFile ?? ((file: string) => fs.readFileSync(file));
    const upload = this.deps.upload ?? convexUploader();
    const ids: string[] = [];
    for (const ref of raw as ImageRef[]) {
      if (!ref || typeof ref.path !== 'string') throw new RpcError(ErrorCode.other, 'Each picture needs a path.');
      let bytes: Uint8Array;
      try {
        bytes = read(ref.path);
      } catch (e) {
        throw new RpcError(ErrorCode.other, `Couldn't read a picture to send to ${name}: ${(e as Error)?.message ?? e}`);
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new RpcError(ErrorCode.other, `A picture over ${MAX_IMAGE_BYTES / 1024 / 1024} MB can't go to ${name}.`);
      try {
        const url = (await src.post('mutation', 'relay:imageUploadUrl', { key: src.key })) as string;
        ids.push(await upload(url, bytes, typeof ref.mediaType === 'string' ? ref.mediaType : 'application/octet-stream'));
      } catch (e) {
        throw new RpcError(ErrorCode.other, `Couldn't send a picture to ${name} through Convex: ${(e as Error)?.message ?? e}`);
      }
    }
    return ids;
  }

  /**
   * Queues a command for the thread's runner and waits until it's taken
   * (or, with `done`, finished). A runner that's offline is said at once
   * rather than left to pick it up whenever it's back.
   */
  private async command(runnerId: string, threadId: string | undefined, kind: string, args: Record<string, unknown>, opts: { done?: boolean; ms?: number } = {}): Promise<{ state: string; note?: string; threadId?: string; result?: unknown }> {
    const runner = this.runner(runnerId);
    const name = runner?.name ?? 'the other runner';
    if (runner && !runner.online) throw notSent(new RpcError(ErrorCode.other, `${name} is offline, so that can't reach it now.`));
    let src: RelaySource;
    try {
      src = this.src();
    } catch (e) {
      throw notSent(e);
    }
    let commandId: unknown;
    try {
      commandId = await src.post('mutation', 'relay:queueCommand', { key: src.key, runnerId, ...(threadId ? { threadId } : {}), kind, args });
    } catch (e) {
      throw new RpcError(ErrorCode.other, `Couldn't reach ${name} through Convex: ${(e as Error)?.message ?? e}`);
    }
    const subscribe = src.subscribe;
    if (!subscribe) return { state: 'pending' };
    const ms = opts.ms ?? TAKE_MS;
    return new Promise((resolve, reject) => {
      let unsub: (() => void) | undefined;
      let finished = false;
      const end = (f: () => void) => {
        if (finished) return;
        finished = true;
        timer.cancel();
        // The subscribe callback can run before subscribe returns.
        queueMicrotask(() => unsub?.());
        f();
      };
      const timer = this.deps.clock.setTimeout(
        () => end(() => (opts.done ? reject(new RpcError(ErrorCode.other, `${name} hasn't answered yet. It's waiting for it in Convex.`)) : resolve({ state: 'pending' }))),
        ms,
      );
      unsub = subscribe(
        'relay:commandState',
        { key: src.key, commandId },
        (v) => {
          const s = v as { state: string; note?: string; threadId?: string; result?: unknown } | null;
          if (!s) return end(() => reject(new RpcError(ErrorCode.other, `${name} didn't get it.`)));
          if (s.state === 'failed') return end(() => reject(new RpcError(ErrorCode.other, s.note ?? `${name} couldn't do that.`)));
          if (s.state === 'done' || (s.state === 'taken' && !opts.done)) return end(() => resolve(s));
        },
        (e) => end(() => reject(new RpcError(ErrorCode.other, String(e)))),
      );
      if (finished) unsub();
    });
  }

  // A tool opened in the app: fetched once, for as long as this thread is held, and
  // its events go out like any late one. Nothing's there (full sync off on that
  // runner, or a tool from before it): the row goes on saying it's kept there.
  private async heldBody(w: Watch, seq: number | undefined): Promise<{ state: string | null }> {
    if (seq === undefined || !Number.isSafeInteger(seq)) throw new RpcError(ErrorCode.other, 'seq is required');
    const held = w.bodies.get(seq);
    if (held) return { state: held.state };
    let body: HeldBody = null;
    try {
      body = (await this.read('sync:remoteBody', { threadId: w.threadId, seq })) as HeldBody;
    } catch (e) {
      // A backend from before API 52, or Convex away: the stub stands.
      this.deps.log.debug('relay could not fetch a tool body', { threadId: w.threadId, seq, error: String(e) });
      return { state: null };
    }
    // Nothing yet can mean it hasn't gone up yet, and with no `ok` it hasn't answered
    // yet (a tool still running in the background): asked again next time.
    if (body && (body.state !== 'text' || body.ok !== undefined)) {
      w.bodies.set(seq, body);
      this.emit(w);
    }
    return { state: body?.state ?? null };
  }

  private unsupported(w: Watch | undefined, what: string): never {
    const name = w ? this.runnerName(w.runnerId) : 'the other runner';
    throw new RpcError(ErrorCode.other, `${what} isn't possible through Convex yet. Do it on ${name}, or turn on Connect to other machines directly in Settings > Runners.`);
  }

  /** A thread method about another runner's thread (rpc.ts THREAD_METHODS). */
  async call(threadId: string, method: string, p: Record<string, unknown>): Promise<unknown> {
    const w = this.watch(threadId);
    switch (method) {
      case 'threads.events':
        return this.page(w, { afterSeq: num(p.afterSeq), beforeSeq: num(p.beforeSeq), limit: num(p.limit) });
      case 'threads.subscribe': {
        const said = w.shareSaid;
        await this.load(w);
        const after = num(p.afterSeq) ?? 0;
        // What's past the app's last seq, and anything that can come late
        // (a tool's result, a card's answer, a turn's end) from what it was
        // given before: it may have arrived while the app was away, and the
        // app takes a seq it already has as nothing.
        const from = w.given.size ? Math.min(...w.given) : after;
        const late = (seq: number) => seq % SCALE !== 0 && seq % SCALE !== 1;
        const events = this.events(w).filter((e) => e.seq > after || (e.seq >= from && late(e.seq)));
        for (const e of events) w.given.add(e.seq);
        if (!w.given.size) w.given.add(after);
        this.live(w);
        // An app subscribing may be new (relaunched) and not know the share
        // the watch said before: said again, if it's shared (unless reading
        // the row just now said it).
        if (w.shareSaid === said) {
          w.shareSaid = undefined;
          this.noteShare(w);
        }
        return { events, inProgress: [] };
      }
      case 'threads.heldBody':
        return this.heldBody(w, num(p.seq));
      case 'threads.send': {
        const text = typeof p.text === 'string' ? p.text : '';
        const images = await this.uploadImages(w.runnerId, p.images);
        const r = await this.command(w.runnerId, threadId, 'send', { text, ...(Array.isArray(p.answers) && p.answers.length ? { answers: p.answers } : {}), ...(images.length ? { images } : {}) });
        // Not taken in TAKE_MS: it waits in the backend for that runner.
        return { turnId: '', ...(r.state === 'pending' ? { queued: true } : {}) };
      }
      case 'threads.interrupt':
        await this.command(w.runnerId, threadId, 'interrupt', {});
        return {};
      case 'approvals.respond': {
        const approvalId = String(p.approvalId ?? '');
        const decision = String(p.decision ?? '');
        const message = typeof p.message === 'string' ? p.message : undefined;
        await this.command(w.runnerId, threadId, 'respond', { approvalId, decision, ...(message ? { message } : {}), ...(p.answers && typeof p.answers === 'object' ? { answers: p.answers } : {}) }, { done: true });
        w.decided.set(approvalId, { decision, ...(message ? { message } : {}) });
        const card = w.cards.get(approvalId);
        if (card) {
          card.resolved = { decision, ...(message ? { message } : {}) };
          this.emit(w);
        }
        return {};
      }
      case 'secrets.answer': {
        const approvalId = String(p.approvalId ?? '');
        if (p.decline === true) {
          await this.command(w.runnerId, threadId, 'respond', { approvalId, decision: 'deny', secret: true }, { done: true });
          w.decided.set(approvalId, { decision: 'deny' });
          return {};
        }
        // Sealed to that runner's key, as the phone does, so the value
        // never reaches the backend in the clear.
        if (!w.loaded) await this.load(w);
        const open = w.row?.pendingApproval;
        if (open?.kind !== 'secret' || open.approvalId !== approvalId) throw new RpcError(ErrorCode.other, 'That secret card has been answered or has gone.');
        const sealed = seal(open.key, String(p.secret ?? ''), approvalId);
        await this.command(w.runnerId, threadId, 'respond', { approvalId, decision: 'answered', secret: true, sealed }, { done: true });
        w.decided.set(approvalId, { decision: 'answered' });
        return {};
      }
      case 'threads.markSeen': {
        // A write on the other runner and the backend: only when there's something unread.
        if (this.find(threadId)?.unread) {
          await this.command(w.runnerId, threadId, 'update', { markSeen: true }).then(
            () => this.remember(threadId, { unread: false }),
            () => undefined,
          );
        }
        return { thread: this.summary(threadId) };
      }
      case 'threads.update': {
        // Each command with what it changes on the row, for the reply.
        const now = new Date(this.deps.clock.now()).toISOString();
        const t = this.find(threadId);
        const changes: [Record<string, unknown>, Partial<RemoteThread>][] = [];
        if (typeof p.title === 'string') changes.push([{ title: p.title }, { title: p.title }]);
        if (typeof p.archived === 'boolean') {
          changes.push(p.archived ? [{ archive: true, ...(typeof p.verdict === 'string' ? { verdict: p.verdict } : {}), ...(p.archivedBy === 'agent' ? { by: 'agent' } : {}) }, { archivedAt: now }] : [{ unarchive: true }, { archivedAt: undefined }]);
        }
        if (typeof p.starred === 'boolean') changes.push([{ star: p.starred }, { starredAt: p.starred ? (t?.starredAt ?? now) : undefined }]);
        if ('snoozedUntil' in p) {
          const s = p.snoozedUntil;
          changes.push(s === null ? [{ wake: true }, { snoozedUntil: undefined }] : s === 'restart' ? [{ snooze: { untilRestart: true } }, { snoozedUntil: UNTIL_RESTART }] : [{ snooze: { until: String(s) } }, { snoozedUntil: String(s) }]);
        }
        const known = new Set(['threadId', 'title', 'archived', 'verdict', 'archivedBy', 'starred', 'snoozedUntil']);
        if (Object.keys(p).some((k) => !known.has(k) && p[k] !== undefined)) this.unsupported(w, 'Changing its login, model or settings');
        // Kept as each is done, so one failing after another went through
        // doesn't lose the one that did.
        for (const [change, patch] of changes) {
          await this.command(w.runnerId, threadId, 'update', change, { done: true });
          this.remember(threadId, patch);
        }
        // The app takes `{ thread }` back, as from any runner, and decodes
        // nothing else: `{}` failed every archive of another runner's thread
        // with a "Key 'thread' not found" banner after it had gone through.
        return { thread: this.summary(threadId) };
      }
      case 'threads.share': {
        const access = p.access;
        if (access !== 'off' && access !== 'link') throw new RpcError(ErrorCode.badParams, 'access must be "off" or "link"');
        const newLink = p.newLink === true;
        // A new link is one whose slug isn't the old one.
        const old = newLink ? (await this.shareOf(threadId))?.slug : undefined;
        await this.command(w.runnerId, threadId, 'share', { access, ...(newLink ? { newLink: true } : {}) }, { done: true });
        // The command says nothing back, and the app shows the link from
        // the reply, so it's read from that runner's row, which it writes
        // as soon as it has shared (sync.ts, the share command).
        const share = await this.sharedAs(w, access, old);
        return { thread: { ...this.summary(threadId), ...(share ? { share } : {}) } };
      }
      case 'threads.subagent':
        return this.unsupported(w, "Reading a sub-agent's work");
      default:
        return this.unsupported(w, describe(method));
    }
  }

  /** threads.create with a runnerId that's another runner's: a `create` command, answered with the new thread's id. */
  async create(runnerId: string, p: Record<string, unknown>): Promise<{ thread: Record<string, unknown> }> {
    const images = await this.uploadImages(runnerId, p.images);
    const args: Record<string, unknown> = { text: String(p.text ?? ''), ...(images.length ? { images } : {}) };
    for (const k of ['cwd', 'accountId', 'model', 'effort']) if (typeof p[k] === 'string') args[k] = p[k];
    // Left out, that runner would give it full access, so every mode goes
    // (Plan first as Ask plus a flag, which an older runner reads as Ask)
    // and one this runner doesn't know is refused (remoteCreateMode).
    Object.assign(args, remoteCreateMode(p.permissionMode));
    const done = await this.command(runnerId, undefined, 'create', args, { done: true, ms: CALL_MS });
    if (!done.threadId) throw new RpcError(ErrorCode.other, `${this.runnerName(runnerId)} didn't say which thread it made.`);
    const now = new Date(this.deps.clock.now()).toISOString();
    // Opened at once, before the sidebar's list has its row.
    this.made.set(done.threadId, {
      runnerId,
      threadId: done.threadId,
      title: '',
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      accountId: typeof p.accountId === 'string' ? p.accountId : '',
      provider: typeof p.provider === 'string' ? p.provider : 'claude',
      status: 'starting',
      needsYou: false,
      unread: false,
      preview: '',
      createdAt: now,
      lastActivityAt: now,
    });
    return {
      thread: {
        id: done.threadId,
        title: '',
        cwd: typeof p.cwd === 'string' ? p.cwd : '',
        accountId: typeof p.accountId === 'string' ? p.accountId : '',
        provider: typeof p.provider === 'string' ? p.provider : 'claude',
        ...(typeof p.model === 'string' ? { model: p.model } : {}),
        status: 'starting',
        needsYou: false,
        createdAt: now,
        lastActivityAt: now,
        lastSeq: 0,
        lastSeenSeq: 0,
        preview: '',
        runnerId,
      },
    };
  }

  /** files.list on another runner, through an allow-listed `call` command. */
  async listFolder(runnerId: string, path: string): Promise<unknown> {
    const done = await this.command(runnerId, undefined, 'call', { method: 'files.list', params: { path } }, { done: true, ms: CALL_MS });
    return done.result;
  }

  /** Another runner's logins for the new-thread pickers, from the backend's accounts rows. */
  async logins(runnerId: string): Promise<{ accounts: unknown[]; pools: unknown[]; defaults: Record<string, unknown> }> {
    const rows = (await this.read('relay:remoteAccounts', { runnerId })) as { id: string; provider: string; runnerId?: string }[];
    const accounts = rows.map(({ runnerId: _r, ...a }) => ({ ...a, configDir: '' }));
    const recent = this.deps.remote().threads.filter((t) => t.runnerId === runnerId).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    return { accounts, pools: [], defaults: { cwd: recent?.cwd ?? '', accountId: recent?.accountId ?? accounts[0]?.id ?? '', models: {}, efforts: {} } };
  }
}

type Share = { access: 'off' | 'link'; slug: string };

// A threads row's share as the app takes it: "people" (API 7) reads as off.
function toShare(s: RelayThreadRow['share']): Share | undefined {
  if (!s || typeof s.slug !== 'string') return undefined;
  return { access: s.access === 'link' ? 'link' : 'off', slug: s.slug };
}

// Whether the other runner's row already shows a change made from here:
// its own times for archiving and starring, so only whether it's set.
function shows(k: keyof RemoteThread, row: unknown, kept: unknown): boolean {
  if (k === 'archivedAt' || k === 'starredAt') return (row !== undefined) === (kept !== undefined);
  if (k === 'snoozedUntil' && typeof row === 'string' && typeof kept === 'string') return Date.parse(row) === Date.parse(kept);
  return row === kept;
}

// The row has the input as one line; the card draws it under the key a
// tool's input would have had, so a command reads as a command.
function inputKey(name: string, line: string): string {
  if (name === 'Bash') return 'command';
  if (/^[~/]/.test(line)) return 'file_path';
  return /^https?:\/\//.test(line) ? 'url' : 'input';
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function describe(method: string): string {
  switch (method) {
    case 'threads.edit':
      return 'Editing a message';
    case 'threads.hibernateWhen':
      return 'Hibernating until something happens';
    case 'threads.highlights':
    case 'threads.removeHighlight':
      return 'Its highlights';
    case 'threads.explain':
      return 'Explain';
    case 'threads.tickAsk':
      return 'Ticking an ask';
    case 'threads.delete':
      return 'Deleting it';
    default:
      return method.startsWith('panels.') || method.startsWith('actions.') || method.startsWith('patches.') ? 'Its patches' : method.startsWith('reviews.') ? 'Design reviews' : method.startsWith('buttons.') ? 'Reply buttons' : 'That';
  }
}
