// A schedule's check (experiment scheduleChecks, experiments.ts): a shell
// command its runner runs before each run, in the schedule's folder. If it
// prints nothing, the run is skipped and no agent starts, so a watcher that
// polls every few minutes costs nothing until there's something to do.
// Whatever it prints goes into the message. A check that fails (exits
// non-zero or times out) doesn't skip the run: the run goes ahead with the
// error, so the agent can see the check is broken rather than it going
// quiet. Cloudroom, Intentic and Paradev gate their automations this way
// (6 Nov 2026, thread d698c77d).
//
// THREADBEAR_CHECK_STATE names a file of the schedule's own that the check
// may keep state in between runs (the last id it saw), and
// THREADBEAR_SCHEDULE_ID is the schedule's id.
//
// A check like that reports each thing once, so what it printed is kept in
// a file of the schedule's own (keptCheckFile) until a run carrying it has
// really been sent, and the run uses that rather than running the check
// again. A restart landing between the check and the send would otherwise
// lose it: the next runner's check finds nothing new (6 Nov 2026, schedule
// 54f11e8a in a handover).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWriteFileSync } from './fsutil.ts';
import { dropPartialStart, safeStart } from './safe-cut.ts';

// How long a check may run unless its schedule says (checkTimeoutSecs),
// and the most it can say: a Slack read through `codex exec` took 77 s by
// 6 Nov 2026 and failed every hour on the fixed minute (schedule 7a3a98d9).
// The cap keeps a stuck check from holding a runner's stop for long.
export const CHECK_TIMEOUT_MS = 60_000;
export const MAX_CHECK_TIMEOUT_SECS = 300;
export const CHECK_OUTPUT_CHARS = 8000;
export const MAX_CHECK_CHARS = 2000;

export type CheckResult = { ok: true; output: string } | { ok: false; output: string; why: string };

export function checkStateFile(home: string, scheduleId: string): string {
  return path.join(home, 'schedule-checks', `${scheduleId}.state`);
}

// One per command: what a check kept is that command's news, so a changed
// check neither sends it nor writes over it, and it's sent if that check
// is put back.
export function keptCheckFile(home: string, scheduleId: string, check: string): string {
  const hash = crypto.createHash('sha256').update(check).digest('hex').slice(0, 12);
  return path.join(home, 'schedule-checks', `${scheduleId}.${hash}.kept.json`);
}

// What a check printed that hasn't reached a thread yet, and the command
// that printed it.
export type KeptCheck = { check: string; at: string; extra: string };

export function readKeptCheck(home: string, scheduleId: string, check: string): KeptCheck | undefined {
  let kept: KeptCheck;
  try {
    kept = JSON.parse(fs.readFileSync(keptCheckFile(home, scheduleId, check), 'utf8'));
  } catch {
    return undefined;
  }
  if (!kept || typeof kept.extra !== 'string' || kept.check !== check) return undefined;
  return kept;
}

export function keepCheck(home: string, scheduleId: string, kept: KeptCheck): void {
  const file = keptCheckFile(home, scheduleId, kept.check);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // It can hold whatever the check printed, so it's the user's only.
  atomicWriteFileSync(file, JSON.stringify(kept), 0o600);
}

// That command's, or with none, all the schedule's (it's gone).
export function dropKeptCheck(home: string, scheduleId: string, check?: string): void {
  if (check !== undefined) {
    fs.rmSync(keptCheckFile(home, scheduleId, check), { force: true });
    return;
  }
  const dir = path.join(home, 'schedule-checks');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (n.startsWith(`${scheduleId}.`) && (n.endsWith('.kept.json') || n.endsWith('.held'))) fs.rmSync(path.join(dir, n), { force: true });
}

// A check whose approval no longer holds (schedules.ts, `held`): the digest
// of what it'd run that a thread has been told about, so that's said once
// and later runs are skipped until it's approved again, rather than an agent
// starting every five minutes to hear the same thing.
function heldCheckFile(home: string, scheduleId: string): string {
  return path.join(home, 'schedule-checks', `${scheduleId}.held`);
}

export function heldToldAbout(home: string, scheduleId: string): string | undefined {
  try {
    return fs.readFileSync(heldCheckFile(home, scheduleId), 'utf8');
  } catch {
    return undefined;
  }
}

export function noteHeldTold(home: string, scheduleId: string, hash: string): void {
  fs.mkdirSync(path.join(home, 'schedule-checks'), { recursive: true });
  atomicWriteFileSync(heldCheckFile(home, scheduleId), hash);
}

export const HELD_EXTRA = "\n\nIts check wasn't run, as what it runs has changed since it was approved (or it was never approved on this runner). So this run went ahead without it, and later runs are skipped until it's approved again. Look at what it runs, and if that's fine, call update_schedule with the same check to approve it as it is now.";
export const HELD_SKIP = "Its check is waiting to be approved again, as what it runs has changed: update_schedule with the same check approves it.";

// A check under way in some runner process, so another one (the next
// release, in a handover) waits for it rather than running it again: the
// first will keep what it prints. A marker whose process has gone, or that
// is older than any check can run, doesn't count.
export function runningCheckFile(home: string, scheduleId: string): string {
  return path.join(home, 'schedule-checks', `${scheduleId}.running.json`);
}

// limitMs: its time limit, so another process knows when the marker has
// gone stale. A marker without one (an older release's) had a minute.
export function markCheckRunning(home: string, scheduleId: string, at: number, limitMs = CHECK_TIMEOUT_MS): void {
  atomicWriteFileSync(runningCheckFile(home, scheduleId), JSON.stringify({ pid: process.pid, at, limitMs }));
}

// A schedule's own time limit for its check, in ms.
// A record from the backend hasn't been through checkedTimeout, so anything
// but a positive number is the default rather than a timer firing at once.
export function checkLimitMs(checkTimeoutSecs: unknown): number {
  if (typeof checkTimeoutSecs !== 'number' || !(checkTimeoutSecs > 0)) return CHECK_TIMEOUT_MS;
  return Math.min(checkTimeoutSecs, MAX_CHECK_TIMEOUT_SECS) * 1000;
}

export function clearCheckRunning(home: string, scheduleId: string): void {
  fs.rmSync(runningCheckFile(home, scheduleId), { force: true });
}

export function checkRunningElsewhere(home: string, scheduleId: string, now: number): boolean {
  let m: { pid?: unknown; at?: unknown; limitMs?: unknown };
  try {
    m = JSON.parse(fs.readFileSync(runningCheckFile(home, scheduleId), 'utf8'));
  } catch {
    return false;
  }
  if (typeof m?.pid !== 'number' || typeof m.at !== 'number' || m.pid === process.pid) return false;
  const limit = typeof m.limitMs === 'number' && m.limitMs > 0 ? Math.min(m.limitMs, MAX_CHECK_TIMEOUT_SECS * 1000) : CHECK_TIMEOUT_MS;
  if (now - m.at > limit * 2) return false;
  try {
    process.kill(m.pid, 0);
    return true;
  } catch (e) {
    // EPERM: it's there, just not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runCheck(p: { command: string; cwd: string; home: string; scheduleId: string; timeoutMs?: number }): Promise<CheckResult> {
  const state = checkStateFile(p.home, p.scheduleId);
  try {
    fs.mkdirSync(path.dirname(state), { recursive: true });
  } catch {
    // The check can still run; it just has nowhere to keep state.
  }
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: CheckResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('/bin/sh', ['-c', p.command], {
      cwd: fs.existsSync(p.cwd) ? p.cwd : undefined,
      env: { ...process.env, THREADBEAR_SCHEDULE_ID: p.scheduleId, THREADBEAR_CHECK_STATE: state },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout stops whatever it started too.
      detached: true,
    });
    // Whether what's kept has lost its start, maybe in a secret whose start is gone.
    let cutFront = false;
    const take = (b: Buffer) => {
      // Keep the end: the last lines of a long output say the most.
      out += b.toString('utf8');
      if (out.length > CHECK_OUTPUT_CHARS * 2) {
        out = out.slice(-CHECK_OUTPUT_CHARS * 2);
        cutFront = true;
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // Says how to give it longer, for the agent that reads it.
      finish({ ok: false, output: clip(cutFront ? dropPartialStart(out) : out), why: `it took longer than ${Math.round((p.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000)} seconds; the schedule's checkTimeoutSecs can give it up to ${MAX_CHECK_TIMEOUT_SECS}` });
    }, p.timeoutMs ?? CHECK_TIMEOUT_MS);
    child.on('error', (e) => finish({ ok: false, output: clip(cutFront ? dropPartialStart(out) : out), why: e.message }));
    child.on('close', (code, signal) => {
      if (code === 0) finish({ ok: true, output: clip(cutFront ? dropPartialStart(out) : out) });
      else finish({ ok: false, output: clip(cutFront ? dropPartialStart(out) : out), why: signal ? `it was stopped by ${signal}` : `it exited with ${code}` });
    });
  });
}

function clip(s: string): string {
  const t = s.trim();
  // Its last part, begun where no secret is cut in two (safe-cut.ts).
  return t.length > CHECK_OUTPUT_CHARS ? '…' + t.slice(safeStart(t, t.length - CHECK_OUTPUT_CHARS)) : t;
}

// What goes under the scheduled message, or that the run is skipped.
export function checkOutcome(r: CheckResult): { skip: string } | { extra: string } {
  if (r.ok && !r.output) return { skip: 'Its check found nothing new.' };
  const block = r.output ? `\n\n\`\`\`\n${r.output.replaceAll('```', "'''")}\n\`\`\`` : '';
  if (r.ok) return { extra: `\n\nIts check found this:${block}` };
  return { extra: `\n\nIts check failed (${r.why}), so this run went ahead anyway. If it keeps failing, fix the check with update_schedule.${block}` };
}
