// `threadbear setup`: sets Threadbear up on this Mac from a clone of the repo
// (docs/setup-and-updates.md section 2.2). Every step looks at what's already
// there first, so running it again only does what's missing, and --dry-run
// says what it would do without doing any of it.
//
//   ./threadbear setup [--dry-run] [--yes] [--team SLUG] [--project NAME]
//                      [--region REGION] [--cwd DIR] [--name NAME]
//                      [--home DIR] [--skip-install] [--existing]
//                      [--self-hosted]
//
// Convex cloud is the default, and the one we recommend: it keeps working
// while your Mac sleeps, sends phone notifications, and needs nothing else
// installed. --self-hosted runs Convex's open source backend in Docker on
// this Mac instead, reached over Tailscale (docs/self-hosting.md). With it
// you lose phone notifications, the phone needs Tailscale on, nothing works
// while this Mac sleeps, and share links only open on your tailnet.
//
//   1. this Mac: macOS, Xcode's command line tools, git, Node 24, Claude Code
//      or Codex, and Tailscale (optional)
//   2. your copy: a fork of Mike's repo, with his as `upstream`, and the
//      key his releases are signed with pinned in the data folder
//      (docs/setup-and-updates.md section 2.3)
//   3. the repo's packages
//   4. a Convex login, then a Convex project of your own with a production
//      deployment (a new one, or the one this clone already uses). With
//      --self-hosted: Convex's backend and dashboard in Docker, served on
//      this Mac's tailnet name with `tailscale serve`
//   5. its keys: a deploy key the runner uses to deploy the backend when it
//      updates (self-hosted: the backend's admin key), and the main key,
//      set as RUNNER_KEY
//   With --existing (a second Mac joining a Threadbear another Mac set up),
//   and on a Mac that already has a runner key, steps 4, 5 and 7 are
//   skipped: no Convex login, deploy key or backend deploy here, since each
//   can do anything to the deployment. Its key comes from the first Mac:
//   tb runner add <name> --ssh <this Mac> (docs/protocol.md, "Runner keys").
//   6. runner.json: where the runner mirrors to, and the default folder for
//      new threads (~/ThreadbearThreads, made here, unless --cwd; Settings changes it)
//   7. the backend and the website, deployed
//   8. the runner (its LaunchAgent, with Threadbear Runner.app as the
//      program, so macOS's privacy prompts name it) and the Mac app, built
//      and installed
//   9. where to pair your iPhone and sign a browser in (the app's Settings)
//
// Node built-ins only, so it runs before the repo's packages are installed.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isJoining, runnerKeyPlan } from './runner-key-plan.mjs';
import { ConvexAdminError, convexEnv, readConvexAdmin, SELF_HOSTED_ENV_FILE } from '../runner/src/convex-admin.ts';

const repo = path.resolve(import.meta.dirname, '..');
// Where new threads start: a folder of their own, not the home folder, and
// not ~/Threadbear, which on macOS is the same folder as a ~/threadbear clone.
const THREADS_FOLDER = '~/ThreadbearThreads';

// Whether a folder is this repo or inside it, as macOS sees it: names
// compared without case, through links where the folder exists.
function insideRepo(folder) {
  const abs = path.resolve(folder.replace(/^~(?=$|\/)/, os.homedir()));
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const a = real(abs).toLowerCase();
  const r = real(repo).toLowerCase();
  return a === r || a.startsWith(r + path.sep);
}
const DEFAULT_HOME = path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear');

const { values: v } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    team: { type: 'string' },
    project: { type: 'string', default: 'threadbear' },
    region: { type: 'string' },
    cwd: { type: 'string' },
    name: { type: 'string' },
    home: { type: 'string' },
    'skip-install': { type: 'boolean' },
    existing: { type: 'boolean' },
    'self-hosted': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (v.help) {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(0, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const dry = Boolean(v['dry-run']);
const home = path.resolve((v.home ?? process.env.THREADBEAR_HOME ?? DEFAULT_HOME).replace(/^~(?=$|\/)/, os.homedir()));
const secrets = path.join(home, 'secrets');
const runnerJsonPath = path.join(home, 'runner.json');
const deployKeyFile = path.join(secrets, 'convex-deploy.env');
const selfHostedFile = path.join(secrets, SELF_HOSTED_ENV_FILE);
const runnerKeyFile = path.join(secrets, 'convex-key');
const npx = path.join(path.dirname(process.execPath), 'npx');
const localKey = (() => {
  try {
    return fs.readFileSync(runnerKeyFile, 'utf8').trim();
  } catch {
    return '';
  }
})();
// A Mac joining another's Threadbear, by the flag or by the runner key it
// already has (setup run again there without the flag).
const joining = isJoining({ existing: v.existing, local: localKey });
// Self-hosted by the flag, or by an earlier self-hosted setup (its admin key
// is here), so running setup again without the flag carries on the same way.
// A Mac joining another's Threadbear has no backend of its own either way.
const selfHosted = !joining && (Boolean(v['self-hosted']) || fs.existsSync(selfHostedFile));
const npm = path.join(path.dirname(process.execPath), 'npm');

class Fail extends Error {}
const say = (s = '') => console.log(s);
const ok = (s) => say(`  ✓ ${s}`);
const todo = (s) => say(`  → ${s}`);
const note = (s) => say(`  · ${s}`);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', ...opts });
}
function runOrFail(what, cmd, args, opts = {}) {
  const r = run(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Fail(`${what} failed (${cmd} ${args.join(' ')}).`);
  return r;
}
function has(cmd) {
  return run('/bin/zsh', ['-lc', `command -v ${cmd}`]).status === 0;
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}
function writeSecret(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
// The deploy key, read and never printed; its "prod:<name>|" prefix names the deployment.
function deployKey() {
  try {
    const key = fs.readFileSync(deployKeyFile, 'utf8').match(/^CONVEX_DEPLOY_KEY=["']?([^"'\n]+)/m)?.[1];
    return key ? { key, name: key.match(/^[a-z]+:([a-z0-9-]+)\|/)?.[1] } : undefined;
  } catch {
    return undefined;
  }
}
// This Mac's admin credential for the backend (runner/src/convex-admin.ts):
// the deploy key, or a self-hosted backend's admin key.
function admin() {
  try {
    return readConvexAdmin(home);
  } catch (e) {
    if (e instanceof ConvexAdminError) throw new Fail(e.message);
    throw e;
  }
}
// Convex commands against the production deployment (or the self-hosted
// backend), picked by this Mac's admin credential alone so a stray
// CONVEX_DEPLOYMENT or .env.local can't point them anywhere else.
function adminEnv() {
  return convexEnv(admin());
}


// ------------------------------------------------------------ the steps

function checkMac() {
  say('1. This Mac');
  if (process.platform !== 'darwin') throw new Fail('Threadbear runs on macOS.');
  // os.release() is the Darwin version (25.x on macOS 26), so ask sw_vers for the one people know.
  const macos = run('sw_vers', ['-productVersion']).stdout?.trim() || `Darwin ${os.release()}`;
  ok(`macOS ${macos} on ${os.arch()}`);
  if (run('xcode-select', ['-p']).status !== 0) throw new Fail("Xcode's command line tools aren't installed. Run: xcode-select --install");
  ok("Xcode's command line tools");
  if (!has('git')) throw new Fail('git is missing.');
  ok('git');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Fail(`Node ${process.versions.node} is too old; Threadbear needs 24 or newer.`);
  ok(`Node ${process.versions.node} (${process.execPath})`);
  const claude = fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'claude')) || has('claude');
  const codex = has('codex');
  if (!claude && !codex) throw new Fail('Neither Claude Code nor Codex is installed. Install one and log in first: https://claude.com/claude-code or https://developers.openai.com/codex');
  ok([claude && 'Claude Code', codex && 'Codex'].filter(Boolean).join(' and '));
  // The runner is a login agent, which macOS only loads for someone logged in
  // to the desktop: over SSH to a Mac nobody's logged in to, step 8 can't
  // finish (seen on Tinker Desk, 28 Oct).
  if (desktopSession()) ok('logged in to the desktop');
  else note("Nobody is logged in to this Mac's desktop. Everything up to installing the runner works, then setup stops: log in (in person or with Screen Sharing) and run it again.");
  if (fs.existsSync('/Applications/Tailscale.app') || has('tailscale')) ok('Tailscale');
  else note("Tailscale isn't installed. Threadbear works without it, and so does a second Mac; it only adds a direct link between your machines (https://tailscale.com/download).");
}

function desktopSession() {
  return run('launchctl', ['print', `gui/${process.getuid()}`]).status === 0;
}

// Mike's repo, which everyone else's copy follows for his releases.
const MIKES_REPO = 'https://github.com/mikecann/threadbear.git';
const repoKey = (url) => url.trim().replace(/^git@([^:]+):/, '$1/').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();

function remoteUrl(name) {
  const r = run('git', ['remote', 'get-url', name]);
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// A fork, not a clone (Mike, 29 Oct): their changes need somewhere of their
// own to live, and `upstream` is where Mike's releases come from. With no
// GitHub login it still works: origin becomes upstream, and their changes
// stay on this Mac until they fork.
function yourCopy() {
  say('2. Your copy');
  const origin = remoteUrl('origin');
  const upstream = remoteUrl('upstream');
  const mikes = repoKey(MIKES_REPO);
  if (upstream) ok(`Mike's releases come from upstream (${upstream})`);
  else if (origin && repoKey(origin) === mikes) {
    // Only a zero exit is a login: with an expired token gh prints the 401's JSON, which once
    // became the "username" and then failed the fork (Tinker Desk, 5 Nov 2026).
    const ghUser = has('gh') ? run('gh', ['api', 'user', '--jq', '.login']) : undefined;
    const login = ghUser?.status === 0 ? ghUser.stdout.trim() : '';
    if (login === 'mikecann') ok("this is Mike's own repo");
    else if (dry) todo(login ? `gh repo fork --remote: fork it to ${login}'s GitHub, origin becomes the fork and upstream Mike's` : "git remote rename origin upstream (no GitHub login, so no fork)");
    else if (login) {
      runOrFail('Forking the repo', 'gh', ['repo', 'fork', '--remote', '--remote-name', 'origin']);
      ok(`forked to ${login}'s GitHub as origin; Mike's repo is upstream`);
    } else {
      runOrFail('Renaming origin to upstream', 'git', ['remote', 'rename', 'origin', 'upstream']);
      ok("Mike's repo is upstream");
      note('Not logged in to GitHub, so this copy has no fork of its own. To keep your changes on GitHub later: gh auth login --web, then gh repo fork --remote --remote-name origin');
    }
  } else if (origin) {
    if (dry) todo(`git remote add upstream ${MIKES_REPO}`);
    else {
      runOrFail('Adding upstream', 'git', ['remote', 'add', 'upstream', MIKES_REPO]);
      ok(`upstream is Mike's repo; origin (${origin}) is yours`);
    }
  } else note("This copy has no git remote, so it won't hear about Mike's releases. Add his repo with: git remote add upstream " + MIKES_REPO);

  // The pinned copy is the one the runner trusts; a later change to the
  // repo's copy never replaces it (runner/src/upstream.ts).
  const pinned = path.join(home, 'upstream-signers');
  const shipped = path.join(repo, 'scripts', 'release-signers');
  if (!fs.existsSync(shipped)) return note("this copy has no scripts/release-signers, so Mike's releases can't be checked");
  if (fs.existsSync(pinned)) {
    if (fs.readFileSync(pinned, 'utf8') !== fs.readFileSync(shipped, 'utf8')) note(`the release key in scripts/release-signers differs from the one pinned at ${pinned}; keeping the pinned one`);
    return ok("Mike's release key is pinned");
  }
  if (dry) return todo(`pin Mike's release key at ${pinned}`);
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(shipped, pinned);
  ok(`Mike's release key pinned at ${pinned}`);
}

function packages() {
  say('3. Packages');
  if (fs.existsSync(path.join(repo, 'node_modules', 'convex'))) return ok('installed');
  if (dry) return todo('npm ci');
  runOrFail('npm ci', npm, ['ci', '--no-audit', '--no-fund']);
  ok('installed');
}

function convexLogin() {
  say('4. Convex');
  const config = readJson(path.join(os.homedir(), '.convex', 'config.json'));
  if (config.accessToken) ok('logged in to Convex');
  else if (dry) todo('npx convex login (opens the browser)');
  else {
    // Opens the browser and waits for the approval there, with no questions
    // in the terminal, so an agent can run setup too (INSTALL.md).
    runOrFail('Logging in to Convex', npx, ['convex', 'login', '--device-name', os.hostname().split('.')[0], '--login-flow', 'poll']);
    ok('logged in to Convex');
  }
}

// The production deployment's URL. Read from runner.json when setup has
// already run; otherwise made here.
async function project() {
  const json = readJson(runnerJsonPath);
  const key = deployKey();
  if (json.sync?.url && key) {
    ok(`using ${json.sync.url}`);
    return json.sync.url;
  }
  const selected = fs.existsSync(path.join(repo, '.env.local')) && /CONVEX_DEPLOYMENT=/.test(fs.readFileSync(path.join(repo, '.env.local'), 'utf8'));
  if (!selected) {
    const verb = v.existing ? 'use the existing' : 'create a';
    if (dry) {
      todo(`${verb} Convex project "${v.project}"${v.team ? ` on team ${v.team}` : ''} with a dev deployment`);
      const teams = v.team ? [] : convexTeams();
      if (teams.length > 1) note(`your Convex login has ${teams.length} teams, so the real run needs --team and one of: ${teams.map((t) => `${t.slug} (${t.name})`).join(', ')}`);
      return undefined;
    }
    const args = ['convex', 'dev', '--once', '--configure', v.existing ? 'existing' : 'new', '--project', v.project, '--dev-deployment', 'cloud'];
    const team = v.team ?? onlyTeam();
    if (team) args.push('--team', team);
    runOrFail(v.existing ? 'Selecting the Convex project' : 'Creating the Convex project', npx, args);
    ok(`project ${v.project}`);
  } else ok('this clone already has a Convex project (.env.local)');
  if (dry) return todo(`create its production deployment${(v.region ?? nearestRegion()) ? ` in ${v.region ?? nearestRegion()}` : ''}`), undefined;
  const args = ['convex', 'deployment', 'create', 'production', '--type', 'prod', '--default'];
  const region = v.region ?? nearestRegion();
  if (region) args.push('--region', region);
  const made = run(npx, args);
  const text = `${made.stdout}\n${made.stderr}`;
  let url = text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)?\.convex\.cloud/)?.[0];
  if (!url) {
    // It may exist already (a second run after a failure): find its URL from the key.
    note('the production deployment may already exist; looking for it');
  }
  return url;
}

async function keys(urlFromProject) {
  say('5. Keys');
  if (selfHosted) ok(`the self-hosted backend's admin key, in ${selfHostedFile}`);
  else if (!deployKey()) {
    if (dry) todo(`a deploy key in ${deployKeyFile}`);
    else {
      fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
      const keyName = `threadbear-runner-${os.hostname().split('.')[0].toLowerCase()}`;
      runOrFail('Making a deploy key', npx, ['convex', 'deployment', 'token', 'create', keyName, '--prod', '--save-env', deployKeyFile]);
      fs.chmodSync(deployKeyFile, 0o600);
      // By name, so tb runner rotate-owner knows this one is this Mac's own.
      fs.appendFileSync(path.join(secrets, 'made-deploy-keys'), keyName + '\n', { mode: 0o600 });
      ok(`deploy key saved in ${deployKeyFile}`);
    }
  } else ok('deploy key');
  const key = selfHosted ? (dry ? undefined : admin()) : deployKey();
  let url = urlFromProject ?? readJson(runnerJsonPath).sync?.url;
  if (!url && key?.name) url = await findUrl(key.name);
  if (!dry && !url) throw new Fail("Couldn't work out the production deployment's URL. Put it in runner.json as sync.url and run setup again.");
  // The deployment's RUNNER_KEY is the main key, which can do everything:
  // one that's already set wins, never replaced, or the Macs using it would
  // be locked out. Only a deployment without one gets a new key. A Mac
  // joining with --existing gets a runner key of its own instead (since
  // 5 Nov 2026), so it can't write the first Mac's threads or pair phones.
  if (dry) {
    if (fs.existsSync(runnerKeyFile)) ok('runner key');
    else todo("the runner key: the deployment's own if it has one, else a new one set as RUNNER_KEY");
  }
  if (!dry && key) {
    const got = run(npx, ['convex', 'env', 'get', 'RUNNER_KEY'], { env: adminEnv() });
    const existing = (got.stdout ?? '').trim();
    const local = fs.existsSync(runnerKeyFile) ? fs.readFileSync(runnerKeyFile, 'utf8').trim() : '';
    const nextGet = run(npx, ['convex', 'env', 'get', 'RUNNER_KEY_NEXT'], { env: adminEnv() });
    const plan = runnerKeyPlan({ envGet: got, nextGet, local, joining });
    if (plan.action === 'fail') throw new Fail(plan.why);
    if (plan.action === 'joined') ok("runner key: this Mac's own, left as it is");
    else if (plan.action === 'keep') ok('runner key');
    else if (plan.action === 'copy') {
      writeSecret(runnerKeyFile, existing);
      ok(local ? "runner key: using the deployment's (it already had one)" : 'runner key');
    } else {
      const fresh = local || crypto.randomBytes(32).toString('hex');
      if (!local) writeSecret(runnerKeyFile, fresh);
      const r = spawnSync(npx, ['convex', 'env', 'set', 'RUNNER_KEY'], { cwd: repo, env: adminEnv(), input: fresh, encoding: 'utf8' });
      if (r.status !== 0) throw new Fail('Setting RUNNER_KEY on the deployment failed.');
      ok('runner key set as RUNNER_KEY');
    }
  }
  return url;
}

// The Convex region nearest this Mac, from its time zone, so the phone and
// the website aren't a round trip across the world away (an agent-run install
// on Tinker Desk landed in the US default, 28 Oct). Undefined leaves Convex's
// default (the US). --region overrides it.
function nearestRegion() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  if (/^(Australia|Pacific\/(Auckland|Fiji|Guam|Port_Moresby)|Asia\/(Singapore|Jakarta|Makassar|Jayapura|Manila|Tokyo|Seoul|Hong_Kong|Shanghai|Taipei|Kuala_Lumpur|Bangkok|Ho_Chi_Minh))/.test(zone)) return 'aws-ap-southeast-2';
  if (/^(Europe|Africa|Atlantic\/(Reykjavik|Canary|Madeira|Azores))/.test(zone)) return 'aws-eu-west-1';
  return undefined;
}

// The team to use when none was given: the only one there is. With several,
// Convex asks in the terminal; with nobody there to answer (an agent), setup
// stops and lists them instead.
// The Convex login's teams, from `convex login status` (which prints the list on stderr). None
// when it isn't logged in yet.
function convexTeams() {
  const r = run(npx, ['convex', 'login', 'status']);
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return [...out.matchAll(/^\s+- (.+) \(([^)]+)\)$/gm)].map((m) => ({ name: m[1], slug: m[2] }));
}

function onlyTeam() {
  const teams = convexTeams();
  if (teams.length === 1) return teams[0].slug;
  if (process.stdin.isTTY && !v.yes) return undefined;
  throw new Fail(`Your Convex login has ${teams.length} teams. Run setup again with --team and one of: ${teams.map((t) => `${t.slug} (${t.name})`).join(', ')}.`);
}

// Probes the regions Convex runs in for a deployment's URL.
async function findUrl(name) {
  for (const region of ['', 'ap-southeast-2.', 'eu-west-1.', 'us-east-1.', 'us-west-2.']) {
    const url = `https://${name}.${region}convex.cloud`;
    try {
      const res = await fetch(`${url}/version`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return url;
    } catch {
      // not this one
    }
  }
  return undefined;
}

// ------------------------------------------------- a self-hosted backend
//
// Convex's open source backend and dashboard in Docker (docs/self-hosting.md),
// each published on this Mac's loopback only, and served to the tailnet with
// `tailscale serve` on ports of their own, so nothing listens on the LAN and
// 443 stays free for whatever already uses it. The backend fetches its own
// stored files through CONVEX_CLOUD_ORIGIN, so the container is told the
// tailnet name's address (--add-host) to reach itself the same way.

// Pinned, as an upgrade can need an export and import (Convex's
// self-hosted/advanced/upgrading.md); move it on deliberately.
const CONVEX_IMAGE_TAG = 'd1fcbeaf939502a23a0f4b7e9095a12e84866294';
const BACKEND_IMAGE = `ghcr.io/convex/convex-backend:${CONVEX_IMAGE_TAG}`;
const DASHBOARD_IMAGE = `ghcr.io/convex/convex-dashboard:${CONVEX_IMAGE_TAG}`;
const BACKEND_CONTAINER = 'threadbear-convex';
const DASHBOARD_CONTAINER = 'threadbear-convex-dashboard';
const DATA_VOLUME = 'threadbear-convex-data';
// Tailnet port, then this Mac's loopback port. Not 3210 on loopback: that's
// where `npx convex dev` runs a local deployment.
const PORTS = { api: [3210, 13210], site: [3211, 13211], dashboard: [6791, 16791] };
const ADMIN_URL = `http://127.0.0.1:${PORTS.api[1]}`;

function docker(args, opts = {}) {
  return run('docker', args, opts);
}

function tailscaleCli() {
  if (has('tailscale')) return 'tailscale';
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return fs.existsSync(app) ? app : undefined;
}

// This Mac on the tailnet: its MagicDNS name and IPv4 address.
function tailnetSelf() {
  const ts = tailscaleCli();
  if (!ts) throw new Fail('A self-hosted backend is reached over Tailscale, which isn\'t installed. Install it (https://tailscale.com/download), log in, and run setup again. Or leave out --self-hosted and use Convex cloud, which we recommend.');
  const r = run(ts, ['status', '--json']);
  let st;
  try {
    st = JSON.parse(r.stdout);
  } catch {
    st = undefined;
  }
  const name = st?.Self?.DNSName?.replace(/\.$/, '');
  const ip = st?.Self?.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (r.status !== 0 || st?.BackendState !== 'Running' || !name || !ip) throw new Fail("Tailscale isn't logged in and running on this Mac. Open Tailscale, log in, and run setup again.");
  if (!st?.CurrentTailnet?.MagicDNSSuffix && !name.endsWith('.ts.net')) throw new Fail('Turn on MagicDNS for your tailnet (Tailscale admin console › DNS), then run setup again: the phone finds the backend by this Mac\'s tailnet name.');
  return { ts, name, ip };
}

function checkDocker() {
  if (!has('docker')) throw new Fail('A self-hosted backend runs in Docker, which isn\'t installed. Install Docker Desktop or OrbStack, start it, and run setup again. Or leave out --self-hosted and use Convex cloud, which we recommend.');
  if (docker(['info', '--format', '{{.ServerVersion}}']).status !== 0) throw new Fail("Docker is installed but not running. Start Docker Desktop (or OrbStack), and set it to start when you log in, as the backend stops with it. Then run setup again.");
}

// The label setup puts on each container: a hash of everything it was run
// with (image, env, ports, volume, --add-host), so a container someone
// changed or made another way, or one from before the Mac was renamed or got
// a new tailnet address, is never taken for this one.
const CONFIG_LABEL = 'app.threadbear.config';

function containerState(name) {
  // Guarded, as indexing a container's null Labels fails the whole template.
  const r = docker(['inspect', '--format', `{{.State.Running}}|{{if .Config.Labels}}{{index .Config.Labels "${CONFIG_LABEL}"}}{{end}}`, name]);
  if (r.status !== 0) return undefined;
  const [running, label] = r.stdout.trim().split('|');
  return { running: running === 'true', label };
}

// A container with exactly these settings, running. One left from an earlier
// run with other settings (the Mac renamed, a new image) is made again; the
// data is in the volume, so nothing's lost.
function ensureContainer(name, image, want, runArgs) {
  const env = Object.entries(want).flatMap(([k, val]) => ['-e', `${k}=${val}`]);
  const config = crypto.createHash('sha256').update(JSON.stringify([image, runArgs, env])).digest('hex').slice(0, 16);
  const have = containerState(name);
  const same = have?.label === config;
  if (same && have.running) return ok(`${name} is running`);
  if (dry) return todo(same ? `docker start ${name}` : `docker run ${name} (${image})`);
  // One that won't start is made again too: after Docker stopped uncleanly,
  // its old container can fail with "failed to start shim ... file exists"
  // (Tinker Desk, 7 Nov 2026), and a new one on the same volume is fine. So
  // running setup again is the fix for a backend that won't come up.
  if (same) {
    if (docker(['start', name]).status === 0) return ok(`${name} started`);
    note(`${name} wouldn't start; making it again${name === BACKEND_CONTAINER ? ` (your data is kept, in the ${DATA_VOLUME} volume)` : ''}`);
    docker(['rm', '-f', name]);
  } else if (have) {
    note(`${name} has older settings; making it again${name === BACKEND_CONTAINER ? ` (your data is kept, in the ${DATA_VOLUME} volume)` : ''}`);
    docker(['rm', '-f', name]);
  }
  const r = docker(['run', '-d', '--name', name, '--restart', 'unless-stopped', '--label', `${CONFIG_LABEL}=${config}`, ...runArgs, ...env, image], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Fail(`Starting the ${name} container failed.`);
  ok(`${name} running`);
}

// `tailscale serve` for one port, unless it's already serving that port:
// the same target is fine, anything else is someone else's and is left alone.
function serve(ts, tailnetPort, localPort) {
  const target = `http://127.0.0.1:${localPort}`;
  const st = run(ts, ['serve', 'status', '--json']);
  let cfg = {};
  try {
    cfg = JSON.parse(st.stdout || '{}');
  } catch {
    // no config yet
  }
  const handlers = Object.entries(cfg.Web ?? {}).filter(([hostPort]) => hostPort.endsWith(`:${tailnetPort}`)).flatMap(([, w]) => Object.values(w.Handlers ?? {}));
  if (handlers.length) {
    if (handlers.every((h) => h.Proxy?.replace(/\/$/, '') === target)) return ok(`tailnet port ${tailnetPort} serves ${target}`);
    throw new Fail(`Tailscale already serves something else on port ${tailnetPort} of this Mac (tailscale serve status). Take it off (tailscale serve --https=${tailnetPort} off) and run setup again.`);
  }
  if (dry) return todo(`tailscale serve --bg --https=${tailnetPort} ${target}`);
  if (run(ts, ['serve', '--bg', `--https=${tailnetPort}`, target]).status !== 0) throw new Fail(`tailscale serve on port ${tailnetPort} failed. If it asks you to enable HTTPS for your tailnet, do that in the Tailscale admin console (DNS › HTTPS certificates) and run setup again.`);
  ok(`tailnet port ${tailnetPort} serves ${target}`);
}

async function waitForBackend() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${ADMIN_URL}/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Fail(`The backend didn't answer at ${ADMIN_URL} within a minute. docker logs ${BACKEND_CONTAINER} says why.`);
}

// The Convex CLI against the self-hosted backend, from an empty folder so a
// checkout's .env.local (which names a dev deployment) can't take part.
function selfHostedConvex(args, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-convex-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tb-convex-env', private: true, dependencies: { convex: '*' } }));
  try {
    return spawnSync(process.execPath, [path.join(repo, 'node_modules', 'convex', 'bin', 'main.js'), ...args], { cwd: dir, env: adminEnv(), input, encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function selfHostedBackend() {
  say('4. Self-hosted backend (Convex cloud is the one we recommend: docs/self-hosting.md)');
  if (fs.existsSync(deployKeyFile)) throw new Fail(`This Mac is already set up with Convex cloud (${deployKeyFile}). Setup doesn't move a Threadbear between backends; leave out --self-hosted to carry on with cloud.`);
  checkDocker();
  ok('Docker');
  const { ts, name, ip } = tailnetSelf();
  ok(`Tailscale: this Mac is ${name}`);
  const origin = (port) => `https://${name}:${port}`;
  const url = origin(PORTS.api[0]);
  const site = origin(PORTS.site[0]);
  const dashboard = origin(PORTS.dashboard[0]);
  if (!dry) {
    for (const image of [BACKEND_IMAGE, DASHBOARD_IMAGE]) {
      if (docker(['image', 'inspect', image]).status === 0) continue;
      say(`  · pulling ${image}`);
      if (docker(['pull', '-q', image], { stdio: ['ignore', 'ignore', 'inherit'] }).status !== 0) throw new Fail(`docker pull ${image} failed.`);
    }
  }
  ensureContainer(BACKEND_CONTAINER, BACKEND_IMAGE, { CONVEX_CLOUD_ORIGIN: url, CONVEX_SITE_ORIGIN: site, DISABLE_BEACON: 'true' }, [
    '-p', `127.0.0.1:${PORTS.api[1]}:3210`, '-p', `127.0.0.1:${PORTS.site[1]}:3211`,
    '-v', `${DATA_VOLUME}:/convex/data`, '--add-host', `${name}:${ip}`,
  ]);
  ensureContainer(DASHBOARD_CONTAINER, DASHBOARD_IMAGE, { NEXT_PUBLIC_DEPLOYMENT_URL: url }, ['-p', `127.0.0.1:${PORTS.dashboard[1]}:6791`]);
  for (const [tailnetPort, localPort] of Object.values(PORTS)) serve(ts, tailnetPort, localPort);
  if (dry) {
    if (!fs.existsSync(selfHostedFile)) todo(`the backend's admin key, in ${selfHostedFile}`);
    todo('PUSH_RELAY=off on the backend (the push relay only reaches Convex cloud)');
    return { url, site, dashboard };
  }
  await waitForBackend();
  if (!fs.existsSync(selfHostedFile)) {
    // generate_admin_key.sh prints "Admin key:" and the key; only the key is kept, never printed.
    const r = docker(['exec', BACKEND_CONTAINER, './generate_admin_key.sh']);
    const key = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
    if (r.status !== 0 || !key?.includes('|')) throw new Fail(`Couldn't make the backend's admin key (docker exec ${BACKEND_CONTAINER} ./generate_admin_key.sh).`);
    // Quoted, as the key has a "|" in it: a shell can source the file as it is.
    writeSecret(selfHostedFile, `CONVEX_SELF_HOSTED_URL='${ADMIN_URL}'\nCONVEX_SELF_HOSTED_ADMIN_KEY='${key}'\n`);
    ok(`admin key saved in ${selfHostedFile}`);
  } else ok('admin key');
  // Notifications would only fail: the relay checks a backend by calling it
  // back on a Convex host (relay/convex/verify.ts). Off, the phone and the
  // Mac say there are none, rather than going quiet (convex/pushHealth.ts).
  const pushSet = selfHostedConvex(['env', 'set', 'PUSH_RELAY', 'off']);
  if (pushSet.status !== 0) throw new Fail(`Setting PUSH_RELAY=off on the backend failed: ${(pushSet.stderr || '').trim().slice(0, 300)}`);
  ok('phone notifications off (the push relay only reaches Convex cloud)');
  return { url, site, dashboard };
}

async function runnerJson(url, site) {
  say('6. runner.json');
  const json = readJson(runnerJsonPath);
  const name = v.name ?? json.sync?.name ?? os.hostname().split('.')[0];
  // Not asked: it's in the Mac app's Settings, and each new thread can pick
  // its own folder anyway. --cwd sets it here. The default is a folder of its
  // own rather than the home folder: an agent searching home reaches Dropbox,
  // Desktop and Documents, and macOS stops everything to ask about each
  // (Mike's first thread on Tinker Desk, 28 Oct).
  let cwd = v.cwd ?? json.defaults?.cwd ?? THREADS_FOLDER;
  // Not inside this repo: a thread there gets the repo's patches and a
  // worktree each. macOS ignores case, so the ~/Threadbear this used to
  // make was the ~/threadbear clone itself (Tinker Desk, 30 Oct). One
  // saved by an older setup moves; one given with --cwd is said.
  if (insideRepo(cwd)) {
    if (v.cwd) note(`${cwd} is inside this repo, so threads there get its patches and a worktree each.`);
    else cwd = THREADS_FOLDER;
  }
  const cwdPath = cwd.replace(/^~(?=$|\/)/, os.homedir());
  if (!dry && !fs.existsSync(cwdPath)) fs.mkdirSync(cwdPath, { recursive: true });
  const next = { ...json, sync: { ...json.sync, ...(url ? { url } : {}), ...(site ? { site } : {}), name }, defaults: { ...json.defaults, cwd } };
  if (JSON.stringify(next) === JSON.stringify(json)) return ok(`${runnerJsonPath} as it was`);
  if (dry) return todo(`write ${runnerJsonPath}: sync.url ${url ?? '(the new deployment)'}${site ? `, sync.site ${site}` : ''}, sync.name ${name}, defaults.cwd ${cwd}`);
  writeJson(runnerJsonPath, next);
  ok(`mirrors to ${url} as ${name}; new threads start in ${cwd}`);
}

function backend() {
  say('7. Backend and website');
  if (dry) return todo('node runner/scripts/deploy-backend.mjs (deploys convex/ and web/ if they changed)');
  runOrFail('Deploying the backend', process.execPath, [path.join(repo, 'runner', 'scripts', 'deploy-backend.mjs'), '--home', home, '--repo', repo]);
}

function install() {
  say('8. Runner and Mac app');
  if (v['skip-install']) return note('skipped (--skip-install)');
  if (dry) return todo('runner/scripts/install-runner.sh, then app/install.sh');
  if (!desktopSession()) throw new Fail("Nobody is logged in to this Mac's desktop, and macOS only starts the runner (a login agent) for someone who is. Log in, in person or with Screen Sharing, then run setup again.");
  const env = { ...process.env, THREADBEAR_NODE: process.execPath };
  const homeArgs = path.resolve(home) === DEFAULT_HOME ? [] : ['--home', home];
  runOrFail('Installing the runner', 'bash', [path.join(repo, 'runner', 'scripts', 'install-runner.sh'), ...homeArgs], { env });
  runOrFail('Installing the Mac app', 'bash', [path.join(repo, 'app', 'install.sh')], { env });
  // A Mac joining a Threadbear you already use: you know your way round,
  // so the app's first-run tour stays away (Help > Take the Tour still has it).
  if (joining) run('defaults', ['write', 'com.mikerosoft.threadbear', 'tourSeen', '-bool', 'YES']);
  ok('runner and app installed');
}

function joined() {
  say('9. Join your first Mac');
  const host = os.hostname().replace(/\.local$/, '');
  note(`On your first Mac, run: tb runner add ${v.name ?? host} --ssh ${host}`);
  note("It gives this Mac's runner a key of its own and the deployment's address, over ssh. Then restart the runner here (tb restart) and its threads show on your phone and your first Mac.");
  note('tb runner check (here) says if a deploy key or Convex login from an earlier setup is still on this Mac, which you should remove.');
}

function finish(url, sh) {
  say('9. Finish setting up');
  if (sh) {
    note(`Your backend runs in Docker on this Mac, at ${url} on your tailnet; its dashboard is ${sh.dashboard} (log in with the admin key in ${selfHostedFile}).`);
    note('Self-hosted means: no phone notifications, the phone needs Tailscale on, nothing works while this Mac sleeps or Docker is stopped, and share links only open on your tailnet. Convex cloud has none of those limits (docs/self-hosting.md).');
  }
  // "From anywhere" isn't true of a self-hosted backend, which is only on the tailnet.
  note(`Open Threadbear for a short tour that ends with your first thread. While it runs, Finish setting up has the rest: pair your iPhone and open your website, to check on your threads ${sh ? 'from anything on your tailnet' : 'from anywhere'}.`);
  note('Pairing and the website are in Settings (⌘,) › Phone & browser too.');
  // The terminal scripts still work, for a Mac with no app window to hand.
  const at = url ?? '<your deployment URL>';
  // These scripts only know Convex cloud addresses; a self-hosted backend pairs from Settings.
  if (!sh) note(`From a terminal instead: swift ios/scripts/pair-qr.swift --prod --url ${at}  and  npm run web:sign-in`);
  // docs/on-your-mac.md, "Who it talks to", has the longer version.
  note('Your threads\' text goes to your own Convex deployment with known secret shapes and values taken out first. That catches what it knows, not everything, and it can\'t read pictures. If a key does leak into a thread, rotate it. `tb status` says what this runner does.');
}

try {
  say(dry ? 'Threadbear setup (dry run: nothing changes)\n' : 'Threadbear setup\n');
  checkMac();
  say();
  yourCopy();
  say();
  packages();
  say();
  let url = readJson(runnerJsonPath).sync?.url;
  let sh;
  if (joining) {
    say('4. Convex: skipped (this Mac joins a Threadbear another Mac set up)');
    note('No Convex login and no deploy key here: either can do anything to the deployment. The first Mac deploys the backend, and gives this one its own key.');
    say();
    say('5. Keys: skipped (its key comes from the first Mac)');
  } else if (selfHosted) {
    sh = await selfHostedBackend();
    say();
    url = await keys(sh.url);
  } else {
    convexLogin();
    const made = await project();
    say();
    url = await keys(made);
  }
  say();
  await runnerJson(url, sh?.site);
  say();
  if (joining) say('7. Backend and website: skipped (the first Mac deploys them)');
  else backend();
  say();
  install();
  say();
  if (joining) joined();
  else finish(url, sh);
  say(dry ? '\nDry run done.' : '\nThreadbear is set up.');
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  console.error(`\n✗ ${e.message}\nFix that and run setup again; it carries on from where it stopped.`);
  process.exit(1);
}
