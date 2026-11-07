import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { inBackground, TASKPOLICY } from '../../src/background.ts';
import { runCommand } from '../../src/patches.ts';
import { land } from '../../src/worktrees.ts';

// Builds and tests Threadbear spawns itself run at background priority on
// a Mac (a land's check held Mike's M5 above load 24 on 6 Nov).

test('inBackground: taskpolicy -b on a Mac that has it, the command as it is elsewhere', () => {
  assert.deepEqual(inBackground('/bin/sh', ['-c', 'x'], { platform: 'darwin', exists: () => true }), [TASKPOLICY, ['-b', '/bin/sh', '-c', 'x']]);
  assert.deepEqual(inBackground('/bin/sh', ['-c', 'x'], { platform: 'darwin', exists: () => false }), ['/bin/sh', ['-c', 'x']]);
  assert.deepEqual(inBackground('/bin/sh', ['-c', 'x'], { platform: 'linux', exists: () => true }), ['/bin/sh', ['-c', 'x']]);
});

// A darwin-background process reports scheduling priority 4 in ps (20 is
// normal). Only the background side is checked: the suite itself may run
// under taskpolicy -b, and then everything it starts is 4 anyway.
const onMac = process.platform === 'darwin' && fs.existsSync(TASKPOLICY);
const PRI = 'ps -o pri= -p $$';

test('runCommand: background runs at background priority', { skip: !onMac }, async () => {
  const r = await runCommand(PRI, { cwd: tmpDir(), env: { PATH: '/usr/bin:/bin' }, shell: ['/bin/sh', '-c'], background: true });
  assert.equal(r.ok, true, r.text);
  assert.equal(r.text.trim(), '4');
});

test("land: the check runs at background priority", { skip: !onMac }, async () => {
  const root = fs.realpathSync(tmpDir('tb-bg-'));
  const main = path.join(root, 'repo');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'thread/bg', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'b');
  const pri = path.join(root, 'pri.txt');
  const code = await land(
    { path: wt, branch: 'thread/bg', mainCheckout: main, check: `${PRI} > '${pri}'` },
    { out: () => {}, err: () => {}, shell: ['/bin/sh', '-c'] },
  );
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(pri, 'utf8').trim(), '4');
});

test('runner: a turn hook runs at background priority unless the runner is told otherwise', { skip: !onMac }, async () => {
  const pri = async (backgroundJobs: boolean): Promise<string | undefined> => {
    const root = tmpDir();
    const project = path.join(root, 'app');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(project, '.threadbear', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(project, '.threadbear', 'patches', 'hooks.ts'), `export default { hooks: [{ title: "Pri", on: "turn.end", run: "${PRI}", tell: "never" }] };\n`);
    const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 20_000, backgroundJobs });
    const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project });
    await new Promise((r) => setImmediate(r));
    await h.runner.patchesIdle();
    const s = h.adapter.last;
    s.init();
    s.result('completed');
    const runs = () => h.events(thread.id).filter((e) => e.type === 'action.run');
    for (let i = 0; i < 2000 && !runs().length; i++) await new Promise((r) => setTimeout(r, 10));
    return (runs()[0] as { text?: string } | undefined)?.text?.trim();
  };
  assert.equal(await pri(true), '4');
  // Off, it runs as the runner does: at this suite's own priority, which
  // depends on how it was started (20 under a GUI login, 31 over ssh, as
  // when ./check.sh sends it to a check host, 4 under taskpolicy -b).
  const own = execFileSync('/bin/ps', ['-o', 'pri=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
  assert.equal((await pri(false)) ?? '', own);
});
