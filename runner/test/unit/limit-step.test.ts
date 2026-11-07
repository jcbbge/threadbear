// scripts/limit-step.mjs, which check.sh runs the Swift steps through so a
// frozen one can't hold up every landing (an xctest in a modal alert, 7 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'limit-step.mjs');

function run(script: string, limits = ['--silence', '1', '--total', '60']) {
  return spawnSync(process.execPath, [SCRIPT, ...limits, '--', 'bash', '-c', script], { encoding: 'utf8', timeout: 60_000 });
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a step that finishes keeps its output and exit code', () => {
  const ok = run('echo out; echo err >&2');
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'out\n');
  assert.equal(ok.stderr, 'err\n');
  assert.equal(run('exit 3').status, 3);
});

test('a step that stays quiet past the limit is killed, naming the test that was running', () => {
  const started = Date.now();
  const r = run(`echo "Test Case '-[A b]' started."; echo "Test Case '-[A b]' passed (0.1 seconds)."; echo "Test Case '-[A frozen]' started."; exec sleep 60`);
  assert.equal(r.status, 124);
  assert.ok(Date.now() - started < 30_000, 'not left to run to the end');
  assert.match(r.stdout, /limit-step: error: no output for 1 s/);
  assert.match(r.stdout, /still running: -\[A frozen\]$/m);
  assert.doesNotMatch(r.stdout, /still running:.*-\[A b\]/);
});

test('Swift Testing tests count too, whatever their symbol', () => {
  const r = run(`printf '\\e[1m◇\\e[0m Test first() started.\\n✔ Test first() passed after 0.1 seconds.\\n􀟈 Test second() started.\\n'; exec sleep 60`);
  assert.equal(r.status, 124);
  assert.match(r.stdout, /still running: second\(\)$/m);
});

test('a step that keeps printing still stops at the total limit', () => {
  const r = run('while :; do echo tick; sleep 0.2; done', ['--silence', '30', '--total', '1']);
  assert.equal(r.status, 124);
  assert.match(r.stdout, /error: still going after 1 s/);
  assert.match(r.stdout, /no test was running\. Last line: tick/);
});

test('what a step started goes too, even in a process group of its own', () => {
  // As swift test starts xctest: `set -m` gives each background job its own group.
  const dir = tmpDir('limit-step-');
  const pidFile = path.join(dir, 'pid');
  const r = run(`set -m; sleep 60 & echo $! >"${pidFile}"; wait`);
  assert.equal(r.status, 124);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.equal(alive(pid), false, 'the frozen process is gone');
});

test('a process that ignores SIGTERM goes too, even when the step itself stops at once', () => {
  const dir = tmpDir('limit-step-');
  const pidFile = path.join(dir, 'pid');
  // The ignored signal carries through exec; the bash above it dies on SIGTERM.
  const r = run(`(trap '' TERM; exec sleep 60) & echo $! >"${pidFile}"; wait`);
  assert.equal(r.status, 124);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.equal(alive(pid), false, 'it got the SIGKILL');
});

test('a process holding the output open after the step exits does not hold up the check', () => {
  const started = Date.now();
  const r = run('sleep 30 & exit 0', ['--silence', '60', '--total', '60']);
  assert.equal(r.status, 0);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
});

test('a command that cannot start says so', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--silence', '1', '--total', '1', '--', '/no/such/command'], { encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /limit-step: error: couldn't run/);
});

test('wrong arguments are refused rather than running with no limit', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--', 'true'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--silence', '1', '--total', '1'], { encoding: 'utf8' }).status, 2);
});
