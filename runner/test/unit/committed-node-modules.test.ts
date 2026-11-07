// A repo's committed node_modules is the repo's own code (Mike's call,
// 7 Nov 2026, after Gautam's scan): files git tracks under node_modules,
// submodules included, are hashed into a patch's trust and followed for
// their own imports; packages npm installed (untracked, ignored) aren't, so
// an install never asks again; and when git can't say which is which, the
// patch fails closed (tracked-packages.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { loadPatchSet } from '../../src/patches.ts';
import { PatchTrust, patchHash } from '../../src/patch-trust.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', '-C', cwd, ...args], { stdio: 'pipe' }).toString();

function write(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
}

const patchIn = (folder: string) => path.join(folder, '.threadbear', 'patches', 'tools.ts');

// A real git repo whose patch imports `zod`, and node_modules ignored as
// usual. `commit`: the node_modules files forced into git anyway.
function repo(commit: Record<string, string>, installed: Record<string, string> = {}) {
  const root = tmpDir();
  const folder = path.join(fs.realpathSync(root), 'repo');
  const marks = tmpDir();
  write(folder, {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'repo', type: 'module' }),
    '.threadbear/patches/tools.ts': "import { list } from 'zod';\nexport default { actions: [{ title: 'Go ' + list, run: 'true' }] };\n",
    ...commit,
    ...installed,
  });
  git(folder, 'init', '-q');
  git(folder, 'add', '.');
  for (const f of Object.keys(commit)) git(folder, 'add', '-f', f);
  git(folder, 'commit', '-qm', 'one');
  return { root, folder, marks };
}

const zod = (body: string) => ({
  'node_modules/zod/package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './index.mjs' }),
  'node_modules/zod/index.mjs': body,
});

test("a committed node_modules/zod is hashed with the patch: a pull that changes it asks again, and its new code doesn't run", async () => {
  const { root, folder, marks } = repo(zod("import { n } from './lib.mjs';\nexport const list = n;\n"), {});
  write(folder, { 'node_modules/zod/lib.mjs': 'export const n = 1;\n' });
  git(folder, 'add', '-f', 'node_modules/zod/lib.mjs');
  git(folder, 'commit', '-qm', 'lib');
  const h = patchHash(patchIn(folder));
  assert.equal(h.incomplete, undefined);
  const covered = h.deps.map((d) => path.relative(folder, d.path)).sort();
  assert.deepEqual(covered, ['node_modules/zod/index.mjs', 'node_modules/zod/lib.mjs', 'node_modules/zod/package.json'], 'every committed file, and its import of ./lib.mjs');
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([patchIn(folder)]).length, 1);
  const first = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.deepEqual(first.actions.map((a) => a.title), ['Go 1']);

  // The pull: the committed package's own import now writes a file.
  const ran = path.join(marks, 'zod.ran');
  write(folder, { 'node_modules/zod/lib.mjs': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'x');\nexport const n = 2;\n` });
  git(folder, 'commit', '-qam', 'pull');
  const after = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(after.patches[0]?.untrusted, 'changed');
  assert.deepEqual(after.actions, []);
  assert.equal(fs.existsSync(ran), false, "the pulled-in package code didn't run");
});

test('an installed (untracked, ignored) package is not hashed: reinstalling a new version never asks again', async () => {
  const { root, folder } = repo({}, zod('export const list = 1;\n'));
  const h = patchHash(patchIn(folder));
  assert.equal(h.incomplete, undefined);
  assert.deepEqual(h.deps, []);
  const trust = new PatchTrust();
  trust.trustCurrent([patchIn(folder)]);
  write(folder, { 'node_modules/zod/index.mjs': 'export const list = 2;\n' });
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(set.patches[0]?.untrusted, undefined);
  assert.equal(set.patches[0]?.error, undefined);
  assert.equal(set.actions.length, 1);
});

test('a pull that starts tracking node_modules/zod over the installed copy asks again, though the cached hash read none of its files', async () => {
  const { root, folder, marks } = repo({}, zod('export const list = 1;\n'));
  const trust = new PatchTrust();
  trust.trustCurrent([patchIn(folder)]);
  assert.equal((await trust.check(patchIn(folder), 0)).trusted, true);
  // git checkout writes over an ignored file; then the index changes.
  const ran = path.join(marks, 'shipped.ran');
  write(folder, { 'node_modules/zod/index.mjs': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'x');\nexport const list = 1;\n` });
  const st = fs.statSync(path.join(folder, 'node_modules/zod/index.mjs'));
  git(folder, 'add', '-f', 'node_modules/zod/index.mjs', 'node_modules/zod/package.json');
  git(folder, 'commit', '-qm', 'vendor zod');
  void st;
  const verdict = await trust.check(patchIn(folder), 0);
  assert.equal(verdict.trusted, false);
  assert.equal(verdict.trusted === false && verdict.reason, 'changed');
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.deepEqual(set.actions, []);
  assert.equal(fs.existsSync(ran), false);
});

test("a package another committed package imports, and one an installed package imports, are hashed too: every committed file under node_modules is", () => {
  const { folder } = repo({
    ...zod("import { m } from 'helper';\nexport const list = m;\n"),
    'node_modules/helper/package.json': JSON.stringify({ name: 'helper', type: 'module', exports: './h.mjs' }),
    'node_modules/helper/h.mjs': 'export const m = 1;\n',
    'packages/web/node_modules/deep/x.mjs': 'export default 1;\n',
  });
  const covered = patchHash(patchIn(folder)).deps.map((d) => path.relative(folder, d.path));
  assert.ok(covered.includes('node_modules/helper/h.mjs'));
  assert.ok(covered.includes('packages/web/node_modules/deep/x.mjs'), 'committed anywhere in the repo, as an installed package may import it');
});

test('a package committed as a submodule is followed through it, and a change to the submodule asks again', async () => {
  const lib = tmpDir();
  write(lib, { 'package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './index.mjs' }), 'index.mjs': 'export const list = 1;\n' });
  git(lib, 'init', '-q');
  git(lib, 'add', '.');
  git(lib, 'commit', '-qm', 'lib');
  const { root, folder } = repo({});
  git(folder, 'submodule', '-q', 'add', '-f', lib, 'node_modules/zod');
  git(folder, 'commit', '-qm', 'sub');
  const h = patchHash(patchIn(folder));
  assert.equal(h.incomplete, undefined);
  assert.ok(h.deps.some((d) => d.path === path.join(folder, 'node_modules/zod/index.mjs')));
  const trust = new PatchTrust();
  trust.trustCurrent([patchIn(folder)]);
  fs.writeFileSync(path.join(folder, 'node_modules/zod/index.mjs'), 'export const list = 2;\n');
  git(path.join(folder, 'node_modules/zod'), 'commit', '-qam', 'two');
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(set.patches[0]?.untrusted, 'changed');
});

test("when git can't say what it tracks, or the folder isn't a git checkout, a bare import of a package inside it fails closed", async () => {
  // Not a checkout: node_modules could be from npm or from the zip.
  const plain = tmpDir();
  write(plain, { '.threadbear/patches/tools.ts': "import { list } from 'zod';\nexport default { actions: [{ title: 'Go ' + list, run: 'true' }] };\n", ...zod('export const list = 1;\n') });
  assert.match(patchHash(patchIn(plain)).incomplete ?? '', /isn't a git checkout/);
  // A broken index: git fails.
  const { root, folder } = repo({}, zod('export const list = 1;\n'));
  fs.writeFileSync(path.join(folder, '.git', 'index'), 'not an index');
  assert.match(patchHash(patchIn(folder)).incomplete ?? '', /git couldn't list/);
  const trust = new PatchTrust();
  assert.deepEqual(trust.trustCurrent([patchIn(folder)]), []);
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.match(set.patches[0]?.error ?? '', /git couldn't list/);
  // A builtin needs no git.
  const builtin = tmpDir();
  write(builtin, { '.threadbear/patches/tools.ts': "import path from 'path';\nimport fs from 'node:fs';\nexport default { actions: [{ title: path.sep + typeof fs, run: 'true' }] };\n" });
  assert.equal(patchHash(patchIn(builtin)).incomplete, undefined);
});

test("a committed link in node_modules, or a committed native addon, can't be followed, so the patch fails closed", () => {
  const { folder } = repo({ 'vendor/zod/package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './index.mjs' }), 'vendor/zod/index.mjs': 'export const list = 1;\n' });
  fs.mkdirSync(path.join(folder, 'node_modules'), { recursive: true });
  fs.symlinkSync('../vendor/zod', path.join(folder, 'node_modules/zod'));
  git(folder, 'add', '-f', 'node_modules/zod');
  git(folder, 'commit', '-qm', 'link');
  assert.match(patchHash(patchIn(folder)).incomplete ?? '', /link the repo commits/);
  const addon = repo({ ...zod('export const list = 1;\n'), 'node_modules/zod/x.node': '\0' });
  assert.match(patchHash(patchIn(addon.folder)).incomplete ?? '', /native addon/);
});

test("a script a patch's command runs that imports a committed package has that package hashed too", () => {
  const { folder } = repo(zod('export const list = 1;\n'));
  write(folder, {
    'scripts/count.mjs': "import { list } from 'zod';\nconsole.log(list);\n",
    '.threadbear/patches/tools.ts': "export default { panels: [{ title: 'N', url: 'http://localhost:1', badge: async ({ sh }) => Number(await sh('node scripts/count.mjs')) }] };\n",
  });
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'script');
  const covered = patchHash(patchIn(folder)).deps.map((d) => path.relative(folder, d.path));
  assert.ok(covered.includes('scripts/count.mjs'));
  assert.ok(covered.includes('node_modules/zod/index.mjs'), 'what the script imports from the committed package');
});

// ---- Codex's review of the fix (7 Nov) ----

test("Codex 1: a package that isn't there when the patch is hashed, and a later commit adds, asks again", async () => {
  const { folder } = repo({});
  write(folder, { '.threadbear/patches/tools.ts': "export default { actions: [{ title: 'Go', run: 'true', when: async () => { if (globalThis.never) await import('zod'); return true; } }] };\n" });
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'lazy');
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([patchIn(folder)]).length, 1);
  assert.equal((await trust.check(patchIn(folder), 0)).trusted, true);
  write(folder, zod('export const list = 2;\n'));
  git(folder, 'add', '-f', 'node_modules/zod');
  git(folder, 'commit', '-qm', 'vendor zod');
  const verdict = await trust.check(patchIn(folder), 0);
  assert.equal(verdict.trusted === false && verdict.reason, 'changed');
});

test('Codex 1: the module hook refuses a committed package file the hash never covered, whenever the import comes', async () => {
  const { unhashedPackageFile } = await import('../../src/tracked-packages.ts');
  const { folder } = repo(zod('export const list = 1;\n'));
  const f = path.join(folder, 'node_modules/zod/index.mjs');
  assert.match(unhashedPackageFile(f, folder, () => false) ?? '', /commits under node_modules that patch trust didn't hash/);
  assert.equal(unhashedPackageFile(f, folder, () => true), undefined);
  const { folder: plain } = repo({}, zod('export const list = 1;\n'));
  assert.equal(unhashedPackageFile(path.join(plain, 'node_modules/zod/index.mjs'), plain, () => false), undefined, 'installed');
});

test("Codex 2: a submodule its config calls inactive is still followed, as its files are on disk", () => {
  const lib = tmpDir();
  write(lib, { 'package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './index.mjs' }), 'index.mjs': 'export const list = 1;\n' });
  git(lib, 'init', '-q');
  git(lib, 'add', '.');
  git(lib, 'commit', '-qm', 'lib');
  const { folder } = repo({});
  git(folder, 'submodule', '-q', 'add', '-f', lib, 'node_modules/zod');
  git(folder, 'commit', '-qm', 'sub');
  const name = git(folder, 'config', '-f', '.gitmodules', '--get-regexp', 'path').split(' ')[0]!.replace(/^submodule\./, '').replace(/\.path$/, '');
  git(folder, 'config', `submodule.${name}.active`, 'false');
  assert.equal(git(folder, 'ls-files', '--recurse-submodules').includes('node_modules/zod/index.mjs'), false, "git's own recursion skips it");
  const h = patchHash(patchIn(folder));
  assert.equal(h.incomplete, undefined);
  assert.ok(h.deps.some((d) => d.path === path.join(folder, 'node_modules/zod/index.mjs')));
});

test("Codex 3: a submodule's own commit that starts tracking a package its script requires asks again, though the outer index didn't change", async () => {
  const sub = tmpDir();
  write(sub, { '.gitignore': 'node_modules\n', 'scripts/x.cjs': "const z = require('zod');\nconsole.log(z.n);\n", 'node_modules/zod/index.js': 'exports.n = 1;\n', 'node_modules/zod/package.json': JSON.stringify({ name: 'zod', main: 'index.js' }) });
  git(sub, 'init', '-q');
  git(sub, 'add', '.');
  git(sub, 'commit', '-qm', 'sub');
  const { folder } = repo({});
  git(folder, 'submodule', '-q', 'add', '-f', sub, 'sub');
  write(folder, { '.threadbear/patches/tools.ts': "export default { panels: [{ title: 'N', url: 'http://localhost:1', badge: async ({ sh }) => Number(await sh('node sub/scripts/x.cjs')) }] };\n" });
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'patch');
  // The submodule's checkout has its own installed (ignored) copy.
  write(path.join(folder, 'sub'), { 'node_modules/zod/index.js': 'exports.n = 1;\n', 'node_modules/zod/package.json': JSON.stringify({ name: 'zod', main: 'index.js' }) });
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([patchIn(folder)]).length, 1);
  assert.equal((await trust.check(patchIn(folder), 0)).trusted, true);
  fs.writeFileSync(path.join(folder, 'sub/node_modules/zod/index.js'), 'exports.n = 2;\n');
  git(path.join(folder, 'sub'), 'add', '-f', 'node_modules/zod');
  git(path.join(folder, 'sub'), 'commit', '-qm', 'vendor');
  const verdict = await trust.check(patchIn(folder), 0);
  assert.equal(verdict.trusted === false && verdict.reason, 'changed');
});

test("Codex 4: require('payload') finding a committed node_modules/payload.js (no folder of that name) hashes it", () => {
  const { folder } = repo({ 'node_modules/payload.js': 'module.exports = 1;\n' });
  write(folder, {
    'scripts/x.cjs': "console.log(require('payload'));\n",
    '.threadbear/patches/tools.ts': "export default { panels: [{ title: 'N', url: 'http://localhost:1', badge: async ({ sh }) => Number(await sh('node scripts/x.cjs')) }] };\n",
  });
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'script');
  const covered = patchHash(patchIn(folder)).deps.map((d) => path.relative(folder, d.path));
  assert.ok(covered.includes('node_modules/payload.js'), covered.join(', '));
});

test('Codex round 2: a submodule left uninitialized when the patch was trusted, checked out later, asks again', async () => {
  const lib = tmpDir();
  write(lib, { 'package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './index.mjs' }), 'index.mjs': 'export const list = 1;\n' });
  git(lib, 'init', '-q');
  git(lib, 'add', '.');
  git(lib, 'commit', '-qm', 'lib');
  const { folder } = repo({});
  git(folder, 'submodule', '-q', 'add', '-f', lib, 'node_modules/zod');
  git(folder, 'commit', '-qm', 'sub');
  // Take its checkout away, as a fresh clone without --recursive has it.
  git(folder, 'submodule', '-q', 'deinit', '-f', 'node_modules/zod');
  assert.equal(fs.existsSync(path.join(folder, 'node_modules/zod/index.mjs')), false);
  write(folder, { '.threadbear/patches/tools.ts': "export default { actions: [{ title: 'Go', run: 'true', when: async () => { if (globalThis.never) await import('zod'); return true; } }] };\n" });
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'lazy');
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([patchIn(folder)]).length, 1);
  assert.equal((await trust.check(patchIn(folder), 0)).trusted, true);
  git(folder, 'submodule', '-q', 'update', '--init');
  assert.ok(fs.existsSync(path.join(folder, 'node_modules/zod/index.mjs')));
  const verdict = await trust.check(patchIn(folder), 0);
  assert.equal(verdict.trusted === false && verdict.reason, 'changed');
});

test('Codex round 2: on a Mac, a package committed under NODE_MODULES (which `node_modules` finds there) is hashed too', { skip: process.platform !== 'darwin' && process.platform !== 'win32' }, () => {
  const { folder } = repo({ 'NODE_MODULES/zod/package.json': JSON.stringify({ name: 'zod', main: 'index.js' }), 'NODE_MODULES/zod/index.js': 'exports.n = 1;\n' });
  write(folder, {
    'scripts/x.cjs': "console.log(require('zod').n);\n",
    '.threadbear/patches/tools.ts': "export default { panels: [{ title: 'N', url: 'http://localhost:1', badge: async ({ sh }) => Number(await sh('node scripts/x.cjs')) }] };\n",
  });
  git(folder, 'add', '.');
  git(folder, 'commit', '-qm', 'script');
  const covered = patchHash(patchIn(folder)).deps.map((d) => path.relative(folder, d.path));
  assert.ok(covered.includes('NODE_MODULES/zod/index.js'), covered.join(', '));
});
