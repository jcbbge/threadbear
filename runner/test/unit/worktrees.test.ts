// A worktree per thread (docs/thread-worktrees.md): the patch's `worktree`,
// making one when a thread starts, `tb land`, and cleaning up. Real git, in
// temp repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { makeHarness, tmpDir, type Harness } from '../helpers/fakes.ts';
import { checkSequence, checkSummary } from '../helpers/protocol-check.ts';
import { findWorktreePatch, readPatchModule } from '../../src/patches.ts';
import { cleanUpWorktree, land, makeWorktree, MAX_SPARES, overwrittenFiles, type LandTarget } from '../../src/worktrees.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { readToken } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { PatchTrust } from '../../src/patch-trust.ts';

// Commits need a name, and Mike's own git config (signing, hooks) mustn't
// reach the temp repos. Each test file runs in its own process.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const TB = path.join(import.meta.dirname, '..', '..', 'bin', 'tb');

function sh(cwd: string, cmd: string): string {
  return execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

const PATCH = (w: string) => `export default { worktree: ${w} };\n`;

// A repo at <root>/proj on main, with a runner/ folder and the given patch.
function makeRepo(patch = PATCH(`{ setup: "echo setting up in $PWD; touch .setup-ran" }`)): { root: string; main: string } {
  const root = fs.realpathSync(tmpDir('tb-wt-'));
  const main = path.join(root, 'proj');
  fs.mkdirSync(main);
  sh(main, 'git init -q -b main');
  write(main, {
    '.gitignore': 'node_modules\n.setup-ran\n.build\n',
    'README.md': 'one\ntwo\nthree\n',
    'runner/a.ts': 'export const a = 1;\n',
    ...(patch ? { '.threadbear/patches/checks.ts': patch } : {}),
  });
  sh(main, 'git add -A && git commit -qm init');
  return { root, main };
}

// A thread/ worktree of `main` by hand, for the landing tests.
function makeBranch(main: string, id8 = 'abcd1234'): LandTarget {
  const wt = path.join(path.dirname(main), 'proj-threads', id8);
  sh(main, `git worktree add -q -b thread/${id8} ${wt} main`);
  return { path: wt, branch: `thread/${id8}`, mainCheckout: main };
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  write(dir, files);
  sh(dir, `git add -A && git commit -qm "${message}"`);
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, opts: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function until(check: () => boolean, what: string, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function harness(): Harness {
  return makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000 });
}

// --------------------------------------------------------------- patches

test('a patch can carry worktree with setup and check; anything malformed is the file\'s error', () => {
  const ok = readPatchModule('checks', 'project', '/x/checks.ts', { worktree: { setup: 'npm ci', check: './check.sh --quick' } });
  assert.equal(ok.info.error, undefined);
  assert.deepEqual(ok.worktree, { setup: 'npm ci', check: './check.sh --quick' });
  assert.deepEqual(ok.actions, []);
  assert.deepEqual(readPatchModule('w', 'project', '/x/w.ts', { worktree: {} }).worktree, {});
  assert.deepEqual(readPatchModule('k', 'project', '/x/k.ts', { worktree: { keep: ['app/.build', 'dock/.build'] } }).worktree, { keep: ['app/.build', 'dock/.build'] });
  assert.equal(readPatchModule('a', 'project', '/x/a.ts', { actions: [] }).worktree, undefined, 'none unless asked for');
  for (const [worktree, error] of [
    [[], 'worktree should be an object with setup and/or check.'],
    [true, 'worktree should be an object with setup and/or check.'],
    [{ setup: 3 }, 'worktree.setup should be a command.'],
    [{ check: '  ' }, 'worktree.check should be a command.'],
    [{ keep: 'app/.build' }, 'worktree.keep should be a list of folders inside the repo, like "app/.build".'],
    [{ keep: [] }, 'worktree.keep should be a list of folders inside the repo, like "app/.build".'],
    [{ keep: ['/abs/.build'] }, 'worktree.keep should be a list of folders inside the repo, like "app/.build".'],
    [{ keep: ['../up'] }, 'worktree.keep should be a list of folders inside the repo, like "app/.build".'],
  ] as const) {
    const bad = readPatchModule('b', 'project', '/x/b.ts', { worktree });
    assert.equal(bad.info.error, error);
    assert.equal(bad.worktree, undefined);
  }
});

test('the nearest patch with a worktree wins; home\'s patches and broken files never count', async () => {
  const home = fs.realpathSync(tmpDir());
  write(home, {
    '.threadbear/patches/everywhere.ts': PATCH(`{ setup: "from home" }`),
    'dev/repo/.threadbear/patches/a-actions.ts': `export default { actions: [{ title: "Hi", run: "echo hi" }] };`,
    'dev/repo/.threadbear/patches/b-broken.ts': `export default { worktree: { setup: 4 } };`,
    'dev/repo/.threadbear/patches/c-wt.ts': PATCH(`{ setup: "outer", check: "outer check" }`),
    'dev/repo/pkg/.threadbear/patches/inner.ts': PATCH(`{ check: "inner check" }`),
    'dev/plain/x.txt': '',
  });
  const inner = await findWorktreePatch(path.join(home, 'dev/repo/pkg'), home);
  assert.deepEqual(inner, { check: 'inner check', patch: 'inner', file: path.join(home, 'dev/repo/pkg/.threadbear/patches/inner.ts'), folder: path.join(home, 'dev/repo/pkg') });
  const outer = await findWorktreePatch(path.join(home, 'dev/repo'), home);
  assert.equal(outer?.patch, 'c-wt');
  assert.equal(outer?.setup, 'outer');
  assert.equal(outer?.folder, path.join(home, 'dev/repo'));
  assert.equal(await findWorktreePatch(path.join(home, 'dev/plain'), home), undefined, "home's own patch folder isn't a repo's choice");
});

// ----------------------------------------------------------- a new thread

test('a new thread in an opted-in repo gets its own worktree, cwd, setup run, brief and Land chip', async () => {
  const { root, main } = makeRepo();
  const h = harness();
  const { thread, turnId } = h.runner.create({ text: 'Fix it', accountId: 'claude-3', cwd: path.join(main, 'runner') });
  const id8 = thread.id.slice(0, 8);
  const wt = path.join(root, 'proj-threads', id8);
  // The CLI starts once the worktree is there and set up.
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const s = h.adapter.last;
  assert.equal(s.opts.cwd, path.join(wt, 'runner'), 'the same subfolder of the worktree');
  assert.match(s.opts.instructions ?? '', new RegExp(`own git worktree of proj at ${wt}, on the branch thread/${id8}, made from main`));
  assert.match(s.opts.instructions ?? '', /run `tb land` in the worktree/);
  assert.equal(sh(wt, 'git rev-parse --abbrev-ref HEAD'), `thread/${id8}`);
  assert.equal(sh(wt, 'git rev-parse HEAD'), sh(main, 'git rev-parse main'));
  assert.ok(fs.existsSync(path.join(wt, '.setup-ran')), 'setup ran in the worktree root');

  const events = h.events(thread.id);
  assert.deepEqual(events.map((e) => e.type), ['user.message', 'turn.started', 'system.note', 'action.run']);
  assert.deepEqual(checkSequence(events), []);
  assert.equal(events[2].text, `Working in a worktree of its own at ${wt}, on the branch thread/${id8}. tb land puts it on main.`);
  const setup = events[3];
  assert.equal(setup.turnId, turnId);
  assert.equal(setup.trigger, 'worktree.setup');
  assert.equal(setup.title, 'Set up the worktree');
  assert.equal(setup.patch, 'checks');
  assert.equal(setup.ok, true);
  assert.match(setup.text, new RegExp(`setting up in ${wt}\n`));

  const summary = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(summary), []);
  assert.equal(summary.cwd, path.join(wt, 'runner'));
  assert.deepEqual(summary.worktree, { branch: `thread/${id8}`, mainCheckout: main, path: wt });
  await until(() => Boolean(h.runner.get(thread.id).actions), 'the patches to load');
  const land = h.runner.get(thread.id).actions?.find((a) => a.id === 'worktree.land');
  assert.ok(land);
  assert.equal(land.title, 'Land');
  // The path is shell-quoted when it has a space, as the updater's own clone
  // under Application Support does, so allow a closing quote before ` land`.
  assert.match(land.command ?? '', /\/bin\/tb'? land$/);
  assert.ok(h.runner.get(thread.id).patches?.some((p) => p.id === 'worktree' && p.source === 'builtin'));
  const rec = h.store.load(thread.id);
  assert.deepEqual(rec?.worktree, { repo: 'proj', mainCheckout: main, path: wt, branch: `thread/${id8}`, base: sh(main, 'git rev-parse main') });
  assert.equal(rec?.worktreePending, undefined);
});

test('worktree: false, a folder with no patches, and a repo without main checked out all start where asked', async () => {
  const { main } = makeRepo();
  const h = harness();
  const off = h.runner.create({ text: 'Here', accountId: 'claude-3', cwd: main, worktree: false });
  // Nothing to wait for: the CLI starts at once, as before.
  assert.equal(h.adapter.last.opts.cwd, main);
  assert.equal(h.runner.get(off.thread.id).worktree, undefined);

  const plain = fs.realpathSync(tmpDir());
  h.runner.create({ text: 'Plain', accountId: 'claude-3', cwd: plain });
  assert.equal(h.adapter.last.opts.cwd, plain, 'no patch files: started straight away');

  sh(main, 'git checkout -q -b other');
  const { thread } = h.runner.create({ text: 'No main', accountId: 'claude-3', cwd: main });
  await until(() => h.adapter.sessions.length === 3, 'the CLI to start');
  assert.equal(h.adapter.last.opts.cwd, main);
  assert.equal(h.runner.get(thread.id).worktree, undefined);
  const note = h.events(thread.id).find((e) => e.type === 'system.note');
  assert.equal(note?.text, `Couldn't make a worktree for this thread: no checkout of proj has main checked out. It starts in ${main} instead.`);
  assert.doesNotMatch(h.adapter.last.opts.instructions ?? '', /worktree/);
});

test('a leftover folder or branch of the same name is never reused', async () => {
  const { root, main } = makeRepo();
  const patch = (await findWorktreePatch(main, root))!;
  const id = 'feedface-0000-0000-0000-000000000000';
  fs.mkdirSync(path.join(root, 'proj-threads', 'feedface'), { recursive: true });
  const folder = await makeWorktree({ cwd: main, threadId: id, patch });
  assert.deepEqual(folder, { ok: false, reason: `there's already a folder at ${path.join(root, 'proj-threads', 'feedface')}` });
  fs.rmSync(path.join(root, 'proj-threads'), { recursive: true });
  sh(main, 'git branch thread/feedface');
  assert.deepEqual(await makeWorktree({ cwd: main, threadId: id, patch }), { ok: false, reason: 'the branch thread/feedface already exists' });
  assert.equal(sh(main, 'git worktree list').split('\n').length, 1);

  const notRepo = path.join(fs.realpathSync(tmpDir()), 'plain');
  write(notRepo, { '.threadbear/patches/w.ts': PATCH('{}') });
  const p2 = (await findWorktreePatch(notRepo, path.dirname(notRepo)))!;
  const r = await makeWorktree({ cwd: notRepo, threadId: id, patch: p2 });
  assert.deepEqual(r, { ok: false, reason: `the w patch asks for one, but ${notRepo} isn't in a git repo` });
});

test('a failing setup is shown and the turn starts anyway', async () => {
  const { main } = makeRepo(PATCH(`{ setup: "echo no luck >&2; exit 4" }`));
  const h = harness();
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: main });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const setup = h.events(thread.id).find((e) => e.type === 'action.run');
  assert.equal(setup.ok, false);
  assert.equal(setup.exitCode, 4);
  assert.equal(setup.text.trim(), 'no luck');
  assert.ok(h.runner.get(thread.id).worktree);
});

// The setup runs in the new worktree, from main's commit, which may not be
// what was trusted in the main checkout (an uncommitted edit there, a
// script changed on main): it's the worktree's own copy of the patch, and
// the scripts it names there, that must be trusted (Daybreak, 5 Nov).
test("setup runs only when the worktree's own copy of the patch is trusted, and it's that copy's setup", async () => {
  const opts = { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000 };
  const file = (main: string) => path.join(main, '.threadbear/patches/checks.ts');

  // Committed: a setup script that does harm. In the main checkout, not
  // committed: a harmless one, and that's what was trusted.
  const bad = makeRepo(PATCH(`{ setup: "./setup.sh" }`));
  commit(bad.main, { 'setup.sh': '#!/bin/sh\ntouch .evil-ran\n' }, 'setup');
  fs.chmodSync(path.join(bad.main, 'setup.sh'), 0o755);
  fs.writeFileSync(path.join(bad.main, 'setup.sh'), '#!/bin/sh\ntouch .setup-ran\n');
  const trust = new PatchTrust();
  trust.trustCurrent([file(bad.main)]);
  const h = makeHarness(undefined, {}, { ...opts, patchTrust: trust });
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: bad.main });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const wt = h.runner.get(thread.id).worktree;
  assert.ok(wt, 'the worktree is still made: the main checkout\'s patch is trusted');
  const wtPath = h.store.load(thread.id)!.worktree!.path;
  assert.equal(fs.existsSync(path.join(wtPath, '.evil-ran')), false, "the worktree's setup script didn't run");
  const events = h.events(thread.id);
  assert.equal(events.some((e) => e.type === 'action.run'), false);
  const note = events.filter((e) => e.type === 'system.note').at(-1);
  assert.match(note?.text ?? '', /^Didn't run the worktree's setup \(\.\/setup\.sh\): its copy of the checks patch isn't a version you've trusted\./);

  // Both versions trusted: the worktree's own setup is the one that runs,
  // by the absolute path of the worktree's script.
  const good = makeRepo(PATCH(`{ setup: "./committed.sh" }`));
  commit(good.main, { 'committed.sh': '#!/bin/sh\ntouch .committed-ran\n', 'main.sh': '#!/bin/sh\ntouch .main-ran\n' }, 'scripts');
  fs.chmodSync(path.join(good.main, 'committed.sh'), 0o755);
  fs.chmodSync(path.join(good.main, 'main.sh'), 0o755);
  sh(good.main, 'git add -A && git commit -qm modes');
  const t2 = new PatchTrust();
  t2.trustCurrent([file(good.main)]);
  fs.writeFileSync(file(good.main), PATCH(`{ setup: "./main.sh" }`));
  fs.utimesSync(file(good.main), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  t2.trustCurrent([file(good.main)]);
  const h2 = makeHarness(undefined, {}, { ...opts, patchTrust: t2 });
  const made = h2.runner.create({ text: 'Go', accountId: 'claude-3', cwd: good.main });
  await until(() => h2.adapter.sessions.length === 1, 'the CLI to start');
  const p2 = h2.store.load(made.thread.id)!.worktree!.path;
  assert.ok(fs.existsSync(path.join(p2, '.committed-ran')));
  assert.equal(fs.existsSync(path.join(p2, '.main-ran')), false);
  assert.equal(h2.events(made.thread.id).find((e) => e.type === 'action.run')?.command, './committed.sh');
});

// The remediation test for Daybreak's finding: changing only the setup
// script needs a fresh trust decision before a new thread runs it, however
// the setup names it. `cd scripts && ./setup.sh` kept its trust while
// scripts/setup.sh changed, as the hash only saw ./setup.sh.
test('changing only the setup script needs trusting again before a thread runs it; a setup that cds first never runs', async () => {
  const opts = { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000 };
  const file = (main: string) => path.join(main, '.threadbear/patches/checks.ts');

  const cd = makeRepo(PATCH(`{ setup: "cd scripts && ./setup.sh" }`));
  commit(cd.main, { 'scripts/setup.sh': 'touch ../.setup-ran\n' }, 'setup');
  sh(cd.main, 'chmod +x scripts/setup.sh && git add -A && git commit -qm mode');
  const trust = new PatchTrust();
  trust.trustCurrent([file(cd.main)]);
  // A commit changes only the script the trusted command reaches.
  commit(cd.main, { 'scripts/setup.sh': 'touch ../.evil-ran\n' }, 'evil');
  const h = makeHarness(undefined, {}, { ...opts, patchTrust: trust });
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: cd.main });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  assert.equal(h.runner.get(thread.id).worktree, undefined, 'the patch is refused, so no worktree either');
  assert.equal(h.adapter.last.opts.cwd, cd.main);
  assert.equal(h.events(thread.id).some((e) => e.type === 'action.run'), false);
  assert.equal(fs.existsSync(path.join(cd.main, '.evil-ran')), false);
  await h.runner.patchesIdle();
  // The command is followed for the hash too now, so the changed script is
  // asked about; as it stands it'd be refused anyway (patch-trust tests).
  const info = h.runner.get(thread.id).patches?.find((p) => p.id === 'checks');
  assert.equal(info?.untrusted, 'changed');

  // Named as one script: trusted, then a commit changes only the script.
  const one = makeRepo(PATCH(`{ setup: "./scripts/setup.sh" }`));
  commit(one.main, { 'scripts/setup.sh': '#!/bin/sh\ntouch .setup-ran\n' }, 'setup');
  sh(one.main, 'chmod +x scripts/setup.sh && git add -A && git commit -qm mode');
  const t2 = new PatchTrust();
  t2.trustCurrent([file(one.main)]);
  commit(one.main, { 'scripts/setup.sh': '#!/bin/sh\ntouch .evil-ran\n' }, 'evil');
  // The main checkout's patch is trusted no longer, so no worktree, and nothing runs.
  const h2 = makeHarness(undefined, {}, { ...opts, patchTrust: t2 });
  const made = h2.runner.create({ text: 'Go', accountId: 'claude-3', cwd: one.main });
  await until(() => h2.adapter.sessions.length === 1, 'the CLI to start');
  assert.equal(h2.runner.get(made.thread.id).worktree, undefined);
  assert.equal(h2.events(made.thread.id).some((e) => e.type === 'action.run'), false);
  await h2.runner.patchesIdle();
  assert.equal(h2.runner.get(made.thread.id).patches?.find((p) => p.id === 'checks')?.untrusted, 'changed');

  // Trusting the new version is what lets it run.
  t2.trustCurrent([file(one.main)]);
  const h3 = makeHarness(undefined, {}, { ...opts, patchTrust: t2 });
  const third = h3.runner.create({ text: 'Go', accountId: 'claude-3', cwd: one.main });
  await until(() => h3.adapter.sessions.length === 1, 'the CLI to start');
  const p3 = h3.store.load(third.thread.id)!.worktree!.path;
  assert.ok(fs.existsSync(path.join(p3, '.evil-ran')), 'the version trusted now runs');
});

// Daybreak verify-fix (5 Nov): the worktree's copy of a trusted patch
// hashed the same when only a script its setup runs had changed, so the
// changed helper ran before the first turn. Now the helper is in the hash.
test("a worktree whose setup script is unchanged but whose helper changed doesn't run the setup; trusting that version does", async () => {
  const opts = { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000 };
  const file = (main: string) => path.join(main, '.threadbear/patches/checks.ts');
  const r = makeRepo(PATCH(`{ setup: "./setup.sh" }`));
  // Committed: an unchanged setup.sh that runs a harmful helper. In the main
  // checkout, not committed: a harmless helper, and that's what was trusted.
  commit(r.main, { 'setup.sh': '#!/bin/sh\n"$(dirname "$0")/scripts/helper.sh"\n', 'scripts/helper.sh': '#!/bin/sh\ntouch .evil-ran\n' }, 'setup');
  sh(r.main, 'chmod +x setup.sh scripts/helper.sh && git add -A && git commit -qm modes');
  fs.writeFileSync(path.join(r.main, 'scripts/helper.sh'), '#!/bin/sh\ntouch .setup-ran\n');
  const trust = new PatchTrust();
  trust.trustCurrent([file(r.main)]);
  const h = makeHarness(undefined, {}, { ...opts, patchTrust: trust });
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: r.main });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const wtPath = h.store.load(thread.id)!.worktree!.path;
  assert.equal(fs.existsSync(path.join(wtPath, '.evil-ran')), false, "the worktree's changed helper didn't run");
  assert.equal(h.events(thread.id).some((e) => e.type === 'action.run'), false);
  const note = h.events(thread.id).filter((e) => e.type === 'system.note').at(-1);
  assert.match(note?.text ?? '', /^Didn't run the worktree's setup \(\.\/setup\.sh\): its copy of the checks patch isn't a version you've trusted\./);

  // Committing the helper that was trusted: the worktree's copy matches,
  // and the setup runs it.
  sh(r.main, 'git add -A && git commit -qm helper');
  const h2 = makeHarness(undefined, {}, { ...opts, patchTrust: trust });
  const made = h2.runner.create({ text: 'Go', accountId: 'claude-3', cwd: r.main });
  await until(() => h2.adapter.sessions.length === 1, 'the CLI to start');
  await until(() => h2.events(made.thread.id).some((e) => e.type === 'action.run'), 'the setup to run');
  assert.ok(fs.existsSync(path.join(h2.store.load(made.thread.id)!.worktree!.path, '.setup-ran')));
});

test('threads.create takes worktree: false over RPC, and refuses a worktree that isn\'t a boolean', async () => {
  const { main } = makeRepo();
  const h = harness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: readToken(h.home), runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  const c = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, readToken(h.home));
  try {
    await c.call('hello', { client: 'test', version: '1' });
    await assert.rejects(c.call('threads.create', { text: 'x', accountId: 'claude-3', cwd: main, worktree: 'no' }), /worktree must be a boolean/);
    const r = await c.call<{ thread: { id: string; cwd: string } }>('threads.create', { text: 'x', accountId: 'claude-3', cwd: main, worktree: false });
    assert.equal(r.thread.cwd, main);
    assert.equal(h.adapter.last.opts.cwd, main);
    assert.equal(h.store.load(r.thread.id)?.worktreePending, undefined);
  } finally {
    c.close();
    await server.close();
  }
});

// --------------------------------------------------------------- landing

test('the Land chip can wait beyond the ordinary command timeout', async () => {
  const h = makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 20 });
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: tmpDir() });
  const action = { id: 'worktree.land', title: 'Land', kind: 'command' as const, patch: 'worktree', command: 'sleep 0.1; echo checked' };
  h.runner.worktreeAction = () => action;
  assert.equal((await h.runner.runAction(thread.id, action.id)).ok, true);
  // A project action cannot opt into the built-in landing's longer limit.
  h.runner.worktreeAction = () => ({ ...action, patch: 'project' });
  assert.equal((await h.runner.runAction(thread.id, action.id)).ok, false);
});

test('land serializes separate CLIs before rebasing, so each checks the commit it lands once', async () => {
  const { root, main } = makeRepo(PATCH(`{ check: "./check.sh" }`));
  commit(main, { 'check.sh': `#!/bin/sh
echo checked >> '${root}/checks'
if test -f first.txt && ! test -f second.txt; then
  touch '${root}/checking'
  while ! test -f '${root}/release'; do sleep 0.05; done
fi
if test -f second.txt; then test -f first.txt && test "$1" = --latest; fi
` }, 'Add check');
  sh(main, 'chmod +x check.sh && git add check.sh && git commit -qm executable');
  const a = makeBranch(main, 'first');
  const b = makeBranch(main, 'second');
  commit(a.path, { 'first.txt': 'first\n', '.threadbear/patches/checks.ts': PATCH(`{ check: "./check.sh --latest" }`) }, 'First');
  commit(b.path, { 'second.txt': 'second\n' }, 'Second');
  const env = { THREADBEAR_HOME: path.join(root, 'no-runner'), THREADBEAR_THREAD_ID: undefined };
  const first = runTb(['land'], a.path, env);
  await until(() => fs.existsSync(path.join(root, 'checking')), 'first check');
  const second = startTb(['land'], b.path, env);
  try {
    await until(() => second.output().includes('Waiting for another landing'), 'second CLI waiting for landing');
  } finally {
    write(root, { release: '' });
  }
  const [one, two] = await Promise.all([first, second.done]);
  assert.equal(one.code, 0, one.out);
  assert.equal(two.code, 0, two.out);
  assert.match(two.out, /Waiting for another landing/);
  assert.equal(fs.readFileSync(path.join(root, 'checks'), 'utf8'), 'checked\nchecked\n');
  assert.equal(sh(main, 'git rev-parse main'), sh(b.path, 'git rev-parse HEAD'));
  assert.ok(fs.existsSync(path.join(main, 'first.txt')));
  assert.ok(fs.existsSync(path.join(main, 'second.txt')));
});

test('land refuses a branch changed by the check instead of merging an unchecked commit', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'first.txt': 'first\n' }, 'First');
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land({ ...t, check: 'echo unchecked > extra.txt && git add extra.txt && git commit -qm unchecked' }, c.opts), 1);
  assert.match(c.err.join('\n'), /changed while the check ran/);
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test('land releases its lock when a CLI is killed during the check', async () => {
  const { root, main } = makeRepo(PATCH(`{ check: "touch ../checking; while ! test -f ../release; do sleep 0.05; done" }`));
  const t = makeBranch(main);
  commit(t.path, { 'first.txt': 'first\n' }, 'First');
  const env = { THREADBEAR_HOME: path.join(root, 'no-runner'), THREADBEAR_THREAD_ID: undefined };
  const first = startTb(['land'], t.path, env);
  try {
    await until(() => fs.existsSync(path.join(t.path, '../checking')), 'CLI checking');
  } finally {
    first.child.kill('SIGKILL');
    await first.done;
  }
  // Acquire while the orphan check is still alive, so a pipe inherited
  // by that check cannot make a leaked lock look like a passing test.
  const next = land(t, capture().opts);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await Promise.race([next, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Killed CLI kept its landing lock')), 10_000);
    })]), 0);
  } finally {
    clearTimeout(timer);
    write(path.dirname(t.path), { release: '' });
    await next;
  }
  assert.equal(sh(main, 'git rev-parse main'), sh(t.path, 'git rev-parse HEAD'));
});

test('land refuses tracked edits made by the check, and releases the lock on failure', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'first.txt': 'first\n' }, 'First');
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land({ ...t, check: 'echo edited > first.txt' }, c.opts), 1);
  assert.match(c.err.join('\n'), /changed while the check ran/);
  assert.equal(sh(main, 'git rev-parse main'), before);
  sh(t.path, 'git restore first.txt');
  assert.equal(await land(t, capture().opts), 0);
});

test('tb land refuses a check patch that cannot load after rebasing', async () => {
  const { root, main } = makeRepo(PATCH(`{ check: "true" }`));
  const t = makeBranch(main);
  commit(t.path, { 'first.txt': 'first\n' }, 'First');
  commit(main, { '.threadbear/patches/checks.ts': 'export default { worktree: { check: ' }, 'Broken check');
  const before = sh(main, 'git rev-parse main');
  const result = await runTb(['land'], t.path, { THREADBEAR_HOME: path.join(root, 'no-runner'), THREADBEAR_THREAD_ID: undefined });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Couldn't read the repo's patches for its check/);
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test('land refuses untracked inputs created during validation', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'first.txt': 'first\n' }, 'First');
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land({ ...t, check: 'echo extra > extra.txt' }, c.opts), 1);
  assert.match(c.err.join('\n'), /changed while the check ran/);
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test('land: rebases on main, runs the check in the worktree, fast-forwards main and says what landed', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'runner/b.ts': 'export const b = 2;\n' }, 'Add b');
  // main moved on meanwhile, in another file.
  commit(main, { 'other.txt': 'x\n' }, 'Other work');
  const c = capture();
  const code = await land({ ...t, check: 'test -f runner/b.ts && test -f other.txt && echo checked' }, c.opts);
  assert.equal(code, 0, c.err.join('\n'));
  assert.deepEqual(c.err, []);
  assert.equal(c.out[0], 'Running the check: test -f runner/b.ts && test -f other.txt && echo checked');
  assert.match(c.out[1], /^The check passed \(\d+ s\)\.$/);
  assert.equal(c.out[2], `Landed on main in ${main}:`);
  assert.match(c.out[3], /^[0-9a-f]+ Add b$/);
  assert.equal(c.out.length, 4, 'only what landed, not main\'s own commit');
  assert.equal(sh(main, 'git log -1 --format=%s main'), 'Add b');
  assert.ok(fs.existsSync(path.join(main, 'runner/b.ts')), "main's working tree has it");
  assert.equal(sh(main, 'git rev-parse main'), sh(t.path, 'git rev-parse HEAD'));

  // The thread carries on: the next land lands only what's new.
  const again = capture();
  assert.equal(await land(t, again.opts), 0);
  assert.deepEqual(again.out, [`Nothing to land: ${t.branch} has no commits that aren't on main.`]);
  commit(t.path, { 'runner/c.ts': '3\n' }, 'Add c');
  const third = capture();
  assert.equal(await land(t, third.opts), 0);
  assert.equal(third.out.length, 2);
  assert.match(third.out[1], /Add c$/);
});

test('land refuses with uncommitted changes in the worktree, and says which files', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'runner/b.ts': '2\n' }, 'Add b');
  write(t.path, { 'README.md': 'changed\n', 'new.txt': 'untracked\n' });
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land({ ...t, check: 'touch ran-check' }, c.opts), 1);
  const text = c.err.join('\n');
  assert.match(text, new RegExp(`^There are uncommitted changes in ${t.path}, so nothing landed:\n  M README.md\n  \\?\\? new.txt\nCommit them`));
  assert.equal(sh(main, 'git rev-parse main'), before);
  assert.ok(!fs.existsSync(path.join(t.path, 'ran-check')), 'the check never ran');
});

test('land: a rebase conflict is undone and names the files', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'README.md': 'one\nTWO from the thread\nthree\n' }, 'Thread edit');
  commit(main, { 'README.md': 'one\nTWO on main\nthree\n' }, 'Main edit');
  const branchBefore = sh(t.path, 'git rev-parse HEAD');
  const mainBefore = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land(t, c.opts), 1);
  const text = c.err.join('\n');
  assert.match(text, /^Rebasing thread\/abcd1234 on main ran into conflicts in:\n  README.md\nThe rebase was undone/);
  assert.match(text, /run tb land again\.$/);
  assert.equal(sh(t.path, 'git rev-parse HEAD'), branchBefore, 'the branch is as it was');
  assert.equal(sh(t.path, 'git status --porcelain'), '', 'no rebase left in progress');
  assert.equal(sh(main, 'git rev-parse main'), mainBefore);
});

test("land never rebases a branch with a merge on it (Mike's release), so his commits keep their ids", async () => {
  const { main } = makeRepo();
  // Mike's release: a commit of his that main doesn't have.
  sh(main, 'git checkout -q -b mike && echo his > his.txt && git add his.txt && git commit -qm "Mike\'s change" && git checkout -q main');
  const his = sh(main, 'git rev-parse mike');
  const t = makeBranch(main);
  sh(t.path, 'git merge -q --no-ff --no-edit mike');
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  sh(main, `git merge-base --is-ancestor ${his} main`);
  assert.equal(c.out.length, 2, 'what landed is the merge, not each of his commits');
  assert.match(c.out[1], /Merge branch 'mike'/);

  // Main moved meanwhile: main is merged in, still no rebase.
  sh(main, 'git checkout -q mike && echo more > more.txt && git add more.txt && git commit -qm "More of his" && git checkout -q main');
  const more = sh(main, 'git rev-parse mike');
  sh(t.path, 'git merge -q --no-ff --no-edit mike');
  commit(main, { 'other.txt': 'x\n' }, 'Other work');
  const again = capture();
  assert.equal(await land(t, again.opts), 0, again.err.join('\n'));
  sh(main, `git merge-base --is-ancestor ${more} main`);
  assert.ok(fs.existsSync(path.join(main, 'other.txt')) && fs.existsSync(path.join(main, 'more.txt')));
});

test('land: a failing check stops it with the last lines of output, and main stays put', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'runner/b.ts': '2\n' }, 'Add b');
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  const check = 'for i in $(seq 1 60); do echo line $i; done; echo "1 test failed" >&2; exit 3';
  assert.equal(await land({ ...t, check }, c.opts), 1);
  const text = c.err.join('\n');
  assert.match(text, /^The check failed \(exit 3\), so main wasn't touched\. The last lines of its output:\n\n/);
  assert.match(text, /line 60\n1 test failed\n\nFix it, commit, and run tb land again\.$/);
  assert.doesNotMatch(text, /line 1\n/, 'only the end of a long output');
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test("land refuses when main's checkout has uncommitted changes in files it would change, and leaves them", async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'README.md': 'one\ntwo\nthree\nfour\n' }, 'Thread edit');
  write(main, { 'README.md': 'someone else is editing\n' });
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land(t, c.opts), 1);
  assert.equal(
    c.err.join('\n'),
    `The main checkout at ${main} has uncommitted changes in files this would change, so nothing landed:\n  README.md\n` +
      'Commit or move those changes there (someone else may be working on them), then run tb land again.',
  );
  assert.equal(sh(main, 'git rev-parse main'), before);
  assert.equal(fs.readFileSync(path.join(main, 'README.md'), 'utf8'), 'someone else is editing\n');
  // Changes elsewhere in main's checkout don't stand in the way.
  write(main, { 'README.md': 'one\ntwo\nthree\n', 'scratch.txt': 'mine\n' });
  sh(main, 'git checkout -- README.md');
  assert.equal(await land(t, capture().opts), 0);
  assert.equal(sh(main, 'git log -1 --format=%s'), 'Thread edit');
});

test('land --dry-run does the checks and says what would land, without moving main', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(t.path, { 'runner/b.ts': '2\n' }, 'Add b');
  const before = sh(main, 'git rev-parse main');
  const c = capture();
  assert.equal(await land({ ...t, check: 'true' }, { ...c.opts, dryRun: true }), 0);
  assert.equal(c.out.at(-2), `Would land on main in ${main}:`);
  assert.match(c.out.at(-1)!, /Add b$/);
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test('overwrittenFiles reads both of git\'s refusals', () => {
  const text =
    'error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\n\tsrc/a.ts\nPlease commit your changes or stash them before you merge.\n' +
    'error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt\nPlease move or remove them before you merge.\nAborting\n';
  assert.deepEqual(overwrittenFiles(text), ['README.md', 'src/a.ts', 'new.txt']);
});

function runTb(args: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ code: number | null; out: string }> {
  return startTb(args, cwd, env).done;
}

function startTb(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const full = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete full[k];
  const p = spawn(process.execPath, [TB, ...args], { cwd, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const done = new Promise<{ code: number | null; out: string }>((resolve) => {
    p.on('exit', (code) => resolve({ code, out }));
  });
  return { child: p, done, output: () => out };
}

test('tb land outside a thread goes by git: the thread/ branch, main\'s checkout and the patch\'s check', async () => {
  const { main } = makeRepo(PATCH(`{ check: "echo checking in $PWD" }`));
  const t = makeBranch(main);
  commit(t.path, { 'runner/b.ts': '2\n' }, 'Add b');
  const env = { THREADBEAR_THREAD_ID: undefined, THREADBEAR_HOME: fs.realpathSync(tmpDir()), THREADBEAR_URL: 'ws://127.0.0.1:9/rpc' };
  const dry = await runTb(['land', '--dry-run'], path.join(t.path, 'runner'), env);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /^Running the check: echo checking in \$PWD\nThe check passed/);
  assert.match(dry.out, new RegExp(`Would land on main in ${main}:\n[0-9a-f]+ Add b\n$`));
  assert.equal(sh(main, 'git log -1 --format=%s'), 'init');

  const elsewhere = await runTb(['land'], main, env);
  assert.equal(elsewhere.code, 1);
  assert.equal(elsewhere.out, `${main} is on main, not a thread/ branch. tb land runs in a thread's own worktree.\n`);
  const wrongFlag = await runTb(['land', '--json'], t.path, env);
  assert.equal(wrongFlag.code, 2);
  assert.match(wrongFlag.out, /tb land doesn't take --json\. It takes --dry-run\./);
});

test('tb land inside a thread asks the runner where its worktree is, wherever it runs', async () => {
  const { main } = makeRepo(PATCH(`{ check: "test -f runner/b.ts" }`));
  const h = harness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: readToken(h.home), runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  try {
    const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: main });
    await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
    const wt = h.runner.get(thread.id).worktree!.path;
    commit(wt, { 'runner/b.ts': '2\n' }, 'Thread work');
    const r = await runTb(['land'], fs.realpathSync(tmpDir()), { THREADBEAR_THREAD_ID: thread.id, THREADBEAR_HOME: h.home, THREADBEAR_URL: `ws://127.0.0.1:${port}/rpc` });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Landed on main in ${main}:\n[0-9a-f]+ Thread work\n$`));
    assert.equal(sh(main, 'git log -1 --format=%s'), 'Thread work');
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------- cleaning up

// A thread with a worktree whose first turn has finished.
async function threadWithWorktree(h: Harness, main: string) {
  const started = h.adapter.sessions.length;
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: path.join(main, 'runner') });
  await until(() => h.adapter.sessions.length === started + 1, 'the CLI to start');
  const s = h.adapter.last;
  s.init();
  s.result();
  const w = h.runner.get(thread.id).worktree!;
  return { id: thread.id, w };
}

const notes = (h: Harness, id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => e.text as string);

test('archiving a thread whose branch is all on main removes its worktree and branch; it comes back in the main checkout', async () => {
  const { root, main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Landed work');
  assert.equal(await land({ path: w.path, branch: w.branch, mainCheckout: main }, capture().opts), 0);
  write(w.path, { 'scratch.txt': 'untracked, so --force\n' });
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  assert.equal(notes(h, id).at(-1), `Removed this thread's worktree and its branch ${w.branch}: everything on it is on main.`);
  assert.ok(!fs.existsSync(w.path));
  assert.ok(!fs.existsSync(path.join(root, 'proj-threads')), 'the empty -threads folder goes too');
  assert.equal(sh(main, `git branch --list ${w.branch}`), '');
  const summary = h.runner.get(id);
  assert.equal(summary.worktree, undefined);
  assert.ok(!summary.actions?.some((a) => a.id === 'worktree.land'));
  assert.deepEqual(checkSummary(summary), []);

  // Sent a message: unarchived, and on in the main checkout's runner/.
  h.runner.send(id, 'More please');
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  assert.equal(h.adapter.last.opts.cwd, path.join(main, 'runner'));
  assert.equal(h.runner.get(id).cwd, path.join(main, 'runner'));
  assert.ok(notes(h, id).includes(`This thread's worktree was removed when it was archived, so it carries on in the main checkout, ${path.join(main, 'runner')}.`));
  const sent = h.adapter.last.sent.at(-1)!.text;
  // After the handoff note (the test harness can't carry the transcript).
  assert.match(sent, new RegExp(`\n\n\\[Threadbear\\] Your worktree at ${w.path} was removed after its work landed on main\\. You're now in the main checkout`));
  assert.match(sent, /More please$/);
  assert.doesNotMatch(h.adapter.last.opts.instructions ?? '', /own git worktree/, 'a fresh session is no longer told about it');
});

test("archiving a thread with work that isn't on main keeps the worktree and branch, and says how to land or drop them", async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  assert.equal(
    notes(h, id).at(-1),
    `This thread's worktree at ${w.path} and its branch ${w.branch} stay: ${w.branch} has commits that aren't on main. ` +
      `To land it, run tb land in ${w.path} (or bring the thread back and press Land). ` +
      `To drop it, git -C ${main} worktree remove --force ${w.path} && git -C ${main} branch -D ${w.branch}.`,
  );
  assert.ok(fs.existsSync(w.path));
  assert.ok(h.runner.get(id).worktree, 'still shown');
});

test('cleanUpWorktree keeps a worktree with uncommitted changes to tracked files', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  write(t.path, { 'README.md': 'edited\n' });
  const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
  assert.deepEqual(await cleanUpWorktree(rec), { removed: false, reason: 'the worktree has uncommitted changes' });
  assert.ok(fs.existsSync(t.path));
  sh(t.path, 'git checkout -- README.md');
  assert.deepEqual(await cleanUpWorktree(rec), { removed: true });
  assert.ok(!fs.existsSync(t.path));
  assert.equal(sh(main, `git branch --list ${t.branch}`), '');
});

test('deleting a thread removes a landed worktree; an unlanded one stays, with a notice', async () => {
  const { main } = makeRepo();
  const h = harness();
  const a = await threadWithWorktree(h, main);
  h.runner.delete(a.id);
  // The branch goes after the folder.
  await until(() => !fs.existsSync(a.w.path) && sh(main, `git branch --list ${a.w.branch}`) === '', 'the worktree and branch to go');

  const b = await threadWithWorktree(h, main);
  commit(b.w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.delete(b.id);
  await until(() => h.notes.some((n) => n.method === 'runner.notice'), 'the notice');
  const notice = h.notes.find((n) => n.method === 'runner.notice') as { params: { message: string } };
  assert.match(notice.params.message, new RegExp(`^"Go" was deleted, but its worktree at ${b.w.path} and branch ${b.w.branch} stay: ${b.w.branch.replace('/', '\\/')} has commits that aren't on main\\. To land it, run tb land in ${b.w.path}\\. To drop it`));
  assert.ok(fs.existsSync(b.w.path));
});

// ---------------------------------------------------------------- spares

const KEEP = PATCH(`{ setup: "touch .setup-ran", keep: ["app/.build"] }`);

const isLocked = (main: string, wt: string) => sh(main, 'git worktree list --porcelain').split('\n\n').some((b) => b.includes(`worktree ${wt}\n`) && b.includes('locked threadbear spare'));

test('with keep, an archived landed worktree is kept as a spare, and the next thread takes it, build cache and all', async () => {
  const { root, main } = makeRepo(KEEP);
  const h = harness();
  const a = await threadWithWorktree(h, main);
  const slot = path.join(root, 'proj-threads', 'slot-1');
  assert.equal(a.w.path, slot, 'named for the slot, not the thread, as it outlives it');
  assert.deepEqual(h.store.load(a.id)?.worktree?.keep, ['app/.build']);
  commit(slot, { 'runner/b.ts': '2\n' }, 'Landed work');
  assert.equal(await land({ path: slot, branch: a.w.branch, mainCheckout: main }, capture().opts), 0);
  write(slot, { 'app/.build/cache.o': 'warm\n', 'node_modules/old.js': 'stale\n', 'scratch.txt': 'untracked\n' });

  h.runner.update({ threadId: a.id, archived: true });
  await until(() => notes(h, a.id).some((n) => n.includes('for the next thread')), 'the cleanup');
  assert.equal(notes(h, a.id).at(-1), `Deleted this thread's branch ${a.w.branch} (everything on it is on main) and kept its worktree, build caches and all, for the next thread.`);
  assert.ok(isLocked(main, slot), 'locked as a spare');
  assert.equal(sh(main, `git branch --list ${a.w.branch}`), '');
  assert.equal(h.runner.get(a.id).worktree, undefined);

  const b = await threadWithWorktree(h, main);
  assert.equal(b.w.path, slot, 'took the spare');
  assert.equal(h.adapter.last.opts.cwd, path.join(slot, 'runner'));
  assert.ok(!isLocked(main, slot));
  assert.equal(sh(slot, 'git rev-parse --abbrev-ref HEAD'), b.w.branch);
  assert.equal(sh(slot, 'git rev-parse HEAD'), sh(main, 'git rev-parse main'));
  assert.equal(fs.readFileSync(path.join(slot, 'app/.build/cache.o'), 'utf8'), 'warm\n', 'the kept folder stays');
  assert.ok(!fs.existsSync(path.join(slot, 'node_modules')), "ignored files that aren't kept go");
  assert.ok(!fs.existsSync(path.join(slot, 'scratch.txt')));
  assert.ok(fs.existsSync(path.join(slot, '.setup-ran')), 'setup ran again');
  assert.equal(sh(slot, 'git status --porcelain'), '');

  // The first thread, brought back, never carries on in what's now b's folder.
  h.runner.send(a.id, 'More please');
  await until(() => h.adapter.last.opts.cwd === path.join(main, 'runner'), "a's new CLI in the main checkout");
  assert.ok(notes(h, a.id).includes(`This thread's worktree was handed on to other threads when it was archived, so it carries on in the main checkout, ${path.join(main, 'runner')}.`));
  assert.match(h.adapter.last.sent.at(-1)!.text, new RegExp(`Your worktree at ${slot} was handed on to other threads after its work landed on main`));
});

test('with keep, two threads at once never share a spare, and an unlanded worktree is never kept', async () => {
  const { root, main } = makeRepo(KEEP);
  const patch = (await findWorktreePatch(main, root))!;
  const one = await makeWorktree({ cwd: main, threadId: 'aaaaaaaa-1', patch });
  assert.ok(one.ok);
  assert.deepEqual(await cleanUpWorktree(one.worktree), { removed: true, spare: true });
  const [x, y] = await Promise.all([
    makeWorktree({ cwd: main, threadId: 'bbbbbbbb-1', patch }),
    makeWorktree({ cwd: main, threadId: 'cccccccc-1', patch }),
  ]);
  assert.ok(x.ok && y.ok);
  assert.deepEqual([x.worktree.path, y.worktree.path].sort(), [path.join(root, 'proj-threads', 'slot-1'), path.join(root, 'proj-threads', 'slot-2')]);

  commit(x.worktree.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  assert.deepEqual(await cleanUpWorktree(x.worktree), { removed: false, reason: `${x.worktree.branch} has commits that aren't on main` });
  assert.ok(!isLocked(main, x.worktree.path));
});

test(`with keep, past ${MAX_SPARES} spares an archived worktree is removed as before`, async () => {
  const { root, main } = makeRepo(KEEP);
  const patch = (await findWorktreePatch(main, root))!;
  const made = [];
  for (let i = 0; i <= MAX_SPARES; i++) {
    const m = await makeWorktree({ cwd: main, threadId: `${String(i).padStart(8, '0')}-x`, patch });
    assert.ok(m.ok);
    made.push(m.worktree);
  }
  for (const w of made.slice(0, MAX_SPARES)) assert.deepEqual(await cleanUpWorktree(w), { removed: true, spare: true });
  const last = made[MAX_SPARES];
  assert.deepEqual(await cleanUpWorktree(last), { removed: true });
  assert.ok(!fs.existsSync(last.path));
  assert.equal(sh(main, `git branch --list ${last.branch}`), '');
});

// ------------------------------------------------- handovers and stale records

// THREADBEAR-16 (6 Nov): a thread archived as a handover began. The cleanup
// was still running git when the draining runner saved the record and let
// the thread go, so its result (removedAt and the note) was lost, and the
// note's emit threw on the let-go thread.
test('a handover waits for an archived thread\'s worktree cleanup, so the saved record says it was removed', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  const rt = (h.runner as any).threads.get(id).rt;
  // The CLI has gone and the cleanup has started, but git hasn't finished.
  await until(() => rt.archivePending === false, 'the cleanup to start');
  assert.ok(fs.existsSync(w.path), 'still removing');
  const handed: string[] = [];
  await h.runner.beginDrain([], { onHandedOver: (t) => handed.push(t) });
  await until(() => handed.includes(id), 'the handover');
  assert.equal(h.runner.has(id), false);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8'));
  assert.ok(saved.worktree.removedAt, 'removedAt was saved');
  assert.ok(!fs.existsSync(w.path));
  assert.ok(notes(h, id).includes(`Removed this thread's worktree and its branch ${w.branch}: everything on it is on main.`));
});

test('cleanUpWorktree leaves a folder that is now another thread\'s worktree, from a record that missed its removal', async () => {
  const { main } = makeRepo();
  const old = makeBranch(main, 'old00000');
  const rec = { repo: 'proj', mainCheckout: main, path: old.path, branch: old.branch, base: sh(main, 'git rev-parse main') };
  // Removed, but the record never heard; then a new thread took the folder.
  sh(main, `git worktree remove ${old.path} && git branch -D ${old.branch}`);
  sh(main, `git worktree add -q -b thread/new00000 ${old.path} main`);
  write(old.path, { 'scratch.txt': 'the new thread\'s untracked work\n' });
  assert.deepEqual(await cleanUpWorktree(rec), { removed: true, taken: true });
  assert.equal(fs.readFileSync(path.join(old.path, 'scratch.txt'), 'utf8'), 'the new thread\'s untracked work\n');
  assert.equal(sh(old.path, 'git rev-parse --abbrev-ref HEAD'), 'thread/new00000');

  // A spare (detached and locked) or a borrowed worktree is left alone too,
  // and a landed branch of ours that's still there goes.
  const other = makeBranch(main, 'oth00000');
  const rec2 = { repo: 'proj', mainCheckout: main, path: other.path, branch: other.branch, base: rec.base };
  sh(other.path, 'git checkout -q --detach');
  assert.deepEqual(await cleanUpWorktree(rec2), { removed: true, taken: true });
  assert.ok(fs.existsSync(other.path));
  assert.equal(sh(main, `git branch --list ${other.branch}`), '');
});

test('a thread brought back whose worktree folder is now another\'s carries on in the main checkout', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  // As THREADBEAR-16 left it: worktree and branch gone, record not told,
  // and then another thread took the folder.
  sh(main, `git worktree remove --force ${w.path} && git branch -D ${w.branch}`);
  sh(main, `git worktree add -q -b thread/zzzz0000 ${w.path} main`);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes('another')), 'the cleanup');
  assert.ok(fs.existsSync(w.path), "the other thread's worktree stays");
  assert.equal(h.runner.get(id).worktree, undefined, 'no Land chip');
  h.runner.send(id, 'More please');
  await until(() => h.adapter.last.opts.cwd === path.join(main, 'runner'), 'a new CLI in the main checkout');
});

test("at start, an archived thread whose worktree and branch went unrecorded is told; one that's still there isn't", async () => {
  const { main } = makeRepo();
  const h = harness();
  const lost = await threadWithWorktree(h, main);
  const kept = await threadWithWorktree(h, main);
  sh(main, `git worktree remove --force ${lost.w.path} && git branch -D ${lost.w.branch}`);
  const threads = (h.runner as any).threads;
  for (const id of [lost.id, kept.id]) threads.get(id).rec.archivedAt = new Date(h.clock.now()).toISOString();
  await h.runner.settleLostCleanups();
  assert.ok(threads.get(lost.id).rec.worktree.removedAt);
  assert.equal(h.runner.get(lost.id).worktree, undefined, 'no Land chip');
  assert.equal(threads.get(kept.id).rec.worktree.removedAt, undefined);
  assert.equal(notes(h, lost.id).filter((n) => n.includes('worktree')).length, 1, 'quietly: only the note from when it was made');
});

test('a message sent while the archive cleanup runs waits for it, then starts in the main checkout', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  const rt = (h.runner as any).threads.get(id).rt;
  await until(() => rt.archivePending === false, 'the cleanup to start');
  assert.ok(fs.existsSync(w.path), 'still removing');
  h.runner.send(id, 'More please');
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  assert.equal(h.adapter.last.opts.cwd, path.join(main, 'runner'), 'not the folder being removed');
  assert.ok(!fs.existsSync(w.path));
});

test('a thread deleted while a handover waits for its cleanup stays deleted', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id } = await threadWithWorktree(h, main);
  h.runner.update({ threadId: id, archived: true });
  const rt = (h.runner as any).threads.get(id).rt;
  await until(() => rt.archivePending === false, 'the cleanup to start');
  const drained = h.runner.beginDrain([], { onHandedOver: () => undefined });
  h.runner.delete(id);
  await drained;
  assert.ok(!fs.existsSync(path.join(h.home, 'threads', id)), 'not saved back');
});

test("a handover doesn't wait on a thread's cleanup to let the rest go, nor for ever on one that never finishes", async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3' });
  h.adapter.last.init();
  h.adapter.last.result();
  const other = h.runner.create({ text: 'Other', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  h.adapter.last.result();
  const rt = (h.runner as any).threads.get(thread.id).rt;
  rt.cleaning = new Promise(() => undefined);
  const handed: string[] = [];
  await h.runner.beginDrain([], { onHandedOver: (id) => handed.push(id) });
  assert.equal(h.runner.has(other.id), false, 'the rest go at once');
  assert.deepEqual(h.runner.keeping(), [thread.id]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.runner.has(thread.id), true, 'waits a while');
  h.clock.advance(10 * 60_000);
  await until(() => handed.includes(thread.id), 'the handover past the limit');
  assert.equal(h.runner.has(thread.id), false);
});

test('at start, an archived thread whose slot folder another thread has since taken is marked as handed on', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  sh(main, `git worktree remove --force ${w.path} && git branch -D ${w.branch}`);
  sh(main, `git worktree add -q -b thread/yyyy0000 ${w.path} main`);
  const rec = (h.runner as any).threads.get(id).rec;
  rec.archivedAt = new Date(h.clock.now()).toISOString();
  await h.runner.settleLostCleanups();
  assert.ok(rec.worktree.removedAt);
  assert.equal(rec.worktree.spare, true, 'so it never carries on in the other thread\'s folder');
  assert.ok(fs.existsSync(w.path));
});

test('a message sent to a stale archived thread while the start check runs waits for it, so never starts in the reused folder', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  sh(main, `git worktree remove --force ${w.path} && git branch -D ${w.branch}`);
  sh(main, `git worktree add -q -b thread/xxxx0000 ${w.path} main`);
  // As at a start: no CLI, archived.
  const st = (h.runner as any).threads.get(id);
  (h.runner as any).releaseSession(st);
  await st.rt.closing;
  st.rec.archivedAt = new Date(h.clock.now()).toISOString();
  const settled = h.runner.settleLostCleanups();
  h.runner.send(id, 'More please');
  await settled;
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  assert.equal(h.adapter.last.opts.cwd, path.join(main, 'runner'));
});

test('cleanUpWorktree changes nothing once the thread has been handed to another runner', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
  assert.deepEqual(await cleanUpWorktree(rec, () => false), { removed: false, reason: 'the thread was handed to another runner' });
  assert.ok(fs.existsSync(t.path));
  assert.ok(sh(main, `git branch --list ${t.branch}`).includes(t.branch));
});

// ---- turn.end hooks and an archive's cleanup (7 Nov): the hook was still
// running in the worktree when archiving removed it, so a passing typecheck
// "failed" on missing files and woke the thread that had just been archived.

const HOOK_PATCH = (run: string, tell = 'failures') => PATCH(`{ setup: "true" }, hooks: [{ title: "Check", on: "turn.end", run: ${JSON.stringify(run)}, edited: "**/*.ts", tell: ${JSON.stringify(tell)} }]`);

// Ends a turn that edited a .ts file, with end_turn asking for the archive,
// so the hook is running as the archive happens.
async function archiveAfterEdit(h: Harness, id: string): Promise<void> {
  await h.runner.patchesIdle();
  const s = h.adapter.last;
  h.runner.send(id, 'Finish up');
  s.out({ kind: 'event', event: { type: 'edit.diff', itemId: 'e1', path: 'a.ts', hunks: [] } });
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 't1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', archive: true } } });
  s.text('m1', 'All landed.');
  s.result('completed');
}

const hookRuns = (h: Harness, id: string) => h.events(id).filter((e) => e.type === 'action.run' && e.trigger === 'turn.end');
const toldAgent = (h: Harness, id: string) => h.events(id).filter((e) => e.type === 'user.message' && e.origin === 'runner');

test('an archive waits for a running turn.end hook: it sees the whole worktree, passes, and the thread stays archived', async () => {
  // Fails if a.ts has gone by the time it looks, as the typecheck did.
  const { main } = makeRepo(HOOK_PATCH('sleep 0.6; test -f a.ts'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.last.ended === true, 'the CLI to go');
  assert.equal(hookRuns(h, id).length, 0, 'the hook is still running');
  assert.ok(fs.existsSync(path.join(w.path, 'runner/a.ts')), 'and its files are still there');
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup, after the hook');
  assert.deepEqual(hookRuns(h, id).map((e) => e.ok), [true]);
  assert.equal(toldAgent(h, id).length, 0);
  assert.ok(h.runner.get(id).archivedAt, 'still archived');
  assert.equal(h.adapter.sessions.length, sessions, 'not woken');
  assert.ok(!fs.existsSync(w.path));
});

test('a real hook failure on a thread being archived brings it back in its own worktree, which stays', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.3; echo really broken >&2; exit 1'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.sessions.length === sessions + 1, 'the thread to be told');
  assert.match(toldAgent(h, id)[0].text, /really broken/);
  const t = h.runner.get(id);
  assert.equal(t.archivedAt, undefined, 'back from the archive');
  assert.equal(h.adapter.last.opts.cwd, path.join(w.path, 'runner'), 'where its work is');
  assert.ok(fs.existsSync(w.path));
  assert.ok(!notes(h, id).some((n) => n.startsWith('Removed')));
});

test('a hook that tells the agent even when it passes leaves an archived thread archived', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.3; echo fine', 'always'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await archiveAfterEdit(h, id);
  await until(() => hookRuns(h, id).length === 1, 'the hook');
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  assert.deepEqual(hookRuns(h, id).map((e) => e.ok), [true]);
  assert.equal(toldAgent(h, id).length, 0);
  assert.ok(h.runner.get(id).archivedAt);
  assert.equal(h.adapter.sessions.length, sessions);
  assert.ok(!fs.existsSync(w.path));
});

test('a hook whose folder went while it ran is not reported as a failure and wakes nothing', async () => {
  // Gone some other way than the archive, which now waits: by hand, say.
  const { main } = makeRepo(HOOK_PATCH('rm -rf "$PWD"; exit 1'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await h.runner.patchesIdle();
  const s = h.adapter.last;
  h.runner.send(id, 'Edit');
  s.out({ kind: 'event', event: { type: 'edit.diff', itemId: 'e1', path: 'a.ts', hunks: [] } });
  s.result('completed');
  await until(() => notes(h, id).some((n) => n.includes('Check')), 'the note about the hook');
  assert.equal(notes(h, id).at(-1), `The hook "Check" had its folder ${path.join(w.path, 'runner')} removed while it ran, so its result says nothing about the code.`);
  assert.equal(hookRuns(h, id).length, 0);
  assert.equal(toldAgent(h, id).length, 0);
  assert.equal(h.adapter.sessions.length, sessions);
});

test('a handover that starts while a hook runs keeps the thread, so the archive\'s cleanup still happens and is saved', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.6; test -f a.ts'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.last.ended === true, 'the CLI to go');
  const handed: string[] = [];
  // It has no turn, so the restarter doesn't count it as busy.
  await h.runner.beginDrain([], { onHandedOver: (t) => handed.push(t) });
  assert.equal(h.runner.has(id), true, 'held while its hook runs');
  await until(() => handed.includes(id), 'the handover');
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8'));
  assert.ok(saved.worktree.removedAt, 'removedAt was saved');
  assert.ok(saved.archivedAt, 'still archived');
  assert.equal(saved.queue?.length ?? 0, 0, 'nothing to wake it');
  assert.ok(!fs.existsSync(w.path));
});

test('a runner that stops while an archive waits for a hook leaves the cleanup to the next one', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.3'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.last.ended === true, 'the CLI to go');
  await h.runner.shutdown();
  assert.ok(fs.existsSync(w.path), 'nothing removed it yet');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(fs.existsSync(w.path), 'nor as the hook ended, on a runner that was stopping');
  const next = makeHarness(h.home, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000 });
  await until(() => notes(next, id).some((n) => n.startsWith('Removed')), 'the next runner to clean up');
  assert.ok(!fs.existsSync(w.path));
  assert.equal(next.runner.get(id).worktree, undefined);
  assert.ok(next.runner.get(id).archivedAt);
  // Once only: the runner after that has nothing owed.
  next.runner.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8')).worktree.cleanupOwed, undefined);
});

test('a cleanup that keeps the worktree is not owed again, so the next runner says nothing more', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  await h.runner.shutdown();
  const next = makeHarness(h.home, {}, { actionShell: ['/bin/sh', '-c'] });
  // Started as it loaded; this waits for it. A harness's events are what
  // happened since it started.
  await (next.runner as any).threads.get(id).rt.cleaning;
  assert.equal(notes(next, id).filter((n) => n.includes(' stay: ')).length, 0);
});

test('a hook that ignores SIGTERM still ends at the timeout, so the archive waiting for it is not held for ever', async () => {
  const { main } = makeRepo(HOOK_PATCH(`trap '' TERM; while :; do sleep 0.2; done`, 'never'));
  const h = makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 300 });
  const { id, w } = await threadWithWorktree(h, main);
  await archiveAfterEdit(h, id);
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup, past the hook');
  assert.deepEqual(hookRuns(h, id).map((e) => e.ok), [false]);
  assert.match(hookRuns(h, id)[0].text, /Stopped after/);
  assert.ok(!fs.existsSync(w.path));
});

test('adopting a thread still owed a cleanup leaves it, as the old runner\'s git may still be at it; the next start does it', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const threads = (h.runner as any).threads;
  // As letGo leaves it when its wait for a hung cleanup runs out.
  const rec = threads.get(id).rec;
  rec.archivedAt = new Date(h.clock.now()).toISOString();
  rec.worktree.cleanupOwed = true;
  (h.runner as any).store.save(rec);
  threads.delete(id);
  h.runner.adopt(id);
  await threads.get(id).rt.cleaning;
  assert.ok(fs.existsSync(w.path));
  assert.equal(threads.get(id).rec.worktree.cleanupOwed, true, 'still owed');
  h.runner.flush();
  await h.runner.shutdown();
  const next = makeHarness(h.home, {}, { actionShell: ['/bin/sh', '-c'] });
  await until(() => notes(next, id).some((n) => n.startsWith('Removed')), 'the cleanup at the next start');
  assert.ok(!fs.existsSync(w.path));
});
