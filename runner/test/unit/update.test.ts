import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import type { UpdateFailure } from '../../src/fix-update.ts';
import { nullLogger } from '../../src/log.ts';
import { CHECK_INTERVAL_MS, FIRST_CHECK_MS, SOON_MS, RunnerUpdater, launcherDiffers, launchAgentBehind, launcherSourcesHash, appOfExecutable, updateDir, watchMainRef, decideUpdate, failedAlready, releaseTreeAt, syncClone, updateFilePath, type UpdateDeps } from '../../src/update.ts';
import type { ReleaseJson } from '../../src/release.ts';
import { patiently } from '../helpers/patience.ts';

const running = { id: 'r1', tree: 'a+b+c+d' };
const none = { pendingRestart: false, crashedTrees: new Set<string>() };

test('decideUpdate: builds only when main differs and nothing stands in the way', () => {
  assert.deepEqual(decideUpdate({ mainTree: 'a+b+c+d', running, ...none }), { action: 'nothing', why: 'up to date with main' });
  assert.deepEqual(decideUpdate({ mainTree: 'x+b+c+d', running, ...none }), { action: 'build' });
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', running: { id: 'r1' }, ...none }).action, 'nothing', 'unknown tree');
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', running, ...none, pendingRestart: true }).action, 'nothing');
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', running, current: 'r2', ...none }).action, 'nothing', 'another release waits to start');
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', running, current: 'r1', ...none }).action, 'build');
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', running, ...none, failed: { tree: 'x+b+c+d' } }).action, 'nothing', 'failed before');
  assert.equal(decideUpdate({ mainTree: 'y+b+c+d', running, ...none, failed: { tree: 'x+b+c+d' } }).action, 'build', 'main moved on');
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', running, ...none, crashedTrees: new Set(['x+b+c+d']) }).action, 'nothing', 'crashed before');
  // A failure is kept with the whole of runner/: a fix to a test alone is built again.
  const failed = { tree: 'x+b+c+d', buildTree: 'B1' };
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', mainBuildTree: 'B1', running, ...none, failed }).action, 'nothing', 'same build tree');
  assert.equal(decideUpdate({ mainTree: 'x+b+c+d', mainBuildTree: 'B2', running, ...none, failed }).action, 'build', 'only a test changed');
});

test('failedAlready: by the whole of runner/ when both have it, by the release tree for older update.json files', () => {
  assert.equal(failedAlready(undefined, { tree: 't' }), false);
  assert.equal(failedAlready({ tree: 't', buildTree: 'B1' }, { tree: 't', buildTree: 'B1' }), true);
  assert.equal(failedAlready({ tree: 't', buildTree: 'B1' }, { tree: 't', buildTree: 'B2' }), false);
  assert.equal(failedAlready({ tree: 't' }, { tree: 't', buildTree: 'B2' }), true, 'written before buildTree was kept');
  assert.equal(failedAlready({ tree: 't' }, { tree: 'u', buildTree: 'B2' }), false);
});

// A throwaway repo laid out like this one: runner/src, runner/bin and the
// package files, so the release tree formula has something to hash.
function makeRepo(): { repo: string; first: string; commit: (msg: string, file?: string, text?: string) => string } {
  const repo = tmpDir('tb-update-repo-');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Update Test',
    GIT_AUTHOR_EMAIL: 'update-test@example.com',
    GIT_COMMITTER_NAME: 'Update Test',
    GIT_COMMITTER_EMAIL: 'update-test@example.com',
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.mkdirSync(path.join(repo, 'runner', 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'runner', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'runner', 'src', 'main.ts'), 'console.log(1)\n');
  fs.writeFileSync(path.join(repo, 'runner', 'bin', 'tb'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(repo, 'runner', 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(repo, 'runner', 'package-lock.json'), '{"name":"x","lockfileVersion":3}\n');
  fs.writeFileSync(path.join(repo, 'runner', 'README.md'), 'docs\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git('init', '-q', '-b', 'main');
  const commit = (msg: string, file?: string, text?: string) => {
    if (file) fs.writeFileSync(path.join(repo, file), text ?? '');
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const first = commit('first');
  return { repo, first, commit };
}

test('syncClone brings a clone to main and reports its release tree; docs and tests do not change it', async () => {
  const { repo, first, commit } = makeRepo();
  const dir = path.join(tmpDir('tb-update-clone-'), 'src');
  const a = await syncClone(repo, 'runner/', dir);
  assert.equal(a.commit, first);
  assert.equal(a.tree, releaseTreeAt(repo, 'runner/', 'HEAD'));
  assert.equal(a.subject, 'first');
  // Only tests and docs changed: the same tree.
  commit('docs', 'runner/README.md', 'more docs\n');
  const b = await syncClone(repo, 'runner/', dir);
  assert.notEqual(b.commit, a.commit);
  assert.equal(b.tree, a.tree);
  // ...but the whole of runner/ did, which is what a failed build is kept by.
  assert.ok(a.buildTree && b.buildTree);
  assert.notEqual(b.buildTree, a.buildTree);
  // A source change: a new tree, and the clone has it.
  const third = commit('code', 'runner/src/main.ts', 'console.log(2)\n');
  const c = await syncClone(repo, 'runner/', dir);
  assert.equal(c.commit, third);
  assert.notEqual(c.tree, a.tree);
  assert.equal(fs.readFileSync(path.join(dir, 'runner', 'src', 'main.ts'), 'utf8'), 'console.log(2)\n');
  // Uncommitted work in the checkout never reaches the clone.
  fs.writeFileSync(path.join(repo, 'runner', 'src', 'main.ts'), 'console.log(3)\n');
  const d = await syncClone(repo, 'runner/', dir);
  assert.equal(d.tree, c.tree);
  assert.equal(fs.readFileSync(path.join(dir, 'runner', 'src', 'main.ts'), 'utf8'), 'console.log(2)\n');
  // node_modules in the clone survives a sync, and goes when the lock changes.
  fs.mkdirSync(path.join(dir, 'runner', 'node_modules', 'left'), { recursive: true });
  await syncClone(repo, 'runner/', dir);
  assert.ok(fs.existsSync(path.join(dir, 'runner', 'node_modules', 'left')));
  commit('lock', 'runner/package-lock.json', '{"name":"x","lockfileVersion":3,"v":2}\n');
  await syncClone(repo, 'runner/', dir);
  assert.ok(!fs.existsSync(path.join(dir, 'runner', 'node_modules')));
  assert.equal(releaseTreeAt(repo, 'runner/', 'nonsense'), undefined);
});

type Harness = {
  u: RunnerUpdater;
  clock: FakeClock;
  home: string;
  notices: string[];
  restarts: { release: string; reason: string }[];
  deploys: number;
  follows: string[];
  main: { commit: string; short: string; subject: string; tree: string; buildTree?: string };
  deployResult: { ok: true; id: string } | { ok: false; error: string; transient?: boolean };
  backendDeploys: string[];
  backendResult: { ok: boolean; error?: string };
  pending: boolean;
};

function harness(releaseExtra: Partial<ReleaseJson> = {}, depsExtra: Partial<UpdateDeps> = {}): Harness {
  const home = tmpDir('tb-update-home-');
  const checkout = tmpDir('tb-update-checkout-');
  fs.mkdirSync(path.join(checkout, '.git'));
  fs.mkdirSync(path.join(home, 'runner', 'releases', 'r1'), { recursive: true });
  fs.symlinkSync(path.join('releases', 'r1'), path.join(home, 'runner', 'current'));
  fs.writeFileSync(path.join(home, 'runner', 'state.json'), JSON.stringify({ current: 'r1', previous: null, lastGood: 'r1', boots: [] }));
  const release: ReleaseJson = { id: 'r1', commit: 'c1', dirty: false, builtAt: '2026-10-27T00:00:00Z', node: '24', checkout, prefix: 'runner/', tree: 'a+b+c+d', ...releaseExtra };
  const h: Omit<Harness, 'u'> = {
    clock: new FakeClock(),
    home,
    notices: [] as string[],
    restarts: [] as { release: string; reason: string }[],
    deploys: 0,
    follows: [] as string[],
    main: { commit: 'c2', short: 'c2', subject: 'Steering', tree: 'x+b+c+d' },
    deployResult: { ok: true, id: 'r2' },
    backendDeploys: [] as string[],
    backendResult: { ok: true } as { ok: boolean; error?: string },
    pending: false,
  };
  const u = new RunnerUpdater({
    home,
    release,
    enabled: true,
    clock: h.clock,
    log: nullLogger,
    notice: (_l, m) => h.notices.push(m),
    restart: (p) => {
      h.restarts.push({ release: p.release, reason: p.reason });
      h.pending = true;
      return { scheduled: true, waitingFor: ['t1'] };
    },
    pendingRestart: () => h.pending,
    // Not the environment these tests happen to run in (inside a thread it
    // is a supervised runner's).
    env: {},
    sync: async () => h.main,
    deployBackend: async (_repo, _runnerDir, _home, commit) => {
      h.backendDeploys.push(commit);
      return h.backendResult;
    },
    deploy: async (_dir, _home, _log, follow) => {
      h.deploys++;
      h.follows.push(follow);
      if (h.deployResult.ok) {
        // As deploy.mjs would: a new release, current pointing at it.
        fs.mkdirSync(path.join(home, 'runner', 'releases', h.deployResult.id), { recursive: true });
        fs.rmSync(path.join(home, 'runner', 'current'));
        fs.symlinkSync(path.join('releases', h.deployResult.id), path.join(home, 'runner', 'current'));
      }
      return h.deployResult;
    },
    ...depsExtra,
  });
  return Object.assign(h, { u });
}

test('a change to main is built and a restart asked for; the next check sees the release waiting', async () => {
  const h = harness();
  h.u.start();
  assert.equal(h.u.status().state, 'idle');
  h.clock.advance(FIRST_CHECK_MS);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.deploys, 1);
  // The new release follows the same checkout, not the clone it was built in.
  assert.deepEqual(h.follows, [h.u.status().checkout]);
  assert.deepEqual(h.restarts, [{ release: 'r2', reason: 'Updating to main at c2: Steering' }]);
  const s = h.u.status();
  assert.equal(s.state, 'waiting');
  assert.equal(s.release, 'r2');
  assert.equal(s.commit, 'c2');
  // Still waiting for the restart: nothing more is built.
  h.clock.advance(CHECK_INTERVAL_MS);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.deploys, 1);
});

test('a failed build or backend deploy goes to a fix thread instead of the notice, and to the notice when that fails', async () => {
  const failures: UpdateFailure[] = [];
  let handle: () => boolean = () => true;
  const h = harness({}, { onFailed: (f) => (failures.push(f), handle()) });
  h.deployResult = { ok: false, error: 'Unit tests failed' };
  h.u.start();
  await h.u.check();
  assert.equal(h.notices.length, 0, 'no banner');
  assert.equal(failures.length, 1);
  assert.deepEqual({ ...failures[0], logFile: undefined }, { kind: 'build', commit: 'c2', short: 'c2', subject: 'Steering', error: 'Unit tests failed', logFile: undefined });
  assert.equal(h.u.status().state, 'failed', 'the failure still shows in status');
  // The backend at a newer main, and a thread that can't be started.
  h.main = { commit: 'c3', short: 'c3', subject: 'Schema', tree: 'y+b+c+d' };
  h.backendResult = { ok: false, error: 'convex deploy failed' };
  handle = () => {
    throw new Error('no thread');
  };
  await h.u.check();
  assert.equal(failures.at(-1)!.kind, 'backend');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /Convex backend couldn't be deployed at main c3/);
});

test('main at the same tree, or only tests and docs changed, is left alone', async () => {
  const h = harness();
  h.main = { ...h.main, commit: 'c9', short: 'c9', tree: 'a+b+c+d' };
  h.u.start();
  const d = await h.u.check();
  assert.deepEqual(d, { action: 'nothing', why: 'up to date with main' });
  assert.equal(h.deploys, 0);
  assert.equal(h.u.status().state, 'idle');
  assert.equal(h.u.status().commit, 'c9');
});

test('a failed build is said once and not tried again until main moves on', async () => {
  const h = harness();
  h.deployResult = { ok: false, error: 'Unit tests failed; the whole output is in /tmp/x.log' };
  h.u.start();
  await h.u.check();
  assert.equal(h.deploys, 1);
  assert.equal(h.u.status().state, 'failed');
  assert.match(h.u.status().reason!, /Unit tests failed/);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /couldn't update to main at c2 \(Steering\): Unit tests failed/);
  assert.equal(JSON.parse(fs.readFileSync(updateFilePath(h.home), 'utf8')).failed.tree, 'x+b+c+d');
  await h.u.check();
  assert.equal(h.deploys, 1, 'not retried');
  assert.equal(h.u.status().state, 'failed', 'the failure stays on show');
  assert.equal(h.notices.length, 1);
  // A fix on main: built again.
  h.main = { commit: 'c3', short: 'c3', subject: 'Fix', tree: 'z+b+c+d' };
  h.deployResult = { ok: true, id: 'r3' };
  await h.u.check();
  assert.equal(h.deploys, 2);
  assert.equal(h.u.status().state, 'waiting');
});

test('a build that failed its checks is tried again when only a test is fixed', async () => {
  const h = harness();
  h.main = { ...h.main, buildTree: 'B1' };
  h.deployResult = { ok: false, error: 'Unit tests failed; the whole output is in /tmp/x.log' };
  h.u.start();
  await h.u.check();
  assert.equal(JSON.parse(fs.readFileSync(updateFilePath(h.home), 'utf8')).failed.buildTree, 'B1');
  await h.u.check();
  assert.equal(h.deploys, 1, 'not retried while nothing changed');
  // The test fixed on main: the release paths are the same, runner/ isn't.
  h.main = { ...h.main, commit: 'c3', short: 'c3', subject: 'Fix the test', buildTree: 'B2' };
  h.deployResult = { ok: true, id: 'r3' };
  await h.u.check();
  assert.equal(h.deploys, 2);
  assert.equal(h.u.status().state, 'waiting');
});

test('a deploy that could not run now (another deploy holds the lock) is tried again next time', async () => {
  const h = harness();
  h.deployResult = { ok: false, error: 'Another deploy (pid 5) is working on it', transient: true };
  h.u.start();
  await h.u.check();
  assert.equal(h.u.status().state, 'idle');
  assert.equal(h.notices.length, 0);
  assert.ok(!fs.existsSync(updateFilePath(h.home)));
  await h.u.check();
  assert.equal(h.deploys, 2);
});

test('a tree whose release crashed at startup is not built again', async () => {
  const h = harness();
  fs.mkdirSync(path.join(h.home, 'runner', 'releases', 'r0'), { recursive: true });
  fs.writeFileSync(path.join(h.home, 'runner', 'releases', 'r0', 'release.json'), JSON.stringify({ id: 'r0', commit: 'c2', dirty: false, builtAt: '', node: '24', tree: 'x+b+c+d' }));
  fs.writeFileSync(path.join(h.home, 'runner', 'state.json'), JSON.stringify({ current: 'r1', previous: 'r0', lastGood: 'r1', boots: [], rolledBack: { from: 'r0', to: 'r1', at: '2026-10-27T00:00:00Z' } }));
  h.u.start();
  const d = await h.u.check();
  assert.equal(d?.action, 'nothing');
  assert.match((d as { why: string }).why, /crashed at startup/);
  assert.equal(h.deploys, 0);
});

test('a release with no tree recorded works it out from its commit', async () => {
  const h = harness({ tree: undefined }, { treeOf: (_dir, _prefix, commit) => (commit === 'c1' ? 'a+b+c+d' : undefined) });
  h.u.start();
  await h.u.check();
  assert.equal(h.deploys, 1);
});

test('off: from a checkout, when switched off, when the release has no checkout, when the checkout is gone, or when it is the updater\'s own clone', () => {
  const base = { home: tmpDir('tb-update-off-'), enabled: true, clock: new FakeClock(), log: nullLogger, notice: () => {}, restart: () => ({ scheduled: true, waitingFor: [] }), pendingRestart: () => false };
  const release: ReleaseJson = { id: 'r1', commit: 'c1', dirty: false, builtAt: '', node: '24', checkout: '/nonexistent/checkout', prefix: 'runner/', tree: 't' };
  const cases: [Partial<UpdateDeps>, RegExp][] = [
    [{}, /checkout, not a release/],
    [{ release, enabled: false }, /followMain is off/],
    [{ release: { ...release, checkout: undefined } }, /deploy once by hand/],
    [{ release }, /is gone/],
  ];
  for (const [extra, why] of cases) {
    const u = new RunnerUpdater({ ...base, ...extra });
    u.start();
    assert.equal(u.status().state, 'off');
    assert.match(u.status().reason!, why);
  }
  // A release that names the updater's own clone would only ever fetch
  // itself (27 Oct: stuck "up to date" for hours while main moved on).
  const clone = path.join(base.home, 'runner', 'update', 'src');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const selfFollowing = new RunnerUpdater({ ...base, release: { ...release, checkout: clone } });
  selfFollowing.start();
  assert.equal(selfFollowing.status().state, 'off');
  assert.match(selfFollowing.status().reason!, /updater's own clone/);
  // Before start() (the release isn't marked good yet) it says so, rather
  // than looking switched off; once following, there is no reason to show.
  const fresh = new RunnerUpdater({ ...base, release: { ...release, checkout: base.home } });
  assert.equal(fresh.status().state, 'off');
  assert.match(fresh.status().reason!, /not until this release has been marked good/);
  fs.mkdirSync(path.join(base.home, '.git'), { recursive: true });
  fresh.start();
  assert.equal(fresh.status().state, 'idle');
  assert.equal(fresh.status().reason, undefined);
  fresh.stop();
});

test('main moving in the checkout is checked within seconds, not at the next five-minute look', async () => {
  let fire = () => {};
  const changes: number[] = [];
  const h = harness({}, { watch: (_checkout, onChange) => ((fire = onChange), () => {}), onChange: () => changes.push(1) });
  // Up to date to begin with.
  h.main = { ...h.main, tree: 'a+b+c+d' };
  h.u.start();
  h.clock.advance(FIRST_CHECK_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.deploys, 0);
  // A merge lands: two ref writes close together make one check.
  h.main = { commit: 'c3', short: 'c3', subject: 'Faster', tree: 'z+b+c+d' };
  fire();
  h.clock.advance(1000);
  fire();
  h.clock.advance(SOON_MS);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(h.deploys, 1);
  assert.deepEqual(h.restarts, [{ release: 'r2', reason: 'Updating to main at c3: Faster' }]);
  assert.equal(h.u.status().subject, 'Faster');
  assert.ok(changes.length >= 3, 'tells main.ts as it goes');
  h.u.stop();
});

test('watchMainRef hears a commit on main, from a worktree too', async () => {
  const { repo, commit } = makeRepo();
  let heard = 0;
  const stop = watchMainRef(repo, () => heard++);
  try {
    commit('second', 'notes.md', 'hello');
    await patiently(() => heard > 0);
    assert.ok(heard > 0, 'a commit in the checkout');
    const wt = path.join(tmpDir('tb-update-wt-'), 'wt');
    const added = spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', wt], { encoding: 'utf8' });
    assert.equal(added.status, 0, `${added.stdout}${added.stderr}${added.error ?? ''}`);
    heard = 0;
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
    spawnSync('git', ['-C', wt, 'commit', '-q', '--allow-empty', '-m', 'from a worktree'], { env });
    spawnSync('git', ['-C', wt, 'update-ref', 'refs/heads/main', 'HEAD'], { env });
    await patiently(() => heard > 0);
    assert.ok(heard > 0, 'main moved from a worktree');
  } finally {
    stop();
  }
});

test('launcherDiffers: only when both files are there and differ', () => {
  const dir = tmpDir('tb-update-launch-');
  const a = path.join(dir, 'a.mjs');
  const b = path.join(dir, 'b.mjs');
  assert.equal(launcherDiffers(a, b), false);
  fs.writeFileSync(a, 'one');
  fs.writeFileSync(b, 'one');
  assert.equal(launcherDiffers(a, b), false);
  fs.writeFileSync(b, 'two');
  assert.equal(launcherDiffers(a, b), true);
});

test('launcherSourcesHash matches what build-launcher.sh records', () => {
  const launcher = path.join(import.meta.dirname, '..', '..', 'launcher');
  const r = spawnSync('bash', [path.join(launcher, 'build-launcher.sh'), '--hash'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(launcherSourcesHash(launcher), r.stdout.trim());
  assert.equal(launcherSourcesHash(tmpDir('tb-no-launcher-')), undefined);
});

test('launchAgentBehind: launch.mjs, a plist that runs node, and an app built from older sources', () => {
  // main's runner/ in the updater's clone, and an installed data dir.
  const main = tmpDir('tb-behind-main-');
  const home = tmpDir('tb-behind-home-');
  fs.mkdirSync(path.join(main, 'launcher'));
  for (const f of ['main.swift', 'Info.plist', 'build-launcher.sh']) fs.writeFileSync(path.join(main, 'launcher', f), f);
  fs.writeFileSync(path.join(main, 'launch.mjs'), 'launch');
  fs.mkdirSync(path.join(home, 'runner'));
  fs.writeFileSync(path.join(home, 'runner', 'launch.mjs'), 'launch');
  const app = path.join(home, 'Threadbear Runner.app');
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  const built = (sources: string) => fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'build.json'), JSON.stringify({ sources }));
  built(launcherSourcesHash(path.join(main, 'launcher'))!);
  const sup = { THREADBEAR_SUPERVISED: '1', THREADBEAR_RUNNER_APP: app };

  const noApp = () => undefined;
  assert.equal(launchAgentBehind(main, home, sup, noApp, 'darwin'), undefined, 'up to date');
  // Not under launch.mjs (a dev runner, a checkout): nothing to say about the app.
  assert.equal(launchAgentBehind(main, home, {}, noApp, 'darwin'), undefined);
  // Installed before the app: the plist runs node.
  assert.match(launchAgentBehind(main, home, { THREADBEAR_SUPERVISED: '1' }, noApp, 'darwin')!, /^The LaunchAgent still runs node, not Threadbear Runner\.app/);
  // On Linux systemd runs node and there's no app to be behind.
  assert.equal(launchAgentBehind(main, home, { THREADBEAR_SUPERVISED: '1' }, noApp, 'linux'), undefined);
  // A plist from before THREADBEAR_RUNNER_APP: the app is found above launch.mjs.
  assert.equal(launchAgentBehind(main, home, { THREADBEAR_SUPERVISED: '1' }, () => app, 'darwin'), undefined);
  // The app is from older launcher sources, or its build.json is gone.
  built('old');
  assert.equal(launchAgentBehind(main, home, sup, undefined, 'darwin'), "Threadbear Runner.app was built from older launcher sources than main's.");
  fs.rmSync(path.join(app, 'Contents', 'Resources', 'build.json'));
  assert.match(launchAgentBehind(main, home, sup, undefined, 'darwin')!, /older launcher sources/);
  // Both at once, a sentence each.
  fs.writeFileSync(path.join(main, 'launch.mjs'), 'launch 2');
  assert.equal(launchAgentBehind(main, home, sup, undefined, 'darwin'), "launch.mjs has changed on main. Threadbear Runner.app was built from older launcher sources than main's.");
  // A main from before the launcher says nothing about it.
  fs.rmSync(path.join(main, 'launcher'), { recursive: true });
  assert.equal(launchAgentBehind(main, home, { THREADBEAR_SUPERVISED: '1' }, () => app, 'darwin'), 'launch.mjs has changed on main.');
});

test('appOfExecutable: only the launcher app\'s executable', () => {
  assert.equal(appOfExecutable('/Users/m/Applications/Threadbear Runner.app/Contents/MacOS/Threadbear Runner'), '/Users/m/Applications/Threadbear Runner.app');
  assert.equal(appOfExecutable('/Users/m/.nvm/versions/node/v24.22.1/bin/node'), undefined);
  assert.equal(appOfExecutable('/Applications/Threadbear.app/Contents/MacOS/Threadbear'), undefined);
  assert.equal(appOfExecutable(''), undefined);
});

test('a check says when the LaunchAgent is behind main, for tb status and the Updates panel', async () => {
  const h = harness({}, { env: { THREADBEAR_SUPERVISED: '1' }, findLauncherApp: () => undefined, platform: 'darwin' });
  // main's runner/ as the updater's clone holds it.
  const launcher = path.join(updateDir(h.home), 'src', 'runner', 'launcher');
  fs.mkdirSync(launcher, { recursive: true });
  for (const f of ['main.swift', 'Info.plist', 'build-launcher.sh']) fs.writeFileSync(path.join(launcher, f), f);
  h.u.start();
  await h.u.check();
  const s = h.u.status();
  assert.equal(s.launcherChanged, true);
  assert.match(s.launcherReason!, /still runs node/);
});

test('the backend is deployed at main before the runner is built, once per commit', async () => {
  const h = harness();
  h.u.start();
  await h.u.check();
  assert.deepEqual(h.backendDeploys, ['c2']);
  assert.equal(h.deploys, 1);
  // The same commit again: the backend isn't asked a second time.
  await h.u.check();
  assert.deepEqual(h.backendDeploys, ['c2']);
});

test('a failed backend deploy holds the runner back until main changes', async () => {
  const h = harness();
  h.backendResult = { ok: false, error: 'convex deploy failed' };
  h.u.start();
  const d = await h.u.check();
  assert.deepEqual(d, { action: 'nothing', why: 'the backend deploy at main failed' });
  assert.equal(h.deploys, 0);
  assert.equal(h.u.status().state, 'failed');
  assert.match(h.u.status().reason ?? '', /backend deploy failed: convex deploy failed/);
  assert.equal(h.notices.length, 1);
  // Checked again at the same commit: still held, and no second notice.
  await h.u.check();
  assert.equal(h.deploys, 0);
  assert.equal(h.notices.length, 1);
  // Main moves on and the backend deploys: the runner is built.
  h.backendResult = { ok: true };
  h.main = { ...h.main, commit: 'c3', short: 'c3' };
  await h.u.check();
  assert.deepEqual(h.backendDeploys, ['c2', 'c3']);
  assert.equal(h.deploys, 1);
});
