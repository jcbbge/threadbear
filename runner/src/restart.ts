// Restarting the runner without cutting a turn short (docs/dev-tools.md,
// section 2). runner.restart saves the request in <home>/restart.json and
// waits until no thread is starting, running or waiting on an approval or
// a question, and no CLI is running background shells or subagents; then
// main.ts shuts down the way it does on SIGTERM and exits 0, and launchd
// starts the runner again. The next start reads the file, notes the restart
// in the threads that asked to carry on, and sends each of them its resume
// text as a turn of the runner's own.
import type { SecretCheckStatus } from './secret-check.ts';
import type { MacScreenStatus } from './mac-screen.ts';
import type { UpstreamStatus } from './upstream.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Runner } from './runner.ts';
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { SyncStatus } from './sync.ts';
import type { ThreadStatus, ThreadSummary } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { paths, RUNNER_VERSION } from './config.ts';
import { currentLink, pointCurrentAt, readState, releaseExists } from './release.ts';
import type { TimerHandle } from './clock.ts';
import type { UpdateStatus } from './update.ts';

export type RestartWhen = 'idle' | 'now';
export type ResumeRequest = { threadId: string; text: string };

// A resume as saved. release is the release the request expected to come
// back on (deploy-runner.sh's), so a thread resumed on another one (after a
// crash rollback, or a later deploy) is told its change isn't running.
// afterSeq is the thread's last event when it asked: a message someone sent
// after that means they've moved on, and the resume isn't sent.
export type SavedResume = ResumeRequest & { requestedAt: string; release?: string; afterSeq?: number };

// <home>/restart.json. Several requests merge into one: "now" wins and
// every thread's resume is kept (a later one for the same thread replaces
// its earlier one).
export type RestartFile = {
  when: RestartWhen;
  reason?: string;
  requestedAt: string;
  fromVersion: string; // the runner that took the request, for the note afterwards
  release?: string; // the latest request's expected release
  resumes: SavedResume[];
  // When this runner began shutting down for it, or stopped for any other
  // reason while it was pending. A resume's age counts from here, so a
  // restart that waited an hour for a long turn still resumes.
  shutdownAt?: string;
  // After this, background shells and subagents no longer hold it (a dev
  // server never finishes); turns always do.
  backgroundUntil?: string;
  // restart.done.json only: the runner that handled it.
  handledBy?: string;
  handledRelease?: string;
};

export type RestartParams = { when?: RestartWhen; resume?: ResumeRequest; reason?: string; release?: string; backgroundWaitMs?: number; cancel?: boolean };

export type Background = { threadId: string; tasks: string[] };

// runner.restart's result. background is the background work among the
// threads it waits for, so the scripts can name it; note says what a cancel
// did about the release the withdrawn restart was for; noResume why the
// resume asked for won't be sent as things stand, so the scripts don't tell
// an agent to end its turn and wait for a message that never comes.
export type RestartResult = { scheduled: boolean; waitingFor: string[]; background?: Background[]; note?: string; noResume?: string; handover?: { keeps: string[] } };

export type Notice = { level: 'info' | 'warning' | 'error'; message: string };

// runner.status's result (docs/protocol.md).
export type RunnerStatus = {
  version: string;
  release?: string;
  pid: number;
  startedAt: string;
  home: string;
  logFile?: string;
  branch?: string;
  liveClis: number;
  running: string[]; // starting, running or waiting on an approval or a question
  background?: Background[]; // background shells and subagents still going
  pendingRestart?: { when: RestartWhen; reason?: string; release?: string; resumeThreadId?: string; requestedAt: string; backgroundUntil?: string; waitingFor: string[] };
  // This release is running because launch.mjs went back to it from `from`,
  // which kept crashing at startup. A deploy's health check can pass before
  // the crash, so tb status says so for as long as it holds.
  rolledBack?: { from: string; at: string };
  // Older runners still finishing turns after a handover (main.ts adds it).
  draining?: { pid: number; version: string; release?: string; since: string; threads: string[] }[];
  // The runner following main by itself (src/update.ts).
  update?: UpdateStatus;
  // Mike's releases, for a fork (upstream.ts; main.ts adds it).
  upstream?: UpstreamStatus;
  // The Convex mirror (src/sync.ts; main.ts adds it).
  sync?: SyncStatus;
  secretCheck?: SecretCheckStatus;
  // Dialogs on this Mac's screen and Full Disk Access (mac-screen.ts; main.ts adds it).
  macScreen?: MacScreenStatus;
};

export const RESUME_MAX_AGE_MS = 15 * 60_000;
export const RESUMES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

const BUSY: ThreadStatus[] = ['starting', 'running', 'waiting'];
const ALL: ('inbox' | 'snoozed' | 'archived')[] = ['inbox', 'snoozed', 'archived'];

export function restartPath(home: string): string {
  return path.join(home, 'restart.json');
}

// The restart.json this runner handled, kept until it has stayed up long
// enough to be marked good. If it crashes and launch.mjs goes back to the
// last good release, that runner resumes the same threads once more.
export function donePath(home: string): string {
  return path.join(home, 'restart.done.json');
}

export function resumesPath(home: string): string {
  return path.join(paths.run(home), 'resumes.json');
}

// This runner's own bin/ (the release's, or the checkout's when run from
// source), so a bare `tb` in a thread is there and matches the runner.
export const BIN_DIR = path.resolve(import.meta.dirname, '..', 'bin');

// Every CLI gets these, so tools an agent runs (tb self, deploy-runner.sh)
// know which thread and which runner they're in. THREADBEAR_HOME is the one
// tb reads, and agents point it at a dev runner; THREADBEAR_RUNNER_HOME
// always names the runner the thread is on, so the scripts' guards against
// restarting it from inside one of its threads go by that.
export function threadEnv(threadId: string, home: string, basePath = process.env.PATH): Record<string, string> {
  return {
    THREADBEAR_THREAD_ID: threadId,
    THREADBEAR_HOME: home,
    THREADBEAR_RUNNER_HOME: home,
    THREADBEAR_RUNNER_VERSION: RUNNER_VERSION,
    // A picture copied in here can be on the thread's shared page; one
    // anywhere else can't (docs/protocol.md, "Sharing").
    THREADBEAR_MEDIA_DIR: paths.media(home, threadId),
    // The old names too, for skills and scripts written before the rename.
    THREADBARE_THREAD_ID: threadId,
    THREADBARE_HOME: home,
    THREADBARE_RUNNER_HOME: home,
    PATH: basePath ? `${BIN_DIR}:${basePath}` : BIN_DIR,
  };
}

export type RestarterDeps = {
  runner: Pick<Runner, 'list' | 'get' | 'send' | 'note' | 'notice' | 'onNotification' | 'events' | 'backgroundWork' | 'threadsWithHooksRunning' | 'refuseNewTurns'>;
  home: string;
  clock: Clock;
  log: Logger;
  // Shuts the runner down the way SIGTERM does and exits 0 (main.ts).
  restart: () => void;
  // Handovers (docs/protocol.md): whether one is possible (launch.mjs
  // supervises this runner), and starting one, which keeps `keeps` here
  // until their turns end and has the new release take everything else.
  canHandOver?: () => boolean;
  handOver?: (keeps: string[]) => void;
  // Threads a draining runner still has (on the primary): a resume for one
  // waits until it comes across (resumeAdopted).
  elsewhere?: (threadId: string) => boolean;
  version?: string;
  release?: string;
  branch?: string; // the branch the release was built from (release.json)
  logFile?: string;
  // launch.mjs's rollback notice, when this runner is an earlier release
  // because the one deployed kept crashing: the resumed thread asked for
  // the new one, so its note says so.
  rolledBack?: string;
  rolledBackFrom?: string; // the release launch.mjs went back from
  updateStatus?: () => UpdateStatus | undefined;
  // The idle check and the restart run after the current tick: a turn that
  // ends and the queued message that starts straight after it never look
  // idle, and the runner.restart reply goes out before the runner stops.
  defer?: (fn: () => void) => void;
};

export class Restarter {
  private deps: RestarterDeps;
  private version: string;
  private defer: (fn: () => void) => void;
  private startedAt: string;
  private pending?: RestartFile;
  private restarting = false;
  // Resumes for threads still on a draining runner, sent when they arrive.
  private deferred = new Map<string, { saved: RestartFile; r: SavedResume; from: string; again: boolean }>();
  private checkQueued = false;
  // Re-checks when background work stops holding the restart.
  private backgroundTimer?: TimerHandle;

  constructor(deps: RestarterDeps) {
    this.deps = deps;
    this.version = deps.version ?? RUNNER_VERSION;
    this.defer = deps.defer ?? ((fn) => setImmediate(fn));
    this.startedAt = new Date(deps.clock.now()).toISOString();
    // Any summary change can be a thread finishing, and a deleted thread
    // (threads.delete, the delete_thread tool) stops whatever it was doing
    // without one.
    deps.runner.onNotification((n) => {
      if (n.method === 'thread.updated' || n.method === 'thread.deleted') this.queueCheck();
    });
  }

  // ------------------------------------------------------------ requests

  request(p: RestartParams): RestartResult {
    const { runner, log } = this.deps;
    if (p.cancel) return this.cancel();
    // A thread that doesn't exist is an error now, not a lost resume later.
    const thread = p.resume ? runner.get(p.resume.threadId) : undefined;
    const now = this.isoNow();
    const next: RestartFile = this.pending ?? { when: 'idle', requestedAt: now, fromVersion: this.version, resumes: [] };
    if (p.when === 'now') next.when = 'now';
    if (p.reason) next.reason = p.reason;
    if (p.release) next.release = p.release;
    if (p.backgroundWaitMs !== undefined) {
      // The most impatient request wins, as "now" does.
      const until = this.deps.clock.now() + p.backgroundWaitMs;
      const had = next.backgroundUntil ? Date.parse(next.backgroundUntil) : Infinity;
      if (until < had) next.backgroundUntil = new Date(until).toISOString();
    }
    if (p.resume && thread) {
      const { threadId, text } = p.resume;
      next.resumes = next.resumes.filter((r) => r.threadId !== threadId);
      const saved: SavedResume = { threadId, text, requestedAt: now, afterSeq: thread.lastSeq };
      if (p.release) saved.release = p.release;
      next.resumes.push(saved);
    }
    this.pending = next;
    this.save();
    this.armBackgroundTimer();
    const waitingFor = next.when === 'now' || this.restarting ? [] : this.busy();
    log.info('restart requested', { when: next.when, reason: p.reason, resumeThreadId: p.resume?.threadId, waitingFor, backgroundUntil: next.backgroundUntil });
    // Busy threads needn't hold it: they finish here while the new release
    // takes everything else.
    if (!this.restarting && waitingFor.length && next.when === 'idle' && this.deps.canHandOver?.()) {
      const out: RestartResult = { scheduled: true, waitingFor: [], handover: { keeps: waitingFor } };
      if (p.resume && thread && resumesInLastHour(this.deps.home, p.resume.threadId, this.deps.clock.now()) >= RESUMES_PER_HOUR) {
        out.noResume = `this thread has already been resumed ${RESUMES_PER_HOUR} times in the last hour`;
      }
      this.beginHandover(waitingFor);
      return out;
    }
    if (!this.restarting) {
      if (waitingFor.length === 0) this.begin();
      else runner.notice('info', pendingMessage(waitingFor.length, this.onYou(waitingFor)));
    }
    const background = waitingFor.length ? runner.backgroundWork().filter((b) => waitingFor.includes(b.threadId)) : [];
    const out: RestartResult = background.length ? { scheduled: true, waitingFor, background } : { scheduled: true, waitingFor };
    // Checked without using one up: the restart may still be an hour off.
    if (p.resume && thread && resumesInLastHour(this.deps.home, p.resume.threadId, this.deps.clock.now()) >= RESUMES_PER_HOUR) {
      out.noResume = `this thread has already been resumed ${RESUMES_PER_HOUR} times in the last hour`;
    }
    return out;
  }

  // Withdraws a restart that hasn't begun (tb restart --cancel). A deploy
  // has already pointed current at the release the restart was for, and
  // that would start on the next restart of any kind (a crash, a reboot)
  // with no health check and nobody watching, so current goes back to the
  // release this runner is.
  private cancel(): RestartResult {
    if (this.restarting) throw new RpcError(ErrorCode.busy, 'The runner is already restarting.');
    const p = this.pending;
    if (!p) return { scheduled: false, waitingFor: [] };
    this.pending = undefined;
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    try {
      fs.rmSync(restartPath(this.deps.home), { force: true });
    } catch (e) {
      this.deps.log.warn('could not remove restart.json', { error: String(e) });
    }
    const note = this.putCurrentBack(p);
    this.deps.log.info('restart cancelled', { release: p.release, note });
    this.deps.runner.notice('info', 'The pending runner restart was cancelled.');
    return note ? { scheduled: false, waitingFor: [], note } : { scheduled: false, waitingFor: [] };
  }

  private putCurrentBack(p: RestartFile): string | undefined {
    const { home, release: mine } = this.deps;
    const wanted = p.release;
    if (!wanted || wanted === mine || currentLink(home) !== wanted) return undefined;
    if (mine && releaseExists(home, mine)) {
      try {
        pointCurrentAt(home, mine);
        return `current points at ${mine} again (the release running now), so ${wanted} won't start on the next restart.`;
      } catch (e) {
        this.deps.log.warn('could not point current back at the running release', { release: mine, error: String(e) });
      }
    }
    const back = mine ? ` deploy-runner.sh --rollback goes back to ${mine}.` : '';
    return `Release ${wanted} is still current and starts on the runner's next restart (a crash or a reboot too).${back}`;
  }

  status(): RunnerStatus {
    const all = this.deps.runner.list(ALL);
    const running = all.filter((t) => BUSY.includes(t.status)).map((t) => t.id);
    const out: RunnerStatus = {
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      home: this.deps.home,
      liveClis: all.filter((t) => t.live).length,
      running,
      background: this.deps.runner.backgroundWork(),
    };
    if (this.deps.release) out.release = this.deps.release;
    if (this.deps.branch) out.branch = this.deps.branch;
    const rolledBack = this.rolledBackOnto();
    if (rolledBack) out.rolledBack = rolledBack;
    if (this.deps.logFile) out.logFile = this.deps.logFile;
    const update = this.deps.updateStatus?.();
    if (update) out.update = update;
    const p = this.pending;
    if (p) {
      const pr: NonNullable<RunnerStatus['pendingRestart']> = { when: p.when, requestedAt: p.requestedAt, waitingFor: p.when === 'now' || this.restarting ? [] : this.busy() };
      if (p.reason) pr.reason = p.reason;
      if (p.release) pr.release = p.release;
      if (p.backgroundUntil) pr.backgroundUntil = p.backgroundUntil;
      const last = p.resumes.at(-1);
      if (last) pr.resumeThreadId = last.threadId;
      out.pendingRestart = pr;
    }
    return out;
  }

  // launch.mjs's last crash rollback, if it went back to this release and
  // nobody has activated this release on purpose since (deploy-runner.sh
  // --rollback onto it is a choice, not a crash).
  private rolledBackOnto(): RunnerStatus['rolledBack'] {
    const mine = this.deps.release;
    if (!mine) return undefined;
    const s = readState(this.deps.home);
    const rb = s?.rolledBack;
    if (!rb || typeof rb !== 'object' || rb.to !== mine || typeof rb.from !== 'string' || typeof rb.at !== 'string') return undefined;
    const act = s?.activated;
    if (act && act.release === mine && Date.parse(act.at) > Date.parse(rb.at)) return undefined;
    return { from: rb.from, at: rb.at };
  }

  // Sent after each hello, so an app that connects while a restart waits
  // knows about it.
  helloNotices(): Notice[] {
    if (!this.pending) return [];
    const busy = this.busy();
    return [{ level: 'info', message: this.restarting ? pendingMessage(0) : pendingMessage(busy.length, this.onYou(busy)) }];
  }

  // How many of these threads wait on Mike (an approval or a question).
  private onYou(ids: string[]): number {
    const waiting = new Set(this.deps.runner.list(ALL).filter((t) => t.status === 'waiting').map((t) => t.id));
    return ids.filter((id) => waiting.has(id)).length;
  }

  // --------------------------------------------------------- idle check

  // The threads a restart waits for: a turn starting, running or waiting on
  // an approval or a question, or background shells and subagents the CLI
  // is still running after its turn ended. Stopping the runner stops those
  // too, and an agent waiting on a 40-minute test run would never hear back.
  // Background work only holds it until backgroundUntil, though: a dev
  // server or a watcher never finishes.
  private busy(): string[] {
    const ids = new Set(
      this.deps.runner
        .list(ALL)
        .filter((t) => BUSY.includes(t.status))
        .map((t) => t.id),
    );
    const until = this.pending?.backgroundUntil ? Date.parse(this.pending.backgroundUntil) : Infinity;
    if (this.deps.clock.now() < until) for (const b of this.deps.runner.backgroundWork()) ids.add(b.threadId);
    // A turn-end hook: stopping would lose its result, and any archive waiting
    // for it would wait for the next runner. Hooks end by themselves (runCommand's
    // timeout), so no limit like background work's.
    for (const id of this.deps.runner.threadsWithHooksRunning()) ids.add(id);
    return [...ids];
  }

  private armBackgroundTimer(): void {
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    const until = this.pending?.backgroundUntil ? Date.parse(this.pending.backgroundUntil) : NaN;
    if (!Number.isFinite(until) || this.restarting) return;
    this.backgroundTimer = this.deps.clock.setTimeout(() => {
      this.backgroundTimer = undefined;
      this.queueCheck();
    }, until - this.deps.clock.now());
  }

  private queueCheck(): void {
    if (!this.pending || this.restarting || this.checkQueued) return;
    this.checkQueued = true;
    this.defer(() => {
      this.checkQueued = false;
      if (!this.pending || this.restarting) return;
      if (this.pending.when === 'now' || this.busy().length === 0) this.begin();
    });
  }

  private beginHandover(keeps: string[]): void {
    if (this.restarting || !this.pending) return;
    this.restarting = true;
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    // From here the restart counts as done for the new runner: it takes
    // restart.json and resumes the threads (a kept one when it arrives).
    this.pending.shutdownAt = this.isoNow();
    this.save();
    this.deps.log.info('handing over', { reason: this.pending.reason, keeps });
    const n = keeps.length;
    // "The runner is restarting" first: the app reads that as a restart
    // under way (RunnerRestart.parse) and keeps its banner quiet while the
    // connection moves to the new runner.
    this.deps.runner.notice('info', `The runner is restarting onto a new release. ${n === 1 ? '1 busy thread finishes its turn' : `${n} busy threads finish their turns`} on the old one first, then ${n === 1 ? 'moves' : 'move'} across.`);
    this.defer(() => this.deps.handOver!(keeps));
  }

  // A thread a draining runner kept has come across: the resume it was
  // waiting for goes now, and its 15 minutes count from now.
  resumeAdopted(threadId: string): void {
    const d = this.deferred.get(threadId);
    if (!d) return;
    this.deferred.delete(threadId);
    this.resumeOne({ ...d.saved, shutdownAt: this.isoNow() }, { ...d.r, requestedAt: this.isoNow() }, d.from, d.again);
  }

  private begin(): void {
    if (this.restarting || !this.pending) return;
    this.restarting = true;
    this.backgroundTimer?.cancel();
    this.backgroundTimer = undefined;
    // A turn started now would be cut off before it got going.
    this.deps.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
    this.pending.shutdownAt = this.isoNow();
    this.save();
    this.deps.log.info('restarting', { when: this.pending.when, reason: this.pending.reason });
    this.deps.runner.notice('info', pendingMessage(0));
    this.defer(() => this.deps.restart());
  }

  // main.ts calls this whenever the runner stops, whatever stopped it
  // (launchctl kickstart, a reboot, the restart itself). A pending restart
  // counts as done from here, so a resume's age starts now rather than when
  // the restart was first asked for.
  stopping(): void {
    // Stopping cleanly isn't crashing: the restart this runner handled is done.
    this.proven();
    if (!this.pending || this.pending.shutdownAt) return;
    this.pending.shutdownAt = this.isoNow();
    this.save();
  }

  // main.ts calls this once the runner has stayed up long enough to be
  // marked good: the restart it handled won't need handling again.
  proven(): void {
    try {
      fs.rmSync(donePath(this.deps.home), { force: true });
    } catch (e) {
      this.deps.log.warn('could not remove restart.done.json', { error: String(e) });
    }
  }

  private save(): void {
    try {
      atomicWriteFileSync(restartPath(this.deps.home), JSON.stringify(this.pending, null, 2) + '\n');
    } catch (e) {
      // Still restarts; only a crash before then would lose it.
      this.deps.log.error('could not save restart.json', { error: String(e) });
    }
  }

  // ------------------------------------------------------- next start

  // Handles the restart.json the previous runner left (it restarted, or
  // crashed while a restart was pending, which comes to the same thing).
  // The file moves to restart.done.json first, so a resume that crashes
  // this runner isn't sent again by the next start of the same release; but
  // if this release keeps crashing and launch.mjs goes back to the last good
  // one, that runner finds restart.done.json with the rollback and resumes
  // the same threads once more, saying what happened.
  resumeAfterRestart(): void {
    const { log, home } = this.deps;
    const file = restartPath(home);
    const done = donePath(home);
    let saved: RestartFile | undefined;
    let again = false;
    if (fs.existsSync(file)) {
      saved = readJsonSync<RestartFile>(file);
      try {
        if (saved && typeof saved === 'object') {
          atomicWriteFileSync(done, JSON.stringify({ ...saved, handledBy: this.version, handledRelease: this.deps.release }, null, 2) + '\n');
        }
        fs.unlinkSync(file);
      } catch (e) {
        log.warn('could not move restart.json aside', { error: String(e) });
      }
    } else if (fs.existsSync(done)) {
      // Left by a runner that didn't stay up. Only worth acting on if that
      // runner was the release launch.mjs has just gone back from.
      const left = readJsonSync<RestartFile>(done);
      const handled = left && typeof left === 'object' && typeof left.handledRelease === 'string' ? left.handledRelease : undefined;
      if (this.deps.rolledBack && handled !== undefined && handled === this.deps.rolledBackFrom) {
        saved = left!;
        again = true;
      } else if (!this.deps.rolledBack && handled !== undefined && handled === this.deps.release) {
        // The same release starting again before it was marked good:
        // launch.mjs gives a broken release a second start before going
        // back, and the release it goes back to needs the file then. This
        // start being marked good (proven) or stopping cleanly drops it.
        log.info('restart.done.json is from this release, which has not been marked good yet; keeping it');
        return;
      }
      try {
        fs.unlinkSync(done);
      } catch (e) {
        log.warn('could not remove restart.done.json', { error: String(e) });
      }
      if (!again) return;
    } else {
      return;
    }
    if (!saved || typeof saved !== 'object') {
      log.warn('restart.json could not be read; nothing to resume');
      return;
    }
    const from = again && typeof saved.handledBy === 'string' ? saved.handledBy : typeof saved.fromVersion === 'string' ? saved.fromVersion : 'an unknown version';
    log.info('restarted', { from, to: this.version, reason: saved.reason, again });
    for (const r of Array.isArray(saved.resumes) ? saved.resumes : []) {
      if (!r || typeof r.threadId !== 'string' || typeof r.text !== 'string') continue;
      this.resumeOne(saved, r, from, again);
    }
  }

  // again: this is the resume after a crash rollback, standing in for the
  // one the crashed release sent (or never got to send) for the same
  // restart, which shouldn't count against the thread's hourly limit.
  private resumeOne(saved: RestartFile, r: SavedResume, from: string, again = false): void {
    const { runner, log, home } = this.deps;
    if (this.deps.elsewhere?.(r.threadId)) {
      log.info('the thread to resume is still finishing on the old runner; resuming it when it comes across', { threadId: r.threadId });
      this.deferred.set(r.threadId, { saved, r, from, again });
      return;
    }
    let thread: ThreadSummary;
    try {
      thread = runner.get(r.threadId);
    } catch {
      log.warn('the thread to resume after the restart is gone', { threadId: r.threadId });
      return;
    }
    try {
      const now = this.deps.clock.now();
      // From the shutdown if the old runner got that far; else from when this
      // thread asked (a later request merged in has its own time).
      const at = Date.parse(saved.shutdownAt ?? r.requestedAt ?? saved.requestedAt);
      const fresh = Number.isFinite(at) && now - at < RESUME_MAX_AGE_MS;
      const branch = this.deps.branch && this.deps.branch !== 'main' ? ` (from branch ${this.deps.branch})` : '';
      let note = `Runner restarted: ${from} to ${this.version}${branch}`;
      if (this.deps.rolledBack) note += `\n\n${this.deps.rolledBack}`;
      const warning = this.wrongRelease(r);
      if (warning && !this.deps.rolledBack) note += `\n\n${warning}`;
      const why = !fresh
        ? `the request is more than ${RESUME_MAX_AGE_MS / 60_000} minutes old`
        : thread.archivedAt
          ? 'this thread is archived'
          : thread.snoozedUntil !== undefined && Date.parse(thread.snoozedUntil) > now
            ? 'this thread is snoozed'
            : this.spokenSince(r)
              ? 'a message was sent to this thread after the restart was asked for'
              : !takeResume(home, r.threadId, now, again ? Date.parse(saved.shutdownAt ?? r.requestedAt ?? saved.requestedAt) : undefined)
                ? `this thread has already been resumed ${RESUMES_PER_HOUR} times in the last hour`
                : undefined;
      if (why) note += `\n\nNot carrying on by itself: ${why}.`;
      runner.note(r.threadId, note);
      if (why) {
        log.info('not resuming a thread after the restart', { threadId: r.threadId, why });
        return;
      }
      // The note is only for the app; the model hears about a rollback, or a
      // release that isn't the one it deployed, from the message itself.
      const heads = [this.deps.rolledBack, warning].filter(Boolean);
      const text = heads.length ? `Note from the runner: ${heads.join(' ')} Check tb logs before going on. Your message for after the restart follows.\n\n${r.text}` : r.text;
      runner.send(r.threadId, text, [], { origin: 'runner' });
      log.info('resumed a thread after the restart', { threadId: r.threadId });
    } catch (e) {
      log.error('could not resume a thread after the restart', { threadId: r.threadId, error: String(e) });
    }
  }

  // Set when the thread asked for a release that isn't the one running.
  private wrongRelease(r: SavedResume): string | undefined {
    if (typeof r.release !== 'string' || !r.release || r.release === this.deps.release) return undefined;
    return `Release ${r.release} isn't running (this is ${this.deps.release ?? 'a runner run from source'}), so the change it carries isn't live.`;
  }

  // Someone wrote in the thread after it asked to be carried on: the resume
  // would talk over them.
  private spokenSince(r: SavedResume): boolean {
    if (typeof r.afterSeq !== 'number') return false;
    for (let after = r.afterSeq; ; ) {
      const page = this.deps.runner.events(r.threadId, { afterSeq: after, limit: 10_000 }).events;
      if (page.some((e) => e.type === 'user.message' && e.origin !== 'runner')) return true;
      if (page.length < 10_000) return false;
      after = page[page.length - 1].seq;
    }
  }

  private isoNow(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }
}

// The notice while a restart waits. onYou of the waiting threads are
// waiting on Mike's answer to an approval or a question, which won't come by
// itself, so the line says so. The Mac app reads these sentences
// (RunnerRestart.parse in app/Sources/ThreadbearCore/RPC/RunnerRestart.swift:
// the prefix, and the numbers after it adding up to the count), and so does
// the mock runner's copy; restart.test.ts pins them.
export function pendingMessage(waiting: number, onYou = 0): string {
  if (waiting === 0) return 'The runner is restarting now.';
  const answer = Math.min(Math.max(0, onYou), waiting);
  const finishing = waiting - answer;
  const finish = finishing === 1 ? '1 thread finishes' : `${finishing} threads finish`;
  if (answer === 0) return `The runner will restart when ${finish}.`;
  if (finishing === 0) return `The runner will restart when you answer ${answer === 1 ? '1 thread' : `${answer} threads`}.`;
  return `The runner will restart when ${finish} and you answer ${answer}.`;
}

// At most RESUMES_PER_HOUR automatic resumes per thread in any hour, kept in
// run/resumes.json so a restart loop (an agent that deploys, resumes and
// deploys again) stops by itself. Returns false when the thread is over.
// replacesSince: resumes recorded from then on are dropped first. After a
// crash rollback the release that crashed resumed the thread once already
// for the same restart, and the one going back resumes it again; counting
// both stopped an agent at good deploy, broken deploy, fix.
export function takeResume(home: string, threadId: string, now: number, replacesSince?: number): boolean {
  const file = resumesPath(home);
  const out = recentResumes(home, now);
  let mine = out[threadId] ?? [];
  if (replacesSince !== undefined && Number.isFinite(replacesSince)) mine = mine.filter((t) => Date.parse(t) < replacesSince);
  if (mine.length >= RESUMES_PER_HOUR) return false;
  out[threadId] = [...mine, new Date(now).toISOString()];
  atomicWriteFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return true;
}

// How many times the thread has been resumed in the last hour, without
// recording anything.
export function resumesInLastHour(home: string, threadId: string, now: number): number {
  return (recentResumes(home, now)[threadId] ?? []).length;
}

function recentResumes(home: string, now: number): Record<string, string[]> {
  const all = readJsonSync<Record<string, string[]>>(resumesPath(home)) ?? {};
  const recent = (ts: unknown): string[] =>
    Array.isArray(ts) ? ts.filter((t): t is string => typeof t === 'string' && now - Date.parse(t) < HOUR_MS) : [];
  const out: Record<string, string[]> = {};
  for (const [id, ts] of Object.entries(all)) {
    const kept = recent(ts);
    if (kept.length) out[id] = kept;
  }
  return out;
}

// ----------------------------------------------------------------- RPC

// runner.status and runner.restart, served by rpc.ts beside the runner's
// own methods.
export function restartMethods(r: Restarter): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'runner.status': () => r.status(),
    'runner.restart': (p) => r.request(parseRestartParams(p)),
  };
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

export function parseRestartParams(p: Record<string, unknown>): RestartParams {
  const out: RestartParams = {};
  if (p.cancel !== undefined && p.cancel !== null && p.cancel !== false) {
    if (p.cancel !== true) throw bad('cancel must be true or false');
    out.cancel = true;
  }
  if (p.release !== undefined && p.release !== null) {
    if (typeof p.release !== 'string' || !p.release) throw bad('release must be a release id');
    out.release = p.release;
  }
  if (p.when !== undefined && p.when !== null) {
    if (p.when !== 'idle' && p.when !== 'now') throw bad('when must be "idle" or "now"');
    out.when = p.when;
  }
  if (p.backgroundWaitMs !== undefined && p.backgroundWaitMs !== null) {
    if (typeof p.backgroundWaitMs !== 'number' || !Number.isFinite(p.backgroundWaitMs) || p.backgroundWaitMs < 0) throw bad('backgroundWaitMs must be a number of milliseconds');
    out.backgroundWaitMs = p.backgroundWaitMs;
  }
  if (p.reason !== undefined && p.reason !== null) {
    if (typeof p.reason !== 'string') throw bad('reason must be a string');
    if (p.reason.trim()) out.reason = p.reason.trim();
  }
  if (p.resume !== undefined && p.resume !== null) {
    const r = p.resume as Record<string, unknown>;
    if (typeof r !== 'object' || Array.isArray(r)) throw bad('resume must be an object');
    if (typeof r.threadId !== 'string' || !r.threadId) throw bad('resume.threadId must be a string');
    if (typeof r.text !== 'string' || !r.text.trim()) throw bad('resume.text must be a non-empty string');
    out.resume = { threadId: r.threadId, text: r.text };
  }
  return out;
}
