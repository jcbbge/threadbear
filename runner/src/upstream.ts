// Mike's releases, for everyone's own copy of Threadbear
// (docs/setup-and-updates.md section 2.3).
//
// Everyone else's copy is a fork: `origin` is theirs and `upstream` is
// mikecann/threadbear. Their runner fetches upstream's release tags every
// six hours and says when there's a newer one than their main has, for the
// Updates panel's "new changes from Mike" and `tb updates`. Bringing it in
// is a thread they start (docs/bringing-in-updates.md); nothing here ever
// changes their main.
//
// Only tags signed with the key setup pinned (<home>/upstream-signers,
// copied from scripts/release-signers at setup) count. The pinned copy is
// the one that matters: a key changed in the repo, or a hijacked GitHub
// account, can't get code onto anyone's Mac this way. So the check is an
// SSH signature by that key and nothing else: the runner splits the tag
// itself and asks ssh-keygen, never `git verify-tag`, which hands a PGP or
// X.509 signature to gpg and the whole keyring whatever gpg.format says
// (Gautam's scan, 6 Nov 2026, F5).
//
// Tags are fetched into a folder of their own, outside the checkout, a
// few at a time and with a deadline (stageReleases), and only one that
// verifies is copied in, to refs/threadbear/upstream/; a release there is
// never moved to another object, so a tag swapped upstream after it was
// checked can't change what a bring-in thread merges (F31). Those threads
// are told the verified commit id, and merge that.
//
// Mike's own runner (runner.json `releases.publish`) makes the tags: once
// a day, if main has moved since the last one, it tags main's tip as
// release/YYYY-MM-DD, signed, and pushes the tag. Only a main it's safe to
// hand on: the runner it's running is main's, has been marked good and up
// for an hour, and main's tip is an hour old, so a commit that crashes
// the runner or is about to be followed by its fix isn't what goes out.
// And GitHub's checks have passed on that exact commit (ciVerdict): the
// runner staying up says nothing about the apps building. release/2026-11-04
// to -06 went out not building on Xcode 26.6, and people installing it
// found out before Mike did (PR #1, Maroš's fork).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';

export const FETCH_INTERVAL_MS = 6 * 60 * 60_000;
export const PUBLISH_INTERVAL_MS = 60 * 60_000;
// The first look, a while after the runner starts: never in the way of a
// start that's about to be rolled back.
export const FIRST_LOOK_MS = 2 * 60_000;
// How long main's tip and the running release must have settled before
// Mike's runner tags it.
export const SETTLE_MS = 60 * 60_000;
export const TAG_PREFIX = 'release/';
// A runner from before 7 Nov fetched every tag here, unchecked; anything
// left is deleted (checkNow). Now they're staged outside the checkout, in
// STAGED_NS of a folder of their own (stageReleases).
const INCOMING_NS = 'refs/threadbear/upstream-incoming/';
const STAGED_NS = 'refs/incoming/';
// The releases that verified, copied from INCOMING_NS and never moved once
// there. Their own namespaces, so the fork's own tags are never touched.
const REF_NS = 'refs/threadbear/upstream/';
const MAX_SUBJECTS = 50;
// What a release's name is after release/: the local date it was tagged
// (tagFor). Nothing else is ever looked at.
const RELEASE_NAME = /^\d{4}-\d{2}-\d{2}$/;
// How far past today's date (UTC) a release's date can be: Mike's day can
// start well before the fork's.
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60_000;
const MAX_ANSWERS = 10_000;
// The most tags one check reads that it hasn't read before.
const MAX_READS = 20;
// The most releases older than the newest kept that a check fetches, for
// their notes (notesSince reads nine).
const MAX_OLDER = 9;

// A release tag's message lists at most 200 subjects (publishOnce), a few
// tens of KB; a bigger tag object is turned down unread.
const MAX_TAG_BYTES = 1024 * 1024;

type Ref = { oid: string; type: string; size: number };

function readable(ref: Ref): boolean {
  return ref.type === 'tag' && ref.size > 0 && ref.size <= MAX_TAG_BYTES;
}

export type UpstreamRelease = {
  tag: string; // release/2026-10-30
  commit: string;
  date?: string; // the tag's date, ISO
  changes: number; // commits in it that main doesn't have, merges left out
  subjects: string[]; // their subject lines, newest first, at most 50
  // Commits in it Mike marked with an `Important:` trailer (a security or
  // data fix), saying why. They're covered by the tag's signature, as the
  // signed tag names the commit and so its whole history. bring-in.ts
  // starts a thread for these straight away rather than on its timer.
  important?: { commit: string; why: string }[];
  // Plain-words notes for people, from each release main doesn't have yet,
  // newest first. Each verified tag's commit subjects fill in when its
  // message has no plain-words notes.
  notes?: { tag: string; lines: string[] }[];
};

// runner.status's `upstream`, and RunnerUpdates' (docs/protocol.md).
export type UpstreamStatus = {
  // off: no upstream remote, upstream is this repo, or no pinned key;
  // idle: main has the newest release; available: it doesn't.
  state: 'off' | 'idle' | 'checking' | 'available' | 'failed';
  reason?: string;
  checkout?: string;
  checkedAt?: string;
  // The newest signed release, whether or not main has it.
  release?: UpstreamRelease;
  // Mike's runner: the last release tag it made, and when it next looks.
  published?: { tag: string; at: string };
  // Mike's runner: why main's tip isn't today's release yet, when it's
  // only GitHub's checks in the way (ciVerdict). Gone once it's tagged.
  held?: { commit: string; why: string; at: string };
};

// One GitHub Actions run of a workflow on a commit, as ciVerdict needs it.
export type CiRun = { workflow: string; name: string; status: string; conclusion: string | null; attempt: number };

export type PublishConfig = { publish: boolean; signingKey?: string };

export type UpstreamDeps = {
  home: string;
  // The repo this runner's release follows (release.json's checkout).
  checkout?: string;
  clock: Clock;
  log: Logger;
  publish?: PublishConfig;
  // Whether main's tip is what this runner runs, and it has been marked
  // good and up for SETTLE_MS (main.ts). Only asked when publishing.
  runningMainSettled?: () => boolean;
  onChange?: () => void;
  // After every check that got as far as the releases, with what it found
  // (bring-in.ts decides from it whether to start a thread).
  onChecked?: (status: UpstreamStatus) => void;
  // Mike's runner: writes plain-words notes for a release from its
  // commits, for the tag message (main.ts asks Opus through the Claude pool), as "- "
  // lines. Nothing, or a failure, leaves them out; the release goes out anyway.
  writeNotes?: (commits: string) => Promise<string | undefined>;
  // Replaced in tests.
  git?: (cwd: string, args: string[], opts?: GitOptions) => Promise<string>;
  gitBytes?: (cwd: string, args: string[]) => Promise<Buffer>;
  // How long fetching from upstream may take (FETCH_TIMEOUT_MS), and how
  // much it may bring (STAGE_MAX_BYTES). Tests.
  fetchTimeoutMs?: number;
  stageMaxBytes?: number;
  // The Actions runs on a commit, from GitHub (githubRuns). Replaced in tests.
  ciRuns?: (repo: string, commit: string) => Promise<CiRun[]>;
};

// The push runs on one commit of a public GitHub repo ("owner/name"). No
// token: the repo's public, and an hourly look is far inside the 60 an
// hour GitHub allows without one.
export async function githubRuns(repo: string, commit: string): Promise<CiRun[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${commit}&event=push&per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'threadbear-runner' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { workflow_runs?: { workflow_id: number; name: string; status: string; conclusion: string | null; run_attempt?: number }[] };
  return (body.workflow_runs ?? []).map((r) => ({ workflow: String(r.workflow_id), name: r.name, status: r.status, conclusion: r.conclusion, attempt: r.run_attempt ?? 1 }));
}

// Whether a commit's checks let it be a release: undefined when they do,
// or why not. Each workflow counts by its latest attempt, so a red run
// that's been re-run green passes. None at all holds it too: GitHub hasn't
// started them yet, or the commit isn't on GitHub.
export function ciVerdict(runs: CiRun[]): string | undefined {
  const latest = new Map<string, CiRun>();
  for (const r of runs) {
    const had = latest.get(r.workflow);
    if (!had || r.attempt > had.attempt) latest.set(r.workflow, r);
  }
  if (!latest.size) return "GitHub hasn't run its checks yet";
  const runsOf = [...latest.values()];
  const failed = runsOf.filter((r) => r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion ?? ''));
  if (failed.length) return `${failed.map((r) => `"${r.name}"`).join(', ')} didn't pass on it`;
  if (runsOf.some((r) => r.status !== 'completed')) return "GitHub's checks are still running on it";
  return undefined;
}

export function signersPath(home: string): string {
  return path.join(home, 'upstream-signers');
}

// How long one git command may take before it's stopped: a fetch from a
// remote that answers slowly or never (Daybreak, 7 Nov 2026) held the
// release check, and every check after it, for good.
export const GIT_TIMEOUT_MS = 2 * 60_000;
export const FETCH_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_OUTPUT = 16 * 1024 * 1024;
// The most a release check may fetch before anything is verified: a few
// days' releases are a few MB, and a fork's checkout already has the rest.
export const STAGE_MAX_BYTES = 512 * 1024 * 1024;

// The bytes in a folder's files, everything below it.
function folderBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          total += fs.lstatSync(p).size;
        } catch {
          // gone in between
        }
    }
  };
  walk(dir);
  return total;
}

// input: what it reads on stdin. over: asked every half second while it
// runs; true stops it (stageReleases' size limit).
export type GitOptions = { timeoutMs?: number; env?: Record<string, string>; input?: string; over?: () => string | undefined };

export function gitAsync(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return runGit(cwd, args, opts).then((out) => out.toString('utf8').trim());
}

// git in its own process group, so a deadline stops what it started too
// (git-remote-https, ssh, upload-pack), with a cap on what it may print.
// GIT_TERMINAL_PROMPT=0: a fetch that wants a password fails rather than
// hanging the runner on a prompt nobody sees.
function runGit(cwd: string, args: string[], opts: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let why = '';
    const stop = (reason: string) => {
      if (why) return;
      why = reason;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const watch = opts.over
      ? setInterval(() => {
          const why = opts.over!();
          if (why) stop(why);
        }, 500)
      : undefined;
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
    child.stdout!.on('data', (d: Buffer) => {
      size += d.length;
      if (size > GIT_MAX_OUTPUT) stop('printed more than 16 MB');
      else out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (err.length < 8192) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      reject(new Error(`git ${args.join(' ')} failed: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      // The reason first: a check's status keeps only the start of it.
      if (why) reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} ${why} (git ${args.join(' ')})`));
      else if (code !== 0) reject(new Error(`git ${args.join(' ')} failed: ${err.trim() || `exit ${code ?? signal}`}`));
      else resolve(Buffer.concat(out));
    });
  });
}

// github.com/mikecann/threadbear, however the URL is written (https, ssh,
// with or without .git), so origin and upstream can be compared.
export function repoKey(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

// `git log --format=%H%x1f<Important trailers>` as the commits that have one.
export function parseImportant(out: string): { commit: string; why: string }[] {
  return out
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter(([commit, why]) => commit && why?.trim())
    .map(([commit, why]) => ({ commit: commit.trim(), why: why.trim().slice(0, 200) }));
}

// A tag message's "What's new:" bullets. Release messages look like:
//
//   Threadbear 2026-11-06
//
//   Important: keeps API keys out of Convex      (only when there's one)
//
//   What's new:                                   (when notes were written)
//   - Searching projects finds goals and state again
//
//   Every change:
//   - Website: project search reaches goals and state again
export const NOTES_HEADING = "What's new:";
export const CHANGES_HEADING = 'Every change:';
const MAX_NOTE_LINES = 12;

export function parseNotes(message: string): string[] {
  const lines = message.split('\n');
  const at = lines.findIndex((l) => l.trim() === NOTES_HEADING);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('- ')) break;
    const text = l.slice(2).trim();
    if (text) out.push(text.slice(0, 200));
  }
  return out.slice(0, MAX_NOTE_LINES);
}

// For Opus writing a release's notes (main.ts writeNotes). The
// readers use Threadbear on their own Mac and never see its code.
export const RELEASE_NOTES_SYSTEM = `You write the release notes for Threadbear, a Mac app for running AI coding agents in threads, with an iPhone app and a website. The reader uses Threadbear on their own Mac and wants to know what they'll notice in this release. You get its commit messages.

Write 2 to 8 lines, the most noticeable first, each starting "- ". Plain words, as if telling a friend: what they can now do or what works better. Under 15 words each. Fold several commits about one thing into one line. Leave out work they'd never notice (tests, docs, refactors, review rounds, internal speedups) unless it changes something they see. No file, function or code names, no jargon, no em dashes, no marketing words. Reply with only the lines. If nothing in it would be noticed, reply NONE.`;

// What the model wrote, as bullets: "- " lines only, nothing if it said NONE.
export function cleanNotes(text: string | undefined): string[] {
  if (!text || /^\s*NONE\s*$/i.test(text)) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*•] /.test(l))
    .map((l) => l.replace(/^[-*•] /, '').replace(/\s*—\s*/g, ', ').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_NOTE_LINES);
}

// release/2026-10-30 for a local date.
export function tagFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${TAG_PREFIX}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Upstream {
  private st: UpstreamStatus = { state: 'off' };
  private timer: TimerHandle | undefined;
  private publishTimer: TimerHandle | undefined;
  private running: Promise<UpstreamStatus> | undefined;
  private stopped = false;
  // verified()'s answers, by signers file, object and name.
  private readonly answers = new Map<string, SignedTag | null>();
  // Reused if signing or pushing the same release needs another try.
  private noteDraft?: { key: string; lines: string[] };
  private readonly git: (cwd: string, args: string[], opts?: GitOptions) => Promise<string>;
  private readonly deps: UpstreamDeps;

  private get fetchTimeoutMs(): number {
    return this.deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  private get stageMaxBytes(): number {
    return this.deps.stageMaxBytes ?? STAGE_MAX_BYTES;
  }

  constructor(deps: UpstreamDeps) {
    this.deps = deps;
    this.git = deps.git ?? gitAsync;
    if (deps.checkout) this.st.checkout = deps.checkout;
  }

  status(): UpstreamStatus {
    return { ...this.st };
  }

  start(): void {
    if (!this.deps.checkout) {
      this.set({ state: 'off', reason: 'this runner runs from source, not a release' });
      return;
    }
    this.stopped = false;
    this.timer ??= this.deps.clock.setTimeout(() => this.tick(), FIRST_LOOK_MS);
    if (this.deps.publish?.publish) this.publishTimer ??= this.deps.clock.setTimeout(() => this.publishTick(), FIRST_LOOK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.publishTimer?.cancel();
    this.timer = this.publishTimer = undefined;
  }

  private tick(): void {
    this.timer = undefined;
    void this.check().finally(() => {
      if (!this.stopped) this.timer = this.deps.clock.setTimeout(() => this.tick(), FETCH_INTERVAL_MS);
    });
  }

  private publishTick(): void {
    this.publishTimer = undefined;
    void this.publishOnce()
      .catch((e) => this.deps.log.warn('could not tag a release', { error: String(e) }))
      .finally(() => {
        if (!this.stopped) this.publishTimer = this.deps.clock.setTimeout(() => this.publishTick(), PUBLISH_INTERVAL_MS);
      });
  }

  // Fetches upstream's release tags and works out what main is missing.
  // `tb updates check` and the timer share one check at a time.
  check(): Promise<UpstreamStatus> {
    this.running ??= this.checkNow().finally(() => (this.running = undefined));
    return this.running;
  }

  private async checkNow(): Promise<UpstreamStatus> {
    const checkout = this.deps.checkout;
    if (!checkout) return this.status();
    const urls = await this.remotes(checkout);
    if (!urls.upstream) return this.set({ state: 'off', reason: "this copy has no upstream remote (Mike's repo), so it has no releases to follow" });
    if (urls.origin && repoKey(urls.origin) === repoKey(urls.upstream)) return this.set({ state: 'off', reason: 'upstream is this repo' });
    const signers = signersPath(this.deps.home);
    if (!fs.existsSync(signers)) return this.set({ state: 'off', reason: `no release key pinned at ${signers}; run ./threadbear setup again` });
    this.set({ state: 'checking' });
    const checkedAt = new Date(this.deps.clock.now()).toISOString();
    try {
      // Before the fetch, so an upstream that's gone (or made to fail)
      // can't keep an unverified ref there.
      await this.sweep(checkout, signers);
      // What a runner from before this kept unverified here goes: upstream's
      // tags are only ever staged outside the checkout now (stageReleases).
      for (const [name, ref] of await this.refs(checkout, INCOMING_NS)) await this.git(checkout, ['update-ref', '-d', INCOMING_NS + name, ref.oid]).catch(() => undefined);
      // A folder of this check's own, so two Upstreams (a runner handing
      // over to the next) never share one (Codex's review). One a runner
      // that was killed left behind goes after an hour.
      const parent = path.join(this.deps.home, 'runner', 'upstream-fetch');
      fs.mkdirSync(parent, { recursive: true });
      for (const old of fs.readdirSync(parent)) {
        const p = path.join(parent, old);
        try {
          // The real clock: it's compared with a file's time.
          if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60_000) fs.rmSync(p, { recursive: true, force: true });
        } catch {
          // gone already
        }
      }
      const work = fs.mkdtempSync(path.join(parent, 'check-'));
      let release: UpstreamRelease | undefined;
      try {
        const staged = await this.stageReleases(checkout, signers, path.join(work, 'git'));
        await this.promote(checkout, signers, staged);
        release = await this.newestSigned(checkout, signers, staged);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
      if (!release) return this.set({ state: 'idle', checkedAt, reason: 'no signed releases yet' });
      const state = release.changes > 0 ? 'available' : 'idle';
      if (state === 'available' && this.st.release?.tag !== release.tag) this.deps.log.info('a newer release from upstream', { tag: release.tag, changes: release.changes });
      const status = this.set({ state, checkedAt, release });
      try {
        this.deps.onChecked?.(status);
      } catch (e) {
        this.deps.log.warn('could not act on the release check', { error: String(e) });
      }
      return status;
    } catch (e) {
      this.deps.log.warn('could not check upstream for releases', { error: String(e) });
      return this.set({ state: 'failed', checkedAt, reason: String((e as Error).message ?? e).slice(0, 300) });
    }
  }

  private async remotes(checkout: string): Promise<{ origin?: string; upstream?: string }> {
    const get = (name: string) => this.git(checkout, ['remote', 'get-url', name]).catch(() => undefined);
    const [origin, upstream] = await Promise.all([get('origin'), get('upstream')]);
    return { origin, upstream };
  }

  // Fetches a bounded few of upstream's release tags into a folder of their
  // own, where the check reads and verifies them; the checkout gets only a
  // release that verified (promote). It fetched every release/* tag
  // upstream had, with all their history, straight into the checkout and
  // with no deadline, so a hijacked upstream could hold the check or fill
  // the disk before a signature was looked at (Daybreak, 7 Nov 2026).
  //
  // 1. ls-remote lists upstream's release/* tags: names and object ids,
  //    nothing fetched (a deadline and an output cap, as every git here).
  // 2. The candidates, by promote's rules (f7ec0661): date names no later
  //    than a couple of days from now, newest first, at most MAX_READS from
  //    the newest release kept here on, and the newest few older than it,
  //    which only the notes read (notesSince). A tag already found unsigned
  //    is passed over, so a flood of them can't keep a real one out for long.
  // 3. Those are fetched with their objects going to the folder (git's own
  //    quarantine, GIT_OBJECT_DIRECTORY), not the checkout's, and no ref of
  //    the checkout's changes. The folder is a bare repo whose objects fall
  //    back on the checkout's, so only what's new comes over the network,
  //    and each candidate is a ref there, refs/incoming/<date>.
  // checkNow deletes the folder when the check ends, whatever happened, so
  // what didn't verify, and a fetch cut short, leaves nothing behind.
  private async stageReleases(checkout: string, signers: string, work: string): Promise<string | undefined> {
    const listed = await this.git(checkout, ['ls-remote', 'upstream', `refs/tags/${TAG_PREFIX}*`], { timeoutMs: this.fetchTimeoutMs });
    // A tag object is listed twice, the second time peeled (name^{}): a
    // name without that points straight at a commit, which is never a
    // signed release, so it's left out unfetched (promote's rule).
    const listedOids = new Map<string, string>();
    const peeled = new Set<string>();
    for (const line of listed.split('\n')) {
      const [oid, ref] = line.split('\t');
      if (!oid || !OBJECT_ID.test(oid) || !ref?.startsWith(`refs/tags/${TAG_PREFIX}`)) continue;
      const name = ref.slice(`refs/tags/${TAG_PREFIX}`.length);
      if (name.endsWith('^{}')) peeled.add(name.slice(0, -3));
      else if (RELEASE_NAME.test(name)) listedOids.set(name, oid);
    }
    const offered = new Map([...listedOids].filter(([name]) => peeled.has(name)));
    const kept = await this.refs(checkout, REF_NS);
    const newest = [...kept.keys()].filter((n) => RELEASE_NAME.test(n)).sort().at(-1) ?? '';
    const latest = new Date(this.deps.clock.now() + FUTURE_SLACK_MS).toISOString().slice(0, 10);
    const pinned = this.signersHash(signers);
    const unsigned = (name: string) => this.answers.get(`${pinned} ${offered.get(name)} ${TAG_PREFIX}${name}`) === null;
    const names = [...offered.keys()].filter((n) => n <= latest && !unsigned(n)).sort().reverse();
    const candidates = [...names.filter((n) => n >= newest).slice(0, MAX_READS), ...names.filter((n) => n < newest).slice(0, MAX_OLDER)];
    if (!candidates.length) return undefined;

    const objects = path.resolve(checkout, await this.git(checkout, ['rev-parse', '--git-path', 'objects']));
    const format = await this.git(checkout, ['rev-parse', '--show-object-format']).catch(() => 'sha1');
    await this.git(path.dirname(work), ['init', '-q', '--bare', `--object-format=${format}`, work]);
    fs.writeFileSync(path.join(work, 'objects', 'info', 'alternates'), `${objects}\n`);
    await this.git(
      checkout,
      // One pack, never loose objects (unpackLimit), so its size is what's
      // in objects/pack, watched as it comes: over the limit, it's stopped.
      // No pruning: fetch.prune or fetch.pruneTags in someone's config
      // would add refs/tags/*:refs/tags/* and change the checkout's tags
      // (Codex's review).
      ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false', '-c', 'fetch.unpackLimit=1', '-c', 'transfer.unpackLimit=1',
        'fetch', '-q', '--no-tags', '--no-prune', '--no-prune-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', 'upstream',
        ...candidates.map((n) => `refs/tags/${TAG_PREFIX}${n}`)],
      {
        timeoutMs: this.fetchTimeoutMs,
        env: { GIT_OBJECT_DIRECTORY: path.join(work, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects },
        over: () => (folderBytes(path.join(work, 'objects')) > this.stageMaxBytes ? `fetched more than ${Math.round(this.stageMaxBytes / 1024 / 1024)} MB` : undefined),
      },
    );
    if (folderBytes(path.join(work, 'objects')) > this.stageMaxBytes) throw new Error(`git fetch from upstream fetched more than ${Math.round(this.stageMaxBytes / 1024 / 1024)} MB`);
    // The ids ls-remote named, where they came (a tag moved in between
    // isn't there, and waits for the next check).
    const updates: string[] = [];
    for (const name of candidates) {
      const oid = offered.get(name)!;
      if (await this.git(work, ['cat-file', '-e', oid]).then(() => true, () => false)) updates.push(`create ${STAGED_NS}${name} ${oid}`);
    }
    if (updates.length) await this.git(work, ['update-ref', '--stdin'], { input: updates.join('\n') + '\n' });
    return work;
  }

  // Copies a staged release's objects into the checkout (no ref changes).
  private async bringIn(checkout: string, work: string, name: string): Promise<void> {
    await this.git(checkout, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '-q', '--no-tags', '--no-prune', '--no-prune-tags', '--no-write-fetch-head', '--refmap=', work, `${STAGED_NS}${name}`]);
  }



  // Takes out anything in REF_NS that doesn't verify: a runner from before
  // this check fetched straight into it, unverified, and so can a
  // rolled-back one. Whatever the name, so nothing is in the way of a
  // release's (refs/threadbear/upstream/2026-11-06/x blocks 2026-11-06).
  private async sweep(checkout: string, signers: string): Promise<void> {
    for (const [name, ref] of await this.refs(checkout, REF_NS)) {
      if (await this.verified(checkout, ref, TAG_PREFIX + name, signers)) continue;
      this.deps.log.warn('removed an upstream release ref that is not signed with the pinned key', { tag: TAG_PREFIX + name });
      await this.git(checkout, ['update-ref', '-d', REF_NS + name, ref.oid]).catch(() => undefined);
    }
  }

  // Copies the newest fetched tag that verifies into REF_NS. Upstream can
  // push any number of tags, so what it can make the runner read is
  // bounded: only names Mike's runner makes (a date, tagFor), no later
  // than a couple of days from now and no earlier than the newest release
  // kept; only tag objects (a tag pointing straight at a commit is turned
  // down without a read); newest first, stopping at the first that
  // verifies; and at most MAX_READS tags read per check. A name already
  // kept keeps its object: a different tag served later under it is a
  // re-tag nobody should merge, so it's said in the log and left out.
  // The tags are the ones stageReleases fetched to `staged`, read there;
  // only the one kept comes into the checkout.
  private async promote(checkout: string, signers: string, staged: string | undefined): Promise<void> {
    if (!staged) return;
    const kept = await this.refs(checkout, REF_NS);
    const newest = [...kept.keys()].filter((n) => RELEASE_NAME.test(n)).sort().at(-1) ?? '';
    const latest = new Date(this.deps.clock.now() + FUTURE_SLACK_MS).toISOString().slice(0, 10);
    const incoming = [...(await this.refs(staged, STAGED_NS))]
      // Not a tag object goes through verified() too, unread, so it's
      // remembered and stageReleases passes it over next time: a server
      // can list a commit as a tag (Codex's review).
      .filter(([name, ref]) => RELEASE_NAME.test(name) && name >= newest && name <= latest && kept.get(name)?.oid !== ref.oid)
      .sort(([a], [b]) => (a < b ? 1 : -1));
    let reads = 0;
    for (const [name, ref] of incoming) {
      const tag = TAG_PREFIX + name;
      if (!this.answered(ref, tag, signers) && ++reads > MAX_READS) {
        this.deps.log.warn('more upstream release tags than one check reads; the rest wait for the next', { from: tag });
        break;
      }
      if (!(await this.verified(staged, ref, tag, signers))) {
        this.deps.log.warn('skipped an upstream release tag that is not signed with the pinned key', { tag });
        continue;
      }
      const have = kept.get(name);
      if (have) {
        this.deps.log.warn('upstream serves a different tag under a release name already verified here; keeping the one verified first', { tag, kept: have.oid, offered: ref.oid });
        continue;
      }
      // Only if the name is still free (a ref that turned up in between
      // isn't overwritten). A clash with another ref's name fails this one
      // copy, not the whole check.
      const ok = await this.bringIn(checkout, staged, name)
        .then(() => this.git(checkout, ['update-ref', REF_NS + name, ref.oid, '']))
        .then(() => true)
        .catch((e) => (this.deps.log.warn('could not keep a verified release', { tag, error: String(e) }), false));
      // The newest is the one that counts; older ones needn't be read.
      if (ok) break;
    }
  }

  // name (after the namespace) -> the object the ref points at, and its type.
  private async refs(checkout: string, ns: string): Promise<Map<string, Ref>> {
    const out = await this.git(checkout, ['for-each-ref', '--format=%(objectname) %(objecttype) %(objectsize) %(refname)', ns]);
    const map = new Map<string, Ref>();
    for (const line of out.split('\n')) {
      const [oid, type, size, ...rest] = line.split(' ');
      const refname = rest.join(' ');
      if (oid && type && refname.startsWith(ns)) map.set(refname.slice(ns.length), { oid, type, size: Number(size) });
    }
    return map;
  }

  // The newest release in REF_NS that verifies against the pinned key and
  // names itself what it's kept as (so an old signed tag pushed under a
  // newer name can't pass for the newer release), with what main doesn't
  // have. Each is checked again here, by its object id, and the commit is
  // the one its signed text names.
  private async newestSigned(checkout: string, signers: string, staged: string | undefined): Promise<UpstreamRelease | undefined> {
    const refs = [...(await this.refs(checkout, REF_NS))].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
    for (const [name, ref] of refs) {
      const tag = TAG_PREFIX + name;
      const signed = await this.verified(checkout, ref, tag, signers);
      // Only a ref that turned up since promote took out the rest.
      if (!signed) continue;
      const { commit, date } = signed;
      const range = `refs/heads/main..${commit}`;
      const [count, log, trailers] = await Promise.all([
        this.git(checkout, ['rev-list', '--count', '--no-merges', range]),
        this.git(checkout, ['log', '--no-merges', `--max-count=${MAX_SUBJECTS}`, '--format=%s', range]),
        // One line per commit: its id, then any Important: trailer's text.
        this.git(checkout, ['log', '--no-merges', '--format=%H%x1f%(trailers:key=Important,valueonly,separator=%x20)', range]),
      ]);
      const important = parseImportant(trailers);
      const changes = Number(count) || 0;
      const notes = changes > 0 ? await this.notesSince(checkout, { ...signed, name }, signers, staged) : [];
      return { tag, commit, ...(date ? { date } : {}), changes, subjects: log.split('\n').filter(Boolean), ...(important.length ? { important } : {}), ...(notes.length ? { notes } : {}) };
    }
    return undefined;
  }

  // The notes of each signed release main doesn't have, newest first,
  // stopping at the first one main already has (at most 10). Only the
  // newest is kept in REF_NS (promote), so older ones are read from the
  // staged tags (stageReleases), each verified against the pinned key the
  // same way, and the text comes from the verified bytes, never from a ref
  // git could move. Their history is only in `staged` (whose objects fall
  // back on the checkout's), so that's where it's compared with main's.
  private async notesSince(checkout: string, newest: SignedTag & { name: string }, signers: string, staged: string | undefined): Promise<{ tag: string; lines: string[] }[]> {
    const main = await this.git(checkout, ['rev-parse', 'refs/heads/main']);
    const older = [...(staged ? await this.refs(staged, STAGED_NS) : [])]
      .filter(([name]) => RELEASE_NAME.test(name) && name < newest.name)
      .sort(([x], [y]) => (x < y ? 1 : -1))
      .slice(0, 9);
    const out: { tag: string; lines: string[] }[] = [];
    const add = (name: string, signed: SignedTag) => {
      const message = signed.payload.toString('utf8');
      const notes = parseNotes(message);
      // A failed model call, or a tag from before notes existed, still
      // describes that release instead of disappearing behind older notes.
      const lines = notes.length ? notes : message.split('\n').filter((l) => l.startsWith('- ')).slice(0, 5).map((l) => l.slice(2).trim().slice(0, 200)).filter(Boolean);
      if (lines.length) out.push({ tag: TAG_PREFIX + name, lines });
    };
    add(newest.name, newest);
    for (const [name, ref] of older) {
      const signed = await this.verified(staged!, ref, TAG_PREFIX + name, signers);
      if (!signed || !(await this.isAncestor(staged!, signed.commit, newest.commit))) continue;
      if (await this.isAncestor(staged!, signed.commit, main)) break;
      add(name, signed);
    }
    return out;
  }

  // The tag object `oid`, if it is signed by the pinned key as `tag`.
  // Throws when ssh-keygen can't be run at all, so the check fails and says
  // why rather than calling every release unsigned (and taking them out).
  // An object's bytes never change, so each answer is kept (for the
  // pinned file as it is now): a check reads only tags it hasn't seen.
  // Only answers are kept: git or ssh-keygen failing to run throws, so the
  // check fails and says why, and the tag is read again next time.
  private async verified(checkout: string, ref: Ref, tag: string, signers: string): Promise<SignedTag | undefined> {
    // Not a tag object (a commit or anything else), or one far bigger than
    // any Mike's runner makes, is just not signed: never read.
    const key = this.answerKey(ref, tag, signers);
    if (!readable(ref)) {
      // Remembered too, so stageReleases passes over it next time: twenty
      // oversized tags newer than a real release held every check's places
      // (Codex's review).
      if (ref.type && ref.size > 0) this.remember(key, null);
      return undefined;
    }
    if (this.answers.has(key)) return this.answers.get(key) ?? undefined;
    const raw = await (this.deps.gitBytes ?? gitBytes)(checkout, ['cat-file', 'tag', ref.oid]);
    const split = splitSignedTag(raw, tag);
    const signed = split && (await sshVerified(split, signers)) ? split : undefined;
    this.remember(key, signed ?? null);
    return signed;
  }

  private remember(key: string, answer: SignedTag | null): void {
    if (this.answers.size >= MAX_ANSWERS) this.answers.delete(this.answers.keys().next().value!);
    this.answers.set(key, answer);
  }

  private answered(ref: Ref, tag: string, signers: string): boolean {
    return !readable(ref) || this.answers.has(this.answerKey(ref, tag, signers));
  }

  private answerKey(ref: Ref, tag: string, signers: string): string {
    return `${this.signersHash(signers)} ${ref.oid} ${tag}`;
  }

  private signersHash(signers: string): string {
    return createHash('sha256').update(fs.readFileSync(signers)).digest('hex');
  }

  // Mike's runner: tags main's tip as today's release when it's moved since
  // the last one and has settled (above). Returns the tag it made.
  async publishOnce(): Promise<string | undefined> {
    const { checkout, publish } = this.deps;
    if (!checkout || !publish?.publish) return undefined;
    if (!publish.signingKey || !fs.existsSync(publish.signingKey)) {
      this.deps.log.warn('releases.publish is on but releases.signingKey is missing', { signingKey: publish.signingKey });
      return undefined;
    }
    if (!(this.deps.runningMainSettled?.() ?? false)) return undefined;
    const now = this.deps.clock.now();
    const tip = await this.git(checkout, ['rev-parse', 'refs/heads/main']);
    const committed = Number(await this.git(checkout, ['log', '-1', '--format=%ct', tip])) * 1000;
    if (now - committed < SETTLE_MS) return undefined;
    // Tags made on another Mac, or by hand, count too.
    await this.git(checkout, ['fetch', '-q', '--no-tags', 'origin', `+refs/tags/${TAG_PREFIX}*:refs/tags/${TAG_PREFIX}*`], { timeoutMs: this.fetchTimeoutMs });
    const tag = tagFor(new Date(now));
    const tags = (await this.git(checkout, ['tag', '--list', '--sort=-refname', `${TAG_PREFIX}*`])).split('\n').filter(Boolean);
    if (tags.includes(tag)) return this.hold(undefined);
    const last = tags[0];
    if (last && (await this.isAncestor(checkout, tip, last))) return this.hold(undefined);
    const why = await this.checksSay(checkout, tip);
    if (why) {
      this.hold({ commit: tip, why, at: new Date(now).toISOString() });
      return undefined;
    }
    this.hold(undefined);

    const range = last ? `${last}..${tip}` : tip;
    const subjects = (await this.git(checkout, ['log', '--no-merges', '--format=- %s', range, '--max-count=200'])).trim();
    // Important commits lead the message, so the release says so wherever
    // it's read (forks find them from the commits' trailers themselves).
    const important = parseImportant(await this.git(checkout, ['log', '--no-merges', '--format=%H%x1f%(trailers:key=Important,valueonly,separator=%x20)', last ? `${last}..${tip}` : tip, '--max-count=200']));
    const lead = important.length ? important.map((i) => `Important: ${i.why}`).join('\n') + '\n\n' : '';
    const notes = await this.notesFor(checkout, range);
    const whatsNew = notes.length ? `${NOTES_HEADING}\n${notes.map((n) => `- ${n}`).join('\n')}\n\n` : '';
    const message = `Threadbear ${tag.slice(TAG_PREFIX.length)}\n\n${lead}${whatsNew}${CHANGES_HEADING}\n${subjects}\n`;
    const file = path.join(this.deps.home, 'runner', 'release-tag-message.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, message);
    await this.git(checkout, ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${publish.signingKey}`, 'tag', '-s', '-F', file, tag, tip]);
    try {
      await this.git(checkout, ['push', '-q', 'origin', `refs/tags/${tag}`], { timeoutMs: this.fetchTimeoutMs });
    } catch (e) {
      // Taken back, so the next look tries the push again.
      await this.git(checkout, ['tag', '-d', tag]).catch(() => undefined);
      throw e;
    }
    this.deps.log.info('tagged a release', { tag, commit: tip });
    this.set({ ...this.st, published: { tag, at: new Date(now).toISOString() } });
    return tag;
  }

  // Plain-words notes for a release, from its commits' subjects and bodies.
  private async notesFor(checkout: string, range: string): Promise<string[]> {
    if (!this.deps.writeNotes) return [];
    // The full log keys a draft to the exact input, even if a tag moved.
    const log = await this.git(checkout, ['log', '--no-merges', '--format=%s%n%b%x1e', range, '--max-count=200']);
    const key = createHash('sha256').update(log).digest('hex');
    if (this.noteDraft?.key === key) return this.noteDraft.lines;
    let lines: string[] = [];
    try {
      // Each commit's body cut short, so a busy day's last commits still fit.
      const commits = log.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => (c.length > 600 ? `${c.slice(0, 600)}…` : c));
      lines = cleanNotes(await this.deps.writeNotes(commits.join('\n---\n').slice(0, 60_000)));
    } catch (e) {
      this.deps.log.warn('could not write release notes; tagging without them', { error: String(e) });
    }
    // Signing or pushing can fail. Retry those without paying for the same
    // notes again; a failed model call is cached as the subject fallback.
    this.noteDraft = { key, lines };
    return lines;
  }

  // GitHub only runs its checks on a main that's been pushed, and nothing
  // else pushes it: tb land never does, and on 7 Nov the first gated
  // release sat behind a main three commits ahead of GitHub's. So a main
  // that has settled here goes up first (fast-forward only), and its
  // checks are looked at on the next hourly look. Returns why it's held.
  private async pushMain(checkout: string, tip: string): Promise<string | undefined> {
    await this.git(checkout, ['fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeoutMs: this.fetchTimeoutMs });
    const theirs = await this.git(checkout, ['rev-parse', 'refs/remotes/origin/main']).catch(() => '');
    if (theirs === tip || (theirs && (await this.isAncestor(checkout, tip, theirs)))) return undefined;
    if (theirs && !(await this.isAncestor(checkout, theirs, tip))) return "main here and GitHub's main have gone different ways";
    await this.git(checkout, ['push', '-q', 'origin', `${tip}:refs/heads/main`], { timeoutMs: this.fetchTimeoutMs });
    this.deps.log.info('pushed main for its checks', { commit: tip });
    return 'just pushed main to GitHub, so its checks have only started';
  }

  // Why GitHub's checks hold this commit back, or undefined when they
  // don't. A main with no workflows has nothing to wait for. One that has
  // them waits for them, and is held when they can't be read: a release
  // that can wait a day is better than one that doesn't build.
  private async checksSay(checkout: string, tip: string): Promise<string | undefined> {
    const workflows = (await this.git(checkout, ['ls-tree', '--name-only', tip, '.github/workflows/'])).split('\n').filter((f) => /\.ya?ml$/.test(f));
    if (!workflows.length) return undefined;
    // The URL as configured, not as an insteadOf rewrites it for fetching.
    const key = repoKey(await this.git(checkout, ['config', '--get', 'remote.origin.url']).catch(() => ''));
    if (!key.startsWith('github.com/')) return "origin isn't on GitHub, so its checks can't be read";
    const pushed = await this.pushMain(checkout, tip);
    if (pushed) return pushed;
    try {
      return ciVerdict(await (this.deps.ciRuns ?? githubRuns)(key.slice('github.com/'.length), tip));
    } catch (e) {
      return `couldn't read GitHub's checks (${String(e)})`;
    }
  }

  // Says (or stops saying) why today's release is waiting, logging only a
  // change, as this runs every hour.
  private hold(held: UpstreamStatus['held']): undefined {
    const was = this.st.held;
    if (held && (was?.commit !== held.commit || was.why !== held.why)) this.deps.log.info('holding back a release', { commit: held.commit, why: held.why });
    if (!held && !was) return undefined;
    this.set({ ...this.st, held });
    return undefined;
  }

  private async isAncestor(checkout: string, a: string, b: string): Promise<boolean> {
    try {
      await this.git(checkout, ['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  private set(next: UpstreamStatus): UpstreamStatus {
    // published and held belong to publishOnce: a check's state leaves them
    // be (held goes only when publishOnce sets it, to undefined).
    const keep = {
      ...(this.deps.checkout ? { checkout: this.deps.checkout } : {}),
      ...(this.st.published && !next.published ? { published: this.st.published } : {}),
      ...(this.st.held && !('held' in next) ? { held: this.st.held } : {}),
    };
    // A failed or in-progress check keeps the last release it knew of.
    const release = next.release ?? (next.state === 'checking' || next.state === 'failed' ? this.st.release : undefined);
    const st: UpstreamStatus = { ...next, ...keep, ...(release ? { release } : {}) };
    const changed = JSON.stringify(st) !== JSON.stringify(this.st);
    this.st = st;
    if (changed) this.deps.onChange?.();
    return this.status();
  }
}

export type SignedTag = { payload: Buffer; signature: string; commit: string; date?: string };

// A tag object's raw bytes, as `git cat-file tag` gives them: exact, as the
// signature covers every byte.
export function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  return runGit(cwd, args, {});
}

const SSH_BEGIN = '-----BEGIN SSH SIGNATURE-----\n';
const SSH_BLOCK = /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]{1,76}\n){1,64}-----END SSH SIGNATURE-----\n$/;
const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// A release tag split into the text it signs and its signature, or
// undefined unless it is exactly what Mike's runner makes: the four tag
// headers in git's order (object, a commit, `tag` naming this release,
// tagger), a message, and one SSH signature at the end. Any other armor
// (PGP, X.509, a second block) fails, so there's nothing for git or gpg to
// pick a different verifier from. Armor counts where git looks for it, at
// the start of a line. publishOnce prefixes notes and commit subjects
// with "- ", so text mentioning armor cannot introduce a signature block.
export function splitSignedTag(raw: Buffer, tag: string): SignedTag | undefined {
  // latin1 keeps one char per byte, so offsets are byte offsets.
  const text = raw.toString('latin1');
  const lines = text.split('\n');
  if (lines.filter((l) => l.startsWith('-----BEGIN ')).length !== 1 || lines.filter((l) => l.startsWith('-----END ')).length !== 1) return undefined;
  const at = text.indexOf('\n' + SSH_BEGIN);
  if (at < 0) return undefined;
  const signature = text.slice(at + 1);
  if (!SSH_BLOCK.test(signature)) return undefined;
  const payload = text.slice(0, at + 1);
  const headEnd = payload.indexOf('\n\n');
  const head = (headEnd < 0 ? payload.slice(0, -1) : payload.slice(0, headEnd)).split('\n');
  if (head.length !== 4) return undefined;
  const [object, type, name, tagger] = head;
  const commit = object.startsWith('object ') ? object.slice('object '.length) : '';
  if (!OBJECT_ID.test(commit) || type !== 'type commit' || name !== `tag ${tag}` || !tagger.startsWith('tagger ')) return undefined;
  const when = / (\d{1,12}) [+-]\d{4}$/.exec(tagger);
  const date = when ? new Date(Number(when[1]) * 1000).toISOString() : undefined;
  return { payload: Buffer.from(payload, 'latin1'), signature, commit, ...(date ? { date } : {}) };
}

// Whether ssh-keygen finds the signature good for the `git` namespace, by a
// key in the pinned allowed-signers file (what `git verify-tag` does for an
// SSH signature, without git choosing the verifier).
async function sshVerified(signed: SignedTag, signers: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-release-sig-'));
  try {
    const sig = path.join(dir, 'tag.sig');
    fs.writeFileSync(sig, signed.signature, { mode: 0o600 });
    const found = await run('ssh-keygen', ['-Y', 'find-principals', '-f', signers, '-s', sig]);
    if (found.code !== 0) return false;
    for (const principal of found.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const v = await run('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', principal, '-n', 'git', '-s', sig], signed.payload);
      if (v.code === 0) return true;
    }
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Its exit code and output; rejects if it couldn't be started or was
// killed (not there, or hung), which is no answer about the signature.
function run(cmd: string, args: string[], input?: Buffer): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.on('error', (e) => reject(new Error(`${cmd} could not run: ${e.message}`)));
    child.on('close', (code, signal) => (code === null ? reject(new Error(`${cmd} was stopped (${signal})`)) : resolve({ code, stdout })));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}
