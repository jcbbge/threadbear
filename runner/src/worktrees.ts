// A worktree per thread (docs/thread-worktrees.md): a repo whose patch has
// `worktree` gives each new thread a git worktree and branch of its own,
// made from main, and `tb land` puts the branch on main once its check
// passes. This file is the git side: making one, landing one and cleaning
// one up. The runner (runner.ts) decides when, and says what happened in
// the thread; tb (cli.ts) runs land.
//
// Everything here runs real git. Nothing ever pushes.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { WorktreePatch } from './patches.ts';
import { inBackground } from './background.ts';

// What a thread's record keeps about its worktree.
export type WorktreeRecord = {
  repo: string; // the repo's name: the main checkout's folder name ("threadbear")
  mainCheckout: string; // the checkout with main checked out, where it lands
  path: string; // the worktree's root
  branch: string; // "thread/<id8>"
  base: string; // main's commit when it was made
  removedAt?: string; // cleaned up when the thread was archived
  // Archived, and the cleanup hasn't had its say yet: it waits for the CLI and
  // turn-end hooks, so a runner stopping or crashing can come first. The next
  // runner does it (settleLostCleanups).
  cleanupOwed?: boolean;
  // The patch's worktree.keep: the folder is set aside for another thread
  // when this one's done with it, rather than removed (see "spares").
  keep?: string[];
  // Set aside as a spare (with removedAt): the folder is still there, but
  // it's another thread's now, or will be.
  spare?: boolean;
};

export const MAIN = 'main';

export function threadBranch(threadId: string): string {
  return `thread/${threadId.slice(0, 8)}`;
}

type GitResult = { ok: boolean; code: number; stdout: string; stderr: string };

// git in `cwd`. Variables that point git at some other repo (set when this
// runs from inside a git hook) are dropped, so -C always wins.
export function git(cwd: string, args: string[]): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[k];
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function gitOut(cwd: string, args: string[]): Promise<string | undefined> {
  const r = await git(cwd, args);
  return r.ok ? r.stdout.trim() : undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.replace(/^(fatal|error): /, '').trim())
      .find(Boolean) ?? 'git failed'
  );
}

// The checkouts of a repo, from `git worktree list --porcelain`.
export type Checkout = { path: string; branch?: string; head?: string; locked?: string };

export async function listCheckouts(cwd: string): Promise<Checkout[] | undefined> {
  const out = await gitOut(cwd, ['worktree', 'list', '--porcelain']);
  if (out === undefined) return undefined;
  const list: Checkout[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const c: Checkout = { path: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) c.path = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) c.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line.startsWith('HEAD ')) c.head = line.slice('HEAD '.length);
      else if (line === 'locked' || line.startsWith('locked ')) c.locked = line.slice('locked '.length);
    }
    if (c.path) list.push(c);
  }
  return list;
}

export async function mainCheckoutOf(cwd: string): Promise<string | undefined> {
  return (await listCheckouts(cwd))?.find((c) => c.branch === MAIN)?.path;
}

export function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The same subfolder of `to` as `cwd` is of `from`, or `to` itself when
// that folder isn't there (it was untracked, or `cwd` was elsewhere).
export function sameSubfolder(cwd: string, from: string, to: string): string {
  const rel = path.relative(realpath(from), realpath(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return to;
  const there = path.join(to, rel);
  return isDir(there) ? there : to;
}

// --------------------------------------------------------------- making

// `patchFile`: the worktree's own copy of the patch that asked for it.
export type MadeWorktree = { ok: true; worktree: WorktreeRecord; cwd: string; patchFile: string } | { ok: false; reason: string };

// Makes the thread's worktree from main in the main checkout. A leftover
// branch of the thread's name is a reason, never overwritten.
//
// Without the patch's `keep`: `git worktree add -b thread/<id8>
// <parent>/<repo>-threads/<id8> main`, and a leftover folder of that name
// is a reason too.
//
// With `keep`: a spare, if there is one (see "spares" below), switched to
// the new branch with its kept folders left as they were; otherwise a new
// `<repo>-threads/slot-<n>`. The folder isn't named after the thread, as
// it outlives it.
export function makeWorktree(opts: { cwd: string; threadId: string; patch: WorktreePatch }): Promise<MadeWorktree> {
  // One at a time, so two new threads never take the same spare or slot.
  const made = making.then(() => makeWorktreeNow(opts));
  making = made.then(
    () => undefined,
    () => undefined,
  );
  return made;
}

let making: Promise<void> = Promise.resolve();

async function makeWorktreeNow(opts: { cwd: string; threadId: string; patch: WorktreePatch }): Promise<MadeWorktree> {
  const top = await gitOut(opts.patch.folder, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, reason: `the ${opts.patch.patch} patch asks for one, but ${opts.patch.folder} isn't in a git repo` };
  const mainCheckout = await mainCheckoutOf(top);
  if (!mainCheckout) return { ok: false, reason: `no checkout of ${path.basename(top)} has ${MAIN} checked out` };
  const repo = path.basename(mainCheckout);
  const threads = path.join(path.dirname(mainCheckout), `${repo}-threads`);
  const id8 = opts.threadId.slice(0, 8);
  const branch = threadBranch(opts.threadId);
  const keep = opts.patch.keep;
  if (!keep && fs.existsSync(path.join(threads, id8))) return { ok: false, reason: `there's already a folder at ${path.join(threads, id8)}` };
  if ((await git(mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok) {
    return { ok: false, reason: `the branch ${branch} already exists` };
  }
  const base = await gitOut(mainCheckout, ['rev-parse', MAIN]);
  if (!base) return { ok: false, reason: `couldn't read ${MAIN} in ${mainCheckout}` };
  const done = (where: string): MadeWorktree => ({
    ok: true,
    worktree: { repo, mainCheckout, path: where, branch, base, ...(keep ? { keep } : {}) },
    cwd: sameSubfolder(opts.cwd, top, where),
    patchFile: path.join(where, path.relative(top, realpath(opts.patch.file))),
  });

  if (keep) {
    for (const spare of await spares(mainCheckout, threads)) {
      // Unlocking is the claim: a second unlock of the same spare fails.
      if (!(await git(mainCheckout, ['worktree', 'unlock', spare])).ok) continue;
      if (await reuse(spare, branch, base, keep)) return done(spare);
      // Couldn't be put right: it stays unlocked, out of the pool, for
      // someone to look at, and the thread gets a new slot.
    }
  }

  let where = path.join(threads, id8);
  if (keep) {
    let n = 1;
    while (fs.existsSync(path.join(threads, `slot-${n}`))) n++;
    where = path.join(threads, `slot-${n}`);
  }
  fs.mkdirSync(threads, { recursive: true });
  const add = await git(mainCheckout, ['worktree', 'add', '-b', branch, where, base]);
  if (!add.ok) return { ok: false, reason: `git worktree add failed: ${firstLine(add.stderr)}` };
  return done(where);
}

// ---------------------------------------------------------------- spares
//
// A repo whose patch has worktree.keep (its build caches, like
// "app/.build") gets its worktrees reused: SwiftPM's cache only works in
// the folder it was built in, so every new worktree was a cold build of
// several minutes. When a thread is archived with everything landed, its
// worktree is detached, its branch deleted, and the folder locked with
// the reason below: a spare. The next new thread unlocks one, wipes
// everything git doesn't track except the kept folders, and checks out its
// branch there, so its first build only recompiles what changed.

const SPARE = 'threadbear spare';

// How many spares a repo keeps. Each holds its build caches (a gigabyte or
// so for Threadbear's), so past this an archived thread's worktree is
// removed as before.
export const MAX_SPARES = 6;

// The repo's spares, in `threads` (its <repo>-threads folder).
async function spares(mainCheckout: string, threads: string): Promise<string[]> {
  const dir = realpath(threads);
  return ((await listCheckouts(mainCheckout)) ?? [])
    .filter((c) => c.locked === SPARE && path.dirname(realpath(c.path)) === dir && isDir(c.path))
    .map((c) => c.path)
    .sort();
}

// A claimed spare, made like new on `branch` at `base`. The kept folders
// are left as they are; everything else git doesn't track goes, ignored
// files too (an old thread's node_modules, say), and setup runs again.
async function reuse(where: string, branch: string, base: string, keep: string[]): Promise<boolean> {
  const exclude = keep.flatMap((k) => ['-e', `/${k.replace(/^\/+|\/+$/g, '')}`]);
  for (const args of [['reset', '-q', '--hard'], ['clean', '-ffdxq', ...exclude], ['checkout', '-q', '-b', branch, base]]) {
    if (!(await git(where, args)).ok) return false;
  }
  return true;
}

// What the agent is told in its appended system prompt.
export function worktreeInstructions(w: WorktreeRecord): string {
  return [
    `This thread has its own git worktree of ${w.repo} at ${w.path}, on the branch ${w.branch}, made from ${MAIN}.`,
    `Commit your work there, on that branch. Other threads work in worktrees of their own, and the main checkout at ${w.mainCheckout} isn't yours to edit.`,
    `When the work is done and checked, run \`tb land\` in the worktree: it rebases the branch on ${MAIN}, runs the repo's check and fast-forwards ${MAIN} to it. It never pushes. After landing you can carry on, and the next \`tb land\` lands only what's new.`,
  ].join(' ');
}

// --------------------------------------------------------------- landing

export type LandTarget = {
  path: string; // the worktree's root
  branch: string;
  mainCheckout: string;
  check?: string; // the patch's worktree.check
};

export type LandOptions = {
  dryRun?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // How the check runs; tests pass a plain shell.
  shell?: string[];
  // The CLI reads the patch after rebasing, including changes to the
  // required check made by a landing it just waited for.
  readCheck?: () => Promise<string | undefined>;
};

// How many lines of a failed check's output are shown.
const CHECK_TAIL_LINES = 40;

// `tb land`: refuses with uncommitted changes, rebases on main, runs the
// check, fast-forwards main in its checkout and prints what landed.
// Returns the exit code. Every refusal leaves main as it was.
export async function land(t: LandTarget, opts: LandOptions = {}): Promise<number> {
  const common = await gitOut(t.path, ['rev-parse', '--git-common-dir']);
  if (!common) {
    (opts.err ?? console.error)(`${t.path} isn't a git checkout, so there's nothing to land.`);
    return 1;
  }
  // The remote check queue only serializes checks, after their snapshots
  // have been copied. Serialize the entire landing before rebasing, across
  // CLI processes, so waiting for that queue cannot stale another landing.
  let release: () => Promise<void>;
  try {
    release = await lockLanding(path.resolve(t.path, common, 'threadbear-land.lock'), opts.out ?? console.log);
  } catch (e) {
    (opts.err ?? console.error)(`Couldn't lock the repo for landing: ${(e as Error).message}`);
    return 1;
  }
  try {
    return await landLocked(t, opts);
  } finally {
    await release();
  }
}

// Advisory locks are released by the OS, including when tb crashes. The
// holder exits when its parent's pipe closes; no PID files to go stale or
// delete under another waiter. Keep the lock file itself between runs.
async function lockLanding(file: string, out: (line: string) => void): Promise<() => Promise<void>> {
  const holder = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('locked');";
  const mac = process.platform === 'darwin';
  const take = async (wait: boolean): Promise<(() => Promise<void>) | undefined> => {
    // 75 is EX_TEMPFAIL for lockf, and explicitly chosen for flock. A
    // nonblocking try distinguishes contention from a slow Node startup.
    const args = mac ? ['-k', ...(wait ? [] : ['-t', '0'])] : ['-x', '-E', '75', ...(wait ? [] : ['-n'])];
    const child = spawn(mac ? '/usr/bin/lockf' : 'flock', [...args, file, process.execPath, '-e', holder], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let errors = '';
    child.stderr.on('data', (d) => { errors += d; });
    const acquired = await new Promise<boolean>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        if (!wait && code === 75) resolve(false);
        else reject(new Error(errors.trim() || `landing lock exited (${code})`));
      });
      child.stdout.once('data', () => resolve(true));
    });
    if (!acquired) return undefined;
    return async () => {
      child.stdin.end();
      await closed;
    };
  };
  const release = await take(false);
  if (release) return release;
  out('Waiting for another landing of this repo to finish...');
  return (await take(true))!;
}

async function landLocked(t: LandTarget, opts: LandOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const err = opts.err ?? ((l: string) => process.stderr.write(l + '\n'));
  const fail = (...lines: string[]): number => {
    err(lines.join('\n'));
    return 1;
  };

  const head = await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head === undefined) return fail(`${t.path} isn't a git checkout, so there's nothing to land.`);
  if (head !== t.branch) return fail(`The worktree at ${t.path} is on ${head}, not ${t.branch}. Check out ${t.branch} there, then run tb land again.`);
  const mainHead = await gitOut(t.mainCheckout, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (mainHead !== MAIN) {
    return fail(`The main checkout at ${t.mainCheckout} is on ${mainHead ?? 'nothing git can read'}, not ${MAIN}, so tb land can't move ${MAIN} there.`);
  }

  // 1. Nothing uncommitted: it wouldn't land, and a rebase could trip on it.
  const status = await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all']);
  if (status === undefined) return fail(`Couldn't read git status in ${t.path}.`);
  if (status) {
    return fail(
      `There are uncommitted changes in ${t.path}, so nothing landed:`,
      ...status.split('\n').map((l) => `  ${l}`),
      'Commit them (or remove them), then run tb land again.',
    );
  }

  // 2. Rebase on main. A conflict is undone, and the files named. A branch
  // with a merge on it (Mike's release, brought in: docs/bringing-in-updates.md)
  // is never rebased, as that flattens the merge and rewrites his commits,
  // and then the copy never looks up to date with his release again. It
  // merges main in instead, when main has moved.
  const hasMerge = Boolean(await gitOut(t.path, ['rev-list', '--merges', `${MAIN}..${t.branch}`]));
  const behind = !(await git(t.path, ['merge-base', '--is-ancestor', MAIN, t.branch])).ok;
  if (hasMerge && behind) {
    const merged = await git(t.path, ['merge', '--no-edit', MAIN]);
    if (!merged.ok) {
      const conflicted = (await gitOut(t.path, ['diff', '--name-only', '--diff-filter=U'])) ?? '';
      await git(t.path, ['merge', '--abort']);
      if (conflicted) {
        return fail(
          `Merging ${MAIN} into ${t.branch} (it has a merge on it, so it isn't rebased) ran into conflicts in:`,
          ...conflicted.split('\n').map((f) => `  ${f}`),
          `The merge was undone, so ${t.branch} is as it was and ${MAIN} wasn't touched. Run git merge ${MAIN} in ${t.path}, sort out those files, commit, then run tb land again.`,
        );
      }
      return fail(`git merge ${MAIN} failed in ${t.path}, so nothing landed: ${firstLine(merged.stderr || merged.stdout)}`);
    }
  } else if (!hasMerge) {
    const rebase = await git(t.path, ['rebase', MAIN]);
    if (!rebase.ok) {
      const conflicted = (await gitOut(t.path, ['diff', '--name-only', '--diff-filter=U'])) ?? '';
      await git(t.path, ['rebase', '--abort']);
      if (conflicted) {
        return fail(
          `Rebasing ${t.branch} on ${MAIN} ran into conflicts in:`,
          ...conflicted.split('\n').map((f) => `  ${f}`),
          `The rebase was undone, so ${t.branch} is as it was and ${MAIN} wasn't touched. Run git rebase ${MAIN} in ${t.path}, sort out those files, finish the rebase, then run tb land again.`,
        );
      }
      return fail(`git rebase ${MAIN} failed in ${t.path}, so nothing landed: ${firstLine(rebase.stderr || rebase.stdout)}`);
    }
  }

  const commits = (await gitOut(t.path, ['log', '--oneline', '--first-parent', `${MAIN}..${t.branch}`])) ?? '';
  if (!commits) {
    out(`Nothing to land: ${t.branch} has no commits that aren't on ${MAIN}.`);
    return 0;
  }

  // 3. The repo's check, in the worktree. Pin what passed, rather than
  // merging a branch name that another process could move during checks.
  const checked = await gitOut(t.path, ['rev-parse', 'HEAD']);
  if (!checked) return fail(`Couldn't read HEAD in ${t.path}.`);
  let check: string | undefined;
  try {
    check = opts.readCheck ? await opts.readCheck() : t.check;
  } catch (e) {
    return fail(`Couldn't read the repo's patches for its check: ${(e as Error).message}`);
  }
  if (check) {
    out(`Running the check: ${check}`);
    const r = await runCheck(check, t.path, opts.shell);
    if (!r.ok) {
      const tail = r.text.trimEnd().split('\n').slice(-CHECK_TAIL_LINES);
      return fail(
        `The check failed${r.code !== undefined ? ` (exit ${r.code})` : ''}, so ${MAIN} wasn't touched. The last lines of its output:`,
        '',
        ...tail,
        '',
        'Fix it, commit, and run tb land again.',
      );
    }
    out(`The check passed (${Math.round(r.durationMs / 1000)} s).`);
  }

  if ((await gitOut(t.path, ['rev-parse', 'HEAD'])) !== checked ||
      (await gitOut(t.path, ['rev-parse', t.branch])) !== checked ||
      (await gitOut(t.path, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== t.branch ||
      (await gitOut(t.path, ['status', '--porcelain', '--untracked-files=all'])) !== '') {
    return fail(`The branch or files in ${t.path} changed while the check ran, so nothing landed. Commit the changes and run tb land again.`);
  }

  if (opts.dryRun) {
    out(`Would land on ${MAIN} in ${t.mainCheckout}:`);
    out(commits);
    return 0;
  }

  // 4. Fast-forward main where it's checked out.
  const before = await gitOut(t.mainCheckout, ['rev-parse', MAIN]);
  const merge = await git(t.mainCheckout, ['merge', '--ff-only', checked]);
  if (!merge.ok) {
    const text = merge.stderr + merge.stdout;
    const files = overwrittenFiles(text);
    if (files.length) {
      return fail(
        `The main checkout at ${t.mainCheckout} has uncommitted changes in files this would change, so nothing landed:`,
        ...files.map((f) => `  ${f}`),
        `Commit or move those changes there (someone else may be working on them), then run tb land again.`,
      );
    }
    if (/fast-forward/i.test(text)) return fail(`${MAIN} moved while this ran, so nothing landed. Run tb land again.`);
    return fail(`git merge --ff-only ${t.branch} failed in ${t.mainCheckout}, so nothing landed: ${firstLine(text)}`);
  }

  // 5. What landed.
  const landed = (await gitOut(t.mainCheckout, ['log', '--oneline', '--first-parent', `${before}..${MAIN}`])) ?? commits;
  out(`Landed on ${MAIN} in ${t.mainCheckout}:`);
  out(landed);
  return 0;
}

// The files git names when a merge would overwrite local changes (or
// untracked files) in the checkout: the tab-indented lines after the
// "would be overwritten by merge:" line.
export function overwrittenFiles(text: string): string[] {
  const files: string[] = [];
  let listing = false;
  for (const line of text.split('\n')) {
    if (/would be overwritten by merge:?$/.test(line.trim())) listing = true;
    else if (listing && /^\s+\S/.test(line)) files.push(line.trim());
    else listing = false;
  }
  return files;
}

// Runs the check through a shell, keeping the end of its output (that's
// where a test runner says what failed).
function runCheck(command: string, cwd: string, shell = ['/bin/sh', '-c']): Promise<{ ok: boolean; code?: number; text: string; durationMs: number }> {
  const started = Date.now();
  // At background priority: a land's check is the full quick suite.
  const [bin, args] = inBackground(shell[0], [...shell.slice(1), command]);
  const keep = 256 * 1024;
  return new Promise((resolve) => {
    let text = '';
    const take = (b: Buffer) => {
      text += b.toString('utf8');
      if (text.length > keep * 2) text = text.slice(-keep);
    };
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => resolve({ ok: false, text: `${text}\n${e.message}`, durationMs: Date.now() - started }));
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? undefined, text, durationMs: Date.now() - started }));
  });
}

// For `tb land` outside a thread (or in a thread without one of its own):
// the folder's checkout, if it's on a thread/ branch, and where main is.
export async function landTargetFromGit(cwd: string): Promise<{ target?: Omit<LandTarget, 'check'>; reason?: string }> {
  const top = await gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return { reason: `${cwd} isn't in a git checkout. Run tb land in a thread's worktree.` };
  const branch = await gitOut(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch?.startsWith('thread/')) {
    return { reason: `${top} is on ${branch ?? 'no branch'}, not a thread/ branch. tb land runs in a thread's own worktree.` };
  }
  const mainCheckout = await mainCheckoutOf(top);
  if (!mainCheckout) return { reason: `No checkout of this repo has ${MAIN} checked out, so there's nowhere to land.` };
  return { target: { path: top, branch, mainCheckout } };
}

// ------------------------------------------------------------- cleaning up

// `taken`: the folder is another checkout's now (another thread's worktree,
// a spare or a borrowed one), so it was left alone; only this thread's
// landed branch, if it was still there, went.
export type Cleanup = { removed: true; spare?: boolean; taken?: boolean } | { removed: false; reason: string };

// Whether a worktree the record still has is gone: its branch has, and its
// folder either has too ('gone') or is another checkout's now ('taken', a
// reused slot). Reads only, for records that missed hearing it went.
export async function worktreeGone(w: WorktreeRecord): Promise<false | 'gone' | 'taken'> {
  const branch = await git(w.mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]);
  // 1 is "no such ref"; anything else (no repo there) proves nothing.
  if (branch.ok || branch.code !== 1) return false;
  if (!isDir(w.path)) return 'gone';
  const checkouts = await listCheckouts(w.mainCheckout);
  if (!checkouts) return false;
  const here = realpath(w.path);
  return checkouts.some((c) => realpath(c.path) === here && c.branch === w.branch) ? false : 'taken';
}

// When its thread is archived or deleted: a worktree whose branch is all
// on main is removed with its branch (`--force` only for untracked
// files), or, with `keep` and room for another spare, set aside as one;
// otherwise both stay, and the reason says why.
export async function cleanUpWorktree(w: WorktreeRecord, stillOurs: () => boolean = () => true): Promise<Cleanup> {
  // Checked before each change: a runner handing the thread over stops
  // waiting for a slow git after a while, and from then the folder may be
  // the new runner's to use, so nothing more is changed here.
  const LET_GO: Cleanup = { removed: false, reason: 'the thread was handed to another runner' };
  let branchThere = (await git(w.mainCheckout, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`])).ok;
  if (branchThere) {
    const merged = await git(w.mainCheckout, ['merge-base', '--is-ancestor', w.branch, MAIN]);
    if (!merged.ok) return { removed: false, reason: `${w.branch} has commits that aren't on ${MAIN}` };
  }
  // A record can outlive its worktree without hearing (THREADBEAR-16: a
  // handover saved it while the cleanup ran), and slot folders are reused.
  // So the folder is only touched if it's still this branch's checkout:
  // otherwise it may be another thread's, and --force would take its work.
  let ours = false;
  if (fs.existsSync(w.path)) {
    const checkouts = await listCheckouts(w.mainCheckout);
    if (!checkouts) return { removed: false, reason: `git couldn't list the worktrees of ${w.mainCheckout}` };
    const here = realpath(w.path);
    ours = checkouts.some((c) => realpath(c.path) === here && c.branch === w.branch);
    if (!ours) {
      if (branchThere) {
        if (!stillOurs()) return LET_GO;
        const del = await git(w.mainCheckout, ['branch', '-D', w.branch]);
        if (!del.ok) return { removed: false, reason: `deleting ${w.branch} failed: ${firstLine(del.stderr)}` };
      }
      return { removed: true, taken: true };
    }
  }
  if (ours) {
    const status = await gitOut(w.path, ['status', '--porcelain', '--untracked-files=all']);
    if (status === undefined) return { removed: false, reason: `git couldn't read ${w.path}` };
    const lines = status ? status.split('\n') : [];
    if (lines.some((l) => !l.startsWith('??'))) return { removed: false, reason: `the worktree has uncommitted changes` };
    if (w.keep && (await spares(w.mainCheckout, path.dirname(w.path))).length < MAX_SPARES) {
      // Detached where it is (no files change), so the branch can go; its
      // untracked files go when the next thread takes it.
      if (!stillOurs()) return LET_GO;
      if ((await git(w.path, ['checkout', '-q', '--detach'])).ok) {
        if (!stillOurs()) return LET_GO;
        if (branchThere && (await git(w.mainCheckout, ['branch', '-D', w.branch])).ok) branchThere = false;
        if (!stillOurs()) return LET_GO;
        if (!branchThere && (await git(w.mainCheckout, ['worktree', 'lock', '--reason', SPARE, w.path])).ok) return { removed: true, spare: true };
      }
      // Couldn't be set aside: removed instead, below.
    }
    const args = ['worktree', 'remove', ...(lines.length ? ['--force'] : []), w.path];
    if (!stillOurs()) return LET_GO;
    const rm = await git(w.mainCheckout, args);
    if (!rm.ok) return { removed: false, reason: `git worktree remove failed: ${firstLine(rm.stderr)}` };
  } else {
    if (!stillOurs()) return LET_GO;
    await git(w.mainCheckout, ['worktree', 'prune']);
  }
  // Checked above that it's all on main, so -D loses nothing.
  if (branchThere) {
    if (!stillOurs()) return LET_GO;
    const del = await git(w.mainCheckout, ['branch', '-D', w.branch]);
    if (!del.ok) return { removed: false, reason: `the worktree went, but deleting ${w.branch} failed: ${firstLine(del.stderr)}` };
  }
  // The <repo>-threads folder, once it's empty.
  try {
    fs.rmdirSync(path.dirname(w.path));
  } catch {
    // Not empty, or gone.
  }
  return { removed: true };
}
