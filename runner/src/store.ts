import type { HighlightState } from './highlights.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { WaitingForRoom, Ask, AskAnswer, NeedsWho, DesignReview, ReplyButton, ReviewDraft, EffortLevel, MessageOrigin, PanelRequest, PermissionMode, ThreadShare, PersistedEvent, Provider, ArchivedBy, ArchiveVerdict, Subagent, ThreadProject, ThreadSchedule, ThreadStartedBy, ThreadStatus, ImageRef, LooseEnd } from './protocol.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { paths } from './config.ts';
import type { WorktreeRecord } from './worktrees.ts';
import type { WakeWhen } from './wake-when.ts';

export type QueuedSend = { turnId: string; text: string; images: ImageRef[]; origin?: MessageOrigin; scheduleId?: string; reviewId?: string; reviewResponse?: ReviewDraft; answers?: AskAnswer[]; editOf?: number };

// What thread.json holds: the public summary fields plus a few internal ones.
export type ThreadRecord = {
  id: string;
  title: string;
  cwd: string;
  accountId: string;
  // The pool that picks the login (pools.ts). Absent: pinned to accountId,
  // never moved; every thread from before pools.
  poolId?: string;
  // Every login in the pool is out of room: the thread carries on by
  // itself at `until` (an ISO time). Kept here so the wait survives a
  // restart; start() re-arms its timer.
  waitingForRoom?: WaitingForRoom;
  // The id of the runner's own carry-on turn after a login ran dry, so a
  // carry-on that runs dry straight away waits rather than move again.
  autoCarryOn?: string;
  // A turn failed because the API couldn't be reached (errorKind network):
  // the thread carries on by itself once a probe reaches it again
  // (Runner.onNetworkLost). `since` is when the line first went, `tries`
  // the carry-ons sent since. Kept here so the wait survives a restart.
  waitingForNetwork?: { since: string; tries: number };
  // The runner's own carry-on after that, so if it can't get through
  // either the thread waits again, counting on from the same outage.
  netCarryOn?: { turnId: string; since: string; tries: number };
  // The turn a restart (or a crash, or the Mac restarting) cut off, until
  // the runner that comes next carries it on (Runner.carryOnStopped).
  stoppedMidTurn?: { turnId: string; at: string };
  // That carry-on's turn id: if it's cut off too, it isn't carried on again.
  restartCarryOn?: string;
  // Background work a handover or a restart stopped, until the runner that
  // comes next tells the thread (Runner.tellStoppedWork). Kept here because
  // the stop and the telling happen in different runners.
  stoppedWork?: { what: string[]; at: string };
  // Times it has been woken for that since anyone last wrote to it.
  stoppedWorkWakes?: number;
  provider: Provider;
  model?: string;
  effort?: EffortLevel;
  modelInUse?: string; // full id the CLI ran the last turn on
  effortInUse?: EffortLevel; // the level the CLI reported for the last turn
  permissionMode: PermissionMode;
  // Its CLI runs in a sandbox (sandbox.ts) and must stay in one: set when it
  // starts in a sandbox folder or a sandboxed thread's agent starts it
  // there, and taken off only by a move Mike made or allowed. A thread with
  // it never starts outside a sandbox, whatever its folder has become
  // (Daybreak, 7 Nov 2026), and its agent counts as restricted
  // (threadbear-mcp.ts, "Raising access").
  confined?: true;
  // "Plan first": the mode approving the plan goes back to, and the plan
  // waiting for Mike (its plan.proposed itemId).
  modeBeforePlan?: PermissionMode;
  openPlan?: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  snoozedUntil?: string;
  snoozedUntilRestart?: boolean; // snoozedUntil is UNTIL_RESTART; start() wakes it
  untilRelease?: string; // with snoozedUntilRestart: only a start on another release wakes it
  wakeWhen?: WakeWhen; // hibernated in Mike's words (wake-when.ts)
  // Hibernating until these threads finish (end_turn's waitFor,
  // runner/hibernation.ts): each counts once it has finished (with no new
  // work since), been archived or been deleted.
  // `until`: waits for something in particular, which the librarian
  // judges from its looks at that thread (met), not for any finish.
  // `review`: the thread is a review of this one's change (runner/lab-review.ts).
  waitingOn?: { threadId: string; title: string; until?: string; review?: true; done?: { at: string; how: 'finished' | 'met' | 'archived' | 'deleted'; reply?: string; why?: string } }[];
  // Its last finished turn (nothing needed, nothing left running) and that
  // turn's reply, for threads waiting on it, including on a runner it
  // moves to (runner/hibernation.ts, reconcileWaits). Cleared by any new
  // work (a message, a turn its CLI opens), so no clock is compared.
  finished?: { at: string; reply?: string };
  // Review by another lab (runner/lab-review.ts): reviewOf is set on a
  // review thread (the thread whose change it checks), which never gets a
  // review of its own; labReviews counts the reviews since Mike last wrote.
  reviewOf?: string;
  labReviews?: number;
  // A review a draining, restarting or stopping runner couldn't start (it
  // makes no threads), for the runner that adopts or loads this one to start.
  // `seq`: where that turn's events end, which its diff is read back from.
  labReviewOwed?: { turnId: string; seq?: number; reply?: string };
  snoozedAt?: string; // when it was last put away, for how long it slept; may be stale once awake
  woke?: { at: string; since?: string }; // woke by itself and not looked at yet (since = snoozedAt)
  archivedAt?: string;
  // Who archived it, and Mike's verdict from the done card. Set afresh by
  // every archive and only read while archivedAt is set, so the paths that
  // bring a thread back needn't clear them.
  archivedBy?: ArchivedBy;
  archiveVerdict?: ArchiveVerdict;
  // A schedule's message brought it out of the archive (Runner.sendTo), and
  // who had archived it: a run that ends with nothing for Mike puts it back.
  unarchivedBySchedule?: { by?: ArchivedBy };
  starredAt?: string; // Mike starred it: the Starred section, oldest star first
  preview: string;
  lastSeq: number;
  lastSeenSeq: number;
  nativeSessionId?: string;
  contextTokens?: number;
  contextWindow?: number; // the model's window, when the CLI reports it
  costUsd?: number;
  reviews?: DesignReview[];
  reviewDeliveries?: string[]; // review IDs whose reply reached session.send
  buttons?: ReplyButton[]; // its reply buttons, oldest first (runner/buttons.ts)
  // Internal.
  // The version of the CLI that ran the thread's last session, so a new
  // session on another version can say so ("Codex 0.165.0 from this turn
  // on (was 0.164.0)") even after an idle release.
  cliVersion?: string;
  // Set when a same-account folder move on an adapter that moves folders
  // itself (Codex) is waiting for the next turn, which says so. The
  // session carries on; there's no handoff.
  moved?: { fromCwd: string };
  sessionUsed?: boolean; // nativeSessionId has a transcript, so the next start resumes it
  sessionCostTotal?: number; // the CLI's running total_cost_usd for this native session
  lastTurnCompletedSeq: number;
  forceUnread?: boolean; // set when a snooze ends
  // What the last completed turn said it needs from Mike, with the seq of
  // its turn.completed and which of its asks he has ticked.
  needs?: { seq: number; needs: NeedsWho; asks?: Ask[]; ticked?: number[] };
  // Set when the folder or account changes, or the record had to be
  // rebuilt; the next turn starts a new native session with a note.
  // lost: the session to resume couldn't be found (never saved; only set
  // while the fresh session's first message is put together).
  // quickAsk: the thread began as a quick ask from the phone (Runner.quickAsk),
  // answered by a fast model rather than a session of its own.
  handoff?: { fromCwd: string; fromAccountId: string; rebuilt?: boolean; lost?: boolean; quickAsk?: boolean };
  sample?: true; // one of the tour's sample threads (Runner.samples): made up, never sent to
  allowRules?: string[]; // "Always allow" rules, in the CLI's syntax
  queue: QueuedSend[];
  pendingApprovals: string[];
  turnId?: string; // turn in progress when the record was saved
  titleSet?: boolean;
  titleByMike?: boolean; // named by Mike, so agents leave it alone (Runner.update)
  subagents?: SubagentRecord[]; // newest last, at most SUBAGENTS_KEPT
  // The projects the thread is in (projects.ts), oldest first; titles come
  // from the project list when the summary is made.
  projects?: ThreadProjectRecord[];
  // Projects Mike took the thread out of: the librarian never puts it back.
  projectsLeft?: string[];
  // The projects the native session has been told about (the brief, or a
  // line when it joined one), so it hears about each once.
  projectsTold?: string[];
  // The hash of Mike's standing instructions the native session was last
  // told, so it hears each change once; 'cleared' or 'rewound' (instructions.ts).
  // Absent while it has never held any.
  instructionsTold?: string;
  // Highlights (highlights.ts): what's been found and pinned, and the
  // event it had read up to. Brought up to date when a client asks.
  highlights?: HighlightState;
  highlightsAt?: string; // a pin, a removal or a new brief
  brief?: { text: string; at: string }; // the librarian's line on where the thread is up to
  // The thread's own git worktree (worktrees.ts), once it's made.
  worktree?: WorktreeRecord;
  // The done card's loose ends (runner/loose-ends.ts), for the card at seq.
  looseEnds?: { seq: number; ends: LooseEnd[]; at: string };
  // Made in a repo that asks for worktrees and not told otherwise: the
  // first turn makes one (and runs its setup) before the CLI starts.
  worktreePending?: boolean;
  // The schedule that started the thread, with its title then (the
  // schedule may be renamed or deleted later).
  schedule?: ThreadSchedule;
  // Who started it, when that wasn't Mike. Its why is the starter's, until
  // the thread's own end_turn says how it came out.
  startedBy?: ThreadStartedBy;
  // Mike's last message, one line (askedLine in runner.ts).
  asked?: string;
  // show_panel's request, until the app shows it or Mike sends a message.
  panelRequest?: PanelRequest;
  // The seq ranges edits of earlier messages cut out of the conversation
  // (docs/protocol.md, "Editing a message"), oldest first. Everything that
  // reads the thread for the agent or the librarian leaves them out.
  rewinds?: { from: number; to: number }[];
  // Claude: the transcript entry the next start resumes at, after an edit
  // cut the conversation back. Used once.
  resumeAt?: string;
  // Sharing on the website (Runner.share): who else can read it.
  share?: ThreadShare;
};

// Whether an edit cut the event at `seq` out of the conversation.
export function cutOut(rec: Pick<ThreadRecord, 'rewinds'>, seq: number): boolean {
  return rec.rewinds?.some((r) => seq >= r.from && seq <= r.to) ?? false;
}

export type ThreadProjectRecord = Omit<ThreadProject, 'title'>;

// A sub-agent as the summary shows it, plus where its transcript is: the
// thread can change folder, account or session after it ran.
export type SubagentRecord = Subagent & { sessionId?: string; cwd?: string; accountId?: string };

// Append-only events.ndjson with a byte-offset index, so a page of a
// 4,000-event thread is one read of the bytes it needs. seq N is line N.
export class EventLog {
  readonly file: string;
  private offsets: number[] = [];
  private size = 0;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load(): void {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.file);
    } catch {
      this.offsets = [];
      this.size = 0;
      return;
    }
    const offsets: number[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        offsets.push(start);
        start = i + 1;
      }
    }
    if (start < buf.length) {
      // A crash mid-append left half a line. Drop it so seq stays gapless.
      fs.truncateSync(this.file, start);
    }
    this.offsets = offsets;
    this.size = start;
  }

  get lastSeq(): number {
    return this.offsets.length;
  }

  append(event: PersistedEvent): void {
    if (event.seq !== this.offsets.length + 1) {
      throw new Error(`event seq ${event.seq} out of order (last ${this.offsets.length})`);
    }
    const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      fs.appendFileSync(this.file, line);
    } catch (e) {
      // A write that failed part way (disk full) would leave half a line
      // for the next append to run into; cut it off.
      try {
        if (fs.statSync(this.file).size > this.size) fs.truncateSync(this.file, this.size);
      } catch {
        // can't fix it now; load() drops a half line on the next start
      }
      throw e;
    }
    this.offsets.push(this.size);
    this.size += line.length;
  }

  // Events with fromSeq <= seq <= toSeq.
  read(fromSeq: number, toSeq: number): PersistedEvent[] {
    const from = Math.max(1, fromSeq);
    const to = Math.min(this.offsets.length, toSeq);
    if (to < from) return [];
    const startByte = this.offsets[from - 1];
    const endByte = to < this.offsets.length ? this.offsets[to] : this.size;
    const buf = Buffer.alloc(endByte - startByte);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, startByte);
    } finally {
      fs.closeSync(fd);
    }
    const out: PersistedEvent[] = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as PersistedEvent);
      } catch {
        // Skip a corrupt line rather than failing the whole page.
      }
    }
    return out;
  }
}

export class ThreadStore {
  readonly home: string;
  private logs = new Map<string, EventLog>();

  constructor(home: string) {
    this.home = home;
  }

  threadDir(id: string): string {
    return paths.thread(this.home, id);
  }

  mediaDir(id: string): string {
    return paths.media(this.home, id);
  }

  blobsDir(id: string): string {
    return paths.blobs(this.home, id);
  }

  // The ids of every thread folder on disk, this runner's or not.
  ids(): string[] {
    try {
      return fs.readdirSync(paths.threads(this.home)).filter((n) => !n.startsWith('.'));
    } catch {
      return [];
    }
  }

  // Every thread on disk. `broken` lists folders that have an event log but
  // no readable thread.json, so the runner can rebuild them rather than
  // have the thread vanish.
  loadAll(): { records: ThreadRecord[]; broken: string[] } {
    const dir = paths.threads(this.home);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { records: [], broken: [] };
    }
    const records: ThreadRecord[] = [];
    const broken: string[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const rec = this.load(name);
      if (!rec) {
        if (fs.existsSync(path.join(dir, name, 'events.ndjson'))) broken.push(name);
        continue;
      }
      records.push(rec);
    }
    return { records, broken };
  }

  // One thread's record, or undefined when thread.json is missing or isn't
  // that thread's.
  load(id: string): ThreadRecord | undefined {
    const rec = readJsonSync<ThreadRecord>(path.join(paths.threads(this.home), id, 'thread.json'));
    if (!rec || !rec.id || rec.id !== id) return undefined;
    rec.provider ??= 'claude'; // records from before Codex
    rec.queue ??= [];
    rec.pendingApprovals ??= [];
    rec.lastTurnCompletedSeq ??= 0;
    return rec;
  }

  // Drops the cached event log, so the next log() reads the file again:
  // another runner (a draining one, docs/protocol.md "Handovers") may have
  // written to it since.
  forget(id: string): void {
    this.logs.delete(id);
  }

  // Keeps an unreadable thread.json for a look later, out of the way.
  setAside(id: string): void {
    const file = path.join(this.threadDir(id), 'thread.json');
    try {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
    } catch {
      // nothing to keep
    }
  }

  create(rec: ThreadRecord): void {
    fs.mkdirSync(this.mediaDir(rec.id), { recursive: true });
    fs.mkdirSync(this.blobsDir(rec.id), { recursive: true });
    this.save(rec);
  }

  save(rec: ThreadRecord): void {
    atomicWriteFileSync(path.join(this.threadDir(rec.id), 'thread.json'), JSON.stringify(rec, null, 1) + '\n');
  }

  // Moves a thread's folder to trash/<id>-<time> so it's out of the list but
  // can still be put back by hand.
  trash(id: string, now: number): void {
    const dir = this.threadDir(id);
    if (!fs.existsSync(dir)) return;
    const bin = path.join(this.home, 'trash');
    fs.mkdirSync(bin, { recursive: true });
    fs.renameSync(dir, path.join(bin, `${id}-${now}`));
    this.logs.delete(id);
  }

  log(id: string): EventLog {
    let log = this.logs.get(id);
    if (!log) {
      log = new EventLog(path.join(this.threadDir(id), 'events.ndjson'));
      this.logs.set(id, log);
    }
    return log;
  }
}
