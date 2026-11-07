// `tb runner add|list|logins|revoke|check|rotate-owner` (docs/protocol.md, "Runner keys"): on the main
// Mac, whose secrets/convex-key is the owner key, makes a key for one other
// runner. That key acts as its runner alone on the backend, so a second Mac
// no longer holds a copy of the key that can do everything. Straight to the
// backend over HTTP, like tb pair it needs no runner.
//
// The plain key is never printed (an agent running tb would have it in its
// transcript, and a thread's transcript can command agents): it goes over
// ssh into the other Mac's secrets/convex-key, or into a file you name.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.ts';
import { CONVEX_BIN } from './convex-keys.ts';
import { convexEnv, readConvexAdmin, SELF_HOSTED_ENV_FILE, type ConvexAdmin } from './convex-admin.ts';
import { convexPoster, forbiddenText, readSyncKey, type Post } from './sync.ts';

type Run = { ok: boolean; out: string; err: string };
type Ssh = (host: string, command: string, input?: string) => Run;
// The Convex CLI with this Mac's deploy key, for rotate-owner's env vars.
type ConvexCli = (args: string[], input?: string) => Run;
// heads: this Mac's runner's threads and their last seq, for the audit (cli.ts asks the runner).
// deployKeys: the deployment's deploy keys as Convex lists them (undefined:
// no way to ask, see listDeployKeys). host: this Mac's short name.
type DeployKey = { name: string; creationTime: number; lastUsedTime?: number | null };
export type RunnerKeyDeps = { post?: Post; ssh?: Ssh; convex?: ConvexCli; userHome?: string; heads?: () => Promise<{ threadId: string; lastSeq: number }[]>; deployKeys?: () => Promise<DeployKey[] | undefined>; host?: string; print?: (s: string) => void; fail?: (s: string) => void; now?: () => number };
type Flags = { ssh?: string; out?: string; id?: string; json?: boolean; finish?: boolean; replace?: boolean; remove?: string[]; snapshot?: string; keysChecked?: boolean; purge?: boolean; lockOut?: string[] };

// Anything another Mac or a runner key wrote, as printed here: no control
// characters or escape sequences (which could rewrite the terminal), no
// zero-width or direction marks, one line, cut short. Never put in a
// command for Mike to run: rows are referred to by number instead.
export function clean(s: unknown, max = 160): string {
  const one = String(s ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// What the Convex panel names its deploy keys (convex-keys.ts make): only a
// name like this from another Mac goes into a command, anything else is
// shown as unrecognised.
const PANEL_KEY = /^threadbear-panel-[a-z0-9-]{1,40}-[0-9a-f]{6}$/;
const DEPLOYMENT = /^[a-z0-9-]{1,64}$/;

// As convex/runnerAccess.ts RUNNER_ID and validRunnerId (a unit test keeps
// them the same): checked as written, never trimmed, so the id this Mac
// compares is the id the backend gets.
export const RUNNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const validRunnerId = (id: string) => RUNNER_ID.test(id) && id !== 'any';

// What a Mac with a runner key shouldn't also have, as any of them can do
// anything to the deployment (read RUNNER_KEY, issue phone tokens, deploy),
// so with one the runner key keeps nothing out: setup's deploy key, the
// Convex panel's cached deploy keys (convex-keys.ts, by name), a Convex CLI
// login, or a self-hosted backend's admin key (setup --self-hosted).
type Admin = { deployEnv: boolean; cliLogin: boolean; panels: string[]; teamToken?: boolean; selfHostedEnv?: boolean };
const hasAdmin = (a: Admin) => a.deployEnv || a.cliLogin || a.panels.length > 0 || Boolean(a.teamToken) || Boolean(a.selfHostedEnv);

function adminAdvice(a: Admin, where: string, url: string): string {
  const deployment = deploymentOf(url);
  const good = a.panels.filter((n) => PANEL_KEY.test(n));
  const odd = a.panels.length - good.length;
  const have = [a.deployEnv && "setup's deploy key (secrets/convex-deploy.env, named threadbear-runner-<that Mac's name>)", ...good.map((n) => `the Convex panel's deploy key ${n}`), odd && `${odd} panel key file${odd === 1 ? '' : 's'} with an unrecognised name (secrets/convex-panels/)`, a.cliLogin && 'a Convex CLI login (~/.convex/config.json)', a.teamToken && 'a Convex team access token (secrets/convex-team-token, which reaches every project on the team)', a.selfHostedEnv && `the self-hosted backend's admin key (secrets/${SELF_HOSTED_ENV_FILE})`].filter(Boolean);
  const settings = deployment ? `https://dashboard.convex.dev/d/${deployment}/settings` : "the deployment's settings in the Convex dashboard";
  const commands = deployment && good.length ? `, or from this Mac: ${good.map((n) => `npx convex deployment token delete ${n} --deployment ${deployment}`).join('; ')}` : '';
  return [
    `${where} also has ${have.join(', ')}. Any of them can do anything to the deployment, so its runner key keeps nothing out, and deleting the files doesn't stop a copy someone already took. In this order:`,
    `  1. Revoke them on Convex's side: the deploy keys in ${settings} (Deploy keys)${commands}.${odd ? ' Look there for any you don\'t recognise too.' : ''}${a.cliLogin ? " The CLI login: in the Convex dashboard's account settings, revoke that Mac's access token (named after its hostname)." : ''}${a.teamToken ? " The team token: in the Convex dashboard's team settings (Access tokens)." : ''}${a.selfHostedEnv ? " A self-hosted admin key can't be revoked on its own: every one comes from the backend's instance secret, so changing that is the only way (docs/self-hosting.md, \"Keys\")." : ''}`,
    `  2. Then remove them there: the files above${a.cliLogin ? ', and npx convex logout' : ''}.`,
    "  3. Then rotate the main key, which they could read: tb runner rotate-owner here. Only the main Mac needs any of these.",
  ].join('\n');
}

function deploymentOf(url: string): string | undefined {
  try {
    const d = new URL(url).hostname.split('.')[0] ?? '';
    return DEPLOYMENT.test(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

// The deployment's deploy keys from Convex's side (its management API,
// GET /v1/deployments/<name>/list_deploy_keys), so rotate-owner doesn't take
// another Mac's word for what it has. It needs a team access token, which
// Mike makes in the Convex dashboard's team settings and gives this one run
// as CONVEX_TEAM_TOKEN: never kept on disk, and Threadbear never reads the
// Convex CLI's own login. Undefined without one; an answer in any other
// shape than a list of { name, creationTime } is an error, never "no keys".
export async function listDeployKeys(url: string, token: string | undefined, fetchFn: typeof fetch = fetch): Promise<DeployKey[] | undefined> {
  const deployment = deploymentOf(url);
  if (!token?.trim() || !deployment) return undefined;
  const res = await fetchFn(`https://api.convex.dev/v1/deployments/${deployment}/list_deploy_keys`, { headers: { Authorization: `Bearer ${token.trim()}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Convex said ${res.status} listing the deployment's deploy keys (is CONVEX_TEAM_TOKEN a team access token for its team?).`);
  const rows = (await res.json().catch(() => undefined)) as unknown;
  const ok = Array.isArray(rows) && rows.every((r) => r && typeof r === 'object' && typeof (r as DeployKey).name === 'string' && typeof (r as DeployKey).creationTime === 'number');
  if (!ok) throw new Error("Convex's list of deploy keys wasn't in the shape expected, so it can't be relied on here.");
  return (rows as DeployKey[]).map((r) => ({ name: r.name, creationTime: r.creationTime, lastUsedTime: typeof r.lastUsedTime === 'number' ? r.lastUsedTime : undefined }));
}

// The deploy keys this Mac made itself, by name, as it recorded them then
// (secrets/made-deploy-keys: setup's and the Convex panel's): the only ones
// rotate-owner takes as this Mac's without Mike looking. A name alone,
// hostname and all, says nothing about where copies of a key are.
export function madeDeployKeys(home: string): Set<string> {
  try {
    return new Set(fs.readFileSync(path.join(home, 'secrets', 'made-deploy-keys'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}


// One look on the other Mac. "checked" at the end, so a look cut short (ssh
// failing, a timeout) is never taken for a clean one.
export const REMOTE_ADMIN_CHECK = [
  'd="$HOME/Library/Application Support/Threadbear/secrets"',
  '[ -e "$d/convex-deploy.env" ] && echo deploy-env',
  '[ -e "$HOME/.convex/config.json" ] && echo cli-login',
  '[ -e "$d/convex-team-token" ] && echo team-token',
  `[ -e "$d/${SELF_HOSTED_ENV_FILE}" ] && echo self-hosted-env`,
  // Only each key's name, never the key: sed picks the "name" field.
  'for f in "$d"/convex-panels/*.json; do [ -e "$f" ] && echo "panel $(sed -n \'s/.*"name":"\\([^"]*\\)".*/\\1/p\' "$f")"; done',
  'echo checked',
].join('; ');

function remoteAdmin(ssh: Ssh, host: string): Admin | undefined {
  const r = ssh(host, REMOTE_ADMIN_CHECK);
  const lines = r.out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!r.ok || lines.at(-1) !== 'checked') return undefined;
  return { deployEnv: lines.includes('deploy-env'), cliLogin: lines.includes('cli-login'), teamToken: lines.includes('team-token'), selfHostedEnv: lines.includes('self-hosted-env'), panels: lines.filter((l) => l.startsWith('panel ')).map((l) => l.slice(6).trim() || '(no name)') };
}

function localAdmin(home: string, userHome: string): Admin {
  const dir = path.join(home, 'secrets', 'convex-panels');
  let panels: string[] = [];
  try {
    panels = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const name = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { name?: unknown }).name;
          return typeof name === 'string' ? name : '(no name)';
        } catch {
          return '(unreadable)';
        }
      });
  } catch {
    // no panel keys
  }
  return { deployEnv: fs.existsSync(path.join(home, 'secrets', 'convex-deploy.env')), cliLogin: fs.existsSync(path.join(userHome, '.convex', 'config.json')), teamToken: fs.existsSync(path.join(home, 'secrets', 'convex-team-token')), selfHostedEnv: fs.existsSync(path.join(home, 'secrets', SELF_HOSTED_ENV_FILE)), panels };
}

// Every ssh to the other Mac, which may have been tampered with: no
// password prompt, and nothing of this Mac's forwarded to it (an agent
// there could use a forwarded ssh agent to log back in here).
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardX11=no'];

// Threadbear's data dir on the other Mac, as that Mac's shell sees it.
const REMOTE_HOME = '"$HOME/Library/Application Support/Threadbear"';

// The Convex CLI won't run `env` outside a folder whose package.json lists
// convex (rotate-owner failed from the data folder, 5 Nov 2026). The repo's
// own folders would do, but their .env.local names the dev deployment, so
// it runs in an empty private folder that only says it uses convex: then the
// deploy key alone picks the deployment.
export function convexScratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-convex-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tb-convex-env', private: true, dependencies: { convex: '*' } }));
  return dir;
}

const realConvex =
  (home: string): ConvexCli =>
  (args, input) => {
    // Only this Mac's deploy key (or a self-hosted backend's admin key) picks the deployment.
    let env: NodeJS.ProcessEnv;
    try {
      env = convexEnv(readConvexAdmin(home));
    } catch (e) {
      return { ok: false, out: '', err: (e as Error).message };
    }
    const cwd = convexScratchDir();
    try {
      const r = spawnSync(process.execPath, [CONVEX_BIN, ...args], { cwd, env, input, encoding: 'utf8' });
      return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || (r.error ? String(r.error) : '') };
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };

// This Mac's admin credential for the backend, or undefined (none, or both
// kinds at once, which convex-admin.ts refuses).
function adminOf(home: string): ConvexAdmin | undefined {
  try {
    const a = readConvexAdmin(home);
    return a.kind === 'none' ? undefined : a;
  } catch {
    return undefined;
  }
}

// Owner only, through a temp file and a rename, so the runner never reads half a key.
function writeKeyFile(file: string, key: string): void {
  const tmp = `${file}.${process.pid}.new`;
  fs.writeFileSync(tmp, key + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// The other Mac runs what ssh sends in its login shell, which on a Mac is
// zsh, and zsh stops the whole line at a glob that matches nothing (Bruce
// with no convex-panels folder, 5 Nov 2026). So every command goes through
// /bin/sh, the shell these commands are written for.
export function remoteCommand(command: string): string {
  return `exec /bin/sh -c '${command.replace(/'/g, `'\\''`)}'`;
}

const realSsh: Ssh = (host, command, input) => {
  // BatchMode: never stop to ask for a password in the middle of this.
  const r = spawnSync('ssh', [...SSH_OPTIONS, host, remoteCommand(command)], { input, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || (r.error ? String(r.error) : '') };
};

export async function runnerKeysCommand(cfg: Pick<Config, 'home' | 'sync'>, args: string[], f: Flags, deps: RunnerKeyDeps = {}): Promise<number> {
  const print = deps.print ?? ((s) => console.log(s));
  const fail = (s: string) => {
    (deps.fail ?? ((t) => console.error(t)))(s);
    return 1;
  };
  const url = cfg.sync.url;
  const key = readSyncKey(cfg.home);
  if (cfg.sync.urlRefused) return fail(`This Mac doesn't mirror to Convex: ${cfg.sync.urlRefused}.`);
  if (!url || !key) return fail("This Mac doesn't mirror to Convex (no sync.url in runner.json, or no secrets/convex-key), so it has no runner keys to manage. Run ./threadbear setup first.");
  const post = deps.post ?? convexPoster(url);
  const call = async (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => {
    try {
      return await post(kind, fn, { key, ...a });
    } catch (e) {
      const refused = forbiddenText(e);
      if (refused) throw new Error(`${refused} Run tb runner on the main Mac.`);
      if (/could not find (public )?function/i.test(String((e as Error)?.message))) throw new Error("The Convex backend is older than this runner (it has no runner keys yet). It deploys with the runner's next update; try again in a few minutes.");
      throw e;
    }
  };
  const [sub, ...rest] = args;
  try {
    if (sub === 'list' || sub === undefined) {
      const { keys: rows, rotating } = await listKeys(call);
      if (f.json) return print(JSON.stringify({ keys: rows, rotating }, null, 2)), 0;
      if (rotating) print(ROTATING);
      if (!rows.length) return print('No runner keys: every runner on this deployment uses the main key. tb runner add <name> --ssh <host> makes one for another Mac.'), 0;
      for (const r of rows) print(`${r.revokedAt ? 'revoked' : 'live   '}  ${clean(r.runnerId, 64)}  ${clean(r.name, 60)}  made ${clean(r.createdAt, 30)}${r.revokedAt ? `, revoked ${clean(r.revokedAt, 30)}` : ''}`);
      return 0;
    }
    if (sub === 'check') return check(cfg, key, f, deps.ssh ?? realSsh, print, fail, deps.userHome ?? os.homedir(), url);
    if (sub === 'audit') return await auditCommand(f, call, deps.heads, print, fail, cfg.sync.runnerId);
    if (sub === 'rotate-owner') {
      const code = await rotateOwner(cfg.home, key, f, call, deps.convex ?? realConvex(cfg.home), print, fail, url, deps.deployKeys ?? (() => listDeployKeys(url, process.env.CONVEX_TEAM_TOKEN)), cfg.sync.runnerId, (deps.now ?? Date.now)());
      // Finishing kills the old key, not what it made: show that next.
      if (code === 0 && f.finish) await auditCommand({}, call, deps.heads, print, fail, cfg.sync.runnerId);
      return code;
    }
    if (sub === 'revoke') {
      const id = rest[0]?.trim();
      if (!id || !validRunnerId(id)) return fail('tb runner revoke <runnerId>: which runner (tb runner list shows them).');
      // This Mac's own runner never has a runner key, and purging it would
      // wipe the only copy of its schedules.
      if (id === cfg.sync.runnerId) return fail(`${id} is this Mac's own runner id: there's no runner key of it to revoke${f.purge ? ', and nothing of it to purge' : ''}.`);
      const n = (await call('mutation', 'sync:revokeRunnerKey', { runnerId: id })) as number;
      print(n ? `Revoked runner ${id}'s key. Its runner can't reach the backend until it has a new one (tb runner add).` : `Runner ${id} has no live key.`);
      if (!f.purge) return 0;
      // A batch a call (convex/sync.ts purgeRunner) until there's nothing left.
      for (let i = 0; i < 10_000; i++) if (((await call('mutation', 'sync:purgeRunner', { runnerId: id })) as { done?: boolean })?.done) break;
      print(`Took out everything runner ${id} wrote: its threads with their messages and pictures, sidebar rows, Pocket cards, schedules, projects and accounts.`);
      return 0;
    }
    if (sub === 'add') return await add(rest[0], f, call, deps.ssh ?? realSsh, print, fail, url, cfg.sync.runnerId, cfg.sync.site);
    if (sub === 'logins') return await logins(rest, f, call, print, fail);
    // After a rotation, what the old key could have left (auditCommand).
    return fail('tb runner add <name> --ssh <host> | --out <file> [--id <runnerId>], tb runner list, tb runner logins [<runnerId> <provider:email>... | none], tb runner revoke <runnerId>, tb runner check [--ssh <host>], or tb runner rotate-owner [--finish].');
  } catch (e) {
    return fail((e as Error).message);
  }
}

async function add(name: string | undefined, f: Flags, call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>, ssh: Ssh, print: (s: string) => void, fail: (s: string) => number, url: string, ownId: string | undefined, site?: string): Promise<number> {
  if (!name?.trim()) return fail('tb runner add <name>: what to call the runner ("bruce").');
  if (Boolean(f.ssh) === Boolean(f.out)) return fail('Say where the key goes: --ssh <host> writes it into that Mac\'s secrets/convex-key, --out <file> into a file of your own. It is never printed.');
  if (!ownId) return fail("This Mac has no sync.runnerId in runner.json yet (its runner makes one when it starts), so it can't tell its own id from another Mac's. Start it, then run this again.");
  const asked = f.id?.trim();
  if (asked !== undefined && !validRunnerId(asked)) return fail(`--id ${JSON.stringify(asked)} isn't a runner id (1 to 64 letters, digits, - or _, and not "any").`);
  // A key for this Mac's own runner id would let that Mac write as this one.
  if (asked && asked === ownId) return fail(`${asked} is this Mac's own runner id. A runner key is for another Mac.`);
  let runnerId = asked;
  if (f.ssh) {
    const r = ssh(f.ssh, `cat ${REMOTE_HOME}/runner.json`);
    if (!r.ok) return fail(`Couldn't read Threadbear's runner.json on ${f.ssh} over ssh: ${clean(r.err || 'no answer')}. Is Threadbear set up there?`);
    let json: { sync?: { runnerId?: string; url?: string; site?: string } } & Record<string, unknown>;
    try {
      json = JSON.parse(r.out);
    } catch {
      return fail(`${f.ssh}'s runner.json isn't JSON.`);
    }
    if (json.sync?.url && json.sync.url.replace(/\/+$/, '') !== url.replace(/\/+$/, '')) return fail(`${f.ssh} mirrors to ${clean(json.sync.url, 120)}, not this Mac's ${url}, so a key from here is no use to it.`);
    // What that Mac says it is, which this Mac decides whether to believe:
    // a Mac that's been tampered with could name this one, or any runner
    // the deployment knows, to be handed a key that writes as it.
    const there = json.sync?.runnerId;
    // As written: " m5 " isn't "m5", and comparing one but minting the other
    // is how a tampered Mac would get the main Mac's key.
    if (there !== undefined && (typeof there !== 'string' || !validRunnerId(there))) return fail(`${f.ssh}'s runner.json has a sync.runnerId (${clean(JSON.stringify(there), 80)}) that isn't a runner id. Not making a key for it.`);
    if (asked && there && there !== asked) return fail(`${f.ssh}'s runner says it's ${there}, not ${asked}.`);
    if (!asked && there === ownId) return fail(`${f.ssh}'s runner.json says it's ${there}, which is this Mac's own runner id. Not making a key for it.`);
    runnerId = asked ?? there;
    // A self-hosted backend's website address (sync.site) can't be worked
    // out from its URL, so it goes there whenever it's missing or different.
    const siteStale = Boolean(site) && json.sync?.site !== site;
    if (!there || !json.sync?.url || siteStale) {
      // A runner that has never started: this Mac picks its id (or takes
      // --id) and writes it there. One set up with no Convex of its own
      // (setup --existing) gets this deployment's URL too.
      runnerId ??= crypto.randomBytes(6).toString('hex');
      const next = { ...json, sync: { ...json.sync, url, ...(site ? { site } : {}), runnerId } };
      const w = ssh(f.ssh, `d=${REMOTE_HOME}; cat > "$d/runner.json.new" && mv "$d/runner.json.new" "$d/runner.json"`, JSON.stringify(next, null, 2) + '\n');
      if (!w.ok) return fail(`Couldn't write ${f.ssh}'s runner.json: ${clean(w.err || 'no answer')}.`);
    }
  }
  if (!runnerId) return fail('--out needs --id <runnerId>: the other Mac\'s sync.runnerId in its runner.json.');
  // A runner the deployment already has: this Mac says which (its name and
  // when it was last seen) and wants --replace as well as --id, since a
  // tampered Mac would claim another runner's id to take its place.
  const known = (await knownRunners(call)).get(runnerId);
  if (known && !(asked === runnerId && f.replace)) {
    const seen = known.lastSeenAt ? `last seen ${new Date(known.lastSeenAt).toISOString()}` : 'never seen';
    return fail(`Runner ${runnerId} is already on this deployment: ${known.name ? `"${clean(known.name, 60)}", ` : ''}${seen}${known.keyed ? ', with a key of its own' : ''}. If ${f.ssh ? clean(f.ssh, 80) : 'that Mac'} really is that runner (its threads are under that id), run the same command again with --id ${runnerId} --replace.`);
  }
  const made = (await call('mutation', 'sync:addRunnerKey', { runnerId, name: name.trim(), ownerRunnerId: ownId, replace: Boolean(known) })) as { runnerId: string; key: string };
  if (f.out) {
    const file = path.resolve(f.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, made.key + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    print(`Made a key for runner ${made.runnerId} (${name.trim()}) and wrote it to ${file}. Put it on that Mac as secrets/convex-key in Threadbear's data folder (owner only), then delete this copy and restart that runner (tb restart there).`);
    return 0;
  }
  // stdin, never the command line, so it's in no process list on either Mac.
  const write = ssh(f.ssh!, `umask 077; d=${REMOTE_HOME}/secrets; mkdir -p "$d" && chmod 700 "$d" && cat > "$d/convex-key.new" && chmod 600 "$d/convex-key.new" && mv "$d/convex-key.new" "$d/convex-key"`, made.key + '\n');
  if (!write.ok) {
    // Nobody has the key now, so it goes rather than being left live.
    await call('mutation', 'sync:revokeRunnerKey', { runnerId: made.runnerId }).catch(() => undefined);
    return fail(`Made a key for ${made.runnerId} but couldn't write it on ${f.ssh}: ${clean(write.err || 'no answer')}. Revoked it again (so ${made.runnerId} has no live key now); run this again once ssh works.`);
  }
  print(
    [
      `Made a key for runner ${made.runnerId} (${name.trim()}) and wrote it to ${f.ssh}:~/Library/Application Support/Threadbear/secrets/convex-key.`,
      'Its runner reads the key when it starts: restart it there once no thread is busy (tb restart on that Mac waits for them).',
      `Any runner key ${made.runnerId} had before is revoked, and the main key no longer acts as ${made.runnerId}. A copy of the main key that Mac had still works for everything else until you rotate it: tb runner rotate-owner.`,
      `It gets no logins' usage readings from this Mac until you say which it's signed in to: tb runner logins ${made.runnerId} <provider:email>... (tb runner logins lists what it says it has once it's running).`,
    ].join('\n'),
  );
  const admin = remoteAdmin(ssh, f.ssh!);
  if (!admin) print(`Couldn't look on ${f.ssh} for a deploy key or Convex login it shouldn't have; run tb runner check --ssh ${f.ssh} once ssh works.`);
  else if (hasAdmin(admin)) print(adminAdvice(admin, f.ssh!, url));
  return 0;
}

// `tb runner logins`: which logins each runner with a key of its own
// gets this Mac's usage readings of (convex/sync.ts sharedUsage).
// The backend takes only this Mac's word for it, never what that runner's
// own accounts rows say, as its key writes those as it likes; they're
// listed beside it as what it says it has, for Mike to check.
// `tb runner logins <runnerId> claude:a@b codex:a@b` sets exactly those,
// `none` clears them.
type LoginRow = { runnerId: string; name: string; live: boolean; shared: { provider: string; email: string }[]; claimed: { provider: string; email: string }[] };
async function logins(rest: string[], f: Flags, call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>, print: (s: string) => void, fail: (s: string) => number): Promise<number> {
  const [id, ...given] = rest;
  if (id === undefined) {
    const rows = ((await call('query', 'sync:runnerLogins', {})) ?? []) as LoginRow[];
    if (f.json) return print(JSON.stringify(rows, null, 2)), 0;
    if (!rows.length) return print('No runner keys, so nothing to share: every runner on this deployment is on the main key.'), 0;
    const list = (ls: { provider: string; email: string }[]) => (ls.length ? ls.map((l) => `${clean(l.provider, 40)}:${clean(l.email, 200)}`).join(', ') : 'none');
    for (const r of rows) {
      if (!r.live && !r.shared.length) continue;
      print(`${clean(r.runnerId, 64)}  ${clean(r.name, 60)}${r.live ? '' : ' (revoked)'}`);
      print(`  shares:      ${list(r.shared)}`);
      print(`  says it has: ${list(r.claimed)}`);
    }
    print('tb runner logins <runnerId> <provider:email>... sets what one shares (none: nothing). Add only logins you know that Mac is signed in to.');
    return 0;
  }
  if (!validRunnerId(id)) return fail(`${JSON.stringify(clean(id, 80))} isn't a runner id: tb runner logins lists them.`);
  if (!given.length) return fail(`Say which logins ${id} shares, as provider:email (claude:you@example.com), or none.`);
  const parsed: { provider: string; email: string }[] = [];
  if (!(given.length === 1 && given[0] === 'none')) {
    for (const g of given.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)) {
      const at = g.indexOf(':');
      if (at <= 0) return fail(`${JSON.stringify(clean(g, 80))} isn't provider:email, like claude:you@example.com.`);
      parsed.push({ provider: g.slice(0, at), email: g.slice(at + 1) });
    }
  }
  const n = (await call('mutation', 'sync:setRunnerLogins', { runnerId: id, logins: parsed })) as number;
  print(n ? `Runner ${id} gets this Mac's usage readings of ${n} login${n === 1 ? '' : 's'} now.` : `Runner ${id} gets no logins' usage readings from this Mac now.`);
  return 0;
}

const ROTATING = 'RUNNER_KEY_NEXT is set on the deployment, so two main keys work. Finish rotating with tb runner rotate-owner --finish (after restarting this runner on the new key).';

async function listKeys(call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>) {
  const r = (await call('query', 'sync:listRunnerKeys', {})) as { keys?: { runnerId: string; name: string; createdAt: string; revokedAt?: string }[]; rotating?: boolean } | null;
  return { keys: r?.keys ?? [], rotating: Boolean(r?.rotating) };
}

// `tb runner check [--ssh host]`: whether a Mac with a runner key also has
// admin credentials (Admin). Exit 1 when it does, or when it couldn't look.
function check(cfg: Pick<Config, 'home'>, key: string, f: Flags, ssh: Ssh, print: (s: string) => void, fail: (s: string) => number, userHome: string, url: string): number {
  if (f.ssh) {
    const a = remoteAdmin(ssh, f.ssh);
    if (!a) return fail(`Couldn't look on ${f.ssh} over ssh, so this says nothing about it: check ssh reaches it, then run this again.`);
    if (hasAdmin(a)) return fail(adminAdvice(a, f.ssh, url));
    print(`${f.ssh} has no deploy key, self-hosted admin key or panel keys in its Threadbear data folder and no Convex login.`);
    return 0;
  }
  if (!key.startsWith('tbr_')) {
    // A team token is for one rotate-owner run, given as CONVEX_TEAM_TOKEN; one kept on disk is a standing key to the whole team.
    if (fs.existsSync(path.join(cfg.home, 'secrets', 'convex-team-token'))) return fail(`${path.join(cfg.home, 'secrets', 'convex-team-token')} is a Convex team access token kept on disk, which reaches every project on the team. Delete it (and revoke it in the Convex dashboard's team settings if it isn't needed); give one to tb runner rotate-owner as CONVEX_TEAM_TOKEN for that run instead.`);
    print("This Mac has the main key (the deployment's RUNNER_KEY), so it's the one that deploys the backend and keeps a deploy key. tb runner check --ssh <host> checks another Mac.");
    return 0;
  }
  const a = localAdmin(cfg.home, userHome);
  if (hasAdmin(a)) return fail(adminAdvice(a, 'This Mac', url));
  print('This Mac has a runner key of its own, and no deploy key, self-hosted admin key, panel keys or Convex login beside it.');
  return 0;
}

// `tb runner rotate-owner`: a new main key with no gap. Sets it as
// RUNNER_KEY_NEXT (both keys work), writes it into this Mac's
// secrets/convex-key, and says to restart the runner onto it; `--finish`
// then makes it RUNNER_KEY and removes RUNNER_KEY_NEXT, and the old key
// (and every copy of it, Bruce's included) is dead. Uses this Mac's deploy
// key for the env vars. The key is never printed.
async function rotateOwner(home: string, key: string, f: Flags, call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>, convex: ConvexCli, print: (s: string) => void, fail: (s: string) => number, url: string, keys: () => Promise<DeployKey[] | undefined>, ownRunnerId: string | undefined, now: number): Promise<number> {
  if (key.startsWith('tbr_')) return fail('This Mac has a runner key, not the main key: run tb runner rotate-owner on the main Mac.');
  const admin = adminOf(home);
  if (!admin) return fail(`No deploy key in ${path.join(home, 'secrets', 'convex-deploy.env')} (or self-hosted admin key in secrets/${SELF_HOSTED_ENV_FILE}), so this can't set the deployment's env vars. Run it on the main Mac, or make one with npx convex deployment token create --prod --save-env <that file>.`);
  // Owner only, so this also says the key in secrets/convex-key is the main key.
  const { rotating } = await listKeys(call);
  const keyFile = path.join(home, 'secrets', 'convex-key');
  if (!f.finish) {
    if (rotating) return fail(`${ROTATING} Or, to start again, remove it first: npx convex env remove --prod RUNNER_KEY_NEXT.`);
    const stranded = await onMainKey(call, ownRunnerId, now, f.lockOut);
    if (stranded.refuse) return fail(stranded.refuse);
    // A self-hosted backend has no deploy keys to list: its admin keys all
    // come from the instance secret and none can be listed or revoked, so
    // say so and go on (docs/self-hosting.md, "Keys").
    if (admin.kind === 'selfHosted') print(`A self-hosted backend's admin keys can't be listed: any Mac you gave one to (secrets/${SELF_HOSTED_ENV_FILE}) can read the new main key too. tb runner check --ssh <host> looks for one on another Mac.`);
    else {
      // A deploy key can read the new main key as easily as the old, so not
      // while Convex lists any this Mac didn't make, unless Mike has looked
      // at them (--keys-checked), by Convex's own list rather than another
      // Mac's word. CLI logins can't be listed at all.
      const deployment = deploymentOf(url);
      const settings = deployment ? `https://dashboard.convex.dev/d/${deployment}/settings` : "the deployment's settings in the Convex dashboard";
      const logins = "A Convex CLI login on another Mac can read it too and can't be listed here: revoke any in the Convex dashboard's account settings.";
      let listed: DeployKey[] | undefined;
      let why = '';
      try {
        listed = await keys();
        if (!listed) why = 'no CONVEX_TEAM_TOKEN was given for this run (a team access token from the Convex dashboard\'s team settings; it isn\'t kept)';
      } catch (e) {
        why = clean((e as Error).message, 200);
      }
      if (!listed) {
        if (!f.keysChecked) return fail(`Can't list the deployment's deploy keys from Convex's side: ${why}. Any made for another Mac could read the new key. Look in ${settings} (Deploy keys), delete any for another Mac or that you don't know, then run this again with --keys-checked, or with CONVEX_TEAM_TOKEN set for the run. ${logins}`);
      } else {
        const made = madeDeployKeys(home);
        const review = listed.filter((k) => !made.has(k.name));
        if (review.length) {
          const lines = review.map((k, i) => `  ${i + 1}. ${clean(k.name, 80)}, made ${new Date(k.creationTime).toISOString()}${k.lastUsedTime ? `, last used ${new Date(k.lastUsedTime).toISOString()}` : ''}`);
          if (!f.keysChecked) return fail([`Convex lists deploy keys this Mac didn't make itself, and any of them could read the new main key. Delete in ${settings} (Deploy keys) any for another Mac or that you don't know, then run this again with --keys-checked:`, ...lines, logins].join('\n'));
          print(['Going ahead (--keys-checked) with these deploy keys still on the deployment:', ...lines, logins].join('\n'));
        }
      }
    }
    const fresh = crypto.randomBytes(32).toString('hex');
    const set = convex(['env', 'set', 'RUNNER_KEY_NEXT'], fresh);
    if (!set.ok) return fail(`Setting RUNNER_KEY_NEXT failed: ${set.err || 'no answer'}. Nothing changed.`);
    try {
      writeKeyFile(keyFile, fresh);
    } catch (e) {
      convex(['env', 'remove', 'RUNNER_KEY_NEXT']);
      return fail(`Couldn't write ${keyFile}: ${(e as Error).message}. Took RUNNER_KEY_NEXT off again; nothing changed.`);
    }
    print(
      [
        `A new main key is set as RUNNER_KEY_NEXT and in ${keyFile}; the old one still works too.`,
        'Restart this runner onto it (from a terminal: tb restart, which waits for busy threads), check tb status says the mirror is ok,',
        'then run tb runner rotate-owner --finish to make it RUNNER_KEY. Until then RUNNER_KEY_NEXT stays set, which tb status and tb runner list say.',
      ].join('\n'),
    );
    return 0;
  }
  if (!rotating) return fail('RUNNER_KEY_NEXT isn\'t set, so there is nothing to finish. Start with tb runner rotate-owner.');
  // Again here, as a runner can start on the main key between the two.
  const stranded = await onMainKey(call, ownRunnerId, now, f.lockOut);
  if (stranded.refuse) return fail(stranded.refuse);
  // Only the key rotate-owner made: if something put the old key back in
  // secrets/convex-key (setup run meanwhile), promoting it would keep every
  // old copy alive while saying they're dead.
  const next = convex(['env', 'get', 'RUNNER_KEY_NEXT']);
  if (!next.ok) return fail(`Couldn't read RUNNER_KEY_NEXT: ${next.err || 'no answer'}. Nothing changed.`);
  if (next.out.trim() !== key) return fail(`${keyFile} isn't the key in RUNNER_KEY_NEXT (something wrote another one there since rotate-owner). Nothing changed. To start again: npx convex env remove --prod RUNNER_KEY_NEXT, then tb runner rotate-owner.`);
  const set = convex(['env', 'set', 'RUNNER_KEY'], key);
  if (!set.ok) return fail(`Setting RUNNER_KEY failed: ${set.err || 'no answer'}. Both keys still work; run --finish again.`);
  const removed = convex(['env', 'remove', 'RUNNER_KEY_NEXT']);
  if (!removed.ok) return fail(`RUNNER_KEY is the new key, but removing RUNNER_KEY_NEXT failed: ${removed.err || 'no answer'}. Run --finish again.`);
  if (stranded.lockedOut.length) print(`Locked out (--lock-out), as they were on the old main key: ${stranded.lockedOut.join(', ')}. Each needs tb runner add before it can reach the backend again.`);
  print('RUNNER_KEY is the new key and RUNNER_KEY_NEXT is gone, so the old main key no longer works, wherever a copy of it is. Anything that can read env vars still can (a deploy key or Convex login left on another Mac: tb runner check), and what the old key made still works: the audit below lists it (tb runner audit again any time). Rotate the dev deployment the same way if it shares the old key.');
  return 0;
}

// How recently a runner must have heartbeated for rotate-owner to count it
// as still running on the main key. One not seen for longer is a Mac
// that's gone (or a lost one, which rotating should cut off anyway).
export const ON_MAIN_KEY_SEEN_MS = 30 * 24 * 60 * 60 * 1000;
const REVOKE_SLACK_MS = 2 * 60 * 1000; // two heartbeats

// Runners other than this Mac's that rotating the main key would cut off:
// seen lately with no live runner key, so heartbeating on the main key
// (convex/lib.ts actAs: the main key can't act as a runner with a key of
// its own). The 5 Nov 2026 rotation stranded the cloud runner this way,
// unnoticed until Sentry filled with "bad runner key". Each one has to
// get its own key first (tb runner add), or be named with --lock-out.
async function onMainKey(call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>, ownRunnerId: string | undefined, now: number, lockOut: string[] = []): Promise<{ refuse?: string; lockedOut: string[] }> {
  const named = new Set(lockOut.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean));
  // A runner whose key was revoked keeps its heartbeat row; it's only on
  // the main key if it was seen after the revoke (a revoked key is refused),
  // give or take a heartbeat in flight.
  const found = [...(await knownRunners(call))].filter(([id, r]) => id !== ownRunnerId && !r.keyed && r.lastSeenAt !== undefined && now - r.lastSeenAt < ON_MAIN_KEY_SEEN_MS && !(r.revokedAt !== undefined && r.lastSeenAt <= r.revokedAt + REVOKE_SLACK_MS));
  const left = found.filter(([id]) => !named.has(id));
  const lockedOut = found.filter(([id]) => named.has(id)).map(([id]) => id);
  if (!left.length) return { lockedOut };
  const lines = left.map(([id, r], i) => `  ${i + 1}. ${clean(id, 64)}${r.name ? ` "${clean(r.name, 60)}"` : ''}, last seen ${new Date(r.lastSeenAt!).toISOString()}: tb runner add ${JSON.stringify(clean(r.name || id, 60))} --ssh <host> --id ${clean(id, 64)} --replace`);
  return {
    lockedOut,
    refuse: [
      `Not rotating: ${left.length === 1 ? 'this runner is' : 'these runners are'} still on the main key (seen lately, with no runner key of ${left.length === 1 ? 'its' : 'their'} own), so the new key would cut ${left.length === 1 ? 'it' : 'them'} off. Give each its own key first, on this Mac, with the ssh host that reaches it, and restart its runner:`,
      ...lines,
      `Or, to cut one off on purpose (a Mac that's lost or gone), run this again with --lock-out ${left.map(([id]) => clean(id, 64)).join(',')}. Nothing changed.`,
    ].join('\n'),
  };
}

// Every runner id the deployment has heard of: ones that have heartbeated,
// and ones that have (or had) a runner key.
// revokedAt is the latest revoke of a runner with no live key.
async function knownRunners(call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>): Promise<Map<string, { name?: string; lastSeenAt?: number; keyed?: boolean; revokedAt?: number }>> {
  const runners = ((await call('query', 'sync:runnersList', {})) ?? []) as { runnerId: string; name?: string; lastSeenAt?: number }[];
  const { keys } = await listKeys(call);
  const out = new Map<string, { name?: string; lastSeenAt?: number; keyed?: boolean; revokedAt?: number }>();
  for (const r of runners) out.set(r.runnerId, { ...(r.name ? { name: r.name } : {}), ...(r.lastSeenAt ? { lastSeenAt: r.lastSeenAt } : {}) });
  for (const k of keys) if (!k.revokedAt) out.set(k.runnerId, { ...out.get(k.runnerId), keyed: true, ...(out.get(k.runnerId)?.name ? {} : { name: k.name }) });
  for (const k of keys) {
    const at = k.revokedAt ? Date.parse(k.revokedAt) : NaN;
    const row = out.get(k.runnerId);
    if (!Number.isFinite(at) || !row || row.keyed) continue;
    if (row.revokedAt === undefined || at > row.revokedAt) row.revokedAt = at;
  }
  return out;
}

// `tb runner audit [--drop 3,7 --snapshot <hex>]`: what a Mac that held the
// shared key could have left that outlives rotating it (convex/sync.ts
// audit), numbered, for Mike to look at and take out. Everything shown is
// cleaned (clean), and nothing anyone else chose ever goes into a command:
// --drop takes row numbers and the snapshot the listing printed, and only
// goes ahead if a fresh listing has the same snapshot, then removes those
// exact rows by id. Phone tokens say which main key issued them where
// that's known (since runner keys); their last use isn't recorded.
type AuditRow = Record<string, unknown> & { kind: string; id: string; version: string };
type AuditItem = { kind: string; id: string; version: string; line: string };
const AUDIT_HEADS = 100; // threads per request

// Every page of every section, the threads in chunks. Each row's line is
// built from cleaned fields only.
async function auditSnapshot(call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>, heads: RunnerKeyDeps['heads'], ownRunnerId: string | undefined): Promise<{ items: AuditItem[]; theirs: string[]; noHeads: boolean }> {
  let h: { threadId: string; lastSeq: number }[] = [];
  let noHeads = !heads;
  try {
    if (heads) h = await heads();
  } catch {
    noHeads = true;
  }
  let ownerKeyPrint = '';
  const pages = async (section: string, extra: Record<string, unknown> = {}): Promise<AuditRow[]> => {
    const out: AuditRow[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10_000; guard++) {
      const r = (await call('query', 'sync:audit', { section, ...extra, ...(cursor ? { cursor } : {}) })) as { ownerKeyPrint: string; rows: AuditRow[]; next?: string };
      ownerKeyPrint = r.ownerKeyPrint;
      out.push(...r.rows);
      if (!r.next || r.next === cursor) break;
      cursor = r.next;
    }
    return out;
  };
  const items: AuditItem[] = [];
  const add = (r: AuditRow, line: string) => items.push({ kind: r.kind, id: r.id, version: r.version, line });
  for (const t of await pages('tokens')) add(t, `phone or browser token "${clean(t.name, 60)}" ${clean(t.tokenKind ?? '', 10)}, made ${clean(t.createdAt, 30)}, expires ${clean(t.expiresAt, 30)}, ${t.ownerKeyPrint ? (t.ownerKeyPrint === ownerKeyPrint ? 'issued with the current main key' : 'issued with an earlier main key') : 'from before tokens said which key made them (any holder of the old shared key could have)'}`);
  for (const k of await pages('runnerKeys', ownRunnerId ? { ownRunnerId } : {})) add(k, `runner key for ${clean(k.runnerId, 64)} "${clean(k.name, 60)}", made ${clean(k.createdAt, 30)}${k.mainMac ? ": THIS MAC'S OWN RUNNER ID, so its holder can act as this Mac" : ''}`);
  for (const sc of await pages('schedules')) add(sc, `schedule on runner ${clean(sc.runnerId, 64)}, "${clean(sc.title, 60)}": "${clean(sc.text, 120)}"${sc.cwd ? `, in ${clean(sc.cwd, 80)}` : ''}${sc.permissionMode ? `, access ${clean(sc.permissionMode, 10)}` : ''}${sc.createdBy ? `, by ${clean(sc.createdBy, 30)}` : ''}`);
  for (const c of await pages('cards')) add(c, `Pocket card filed with a main key, "${clean(c.title, 60)}"${c.threadId ? ` on thread ${clean(c.threadId, 40)}` : ''}, ${clean(c.updatedAt, 30)}`);
  for (let i = 0; i < Math.max(1, h.length); i += AUDIT_HEADS) {
    const chunk = h.slice(i, i + AUDIT_HEADS);
    if (!chunk.length) break;
    for (const m of await pages('messages', { heads: chunk })) add(m, `message at seq ${Number(m.seq)} in thread ${clean(m.threadId, 40)}, past where this Mac's runner has written: "${clean(m.text, 100)}"`);
    for (const section of ['replyImages', 'shareImages']) for (const p of await pages(section, { heads: chunk })) add(p, `${section === 'shareImages' ? 'shared' : 'reply'} picture at seq ${Number(p.seq)} in thread ${clean(p.threadId, 40)}, past where this Mac's runner has written: ${clean(p.path, 80)}`);
  }
  // A runner key's own schedules: shown, not numbered, so their coming and
  // going doesn't change the snapshot (tb runner revoke --purge takes them).
  const theirs = (await pages('runnerSchedules')).map((sc) => `schedule of runner ${clean(sc.runnerId, 64)} (its own key), "${clean(sc.title, 60)}": "${clean(sc.text, 120)}"`);
  return { items, theirs, noHeads };
}

// Hex, from each row's kind, id and version: the same rows as they were, the same snapshot.
const snapshotOf = (items: AuditItem[]) => crypto.createHash('sha256').update(JSON.stringify(items.map((i) => [i.kind, i.id, i.version]))).digest('hex').slice(0, 12);

async function auditCommand(f: Flags, call: (kind: 'query' | 'mutation', fn: string, a: Record<string, unknown>) => Promise<unknown>, heads: RunnerKeyDeps['heads'], print: (s: string) => void, fail: (s: string) => number, ownRunnerId: string | undefined): Promise<number> {
  const snap = await auditSnapshot(call, heads, ownRunnerId);
  const snapshot = snapshotOf(snap.items);
  if (f.remove?.length) {
    if (!f.snapshot || !/^[0-9a-f]{12}$/.test(f.snapshot)) return fail('--drop needs --snapshot, as the audit listing printed it, so the numbers mean the rows you saw.');
    if (f.snapshot !== snapshot) return fail('The audit listing has changed since that snapshot, so its numbers may not be the rows you meant. Nothing removed: run tb runner audit again. (While a thread on this Mac is busy, its newest messages can show as past its end and change the listing: run it when things are quiet.)');
    const rows: AuditItem[] = [];
    for (const p of f.remove.flatMap((r) => r.split(',')).map((x) => x.trim()).filter(Boolean)) {
      const item = /^\d+$/.test(p) ? snap.items[Number(p) - 1] : undefined;
      if (!item) return fail(`--drop ${clean(p, 20)}: not a row number in the listing (1 to ${snap.items.length}). Nothing removed.`);
      rows.push(item);
    }
    const n = (await call('mutation', 'sync:auditRemove', { rows: rows.map((r) => ({ kind: r.kind, id: r.id, version: r.version })) })) as number;
    print(`Took out ${n} of ${rows.length} (revoked tokens and keys, deleted schedules, cards, messages and pictures).${n < rows.length ? ' The rest had changed since the listing and were left alone.' : ''}`);
    return 0;
  }
  const lines = ['Everything here outlives rotating the main key. To take out rows you didn\'t make:', `  tb runner audit --drop <row numbers, like 2,5> --snapshot ${snapshot}`, ''];
  if (!snap.items.length) lines.push('  Nothing to list.');
  snap.items.forEach((item, i) => lines.push(`  ${i + 1}. ${item.line}`));
  if (snap.theirs.length) lines.push('', "Runner keys' own schedules (tb runner revoke <runnerId> --purge takes out everything a runner wrote):", ...snap.theirs.map((l) => `  - ${l}`));
  if (snap.noHeads) lines.push('', "Messages and pictures past a thread's end weren't checked: this Mac's runner couldn't be reached.");
  lines.push('', "Not checked: a message planted at a seq a thread has since reached can't be told from a real one; this Mac's runner writes its own over it when it sends that seq again.");
  print(lines.join('\n'));
  return 0;
}

