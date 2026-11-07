#!/usr/bin/env node
// Runs a check step, and kills it if it freezes:
//
//   node scripts/limit-step.mjs --silence SECS --total SECS -- <command...>
//
// check.sh runs the Swift steps through this. On 7 Nov an xctest sat for 18
// minutes in a modal alert nobody could click: a run holds the check host's
// lock until it ends, and `tb land` holds the landing lock while it waits, so
// five checks and every landing queued behind it.
//
// A build or test prints something at least every few minutes however loaded
// the machine is, so what gives a freeze away is no output at all for
// --silence. --total is for one that freezes while still printing. Past either,
// this saves where the stuck process is (sample), kills the whole tree, says
// which test was running and exits 124.
//
// swift test only streams test names with NSUnbufferedIO=YES (check.sh sets
// it). Without it, nothing arrives until xctest's buffer fills or it exits.
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const command = split >= 0 ? args.slice(split + 1) : [];
const option = (name) => {
  const at = args.indexOf(name);
  const value = at >= 0 && at < split ? Number(args[at + 1]) : NaN;
  return value > 0 ? value : null;
};
const silenceSecs = option('--silence');
const totalSecs = option('--total');
if (!command.length || !silenceSecs || !totalSecs) {
  console.error('usage: limit-step.mjs --silence SECS --total SECS -- <command...>');
  process.exit(2);
}

// Tests started and not finished, in order. XCTest's lines, then Swift
// Testing's (whose symbol depends on the terminal, so any non-space word).
const running = new Set();
let lastLine = '';
function note(raw) {
  const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (!line) return;
  lastLine = line;
  let m;
  if ((m = line.match(/^Test Case '(.+)' started/))) running.add(m[1]);
  else if ((m = line.match(/^Test Case '(.+)' (passed|failed|skipped)/))) running.delete(m[1]);
  else if ((m = line.match(/^\S+ Test (.+?) started/))) running.add(m[1]);
  else if ((m = line.match(/^\S+ Test (.+?) (passed|failed|skipped)/))) running.delete(m[1]);
}

const startedAt = Date.now();
let lastOutput = startedAt;
const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });

function follow(stream, out) {
  let partial = '';
  stream.on('data', (chunk) => {
    lastOutput = Date.now();
    out.write(chunk);
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop();
    for (const line of lines) note(line);
  });
}
follow(child.stdout, process.stdout);
follow(child.stderr, process.stderr);

// Every process under the step. Not its process group: swift test starts
// xctest in a group of its own, so killing the group would leave the frozen
// one running, still holding the output open.
function tree(roots = [child.pid]) {
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  const kids = new Map();
  for (const row of (ps.stdout ?? '').split('\n')) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const found = [];
  const walk = (pid) => { for (const kid of kids.get(pid) ?? []) { found.push(kid); walk(kid); } };
  roots.forEach(walk);
  return { all: [...roots, ...found], leaves: found.filter((pid) => !kids.has(pid)) };
}

function alive(pid) {
  // A zombie (the step, until node reaps it) answers too, which only delays
  // this by a moment: its exit event comes round the same loop.
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function kill(pids, signal) {
  for (const pid of pids) { try { process.kill(pid, signal); } catch { /* gone already */ } }
}

// Where each stuck process is: the call graph, and the deepest frames of our
// own code for the end of the log, which is the part check.sh shows.
function whereStuck(pids) {
  const frames = [];
  if (process.platform !== 'darwin') return frames;
  for (const pid of pids.slice(0, 3)) {
    const run = spawnSync('/usr/bin/sample', [String(pid), '2'], { encoding: 'utf8', timeout: 30_000 });
    const text = run.stdout ?? '';
    const start = text.indexOf('Call graph:');
    const end = text.indexOf('Total number in stack');
    if (start < 0) continue;
    const graph = text.slice(start, end < 0 ? undefined : end);
    console.log(`\n--- sample of process ${pid}\n${graph}`);
    for (const m of graph.matchAll(/\d+ (.+?) +\(in (Threadbear\w*|\w+Tests)\)/g)) frames.push(m[1]);
  }
  return [...new Set(frames)].slice(-8);
}

let limited = false;
let report = () => {};
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearInterval(watch);
  report();
  process.exitCode = code;
  // Whatever's left holding the output open mustn't hold up the check.
  setTimeout(() => process.exit(code), 200).unref();
}

function hitLimit(why) {
  limited = true;
  const { all, leaves } = tree();
  // Sampling takes seconds and a build that's still going starts more in that
  // time, so the tree is walked again below.
  const frames = whereStuck(leaves.length ? leaves : [child.pid]);
  const tests = [...running];
  // Said last, once the killed step has printed all it's going to, as the end
  // of the log is what check.sh shows. The "error:" is what it looks for when
  // it lists what failed.
  report = () => {
    console.log(`\nlimit-step: error: ${why}, so it was killed.`);
    console.log(tests.length
      ? `limit-step: still running: ${tests.join(', ')}`
      : `limit-step: no test was running. Last line: ${lastLine.slice(0, 200)}`);
    if (frames.length) console.log(`limit-step: stuck in (outermost first): ${frames.join(' > ')}`);
  };
  // Asked to stop, then told, keeping hold of every process seen on the way:
  // one whose parent has gone is out of the tree, and the walk won't find it.
  // This stays until they've all gone, however soon the step itself does.
  const seen = new Set([...all, ...tree().all]);
  // From all of them, as what's left can start more once the step's gone.
  const addTree = () => { for (const pid of tree([...seen].filter(alive)).all) seen.add(pid); };
  kill(seen, 'SIGTERM');
  const askedAt = Date.now();
  let told = false;
  const stopping = setInterval(() => {
    addTree();
    const left = [...seen].filter(alive);
    const waited = Date.now() - askedAt;
    if (!left.length || waited >= 7_000) {
      clearInterval(stopping);
      finish(124);
    } else if (waited >= 5_000 && !told) {
      told = true;
      kill(left, 'SIGKILL');
    }
  }, 200);
}

const watch = setInterval(() => {
  if (limited) return;
  const now = Date.now();
  if (now - lastOutput >= silenceSecs * 1000) hitLimit(`no output for ${silenceSecs} s`);
  else if (now - startedAt >= totalSecs * 1000) hitLimit(`still going after ${totalSecs} s`);
}, Math.min(1000, silenceSecs * 250));

child.on('error', (err) => {
  console.error(`limit-step: error: couldn't run ${command[0]}: ${err.message}`);
  finish(127);
});
child.on('exit', (code, signal) => {
  // After a limit, hitLimit's own loop finishes once the rest has gone.
  if (!limited) finish(code ?? 128 + (constants.signals[signal] ?? 0));
});

// A check that's stopped (ssh dropped, Ctrl-C) takes the step with it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    kill(tree().all, 'SIGKILL');
    process.exit(128 + 15);
  });
}
