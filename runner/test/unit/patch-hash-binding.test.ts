// Ways a trusted patch's hash failed to bind what runs (Gautam's Claude
// Security scan, 6 Nov 2026: F10, F11, F17, F18, F19, F20, F22, F28). Each
// test plays the report's exploit scenario and the variants its fix names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { applyLive, loadPatchSet, renderListPanel, runCommand } from '../../src/patches.ts';
import { folderKey, namedPaths, PatchTrust, patchHash, scanModule } from '../../src/patch-trust.ts';
import { makeRecipeToShell, rcConfig, Reads, reachOf, reachOfCommand, setsMakeShell, yamlListItems } from '../../src/script-trust.ts';

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();

// Files under `folder`, made with their folders.
function write(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
}

const patchIn = (folder: string, name = 'tools.ts') => path.join(folder, '.threadbear', 'patches', name);

// Follow options as patchHash gives them, for script-trust on its own.
const follow = (folder: string) => ({
  folder: fs.realpathSync(folder),
  top: fs.realpathSync(folder),
  scanJs: (src: string, file: string) => {
    const s = scanModule(src, file);
    return { specifiers: s.specifiers, strings: s.strings, ...(s.problem ? { problem: s.problem.code } : {}) };
  },
  resolveImport: (dir: string, spec: string) => path.resolve(dir, spec),
  namedPaths,
});

// CPU time, not the clock's: a busy Mac takes a test process off the CPU
// for whole seconds, which the clock counts and this doesn't.
const timed = <T>(fn: () => T): { ms: number; out: T } => {
  const t = process.cpuUsage();
  const out = fn();
  const d = process.cpuUsage(t);
  return { ms: (d.user + d.system) / 1000, out };
};

// Fails when `fn` takes far longer than `ref`, linear work over the same
// input (the quickest of three). Fixed limits don't hold here: tests run
// at background priority, and on a busy Mac the same parse took 73 ms at
// full speed and 10 s in the background. Both move together, while the
// quadratic regexes this replaces took thousands of times one pass
// (minutes at these sizes). At full speed, each parse below takes well
// under 100 ms.
function assertLinear<T>(label: string, ref: () => unknown, fn: () => T, factor = 50): T {
  const base = Math.min(timed(ref).ms, timed(ref).ms, timed(ref).ms);
  const { ms, out } = timed(fn);
  assert.ok(ms < factor * base + 50, `${label}: ${Math.round(ms)} ms, against ${Math.round(base)} ms for one pass`);
  return out;
}

// The same for a shell script's parse, measured against itself on an eighth
// of the input: 8 times the work when linear, 64 when quadratic, so 16 splits
// them. A cheap stand-in for lexing (mapping each character to an object) is
// no reference here: the JIT took it from 12 ms to 2 by the end of this file
// while the parse stayed about 300, which failed the release build 2 runs in 3.
// A second try, as a process can land on a slower core; quadratic fails both.
function assertScriptLinear(label: string, folder: string, n: number, script: (n: number) => string): void {
  const parse = (size: number) => {
    write(folder, { 'a.sh': script(size) });
    return () => reachOf(path.join(folder, 'a.sh'), follow(folder));
  };
  const small = parse(Math.floor(n / 8));
  const limit = 16 * Math.min(timed(small).ms, timed(small).ms, timed(small).ms) + 50;
  const full = parse(n);
  let ms = timed(full).ms;
  if (ms >= limit) ms = timed(full).ms;
  assert.ok(ms < limit, `${label}: ${Math.round(ms)} ms, over ${Math.round(limit)} ms, 16 times an eighth of the input`);
}

// One plain pass over a text: its lines, and its characters one by one
// (the parsers that replaced regexes walk a line a character at a time).
const pass = (text: string) => () => {
  let n = 0;
  for (const l of text.split('\n')) n += l.trimStart().indexOf('=');
  let out = '';
  for (let i = 0; i < text.length; i++) out += text[i] === '$' ? '$' : text[i];
  return n + out.length;
};

// A real temp folder: script-trust compares real paths (/var is /private/var).
const realTmp = () => fs.realpathSync(tmpDir());

// ---- F10: bare imports self-resolving through the repo's package.json ----

test("F10: a trusted patch's bare import that resolves through the repo's own package.json to a repo file refuses the patch, and nothing of the repo's runs", async () => {
  const marks = tmpDir();
  for (const [spec, pkg, target] of [
    // The report's case: `import 'zod'`, after a pull renamed the package.
    ['zod', { name: 'zod', exports: { '.': './scripts/x.mjs' } }, 'scripts/x.mjs'],
    // A subpath of the package's own name.
    ['acme/helpers', { name: 'acme', exports: { './helpers': './scripts/h.mjs' } }, 'scripts/h.mjs'],
    // Into a folder of the repo's that's only called node_modules (Node
    // refuses that target itself; the hook would too).
    ['zod', { name: 'zod', exports: { '.': './lib/node_modules/x.mjs' } }, 'lib/node_modules/x.mjs'],
  ] as const) {
    const root = tmpDir();
    const folder = path.join(root, 'repo');
    const ran = path.join(marks, `${target.replace(/\W/g, '-')}.ran`);
    // A real checkout, with node_modules installed (git doesn't track it).
    fs.mkdirSync(folder, { recursive: true });
    git(folder, 'init', '-q');
    write(folder, {
      '.gitignore': 'node_modules\n',
      'package.json': JSON.stringify({ ...pkg, type: 'module' }),
      [target]: `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'x');\nexport const list = 1;\n`,
      // What `zod` was when the patch was trusted: a real package.
      'node_modules/zod/package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './index.mjs' }),
      'node_modules/zod/index.mjs': 'export const list = 1;\n',
      '.threadbear/patches/tools.ts': `import { list } from '${spec}';\nexport default { actions: [{ title: 'Go ' + list, run: 'true' }] };\n`,
    });
    const trust = new PatchTrust();
    // The hash never covered package.json, so the yes from before holds.
    assert.deepEqual(trust.trustCurrent([patchIn(folder)]), [patchIn(folder)]);
    const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
    const refused = /its own package by name|Invalid "exports" main target|not a package in node_modules/;
    assert.match(set.patches[0]?.error ?? '', refused, spec);
    assert.deepEqual(set.actions, [], spec);
    assert.equal(fs.existsSync(ran), false, `${spec}: the repo's script never ran`);
  }
});

test("F10: a repo unpacked inside some node_modules/zod folder can't self-reference its way past the node_modules rule", async () => {
  const root = tmpDir();
  const folder = path.join(root, 'node_modules', 'zod');
  const ran = path.join(tmpDir(), 'x.ran');
  write(folder, {
    'package.json': JSON.stringify({ name: 'zod', type: 'module', exports: './scripts/x.mjs' }),
    'scripts/x.mjs': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'x');\nexport const list = 1;\n`,
    // .mjs: Node won't strip types under node_modules.
    '.threadbear/patches/tools.mjs': "import { list } from 'zod';\nexport default { actions: [{ title: 'Go ' + list, run: 'true' }] };\n",
  });
  const trust = new PatchTrust();
  // Not a git checkout, so it can't be trusted at all now; before that, a
  // yes was refused when it loaded.
  assert.ok(trust.trustCurrent([patchIn(folder, 'tools.mjs')]).length <= 1);
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  // Not a git checkout either, so it can't tell installed from shipped
  // (committed-node-modules.test.ts); the load hook refuses it too.
  assert.match(set.patches[0]?.error ?? '', /imports zod, its own package by name|imports zod, and .* isn't a git checkout/);
  assert.equal(fs.existsSync(ran), false);
});

test('F10: a bare import of a real package in node_modules, or a builtin, still loads', async () => {
  const root = tmpDir();
  const folder = path.join(root, 'repo');
  fs.mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q');
  write(folder, {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'repo', type: 'module' }),
    'node_modules/left-pad-x/package.json': JSON.stringify({ name: 'left-pad-x', type: 'module', exports: './index.mjs' }),
    'node_modules/left-pad-x/index.mjs': "export const title = 'Padded';\n",
    '.threadbear/patches/tools.ts': "import path from 'path';\nimport { title } from 'left-pad-x';\nexport default { actions: [{ title: title + path.sep, run: 'true' }] };\n",
  });
  const trust = new PatchTrust();
  trust.trustCurrent([patchIn(folder)]);
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(set.patches[0]?.error, undefined);
  assert.deepEqual(set.actions.map((a) => a.title), ['Padded/']);
});

// ---- F11: the hash's encoding ----

test("F11: two different file sets that version 2's newline-joined encoding hashed alike hash apart, and a path with a newline can't be trusted at all", () => {
  const folder = path.join(tmpDir(), 'repo');
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  const evil = 'echo evil\n';
  const hex = sha256(evil);
  const odd = `lib.sh ${hex}\nz`;
  // The patch: a hook script that sources ./lib.sh if it's there, a
  // string naming the odd folder's k.sh, and ./z/k.sh.
  write(folder, {
    '.threadbear/patches/tools.ts': `export default { hooks: [{ title: 'H', on: 'turn.end', run: './a-setup.sh' }], actions: [{ title: 'A', run: ${JSON.stringify(`'./${odd}/k.sh'`)} }], note: './z/k.sh' };\n`,
    'a-setup.sh': '#!/bin/sh\n[ -f ./lib.sh ] && . ./lib.sh\n',
  });
  const file = patchIn(folder);
  // Version 2's hash, made from a patchHash's files the way it was.
  const v2 = (h: ReturnType<typeof patchHash>) => {
    const dir = path.dirname(h.root);
    const lines = h.deps.map((d) => `${path.relative(dir, d.path)} ${d.sha256 ?? 'missing'}`).sort();
    return sha256(Buffer.from(['threadbear-patch-2', h.own, ...lines].join('\n')));
  };

  // Version A: k.sh in a folder named "lib.sh <hex>\nz", and no lib.sh.
  write(folder, { [`${odd}/k.sh`]: 'true\n' });
  const a = patchHash(file);
  assert.ok(a.deps.some((d) => d.path.endsWith(`${odd}/k.sh`)), 'the odd path is followed');
  assert.match(a.incomplete ?? '', /newline or another control character/);

  // Version B: that folder gone, .threadbear/patches/z/k.sh and an evil lib.sh.
  fs.rmSync(path.join(folder, odd), { recursive: true });
  write(folder, { '.threadbear/patches/z/k.sh': 'true\n', 'lib.sh': evil });
  const b = patchHash(file);
  assert.equal(b.incomplete, undefined);
  assert.equal(v2(a), v2(b), "version 2's encoding couldn't tell them apart");
  assert.notEqual(a.hash, b.hash);

  // So trusting A (were it allowed) or A's version 2 hash doesn't trust B.
  const trust = new PatchTrust();
  trust.trust(file, v2(a));
  trust.trust(file, a.hash);
  return trust.check(file, 0).then((v) => assert.equal(v.trusted, false));
});

test('F11: no hash an earlier version stored trusts a patch now, with helpers or without', async () => {
  const root = tmpDir();
  for (const withHelper of [false, true]) {
    const folder = path.join(root, withHelper ? 'helped' : 'solo');
    write(folder, {
      '.threadbear/patches/tools.ts': withHelper ? "import { t } from '../lib/t.ts';\nexport default { actions: [{ title: t, run: 'true' }] };\n" : "export default { actions: [{ title: 'Solo', run: 'true' }] };\n",
      '.threadbear/lib/t.ts': "export const t = 'Helped';\n",
    });
    const file = patchIn(folder);
    const now = patchHash(file);
    const dir = path.dirname(now.root);
    const lines = now.deps.map((d) => `${path.relative(dir, d.path)} ${d.sha256}`).sort();
    // Version 1/2 for a helper-less patch: its own text's hash. Version 2
    // with helpers: the newline-joined lines.
    const old = now.deps.length ? sha256(Buffer.from(['threadbear-patch-2', now.own, ...lines].join('\n'))) : now.own;
    const trustFile = path.join(tmpDir(), 'patch-trust.json');
    fs.writeFileSync(trustFile, JSON.stringify({ version: 2, folders: { [folderKey(file)]: [old] } }));
    const trust = new PatchTrust({ file: trustFile });
    const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
    assert.equal(set.patches[0]?.untrusted, 'changed', withHelper ? 'with a helper' : 'helper-less');
    assert.deepEqual(set.actions, []);
    // Trusting it now writes version 3.
    trust.trust(file, set.patches[0]!.hash!);
    assert.equal(JSON.parse(fs.readFileSync(trustFile, 'utf8')).version, 3);
  }
});

test("F11: an old trust file's hash of a patch whose text is a version 3 hash's JSON doesn't trust the patch that JSON names", async () => {
  const root = tmpDir();
  const folder = path.join(root, 'repo');
  const marks = tmpDir();
  const ran = path.join(marks, 'b.ran');
  write(folder, { '.threadbear/patches/tools.ts': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'x');\nexport default { actions: [] };\n` });
  const file = patchIn(folder);
  const b = patchHash(file);
  // What a version 2 runner stored for a helper-less patch whose bytes
  // are B's version 3 preimage: their SHA-256, which is B's hash.
  const oldBytes = JSON.stringify(['threadbear-patch-3', b.own, []]);
  assert.equal(sha256(oldBytes), b.hash);
  const trustFile = path.join(tmpDir(), 'patch-trust.json');
  fs.writeFileSync(trustFile, JSON.stringify({ version: 2, folders: { [folderKey(file)]: [sha256(oldBytes), 'claude:' + 'a'.repeat(64)] } }));
  const trust = new PatchTrust({ file: trustFile });
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(set.patches[0]?.untrusted, 'changed');
  assert.equal(fs.existsSync(ran), false);
  // Saved as version 3, the old one kept apart and Claude's as it was.
  trust.save();
  const saved = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
  assert.deepEqual(saved.folders[folderKey(file)], ['legacy:' + b.hash, 'claude:' + 'a'.repeat(64)]);
  assert.equal((await new PatchTrust({ file: trustFile }).check(file, 0)).trusted, false);
});

// ---- F17, F18, F19: pre-trust hashing in linear time ----

test('F17: an .npmrc, .yarnrc or pnpm-workspace.yaml of a few hundred thousand newlines is read in linear time, as is the hash of a patch running npm beside it', () => {
  for (const [rc, body] of [
    ['.npmrc', '\n'.repeat(300_000)],
    ['.yarnrc', '\n'.repeat(300_000)],
    ['.yarnrc.yml', '\n'.repeat(300_000) + 'x'],
    ['bunfig.toml', ' \n'.repeat(150_000)],
    ['pnpm-workspace.yaml', '\n'.repeat(300_000)],
    // pnpm-workspace.yaml's own list pattern: a lazy match before spaces.
    ['pnpm-workspace.yaml', '- a' + ' '.repeat(300_000) + 'b\n'],
  ] as const) {
    const folder = realTmp();
    const small = realTmp();
    const patch = "export default { actions: [{ title: 'I', run: 'npm install' }] };\n";
    write(folder, { 'package.json': '{}', [rc]: body, '.threadbear/patches/tools.ts': patch });
    write(small, { 'package.json': '{}', [rc]: '\n', '.threadbear/patches/tools.ts': patch });
    // The parse itself, then the whole hash (oxc, the follow) around it,
    // against the same patch beside a one-line file.
    assertLinear(`${rc} parse`, pass(body), () => (rc === 'pnpm-workspace.yaml' ? yamlListItems(body) : rcConfig(rc, body)));
    const out = assertLinear(rc, () => (patchHash(patchIn(small)), pass(body)()), () => patchHash(patchIn(folder)), 20);
    assert.ok(out.deps.some((d) => path.basename(d.path) === rc), `${rc} is still hashed`);
  }
});

test("F17: what an .npmrc or .yarnrc sets is still found a line at a time: npm's shell or code fails closed, and yarnPath is hashed", () => {
  for (const npmrc of ['script-shell=/bin/evil\n', '\n\n   node-options = --require ./x.js\n', '"onload-script"=./x.js\n', 'SCRIPT_SHELL=x\n']) {
    const folder = realTmp();
    write(folder, { 'package.json': '{}', '.npmrc': npmrc, 'run.sh': 'npm install\n' });
    assert.match(reachOf(path.join(folder, 'run.sh'), follow(folder)).problem ?? '', /sets a shell or code for npm/, JSON.stringify(npmrc));
  }
  for (const yarnrc of ['yarnPath: .yarn/releases/y.cjs\n', 'yarnPath: ".yarn/releases/y.cjs"\n', 'yarnPath:\n  .yarn/releases/y.cjs\n']) {
    const folder = realTmp();
    write(folder, { 'package.json': '{}', '.yarnrc.yml': yarnrc, '.yarn/releases/y.cjs': 'module.exports = 1;\n', 'run.sh': 'yarn install\n' });
    const reach = reachOf(path.join(folder, 'run.sh'), follow(folder));
    assert.ok(reach.files.some((f) => f.endsWith('y.cjs')), JSON.stringify(yarnrc));
  }
  // A workspace listed in pnpm-workspace.yaml is followed (a comment after it too).
  const folder = realTmp();
  write(folder, {
    'package.json': '{}',
    'pnpm-workspace.yaml': 'packages:\n  - "pkgs/*" # all of them\n',
    'pkgs/a/package.json': JSON.stringify({ scripts: { postinstall: './post.sh' } }),
    'pkgs/a/post.sh': 'echo hi\n',
    'run.sh': 'pnpm install\n',
  });
  assert.ok(reachOf(path.join(folder, 'run.sh'), follow(folder)).files.some((f) => f.endsWith('pkgs/a/post.sh')));
});

test("F17: one rc file is read once for all of a patch's commands, and one too big for a config file fails closed", () => {
  const folder = realTmp();
  write(folder, { 'package.json': '{}', '.npmrc': 'a=b\n'.repeat(1000), 'yarn.sh': 'yarn install\n' });
  // Every command is followed by a Reach of its own, sharing one Reads:
  // the .npmrc is parsed for the first and kept for the rest.
  const reads = new Reads();
  let parses = 0;
  const parsed = reads.parsed;
  parsed.set = function (this: Map<string, unknown>, k: string, v: unknown) {
    parses++;
    return Map.prototype.set.call(this, k, v) as Map<string, unknown>;
  };
  for (let i = 0; i < 50; i++) reachOfCommand(`npm install p${i}`, 'the command', { ...follow(folder), reads });
  assert.equal(parses, 1);
  const big = realTmp();
  write(big, { 'package.json': '{}', '.npmrc': 'a=b\n'.repeat(300_000), 'run.sh': 'npm install\n' });
  assert.match(reachOf(path.join(big, 'run.sh'), follow(big)).problem ?? '', /\.npmrc is over 1024 KB/);
});

test('F18: a Makefile of a few hundred thousand blank lines (or unclosed `$(`s) is read in linear time, as is the hash of a patch running make beside it', () => {
  for (const body of ['\n'.repeat(300_000), ' \n'.repeat(150_000), '\t' + '$('.repeat(150_000) + '\n']) {
    const folder = realTmp();
    const small = realTmp();
    const patch = "export default { actions: [{ title: 'M', run: 'make' }] };\n";
    write(folder, { Makefile: body, '.threadbear/patches/tools.ts': patch });
    write(small, { Makefile: '\n', '.threadbear/patches/tools.ts': patch });
    const label = JSON.stringify(body.slice(0, 4));
    assertLinear(`${label} parse`, pass(body), () => body.split('\n').map((l) => [setsMakeShell(l), makeRecipeToShell(l)]));
    const out = assertLinear(label, () => (patchHash(patchIn(small)), pass(body)()), () => patchHash(patchIn(folder)), 20);
    // (makefile: the first name make tries, and on macOS it's the same file)
    assert.ok(out.deps.some((d) => path.basename(d.path).toLowerCase() === 'makefile'), label);
  }
  const big = realTmp();
  write(big, { Makefile: 'all:\n' + '\techo hi\n'.repeat(150_000), 'run.sh': 'make\n' });
  assert.match(reachOf(path.join(big, 'run.sh'), follow(big)).problem ?? '', /makefile is over 1024 KB/i);
});

test("F18: a Makefile's own SHELL is still found a line at a time, after export or override or for a target, and recipes read as before", () => {
  for (const line of ['SHELL = /bin/evil', '  export SHELL:=/bin/evil', 'override SHELL ::= x', 'all: SHELL = x', '.SHELLFLAGS += -x', 'X := $(shell ./evil.sh)', 'X := ${shell\t./evil.sh}']) {
    assert.equal(setsMakeShell(line), true, line);
  }
  for (const line of ['\tSHELL=bash ./x.sh', 'MYSHELL = x', 'X = $(SHELL)', 'SHELLX = 1', 'all: build']) assert.equal(setsMakeShell(line), false, line);
  assert.equal(makeRecipeToShell('$(MAKE) -C sub && echo $$HOME $@ ${CC} $(x'), 'make -C sub && echo $HOME $__make_variable $__make_variable $(x');
  const folder = realTmp();
  write(folder, { Makefile: '\n\n  override SHELL := /bin/evil\nall:\n\techo hi\n', 'run.sh': 'make\n' });
  assert.match(reachOf(path.join(folder, 'run.sh'), follow(folder)).problem ?? '', /its own SHELL/);
});

test("F19: a patch with `./` and a long run of dots is hashed in linear time, and a sentence's full stop still comes off a path", () => {
  const folder = realTmp();
  const plain = realTmp();
  write(folder, { '.threadbear/patches/x.ts': `// ./${'.'.repeat(5_000_000)}x\nexport default { actions: [] };\n` });
  write(plain, { '.threadbear/patches/x.ts': `// ${'a'.repeat(5_000_000)}\nexport default { actions: [] };\n` });
  // The report's 5 MB of dots, through the whole hash, against a patch
  // as big with nothing in it to follow (both about 15 ms at full speed).
  assertLinear('5 MB patch', () => patchHash(patchIn(plain, 'x.ts')), () => patchHash(patchIn(folder, 'x.ts')), 5);
  // Runs of dots and colons just under a path's longest, stripped by the loop.
  const near = './' + '.'.repeat(4000) + 'x ./' + ':.'.repeat(2000) + 'y. ' + './a' + '.'.repeat(4000);
  assert.deepEqual(assertLinear('near', pass(near), () => namedPaths(near)).length, 3);
  const long = './' + '.'.repeat(300_000) + 'x';
  assertLinear('long', pass(long), () => namedPaths(long));
  assert.deepEqual(namedPaths('Run ./scripts/a.sh. Then ../b.sh: and ./c.sh...'), ['./scripts/a.sh', '../b.sh', './c.sh']);
});

test('pre-trust hashing: a script with a very long word is followed in linear time', () => {
  const folder = realTmp();
  assertScriptLinear('long word', folder, 100_000, (n) => 'a'.repeat(2 * n) + '\n' + 'B'.repeat(n) + '+x=1\n');
  // A long run of reserved words (Codex's review, 6 Nov).
  const words = realTmp();
  assertScriptLinear('reserved words', words, 100_000, (n) => 'if '.repeat(n) + '\n');
  // A shell script too big to read fails closed.
  write(words, { 'big.sh': 'true\n'.repeat(300_000) });
  assert.match(reachOf(path.join(words, 'big.sh'), follow(words)).problem ?? '', /over 1024 KB/);
  // Assignments still read as before.
  const set = realTmp();
  write(set, { 'a.sh': 'BASH_ENV=./x.sh ./run.sh\n', 'run.sh': 'true\n' });
  assert.match(reachOf(path.join(set, 'a.sh'), follow(set)).problem ?? '', /sets BASH_ENV/);
  write(set, { 'b.sh': 'PATH+=:./bin\n' });
  assert.match(reachOf(path.join(set, 'b.sh'), follow(set)).problem ?? '', /puts a folder on PATH/);
});

// ---- F20: a .git symlink ----

test("F20: a folder whose .git is a symlink to a real worktree's .git doesn't take on its main checkout's trust, and its patch never runs", async () => {
  const root = tmpDir();
  const main = path.join(root, 'threadbear');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
  const wt = path.join(root, 'threadbear-threads', 'slot-1');
  git(main, 'worktree', 'add', '-q', '--detach', wt, 'main');
  const marks = tmpDir();
  // The always-trusted checkout, as Threadbear's own is.
  const trust = new PatchTrust({ always: [main] });
  for (const how of ['absolute', 'relative', 'hardlink'] as const) {
    const evil = path.join(root, `evil-${how}`);
    const ran = path.join(marks, `${how}.ran`);
    write(evil, { '.threadbear/patches/x.ts': `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, 'x');\nexport default { actions: [{ title: 'Evil', run: 'true' }] };\n` });
    const target = path.join(wt, '.git');
    if (how === 'absolute') fs.symlinkSync(target, path.join(evil, '.git'));
    else if (how === 'relative') fs.symlinkSync(path.relative(evil, target), path.join(evil, '.git'));
    else fs.linkSync(target, path.join(evil, '.git'));
    assert.equal(folderKey(patchIn(evil, 'x.ts')), fs.realpathSync(evil), `${how}: its own folder`);
    const set = await loadPatchSet(evil, root, new Map(), [], [], undefined, trust);
    assert.equal(set.patches[0]?.untrusted, 'new', how);
    assert.deepEqual(set.actions, [], how);
    assert.equal(fs.existsSync(ran), false, `${how}: none of its code ran`);
  }
  // The real worktree is still its main checkout.
  assert.equal(folderKey(patchIn(wt, 'x.ts')), fs.realpathSync(main));
  // A .git file naming a record whose gitdir is a fifo isn't waited on.
  const fifoed = path.join(root, 'fifoed');
  const record = path.join(root, 'fake-record');
  fs.mkdirSync(record, { recursive: true });
  execFileSync('mkfifo', [path.join(record, 'gitdir')]);
  write(fifoed, { '.git': `gitdir: ${record}\n` });
  assert.equal(folderKey(path.join(fifoed, '.threadbear', 'patches', 'x.ts')), fs.realpathSync(fifoed));
});

// ---- F22: live state and list panels ----

// A repo whose patch counts with `./tools/count.sh` in a badge, a summary
// and a list panel's items, trusted, and a thread in its web/ subfolder.
async function liveRepo(files: Record<string, string> = {}, patch?: string) {
  const root = tmpDir();
  const repo = path.join(root, 'R');
  const marks = tmpDir();
  write(repo, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.threadbear/patches/p.ts': `const n = async ({ sh }) => Number((await sh('./tools/count.sh')).trim());
export default {
  panels: [
    { title: 'Status', url: 'http://localhost:3000', badge: n },
    { title: 'List', items: async ({ sh }) => [(await sh('./tools/count.sh')).trim()] },
  ],
  actions: [{ title: 'Other', run: 'true', badge: async ({ sh }) => Number((await sh(['./tools', 'other.sh'].join('/'))).trim()) }],
};\n`,
    'tools/count.sh': '#!/bin/sh\necho 3\n',
    'web/index.html': '',
    ...files,
    ...(patch ? { '.threadbear/patches/p.ts': patch } : {}),
  });
  fs.chmodSync(path.join(repo, 'tools/count.sh'), 0o755);
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([patchIn(repo, 'p.ts')]).length, 1);
  const thread = path.join(repo, 'web');
  const ran: { command: string; cwd: string }[] = [];
  const ctx = {
    cwd: thread,
    threadId: 't1',
    run: (command: string, cwd: string) => {
      ran.push({ command, cwd });
      return runCommand(command, { cwd, env: process.env });
    },
    verify: (file: string, hash: string) => trust.verify(file, hash),
  };
  return { root, repo, thread, marks, trust, ctx, ran };
}

test("F22: a trusted patch's badge and list panel run its sh commands from the folder holding .threadbear/, not the thread's subfolder, so a pulled-in web/tools/count.sh never runs", async () => {
  const { root, repo, thread, marks, trust, ctx, ran } = await liveRepo();
  // A later pull adds R/web/tools/count.sh, which nothing hashed.
  const evil = path.join(marks, 'web-count.ran');
  write(repo, { 'web/tools/count.sh': `#!/bin/sh\ntouch ${JSON.stringify(evil)}\necho 9\n` });
  fs.chmodSync(path.join(repo, 'web/tools/count.sh'), 0o755);
  const base = await loadPatchSet(thread, root, new Map(), [], [], undefined, trust);
  assert.equal(base.patches[0]?.untrusted, undefined, 'still trusted: the web/ script was never in the hash');
  const set = await applyLive(base, ctx);
  assert.equal(set.panels.find((p) => p.title === 'Status')?.badge, 3, "the patch folder's count.sh");
  const list = await renderListPanel(base.panels.find((p) => p.title === 'List')!, base, ctx);
  assert.deepEqual(list.items?.map((i) => i.title), ['3']);
  assert.equal(fs.existsSync(evil), false, "web/tools/count.sh didn't run");
  for (const r of ran.filter((x) => x.command === './tools/count.sh')) assert.equal(r.cwd, fs.realpathSync(repo));
  // A command worked out in code that reaches a file the hash didn't
  // cover (./tools/other.sh, added later) is refused, never run.
  write(repo, { 'tools/other.sh': `#!/bin/sh\ntouch ${JSON.stringify(path.join(marks, 'other.ran'))}\necho 5\n` });
  fs.chmodSync(path.join(repo, 'tools/other.sh'), 0o755);
  const again = await applyLive(await loadPatchSet(thread, root, new Map(), [], [], undefined, trust), ctx);
  assert.equal(again.actions.find((a) => a.title === 'Other')?.badge, undefined);
  assert.equal(fs.existsSync(path.join(marks, 'other.ran')), false);
  assert.match(again.patches[0]?.liveError ?? '', /other\.sh, which patch trust didn't hash/);
});

test("F22: a live command that runs a script patch trust can't follow (blocked), or one that changed since it was trusted, doesn't run", async () => {
  // count.sh runs what a data file says: blocked for a hook, and now for a badge.
  const { root, thread, marks, trust, ctx, repo } = await liveRepo({ 'tools/count.sh': '#!/bin/sh\neval "$(cat ./tools/steps.txt)"\n', 'tools/steps.txt': 'echo 3\n' });
  const base = await loadPatchSet(thread, root, new Map(), [], [], undefined, trust);
  const set = await applyLive(base, ctx);
  assert.equal(set.panels.find((p) => p.title === 'Status')?.badge, undefined);
  const list = await renderListPanel(base.panels.find((p) => p.title === 'List')!, base, ctx);
  assert.match(list.note ?? '', /Not run: runs tools\/count\.sh, and patch trust can't follow everything that runs: .*eval/);

  // A trusted, followable script changed after the patch set was read.
  const fresh = await liveRepo();
  const loaded = await loadPatchSet(fresh.thread, fresh.root, new Map(), [], [], undefined, fresh.trust);
  const evil = path.join(marks, 'changed.ran');
  fs.writeFileSync(path.join(fresh.repo, 'tools/count.sh'), `#!/bin/sh\ntouch ${JSON.stringify(evil)}\necho 7\n`);
  const after = await applyLive(loaded, fresh.ctx);
  assert.equal(after.panels.find((p) => p.title === 'Status')?.badge, undefined);
  assert.equal(fs.existsSync(evil), false);
  assert.match(after.patches[0]?.liveError ?? '', /changed since it was trusted/);
  // Put back as trusted, it runs again; without a way to check the hash,
  // a bound patch's commands don't run at all.
  fs.writeFileSync(path.join(fresh.repo, 'tools/count.sh'), '#!/bin/sh\necho 3\n');
  assert.equal((await applyLive(loaded, fresh.ctx)).panels.find((p) => p.title === 'Status')?.badge, 3);
  const { verify: _v, ...noVerify } = fresh.ctx;
  void _v;
  const blind = await applyLive(loaded, noVerify);
  assert.equal(blind.panels.find((p) => p.title === 'Status')?.badge, undefined);
  void repo;
});

test("F22: the hash is checked again before each of a function's commands, and a function that timed out can't run one after", async () => {
  const marks = tmpDir();
  const late = path.join(marks, 'late.ran');
  const patch = `export default {
  panels: [
    { title: 'List', items: async ({ sh }) => { await sh('true'); await new Promise((r) => setTimeout(r, 400)); return [(await sh('./tools/count.sh')).trim()]; } },
    { title: 'Slow', url: 'http://localhost:3000', badge: async ({ sh }) => { await new Promise((r) => setTimeout(r, 400)); return Number(await sh('./tools/mark.sh')); } },
  ],
};\n`;
  const { root, repo, thread, trust, ctx } = await liveRepo({ 'tools/mark.sh': `#!/bin/sh\ntouch ${JSON.stringify(late)}\necho 1\n` }, patch);
  const base = await loadPatchSet(thread, root, new Map(), [], [], undefined, trust);
  assert.equal(base.patches[0]?.untrusted, undefined);
  // count.sh changes between the function's first command and its second.
  const listing = renderListPanel(base.panels.find((p) => p.title === 'List')!, base, ctx);
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(path.join(repo, 'tools/count.sh'), '#!/bin/sh\necho 99\n');
  assert.match((await listing).note ?? '', /changed since it was trusted/);
  fs.writeFileSync(path.join(repo, 'tools/count.sh'), '#!/bin/sh\necho 3\n');
  // The badge times out before its command; the command it starts after isn't run.
  const set = await applyLive(base, { ...ctx, timeoutMs: 100 });
  assert.equal(set.panels.find((p) => p.title === 'Slow')?.badge, undefined);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fs.existsSync(late), false, "the timed-out badge's command never ran");
});

test("F22: a tool patch's live command can't run a script of the tool's own repo that the hash didn't cover", async () => {
  const root = tmpDir();
  const tool = path.join(root, 'tool');
  const video = path.join(root, 'video');
  const marks = tmpDir();
  const ran = path.join(marks, 'badge.ran');
  write(tool, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    // The script's path is put together in code, so no string names it.
    '.threadbear/patches/t.ts': `import path from 'node:path';
const script = path.resolve(import.meta.dirname, '..', '..', 'bin', 'badge' + '.sh');
export default { appliesTo: ['*.foo'], panels: [{ title: 'Status', url: 'http://localhost:3000', badge: async ({ sh }) => Number(await sh(script)) }] };\n`,
    'bin/badge.sh': `#!/bin/sh\ntouch ${JSON.stringify(ran)}\necho 2\n`,
  });
  fs.chmodSync(path.join(tool, 'bin/badge.sh'), 0o755);
  write(video, { '.git/HEAD': 'ref: refs/heads/main\n', 'a.foo': '' });
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([patchIn(tool, 't.ts')]).length, 1);
  const base = await loadPatchSet(video, root, new Map(), [], [tool], undefined, trust);
  assert.equal(base.patches[0]?.untrusted, undefined);
  const set = await applyLive(base, { cwd: video, threadId: 't', run: (c, cwd) => runCommand(c, { cwd, env: process.env }), verify: (f, h) => trust.verify(f, h) });
  assert.equal(set.panels[0]?.badge, undefined);
  // Refused from the folder it applies in first: outside that repo and off the short list.
  assert.match(set.patches[0]?.liveError ?? '', /Not run: .*badge\.sh/);
  assert.equal(fs.existsSync(ran), false);
});

// ---- F28: a script reading its program from its input ----

test('F28: a hook script that runs `sh /dev/stdin < ./steps.txt` (or reads its program from another open file) refuses the patch', async () => {
  const lines = [
    'sh /dev/stdin < ./scripts/steps.txt',
    'bash /dev/fd/0 < ./scripts/steps.txt',
    'bash -- /proc/self/fd/0 < ./scripts/steps.txt',
    'source /dev/stdin < ./scripts/steps.txt',
    '. /dev/fd/3 3< ./scripts/steps.txt',
    // A link of the repo's own to the input (Codex's review, 6 Nov).
    '. ./scripts/input < ./scripts/steps.txt',
    'node /dev/stdin < ./scripts/steps.txt',
    'exec 3< ./scripts/steps.txt; /dev/fd/3',
    'zsh /dev/tty',
  ];
  for (const line of lines) {
    const folder = path.join(tmpDir(), 'repo');
    write(folder, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.threadbear/patches/tools.ts': "export default { hooks: [{ title: 'Check', on: 'turn.end', run: './scripts/check.sh' }] };\n",
      'scripts/check.sh': `#!/bin/sh\n${line}\n`,
      'scripts/steps.txt': 'echo looks like data\n',
    });
    fs.chmodSync(path.join(folder, 'scripts/check.sh'), 0o755);
    fs.symlinkSync('/dev/stdin', path.join(folder, 'scripts/input'));
    const trust = new PatchTrust();
    trust.trustCurrent([patchIn(folder)]);
    const set = await loadPatchSet(folder, path.dirname(folder), new Map(), [], [], undefined, trust);
    assert.match(set.patches[0]?.error ?? '', /^Not run: its hook "Check" .*(reads what to run from its input|a file it has open)/, line);
    assert.deepEqual(set.hooks, [], line);
  }
});

test('F28: make reading its Makefile from its input, or a Makefile named by a flag in any form, is followed as make reads it', () => {
  const folder = realTmp();
  write(folder, { Makefile: 'all:\n\techo main\n', 'other.mk': 'all:\n\t./evil.sh\n', 'evil.sh': 'echo evil\n', 'steps.txt': 'all:\n\techo hi\n' });
  for (const cmd of ['make -f - < ./steps.txt', 'make -f- < ./steps.txt', 'make --file=- < ./steps.txt', 'make -sf - < ./steps.txt', 'make -f /dev/stdin < ./steps.txt']) {
    assert.match(reachOfCommand(cmd, 'the command', follow(folder)).problem ?? '', /read(s|ing) (its Makefile|what to run) from its input/, cmd);
  }
  for (const cmd of ['make -fother.mk', 'make -sf other.mk', 'make --makefile=other.mk', 'make -k -f other.mk']) {
    assert.ok(reachOfCommand(cmd, 'the command', follow(folder)).files.some((f) => f.endsWith('evil.sh')), cmd);
  }
  // -j4 and -C dir still read as before.
  write(folder, { 'sub/Makefile': 'all:\n\t./sub.sh\n', 'sub/sub.sh': 'true\n' });
  assert.ok(reachOfCommand('make -j4 -Csub', 'the command', follow(folder)).files.some((f) => f.endsWith('sub.sh')));
});

test("F28: Codex's second round: node -, bash --rcfile x -s, wrappers, every -f, alias paths, escaped yarn paths", () => {
  const folder = realTmp();
  write(folder, { 'dummy.js': '1;\n', 'steps.txt': 'echo hi\n', 'rc.sh': 'true\n', 'first.txt': '# a comment\n', Makefile: 'all:\n\techo hi\n', 'yarn.cjs': 'module.exports = 1;\n', 'package.json': '{}', 'count.txt': 'echo 3\n' });
  const reach = (cmd: string) => reachOfCommand(cmd, 'the command', follow(folder));
  assert.match(reach('node - ./dummy.js < ./steps.txt').problem ?? '', /reading what to run from its input/);
  assert.match(reach('env bash --rcfile ./rc.sh -s < ./steps.txt').problem ?? '', /reading what to run from its input/);
  assert.match(reach('command bash --rcfile ./rc.sh -s < ./steps.txt').problem ?? '', /reading what to run from its input/);
  assert.ok(reach('env bash ./rc.sh < ./steps.txt').files.some((f) => f.endsWith('steps.txt')), 'into a wrapped shell, hashed');
  assert.ok(reach('make -f ./first.txt -f Makefile').files.some((f) => f.endsWith('first.txt')), 'every -f');
  // The repo by another path to it: macOS's /tmp is /private/tmp.
  const alias = fs.mkdtempSync('/tmp/tb-alias-');
  write(alias, { 'count.txt': 'echo 3\n' });
  const viaAlias = reachOfCommand(`bash ${alias}/count.txt`, 'the command', { ...follow(alias), folder: fs.realpathSync(alias), top: fs.realpathSync(alias) });
  assert.ok(viaAlias.files.some((f) => f.endsWith('count.txt')), `${alias} is the repo`);
  fs.rmSync(alias, { recursive: true });
  for (const [yml, ok] of [['yarnPath: "\\u002e/yarn.cjs"\n', true], ['plugins:\n  - path: yarn.cjs\n    spec: x\n', true], ['yarnPath: !!str ./yarn.cjs\n', false], ['yarnPath: *a\n', false], ['yarnPath: "\\q"\n', false]] as const) {
    write(folder, { '.yarnrc.yml': yml });
    const r = reach('yarn install');
    if (ok) assert.ok(r.files.some((f) => f.endsWith('yarn.cjs')), yml);
    else assert.match(r.problem ?? '', /which patch trust doesn't read/, yml);
  }
});

test("F28: Codex's third round: node -- -, an rc file on an open descriptor, include /dev/stdin, quoted yarn keys, inline recipes, .RECIPEPREFIX, and a commented SHELL", () => {
  const folder = realTmp();
  write(folder, { '-': 'true\n', 'steps.txt': 'echo hi\n', 'yarn.cjs': 'module.exports = 1;\n', 'package.json': '{}', 'x.sh': 'true\n' });
  const reach = (cmd: string) => reachOfCommand(cmd, 'the command', follow(folder));
  assert.match(reach('node -- - < ./steps.txt').problem ?? '', /reads what to run from its input/);
  assert.match(reach('bash --rcfile /dev/fd/19 -ic true 19< ./steps.txt').problem ?? '', /rc file that reads from its input/);
  write(folder, { Makefile: 'include /dev/stdin\n' });
  assert.match(reach('make < ./steps.txt').problem ?? '', /includes a makefile that reads from its input/);
  write(folder, { Makefile: 'all: ; ./x.sh\n' });
  assert.ok(reach('make').files.some((f) => f.endsWith('x.sh')), 'an inline recipe is followed');
  write(folder, { Makefile: '.RECIPEPREFIX = >\nall:\n> ./x.sh\n' });
  assert.match(reach('make').problem ?? '', /its own SHELL/);
  write(folder, { Makefile: '# SHELL=/bin/bash\nX := a # $(shell no)\nall:\n\techo ok\n' });
  assert.equal(reach('make').problem, undefined, 'a comment is only a comment');
  write(folder, { '.yarnrc.yml': '"yarnPath": yarn.cjs\n' });
  assert.ok(reach('yarn install').files.some((f) => f.endsWith('yarn.cjs')), 'a quoted key');
  // A long run of assignments is linear.
  assertScriptLinear('assignments', folder, 100_000, (n) => 'a=1 '.repeat(n) + 'true\n');
});

test("F28: Codex's fourth round: env files, #! -s, $'' escapes, a Makefile linked to stdin, make -I and -C twice, !=, Yarn Classic and flow plugins, and linear awk and wrappers", () => {
  const folder = realTmp();
  write(folder, { 'main.mjs': '1;\n', 'steps.txt': 'echo hi\n', 'package.json': '{}', 'yarn.cjs': 'module.exports = 1;\n', 'x.sh': 'true\n' });
  const reach = (cmd: string) => reachOfCommand(cmd, 'the command', follow(folder));
  assert.match(reach('node --env-file=.env main.mjs').problem ?? '', /env file/);
  write(folder, { 'input.sh': '#!/bin/bash -s\ntrue\n' });
  fs.chmodSync(path.join(folder, 'input.sh'), 0o755);
  assert.match(reach('./input.sh < ./steps.txt').problem ?? '', /#! line makes the shell read/);
  write(folder, { 'ok.sh': '#!/bin/bash -eu\ntrue\n' });
  fs.chmodSync(path.join(folder, 'ok.sh'), 0o755);
  assert.equal(reach('./ok.sh').problem, undefined, '#!/bin/bash -eu is fine');
  assert.match(reach("$'\\142ash' -s < ./steps.txt").problem ?? '', /worked out as it runs/);
  fs.symlinkSync('/dev/stdin', path.join(folder, 'Makefile'));
  assert.match(reach('make < ./steps.txt').problem ?? '', /Makefile that reads from its input/);
  fs.rmSync(path.join(folder, 'Makefile'));
  write(folder, { Makefile: 'include extra.mk\nall:\n\ttrue\n', 'config/extra.mk': 'x:\n\t./x.sh\n' });
  assert.ok(reach('make -I config').files.some((f) => f.endsWith('extra.mk')), 'make -I');
  write(folder, { 'sub/nested/Makefile': 'all:\n\t../../x.sh\n' });
  assert.ok(reach('make -C sub -C nested').files.some((f) => f.toLowerCase().endsWith('sub/nested/makefile')), '-C twice');
  write(folder, { Makefile: 'X != sh payload.txt\nall: ; true\n' });
  assert.match(reach('gmake').problem ?? '', /!=/);
  write(folder, { '.yarnrc': 'yarn-path yarn.cjs\n' });
  assert.ok(reach('yarn install').files.some((f) => f.endsWith('yarn.cjs')), 'yarn-path');
  fs.rmSync(path.join(folder, '.yarnrc'));
  write(folder, { '.yarnrc.yml': 'plugins: [{path: .yarn/plugins/custom.cjs, spec: custom}]\n' });
  assert.match(reach('yarn install').problem ?? '', /flow value/);
  const awk = realTmp();
  assertScriptLinear('awk prints', awk, 100_000, (n) => "awk '" + 'print '.repeat(n) + "'\n");
  assert.match(reachOfCommand(`awk '{ print $1 | "sh" }'`, 'the command', follow(awk)).problem ?? '', /runs commands/);
  assert.equal(reachOfCommand(`awk '{ if (a || b) print $1 }'`, 'the command', follow(awk)).problem, undefined);
  const envs = 'env '.repeat(50_000) + 'true\n';
  write(awk, { 'b.sh': envs });
  // Each word is a path it might name, so one stat a word is the pass.
  assertLinear('wrappers', () => envs.split(' ').map((w) => fs.existsSync(path.join(awk, w))), () => reachOf(path.join(awk, 'b.sh'), follow(awk)), 50);
});

test("F22: a command a live function queues to start after it returns isn't run", async () => {
  const marks = tmpDir();
  const late = path.join(marks, 'micro.ran');
  const patch = `export default { panels: [{ title: 'Status', url: 'http://localhost:3000', badge: ({ sh }) => { queueMicrotask(() => void sh('./tools/mark.sh').catch(() => {})); return 1; } }] };\n`;
  const { root, thread, trust, ctx } = await liveRepo({ 'tools/mark.sh': `#!/bin/sh\ntouch ${JSON.stringify(late)}\n` }, patch);
  const base = await loadPatchSet(thread, root, new Map(), [], [], undefined, trust);
  const set = await applyLive(base, ctx);
  assert.equal(set.panels[0]?.badge, 1);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.existsSync(late), false);
});

test('pre-trust hashing: a long first word with many words after it is linear, and a file over the read limit fails closed', () => {
  const folder = realTmp();
  assertScriptLinear('long first word', folder, 20_000, (n) => 'x'.repeat(n) + ' x'.repeat(n) + '\n');
  const big = realTmp();
  fs.mkdirSync(path.join(big, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(big, '.threadbear/patches/tools.ts'), "export default { actions: [{ title: 'S', run: 'node ./big.js' }], worktree: { setup: './s.sh' } };\n");
  fs.writeFileSync(path.join(big, 's.sh'), 'node ./big.js\n');
  // Sparse: 40 MB on paper, nothing written.
  const fd = fs.openSync(path.join(big, 'big.js'), 'w');
  fs.ftruncateSync(fd, 40 * 1024 * 1024);
  fs.closeSync(fd);
  assert.match(patchHash(patchIn(big)).incomplete ?? '', /big\.js: it's over 32 MB/);
});

test('F28: a file redirected into a shell is hashed whatever it looks like, so changing it asks again', () => {
  const folder = realTmp();
  write(folder, { 'scripts/steps.txt': 'echo hi\n', 'scripts/rc.sh': 'true\n' });
  const reach = reachOfCommand('bash --rcfile ./scripts/rc.sh -i < ./scripts/steps.txt', 'the command', follow(folder));
  assert.ok(reach.files.some((f) => f.endsWith('steps.txt')), 'steps.txt is hashed');
  write(folder, { 'scripts/lib.sh': 'true\n' });
  assert.ok(reachOfCommand('. ./scripts/lib.sh < ./scripts/steps.txt', 'the command', follow(folder)).files.some((f) => f.endsWith('steps.txt')), 'into source too');
  // Into Node with a script, it's that script's data: not hashed.
  write(folder, { 'x.js': 'process.stdin.pipe(process.stdout);\n', 'data.json': '{}' });
  assert.ok(!reachOfCommand('node ./x.js < ./data.json', 'the command', follow(folder)).files.some((f) => f.endsWith('data.json')));
});
