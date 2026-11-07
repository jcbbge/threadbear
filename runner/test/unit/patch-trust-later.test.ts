// What Threadbear's trust hash binds once something has been trusted:
// Daybreak's findings of 7 Nov 2026 on approved schedule checks, patch actions
// (scanner failures, and bytes changed after the check), package code and
// Claude project trust. Each test plays the finding's attack and the variants
// its write-up names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { loadPatchSet } from '../../src/patches.ts';
import { checkDigest, PatchTrust, patchHash, type PatchGate } from '../../src/patch-trust.ts';
import { claudeCommands } from '../../src/claude-trust.ts';
import { Scheduler, scheduleMethods } from '../../src/schedules.ts';
import { nullLogger } from '../../src/log.ts';
import { HELD_EXTRA, HELD_SKIP, runCheck, type CheckResult } from '../../src/schedule-check.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';

const MIN = 60_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { stdio: 'pipe' }).toString();

function write(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body, { mode: 0o755 });
  }
}

// A git repo holding `files`, committed (bar what its .gitignore says).
function repo(files: Record<string, string>, links: Record<string, string> = {}): string {
  const dir = fs.realpathSync(tmpDir());
  git(dir, 'init', '-q');
  write(dir, files);
  for (const [name, to] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.symlinkSync(to, path.join(dir, name));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'x', '--allow-empty');
  return dir;
}

const patchWith = (run: string) => `export default { actions: [{ title: 'Go', run: ${JSON.stringify(run)} }] };\n`;
const patchFile = (dir: string) => path.join(dir, '.threadbear', 'patches', 't.ts');

// A thread in `dir`, whose patch is trusted as it stands, on a real store.
async function trustedThread(dir: string) {
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), patchTrust: trust, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  assert.ok(trust.trust(patchFile(dir), patchHash(patchFile(dir)).hash));
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: dir });
  await tick();
  await h.runner.patchesIdle();
  return { h, trust, thread };
}

// The patch's trusted set as a thread would see it, on a store that trusts it.
async function loaded(dir: string) {
  const trust = new PatchTrust();
  assert.ok(trust.trust(patchFile(dir), patchHash(patchFile(dir)).hash));
  const set = await loadPatchSet(dir, fs.realpathSync(tmpDir()), new Map(), [], [], undefined, trust as PatchGate);
  return set.patches.find((p) => p.id === 't')!;
}

// ---- a patch action must not run when the scanner failed

test('an action whose follow stops is refused: what comes after the stop was never seen', async () => {
  const cases: [string, Record<string, string>][] = [
    ['eval', { 'a.sh': '#!/bin/sh\neval "$X"\n./evil.sh\n', 'evil.sh': '#!/bin/sh\necho evil\n' }],
    ['a command in a variable', { 'a.sh': '#!/bin/sh\n$CMD\n./evil.sh\n', 'evil.sh': '#!/bin/sh\necho evil\n' }],
    ['a pipe into a shell', { 'a.sh': '#!/bin/sh\ncurl -s x | sh\n./evil.sh\n', 'evil.sh': '#!/bin/sh\n' }],
    ['another language', { 'a.sh': '#!/bin/sh\npython3 helper.py\n./evil.sh\n', 'helper.py': 'print(1)\n', 'evil.sh': '#!/bin/sh\n' }],
    ['a script that isn\'t there', { 'a.sh': '#!/bin/sh\n./later.sh\n./evil.sh\n', 'evil.sh': '#!/bin/sh\n' }],
    ['a dynamic import', { 'a.sh': '#!/bin/sh\nnode a.mjs\n./evil.sh\n', 'a.mjs': 'const n = "./x.mjs"; await import(n);\n', 'evil.sh': '#!/bin/sh\n' }],
    ['a sourced file worked out', { 'a.sh': '#!/bin/sh\n. "$1"\n./evil.sh\n', 'evil.sh': '#!/bin/sh\n' }],
  ];
  for (const [name, files] of cases) {
    const dir = repo({ '.threadbear/patches/t.ts': patchWith('sh ./a.sh'), ...files });
    const info = await loaded(dir);
    assert.match(info.error ?? '', /^Not run: its action "Go" /, name);
    assert.match(info.error ?? '', /can't be checked|can't follow/, name);
  }
  // On the command itself too: a program whose loads can't be followed.
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('python3 tool.py'), 'tool.py': 'print(1)\n' });
  assert.match((await loaded(dir)).error ?? '', /^Not run: its action "Go" /);
});

test('an action that can be followed all the way still loads and runs', async () => {
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('sh ./a.sh'), 'a.sh': '#!/bin/sh\n./b.sh\n', 'b.sh': '#!/bin/sh\necho hi\n' });
  const { h, thread } = await trustedThread(dir);
  const r = await h.runner.runAction(thread.id, 't.go');
  assert.equal(r.ok, true);
  assert.ok(h.events(thread.id).some((e) => e.type === 'action.run' && /hi/.test(e.text)));
});

// ---- the bytes an action runs are the ones the hash covered

test('an action whose script changed since the patch was last looked at is refused when pressed, and the changed bytes do not run', async () => {
  const marks = tmpDir();
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('sh ./a.sh'), 'a.sh': `#!/bin/sh\n./b.sh\n`, 'b.sh': `#!/bin/sh\necho good\n` });
  const { h, thread } = await trustedThread(dir);
  // A pull changes what it reaches, a level down, after the patch was checked.
  fs.writeFileSync(path.join(dir, 'b.sh'), `#!/bin/sh\ntouch ${marks}/ran\n`);
  await assert.rejects(h.runner.runAction(thread.id, 't.go'), /changed since it was trusted/);
  assert.ok(!fs.existsSync(path.join(marks, 'ran')));
  // The next look at the patch shows it waiting to be trusted.
  await h.runner.patchesIdle();
  const set = (h.runner as any).patchSet((h.runner as any).mustGet(thread.id));
  assert.equal(set.patches.find((p: any) => p.id === 't')?.untrusted, 'changed');
});

test('an action reaching a symlink that was retargeted is refused, even to identical bytes', async () => {
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('sh ./l.sh'), 'real.sh': '#!/bin/sh\necho 1\n', 'other.sh': '#!/bin/sh\necho 1\n' }, { 'l.sh': 'real.sh' });
  const { h, thread } = await trustedThread(dir);
  fs.rmSync(path.join(dir, 'l.sh'));
  fs.symlinkSync('other.sh', path.join(dir, 'l.sh'));
  await assert.rejects(h.runner.runAction(thread.id, 't.go'), /changed since it was trusted/);
});

test('a project patch\'s command action that lost its binding is refused rather than run', async () => {
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('echo hi') });
  const { h, thread } = await trustedThread(dir);
  // As a copy that didn't keep the symbol would be.
  const set = (h.runner as any).patchSet((h.runner as any).mustGet(thread.id));
  set.actions = set.actions.map((a: any) => JSON.parse(JSON.stringify(a)));
  await assert.rejects(h.runner.runAction(thread.id, 't.go'), /no version of its patch/);
});

test('what travels to clients has no trace of the binding', async () => {
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('echo hi') });
  const { h, thread } = await trustedThread(dir);
  const set = (h.runner as any).patchSet((h.runner as any).mustGet(thread.id));
  const wire = JSON.parse(JSON.stringify(set.actions.find((a: any) => a.id === 't.go')));
  assert.deepEqual(Object.keys(wire).sort(), ['command', 'folder', 'id', 'kind', 'patch', 'title'].sort());
  assert.equal((await h.runner.runAction(thread.id, 't.go')).ok, true);
});

// ---- package code

const IGNORE_NM = { '.gitignore': 'node_modules\n' };
const hashAfter = (dir: string, change: string) => {
  const before = patchHash(patchFile(dir));
  fs.appendFileSync(path.join(dir, change), '\n// changed\n');
  const after = patchHash(patchFile(dir));
  return { before, after };
};
const track = (dir: string, ...files: string[]) => {
  git(dir, 'add', '-f', ...files);
  git(dir, 'commit', '-qm', 'y', '--allow-empty');
};

test('a package the repo commits is hashed when a command reaches it through a package manager, with no import naming it', () => {
  const cases: [string, string, Record<string, string>, string, string[]][] = [
    ['npm run, its script runs a committed bin', 'npm run x', { 'package.json': JSON.stringify({ scripts: { x: 'tool' } }), 'node_modules/.bin/tool': '#!/bin/sh\necho\n' }, 'node_modules/.bin/tool', ['node_modules/.bin/tool']],
    ['npx of a committed package', 'npx tool', { 'package.json': '{}', 'node_modules/.bin/tool': '#!/bin/sh\necho\n', 'node_modules/tool/cli.js': 'x' }, 'node_modules/tool/cli.js', ['node_modules/.bin/tool', 'node_modules/tool/cli.js']],
    ['an install, a committed package\'s lifecycle script', 'npm install', { 'package.json': '{}', 'node_modules/dep/package.json': '{"scripts":{"postinstall":"node p.js"}}', 'node_modules/dep/p.js': 'x' }, 'node_modules/dep/p.js', ['node_modules/dep/package.json', 'node_modules/dep/p.js']],
    ['node --import of a committed package', 'node --import pk s.mjs', { 's.mjs': '', 'node_modules/pk/index.js': 'x' }, 'node_modules/pk/index.js', ['node_modules/pk/index.js']],
    ['nested imports through exports', 'node s.mjs', { 's.mjs': "import 'pk/a'", 'node_modules/pk/package.json': '{"exports":{"./a":"./lib/a.js"}}', 'node_modules/pk/lib/a.js': "import './b.js'", 'node_modules/pk/lib/b.js': 'x' }, 'node_modules/pk/lib/b.js', ['node_modules/pk/package.json', 'node_modules/pk/lib/a.js', 'node_modules/pk/lib/b.js']],
  ];
  for (const [name, run, files, change, tracked] of cases) {
    const dir = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(run), ...files });
    track(dir, ...tracked);
    const { before, after } = hashAfter(dir, change);
    assert.notEqual(after.hash, before.hash, name);
    assert.equal(after.incomplete, undefined, name);
  }
});

test('a workspace package linked into node_modules is the repo\'s own code, by import or by bin', () => {
  const linked = { 'node_modules/wsp': '../packages/wsp' };
  const pkg = { 'packages/wsp/package.json': '{"name":"wsp","exports":"./lib/index.js"}', 'packages/wsp/lib/index.js': "import './deep.js'\n", 'packages/wsp/lib/deep.js': 'x\n' };
  for (const [name, run, extra, links, change] of [
    ['a script importing it', 'node s.mjs', { 's.mjs': "import 'wsp'\n", ...pkg }, linked, 'packages/wsp/lib/deep.js'],
    ['a subpath of it', 'node s.mjs', { 's.mjs': "import 'wsp/lib/deep.js'\n", ...pkg }, linked, 'packages/wsp/lib/deep.js'],
    ['its exports', 'node s.mjs', { 's.mjs': "import 'wsp'\n", ...pkg }, linked, 'packages/wsp/package.json'],
    ['a shell script running that', 'sh a.sh', { 'a.sh': 'node s.mjs\n', 's.mjs': "import 'wsp'\n", ...pkg }, linked, 'packages/wsp/lib/deep.js'],
    ['a package script\'s bin', 'npm run x', { 'package.json': JSON.stringify({ scripts: { x: 'tool' } }), 'packages/t/bin.js': '#!/usr/bin/env node\n' }, { 'node_modules/.bin/tool': '../../packages/t/bin.js' }, 'packages/t/bin.js'],
    ['npx of its bin', 'npx tool', { 'package.json': '{}', 'packages/t/bin.js': '#!/usr/bin/env node\n' }, { 'node_modules/.bin/tool': '../../packages/t/bin.js' }, 'packages/t/bin.js'],
    ['yarn with its bin by name', 'yarn tool', { 'package.json': '{}', 'packages/t/bin.js': '#!/usr/bin/env node\n' }, { 'node_modules/.bin/tool': '../../packages/t/bin.js' }, 'packages/t/bin.js'],
  ] as [string, string, Record<string, string>, Record<string, string>, string][]) {
    const dir = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(run), ...extra }, links);
    const { before, after } = hashAfter(dir, change);
    assert.notEqual(after.hash, before.hash, name);
  }
});

test('Codex review: a package\'s bin folder put on PATH by hand is followed as a package script\'s is', () => {
  for (const pathWord of ['"$PWD/node_modules/.bin:$PATH"', './node_modules/.bin:$PATH']) {
    const committed = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(`PATH=${pathWord} tool`), 'node_modules/.bin/tool': '#!/bin/sh\necho\n' });
    track(committed, 'node_modules/.bin/tool');
    const before = patchHash(patchFile(committed));
    fs.appendFileSync(path.join(committed, 'node_modules/.bin/tool'), '# changed\n');
    assert.notEqual(patchHash(patchFile(committed)).hash, before.hash, pathWord);
    const linked = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(`PATH=${pathWord} tool`), 'packages/t/bin.js': '#!/usr/bin/env node\n' }, { 'node_modules/.bin/tool': '../../packages/t/bin.js' });
    const { before: b, after } = hashAfter(linked, 'packages/t/bin.js');
    assert.notEqual(after.hash, b.hash, `${pathWord} to a workspace bin`);
  }
});

test('Codex review: a script importing its own package by name is refused, however it is reached, a later rename too', async () => {
  const files = { 'package.json': '{"name":"p","type":"module","exports":"./payload.mjs"}', 'a.mjs': "import 'p';\n", 'payload.mjs': '1;\n' };
  // An action.
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('node a.mjs'), ...files });
  assert.match((await loaded(dir)).error ?? '', /its own package by name/);
  // A check.
  assert.match(checkDigest('node a.mjs', dir).problem ?? '', /its own package by name/);
  // A Claude hook.
  const c = claudeRepo(hook('node a.mjs'), files);
  assert.match(claudeCommands(c.dir, c.home)?.incomplete ?? '', /its own package by name/);
  // Trusted while it was a real package's name, then a pull renames the repo's.
  const later = repo({ '.threadbear/patches/t.ts': patchWith('node a.mjs'), ...IGNORE_NM, 'package.json': '{"name":"other"}', 'a.mjs': "import 'p';\n", 'node_modules/p/index.js': '1;\n', 'payload.mjs': '1;\n' });
  const { h, thread } = await trustedThread(later);
  fs.writeFileSync(path.join(later, 'package.json'), files['package.json']);
  await assert.rejects(h.runner.runAction(thread.id, 't.go'), /its own package by name/);
  // A package's own name with no exports goes to node_modules, so it's fine.
  assert.equal(checkDigest('node a.mjs', repo({ 'package.json': '{"name":"p"}', 'a.mjs': "import 'p';\n" })).problem, undefined);
});

test('Codex review: a linked package that could send an import past what was hashed is refused', () => {
  const base = { ...IGNORE_NM, 'a.mjs': "import 'wsp';\n" };
  const link = { 'node_modules/wsp': '../packages/wsp' };
  // Through a link to a folder.
  const viaDir = repo({ ...base, 'packages/wsp/package.json': '{"exports":"./lib/run.js"}', 'payload/run.js': '1;\n' }, { ...link, 'packages/wsp/lib': '../../payload' });
  assert.match(checkDigest('node a.mjs', viaDir).problem ?? '', /is a link/);
  // A CommonJS file with no extension, which Node runs though nothing says it's code.
  const bare = repo({ ...base, 'packages/wsp/package.json': '{"exports":"./payload"}', 'packages/wsp/payload': "require('../../evil.js')\n", 'evil.js': '1;\n' }, link);
  assert.match(checkDigest('node a.mjs', bare).problem ?? '', /isn't JavaScript/);
  // A native addon.
  const addon = repo({ ...base, 'packages/wsp/package.json': '{}', 'packages/wsp/x.node': 'x' }, link);
  assert.match(checkDigest('node a.mjs', addon).problem ?? '', /native addon/);
  // A file of any kind in it is hashed, as its manifest could name it later.
  const data = repo({ ...base, 'packages/wsp/package.json': '{}', 'packages/wsp/index.js': '1;\n', 'packages/wsp/data.txt': 'x' }, link);
  const before = checkDigest('node a.mjs', data);
  assert.equal(before.problem, undefined);
  fs.appendFileSync(path.join(data, 'packages/wsp/data.txt'), 'y');
  assert.notEqual(checkDigest('node a.mjs', data).hash, before.hash);
});

test('Codex review: a committed package\'s lifecycle script is followed, past node_modules too', () => {
  for (const run of ['npm rebuild', 'npm install', 'npm rebuild --dangerously-allow-all-scripts']) {
    const dir = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(run), 'package.json': '{}', 'node_modules/dep/package.json': '{"name":"dep","scripts":{"postinstall":"node ../../payload.mjs"}}', 'payload.mjs': '1;\n' });
    track(dir, 'node_modules/dep/package.json');
    const { before, after } = hashAfter(dir, 'payload.mjs');
    assert.notEqual(after.hash, before.hash, run);
  }
  // A committed .bin file with no #! runs as a shell script.
  const bin = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith('npm run x'), 'package.json': JSON.stringify({ scripts: { x: 'tool' } }), 'node_modules/.bin/tool': './payload.sh\n', 'payload.sh': '#!/bin/sh\n' });
  track(bin, 'node_modules/.bin/tool');
  const { before, after } = hashAfter(bin, 'payload.sh');
  assert.notEqual(after.hash, before.hash);
});

test('Codex review 2: npx -c, empty PATH entries, a package with no git or node_modules, an installed wrapper, an extensionless subpath', async () => {
  // npx -c runs with the package's bin folder first on PATH.
  for (const run of ['npx -c tool', 'npm exec --call tool']) {
    const dir = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(run), 'package.json': '{}', 'node_modules/.bin/tool': '#!/bin/sh\necho\n' });
    track(dir, 'node_modules/.bin/tool');
    const { before, after } = hashAfter(dir, 'node_modules/.bin/tool');
    assert.notEqual(after.hash, before.hash, run);
  }
  const linkedBin = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith('npx -c tool'), 'package.json': '{}', 'packages/t/bin.js': '#!/usr/bin/env node\n' }, { 'node_modules/.bin/tool': '../../packages/t/bin.js' });
  const viaCall = hashAfter(linkedBin, 'packages/t/bin.js');
  assert.notEqual(viaCall.after.hash, viaCall.before.hash, 'npx -c of a workspace bin');
  // An empty PATH entry is the current folder, wherever it is.
  for (const value of [':$PATH', '$PATH:', '/usr/bin::/bin', '']) {
    assert.match(checkDigest(`PATH="${value}" tool`, repo({ tool: '#!/bin/sh\n' })).problem ?? '', /on PATH/, value);
  }
  // Still fine: an absolute folder outside the repo, before the old PATH.
  assert.equal(checkDigest('PATH="/opt/homebrew/bin:$PATH" gh pr list', repo({ a: '' })).problem, undefined);
  // Node's self-reference needs neither git nor a node_modules.
  const bare = fs.realpathSync(tmpDir());
  write(bare, { 'package.json': '{"name":"p","exports":"./payload.mjs"}', 'a.mjs': "import 'p';\n", 'payload.mjs': '1;\n' });
  assert.match(checkDigest('node a.mjs', bare).problem ?? '', /its own package by name/);
  // An installed package may import a workspace one the script never names.
  const wrapped = repo({ ...IGNORE_NM, 'a.cjs': "require('wrapper')\n", 'node_modules/wrapper/index.js': "require('wsp')\n", 'packages/wsp/index.js': '1;\n', 'packages/wsp/package.json': '{}' }, { 'node_modules/wsp': '../packages/wsp' });
  const seen = checkDigest('node a.cjs', wrapped);
  assert.equal(seen.problem, undefined);
  fs.appendFileSync(path.join(wrapped, 'packages/wsp/index.js'), '2;\n');
  assert.notEqual(checkDigest('node a.cjs', wrapped).hash, seen.hash);
  // A scoped link too.
  const scoped = repo({ ...IGNORE_NM, 'a.cjs': "require('zod')\n", 'packages/s/index.js': '1;\n', 'packages/s/package.json': '{}' }, { 'node_modules/@me/s': '../../packages/s' });
  const before = checkDigest('node a.cjs', scoped);
  fs.appendFileSync(path.join(scoped, 'packages/s/index.js'), '2;\n');
  assert.notEqual(checkDigest('node a.cjs', scoped).hash, before.hash);
  // A subpath with no extension, which require() runs as CommonJS.
  const sub = repo({ ...IGNORE_NM, 'a.cjs': "require('wsp/payload')\n", 'packages/wsp/package.json': '{}', 'packages/wsp/payload': "require('../../evil.cjs')\n", 'evil.cjs': '1;\n' }, { 'node_modules/wsp': '../packages/wsp' });
  assert.match(checkDigest('node a.cjs', sub).problem ?? '', /isn't JavaScript/);
  // And a committed package's, and a pattern in its exports.
  const committed = repo({ ...IGNORE_NM, 'a.cjs': "require('pk/payload')\n", 'node_modules/pk/payload': "require('../../evil.cjs')\n", 'evil.cjs': '1;\n' });
  track(committed, 'node_modules/pk/payload');
  assert.match(checkDigest('node a.cjs', committed).problem ?? '', /isn't JavaScript/);
  const pattern = repo({ ...IGNORE_NM, 'a.cjs': "require('wsp/x')\n", 'packages/wsp/package.json': '{"exports":{"./*":"./lib/*"}}', 'packages/wsp/lib/x': '1;\n' }, { 'node_modules/wsp': '../packages/wsp' });
  assert.match(checkDigest('node a.cjs', pattern).problem ?? '', /isn't JavaScript/);
  // A file of the repo's required by its exact name, whatever it's called.
  const exact = repo({ 'a.cjs': "require('./payload.bin')\n", 'payload.bin': "require('./evil.cjs')\n", 'evil.cjs': '1;\n' });
  assert.match(checkDigest('node a.cjs', exact).problem ?? '', /isn't JavaScript/);
  // Sourcing a script outside the repo can change this shell.
  const outside = fs.realpathSync(tmpDir());
  write(outside, { 'enter.sh': 'cd /tmp\n' });
  const sourced = checkDigest(`. ${outside}/enter.sh; ./check.sh`, repo({ 'check.sh': '#!/bin/sh\n' }));
  assert.match(sourced.problem ?? '', /sources .*outside the repo/);
  assert.ok(sourced.files.includes(path.join(outside, 'enter.sh')), 'hashed all the same');
});

test('Codex review 3: a committed file by a bare name, a link in a linked package, --call=, and preloads a hash cannot follow', () => {
  const file = repo({ ...IGNORE_NM, 'a.cjs': "require('payload')\n", 'node_modules/payload': "require('../evil.cjs')\n", 'evil.cjs': '1;\n' });
  track(file, 'node_modules/payload');
  assert.match(checkDigest('node a.cjs', file).problem ?? '', /isn't JavaScript/);
  // A link standing in for what its name says it is.
  const entry = repo({ ...IGNORE_NM, 'a.cjs': "require('wsp')\n", 'packages/wsp/package.json': '{"name":"wsp","exports":"./entry.js"}', payload: "require('./evil.cjs')\n", 'evil.cjs': '1;\n' }, { 'node_modules/wsp': '../packages/wsp', 'packages/wsp/entry.js': '../../payload' });
  assert.match(checkDigest('node a.cjs', entry).problem ?? '', /is a link/);
  // However npm reads --call.
  for (const run of ['npx --call=tool', 'npm exec --call=tool', 'npx --cal=tool', 'npx -c=tool']) {
    const dir = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(run), 'package.json': '{}', 'node_modules/.bin/tool': '#!/bin/sh\necho\n' });
    track(dir, 'node_modules/.bin/tool');
    const { before, after } = hashAfter(dir, 'node_modules/.bin/tool');
    assert.notEqual(after.hash, before.hash, run);
  }
  // A preload that maps through package.json, or that's code in a URL.
  for (const preload of ['#boot', 'data:text/javascript,1', 'https://x.example/a.mjs']) {
    const dir = repo({ 'package.json': '{"imports":{"#boot":"./payload.mjs"}}', 'a.cjs': '', 'payload.mjs': '1;\n' });
    assert.match(checkDigest(`node --import '${preload}' a.cjs`, dir).problem ?? '', /can't follow/, preload);
  }
  // A builtin is fine.
  assert.equal(checkDigest("node --import node:fs a.cjs", repo({ 'a.cjs': '' })).problem, undefined);
});

test('narrowed, by Mike\'s decision: a package npm installed stays out of the hash, so an install never asks again', () => {
  // Real files under an ignored node_modules: changing or reinstalling them
  // changes nothing, however they're reached.
  for (const [run, extra] of [
    ['node s.mjs', { 's.mjs': "import 'zod'\n" }],
    ['npm run x', { 'package.json': JSON.stringify({ scripts: { x: 'zod' } }) }],
    ['npx zod', { 'package.json': '{}' }],
  ] as [string, Record<string, string>][]) {
    const dir = repo({ ...IGNORE_NM, '.threadbear/patches/t.ts': patchWith(run), 'node_modules/zod/index.js': 'x', 'node_modules/.bin/zod': '#!/bin/sh\n', ...extra });
    const { before, after } = hashAfter(dir, 'node_modules/zod/index.js');
    assert.equal(after.hash, before.hash, run);
    assert.equal(hashAfter(dir, 'node_modules/.bin/zod').after.hash, before.hash, run);
  }
});

// ---- Claude project trust

const hook = (command: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } });
function claudeRepo(settings: unknown, files: Record<string, string>, links: Record<string, string> = {}, mcp?: unknown) {
  const home = fs.realpathSync(tmpDir());
  const dir = path.join(home, 'r');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  write(dir, { '.claude/settings.json': JSON.stringify(settings), ...(mcp ? { '.mcp.json': JSON.stringify(mcp) } : {}), ...files });
  for (const [name, to] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.symlinkSync(to, path.join(dir, name));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'x', '--allow-empty');
  return { home, dir };
}

test('Claude trust: every edge a hook or MCP server reaches is hashed, and a change stops the trusted version counting', () => {
  const cases: [string, unknown, Record<string, string>, string, Record<string, string>?, unknown?][] = [
    ['imports', hook('node a.mjs'), { 'a.mjs': "import './b.mjs'", 'b.mjs': "import './c.mjs'", 'c.mjs': '' }, 'c.mjs'],
    ['sourced scripts', hook('sh ./a.sh'), { 'a.sh': '#!/bin/sh\n. ./lib.sh\n', 'lib.sh': 'echo 1\n' }, 'lib.sh'],
    ['wrappers', hook('nohup ./a.sh'), { 'a.sh': '#!/bin/sh\n./b.sh\n', 'b.sh': '#!/bin/sh\necho\n' }, 'b.sh'],
    ['a status line', { statusLine: { type: 'command', command: './s.sh' } }, { 's.sh': '#!/bin/sh\n./t.sh\n', 't.sh': '#!/bin/sh\necho\n' }, 't.sh'],
    ['an MCP server', {}, { 'server.js': "require('./lib.js')", 'lib.js': '' }, 'lib.js', {}, { mcpServers: { s: { command: 'node', args: ['server.js'] } } }],
    ['a committed package', hook('node a.mjs'), { 'a.mjs': "import 'zod'", 'vendor.txt': '' }, 'a.mjs'],
    ['a workspace package', hook('node a.mjs'), { '.gitignore': 'node_modules\n', 'a.mjs': "import 'wsp'", 'packages/wsp/index.js': 'x', 'packages/wsp/package.json': '{"name":"wsp"}' }, 'packages/wsp/index.js', { 'node_modules/wsp': '../packages/wsp' }],
    ['a workspace package, through a script', hook('sh a.sh'), { '.gitignore': 'node_modules\n', 'a.sh': 'node b.mjs\n', 'b.mjs': "import 'wsp/sub.js'", 'packages/wsp/sub.js': 'x', 'packages/wsp/package.json': '{"name":"wsp"}' }, 'packages/wsp/sub.js', { 'node_modules/wsp': '../packages/wsp' }],
  ];
  for (const [name, settings, files, change, links, mcp] of cases) {
    const { home, dir } = claudeRepo(settings, files, links ?? {}, mcp);
    const a = claudeCommands(dir, home);
    assert.ok(a && !a.incomplete, `${name}: ${a?.incomplete}`);
    const store = new PatchTrust({ claudeHome: home });
    assert.ok(store.trustClaude(dir, a!.hash));
    assert.equal(store.checkClaude(dir).trusted, true, name);
    fs.appendFileSync(path.join(dir, change), '\n// changed\n');
    assert.equal(store.checkClaude(dir).trusted, false, name);
  }
});

test('Claude trust: what can\'t be followed can\'t be trusted, and that includes names a shell finds on PATH, packages by name and scan failures', () => {
  const cases: [string, unknown, Record<string, string>, RegExp, unknown?][] = [
    ['a PATH command', hook('prettier --check .'), {}, /short list/],
    ['a script by its bare name', hook('a.sh'), { 'a.sh': '#!/bin/sh\n' }, /short list/],
    ['npx', hook('npx tool'), { 'package.json': '{}' }, /by name/],
    ['an installed package\'s program', hook('npm run x'), { '.gitignore': 'node_modules\n', 'package.json': JSON.stringify({ scripts: { x: 'tool' } }), 'node_modules/.bin/tool': '#!/bin/sh\n' }, /package's program/],
    ['a dynamic import', hook('node a.mjs'), { 'a.mjs': 'const n = "x"; await import(n);' }, /worked out as it runs/],
    ['eval before a dependency', hook('sh a.sh'), { 'a.sh': 'eval "$X"\n./b.sh\n', 'b.sh': '' }, /eval/],
    ['another language', hook('python3 x.py'), { 'x.py': '' }, /isn't a shell script|short list|can't follow/],
    ['an MCP server by package', {}, {}, /by name/, { mcpServers: { s: { command: 'npx', args: ['-y', 'x'] } } }],
    ['an MCP server by uvx', {}, {}, /short list/, { mcpServers: { s: { command: 'uvx', args: ['x'] } } }],
    // Its files are followed from the folder, so one starting elsewhere runs
    // others of the same names, and a change to those went unseen.
    ['an MCP server with its own cwd', {}, { 'sub/s.js': '', 's.js': '' }, /own cwd/, { mcpServers: { s: { command: 'node', args: ['s.js'], cwd: 'sub' } } }],
  ];
  for (const [name, settings, files, why, mcp] of cases) {
    const { home, dir } = claudeRepo(settings, files, {}, mcp);
    const a = claudeCommands(dir, home);
    assert.match(a?.incomplete ?? '', why, name);
    const store = new PatchTrust({ claudeHome: home });
    store.trustClaude(dir, a!.hash);
    assert.equal(store.checkClaude(dir).trusted, false, name);
  }
});

test('narrowed, by Mike\'s decision: a hook importing a package npm installed is trusted without its bytes', () => {
  const { home, dir } = claudeRepo(hook('node a.mjs'), { '.gitignore': 'node_modules\n', 'a.mjs': "import 'zod'", 'node_modules/zod/index.js': 'x' });
  const a = claudeCommands(dir, home)!;
  assert.equal(a.incomplete, undefined);
  fs.appendFileSync(path.join(dir, 'node_modules/zod/index.js'), 'y');
  assert.equal(claudeCommands(dir, home)!.hash, a.hash);
});

// ---- a schedule's check keeps to what was approved

function scheduler(o: { result?: () => CheckResult } = {}) {
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  const h = makeHarness(undefined, {}, { patchTrust: trust, panelsRoot: fs.realpathSync(tmpDir()) });
  const ran: { command: string; cwd: string }[] = [];
  const sched = new Scheduler({
    runner: h.runner,
    home: h.home,
    clock: h.clock,
    log: nullLogger,
    zone: () => 'UTC',
    checksOn: () => true,
    runCheck: async (p) => {
      ran.push({ command: p.command, cwd: p.cwd });
      return o.result?.() ?? { ok: true, output: 'news' };
    },
  });
  sched.start();
  return { h, sched, ran, trust };
}

const sentTo = (h: ReturnType<typeof makeHarness>, title: string) => h.runner.list(['inbox', 'snoozed', 'archived']).filter((t) => t.title === title);
const toldHeld = (h: ReturnType<typeof makeHarness>): number => sentTo(h, 'Watch').filter((t) => h.events(t.id).some((e) => e.type === 'user.message' && e.text.includes(HELD_EXTRA))).length;
async function due(h: ReturnType<typeof makeHarness>) {
  h.clock.advance(5 * MIN);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  // Its thread finishes, or a repeating schedule skips its next run for that.
  const s = h.adapter.last;
  if (s) {
    try {
      s.init();
      s.result('completed');
    } catch {
      // Already finished.
    }
  }
  await tick(6);
}

test('schedule check: a change to what it runs holds it, the thread is told once, and passing the check again approves it as it is now', async () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\n./helper.sh\n', 'helper.sh': '#!/bin/sh\necho new\n' });
  const { h, sched, ran } = scheduler();
  const sc = await sched.create({ text: 'Look', title: 'Watch', cron: '*/5 * * * *', cwd: dir, check: './check.sh' });
  await due(h);
  assert.equal(ran.length, 1, 'approved as it was');

  // An untrusted pull changes a script it reaches, a level down.
  fs.appendFileSync(path.join(dir, 'helper.sh'), 'touch /tmp/evil\n');
  await due(h);
  assert.equal(ran.length, 1, 'not run');
  assert.equal(sentTo(h, 'Watch').length, 2, 'the run went ahead, to say so');
  assert.equal(toldHeld(h), 1);
  // Said once: no agent every five minutes.
  await due(h);
  assert.equal(ran.length, 1);
  assert.equal(sentTo(h, 'Watch').length, 2);
  assert.equal(sched.find(sc.id).lastRun?.note, HELD_SKIP);

  // Changing anything else approves nothing.
  await sched.update({ scheduleId: sc.id, title: 'Watch' });
  await due(h);
  assert.equal(ran.length, 1);

  // Passing the check again does.
  await sched.update({ scheduleId: sc.id, check: './check.sh' });
  await due(h);
  assert.equal(ran.length, 2);
  // And a later version is told about afresh.
  fs.appendFileSync(path.join(dir, 'helper.sh'), '# again\n');
  await due(h);
  assert.equal(ran.length, 2);
  assert.equal(toldHeld(h), 2);
  sched.stop();
});

test('schedule check: a symlink retargeted, a file that turns up, a package the repo commits, or a move all hold it', async () => {
  const mutations: [string, Record<string, string>, Record<string, string>, string, (dir: string) => void][] = [
    ['a symlink retargeted', { 'real.sh': '#!/bin/sh\n', 'other.sh': '#!/bin/sh\n' }, { 'l.sh': 'real.sh' }, './l.sh', (d) => {
      fs.rmSync(path.join(d, 'l.sh'));
      fs.symlinkSync('other.sh', path.join(d, 'l.sh'));
    }],
    ['a helper that turns up', { 'a.mjs': "import './later.mjs'\n" }, {}, 'node a.mjs', (d) => fs.writeFileSync(path.join(d, 'later.mjs'), '')],
    ['a workspace package', { '.gitignore': 'node_modules\n', 'a.mjs': "import 'wsp'\n", 'packages/wsp/index.js': 'x', 'packages/wsp/package.json': '{}' }, { 'node_modules/wsp': '../packages/wsp' }, 'node a.mjs', (d) => fs.appendFileSync(path.join(d, 'packages/wsp/index.js'), 'y')],
    ['a package script', { 'package.json': JSON.stringify({ scripts: { x: './a.sh' } }), 'a.sh': '#!/bin/sh\n' }, {}, 'npm run x', (d) => fs.appendFileSync(path.join(d, 'a.sh'), '# y\n')],
  ];
  for (const [name, files, links, check, mutate] of mutations) {
    const dir = repo(files, links);
    const { h, sched, ran } = scheduler();
    await sched.create({ text: 'Look', title: 'Watch', cron: '*/5 * * * *', cwd: dir, check });
    await due(h);
    assert.equal(ran.length, 1, `${name}: runs as approved`);
    mutate(dir);
    await due(h);
    assert.equal(ran.length, 1, `${name}: held`);
    sched.stop();
  }
});

test('schedule check: a thread moved to another folder holds it, and a folder that has gone too', async () => {
  const one = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const two = repo({ 'check.sh': '#!/bin/sh\necho other\n' });
  const { h, sched, ran } = scheduler();
  const { thread: t } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: one });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  await sched.create({ text: 'Look', title: 'Watch', cron: '*/5 * * * *', threadId: t.id, check: './check.sh' });
  await due(h);
  assert.equal(ran.length, 1);
  (h.runner as any).mustGet(t.id).rec.cwd = two;
  await due(h);
  assert.equal(ran.length, 1, 'held in the other folder');
  sched.stop();

  const gone = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const b = scheduler();
  await b.sched.create({ text: 'Look', title: 'Gone', cron: '*/5 * * * *', cwd: gone, check: './check.sh' });
  fs.rmSync(gone, { recursive: true });
  await due(b.h);
  assert.equal(b.ran.length, 0, "it'd run somewhere else");
  b.sched.stop();
});

test('schedule check: a script outside the repo, run by its path, is bound too, and what it runs from its own folder', async () => {
  const outside = fs.realpathSync(tmpDir());
  write(outside, { 'poll.sh': '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\n', 'lib.sh': 'echo\n', 'poll.py': 'print(1)\n' });
  const cwd = repo({ 'x.txt': '' });
  for (const [check, change] of [
    [`${outside}/poll.sh`, 'poll.sh'],
    [`${outside}/poll.sh --flag`, 'lib.sh'],
    [`sh ${outside}/poll.sh`, 'lib.sh'],
    [`/usr/bin/python3 ${outside}/poll.py`, 'poll.py'],
  ] as const) {
    const before = checkDigest(check, cwd);
    fs.appendFileSync(path.join(outside, change), '# changed\n');
    assert.notEqual(checkDigest(check, cwd).hash, before.hash, check);
  }
  // Its relative paths are from where it runs, not beside it: a script that
  // sources ./helper.sh sources the check folder's.
  write(outside, { 'rel.sh': '#!/bin/sh\n. ./helper.sh\n', 'helper.sh': 'echo fine\n' });
  const here = repo({ 'helper.sh': 'echo fine\n' });
  const seen = checkDigest(`${outside}/rel.sh`, here);
  // It's another repo's file to the script, so that's bound but can't be vouched for further.
  assert.match(seen.problem ?? '', /sources .*helper\.sh/);
  fs.appendFileSync(path.join(here, 'helper.sh'), '# changed\n');
  assert.notEqual(checkDigest(`${outside}/rel.sh`, here).hash, seen.hash);
  // And after a cd it can follow, from there.
  const there = repo({ 'helper.sh': 'echo fine\n' });
  const hop = checkDigest(`cd ${there} && ${outside}/rel.sh`, here);
  fs.appendFileSync(path.join(there, 'helper.sh'), '# changed\n');
  assert.notEqual(checkDigest(`cd ${there} && ${outside}/rel.sh`, here).hash, hop.hash);
  // A system program isn't: an OS update isn't a change to approve.
  assert.deepEqual(checkDigest('/bin/ls -l', cwd).files, []);
});

test('schedule check: a row the backend brought finds no approval here, whatever it says', async () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const { h, sched, ran, trust } = scheduler();
  const sc = await sched.create({ text: 'Look', title: 'Watch', cron: '*/5 * * * *', cwd: dir, check: './check.sh' });
  // As onRows would have it: same schedule, another command.
  (sched as any).items.get(sc.id).check = 'sh ./check.sh; echo smuggled';
  assert.equal(trust.checkApproved('sh ./check.sh; echo smuggled', dir).approved, false);
  await due(h);
  assert.equal(ran.length, 0);
  sched.stop();
});

test('schedule check: approval lives in the runner\'s store, under the folder a worktree shares with its main checkout', () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const worktree = path.join(fs.realpathSync(tmpDir()), 'wt');
  git(dir, 'worktree', 'add', '-q', worktree);
  const file = path.join(tmpDir(), 'patch-trust.json');
  const a = new PatchTrust({ file });
  a.approveCheck('./check.sh', dir);
  // Another runner process, a handover's, reads it.
  assert.equal(new PatchTrust({ file }).checkApproved('./check.sh', dir).approved, true);
  assert.equal(new PatchTrust({ file }).checkApproved('./check.sh', worktree).approved, true);
  // It doesn't count as the folder's patches having been trusted.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3);
});

test('schedule check: approving one doesn\'t make a folder\'s first patch read as changed, and the patch list can\'t approve one', async () => {
  const dir = repo({ '.threadbear/patches/t.ts': patchWith('echo hi'), 'check.sh': '#!/bin/sh\n' });
  const trust = new PatchTrust();
  trust.approveCheck('./check.sh', dir);
  const verdict = await trust.check(patchFile(dir), 1);
  assert.equal(!verdict.trusted && verdict.reason, 'new');
  assert.equal(trust.trust(patchFile(dir), 'check:abc'), false);
});

test('schedule check: Threadbear\'s own checkout binds only the command', () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const trust = new PatchTrust({ always: [dir] });
  trust.approveCheck('./check.sh', dir);
  fs.appendFileSync(path.join(dir, 'check.sh'), '# landed\n');
  assert.equal(trust.checkApproved('./check.sh', dir).approved, true);
  assert.equal(trust.checkApproved('./check.sh; echo x', dir).approved, false);
});

// Ask and Auto: the card approves bytes it can vouch for.
function askTools(cwd: string, mode: 'ask' | 'full', answer: () => void = () => {}) {
  const { h, sched, ran } = scheduler();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd, permissionMode: mode });
  const asked: { title: string }[] = [];
  const control = new Proxy(h.runner, {
    get: (t, k) => {
      if (k === 'requestAgentApproval') {
        return async (_: string, p: { title: string }) => {
          asked.push(p);
          answer();
          return { decision: 'allow' };
        };
      }
      const v = (t as any)[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const tools = buildThreadbearTools(control, thread.id, Date.now, sched as never, undefined, undefined, { scheduleChecks: () => true }) as unknown as { name: string; handler: (a: unknown, e?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }[];
  const call = (name: string, a: unknown) => tools.find((t) => t.name === name)!.handler(a);
  return { h, sched, ran, asked, call, thread };
}

test('schedule check: from a thread that asks first, one whose scripts can\'t be followed is refused before any card', async () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\neval "$X"\n./evil.sh\n', 'evil.sh': '#!/bin/sh\n' });
  const { sched, asked, call } = askTools(dir, 'ask');
  const r = await call('schedule_message', { text: 'Look', cron: '*/5 * * * *', new_thread: true, folder: dir, check: './check.sh' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /can't follow/);
  assert.equal(asked.length, 0);
  assert.equal(sched.list().length, 0);
  sched.stop();
});

test('schedule check: a script changed while the card was up isn\'t approved', async () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const { sched, call } = askTools(dir, 'ask', () => fs.appendFileSync(path.join(dir, 'check.sh'), '# swapped\n'));
  const r = await call('schedule_message', { text: 'Look', cron: '*/5 * * * *', new_thread: true, folder: dir, check: './check.sh' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /changed while the approval card was up/);
  assert.equal(sched.list().length, 0);
  sched.stop();
});

test('Codex review: naming this runner doesn\'t get a thread that asks first past the check on the card', async () => {
  const dir = repo({ 'x.py': 'print(1)\n', 'ok.sh': '#!/bin/sh\necho\n' });
  {
    const { sched, asked, call } = askTools(dir, 'ask');
    const r = await call('schedule_message', { text: 'Look', cron: '*/5 * * * *', new_thread: true, folder: dir, runner: 'runner', check: 'python3 x.py' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /can't follow/);
    assert.equal(asked.length, 0);
    assert.equal(sched.list().length, 0);
    sched.stop();
  }
  {
    const { sched, call } = askTools(dir, 'ask', () => fs.appendFileSync(path.join(dir, 'ok.sh'), '# swapped\n'));
    const r = await call('schedule_message', { text: 'Look', cron: '*/5 * * * *', new_thread: true, folder: dir, runner: 'runner', check: './ok.sh' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /changed while the approval card was up/);
    assert.equal(sched.list().length, 0);
    sched.stop();
  }
  // With no folder here to compare, one that turns out to be this runner's is refused.
  {
    const { sched, call } = askTools(dir, 'ask');
    const r = await call('schedule_message', { text: 'Look', cron: '*/5 * * * *', new_thread: true, runner: 'runner', check: 'echo hi' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /could not be read when it went up/);
    sched.stop();
  }
});

test('Codex review: a thread moved while the card was up approves nothing, even with the same bytes in the new folder', async () => {
  const one = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const two = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const made = askTools(one, 'ask', () => {
    (made.h.runner as any).mustGet(made.thread.id).rec.cwd = two;
  });
  const r = await made.call('schedule_message', { text: 'Look', cron: '*/5 * * * *', threadId: made.thread.id, check: './check.sh' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /or the folder it runs in, changed/);
  assert.equal(made.sched.list().length, 0);
  made.sched.stop();
});

test('Codex review 3: a folder by a link retargeted while the card was up approves nothing', async () => {
  const dir = repo({ 'A/check.sh': '#!/bin/sh\necho\n', 'B/check.sh': '#!/bin/sh\necho\n' }, { link: 'A' });
  const made = askTools(dir, 'ask', () => {
    fs.rmSync(path.join(dir, 'link'));
    fs.symlinkSync('B', path.join(dir, 'link'));
  });
  const r = await made.call('schedule_message', { text: 'Look', cron: '*/5 * * * *', new_thread: true, runner: 'runner', folder: path.join(dir, 'link'), check: './check.sh' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /or the folder it runs in, changed/);
  assert.equal(made.sched.list().length, 0);
  made.sched.stop();
});

test('schedule check: the app\'s methods can\'t widen with a card: one passed along can only refuse', async () => {
  const dir = repo({ 'check.sh': '#!/bin/sh\necho\n' });
  const { sched, ran, h } = scheduler();
  const methods = scheduleMethods(sched);
  await assert.rejects(async () => methods['schedules.create']({ text: 'Look', title: 'Watch', cron: '*/5 * * * *', cwd: dir, check: './check.sh', checkCard: { hash: 'nope', folder: dir } }));
  assert.equal(sched.list().length, 0);
  await methods['schedules.create']({ text: 'Look', title: 'Watch', cron: '*/5 * * * *', cwd: dir, check: './check.sh' });
  await due(h);
  assert.equal(ran.length, 1);
  sched.stop();
});

test('schedule check: a Full thread keeps working, unfollowable scripts included, bound to what can be seen', async () => {
  const dir = repo({ 'check.py': 'print(1)\n' });
  const { h, sched, ran, asked, call } = askTools(dir, 'full');
  h.adapter.last.init();
  h.adapter.last.result('completed');
  const r = await call('schedule_message', { text: 'Look', title: 'Poll', cron: '*/5 * * * *', new_thread: true, folder: dir, check: `python3 ${dir}/check.py` });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(asked.length, 0);
  await due(h);
  assert.equal(ran.length, 1);
  fs.appendFileSync(path.join(dir, 'check.py'), '# changed\n');
  await due(h);
  assert.equal(ran.length, 1, 'what can be seen is still bound');
  sched.stop();
});

test('runCheck still runs what it is given, as the gate is the scheduler\'s', async () => {
  const dir = fs.realpathSync(tmpDir());
  const r = await runCheck({ command: 'echo hi', cwd: dir, home: dir, scheduleId: 's' });
  assert.deepEqual(r, { ok: true, output: 'hi' });
});
