// deploy-runner.sh, install-runner.sh and launch.mjs end to end, against a
// throwaway git repo whose runner is test/deploy/fake-runner.mjs, a temp
// data dir, and fake-launchctl.mjs in place of launchctl. Nothing touches
// the real runner, its data dir or launchd. Run with test/deploy/run.sh;
// TB_DEPLOY_KEEP=1 keeps the temp folder.
//
// The tests run in order and share one installed sandbox: each starts from
// where the previous one left the releases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNNER = path.join(import.meta.dirname, '..', '..');
const FAKE_LAUNCHCTL = path.join(import.meta.dirname, 'fake-launchctl.mjs');
const NODE = process.execPath;
const LABEL = 'com.mikerosoft.threadbear.runner.devtest';
const TARGET = `gui/${process.getuid!()}/${LABEL}`;
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{7,}(-dirty)?$/;

let root: string;
let repo: string;
let rdir: string; // the fake checkout's runner/
let home: string;
let launchd: string;
let agents: string;

type Run = { status: number | null; stdout: string; stderr: string };
type State = {
  current: string | null;
  previous: string | null;
  lastGood: string | null;
  boots: { release: string; at: string }[];
  rolledBack?: { from: string; to: string; at: string };
};

// No THREADBEAR_* from whatever this runs in (inside a thread they name
// the live runner), then the fakes.
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^THREADB(EAR|ARE)_/.test(k) && !k.startsWith('FAKE_')) out[k] = v;
  return {
    ...out,
    PATH: `${path.dirname(NODE)}:${process.env.PATH}`,
    THREADBEAR_NODE: NODE,
    // How long a deploy watches a release that came up (20 s for real); the
    // fake runner is marked good after 200 ms, which ends it sooner.
    THREADBEAR_DEPLOY_SETTLE_MS: '1500',
    THREADBEAR_LAUNCHCTL: FAKE_LAUNCHCTL,
    THREADBEAR_LAUNCH_AGENTS_DIR: agents,
    FAKE_LAUNCHD_DIR: launchd,
    ...extra,
  };
}

const out = (r: Run) => `--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;

function sh(script: string, args: string[], extra: Record<string, string> = {}): Run {
  const r: SpawnSyncReturns<string> = spawnSync('/bin/bash', [path.join(rdir, 'scripts', script), ...args], {
    env: env(extra),
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const deploy = (args: string[], extra: Record<string, string> = {}) => sh('deploy-runner.sh', ['--home', home, '--label', LABEL, ...args], extra);

// For runs the test has to act on while they wait.
function deployInBackground(args: string[]): { output: () => string; done: Promise<Run> } {
  const child = spawn('/bin/bash', [path.join(rdir, 'scripts', 'deploy-runner.sh'), '--home', home, '--label', LABEL, ...args], {
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<Run>((resolve) => child.once('close', (status) => resolve({ status, stdout, stderr })));
  return { output: () => stdout + stderr, done };
}

function launchctl(...args: string[]): number | null {
  return spawnSync(FAKE_LAUNCHCTL, args, { env: env(), stdio: 'ignore' }).status;
}

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Deploy Test',
      GIT_AUTHOR_EMAIL: 'deploy-test@example.com',
      GIT_COMMITTER_NAME: 'Deploy Test',
      GIT_COMMITTER_EMAIL: 'deploy-test@example.com',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A commit whose fake runner behaves as `mode` says (see fake-runner.mjs).
function commit(mode: Record<string, unknown>, message: string): string {
  fs.writeFileSync(path.join(rdir, 'src', 'mode.json'), JSON.stringify(mode) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', '--short', 'HEAD');
}

const runnerDir = () => path.join(home, 'runner');
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const state = (): State => readJson(path.join(runnerDir(), 'state.json'));
const current = () => path.basename(fs.readlinkSync(path.join(runnerDir(), 'current')));
const releases = () =>
  fs
    .readdirSync(path.join(runnerDir(), 'releases'))
    .filter((n) => ID_RE.test(n))
    .sort();
const leftovers = () => fs.readdirSync(path.join(runnerDir(), 'releases')).filter((n) => n.startsWith('.'));
const setBusy = (ids: string[]) => fs.writeFileSync(path.join(home, 'fake-busy.json'), JSON.stringify(ids));
const restartCalls = (): Record<string, any>[] =>
  fs
    .readFileSync(path.join(home, 'fake-restart-calls.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const launchctlCalls = (): string[][] =>
  fs
    .readFileSync(path.join(launchd, 'calls.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const kickstarts = () => launchctlCalls().filter((c) => c[0] === 'kickstart' && c[1] === '-k').length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The version the sandbox runner reports, or null if it isn't answering.
// Through deploy.mjs's client: Node's own WebSocket can crash the process
// when it connects to a runner that is going down.
const rpcClient = import(pathToFileURL(path.join(RUNNER, 'scripts', 'rpc-client.mjs')).href);
async function version(dataDir = home): Promise<string | null> {
  const { connectRpc } = await rpcClient;
  try {
    const port = readJson(path.join(dataDir, 'runner.json')).port;
    const token = fs.readFileSync(path.join(dataDir, 'secrets', 'runner-token'), 'utf8').trim();
    const conn = await connectRpc(port, token, 2000);
    try {
      return (await conn.call('hello', { client: 'deploy-test', version: '1' })).runnerVersion ?? null;
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// runner.status from the sandbox runner.
async function status(): Promise<Record<string, any>> {
  const { connectRpc } = await rpcClient;
  const port = readJson(path.join(home, 'runner.json')).port;
  const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
  const conn = await connectRpc(port, token, 2000);
  try {
    return await conn.call('runner.status', {});
  } finally {
    conn.close();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const runsOn = (id: string) => waitFor(`the runner on ${id}`, async () => (await version()) === `9.9.9+${id}`);

before(() => {
  // realpath: /var is /private/var, and the scripts compare resolved paths.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-deploy-test-')));
  repo = path.join(root, 'repo');
  rdir = path.join(repo, 'runner');
  home = path.join(root, 'home');
  launchd = path.join(root, 'launchd');
  agents = path.join(root, 'LaunchAgents');
  for (const d of ['scripts', 'src', 'bin']) fs.mkdirSync(path.join(rdir, d), { recursive: true });
  // The real scripts and launch.mjs, around a fake runner with no packages.
  for (const f of ['deploy-runner.sh', 'deploy.mjs', 'deploy-steps.mjs', 'rpc-client.mjs', 'install-runner.sh', 'deploy-backend.mjs']) {
    fs.copyFileSync(path.join(RUNNER, 'scripts', f), path.join(rdir, 'scripts', f));
  }
  fs.copyFileSync(path.join(RUNNER, 'launch.mjs'), path.join(rdir, 'launch.mjs'));
  // The launcher app's sources, built by install-runner.sh into the sandbox.
  fs.cpSync(path.join(RUNNER, 'launcher'), path.join(rdir, 'launcher'), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'fake-runner.mjs'), path.join(rdir, 'src', 'main.ts'));
  // rpc-client.mjs and the fake runner both answer the auth challenge with it.
  fs.copyFileSync(path.join(RUNNER, 'src', 'rpc-auth.ts'), path.join(rdir, 'src', 'rpc-auth.ts'));
  // deploy-backend.mjs reads this Mac's Convex credential with it.
  fs.copyFileSync(path.join(RUNNER, 'src', 'convex-admin.ts'), path.join(rdir, 'src', 'convex-admin.ts'));
  fs.writeFileSync(path.join(rdir, 'bin', 'tb'), '#!/usr/bin/env node\n');
  const pkg = { name: 'fake-runner', version: '9.9.9', private: true, type: 'module', scripts: { typecheck: 'true', test: 'true' } };
  fs.writeFileSync(path.join(rdir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(
    path.join(rdir, 'package-lock.json'),
    JSON.stringify({ name: 'fake-runner', version: '9.9.9', lockfileVersion: 3, requires: true, packages: { '': { name: 'fake-runner', version: '9.9.9' } } }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git('init', '-q', '-b', 'main');
  commit({}, 'first');
});

after(() => {
  // Stop the fake launchd's job; it and the runners it started are ours.
  if (launchd && fs.existsSync(path.join(launchd, 'job.json'))) launchctl('bootout', TARGET);
  for (const f of ['supervisor.pid', 'child.pid']) {
    try {
      process.kill(Number(fs.readFileSync(path.join(launchd, f), 'utf8')), 'SIGKILL');
    } catch {
      // gone
    }
  }
  if (process.env.TB_DEPLOY_KEEP) console.log(`kept ${root}`);
  else if (root) fs.rmSync(root, { recursive: true, force: true });
});

let first: string;
let second: string;

test('install-runner.sh builds the first release and starts it through launch.mjs', { timeout: 120_000 }, async () => {
  const r = sh('install-runner.sh', ['--home', home, '--label', LABEL, '--port', '0', '--path', '/usr/bin:/bin']);
  assert.equal(r.status, 0, out(r));

  const plistFile = path.join(agents, `${LABEL}.plist`);
  const plist = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', plistFile], { encoding: 'utf8' }).stdout);
  // The program is the launcher app (a sandbox's lives in its data dir),
  // with node and launch.mjs as its arguments.
  const app = path.join(home, 'runner', 'Threadbear Runner.app');
  assert.deepEqual(plist.ProgramArguments, [path.join(app, 'Contents', 'MacOS', 'Threadbear Runner'), NODE, path.join(home, 'runner', 'launch.mjs')]);
  assert.match(r.stdout, /Threadbear Runner\.app isn't built yet/);
  assert.match(r.stdout, /Built .*Threadbear Runner\.app/);
  assert.match(r.stdout, new RegExp(`app:\\s+${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const appInfo = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout);
  assert.equal(appInfo.CFBundleIdentifier, 'com.mikerosoft.threadbear.runner');
  assert.equal(appInfo.CFBundleName, 'Threadbear Runner');
  assert.equal(spawnSync('codesign', ['--verify', '--strict', app]).status, 0, 'the app is signed');
  assert.equal(readJson(path.join(app, 'Contents', 'Resources', 'build.json')).sources, sh('../launcher/build-launcher.sh', ['--hash']).stdout.trim());
  assert.ok(!fs.existsSync(path.join(home, 'runner', '.Threadbear Runner.app.old')), 'no old app left behind on a first install');
  // launchd's job is the launcher, and the runner runs under it: node is
  // its child, so privacy prompts are attributed to the app.
  const launcherPid = Number(fs.readFileSync(path.join(launchd, 'child.pid'), 'utf8'));
  assert.equal(spawnSync('ps', ['-o', 'comm=', '-p', String(launcherPid)], { encoding: 'utf8' }).stdout.trim(), path.join(app, 'Contents', 'MacOS', 'Threadbear Runner'));
  const supervisorPid = Number(spawnSync('pgrep', ['-P', String(launcherPid)], { encoding: 'utf8' }).stdout.trim());
  assert.equal(spawnSync('ps', ['-o', 'command=', '-p', String(supervisorPid)], { encoding: 'utf8' }).stdout.trim(), `${NODE} ${path.join(home, 'runner', 'launch.mjs')}`);
  assert.equal(plist.WorkingDirectory, path.join(home, 'runner'));
  assert.equal(plist.EnvironmentVariables.THREADBEAR_HOME, home);
  // So the runner can tell the LaunchAgent is behind main (update.ts, launchAgentBehind).
  assert.equal(plist.EnvironmentVariables.THREADBEAR_RUNNER_APP, app);
  assert.equal(plist.EnvironmentVariables.THREADBEAR_PORT, '0');
  assert.equal(plist.EnvironmentVariables.THREADBEAR_LOG, path.join(home, 'runner.log'));
  assert.equal(plist.StandardOutPath, path.join(home, 'runner.log'));
  assert.ok(fs.existsSync(path.join(home, 'runner', 'launch.mjs')));

  const ids = releases();
  assert.equal(ids.length, 1);
  first = ids[0];
  const info = readJson(path.join(runnerDir(), 'releases', first, 'release.json'));
  assert.equal(info.id, first);
  assert.equal(info.commit, git('rev-parse', 'HEAD'));
  assert.equal(info.dirty, false);
  assert.equal(info.node, process.versions.node);
  assert.ok(Date.parse(info.builtAt) > 0);
  // For the runner following main by itself (src/update.ts).
  assert.equal(info.checkout, repo);
  assert.equal(info.prefix, 'runner/');
  const lsTree = git('ls-tree', 'HEAD', '--', 'runner/src', 'runner/bin', 'runner/package.json', 'runner/package-lock.json');
  assert.equal(info.tree, lsTree.split('\n').map((l) => l.split(/\s+/)[2]).join('+'));
  for (const f of ['src/main.ts', 'bin/tb', 'package.json', 'package-lock.json']) {
    assert.ok(fs.existsSync(path.join(runnerDir(), 'releases', first, f)), f);
  }
  assert.ok(!fs.existsSync(path.join(runnerDir(), 'releases', first, 'scripts')), 'only what runs goes in a release');
  assert.equal(current(), first);
  assert.equal(state().current, first);
  assert.equal(state().previous, null);
  assert.match(r.stdout, new RegExp(`up on ${first}`));
  assert.equal(await version(), `9.9.9+${first}`);
  // main.ts (here the fake) marks its release good.
  await waitFor('lastGood', () => state().lastGood === first);
  assert.equal(state().boots.at(-1)?.release, first);
});

test('a second release goes live through runner.restart', { timeout: 60_000 }, async () => {
  commit({ v: 2 }, 'second');
  const r = deploy([]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Typecheck\.\.\. ok/);
  assert.match(r.stdout, /Unit tests\.\.\. ok/);
  assert.match(r.stdout, /Smoke test\.\.\. ok/);
  second = current();
  assert.notEqual(second, first);
  assert.deepEqual(releases(), [first, second]);
  assert.equal(state().current, second);
  assert.equal(state().previous, first);
  assert.equal(await version(), `9.9.9+${second}`);
  const call = restartCalls().at(-1)!;
  assert.equal(call.when, 'idle');
  assert.equal(call.release, second, 'the runner is told which release to expect');
  assert.equal(call.resume, undefined, 'no thread to resume outside one');
  assert.deepEqual(leftovers(), []);
});

test('inside a thread, the restart waits for the thread and then resumes it', { timeout: 60_000 }, async () => {
  const inThread = { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home };
  setBusy(['thread-1']);

  const refused = deploy(['--now', '--skip-checks'], inThread);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--now would stop the runner this thread runs on/);
  assert.doesNotMatch(refused.stderr, /--force/, 'never taught to an agent');
  // Kickstarting the default label for a sandbox would restart the real runner.
  const noLabel = sh('deploy-runner.sh', ['--home', home, '--now', '--skip-checks']);
  assert.equal(noLabel.status, 1, out(noLabel));
  assert.match(noLabel.stderr, /pass --label/);
  assert.deepEqual(releases(), [first, second], 'nothing was built');

  commit({ v: 3 }, 'third');
  const r = deploy(['--skip-checks'], inThread);
  assert.equal(r.status, 0, out(r));
  const third = current();
  assert.match(r.stdout, /End your turn now/);
  const call = restartCalls().at(-1)!;
  assert.equal(call.when, 'idle');
  assert.equal(call.resume.threadId, 'thread-1');
  assert.equal(call.resume.text, `The runner restarted on release ${third}. Check that your change works, then carry on.`);
  assert.equal(call.backgroundWaitMs, 30 * 60_000, 'background work holds it for --wait at most');
  // The thread is still running, so the old release still is too.
  assert.equal(await version(), `9.9.9+${second}`);

  setBusy([]);
  await runsOn(third);
});

test("the real runner's label is refused for a sandbox, and a thread is spotted from the process tree", { timeout: 60_000 }, async () => {
  // The reviewer's case: a sandbox --home with the real label, from inside a thread.
  let r = sh('deploy-runner.sh', ['--home', home, '--label', 'com.mikerosoft.threadbear.runner', '--now', '--dry-run'], { THREADBEAR_THREAD_ID: 'thread-1' });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /is the real runner's label/);
  assert.doesNotMatch(r.stdout, /kickstart/);

  // No THREADBEAR_* at all, but the runner owning the data dir is an
  // ancestor (here this test process stands in for it).
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(home, 'run', 'runner.pid'), JSON.stringify({ pid: process.pid, lstart: 'x' }));
  try {
    r = deploy(['--now', '--skip-checks']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /--now would stop the runner this thread runs on/);
    r = sh('install-runner.sh', ['--home', home, '--label', LABEL]);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /Ask the user to run it from a terminal/);
    // THREADBEAR_HOME pointed at a dev runner doesn't switch the guard off.
    r = sh('install-runner.sh', ['--home', home, '--label', LABEL], { THREADBEAR_THREAD_ID: 't', THREADBEAR_HOME: path.join(root, 'dev-home') });
    assert.equal(r.status, 1, out(r));
  } finally {
    fs.rmSync(path.join(home, 'run'), { recursive: true, force: true });
  }
  // THREADBEAR_RUNNER_HOME, not THREADBEAR_HOME, says which runner a thread is on.
  r = deploy(['--now', '--skip-checks'], { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: path.join(root, 'dev-home'), THREADBEAR_RUNNER_HOME: home });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /--now would stop the runner this thread runs on/);
});

test("inside a thread, a resume the runner won't send is said rather than promised", { timeout: 60_000 }, async () => {
  const inThread = { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home };
  setBusy(['thread-1']);
  fs.writeFileSync(path.join(home, 'fake-no-resume'), '');
  commit({ v: 'no-resume' }, 'no resume');
  let r: Run;
  try {
    r = deploy(['--skip-checks'], inThread);
  } finally {
    fs.rmSync(path.join(home, 'fake-no-resume'));
  }
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /The runner restarts when this turn ends, but it won't carry this thread on afterwards: fake: resumed too often\.\n/);
  assert.match(r.stdout, /End your turn now, and say in your reply that the user has to message this thread once the runner is back/);
  assert.doesNotMatch(r.stdout, /resumes this thread with/);
  const id = current();
  setBusy([]);
  await runsOn(id);
});

test('--now --force inside a thread restarts through runner.restart and still carries the thread on', { timeout: 60_000 }, async () => {
  commit({ v: 'now' }, 'now');
  const kicks = kickstarts();
  const r = deploy(['--now', '--force', '--skip-checks'], { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Restarting now\. This turn ends here, and the runner then carries this thread on with:/);
  const id = current();
  const call = restartCalls().at(-1)!;
  assert.equal(call.when, 'now');
  assert.equal(call.release, id);
  assert.equal(call.resume.threadId, 'thread-1');
  assert.equal(kickstarts(), kicks, 'no launchctl kickstart, which would have skipped the resume');
  await runsOn(id);
});

test('--now never cuts other threads short from a thread, and a thread hears about its own background work', { timeout: 60_000 }, async () => {
  const inThread = { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home };
  setBusy(['thread-1', 't-other']);
  const ids = releases();
  let r = deploy(['--now', '--force', '--skip-checks'], inThread);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /^--now would cut short 1 other thread's work/);
  assert.match(r.stderr, /t-other/);
  assert.match(r.stderr, /ask the user to run this from a terminal with --now --force/);
  // From a terminal it takes --force, which isn't offered.
  r = deploy(['--now', '--skip-checks']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /^--now would cut short 2 threads' work/);
  assert.doesNotMatch(r.stderr, /--force/);
  assert.deepEqual(releases(), ids, 'refused before building');

  // Its own dev runner in the background: ending the turn isn't enough.
  setBusy(['thread-1']);
  fs.writeFileSync(path.join(home, 'fake-background.json'), JSON.stringify([{ threadId: 'thread-1', tasks: ['scripts/dev-runner.sh'] }]));
  commit({ v: 'bg' }, 'background work');
  r = deploy(['--skip-checks', '--wait', '5m'], inThread);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /The runner restarts when this turn ends, then resumes this thread with:/);
  assert.match(r.stdout, /It also waits for this thread's background work, which ending the turn doesn't stop:\n  scripts\/dev-runner\.sh\n/);
  assert.match(r.stdout, /goes ahead after 5m and stops it\./);
  // For a sandbox the data dir goes in front: a bare tb in a thread is the
  // live runner's.
  assert.ok(r.stdout.includes(`THREADBEAR_HOME=${home} ${path.join(rdir, 'bin', 'tb')} status shows what it's waiting for`), r.stdout);
  assert.equal(restartCalls().at(-1)!.backgroundWaitMs, 5 * 60_000);
  const id = current();
  setBusy([]);
  fs.rmSync(path.join(home, 'fake-background.json'));
  await runsOn(id);
});

test("a deploy while another deploy's restart is pending is refused unless --force", { timeout: 90_000 }, async () => {
  const running = current();
  setBusy(['t-p']);
  commit({ v: 'p1' }, 'first of two');
  let r = deploy(['--skip-checks'], { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home });
  assert.equal(r.status, 0, out(r));
  const waiting = current();
  assert.equal(await version(), `9.9.9+${running}`);

  commit({ v: 'p2' }, 'second of two');
  const ids = releases();
  r = deploy(['--skip-checks']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, new RegExp(`Release ${waiting} is current but hasn't started yet`));
  assert.match(r.stderr, /thread thread-1 is waiting to be carried on with it/);
  assert.deepEqual(releases(), ids, 'refused before building');

  // --dry-run says the real run would stop there.
  r = deploy(['--skip-checks', '--dry-run']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, new RegExp(`But the real run would stop before building: Release ${waiting} is current but hasn't started yet`));
  // From a thread, --force isn't offered.
  r = deploy(['--skip-checks'], { THREADBEAR_THREAD_ID: 'thread-2', THREADBEAR_HOME: home });
  assert.equal(r.status, 1, out(r));
  assert.doesNotMatch(r.stderr, /--force/);
  r = deploy(['--list']);
  assert.match(r.stdout, new RegExp(`\\* ${waiting}\\s+current, not running yet`));
  assert.match(r.stdout, new RegExp(`  ${running}\\s+running, previous`));
  assert.match(r.stdout, /Restart pending onto/);

  r = deploy(['--skip-checks', '--force', '--wait', '1s']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, new RegExp(`Replacing release ${waiting}, which never started`));
  assert.ok(r.stdout.includes(`THREADBEAR_HOME=${home} ${path.join(rdir, 'bin', 'tb')} restart --cancel`), r.stdout);
  const replaced = current();
  assert.equal(state().previous, running, 'previous is the release that ran, not the one that never did');
  setBusy([]);
  await runsOn(replaced);
});

test('a withdrawn restart: the waiting deploy says so, and --rollback puts current back without a restart', { timeout: 90_000 }, async () => {
  const running = current();
  setBusy(['t-w']);
  commit({ v: 'withdrawn' }, 'to be withdrawn');
  const bg = deployInBackground(['--skip-checks', '--wait', '1m']);
  await waitFor('the deploy to wait', () => /The runner restarts when 1 thread finishes/.test(bg.output()));
  const waiting = current();
  assert.notEqual(waiting, running);
  // tb restart --cancel, as the fake runner answers it (it leaves current
  // alone, like a runner that can't put it back).
  const { connectRpc } = await rpcClient;
  const conn = await connectRpc(readJson(path.join(home, 'runner.json')).port, fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim(), 2000);
  try {
    assert.equal((await conn.call('runner.restart', { cancel: true })).scheduled, false);
  } finally {
    conn.close();
  }
  const r = await bg.done;
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, new RegExp(`The restart was withdrawn \\(tb restart --cancel\\), but ${waiting} is still current and starts on the runner's next restart\\. deploy-runner\\.sh --rollback goes back to ${running}\\.`));
  const kicks = kickstarts();
  const calls = restartCalls().length;
  const rb = deploy(['--rollback']);
  assert.equal(rb.status, 0, out(rb));
  assert.match(rb.stdout, new RegExp(`The runner is already on ${running}, so it doesn't need a restart\\.`));
  assert.equal(current(), running);
  assert.equal(restartCalls().length, calls, 'no restart asked for');
  assert.equal(kickstarts(), kicks);
  setBusy([]);
  assert.equal(await version(), `9.9.9+${running}`);
});

test('a runner that is listening but too slow to answer is not kickstarted', { timeout: 90_000 }, async () => {
  const running = current();
  const kicks = kickstarts();
  commit({ v: 'slow' }, 'slow');
  fs.writeFileSync(path.join(home, 'fake-hang-restart'), '');
  try {
    const r = deploy(['--skip-checks']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /listening but didn't answer runner\.restart/);
    assert.match(r.stderr, /launchctl kickstart -k/);
    assert.equal(kickstarts(), kicks);
    assert.equal(await version(), `9.9.9+${running}`);
  } finally {
    fs.rmSync(path.join(home, 'fake-hang-restart'));
  }
  assert.equal(launchctl('kickstart', '-k', TARGET), 0);
  await runsOn(current());
});

test('a HEAD that is not main is refused unless --allow-branch, and the branch is recorded', { timeout: 60_000 }, async () => {
  git('checkout', '-q', '-b', 'feature');
  commit({ v: 'feature' }, 'unmerged work');
  let r = deploy(['--skip-checks']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /branch feature\) has commits that aren't on main/);
  assert.match(r.stderr, /--allow-branch/);
  r = deploy(['--skip-checks', '--allow-branch']);
  assert.equal(r.status, 0, out(r));
  const id = current();
  assert.equal(readJson(path.join(runnerDir(), 'releases', id, 'release.json')).branch, 'feature');
  await runsOn(id);
  r = deploy(['--list']);
  assert.match(r.stdout, new RegExp(`\\* ${id}.*, feature, node`));
  // Behind main: merged work would come back out.
  git('checkout', '-q', 'main');
  git('merge', '-q', '--ff-only', 'feature');
  commit({ v: 'main-ahead' }, 'main moves on');
  git('checkout', '-q', 'HEAD~1');
  r = deploy(['--skip-checks', '--dry-run']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /is behind main/);
  git('checkout', '-q', 'main');
});

test('a runner too old for runner.restart: waits until idle, then kickstarts', { timeout: 120_000 }, async () => {
  commit({ v: 4, oldRunner: true }, 'old runner');
  let r = deploy(['--skip-checks']);
  assert.equal(r.status, 0, out(r));
  const old = current();
  await runsOn(old);

  // Outside a thread: waits for the busy thread, then kickstarts.
  commit({ v: 5, oldRunner: true }, 'old runner again');
  setBusy(['t-2']);
  const kicks = kickstarts();
  const bg = deployInBackground(['--skip-checks', '--wait', '1m']);
  await waitFor('the wait for t-2', () => /Waiting for 1 thread to finish/.test(bg.output()));
  setBusy([]);
  r = await bg.done;
  assert.equal(r.status, 0, out(r));
  assert.equal(kickstarts(), kicks + 1);
  assert.deepEqual(launchctlCalls().at(-1), ['kickstart', '-k', TARGET]);
  const fifth = current();
  await runsOn(fifth);

  // Inside a thread it can't wait for itself, so it hands Mike the command.
  commit({ v: 6 }, 'sixth');
  r = deploy(['--skip-checks'], { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home });
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, new RegExp(`launchctl kickstart -k ${TARGET.replaceAll('.', '\\.')}`));
  assert.equal(kickstarts(), kicks + 1, 'no kickstart from inside a thread');
  const sixth = current();
  assert.equal(await version(), `9.9.9+${fifth}`);

  // Gives up after --wait, leaving the new release current for next time.
  commit({ v: 7 }, 'seventh');
  setBusy(['t-3']);
  r = deploy(['--skip-checks', '--wait', '1s']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /still running after 1s/);
  const seventh = current();
  assert.notEqual(seventh, sixth);
  assert.equal(await version(), `9.9.9+${fifth}`);
  setBusy([]);
  assert.equal(launchctl('kickstart', '-k', TARGET), 0);
  await runsOn(seventh);
});

test('--rollback goes back to the previous release, and again to come forward', { timeout: 60_000 }, async () => {
  const [prev, cur] = [state().previous!, current()];
  let r = deploy(['--rollback']);
  assert.equal(r.status, 0, out(r));
  assert.equal(current(), prev);
  assert.equal(state().previous, cur);
  await runsOn(prev);
  r = deploy(['--rollback']);
  assert.equal(r.status, 0, out(r));
  assert.equal(current(), cur);
  assert.equal(state().previous, prev);
  await runsOn(cur);
});

test('a release that fails the smoke test leaves current untouched', { timeout: 60_000 }, async () => {
  const [ids, link, s] = [releases(), current(), state()];
  commit({ crash: 'always' }, 'broken');
  const r = deploy(['--skip-checks']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /smoke test failed/);
  assert.match(r.stderr, /crashing on purpose/);
  assert.deepEqual(releases(), ids, 'the failed release is removed');
  assert.deepEqual(leftovers(), []);
  assert.equal(current(), link);
  assert.equal(state().current, s.current);
  assert.equal(state().previous, s.previous);
  assert.equal(await version(), `9.9.9+${link}`);
});

test('uncommitted changes are refused unless --allow-dirty', { timeout: 60_000 }, async () => {
  commit({ v: 8 }, 'eighth');
  const ids = releases();
  fs.writeFileSync(path.join(rdir, 'src', 'mode.json'), JSON.stringify({ v: 'dirty' }));
  let r = deploy(['--skip-checks']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /uncommitted changes/);
  assert.match(r.stderr, /src\/mode\.json/);
  assert.deepEqual(releases(), ids);

  r = deploy(['--skip-checks', '--allow-dirty']);
  assert.equal(r.status, 0, out(r));
  const dirty = current();
  assert.match(dirty, /-dirty$/);
  const info = readJson(path.join(runnerDir(), 'releases', dirty, 'release.json'));
  assert.equal(info.dirty, true);
  assert.equal(readJson(path.join(runnerDir(), 'releases', dirty, 'src', 'mode.json')).v, 'dirty');
  await runsOn(dirty);
  git('checkout', '--', 'runner/src/mode.json');

  // Files outside what a release holds don't count.
  fs.writeFileSync(path.join(rdir, 'scripts', 'notes.txt'), 'scratch\n');
  r = deploy(['--skip-checks']);
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(current(), /-dirty$/);
  fs.rmSync(path.join(rdir, 'scripts', 'notes.txt'));
});

let bad: string;
let good: string;

test('a release that keeps crashing at startup goes back to lastGood', { timeout: 90_000 }, async () => {
  good = current();
  await waitFor('lastGood', () => state().lastGood === good);
  commit({ crash: 'launched' }, 'crashes once installed');
  const r = deploy(['--skip-checks']);
  assert.equal(r.status, 1, out(r));
  bad = releases().at(-1)!;
  assert.notEqual(bad, good);
  assert.match(r.stdout, /Smoke test\.\.\. ok/, 'it only crashes under launch.mjs');
  assert.match(r.stderr, new RegExp(`came back on ${good} instead of ${bad}`));
  assert.match(r.stderr, /kept crashing at startup/);
  assert.match(r.stderr, /crashing on purpose/, 'the log tail is shown');
  const s = state();
  assert.equal(s.rolledBack?.from, bad);
  assert.equal(s.rolledBack?.to, good);
  assert.equal(current(), good);
  assert.deepEqual(
    s.boots.slice(-3).map((b) => b.release),
    [bad, bad, good],
  );
  assert.equal(await version(), `9.9.9+${good}`);
});

test('--rollback after a crash rollback will not go back to the release that crashed', () => {
  // As launch.mjs leaves it when nothing put previous back (a deploy from a
  // thread, which doesn't wait for the health check).
  const file = path.join(runnerDir(), 'state.json');
  const saved = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ ...state(), previous: bad }));
  try {
    const r = deploy(['--rollback']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, new RegExp(`${bad} kept crashing at startup, and launch\\.mjs already went back from it to ${good}`));
    assert.match(r.stderr, /--rollback --force/);
    assert.equal(current(), good);
    // A later crash rollback (from another release) overwrites rolledBack;
    // the crashed list still remembers this one, as the deploy that wrote
    // state after the first crash left it.
    fs.writeFileSync(file, JSON.stringify({ ...state(), previous: bad, crashed: [bad], rolledBack: { from: 'zz-later', to: good, at: new Date().toISOString() } }));
    const again = deploy(['--rollback', '--dry-run']);
    assert.equal(again.status, 1, out(again));
    assert.match(again.stderr, new RegExp(`The previous release, ${bad}, crashed at startup earlier`));
    const list = deploy(['--list']);
    assert.match(list.stdout, new RegExp(`${bad}\\s+previous, crashed at startup`), list.stdout);
    // Marked good since: it drops out.
    fs.writeFileSync(file, JSON.stringify({ ...state(), lastGood: bad }));
    assert.doesNotMatch(deploy(['--list']).stdout, new RegExp(`${bad}.*crashed at startup`));
  } finally {
    fs.writeFileSync(file, saved);
  }
});

test('launch.mjs on its own: two failed starts, then the third runs lastGood', { timeout: 60_000 }, async () => {
  const home2 = path.join(root, 'home2');
  const dir2 = path.join(home2, 'runner');
  fs.mkdirSync(path.join(dir2, 'releases'), { recursive: true });
  for (const id of [good, bad]) fs.cpSync(path.join(runnerDir(), 'releases', id), path.join(dir2, 'releases', id), { recursive: true });
  fs.copyFileSync(path.join(RUNNER, 'launch.mjs'), path.join(dir2, 'launch.mjs'));
  fs.symlinkSync(path.join('releases', bad), path.join(dir2, 'current'));
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ current: bad, previous: good, lastGood: good, boots: [] }));
  const runEnv = env({ THREADBEAR_HOME: home2, THREADBEAR_PORT: '0' });

  for (let i = 0; i < 2; i++) {
    const r = spawnSync(NODE, [path.join(dir2, 'launch.mjs')], { env: runEnv, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /crashing on purpose/);
  }
  const third = spawn(NODE, [path.join(dir2, 'launch.mjs')], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  third.stdout.on('data', (d) => (text += d));
  third.stderr.on('data', (d) => (text += d));
  try {
    await waitFor('the third start to listen', () => /listening on/.test(text));
    assert.match(text, new RegExp(`failed to start 3 times in 10 minutes without being marked good; going back to ${good}`));
    assert.equal(await version(home2), `9.9.9+${good}`);
    const s = JSON.parse(fs.readFileSync(path.join(dir2, 'state.json'), 'utf8')) as State;
    assert.equal(path.basename(fs.readlinkSync(path.join(dir2, 'current'))), good);
    assert.equal(s.current, good);
    assert.equal(s.previous, bad);
    assert.equal(s.rolledBack?.from, bad);
    assert.deepEqual(
      s.boots.map((b) => b.release),
      [bad, bad, good],
    );
  } finally {
    third.kill('SIGTERM');
  }
});

test("launch.mjs still starts lastGood when it can't move the current link", { timeout: 60_000 }, async () => {
  const home4 = path.join(root, 'home4');
  const dir4 = path.join(home4, 'runner');
  fs.mkdirSync(path.join(dir4, 'releases'), { recursive: true });
  for (const id of [good, bad]) fs.cpSync(path.join(runnerDir(), 'releases', id), path.join(dir4, 'releases', id), { recursive: true });
  fs.copyFileSync(path.join(RUNNER, 'launch.mjs'), path.join(dir4, 'launch.mjs'));
  fs.symlinkSync(path.join('releases', bad), path.join(dir4, 'current'));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir4, 'state.json'), JSON.stringify({ current: bad, previous: good, lastGood: good, boots: [{ release: bad, at }, { release: bad, at }] }));
  // A folder it can't write in (a full disk would do the same).
  fs.chmodSync(dir4, 0o555);
  const third = spawn(NODE, [path.join(dir4, 'launch.mjs')], { env: env({ THREADBEAR_HOME: home4, THREADBEAR_PORT: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  third.stdout.on('data', (d) => (text += d));
  third.stderr.on('data', (d) => (text += d));
  try {
    await waitFor('the third start to listen', () => /listening on/.test(text));
    assert.match(text, /could not point current at the release it went back to/);
    assert.equal(await version(home4), `9.9.9+${good}`);
    assert.equal(path.basename(fs.readlinkSync(path.join(dir4, 'current'))), bad, 'the link is where it was');
  } finally {
    third.kill('SIGTERM');
    fs.chmodSync(dir4, 0o755);
  }
});

test('planBoot: the crash-loop rules', async () => {
  const launch = await import(pathToFileURL(path.join(RUNNER, 'launch.mjs')).href);
  const now = Date.parse('2026-10-26T10:00:00Z');
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const exists = () => true;
  const base = { current: 'B', previous: 'A', lastGood: 'A', boots: [] as { release: string; at: string }[] };

  let p = launch.planBoot({ ...base, boots: [{ release: 'B', at: ago(30) }] }, now, exists);
  assert.equal(p.start, 'B', 'a second start is still the new release');
  assert.equal(p.rolledBack, null);

  p = launch.planBoot({ ...base, boots: [{ release: 'B', at: ago(100) }, { release: 'B', at: ago(10) }] }, now, exists);
  assert.equal(p.start, 'A');
  assert.deepEqual(p.rolledBack, { from: 'B', to: 'A', at: new Date(now).toISOString() });
  assert.equal(p.state.current, 'A');
  assert.equal(p.state.previous, 'B');

  p = launch.planBoot({ ...base, boots: [{ release: 'B', at: ago(610) }, { release: 'B', at: ago(10) }] }, now, exists);
  assert.equal(p.start, 'B', 'boots older than 10 minutes do not count');

  // Three starts that each hung until the watchdog stopped them, 95 s apart.
  p = launch.planBoot({ ...base, boots: [{ release: 'B', at: ago(190) }, { release: 'B', at: ago(95) }] }, now, exists);
  assert.equal(p.start, 'A', 'starts that hang count too');

  // Planned restarts (runner.restart, launchctl kickstart) are clean stops.
  p = launch.planBoot({ ...base, boots: [{ release: 'B', at: ago(80), clean: true }, { release: 'B', at: ago(40), clean: true }] }, now, exists);
  assert.equal(p.start, 'B', 'clean restarts are not crashes');
  assert.equal(p.rolledBack, null);
  assert.equal(p.state.boots.at(-1).pid, process.pid, 'each boot records its pid, so its exit can mark it clean');

  p = launch.planBoot({ ...base, lastGood: 'B', boots: [{ release: 'B', at: ago(20) }, { release: 'B', at: ago(10) }] }, now, exists);
  assert.equal(p.start, 'B', 'a release marked good is not rolled back');
  assert.equal(p.stuck, false);

  p = launch.planBoot({ ...base, boots: [{ release: 'B', at: ago(20) }, { release: 'B', at: ago(10) }] }, now, () => false);
  assert.equal(p.start, 'B', 'lastGood has to still exist');
  assert.equal(p.stuck, true);

  // --rollback --force onto B, which crashed a few minutes ago: only the
  // boots since it was activated again count.
  p = launch.planBoot({ ...base, activated: { release: 'B', at: ago(5) }, boots: [{ release: 'B', at: ago(200) }, { release: 'B', at: ago(190) }] }, now, exists);
  assert.equal(p.start, 'B', 'fresh tries after a forced rollback');
  p = launch.planBoot({ ...base, activated: { release: 'B', at: ago(60) }, boots: [{ release: 'B', at: ago(30) }, { release: 'B', at: ago(10) }] }, now, exists);
  assert.equal(p.start, 'A', 'and it still goes back if it crashes again');
  p = launch.planBoot({ ...base, activated: { release: 'C', at: ago(5) }, boots: [{ release: 'B', at: ago(30) }, { release: 'B', at: ago(10) }] }, now, exists);
  assert.equal(p.start, 'A', "another release's activation doesn't count");

  const many = Array.from({ length: 25 }, (_, i) => ({ release: 'A', at: ago(1000 + i) }));
  p = launch.planBoot({ ...base, boots: many }, now, exists);
  assert.equal(p.state.boots.length, 20);
  assert.equal(p.state.boots.at(-1).release, 'B');
});

let died: string;

test('a release that dies a few seconds after it starts is caught, not reported as up', { timeout: 90_000 }, async () => {
  const running = current();
  await waitFor('lastGood', () => state().lastGood === running);
  // It answers the first hello, then exits: the health check alone passed it.
  commit({ crashAfterMs: 1000, goodAfterMs: -1 }, 'dies after starting');
  const r = deploy(['--skip-checks']);
  assert.equal(r.status, 1, out(r));
  died = releases().at(-1)!;
  assert.notEqual(died, running);
  assert.match(r.stdout, /Checking it stays up\.\.\. no\n/);
  assert.doesNotMatch(r.stdout, /The runner is up on/);
  assert.match(r.stderr, new RegExp(`The runner came up on ${died} but stopped again within \\d+ s\\.`));
  assert.match(r.stderr, new RegExp(`current points at ${running} again`));
  // launch.mjs says which release stopped and how, which the dying
  // release itself didn't.
  assert.match(r.stderr, new RegExp(`release ${died} exited with code 1 after \\d+ s, not marked good, so it counts as a failed start`));
  assert.equal(current(), running);
  await runsOn(running);
  assert.match(deploy(['--list']).stdout, new RegExp(`${died}\\s+crashed at startup`));
  // Shipping the same commit again is warned about before anything is built.
  const again = deploy(['--skip-checks', '--dry-run']);
  assert.equal(again.status, 0, out(again));
  assert.match(again.stdout, new RegExp(`Note: ${died}, built from this same commit, crashed at startup`));
});

test('pruning keeps the newest 5 releases plus lastGood, and drops crashed ones first', { timeout: 120_000 }, async () => {
  const lastGood = state().lastGood!;
  assert.equal(lastGood, good);
  const built: string[] = [];
  for (let i = 1; i <= 5; i++) {
    // Never marked good, so lastGood stays where it is.
    commit({ v: `p${i}`, goodAfterMs: -1 }, `prune ${i}`);
    const r = deploy(['--skip-checks']);
    assert.equal(r.status, 0, out(r));
    built.push(current());
  }
  await runsOn(built.at(-1)!);
  assert.equal(state().lastGood, lastGood);
  // Two releases crashed: only the newest is kept (for --rollback --force),
  // and neither counted towards the 5.
  assert.deepEqual(releases(), [lastGood, died, ...built].sort());
  assert.ok(!releases().includes(bad), 'the older crashing release is gone');
});

test('pruning keeps the release of a runner still finishing turns after a handover, until it exits', { timeout: 120_000 }, async () => {
  // The oldest release outside the newest 5: the next deploy would remove it.
  const doomed = releases().filter((id) => id !== state().lastGood && id !== died)[0];
  // A runner still finishing a turn on it, as a live process with the drain
  // file a real one writes (docs/protocol.md, "Handovers").
  const draining = spawn(NODE, ['-e', 'setTimeout(() => {}, 120_000)'], { stdio: 'ignore' });
  const drain = path.join(home, 'run', `drain-${draining.pid}.json`);
  fs.mkdirSync(path.dirname(drain), { recursive: true });
  fs.writeFileSync(drain, JSON.stringify({ pid: draining.pid, port: 1, version: `9.9.9+${doomed}`, release: doomed, since: new Date().toISOString(), threads: ['t1'] }));
  try {
    commit({ v: 'drain1', goodAfterMs: -1 }, 'while one drains');
    let r = deploy(['--skip-checks', '--dry-run']);
    assert.doesNotMatch(r.stdout, new RegExp(`Would remove: .*${doomed}`), out(r));
    r = deploy(['--skip-checks']);
    assert.equal(r.status, 0, out(r));
    assert.ok(releases().includes(doomed), `kept while its runner runs\n${out(r)}`);
    // Once that runner has exited, the next deploy removes it as usual.
    draining.kill();
    await waitFor('the draining runner to exit', () => !alive(draining.pid!));
    commit({ v: 'drain2', goodAfterMs: -1 }, 'after it exits');
    r = deploy(['--skip-checks']);
    assert.equal(r.status, 0, out(r));
    assert.ok(!releases().includes(doomed), `removed once its runner is gone\n${out(r)}`);
    await runsOn(current());
  } finally {
    draining.kill();
    fs.rmSync(drain, { force: true });
  }
});

test('--list and --dry-run change nothing', { timeout: 60_000 }, async () => {
  let r = deploy(['--list']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, new RegExp(`\\* ${current()}\\s+current`));
  assert.match(r.stdout, new RegExp(`${state().lastGood}\\s+last good`));
  assert.match(r.stdout, new RegExp(`Running: 9\\.9\\.9\\+${current()}`));

  commit({ v: 'dry' }, 'dry run');
  const [ids, link, s] = [releases(), current(), fs.readFileSync(path.join(runnerDir(), 'state.json'), 'utf8')];
  r = deploy(['--dry-run']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Would build \S+-[0-9a-f]+ from/);
  assert.match(r.stdout, /Would restart: ask the runner/);
  assert.deepEqual(releases(), ids);
  assert.equal(current(), link);
  assert.equal(fs.readFileSync(path.join(runnerDir(), 'state.json'), 'utf8'), s);
});

test('no deploy to a LaunchAgent that runs a checkout, or to none', () => {
  const home3 = path.join(root, 'home3');
  const label = `${LABEL}.checkout`;
  fs.writeFileSync(
    path.join(agents, `${label}.plist`),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${NODE}</string><string>/x/runner/src/main.ts</string></array></dict></plist>\n`,
  );
  try {
    let r = sh('deploy-runner.sh', ['--home', home3, '--label', label, '--dry-run']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /runs from a checkout/);
    assert.match(r.stderr, /Install it with scripts\/install-runner\.sh --home/);
    // From a thread of that runner it's Mike's to do, not the agent's.
    r = sh('deploy-runner.sh', ['--home', home3, '--label', label, '--dry-run'], { THREADBEAR_THREAD_ID: 't', THREADBEAR_RUNNER_HOME: home3 });
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /the user has to switch it to releases once, from a terminal/);
    assert.match(r.stderr, /Don't run that from a thread/);
    r = sh('deploy-runner.sh', ['--home', home3, '--label', `${LABEL}.none`, '--dry-run']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /isn't installed as a LaunchAgent/);
    // No --label: the hint names a sandbox label, not the real runner's
    // (which install-runner.sh refuses for another data dir).
    r = sh('deploy-runner.sh', ['--home', home3, '--dry-run']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /--label com\.mikerosoft\.threadbear\.runner\.devtest, which builds/);
  } finally {
    fs.rmSync(path.join(agents, `${label}.plist`));
  }
});

test('install-runner.sh guards: sandbox labels, and not from inside its own thread', () => {
  let r = sh('install-runner.sh', ['--home', home, '--print']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs its own --label/);
  r = sh('install-runner.sh', ['--label', LABEL, '--print']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /give a second runner its own --home/);
  r = sh('install-runner.sh', ['--home', home, '--label', LABEL], { THREADBEAR_THREAD_ID: 'thread-1', THREADBEAR_HOME: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Ask the user to run it from a terminal/);
  // THREADBEAR_HOME doesn't pick install-runner.sh's data dir; saying so
  // beats reinstalling the real runner.
  // (--print, so a broken guard could only print the real runner's plist.)
  r = sh('install-runner.sh', ['--print'], { THREADBEAR_HOME: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only goes by --home/);
  // A busy runner isn't replaced (or removed) without --force.
  setBusy(['t-9']);
  r = sh('install-runner.sh', ['--home', home, '--label', LABEL, '--port', '0', '--path', '/usr/bin:/bin']);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /1 thread would be cut short/);
  assert.match(r.stderr, /while threads are busy/);
  r = sh('install-runner.sh', ['--uninstall', '--home', home, '--label', LABEL]);
  assert.equal(r.status, 1, out(r));
  setBusy([]);
  assert.equal(launchctl('print', TARGET), 0, 'still installed');
});

test('reinstalling checks everything first, builds from HEAD, and puts the old setup back if the new one fails', { timeout: 240_000 }, async () => {
  const installed = path.join(runnerDir(), 'launch.mjs');
  const plistFile = path.join(agents, `${LABEL}.plist`);
  const plistPath = () => JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', plistFile], { encoding: 'utf8' }).stdout).EnvironmentVariables.PATH as string;
  const install = (args: string[] = []) => sh('install-runner.sh', ['--home', home, '--label', LABEL, '--port', '0', '--path', '/usr/bin:/bin', ...args]);
  const launchSrc = path.join(rdir, 'launch.mjs');
  const pristine = fs.readFileSync(launchSrc, 'utf8');
  const oldLaunch = fs.readFileSync(installed, 'utf8');
  const before = current();
  await runsOn(before);

  // A launch.mjs change on main while a thread is busy: refused before
  // launch.mjs or anything else changes.
  fs.writeFileSync(launchSrc, pristine + '\n// a change\n');
  commit({ v: 'launch change', goodAfterMs: 1500 }, 'launch.mjs change');
  setBusy(['t-9']);
  let r = install();
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /while threads are busy/);
  assert.equal(fs.readFileSync(installed, 'utf8'), oldLaunch, 'launch.mjs untouched');
  assert.equal(current(), before, 'no release built');
  setBusy([]);

  // Unmerged work: refused unless --allow-branch.
  git('checkout', '-q', '-b', 'reinstall-branch');
  commit({ v: 'branch' }, 'unmerged');
  r = install();
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /has commits that aren't on main/);
  assert.match(r.stderr, /pass --allow-branch/);
  git('checkout', '-q', 'main');
  git('branch', '-q', '-D', 'reinstall-branch');

  // A launch.mjs that doesn't load: refused, nothing changed. (deploy.mjs
  // imports it too, so this has to come before anything runs that.)
  fs.writeFileSync(launchSrc, pristine + '\nthis is not javascript(\n');
  let broke: Run;
  try {
    r = install();
    broke = sh('install-runner.sh', ['--uninstall', '--home', home, '--label', LABEL]);
  } finally {
    git('checkout', '--', 'runner/launch.mjs');
  }
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /launch\.mjs doesn't load, so nothing was changed/);
  assert.doesNotMatch(r.stderr, /should run main|threads are busy/);
  assert.equal(fs.readFileSync(installed, 'utf8'), oldLaunch);
  assert.equal(broke.status, 1, out(broke));
  assert.match(broke.stderr, /launch\.mjs doesn't load \(above\), so this can't check whether threads are busy/);
  assert.equal(launchctl('print', TARGET), 0, 'still installed');

  // Idle, from main: current was built before HEAD, so a new release is
  // built, and the install waits for it to be marked good.
  r = install();
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, new RegExp(`Release ${before} wasn't built from HEAD, so building one that is`));
  assert.match(r.stdout, /Waiting for it to stay up long enough to be marked good/);
  assert.match(r.stdout, /has been marked good/);
  const rebuilt = current();
  assert.notEqual(rebuilt, before);
  assert.equal(readJson(path.join(runnerDir(), 'releases', rebuilt, 'release.json')).commit, git('rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(launchSrc, 'utf8'));
  for (const f of ['previous-launchagent.plist', 'previous-launch.mjs']) assert.ok(!fs.existsSync(path.join(runnerDir(), f)), f);
  // The launcher app is left as it is unless launcher/ changed.
  assert.match(r.stdout, /Keeping .*Threadbear Runner\.app, built from launcher\/ as it is/);
  assert.doesNotMatch(r.stdout, /Built .*Threadbear Runner\.app/);
  await runsOn(rebuilt);

  // A launcher change: the app is rebuilt and the job restarts on it.
  const app = path.join(runnerDir(), 'Threadbear Runner.app');
  const appBuild = () => readJson(path.join(app, 'Contents', 'Resources', 'build.json')).sources as string;
  const launcherSrc = path.join(rdir, 'launcher', 'main.swift');
  const launcherPristine = fs.readFileSync(launcherSrc, 'utf8');
  const launcherHash = () => sh('../launcher/build-launcher.sh', ['--hash']).stdout.trim();
  const hashBefore = launcherHash();
  assert.equal(appBuild(), hashBefore);
  fs.writeFileSync(launcherSrc, launcherPristine + '\n// a launcher change\n');
  commit({ v: 'launcher change' }, 'launcher change');
  assert.notEqual(launcherHash(), hashBefore);
  r = install();
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Threadbear Runner\.app was built from older sources/);
  assert.match(r.stdout, /Built .*Threadbear Runner\.app/);
  assert.equal(appBuild(), launcherHash());
  assert.ok(!fs.existsSync(path.join(runnerDir(), '.Threadbear Runner.app.old')), 'the old app is gone once the install succeeded');
  await runsOn(current());
  const rebuiltApp = appBuild();

  // Another launcher change (a commit, so a release is built from it too),
  // but launchd won't load the new plist: the old plist, release and app
  // all go back.
  const keptRelease = current();
  fs.writeFileSync(launcherSrc, launcherPristine + '\n// another launcher change\n');
  commit({ v: 'launcher change 2' }, 'another launcher change');
  fs.writeFileSync(path.join(launchd, 'fail-bootstrap'), '/fail/here');
  try {
    r = install(['--path', '/fail/here:/usr/bin:/bin']);
  } finally {
    fs.rmSync(path.join(launchd, 'fail-bootstrap'));
    fs.writeFileSync(launcherSrc, launcherPristine + '\n// a launcher change\n');
    commit({ v: 'launcher change' }, 'launcher back');
  }
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /Built .*Threadbear Runner\.app/);
  assert.match(r.stderr, new RegExp(`current points at ${keptRelease} again`));
  assert.equal(current(), keptRelease);
  assert.match(r.stderr, /Bootstrap failed: 5: Input\/output error/);
  assert.match(r.stderr, /launchd wouldn't load the new plist\.\n.*Threadbear Runner\.app is the one from before again\.\nPutting back the LaunchAgent as it was\./);
  assert.match(r.stderr, /Back as it was/);
  assert.ok(!plistPath().includes('/fail/here'), 'the old plist is back');
  assert.equal(appBuild(), rebuiltApp, 'the app from before is back');
  assert.ok(!fs.existsSync(path.join(runnerDir(), '.Threadbear Runner.app.old')));
  assert.deepEqual(fs.readdirSync(agents).filter((f) => f.startsWith(`${LABEL}.plist.`)), [], 'no temp plist left in LaunchAgents');
  await runsOn(current());
  assert.equal(appBuild(), launcherHash(), 'launcher/ is back to what the app was built from');

  // A launch.mjs that loads but can't start a runner, with a new release:
  // the old launch.mjs, plist and current all go back.
  const broken = pristine.replace('if (isMain()) {', "if (isMain()) {\n  throw new Error('launch.mjs broken on purpose');\n}\nif (false) {");
  assert.notEqual(broken, pristine);
  fs.writeFileSync(launchSrc, broken);
  commit({ v: 'broken launch' }, 'broken launch.mjs');
  const kept = fs.readFileSync(installed, 'utf8');
  const keptCurrent = current();
  try {
    r = install();
  } finally {
    fs.writeFileSync(launchSrc, pristine);
    commit({ v: 'launch fixed' }, 'launch.mjs back');
  }
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /The runner didn't come up and stay up on its release\./);
  assert.match(r.stderr, new RegExp(`current points at ${keptCurrent} again`));
  assert.match(r.stderr, /Back as it was/);
  assert.equal(fs.readFileSync(installed, 'utf8'), kept, 'the old launch.mjs is back');
  assert.equal(current(), keptCurrent);
  for (const f of ['previous-launchagent.plist', 'previous-launch.mjs']) assert.ok(!fs.existsSync(path.join(runnerDir(), f)), f);
  await runsOn(keptCurrent);
});

test('--check gives up once a runner that stopped before it was marked good stays down', { timeout: 120_000 }, async () => {
  const good = current();
  await waitFor('lastGood', () => state().lastGood === good);
  const plistFile = path.join(agents, `${LABEL}.plist`);
  // A release that never gets marked good, running under launchd.
  commit({ goodAfterMs: -1 }, 'never good');
  // Built the way the runner's updater builds (from its own clone, naming
  // the checkout it follows), so the release records that checkout.
  const followed = path.join(home, 'followed-checkout');
  let r = deploy(['--skip-checks', '--no-restart', '--follow', followed]);
  assert.equal(r.status, 0, out(r));
  const never = current();
  assert.notEqual(never, good);
  assert.equal(readJson(path.join(runnerDir(), 'releases', never, 'release.json')).checkout, followed);
  assert.equal(launchctl('kickstart', '-k', TARGET), 0);
  await runsOn(never);

  const bg = deployInBackground(['--check']);
  await waitFor('the good wait to start', () => /Waiting for it to stay up long enough/.test(bg.output()));
  // The runner goes down and nothing brings it back.
  const started = Date.now();
  assert.equal(launchctl('bootout', TARGET), 0);
  r = await bg.done;
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, new RegExp(`The runner on ${never} stopped before it was marked good and hasn't come back in 30 s\\.`));
  assert.ok(Date.now() - started < 60_000, 'said after the health window, not the whole good wait');

  // Back on the good release for the tests after this.
  assert.equal(launchctl('bootstrap', `gui/${process.getuid!()}`, plistFile), 0);
  await runsOn(never);
  r = deploy(['--rollback', '--now']);
  assert.equal(r.status, 0, out(r));
  await runsOn(good);
});

test('a handover: the new release starts beside the old runner, which exits once its threads are done', { timeout: 120_000 }, async () => {
  commit({ handover: true }, 'hands over');
  let r = deploy(['--skip-checks', '--now']);
  assert.equal(r.status, 0, out(r));
  const old = current();
  await runsOn(old);
  const oldPid: number = (await status()).pid;
  setBusy(['t1']);
  commit({ handover: true, next: true }, 'the next one');
  r = deploy(['--skip-checks']);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /taking over now; 1 busy thread finishes on the old one first/);
  const next = current();
  assert.notEqual(next, old);
  await runsOn(next);
  // Both run: the old one finishing t1, the new one on the port.
  const reply = readJson(path.join(home, `fake-handover-${oldPid}.json`));
  assert.equal(reply.ok, true);
  assert.notEqual(reply.pid, oldPid);
  assert.ok(alive(oldPid), 'the old runner is still finishing');
  setBusy([]);
  await waitFor('the old runner to exit', () => !alive(oldPid));
  // Its exit isn't a restart: the new one stays up.
  await sleep(1500);
  assert.equal((await status()).pid, reply.pid);
  assert.ok(state().boots.some((b: any) => b.pid === oldPid && b.clean), 'its exit counts as clean');
});

test('uninstall boots the job out and removes the plist', { timeout: 30_000 }, async () => {
  const sup = Number(fs.readFileSync(path.join(launchd, 'supervisor.pid'), 'utf8'));
  const r = sh('install-runner.sh', ['--uninstall', '--home', home, '--label', LABEL]);
  assert.equal(r.status, 0, out(r));
  assert.ok(!fs.existsSync(path.join(agents, `${LABEL}.plist`)));
  assert.notEqual(launchctl('print', TARGET), 0);
  assert.throws(() => process.kill(sup, 0), 'the keep-alive loop is gone');
  assert.equal(await version(), null);
  assert.ok(fs.existsSync(path.join(runnerDir(), 'current')), 'releases stay');
  // So do the app and the privacy grants macOS tied to it.
  assert.ok(fs.existsSync(path.join(runnerDir(), 'Threadbear Runner.app')));
  assert.match(r.stdout, /Threadbear Runner\.app stays/);
});

test('a first install whose runner never comes up is removed again, not left crash-looping', { timeout: 120_000 }, async () => {
  // A data dir nothing has installed into: no launch.mjs or releases to go back to.
  const homeFresh = path.join(root, 'home-fresh');
  const plistFile = path.join(agents, `${LABEL}.plist`);
  // Passes the smoke test, crashes under launch.mjs: nothing marks it good.
  commit({ crash: 'launched' }, 'crashes once installed');
  let r: Run;
  try {
    r = sh('install-runner.sh', ['--home', homeFresh, '--label', LABEL, '--port', '0', '--path', '/usr/bin:/bin']);
  } finally {
    commit({}, 'back');
  }
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /The runner didn't come up and stay up on its release\./);
  assert.match(r.stderr, new RegExp(`There was no LaunchAgent before to go back to, so ${LABEL.replace(/\\./g, '\\\\.')} is removed again`));
  assert.ok(!fs.existsSync(plistFile), 'the plist is gone');
  assert.notEqual(launchctl('print', TARGET), 0, 'the job is booted out');
  assert.ok(!fs.existsSync(path.join(homeFresh, 'runner', 'launch.mjs')), `launch.mjs is gone, so deploy-runner.sh says to install
${out(r)}`);
  assert.equal(fs.readdirSync(path.join(homeFresh, 'runner', 'releases')).filter((n) => ID_RE.test(n)).length, 1, 'the release stays');
  assert.ok(!fs.existsSync(path.join(launchd, 'supervisor.pid')) || (() => { try { process.kill(Number(fs.readFileSync(path.join(launchd, 'supervisor.pid'), 'utf8')), 0); return false; } catch { return true; } })(), 'no keep-alive loop left');
});
