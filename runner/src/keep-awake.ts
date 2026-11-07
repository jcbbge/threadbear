// Keeps the Mac from going to sleep on its own while a thread is working
// (experiment `keepAwake`, experiments.ts). Without it, a long turn on a
// Mac left alone stopped when the Mac slept, and a thread steered from the
// phone sat there until someone woke the Mac. Conductor, Synara, Zuse and
// Autohand all do this (6 Nov 2026, thread d698c77d).
//
// It runs macOS's own `caffeinate -i` while any thread has a turn,
// background job or sub-agent going, and for a few minutes after, so a
// quick run of turns doesn't start and stop it each time. -i only stops
// idle sleep: the display still sleeps and the screen still locks, and
// closing the lid still sleeps a Mac on battery. -w ties it to the
// runner's pid, so it ends with the runner however that goes. On battery
// it lets go below LOW_BATTERY percent. macOS only; elsewhere it's a no-op.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';

export const SWEEP_MS = 30_000;
// How long it stays awake after the last thread stops working.
export const LINGER_MS = 3 * 60_000;
export const LOW_BATTERY = 15;
// How often the battery is read while awake (a spawn, so not every sweep).
export const BATTERY_EVERY_MS = 2 * 60_000;

export type Power = { onBattery: boolean; percent?: number };

export type KeepAwakeDeps = {
  busy: () => number; // threads working now
  on: () => boolean; // the experiment, read each sweep
  clock: Clock;
  log: Logger;
  // Starts caffeinate and returns a handle to stop it; replaced in tests.
  hold?: () => { stop(): void } | undefined;
  power?: () => Promise<Power | undefined>;
};

export class KeepAwake {
  private deps: KeepAwakeDeps;
  private timer?: TimerHandle;
  private held?: { stop(): void };
  private lastBusy = 0;
  private power?: Power;
  private powerAt = 0;
  private reading = false;

  constructor(deps: KeepAwakeDeps) {
    this.deps = deps;
  }

  start(): void {
    this.sweep();
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.release('the runner stopped');
  }

  status(): { holding: boolean } {
    return { holding: Boolean(this.held) };
  }

  sweep(): void {
    this.timer = this.deps.clock.setTimeout(() => this.sweep(), SWEEP_MS);
    const now = this.deps.clock.now();
    if (!this.deps.on()) return this.release('the experiment is off');
    if (this.deps.busy() > 0) this.lastBusy = now;
    const wanted = this.lastBusy > 0 && now - this.lastBusy < LINGER_MS;
    if (!wanted) return this.release('no thread is working');
    // Read before the low-battery check too, so plugging in is noticed.
    if (now - this.powerAt >= BATTERY_EVERY_MS) this.readPower(now);
    if (this.lowBattery()) return this.release('the battery is low');
    if (!this.held) {
      this.held = (this.deps.hold ?? caffeinate)();
      if (this.held) this.deps.log.info('keeping the Mac awake while threads work');
    }
  }

  private lowBattery(): boolean {
    const p = this.power;
    return Boolean(p?.onBattery && p.percent !== undefined && p.percent < LOW_BATTERY);
  }

  private readPower(now: number): void {
    if (this.reading) return;
    this.reading = true;
    this.powerAt = now;
    (this.deps.power ?? readPower)()
      .then((p) => {
        this.power = p;
        if (this.lowBattery()) this.release('the battery is low');
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
      });
  }

  private release(why: string): void {
    if (!this.held) return;
    this.held.stop();
    this.held = undefined;
    this.deps.log.info('letting the Mac sleep again', { why });
  }
}

function caffeinate(): { stop(): void } | undefined {
  if (process.platform !== 'darwin') return undefined;
  let child: ChildProcess;
  try {
    child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  } catch {
    return undefined;
  }
  child.on('error', () => undefined);
  return { stop: () => void child.kill() };
}

// `pmset -g batt`: "Now drawing from 'Battery Power'" and "-InternalBattery-0 (id=…)	87%; discharging".
function readPower(): Promise<Power | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(parsePower(String(stdout)));
    });
  });
}

export function parsePower(out: string): Power | undefined {
  if (!out.trim()) return undefined;
  const pct = /(\d{1,3})%/.exec(out);
  return { onBattery: /'Battery Power'/.test(out), ...(pct ? { percent: Number(pct[1]) } : {}) };
}
