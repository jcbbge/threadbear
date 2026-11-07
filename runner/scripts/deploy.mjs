// deploy-runner.sh's logic: builds a release of the runner from this
// checkout and switches the live runner to it (docs/dev-tools.md, "Runner
// releases"). deploy-runner.sh runs it with the pinned Node. It uses only
// Node built-ins (rpc-client.mjs talks to the runner), so it works without
// the checkout's node_modules and against any runner version.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pointCurrent, readCurrentLink, readState, releaseExists, writeState } from '../launch.mjs';
import { connectRpc } from './rpc-client.mjs';
import { Fail, smokeTimedOut, step, unitTests } from './deploy-steps.mjs';
// THREADBARE_* was the old name for these variables (config.ts, adoptOldNames).
for (const [k, v] of Object.entries(process.env)) {
  const name = k.startsWith('THREADBARE_') ? 'THREADBEAR_' + k.slice(11) : undefined;
  if (name && process.env[name] === undefined) process.env[name] = v;
}

const HELP = `deploy-runner.sh: build a runner release from this checkout and switch the
live runner to it.

  1. typecheck and unit tests        5. point current at it
  2. snapshot runner/ at HEAD        6. restart the runner
  3. smoke test the snapshot         7. check it came up on the new release,
  4. deploy the Convex backend and      or go back to the previous one
     website at HEAD, if they       8. keep the newest 5 plus the last good one
     changed (deploy-backend.mjs)

Options:
  --skip-checks     skip step 1
  --skip-backend    skip step 4 (the runner may then be newer than its backend)
  --allow-dirty     build from uncommitted files (the id ends in -dirty)
  --allow-branch    build from a HEAD that isn't main's tip (unmerged work,
                    or a checkout behind main); the next deploy from main
                    drops it again
  --now             restart straight away, stopping turns in progress
                    (refused inside a thread unless --force, and refused
                    while other threads are busy unless run from a
                    terminal with --force)
  --force           do it anyway: --now (see above), --rollback to a
                    release that crashed at startup, or replacing a release
                    that is still waiting for its restart
  --wait 30m        how long to wait for running threads before giving up
                    (s, m or h); background shells and subagents hold the
                    restart this long at most
  --resume "text"   sent to this thread as a new turn after the restart
                    (inside a thread, where there's a default)
  --rollback        go back to the previous release instead of building one
  --list            show the releases and which one is running
  --home DIR        data dir (default $THREADBEAR_HOME, else
                    ~/Library/Application Support/Threadbear)
  --label LABEL     launchd label (default com.mikerosoft.threadbear.runner)
  --dry-run         say what would happen and change nothing

For install-runner.sh:
  --no-restart      stop after step 4
  --follow DIR      the checkout the release follows main from (default
                    this one); the runner's updater builds from its own
                    clone and passes the checkout it was following
  --check           only step 6, for the release current points at, then
                    wait until it has been marked good
  --check-idle      exit 1 if a thread is busy (or the runner won't say)
  --check-branch    exit 1 if HEAD isn't main's tip
`;

const DEFAULT_LABEL = 'com.mikerosoft.threadbear.runner';
const DEFAULT_HOME = path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear');
// On Linux the data dir keeps its macOS name, so every path in the docs and
// scripts is the same; systemd takes launchd's place (install-runner.sh).
const LINUX = process.platform === 'linux';
// What a release holds from runner/, besides node_modules and release.json.
const RELEASE_PATHS = ['src', 'bin', 'package.json', 'package-lock.json'];
const KEEP_RELEASES = 5;
const HEALTH_MS = 30_000;
// How long a release that came up has to stay up before the deploy says so
// (less once it's marked good). One that died 8 s after it started
// listening used to pass the health check, and launch.mjs rolled it back
// after the deploy had reported success. THREADBEAR_DEPLOY_SETTLE_MS
// shortens it for tests.
const SETTLE_MS = 20_000;
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]+(-dirty)?$/;
const BUSY = new Set(['starting', 'running', 'waiting']);
// A runner that answers slower than the first try's 3 s is busy, not down:
// one more try with this long before giving up.
const SLOW_RPC_MS = 15_000;

const say = (msg) => console.log(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run on exit, including Ctrl-C: stop a smoke-test runner, drop the lock
// and any half-built release.
const cleanups = [];
process.on('exit', () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function sameDir(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) throw new Fail(`Can't read the time "${s}"; use something like 90s, 30m or 2h.`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
}

function fmtDuration(ms) {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

// For commands printed to paste into a shell; the default data dir has a space.
function shq(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// "1 thread finishes", "2 threads finish".
function finish(n) {
  return n === 1 ? '1 thread finishes' : `${n} threads finish`;
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return `(no log at ${file})`;
  }
}

// The pinned Node first on PATH (npm's shebang finds it there), and no
// THREADBEAR_* variables: inside a thread they name the live runner, and
// tests or a smoke-test runner must never pick that up.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('THREADBEAR_')) env[k] = v;
  env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`;
  return { ...env, ...extra };
}

function setup(v) {
  const home = path.resolve(expandHome(v.home ?? process.env.THREADBEAR_HOME ?? process.env.THREADBEAR_DATA_DIR ?? DEFAULT_HOME));
  const isDefaultHome = sameDir(home, DEFAULT_HOME);
  // The same rule as install-runner.sh: the default label goes with the
  // default data dir and nothing else, or restarting a sandbox would
  // restart the real runner.
  if (v.label === DEFAULT_LABEL && !isDefaultHome) {
    throw new Fail(`${DEFAULT_LABEL} is the real runner's label, and ${home} isn't its data dir. A sandbox has a label of its own (say ${DEFAULT_LABEL}.devtest).`);
  }
  if (v.label !== undefined && v.label !== DEFAULT_LABEL && isDefaultHome) {
    throw new Fail(`${home} belongs to ${DEFAULT_LABEL}; leave --label out, or give a sandbox its own --home.`);
  }
  const label = v.label ?? DEFAULT_LABEL;
  // Which thread to carry on afterwards: only one of the runner being
  // deployed to. The runner names its own data dir in
  // THREADBEAR_RUNNER_HOME, which, unlike THREADBEAR_HOME, nothing tells an
  // agent to change.
  const env = process.env;
  const threadHome = env.THREADBEAR_RUNNER_HOME || env.THREADBEAR_HOME || env.THREADBEAR_DATA_DIR || DEFAULT_HOME;
  const threadId = env.THREADBEAR_THREAD_ID && sameDir(threadHome, home) ? env.THREADBEAR_THREAD_ID : null;
  // Whether stopping that runner would stop this script: true in one of its
  // threads, and also under a runner too old to say which thread (or with
  // the variables overridden), which only the process tree shows.
  const underRunner = runnerIsAncestor(home);
  return {
    home,
    isDefaultHome,
    dir: path.join(home, 'runner'),
    releases: path.join(home, 'runner', 'releases'),
    label,
    // Kickstarting the default label for some other data dir would restart
    // the real runner, so a sandbox has to name its own.
    labelKnown: v.label !== undefined || isDefaultHome,
    follow: v.follow ? path.resolve(expandHome(v.follow)) : undefined,
    target: `gui/${process.getuid()}/${label}`,
    // A runner on Linux is a systemd user service of the same name
    // (install-runner.sh), and its unit file stands in for the plist.
    linux: LINUX,
    unit: `${label}.service`,
    plist: LINUX
      ? path.join(env.THREADBEAR_SYSTEMD_UNITS_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'), `${label}.service`)
      : path.join(env.THREADBEAR_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents'), `${label}.plist`),
    log: isDefaultHome ? path.join(os.homedir(), 'Library', 'Logs', 'threadbear-runner.log') : path.join(home, 'runner.log'),
    threadId,
    inThread: Boolean(threadId) || underRunner,
    launchctl: env.THREADBEAR_LAUNCHCTL || 'launchctl',
    systemctl: env.THREADBEAR_SYSTEMCTL || 'systemctl',
    npm: path.join(path.dirname(process.execPath), 'npm'),
    runnerDir: path.resolve(import.meta.dirname, '..'),
  };
}

// True if the runner that owns `home` (run/runner.pid) is an ancestor of
// this process: a CLI it started ran this, directly or through a shell, a
// dev runner or anything else, and its restart would stop it.
function runnerIsAncestor(home) {
  let pid;
  try {
    const raw = fs.readFileSync(path.join(home, 'run', 'runner.pid'), 'utf8').trim();
    pid = /^\d+$/.test(raw) ? Number(raw) : JSON.parse(raw).pid;
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  const parent = new Map();
  for (const line of r.stdout.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) parent.set(p, pp);
  }
  for (let p = process.ppid, n = 0; p > 1 && n < 200; p = parent.get(p) ?? 0, n++) {
    if (p === pid) return true;
  }
  return false;
}

// What the LaunchAgent runs: 'releases' (launch.mjs in this data dir),
// 'checkout' (src/main.ts, as before releases or with --from-source), or
// 'missing'. A sandbox with no --label has no plist to read; launch.mjs in
// its data dir is the best sign then.
function installedAs(c) {
  if (!c.labelKnown) return fs.existsSync(path.join(c.dir, 'launch.mjs')) ? 'releases' : 'missing';
  if (!fs.existsSync(c.plist)) return 'missing';
  let args = [];
  if (c.linux) {
    args = unitExecStart(fs.readFileSync(c.plist, 'utf8'));
  } else {
    const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', c.plist], { encoding: 'utf8' });
    try {
      args = JSON.parse(r.stdout).ProgramArguments ?? [];
    } catch {
      // unreadable: treated as not running releases
    }
  }
  const launch = path.join(c.dir, 'launch.mjs');
  return args.some((a) => typeof a === 'string' && sameDir(a, launch)) && fs.existsSync(launch) ? 'releases' : 'checkout';
}

// Refuses a deploy or rollback the LaunchAgent wouldn't pick up. For the
// real runner the switch to releases is Mike's to make, from a terminal:
// install-runner.sh stops the runner, and with it any thread running it.
function requireReleases(c) {
  const how = installedAs(c);
  if (how === 'releases') return;
  const what = how === 'missing' ? `isn't installed as a LaunchAgent (${c.label})` : `runs from a checkout (${c.plist} doesn't start ${path.join(c.dir, 'launch.mjs')})`;
  if (c.isDefaultHome || c.inThread) {
    throw new Fail(
      `The runner at ${c.home} ${what}, so a release would never start. the user has to switch it to releases once, from a terminal:\n  ${path.join(c.runnerDir, 'scripts', 'install-runner.sh')}\nDon't run that from a thread: it stops the runner the thread runs on. Until then, runner changes wait for him.`,
    );
  }
  // Without --label, the default would be the real runner's, which
  // install-runner.sh refuses for another data dir.
  const label = c.labelKnown ? c.label : `${DEFAULT_LABEL}.devtest`;
  throw new Fail(`The runner at ${c.home} ${what}. Install it with scripts/install-runner.sh --home ${c.home} --label ${label}, which builds the first release.`);
}

// ---------------------------------------------------------------- talking to the runner

// One authenticated connection to the runner at `home`, found the way tb
// finds it: the port in runner.json and the token in secrets/. Rejects with
// `down: true` when nothing is listening.
async function connect(home, timeoutMs = 3000) {
  const port = readJson(path.join(home, 'runner.json'))?.port;
  let token;
  try {
    token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
  } catch {
    throw Object.assign(new Error('no runner token'), { down: true });
  }
  if (!port) throw Object.assign(new Error('no port in runner.json'), { down: true });
  const conn = await connectRpc(port, token, timeoutMs);
  try {
    conn.hello = await conn.call('hello', { client: 'deploy-runner', version: '1' });
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
}

async function rpc(home, method, params, timeoutMs = 3000) {
  const c = await connect(home, timeoutMs);
  try {
    return await c.call(method, params);
  } finally {
    c.close();
  }
}

// A call that tells a runner that is down (nothing listening: safe to
// start through launchd) from one that is only slow (busy, or loading a big
// thread: launchctl kickstart -k would cut every turn short). A slow one
// gets a second, longer try.
async function rpcPatient(home, method, params) {
  try {
    return await rpc(home, method, params);
  } catch (e) {
    if (e.down || e.notProved || typeof e.code === 'number') throw e;
  }
  return rpc(home, method, params, SLOW_RPC_MS);
}

// What's running: { state: 'up', version, pid? }, 'down' (nothing
// listening), or 'unknown' (there but not answering in time).
async function probe(home) {
  let c;
  try {
    c = await connect(home);
  } catch (e) {
    return { state: e.down ? 'down' : 'unknown' };
  }
  let status;
  try {
    status = await c.call('runner.status', {});
  } catch {
    // older runners have no runner.status
  } finally {
    c.close();
  }
  return { state: 'up', version: String(c.hello?.runnerVersion ?? ''), pid: status?.pid, status };
}

const releaseOf = (version) => (version && version.includes('+') ? version.slice(version.indexOf('+') + 1) : null);

// Waits for the runner to come back on `id`. `before` is what answered
// before the restart was asked for (or null). The restart has to start
// within `startMs`; from then on the new runner has 30 s. Coming back on
// any other release (launch.mjs going back to lastGood, say) fails at once,
// and so does the same runner no longer having a restart pending (someone
// ran tb restart --cancel) when `pending` says one was asked for.
async function awaitRelease(home, id, before, startMs, pending = false) {
  const start = Date.now();
  let downAt = null;
  for (;;) {
    const p = await probe(home);
    const now = Date.now();
    if (p.state === 'up' && releaseOf(p.version) === id) return { result: 'ok', ...p };
    if (p.state === 'down') downAt ??= now;
    else if (p.state === 'up') {
      const restarted = !before ? true : p.pid && before.pid ? p.pid !== before.pid : downAt !== null || p.version !== before.version;
      if (restarted) return { result: 'other', ...p };
      if (pending && p.status && !p.status.pendingRestart) return { result: 'withdrawn', ...p };
    }
    if (downAt !== null && now - downAt > HEALTH_MS) return { result: 'timeout' };
    if (downAt === null && now - start > startMs) return { result: 'pending' };
    await sleep(500);
  }
}

// A systemd unit's ExecStart as its arguments, undoing install-runner.sh's
// quoting ("..." with \\ and \" escaped, % as %%). [] when there's none.
function unitExecStart(text) {
  const line = text.split('\n').find((l) => l.startsWith('ExecStart='));
  if (!line) return [];
  const args = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of line.slice('ExecStart='.length).matchAll(re)) {
    const raw = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
    args.push(raw.replace(/%%/g, '%'));
  }
  return args;
}

function jobLoaded(c) {
  if (c.linux) return spawnSync(c.systemctl, ['--user', 'is-active', '--quiet', c.unit], { stdio: 'ignore' }).status === 0;
  return spawnSync(c.launchctl, ['print', c.target], { stdio: 'ignore' }).status === 0;
}

// Asynchronous on purpose: kickstart -k returns once the old runner has
// exited, and the runner's shutdown waits for its clients, so this process
// has to keep its own connections moving meanwhile.
async function kickstart(c) {
  if (!c.labelKnown) {
    throw new Fail(`${c.home} isn't the default data dir, so pass --label with its launchd label to restart it.`);
  }
  // systemd's restart, like kickstart -k, returns once the old one is gone
  // and the new one started.
  const [cmd, args] = c.linux ? [c.systemctl, ['--user', 'restart', c.unit]] : [c.launchctl, ['kickstart', '-k', c.target]];
  const r = await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    child.on('error', (e) => resolve({ status: null, text: e.message }));
    child.on('close', (status) => resolve({ status, text }));
  });
  if (r.status !== 0) throw new Fail(`${restartCommand(c)} failed: ${r.text.trim()}`);
}

// The threads keeping the runner busy, as { id, title }, or [] when it's
// idle or down. A runner that answers but too slowly counts as busy: it
// can't be shown to be idle.
async function busyThreads(c) {
  let threads;
  try {
    threads = (await rpcPatient(c.home, 'threads.list', { include: ['inbox', 'snoozed', 'archived'] })).threads;
  } catch (e) {
    if (e.down) return []; // nothing answering, so nothing to interrupt
    return [{ id: '?', title: `the runner isn't answering (${e.message})` }];
  }
  const busy = threads.filter((t) => BUSY.has(t.status));
  // Runners with runner.status also say which threads have background
  // shells or subagents, which a restart would stop.
  try {
    const s = await rpc(c.home, 'runner.status', {});
    for (const b of s.background ?? []) {
      if (!busy.some((t) => t.id === b.threadId)) busy.push(threads.find((t) => t.id === b.threadId) ?? { id: b.threadId, title: '' });
    }
  } catch {
    // older runner
  }
  return busy;
}

// For runners without runner.restart: no thread starting, running or
// waiting on an approval. Returns [] when idle, else the busy threads.
async function waitUntilIdle(c, waitMs) {
  const end = Date.now() + waitMs;
  let shown = '';
  for (;;) {
    const busy = await busyThreads(c);
    if (busy.length === 0) return [];
    const names = busy.map((t) => `${t.id.slice(0, 8)} "${t.title}"`).join(', ');
    if (names !== shown) {
      say(`Waiting for ${plural(busy.length, 'thread')} to finish (up to ${fmtDuration(waitMs)}): ${names}`);
      shown = names;
    }
    if (Date.now() >= end) return busy;
    await sleep(Math.min(2000, Math.max(100, end - Date.now())));
  }
}

// ---------------------------------------------------------------- releases

function listReleases(c) {
  try {
    return fs
      .readdirSync(c.releases)
      .filter((n) => ID_RE.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function currentId(c) {
  return readCurrentLink(c.dir) ?? readState(c.dir).current;
}

// Swaps the link first (that's what launch.mjs starts), then records it.
// previous is the release to go back to: the one running, when that's
// known, rather than one current named that never started.
// activated tells launch.mjs to count crashes of this release from now on
// only, so a forced rollback onto one that crashed earlier gets fresh tries.
function activate(c, id, previous) {
  const state = readState(c.dir);
  const was = currentId(c);
  pointCurrent(c.dir, id);
  saveState(c, { ...state, current: id, previous: previous ?? was ?? state.previous, activated: { release: id, at: new Date().toISOString() } }, id);
  say(`current now points at ${id}${was ? ` (was ${was})` : ''}.`);
}

// failed: a release that came up and then died, which --list then marks
// as crashed, --rollback won't go back to and pruning drops first. (One
// that crash-looped is already in rolledBack.)
function restore(c, before, failed) {
  pointCurrent(c.dir, before.current);
  const state = readState(c.dir);
  const crashed = Array.isArray(state.crashed) ? state.crashed : [];
  saveState(c, { ...state, current: before.current, previous: before.previous, ...(failed ? { crashed: [...crashed, failed] } : {}) });
}

// The releases that crashed at startup since they were last activated.
// launch.mjs records only the latest crash rollback (rolledBack), and the
// next one overwrites it: release A crashes, a deploy of B crashes too and
// its health check puts previous back to A, and then nothing said A was
// bad. So every state write here keeps them in `crashed`. One marked good
// since, or activated again on purpose (--rollback --force), drops out.
function crashedReleases(state) {
  const ids = new Set(Array.isArray(state.crashed) ? state.crashed.filter((x) => typeof x === 'string' && x) : []);
  const rb = state.rolledBack;
  const again = rb && state.activated?.release === rb.from && Date.parse(state.activated.at) > Date.parse(rb.at);
  if (rb?.from && !again) ids.add(rb.from);
  if (state.lastGood) ids.delete(state.lastGood);
  return ids;
}

// writeState, keeping `crashed` up to date. activated: a release activated
// just now, which gets fresh tries.
function saveState(c, state, activated) {
  const crashed = crashedReleases(state);
  if (activated) crashed.delete(activated);
  writeState(c.dir, { ...state, crashed: [...crashed].slice(-20) });
}

// The releases that runners still finishing turns after a handover run on
// (docs/protocol.md, "Handovers"), from their run/drain-<pid>.json files. On
// a busy day one can outlast five newer releases; deleting its release from
// under it took tb away from its threads (29 Oct), and anything it hadn't
// loaded yet would have gone the same way.
function drainingReleases(c) {
  const dir = path.join(c.home, 'run');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return names
    .filter((name) => /^drain-\d+\.json$/.test(name))
    .map((name) => readJson(path.join(dir, name)))
    .filter((info) => typeof info?.release === 'string' && alive(info.pid))
    .map((info) => info.release);
}

function pruneList(c, extraKeep = []) {
  const state = readState(c.dir);
  const ids = listReleases(c);
  // The newest 5 plus lastGood, as specced, and never anything current,
  // previous or still running points at, whatever its age (extraKeep has
  // the running runners' releases). Releases that
  // crashed at startup go first and don't count towards the 5: a run of
  // broken deploys used to push out the good releases there were to go
  // back to. The newest of them stays, for --rollback --force.
  const crashed = crashedReleases(state);
  const good = ids.filter((id) => !crashed.has(id));
  const newestCrashed = ids.find((id) => crashed.has(id));
  const keep = new Set([...good.slice(0, KEEP_RELEASES), newestCrashed, state.lastGood, state.current, state.previous, currentId(c), ...extraKeep]);
  return ids.filter((id) => !keep.has(id));
}

function prune(c, extraKeep) {
  const gone = pruneList(c, extraKeep);
  for (const id of gone) fs.rmSync(path.join(c.releases, id), { recursive: true, force: true });
  // Builds a killed deploy left behind; this one holds the lock, so no
  // other deploy is building.
  for (const name of fs.existsSync(c.releases) ? fs.readdirSync(c.releases) : []) {
    if (name.startsWith('.building-')) fs.rmSync(path.join(c.releases, name), { recursive: true, force: true });
  }
  if (gone.length) say(`Removed ${plural(gone.length, 'old release')}: ${gone.join(', ')}`);
}

// A directory made with mkdir, which fails if it exists, so two deploys
// (two threads, say) never build or swap at once.
function lock(c) {
  fs.mkdirSync(c.dir, { recursive: true });
  const dir = path.join(c.dir, 'deploy.lock');
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const pid = Number(readJson(path.join(dir, 'pid')) ?? 0);
    if (alive(pid)) throw new Fail(`Another deploy (pid ${pid}) is working on ${c.dir}. Wait for it to finish.`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  throw new Fail(`Couldn't take the deploy lock in ${c.dir}.`);
}

// Whether a process is running; another user's counts.
function alive(pid) {
  try {
    return pid > 0 && (process.kill(pid, 0), true);
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: opts.encoding ?? 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Fail(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return opts.encoding === 'buffer' ? r.stdout : r.stdout.trim();
}

function gitInfo(c) {
  const root = git(c.runnerDir, ['rev-parse', '--show-toplevel']);
  // Only files that end up in the release count as uncommitted changes:
  // tests, scripts and docs don't change what runs (and a worktree's
  // node_modules symlink shows up as untracked).
  const changes = git(c.runnerDir, ['status', '--porcelain', '--untracked-files=all', '--', ...RELEASE_PATHS]);
  const main = spawnSync('git', ['-C', c.runnerDir, 'rev-parse', '--verify', '-q', 'refs/heads/main'], { encoding: 'utf8' });
  return {
    root,
    prefix: git(c.runnerDir, ['rev-parse', '--show-prefix']),
    commit: git(c.runnerDir, ['rev-parse', 'HEAD']),
    short: git(c.runnerDir, ['rev-parse', '--short', 'HEAD']),
    branch: git(c.runnerDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    main: main.status === 0 ? main.stdout.trim() : null,
    changes: changes ? changes.split('\n') : [],
  };
}

// The live runner should run main. A release from a feature branch ships
// work that isn't merged (and the next deploy from main silently drops it);
// one from a checkout behind main takes merged work back out.
function branchProblem(c, g) {
  if (g.main === g.commit) return null;
  const where = `HEAD (${g.short}, ${g.branch === 'HEAD' ? 'no branch' : `branch ${g.branch}`})`;
  if (!g.main) return `${where} can't be compared with main: there's no main branch in this checkout.`;
  const ancestor = (a, b) => spawnSync('git', ['-C', c.runnerDir, 'merge-base', '--is-ancestor', a, b]).status === 0;
  if (ancestor(g.commit, g.main)) return `${where} is behind main, so this release would take out work that's already merged.`;
  if (ancestor(g.main, g.commit)) return `${where} has commits that aren't on main; the next deploy from main would drop them again.`;
  return `${where} and main have each moved on; this release would ship unmerged work and leave out some of main.`;
}

// The object hashes of what a release holds, at HEAD, joined. The runner's
// src/update.ts computes the same for main, so a commit that only touches
// tests, scripts or docs isn't an update.
function releaseTree(g) {
  const r = spawnSync('git', ['-C', g.root, 'ls-tree', 'HEAD', '--', ...RELEASE_PATHS.map((p) => g.prefix + p)], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  const hashes = r.stdout.split('\n').filter(Boolean).map((line) => line.split(/\s+/)[2]);
  return hashes.length ? hashes.join('+') : undefined;
}

function newReleaseId(c, short, dirty) {
  for (;;) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const id = `${stamp}-${short}${dirty ? '-dirty' : ''}`;
    if (!fs.existsSync(path.join(c.releases, id))) return id;
    // Two builds in one second: wait for the next.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 - (Date.now() % 1000) + 5);
  }
}

// step() and unitTests() are in deploy-steps.mjs, where unit tests reach them.

// Step 4: the backend before the runner, so a runner is never newer than the
// backend it writes to. deploy-backend.mjs does nothing when convex/ and web/
// haven't changed, or when this data dir has no deploy key (a sandbox).
function deployBackend(c, g, v) {
  if (v['skip-backend']) {
    say('Skipping the backend (--skip-backend).');
    return;
  }
  const r = spawnSync(process.execPath, [path.join(c.runnerDir, 'scripts', 'deploy-backend.mjs'), '--home', c.home, '--repo', g.root, '--commit', g.commit], { stdio: 'inherit', env: cleanEnv() });
  if (r.status !== 0) throw new Fail('The backend deploy failed, so the runner stays on its current release. Fix it and deploy again, or pass --skip-backend.');
}

function checks(c) {
  const opts = { cwd: c.runnerDir, env: cleanEnv() };
  if (!fs.existsSync(path.join(c.runnerDir, 'node_modules'))) step('Installing the checkout\'s packages', c.npm, ['ci', '--no-audit', '--no-fund'], opts);
  step('Typecheck', c.npm, ['run', 'typecheck'], opts);
  unitTests(c, opts);
}

function snapshotHead(c, g, dest) {
  const wanted = RELEASE_PATHS.map((p) => g.prefix + p);
  // Only paths HEAD has, or git archive refuses the whole lot.
  const present = git(g.root, ['ls-tree', '--name-only', 'HEAD', '--', ...wanted]).split('\n').filter(Boolean);
  const tar = path.join(dest, '.snapshot.tar');
  git(g.root, ['archive', '--format=tar', `--output=${tar}`, 'HEAD', '--', ...present]);
  const strip = g.prefix.split('/').filter(Boolean).length;
  const r = spawnSync('tar', ['-xf', tar, '-C', dest, '--strip-components', String(strip)], { encoding: 'utf8' });
  fs.rmSync(tar, { force: true });
  if (r.status !== 0) throw new Fail(`Couldn't unpack the snapshot: ${r.stderr.trim()}`);
}

// --allow-dirty: the files as they are, tracked or new (ignored ones and
// node_modules stay out), with deletions honoured.
function snapshotWorkingTree(c, dest) {
  const files = git(c.runnerDir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...RELEASE_PATHS], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (const f of new Set(files)) {
    const from = path.join(c.runnerDir, f);
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      continue; // deleted, not yet committed
    }
    if (st.isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.cpSync(from, path.join(dest, f), { verbatimSymlinks: true, preserveTimestamps: true });
  }
}

// Production packages. A release with the same package-lock.json and Node
// already has them, so they're cloned from it instead (APFS copy-on-write:
// seconds, and next to no disk); otherwise npm ci.
function installPackages(c, dest) {
  const lock = fs.readFileSync(path.join(dest, 'package-lock.json'));
  const state = readState(c.dir);
  const donors = [...new Set([state.current, state.lastGood, ...listReleases(c)])].filter(Boolean);
  for (const id of donors) {
    const dir = path.join(c.releases, id);
    try {
      if (readJson(path.join(dir, 'release.json'))?.node !== process.versions.node) continue;
      if (!fs.existsSync(path.join(dir, 'node_modules')) || !lock.equals(fs.readFileSync(path.join(dir, 'package-lock.json')))) continue;
    } catch {
      continue;
    }
    if (spawnSync('cp', ['-cR', path.join(dir, 'node_modules'), path.join(dest, 'node_modules')], { stdio: 'ignore' }).status === 0) {
      say(`Packages: cloned from ${id} (same package-lock.json).`);
      return;
    }
    fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true });
  }
  step('Installing packages (npm ci --omit=dev)', c.npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: dest,
    env: cleanEnv(),
  });
}

function build(c, id, g, dirty) {
  fs.mkdirSync(c.releases, { recursive: true });
  // Built under a hidden name and renamed when whole, so a release dir
  // never exists half-made.
  const tmp = path.join(c.releases, `.building-${id}`);
  const drop = () => fs.rmSync(tmp, { recursive: true, force: true });
  drop();
  fs.mkdirSync(tmp);
  cleanups.push(drop);
  say(`Building ${id} from ${dirty ? 'the working tree (uncommitted changes)' : `${g.short} (HEAD)`}...`);
  if (dirty) snapshotWorkingTree(c, tmp);
  else snapshotHead(c, g, tmp);
  if (!fs.existsSync(path.join(tmp, 'src', 'main.ts'))) throw new Fail(`The snapshot has no src/main.ts; is ${c.runnerDir} the runner?`);
  installPackages(c, tmp);
  // checkout, prefix and tree are for the runner following main by itself
  // (src/update.ts); a dirty build has no tree, since its files aren't HEAD's.
  const tree = dirty ? undefined : releaseTree(g);
  fs.writeFileSync(
    path.join(tmp, 'release.json'),
    JSON.stringify(
      { id, commit: g.commit, branch: g.branch, dirty, builtAt: new Date().toISOString(), node: process.versions.node, checkout: c.follow ?? g.root, prefix: g.prefix, ...(tree ? { tree } : {}) },
      null,
      2,
    ) + '\n',
  );
  fs.renameSync(tmp, path.join(c.releases, id));
}

// Starts the release on a temp data dir and port 0, says hello, checks the
// version names the release, and stops it. Logins and the claude binary
// point nowhere: nothing outside the temp dir is read or written.
async function smoke(c, id) {
  process.stdout.write('Smoke test... ');
  const root = path.join(c.releases, id);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-smoke-'));
  const home = path.join(tmp, 'home');
  const out = path.join(tmp, 'output.log');
  const fd = fs.openSync(out, 'a');
  const child = spawn(process.execPath, [path.join(root, 'src', 'main.ts')], {
    cwd: root,
    detached: true, // its own process group, so it can be stopped whole
    stdio: ['ignore', fd, fd],
    env: cleanEnv({
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(tmp, 'runner.log'),
      THREADBEAR_CLAUDE_PATH: path.join(tmp, 'no-claude'),
      THREADBEAR_ACCOUNTS_DIR: path.join(tmp, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: path.join(tmp, 'no-main'),
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(tmp, 'no-main.json'),
      // Nor the real ~/.codex (its model probe would start a codex) or
      // Token Stats' limits.json, and never a CLI install.
      THREADBEAR_CODEX_MAIN_DIR: path.join(tmp, 'no-codex-main'),
      THREADBEAR_TOKEN_STATS_LIMITS: path.join(tmp, 'no-limits.json'),
      THREADBEAR_CLI_UPDATES: 'off',
    }),
  });
  fs.closeSync(fd);
  let exited = null;
  const gone = new Promise((r) => child.once('exit', (code, signal) => r((exited = { code, signal }))));
  const kill = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  const killNow = () => kill('SIGKILL');
  cleanups.push(killNow);
  const started = Date.now();
  let problem = null;
  try {
    let port = null;
    while (!port) {
      if (exited) throw new Error(`it exited (${exited.code ?? exited.signal}) before listening`);
      // Long enough for a busy Mac: at 30 s, load kept every release from
      // going out for hours, and longer still while it's overloaded.
      const waited = Date.now() - started;
      if (smokeTimedOut(waited, os.loadavg()[0] / os.cpus().length)) throw new Error(`it was not listening after ${Math.round(waited / 1000)} s`);
      port = /listening on (\d+)/.exec(fs.readFileSync(out, 'utf8'))?.[1];
      if (!port) await sleep(100);
    }
    const p = await probe(home);
    if (p.state !== 'up') throw new Error(`hello on port ${port} got no answer`);
    if (releaseOf(p.version) !== id) throw new Error(`it says it is ${p.version || 'no version'}, not ${id}`);
  } catch (e) {
    problem = e.message;
  }
  kill('SIGTERM');
  const timer = setTimeout(killNow, 10_000);
  await gone;
  clearTimeout(timer);
  cleanups.splice(cleanups.indexOf(killNow), 1);
  if (problem) {
    say('failed');
    console.error(`Output:\n${tail(out)}\nRunner log:\n${tail(path.join(tmp, 'runner.log'))}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Fail(`The smoke test failed: ${problem}. current is unchanged.`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  say(`ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

// ---------------------------------------------------------------- restart and health

function restartCommand(c) {
  return c.linux ? `systemctl --user restart ${c.unit}` : `launchctl kickstart -k ${c.target}`;
}

// The tb that goes with this checkout, written out in full in what the
// script prints: a bare `tb` isn't on PATH in every shell. For a sandbox it
// carries the data dir: a bare tb follows THREADBEAR_HOME, which in a
// thread names the live runner, and `restart --cancel` there would withdraw
// someone else's deploy.
function tbCommand(c) {
  const tb = shq(path.join(c.runnerDir, 'bin', 'tb'));
  return c.isDefaultHome ? tb : `THREADBEAR_HOME=${shq(c.home)} ${tb}`;
}

// --now stops every turn and background job on the runner. Cutting other
// threads' work short is never an agent's call: from a thread it's refused
// even with --force (Mike can run it from a terminal); from a terminal,
// --force does it.
async function refuseNowWhileBusy(c, v) {
  const others = (await busyThreads(c)).filter((t) => t.id !== c.threadId);
  if (!others.length || (v.force && !c.inThread)) return;
  const names = others.map((t) => `  ${t.id.slice(0, 8)}  ${t.title}`).join('\n');
  const mine = c.inThread ? ' If it really can\'t wait, finish your turn and ask the user to run this from a terminal with --now --force.' : '';
  const other = c.threadId ? 'other ' : '';
  const whose = others.length === 1 ? `1 ${other}thread's` : `${others.length} ${other}threads'`;
  throw new Fail(`--now would cut short ${whose} work (turns, background shells, subagents):\n${names}\nLeave --now out: the runner then restarts once they finish.${mine}`);
}

// What the thread is sent after the restart, unless --resume says otherwise.
function defaultResume(v, id, from) {
  return v.rollback
    ? `The runner went back to release ${id}${from ? `; the change in ${from} is no longer live` : ''}. Check the runner is healthy, then carry on.`
    : `The runner restarted on release ${id}. Check that your change works, then carry on.`;
}

// Restarts the live runner onto `id` and checks it came up there. `before`
// is { current, previous } to go back to if it doesn't.
async function restartAndCheck(c, v, id, before, waitMs) {
  const baseline = await probe(c.home);
  const running = baseline.state === 'up' ? baseline : null;
  let startMs = HEALTH_MS;
  let waited = false; // the restart waits for threads, up to waitMs
  // Background work (a dev server, a watcher) may never finish, so it holds
  // the restart for --wait at most. Turns always hold it.
  const params = {
    when: v.now ? 'now' : 'idle',
    release: id,
    reason: v.rollback ? `Rolling back to release ${id}` : `Deploying release ${id}`,
    backgroundWaitMs: waitMs,
  };
  if (c.threadId) params.resume = { threadId: c.threadId, text: v.resume ?? defaultResume(v, id, before.current) };
  if (v.now && c.inThread) {
    // Said first: the restart stops this script along with the turn.
    say(`Restarting now. This turn ends here${params.resume ? `, and the runner then carries this thread on with:\n  "${params.resume.text}"` : '.'}`);
  }
  let res = null;
  let err = null;
  try {
    res = await rpcPatient(c.home, 'runner.restart', params);
  } catch (e) {
    err = e;
  }
  if (err && err.code === -32601) {
    // A runner from before runner.restart: it can't wait for its own
    // threads, so this does, then kickstarts it.
    if (c.inThread) {
      say(`Release ${id} is current, but the live runner is too old to restart itself without ending this turn.`);
      say(`It starts ${id} on its next restart. When no thread is running, the user can run:\n  ${restartCommand(c)}`);
      return 0;
    }
    if (v.now) say(`Restarting now: ${restartCommand(c)}`);
    else {
      const busy = await waitUntilIdle(c, waitMs);
      if (busy.length) {
        throw new Fail(
          `Threads were still running after ${fmtDuration(waitMs)}, so the runner wasn't restarted. Release ${id} is current and starts on the next restart:\n  ${restartCommand(c)}`,
        );
      }
      say(`No thread is running. Restarting: ${restartCommand(c)}`);
    }
    await kickstart(c);
  } else if (err && typeof err.code === 'number') {
    throw new Fail(`runner.restart failed: ${err.message}. Release ${id} is current and starts on the runner's next restart.`);
  } else if (err && !err.down) {
    // Listening but not answering in time: busy, not down. A kickstart
    // would stop every turn, so that's left to whoever can see why.
    throw new Fail(
      `The runner is listening but didn't answer runner.restart (${err.message}). Release ${id} is current and starts on its next restart. If it's stuck, ${c.inThread ? 'the user can run' : 'run'}:\n  ${restartCommand(c)}`,
    );
  } else if (err) {
    // Nothing listening: down, or not started.
    if (c.inThread) {
      say(`Release ${id} is current, but the runner isn't answering (${err.message}). the user can restart it with:\n  ${restartCommand(c)}`);
      return 0;
    }
    if (!c.labelKnown || !jobLoaded(c)) {
      throw new Fail(`The runner isn't answering and ${c.label} isn't loaded, so there's nothing to restart. Release ${id} is current; start it with scripts/install-runner.sh.`);
    }
    say(`The runner isn't running (${err.message}). Starting it: ${restartCommand(c)}`);
    await kickstart(c);
  } else {
    const waiting = Array.isArray(res?.waitingFor) ? res.waitingFor : [];
    const background = Array.isArray(res?.background) ? res.background : [];
    // A handover (docs/protocol.md): the new release takes over now, and
    // the busy threads finish their turns on the old runner first.
    const keeps = Array.isArray(res?.handover?.keeps) ? res.handover.keeps : null;
    if (keeps && c.inThread) {
      const mine = Boolean(c.threadId && keeps.includes(c.threadId));
      const others = keeps.filter((t) => t !== c.threadId).length;
      const noResume = params.resume && typeof res?.noResume === 'string' ? res.noResume : null;
      const lines = [`Release ${id} is current, and a new runner on it is taking over now.`];
      if (mine) {
        const then = !params.resume ? '.' : noResume ? `, but it won't carry on by itself there: ${noResume}.` : `, where it carries on with:\n  "${params.resume.text}"`;
        lines.push(`This thread finishes this turn on the old runner${others ? ` (as ${plural(others, 'other busy thread')} ${others === 1 ? 'does' : 'do'})` : ''}, then moves across${then}`);
        lines.push(
          `${tbCommand(c)} status shows the old runner and what it's finishing.`,
          noResume
            ? 'End your turn now (that is what moves this thread across), and say in your reply that the user has to message this thread to check the change.'
            : 'End your turn now; that is what moves this thread across.',
        );
      } else {
        lines.push(`${plural(keeps.length, 'busy thread')} ${keeps.length === 1 ? 'finishes its turn' : 'finish their turns'} on the old runner first, then ${keeps.length === 1 ? 'moves' : 'move'} across.`);
      }
      say(lines.join('\n'));
      return 0;
    }
    if (keeps) say(`A new runner on ${id} is taking over now; ${plural(keeps.length, 'busy thread')} ${keeps.length === 1 ? 'finishes' : 'finish'} on the old one first.`);
    if (c.inThread) {
      if (!waiting.length) {
        say(`Release ${id} is current and the runner is restarting now, which ends this turn.`);
        return 0;
      }
      const mine = c.threadId && waiting.includes(c.threadId);
      const others = waiting.filter((t) => t !== c.threadId).length;
      const when = mine ? (others ? `this turn ends and ${finish(others).replace('thread', 'other thread')}` : 'this turn ends') : finish(waiting.length);
      // The runner says when it won't send the resume (3 this hour), so the
      // agent doesn't end its turn waiting for a message that never comes.
      const noResume = params.resume && typeof res?.noResume === 'string' ? res.noResume : null;
      const then = !params.resume ? '.' : noResume ? `, but it won't carry this thread on afterwards: ${noResume}.` : `, then resumes this thread with:\n  "${params.resume.text}"`;
      const lines = [`Release ${id} is current. The runner restarts when ${when}${then}`];
      // Ending the turn doesn't stop these, and the restart waits for them.
      const own = background.find((b) => b.threadId === c.threadId);
      if (own?.tasks?.length) {
        lines.push(
          `It also waits for this thread's background work, which ending the turn doesn't stop:\n${own.tasks.map((t) => `  ${t}`).join('\n')}\n` +
            `Stop it before you end your turn (a dev runner stops with the kill <pid> it printed). Otherwise the restart goes ahead after ${fmtDuration(waitMs)} and stops it.`,
        );
      } else if (others) {
        lines.push('It also waits for the other threads\' turns, background shells and subagents.');
      }
      lines.push(
        `${tbCommand(c)} status shows what it's waiting for.`,
        noResume
          ? 'End your turn now, and say in your reply that the user has to message this thread once the runner is back, to check the change.'
          : "End your turn now; there's nothing more to do here until then.",
      );
      say(lines.join('\n'));
      return 0;
    }
    if (waiting.length) {
      say(
        `The runner restarts when ${finish(waiting.length)} (turns, or background shells and subagents for up to ${fmtDuration(waitMs)}): ${waiting.join(', ')}. Waiting up to ${fmtDuration(waitMs)}...`,
      );
      // Background work stops holding it at waitMs, and the runner starts
      // its restart then if no turn holds it, so a little longer to see it.
      startMs = waitMs + 5000;
      waited = true;
    } else if (!keeps) {
      say('The runner is restarting.');
    }
  }

  const r = await awaitRelease(c.home, id, running, startMs, Boolean(res));
  if (r.result === 'ok') {
    const s = await settle(c, id, r.pid);
    if (s.result !== 'ok') return wentWrong(c, id, before, s, waitMs);
    say(`The runner is up on ${id}${r.pid ? ` (pid ${r.pid})` : ''}.`);
    return 0;
  }
  if (r.result === 'withdrawn') {
    const now = currentId(c);
    console.error(
      now !== id
        ? `The restart was withdrawn (tb restart --cancel), and current points at ${now} again, so ${id} won't start.`
        : `The restart was withdrawn (tb restart --cancel), but ${id} is still current and starts on the runner's next restart. deploy-runner.sh --rollback goes back to ${before.current}.`,
    );
    return 1;
  }
  if (r.result === 'pending') {
    if (waited) {
      say(
        `The threads are still busy after ${fmtDuration(waitMs)}. The restart stays queued: the runner starts ${id} when they finish. ` +
          `To withdraw it and put current back on ${before.current}:\n  ${tbCommand(c)} restart --cancel`,
      );
      return 0;
    }
    throw new Fail(`The runner hasn't restarted after ${HEALTH_MS / 1000} s. Release ${id} is current and starts on its next restart:\n  ${restartCommand(c)}`);
  }
  return wentWrong(c, id, before, r, waitMs);
}

// Watches a release that has just come up until it's marked good or has
// stayed up SETTLE_MS: 'ok', or 'stopped' (down, or a new pid or release)
// with how long it lasted. A runner that's there but slow to answer is busy,
// not gone.
async function settle(c, id, pid) {
  const env = Number(process.env.THREADBEAR_DEPLOY_SETTLE_MS);
  const ms = Number.isFinite(env) && env >= 0 ? env : SETTLE_MS;
  const start = Date.now();
  process.stdout.write('Checking it stays up... ');
  while (Date.now() - start < ms && readState(c.dir).lastGood !== id) {
    await sleep(Math.min(500, ms));
    const p = await probe(c.home);
    if (p.state === 'unknown') continue;
    if (p.state === 'down' || releaseOf(p.version) !== id || (pid && p.pid && p.pid !== pid)) {
      say('no');
      return { result: 'stopped', after: Date.now() - start, ...p };
    }
  }
  say('ok');
  return { result: 'ok' };
}

// Health check failed: go back to the release that was running before and
// show the end of the runner's log.
async function wentWrong(c, id, before, r, waitMs) {
  console.error(
    r.result === 'other'
      ? `The runner came back on ${releaseOf(r.version) ?? r.version} instead of ${id}.`
      : r.result === 'stopped'
        ? `The runner came up on ${id} but stopped again within ${Math.max(1, Math.round(r.after / 1000))} s.`
        : `The runner didn't come back on ${id} within ${HEALTH_MS / 1000} s of the restart.`,
  );
  const rolledBack = readState(c.dir).rolledBack;
  if (rolledBack?.from === id) console.error(`launch.mjs went back to ${rolledBack.to} after ${id} kept crashing at startup.`);
  if (before.current && before.current !== id && releaseExists(c.dir, before.current)) {
    restore(c, before, r.result === 'stopped' ? id : undefined);
    console.error(`current points at ${before.current} again.`);
    const now = await probe(c.home);
    if (now.state === 'up' && releaseOf(now.version) === before.current) {
      console.error(`The runner is already running ${before.current}.`);
    } else if (c.inThread) {
      console.error(`It starts on the runner's next restart. The user can run:\n  ${restartCommand(c)}`);
    } else if (now.state === 'up') {
      // Up on yet another release (a crash rollback to an older lastGood,
      // say). Turns may have started on it since, so it restarts once
      // they've finished rather than at once.
      await backTo(c, before.current, waitMs);
    } else if (c.labelKnown) {
      console.error(`Restarting: ${restartCommand(c)}`);
      try {
        await kickstart(c);
      } catch (e) {
        console.error(e.message);
      }
    } else {
      console.error(LINUX ? 'Restart it with its label: systemctl --user restart <label>.service' : `Restart it with its label: launchctl kickstart -k gui/${process.getuid()}/<label>`);
    }
  } else {
    console.error('There is no earlier release to go back to.');
  }
  console.error(`\nEnd of ${c.log}:\n${tail(c.log)}`);
  return 1;
}

// Asks a runner that is answering to restart onto `release` once no thread
// is busy. One too old for runner.restart is kickstarted only when idle.
async function backTo(c, release, waitMs) {
  try {
    const res = await rpcPatient(c.home, 'runner.restart', { when: 'idle', release, reason: `Going back to release ${release}`, backgroundWaitMs: waitMs });
    const w = Array.isArray(res?.waitingFor) ? res.waitingFor : [];
    console.error(w.length ? `The runner restarts onto ${release} once ${finish(w.length)}.` : `The runner is restarting onto ${release}.`);
    return;
  } catch (e) {
    if (e.code !== -32601) {
      console.error(`Couldn't ask the runner to restart (${e.message}). It starts ${release} on its next restart:\n  ${restartCommand(c)}`);
      return;
    }
  }
  if (!c.labelKnown || (await busyThreads(c)).length) {
    console.error(`It starts ${release} on the runner's next restart. Once no thread is busy:\n  ${restartCommand(c)}`);
    return;
  }
  console.error(`Restarting: ${restartCommand(c)}`);
  try {
    await kickstart(c);
  } catch (e) {
    console.error(e.message);
  }
}

// ---------------------------------------------------------------- commands

async function list(c) {
  const state = readState(c.dir);
  const cur = currentId(c);
  const ids = listReleases(c);
  const p = await probe(c.home);
  const running = p.state === 'up' ? releaseOf(p.version) : null;
  // current and running differ while a deploy's restart waits (or after
  // one was withdrawn without putting current back).
  const behind = running && cur && running !== cur;
  const crashed = crashedReleases(state);
  if (!ids.length) {
    say(`No releases in ${c.releases}.`);
  } else {
    say(`Releases in ${c.releases}, newest first:`);
    const width = Math.max(...ids.map((id) => id.length));
    const marksOf = (id) =>
      [
        id === cur && (behind ? 'current, not running yet' : 'current'),
        behind && id === running && 'running',
        id === state.previous && 'previous',
        id === state.lastGood && 'last good',
        crashed.has(id) && 'crashed at startup',
      ]
        .filter(Boolean)
        .join(', ');
    const marksWidth = Math.max(...ids.map((id) => marksOf(id).length));
    for (const id of ids) {
      const info = readJson(path.join(c.releases, id, 'release.json')) ?? {};
      const built = info.builtAt ? info.builtAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '?';
      const branch = typeof info.branch === 'string' ? `, ${info.branch === 'HEAD' ? 'no branch' : info.branch}` : '';
      say(`${id === cur ? '*' : ' '} ${id.padEnd(width)}  ${marksOf(id).padEnd(marksWidth)}  built ${built}${branch}, node ${info.node ?? '?'}`);
    }
  }
  if (state.rolledBack) say(`Last crash rollback: ${state.rolledBack.from} to ${state.rolledBack.to} at ${state.rolledBack.at}.`);
  say(p.state === 'up' ? `Running: ${p.version}${p.pid ? ` (pid ${p.pid})` : ''}` : `The runner at ${c.home} isn't answering.`);
  const pending = p.status?.pendingRestart;
  if (pending) say(`Restart pending${pending.release ? ` onto ${pending.release}` : ''}, waiting for ${plural(pending.waitingFor?.length ?? 0, 'thread')}.`);
  else if (behind) say(`${cur} is current but the runner is on ${running}: it starts ${cur} on its next restart.`);
  return 0;
}

// The runner marks a release good after 60 s of listening (src/release.ts);
// this allows for a slow start on top.
const GOOD_WAIT_MS = 150_000;

// For install-runner.sh: the runner came up on current, and then stayed up
// until it was marked good. Only then does install-runner.sh drop the plist
// it replaced: on a first install there's no earlier good release, so until
// this one is marked good, that plist is the only way back.
async function check(c) {
  const id = currentId(c);
  if (!id) throw new Fail(`No current release in ${c.dir}.`);
  const r = await awaitRelease(c.home, id, null, HEALTH_MS);
  const fail = (msg) => {
    console.error(msg);
    console.error(`\nEnd of ${c.log}:\n${tail(c.log)}`);
    return 1;
  };
  if (r.result !== 'ok') {
    return fail(r.result === 'other' ? `The runner is running ${r.version}, not ${id}.` : `The runner didn't come up on ${id} within ${HEALTH_MS / 1000} s.`);
  }
  say(`The runner is up on ${id}.`);
  if (readState(c.dir).lastGood === id) return 0;
  say('Waiting for it to stay up long enough to be marked good (about a minute)...');
  const end = Date.now() + GOOD_WAIT_MS;
  // A runner that stops and doesn't come back (launchd can't start its
  // program, say) is reported after the health window, not after the whole
  // good wait: nothing is going to mark it good.
  let downAt = null;
  for (;;) {
    if (readState(c.dir).lastGood === id) {
      say(`${id} has been marked good.`);
      return 0;
    }
    const p = await probe(c.home);
    if (p.state === 'up' && releaseOf(p.version) !== id) return fail(`The runner went over to ${p.version} before ${id} was marked good.`);
    if (p.state === 'up' && r.pid && p.pid && p.pid !== r.pid) return fail(`The runner on ${id} stopped and started again (pid ${r.pid}, now ${p.pid}) before it was marked good.`);
    if (p.state === 'down') downAt ??= Date.now();
    else if (p.state === 'up') downAt = null;
    if (downAt !== null && Date.now() - downAt > HEALTH_MS) return fail(`The runner on ${id} stopped before it was marked good and hasn't come back in ${HEALTH_MS / 1000} s.`);
    if (Date.now() > end) return fail(`${id} wasn't marked good within ${GOOD_WAIT_MS / 1000} s.`);
    await sleep(1000);
  }
}

// For install-runner.sh before it replaces the runner: 0 if nothing would
// be cut short, else 1 with the threads that would.
async function checkIdle(c) {
  const busy = await busyThreads(c);
  if (!busy.length) return 0;
  console.error(`${plural(busy.length, 'thread')} would be cut short:`);
  for (const t of busy) console.error(`  ${t.id.slice(0, 8)}  ${t.title}`);
  return 1;
}

function describeRestart(c, v, id, from) {
  if (v['no-restart']) return 'no restart (--no-restart)';
  const how = v.now ? 'restart straight away (runner.restart now, or launchctl kickstart for an older runner)' : 'ask the runner to restart once no thread is busy (runner.restart)';
  const resume = c.threadId ? `, then resume this thread with "${v.resume ?? defaultResume(v, id, from)}"` : '';
  return `${how}${resume}`;
}

// The release the runner is actually on, and a pending restart, so a
// deploy never quietly replaces one that is still waiting to start.
// running is null unless it's a release in this data dir (not "source").
async function liveRelease(c) {
  const p = await probe(c.home);
  const rel = p.state === 'up' ? releaseOf(p.version) : null;
  return { running: rel && releaseExists(c.dir, rel) ? rel : null, pending: p.status?.pendingRestart };
}

function refuseWaiting(c, v, live) {
  const cur = currentId(c);
  if (!live.pending || !live.running || !cur || cur === live.running || v.force) return;
  const p = live.pending;
  const who = p.resumeThreadId ? `, and thread ${p.resumeThreadId.slice(0, 8)} is waiting to be carried on with it` : '';
  // From a thread, replacing another deploy is Mike's call, so --force
  // isn't offered there.
  const force = c.inThread ? '' : ', or pass --force to replace it';
  throw new Fail(
    `Release ${cur} is current but hasn't started yet: the runner (still on ${live.running}) restarts onto it when ${finish(p.waitingFor?.length ?? 0)}${who}. ` +
      `Deploying now would replace it before it ever ran. Wait for it to go live (deploy-runner.sh --list shows what's running)${force}.`,
  );
}

async function rollback(c, v, waitMs) {
  const state = readState(c.dir);
  const cur = currentId(c);
  const target = state.previous;
  if (!target) throw new Fail('There is no previous release to go back to.');
  if (target === cur) throw new Fail(`current already points at ${target}.`);
  if (!releaseExists(c.dir, target)) throw new Fail(`The previous release ${target} isn't in ${c.releases} any more.`);
  // After a crash rollback, previous names the release that crashed; after
  // a later deploy's own rollback, it can name an earlier one that did.
  if (crashedReleases(state).has(target) && !v.force) {
    const again = c.inThread ? '' : ` (--rollback --force starts ${target} again.)`;
    if (state.rolledBack?.from === target) {
      throw new Fail(`${target} kept crashing at startup, and launch.mjs already went back from it to ${state.rolledBack.to}, so there's nothing to roll back.${again}`);
    }
    throw new Fail(`The previous release, ${target}, crashed at startup earlier (deploy-runner.sh --list marks it), so going back to it would only crash again.${again}`);
  }
  requireReleases(c);
  const forward = cur && target > cur ? ' (that rolls forward to the newer release)' : '';
  if (v['dry-run']) {
    say(`Would point current at ${target} (now ${cur})${forward}.`);
    say(`Would restart: ${describeRestart(c, v, target, cur)}.`);
    return 0;
  }
  lock(c);
  const live = await liveRelease(c);
  refuseWaiting(c, v, live);
  if (forward) say(`Going to ${target}${forward}.`);
  const before = { current: live.running ?? cur, previous: state.previous };
  activate(c, target, live.running ?? cur);
  // current named a release that never started (a deploy whose restart was
  // withdrawn): pointing it back is all there is to do.
  if (live.running === target) {
    say(`The runner is already on ${target}, so it doesn't need a restart.`);
    return 0;
  }
  return restartAndCheck(c, v, target, before, waitMs);
}

// launch.mjs is only copied in by install-runner.sh: a change to it in this
// checkout doesn't reach the LaunchAgent until a reinstall.
function warnStaleLaunch(c) {
  try {
    if (!fs.readFileSync(path.join(c.runnerDir, 'launch.mjs')).equals(fs.readFileSync(path.join(c.dir, 'launch.mjs')))) {
      say(`Note: launch.mjs in this checkout differs from ${path.join(c.dir, 'launch.mjs')}. Releases don't update it; scripts/install-runner.sh does.`);
    }
  } catch {
    // not installed yet; deploy() refuses that case
  }
}

async function deploy(c, v, waitMs) {
  // A LaunchAgent that still runs a checkout would never pick up the release.
  if (!v['no-restart']) requireReleases(c);
  const g = gitInfo(c);
  if (g.changes.length && !v['allow-dirty']) {
    throw new Fail(
      `runner/ has uncommitted changes in what a release holds:\n${g.changes.map((l) => `  ${l}`).join('\n')}\nCommit them, or pass --allow-dirty to build from the files as they are.`,
    );
  }
  const off = branchProblem(c, g);
  if (off && !v['allow-branch']) throw new Fail(`${off}\nMerge to main and deploy from there, or pass --allow-branch.`);
  const dirty = g.changes.length > 0;
  // A redeploy of a commit whose release crashed is most likely the same
  // crash again (the cause may be outside the runner, so it's only said).
  const crashedSame = dirty ? [] : [...crashedReleases(readState(c.dir))].filter((r) => r.endsWith(`-${g.short}`)).sort();
  if (crashedSame.length) say(`Note: ${crashedSame.at(-1)}, built from this same commit, crashed at startup (deploy-runner.sh --list marks it), so this one probably will too. Why is in ${c.log}.`);
  if (v['dry-run']) {
    const id = newReleaseId(c, g.short, dirty);
    say('Dry run: nothing changes.');
    if (off) say(`Note: ${off}`);
    say(v['skip-checks'] ? 'Would skip the checks.' : 'Would run the typecheck and unit tests.');
    say(`Would build ${id} from ${dirty ? 'the working tree' : `${g.short} (HEAD)`} on ${g.branch === 'HEAD' ? 'no branch' : `branch ${g.branch}`} into ${c.releases}, then smoke test it.`);
    say(v['skip-backend'] ? 'Would skip the backend.' : 'Would deploy the Convex backend and website at HEAD if they changed (deploy-backend.mjs --dry-run says which).');
    say(`Would point current at ${id}${currentId(c) ? ` (now ${currentId(c)})` : ''}.`);
    say(`Would restart: ${describeRestart(c, v, id)}.`);
    if (!v['no-restart']) {
      try {
        refuseWaiting(c, v, await liveRelease(c));
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        say(`But the real run would stop before building: ${e.message}`);
      }
    }
    const gone = pruneList(c, [id, ...drainingReleases(c)]);
    say(gone.length ? `Would remove: ${gone.join(', ')}` : 'Would remove no old releases.');
    return 0;
  }
  lock(c);
  // Checked before the build so a refusal is quick, and again after it.
  if (!v['no-restart']) refuseWaiting(c, v, await liveRelease(c));
  warnStaleLaunch(c);
  if (off) say(`Note: ${off}`);
  if (v['skip-checks']) say('Skipping the checks.');
  else checks(c);
  const id = newReleaseId(c, g.short, dirty);
  build(c, id, g, dirty);
  try {
    await smoke(c, id);
  } catch (e) {
    fs.rmSync(path.join(c.releases, id), { recursive: true, force: true });
    throw e;
  }
  try {
    deployBackend(c, g, v);
  } catch (e) {
    fs.rmSync(path.join(c.releases, id), { recursive: true, force: true });
    throw e;
  }
  const live = v['no-restart'] ? { running: null } : await liveRelease(c);
  if (!v['no-restart']) {
    try {
      refuseWaiting(c, v, live);
    } catch (e) {
      fs.rmSync(path.join(c.releases, id), { recursive: true, force: true });
      throw e;
    }
  }
  const state = readState(c.dir);
  const cur = currentId(c);
  if (live.running && cur && cur !== live.running) say(`Replacing release ${cur}, which never started; the runner is on ${live.running}.`);
  const before = { current: live.running ?? cur, previous: state.previous };
  activate(c, id, live.running ?? cur);
  let code = 0;
  if (v['no-restart']) say('Not restarting (--no-restart).');
  else code = await restartAndCheck(c, v, id, before, waitMs);
  const running = releaseOf((await probe(c.home)).version);
  prune(c, [running, ...drainingReleases(c)]);
  return code;
}

async function main(argv) {
  let v;
  try {
    ({ values: v } = parseArgs({
      args: argv,
      strict: true,
      options: {
        'skip-checks': { type: 'boolean' },
      'skip-backend': { type: 'boolean' },
        'allow-dirty': { type: 'boolean' },
        'allow-branch': { type: 'boolean' },
        now: { type: 'boolean' },
        force: { type: 'boolean' },
        wait: { type: 'string' },
        resume: { type: 'string' },
        rollback: { type: 'boolean' },
        list: { type: 'boolean' },
        home: { type: 'string' },
        label: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'no-restart': { type: 'boolean' },
        follow: { type: 'string' },
        check: { type: 'boolean' },
        'check-idle': { type: 'boolean' },
        'check-branch': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    console.error(`${e.message}\nSee scripts/deploy-runner.sh --help.`);
    return 2;
  }
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const c = setup(v);
  if (v.list) return list(c);
  if (v.check) return check(c);
  if (v['check-idle']) return checkIdle(c);
  if (v['check-branch']) {
    const off = branchProblem(c, gitInfo(c));
    if (!off) return 0;
    console.error(off);
    return 1;
  }
  // Everything that can be refused is refused before anything is built.
  if (v.now && v['no-restart']) throw new Fail('--now and --no-restart contradict each other.');
  if (v.now && !c.labelKnown) throw new Fail(`--now restarts through launchd, and ${c.home} isn't the default data dir, so pass --label with its launchd label.`);
  if (v.now && c.inThread && !v.force) {
    throw new Fail(
      '--now would stop the runner this thread runs on, ending this turn and any work other threads have going. Leave it out: the runner then restarts once every thread is idle and resumes this thread.',
    );
  }
  if (v.now) await refuseNowWhileBusy(c, v);
  if (v.resume !== undefined && !c.threadId) {
    throw new Fail('--resume picks up the thread it runs in, so it only works inside a Threadbear thread of this runner (THREADBEAR_THREAD_ID).');
  }
  const waitMs = parseDuration(v.wait ?? '30m');
  if (v.rollback) return rollback(c, v, waitMs);
  return deploy(c, v, waitMs);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Fail ? e.message : (e?.stack ?? String(e)));
    process.exit(1);
  },
);
