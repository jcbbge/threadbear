// scripts/check-remote.sh losing the race for a free check host. On 6 Nov
// an app check's copy took 22 minutes over a slow uplink, another check took
// Tinker Desk meanwhile, and the run deleted its finished copy and copied
// again. Now a lost race keeps the copy: after a slow copy it waits on that
// host, after a quick one it chooses again and only copies if it moves.
// Runs the real script from a temp checkout, with a fake ssh that answers
// the probe and the lock from files and runs everything else locally, and
// an rsync that copies to "host:path" as plain local paths.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'check-remote.sh');

// ssh: drops its -o options, takes the host, and answers the probe and
// the lock from files: a host's state file says free or busy, its "lose"
// file how many lock-without-waiting tries to refuse (75), each of which
// leaves the host busy, as another check has it. Each host's home is a
// folder under $FAKE, and everything else (mkdir, the copy from the
// mirror, rm -rf, find) really runs there. A run says whether its copy is there.
// rsync: drops -e and its command, takes host:path as path, and logs an
// upload to a host's mirror as that host's copy.
const FAKE_RSYNC = `#!/bin/bash
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -e) shift ;;
    *:/*) h="\${1%%:*}"; p="\${1#*:}"; case "$p" in */mirror/*) echo "$h" >>"$FAKE/copies.log"; [ -z "$RSYNC_PEEK" ] || bash -c "$RSYNC_PEEK" >>"$FAKE/rsync-peek"; [ "$RSYNC_FAILS_ON" != "$h" ] || { [ ! -f "$FAKE/$h/df-after" ] || cp "$FAKE/$h/df-after" "$FAKE/$h/df-out"; exit 11; } ;; esac; args+=("$p") ;;
    *) args+=("$1") ;;
  esac
  shift
done
exec /usr/bin/rsync "\${args[@]}"
`;

const FAKE_SSH = `#!/bin/bash
while [ "$1" = -o ]; do echo "$2" >>"$FAKE/ssh-opts.log"; shift 2; done
host="$1"; shift
cmd="$*"
d="$FAKE/$host"
echo "$host $cmd" >>"$FAKE/ssh.log"
[ -d "$d" ] || exit 255
run_copy() {
  script="$(printf '%s' "$cmd" | grep -oE "$d/home/[^ \\\\']*/scripts/check-remote.sh" | head -1)"
  if [ -n "$script" ] && [ -f "$script" ] && [ -f "$(dirname "$script")/../.check-changed" ]; then
    echo "ran on $host $1 from $script"
    [ -z "$PEEK" ] || (cd "$(dirname "$script")/.." && bash -c "$PEEK") >"$FAKE/peek"
    # A failed step's log path, as check.sh prints it there, and one that
    # only looks like it.
    if [ -n "$PRINT_LOG" ]; then
      id="$(printf '%s' "$cmd" | grep -oE 'runs/[0-9]+-[0-9]+-[0-9]+/' | head -1 | cut -d/ -f2)"
      b="$d/home/.cache/threadbear-check"
      echo "log at $b/tmp-$id/threadbear-check.Ab12/step.log"
      echo "near $d/home/Xcache/threadbear-check/tmp-$id/threadbear-check.Ab12/step.log"
    fi
    # The check failing, and the disk as a host's "df-after" file has it then.
    if [ -n "$RUN_FAILS" ]; then
      [ ! -f "$d/df-after" ] || cp "$d/df-after" "$d/df-out"
      # What keep_logs wrote there, as it failed.
      if [ -n "$KEPT_KB$KEPT_EMPTY" ]; then
        id="$(printf '%s' "$cmd" | grep -oE 'runs/[0-9]+-[0-9]+-[0-9]+/' | head -1 | cut -d/ -f2)"
        mkdir -p "$d/home/.cache/threadbear-check/kept-$id"
        printf '%s' "$KEPT_KB" >"$d/home/.cache/threadbear-check/kept-$id/free-kb"
      fi
      exit 1
    fi
  else echo "no copy on $host for: $cmd"; exit 1; fi
}
# The host's commands find a df that prints its "df-out" file; the real awk
# reads that, from the script's own command.
PATH="$d/bin:$PATH"
case "$cmd" in
  *"uname -s"*)
    # A host's "probe-fails" file: it answers, but the probe's mkdir fails.
    [ ! -f "$d/probe-fails" ] || exit 1
    # A host's "base" file says what folder it reports, if not its own.
    b="$d/home/.cache/threadbear-check"; [ -f "$d/base" ] && b="$(cat "$d/base")"
    # A host's "os" file says what system it is, if not a Mac.
    printf '%s\\n%s\\n%s\\n' "$b" "$(cat "$d/os" 2>/dev/null || echo Darwin)" "$(cat "$d/state")"
    # What the probe runs after the lock's "fi && ", for real.
    (cd "$d/home" && bash -c "\${cmd##*fi && }") ;;
  *"lockf -t 0 -k"*)
    n="$(cat "$d/lose" 2>/dev/null || echo 0)"
    if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$d/lose"; [ ! -f "$d/df-after" ] || cp "$d/df-after" "$d/df-out"; [ -f "$d/looks-free" ] || echo busy >"$d/state"; exit 75; fi
    run_copy now ;;
  *"lockf -k"*) run_copy "after waiting" ;;
  *"flock -n -E 75"*) run_copy now ;;
  *"flock "*) run_copy "after waiting" ;;
  *) bash -c "$cmd" ;;
esac
`;

// looksFree: the probe still says free after each lost race (another check
// keeps grabbing it between the probe and the lock).
// This Mac's home for the run: short and under /tmp, so the ssh socket's
// folder fits (a socket's path is short), and never the real one. Its
// TMPDIR is a folder of the test's own, to see what's left there.
const homes: string[] = [];
after(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })));
function shortHome(): string {
  const h = fs.mkdtempSync('/tmp/tbcr-');
  homes.push(h);
  return h;
}

// df -Pk as each system prints it, the lines copied from Tinker Desk and the
// cloud box on 7 Nov, with the given KiB available.
const whole = (kb: number | string) => (typeof kb === 'number' ? Math.ceil(kb) : kb);
const macDf = (kb: number | string) => `Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5   482797652 383744568 ${whole(kb)}    84%    /System/Volumes/Data\n`;
const linuxDf = (kb: number | string) => `Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/sda1         78397936 52179404  ${whole(kb)}      70% /\n`;
const GiB = 1024 * 1024;

// df: what the host's df prints (plenty free, if not given). dfAfter: what it
// prints once a copy or a run has failed there. os: Linux, if not a Mac.
type Host = { state: string; lose?: number; looksFree?: boolean; base?: string; df?: string; dfAfter?: string; os?: string };
function setup(hosts: Record<string, Host>, opts: { home?: string } = {}) {
  const tmp = tmpDir('check-remote-');
  const home = opts.home ?? shortHome();
  const tmpdir = path.join(tmp, 'tmpdir');
  fs.mkdirSync(tmpdir);
  const fake = path.join(tmp, 'fake');
  const bin = path.join(tmp, 'bin');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rsync'), FAKE_RSYNC, { mode: 0o755 });
  for (const [h, s] of Object.entries(hosts)) {
    fs.mkdirSync(path.join(fake, h, 'home'), { recursive: true });
    fs.writeFileSync(path.join(fake, h, 'state'), s.state);
    if (s.lose) fs.writeFileSync(path.join(fake, h, 'lose'), String(s.lose));
    if (s.looksFree) fs.writeFileSync(path.join(fake, h, 'looks-free'), '');
    if (s.base !== undefined) fs.writeFileSync(path.join(fake, h, 'base'), s.base);
    if (s.os) fs.writeFileSync(path.join(fake, h, 'os'), s.os);
    if (s.dfAfter !== undefined) fs.writeFileSync(path.join(fake, h, 'df-after'), s.dfAfter);
    fs.writeFileSync(path.join(fake, h, 'df-out'), s.df ?? macDf(100 * GiB));
    fs.mkdirSync(path.join(fake, h, 'bin'));
    fs.writeFileSync(path.join(fake, h, 'bin', 'df'), `#!/bin/bash\n[ "$*" = "-Pk ." ] || exit 9\ncat "${path.join(fake, h, 'df-out')}"\n`, { mode: 0o755 });
  }
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-remote.sh'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  return {
    fake,
    repo,
    home,
    tmpdir,
    // peek: a command run in the copy as its check starts, its output kept.
    // env: more for the script's environment (PRINT_LOG, RSYNC_PEEK).
    run(hostList: string, staySecs: number, peek = '', env: Record<string, string> = {}) {
      const base: NodeJS.ProcessEnv = { ...process.env };
      delete base.XDG_CACHE_HOME;
      const r = spawnSync('bash', [path.join(repo, 'scripts', 'check-remote.sh'), hostList, '--quick'], {
        encoding: 'utf8',
        env: { ...base, HOME: home, TMPDIR: tmpdir, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, PEEK: peek, THREADBEAR_CHECK_STAY_SECS: String(staySecs), ...env },
      });
      const read = (f: string) => (fs.existsSync(path.join(fake, f)) ? fs.readFileSync(path.join(fake, f), 'utf8') : '');
      // The copies left on each host afterwards.
      const left = (h: string) => {
        const runs = path.join(fake, h, 'home', '.cache', 'threadbear-check', 'runs');
        return fs.existsSync(runs) ? fs.readdirSync(runs) : [];
      };
      return { ...r, ssh: read('ssh.log'), sshOpts: read('ssh-opts.log'), rsyncPeek: read('rsync-peek'), copies: read('copies.log').trim().split('\n').filter(Boolean), left, peek: read('peek') };
    },
  };
}

test('a slow copy that loses the race waits on its host with the same copy, even with another free', () => {
  const s = setup({ h1: { state: 'free', lose: 1 }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 0);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ran on h1 after waiting from .*\/runs\/[^/]+-0\/scripts/);
  assert.match(r.stdout, /waiting for it there/);
  assert.deepEqual(r.copies, ['h1']);
  // h1 was free first, so h2 was never even probed.
  assert.doesNotMatch(r.ssh, /^h2 /m);
});

test('a quick copy that loses the race chooses again and reuses the copy on the same host', () => {
  const s = setup({ h1: { state: 'free', lose: 1 } });
  const r = s.run('h1', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /its copy is already there/);
  assert.match(r.stdout, /ran on h1 after waiting from .*-0\/scripts/);
  assert.deepEqual(r.copies, ['h1']);
  assert.deepEqual(r.left('h1'), []);
});

test('a quick copy that loses the race moves to a free host and deletes the first copy', () => {
  const s = setup({ h1: { state: 'free', lose: 1 }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ran on h2 now from .*\/h2\/home\/.*-1\/scripts/);
  assert.deepEqual(r.copies, ['h1', 'h2']);
  assert.deepEqual(r.left('h1'), []);
  assert.deepEqual(r.left('h2'), []);
});

test('losing three times in a row waits in line rather than trying forever', () => {
  const s = setup({ h1: { state: 'free', lose: 5, looksFree: true } });
  const r = s.run('h1', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/choosing again/g) ?? []).length, 3);
  assert.match(r.stdout, /ran on h1 after waiting/);
  assert.deepEqual(r.copies, ['h1']);
});

test('the copy carries the checkout, untracked files included, and .check-changed', () => {
  const s = setup({ h1: { state: 'free' } });
  fs.writeFileSync(path.join(s.repo, 'untracked.txt'), 'u\n');
  fs.writeFileSync(path.join(s.repo, 'ignored.log'), 'i\n');
  fs.writeFileSync(path.join(s.repo, '.gitignore'), '*.log\n');
  fs.writeFileSync(path.join(s.repo, 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync('a.txt', path.join(s.repo, 'link'));
  // docs/ and site/ pictures stay behind; site's JSON goes (TourTests reads it).
  fs.mkdirSync(path.join(s.repo, 'docs'));
  fs.mkdirSync(path.join(s.repo, 'site'));
  fs.writeFileSync(path.join(s.repo, 'docs', 'shot.png'), 'png');
  fs.writeFileSync(path.join(s.repo, 'site', 'tour.json'), '{}');
  const r = s.run('h1', 3600, 'find . -mindepth 1 | sed "s#^\\./##" | sort; [ -x tool.sh ] && echo "tool.sh runs"; echo "link -> $(readlink link)"');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.copies, ['h1']);
  const listed = r.peek.trim().split('\n');
  for (const f of ['a.txt', 'untracked.txt', '.gitignore', 'tool.sh', 'link', 'scripts', 'scripts/check-remote.sh', '.check-changed',
    'tool.sh runs', 'link -> a.txt', 'site/tour.json']) {
    assert.ok(listed.includes(f), `${f} in ${listed.join(',')}`);
  }
  assert.ok(!listed.includes('ignored.log'), listed.join(','));
  assert.ok(!listed.includes('docs/shot.png'), listed.join(','));
});

test('a .check-changed in the checkout never has the real one written through it, and modes are kept', () => {
  const s = setup({ h1: { state: 'free' } });
  const victim = path.join(s.fake, 'victim');
  fs.writeFileSync(victim, 'untouched\n');
  fs.symlinkSync(victim, path.join(s.repo, '.check-changed'));
  fs.writeFileSync(path.join(s.repo, 'shared.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(s.repo, 'shared.sh'), 0o775);
  const r = s.run('h1', 3600, '[ -L .check-changed ] && echo "is a link"; cat .check-changed; ls -l shared.sh | cut -c1-10');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n');
  assert.doesNotMatch(r.peek, /is a link/);
  // The changed list (here the untracked files) is what's there.
  assert.match(r.peek, /^shared\.sh$/m);
  // Modes as they are here, not as the receiver's umask would leave them.
  assert.match(r.peek, /-rwxrwxr-x/);
});

// Daybreak, 7 Nov 2026. The folder a host reports for its cache is that
// host's word: it's used only if it's a plain absolute path (letters,
// digits, . _ / -, no . or .. parts) ending in .cache/threadbear-check, and
// it's never part of a program run here.
test("a host whose reported folder isn't a plain absolute path is passed over", () => {
  const s = setup({ h1: { state: 'free' } });
  const odd = ['relative/.cache/threadbear-check', `${s.fake}/x y/.cache/threadbear-check`, `${s.fake}/x'y/.cache/threadbear-check`,
    `${s.fake}/a#b/.cache/threadbear-check`, `${s.fake}/a/../.cache/threadbear-check`, `${s.fake}/a/./.cache/threadbear-check`, `${s.fake}/é/.cache/threadbear-check`];
  for (const base of odd) {
    fs.writeFileSync(path.join(s.fake, 'h1', 'base'), base);
    fs.rmSync(path.join(s.fake, 'copies.log'), { force: true });
    const r = s.run('h1', 3600);
    assert.equal(r.status, 255, `${base}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Unexpected folder on h1/, base);
    assert.deepEqual(r.copies, [], base);
  }
});

test('a host passed over for its folder leaves the next one to run the check', () => {
  const s = setup({ h1: { state: 'free', base: '/x y/.cache/threadbear-check' }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ran on h2 now/);
  assert.deepEqual(r.copies, ['h2']);
});

test("a failed step's log path is changed to this Mac's copy as plain text", () => {
  const s = setup({ h1: { state: 'free' } });
  const r = s.run('h1', 3600, '', { PRINT_LOG: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const local = path.join(s.tmpdir, 'threadbear-check-remote.');
  const log = r.stdout.split('\n').find((l) => l.startsWith('log at '));
  assert.ok(log?.startsWith(`log at ${local}`) && log.endsWith('/step.log'), r.stdout);
  // Only that exact folder: one that differs where a pattern's "." would
  // have matched anything is left as it is.
  const near = r.stdout.split('\n').find((l) => l.startsWith('near '));
  assert.match(near ?? '', /\/Xcache\/threadbear-check\/tmp-[0-9-]+\/threadbear-check\.Ab12\/step\.log$/, r.stdout);
});

// The copy lock: its file in a folder of this user's own, mode 700, and the
// helper's ready and release files in a folder mktemp -d made for this run,
// never names made up in the shared TMPDIR.
const LIST_LOCKS = 'for f in "$TMPDIR"/* "$HOME/.cache/threadbear-check-locks" "$HOME/.cache/threadbear-check-locks"/* "$TMPDIR"/tb-check-lock.*/*; do [ -e "$f" ] || [ -L "$f" ] || continue; ls -ld "$f" | awk \'{print $1}\' | tr "\\n" " "; echo "$f"; done';

test("the copy lock's files are in folders only this user can use", () => {
  const s = setup({ h1: { state: 'free' } });
  const r = s.run('h1', 3600, '', { RSYNC_PEEK: LIST_LOCKS });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const held = r.rsyncPeek.trim().split('\n').filter(Boolean).map((l) => {
    const [mode, ...rest] = l.split(' ');
    return { mode, file: rest.join(' ') };
  });
  const lockDir = path.join(s.home, '.cache', 'threadbear-check-locks');
  assert.ok(held.some((h) => h.file === lockDir && h.mode.startsWith('drwx------')), r.rsyncPeek);
  assert.ok(held.some((h) => h.file.startsWith(`${lockDir}/copy-`) && h.file.endsWith('-h1.lock')), r.rsyncPeek);
  // Everything of the lock's in TMPDIR is a private folder of this run's.
  for (const h of held.filter((x) => x.file.startsWith(`${s.tmpdir}/tb-check`))) {
    if (path.dirname(h.file) === s.tmpdir) {
      assert.match(path.basename(h.file), /^tb-check-lock\.[A-Za-z0-9]+$/, r.rsyncPeek);
      assert.ok(h.mode.startsWith('drwx------'), r.rsyncPeek);
    } else assert.match(path.dirname(h.file), /\/tb-check-lock\.[A-Za-z0-9]+$/, r.rsyncPeek);
  }
  assert.ok(held.some((h) => /\/tb-check-lock\.[A-Za-z0-9]+$/.test(h.file)), r.rsyncPeek);
  // And the run's folder goes with it.
  assert.deepEqual(fs.readdirSync(s.tmpdir).filter((f) => f.startsWith('tb-check')), []);
});

test("a lock folder that isn't this user's own, mode 700, is never used or repaired", () => {
  for (const make of ['open', 'link'] as const) {
    const s = setup({ h1: { state: 'free' } });
    const lockDir = path.join(s.home, '.cache', 'threadbear-check-locks');
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const elsewhere = path.join(s.home, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    if (make === 'open') {
      fs.mkdirSync(lockDir);
      fs.chmodSync(lockDir, 0o755);
    } else fs.symlinkSync(elsewhere, lockDir);
    const r = s.run('h1', 3600);
    assert.equal(r.status, 1, `${make}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Couldn't take the lock on this checkout's copy/, make);
    assert.deepEqual(r.copies, [], make);
    if (make === 'open') assert.equal(fs.statSync(lockDir).mode & 0o777, 0o755, 'left as it was');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  }
});

// ssh's shared connection: its socket in ~/.ssh/tbc, a folder of this
// user's own, never a name in /tmp another account could make first.
test("ssh shares a connection through a socket in this user's own folder", () => {
  const s = setup({ h1: { state: 'free' } });
  const r = s.run('h1', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = path.join(s.home, '.ssh', 'tbc');
  assert.ok(r.sshOpts.split('\n').includes(`ControlPath=${dir}/%C`), r.sshOpts);
  assert.ok(r.sshOpts.split('\n').includes('ControlMaster=auto'), r.sshOpts);
  assert.doesNotMatch(r.sshOpts, /\/tmp\/tbc-/);
  const st = fs.lstatSync(dir);
  assert.ok(st.isDirectory() && (st.mode & 0o777) === 0o700 && st.uid === process.getuid!());
});

test('without a short private folder for the socket, each ssh connects on its own', () => {
  const longHome = path.join(shortHome(), 'a-folder-name-long-enough-for-the-socket-path');
  fs.mkdirSync(longHome);
  const cases: [string, (home: string) => void][] = [
    ['open', (home) => fs.mkdirSync(path.join(home, '.ssh', 'tbc'), { recursive: true, mode: 0o755 })],
    ['link', (home) => {
      fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
      fs.mkdirSync(path.join(home, 'real'), { mode: 0o700 });
      fs.symlinkSync(path.join(home, 'real'), path.join(home, '.ssh', 'tbc'));
    }],
    ['long', () => undefined],
  ];
  for (const [what, make] of cases) {
    const home = what === 'long' ? longHome : shortHome();
    make(home);
    const s = setup({ h1: { state: 'free' } }, { home });
    const r = s.run('h1', 3600);
    assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
    const opts = r.sshOpts.split('\n');
    assert.ok(opts.includes('ControlMaster=no') && opts.includes('ControlPath=none'), `${what}: ${r.sshOpts}`);
    assert.ok(!opts.some((o) => o.startsWith('ControlPath=/')), `${what}: ${r.sshOpts}`);
    assert.match(r.stderr, /Not sharing one ssh connection per host/, what);
    if (what === 'open') assert.equal(fs.statSync(path.join(home, '.ssh', 'tbc')).mode & 0o777, 0o755, 'left as it was');
    if (what === 'long') assert.ok(!fs.existsSync(path.join(home, '.ssh', 'tbc')));
  }
});

test('a home with a newline in its name gets no shared connection, even with its folder ready', () => {
  const home = path.join(shortHome(), 'a\nb');
  fs.mkdirSync(path.join(home, '.ssh', 'tbc'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, '.ssh'), 0o700);
  fs.chmodSync(path.join(home, '.ssh', 'tbc'), 0o700);
  const s = setup({ h1: { state: 'free' } }, { home });
  const r = s.run('h1', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const opts = r.sshOpts.split('\n');
  assert.ok(opts.includes('ControlMaster=no') && opts.includes('ControlPath=none'), r.sshOpts);
});

// 7 Nov 2026: Tinker Desk fell under 1 GiB and an --app check died with a
// CodeSign error that said nothing about the disk. A host without room is
// passed over before anything's copied, and a failure says when room's short.
// Something changed, so a --quick run has no Swift to build (with nothing
// changed, check.sh runs everything).
const changedSomething = (s: ReturnType<typeof setup>) => fs.writeFileSync(path.join(s.repo, 'changed.txt'), 'c\n');

test('a host low on disk is passed over for the next one, nothing copied to it', () => {
  const s = setup({ h1: { state: 'free', df: macDf(0.9 * GiB) }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /Passing over h1: it has 0\.9 GiB free, and this check wants 8 GiB\./);
  assert.match(r.stdout, /ran on h2 now/);
  assert.deepEqual(r.copies, ['h2']);
  assert.doesNotMatch(r.ssh, /^h1 .*mirror/m);
});

test('a host low on disk is passed over even if it is the only one free', () => {
  const s = setup({ h1: { state: 'free', df: macDf(GiB) }, h2: { state: 'busy' } });
  const r = s.run('h1,h2', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ran on h2 after waiting/);
  assert.deepEqual(r.copies, ['h2']);
});

test('with no host that has room it fails naming each and its free space, and not with 255', () => {
  const s = setup({ h1: { state: 'free', df: macDf(0.95 * GiB) }, h2: { state: 'busy', df: macDf(5 * GiB) } });
  const r = s.run('h1,h2', 3600);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No check host has room for this check: h1 has 0\.9 GiB free, h2 has 5\.0 GiB free, and it wants 8 GiB\./);
  assert.deepEqual(r.copies, []);
});

test('a host that is reachable but low still fails, with another one unreachable', () => {
  const s = setup({ h1: { state: 'free', df: macDf(GiB) } });
  const r = s.run('h1,nope', 3600);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No check host has room for this check: h1 has 1\.0 GiB free/);
});

test("df's lines from each system are read, and the limit is inclusive of exactly enough", () => {
  for (const [df, os] of [[macDf, 'Darwin'], [linuxDf, 'Linux']] as const) {
    const s = setup({ h1: { state: 'free', df: df(2 * GiB), os } });
    changedSomething(s);
    const r = s.run('h1', 3600);
    assert.equal(r.status, 0, `${os}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.copies, ['h1'], os);
    assert.doesNotMatch(r.stderr, /Passing over/, os);
  }
  const s = setup({ h1: { state: 'free', df: macDf(8 * GiB) } });
  const r = s.run('h1', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.copies, ['h1']);
});

test('a run that builds no Swift needs less room than one that does', () => {
  const room = macDf(3 * GiB);
  const quick = setup({ h1: { state: 'free', df: room } });
  changedSomething(quick);
  const noSwift = quick.run('h1', 3600);
  assert.equal(noSwift.status, 0, noSwift.stdout + noSwift.stderr);
  assert.deepEqual(noSwift.copies, ['h1']);

  // Touching ios/ runs ThreadbearKit's Swift tests, even with --quick.
  const ios = setup({ h1: { state: 'free', df: room } });
  fs.mkdirSync(path.join(ios.repo, 'ios'));
  fs.writeFileSync(path.join(ios.repo, 'ios', 'x.swift'), '\n');
  const swift = ios.run('h1', 3600);
  assert.equal(swift.status, 1, swift.stdout + swift.stderr);
  assert.match(swift.stderr, /h1 has 3\.0 GiB free, and it wants 8 GiB/);

  const low = setup({ h1: { state: 'free', df: macDf(1.5 * GiB) } });
  changedSomething(low);
  const r = low.run('h1', 3600);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /h1 has 1\.5 GiB free, and it wants 2 GiB/);
});

test('a Linux host that could not run it anyway is not named as short of room', () => {
  // Nothing changed, so this one needs a Mac; the Linux host's disk isn't the reason.
  const s = setup({ h1: { state: 'free', os: 'Linux', df: linuxDf(GiB) }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 3600);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /h1/);
  assert.deepEqual(r.copies, ['h2']);
});

test("a df answer that can't be used doesn't stop the check, and is never run or trusted as room", () => {
  const marker = path.join(tmpDir('check-remote-marker-'), 'ran');
  const answers = ['', 'not a disk\n', macDf('$(touch ' + marker + ')'), macDf('12x'), macDf('1'.repeat(40)), macDf('-5'), macDf('٣٣')];
  for (const df of answers) {
    const s = setup({ h1: { state: 'free', df } });
    const r = s.run('h1', 3600);
    assert.equal(r.status, 0, `${JSON.stringify(df)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Couldn't read how much disk h1 has free; trying it anyway\./, JSON.stringify(df));
    assert.deepEqual(r.copies, ['h1'], JSON.stringify(df));
  }
  assert.ok(!fs.existsSync(marker));
  // A leading zero isn't octal: 0900 would be an error there.
  const s = setup({ h1: { state: 'free', df: macDf('0900') } });
  const r = s.run('h1', 3600);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /h1 has 0\.0 GiB free/);
});

test('a check that fails on a host left short of room says so last', () => {
  const s = setup({ h1: { state: 'free', dfAfter: macDf(0.5 * GiB) } });
  const r = s.run('h1', 3600, '', { RUN_FAILS: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stderr.trim().split('\n').at(-1), 'h1 had only 0.5 GiB free when this failed, and this check wants 8 GiB, which may be why. Free some space there and run it again.');
});

test('a check that fails with plenty of room, or that passes on a low host, says nothing about it', () => {
  const failed = setup({ h1: { state: 'free' } });
  const f = failed.run('h1', 3600, '', { RUN_FAILS: '1' });
  assert.equal(f.status, 1, f.stdout + f.stderr);
  assert.doesNotMatch(f.stderr, /GiB/);

  const passed = setup({ h1: { state: 'free', dfAfter: macDf(GiB) } });
  const p = passed.run('h1', 3600);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.doesNotMatch(p.stderr, /GiB/);
});

test('a copy that fails on a host short of room says so, and ends as no room rather than 255', () => {
  const s = setup({ h1: { state: 'free', dfAfter: macDf(0.2 * GiB) } });
  const r = s.run('h1', 3600, '', { RSYNC_FAILS_ON: 'h1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Couldn't copy this checkout to h1 \(it has 0\.2 GiB free, and this check wants 8 GiB\); trying the others\./);
  assert.match(r.stderr, /No check host has room for this check: h1 has 0\.2 GiB free, and it wants 8 GiB\./);
  assert.deepEqual(r.left('h1'), []);
});

test('a copy that fails on a host short of room still goes on to one with room', () => {
  const s = setup({ h1: { state: 'free', dfAfter: macDf(0.2 * GiB) }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 3600, '', { RSYNC_FAILS_ON: 'h1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ran on h2 now/);
});

test('a copy that fails with plenty of room is still just unreachable: 255', () => {
  const s = setup({ h1: { state: 'free' } });
  const r = s.run('h1', 3600, '', { RSYNC_FAILS_ON: 'h1' });
  assert.equal(r.status, 255, r.stdout + r.stderr);
  assert.match(r.stderr, /Couldn't copy this checkout to h1; trying the others\./);
  assert.match(r.stderr, /None of h1 can run this check now\./);
});

// Codex's review of the above.
test("a disk too full for the probe's own mkdir is no room, not unreachable", () => {
  const s = setup({ h1: { state: 'free', df: macDf(0.1 * GiB) } });
  fs.writeFileSync(path.join(s.fake, 'h1', 'probe-fails'), '');
  const r = s.run('h1', 3600);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No check host has room for this check: h1 has 0\.1 GiB free/);
  assert.deepEqual(r.copies, []);
});

test('a probe that fails with room to spare, or a host ssh cannot reach, is still unreachable: 255', () => {
  const s = setup({ h1: { state: 'free' } });
  fs.writeFileSync(path.join(s.fake, 'h1', 'probe-fails'), '');
  for (const hosts of ['h1', 'nope']) {
    const r = s.run(hosts, 3600);
    assert.equal(r.status, 255, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`Couldn't reach ${hosts} over ssh`));
  }
});

test('a slow copy that loses the race to a check that fills the disk moves on, not waits there', () => {
  const s = setup({ h1: { state: 'free', lose: 1, dfAfter: macDf(0.5 * GiB) }, h2: { state: 'free' } });
  const r = s.run('h1,h2', 0);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /Passing over h1: it has 0\.5 GiB free/);
  assert.match(r.stdout, /ran on h2 now/);
  assert.deepEqual(r.copies, ['h1', 'h2']);
  assert.deepEqual(r.left('h1'), []);
});

test('a failure is judged by the disk as it failed, not after its temp files went', () => {
  const s = setup({ h1: { state: 'free' } });
  const r = s.run('h1', 3600, '', { RUN_FAILS: '1', KEPT_KB: String(GiB) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr.trim().split('\n').at(-1)!, /^h1 had only 1\.0 GiB free when this failed/);

  // A write the full disk cut short leaves it empty: ask the host now instead.
  const empty = setup({ h1: { state: 'free', dfAfter: macDf(0.5 * GiB) } });
  const e = empty.run('h1', 3600, '', { RUN_FAILS: '1', KEPT_EMPTY: '1' });
  assert.equal(e.status, 1, e.stdout + e.stderr);
  assert.match(e.stderr, /h1 had only 0\.5 GiB free when this failed/);
});

// The host's side for real: a scratch copy whose check.sh fails, with temp
// files that are gone by the end, and a df that sits in the folder --on-host
// puts first on PATH (the pinned Node's).
function onHost(checkExit: number, df: string) {
  const home = shortHome();
  const base = path.join(home, '.cache', 'threadbear-check');
  const copy = path.join(base, 'runs', '1-1-0');
  fs.mkdirSync(path.join(copy, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(copy, 'scripts', 'check-remote.sh'));
  fs.writeFileSync(path.join(copy, 'check.sh'), `#!/bin/bash\necho made >"$TMPDIR/big"\nexit ${checkExit}\n`, { mode: 0o755 });
  const nodeBin = path.join(home, '.nvm', 'versions', 'node', 'v24.22.1', 'bin');
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.writeFileSync(path.join(nodeBin, 'df'), `#!/bin/bash\n[ "$*" = "-Pk ." ] || exit 9\ncat <<'END'\n${df}END\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(copy, 'scripts', 'check-remote.sh'), '--on-host', '1-1-0'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  return { r, base, kept: path.join(base, 'kept-1-1-0', 'free-kb') };
}

test('--on-host records the free space of a failed run for this Mac, before clearing up', () => {
  const { r, base, kept } = onHost(3, macDf(GiB));
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(kept, 'utf8').trim(), String(GiB));
  assert.ok(!fs.existsSync(path.join(base, 'tmp-1-1-0')), 'temp files gone');
  assert.ok(!fs.existsSync(path.join(base, 'src')), 'copy gone');
});

test('--on-host records nothing when the run passed', () => {
  const { r, kept } = onHost(0, macDf(GiB));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(kept));
});
