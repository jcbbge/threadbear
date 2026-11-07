// Deploy keys for the Convex panel (docs/protocol.md, "The Convex panel").
// Convex's embedded dashboard takes a deploy key instead of Mike's Convex
// login, so the runner makes one per deployment with the Convex CLI, on the
// CLI's own login, and keeps it under secrets/. A key never goes into a
// thread's events, the summary or the log: only panels.convexKey's answer.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { CommandOutcome } from './patches.ts';
import { convexCloudUrl, convexDeploymentName, findUp, isConvexProject, parseEnvValue, readEnvValue } from './patches.ts';
import { ErrorCode, RpcError } from './protocol.ts';

export type ConvexKey = { deployment: string; deploymentUrl: string; adminKey: string };
export type ConvexDeploymentChoice = { deployment: string; deploymentUrl: string; label: string };
export type ConvexDeployments = { deployments: ConvexDeploymentChoice[]; note?: string };
// A sign-in started from the panel (`panels.convexLogin`). `url` is the page
// to approve it on, `code` the one that page shows.
export type ConvexLogin = { state: 'idle' | 'waiting' | 'done' | 'failed'; url?: string; code?: string; message?: string };
type Run = (command: string, cwd: string) => Promise<CommandOutcome>;
// 'bad' only when the deployment said the key is no good (revoked).
type CheckKey = (deploymentUrl: string, adminKey: string) => Promise<'ok' | 'bad'>;
export type ConvexKeysOptions = {
  configFile?: string; // the CLI's login, ~/.convex/config.json
  login?: string[]; // the sign-in command, for tests
  checkKey?: CheckKey;
  loginTimeoutMs?: number;
};

// The runner's own Convex CLI (its `convex` dependency, run by its own
// node), never the project's: a project on an older convex package lacks
// `deployment token` and `run --inline-query` (1.32 printed its help
// instead, THREADBEAR-6), and npx would need it installed. It still runs in
// the project's folder, so it finds the project's convex.json and env files.
const convexPackage = createRequire(import.meta.url).resolve('convex/package.json');
const convexBin = path.join(path.dirname(convexPackage), JSON.parse(fs.readFileSync(convexPackage, 'utf8')).bin.convex);
export const CONVEX_CLI = `${shellQuote(process.execPath)} ${shellQuote(convexBin)}`;
export const CONVEX_BIN = convexBin;

// secrets/made-deploy-keys: the names of deploy keys this Mac made, one a line.
export function recordMadeKey(secretsDir: string, name: string): void {
  try {
    fs.appendFileSync(path.join(secretsDir, 'made-deploy-keys'), name + '\n', { mode: 0o600 });
  } catch {
    // Only a convenience for rotate-owner, which then asks Mike to look.
  }
}

export class ConvexKeys {
  // One CLI call per deployment at a time: two panels opening together
  // would otherwise make two keys.
  private pending = new Map<string, Promise<string>>();
  private choices = new Map<string, { until: number; result: Promise<ConvexDeployments> }>();

  private dir: string;
  private run: Run;
  private host: string;
  private opts: ConvexKeysOptions;
  private signIn?: { status: ConvexLogin; started: Promise<ConvexLogin> };

  // `dir` is secrets/convex-panels.
  constructor(dir: string, run: Run, host: string = os.hostname(), opts: ConvexKeysOptions = {}) {
    this.dir = dir;
    this.run = run;
    this.host = host;
    this.opts = opts;
  }

  // The host's short name: in key names, the sign-in's device name and
  // the panel's messages ("The Convex CLI on bruce ...").
  private get shortHost(): string {
    return this.host.split('.')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'mac';
  }

  // Whether the CLI has a login at all, as setup checks it. A login it has
  // can still be expired or revoked: the CLI's own error says so then.
  signedIn(): boolean {
    const file = this.opts.configFile ?? path.join(os.homedir(), '.convex', 'config.json');
    try {
      return !!JSON.parse(fs.readFileSync(file, 'utf8'))?.accessToken;
    } catch {
      return false;
    }
  }

  // A CLI failure in plain words, as an error the app can act on: signed
  // out gets a Sign in button, no access a "sign in as someone else".
  failure(text: string, deployment: string, team?: string): RpcError {
    const said = cliError(text);
    if (!this.signedIn() || SIGNED_OUT.test(text)) {
      return new RpcError(ErrorCode.convexSignedOut,
        `The Convex CLI on ${this.shortHost} isn't signed in to Convex, so it can't open this dashboard. Sign in from the panel, or run npx convex login on ${this.shortHost}.`);
    }
    if (NO_ACCESS.test(text)) {
      return new RpcError(ErrorCode.convexNoAccess,
        `The Convex account signed in on ${this.shortHost} can't reach ${deployment}${team ? `, which is on the team ${team}` : ''}. Sign in with an account on that team, or ask the team's owner to invite you.`);
    }
    return new RpcError(ErrorCode.other, `Couldn't open the dashboard for ${deployment}. The Convex CLI said: ${said}`);
  }

  // Starts a sign-in to Convex on this runner's CLI, or says how the one
  // going is getting on (`check`). The CLI's device flow prints a page and
  // code and waits for them to be approved; the app opens the page on the
  // Mac Mike is at, which needn't be this runner's (Bruce's sign-in is
  // approved from the M5's browser). `force` signs in again over a working
  // login, to switch to an account that can reach the deployment.
  async login(check = false, force = false): Promise<ConvexLogin> {
    if (check || this.signIn?.status.state === 'waiting') return this.signIn ? this.signIn.status : { state: 'idle' };
    const status: ConvexLogin = { state: 'waiting' };
    let ready!: (s: ConvexLogin) => void;
    const started = new Promise<ConvexLogin>((resolve) => { ready = resolve; });
    this.signIn = { status, started };
    const [cmd, ...args] = this.opts.login ?? [process.execPath, convexBin, 'login', '--no-open', '--login-flow', 'poll',
      '--device-name', this.shortHost, ...(force ? ['--force'] : [])];
    const child = spawn(cmd, args, { cwd: os.homedir(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const seen = (chunk: Buffer) => {
      out += chunk.toString();
      const url = /https:\/\/\S+\/device\S*/.exec(out)?.[0];
      if (url && !status.url) {
        status.url = url.replace(/[.,]+$/, '');
        status.code = /user_code=([A-Z0-9-]+)/.exec(status.url)?.[1] ?? /code[^:\n]*:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)?.[1];
        ready({ ...status });
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    // The code expires after five minutes; past that the CLI may hang on.
    const timer = setTimeout(() => child.kill(), this.opts.loginTimeoutMs ?? 6 * 60_000);
    const finish = (ok: boolean, message?: string) => {
      clearTimeout(timer);
      if (status.state !== 'waiting') return;
      status.state = ok ? 'done' : 'failed';
      if (message) status.message = message;
      // A new login can reach other deployments: list them again.
      if (ok) this.choices.clear();
      ready({ ...status });
    };
    child.on('error', (e) => finish(false, `Couldn't start the Convex CLI: ${e.message}`));
    child.on('close', (code, signal) => {
      if (signal) return finish(false, "The sign-in wasn't approved in time. Try again.");
      if (code !== 0) return finish(false, `The sign-in didn't finish. The Convex CLI said: ${cliError(withoutPrompt(out))}`);
      if (!this.signedIn()) return finish(false, 'The Convex CLI finished without signing in.');
      finish(true);
    });
    return started;
  }

  async deployments(folder: string, configured: { deployment: string; deploymentUrl: string }, refresh = false): Promise<ConvexDeployments> {
    const type = readEnvValue(folder, 'CONVEX_DEPLOYMENT')?.split(':')[0];
    const cacheKey = JSON.stringify([folder, configured, type]);
    const cached = this.choices.get(cacheKey);
    if (!refresh && cached && cached.until > Date.now()) return cached.result;
    const result = this.listDeployments(folder, configured, type);
    this.choices.set(cacheKey, { until: Date.now() + 60_000, result });
    return result;
  }

  private async listDeployments(folder: string, configured: { deployment: string; deploymentUrl: string }, type?: string): Promise<ConvexDeployments> {
    const deployments: ConvexDeploymentChoice[] = [{ ...configured,
      label: type === 'dev' ? 'Development' : type === 'prod' ? 'Production' : 'Configured' }];
    const notes: string[] = [];
    const failed: string[] = [];
    // The CLI resolves the project's default dev/prod with its own login.
    // Reading only this built-in URL also preserves regional cloud hosts.
    // No --push, codegen or writes to the project's env files.
    const resolved = await Promise.all(['dev', 'prod'].map(async selector => {
      const label = selector === 'prod' ? 'Production' : 'Development';
      try {
        const out = await this.run(`${CONVEX_CLI} run --inline-query 'process.env.CONVEX_CLOUD_URL' --deployment ${selector} --codegen disable --typecheck disable`, folder);
        if (!out.ok) {
          failed.push(out.text);
          throw new Error(cliError(out.text));
        }
        const url = new URL(JSON.parse(out.text.trim()));
        const deployment = convexDeploymentName(url.hostname.split('.')[0]);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.convex.cloud') || !deployment || url.username || url.password) {
          throw new Error('This deployment has no Convex cloud URL.');
        }
        return { deployment, deploymentUrl: url.origin, label };
      } catch (error) {
        notes.push(`${label}: ${error instanceof Error ? error.message : 'Could not resolve deployment'}`);
        return undefined;
      }
    }));
    for (const choice of resolved) {
      if (!choice) continue;
      const at = deployments.findIndex(d => d.deployment === choice.deployment);
      if (at < 0) deployments.push(choice);
      else deployments[at] = choice;
    }
    // Signed out or no access fails both the same way: say it once, plainly.
    if (failed.length === 2) {
      const why = this.failure(failed[0], configured.deployment);
      if (why.code === ErrorCode.convexSignedOut) return { deployments, note: 'Sign in to Convex to list the project\'s other deployments.' };
      if (why.code === ErrorCode.convexNoAccess) return { deployments, note: 'The signed-in Convex account can\'t reach this project, so only the configured deployment is listed.' };
    }
    return { deployments, ...(notes.length ? { note: notes.join('\n') } : {}) };
  }

  // `at` is the deployment's URL, to check a saved key still works (one
  // revoked in the deployment's settings is replaced by itself), and the
  // team its owner is, for the message when this login can't reach it.
  async key(deployment: string, folder: string, renew = false, at: { deploymentUrl?: string; team?: string } = {}): Promise<string> {
    if (convexDeploymentName(deployment) !== deployment) throw new Error(`"${deployment}" isn't a Convex deployment name.`);
    const file = path.join(this.dir, `${deployment}.json`);
    const saved = readSaved(file);
    if (saved && !renew) {
      const check = this.opts.checkKey ?? checkAdminKey;
      // Only ever sent to the deployment's own convex.cloud address, never
      // to whatever URL a project's env file names.
      const own = at.deploymentUrl && convexCloudUrl(deployment, at.deploymentUrl);
      if (!own || await check(own, saved.adminKey) === 'ok') return saved.adminKey;
    }
    const busy = this.pending.get(deployment);
    if (busy) return busy;
    const made = this.make(deployment, folder, file, saved?.name, at.team).finally(() => this.pending.delete(deployment));
    this.pending.set(deployment, made);
    return made;
  }

  private async make(deployment: string, folder: string, file: string, oldName: string | undefined, team?: string): Promise<string> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    // A new key replaces one that stopped working (or was revoked): take
    // the old one off Convex too, if it's still there. Its failure is fine.
    if (oldName) await this.run(`${CONVEX_CLI} deployment token delete ${oldName} --deployment ${deployment}`, folder);
    // Names are unique on a deployment, so each key gets its own; the host
    // says which Mac's runner made it, in the deployment's settings.
    const name = `threadbear-panel-${this.shortHost}-${crypto.randomBytes(3).toString('hex')}`;
    // --save-env writes the key to a file rather than printing it, so it's
    // never in the command's output (which an error message quotes).
    const scratch = path.join(this.dir, `.new-${deployment}-${crypto.randomBytes(4).toString('hex')}.env`);
    const command = `${CONVEX_CLI} deployment token create ${name} --deployment ${deployment} --save-env ${shellQuote(scratch)}`;
    try {
      const out = await this.run(command, folder);
      const adminKey = fs.existsSync(scratch) ? parseEnvValue(fs.readFileSync(scratch, 'utf8'), 'CONVEX_DEPLOY_KEY') : undefined;
      if (!out.ok || !adminKey) throw this.failure(out.text, deployment, team);
      fs.writeFileSync(file, JSON.stringify({ name, adminKey }) + '\n', { mode: 0o600 });
      // Recorded by name, so tb runner rotate-owner knows this key is this
      // Mac's own when Convex lists it (runner-keys.ts madeDeployKeys).
      recordMadeKey(path.dirname(this.dir), name);
      fs.chmodSync(file, 0o600);
      return adminKey;
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  }
}

// The Convex project folder a thread's panel for `deployment` comes from:
// the thread's own, or one of its projects' folders.
export function convexFolderFor(deployment: string, starts: string[], home: string): string | undefined {
  for (const start of starts) {
    const dir = findUp(start, home, isConvexProject);
    if (dir && convexDeploymentName(readEnvValue(dir, 'CONVEX_DEPLOYMENT')) === deployment) return dir;
  }
  return undefined;
}

function readSaved(file: string): { name: string; adminKey: string } | undefined {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof saved?.name === 'string' && typeof saved?.adminKey === 'string' && saved.adminKey ? saved : undefined;
  } catch {
    return undefined;
  }
}

// What the CLI says when it has no login, or one that's expired or revoked
// (seen with convex 1.48: "Creating a deploy key requires being logged in
// with a personal access token", "401 Unauthorized: MissingAccessToken").
const SIGNED_OUT = /requires being logged in|not logged in|MissingAccessToken|AuthenticationFailed|access token is required|401 Unauthorized|npx convex login/i;
// "You don't have access to the selected project."
const NO_ACCESS = /(don't|do not) have access|not a member|403 Forbidden/i;

// Asks the deployment whether a deploy key still works. Anything but a
// clear no (offline, a slow answer) keeps the saved key: the dashboard
// says so itself if it's wrong, and New deploy key is still there.
async function checkAdminKey(deploymentUrl: string, adminKey: string): Promise<'ok' | 'bad'> {
  try {
    // redirect: 'error', as for every request carrying a key (secure-url.ts):
    // a redirect would hand the key on to wherever it points.
    const res = await fetch(new URL('/api/check_admin_key', deploymentUrl), {
      headers: { Authorization: `Convex ${adminKey}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    return res.status === 401 || res.status === 403 ? 'bad' : 'ok';
  } catch {
    return 'ok';
  }
}

// The sign-in's output past its "visit this page" lines, which aren't why
// it failed.
function withoutPrompt(text: string): string {
  return text.split('\n').filter((l) => !/\/device\b|expires in/.test(l)).join('\n');
}

// The CLI's complaint, without its colours and spinners, short enough for
// the panel to show.
export function cliError(text: string): string {
  const lines = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.replace(/^[\s✖✔⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏-]+/, '').trim())
    .filter(Boolean);
  const joined = lines.slice(-3).join(' ');
  return (joined || 'the Convex CLI gave no reason').slice(0, 400);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
