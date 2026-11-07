// Schedules: a message sent at a set time, once (`at`) or over and over
// (`cron`), to a thread or to a new thread each time. Like Convex's
// scheduled functions and crons. Served as the schedules.* methods beside
// the runner's own (see "Schedules" in docs/protocol.md).
//
// Where they're kept depends on the backend. With sync off, or a backend
// older than API 9, they're this runner's own schedules.json, as they always
// were. Once a backend of API 9 is attached (attach(), from sync.ts), they
// live in its `schedules` table so every runner sees one list and a schedule
// can run on another runner (step 6, docs/step6-plan.md): this runner moves
// its own file up once, keeps a live copy of the whole table (and a copy on
// disk for when the backend can't be reached), and sends only its own,
// each run taken with a claim first so it's sent once.
import { experimentOn } from './experiments.ts';
import type { CheckCard } from './patch-trust.ts';
import { type KeptCheck, CHECK_TIMEOUT_MS, checkLimitMs, checkOutcome, checkRunningElsewhere, clearCheckRunning, dropKeptCheck, HELD_EXTRA, HELD_SKIP, heldToldAbout, keepCheck, markCheckRunning, MAX_CHECK_CHARS, MAX_CHECK_TIMEOUT_SECS, noteHeldTold, readKeptCheck, runCheck, type CheckResult } from './schedule-check.ts';
import { forbiddenText } from './sync.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Runner } from './runner.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { EffortLevel, PermissionMode, Schedule } from './protocol.ts';
import { EFFORT_LEVELS, ErrorCode, RpcError, isEffortLevel } from './protocol.ts';
import { atomicWriteFileSync, isDirectory, readJsonSync } from './fsutil.ts';
import { expandHome } from './config.ts';
import { CronError, checkZone, describeAt, describeCron, localZone, nextRun, nextRuns, parseCron } from './cron.ts';
import { cutSafely, firstLineSafely } from './safe-cut.ts';

// What a check printed, carried by a run: kept (when it was kept) and the
// command, so a sent run drops that command's kept file.
// `held`: it says a check wasn't run, for this digest of what it'd run.
type Carried = { extra: string; kept?: string; check?: string; held?: string };

// What schedules.json holds for each: everything but whenText, which is
// worked out when it's sent, and runnerName, from the backend's runners.
type ScheduleRecord = Omit<Schedule, 'whenText' | 'runnerName' | 'runnerIcon'>;

// A schedule as the backend stores it: the record with its runner and its
// words (the phone shows whenText; the backend has no cron code).
export type StoredSchedule = ScheduleRecord & { runnerId: string; whenText: string };

// What a runner the backend knows of looks like, and what runners.list
// answers with (docs/protocol.md, RunnerInfo).
// version, release, startedAt and draining are what each runner's heartbeat
// last said (sync.ts), for the app's Runners panel.
export type BackendRunner = { id: string; name: string; lastSeenAt?: number; icon?: string; version?: string; release?: string; startedAt?: string; draining?: boolean };
export type RunnerInfo = {
  id: string;
  name: string;
  icon?: string;
  online: boolean;
  lastSeenAt?: string;
  self: boolean;
  version?: string;
  release?: string;
  startedAt?: string;
  draining?: boolean;
};
// This runner, as runners.list has it first.
type SelfRunner = { id: string; name: string; icon?: string; version?: string; release?: string; startedAt?: string };

// The backend's schedules table (sync.ts makes one for Convex; tests pass a
// fake). Every call can fail when the backend can't be reached.
class HeldLocal extends Error {
  held: { id: string; why: string }[];
  constructor(held: { id: string; why: string }[]) {
    super('schedules held on this Mac');
    this.held = held;
  }
}

export type ScheduleBackend = {
  // The whole table now and whenever it changes. Returns the unsubscribe.
  subscribe(onRows: (rows: StoredSchedule[]) => void, onError: (e: Error) => void): () => void;
  save(s: StoredSchedule): Promise<void>;
  remove(scheduleId: string): Promise<void>;
  // This runner's schedules.json, moved up once. `held`: ones a runner key
  // couldn't bring up (convex/sync.ts adoptSchedules), when nothing moved.
  adopt(rows: StoredSchedule[]): Promise<void | { held?: { id: string; why: string }[] }>;
  // Takes a run: "due" at that nextRunAt, or the "request" at that
  // runRequestedAt. False when it isn't ours to send (any more).
  claim(scheduleId: string, kind: 'due' | 'request', expect: string): Promise<boolean>;
  release(scheduleId: string): Promise<void>;
  ran(p: {
    scheduleId: string;
    lastRun: NonNullable<Schedule['lastRun']>;
    sent: boolean;
    expectUpdatedAt: string;
    nextRunAt?: string;
    finishedAt?: string;
    request?: string;
  }): Promise<void>;
  requestRun(scheduleId: string, at: string): Promise<boolean>;
  runners(): Promise<BackendRunner[]>;
};

// A runner the backend hasn't heard from for this long shows as offline,
// as on the phone.
const ONLINE_MS = 3 * 60_000;
// One not heard from for this long (or that said goodbye for good) isn't
// offered in runners.list: an old install, or a test's.
const FORGET_MS = 30 * 86_400_000;

export type ScheduleRunner = Pick<Runner, 'create' | 'send' | 'get' | 'hello' | 'onNotification' | 'publish' | 'patchTrust'>;

export type CreateScheduleParams = {
  // A card's approval of `check` (patch-trust.ts, approveCheck). Not from a client.
  checkCard?: CheckCard;
  text: string;
  title?: string;
  at?: string;
  cron?: string;
  timezone?: string;
  threadId?: string;
  cwd?: string;
  accountId?: string;
  poolId?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  // A shell command run before each run (schedule-check.ts).
  check?: string;
  // How long it may take, in seconds; absent, a minute.
  checkTimeoutSecs?: number;
  paused?: boolean;
  createdBy?: string;
  // Another runner's id or name (runners.list); absent, this one.
  runnerId?: string;
};

export type UpdateScheduleParams = {
  scheduleId: string;
  title?: string;
  text?: string;
  at?: string;
  cron?: string;
  timezone?: string | null;
  paused?: boolean;
  cwd?: string;
  accountId?: string;
  // null takes it out of its pool (back to the folder's or the default).
  poolId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
  // null or "" takes the check off.
  check?: string | null;
  checkCard?: CheckCard;
  // null: back to a minute.
  checkTimeoutSecs?: number | null;
};

// The Mac sleeps and timers stop with it, so check often rather than
// trusting one long timer to wake up on time.
const TICK_MS = 30_000;
// A one-off that has run stays in the list this long, then goes.
const KEEP_FINISHED_MS = 7 * 86_400_000;
const BUSY = new Set(['starting', 'running', 'waiting']);

export class Scheduler {
  private runner: ScheduleRunner;
  private file: string;
  private clock: Clock;
  private log: Logger;
  private zone: () => string;
  private items = new Map<string, ScheduleRecord>();
  private timer?: TimerHandle;
  private stopped = false;
  private unlisten?: () => void;
  // This runner, as the backend knows it (sync.runnerId and its name).
  private self: SelfRunner;
  // Whether this runner has a backend to attach to at all (sync is on).
  // Without one a backend copy on disk is taken back as the runner's own.
  private syncOn: boolean;
  // "local": schedules.json is the schedules. "backend": the backend's
  // table is, and this.items is a copy of it, live once `backend` is set.
  private mode: 'local' | 'backend' = 'local';
  private held: { id: string; why: string }[] = [];
  private backend?: ScheduleBackend;
  private attaching = false;
  private unsubscribe?: () => void;
  private ticking = false;
  // A change (a new row, a run asked for) that came in mid-tick: look again
  // straight after rather than on the next regular check.
  private tickAgain = false;
  private names = new Map<string, string>();
  private icons = new Map<string, string>();
  private namesDue = false;
  // Threads a draining runner still has (docs/protocol.md, "Handovers"):
  // they're real threads, just not loaded here yet.
  private elsewhere: (threadId: string) => boolean;
  // Schedule checks (experiment scheduleChecks, schedule-check.ts).
  private home: string;
  private checksOn: () => boolean;
  private check: (p: { command: string; cwd: string; home: string; scheduleId: string; timeoutMs?: number }) => Promise<CheckResult>;
  // Local mode's runs waiting on their check, so a tick doesn't start another.
  private checking = new Set<string>();
  // Every check under way, for settled(): the runner waits for them before
  // it exits, so what they print is kept for the next one.
  // Each with its time limit, so a stop waits for the longest.
  private inFlight = new Map<Promise<unknown>, number>();
  // Kept outputs this process has sent (id, command and when kept), in case the file
  // couldn't be deleted: it isn't sent again.
  private delivered = new Set<string>();
  // What a check printed that couldn't be written down (id, newline, command).
  private memKept = new Map<string, KeptCheck>();
  // Schedules whose check this process has under way.
  private checkingNow = new Set<string>();

  constructor(deps: {
    runner: ScheduleRunner;
    home: string;
    clock: Clock;
    log: Logger;
    zone?: () => string;
    elsewhere?: (threadId: string) => boolean;
    self?: SelfRunner;
    syncOn?: boolean;
    checksOn?: () => boolean;
    runCheck?: (p: { command: string; cwd: string; home: string; scheduleId: string; timeoutMs?: number }) => Promise<CheckResult>;
  }) {
    this.runner = deps.runner;
    this.home = deps.home;
    this.checksOn = deps.checksOn ?? (() => experimentOn(deps.home, 'scheduleChecks'));
    this.check = deps.runCheck ?? runCheck;
    this.self = deps.self ?? { id: 'runner', name: 'this Mac' };
    this.syncOn = deps.syncOn ?? false;
    this.elsewhere = deps.elsewhere ?? (() => false);
    this.file = path.join(deps.home, 'schedules.json');
    this.clock = deps.clock;
    this.log = deps.log;
    this.zone = deps.zone ?? localZone;
  }

  start(): void {
    const saved = readJsonSync<{ version?: number; schedules?: ScheduleRecord[] }>(this.file);
    if (!saved && fs.existsSync(this.file)) this.log.error('schedules.json could not be read; starting with none', { file: this.file });
    // Version 2 is the backend's copy. With sync on it stays one (nothing is
    // sent until the backend is attached and says so); with sync turned off
    // since, this runner's own come back as its own file.
    const copy = saved?.version === 2;
    if (copy && this.syncOn) this.mode = 'backend';
    for (const s of saved?.schedules ?? []) {
      if (!s || typeof s.id !== 'string') continue;
      if (copy && !this.syncOn) {
        if (s.runnerId && s.runnerId !== this.self.id) continue;
        delete s.runnerId;
        delete s.runRequestedAt;
      }
      this.items.set(s.id, s);
    }
    // A thread's schedules go with it.
    this.unlisten = this.runner.onNotification((n) => {
      if (n.method !== 'thread.deleted') return;
      let gone = false;
      for (const s of [...this.items.values()]) {
        if (s.threadId !== n.params.threadId || !this.mine(s)) continue;
        this.items.delete(s.id);
        this.dropKept(s.id);
        gone = true;
        if (this.mode === 'backend') void this.backend?.remove(s.id).catch((e) => this.log.warn('could not delete a schedule from the backend', { scheduleId: s.id, error: String(e) }));
      }
      if (gone) this.changed();
    });
    this.log.info('schedules loaded', { count: this.items.size, mode: this.mode });
    this.tick();
  }

  /** Resolves once the checks under way have finished (and kept what they printed), or after limitMs (by default the longest one's own time limit). */
  async settled(limitMs = Math.max(CHECK_TIMEOUT_MS, ...this.inFlight.values()) + 5000): Promise<void> {
    if (!this.inFlight.size) {
      this.flushMemKept();
      return;
    }
    let timer: TimerHandle | undefined;
    const limit = new Promise<void>((r) => {
      timer = this.clock.setTimeout(r, limitMs);
    });
    await Promise.race([Promise.allSettled([...this.inFlight.keys()]), limit]);
    timer?.cancel();
    this.flushMemKept();
  }

  // What couldn't be written down when its check ran gets one more try
  // before the runner exits, so the next one finds it.
  private flushMemKept(): void {
    for (const [k, kept] of [...this.memKept]) {
      try {
        keepCheck(this.home, k.slice(0, k.indexOf('\n')), kept);
        this.memKept.delete(k);
      } catch {
        // Still can't; it goes with this process.
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.unlisten?.();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ---------------------------------------------------------- the backend

  /** Whether the schedules are the backend's (sync.ts stops mirroring them). */
  inBackend(): boolean {
    return this.mode === 'backend';
  }

  // Called by sync.ts after each heartbeat from a backend of API 9 or later.
  // The first time, this runner's own schedules.json goes up (if it wasn't
  // already the backend's copy), then the live copy starts. A failure is
  // logged and tried again on the next heartbeat; meanwhile a runner still
  // on its own file keeps sending from it.
  async attach(backend: ScheduleBackend): Promise<void> {
    if (this.backend || this.attaching || this.stopped) return;
    this.attaching = true;
    try {
      if (this.mode === 'local') await this.moveUp(backend);
      if (this.stopped) return;
      // No await between moveUp's last look and here, so nothing made in
      // the file meanwhile is left behind.
      this.mode = 'backend';
      this.backend = backend;
      this.changed();
      this.unsubscribe = backend.subscribe(
        (rows) => this.onRows(rows),
        (e) => this.log.warn('the schedules subscription failed', { error: String(e) }),
      );
      void this.refreshNames();
    } catch (e) {
      if (e instanceof HeldLocal) {
        // Said when what's held changes, not every heartbeat.
        const said = JSON.stringify(e.held);
        if (said !== JSON.stringify(this.held)) this.log.warn("schedules stay on this Mac: this runner's key can't put some in the backend, so none move until they can", { held: e.held.map((h) => ({ id: h.id, why: h.why })) });
        this.held = e.held;
      } else this.log.warn('could not move schedules to the backend; trying again later', { error: String(e) });
    } finally {
      this.attaching = false;
    }
  }

  /** Schedules kept in this runner's own file because the backend couldn't take them (shown in tb status). */
  heldLocal(): { id: string; why: string }[] {
    return this.held;
  }

  // Moves this runner's schedules.json up. The file keeps working while the
  // calls are out, so it looks again until a pass finds nothing made,
  // changed or deleted since the last one.
  private async moveUp(backend: ScheduleBackend): Promise<void> {
    // id -> the record as sent (not updatedAt: two changes can share a
    // millisecond).
    const sent = new Map<string, string>();
    let first = true;
    for (;;) {
      const now = [...this.items.values()];
      const fresh = now.filter((r) => !sent.has(r.id));
      const changed = now.filter((r) => sent.has(r.id) && sent.get(r.id) !== JSON.stringify(r));
      const gone = [...sent.keys()].filter((id) => !this.items.has(id));
      if (!first && !fresh.length && !changed.length && !gone.length) break;
      // The first pass always goes, even with none: it clears this runner's
      // mirrored rows.
      if (first || fresh.length) await this.adopt(backend, fresh.map((r) => this.stored({ ...r, runnerId: this.self.id })));
      for (const r of changed) await backend.save(this.stored({ ...r, runnerId: this.self.id }));
      for (const id of gone) await backend.remove(id);
      for (const r of [...fresh, ...changed]) sent.set(r.id, JSON.stringify(r));
      for (const id of gone) sent.delete(id);
      first = false;
    }
    for (const r of this.items.values()) r.runnerId = this.self.id;
    this.log.info('schedules moved to the backend', { count: sent.size });
  }

  // adoptSchedules is the main key's only (it clears mirrored rows from
  // before API 9, docs/protocol.md "Runner keys"): a runner key's runner
  // saves its schedules one by one instead, which is all it needs.
  // Any held back means nothing moved: the file stays this runner's copy,
  // its schedules keep running from it, and nothing is lost (HeldLocal).
  private async adopt(backend: ScheduleBackend, rows: StoredSchedule[]): Promise<void> {
    let r: Awaited<ReturnType<ScheduleBackend['adopt']>>;
    try {
      r = await backend.adopt(rows);
    } catch (e) {
      if (!forbiddenText(e)) throw e;
      for (const row of rows) await backend.save(row);
      return;
    }
    const held = (r && typeof r === 'object' && Array.isArray(r.held) ? r.held : []).filter((h) => typeof h?.id === 'string');
    if (held.length) throw new HeldLocal(held);
    this.held = [];
  }

  private onRows(rows: StoredSchedule[]): void {
    if (this.stopped) return;
    const before = new Map(this.items);
    this.items.clear();
    for (const r of rows) {
      const { whenText: _w, ...rec } = r;
      // Another schedule under the same id (gone and made again, or moved
      // to another runner): what the old one's check printed isn't this
      // one's to send (stillClaimed).
      const was = before.get(rec.id);
      if (was && (was.createdAt !== rec.createdAt || was.runnerId !== rec.runnerId)) this.dropKept(rec.id);
      this.items.set(rec.id, rec);
      if (!this.names.has(rec.runnerId)) this.namesDue = true;
    }
    if (this.namesDue) void this.refreshNames();
    this.changed();
    this.tick();
  }

  // The runners' names, for runnerName on each schedule: every runner the
  // backend has, gone quiet or not, since a schedule can name any of them.
  private async refreshNames(): Promise<void> {
    const list = await this.backend?.runners().catch(() => undefined);
    // (A runner key may not list runners: then only this one has a name.)
    if (!list) return;
    const before = JSON.stringify([...this.names, ...this.icons]);
    for (const r of list) this.learn(r);
    this.namesDue = false;
    if (JSON.stringify([...this.names, ...this.icons]) !== before) this.publish();
  }

  private learn(r: BackendRunner): void {
    this.names.set(r.id, r.name);
    if (r.icon) this.icons.set(r.id, r.icon);
  }

  /** runners.list: this runner first, then the backend's others by name. */
  async runners(): Promise<RunnerInfo[]> {
    const { id, name, icon, version, release, startedAt } = this.self;
    const me: RunnerInfo = { id, name, ...(icon ? { icon } : {}), online: true, self: true, ...(version ? { version } : {}), ...(release ? { release } : {}), ...(startedAt ? { startedAt } : {}) };
    if (!this.backend) return [me];
    const now = this.clock.now();
    // Only the main key lists every runner (docs/protocol.md, "Runner keys"):
    // on a runner key, this runner is the only one there is.
    let all: BackendRunner[];
    try {
      all = await this.backend.runners();
    } catch (e) {
      if (forbiddenText(e)) return [me];
      throw e;
    }
    for (const r of all) this.learn(r);
    const others = all
      .filter((r) => r.id !== this.self.id && r.lastSeenAt !== undefined && now - r.lastSeenAt < FORGET_MS)
      .map((r) => ({
        id: r.id,
        name: r.name,
        ...(r.icon ? { icon: r.icon } : {}),
        online: r.lastSeenAt !== undefined && now - r.lastSeenAt < ONLINE_MS,
        ...(r.lastSeenAt !== undefined ? { lastSeenAt: new Date(r.lastSeenAt).toISOString() } : {}),
        self: false,
        ...(r.version ? { version: r.version } : {}),
        ...(r.release ? { release: r.release } : {}),
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        ...(r.draining ? { draining: true } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [me, ...others];
  }

  // An id or a name from runners.list, as an id.
  private async resolveRunner(idOrName: string): Promise<string> {
    const want = idOrName.trim();
    if (want === this.self.id || want.toLowerCase() === this.self.name.toLowerCase()) return this.self.id;
    if (!this.backend) {
      throw bad(this.mode === 'backend' ? "Can't reach the backend to find that runner; try again in a moment." : 'Schedules on another runner need the Convex backend (sync on, API 9 or later).');
    }
    const list = await this.runners();
    const hit = list.find((r) => r.id === want) ?? list.find((r) => r.name.toLowerCase() === want.toLowerCase());
    if (!hit) throw bad(`No runner called ${want}. Runners: ${list.map((r) => r.name).join(', ')}.`);
    return hit.id;
  }

  // Ours to send: every one while they're our own file; in the backend,
  // the ones with our runnerId.
  private mine(rec: ScheduleRecord): boolean {
    return this.mode === 'local' || rec.runnerId === this.self.id;
  }

  private stored(rec: ScheduleRecord & { runnerId: string }): StoredSchedule {
    return { ...rec, whenText: this.whenText(rec) };
  }

  // Writes a made or changed schedule: to the backend, which answers once
  // it has it, or straight into the file.
  private async put(rec: ScheduleRecord): Promise<void> {
    if (this.mode === 'backend') {
      const b = this.mustHaveBackend();
      try {
        await b.save(this.stored({ ...rec, runnerId: rec.runnerId ?? this.self.id }));
      } catch (e) {
        throw new RpcError(ErrorCode.other, `Couldn't save the schedule to the backend: ${(e as Error).message ?? e}`);
      }
    }
    this.items.set(rec.id, rec);
    this.changed();
  }

  private mustHaveBackend(): ScheduleBackend {
    if (!this.backend) throw new RpcError(ErrorCode.other, "Schedules live in the Convex backend, which this runner can't reach right now; try again in a moment.");
    return this.backend;
  }

  // ---------------------------------------------------------------- reads

  list(threadId?: string): Schedule[] {
    return this.listRecords(threadId).map((s) => this.view(s));
  }

  private listRecords(threadId?: string): ScheduleRecord[] {
    const rank = (s: ScheduleRecord): number => (s.nextRunAt && !s.paused ? 0 : s.finishedAt ? 2 : 1);
    return [...this.items.values()]
      .filter((s) => !threadId || s.threadId === threadId || s.createdBy === threadId)
      .sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        if (a.nextRunAt && b.nextRunAt && !a.paused && !b.paused) return a.nextRunAt.localeCompare(b.nextRunAt);
        if (a.finishedAt && b.finishedAt) return b.finishedAt.localeCompare(a.finishedAt);
        return b.createdAt.localeCompare(a.createdAt);
      });
  }

  find(idOrPrefix: string): Schedule {
    return this.view(this.mustGet(idOrPrefix));
  }

  preview(p: { cron?: string; at?: string; timezone?: string; count?: number }): { whenText: string; runs: string[] } {
    const count = Math.min(Math.max(p.count ?? 5, 1), 20);
    const zone = p.timezone ? this.checkedZone(p.timezone) : undefined;
    if ((p.cron === undefined) === (p.at === undefined)) throw bad('Give either cron or at.');
    if (p.at !== undefined) {
      const t = this.parseAt(p.at);
      return { whenText: describeAt(t, zone ?? this.zone(), this.clock.now()), runs: [new Date(t).toISOString()] };
    }
    const spec = this.parsedCron(p.cron!);
    const runs = nextRuns(spec, this.clock.now(), zone ?? this.zone(), count);
    if (!runs.length) throw bad(`"${p.cron}" never runs.`);
    return { whenText: describeCron(spec, zone), runs: runs.map((t) => new Date(t).toISOString()) };
  }

  // ------------------------------------------------------------ mutations

  async create(p: CreateScheduleParams): Promise<Schedule> {
    const text = p.text?.trim();
    if (!text) throw bad('text is required');
    if ((p.cron === undefined) === (p.at === undefined)) throw bad('Give either at (once) or cron (repeating).');
    const runnerId = p.runnerId?.trim() ? await this.resolveRunner(p.runnerId) : this.self.id;
    const away = runnerId !== this.self.id;
    if (p.accountId && p.poolId) throw bad('Give accountId or poolId, not both: a pool picks the login.');
    if (away && p.threadId) throw bad("A schedule that sends to a thread runs on that thread's runner; leave runnerId out.");
    const now = this.iso();
    const rec: ScheduleRecord = {
      id: crypto.randomUUID(),
      title: p.title?.trim() ? cutSafely(p.title.trim(), 200) : firstLine(text),
      text,
      paused: Boolean(p.paused),
      createdAt: now,
      updatedAt: now,
      runs: 0,
    };
    if (p.timezone) rec.timezone = this.checkedZone(p.timezone);
    if (p.at !== undefined) rec.at = new Date(this.parseAt(p.at)).toISOString();
    else rec.cron = this.parsedCron(p.cron!).source;
    if (p.threadId) {
      // Throws thread not found for a bad id.
      rec.threadId = this.elsewhere(p.threadId) ? p.threadId : this.runner.get(p.threadId).id;
    } else if (away) {
      // Its folder and account are that runner's, checked there when it
      // runs; no folder means its default.
      if (p.cwd?.trim()) rec.cwd = p.cwd.trim();
      if (p.accountId) rec.accountId = p.accountId;
      if (p.poolId) rec.poolId = p.poolId;
      if (p.model) rec.model = p.model;
      if (p.effort) rec.effort = p.effort;
      if (p.permissionMode) rec.permissionMode = p.permissionMode;
    } else {
      rec.cwd = this.checkedFolder(p.cwd);
      if (p.accountId) rec.accountId = this.checkedAccount(p.accountId);
      if (p.poolId) rec.poolId = this.checkedPool(p.poolId);
      if (p.model) rec.model = p.model;
      if (p.effort) rec.effort = p.effort;
      if (p.permissionMode) rec.permissionMode = p.permissionMode;
    }
    if (p.check?.trim()) rec.check = checkedCheck(p.check);
    if (p.checkTimeoutSecs !== undefined) rec.checkTimeoutSecs = checkedTimeout(p.checkTimeoutSecs);
    if (p.createdBy) rec.createdBy = p.createdBy;
    if (this.mode === 'backend') rec.runnerId = runnerId;
    this.plan(rec);
    if (!away) this.approveCheck(rec, p.checkCard);
    await this.put(rec);
    // An `at` that's already passed runs now rather than on the next tick.
    this.tick();
    return this.view(this.items.get(rec.id) ?? rec);
  }

  // One at a time: each copies the record as it stands, so two at once
  // would have the later save put back what the earlier one changed (a
  // rename landing after a lowering would raise the mode back).
  private updating: Promise<unknown> = Promise.resolve();

  update(p: UpdateScheduleParams): Promise<Schedule> {
    const run = this.updating.then(() => this.updateNow(p));
    this.updating = run.catch(() => undefined);
    return run;
  }

  private async updateNow(p: UpdateScheduleParams): Promise<Schedule> {
    // A copy, so a write the backend turns down changes nothing here.
    const rec: ScheduleRecord = structuredClone(this.mustGet(p.scheduleId));
    const away = !this.mine(rec);
    let replan = false;
    if (p.title !== undefined) rec.title = p.title.trim() ? cutSafely(p.title.trim(), 200) : firstLine(rec.text);
    if (p.text !== undefined) {
      if (!p.text.trim()) throw bad('text cannot be empty');
      rec.text = p.text.trim();
    }
    if (p.at !== undefined && p.cron !== undefined) throw bad('Give at or cron, not both.');
    if (p.timezone !== undefined) {
      if (p.timezone === null || p.timezone === '') delete rec.timezone;
      else rec.timezone = this.checkedZone(p.timezone);
      replan = true;
    }
    if (p.at !== undefined) {
      rec.at = new Date(this.parseAt(p.at)).toISOString();
      delete rec.cron;
      delete rec.finishedAt;
      replan = true;
    }
    if (p.cron !== undefined) {
      rec.cron = this.parsedCron(p.cron).source;
      delete rec.at;
      delete rec.finishedAt;
      replan = true;
    }
    if (p.paused !== undefined && p.paused !== rec.paused) {
      rec.paused = p.paused;
      replan = true;
    }
    if (p.check !== undefined) {
      // What an earlier check kept stays with that command (readKeptCheck):
      // news no thread has seen yet is sent if that check is put back.
      if (p.check === null || !p.check.trim()) delete rec.check;
      else rec.check = checkedCheck(p.check);
    }
    if (p.checkTimeoutSecs !== undefined) {
      // Kept with the check taken off, so putting one back keeps its time.
      if (p.checkTimeoutSecs === null) delete rec.checkTimeoutSecs;
      else rec.checkTimeoutSecs = checkedTimeout(p.checkTimeoutSecs);
    }
    const moved = !rec.threadId && p.cwd !== undefined;
    if (!rec.threadId) {
      if (p.cwd !== undefined) rec.cwd = away ? p.cwd.trim() || undefined : this.checkedFolder(p.cwd);
      if (rec.cwd === undefined) delete rec.cwd;
      if (p.accountId !== undefined && p.poolId) throw bad('Give accountId or poolId, not both: a pool picks the login.');
      // One or the other, as threads.update has it: a login pins it, a
      // pool picks one each run.
      if (p.accountId !== undefined) {
        rec.accountId = away ? p.accountId : this.checkedAccount(p.accountId);
        delete rec.poolId;
      }
      if (p.poolId === null || p.poolId === '') delete rec.poolId;
      else if (p.poolId !== undefined) {
        rec.poolId = away ? p.poolId : this.checkedPool(p.poolId);
        delete rec.accountId;
      }
      if (p.model !== undefined) setOrDelete(rec, 'model', p.model);
      if (p.effort !== undefined) setOrDelete(rec, 'effort', p.effort);
      if (p.permissionMode !== undefined) rec.permissionMode = p.permissionMode;
    } else if ([p.cwd, p.accountId, p.poolId, p.model, p.effort, p.permissionMode].some((x) => x !== undefined)) {
      throw bad("This schedule sends to a thread, so it has no folder, account or model of its own; change the thread's.");
    }
    rec.updatedAt = this.iso();
    if (replan) this.plan(rec);
    // Passing the check again, or moving it, approves it as it is now. Any
    // other change leaves its approval alone.
    if (!away && (p.check !== undefined || moved)) this.approveCheck(rec, p.checkCard);
    await this.put(rec);
    this.tick();
    return this.view(rec);
  }

  async delete(scheduleId: string): Promise<Record<string, never>> {
    const rec = this.mustGet(scheduleId);
    if (this.mode === 'backend') {
      try {
        await this.mustHaveBackend().remove(rec.id);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        throw new RpcError(ErrorCode.other, `Couldn't delete the schedule from the backend: ${(e as Error).message ?? e}`);
      }
    }
    this.items.delete(rec.id);
    this.dropKept(rec.id);
    this.changed();
    return {};
  }

  // Runs it now, as if it were due. A repeating one keeps its next time.
  // Another runner's is asked for through the backend, and runs there.
  async runNow(scheduleId: string): Promise<{ schedule: Schedule; threadId?: string; turnId?: string; queued?: boolean }> {
    const rec = this.mustGet(scheduleId);
    if (!this.mine(rec)) {
      const at = this.iso();
      const ok = await this.mustHaveBackend()
        .requestRun(rec.id, at)
        .catch((e) => {
          throw new RpcError(ErrorCode.other, `Couldn't ask its runner to run it: ${(e as Error).message ?? e}`);
        });
      if (!ok) throw new RpcError(ErrorCode.scheduleNotFound, `No schedule ${scheduleId}`);
      rec.runRequestedAt = at;
      this.changed();
      return { schedule: this.view(rec), queued: true };
    }
    this.notMidCheck(rec);
    const res = this.send(rec, true, this.keptFor(rec));
    if (res.outcome !== 'sent') throw new RpcError(ErrorCode.other, res.note ?? "Couldn't run it.");
    if (rec.at) this.finish(rec);
    if (this.mode === 'backend') await this.recordRun(rec, true);
    this.changed();
    return { schedule: this.view(rec), threadId: res.threadId!, turnId: res.turnId! };
  }

  // Tells the backend about a run this runner sent (or skipped, or
  // couldn't send), with the schedule's next time. Best effort: a run that
  // was sent stays sent.
  private async recordRun(rec: ScheduleRecord, sent: boolean, request?: string): Promise<void> {
    if (!this.backend || !rec.lastRun) return;
    await this.backend
      .ran({
        scheduleId: rec.id,
        lastRun: rec.lastRun,
        sent,
        expectUpdatedAt: rec.updatedAt,
        ...(rec.nextRunAt ? { nextRunAt: rec.nextRunAt } : {}),
        ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
        ...(request ? { request } : {}),
      })
      .catch((e) => this.log.warn('could not record a schedule run in the backend', { scheduleId: rec.id, error: String(e) }));
  }

  // ------------------------------------------------------------------ runs

  private tick(): void {
    if (this.mode === 'backend') {
      void this.backendTick();
      return;
    }
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    const now = this.clock.now();
    let changed = this.prune(now);
    for (const rec of [...this.items.values()]) {
      if (rec.paused || !rec.nextRunAt || Date.parse(rec.nextRunAt) > now) continue;
      if (this.checking.has(rec.id)) continue;
      if (rec.check && this.checksOn()) {
        // Its check first, then the run (or a skip) as below.
        this.checking.add(rec.id);
        void this.checked(rec).then((checked) => {
          this.checking.delete(rec.id);
          // Stopped: what it printed is kept (checked), for the next runner.
          if (this.stopped) return;
          if (!this.items.has(rec.id)) {
            this.dropKept(rec.id);
            return;
          }
          // Its check is running in another runner process, or was changed
          // while it ran: left due for the next tick.
          if (checked === 'later') return;
          const res = this.send(rec, false, checked);
          if (res.outcome === 'retry') return;
          if (rec.at) this.finish(rec);
          else this.plan(rec);
          this.changed();
        });
        continue;
      }
      const res = this.send(rec, false);
      // The runner is restarting: leave it due for the next runner.
      if (res.outcome === 'retry') continue;
      if (rec.at) this.finish(rec);
      else this.plan(rec);
      changed = true;
    }
    if (changed) this.changed();
    let next = Infinity;
    for (const rec of this.items.values()) {
      if (!rec.paused && rec.nextRunAt) next = Math.min(next, Date.parse(rec.nextRunAt));
    }
    // Something still due (waiting out a restart) is tried again on the
    // next regular check, not straight away over and over.
    const wait = next <= now ? TICK_MS : Math.min(next - now, TICK_MS);
    this.timer = this.clock.setTimeout(() => this.tick(), wait);
  }

  // The backend's version of tick: the same runs, each taken with a claim
  // before it's sent, then recorded with the next time. Also the
  // schedules.run requests other runners left for ours. Nothing is sent
  // until the backend is attached.
  private async backendTick(): Promise<void> {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    const backend = this.backend;
    if (!backend) return;
    this.ticking = true;
    this.tickAgain = false;
    try {
      const now = this.clock.now();
      for (const row of [...this.items.values()]) {
        let rec = row;
        if (!this.mine(rec)) continue;
        if (rec.finishedAt && now - Date.parse(rec.finishedAt) > KEEP_FINISHED_MS) {
          await backend.remove(rec.id).catch(() => {});
          this.items.delete(rec.id);
          this.dropKept(rec.id);
          continue;
        }
        if (rec.runRequestedAt) await this.runRequested(backend, rec);
        if (rec.paused || !rec.nextRunAt || Date.parse(rec.nextRunAt) > now) continue;
        const claimed = await backend.claim(rec.id, 'due', rec.nextRunAt).catch((e) => {
          this.log.warn('could not claim a schedule run', { scheduleId: rec.id, error: String(e) });
          return false;
        });
        if (!claimed || this.stopped) continue;
        // The record as it is now: the subscription may have brought a
        // newer one (its check changed) or none (deleted, maybe by another
        // runner) while the claim was out, and again while it checked.
        const fresh = this.stillClaimed(backend, rec);
        if (!fresh) continue;
        rec = fresh;
        const checked = await this.checked(rec);
        if (this.stopped) continue;
        const after = this.stillClaimed(backend, rec);
        if (!after) continue;
        rec = after;
        if (checked === 'later') {
          await backend.release(rec.id).catch(() => {});
          continue;
        }
        const res = this.send(rec, false, checked);
        if (res.outcome === 'retry') {
          await backend.release(rec.id).catch(() => {});
          continue;
        }
        if (rec.at) this.finish(rec);
        else this.plan(rec);
        await this.recordRun(rec, res.outcome === 'sent');
      }
      this.changed();
    } finally {
      this.ticking = false;
    }
    if (this.stopped) return;
    if (this.tickAgain) {
      this.timer = this.clock.setTimeout(() => this.tick(), 0);
      return;
    }
    let next = Infinity;
    const now = this.clock.now();
    for (const rec of this.items.values()) {
      if (!this.mine(rec)) continue;
      if (!rec.paused && rec.nextRunAt) next = Math.min(next, Date.parse(rec.nextRunAt));
      if (rec.runRequestedAt) next = now;
    }
    const wait = next <= now ? TICK_MS : Math.min(next - now, TICK_MS);
    this.timer = this.clock.setTimeout(() => this.tick(), wait);
  }

  // A schedules.run another runner asked for: sent as if run here.
  private async runRequested(backend: ScheduleBackend, row: ScheduleRecord): Promise<void> {
    const request = row.runRequestedAt!;
    const claimed = await backend.claim(row.id, 'request', request).catch(() => false);
    if (!claimed || this.stopped) return;
    // As it is now (backendTick says why): deleted meanwhile, or no longer
    // the one claimed, it isn't sent.
    const rec = this.stillClaimed(backend, row);
    if (!rec) return;
    let res: ReturnType<Scheduler['send']>;
    try {
      this.notMidCheck(rec);
      res = this.send(rec, true, this.keptFor(rec));
    } catch (e) {
      // Busy (a restart, or its thread finishing on the old runner): leave
      // the request for the next look.
      if (e instanceof RpcError && e.code === ErrorCode.busy) {
        await backend.release(rec.id).catch(() => {});
        return;
      }
      throw e;
    }
    if (res.outcome === 'sent' && rec.at) this.finish(rec);
    delete rec.runRequestedAt;
    await this.recordRun(rec, res.outcome === 'sent', request);
  }

  // The schedule a claim was taken for, as the subscription has it now, or
  // undefined when that one isn't there to send any more: deleted, moved to
  // another runner, or a different schedule under the same id. The claim
  // was the backend saying this runner may send that row; a row that came in
  // under its id meanwhile wasn't claimed. Daybreak's finding (6 Nov): the
  // owner deletes a schedule while its check runs, a runner key saves one
  // of its own under the gone id (same check, its own text, Full access),
  // and the main Mac's subscription, which has every runner's rows, handed
  // the new row to send() in place of the claimed one. So it must still be
  // this runner's (only the owner key or this runner's own can write a row
  // with our runnerId) and the same schedule (createdAt, which update
  // keeps). Its kept check output went with the old one (onRows).
  private stillClaimed(backend: ScheduleBackend, claimed: ScheduleRecord): ScheduleRecord | undefined {
    const now = this.items.get(claimed.id);
    if (now && this.mine(now) && now.createdAt === claimed.createdAt) return now;
    // Let go, in case the claim is still on a row of ours (moved away keeps
    // it): only the holder's is cleared.
    if (now) void backend.release(claimed.id).catch(() => {});
    else this.dropKept(claimed.id);
    return undefined;
  }

  // Its check, when it has one and checks are on (schedule-check.ts):
  // undefined to run as usual.
  // 'later': not now, leave it due (its check is running in another runner
  // process, or the check was changed while it ran).
  private async checked(rec: ScheduleRecord): Promise<{ skip: string } | Carried | 'later' | undefined> {
    if (!rec.check || !this.checksOn()) return undefined;
    const cwd = this.checkFolder(rec);
    // What it printed last time and no run has carried yet (a restart
    // refused the send, or the runner stopped mid-check): send that rather
    // than asking again, as a check that keeps state won't print it twice.
    const command = rec.check;
    const id = rec.id;
    const timeoutMs = checkLimitMs(rec.checkTimeoutSecs);
    const kept = this.keptFor(rec);
    if (kept) return kept;
    if (checkRunningElsewhere(this.home, id, this.clock.now())) return 'later';
    // Approved once, it runs unattended from then on, so it must still be
    // what was approved: the command, in this folder, reaching these bytes.
    // Read afresh now. What's in a row isn't enough, as the backend's row
    // says what to run but only this runner's own store says it was approved.
    const hold = this.heldCheck(command, cwd, id);
    if (hold) return hold;
    try {
      markCheckRunning(this.home, id, this.clock.now(), timeoutMs);
    } catch {
      // It still runs; another process just can't see it is.
    }
    const run = this.check({ command, cwd, home: this.home, scheduleId: id, timeoutMs })
      .catch((e: unknown) => ({ ok: false as const, output: '', why: String(e) }))
      .then((r) => {
        const out = checkOutcome(r);
        // Deleted meanwhile: nothing to send it with.
        const now = this.items.get(id);
        if (!now) return 'later' as const;
        let res: typeof out | Carried = out;
        if ('extra' in out) {
          const kept = { check: command, at: this.iso(), extra: out.extra };
          try {
            keepCheck(this.home, id, kept);
          } catch (e) {
            // Kept in memory instead, so at least this process's next try
            // doesn't run the check again and lose it.
            this.memKept.set(`${id}\n${command}`, kept);
            this.log.warn("could not keep a schedule check's output", { scheduleId: id, error: String(e) });
          }
          res = { extra: out.extra, kept: kept.at, check: command };
        }
        // Changed or taken off while it ran: not sent under the new check
        // (kept with its own command, as update says).
        if (now.check !== command) return 'later' as const;
        return res;
      })
      .finally(() => {
        try {
          clearCheckRunning(this.home, id);
        } catch {
          // Its time limit makes it stale anyway.
        }
      });
    this.inFlight.set(run, timeoutMs);
    this.checkingNow.add(id);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
      this.checkingNow.delete(id);
    }
  }

  // Where a check runs: its thread's folder, its own, or the runner's.
  private checkFolder(rec: ScheduleRecord): string {
    if (rec.threadId) {
      try {
        return this.runner.get(rec.threadId).cwd;
      } catch {
        // A thread that's gone: send says so.
      }
    }
    return rec.cwd ? path.resolve(expandHome(rec.cwd)) : this.home;
  }

  // Binds a schedule's check to what it runs as this is called, in this
  // runner's own store: making or changing one is what approves it (a thread
  // that asks first has had its card by now, threadbear-mcp.ts). A failure
  // only means the check is held at its next run.
  private approveCheck(rec: ScheduleRecord, card?: CheckCard): void {
    if (!rec.check) return;
    try {
      this.runner.patchTrust.approveCheck(rec.check, this.checkFolder(rec), card);
    } catch (e) {
      // A card's approval that doesn't hold changes nothing.
      if (card) throw bad(e instanceof Error ? e.message : String(e));
      this.log.warn("could not approve a schedule's check", { scheduleId: rec.id, error: String(e) });
    }
  }

  // What to do instead of running a check that isn't approved as it is now,
  // or undefined when it is. Said once per version of what it runs, on the
  // run that's sent with it (see send), then skipped: a failed check going
  // quiet would be worse, and an agent every five minutes no better. A folder
  // that's gone counts, as the check would run somewhere else (runCheck).
  private heldCheck(command: string, cwd: string, id: string): { skip: string } | Carried | undefined {
    let hash: string;
    try {
      const v = this.runner.patchTrust.checkApproved(command, cwd);
      if (v.approved && fs.existsSync(cwd)) return undefined;
      hash = v.hash;
    } catch (e) {
      hash = `unreadable: ${String(e)}`;
    }
    if (heldToldAbout(this.home, id) === hash) return { skip: HELD_SKIP };
    return { extra: HELD_EXTRA, held: hash };
  }

  // Run now doesn't run the check, but sends what it kept and no thread
  // has seen, rather than leaving it to a next run a one-off won't have.
  private keptFor(rec: ScheduleRecord): Carried | undefined {
    if (!rec.check || !this.checksOn()) return undefined;
    const kept = this.memKept.get(`${rec.id}\n${rec.check}`) ?? readKeptCheck(this.home, rec.id, rec.check);
    if (!kept || this.delivered.has(`${rec.id}\n${kept.check}\n${kept.at}`)) return undefined;
    return { extra: kept.extra, kept: kept.at, check: kept.check };
  }

  // Run now waits for a check under way (here, or on the old runner in a
  // handover): sent now, it would go without what the check is about to
  // print, and finish a one-off before that has a run to carry it.
  private notMidCheck(rec: ScheduleRecord): void {
    if (!rec.check || !this.checksOn()) return;
    if (this.checkingNow.has(rec.id) || checkRunningElsewhere(this.home, rec.id, this.clock.now())) {
      throw new RpcError(ErrorCode.busy, 'Its check is running; try again in a moment.');
    }
  }

  // A run carrying a check's output was sent, so it needn't be kept.
  private dropKept(scheduleId: string, check?: string): void {
    for (const k of [...this.memKept.keys()]) if (k.startsWith(`${scheduleId}\n`) && (check === undefined || k === `${scheduleId}\n${check}`)) this.memKept.delete(k);
    try {
      dropKeptCheck(this.home, scheduleId, check);
    } catch (e) {
      this.log.warn("could not clear a schedule check's kept output", { scheduleId, error: String(e) });
    }
  }

  private send(rec: ScheduleRecord, manual: boolean, checked?: { skip: string } | Carried): { outcome: 'sent' | 'skipped' | 'failed' | 'retry'; threadId?: string; turnId?: string; note?: string } {
    const at = this.iso();
    const text = `[Scheduled: "${rec.title}", ${this.whenText(rec)}]\n\n${rec.text}${checked && 'extra' in checked ? checked.extra : ''}`;
    const record = (outcome: 'sent' | 'skipped' | 'failed', threadId?: string, note?: string) => {
      rec.lastRun = { at, outcome, ...(threadId ? { threadId } : {}), ...(note ? { note } : {}) };
      if (outcome === 'sent') rec.runs += 1;
      // Only a sent run has carried it. A skip (the last thread still
      // going), a failure or a refused send keeps it for the next run.
      if (outcome === 'sent' && checked && 'extra' in checked && checked.check) {
        this.delivered.add(`${rec.id}\n${checked.check}\n${checked.kept}`);
        this.dropKept(rec.id, checked.check);
      }
      if (outcome === 'sent' && checked && 'extra' in checked && checked.held) {
        try {
          noteHeldTold(this.home, rec.id, checked.held);
        } catch (e) {
          // Told again next run, rather than not told.
          this.log.warn('could not note that a held check was told about', { scheduleId: rec.id, error: String(e) });
        }
      }
      this.log.info('schedule ran', { scheduleId: rec.id, outcome, threadId, note });
    };
    if (checked && 'skip' in checked) {
      record('skipped', undefined, checked.skip);
      return { outcome: 'skipped', note: checked.skip };
    }
    // Its thread is busy on a draining runner: it's sent once the thread
    // has come across, like a busy thread's queue.
    if (rec.threadId && this.elsewhere(rec.threadId)) {
      if (manual) throw new RpcError(ErrorCode.busy, 'That thread is finishing a turn on the old runner; try again in a moment.');
      return { outcome: 'retry' };
    }
    try {
      if (rec.threadId) {
        // queue: a busy thread finishes what it's doing first.
        const { turnId } = this.runner.send(rec.threadId, text, [], { origin: 'schedule', scheduleId: rec.id, queue: true });
        record('sent', rec.threadId);
        return { outcome: 'sent', threadId: rec.threadId, turnId };
      }
      // Don't pile up new threads behind one that's still going.
      const last = rec.lastRun?.outcome === 'sent' ? rec.lastRun.threadId : undefined;
      if (last && !manual && rec.cron && this.isBusy(last)) {
        const note = 'The thread from the last run was still going.';
        record('skipped', last, note);
        return { outcome: 'skipped', note };
      }
      const r = this.runner.create({
        text,
        title: rec.title,
        // Made on another runner, the folder is as it was typed there.
        cwd: rec.cwd ? path.resolve(expandHome(rec.cwd)) : undefined,
        accountId: rec.accountId,
        poolId: rec.poolId,
        model: rec.model,
        effort: rec.effort,
        permissionMode: rec.permissionMode,
        origin: 'schedule',
        scheduleId: rec.id,
      });
      record('sent', r.thread.id);
      return { outcome: 'sent', threadId: r.thread.id, turnId: r.turnId };
    } catch (e) {
      if (e instanceof RpcError && e.code === ErrorCode.busy) {
        if (manual) throw e;
        return { outcome: 'retry' };
      }
      const note = (e as Error).message ?? String(e);
      record('failed', rec.threadId, note);
      this.log.warn('schedule could not run', { scheduleId: rec.id, error: note });
      return { outcome: 'failed', note };
    }
  }

  private isBusy(threadId: string): boolean {
    try {
      return BUSY.has(this.runner.get(threadId).status);
    } catch {
      return false;
    }
  }

  // Works out nextRunAt from now: a one-off's time (even if it's passed,
  // so it runs), or a cron's next time after now, however many it missed.
  private plan(rec: ScheduleRecord): void {
    delete rec.nextRunAt;
    if (rec.paused || rec.finishedAt) return;
    if (rec.at) {
      rec.nextRunAt = rec.at;
      return;
    }
    const t = nextRun(parseCron(rec.cron!), this.clock.now(), rec.timezone ?? this.zone());
    if (t !== undefined) rec.nextRunAt = new Date(t).toISOString();
  }

  private finish(rec: ScheduleRecord): void {
    rec.finishedAt = this.iso();
    delete rec.nextRunAt;
    // What its check kept stays until the schedule goes (prune): a one-off
    // whose send failed and is given a new time sends it then.
  }

  private prune(now: number): boolean {
    let gone = false;
    for (const rec of this.items.values()) {
      if (rec.finishedAt && now - Date.parse(rec.finishedAt) > KEEP_FINISHED_MS) {
        this.items.delete(rec.id);
        this.dropKept(rec.id);
        gone = true;
      }
    }
    return gone;
  }

  // -------------------------------------------------------------- helpers

  private changed(): void {
    const stored = [...this.items.values()];
    const version = this.mode === 'backend' ? 2 : 1;
    try {
      atomicWriteFileSync(this.file, `${JSON.stringify({ version, schedules: stored }, null, 2)}\n`);
    } catch (e) {
      this.log.error('could not save schedules', { error: String(e) });
    }
    this.publish();
  }

  private publish(): void {
    this.runner.publish({ method: 'schedules.updated', params: { schedules: this.list() } });
  }

  private view(rec: ScheduleRecord): Schedule {
    const v: Schedule = { ...rec, whenText: this.whenText(rec) };
    if (rec.runnerId) {
      const own = rec.runnerId === this.self.id;
      const name = own ? this.self.name : this.names.get(rec.runnerId);
      if (name) v.runnerName = name;
      const icon = own ? this.self.icon : this.icons.get(rec.runnerId);
      if (icon) v.runnerIcon = icon;
    }
    return v;
  }

  private whenText(rec: ScheduleRecord): string {
    if (rec.at) return describeAt(Date.parse(rec.at), rec.timezone ?? this.zone(), this.clock.now());
    try {
      return describeCron(parseCron(rec.cron ?? ''), rec.timezone);
    } catch {
      return `Cron ${rec.cron}`;
    }
  }

  private mustGet(idOrPrefix: string): ScheduleRecord {
    const exact = this.items.get(idOrPrefix);
    if (exact) return exact;
    const hits = idOrPrefix ? [...this.items.values()].filter((s) => s.id.startsWith(idOrPrefix)) : [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw bad(`${idOrPrefix} matches ${hits.length} schedules; use more of the id.`);
    throw new RpcError(ErrorCode.scheduleNotFound, `No schedule ${idOrPrefix}`);
  }

  private parseAt(at: string): number {
    const t = Date.parse(at);
    if (Number.isNaN(t)) throw bad(`at must be an ISO time, not "${at}"`);
    return t;
  }

  private parsedCron(cron: string): ReturnType<typeof parseCron> {
    try {
      const spec = parseCron(cron);
      if (nextRun(spec, this.clock.now(), this.zone()) === undefined) throw new CronError(`"${cron}" never runs.`);
      return spec;
    } catch (e) {
      if (e instanceof CronError) throw bad(e.message);
      throw e;
    }
  }

  private checkedZone(zone: string): string {
    try {
      return checkZone(zone);
    } catch (e) {
      throw bad((e as Error).message);
    }
  }

  private checkedFolder(cwd: string | undefined): string {
    const dir = path.resolve(expandHome(cwd?.trim() ? cwd.trim() : this.runner.hello().defaults.cwd));
    if (!isDirectory(dir)) throw bad(`Folder not found: ${dir}`);
    return dir;
  }

  private checkedAccount(id: string): string {
    if (!this.runner.hello().accounts.some((a) => a.id === id)) throw new RpcError(ErrorCode.accountNotFound, `No account called ${id}`);
    return id;
  }

  private checkedPool(id: string): string {
    const pools = this.runner.hello().pools;
    if (!pools.some((x) => x.id === id)) throw bad(`No pool called ${id}. Pools: ${pools.map((x) => x.id).join(', ')}`);
    return id;
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

function firstLine(text: string): string {
  return firstLineSafely(text, 80) || 'Scheduled message';
}

function checkedTimeout(secs: number): number {
  if (!Number.isInteger(secs) || secs < 1 || secs > MAX_CHECK_TIMEOUT_SECS) throw bad(`checkTimeoutSecs must be a whole number of seconds from 1 to ${MAX_CHECK_TIMEOUT_SECS}`);
  return secs;
}

function checkedCheck(command: string): string {
  const c = command.trim();
  if (c.length > MAX_CHECK_CHARS) throw bad(`check must be at most ${MAX_CHECK_CHARS} characters`);
  return c;
}

function setOrDelete<K extends 'model' | 'effort'>(rec: ScheduleRecord, key: K, v: ScheduleRecord[K] | null): void {
  if (v === null || v === undefined || v === '') delete rec[key];
  else rec[key] = v;
}

// ------------------------------------------------------------- the methods

export function scheduleMethods(s: Scheduler): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'schedules.list': (p) => ({ schedules: s.list(str(p, 'threadId')) }),
    'runners.list': async () => ({ runners: await s.runners() }),
    'schedules.create': async (p) => ({
      schedule: await s.create({
        text: str(p, 'text') ?? '',
        title: str(p, 'title'),
        at: str(p, 'at'),
        cron: str(p, 'cron'),
        timezone: str(p, 'timezone'),
        threadId: str(p, 'threadId'),
        cwd: str(p, 'cwd'),
        accountId: str(p, 'accountId'),
        poolId: str(p, 'poolId'),
        model: str(p, 'model'),
        effort: effort(p.effort) ?? undefined,
        permissionMode: mode(p.permissionMode),
        check: str(p, 'check'),
        ...checkCardOf(p),
        checkTimeoutSecs: num(p, 'checkTimeoutSecs'),
        paused: bool(p, 'paused'),
        createdBy: str(p, 'createdBy'),
        runnerId: str(p, 'runnerId'),
      }),
    }),
    'schedules.update': async (p) => {
      const scheduleId = str(p, 'scheduleId');
      if (!scheduleId) throw bad('scheduleId must be a string');
      const upd: UpdateScheduleParams = { scheduleId };
      for (const k of ['title', 'text', 'at', 'cron', 'cwd', 'accountId'] as const) {
        const v = str(p, k);
        if (v !== undefined) upd[k] = v;
      }
      if (p.timezone !== undefined) upd.timezone = p.timezone === null ? null : str(p, 'timezone');
      if (p.poolId !== undefined) upd.poolId = p.poolId === null ? null : str(p, 'poolId');
      if (p.model !== undefined) upd.model = p.model === null ? null : str(p, 'model');
      if (p.effort !== undefined) upd.effort = effort(p.effort);
      if (p.permissionMode !== undefined) upd.permissionMode = mode(p.permissionMode);
      if (p.paused !== undefined) upd.paused = bool(p, 'paused');
      if (p.check !== undefined) upd.check = p.check === null ? null : str(p, 'check');
      Object.assign(upd, checkCardOf(p));
      if (p.checkTimeoutSecs !== undefined) upd.checkTimeoutSecs = p.checkTimeoutSecs === null ? null : num(p, 'checkTimeoutSecs');
      return { schedule: await s.update(upd) };
    },
    'schedules.delete': (p) => s.delete(reqStr(p, 'scheduleId')),
    'schedules.run': (p) => s.runNow(reqStr(p, 'scheduleId')),
    'schedules.preview': (p) => {
      const count = p.count;
      if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count))) throw bad('count must be a whole number');
      return s.preview({ cron: str(p, 'cron'), at: str(p, 'at'), timezone: str(p, 'timezone'), count: count as number | undefined });
    },
  };
}

// A card's approval passing through from a draining runner's tool call
// (handover.ts). It can only refuse more: leaving it out approves as things
// are, which is what the app and tb do.
function checkCardOf(p: Record<string, unknown>): { checkCard?: CheckCard } {
  const c = p.checkCard;
  if (c === undefined || c === null) return {};
  if (typeof c !== 'object') throw bad('checkCard must be an object');
  const { hash, folder } = c as { hash?: unknown; folder?: unknown };
  return { checkCard: { ...(typeof hash === 'string' ? { hash } : {}), ...(typeof folder === 'string' ? { folder } : {}) } };
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function reqStr(p: Record<string, unknown>, k: string): string {
  const v = str(p, k);
  if (v === undefined) throw bad(`${k} must be a string`);
  return v;
}

function bool(p: Record<string, unknown>, k: string): boolean | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${k} must be a boolean`);
  return v;
}

function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw bad(`${k} must be a number`);
  return v;
}

function effort(v: unknown): EffortLevel | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isEffortLevel(v)) throw bad(`effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  return v;
}

function mode(v: unknown): PermissionMode | undefined {
  if (v === undefined || v === null) return undefined;
  if (v !== 'full' && v !== 'ask' && v !== 'auto') throw bad('permissionMode must be "full", "ask" or "auto"');
  return v;
}
