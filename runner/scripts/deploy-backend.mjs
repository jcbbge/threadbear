// Deploys the Convex backend (convex/) and the website (web/) at a commit to
// the runner's own deployment, when either has changed since the last time
// (docs/setup-and-updates.md section 2.3). The runner's updater runs it
// before building a runner release (src/update.ts), and deploy.mjs before it
// switches releases, so the backend is never older than the runner using it.
//
//   node runner/scripts/deploy-backend.mjs [--commit REV] [--force] [--dry-run] [--status]
//
// It deploys from a clean `git archive` of the commit in a temp folder, never
// the checkout, whose .env.local points at the dev deployment. The deploy key
// is `CONVEX_DEPLOY_KEY=...` in <home>/secrets/convex-deploy.env (made with
// `npx convex deployment token create threadbear-runner --prod --save-env <file>`);
// with no key file it does nothing and says so. A self-hosted backend
// (docs/self-hosting.md) has its admin URL and key in
// <home>/secrets/convex-self-hosted.env instead (src/convex-admin.ts). What
// it last deployed is in <home>/backend.json. Node built-ins only, like
// deploy.mjs (convex-admin.ts is too).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConvexAdminError, convexEnv, prodArgs, readConvexAdmin } from '../src/convex-admin.ts';

const HELP = `deploy-backend.mjs: deploy convex/ and web/ at a commit to the runner's Convex deployment, if they changed.

Options:
  --commit REV   what to deploy (default HEAD of the repo this script is in)
  --repo DIR     the repo (default the one this script is in)
  --home DIR     data dir (default $THREADBEAR_HOME, else ~/Library/Application Support/Threadbear)
  --force        deploy even if nothing changed
  --dry-run      say what would be deployed and change nothing
  --status       print what was last deployed and stop
`;

const DEFAULT_HOME = path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear');
// What each part is built from. The root package files are the Convex
// dependency's version, so they count for both.
const FUNCTION_PATHS = ['convex', 'convex.json', 'package.json', 'package-lock.json'];
const SITE_PATHS = ['web', 'package.json', 'package-lock.json'];
const EXPORT_PATHS = ['convex', 'convex.json', 'web', 'package.json', 'package-lock.json'];

class Fail extends Error {}
const say = (msg) => console.log(msg);

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Fail(`git ${args.join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.stdout.trim();
}

// The object hashes of the paths at the commit, joined: the same idea as a
// runner release's tree (deploy.mjs releaseTree).
function treeOf(repo, commit, paths) {
  const out = git(repo, ['ls-tree', commit, '--', ...paths]);
  return out.split('\n').filter(Boolean).map((line) => line.split(/\s+/)[2]).join('+');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The key is read, never printed. A deploy key's "prod:<name>|..." prefix
// names the deployment, which has to be the one the runner mirrors to
// (runner.json sync.url), or this would deploy one backend and the runner
// use another.
function readAdmin(home) {
  try {
    return readConvexAdmin(home);
  } catch (e) {
    if (e instanceof ConvexAdminError) throw new Fail(e.message);
    throw e;
  }
}

function hasRunnerKey(home) {
  try {
    return fs.readFileSync(path.join(home, 'secrets', 'convex-key'), 'utf8').trim().startsWith('tbr_');
  } catch {
    return false;
  }
}

function syncDeployment(home) {
  const url = readJson(path.join(home, 'runner.json')).sync?.url;
  if (!url) return undefined;
  try {
    return { url, name: new URL(url).hostname.split('.')[0] };
  } catch {
    return { url };
  }
}

// Two deploys can overlap: an old runner handing over goes on with the
// deploy it started while the new one checks main and starts its own for
// the same commit (6 Nov, 1ba0776). So a second deploy waits for the first
// rather than failing. The lock is the kernel's (lockf on macOS, flock on
// Linux), held by a copy of this script that runs the whole deploy again
// under it: it goes when its holder dies, so there's no stale lock or reused
// pid to judge, and the copy reads backend.json afresh once it holds it, so
// it deploys only what the other one left (usually nothing).
const LOCK_WAIT_SECS = 30 * 60;
const LOCKED_ENV = 'DEPLOY_BACKEND_LOCK_HELD';
let unlocked = false;

function lockTool(file, cmd, { wait }) {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/lockf')) {
    // -k keeps the file: removing it after would let a third run lock a
    // new file while a second still waits on the old one.
    return { cmd: '/usr/bin/lockf', args: ['-k', '-t', String(wait), file, ...cmd], timedOut: 75 };
  }
  for (const flock of ['/usr/bin/flock', '/bin/flock']) {
    // -E: its own exit status for a timeout, apart from the deploy's 1.
    if (fs.existsSync(flock)) return { cmd: flock, args: ['-E', '75', '-w', String(wait), file, ...cmd], timedOut: 75 };
  }
  return undefined;
}

// Runs this script again under the lock and returns its exit status, or
// undefined when this is already that copy.
function underLock(home, argv) {
  if (process.env[LOCKED_ENV] === '1') return undefined;
  const file = path.join(home, 'backend.flock');
  const again = [process.execPath, import.meta.filename, ...argv];
  const tool = lockTool(file, again, { wait: LOCK_WAIT_SECS });
  // Most Macs and runners with no lock tool never deploy (a runner key, no
  // deploy key), so it's only an error once there's a deploy to do.
  if (!tool) {
    unlocked = true;
    return undefined;
  }
  // Only for the message: a busy lock right now means a wait.
  const probe = lockTool(file, [process.execPath, '-e', ''], { wait: 0 });
  if (probe && spawnSync(probe.cmd, probe.args, { stdio: 'ignore' }).status !== 0) say('Waiting for another backend deploy to finish...');
  const r = spawnSync(tool.cmd, tool.args, { stdio: 'inherit', env: { ...process.env, [LOCKED_ENV]: '1' } });
  if (r.error) throw new Fail(`${tool.cmd} failed: ${r.error.message}`);
  if (r.status === tool.timedOut) throw new Fail(`Another backend deploy was still running after ${LOCK_WAIT_SECS / 60} minutes.`);
  return r.status ?? 1;
}

// Releases before 6 Nov took backend.lock, a file with their pid in it. One
// still running from an old runner handing over gets waited for too.
function waitForOldLock(home) {
  const file = path.join(home, 'backend.lock');
  const until = Date.now() + LOCK_WAIT_SECS * 1000;
  for (;;) {
    let pid;
    try {
      pid = Number(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    let alive = false;
    try {
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      // gone
    }
    if (!alive) {
      fs.rmSync(file, { force: true });
      return;
    }
    if (Date.now() > until) throw new Fail(`An older backend deploy (pid ${pid}) was still running after ${LOCK_WAIT_SECS / 60} minutes.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

// Runs a step with its output in a log file, printed only if it fails.
function step(name, cmd, args, opts) {
  process.stdout.write(`${name}... `);
  const started = Date.now();
  const logFile = path.join(os.tmpdir(), `threadbear-backend-${process.pid}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.log`);
  const fd = fs.openSync(logFile, 'w');
  const r = spawnSync(cmd, args, { ...opts, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const secs = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (r.status === 0) {
    say(`ok (${secs})`);
    fs.rmSync(logFile, { force: true });
    return;
  }
  say(`failed (${secs})`);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  console.error(lines.slice(-30).join('\n'));
  throw new Fail(`${name} failed; the whole output is in ${logFile}`);
}

function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      commit: { type: 'string' },
      repo: { type: 'string' },
      home: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      status: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const home = path.resolve(v.home ?? process.env.THREADBEAR_HOME ?? process.env.THREADBARE_HOME ?? DEFAULT_HOME);
  const stateFile = path.join(home, 'backend.json');
  if (v.status) {
    say(JSON.stringify(readJson(stateFile), null, 2));
    return 0;
  }
  // Before anything is read: whether it's up to date, and which commit HEAD
  // is, are only true once no other deploy is changing them.
  if (!v['dry-run']) {
    const locked = underLock(home, argv);
    if (locked !== undefined) return locked;
    waitForOldLock(home);
  }
  const state = readJson(stateFile);
  const repo = path.resolve(v.repo ?? git(import.meta.dirname, ['rev-parse', '--show-toplevel']));
  const commit = git(repo, ['rev-parse', v.commit ?? 'HEAD']);
  const short = commit.slice(0, 7);
  const want = { functions: treeOf(repo, commit, FUNCTION_PATHS), site: treeOf(repo, commit, SITE_PATHS) };
  // The website has the backend's address built into it (VITE_CONVEX_URL),
  // so it's built again when that changes too: a self-hosted backend whose
  // Mac was renamed has a new one (docs/self-hosting.md). Deploys from before
  // this was recorded have no url, and aren't redone for that alone.
  const siteUrl = readJson(path.join(home, 'runner.json')).sync?.url;
  const todo = {
    functions: v.force || state.functions?.tree !== want.functions,
    site: v.force || state.site?.tree !== want.site || (state.site?.url !== undefined && state.site.url !== siteUrl),
  };
  if (!todo.functions && !todo.site) {
    say(`Backend up to date at ${short}.`);
    return 0;
  }

  // Only the main Mac's runner deploys the backend. A Mac with a runner key
  // of its own (docs/protocol.md, "Runner keys") doesn't, even if an older
  // setup left a deploy key there (tb runner check says to remove it).
  if (hasRunnerKey(home)) {
    say('This Mac has a runner key of its own, so it leaves deploying the backend to the main Mac.');
    return 0;
  }
  const admin = readAdmin(home);
  if (admin.kind === 'none') {
    say(`No deploy key in ${admin.file}, so the backend isn't deployed automatically. Make one with:\n  npx convex deployment token create threadbear-runner --prod --save-env "${admin.file}"`);
    return 0;
  }
  const deployment = admin.kind === 'cloud' ? admin.deployment : undefined;
  const sync = syncDeployment(home);
  if (sync?.name && deployment && sync.name !== deployment) {
    throw new Fail(`The deploy key is for ${deployment}, but the runner mirrors to ${sync.url}. Make a key for that deployment.`);
  }
  // A self-hosted backend has no deployment name to compare, and its admin
  // URL is this Mac's loopback port while sync.url is its tailnet name, so
  // there's nothing to check here: setup writes both from the same backend.
  const target = admin.kind === 'selfHosted' ? `the self-hosted backend at ${admin.url}` : (deployment ?? "the key's deployment");
  const what = [todo.functions && 'functions', todo.site && 'website'].filter(Boolean).join(' and ');
  if (v['dry-run']) {
    say(`Would deploy the ${what} at ${short} to ${target}.`);
    return 0;
  }

  if (unlocked) throw new Fail('No lockf or flock here to keep two backend deploys apart. Install flock (util-linux).');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-backend-'));
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', commit, '--', ...EXPORT_PATHS], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Fail(`git archive failed: ${String(archive.stderr).trim()}`);
  const untar = spawnSync('tar', ['-x', '-C', tmp], { input: archive.stdout });
  if (untar.status !== 0) throw new Fail(`tar failed: ${String(untar.stderr).trim()}`);

  // Only the key picks the deployment: anything left over from a checkout's
  // .env.local or a thread's environment could point somewhere else.
  const env = convexEnv(admin, { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` });
  const npm = path.join(path.dirname(process.execPath), 'npm');
  const npx = path.join(path.dirname(process.execPath), 'npx');
  const opts = { cwd: tmp, env };

  const failed = (part, e) => {
    writeJson(stateFile, { ...readJson(stateFile), failed: { part, commit, at: new Date().toISOString(), error: String(e.message ?? e).slice(0, 300) } });
    throw e;
  };
  try {
    step('Installing packages', npm, ['ci', '--no-audit', '--no-fund', '--prefer-offline'], opts);
  } catch (e) {
    failed('packages', e);
  }
  if (todo.functions) {
    try {
      step(`Deploying the Convex functions at ${short}`, npx, ['convex', 'deploy', '--typecheck', 'enable'], opts);
    } catch (e) {
      failed('functions', e);
    }
    writeJson(stateFile, { ...readJson(stateFile), functions: { tree: want.functions, commit, at: new Date().toISOString() }, failed: undefined });
  }
  if (todo.site) {
    try {
      step(`Uploading the website at ${short}`, npx, ['static-hosting', 'upload', '--build', '--build-command', 'npm run web:build', '--dist', 'web/dist', ...prodArgs(admin)], opts);
    } catch (e) {
      failed('website', e);
    }
    writeJson(stateFile, { ...readJson(stateFile), site: { tree: want.site, commit, at: new Date().toISOString(), ...(siteUrl ? { url: siteUrl } : {}) }, failed: undefined });
  }
  say(`Backend deployed at ${short} (${what}).`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
