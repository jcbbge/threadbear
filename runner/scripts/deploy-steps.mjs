// The build steps deploy.mjs runs before it makes a release (typecheck, unit
// tests, npm ci), apart from the script so test/unit/deploy-steps.test.ts can
// drive them with fake processes. deploy.mjs runs on import, so it can't be
// imported by a test itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A failure with a message for whoever ran the script; no stack trace.
export class Fail extends Error {}

// A step that didn't exit 0, with where its output went.
export class StepFailed extends Fail {
  constructor(message, logFile) {
    super(message);
    this.logFile = logFile;
  }
}

// Why a spawnSync run didn't succeed, in words. A process that couldn't start
// (r.error: EAGAIN with too many processes, ENOENT) or was killed (r.signal)
// writes nothing to its log, so without this the cause was lost: on 4 Nov the
// self-update's unit tests "failed" in 0.1s with an empty log and nothing said
// why (Sentry THREADBEAR-M).
export function whyFailed(r, cmd) {
  const what = path.basename(cmd);
  if (r.error) return `${what} couldn't run: ${r.error.message}`;
  if (r.signal) return `${what} was stopped by ${r.signal}`;
  return `${what} exited with ${r.status}`;
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return `(no log at ${file})`;
  }
}

// Runs a step with its output in a log file, printed only if it fails.
// io: { say, write, error, spawn, tmpdir } for tests; the defaults are the
// console and spawnSync.
export function step(name, cmd, args, opts, io = {}) {
  const { say = console.log, write = (s) => process.stdout.write(s), error = console.error, spawn = spawnSync, tmpdir = os.tmpdir() } = io;
  write(`${name}... `);
  const started = Date.now();
  const logFile = path.join(tmpdir, `threadbear-deploy-${process.pid}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.log`);
  const fd = fs.openSync(logFile, 'w');
  const r = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const secs = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (r.status === 0) {
    say(`ok (${secs})`);
    fs.rmSync(logFile, { force: true });
    return;
  }
  const why = whyFailed(r, cmd);
  // In the log too, so the file named in the error says what happened.
  fs.appendFileSync(logFile, `\n[deploy] ${why}\n`);
  say(`failed (${secs}): ${why}`);
  error(tail(logFile));
  throw new StepFailed(`${name} failed (${why}); the whole output is in ${logFile}`, logFile);
}

// The full suite runs files in parallel on a Mac that's usually busy with
// threads, so a test with a timing assumption can fail for no real reason
// and hold the runner back from main. Files that failed get one more go, one
// at a time; a real break fails both runs and still stops the update.
// A run that failed without naming a test file (npm couldn't start, was
// killed, or died before the tests reported) gets the whole suite once more,
// as that isn't a test failing, and update.ts won't try this tree again.
// Both runs give up on a test after 5 minutes, and end once the tests are
// done even if one left a server open (package.json's test script has the
// same flags). Without them a test that failed with its socket still open
// held the run, and so the runner, off main for 48 minutes on 29 Oct, until
// it was stopped by hand.
export const TEST_LIMITS = ['--test-timeout=300000', '--test-force-exit'];
export function unitTests(c, opts, io = {}) {
  const { say = console.log } = io;
  try {
    step('Unit tests', c.npm, ['test'], opts, io);
  } catch (e) {
    if (!(e instanceof StepFailed)) throw e;
    const files = failedTestFiles(readOr(e.logFile));
    if (!files.length) {
      say(`The unit tests failed without naming a test file; running them once more.`);
      step('Unit tests, again', c.npm, ['test'], opts, io);
      say(`The second run passed (first run's output: ${e.logFile})`);
      return;
    }
    step(`Rerunning ${files.join(', ')}`, c.node ?? process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...TEST_LIMITS, ...files], opts, io);
    say(`Flaky: ${files.join(', ')} failed in the full run and passed alone (first run's output: ${e.logFile})`);
  }
}

function readOr(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// node --test's summary names each failure as "test at <file>:<line>:<col>".
export function failedTestFiles(output) {
  return [...new Set([...output.matchAll(/^test at (\S+?\.test\.ts):\d+:\d+$/gm)].map((m) => m[1]))];
}

// Whether the smoke test gives up on a release that hasn't said it's
// listening after `waited` ms, with the Mac's one-minute load per core what
// it is now. A healthy release listens in seconds; 90 s covers a busy Mac.
// Past that it keeps waiting only while the Mac is overloaded (more than
// twice as much to run as it has cores), up to ten minutes: on 6 Nov a load
// of 94 on 18 cores failed a release that started in 7 s once it eased, and
// a release that crashes is caught at once whatever the wait.
export function smokeTimedOut(waited, loadPerCore) {
  if (waited <= 90_000) return false;
  return loadPerCore <= 2 || waited > 10 * 60_000;
}
