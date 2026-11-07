import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { type CiRun, ciVerdict, gitAsync, FETCH_INTERVAL_MS, FIRST_LOOK_MS, SETTLE_MS, Upstream, cleanNotes, parseImportant, parseNotes, repoKey, signersPath, splitSignedTag, tagFor } from '../../src/upstream.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

// Commits and tags in the throwaway repos need a name, and must not pick
// up a signing setup from whoever runs the tests.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Mike', GIT_AUTHOR_EMAIL: 'mike@example.com', GIT_COMMITTER_NAME: 'Mike', GIT_COMMITTER_EMAIL: 'mike@example.com', GIT_CONFIG_GLOBAL: '/dev/null' };
// The runner's own git (the signed tag) needs a name too: with no global
// config, git on macOS makes one up from the hostname, but on Linux it
// refuses ("Committer identity unknown").
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_COMMITTER_NAME: 'Mike', GIT_COMMITTER_EMAIL: 'mike@example.com' });

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function key(dir: string, name: string): { priv: string; signers: string } {
  const priv = path.join(dir, name);
  const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', priv]);
  assert.equal(r.status, 0, String(r.stderr));
  const signers = path.join(dir, `${name}.signers`);
  fs.writeFileSync(signers, `mike@example.com namespaces="git" ${fs.readFileSync(`${priv}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`);
  return { priv, signers };
}

function commit(repo: string, file: string, subject: string): string {
  fs.writeFileSync(path.join(repo, file), subject);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

function signedTag(repo: string, tag: string, priv: string, rev = 'HEAD'): void {
  git(repo, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${priv}`, 'tag', '-s', '-m', `Threadbear ${tag}`, tag, rev);
}

// Mike's repo (a bare one on "GitHub", and his checkout) and someone's fork
// of it, cloned, with origin as their fork and upstream as Mike's.
function world() {
  const root = tmpDir('tb-upstream-');
  const mikeKey = key(root, 'mike-key');
  const mikeBare = path.join(root, 'mike.git');
  const forkBare = path.join(root, 'fork.git');
  const mike = path.join(root, 'mike');
  const theirs = path.join(root, 'theirs');
  git(root, 'init', '-q', '--bare', '-b', 'main', mikeBare);
  git(root, 'clone', '-q', mikeBare, mike);
  git(mike, 'checkout', '-q', '-b', 'main');
  commit(mike, 'a.txt', 'First');
  signedTag(mike, 'release/2026-10-01', mikeKey.priv);
  git(mike, 'push', '-q', 'origin', 'main', '--tags');
  git(root, 'clone', '-q', '--bare', mikeBare, forkBare);
  git(root, 'clone', '-q', forkBare, theirs);
  git(theirs, 'remote', 'add', 'upstream', mikeBare);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.copyFileSync(mikeKey.signers, signersPath(home));
  return { root, mikeKey, mike, theirs, home };
}

// The clock after every release date the tests use: a release dated after
// today (and a couple of days' slack) isn't looked at.
const LATER = Date.parse('2026-12-31T00:00:00Z');

// origin as GitHub, still fetching from and pushing to the bare repo: the
// runner reads the configured URL, git goes through the insteadOf.
function asGitHub(repo: string, root: string): void {
  git(repo, 'config', 'remote.origin.url', 'https://github.com/mikecann/threadbear.git');
  git(repo, 'config', `url.${path.join(root, 'mike.git')}.insteadOf`, 'https://github.com/mikecann/threadbear.git');
}

function upstreamFor(checkout: string, home: string, clock = new FakeClock(LATER), extra = {}) {
  return new Upstream({ home, checkout, clock, log: nullLogger, ...extra });
}

test('repoKey: the same repo however its URL is written', () => {
  const k = 'github.com/mikecann/threadbear';
  for (const u of ['https://github.com/mikecann/threadbear.git', 'https://github.com/mikecann/threadbear', 'git@github.com:mikecann/threadbear.git', 'ssh://git@github.com/mikecann/threadbear', 'https://x-access-token@github.com/MikeCann/threadbear/']) {
    assert.equal(repoKey(u), k, u);
  }
  assert.notEqual(repoKey('https://github.com/someone/threadbear.git'), k);
});

test('tagFor: release/ and the local date', () => {
  assert.equal(tagFor(new Date(2026, 9, 5, 23, 59)), 'release/2026-10-05');
});

test('a fork sees a newer signed release from Mike, with what main is missing', async () => {
  const w = world();
  const up = upstreamFor(w.theirs, w.home);
  let s = await up.check();
  assert.equal(s.state, 'idle', s.reason ?? '');
  assert.equal(s.release?.tag, 'release/2026-10-01');
  assert.equal(s.release?.changes, 0);

  commit(w.mike, 'b.txt', 'Second');
  const third = commit(w.mike, 'c.txt', 'Third');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  s = await up.check();
  assert.equal(s.state, 'available');
  assert.equal(s.release?.tag, 'release/2026-10-30');
  assert.equal(s.release?.commit, third);
  assert.equal(s.release?.changes, 2);
  assert.deepEqual(s.release?.subjects, ['Third', 'Second']);
  assert.ok(s.checkedAt);
  // Their own tags are left alone: upstream's go in a namespace of their own.
  assert.equal(git(w.theirs, 'tag', '--list', 'release/2026-10-30'), '');

  // Once main has it, there's nothing to bring in.
  git(w.theirs, 'merge', '-q', '--no-edit', 'refs/threadbear/upstream/2026-10-30');
  s = await up.check();
  assert.equal(s.state, 'idle');
  assert.equal(s.release?.changes, 0);
});

test('commits Mike marks Important: come with the release, and lead his tag message', async () => {
  const w = world();
  const seen: string[] = [];
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { onChecked: (s: { state: string }) => seen.push(s.state) });
  commit(w.mike, 'b.txt', 'Ordinary');
  fs.writeFileSync(path.join(w.mike, 'c.txt'), 'x');
  git(w.mike, 'add', 'c.txt');
  git(w.mike, 'commit', '-q', '-m', 'Scrub secrets\n\nWhy it matters.\n\nImportant: keeps API keys out of Convex');
  const fix = git(w.mike, 'rev-parse', 'HEAD');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await up.check();
  assert.deepEqual(s.release?.important, [{ commit: fix, why: 'keeps API keys out of Convex' }]);
  assert.deepEqual(seen, ['available']);
  assert.deepEqual(parseImportant(`abc\x1f\ndef\x1fa reason\n`), [{ commit: 'def', why: 'a reason' }]);
});

test('only tags signed with the pinned key, under their own name, count', async () => {
  const w = world();
  const stranger = key(w.root, 'stranger');
  commit(w.mike, 'b.txt', 'Signed by someone else');
  signedTag(w.mike, 'release/2026-10-30', stranger.priv);
  commit(w.mike, 'c.txt', 'Not signed at all');
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-10-31');
  // A real signed tag for the 29th, pushed again as if it were the 1st.
  git(w.mike, 'update-ref', 'refs/tags/release/2026-11-01', git(w.mike, 'rev-parse', 'refs/tags/release/2026-10-01'));
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'idle');
  assert.equal(s.release?.tag, 'release/2026-10-01');
});

test('off without an upstream remote, when upstream is this repo, or with no pinned key', async () => {
  const w = world();
  assert.match((await upstreamFor(w.mike, w.home).check()).reason ?? '', /no upstream remote/);
  git(w.mike, 'remote', 'add', 'upstream', git(w.mike, 'remote', 'get-url', 'origin'));
  assert.match((await upstreamFor(w.mike, w.home).check()).reason ?? '', /upstream is this repo/);
  fs.rmSync(signersPath(w.home));
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'off');
  assert.match(s.reason ?? '', /no release key pinned/);
});

test('a fetch that fails says so and keeps the release it knew of', async () => {
  const w = world();
  commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  assert.equal((await up.check()).state, 'available');
  git(w.theirs, 'remote', 'set-url', 'upstream', path.join(w.root, 'gone.git'));
  const s = await up.check();
  assert.equal(s.state, 'failed');
  assert.equal(s.release?.tag, 'release/2026-10-30');
});

test('the timer looks a while after start, then every six hours', async () => {
  const w = world();
  const clock = new FakeClock();
  let changes = 0;
  const up = upstreamFor(w.theirs, w.home, clock, { onChange: () => changes++ });
  up.start();
  assert.equal(up.status().state, 'off');
  clock.advance(FIRST_LOOK_MS);
  await waitFor(() => up.status().state === 'idle');
  assert.ok(changes >= 1);
  assert.equal(clock.pending(), 1);
  up.stop();
  assert.equal(clock.pending(), 0);
  void FETCH_INTERVAL_MS;
});

test("Mike's runner tags main once a day, signed, once it has settled", async () => {
  const w = world();
  const tip = commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  let settled = false;
  const clock = new FakeClock(committed + SETTLE_MS / 2);
  const up = upstreamFor(w.mike, w.home, clock, { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => settled });

  assert.equal(await up.publishOnce(), undefined, 'the runner has not settled');
  settled = true;
  assert.equal(await up.publishOnce(), undefined, "main's tip is too new");
  clock.advance(SETTLE_MS);
  const tag = await up.publishOnce();
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), tip);
  assert.match(git(w.mike, 'cat-file', 'tag', tag!), /- Newer work/);
  // Pushed, and signed so that a fork's runner takes it.
  assert.ok(git(w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`));
  assert.equal((await upstreamFor(w.theirs, w.home, clock).check()).release?.tag, tag);
  assert.equal(up.status().published?.tag, tag);

  // Not again the same day, and not on a later day with nothing new.
  assert.equal(await up.publishOnce(), undefined);
  clock.advance(24 * 60 * 60_000);
  assert.equal(await up.publishOnce(), undefined);
});

test("release notes: Mike's runner writes them into the tag, and a fork reads each release's", async () => {
  const w = world();
  const prompts: string[] = [];
  let reply: string | undefined = '- Threads can be pinned\n- Search is quicker';
  let failPush = true;
  commit(w.mike, 'b.txt', 'Pinning: a pin button on rows\n\nBecause Mike asked.');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true,
    writeNotes: async (commits: string) => { prompts.push(commits); if (reply === 'throw') throw new Error('no room'); return reply; },
    git: async (cwd: string, args: string[]) => {
      if (args[0] === 'push' && args.some((a) => a.startsWith('refs/tags/')) && failPush) { failPush = false; throw new Error('push offline'); }
      return git(cwd, ...args);
    },
  });
  await assert.rejects(up.publishOnce(), /push offline/);
  const first = await up.publishOnce();
  assert.equal(prompts.length, 1, 'a failed push reuses the draft for the same commits');
  assert.match(prompts[0], /Pinning: a pin button on rows\nBecause Mike asked\./);
  const message = git(w.mike, 'cat-file', 'tag', first!);
  assert.match(message, /What's new:\n- Threads can be pinned\n- Search is quicker\n\nEvery change:\n- Pinning: a pin button on rows/);

  // The next day, the model fails: the release goes out without notes.
  commit(w.mike, 'c.txt', 'Tidy the tests');
  git(w.mike, 'push', '-q', 'origin', 'main');
  clock.advance(24 * 60 * 60_000 + 2 * SETTLE_MS);
  reply = 'throw';
  const second = await up.publishOnce();
  assert.ok(second && second !== first);
  assert.doesNotMatch(git(w.mike, 'cat-file', 'tag', second), /What's new:/);

  // A fork behind both sees the first's notes (the second has none).
  const s = await upstreamFor(w.theirs, w.home, clock).check();
  assert.equal(s.release?.tag, second);
  assert.deepEqual(s.release?.notes, [{ tag: second, lines: ['Tidy the tests'] }, { tag: first, lines: ['Threads can be pinned', 'Search is quicker'] }]);
  // Once main has the first, only what's newer counts.
  git(w.theirs, 'merge', '-q', '--no-edit', git(w.mike, 'rev-parse', `${first}^{commit}`));
  assert.deepEqual((await upstreamFor(w.theirs, w.home, clock).check()).release?.notes, [{ tag: second, lines: ['Tidy the tests'] }]);
});

test('release notes exclude signed tags outside the offered history and unsigned notes', async () => {
  const w = world();
  commit(w.mike, 'main.txt', 'Main work');
  const newest = git(w.mike, 'rev-parse', 'HEAD');
  git(w.mike, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  commit(w.mike, 'side.txt', 'Unmerged side work');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', "What's new:\n- Not in the offered release", 'release/2026-11-01');
  git(w.mike, 'tag', '-a', '-m', "What's new:\n- Unsigned notes", 'release/2026-11-02');
  git(w.mike, 'checkout', '-q', 'main');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', "What's new:\n- Main work", 'release/2026-11-03', newest);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.deepEqual(s.release?.notes, [{ tag: 'release/2026-11-03', lines: ['Main work'] }]);
});

test('parseNotes and cleanNotes', () => {
  assert.deepEqual(parseNotes("Threadbear 2026-11-06\n\nImportant: x\n\nWhat's new:\n- One\n- Two\n\nEvery change:\n- a"), ['One', 'Two']);
  assert.deepEqual(parseNotes('Threadbear 2026-11-01\n\n- an old one with only subjects'), []);
  assert.deepEqual(cleanNotes('Here you go:\n- One — and more\n* Two\nnot a line'), ['One, and more', 'Two']);
  assert.deepEqual(cleanNotes(' NONE '), []);
  assert.deepEqual(cleanNotes(undefined), []);
  assert.deepEqual(cleanNotes('- ' + 'x'.repeat(1000)), ['x'.repeat(200)]);
});

test("ciVerdict: every workflow's latest attempt has to pass", () => {
  const run = (workflow: string, status: string, conclusion: string | null, attempt = 1): CiRun => ({ workflow, name: `wf ${workflow}`, status, conclusion, attempt });
  assert.equal(ciVerdict([run('1', 'completed', 'success'), run('2', 'completed', 'skipped')]), undefined);
  assert.match(ciVerdict([])!, /hasn't run/);
  assert.match(ciVerdict([run('1', 'completed', 'success'), run('2', 'in_progress', null)])!, /still running/);
  assert.equal(ciVerdict([run('1', 'completed', 'failure'), run('2', 'completed', 'cancelled')]), '"wf 1", "wf 2" didn\'t pass on it');
  // A red run re-run green passes; a green one re-run red doesn't.
  assert.equal(ciVerdict([run('1', 'completed', 'failure', 1), run('1', 'completed', 'success', 2)]), undefined);
  assert.match(ciVerdict([run('1', 'completed', 'success', 1), run('1', 'completed', 'failure', 2)])!, /didn't pass/);
});

test("Mike's runner holds a release until GitHub's checks pass on that commit", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  const tip = commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  let runs: CiRun[] | Error = [{ workflow: '7', name: 'Builds on Xcode 26', status: 'completed', conclusion: 'failure', attempt: 1 }];
  const asked: string[] = [];
  let notesCalls = 0;
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv },
    runningMainSettled: () => true,
    writeNotes: async () => { notesCalls++; return "- Checks keep releases buildable"; },
    ciRuns: async (repo: string, sha: string) => {
      asked.push(`${repo} ${sha}`);
      if (runs instanceof Error) throw runs;
      return runs;
    },
  });

  assert.equal(await up.publishOnce(), undefined, 'a red build holds it');
  assert.deepEqual(asked, [`mikecann/threadbear ${tip}`]);
  assert.equal(up.status().held?.commit, tip);
  assert.match(up.status().held!.why, /"Builds on Xcode 26" didn't pass/);
  assert.equal(git(w.mike, 'tag', '--list', 'release/2026-12*'), '');
  // A check of upstream in between leaves it saying so.
  await up.check();
  assert.ok(up.status().held);

  runs = new Error('offline');
  assert.equal(await up.publishOnce(), undefined, "checks it can't read hold it too");
  assert.match(up.status().held!.why, /couldn't read GitHub's checks/);

  assert.equal(notesCalls, 0, 'notes generation waits for the exact commit checks too');
  runs = [{ workflow: '7', name: 'Builds on Xcode 26', status: 'completed', conclusion: 'success', attempt: 2 }];
  const tag = await up.publishOnce();
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), tip);
  assert.equal(up.status().held, undefined);
  assert.equal(up.status().published?.tag, tag);
  assert.equal(notesCalls, 1);
  assert.match(git(w.mike, "cat-file", "tag", tag!), /What's new:\n- Checks keep releases buildable/);
});

test("Mike's runner pushes a settled main GitHub doesn't have, then waits for its checks", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  const tip = commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  // Landed here, never pushed.
  assert.notEqual(git(w.mike, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], tip);
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true, ciRuns: async () => assert.fail('not asked yet') });
  assert.equal(await up.publishOnce(), undefined);
  assert.equal(git(w.mike, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], tip, 'pushed');
  assert.match(up.status().held!.why, /just pushed main/);

  // A main that's gone a different way from GitHub's isn't pushed over it.
  const w2 = world();
  asGitHub(w2.mike, w2.root);
  commit(w2.mike, 'x.txt', 'Mine');
  const other = path.join(w2.root, 'other');
  git(w2.root, 'clone', '-q', path.join(w2.root, 'mike.git'), other);
  commit(other, 'y.txt', 'Theirs');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  fs.mkdirSync(path.join(w2.mike, '.github', 'workflows'), { recursive: true });
  commit(w2.mike, '.github/workflows/build.yml', 'Build on GitHub');
  const at = Number(git(w2.mike, 'log', '-1', '--format=%ct')) * 1000;
  const up2 = upstreamFor(w2.mike, w2.home, new FakeClock(at + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w2.mikeKey.priv }, runningMainSettled: () => true });
  assert.equal(await up2.publishOnce(), undefined);
  assert.match(up2.status().held!.why, /different ways/);
  assert.match(git(other, 'log', '-1', '--format=%s', 'origin/main'), /Theirs/);
});

test("a main whose origin isn't GitHub can't show its checks, so it waits", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true, ciRuns: async () => assert.fail('not asked') });
  assert.equal(await up.publishOnce(), undefined);
  assert.match(up.status().held!.why, /isn't on GitHub/);
});

test('publishing needs a signing key', async () => {
  const w = world();
  const up = upstreamFor(w.mike, w.home, new FakeClock(Date.now() + 2 * SETTLE_MS), { publish: { publish: true, signingKey: path.join(w.root, 'missing') }, runningMainSettled: () => true });
  assert.equal(await up.publishOnce(), undefined);
});

// A stand-in for gpg (or gpgsm) that signs with made-up armor and says any
// signature is good, as a victim's gpg does for an attacker's key that's in
// their keyring or that it fetched itself (auto-key-retrieve, WKD).
function fakeGpg(dir: string, armor: 'PGP SIGNATURE' | 'SIGNED MESSAGE'): string {
  const file = path.join(dir, `fake-gpg-${armor.replace(' ', '-')}`);
  fs.writeFileSync(file, `#!/bin/sh
case "$*" in
  *--verify*)
    # Read what git writes in, as gpg does: leaving it unread, git can get
    # a broken pipe and call the tag bad (two runs in three on Linux).
    cat > /dev/null
    printf '[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 0123456789ABCDEF Mallory <m@example.com>\n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-12-01 1764547200 0 4 0 22 10 00 0123456789ABCDEF0123456789ABCDEF01234567\n[GNUPG:] TRUST_FULLY 0 pgp\n'
    exit 0;;
  *)
    cat > /dev/null
    printf -- '-----BEGIN ${armor}-----\n\nAAAAfakefakefake\n-----END ${armor}-----\n'
    printf '\n[GNUPG:] SIG_CREATED D 22 8 00 1764547200 0123456789ABCDEF0123456789ABCDEF01234567\n' >&2
    exit 0;;
esac
`, { mode: 0o755 });
  return file;
}

// The victim's own git config pointing gpg (or gpgsm) at the fake, for as
// long as \`run\` takes: the runner's git reads it, as it would ~/.gitconfig.
async function withVictimGpg<T>(entries: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const keys = Object.keys(entries);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(keys.length) };
  keys.forEach((k, i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: k, [`GIT_CONFIG_VALUE_${i}`]: entries[k] }));
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Gautam's scan, 6 Nov 2026, F5: verify-tag with gpg.format=ssh still hands
// a PGP or X.509 signature to gpg and the whole keyring, so an attacker who
// controls upstream got a release past the pinned key with their own key.
test('a release tag signed with OpenPGP or X.509 never counts, whatever gpg says about it', async () => {
  const w = world();
  const pgp = fakeGpg(w.root, 'PGP SIGNATURE');
  const x509 = fakeGpg(w.root, 'SIGNED MESSAGE');
  commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, '-c', 'gpg.format=openpgp', '-c', `gpg.program=${pgp}`, '-c', 'user.signingkey=MALLORY', 'tag', '-s', '-m', 'Threadbear 2026-12-01', 'release/2026-12-01');
  git(w.mike, '-c', 'gpg.format=x509', '-c', `gpg.x509.program=${x509}`, '-c', 'user.signingkey=MALLORY', 'tag', '-s', '-m', 'Threadbear 2026-12-02', 'release/2026-12-02');
  assert.match(git(w.mike, 'cat-file', 'tag', 'release/2026-12-01'), /-----BEGIN PGP SIGNATURE-----/);
  assert.match(git(w.mike, 'cat-file', 'tag', 'release/2026-12-02'), /-----BEGIN SIGNED MESSAGE-----/);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  // The victim's gpg would call both good.
  const s = await withVictimGpg({ 'gpg.program': pgp, 'gpg.openpgp.program': pgp, 'gpg.x509.program': x509 }, async () => {
    assert.equal(spawnSync('git', ['-C', w.mike, 'verify-tag', 'release/2026-12-01'], { env: process.env }).status, 0, 'gpg calls the PGP tag good');
    return upstreamFor(w.theirs, w.home).check();
  });
  assert.equal(s.release?.tag, 'release/2026-10-01');
  assert.equal(s.state, 'idle');
  assert.equal(spawnSync('git', ['-C', w.theirs, 'rev-parse', '-q', '--verify', 'refs/threadbear/upstream/2026-12-01']).status, 1, 'never copied where a bring-in merges from');
});

test('splitSignedTag: only one SSH signature block, at the end, under the four headers git writes', () => {
  const w = world();
  const raw = spawnSync('git', ['-C', w.mike, 'cat-file', 'tag', 'release/2026-10-01']).stdout as Buffer;
  const text = raw.toString('latin1');
  const ok = splitSignedTag(raw, 'release/2026-10-01');
  assert.ok(ok, 'a tag as Mike signs it');
  assert.equal(ok.commit, git(w.mike, 'rev-parse', 'release/2026-10-01^{commit}'));
  assert.ok(ok.date);
  assert.equal(ok.payload.length + Buffer.byteLength(ok.signature, 'latin1'), raw.length, 'payload and signature are the whole object');
  const sig = text.slice(text.indexOf('-----BEGIN SSH'));
  const pgp = '-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n';
  const bad: [string, string][] = [
    ['another name', text],
    ['a PGP block after Mike\'s', text + pgp],
    ['a PGP block before it', text.replace(sig, pgp + sig)],
    ['an X.509 block in the message', text.replace(sig, '-----BEGIN SIGNED MESSAGE-----\nAAAA\n-----END SIGNED MESSAGE-----\n' + sig)],
    ['a second SSH block', text + sig],
    ['no signature', text.slice(0, text.indexOf('-----BEGIN SSH'))],
    ['a header added', text.replace('\ntagger ', '\ngpgsig-sha256 x\ntagger ')],
    ['a tag of a tree', text.replace('type commit', 'type tree')],
    ['text after the signature', text + 'more\n'],
  ];
  for (const [what, t] of bad) assert.equal(splitSignedTag(Buffer.from(t, 'latin1'), what === 'another name' ? 'release/2026-10-02' : 'release/2026-10-01'), undefined, what);
  // Armor mentioned in a commit subject (publishOnce starts each with "- ")
  // isn't a block, so it doesn't stop a release.
  const subject = Buffer.from(text.replace(sig, '- Reject -----BEGIN PGP SIGNATURE----- tags\n' + sig), 'latin1');
  assert.ok(splitSignedTag(subject, 'release/2026-10-01'));
});

const kept = (repo: string, name: string) => spawnSync('git', ['-C', repo, 'rev-parse', '-q', '--verify', `refs/threadbear/upstream/${name}^{commit}`], { encoding: 'utf8' }).stdout.trim();

// F31: the fetch force-moved refs/threadbear/upstream/<date>, the ref a
// bring-in thread merges, to whatever upstream served, before any check.
test('a release swapped upstream after it verified never moves the ref a bring-in merges', async () => {
  const w = world();
  const good = commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  assert.equal((await up.check()).release?.commit, good);

  // The attacker force-pushes the same name, unsigned, at their own commit.
  git(w.mike, 'checkout', '-q', '-b', 'evil');
  const evil = commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, 'tag', '-f', '-a', '-m', 'Threadbear 2026-10-30', 'release/2026-10-30', evil);
  git(w.mike, 'push', '-q', '-f', 'origin', 'refs/tags/release/2026-10-30');
  const s = await up.check();
  assert.equal(kept(w.theirs, '2026-10-30'), good, 'the verified ref keeps the commit that verified');
  assert.equal(s.release?.tag, 'release/2026-10-30');
  assert.equal(s.release?.commit, good);
  // What upstream serves now never reached the checkout: it was staged
  // outside it, didn't verify, and went (Daybreak, 7 Nov 2026).
  assert.equal(git(w.theirs, 'for-each-ref', 'refs/threadbear/upstream-incoming/'), '');
  assert.notEqual(spawnSync('git', ['-C', w.theirs, 'cat-file', '-e', evil]).status, 0, 'the unsigned tag\'s commit is not in the checkout');
});

test('a release name that verified keeps its first tag even if a signed one replaces it upstream', async () => {
  const w = world();
  const first = commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  await up.check();
  const other = commit(w.mike, 'c.txt', 'Third');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-f', '-s', '-m', 'again', 'release/2026-10-30', other);
  git(w.mike, 'push', '-q', '-f', 'origin', 'main', 'refs/tags/release/2026-10-30');
  const s = await up.check();
  assert.equal(kept(w.theirs, '2026-10-30'), first);
  assert.equal(s.release?.commit, first);
});

// A runner from before this check fetched straight into the verified
// namespace, so a fork can have an unsigned tag sitting there.
test('an unsigned ref an older runner left among the releases is taken out, and a signed one takes its name', async () => {
  const w = world();
  git(w.mike, 'checkout', '-q', '-b', 'evil');
  const evil = commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-11-02', evil);
  git(w.mike, 'push', '-q', 'origin', 'refs/tags/release/2026-11-02');
  git(w.mike, 'checkout', '-q', 'main');
  // What the old fetch did.
  git(w.theirs, 'fetch', '-q', '--no-tags', 'upstream', '+refs/tags/release/*:refs/threadbear/upstream/*');
  assert.equal(kept(w.theirs, '2026-11-02'), evil);
  const leftover = git(w.theirs, 'rev-parse', 'refs/threadbear/upstream/2026-11-02');
  git(w.mike, 'push', '-q', '-f', 'origin', ':refs/tags/release/2026-11-02');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.release?.tag, 'release/2026-10-01');
  assert.equal(kept(w.theirs, '2026-11-02'), '', 'taken out, so nothing merges it by name');

  // Left over under a name upstream now has a real release for.
  git(w.theirs, 'update-ref', 'refs/threadbear/upstream/2026-11-03', leftover);
  const real = commit(w.mike, 'd.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-03', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const t = await upstreamFor(w.theirs, w.home).check();
  assert.equal(t.release?.commit, real);
  assert.equal(kept(w.theirs, '2026-11-03'), real);
});

test('with no ssh-keygen to ask, the check fails and keeps the releases it verified', async () => {
  const w = world();
  const up = upstreamFor(w.theirs, w.home);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-01');
  const bin = path.join(w.root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim(), path.join(bin, 'git'));
  const before = process.env.PATH;
  process.env.PATH = bin;
  let s;
  try {
    // A runner just started: nothing it remembers.
    s = await upstreamFor(w.theirs, w.home).check();
  } finally {
    process.env.PATH = before;
  }
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /ssh-keygen/);
  assert.ok(kept(w.theirs, '2026-10-01'), 'not taken out as unsigned');
});

// From Codex's review of the fix: what an older runner left among the
// releases is taken out whatever its name, before anything is copied in.
test('every unsigned ref an older runner left among the releases goes, even older ones and ones in the way of a name', async () => {
  const w = world();
  git(w.mike, 'checkout', '-q', '-b', 'evil');
  const evil = commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-10-30', evil);
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-11-06/poison', evil);
  git(w.mike, 'push', '-q', 'origin', 'refs/tags/release/2026-10-30', 'refs/tags/release/2026-11-06/poison');
  git(w.theirs, 'fetch', '-q', '--no-tags', 'upstream', '+refs/tags/release/*:refs/threadbear/upstream/*');
  git(w.mike, 'push', '-q', 'origin', ':refs/tags/release/2026-11-06/poison');
  git(w.mike, 'tag', '-d', 'release/2026-11-06/poison');
  git(w.mike, 'checkout', '-q', 'main');
  const real = commit(w.mike, 'd.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', 'refs/tags/release/2026-11-06');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'available', s.reason ?? '');
  assert.equal(s.release?.commit, real);
  assert.equal(kept(w.theirs, '2026-10-30'), '', 'an older unsigned one goes too');
  assert.equal(kept(w.theirs, '2026-11-06/poison'), '');
});

// Codex's review: upstream can push any number of tags, and each one made
// the runner read (and maybe ssh-keygen) it on every check.
test('a flood of tags upstream costs a check a few reads, once', async () => {
  const w = world();
  const tip = git(w.mike, 'rev-parse', 'HEAD');
  const fake = spawnSync('git', ['-C', w.mike, 'hash-object', '-t', 'tag', '-w', '--stdin'], { input: `object ${tip}\ntype commit\ntag release/2099-01-01\ntagger M <m@e> 1 +0000\n\nx\n-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n`, encoding: 'utf8' }).stdout.trim();
  const lines: string[] = [];
  for (let i = 0; i < 150; i++) lines.push(`create refs/tags/release/junk-${i} ${tip}`);
  for (let i = 1; i <= 28; i++) lines.push(`create refs/tags/release/2099-02-${String(i).padStart(2, '0')} ${fake}`);
  for (let i = 1; i <= 28; i++) lines.push(`create refs/tags/release/2026-09-${String(i).padStart(2, '0')} ${fake}`);
  // Date-named, pointing straight at a commit: turned down without a read.
  for (let d = Date.parse('1990-01-01'); d < Date.parse('1991-01-01'); d += 86_400_000) lines.push(`create refs/tags/release/${new Date(d).toISOString().slice(0, 10)} ${tip}`);
  // Tag objects dated after Mike's newest: read, but only so many a check.
  for (let i = 7; i <= 31; i++) lines.push(`create refs/tags/release/2026-12-${String(i).padStart(2, '0')} ${fake}`);
  assert.equal(spawnSync('git', ['-C', w.mike, 'update-ref', '--stdin'], { input: lines.join('\n') + '\n' }).status, 0);
  const real = commit(w.mike, 'b.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  let reads = 0;
  const { gitBytes } = await import('../../src/upstream.ts');
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { gitBytes: (cwd: string, args: string[]) => (reads++, gitBytes(cwd, args)) });
  // 25 fakes dated after it: 20 a check, then the real one.
  let s = await up.check();
  assert.equal(reads, 20);
  assert.equal(s.release, undefined, 'not reached yet, nor the older one');
  reads = 0;
  s = await up.check();
  assert.equal(s.release?.commit, real);
  assert.ok(reads <= 8, `read ${reads} tags`);
  reads = 0;
  await up.check();
  assert.equal(reads, 0, 'nothing read again');
});

// Codex's second pass: a read that failed was kept as "not signed", and
// in the sweep took a good release out.
test('a read that fails is not taken for an unsigned tag, nor remembered', async () => {
  const w = world();
  const { gitBytes } = await import('../../src/upstream.ts');
  let fail = false;
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { gitBytes: (cwd: string, args: string[]) => (fail ? Promise.reject(new Error('spawn git EAGAIN')) : gitBytes(cwd, args)) });
  const fresh = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { gitBytes: (cwd: string, args: string[]) => (fail ? Promise.reject(new Error('spawn git EAGAIN')) : gitBytes(cwd, args)) });
  assert.equal((await up.check()).release?.tag, 'release/2026-10-01');
  fail = true;
  const s = await fresh.check();
  assert.equal(s.state, 'failed');
  assert.ok(kept(w.theirs, '2026-10-01'), 'the sweep left it');
  fail = false;
  assert.equal((await fresh.check()).release?.tag, 'release/2026-10-01');
});

test('an unsigned ref an older runner left goes even while upstream cannot be fetched', async () => {
  const w = world();
  git(w.mike, 'checkout', '-q', '-b', 'evil');
  const evil = commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-11-06', evil);
  git(w.mike, 'push', '-q', 'origin', 'refs/tags/release/2026-11-06');
  git(w.theirs, 'fetch', '-q', '--no-tags', 'upstream', '+refs/tags/release/*:refs/threadbear/upstream/*');
  git(w.theirs, 'remote', 'set-url', 'upstream', path.join(w.root, 'gone.git'));
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'failed');
  assert.equal(kept(w.theirs, '2026-11-06'), '');
});

// Codex's third pass: a tag past the read buffer failed every check.
test('a huge tag is turned down unread, and one an older runner left is taken out', async () => {
  const w = world();
  const big = path.join(w.root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(17 * 1024 * 1024));
  git(w.mike, 'tag', '-a', '-F', big, 'release/2026-11-05');
  git(w.mike, 'push', '-q', 'origin', 'refs/tags/release/2026-11-05');
  git(w.theirs, 'fetch', '-q', '--no-tags', 'upstream', '+refs/tags/release/*:refs/threadbear/upstream/*');
  const real = commit(w.mike, 'd.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-04', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', 'refs/tags/release/2026-11-04');
  let reads = 0;
  const { gitBytes } = await import('../../src/upstream.ts');
  const s = await upstreamFor(w.theirs, w.home, new FakeClock(LATER), { gitBytes: (cwd: string, args: string[]) => (reads++, gitBytes(cwd, args)) }).check();
  assert.equal(s.release?.commit, real, s.reason ?? '');
  assert.equal(kept(w.theirs, '2026-11-05'), '');
  assert.ok(reads <= 3);
});

test('tb updates and the bring-in thread name the verified commit to merge', async () => {
  const { formatUpstream } = await import('../../src/tb-dev.ts');
  const commitId = 'a'.repeat(40);
  const text = formatUpstream({ state: 'available', release: { tag: 'release/2026-10-30', commit: commitId, changes: 1, subjects: ['One'] } }, Date.now());
  assert.match(text, new RegExp(`git merge[^\\n]*${commitId}`));
});

async function waitFor(ok: () => boolean, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('tb updates: what to bring in, or that there is nothing', async () => {
  const { formatUpstream } = await import('../../src/tb-dev.ts');
  const now = Date.parse('2026-10-30T10:00:00Z');
  const checkedAt = '2026-10-30T09:00:00Z';
  const text = formatUpstream({ state: 'available', checkedAt, release: { tag: 'release/2026-10-30', commit: 'abc', changes: 3, subjects: ['Third', 'Second'] } }, now);
  assert.match(text, /^Mike's releases: release\/2026-10-30 has 3 changes this copy's main doesn't, checked 1h/);
  assert.match(text, /\n {2}Third\n {2}Second\n {2}… and 1 more\n/);
  assert.match(text, /bringing-in-updates\.md/);
  assert.match(formatUpstream({ state: 'idle', checkedAt, release: { tag: 'release/2026-10-30', commit: 'abc', changes: 0, subjects: [] } }, now), /^Mike's releases: up to date with release\/2026-10-30, checked/);
  assert.equal(formatUpstream({ state: 'off', reason: 'upstream is this repo', published: { tag: 'release/2026-10-30', at: checkedAt } }, now), "Mike's releases: off (upstream is this repo)\nLast release tagged here: release/2026-10-30");
});

// ------------------------------------------- Daybreak, 7 Nov 2026: bounds
// Upstream's tags are listed first, only a bounded few date-named ones are
// fetched, into a folder of their own outside the checkout, every git
// command has a deadline, and what doesn't verify leaves nothing behind.

// Objects in the checkout, loose and packed.
function objectsIn(repo: string): Set<string> {
  const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { encoding: 'utf8' });
  return new Set(r.stdout.trim().split('\n').filter(Boolean));
}

test('upstream with thousands of tags: only a bounded few are fetched, and none that fail to verify stay', async () => {
  const w = world();
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.tag, 'release/2026-10-01');
  const base = git(w.mike, 'rev-parse', 'HEAD');
  const tree = git(w.mike, 'rev-parse', `${base}^{tree}`);
  // Fakes with commits of their own, so any that came over would show.
  const fakes: string[] = [];
  const fake = (msg: string) => {
    const c = spawnSync('git', ['-C', w.mike, 'commit-tree', tree, '-p', base, '-m', msg], { encoding: 'utf8', env: GIT_ENV }).stdout.trim();
    fakes.push(c);
    return c;
  };
  const lines: string[] = [];
  // Thousands of names, most not dates, and dates years ahead.
  for (let i = 0; i < 3000; i++) lines.push(`create refs/tags/release/junk-${i} ${base}`);
  for (let d = Date.parse('2027-01-10'); d < Date.parse('2030-01-01'); d += 86_400_000) lines.push(`create refs/tags/release/${new Date(d).toISOString().slice(0, 10)} ${base}`);
  // Every date after the last release that isn't the real one: a name
  // straight at a commit of its own (never fetched)...
  for (let d = Date.parse('2026-10-02'); d <= Date.parse('2026-12-06'); d += 86_400_000) {
    const name = new Date(d).toISOString().slice(0, 10);
    if (name !== '2026-11-06') lines.push(`create refs/tags/release/${name} ${fake(name)}`);
  }
  assert.equal(spawnSync('git', ['-C', w.mike, 'update-ref', '--stdin'], { input: lines.join('\n') + '\n' }).status, 0);
  // ...or an unsigned tag, newer than the real one, on a commit of its own.
  for (let i = 7; i <= 31; i++) git(w.mike, 'tag', '-a', '-m', 'unsigned', `release/2026-12-${String(i).padStart(2, '0')}`, fake(`tag ${i}`));
  const real = commit(w.mike, 'b.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const before = objectsIn(w.theirs);
  const up = upstreamFor(w.theirs, w.home);
  // 25 unsigned tags newer than it: 20 a check, then the real one.
  let s = await up.check();
  assert.equal(s.release?.tag, 'release/2026-10-01');
  s = await up.check();
  assert.equal(s.release?.commit, real, s.reason ?? '');
  const after = objectsIn(w.theirs);
  assert.deepEqual(fakes.filter((f) => after.has(f)), [], "no unsigned tag's or name's commit is in the checkout");
  // What came in is the release and its history: a commit, a tree, a blob and the tag.
  assert.ok(after.size - before.size <= 4, `${after.size - before.size} objects came in`);
  assert.equal(git(w.theirs, 'for-each-ref', 'refs/threadbear/upstream-incoming/'), '');
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'runner', 'upstream-fetch')), [], 'the staging folder is gone');
});

// A remote that never answers, standing in for one that's hijacked or down:
// git's upload-pack swapped for a script that hangs, with a child of its own.
function hangingUpstream(w: ReturnType<typeof world>, when: 'list' | 'fetch') {
  const script = path.join(w.root, 'hang.sh');
  const count = path.join(w.root, 'calls');
  fs.writeFileSync(script, `#!/bin/bash
n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo $n >"${count}"
if [ ${when === 'list' ? 1 : 2} -le $n ]; then sleep 600 & echo $! >>"${w.root}/pids"; echo $$ >>"${w.root}/pids"; wait; fi
exec git-upload-pack "$@"
`, { mode: 0o755 });
  git(w.theirs, 'config', 'remote.upstream.uploadpack', script);
  git(w.theirs, 'config', 'protocol.version', '2');
  return () => fs.readFileSync(path.join(w.root, 'pids'), 'utf8').trim().split('\n').map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const when of ['list', 'fetch'] as const) {
  test(`an upstream that hangs ${when === 'list' ? 'listing its tags' : 'sending them'} fails the check by its deadline, and leaves nothing running or behind`, async () => {
    const w = world();
    const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { fetchTimeoutMs: 1500 });
    assert.equal((await up.check()).release?.tag, 'release/2026-10-01');
    fs.rmSync(path.join(w.root, 'calls'), { force: true });
    commit(w.mike, 'b.txt', 'Newer');
    signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
    git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
    const pids = hangingUpstream(w, when);
    const before = objectsIn(w.theirs);
    const t0 = Date.now();
    const s = await up.check();
    assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
    assert.equal(s.state, 'failed');
    assert.match(s.reason ?? '', /timed out/);
    assert.equal(s.release?.tag, 'release/2026-10-01', 'keeps the release it knew of');
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of pids()) assert.ok(!alive(pid), `pid ${pid} still running`);
    assert.deepEqual([...objectsIn(w.theirs)].filter((o) => !before.has(o)), []);
    assert.deepEqual(fs.readdirSync(path.join(w.home, 'runner', 'upstream-fetch')), []);
  });
}

test('gitAsync stops a git command at its deadline, and what it started', async () => {
  const dir = tmpDir('tb-git-deadline-');
  const pidFile = path.join(dir, 'pid');
  const t0 = Date.now();
  await assert.rejects(gitAsync(dir, ['-c', `alias.hang=!sleep 600 & echo $! >${pidFile}; wait`, 'hang'], { timeoutMs: 500 }), /timed out/);
  assert.ok(Date.now() - t0 < 5000);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'the sleep it started is gone');
  assert.equal(await gitAsync(dir, ['--version']).then((v) => v.startsWith('git version')), true);
});

// Codex's review of the bounds.
test("fetch.prune and fetch.pruneTags in the fork's config change none of its refs", async () => {
  const w = world();
  git(w.theirs, 'tag', 'mine');
  git(w.theirs, 'config', 'fetch.prune', 'true');
  git(w.theirs, 'config', 'fetch.pruneTags', 'true');
  git(w.theirs, 'config', 'remote.upstream.prune', 'true');
  const real = commit(w.mike, 'b.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-11-07');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const refsBefore = git(w.theirs, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags', 'refs/heads', 'refs/remotes');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.release?.commit, real, s.reason ?? '');
  assert.equal(git(w.theirs, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags', 'refs/heads', 'refs/remotes'), refsBefore);
  assert.equal(git(w.theirs, 'fsck', '--connectivity-only', '--no-dangling'), '');
});

test('two checks at once, as when a runner hands over to the next, each stage on their own', async () => {
  const w = world();
  const real = commit(w.mike, 'b.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const [a, b] = await Promise.all([upstreamFor(w.theirs, w.home).check(), upstreamFor(w.theirs, w.home).check()]);
  assert.equal(a.release?.commit, real, a.reason ?? '');
  assert.equal(b.release?.commit, real, b.reason ?? '');
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'runner', 'upstream-fetch')), []);
});

test('a fetch bigger than the limit is stopped, and brings nothing into the checkout', async () => {
  const w = world();
  assert.equal((await upstreamFor(w.theirs, w.home).check()).release?.tag, 'release/2026-10-01');
  git(w.mike, 'checkout', '-q', '-b', 'big');
  fs.writeFileSync(path.join(w.mike, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024));
  git(w.mike, 'add', 'big.bin');
  git(w.mike, 'commit', '-q', '-m', 'big');
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-11-07');
  git(w.mike, 'push', '-q', 'origin', 'refs/tags/release/2026-11-07');
  const before = objectsIn(w.theirs);
  const s = await upstreamFor(w.theirs, w.home, new FakeClock(LATER), { stageMaxBytes: 1024 * 1024 }).check();
  assert.equal(s.state, 'failed');
  assert.match(s.reason ?? '', /more than 1 MB/);
  assert.equal(s.release, undefined);
  assert.deepEqual([...objectsIn(w.theirs)].filter((o) => !before.has(o)), []);
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'runner', 'upstream-fetch')), []);
});

test("tags too big to read are remembered, so they can't hold a real release out", async () => {
  const w = world();
  const big = path.join(w.root, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 10));
  for (let i = 7; i <= 27; i++) git(w.mike, 'tag', '-a', '-F', big, `release/2026-12-${String(i).padStart(2, '0')}`);
  const real = commit(w.mike, 'b.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  let s = await up.check();
  for (let i = 0; i < 2 && s.release?.commit !== real; i++) s = await up.check();
  assert.equal(s.release?.commit, real, s.reason ?? '');
});

test('a server that lists commits as tags (forged peeled lines) still lets a real release through', async () => {
  const w = world();
  const base = git(w.mike, 'rev-parse', 'HEAD');
  const lines: string[] = [];
  for (let i = 7; i <= 31; i++) lines.push(`create refs/tags/release/2026-12-${String(i).padStart(2, '0')} ${base}`);
  assert.equal(spawnSync('git', ['-C', w.mike, 'update-ref', '--stdin'], { input: lines.join('\n') + '\n' }).status, 0);
  const real = commit(w.mike, 'b.txt', 'Real');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  // ls-remote as such a server would answer: a peeled line for every name.
  const forge = async (cwd: string, args: string[], opts?: Parameters<typeof gitAsync>[2]) => {
    const out = await gitAsync(cwd, args, opts);
    if (args[0] !== 'ls-remote') return out;
    return out.split('\n').flatMap((l) => (l.endsWith('^{}') || !l ? [l] : [l, `${l.split('\t')[0]}\t${l.split('\t')[1]}^{}`])).join('\n');
  };
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { git: forge });
  let s = await up.check();
  for (let i = 0; i < 2 && s.release?.commit !== real; i++) s = await up.check();
  assert.equal(s.release?.commit, real, s.reason ?? '');
});

test("gitAsync's watcher stops a command it says is over its limit, and what it started", async () => {
  const dir = tmpDir('tb-git-watch-');
  const pidFile = path.join(dir, 'pid');
  let asked = 0;
  await assert.rejects(
    gitAsync(dir, ['-c', `alias.hang=!sleep 600 & echo $! >${pidFile}; wait`, 'hang'], { timeoutMs: 60_000, over: () => (++asked >= 2 ? 'fetched more than 1 MB' : undefined) }),
    /fetched more than 1 MB/,
  );
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))));
});
