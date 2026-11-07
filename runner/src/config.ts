import fs from 'node:fs';
import { readSandbox, type SandboxConfig } from './sandbox.ts';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from './fsutil.ts';
import { RELEASE } from './release.ts';
import { gatewayBase, gatewayUrlFrom } from './connectors.ts';
import { credentialUrlProblem } from './secure-url.ts';
import { findGatewayClient } from './notion-tasks.ts';
import { CLI_POLICIES, isEffortLevel, isProvider, type CliPolicy, type EffortLevel, type Provider } from './protocol.ts';

// <package version>+<release id>, or +source when run from a checkout.
export const RUNNER_VERSION = RELEASE.version;
// Where a new thread starts when nothing says otherwise. Setup writes
// ~/ThreadbearThreads into runner.json (not the home folder, where agents set off
// macOS's Dropbox, Desktop and Documents prompts); anyone's own choice
// goes in their runner.json's defaults.cwd.
export const DEFAULT_CWD = '~';
export const DEFAULT_PORT = 8797;
export const DEFAULT_MAX_LIVE = 6;

// Notes shown with an account in the app's account menu (runner.json
// accountNotes, e.g. { "claude-2": "Work only" }). None by
// default: they're one person's.
export const DEFAULT_ACCOUNT_NOTES: Record<string, string> = {};

// Folders whose new threads start on a built-in pool, by the login that
// pool is made from (pools.ts, defaultPools), from runner.json poolFolders
// (e.g. { "claude-2": ["~/dev/work"] }). None by default, as one
// person's folders would otherwise apply to anyone's second login. A runner.json `pools` list carries its own folders.
export const DEFAULT_POOL_FOLDERS: Record<string, string[]> = {};

export type CliUpdatesConfig = {
  claude: CliPolicy;
  codex: CliPolicy;
  checkMinutes: number;
  keepCodexVersions: number; // Codex copies kept under <home>/tools/codex
};
export const DEFAULT_CLI_UPDATES: CliUpdatesConfig = { claude: 'auto', codex: 'auto', checkMinutes: 60, keepCodexVersions: 2 };

// Everything that differs between the real install and a test lives here, so
// tests can point THREADBEAR_HOME and THREADBEAR_PORT somewhere harmless and
// never touch ~/Library/Application Support/Threadbear.
export type Config = {
  home: string; // data dir
  port: number;
  host: string;
  logFile: string;
  claudePath: string;
  idleMs: number;
  // Most CLIs kept live at once. Each one is a claude process plus its own
  // copy of the account's MCP servers (about 400 MB), so past this the
  // longest-idle one is released early.
  maxLive: number;
  // model: what threads.create uses when it isn't given one (a dev runner
  // sets the cheapest, so a thread started from a debug app's composer
  // doesn't run on the account's default). Unset means the account's own.
  // models and efforts are the same per provider (models.claude wins over
  // model); unset means the account's own default or the model's own level.
  defaults: {
    cwd: string;
    accountId?: string;
    poolId?: string;
    model?: string;
    models?: Partial<Record<Provider, string>>;
    efforts?: Partial<Record<Provider, EffortLevel>>;
  };
  // Where accounts are discovered. Tests can narrow these.
  claudeMainDir: string;
  claudeMainJson: string;
  tokenStatsAccountsDir: string;
  // <data dir>/accounts: more logins for anyone without Token Stats (the
  // guide's "Adding another login"), claude-N and codex-N as there.
  accountsDir?: string;
  // A Codex binary set by hand, used as is and never updated. Unset means
  // Threadbear's own copy (<home>/tools/codex/current), or until there is
  // one the codex next to the runner's Node; never ~/.local/bin/codex.
  codexPath?: string;
  codexArgs: string[]; // extra `codex app-server` arguments
  codexMainDir: string; // codex-main's CODEX_HOME
  tokenStatsLimitsFile: string; // Token Stats' limits.json, read only
  cliUpdates: CliUpdatesConfig;
  // Reads the CLIs' transcripts for the Usage panel's token counts
  // (token-tally.ts). THREADBEAR_TOKEN_TALLY=off turns it off: a dev runner
  // would read every login's last 14 days (gigabytes) for nothing.
  tokenTally?: boolean;
  accountNotes: Record<string, string>;
  poolFolders?: Record<string, string[]>;
  // Folders whose threads run their CLI in a container (sandbox.ts).
  sandbox?: SandboxConfig;
  // runner.json's pools as written (pools.ts readPools checks each);
  // absent means the built-in ones. pools.save replaces it.
  pools?: unknown[];
  // A runner on a release builds and restarts onto main by itself
  // (src/update.ts). Off with followMain: false in runner.json or
  // THREADBEAR_FOLLOW_MAIN=0.
  followMain: boolean;
  // A turn's reply in the Mac app: end_turn's bullets, or (false) the
  // agent's own message, with the bullets only for previews.
  bulletReplies: boolean;
  // One reply (docs/protocol.md, "One reply"): end_turn carries the card
  // and a headline, and the agent's message straight after it is the
  // turn's reply. Off by default while Mike tries it (1 Nov 2026).
  oneReply: boolean;
  // Mike's runner tags a signed release of main once a day for everyone
  // else's copy (src/upstream.ts): runner.json `releases`.
  releases?: { publish: boolean; signingKey?: string };
  // The runner's own model calls (src/models/): the pool whose Claude
  // logins answer them (null: none, so no small jobs) and folders whose
  // threads are never sent.
  models: { pool: string | null; privateFolders: string[] };
  // The Convex mirror (src/sync.ts): the project's URL, whether it's on,
  // the name the phone shows for this runner and its id (made once).
  // THREADBEAR_SYNC=off turns it off for tests and dev runners.
  // urlRefused: why the configured url isn't used (plain http off this
  // Mac, secure-url.ts), so sync is off and tb status says why.
  sync: { enabled: boolean; url?: string; urlRefused?: string; site?: string; name?: string; runnerId?: string; icon?: string; rpcUrl?: string; pastedPictures?: boolean; full?: boolean };
  // The silent on-device secret check (src/secret-check.ts): off unless asked.
  secretCheck?: boolean;
  // Mike's Connectors gateway's base URL (connectors.ts), for the app's
  // Connectors panel. Unset means there's none to watch.
  connectorsUrl?: string;
  // The same gateway's MCP endpoint and the command that prints its
  // Authorization header, for reading projects' Notion boards
  // (notion-tasks.ts). Only with connectorsUrl.
  connectorsClient?: { mcpUrl: string; headersHelper: string };
  // Why a configured gateway URL isn't used (plain http off this Mac,
  // secure-url.ts): the Connectors panel's off state and the log say it.
  connectorsRefused?: string;
};

export type RunnerJson = {
  port?: number;
  defaults?: {
    cwd?: string;
    accountId?: string;
    // New threads start on accountId (the last one used) as it is, rather
    // than on the account with the most room. A dev runner sets it so its
    // threads stay on claude-3.
    keepAccount?: boolean;
    // The pool a new thread with nothing named starts on: the last one
    // named in threads.create (Runner.rememberPool).
    poolId?: string;
    model?: string;
    models?: Partial<Record<Provider, string>>;
    efforts?: Partial<Record<Provider, EffortLevel>>;
  };
  claudePath?: string;
  idleMinutes?: number;
  maxLiveCLIs?: number;
  codexPath?: string;
  codexArgs?: string[];
  cliUpdates?: Partial<CliUpdatesConfig>;
  accountNotes?: Record<string, string>;
  poolFolders?: Record<string, string[]>;
  sandbox?: unknown;
  pools?: unknown[];
  followMain?: boolean;
  // The ssh host that ./check.sh sends the repo's checks to, so suites and
  // the app's test windows stay off this Mac (scripts/check-remote.sh), or
  // checkHosts, several tried in order, which wins (a check.sh from before
  // the list reads only checkHost). Only check.sh reads them.
  checkHost?: string;
  checkHosts?: string[];
  bulletReplies?: boolean;
  oneReply?: boolean;
  // bringIn: how often a fork's runner starts a thread to bring in Mike's
  // releases (bring-in.ts): every so many days, 'important' or 'off'.
  releases?: { publish?: boolean; signingKey?: string; bringIn?: number | 'important' | 'off' };
  models?: { pool?: string | null; privateFolders?: string[] };
  // icon: an SF Symbol for this runner in lists (machine.ts works one out).
  // rpcUrl: how a Mac app reaches this runner over the tailnet (step 6 part 2).
  // full: true sends tool output to your Convex deployment as well, scrubbed first
  // (docs/full-convex.md). Off unless you say so.
  // pastedPictures: false keeps pictures you paste off your Convex deployment
  // (docs/on-your-mac.md).
  sync?: { enabled?: boolean; url?: string; site?: string; name?: string; runnerId?: string; icon?: string; rpcUrl?: string; pastedPictures?: boolean; full?: boolean };
  secretCheck?: { enabled?: boolean };
  // Days after a thread is archived that housekeeping clears its pictures
  // (housekeeping.ts). Absent: they're kept. Mike's runners set 30.
  archivedMediaDays?: number;
  // Features still being tried out, each off unless it says (experiments.ts).
  experiments?: Record<string, boolean>;
  // The gateway, when it isn't the `connectors` MCP server in
  // ~/.claude.json; url "" or enabled: false turns the panel's polling off.
  connectors?: { url?: string; enabled?: boolean; headersHelper?: string };
};

export function defaultHome(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear');
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function readRunnerJson(home: string): RunnerJson {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8')) as RunnerJson;
  } catch {
    return {};
  }
}

export function writeRunnerJson(home: string, data: RunnerJson): void {
  atomicWriteFileSync(path.join(home, 'runner.json'), JSON.stringify(data, null, 2) + '\n');
}

// The app finds the runner through runner.json, so it always names the port
// the runner is actually listening on (THREADBEAR_PORT and port 0 included),
// and shows the default folder so it's easy to change.
export function recordListening(home: string, port: number, defaultCwd: string): void {
  const json = readRunnerJson(home);
  if (json.port === port && json.defaults?.cwd) return;
  json.port = port;
  json.defaults = { cwd: defaultCwd, ...json.defaults };
  writeRunnerJson(home, json);
}

// The app was called Threadbare until 27 Oct 2026, and its variables were
// THREADBARE_*. Threads, skills and launchd jobs from before then may still
// set the old names, so each one stands in for its new name when that
// isn't set. On import, so every entry point (the runner, tb) gets it.
export function adoptOldNames(env: NodeJS.ProcessEnv): void {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('THREADBARE_') || v === undefined) continue;
    const name = 'THREADBEAR_' + k.slice('THREADBARE_'.length);
    if (env[name] === undefined) env[name] = v;
  }
}
adoptOldNames(process.env);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  adoptOldNames(env);
  // THREADBEAR_DATA_DIR is the name the Mac app uses for the same override.
  const home = path.resolve(expandHome(env.THREADBEAR_HOME || env.THREADBEAR_DATA_DIR || defaultHome()));
  const json = readRunnerJson(home);
  const port = Number(env.THREADBEAR_PORT || json.port || DEFAULT_PORT);
  const idleMs = env.THREADBEAR_IDLE_MS
    ? Number(env.THREADBEAR_IDLE_MS)
    : (json.idleMinutes ?? 30) * 60_000;
  const maxLive = Number(env.THREADBEAR_MAX_LIVE || json.maxLiveCLIs || DEFAULT_MAX_LIVE);
  const codexPath = nonEmpty(env.THREADBEAR_CODEX_PATH) ?? nonEmpty(json.codexPath);
  const models = providerMap(json.defaults?.models, nonEmpty);
  const efforts = providerMap(json.defaults?.efforts, (v) => (isEffortLevel(v) ? v : undefined));
  return {
    home,
    port,
    host: '127.0.0.1',
    maxLive: Number.isFinite(maxLive) && maxLive >= 1 ? Math.floor(maxLive) : DEFAULT_MAX_LIVE,
    logFile: expandHome(env.THREADBEAR_LOG || path.join(os.homedir(), 'Library', 'Logs', 'threadbear-runner.log')),
    claudePath: expandHome(env.THREADBEAR_CLAUDE_PATH || json.claudePath || '~/.local/bin/claude'),
    idleMs,
    defaults: {
      cwd: expandHome(json.defaults?.cwd || DEFAULT_CWD),
      accountId: json.defaults?.accountId,
      ...(nonEmpty(json.defaults?.poolId) ? { poolId: nonEmpty(json.defaults?.poolId) } : {}),
      model: nonEmpty(json.defaults?.model),
      ...(models ? { models } : {}),
      ...(efforts ? { efforts } : {}),
    },
    claudeMainDir: expandHome(env.THREADBEAR_CLAUDE_MAIN_DIR || '~/.claude'),
    claudeMainJson: expandHome(env.THREADBEAR_CLAUDE_MAIN_JSON || '~/.claude.json'),
    tokenStatsAccountsDir: expandHome(
      env.THREADBEAR_ACCOUNTS_DIR || '~/Library/Application Support/Token Stats/Accounts',
    ),
    accountsDir: path.join(home, 'accounts'),
    followMain: env.THREADBEAR_FOLLOW_MAIN ? env.THREADBEAR_FOLLOW_MAIN !== '0' : json.followMain !== false,
    bulletReplies: json.bulletReplies !== false,
    // On unless runner.json turns it off (2 Nov: Mike found it the right
    // balance, and it's no longer in Settings).
    oneReply: json.oneReply !== false,
    ...(json.releases?.publish === true ? { releases: { publish: true, ...(typeof json.releases.signingKey === 'string' ? { signingKey: expandHome(json.releases.signingKey) } : {}) } } : {}),
    models: modelSettingsFrom(json),
    ...(codexPath ? { codexPath: expandHome(codexPath) } : {}),
    codexArgs: Array.isArray(json.codexArgs) ? json.codexArgs.filter((a): a is string => typeof a === 'string') : [],
    codexMainDir: expandHome(env.THREADBEAR_CODEX_MAIN_DIR || '~/.codex'),
    tokenStatsLimitsFile: expandHome(
      env.THREADBEAR_TOKEN_STATS_LIMITS || '~/Library/Application Support/Token Stats/limits.json',
    ),
    cliUpdates: cliUpdatesConfig(json.cliUpdates, env.THREADBEAR_CLI_UPDATES),
    tokenTally: env.THREADBEAR_TOKEN_TALLY !== 'off',
    accountNotes: stringMap(json.accountNotes) ?? { ...DEFAULT_ACCOUNT_NOTES },
    poolFolders: folderMap(json.poolFolders) ?? { ...DEFAULT_POOL_FOLDERS },
    ...((sb) => (sb ? { sandbox: sb } : {}))(readSandbox(json.sandbox, expandHome)),
    ...(Array.isArray(json.pools) && json.pools.length ? { pools: json.pools } : {}),
    sync: syncConfig(json.sync, env),
    secretCheck: json.secretCheck?.enabled === true,
    ...connectorsConfig(json.connectors, env, expandHome(env.THREADBEAR_CLAUDE_MAIN_JSON || '~/.claude.json')),
  };
}

// THREADBEAR_CONNECTORS_URL wins (empty or "off" turns it off, for tests),
// then runner.json, then the main login's `connectors` MCP server. The
// gateway's calls carry its token, so a URL that isn't https (or plain
// http to this Mac) leaves it off rather than falling back on the next.
function connectorsConfig(raw: RunnerJson['connectors'], env: NodeJS.ProcessEnv, claudeJson: string): Pick<Config, 'connectorsUrl' | 'connectorsClient' | 'connectorsRefused'> {
  const fromEnv = env.THREADBEAR_CONNECTORS_URL;
  const found = fromEnv !== undefined ? (fromEnv.trim() && fromEnv.trim() !== 'off' ? { url: fromEnv.trim(), from: 'THREADBEAR_CONNECTORS_URL' } : undefined) : gatewayUrlFrom(raw, claudeJson);
  if (!found) return {};
  const problem = credentialUrlProblem(found.url);
  if (problem) return { connectorsRefused: `${found.from} ${problem}` };
  const url = gatewayBase(found.url);
  if (!url) return {};
  const client = fromEnv !== undefined ? undefined : findGatewayClient(raw, claudeJson);
  return { connectorsUrl: url, ...(client ? { connectorsClient: client } : {}) };
}

// THREADBEAR_SYNC=off wins over runner.json; THREADBEAR_SYNC_URL points a
// test or dev runner at its own deployment. Every post carries the runner
// key and thread text, so a URL that isn't https (or plain http to this
// Mac, a local backend) isn't used: sync stays off and says why, rather
// than falling back on runner.json's.
function syncConfig(raw: RunnerJson['sync'], env: NodeJS.ProcessEnv): Config['sync'] {
  const fromEnv = nonEmpty(env.THREADBEAR_SYNC_URL);
  const url = fromEnv ?? nonEmpty(raw?.url);
  const out: Config['sync'] = { enabled: env.THREADBEAR_SYNC === 'off' ? false : raw?.enabled !== false };
  const problem = url ? credentialUrlProblem(url) : undefined;
  if (problem) out.urlRefused = `${fromEnv ? 'THREADBEAR_SYNC_URL' : 'sync.url in runner.json'} ${problem}`;
  else if (url) out.url = url;
  // Where the website is, for a self-hosted backend, which serves it on a
  // port of its own (docs/self-hosting.md). A cloud deployment leaves it
  // out: its site is the .convex.site twin of url.
  const site = nonEmpty(raw?.site);
  if (site) out.site = site;
  const name = nonEmpty(raw?.name);
  if (name) out.name = name;
  const runnerId = nonEmpty(raw?.runnerId);
  if (runnerId) out.runnerId = runnerId;
  const icon = nonEmpty(raw?.icon);
  if (icon) out.icon = icon;
  const rpcUrl = nonEmpty(raw?.rpcUrl);
  if (rpcUrl) out.rpcUrl = rpcUrl;
  if (raw?.pastedPictures === false) out.pastedPictures = false;
  if (raw?.full === true) out.full = true;
  return out;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// { claude?, codex? } with only the providers that have a usable value;
// undefined when none has, so an unset map stays absent.
function providerMap<V>(raw: unknown, read: (v: unknown) => V | undefined): Partial<Record<Provider, V>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Partial<Record<Provider, V>> = {};
  for (const [p, v] of Object.entries(raw)) {
    const value = read(v);
    if (isProvider(p) && value !== undefined) out[p] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// runner.json poolFolders: login id to folders. Anything else is ignored.
function folderMap(v: unknown): Record<string, string[]> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(v)) if (Array.isArray(list)) out[k] = list.filter((x): x is string => typeof x === 'string');
  return out;
}

function stringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

// THREADBEAR_CLI_UPDATES=off turns both off whatever runner.json says: tests
// and dev runners must never install a CLI.
function cliUpdatesConfig(raw: Partial<CliUpdatesConfig> | undefined, envValue: string | undefined): CliUpdatesConfig {
  const policy = (v: unknown, fallback: CliPolicy): CliPolicy =>
    typeof v === 'string' && (CLI_POLICIES as readonly string[]).includes(v) ? (v as CliPolicy) : fallback;
  const count = (v: unknown, fallback: number, min: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
  const off = envValue === 'off';
  return {
    claude: off ? 'off' : policy(raw?.claude, DEFAULT_CLI_UPDATES.claude),
    codex: off ? 'off' : policy(raw?.codex, DEFAULT_CLI_UPDATES.codex),
    checkMinutes: count(raw?.checkMinutes, DEFAULT_CLI_UPDATES.checkMinutes, 1),
    // Fewer than 2 would leave nothing for "Go back".
    keepCodexVersions: count(raw?.keepCodexVersions, DEFAULT_CLI_UPDATES.keepCodexVersions, 2),
  };
}

export const DEFAULT_SMALL_MODEL_POOL = 'claude';

export function modelSettingsFrom(json: RunnerJson): Config['models'] {
  const folders = json.models?.privateFolders;
  const pool = json.models?.pool;
  return {
    // Absent or not a string: the Claude pool. null is Mike saying none.
    pool: pool === null ? null : typeof pool === 'string' && pool.trim() ? pool.trim() : DEFAULT_SMALL_MODEL_POOL,
    privateFolders: Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [],
  };
}

// Where a client (tb) finds the runner. THREADBEAR_PORT=0 tells a runner to
// take any free port, and the CLIs a dev or sandbox runner starts inherit
// it, so then the port it got, in runner.json, is the one to use.
export function runnerUrl(cfg: Config, env: NodeJS.ProcessEnv = process.env): string {
  if (env.THREADBEAR_URL) return env.THREADBEAR_URL;
  const port = cfg.port || readRunnerJson(cfg.home).port || DEFAULT_PORT;
  return `ws://127.0.0.1:${port}/rpc`;
}

export const paths = {
  secrets: (home: string) => path.join(home, 'secrets'),
  token: (home: string) => path.join(home, 'secrets', 'runner-token'),
  threads: (home: string) => path.join(home, 'threads'),
  thread: (home: string, id: string) => path.join(home, 'threads', id),
  media: (home: string, id: string) => path.join(home, 'threads', id, 'media'),
  blobs: (home: string, id: string) => path.join(home, 'threads', id, 'blobs'),
  panels: (home: string, id: string) => path.join(home, 'threads', id, 'panels'),
  inbox: (home: string) => path.join(home, 'inbox'),
  run: (home: string) => path.join(home, 'run'),
};

// Creates the data dir layout and the bearer token (0600) if missing.
export function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(paths.threads(home), { recursive: true });
  fs.mkdirSync(paths.inbox(home), { recursive: true });
  fs.mkdirSync(paths.run(home), { recursive: true });
  fs.mkdirSync(paths.secrets(home), { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.secrets(home), 0o700);
  const tokenPath = paths.token(home);
  if (!fs.existsSync(tokenPath)) {
    fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  }
  fs.chmodSync(tokenPath, 0o600);
}

export function readToken(home: string): string {
  return fs.readFileSync(paths.token(home), 'utf8').trim();
}
