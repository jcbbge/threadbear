// The silent on-device secret check: how often would Apple's on-device model
// have held some tool output back from Convex? It's an experiment to answer
// that with real numbers (docs/convex-backend.md, "Secret scrubbing") before
// any such check is trusted with anything. So it changes nothing that uploads,
// and it's off unless runner.json says `secretCheck: { enabled: true }`.
//
// It keeps counts, plus the thread and seq of what it flagged so someone can
// open those on this Mac and judge them. Never their text: that stays in memory
// until its turn and goes only down a pipe to the helper. Mac only, skipped on
// battery, a capped sample rather than everything, at background priority in
// a process of its own so the runner's event loop never waits for it.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from './log.ts';
import { redactSecrets } from './redaction.ts';

export const RUN_EVERY_MS = 10 * 60_000;
export const RETRY_UNAVAILABLE_MS = 60 * 60_000;
export const MAX_QUEUE = 200;
export const TEXTS_PER_RUN = 20;
export const IMAGES_PER_RUN = 10;
export const MAX_TEXT = 6000;
const MIN_TEXT = 40;
const MAX_FLAGGED = 500;
const RUN_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 5 * 60_000;
const TASKPOLICY = '/usr/sbin/taskpolicy';

export type FlaggedItem = { threadId: string; seq: number; source: 'text' | 'image'; at: string };
export type SecretCheckCounts = {
  since: string;
  checkedText: number;
  checkedImages: number;
  flaggedText: number;
  flaggedImages: number;
  errors: number;
  // How it compares with the rules, on text: both said secret, or only the rules.
  rulesAndModel: number;
  rulesOnly: number;
};
export type SecretCheckStatus = SecretCheckCounts & {
  // starting: on here, and hasn't had its first look yet (RUN_EVERY_MS after a start).
  state: 'off' | 'unsupported' | 'starting' | 'unavailable' | 'on';
  reason?: string;
  lastRunAt?: string;
  skippedOnBattery?: number;
  file?: string;
};

type Item = { threadId: string; seq: number } & ({ text: string } | { image: string });
type RunVerdict = { id: number; verdict: string };

// Stand-ins for what touches the machine, for tests.
export type SecretCheckDeps = {
  home: string;
  enabled: boolean;
  log?: Logger;
  now?: () => number;
  platform?: string;
  source?: string;
  build?: (source: string, out: string, signal?: AbortSignal) => Promise<void>;
  probe?: (helper: string) => Promise<string>;
  onAC?: () => Promise<boolean>;
  run?: (helper: string, jobs: string[], signal: AbortSignal) => Promise<RunVerdict[]>;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  exists?: (file: string) => boolean;
};

const realSource = () => fileURLToPath(new URL('./secret-check/main.swift', import.meta.url));

function realBuild(source: string, out: string, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  return new Promise((resolve, reject) => {
    execFile(TASKPOLICY, ['-b', '/usr/bin/xcrun', 'swiftc', '-O', '-o', tmp, source], { timeout: BUILD_TIMEOUT_MS, ...(signal ? { signal } : {}) }, (err) => {
      if (err) {
        fs.rmSync(tmp, { force: true });
        reject(new Error('swiftc failed'));
        return;
      }
      fs.renameSync(tmp, out);
      resolve();
    });
  });
}

function realProbe(helper: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(helper, ['--probe'], { timeout: 30_000 }, (_err, stdout) => resolve(String(stdout).trim() || 'unavailable: the helper said nothing'));
  });
}

function realOnAC(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'ps'], { timeout: 10_000 }, (err, stdout) => resolve(!err && /AC Power/.test(String(stdout))));
  });
}

function realRun(helper: string, jobs: string[], signal: AbortSignal): Promise<RunVerdict[]> {
  return new Promise((resolve) => {
    const child = spawn(TASKPOLICY, ['-b', helper], { stdio: ['pipe', 'pipe', 'ignore'], signal });
    const out: RunVerdict[] = [];
    let buffer = '';
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        try {
          out.push(JSON.parse(buffer.slice(0, at)) as RunVerdict);
        } catch {
          // Not an answer: nothing to count.
        }
        buffer = buffer.slice(at + 1);
      }
    });
    const done = () => {
      clearTimeout(timer);
      resolve(out);
    };
    child.on('error', done);
    child.on('close', done);
    child.stdin.on('error', () => {});
    child.stdin.end(jobs.join('\n') + '\n');
  });
}

export class SecretCheck {
  private deps: SecretCheckDeps;
  private now: () => number;
  private file: string;
  private queue: Item[] = [];
  private state: SecretCheckStatus['state'];
  private reason?: string;
  private counts: SecretCheckCounts;
  private flagged: FlaggedItem[] = [];
  private helper?: string;
  private nextProbeAt = 0;
  private lastRunAt?: number;
  private skippedOnBattery = 0;
  private timer?: { cancel(): void };
  private running = false;
  private stopped = false;
  private abort = new AbortController();

  constructor(deps: SecretCheckDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.file = path.join(deps.home, 'secret-check.json');
    this.counts = this.freshCounts();
    if (!deps.enabled) this.state = 'off';
    else if ((deps.platform ?? process.platform) !== 'darwin') {
      this.state = 'unsupported';
      this.reason = "Apple's on-device model is only on a Mac";
    } else {
      this.state = 'starting';
      this.load();
    }
  }

  private freshCounts(): SecretCheckCounts {
    return { since: new Date(this.now()).toISOString(), checkedText: 0, checkedImages: 0, flaggedText: 0, flaggedImages: 0, errors: 0, rulesAndModel: 0, rulesOnly: 0 };
  }

  private load(): void {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { counts?: SecretCheckCounts; flagged?: FlaggedItem[] };
      if (saved.counts) this.counts = { ...this.counts, ...saved.counts };
      if (Array.isArray(saved.flagged)) this.flagged = saved.flagged;
    } catch {
      // None yet.
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ counts: this.counts, flagged: this.flagged }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.deps.log?.debug('secret check could not save its counts', { code: (e as NodeJS.ErrnoException).code });
      fs.rmSync(tmp, { force: true });
    }
  }

  get on(): boolean {
    return this.state !== 'off' && this.state !== 'unsupported';
  }

  start(): void {
    if (!this.on || this.timer) return;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    // The helper too, so one left running can't save over the next release's counts.
    this.abort.abort();
    this.timer?.cancel();
    this.timer = undefined;
    this.queue = [];
  }

  private arm(): void {
    if (this.stopped) return;
    const set = this.deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { cancel: () => clearTimeout(t) };
    });
    this.timer = set(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.arm());
    }, RUN_EVERY_MS);
  }

  // A tool's output, from a thread's events. A capped sample: past MAX_QUEUE a
  // new one takes a random one's place, so a long run isn't only its first hour.
  see(threadId: string, e: { type?: string; seq?: unknown; text?: unknown; images?: unknown }): void {
    if (!this.on || e.type !== 'tool.result' || typeof e.seq !== 'number') return;
    const seq = e.seq;
    const add = (item: Item) => {
      if (this.queue.length < MAX_QUEUE) this.queue.push(item);
      else this.queue[crypto.randomInt(MAX_QUEUE)] = item;
    };
    if (typeof e.text === 'string' && e.text.trim().length >= MIN_TEXT) add({ threadId, seq, text: e.text.slice(0, MAX_TEXT) });
    if (Array.isArray(e.images)) for (const i of e.images as { path?: unknown }[]) if (typeof i?.path === 'string') add({ threadId, seq, image: i.path });
  }

  // The helper, built the first time from the source in this release: only on
  // a Mac where someone turned this on, so no install ever depends on it.
  private async ensureHelper(): Promise<boolean> {
    const now = this.now();
    if (this.helper && this.state === 'on') return true;
    if (now < this.nextProbeAt) return false;
    this.nextProbeAt = now + RETRY_UNAVAILABLE_MS;
    const source = this.deps.source ?? realSource();
    const exists = this.deps.exists ?? fs.existsSync;
    try {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16);
      const out = path.join(this.deps.home, 'tools', 'secret-check', `secret-check-${hash}`);
      if (!exists(out)) await (this.deps.build ?? realBuild)(source, out, this.abort.signal);
      if (this.stopped) return false;
      const said = await (this.deps.probe ?? realProbe)(out);
      if (this.stopped) return false;
      if (said !== 'available') {
        this.state = 'unavailable';
        this.reason = said.replace(/^unavailable:\s*/, '').slice(0, 200);
        return false;
      }
      this.helper = out;
      this.state = 'on';
      this.reason = undefined;
      return true;
    } catch (e) {
      this.state = 'unavailable';
      this.reason = `its helper wouldn't build (${(e as Error).message.slice(0, 80)}); it needs Xcode's tools and a macOS with Apple's on-device model`;
      this.deps.log?.info('secret check is unavailable', { reason: this.reason });
      return false;
    }
  }

  // One run: a few of each kind, on mains power only.
  async tick(): Promise<void> {
    if (!this.on || this.running || this.stopped || !this.queue.length) return;
    this.running = true;
    try {
      if (!(await this.ensureHelper()) || this.stopped) return;
      if (!(await (this.deps.onAC ?? realOnAC)())) {
        this.skippedOnBattery++;
        return;
      }
      const take = (want: (i: Item) => boolean, n: number) => {
        const out: Item[] = [];
        for (let i = this.queue.length - 1; i >= 0 && out.length < n; i--) {
          if (want(this.queue[i]!)) out.push(...this.queue.splice(i, 1));
        }
        return out;
      };
      const items = [...take((i) => 'text' in i, TEXTS_PER_RUN), ...take((i) => 'image' in i, IMAGES_PER_RUN)];
      if (!items.length) return;
      const jobs = items.map((it, id) => JSON.stringify('text' in it ? { id, text: it.text } : { id, image: it.image }));
      const verdicts = await (this.deps.run ?? realRun)(this.helper!, jobs, this.abort.signal);
      if (this.stopped) return;
      this.lastRunAt = this.now();
      const at = new Date(this.lastRunAt).toISOString();
      for (const v of verdicts) {
        const it = items[v.id];
        if (!it) continue;
        const isText = 'text' in it;
        if (v.verdict === 'empty') continue;
        if (v.verdict === 'error') {
          this.counts.errors++;
          continue;
        }
        if (isText) this.counts.checkedText++;
        else this.counts.checkedImages++;
        const secret = v.verdict === 'secret';
        if (secret) {
          if (isText) this.counts.flaggedText++;
          else this.counts.flaggedImages++;
          this.flagged.push({ threadId: it.threadId, seq: it.seq, source: isText ? 'text' : 'image', at });
          if (this.flagged.length > MAX_FLAGGED) this.flagged.splice(0, this.flagged.length - MAX_FLAGGED);
        }
        if (isText && redactSecrets(it.text).redacted) {
          if (secret) this.counts.rulesAndModel++;
          else this.counts.rulesOnly++;
        }
      }
      // A run the helper died in part way: those items are simply not counted.
      this.counts.errors += Math.max(0, items.length - verdicts.length);
      this.save();
    } finally {
      this.running = false;
    }
  }

  status(): SecretCheckStatus {
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      ...this.counts,
      ...(this.lastRunAt !== undefined ? { lastRunAt: new Date(this.lastRunAt).toISOString() } : {}),
      ...(this.skippedOnBattery ? { skippedOnBattery: this.skippedOnBattery } : {}),
      ...(this.on ? { file: this.file } : {}),
    };
  }
}
