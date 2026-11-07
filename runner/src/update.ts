// The runner following main by itself (docs/dev-tools.md, "The runner
// updating itself"). Every few minutes a runner that runs from a release
// looks at main in the checkout it was built from. When what a release
// holds of runner/ (src, bin, package.json, package-lock.json) differs
// there from what's running, it builds a release of main the way
// deploy-runner.sh does (checks, snapshot, smoke test, point current at
// it), from its own clone under <home>/runner/update/src so nothing an
// agent has going in the checkout is built or disturbed, and then asks for
// the usual restart once no thread is busy. A build that failed isn't
// tried again until something it builds or checks changes on main (a fix
// to a test counts, though it changes nothing that runs), and a tree whose
// release crashed at startup isn't tried again until main changes.
import { execFile, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { currentLink, readRelease, readState, type ReleaseJson } from './release.ts';
import type { RestartResult } from './restart.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { inBackground } from './background.ts';
import type { UpdateFailure } from './fix-update.ts';

export const CHECK_INTERVAL_MS = 5 * 60_000;
// After main's ref changes in the checkout (a commit or merge landing), the
// check runs this soon, rather than at the next five-minute look. A burst
// of ref writes (a merge, then a push's packed-refs) makes one check.
export const SOON_MS = 3000;
// After this release is marked good: a release about to be rolled back
// should never deploy anything.
export const FIRST_CHECK_MS = 30_000;
// Background shells and subagents hold the update's restart this long at
// most (turns always hold it), as deploy-runner.sh's default --wait.
export const BACKGROUND_WAIT_MS = 30 * 60_000;
// What a release holds from runner/, as deploy.mjs's RELEASE_PATHS: only a
// change to these changes what runs, so a commit that only touches tests
// or docs doesn't restart the runner.
export const RELEASE_PATHS = ['src', 'bin', 'package.json', 'package-lock.json'];
const TRANSIENT = /Another deploy \(pid/;

export type UpdateState = 'off' | 'idle' | 'checking' | 'building' | 'waiting' | 'failed';

// runner.status's `update` (docs/protocol.md).
export type UpdateStatus = {
  state: UpdateState;
  checkout?: string;
  // off: why updates are off; failed: what went wrong.
  reason?: string;
  checkedAt?: string;
  // The commit on main the last check saw, and the release built from it
  // (waiting to start) when there is one.
  commit?: string;
  subject?: string; // the commit's subject line
  release?: string;
  logFile?: string;
  // The LaunchAgent is behind main in a way only install-runner.sh fixes
  // (launchAgentBehind below), and which way.
  launcherChanged?: boolean;
  launcherReason?: string;
};

// tree is what a release of main would hold (RELEASE_PATHS); buildTree is
// the whole of runner/ (tests, scripts, configs too), everything a build
// reads, so a failed build can be retried when only a test was fixed.
export type MainInfo = { commit: string; short: string; subject: string; tree: string; buildTree?: string };
export type DeployResult = { ok: true; id: string } | { ok: false; error: string; transient?: boolean };

// <home>/runner/update.json: the build that failed, so it isn't retried
// every five minutes.
// buildTree is missing in files written before it was kept.
export type UpdateFile = { failed?: { tree: string; buildTree?: string; commit: string; at: string; error: string } };

export type UpdateDeps = {
  home: string;
  // This runner's release.json; a runner run from a checkout has none, and
  // doesn't follow anything.
  release?: ReleaseJson;
  enabled: boolean;
  clock: Clock;
  log: Logger;
  notice: (level: 'info' | 'warning' | 'error', message: string) => void;
  // A failed build or backend deploy: starts a thread to fix it
  // (fix-update.ts) in place of the notice. False, or a throw, and the
  // notice is said instead.
  onFailed?: (f: UpdateFailure) => boolean;
  // Restarter.request with when: 'idle'.
  restart: (p: { release: string; reason: string; backgroundWaitMs: number }) => RestartResult;
  pendingRestart: () => boolean;
  // Replaced in tests: bringing the clone to main, and the deploy itself.
  sync?: (checkout: string, prefix: string, dir: string) => Promise<MainInfo>;
  treeOf?: (dir: string, prefix: string, commit: string) => string | undefined;
  deploy?: (runnerDir: string, home: string, logFile: string, follow: string) => Promise<DeployResult>;
  // Deploys the Convex backend and website at main before the runner is
  // built (scripts/deploy-backend.mjs): a no-op when they haven't changed.
  deployBackend?: (repoDir: string, runnerDir: string, home: string, commit: string, logFile: string) => Promise<{ ok: boolean; error?: string }>;
  watch?: (checkout: string, onChange: () => void) => () => void;
  // The environment launchAgentBehind reads (process.env; tests replace it).
  env?: NodeJS.ProcessEnv;
  // The launcher app above launch.mjs (launcherAppAbove; tests replace it).
  findLauncherApp?: () => string | undefined;
  // process.platform: only macOS has a launcher app (tests replace it).
  platform?: NodeJS.Platform;
  // Whenever status() may have changed (runner.updates, main.ts).
  onChange?: () => void;
};

export type Decision = { action: 'build' } | { action: 'nothing'; why: string };

// Whether main is worth building. running.tree is what this release holds
// (undefined when it can't be worked out); current is the release the
// current link names.
export function decideUpdate(i: {
  mainTree: string;
  mainBuildTree?: string;
  running: { id: string; tree?: string };
  current?: string;
  pendingRestart: boolean;
  failed?: { tree: string; buildTree?: string };
  crashedTrees: Set<string>;
}): Decision {
  if (!i.running.tree) return { action: 'nothing', why: "can't tell what this release was built from" };
  if (i.pendingRestart) return { action: 'nothing', why: 'a restart is already pending' };
  if (i.current && i.current !== i.running.id) return { action: 'nothing', why: `release ${i.current} is current and waiting to start` };
  if (i.mainTree === i.running.tree) return { action: 'nothing', why: 'up to date with main' };
  if (failedAlready(i.failed, { tree: i.mainTree, buildTree: i.mainBuildTree })) {
    return { action: 'nothing', why: 'the last build of this tree failed; waiting for main to change' };
  }
  if (i.crashedTrees.has(i.mainTree)) return { action: 'nothing', why: 'a release of this tree crashed at startup; waiting for main to change' };
  return { action: 'build' };
}

// Whether main is what the last failed build was built from. Compared by
// the whole of runner/ when both sides have it: a failure in the checks is
// often fixed in a test alone, which leaves the release paths as they were
// and would otherwise never be built again (4428543 sat unshipped that way).
export function failedAlready(failed: { tree: string; buildTree?: string } | undefined, main: { tree: string; buildTree?: string }): boolean {
  if (!failed) return false;
  if (failed.buildTree && main.buildTree) return failed.buildTree === main.buildTree;
  return failed.tree === main.tree;
}

// Calls onChange when main's ref moves in the checkout: refs/heads/main
// (written through main.lock) or packed-refs, in the repository's common
// dir, which worktrees share, so a commit from any of them counts.
export function watchMainRef(checkout: string, onChange: () => void): () => void {
  let common: string;
  try {
    common = path.resolve(checkout, git(checkout, ['rev-parse', '--git-common-dir']));
  } catch {
    return () => {};
  }
  const watchers: fs.FSWatcher[] = [];
  const watch = (dir: string, match: RegExp) => {
    try {
      const w = fs.watch(dir, (_event, file) => {
        if (!file || match.test(String(file))) onChange();
      });
      // A folder that goes away (a repack) just stops this one.
      w.on('error', () => w.close());
      watchers.push(w);
    } catch {
      // not there: the five-minute look still finds the change
    }
  };
  watch(path.join(common, 'refs', 'heads'), /^main(\.lock)?$/);
  watch(common, /^packed-refs$/);
  return () => {
    for (const w of watchers) w.close();
  };
}

export function updateDir(home: string): string {
  return path.join(home, 'runner', 'update');
}

export function updateFilePath(home: string): string {
  return path.join(home, 'runner', 'update.json');
}

export function updateLogPath(home: string): string {
  return path.join(home, 'runner', 'update.log');
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.stdout.trim();
}

// git without blocking the event loop. syncClone runs every time main
// moves, and its fetch, checkout and clean take many seconds while the
// disk is busy (a render, a backup): run synchronously they froze every
// thread and the app's requests for that long.
function gitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

// The object hashes of the release paths at `rev`, joined: the same formula
// deploy.mjs writes as `tree` in release.json. Undefined when `rev` isn't
// in the repo or holds none of them.
export function releaseTreeAt(repo: string, prefix: string, rev: string): string | undefined {
  const r = spawnSync('git', ['-C', repo, 'ls-tree', rev, '--', ...RELEASE_PATHS.map((p) => prefix + p)], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  return joinTreeHashes(r.stdout);
}

async function releaseTreeAtAsync(repo: string, prefix: string, rev: string): Promise<string | undefined> {
  try {
    return joinTreeHashes(await gitAsync(repo, ['ls-tree', rev, '--', ...RELEASE_PATHS.map((p) => prefix + p)]));
  } catch {
    return undefined;
  }
}

function joinTreeHashes(lsTree: string): string | undefined {
  const hashes = lsTree
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[2]);
  return hashes.length ? hashes.join('+') : undefined;
}

// Brings <dir> to the checkout's main: a clone of the checkout (so only
// what's committed on main is built, never a working tree), fetched and
// reset each time. runner/node_modules is kept between runs for the checks,
// and dropped when package-lock.json changed so they install afresh.
export async function syncClone(checkout: string, prefix: string, dir: string): Promise<MainInfo> {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    await gitAsync(path.dirname(dir), ['clone', '-q', '--no-checkout', checkout, dir]);
  }
  await gitAsync(dir, ['fetch', '-q', checkout, 'refs/heads/main']);
  await gitAsync(dir, ['checkout', '-q', '-B', 'main', 'FETCH_HEAD']);
  const modules = path.join(dir, prefix, 'node_modules');
  await gitAsync(dir, ['clean', '-qfdx', '-e', `${prefix}node_modules`]);
  const lockFile = path.join(dir, prefix, 'package-lock.json');
  // Beside the clone, not in it: git clean would take it out each time.
  const stamp = path.join(path.dirname(dir), 'installed-lock');
  const lock = fs.existsSync(lockFile) ? crypto.createHash('sha256').update(fs.readFileSync(lockFile)).digest('hex') : '';
  let had = '';
  try {
    had = fs.readFileSync(stamp, 'utf8').trim();
  } catch {
    // first run
  }
  if (had !== lock) {
    await fs.promises.rm(modules, { recursive: true, force: true });
    fs.writeFileSync(stamp, lock + '\n');
  }
  const tree = await releaseTreeAtAsync(dir, prefix, 'HEAD');
  if (!tree) throw new Error(`main in ${checkout} has no ${prefix}src to build`);
  const buildTree = await gitAsync(dir, ['rev-parse', `HEAD:${prefix.replace(/\/$/, '')}`]);
  const [commit, short, subject] = await Promise.all([
    gitAsync(dir, ['rev-parse', 'HEAD']),
    gitAsync(dir, ['rev-parse', '--short', 'HEAD']),
    gitAsync(dir, ['log', '-1', '--format=%s']),
  ]);
  return { commit, short, subject, tree, buildTree };
}

// deploy.mjs from the clone, stopping after it has pointed current at the
// new release (--no-restart): the runner asks for the restart itself, so
// the build never has to outlive it. Its output goes to logFile.
// follow is the checkout the running release follows: deploy.mjs records
// it as the new release's checkout, so the release after this one still
// follows Mike's checkout rather than this clone (which would only ever
// fetch itself and report "up to date" for good).
export function backendLogPath(home: string): string {
  return path.join(updateDir(home), 'backend.log');
}

// The backend goes before the runner, so a runner is never newer than the
// backend it writes to (docs/setup-and-updates.md section 2.3). The script
// compares what changed itself, so running it for every new commit of main
// is cheap when convex/ and web/ are as they were.
export function runBackendDeploy(repoDir: string, runnerDir: string, home: string, commit: string, logFile: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const script = path.join(runnerDir, 'scripts', 'deploy-backend.mjs');
    // A main from before the script existed has nothing to deploy this way.
    if (!fs.existsSync(script)) {
      resolve({ ok: true });
      return;
    }
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^THREADB(EAR|ARE)_/.test(k)) env[k] = v;
    let fd: number;
    try {
      fd = fs.openSync(logFile, 'w');
    } catch (e) {
      resolve({ ok: false, error: `couldn't open ${logFile}: ${(e as Error).message}` });
      return;
    }
    // Background priority (background.ts): it builds the backend from main.
    const child = spawn(...inBackground(process.execPath, [script, '--home', home, '--repo', repoDir, '--commit', commit]), { cwd: repoDir, env, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      let text = '';
      try {
        text = fs.readFileSync(logFile, 'utf8');
      } catch {
        // nothing written
      }
      const last = text.trim().split('\n').filter(Boolean).at(-1) ?? (signal ? `stopped by ${signal}` : `exit ${code}`);
      resolve({ ok: false, error: last.slice(0, 300) });
    });
  });
}

export function runDeploy(runnerDir: string, home: string, logFile: string, follow: string): Promise<DeployResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^THREADB(EAR|ARE)_/.test(k)) env[k] = v;
    let fd: number;
    try {
      fd = fs.openSync(logFile, 'w');
    } catch (e) {
      resolve({ ok: false, error: `couldn't open ${logFile}: ${(e as Error).message}` });
      return;
    }
    // Background priority (background.ts): the release build is npm ci and tsc.
    const child = spawn(...inBackground(process.execPath, [path.join(runnerDir, 'scripts', 'deploy.mjs'), '--no-restart', '--home', home, '--follow', follow]), {
      cwd: runnerDir,
      env,
      stdio: ['ignore', fd, fd],
    });
    fs.closeSync(fd);
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code, signal) => {
      if (code === 0) {
        const id = currentLink(home);
        resolve(id ? { ok: true, id } : { ok: false, error: 'the deploy finished but current names no release' });
        return;
      }
      let text = '';
      try {
        text = fs.readFileSync(logFile, 'utf8');
      } catch {
        // nothing written
      }
      const lines = text.trim().split('\n').filter(Boolean);
      const last = lines.at(-1) ?? (signal ? `stopped by ${signal}` : `exit ${code}`);
      resolve({ ok: false, error: last.slice(0, 300), transient: TRANSIENT.test(text) });
    });
  });
}

export class RunnerUpdater {
  // The last main commit the backend was deployed for (or failed at), so it's
  // tried once per commit, and why it failed.
  private backendTried?: string;
  private backendFailed?: string;
  private deps: UpdateDeps;
  private timer?: TimerHandle;
  private state: UpdateState = 'off';
  private reason?: string;
  private checkedAt?: string;
  private commit?: string;
  private subject?: string;
  private launcherChanged = false;
  private launcherReason?: string;
  private releaseBuilt?: string;
  private busy = false;
  private stopped = false;
  private unwatch?: () => void;
  private soonTimer?: TimerHandle;
  private again = false;

  constructor(deps: UpdateDeps) {
    this.deps = deps;
    // Until start(): a fresh release shows why it isn't looking yet, so
    // "off" right after a restart doesn't read as the feature being off.
    this.reason = 'not until this release has been marked good, about a minute after it starts';
  }

  // Called once this release has been marked good.
  start(): void {
    const { release, enabled, log } = this.deps;
    const off = (why: string) => {
      this.state = 'off';
      this.reason = why;
      log.info('not following main', { why });
      this.deps.onChange?.();
    };
    if (!enabled) return off('followMain is off in runner.json');
    if (!release) return off('running from a checkout, not a release');
    if (!release.checkout || !release.prefix) return off('this release was built before releases recorded their checkout; deploy once by hand');
    if (!fs.existsSync(path.join(release.checkout, '.git'))) return off(`the checkout it was built from, ${release.checkout}, is gone`);
    // A release the updater built before it passed --follow names the
    // updater's own clone, which never gets new commits.
    if (sameDir(release.checkout, path.join(updateDir(this.deps.home), 'src'))) {
      return off("this release was built from the updater's own clone, so it can't see main; deploy once by hand from the checkout");
    }
    this.state = 'idle';
    this.reason = undefined;
    log.info('following main', { checkout: release.checkout, release: release.id });
    this.timer = this.deps.clock.setTimeout(() => this.tick(), FIRST_CHECK_MS);
    this.unwatch = (this.deps.watch ?? watchMainRef)(release.checkout, () => this.soon());
    this.deps.onChange?.();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.soonTimer?.cancel();
    this.soonTimer = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
  }

  // Main moved: look in a moment instead of at the next five-minute check.
  // One already running looks again once it's done.
  private soon(): void {
    if (this.stopped || this.state === 'off') return;
    this.soonTimer?.cancel();
    this.soonTimer = this.deps.clock.setTimeout(() => {
      this.soonTimer = undefined;
      if (this.busy) {
        this.again = true;
        return;
      }
      this.timer?.cancel();
      this.tick();
    }, SOON_MS);
  }

  status(): UpdateStatus {
    const out: UpdateStatus = { state: this.state };
    if (this.deps.release?.checkout) out.checkout = this.deps.release.checkout;
    if (this.reason) out.reason = this.reason;
    if (this.checkedAt) out.checkedAt = this.checkedAt;
    if (this.commit) out.commit = this.commit;
    if (this.subject) out.subject = this.subject;
    if (this.releaseBuilt) out.release = this.releaseBuilt;
    if (this.launcherChanged) out.launcherChanged = true;
    if (this.launcherReason) out.launcherReason = this.launcherReason;
    if (this.state !== 'off') out.logFile = updateLogPath(this.deps.home);
    return out;
  }

  private tick(): void {
    this.timer = undefined;
    void this.check().finally(() => {
      if (this.stopped || this.state === 'off') return;
      if (this.again) {
        this.again = false;
        this.tick();
        return;
      }
      this.timer = this.deps.clock.setTimeout(() => this.tick(), CHECK_INTERVAL_MS);
    });
  }

  // One look at main, and a build if it's worth one. Public for tests.
  async check(): Promise<Decision | undefined> {
    const { home, release, log } = this.deps;
    if (this.busy || this.stopped || !release?.checkout || !release.prefix) return undefined;
    this.busy = true;
    const wasFailed = this.state === 'failed';
    this.state = 'checking';
    try {
      const dir = path.join(updateDir(home), 'src');
      const main = await (this.deps.sync ?? syncClone)(release.checkout, release.prefix, dir);
      this.checkedAt = new Date(this.deps.clock.now()).toISOString();
      this.commit = main.commit;
      this.subject = main.subject;
      this.launcherReason = launchAgentBehind(path.join(dir, release.prefix), home, this.deps.env ?? process.env, this.deps.findLauncherApp, this.deps.platform);
      this.launcherChanged = this.launcherReason !== undefined;
      if (main.commit !== this.backendTried) {
        this.backendTried = main.commit;
        const b = await (this.deps.deployBackend ?? runBackendDeploy)(dir, path.join(dir, release.prefix), home, main.commit, backendLogPath(home));
        if (this.stopped) return undefined;
        this.backendFailed = b.ok ? undefined : (b.error ?? 'unknown error');
        if (!b.ok) {
          log.error('could not deploy the backend at main', { commit: main.short, error: this.backendFailed });
          this.failed(
            { kind: 'backend', commit: main.commit, short: main.short, subject: main.subject, error: this.backendFailed ?? 'unknown error', logFile: backendLogPath(home) },
            `The Convex backend couldn't be deployed at main ${main.short} (${main.subject}): ${this.backendFailed}. The runner stays where it is until main changes. The output is in ${backendLogPath(home)}.`,
          );
        }
      }
      // A runner newer than its backend could write what the backend can't
      // take, so it waits for a main whose backend deploys.
      if (this.backendFailed) {
        this.state = 'failed';
        this.reason = `the backend deploy failed: ${this.backendFailed}`;
        return { action: 'nothing', why: 'the backend deploy at main failed' };
      }
      const treeOf = this.deps.treeOf ?? releaseTreeAt;
      const running = { id: release.id, tree: release.tree ?? (release.dirty ? undefined : treeOf(dir, release.prefix, release.commit)) };
      const file = readJsonSync<UpdateFile>(updateFilePath(home));
      const decision = decideUpdate({
        mainTree: main.tree,
        mainBuildTree: main.buildTree,
        running,
        current: currentLink(home),
        pendingRestart: this.deps.pendingRestart(),
        failed: file?.failed,
        crashedTrees: this.crashedTrees(dir, release.prefix, treeOf),
      });
      if (decision.action === 'nothing') {
        log.debug('main checked', { commit: main.short, why: decision.why });
        // A failure stays on show until main moves on from it.
        this.state = wasFailed && failedAlready(file?.failed, main) ? 'failed' : 'idle';
        return decision;
      }
      this.state = 'building';
      this.reason = undefined;
      this.deps.onChange?.();
      log.info('building a release of main', { commit: main.short, subject: main.subject });
      const result = await (this.deps.deploy ?? runDeploy)(path.join(dir, release.prefix), home, updateLogPath(home), release.checkout);
      if (this.stopped) return decision;
      if (!result.ok) {
        if (result.transient) {
          log.info('could not build main now; trying again later', { error: result.error });
          this.state = 'idle';
          return decision;
        }
        this.state = 'failed';
        this.reason = result.error;
        atomicWriteFileSync(updateFilePath(home), JSON.stringify({ failed: { tree: main.tree, buildTree: main.buildTree, commit: main.commit, at: this.checkedAt, error: result.error } } as UpdateFile, null, 2) + '\n');
        log.error('could not build a release of main', { commit: main.short, error: result.error });
        this.failed(
          { kind: 'build', commit: main.commit, short: main.short, subject: main.subject, error: result.error, logFile: updateLogPath(home) },
          `The runner couldn't update to main at ${main.short} (${main.subject}): ${result.error}. The output is in ${updateLogPath(home)}.`,
        );
        return decision;
      }
      this.releaseBuilt = result.id;
      this.state = 'waiting';
      const res = this.deps.restart({ release: result.id, reason: `Updating to main at ${main.short}: ${main.subject}`, backgroundWaitMs: BACKGROUND_WAIT_MS });
      log.info('release of main built; restart asked for', { release: result.id, commit: main.short, waitingFor: res.waitingFor });
      return decision;
    } catch (e) {
      // Git trouble in the clone, say: logged, and tried again next time.
      log.warn('could not check main', { error: String(e) });
      this.state = wasFailed ? 'failed' : 'idle';
      return undefined;
    } finally {
      this.busy = false;
      this.deps.onChange?.();
    }
  }

  // A thread to fix it when one can be started, else the notice.
  private failed(f: UpdateFailure, notice: string): void {
    try {
      if (this.deps.onFailed?.(f)) return;
    } catch (e) {
      this.deps.log.warn('could not start a thread to fix the update', { error: String(e) });
    }
    this.deps.notice('warning', notice);
  }

  // The trees of releases that crashed at startup (deploy.mjs's `crashed`
  // and launch.mjs's rolledBack), so a commit that crashed isn't built and
  // deployed every five minutes.
  private crashedTrees(dir: string, prefix: string, treeOf: NonNullable<UpdateDeps['treeOf']>): Set<string> {
    const out = new Set<string>();
    const state = readState(this.deps.home) as (ReturnType<typeof readState> & { crashed?: unknown }) | undefined;
    const ids = new Set<string>(Array.isArray(state?.crashed) ? state.crashed.filter((x): x is string => typeof x === 'string') : []);
    if (state?.rolledBack?.from) ids.add(state.rolledBack.from);
    if (state?.lastGood) ids.delete(state.lastGood);
    for (const id of ids) {
      const r = readRelease(path.join(this.deps.home, 'runner', 'releases', id));
      if (!r) continue;
      const tree = r.tree ?? (r.dirty ? undefined : treeOf(dir, prefix, r.commit));
      if (tree) out.add(tree);
    }
    return out;
  }
}

// Whether main's launch.mjs (in the clone) isn't the installed one. Only
// for a runner installed with one: without either file there's nothing to
// say.
// The files build-launcher.sh hashes (its sources_hash), in its order.
const LAUNCHER_SOURCES = ['main.swift', 'Info.plist', 'build-launcher.sh'];

// The hash build-launcher.sh records in the app's build.json for the
// launcher sources in `dir`, or undefined when they aren't all there (a
// main from before the launcher).
export function launcherSourcesHash(dir: string): string | undefined {
  try {
    const h = crypto.createHash('sha256');
    for (const f of LAUNCHER_SOURCES) h.update(fs.readFileSync(path.join(dir, f)));
    return h.digest('hex');
  } catch {
    return undefined;
  }
}

// Why the installed LaunchAgent is behind main's runner/ (`mainRunner`, in
// the updater's clone), in a sentence, or undefined when it isn't.
// Releases never change any of it, and the runner can't reinstall the
// launchd job it runs in, so this is said (tb status, the app's Updates
// panel) for Mike to run install-runner.sh. The app is the one
// install-runner.sh put in the plist (THREADBEAR_RUNNER_APP), else the
// process that started launch.mjs, for a plist written before that
// variable; a supervised runner with neither still runs node as the
// program.
export function launchAgentBehind(
  mainRunner: string,
  home: string,
  env: NodeJS.ProcessEnv,
  findApp: () => string | undefined = launcherAppAbove,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const why: string[] = [];
  if (launcherDiffers(path.join(mainRunner, 'launch.mjs'), path.join(home, 'runner', 'launch.mjs'))) why.push('launch.mjs has changed on main.');
  const onMain = launcherSourcesHash(path.join(mainRunner, 'launcher'));
  // Linux has no launcher app (systemd runs node; install-runner.sh).
  if (onMain && env.THREADBEAR_SUPERVISED === '1' && platform === 'darwin') {
    const app = env.THREADBEAR_RUNNER_APP || findApp();
    if (!app) {
      why.push('The LaunchAgent still runs node, not Threadbear Runner.app, so privacy prompts say "node".');
    } else {
      let built: unknown;
      try {
        built = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'build.json'), 'utf8')).sources;
      } catch {
        // missing or unreadable: rebuilt by the same command
      }
      if (built !== onMain) why.push('Threadbear Runner.app was built from older launcher sources than main\'s.');
    }
  }
  return why.length ? why.join(' ') : undefined;
}

// The launcher app this runner runs under, from the process tree: the
// runner's parent is launch.mjs and launch.mjs's parent is the app's
// executable. Undefined when it's anything else (node, a test, a shell).
export function launcherAppAbove(): string | undefined {
  const ps = (field: string, pid: number) => spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const grandparent = Number(ps('ppid', process.ppid));
  if (!grandparent || grandparent <= 1) return undefined;
  return appOfExecutable(ps('comm', grandparent));
}

// "<x>.app/Contents/MacOS/Threadbear Runner" to "<x>.app", else undefined.
export function appOfExecutable(exe: string): string | undefined {
  const m = /^(\/.+\.app)\/Contents\/MacOS\/Threadbear Runner$/.exec(exe);
  return m ? m[1] : undefined;
}

export function launcherDiffers(onMain: string, installed: string): boolean {
  try {
    return !fs.readFileSync(onMain).equals(fs.readFileSync(installed));
  } catch {
    return false;
  }
}
