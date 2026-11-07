// The librarian: the runner's own background job that keeps projects up
// to date (docs/protocol.md, "Projects"). It watches threads' turns and
// moves, and now and then asks the small model (models/index.ts, feature
// "projects") which projects a thread belongs in, whether it needs a new
// one, where the thread has got a project to, and whether the thread's
// title still fits. What it decides takes effect straight away; Mike can
// take a thread out, and then it's never put back (projects.ts).
//
// One look at a time, the soonest due first. Its queue, what it did and
// whether it's paused are kept in librarian.json, so a runner restart
// (which happens whenever main moves) doesn't lose them. The app shows all
// of it in the Librarian view (LibrarianStatus).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { Models, ModelFailure } from './models/index.ts';
import type { Notification, ThreadActivity } from './runner.ts';
import type { LibrarianEntry, LibrarianJob, LibrarianOutcome, LibrarianReason, LibrarianStatus } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { ThreadRecord } from './store.ts';
import type { ProjectRecord, Projects } from './projects.ts';
import { LINKS_MAX, NOTES_LONG, WHY_MAX } from './projects.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { findUp, isInside } from './patches.ts';
import { SYMBOLS, fileHash, findIcon, storeIcon } from './project-icons.ts';
import { userLine } from './user-name.ts';
import type { PocketCardInput, PocketCardSummary } from './sync.ts';
import { POCKET_ICONS, type PocketIconName } from './pocket-icons.ts';
import { trimEndOf, trimStartOf } from './linear-text.ts';

// The phone's Pocket, in the Convex backend (sync.ts). Asked for each look,
// as sync can be off.
export type ThreadGist = { first?: string; firstImages?: number; recent: { who: 'user' | 'assistant'; text: string; images?: number }[] };

export type LibrarianPocket = {
  pocketCards(): Promise<PocketCardSummary[]>;
  savePocketCard(card: PocketCardInput): Promise<'added' | 'replaced'>;
  removePocketCard(title: string): Promise<boolean>;
};

// What the librarian needs from the runner.
export type LibrarianHost = {
  threadRecords(): ThreadRecord[];
  threadGist(threadId: string, opts?: { recent?: number; chars?: number }): ThreadGist;
  threadSince?(threadId: string, seq: number): { chars: number; links: boolean };
  resolveThread(idOrPrefix: string): string;
  onThreadActivity(fn: (a: ThreadActivity) => void): () => void;
  onNotification(fn: (n: Notification) => void): () => void;
  publish(n: Notification): void;
  // Keeps the look's line on where the thread is up to, shown at the top
  // of its Highlights (docs/protocol.md).
  setBrief?(threadId: string, text: string): void;
  // Renames a thread whose title no longer says what it's about; returns
  // the title it took, or nothing when it kept the old one.
  retitleFromLibrarian?(threadId: string, title: string, from: string): string | undefined;
  // Threads hibernating until Mike next talks about something
  // (wake-when.ts), and waking one he just did.
  waitingTopics?(): { threadId: string; title: string; topic: string }[];
  wakeForTopic?(threadId: string, inThreadId: string): boolean;
  // Threads hibernating until this one has done something in particular
  // (end_turn's waitFor until), and saying one has.
  waitedOnFor?(threadId: string): { threadId: string; title: string; until: string }[];
  waitMet?(waiterId: string, targetId: string, why: string, until: string): boolean;
};

// How long after a turn ends before a look, so a quick follow-up turn
// doesn't mean two looks.
export const SETTLE_MS = 10_000;
// How long after a new thread's first message before a look from that
// alone, so it's filed while its first turn is still going (a long one
// used to leave it unfiled for as long as it ran).
export const FIRST_MESSAGE_MS = 5_000;
// A thread with more turns is looked at again no sooner than this.
export const CATCH_UP_MS = 20 * 60_000;
// A catch-up look is skipped, with no model call, when the turns since the
// last look edited nothing, gave no link and said less than this much: a
// quick "thanks" or "go" rarely changes a project, its state or a title.
// What they said still counts towards the next one.
export const CATCH_UP_MIN_CHARS = 400;
// How often to look for turns the librarian never heard end. A turn that
// ends in an older runner while it drains after a handover is only heard
// by that runner, whose librarian has stopped; main moving every few
// minutes made that common. Threads active within SWEEP_DAYS.
export const SWEEP_MS = 5 * 60_000;
const SWEEP_DAYS = 2;
// Without a pool or room on it, how long before trying again.
const OFF_RETRY_MS = 10 * 60_000;
const RECENT_KEPT = 50;
// A backfill looks at threads active this recently.
const BACKFILL_DAYS = 30;
// Icons: every project's folders are looked through again this often, so
// a repo that gets a new app icon shows it; a new project or one whose
// folders changed is looked at after ICON_SOON_MS.
export const ICON_SWEEP_MS = 60 * 60_000;
export const ICON_SOON_MS = 3_000;
// A project's notes past NOTES_LONG get rewritten shorter, this long after
// the project last changed, so a thread part-way through adding to them
// has finished first.
export const NOTES_SOON_MS = 60_000;
// Old notes kept on disk per project, the newest first.
const NOTES_KEPT = 5;

// New Pocket cards: at most this many a day, so a look that gets it wrong
// can't fill the deck. A thread only ever gets one from the librarian, so
// one Mike took out doesn't come back on the next look.
export const POCKET_ADDS_PER_DAY = 5;
const POCKET_ADDS_KEPT_MS = 30 * 24 * 60 * 60_000;
// A short message saying they're going out would otherwise be a quiet
// catch-up, with no look to file a card from.
const HEADING_OUT = /\b(heading|going|off|popping|driving|walking) (to|out|over|down|into)\b|\bon my way\b|\bI'?m at\b|\bout and about\b/i;

// Which reason wins when a thread is queued twice.
const RANK: Record<LibrarianReason, number> = { asked: 0, 'waited-on': 1, moved: 1, 'new-folder': 2, 'first-turn': 3, 'first-message': 4, 'catch-up': 5, notes: 6 };

// `early`: the look was from the first message alone, so the first turn's
// end still gets a look of its own.
type Look = { at: string; seq: number; early?: boolean };

// A Pocket card the librarian added.
type PocketAdded = { at: string; threadId: string };

type Saved = {
  pocketAdded?: PocketAdded[];
  paused?: boolean;
  queue?: LibrarianJob[];
  recent?: LibrarianEntry[];
  looks?: Record<string, Look>;
  day?: Day;
};

// The day's looks, skips and what they used. notionalUsd is what they'd
// have cost on the API; the login's room pays, so nothing is spent.
type Day = { date: string; looks: number; skipped?: number; tokens?: number; notionalUsd?: number };

// What the model is asked to answer.
type Answer = {
  projects?: unknown;
  // Why it belongs in each of `projects`, by id: kept with the thread's
  // membership for Highlights' ⓘ.
  reasons?: unknown;
  // Projects it's in that it turns out not to be about, by id, with why.
  leave?: unknown;
  new?: unknown;
  state?: unknown;
  addFolders?: unknown;
  links?: unknown;
  thread?: unknown;
  title?: unknown;
  // New names for projects the thread is in, by id.
  retitle?: unknown;
  wake?: unknown;
  met?: unknown;
  pocket?: unknown;
  why?: unknown;
};

export class Librarian {
  private host: LibrarianHost;
  private projects: Projects;
  // The conditions each look was shown (prompt), for its met (apply).
  private shownWaiters = new Map<string, { threadId: string; title: string; until: string }[]>();
  private models?: Pick<Models, 'generate'> & { unavailable?(opts?: { poolOnly?: boolean }): string | undefined; isPrivateFolder?(cwd: string): boolean };
  private clock: Clock;
  private log: Logger;
  private file: string;
  private home: string;
  private paused = false;
  private queue = new Map<string, LibrarianJob>();
  private recent: LibrarianEntry[] = [];
  private looks: Record<string, Look> = {};
  private pocket?: () => LibrarianPocket | undefined;
  private pocketAdded: PocketAdded[] = [];
  private day: Day = { date: '', looks: 0 };
  // Folders each thread has edited in since its last look, by repo.
  private edited = new Map<string, Set<string>>();
  // Repos its shell commands ran in since its last look (`cd ~/dev/me/app`),
  // for a thread in a catch-all folder that never uses Edit or Write.
  private workedIn = new Map<string, Set<string>>();
  private current?: LibrarianJob & { startedAt: string };
  private off?: string;
  // `off` is there because no model could be reached at all (no pool with
  // a Claude login), so it clears by itself once one can.
  private offForSetup = false;
  private timer?: TimerHandle;
  private timerAt = Infinity;
  private sweepTimer?: TimerHandle;
  private stopped = false;
  private unsubs: (() => void)[] = [];
  // What each project's icon was last worked out from (folders, title, who
  // set it), so only a changed one is looked at between sweeps.
  private iconSeen = new Map<string, string>();
  private iconTimer?: TimerHandle;
  private iconTimerAt = Infinity;
  private iconRun?: Promise<void>;
  private iconAgain = false;
  private iconFullDue = 0;
  private notesTimer?: TimerHandle;
  private notesRun?: Promise<void>;
  // Notes it already tried and couldn't shorten, by project, so the same
  // notes aren't sent again on every change to the project.
  private notesTried = new Map<string, string>();

  constructor(deps: { host: LibrarianHost; projects: Projects; models?: Pick<Models, 'generate'> & { unavailable?(opts?: { poolOnly?: boolean }): string | undefined; isPrivateFolder?(cwd: string): boolean }; clock: Clock; log: Logger; home: string; userHome?: string; pocket?: () => LibrarianPocket | undefined }) {
    this.host = deps.host;
    this.pocket = deps.pocket;
    this.projects = deps.projects;
    this.models = deps.models;
    this.clock = deps.clock;
    this.log = deps.log;
    this.file = path.join(deps.home, 'librarian.json');
    this.home = deps.userHome ?? os.homedir();
  }

  start(): void {
    const saved = readJsonSync<Saved>(this.file);
    if (!saved && fs.existsSync(this.file)) this.log.error('librarian.json could not be read; starting afresh', { file: this.file });
    this.paused = Boolean(saved?.paused);
    for (const j of saved?.queue ?? []) if (j && typeof j.threadId === 'string') this.queue.set(j.threadId, j);
    this.recent = (saved?.recent ?? []).slice(0, RECENT_KEPT);
    this.looks = saved?.looks ?? {};
    this.pocketAdded = saved?.pocketAdded ?? [];
    if (saved?.day) this.day = saved.day;
    if (!this.models) this.off = 'Model calls are off in this runner.';
    this.unsubs.push(this.host.onThreadActivity((a) => this.onActivity(a)));
    this.unsubs.push(
      this.host.onNotification((n) => {
        if (n.method === 'projects.updated') {
          this.iconsSoon();
          this.notesSoon();
        }
        if (n.method !== 'thread.deleted') return;
        const id = n.params.threadId;
        delete this.looks[id];
        this.edited.delete(id);
        this.workedIn.delete(id);
        if (this.queue.delete(id)) this.changed();
      }),
    );
    this.sweep();
    this.schedule();
    this.iconsSoon();
    this.notesSoon();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.sweepTimer?.cancel();
    this.iconTimer?.cancel();
    this.notesTimer?.cancel();
    for (const u of this.unsubs) u();
  }

  // ---------------------------------------------------------------- reads

  status(): LibrarianStatus {
    this.rollDay();
    // Whether there's a pool with a Claude login is known without asking
    // the model; room isn't.
    const why = this.models?.unavailable?.({ poolOnly: true });
    if (!this.current && !this.off && why) {
      this.off = why;
      this.offForSetup = true;
    } else if (this.offForSetup && this.models?.unavailable && !why) {
      this.off = undefined;
      this.offForSetup = false;
    }
    const s: LibrarianStatus = {
      state: this.current ? 'working' : this.paused ? 'paused' : this.off ? 'off' : 'idle',
      paused: this.paused,
      queue: this.sortedQueue(),
      recent: this.recent,
      looksToday: this.day.looks,
      // Always 0 since looks only run on the pool; kept for older apps.
      spentTodayUsd: 0,
      skippedToday: this.day.skipped ?? 0,
      tokensToday: this.day.tokens ?? 0,
      notionalTodayUsd: round(this.day.notionalUsd ?? 0),
    };
    if (this.off && !this.current) s.reason = this.off;
    if (this.current) s.current = this.current;
    return s;
  }

  // ---------------------------------------------------------------- asks

  // Queues a look at a thread now, or with none, at every recent thread it
  // has never looked at (a backfill).
  run(threadId?: string): LibrarianStatus {
    const now = this.clock.now();
    if (threadId) {
      const id = this.host.resolveThread(threadId);
      this.enqueue(id, 'asked', 'Asked for', now);
    } else {
      const since = now - BACKFILL_DAYS * 86_400_000;
      const due = this.host
        .threadRecords()
        .filter((t) => !this.looks[t.id] && Date.parse(t.lastActivityAt) >= since && t.lastSeq > 0)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      // Newest first, a second apart so the queue keeps that order.
      due.forEach((t, i) => this.enqueue(t.id, 'asked', 'Looking at everything', now + i * 1000));
      this.log.info('librarian backfill', { threads: due.length });
    }
    // Asking again is a good moment to try again after a missing pool.
    this.off = this.models ? undefined : this.off;
    if (this.models) this.offForSetup = false;
    this.changed();
    return this.status();
  }

  update(params: { paused?: boolean }): LibrarianStatus {
    if (params.paused !== undefined && params.paused !== this.paused) {
      this.paused = params.paused;
      this.log.info(this.paused ? 'librarian paused' : 'librarian resumed');
      // Symbols wait while paused: look at every project again now.
      if (!this.paused) {
        this.iconFullDue = 0;
        this.iconsSoon();
      }
      this.changed();
    }
    return this.status();
  }

  // ------------------------------------------------------------- triggers

  private onActivity(a: ThreadActivity): void {
    const now = this.clock.now();
    const rec = this.host.threadRecords().find((t) => t.id === a.threadId);
    if (!rec) return;
    if (a.kind === 'moved') {
      this.enqueue(rec.id, 'moved', `Moved to ${this.tilde(a.to)}`, now + SETTLE_MS);
      this.changed();
      return;
    }
    if (a.kind === 'waited-on') {
      // Soon, and whatever turn it was (its CLI's own too): a thread is
      // asleep until this one has done something.
      this.enqueue(rec.id, 'waited-on', 'A thread is waiting on it', now + SETTLE_MS);
      this.changed();
      return;
    }
    if (a.kind === 'turn.start') {
      if (this.looks[rec.id] || this.queue.has(rec.id) || this.current?.threadId === rec.id) return;
      this.enqueue(rec.id, 'first-message', 'Its first message came in', now + FIRST_MESSAGE_MS);
      this.changed();
      return;
    }
    if (a.outcome !== 'completed') return;
    const repos = this.edited.get(rec.id) ?? new Set<string>();
    for (const file of a.edited) repos.add(this.repoOf(file));
    if (repos.size) this.edited.set(rec.id, repos);
    const worked = this.workedIn.get(rec.id) ?? new Set<string>();
    for (const dir of a.workedIn ?? []) {
      const repo = this.repoOfDir(dir);
      if (repo !== this.repoOfDir(rec.cwd) && this.isProjectFolder(repo)) worked.add(repo);
    }
    if (worked.size) this.workedIn.set(rec.id, worked);
    const look = this.looks[rec.id];
    if (!look || look.early) {
      this.enqueue(rec.id, 'first-turn', 'Its first turn ended', now + SETTLE_MS);
    } else {
      const known = [rec.cwd, ...this.projects.foldersFor(rec).map((f) => f.folder)];
      const outside = [...repos].find((r) => !known.some((k) => isInside(r, k) || isInside(k, r)));
      if (outside) this.enqueue(rec.id, 'new-folder', `Edited files in ${this.tilde(outside)}`, now + SETTLE_MS);
      else this.enqueue(rec.id, 'catch-up', 'More turns since its last look', Math.max(now + SETTLE_MS, Date.parse(look.at) + CATCH_UP_MS));
    }
    this.changed();
  }

  // One job per thread: the more pressing reason and the sooner time win.
  private enqueue(threadId: string, reason: LibrarianReason, why: string, dueAtMs: number): void {
    const rec = this.host.threadRecords().find((t) => t.id === threadId);
    if (!rec) return;
    const job: LibrarianJob = { threadId, threadTitle: rec.title, reason, why, dueAt: new Date(dueAtMs).toISOString() };
    const had = this.queue.get(threadId);
    if (had) {
      const better = RANK[reason] < RANK[had.reason] ? job : had;
      const sooner = Math.min(dueAtMs, Date.parse(had.dueAt));
      this.queue.set(threadId, { ...better, threadTitle: rec.title, dueAt: new Date(sooner).toISOString() });
    } else {
      this.queue.set(threadId, job);
    }
  }

  // Queues every recent thread with a finished turn the librarian hasn't
  // looked at since, then checks again in SWEEP_MS. Events are the quick
  // path; this is what makes a missed one not matter.
  private sweep(): void {
    if (this.stopped) return;
    this.sweepTimer = this.clock.setTimeout(() => this.sweep(), SWEEP_MS);
    // With no models, a look does nothing and leaves no mark.
    if (!this.models) return;
    const now = this.clock.now();
    const since = now - SWEEP_DAYS * 86_400_000;
    let found = 0;
    for (const t of this.host.threadRecords()) {
      if (!t.lastTurnCompletedSeq || Date.parse(t.lastActivityAt) < since) continue;
      if (this.queue.has(t.id) || this.current?.threadId === t.id) continue;
      const look = this.looks[t.id];
      if (look && look.seq >= t.lastTurnCompletedSeq) continue;
      if (!look || look.early) this.enqueue(t.id, 'first-turn', 'Its first turn ended while the runner was restarting', now);
      // A turn missed (on a draining runner, say) in a thread another is
      // waiting on: that look, not a catch-up that may be skipped as quiet.
      else if (this.host.waitedOnFor?.(t.id).length) this.enqueue(t.id, 'waited-on', 'A thread is waiting on it', now);
      else this.enqueue(t.id, 'catch-up', 'More turns since its last look', Math.max(now, Date.parse(look.at) + CATCH_UP_MS));
      found++;
    }
    if (!found) return;
    this.log.info('librarian sweep', { threads: found });
    this.changed();
  }

  // ------------------------------------------------------------- the pump

  private schedule(): void {
    if (this.stopped || this.current || this.paused) return;
    const next = this.sortedQueue()[0];
    if (!next) {
      this.timer?.cancel();
      this.timer = undefined;
      this.timerAt = Infinity;
      return;
    }
    const at = Date.parse(next.dueAt);
    if (at <= this.clock.now()) {
      // Already due (after a pause, or a restart): now, not on a timer.
      this.timer?.cancel();
      this.timer = undefined;
      this.timerAt = Infinity;
      void Promise.resolve().then(() => this.pump());
      return;
    }
    if (this.timer && this.timerAt <= at) return;
    this.timer?.cancel();
    this.timerAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      void this.pump();
    }, at - this.clock.now());
  }

  // Runs the jobs that are due, one at a time.
  async pump(): Promise<void> {
    while (!this.stopped && !this.current && !this.paused) {
      const job = this.sortedQueue()[0];
      if (!job || Date.parse(job.dueAt) > this.clock.now()) break;
      this.queue.delete(job.threadId);
      this.current = { ...job, startedAt: new Date(this.clock.now()).toISOString() };
      this.changed(false);
      try {
        await this.look(job);
      } catch (e) {
        this.log.error('librarian look failed', { threadId: job.threadId, error: String(e) });
        this.note(job, 'failed', (e as Error).message ?? String(e));
      } finally {
        this.current = undefined;
      }
      // A stopped librarian has said all it will: librarian.json is the
      // new runner's now.
      if (this.stopped) return;
      this.changed(false);
    }
    this.schedule();
  }

  // ----------------------------------------------------------- one look

  private async look(job: LibrarianJob): Promise<void> {
    const rec = this.host.threadRecords().find((t) => t.id === job.threadId);
    if (!rec) return;
    if (!this.models) {
      this.off = 'Model calls are off in this runner.';
      return;
    }
    // Not from the first message alone: its agent hasn't had the chance to
    // file a card yet.
    const cards = job.reason === 'first-message' ? undefined : await this.pocketCards();
    if (this.quiet(rec, job, cards)) {
      // Its seq stays, so what these turns said counts towards the next.
      this.looks[rec.id] = { ...this.looks[rec.id], at: new Date(this.clock.now()).toISOString() };
      this.rollDay();
      this.day.skipped = (this.day.skipped ?? 0) + 1;
      this.log.info('librarian skipped a quiet catch-up', { threadId: rec.id });
      return;
    }
    const prompt = this.prompt(rec, job, cards);
    // rec is the live record: the title as the model saw it, so a rename
    // during the call isn't undone.
    const title = rec.title;
    const res = await this.models.generate({ feature: 'projects', cwd: rec.cwd, system: SYSTEM, prompt, maxTokens: 2000 });
    // While the model was thinking, the runner may have stopped this
    // librarian for a handover, let the thread go to the new runner, or
    // the thread may have been deleted. Nothing to say or apply then: the
    // new runner's librarian has the job (changed() saves the one in
    // flight), and a deleted thread needs nothing (THREADBEAR-4).
    if (this.stopped || !this.host.threadRecords().some((t) => t.id === rec.id)) {
      this.log.info('librarian dropped a look at a thread that has gone', { threadId: rec.id, stopped: this.stopped });
      return;
    }
    if (!res.ok) {
      if (WAIT_FOR.includes(res.reason)) {
        // Nothing wrong with the job: try again once there's a pool or room
        // on it.
        this.off = res.reason === 'no-pool' ? (this.models.unavailable?.() ?? offReason(res.reason, res.message)) : offReason(res.reason, res.message);
        this.offForSetup = res.reason === 'no-pool';
        this.enqueue(job.threadId, job.reason, job.why, this.clock.now() + OFF_RETRY_MS);
        return;
      }
      this.markLooked(rec, job);
      this.note(job, res.reason === 'private' ? 'skipped' : 'failed', res.reason === 'private' ? 'Private folder, not sent' : res.message);
      return;
    }
    this.off = undefined;
    this.offForSetup = false;
    this.rollDay();
    this.day.looks++;
    this.used(res);
    const answer = parseAnswer(res.value);
    if (!answer) {
      this.markLooked(rec, job);
      this.note(job, 'failed', "The model's answer wasn't JSON");
      return;
    }
    this.apply(job, rec, answer, prompt, title);
    if (cards) await this.applyPocket(job, rec, answer, cards, prompt);
    this.markLooked(rec, job);
  }

  // A catch-up whose turns edited nothing, gave no link and said little
  // since the last look: not worth a model call (CATCH_UP_MIN_CHARS).
  private quiet(rec: ThreadRecord, job: LibrarianJob, cards?: PocketCardSummary[]): boolean {
    const look = this.looks[rec.id];
    if (job.reason !== 'catch-up' || !look || look.early || !this.host.threadSince) return false;
    // "Posted it" is short, and it's just what takes a card out.
    if (cards?.some((c) => c.threadId === rec.id)) return false;
    if (cards && this.host.threadGist(rec.id).recent.some((m) => m.who === 'user' && HEADING_OUT.test(m.text))) return false;
    if (this.edited.get(rec.id)?.size) return false;
    if (this.newWorkedIn(rec).length) return false;
    const since = this.host.threadSince(rec.id, look.seq);
    return !since.links && since.chars < CATCH_UP_MIN_CHARS;
  }

  // The deck, or nothing when it can't be read (no backend, or none yet):
  // the look then goes ahead and leaves the Pocket alone.
  private async pocketCards(): Promise<PocketCardSummary[] | undefined> {
    try {
      return await this.pocket?.()?.pocketCards();
    } catch (e) {
      this.log.info('librarian could not read the pocket', { error: String(e) });
      return undefined;
    }
  }

  private async applyPocket(job: LibrarianJob, rec: ThreadRecord, a: Answer, cards: PocketCardSummary[], seen: string): Promise<void> {
    const pocket = this.pocket?.();
    if (!pocket || this.stopped) return;
    const now = this.clock.now();
    this.pocketAdded = this.pocketAdded.filter((x) => now - Date.parse(x.at) < POCKET_ADDS_KEPT_MS);
    const { save, remove } = pocketChanges(a.pocket, {
      threadId: rec.id,
      cards,
      seen,
      addsToday: this.pocketAdded.filter((x) => now - Date.parse(x.at) < 24 * 60 * 60_000).length,
      addedBefore: this.pocketAdded.some((x) => x.threadId === rec.id),
    });
    const source = (rec.projects ?? []).map((m) => this.projects.list().find((p) => p.id === m.id)?.title).find(Boolean) ?? path.basename(rec.cwd);
    const said: string[] = [];
    try {
      for (const title of remove) if (await pocket.removePocketCard(title)) said.push(`Took "${title}" out of the Pocket`);
      for (const c of save) {
        const how = await pocket.savePocketCard({ ...c, threadId: rec.id, source });
        if (how === 'added') this.pocketAdded.push({ at: new Date(now).toISOString(), threadId: rec.id });
        said.push(`${how === 'added' ? 'Filed' : 'Updated'} "${c.title}" in the Pocket`);
      }
    } catch (e) {
      this.log.warn('librarian could not change the pocket', { error: String(e) });
    }
    if (said.length) this.note(job, 'updated', said.join('. '));
  }

  private prompt(rec: ThreadRecord, job: LibrarianJob, cards?: PocketCardSummary[]): string {
    const list = this.projects.list();
    const lines: string[] = [];
    lines.push('Projects:');
    if (!list.length) lines.push('(none yet)');
    for (const p of list) {
      const state = p.state.split('\n')[0]?.slice(0, 160);
      lines.push(`- ${p.id} "${p.title}"${(p.titleBy ?? p.createdBy) === 'mike' ? ' (named by the user: keep it)' : ''}; folders: ${p.folders.map((f) => this.tilde(f)).join(', ') || 'none'}` + (p.goals ? `; goals: ${p.goals.slice(0, 200).replace(/\s+/g, ' ')}` : '') + (state ? `; state: ${state}` : '') + (p.links.length ? `; links: ${p.links.map((l) => l.url).join(' ')}` : ''));
    }
    lines.push('');
    lines.push(`Thread "${rec.title}", in ${this.tilde(rec.cwd)}${this.isRepo(rec.cwd) ? '' : ' (not a repo: a catch-all folder)'}`);
    const inNow = (rec.projects ?? []).map((m) => `${m.id}${m.pinned || m.by !== 'librarian' ? ' (pinned)' : ''}${m.why ? ` (${m.why})` : ''}`);
    lines.push(`Currently in: ${inNow.join(', ') || 'none'}`);
    if (rec.projectsLeft?.length) lines.push(`Never put it in: ${rec.projectsLeft.join(', ')}`);
    if (selfFiled(rec)) lines.push('Filed by its own agent or the user: leave its projects as they are (projects [], new null).');
    if (rec.titleSet) lines.push('Its title was set by the user or an agent: keep it (title null).');
    const repos = [...(this.edited.get(rec.id) ?? [])].map((r) => this.tilde(r));
    if (repos.length) lines.push(`Edited files in: ${repos.join(', ')}`);
    const worked = [...(this.workedIn.get(rec.id) ?? [])].filter((r) => !this.edited.get(rec.id)?.has(r)).map((r) => this.tilde(r));
    if (worked.length) lines.push(`Ran commands in: ${worked.join(', ')}`);
    const waiting = this.waitingFor(rec);
    if (waiting.length) {
      lines.push('', 'Hibernating threads waiting for the user to talk about something:');
      for (const w of waiting) lines.push(`- ${w.threadId.slice(0, 8)} "${w.title}": ${w.topic}`);
    }
    // Not a waiter in a private folder: its title and condition aren't
    // sent, so its wait only ends at its time. Kept for apply, so an
    // answer counts only for the conditions it was shown.
    const waiters = (this.host.waitedOnFor?.(rec.id) ?? []).filter((w) => {
      const cwd = this.host.threadRecords().find((t) => t.id === w.threadId)?.cwd;
      return cwd !== undefined && !this.models?.isPrivateFolder?.(cwd);
    });
    this.shownWaiters.set(rec.id, waiters);
    if (waiters.length) {
      lines.push('', 'Hibernating threads waiting until this thread has done something:');
      for (const w of waiters) lines.push(`- ${w.threadId.slice(0, 8)} "${w.title}": until ${w.until}`);
    }
    if (cards) {
      lines.push('', ...pocketPromptLines(rec.id, cards));
    } else {
      lines.push('', 'The Pocket is not available for this look: pocket null.');
    }
    const gist = this.host.threadGist(rec.id);
    if (job.reason === 'first-message') lines.push("It has only just started: file it from what it's about, and don't change any project's state yet.");
    if (gist.first) lines.push('', `First message${attached(gist.firstImages)}: ${gist.first}`);
    if (gist.recent.length) {
      lines.push('', 'Latest messages:');
      for (const m of gist.recent) lines.push(`${m.who === 'user' ? 'User' : 'Agent'}${attached(m.images)}: ${m.text}`);
    }
    return lines.join('\n');
  }

  // `seen` is the prompt the look was given: a link must be in it, so the
  // model can't make one up. `title` is the thread's title it was given.
  private apply(job: LibrarianJob, rec: ThreadRecord, a: Answer, seen = '', title = rec.title): void {
    const live = new Map(this.projects.list().map((p) => [p.id, p]));
    // A thread its agent or Mike filed is theirs to file: the look only
    // keeps its line and the state of the projects it's in.
    const self = selfFiled(rec);
    if (self) {
      a = { ...a, projects: [], new: null };
    }
    const reasons = byProject(a.reasons);
    // A project it isn't in yet needs a reason that says it fits. Haiku,
    // given seventy-odd projects and a thread that fits none, sometimes
    // lists one anyway, with no reason or one like "Not that; ignore",
    // while its `why` says nothing fits: that's how a Qantas booking
    // check ended up in Walkies (30 Oct 2026). Ones it's in already stay.
    const inAlready = new Set((rec.projects ?? []).map((m) => m.id));
    const listed = Array.isArray(a.projects) ? a.projects.filter((x): x is string => typeof x === 'string' && live.has(x)) : [];
    const wanted = listed.filter((pid) => inAlready.has(pid) || (reasons[pid] !== undefined && !saysNoFit(reasons[pid])));
    const unexplained = listed.filter((pid) => !wanted.includes(pid));
    if (unexplained.length) this.log.info('librarian dropped a pick it gave no reason for', { threadId: rec.id, projects: unexplained, reasons: unexplained.map((pid) => reasons[pid] ?? null), why: typeof a.why === 'string' ? a.why : undefined });
    const said: string[] = [];
    const ids = new Set<string>();
    let outcome: LibrarianOutcome = 'nothing';
    const bump = (o: LibrarianOutcome) => {
      const order: LibrarianOutcome[] = ['nothing', 'updated', 'left', 'joined', 'created'];
      if (order.indexOf(o) > order.indexOf(outcome)) outcome = o;
    };
    // A new project, when nothing fits.
    const fresh = readNew(a.new);
    if (fresh && !wanted.length) {
      const folders = fresh.folders.map((f) => this.expand(f)).filter((f) => this.isProjectFolder(f));
      try {
        const p = this.projects.create({ title: fresh.title, folders, goals: fresh.goals, state: fresh.state, by: 'librarian', byThread: rec.id });
        this.projects.changeMembership(rec.id, { add: [p.id], by: 'librarian', why: fresh.why ? { [p.id]: fresh.why } : undefined });
        said.push(`Made ${p.title} and put it there`);
        ids.add(p.id);
        bump('created');
      } catch (e) {
        this.log.warn('librarian could not make a project', { title: fresh.title, error: String(e) });
      }
    }
    if (wanted.length) {
      const r = this.projects.changeMembership(rec.id, { add: wanted, by: 'librarian', why: reasons });
      if (r.joined.length) {
        // Its reasons go once the thread leaves, so the log keeps them for
        // working out a wrong guess later.
        this.log.info('librarian joined', { threadId: rec.id, reasons: Object.fromEntries(r.joined.map((p) => [p, reasons[p]])), why: typeof a.why === 'string' ? a.why : undefined });
        said.push(`Put it in ${r.joined.map((p) => live.get(p)!.title).join(' and ')}`);
        r.joined.forEach((p) => ids.add(p));
        bump('joined');
      }
    }
    // Only a move or a direct ask takes the thread out of one of the
    // librarian's own guesses; turns alone shouldn't make it flap.
    if (!self && (job.reason === 'moved' || job.reason === 'asked')) {
      // Not one it has just made (ids) for this very thread.
      const stale = (rec.projects ?? []).filter((m) => m.by === 'librarian' && !m.pinned && !wanted.includes(m.id) && !ids.has(m.id)).map((m) => m.id);
      if (stale.length && Array.isArray(a.projects)) {
        const r = this.projects.changeMembership(rec.id, { remove: stale, by: 'librarian' });
        if (r.left.length) {
          said.push(`Took it out of ${r.left.map((p) => live.get(p)?.title ?? p).join(' and ')}`);
          r.left.forEach((p) => ids.add(p));
          bump('left');
        }
      }
    }
    // Its own guesses it now says were wrong ("not a Convex components
    // thread", 30 Oct). Only when it says so: leaving one out of
    // `projects` isn't enough, or turns alone would make it flap. Never
    // a pinned one or one Mike or an agent chose (changeMembership).
    if (!self) {
      const leave = Object.entries(byProject(a.leave)).filter(([pid]) => live.has(pid) && !wanted.includes(pid) && !ids.has(pid));
      for (const [pid, why] of leave) {
        const r = this.projects.changeMembership(rec.id, { remove: [pid], by: 'librarian' });
        if (!r.left.length) continue;
        said.push(`Took it out of ${live.get(pid)!.title}: ${lowerFirst(why)}`);
        ids.add(pid);
        bump('left');
      }
    }
    // Where the thread got its projects to, and folders they've grown.
    const member = new Set((this.host.threadRecords().find((t) => t.id === rec.id)?.projects ?? []).map((m) => m.id));
    if (a.addFolders && typeof a.addFolders === 'object') {
      for (const [pid, folders] of Object.entries(a.addFolders as Record<string, unknown>)) {
        const p = live.get(pid);
        if (!p || !member.has(pid) || !Array.isArray(folders)) continue;
        const add = folders
          .filter((f): f is string => typeof f === 'string')
          .map((f) => this.expand(f))
          .filter((f) => this.isProjectFolder(f) && !p.folders.includes(f));
        if (!add.length) continue;
        this.projects.update(pid, { folders: [...p.folders, ...add] });
        said.push(`Added ${add.map((f) => this.tilde(f)).join(', ')} to ${p.title}`);
        ids.add(pid);
        bump('updated');
      }
    }
    // Places Mike will keep going back to (a live site, an admin page),
    // added and never taken away: links are Mike's and agents' to prune.
    if (a.links && typeof a.links === 'object') {
      for (const [pid, list] of Object.entries(a.links as Record<string, unknown>)) {
        const p = this.projects.record(pid);
        if (!p || !member.has(pid) || !Array.isArray(list)) continue;
        const add = list.filter(
          (l): l is { title?: string; url: string } =>
            !!l && typeof l === 'object' && typeof (l as { url?: unknown }).url === 'string' && seen.includes((l as { url: string }).url) && !p.links.some((h) => trimEndOf(h.url, '/') === trimEndOf((l as { url: string }).url, '/')),
        );
        if (!add.length || p.links.length + add.length > LINKS_MAX) continue;
        try {
          this.projects.addLinks(pid, add.map((l) => ({ title: typeof l.title === 'string' ? l.title : undefined, url: l.url })));
        } catch (e) {
          this.log.warn('librarian could not add links', { projectId: pid, error: String(e) });
          continue;
        }
        said.push(`Added ${add.length === 1 ? 'a link' : `${add.length} links`} to ${p.title}`);
        ids.add(pid);
        bump('updated');
      }
    }
    if (a.state && typeof a.state === 'object' && job.reason !== 'first-message') {
      const updated: string[] = [];
      for (const [pid, text] of Object.entries(a.state as Record<string, unknown>)) {
        const p = this.projects.record(pid);
        if (!p || !member.has(pid) || typeof text !== 'string' || !text.trim() || text.trim() === p.state) continue;
        this.projects.update(pid, { state: text.trim().slice(0, 2000) });
        updated.push(p.title);
        ids.add(pid);
      }
      if (updated.length) {
        said.push(`Updated ${updated.join(' and ')}'s state`);
        bump('updated');
      }
    }
    // A project whose name has gone out of date: the tool it's about was
    // renamed ("Chrome browser control" after Paws became BrowserBear, 30
    // Oct 2026), or the work got a name. Only one the thread is in, never
    // one Mike named, and not from the first message alone.
    if (job.reason !== 'first-message') {
      for (const [pid, name] of Object.entries(byProject(a.retitle))) {
        const p = this.projects.record(pid);
        if (!p || !member.has(pid) || (p.titleBy ?? p.createdBy) === 'mike') continue;
        const next = projectTitle(name);
        if (!next || next.toLowerCase() === p.title.toLowerCase()) continue;
        try {
          this.projects.update(pid, { title: next, by: 'librarian' });
        } catch (e) {
          this.log.warn('librarian could not rename a project', { projectId: pid, error: String(e) });
          continue;
        }
        said.push(`Renamed ${p.title} to ${next}`);
        ids.add(pid);
        bump('updated');
      }
    }
    // Not a change to any project, so not in what the look says it did.
    if (typeof a.thread === 'string' && a.thread.trim()) this.host.setBrief?.(rec.id, a.thread);
    // A thread that has moved on from its title gets a new one. Not from
    // the first message alone: the title model has only just named it.
    if (typeof a.title === 'string' && a.title.trim() && job.reason !== 'first-message') {
      const renamed = this.host.retitleFromLibrarian?.(rec.id, a.title, title);
      if (renamed) {
        said.push(`Renamed it ${renamed}`);
        bump('updated');
      }
    }
    // Hibernating threads whose topic Mike has just talked about here.
    if (Array.isArray(a.wake)) {
      const waiting = this.waitingFor(rec);
      const woke: string[] = [];
      for (const id of a.wake) {
        const w = typeof id === 'string' && id.length >= 8 ? waiting.find((x) => x.threadId.startsWith(id)) : undefined;
        if (w && !woke.includes(w.title) && this.host.wakeForTopic?.(w.threadId, rec.id)) woke.push(w.title);
      }
      if (woke.length) {
        said.push(`Woke ${woke.join(' and ')}`);
        bump('updated');
      }
    }
    // Threads waiting until this one had done something, which it has:
    // only those the look was shown, by a unique id, with a reason.
    const shown = this.shownWaiters.get(rec.id) ?? [];
    this.shownWaiters.delete(rec.id);
    if (a.met && typeof a.met === 'object' && !Array.isArray(a.met)) {
      const woke: { id: string; title: string }[] = [];
      for (const [id, reason] of Object.entries(a.met as Record<string, unknown>)) {
        if (typeof reason !== 'string' || !reason.trim() || id.length < 8) continue;
        const hits = shown.filter((x) => x.threadId.startsWith(id));
        const w = hits.length === 1 ? hits[0] : undefined;
        if (w && !woke.some((x) => x.id === w.threadId) && this.host.waitMet?.(w.threadId, rec.id, reason.trim(), w.until)) woke.push({ id: w.threadId, title: w.title });
      }
      if (woke.length) {
        said.push(`Woke ${woke.map((x) => x.title).join(' and ')}`);
        bump('updated');
      }
    }
    const why = typeof a.why === 'string' ? a.why.trim().slice(0, 200) : '';
    const text = said.length ? said.join('. ') : why ? `Nothing to change: ${lowerFirst(why)}` : 'Nothing to change';
    this.note(job, outcome, text, [...ids]);
  }

  // The other threads waiting on a topic.
  private waitingFor(rec: ThreadRecord): { threadId: string; title: string; topic: string }[] {
    return (this.host.waitingTopics?.() ?? []).filter((w) => w.threadId !== rec.id);
  }

  private markLooked(rec: ThreadRecord, job: LibrarianJob): void {
    // Its seq as it is now, after any notes the look added.
    const seq = this.host.threadRecords().find((t) => t.id === rec.id)?.lastSeq ?? rec.lastSeq;
    this.looks[rec.id] = { at: new Date(this.clock.now()).toISOString(), seq, ...(job.reason === 'first-message' ? { early: true } : {}) };
    // An early look hasn't seen the turn's edits yet; the first-turn look will.
    if (job.reason !== 'first-message') {
      this.edited.delete(rec.id);
      this.workedIn.delete(rec.id);
    }
  }

  private note(job: LibrarianJob, outcome: LibrarianOutcome, text: string, projectIds?: string[]): void {
    this.entry({
      threadId: job.threadId,
      threadTitle: this.host.threadRecords().find((t) => t.id === job.threadId)?.title ?? job.threadTitle,
      reason: job.reason,
      outcome,
      text,
      ...(projectIds?.length ? { projectIds } : {}),
    });
    this.log.info('librarian looked', { threadId: job.threadId, reason: job.reason, outcome, text });
  }

  // Onto what it did, newest first.
  private entry(e: Omit<LibrarianEntry, 'id' | 'at'>): void {
    this.recent.unshift({ id: crypto.randomBytes(6).toString('hex'), at: new Date(this.clock.now()).toISOString(), ...e });
    if (this.recent.length > RECENT_KEPT) this.recent.length = RECENT_KEPT;
  }

  // ------------------------------------------------------------- icons

  // A look at icons shortly, for new or changed projects (or all of them
  // when the hourly sweep is due).
  private iconsSoon(): void {
    this.iconTimerSet(this.clock.now() + ICON_SOON_MS);
  }

  private iconTimerSet(at: number): void {
    if (this.stopped) return;
    if (this.iconTimer && this.iconTimerAt <= at) return;
    this.iconTimer?.cancel();
    this.iconTimerAt = at;
    this.iconTimer = this.clock.setTimeout(() => {
      this.iconTimer = undefined;
      this.iconTimerAt = Infinity;
      void this.keepIcons();
    }, Math.max(0, at - this.clock.now()));
  }

  // Finds, refreshes or picks every project's icon that needs it. One run
  // at a time; a change during a run means another straight after.
  keepIcons(): Promise<void> {
    if (this.iconRun) {
      this.iconAgain = true;
      return this.iconRun;
    }
    this.iconRun = (async () => {
      do {
        this.iconAgain = false;
        const now = this.clock.now();
        const full = now >= this.iconFullDue;
        if (full) this.iconFullDue = now + ICON_SWEEP_MS;
        for (const p of this.projects.list()) {
          if (this.stopped) return;
          const rec = this.projects.record(p.id);
          if (!rec) continue;
          const sig = JSON.stringify([rec.folders, rec.title, rec.icon?.by ?? '', rec.icon?.image?.path ?? rec.icon?.symbol ?? '']);
          if (!full && this.iconSeen.get(rec.id) === sig) continue;
          try {
            await this.keepIcon(rec.id);
          } catch (e) {
            this.log.warn('librarian could not keep an icon', { projectId: rec.id, error: String(e) });
          }
          // As it is now, after any change this made, so that isn't
          // looked at again.
          const after = this.projects.record(rec.id);
          if (after) this.iconSeen.set(rec.id, JSON.stringify([after.folders, after.title, after.icon?.by ?? '', after.icon?.image?.path ?? after.icon?.symbol ?? '']));
        }
      } while (this.iconAgain && !this.stopped);
    })().finally(() => {
      this.iconRun = undefined;
      if (!this.stopped) this.iconTimerSet(this.iconFullDue);
    });
    return this.iconRun;
  }

  // One project: the best picture in its folders, copied again when it's
  // a different file or the file has changed; with none, a symbol from the
  // small model. Never one Mike or an agent chose.
  private async keepIcon(projectId: string): Promise<void> {
    const rec = this.projects.record(projectId);
    if (!rec || (rec.icon && rec.icon.by !== 'librarian')) return;
    const found = rec.folders.length ? await findIcon(rec.folders, [rec.title]) : undefined;
    if (found) {
      const hash = await fileHash(found.path);
      if (!hash) return;
      const had = rec.icon?.image;
      if (had && rec.icon?.from === found.path && rec.icon.hash === hash && fs.existsSync(had.path)) return;
      const image = await storeIcon(found.path, this.projects.iconDir, rec.id, hash);
      if (this.stopped) return;
      this.projects.setFoundIcon(rec.id, { image, from: found.path, hash });
      this.log.info('librarian found an icon', { projectId: rec.id, from: found.path });
      return;
    }
    // A picture whose folder has left the project goes; one whose file has
    // just gone from a repo that's still there stays until there's another.
    if (rec.icon?.image) {
      const from = rec.icon.from;
      if (from && rec.folders.some((f) => isInside(from, f)) && fs.existsSync(rec.icon.image.path)) return;
    } else if (rec.icon?.symbol) {
      return;
    }
    const symbol = await this.pickSymbol(rec);
    if (this.stopped) return;
    if (symbol) {
      this.projects.setFoundIcon(rec.id, { symbol });
      this.log.info('librarian picked a symbol', { projectId: rec.id, symbol });
    } else if (rec.icon?.image) {
      // Its picture's folder went and there's no symbol yet: the app's letter.
      this.projects.chooseIcon(rec.id, {}, 'librarian').catch(() => {});
    }
  }

  // A symbol for a project with no picture, from SYMBOLS. Not while paused,
  // and like a look, on the pool only and never for a private folder.
  private async pickSymbol(rec: ProjectRecord): Promise<string | undefined> {
    if (!this.models || this.paused) return undefined;
    const prompt = [
      `Project "${rec.title}"`,
      rec.folders.length ? `Folders: ${rec.folders.map((f) => this.tilde(f)).join(', ')}` : '',
      rec.goals ? `Goals: ${rec.goals.slice(0, 400)}` : '',
      '',
      `Symbols: ${SYMBOLS.join(' ')}`,
    ]
      .filter((l) => l !== undefined)
      .join('\n');
    const res = await this.models.generate({ feature: 'projects', cwd: rec.folders[0], system: SYMBOL_SYSTEM, prompt, maxTokens: 1000 });
    if (!res.ok) {
      if (!WAIT_FOR.includes(res.reason)) this.log.info('librarian could not pick a symbol', { projectId: rec.id, reason: res.reason });
      return undefined;
    }
    this.rollDay();
    this.used(res);
    const words = res.value.toLowerCase().match(/[a-z0-9.]+/g) ?? [];
    return words.map((w) => trimEndOf(w, '.')).find((w) => SYMBOLS.includes(w));
  }

  // ------------------------------------------------------------- notes

  // Agents add to a project's notes as they go, and they grew into a log
  // of everything that landed until Threadbear's hit the cap and a note was
  // refused (Mike, 30 Oct). Past NOTES_LONG the librarian rewrites them as
  // decisions, gotchas and what's owed, keeping the old ones on disk.
  private notesSoon(): void {
    // Once, NOTES_SOON_MS after the first change: projects change often
    // (every look), so pushing it back on each would put it off for good.
    if (this.stopped || this.notesTimer) return;
    this.notesTimer = this.clock.setTimeout(() => {
      this.notesTimer = undefined;
      void this.keepNotes();
    }, NOTES_SOON_MS);
  }

  // Every project whose notes have got long, one at a time. Not while
  // paused, and like a look, on the pool only.
  keepNotes(): Promise<void> {
    if (this.notesRun) return this.notesRun;
    this.notesRun = (async () => {
      for (const p of this.projects.list()) {
        if (this.stopped || this.paused || !this.models) return;
        const rec = this.projects.record(p.id);
        if (!rec || rec.notes.length <= NOTES_LONG || this.notesTried.get(rec.id) === rec.notes) continue;
        try {
          await this.tidyNotes(rec);
        } catch (e) {
          this.notesTried.set(rec.id, rec.notes);
          this.log.warn('librarian could not tidy notes', { projectId: rec.id, error: String(e) });
        }
      }
    })().finally(() => {
      this.notesRun = undefined;
    });
    return this.notesRun;
  }

  private async tidyNotes(rec: ProjectRecord): Promise<void> {
    const before = rec.notes;
    const about = [`Project "${rec.title}"`, rec.goals && `Goals: ${rec.goals}`, rec.state && `State: ${rec.state}`].filter(Boolean);
    const prompt = [...about, '', 'Notes:', before].join('\n');
    const res = await this.models!.generate({ feature: 'projects', cwd: rec.folders[0], system: NOTES_SYSTEM, prompt, maxTokens: 4000 });
    if (this.stopped) return;
    if (!res.ok) {
      // No pool or no room: the next change to the project tries again.
      if (!WAIT_FOR.includes(res.reason)) {
        this.notesTried.set(rec.id, before);
        this.log.info('librarian could not tidy notes', { projectId: rec.id, reason: res.reason });
      }
      return;
    }
    this.rollDay();
    this.used(res);
    // Something added while the model was writing would be lost: leave
    // them, and the change that came with it brings it back here.
    if (this.projects.record(rec.id)?.notes !== before) return;
    const after = tidiedNotes(res.value);
    if (after.length < 200 || after.length > Math.min(NOTES_LONG, before.length * 0.8)) {
      this.notesTried.set(rec.id, before);
      this.log.info('librarian could not shorten notes', { projectId: rec.id, before: before.length, after: after.length });
      return;
    }
    const kept = this.keepOldNotes(rec.id, before);
    this.projects.update(rec.id, { notes: after });
    this.entry({
      threadId: '',
      threadTitle: '',
      reason: 'notes',
      outcome: 'updated',
      text: `Tidied ${rec.title}'s notes, ${before.length.toLocaleString('en')} to ${after.length.toLocaleString('en')} characters`,
      projectIds: [rec.id],
    });
    this.log.info('librarian tidied notes', { projectId: rec.id, before: before.length, after: after.length, kept });
    this.changed(false);
  }

  // The notes as they were, in <data dir>/project-notes, so nothing a
  // rewrite dropped is gone for good. The newest NOTES_KEPT per project.
  private keepOldNotes(projectId: string, notes: string): string {
    const dir = path.join(path.dirname(this.file), 'project-notes');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(this.clock.now()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${projectId}-${stamp}.md`);
    atomicWriteFileSync(file, notes);
    const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${projectId}-`)).sort().reverse();
    for (const f of old.slice(NOTES_KEPT)) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  }

  // ------------------------------------------------------------- helpers

  private sortedQueue(): LibrarianJob[] {
    return [...this.queue.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt) || RANK[a.reason] - RANK[b.reason]);
  }

  // Saves and tells every client. `reschedule` false while a look runs.
  private changed(reschedule = true): void {
    if (this.stopped) return;
    try {
      // The look in flight is saved as queued, so a runner that takes over
      // mid-look (a handover, a crash) does it again rather than losing it.
      const queue = [...this.queue.values()];
      if (this.current && !this.queue.has(this.current.threadId)) {
        const { startedAt: _, ...job } = this.current;
        queue.unshift(job);
      }
      atomicWriteFileSync(
        this.file,
        JSON.stringify({ paused: this.paused, queue, recent: this.recent, looks: this.looks, day: this.day, pocketAdded: this.pocketAdded } satisfies Saved),
      );
    } catch (e) {
      this.log.warn('could not save librarian.json', { error: String(e) });
    }
    this.host.publish({ method: 'librarian.updated', params: { librarian: this.status() } });
    if (reschedule) {
      // A pause or resume, or a new job sooner than the timer.
      if (this.paused) {
        this.timer?.cancel();
        this.timer = undefined;
        this.timerAt = Infinity;
      } else this.schedule();
    }
  }

  private rollDay(): void {
    const d = new Date(this.clock.now());
    const date = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (this.day.date !== date) this.day = { date, looks: 0 };
  }

  // What a call used, into the day's figures.
  private used(res: { tokens?: number; notionalUsd?: number }): void {
    this.day.tokens = (this.day.tokens ?? 0) + (res.tokens ?? 0);
    this.day.notionalUsd = (this.day.notionalUsd ?? 0) + (res.notionalUsd ?? 0);
  }

  // The repo a file belongs to (the nearest folder with .git), else its
  // folder. A git worktree counts as its main checkout: worktrees come and
  // go, and the main one is where the project's patches live.
  private repoOf(file: string): string {
    return this.repoOfDir(path.dirname(file));
  }

  private repoOfDir(dir: string): string {
    const repo = findUp(dir, this.home, (d) => fs.existsSync(path.join(d, '.git')));
    return repo ? mainCheckout(repo) : dir;
  }

  // Repos the thread ran commands in that neither its folder nor any of
  // its projects has.
  private newWorkedIn(rec: ThreadRecord): string[] {
    const known = [rec.cwd, ...this.projects.foldersFor(rec).map((f) => f.folder)];
    return [...(this.workedIn.get(rec.id) ?? [])].filter((r) => !known.some((k) => isInside(r, k) || isInside(k, r)));
  }

  private isRepo(dir: string): boolean {
    return fs.existsSync(path.join(dir, '.git'));
  }

  // A folder a project may have: one that exists and looks like a project
  // of its own, never home or a catch-all folder of repos.
  private isProjectFolder(dir: string): boolean {
    if (dir === this.home || !isInside(dir, this.home)) return false;
    if (mainCheckout(dir) !== dir) return false;
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
    } catch {
      return false;
    }
    return PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m))) || fs.readdirSync(dir).some((n) => n.endsWith('.xcodeproj') || n.endsWith('.tandem'));
  }

  // "~/x" against the home the librarian was given (a test's fake one).
  private expand(p: string): string {
    const t = p.trim();
    return path.resolve(t === '~' ? this.home : t.startsWith('~/') ? path.join(this.home, t.slice(2)) : t);
  }

  private tilde(p: string): string {
    return p === this.home || p.startsWith(this.home + path.sep) ? '~' + p.slice(this.home.length) : p;
  }
}

// Whether the thread's agent or Mike put it in a project (join_project,
// create_project or the app), rather than the librarian.
function selfFiled(rec: ThreadRecord): boolean {
  return (rec.projects ?? []).some((m) => m.by !== 'librarian');
}

// The main checkout of a git worktree (its .git is a file naming
// <main>/.git/worktrees/<name>), else the folder itself.
//
// Any folder an agent touched can have a file called .git (an unpacked
// archive), so only its start is read, and its first line taken apart by
// hand, as git does: `/^gitdir:\s*(.+?)\s*$/m` on "gitdir: a", a MB of
// spaces and "b" was some 10^11 steps on the event loop (Gautam's scan,
// F29). A worktree's .git is one short line.
const GIT_FILE_BYTES = 4096;
export function mainCheckout(dir: string): string {
  try {
    const gitdir = gitdirOf(readStart(path.join(dir, '.git'), GIT_FILE_BYTES), dir);
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    if (gitdir && gitdir.includes(marker)) return gitdir.slice(0, gitdir.indexOf(marker));
  } catch {
    // A .git folder (EISDIR) or none: the folder is its own checkout.
  }
  return dir;
}

// The folder a .git file's first line names, resolved against the folder
// it's in, or undefined when that line isn't `gitdir: <path>`.
export function gitdirOf(text: string, dir: string): string | undefined {
  const nl = text.indexOf('\n');
  const line = nl < 0 ? text : text.slice(0, nl);
  if (!line.startsWith('gitdir:')) return undefined;
  const target = line.slice('gitdir:'.length).trim();
  return target ? path.resolve(dir, target) : undefined;
}

// Up to `max` bytes from the start of a file. Throws as readFileSync does,
// EISDIR for a folder.
function readStart(file: string, max: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const PROJECT_MARKERS = ['.git', 'package.json', 'Package.swift', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'AGENTS.md', 'CLAUDE.md'];

const WAIT_FOR: ModelFailure[] = ['no-pool', 'off', 'no-room'];

function offReason(reason: ModelFailure, message: string): string {
  if (reason === 'no-pool') return 'Needs a Claude pool to run on';
  // "Every login in Claude is out of room"
  if (reason === 'no-room') return message.replace(/\.$/, '');
  if (reason === 'off') return 'Model calls are off';
  return message;
}

// What of a look's answer can touch the Pocket. A look can only change this
// thread's own cards, which is why they're matched by thread, not by what the
// model says. A card can't be guessed into being either: anything on it with a
// digit or a run of capitals (an address, a booking code) must be in what the
// look was shown, as a small model will happily make those up.
type PocketSave = { title: string; text: string; place?: string; icon?: PocketIconName };

// A card is this thread's only if this Mac's own key filed it for this
// thread. One another Mac filed (filedBy, through its runner key) can name
// any thread id, and its text is that Mac's: it's listed by title only,
// marked, and never acted on (docs/protocol.md, "Runner keys").
function isOwnCard(c: PocketCardSummary, threadId: string): boolean {
  return c.threadId === threadId && !c.filedBy;
}

const OTHER_TITLE_CHARS = 60;

/** The look's lines about the Pocket. */
export function pocketPromptLines(threadId: string, cards: PocketCardSummary[]): string[] {
  const lines = ['Pocket cards from this thread:'];
  const own = cards.filter((c) => isOwnCard(c, threadId));
  if (!own.length) lines.push('(none)');
  for (const c of own) lines.push(`- "${c.title}"${c.place ? ` (place: ${c.place})` : ''}: ${c.text.replace(/\n/g, ' / ')}`);
  // Others' titles only, one line and short each: a title is whatever its
  // filer wrote, another Mac's included.
  const short = (t: string) => {
    const one = t.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
    return one.length > OTHER_TITLE_CHARS ? one.slice(0, OTHER_TITLE_CHARS - 1) + '…' : one;
  };
  const others = cards.filter((c) => !isOwnCard(c, threadId)).map((c) => `"${short(c.title)}"${c.filedBy ? ` (filed from ${c.filedBy}: not to act on)` : ''}`);
  if (others.length) lines.push(`Other Pocket cards, not yours to touch: ${others.join(', ')}`);
  return lines;
}

export function pocketChanges(
  raw: unknown,
  ctx: { threadId: string; cards: PocketCardSummary[]; seen: string; addsToday: number; addedBefore: boolean },
): { save: PocketSave[]; remove: string[] } {
  const out = { save: [] as PocketSave[], remove: [] as string[] };
  if (!raw || typeof raw !== 'object') return out;
  const key = (t: string) => t.trim().toLowerCase();
  const own = new Map(ctx.cards.filter((c) => isOwnCard(c, ctx.threadId)).map((c) => [key(c.title), c]));
  const taken = new Set(ctx.cards.map((c) => key(c.title)));
  const seen = ctx.seen.toLowerCase();
  const grounded = (text: string) =>
    text
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter((w) => /\d|\p{Lu}{4}/u.test(w))
      .every((w) => seen.includes(w.toLowerCase()));
  const { save, remove } = raw as { save?: unknown; remove?: unknown };
  let added = false;
  for (const c of Array.isArray(save) ? save : []) {
    const title = typeof c?.title === 'string' ? c.title.trim() : '';
    const text = typeof c?.text === 'string' ? c.text.trim() : '';
    const place = typeof c?.place === 'string' && c.place.trim() ? c.place.trim().slice(0, 100) : undefined;
    // One it made up is left off: the card still gets the plain look.
    const icon = POCKET_ICONS.find((n) => n === c?.icon);
    if (!title || title.length > 60 || !text || text.length > 2000 || !grounded(text)) continue;
    const mine = own.get(key(title));
    if (mine) {
      if (mine.text !== text || (place ?? mine.place) !== mine.place || (icon && icon !== mine.icon)) out.save.push({ title, text, ...((place ?? mine.place) ? { place: place ?? mine.place } : {}), ...(icon ? { icon } : {}) });
    } else if (!taken.has(key(title)) && !own.size && !ctx.addedBefore && !added && ctx.addsToday < POCKET_ADDS_PER_DAY) {
      added = true;
      out.save.push({ title, text, ...(place ? { place } : {}), ...(icon ? { icon } : {}) });
    }
  }
  const saving = new Set(out.save.map((c) => key(c.title)));
  for (const t of Array.isArray(remove) ? remove : []) {
    const mine = typeof t === 'string' ? own.get(key(t)) : undefined;
    if (mine && !saving.has(key(mine.title))) out.remove.push(mine.title);
  }
  return out;
}

export const SYSTEM = `You are the librarian in Threadbear, an app where the user runs AI coding agents in threads. ${userLine()}You keep their projects: groupings above folders that carry goals, state and notes from thread to thread. A project is a body of work they'll come back to (an app, a library, a video, a house job, an ongoing chore), never a single task. One project can span several repos, and a thread can be in several projects.

Given the project list and one thread, decide which projects the thread belongs in, and say why in a few plain words the user will see beside each project. A thread belongs in a project when it's about that project: building, fixing, planning, ideas, research or questions for it. A thread whose folder is a project's repo almost always belongs in that project. Prefer existing projects. Make a new one when the thread is about a body of work that fits none of them (its own repo is a strong sign); a one-off question, a quick chore or a throwaway test belongs in none. Never put a thread back in one it says never to.

Most threads in a catch-all folder belong in no project: errands, personal admin, bookings, one-off questions. Put a thread in a project only when its own messages are about that project's work and you can say what it does there. A project having a folder inside the same catch-all folder isn't enough, and nor is the thread using a tool that is one of the projects (a browser tool, Threadbear itself) or starting a thread to fix one. When nothing clearly fits, projects is [] and new is null: an empty answer is right far more often than a guess.

Reply with JSON only, no prose and no code fence:
{"projects": ["<ids of existing projects the thread belongs in, or []>"],
 "reasons": {"<project id>": "why the thread belongs there"} for every id in projects (an id without a reason is ignored),
 "leave": {"<project id>": "why the thread isn't about it"} for a project it's currently in (not pinned) that it turns out not to be about, else {},
 "new": null or {"title": "short name, as the user would say it", "folders": ["~/path of its repo(s)"], "goals": "one or two sentences: what it's for", "state": "one or two sentences: where it's up to", "why": "why the thread belongs there"},
 "state": {"<project id>": "the project's new state"} only when this thread changed where the whole project stands (shipped or finished something, made a decision, hit a blocker), else {},
 "addFolders": {"<project id>": ["~/path"]} for repos this thread shows belong to a project it's in, else {},
 "links": {"<project id>": [{"title": "Live site", "url": "https://..."}]} for lasting places of a project it's in that the messages give and the project doesn't list yet, else {},
 "thread": "where this thread itself is up to, as two or three short bullets, one per line, each starting \"- \": what it did or found, and what it's waiting on or doing next",
 "title": null, or a new title when the thread's title no longer says what it's about (see below),
 "retitle": {"<project id>": "the project's new name"} for a project it's in whose name has gone out of date (see below), else {},
 "wake": ["<ids of hibernating threads the user is talking about here>"], or [] (see below),
 "met": {"<id of a thread waiting until this one has done something>": "what shows it has, in a few words"}, or {} (see below),
 "pocket": null, or {"save": [{"title": "short name", "text": "the card", "place": "optional", "icon": "optional"}], "remove": ["title"]} (see below),
 "why": "one short line"}

A reason is under 12 words, about this thread, in the user's plain words: "Edits the podcast app's repo", "Shortlists photos for the calendar entry", "Asks how the librarian picks projects". Leaving a project out of projects doesn't take the thread out of it; only leave does. Use leave when the thread clearly isn't about that project: the earlier guess was wrong, or the work has gone elsewhere for good. A thread that has only paused that work stays.

Folders are repos the work lives in (the thread's folder when it's a repo, the repos it edited, and the ones it ran commands in when the work was about them, not a look at something else), never a catch-all folder. A project with no folders that this thread worked on in a repo should get that repo through addFolders. State is two to four plain sentences about the whole project, not this thread: what's done, what's next, what's blocked. Start from the current state, keep what's still true and fold the change in; don't replace it with this thread's details. Ideas and plans that aren't built yet don't change the state.

Links are the few places the user keeps going back to for a project: its live site, admin page, dashboard, store listing. Copy the url exactly from the messages and give it a short title ("Live site", "Admin", "App Store"). Never a pull request, commit, issue, docs page, localhost, file or one-off page.

Keep the thread's title (title null) unless it no longer says what the thread is about: the work moved on to something else, or the title is only the first words of the first message ("Hey, does the library, sorry, the librarian, does it update"). A better wording of the same subject is no reason. A new title is 2 to 6 words about the whole thread as it is now, in sentence case (a capital for the first word and for names only), with no quotes, full stop, dash or emoji: "Fix the flaky upload test on CI", "Librarian renames threads that move on".

Keep projects' names too, unless one the thread is in has gone out of date: the thing it's about was renamed (an app renamed from Scribble to Inkwell leaves "Scribble" or a vaguer "drawing app" behind), or a project named for what it does now has a name of its own. Give the new name the user would say, keeping the old words in brackets when they still help: "Inkwell (drawing app)". A better wording of the same name is no reason, and never rename one marked as named by the user. Most looks rename none.

Some hibernating threads are waiting for the user to talk about something again ("woodworking"). Put one in wake when the user's own messages in this thread are about that: they're working on it, planning it or asking about it. A passing mention, or only the agent bringing it up, isn't enough. Most looks wake none.

Some hibernating threads are waiting until this thread has done something ("until it reports the I/O saving"). Put one in met when this thread's messages, the agent's or the user's, show it has: done, measured, reported or decided, not only planned, started or still going. Most looks meet none.

The Pocket is a deck of short cards on the user's phone, to read at a counter when they're out. Keep this thread's cards true: save one with the same title when a fact on it has changed, and remove one when the messages say it's done with (the parcel's posted, the trip's over). Add a card only when the user, in their own messages here, says they're going somewhere or will need something while out, the messages hold the facts they'd want there, and this thread has no card. A plan for someday isn't enough. If the messages say a card was filed and it isn't listed, the user took it out: leave it. Copy addresses, codes and numbers exactly from the messages and never guess one. The text is only the facts, a line each, with no explanation. The place is what you'd search a map for ("post office"), only if the card is for somewhere. The icon is the closest of ${POCKET_ICONS.join(', ')}, left out if none fits. Most looks change nothing: pocket null.

The thread bullets are for the user glancing at the thread later: concrete, in their plain words, each under ten words, no full stops. The last one says who's waiting on whom ("Waiting on you to pick a design", "Fixing the last failing test").`;

const NOTES_SYSTEM = `You tidy a project's notes in Threadbear, the user's app for running AI coding agents in threads. ${userLine()}Agents add to a project's notes as they work, and these have grown into a log. Rewrite them as short markdown notes that a later agent reads before working on the project.

Keep: the user's decisions and why, facts and gotchas the code doesn't make obvious (deployment names, commands, where things live, what breaks and how to tell), and what's still owed or waiting on someone, with its date.
Drop: what was built or landed (git and the docs record that), commit hashes, test runs and checks that passed, and anything a later note replaced or that has since been done.
Merge notes on the same subject. Keep names, paths, ids and numbers exactly as written, and never add anything that isn't in the notes.

Use three sections, "## Decisions", "## Facts and gotchas" and "## Open", with one short bullet per item. Stay under 6,000 characters. Reply with the notes only.`;

// The model's notes without a code fence it may have put round them.
export function tidiedNotes(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, '$1')
    .trim();
}

function attached(images?: number): string {
  return images ? ` (with ${images === 1 ? 'an image' : `${images} images`} you can't see)` : '';
}

const SYMBOL_SYSTEM = `You pick an icon for a project in Threadbear, an app for running AI coding agents. Given the project and a list of SF Symbol names, reply with the one name from the list that best shows what the project is about, and nothing else.`;

function parseAnswer(text: string): Answer | undefined {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(t.slice(start, end + 1)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Answer) : undefined;
  } catch {
    return undefined;
  }
}

// A `{ "<project id>": "a line" }` from the model, without the junk.
function byProject(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, line] of Object.entries(v as Record<string, unknown>)) {
    if (typeof line === 'string' && line.trim()) out[k] = line.trim().replace(/\s+/g, ' ').slice(0, WHY_MAX);
  }
  return out;
}

// A reason that says the thread doesn't belong: "Not that; ignore",
// "Unrelated", "No clear fit". A real one says what the thread does there.
export function saysNoFit(why: string): boolean {
  return /^(not|no|none|n\/a|ignore|unrelated|irrelevant|doesn'?t|isn'?t|nothing)\b/i.test(why.trim()) || /\b(ignore|unrelated|no (clear )?(fit|match)|not (about|related|part|tied|relevant))\b/i.test(why);
}

function readNew(v: unknown): { title: string; folders: string[]; goals: string; state: string; why: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const n = v as Record<string, unknown>;
  if (typeof n.title !== 'string' || !n.title.trim()) return undefined;
  return {
    title: n.title.trim().slice(0, 80),
    folders: Array.isArray(n.folders) ? n.folders.filter((f): f is string => typeof f === 'string') : [],
    goals: typeof n.goals === 'string' ? n.goals.trim().slice(0, 2000) : '',
    state: typeof n.state === 'string' ? n.state.trim().slice(0, 2000) : '',
    why: typeof n.why === 'string' ? n.why.trim() : '',
  };
}

// A project name from the model, tidied like a thread title: no quotes or
// full stop round it. Too long reads as a sentence, not a name.
function projectTitle(name: string): string | undefined {
  // By hand, not `/^["'“‘]+|["'”’]+$/g` and `/\.+$/`: a model's name ending
  // in a long run of quotes or dots made those quadratic.
  const unquote = (s: string) => trimEndOf(trimStartOf(s, `"'“‘`), `"'”’`);
  const t = unquote(trimEndOf(unquote(name.trim()), '.')).trim();
  return t && t.length <= 60 ? t : undefined;
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ------------------------------------------------------------- the methods

export function librarianMethods(l: Librarian): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'librarian.status': () => ({ librarian: l.status() }),
    'librarian.run': (p) => {
      if (p.threadId !== undefined && p.threadId !== null && typeof p.threadId !== 'string') throw new RpcError(ErrorCode.badParams, 'threadId must be a string');
      return { librarian: l.run((p.threadId as string | undefined) ?? undefined) };
    },
    'librarian.update': (p) => {
      if (p.paused !== undefined && typeof p.paused !== 'boolean') throw new RpcError(ErrorCode.badParams, 'paused must be a boolean');
      return { librarian: l.update({ paused: p.paused as boolean | undefined }) };
    },
  };
}

export type { ProjectRecord };
