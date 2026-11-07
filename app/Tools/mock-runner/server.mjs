#!/usr/bin/env node
// A stand-in runner for building and testing the app without the real one.
// It speaks docs/protocol.md over a WebSocket, serves fixture threads, fakes
// turns when you send a message, and can replay a 30 Hz stream on request.
//
// Usage:
//   node server.mjs --data-dir /tmp/tb-mock [--port 0] [--fixtures dir]... [--filler 16]
//                   [--ready-file FILE] [--exit-with-pid-file FILE] [--quiet]
//
// --exit-with-pid-file names a file holding the pid of the app it serves
// (Tools/dev-app.sh writes it): the mock exits once that app has quit, or
// once the file has been missing for two minutes (the instance was deleted
// or never started), so a debug app that's never stopped doesn't leave a
// mock behind.
//
// It writes <data-dir>/runner.json ({ port }) and <data-dir>/secrets/runner-token
// (random, 0600) so the app can point at it with --data-dir. Nothing touches
// the real runner's data folder unless you pass it, so don't.

import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The tour's sample threads, the runner's own (it runs TypeScript as it is).
import { SAMPLE_THREADS } from '../../../runner/src/samples.ts';
import { fileURLToPath } from 'node:url';
import { reviewDraft, reviewReply, sameDraft } from '../../../runner/src/reviews.ts';
import { authProof, isNonce, newNonce } from '../../../runner/src/rpc-auth.ts';

// What a waiting (untrusted) demo patch gives once it's trusted, by file.
const waitingPatchGives = new Map();

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const dataDir = args['data-dir'];
if (!dataDir) {
  console.error('mock-runner: --data-dir is required (use a temp folder)');
  process.exit(2);
}
const realDataDir = path.join(process.env.HOME ?? '', 'Library/Application Support/Threadbear');
if (path.resolve(dataDir) === path.resolve(realDataDir)) {
  console.error('mock-runner: refusing to use the real runner data folder');
  process.exit(2);
}
// Resolved to absolute paths: image paths in events are built from these and
// the app reads them from its own working folder.
const fixtureDirs = (args.fixtures.length ? args.fixtures : defaultFixtureDirs()).map((dir) => path.resolve(dir));
const fillerCount = Number(args.filler ?? 0);
const quiet = Boolean(args.quiet);

// The model list a real runner learns from each account's CLI, and the
// default its settings name.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const models = [
  { id: 'opus', model: 'claude-opus-5-5', title: 'Opus 5.5', description: 'For complex work and everyday tasks', effortLevels: EFFORTS },
  { id: 'claude-fable-5-1[1m]', model: 'claude-fable-5-1', title: 'Fable 5.1', description: 'For your toughest challenges', effortLevels: EFFORTS },
  { id: 'sonnet', model: 'claude-sonnet-5-5', title: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', effortLevels: EFFORTS },
  { id: 'haiku', model: 'claude-haiku-5-5', title: 'Haiku 5.5', description: 'Fastest for quick answers', effortLevels: EFFORTS },
  { id: 'claude-haiku-4-5-20251001', model: 'claude-haiku-4-5-20251001', title: 'Haiku 4.5', description: 'Fastest for quick answers' },
  { id: 'claude-opus-5', model: 'claude-opus-5', title: 'Opus 5', description: 'Best for everyday, complex tasks', effortLevels: EFFORTS },
];
// Codex's list, as its model/list gives it: its own levels (up to ultra;
// the luna models stop at max) and a default level per model.
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const codexModels = [
  { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', title: 'GPT-6.1-Sol', description: 'Frontier model for complex work', effortLevels: CODEX_EFFORTS, defaultEffort: 'low' },
  { id: 'gpt-6-luna', model: 'gpt-6-luna', title: 'GPT-6-Luna', description: 'Fast and affordable', effortLevels: CODEX_EFFORTS.slice(0, 5), defaultEffort: 'medium' },
];
// Usage as the runner reports it from Token Stats' limits.json and live
// readings, relative to now so reset times stay in the future. `extra`
// overrides any field: `windows` replaces both windows, `more` adds
// smaller ones after them, `readAgoMinutes` dates the reading.
const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
function usage(fiveHour, weekly, { more = [], readAgoMinutes = 0, ...extra } = {}) {
  return {
    windows: [
      { kind: 'five_hour', title: '5-hour', remainingPercent: fiveHour, resetsAt: hoursFromNow(2) },
      { kind: 'weekly', title: 'Weekly', remainingPercent: weekly, resetsAt: hoursFromNow(70) },
      ...more,
    ],
    readAt: new Date(Date.now() - readAgoMinutes * 60_000).toISOString(),
    source: 'tokenStats',
    ...extra,
  };
}
// Mike's logins as the real runner lists them: the main one, claude-2 with
// his note (it's for work, so never picked for a new thread), a stale
// Token Stats reading, one at its limit, and Codex (Pro Lite has only a
// weekly window).
const tokenStatsAccounts = '~/Library/Application Support/Token Stats/Accounts';
// What Token Stats writes under every account when its last check failed:
// the app says it once, not under each one.
const couldntCheck = "Couldn't check usage just now, so these are its last numbers.";
let accounts = [
  {
    id: 'claude-main', provider: 'claude', title: 'mike@example.com', configDir: '~/.claude', defaultModel: 'claude-fable-5-1', models,
    email: 'mike@example.com', plan: 'Max',
    // Max plans lost the 5-hour window at the end of Oct 2026; Team and
    // Pro (below) still have it.
    usage: usage(0, 78, {
      windows: [
        { kind: 'weekly', title: 'Weekly', remainingPercent: 78, resetsAt: hoursFromNow(70) },
        { kind: 'weekly_model', title: 'Weekly Fable', remainingPercent: 71, resetsAt: hoursFromNow(70) },
      ],
      notice: `${couldntCheck} · $48.85 extra usage spent`,
    }),
  },
  {
    id: 'claude-2', provider: 'claude', title: 'work@example.com', configDir: `${tokenStatsAccounts}/claude-2`,
    defaultModel: 'claude-fable-5-1', models, email: 'work@example.com', plan: 'Team', note: 'Convex work only',
    usage: usage(95, 90, { notice: couldntCheck, more: [{ kind: 'weekly_model', title: 'Weekly Fable', remainingPercent: 97, resetsAt: hoursFromNow(70) }] }),
  },
  {
    id: 'claude-3', provider: 'claude', title: 'mike+3@example.com', configDir: `${tokenStatsAccounts}/claude-3`,
    defaultModel: 'claude-fable-5-1', models, email: 'mike+3@example.com', plan: 'Team',
    usage: usage(12, 40, { stale: true, readAgoMinutes: 75, notice: couldntCheck }),
  },
  {
    id: 'claude-4', provider: 'claude', title: 'mike+4@example.com', configDir: `${tokenStatsAccounts}/claude-4`,
    defaultModel: 'claude-fable-5-1', models, email: 'mike+4@example.com', plan: 'Pro',
    usage: usage(0, 31, {
      blocked: true,
      windows: [
        { kind: 'five_hour', title: '5-hour', remainingPercent: 0, resetsAt: hoursFromNow(1.5) },
        { kind: 'weekly', title: 'Weekly', remainingPercent: 31, resetsAt: hoursFromNow(52) },
      ],
    }),
  },
  {
    id: 'codex-main', provider: 'codex', title: 'Codex · mike@example.com', configDir: '~/.codex', defaultModel: 'gpt-6.1-sol',
    defaultEffort: 'high', models: codexModels, email: 'mike@example.com', plan: 'Pro Lite',
    usage: usage(0, 0, {
      source: 'live', notice: '64,390 credits · 2 limit resets available',
      windows: [
        // The credits are in the notice too: the app shows them once.
        { kind: 'weekly', title: 'Weekly', remainingPercent: 64, resetsAt: hoursFromNow(96), detail: '64,390 credits' },
        { kind: 'other', title: 'GPT-6.1-Sol', remainingPercent: 82, resetsAt: hoursFromNow(96) },
      ],
    }),
  },
];
// usage.stats (docs/protocol.md, "Usage history"), made up but steady: the
// same seed every time, so screenshots only change when the code does.
// Each login works the hours of a day (busier in the afternoon, quiet at
// night), at its own pace; its weekly and 5-hour readings go down with its
// tokens and come back at its resets, ending on what `accounts` says now.
const tokenPace = { 'claude-main': 1.0, 'claude-2': 0.08, 'claude-3': 0.45, 'claude-4': 0.7, 'codex-main': 0.25 };
function seeded(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function mockUsageStats(days) {
  const HOUR = 3_600_000;
  const now = Date.now();
  const since = now - days * 24 * HOUR;
  const firstHour = Math.floor(since / HOUR) * HOUR;
  const tokens = [];
  const limits = [];
  for (const [i, a] of accounts.entries()) {
    const pace = tokenPace[a.id] ?? 0.2;
    const rand = seeded(17 + i * 101);
    const hours = [];
    for (let h = firstHour; h <= now; h += HOUR) {
      const local = new Date(h).getHours();
      // A working day: nothing from 1am to 7am, building to mid-afternoon.
      const shape = local < 7 && local >= 1 ? 0 : Math.max(0, Math.sin(((local - 7 + 24) % 24) / 18 * Math.PI));
      const busy = shape * pace * (0.4 + rand() * 1.2);
      if (busy < 0.02) continue;
      const total = Math.round(busy * 28_000_000);
      // Mostly cache reads, as real Claude and Codex turns are.
      const cacheRead = Math.round(total * 0.94);
      const cacheWrite = a.provider === 'codex' ? 0 : Math.round(total * 0.04);
      const output = Math.round(total * 0.006);
      hours.push([h, total - cacheRead - cacheWrite - output, output, cacheRead, cacheWrite]);
    }
    tokens.push({ accountId: a.id, hours });
    // A model's own week ("Weekly Fable") is charted too, under its title.
    const charted = (a.usage?.windows ?? []).filter((x) => ['weekly', 'five_hour', 'weekly_model'].includes(x.kind));
    for (const w of charted) {
      const kind = w.kind;
      if (!w?.resetsAt) continue;
      const week = kind !== 'five_hour';
      const length = (week ? 168 : 5) * HOUR;
      const reset = Date.parse(w.resetsAt);
      // Walk back from now, one window at a time: each goes from 100 down
      // to where it ended, the current one to what it says now.
      const samples = [];
      let end = now;
      let endPct = w.remainingPercent;
      for (let start = reset - length; end > since; start -= length) {
        const from = Math.max(start, since);
        const steps = Math.max(2, Math.round((end - from) / (week ? 3 * HOUR : 20 * 60_000)));
        const run = [];
        for (let k = 0; k <= steps; k++) {
          const t = from + ((end - from) * k) / steps;
          const done = (t - start) / (end - start);
          run.push([Math.round(t), Math.round((100 - (100 - endPct) * Math.pow(done, 1.1)) * 10) / 10]);
        }
        samples.unshift(...run);
        end = start - 1;
        endPct = week ? 20 + rand() * 40 : 10 + rand() * 60;
        // Only today's 5-hour windows: older ones say nothing more.
        if (kind === 'five_hour' && end < now - 15 * HOUR) break;
      }
      limits.push({ accountId: a.id, kind, ...(kind === 'weekly_model' ? { title: w.title } : {}), samples });
    }
  }
  return { generatedAt: iso(), ready: true, tokens, limits };
}
// mock.accounts {old: true}: acts like a runner from before step 4, with
// no Codex accounts, no usage, notes or plans on the rest, and no clis.*
// requests.
let oldRunner = false;
const publicAccounts = () => (oldRunner
  ? accounts.filter((a) => a.provider !== 'codex').map(({ usage: _u, note: _n, plan: _p, email: _e, defaultEffort: _d, ...rest }) => rest)
  : accounts);
const providerOf = (accountId) => accounts.find((a) => a.id === accountId)?.provider ?? 'claude';
// The synthetic fixtures live under a made-up /Users/mike, so the default
// folder does too: the app only shows a folder chip away from the default.
const defaults = {
  cwd: '/Users/mike/dev/me/misc', accountId: 'claude-main',
  models: { codex: 'gpt-6-luna' }, efforts: { codex: 'low' }, poolId: 'claude',
};
// Pools (docs/pools-plan.md). The built-in ones as the runner works them
// out from these logins (one per provider of the logins with no note, one
// per noted login titled from its note), then two of Mike's own: a mixed
// one, Codex first, and one whose only login is at its limit, so a thread
// in it waits for room. mock.accounts {old: true} hides them all.
let pools = [
  { id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-3', 'claude-4'], builtIn: true },
  { id: 'convex', title: 'Convex', accountIds: ['claude-2'], folders: ['~/dev/convex'], builtIn: true },
  { id: 'codex', title: 'Codex', accountIds: ['codex-main'], builtIn: true },
  { id: 'side-projects', title: 'Side projects', accountIds: ['codex-main', 'claude-3'], icon: 'hammer' },
  { id: 'evenings', title: 'Evenings', accountIds: ['claude-4'], icon: 'moon' },
];
const poolOf = (id) => pools.find((pool) => pool.id === id);
// The room a login has: the tighter of its 5-hour and weekly windows; none
// when it's blocked. Unknown usage counts as room.
function roomOf(account) {
  if (account.usage?.blocked) return -1;
  const main = (account.usage?.windows ?? []).filter((w) => w.kind === 'five_hour' || w.kind === 'weekly');
  return main.length ? Math.min(...main.map((w) => w.remainingPercent)) : 50;
}
// A login in the pool on `provider` (the pool's first provider without
// one): the current one while it has room, else the one with the most.
function pickInPool(pool, provider, current) {
  const own = pool.accountIds.map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
  const want = provider ?? own[0]?.provider;
  const candidates = own.filter((a) => a.provider === want);
  const cur = candidates.find((a) => a.id === current);
  if (cur && roomOf(cur) >= 10) return cur.id;
  return [...candidates].sort((a, b) => roomOf(b) - roomOf(a))[0]?.id;
}
// The provider whose account lists a model id, if any does.
const providerOfModel = (model) => model && accounts.find((a) => (a.models ?? []).some((m) => m.id === model || m.model === model))?.provider;
function validatePools(list) {
  if (!Array.isArray(list) || list.length === 0) throw rpcError(-32602, 'pools must be a non-empty list');
  const seen = new Set();
  for (const pool of list) {
    if (!pool?.id || seen.has(pool.id)) throw rpcError(-32602, `duplicate or missing pool id ${pool?.id ?? ''}`);
    seen.add(pool.id);
    if (!Array.isArray(pool.accountIds) || pool.accountIds.length === 0) throw rpcError(-32602, `${pool.title ?? pool.id} has no logins`);
    const unknown = pool.accountIds.find((id) => !accounts.some((a) => a.id === id));
    if (unknown) throw rpcError(-32602, `unknown account ${unknown}`);
  }
}
// What clis.list reports: Claude one version behind, Codex's update held
// back by the schema gate, both checked 20 minutes ago.
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const clis = [
  {
    provider: 'claude', path: '/Users/mike/.local/bin/claude', managedBy: 'cli', installedVersion: '2.1.311', latestVersion: '2.1.312',
    status: 'behind', policy: 'auto', inUse: [], checkedAt: minutesAgo(20),
  },
  {
    provider: 'codex', path: '/Users/mike/Library/Application Support/Threadbear/tools/codex/current', managedBy: 'threadbear',
    installedVersion: '0.164.0', latestVersion: '0.165.0', status: 'held', policy: 'auto', inUse: [], previousVersion: '0.163.0',
    checkedAt: minutesAgo(20),
    hold: { version: '0.165.0', reason: 'the app-server protocol changed', missing: ['thread/backgroundTerminals/list'] },
  },
];
// The Settings window's settings, as a runner with a key set and a little
// spent would have them, so a shot of it has something in every row.
// Settings › Phone & browser: what the demo shows as paired. The
// deployment and site are made up, so a demo pairing link opens nothing.
const DEMO_DEPLOYMENT = 'https://demo-bear-123.convex.cloud';
const DEMO_SITE = 'https://demo-bear-123.convex.site';
const devices = [
  { id: 'tok1', kind: 'phone', name: 'iPhone', createdAt: '2026-10-21T09:12:00.000Z', expiresAt: '2027-01-19T09:12:00.000Z', expired: false },
  { id: 'tok2', kind: 'browser', name: 'Chrome', createdAt: '2026-10-22T14:30:00.000Z', expiresAt: '2027-01-20T14:30:00.000Z', expired: false },
  { id: 'tok3', kind: 'browser', name: 'Safari', createdAt: '2026-07-01T08:00:00.000Z', expiresAt: '2026-09-29T08:00:00.000Z', expired: true },
];
let deviceSeq = devices.length;
const deviceList = () => ({ devices: [...devices], site: DEMO_SITE });

let mockInstructions = { text: '' };
const settings = {
  defaultCwd: defaults.cwd, idleMinutes: 30, maxLiveCLIs: 6, followMain: true, bulletReplies: true, oneReply: true,
  models: {
    pool: 'claude',
    privateFolders: ['~/dev/clients/acme'],
  },
};

/** threadId -> { summary, events: [], inProgress: Map(itemId -> {type,text}), timers: [] } */
const threads = new Map();
loadFixtures();
addFillers(fillerCount);
addDemoPanels();
addDemoPools();
/** threadId -> ThreadHighlights (docs/protocol.md, "Highlights"). */
const highlights = new Map();
addDemoHighlights();
addDemoSubagents();
applyScriptedThreads();
/**
 * The runners a schedule can run on (runners.list, docs/protocol.md,
 * "Schedules", "Runners"): this one first, and an online "bruce", as if
 * sync were on with a backend that has both. A runner played as old
 * (mock.accounts {old: true}) answers runners.list with -32601.
 */
const SELF_RUNNER = { id: 'runner_mock', name: 'm5', icon: 'laptopcomputer', self: true };
const runners = [SELF_RUNNER, { id: 'runner_bruce', name: 'bruce', icon: 'macmini', self: false }];
// Bruce's own threads (docs/protocol.md, "Other runners' threads"). This
// mock plays bruce too, on /bruce/rpc with the same token: its threads sit
// in `threads` marked with `runnerId`, and only a client connected as
// bruce lists them, gets their events or can act on them. A client of this
// runner hears of them through remoteThreads.list and remoteThreads.updated,
// as the real runner passes on what the backend has.
const BRUCE = 'runner_bruce';
// Mike's runner order (backend API 58), every runner's id: set with
// runners.setOrder and said back in remoteThreads.updated, as the real
// runner passes on the backend's.
// MOCK_MORE_RUNNERS=1 adds two more, for a list worth rearranging (only for
// a look at Settings > Runners: the usual demo stays at two).
const MORE_RUNNERS = process.env.MOCK_MORE_RUNNERS ? [
  { id: 'runner_cloud', name: 'Hetzner Cloud', icon: 'cloud', online: true, lastSeenAt: new Date().toISOString() },
  { id: 'runner_pixel', name: 'Pixel', icon: 'smartphone', online: true, lastSeenAt: new Date().toISOString() },
] : [];
let runnerOrder = ['runner_mock', BRUCE, ...MORE_RUNNERS.map((r) => r.id)];
// Files on bruce's Mac that its threads name, for files.read from
// /bruce/rpc (docs/protocol.md, "Other runners' threads"): the picture is a
// real PNG, the rest text. None of these paths exist on this Mac.
const BRUCE_FILES = {
  picture: '/Users/bruce/Library/Application Support/Threadbear/media/backblaze.png',
  list: '/Volumes/CannMedia/duplicates.txt',
  blob: '/Users/bruce/Library/Application Support/Threadbear/threads/bruce_media/blobs/bruce_media_c0_0.txt',
};
const bruceModifiedAt = new Date(Date.now() - 3600_000).toISOString();
if (!process.env.TB_MOCK_NO_REMOTE) addRemoteDemo();
/** The schedules (docs/protocol.md, "Schedules"), soonest first. */
let schedules = [];
addDemoSchedules();
/** The projects (docs/protocol.md, "Projects"), and the librarian's status. */
let projects = [];
let librarian;
const MOCK_GATEWAY = 'https://bruce.example.ts.net:8443';
let connectors = {
  state: 'ok',
  url: MOCK_GATEWAY,
  version: '0.2.0',
  checkedAt: new Date().toISOString(),
  services: [
    { id: 'notion', title: 'Notion', state: 'connected' },
    { id: 'sentry', title: 'Sentry', state: 'signed_out', message: 'The sign-in expired.', connectUrl: `${MOCK_GATEWAY}/admin/connect/sentry` },
    { id: 'cloudflare', title: 'Cloudflare', state: 'connected' },
    { id: 'deepwiki', title: 'DeepWiki', state: 'connected' },
  ],
};
addDemoProjects();

const token = crypto.randomBytes(24).toString('hex');
fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'inbox'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'secrets/runner-token'), token + '\n', { mode: 0o600 });
// Bruce's token, where the real runner keeps another runner's once it's
// been copied in (secrets/runners/<id>.token). Bruce is this mock, so it's
// the same token.
fs.mkdirSync(path.join(dataDir, 'secrets/runners'), { recursive: true });
fs.writeFileSync(path.join(dataDir, `secrets/runners/${BRUCE}.token`), token + '\n', { mode: 0o600 });
// And the host beside it, as `tb pair` on Bruce says to copy: the app sends
// the token nowhere without one (RunnerHostPin). Its rpcUrl is 127.0.0.1.
fs.writeFileSync(path.join(dataDir, `secrets/runners/${BRUCE}.host`), '127.0.0.1\n', { mode: 0o600 });

// What `hello` and `runner.status` report. mock.restart bumps the version,
// as a deploy would, so the app's "Runner restarted" note has two to name.
let runnerVersion = '0.0.0-mock';
let restarts = 0;
const startedAt = iso();
// A restart waiting for threads (mock.restartPending): { when, reason?,
// resumeThreadId?, requestedAt, waitingFor: string[] }.
let pendingRestart;
// A runner on a loaded Mac (mock.slow): `ms` holds threads.send,
// threads.create and threads.update that long before they're handled, as
// a stalled event loop does; `queueMs` answers threads.send at once but
// starts its turn (and its user.message) that much later, as a message
// queued behind a running turn is. Both 0 by default.
let slow = { ms: 0, queueMs: 0 };
// The runner's own update (protocol "Runner updates"), set by mock.updates.
let updates = { state: 'idle', oldRunners: [] };

/** @type {Set<{ws: any, subs: Set<string>, authed: boolean}>} */
const clients = new Set();

let wss = listen(Number(args.port ?? 0));

// The WebSocket server, on its own so mock.restart can close it and listen
// again on the same port, the way the real runner goes away and comes back.
function listen(port) {
  // No `path`: /rpc is this runner and /bruce/rpc is bruce (onConnection).
  const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 64 * 1024 * 1024 });
  server.on('listening', () => {
    const { port } = server.address();
    // Renamed into place like the real runner's (atomicWriteFileSync): a
    // reader that caught it half written saw no port, fell back to 8797,
    // the live runner's, and was refused as unauthorized (testPools, 5 Nov).
    const config = path.join(dataDir, 'runner.json');
    fs.writeFileSync(`${config}.tmp`, JSON.stringify({ port, mock: true }, null, 2));
    fs.renameSync(`${config}.tmp`, config);
    log(`listening on ws://127.0.0.1:${port}/rpc with ${threads.size} threads`);
    // Written whole and renamed into place, so a reader never sees it empty.
    if (args['ready-file']) {
      fs.writeFileSync(`${args['ready-file']}.tmp`, String(port));
      fs.renameSync(`${args['ready-file']}.tmp`, args['ready-file']);
    }
  });
  server.on('connection', onConnection);
  return server;
}

function onConnection(ws, request) {
  const where = (request.url ?? '').split('?')[0];
  if (where !== '/rpc' && where !== '/bruce/rpc') return ws.close(4404, 'not found');
  const header = request.headers['authorization'] ?? '';
  // `as` is whose threads it sees: this runner's (null) or bruce's.
  const client = { ws, subs: new Set(), authed: header === `Bearer ${token}`, as: where === '/bruce/rpc' ? BRUCE : null };
  clients.add(client);
  ws.on('close', () => clients.delete(client));
  // The real runner's auth challenge (docs/protocol.md, "Auth"), for a
  // client that didn't send the old bearer header.
  const challenge = client.authed ? null : newNonce();
  // Bound to its own listening port, as the real runner's are.
  const channel = { server: 'primary', port: request.socket.localPort };
  if (challenge) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth.challenge', params: { version: 1, nonce: challenge, port: channel.port } }));
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      if (!client.authed) return ws.close(4401, 'unauthorized');
      return reply(client, null, null, { code: -32700, message: 'Parse error' });
    }
    if (!client.authed) {
      const p = message.params ?? {};
      if (message.method === 'auth.prove' && challenge && isNonce(p.nonce) && p.proof === authProof(token, 'client', challenge, p.nonce, channel)) {
        client.authed = true;
        return reply(client, message.id, { proof: authProof(token, 'runner', challenge, p.nonce, channel) });
      }
      if (message.method === 'auth' && p.token === token) {
        client.authed = true;
        return reply(client, message.id, {});
      }
      return ws.close(4401, 'unauthorized');
    }
    handle(client, message).catch((error) => {
      reply(client, message.id, null, { code: error.code ?? -32000, message: error.message });
    });
  });
}

async function handle(client, { id, method, params = {} }) {
  // Each runner knows only its own threads: asking this one about one of
  // bruce's (or bruce about this one's) is "Thread not found".
  if (typeof params?.threadId === 'string' && threads.has(params.threadId) && ownerOf(params.threadId) !== client.as) {
    return reply(client, id, null, { code: -32004, message: 'Thread not found' });
  }
  if (slow.ms > 0 && ['threads.send', 'threads.create', 'threads.update'].includes(method)) {
    await new Promise((resolve) => setTimeout(resolve, slow.ms));
  }
  const result = await dispatch(client, method, params);
  if (id !== undefined && id !== null) reply(client, id, result ?? {});
  // Like the real runner: a client that says hello hears about a restart
  // that's waiting, straight after the hello result.
  if (method === 'hello' && pendingRestart) {
    const onYou = pendingRestart.waitingFor.filter((id) => threads.get(id)?.summary.status === 'waiting').length;
    notice(client, 'info', pendingMessage(pendingRestart.waitingFor.length, onYou));
  }
}

async function dispatch(client, method, p) {
  switch (method) {
    case 'hello':
      // Bruce has two logins of its own and no pools, as the real one does,
      // so the pickers on its threads plainly aren't this Mac's.
      if (client.as) {
        return { runnerVersion, protocol: 1, accounts: publicAccounts().filter((a) => a.id === 'claude-main' || a.id === 'codex-main'),
          // Its own home folder, so the composer's folder chip on a new
          // thread there shows a path on bruce.
          defaults: { ...defaults, poolId: undefined, accountId: 'claude-main', cwd: '/Users/bruce/dev/me/misc' }, clis, updates, pools: [] };
      }
      return {
        runnerVersion, protocol: 1, accounts: publicAccounts(),
        defaults: oldRunner ? { ...defaults, poolId: undefined } : defaults, ...(oldRunner ? {} : { clis, updates, pools }),
      };
    case 'files.read':
      // Slow enough on bruce that the app's loading state shows.
      if (client.as) await sleep(400);
      return readFile(client, p);
    case 'files.list':
      if (client.as) await sleep(400);
      return listFolder(client, p);
    case 'pools.list':
      if (oldRunner) throw rpcError(-32601, 'Method not found');
      return { pools };
    case 'pools.save': {
      if (oldRunner) throw rpcError(-32601, 'Method not found');
      validatePools(p.pools);
      // Saved ones are runner.json's, not the code default's.
      pools = p.pools.map(({ id, title, accountIds, folders, icon }) => ({ id, title: title || id, accountIds, ...(folders?.length ? { folders } : {}), ...(icon ? { icon } : {}) }));
      broadcast('pools.updated', { pools });
      return { pools };
    }
    case 'runner.status': {
      const all = [...threads.values()].filter((t) => (t.runnerId ?? null) === client.as).map((t) => t.summary);
      const status = {
        version: runnerVersion, pid: process.pid, startedAt, home: dataDir, logFile: path.join(dataDir, 'runner.log'),
        liveClis: all.filter((s) => s.live).length,
        running: all.filter((s) => ['starting', 'running', 'waiting'].includes(s.status)).map((s) => s.id),
        background: all.filter((s) => s.background?.length).map((s) => ({ threadId: s.id, tasks: s.background.map((b) => b.description || b.kind) })),
      };
      if (pendingRestart) status.pendingRestart = pendingRestart;
      if (!oldRunner) status.clis = clis;
      // Sync on, to the made-up deployment, so the website's links and
      // sharing show (their links open nothing).
      if (!oldRunner) status.sync = { state: 'ok', url: DEMO_DEPLOYMENT };
      return status;
    }
    // The CLI requests only report and pretend: nothing is checked or
    // installed. An update "runs" for a couple of seconds.
    case 'usage.stats': {
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      const days = p.days ?? 8;
      if (!Number.isInteger(days) || days < 1 || days > 14) throw rpcError(-32602, 'days must be a whole number from 1 to 14');
      return mockUsageStats(days);
    }
    case 'clis.list':
    case 'clis.check':
    case 'clis.update':
    case 'clis.setPolicy': {
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      if (method === 'clis.list') return { clis };
      if (method === 'clis.check') {
        for (const cli of clis) if (!p.provider || cli.provider === p.provider) cli.checkedAt = iso();
        broadcastClis();
        return { clis };
      }
      const cli = clis.find((c) => c.provider === p.provider);
      if (!cli) throw rpcError(-32602, 'provider must be claude or codex');
      if (method === 'clis.setPolicy') {
        if (!['auto', 'notify', 'off'].includes(p.policy)) throw rpcError(-32602, 'policy must be auto, notify or off');
        cli.policy = p.policy;
        broadcastClis();
        return { clis };
      }
      fakeCliUpdate(cli, p);
      return { clis };
    }
    case 'threads.list': {
      // THREADBEAR_MOCK_LIST_DELAY_MS: answer late, to see the sidebar's
      // loading rows.
      const listDelay = Number(process.env.THREADBEAR_MOCK_LIST_DELAY_MS ?? 0);
      if (listDelay > 0) await new Promise((r) => setTimeout(r, listDelay));
      const include = new Set(p.include ?? ['inbox']);
      const now = Date.now();
      const list = [...threads.values()].filter((t) => (t.runnerId ?? null) === client.as).map((t) => t.summary).filter((s) => {
        if (s.archivedAt) return include.has('archived');
        if (s.snoozedUntil && Date.parse(s.snoozedUntil) > now) return include.has('snoozed');
        return include.has('inbox');
      });
      return { threads: newestFirst(list) };
    }
    case 'threads.search': {
      const q = String(p.query ?? '').toLowerCase();
      const list = [...threads.values()].filter((t) => (t.runnerId ?? null) === client.as).map((t) => t.summary)
        .filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q));
      return { threads: newestFirst(list).slice(0, p.limit ?? 50) };
    }
    case 'threads.samples': {
      // As the runner makes them (runner/src/samples.ts), each with the
      // Welcome folder's Roll a die chip, as the runner would read it from
      // the patch file the app wrote there.
      // As the runner does: any there are go, and fresh ones are made.
      for (const t of [...threads.values()].filter((t) => t.summary.sample)) {
        threads.delete(t.summary.id);
        broadcast('thread.deleted', { threadId: t.summary.id });
      }
      if (p.remove) return { threads: [] };
      const made = [];
      for (const sample of [...SAMPLE_THREADS].reverse()) {
        const threadId = 'th_sample_' + crypto.randomBytes(4).toString('hex');
        const now = iso();
        const provider = providerOf(defaults.accountId);
        const summary = {
          id: threadId, title: sample.title, cwd: p.cwd, accountId: defaults.accountId, provider,
          model: defaults.models[provider], permissionMode: 'full', status: 'idle', live: false, needsYou: false, sample: true,
          createdAt: now, updatedAt: now, lastActivityAt: now, preview: '', lastSeq: 0, lastSeenSeq: 0,
          actions: [{ id: 'welcome.roll-a-die', title: 'Roll a die', kind: 'command', command: 'echo "You rolled a $(( RANDOM % 6 + 1 ))."', patch: 'welcome', icon: 'dice' }],
          patches: [{ id: 'welcome', source: 'project', file: path.join(p.cwd, '.threadbear/patches/welcome.ts'), icon: 'dice' }],
        };
        threads.set(threadId, { summary, events: [], inProgress: new Map(), timers: [] });
        const turnId = 'turn_' + crypto.randomBytes(4).toString('hex');
        persist(threadId, { type: 'user.message', text: sample.question, images: [] }, turnId);
        persist(threadId, { type: 'turn.started' }, turnId);
        persist(threadId, { type: 'assistant.text', itemId: 'a_' + threadId, text: sample.answer }, turnId);
        persist(threadId, { type: 'turn.completed', outcome: 'completed', durationMs: 4000, needs: sample.needs, ...(sample.asks ? { asks: sample.asks } : {}) }, turnId);
        if (sample.needs === 'you') summary.needsYou = true;
        else if (!sample.unread) summary.lastSeenSeq = summary.lastSeq;
        broadcastSummary(threadId);
        made.push(summary);
      }
      return { threads: made.reverse() };
    }
    case 'threads.create': {
      if (!p.text) throw rpcError(-32602, 'text is required');
      const threadId = 'th_' + crypto.randomBytes(6).toString('hex');
      const now = iso();
      // Like the runner: a login named pins the thread; otherwise a pool
      // (named, else the default) picks one, on the named model's provider.
      // Bruce has no pools: a thread made there is on the login named, or
      // its default.
      const pool = !oldRunner && !client.as && !p.accountId ? poolOf(p.poolId ?? defaults.poolId) : undefined;
      const accountId = p.accountId ?? (pool && pickInPool(pool, providerOfModel(p.model))) ?? defaults.accountId;
      const provider = providerOf(accountId);
      const summary = {
        ...(pool ? { poolId: pool.id } : {}),
        id: threadId, title: (p.title ?? p.text.split('\n')[0]).slice(0, 60), cwd: p.cwd ?? defaults.cwd,
        accountId, provider, model: p.model ?? defaults.models[provider], effort: p.effort ?? defaults.efforts[provider],
        permissionMode: p.permissionMode ?? 'full', status: 'starting', live: true, needsYou: false,
        createdAt: now, updatedAt: now, lastActivityAt: now, preview: '', lastSeq: 0, lastSeenSeq: 0,
      };
      // Made over /bruce/rpc, it's bruce's: only bruce's clients hear of
      // it, and this runner's through remoteThreads.updated.
      // `fresh`: started this session, so the librarian files it after its first turn
      // (librarianFiles). The demo fixtures never are, so nothing they show changes.
      threads.set(threadId, { summary, events: [], inProgress: new Map(), timers: [], fresh: true, ...(client.as ? { runnerId: client.as } : {}) });
      broadcastSummary(threadId);
      setTimeout(() => fakeTurn(threadId, p.text, p.images ?? []), 10);
      return { thread: summary };
    }
    case 'threads.send': {
      const t = need(p.threadId);
      // A message declines any secret card still open, first (docs/
      // protocol.md, "Secrets"), as the real runner does.
      const resolved = new Set(t.events.filter((e) => e.type === 'approval.resolved').map((e) => e.approvalId));
      for (const card of t.events.filter((e) => e.type === 'secret.requested' && !resolved.has(e.approvalId))) {
        persist(t.summary.id, { type: 'approval.resolved', approvalId: card.approvalId, decision: 'deny' }, card.turnId);
        const waiter = t.approvalWaiters?.get(card.approvalId);
        t.approvalWaiters?.delete(card.approvalId);
        waiter?.({ decision: 'deny' });
      }
      const turnId = 'turn_' + crypto.randomBytes(4).toString('hex');
      // Answers from the card go on the user.message, as the runner keeps them.
      const extra = Array.isArray(p.answers) && p.answers.length ? { answers: p.answers } : {};
      // As the runner has it once the CLI starts a session (the app's
      // Finish setting up counts that as a login that works).
      t.summary.nativeSessionId ??= 'mock-session-' + t.summary.id;
      setTimeout(() => fakeTurn(t.summary.id, p.text ?? '', p.images ?? [], turnId, p.origin === 'phone' ? 'phone' : undefined, extra), 10 + slow.queueMs);
      return { turnId };
    }
    case 'threads.edit': {
      // Editing a message (docs/protocol.md, "Editing a message"): stop
      // the turn, cut back to the message with a thread.rewound, then the
      // edited text as a new turn. The files are made up.
      const t = need(p.threadId);
      const target = t.events.find((e) => e.seq === p.seq);
      if (!target || target.type !== 'user.message') throw rpcError(-32602, 'That message can\'t be edited.');
      if (!p.text && !(p.images ?? []).length) throw rpcError(-32602, 'text or images required');
      const bg = t.summary.background ?? [];
      if (bg.length && p.stopBackground !== true) throw rpcError(-32050, `Still running in the background: ${bg.map((b) => b.description).join('; ')}. Going back to an earlier message stops it.`);
      if (t.interrupt) t.interrupt();
      await new Promise((r) => setTimeout(r, 300));
      const files = { undone: ['src/settings/SettingsView.swift', 'src/settings/Tabs.swift'], failed: [], how: 'checkpoint' };
      const rewound = persist(t.summary.id, { type: 'thread.rewound', fromSeq: p.seq, toSeq: t.summary.lastSeq, files });
      setStatus(t.summary.id, 'idle');
      const turnId = 'turn_' + crypto.randomBytes(4).toString('hex');
      setTimeout(() => fakeTurn(t.summary.id, p.text ?? '', p.images ?? [], turnId, undefined, { editOf: p.seq }), 10);
      return { turnId, rewound: { seq: rewound.seq, fromSeq: rewound.fromSeq, toSeq: rewound.toSeq, files } };
    }
    case 'threads.interrupt': {
      const t = need(p.threadId);
      if (t.interrupt) t.interrupt();
      return {};
    }
    case 'threads.update': {
      const t = need(p.threadId);
      const s = t.summary;
      // Like the runner: an account of the other provider switches provider
      // and puts model and effort back to its defaults, unless set here.
      if (p.accountId !== undefined && providerOf(p.accountId) !== s.provider) {
        s.provider = providerOf(p.accountId);
        s.model = defaults.models[s.provider];
        s.effort = defaults.efforts[s.provider];
      }
      for (const key of ['title', 'cwd', 'accountId', 'permissionMode']) if (p[key] !== undefined) s[key] = p[key];
      // A login named pins the thread; null pins it where it is; a pool id
      // puts it in that pool, moving it onto one of the pool's logins if
      // its own isn't in it.
      if (p.accountId !== undefined || p.poolId === null) delete s.poolId;
      if (typeof p.poolId === 'string') {
        const pool = poolOf(p.poolId);
        if (!pool) throw rpcError(-32602, `no pool ${p.poolId}`);
        s.poolId = pool.id;
        if (!pool.accountIds.includes(s.accountId)) {
          const sameProvider = pickInPool(pool, s.provider);
          const next = sameProvider ?? pickInPool(pool);
          if (next) {
            if (providerOf(next) !== s.provider) {
              s.provider = providerOf(next);
              s.model = defaults.models[s.provider];
              s.effort = defaults.efforts[s.provider];
            }
            s.accountId = next;
          }
        }
      }
      if (s.poolId) delete s.waitingForRoom;
      if (p.model !== undefined) s.model = p.model ?? undefined;
      if (p.effort !== undefined) s.effort = p.effort ?? undefined;
      if (p.snoozedUntil !== undefined) {
        // "restart": until the runner next starts, as the runner keeps it.
        const untilRestart = p.snoozedUntil === 'restart';
        s.snoozedUntil = untilRestart ? '9999-12-31T00:00:00.000Z' : p.snoozedUntil ?? undefined;
        s.snoozedUntilRestart = untilRestart || undefined;
        delete s.wakeWhen;
        delete s.woke;
        if (s.snoozedUntil && !s.snoozedAt) s.snoozedAt = iso();
        if (!s.snoozedUntil) delete s.snoozedAt;
        if (s.snoozedUntil) { s.live = false; scheduleWake(s.id); }
      }
      if (p.archived !== undefined) {
        s.archivedAt = p.archived ? iso() : undefined;
        if (p.archived) s.live = false;
      }
      if (p.starred === true) s.starredAt ??= iso();
      else if (p.starred === false) delete s.starredAt;
      s.updatedAt = iso();
      broadcastSummary(s.id);
      return { thread: s };
    }
    case 'threads.events': {
      const t = need(p.threadId);
      let events = t.events;
      if (p.afterSeq !== undefined) events = events.filter((e) => e.seq > p.afterSeq);
      if (p.beforeSeq !== undefined) events = events.filter((e) => e.seq < p.beforeSeq);
      const limit = p.limit ?? 500;
      events = p.afterSeq !== undefined ? events.slice(0, limit) : events.slice(-limit);
      const inProgress = [...t.inProgress.entries()].map(([itemId, v]) => ({ itemId, type: v.type, text: v.text }));
      return { events, firstSeq: events[0]?.seq ?? 0, lastSeq: t.summary.lastSeq, inProgress };
    }
    case 'threads.subscribe': {
      const t = need(p.threadId);
      client.subs.add(t.summary.id);
      const after = p.afterSeq ?? t.summary.lastSeq;
      const inProgress = [...t.inProgress.entries()].map(([itemId, v]) => ({ itemId, type: v.type, text: v.text }));
      return { events: t.events.filter((e) => e.seq > after), inProgress };
    }
    case 'threads.subagent': {
      const t = need(p.threadId);
      const subagent = (t.summary.subagents ?? []).find((s) => s.id === p.subagentId);
      const events = t.subagentEvents?.get(p.subagentId);
      if (!events) throw rpcError(-32006, 'No record of that sub-agent');
      return { ...(subagent ? { subagent } : {}), events: events.map((e) => ({ ...e, threadId: t.summary.id })) };
    }
    case 'threads.unsubscribe':
      client.subs.delete(p.threadId);
      return {};
    case 'threads.tickAsk': {
      // docs/protocol.md, "Needs you": ticks one ask on the open card.
      const t = need(p.threadId);
      const s = t.summary;
      if (!s.asks || s.asksSeq !== p.asksSeq) throw rpcError(-32602, "That isn't the thread's open card of asks.");
      if (!Number.isInteger(p.index) || p.index < 0 || p.index >= s.asks.length) throw rpcError(-32602, 'No such ask.');
      const ask = { ...s.asks[p.index] };
      if (p.ticked) ask.ticked = true;
      else delete ask.ticked;
      s.asks = s.asks.map((a, i) => (i === p.index ? ask : a));
      const caughtUp = s.lastSeenSeq >= s.lastSeq;
      persist(s.id, { type: 'asks.ticked', asksSeq: s.asksSeq, ticked: s.asks.flatMap((a, i) => (a.ticked ? [i] : [])) });
      if (caughtUp) s.lastSeenSeq = s.lastSeq;
      broadcastSummary(s.id);
      return { thread: s };
    }
    case 'threads.share': {
      // docs/protocol.md, "Sharing". The mock keeps it on the summary; no
      // website reads it.
      const t = need(p.threadId);
      if (p.access !== 'off' && p.access !== 'link') throw rpcError(-32602, 'access is "off" or "link"');
      const old = t.summary.share;
      const slug = !old || p.newLink ? crypto.randomBytes(16).toString('base64url') : old.slug;
      t.summary.share = { access: p.access, slug, updatedAt: new Date().toISOString() };
      broadcastSummary(t.summary.id);
      return { thread: t.summary };
    }
    case 'threads.markSeen': {
      const t = need(p.threadId);
      t.summary.lastSeenSeq = Math.max(t.summary.lastSeenSeq, p.seq ?? 0);
      if (t.summary.status !== 'waiting') t.summary.needsYou = Boolean(t.summary.pendingReviews);
      delete t.summary.woke;
      broadcastSummary(t.summary.id);
      return { thread: t.summary };
    }
    case 'buttons.list': {
      // docs/protocol.md, "Reply buttons": every button the thread has.
      const t = need(p.threadId);
      return { buttons: [...(t.buttons?.values() ?? [])].map((button) => structuredClone(button)) };
    }
    case 'buttons.press': {
      // Starts the thread or sends the message once, like the runner. It
      // takes a moment (longer under mock.slow), and a button whose folder
      // is "/gone" fails, so the app's pressing and failed pills can be seen.
      const t = need(p.threadId);
      const button = t.buttons?.get(p.buttonId);
      if (!button) throw rpcError(-32602, `Button not found: ${p.buttonId}`);
      if (button.pressed) return { button: structuredClone(button) };
      await new Promise((resolve) => setTimeout(resolve, 600 + slow.queueMs));
      const from = `[Sent by the agent in the thread "${t.summary.title}" (${t.summary.id.slice(0, 8)})]\n\n`;
      let next;
      try {
        if (button.start?.cwd === '/gone') throw rpcError(-32602, 'Folder not found: /gone');
        if (button.start) {
          const made = await dispatch(client, 'threads.create', { text: from + button.start.text, title: button.start.title ?? button.title, cwd: button.start.cwd, permissionMode: button.start.permissionMode });
          next = { ...button, pressed: { at: iso(), threadId: made.thread.id } };
        } else {
          need(button.send.threadId);
          await dispatch(client, 'threads.send', { threadId: button.send.threadId, text: from + button.send.text });
          next = { ...button, pressed: { at: iso(), threadId: button.send.threadId } };
        }
        delete next.failed;
      } catch (e) {
        const failed = { ...button, failed: { at: iso(), error: String(e.message ?? e).slice(0, 300) } };
        t.buttons.set(failed.id, failed);
        persist(t.summary.id, { type: 'button.updated', button: failed });
        throw e;
      }
      t.buttons.set(next.id, next);
      persist(t.summary.id, { type: 'button.updated', button: next });
      return { button: structuredClone(next) };
    }
    case 'reviews.list': {
      const t = need(p.threadId);
      return { reviews: [...(t.reviews?.values() ?? [])].filter((review) => review.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((review) => structuredClone(review)) };
    }
    case 'reviews.get': {
      const t = need(p.threadId);
      return { review: structuredClone(needReview(t, p.reviewId)) };
    }
    case 'reviews.save':
    case 'reviews.respond':
    case 'reviews.cancel': {
      const t = need(p.threadId);
      const review = needReview(t, p.reviewId);
      const draft = method === 'reviews.cancel' ? review.draft : reviewDraft(review, p.draft, method === 'reviews.respond');
      if (method === 'reviews.respond' && review.status === 'answered' && sameDraft(review.response, draft)) return { review, turnId: review.replyTurnId };
      if (review.status !== 'pending') throw rpcError(-32602, `This review is ${review.status}.`);
      if (p.revision !== review.revision) throw rpcError(-32602, 'This review changed. Reload it before saving or sending your answer.');
      const next = { ...review, draft, revision: review.revision + 1, updatedAt: iso() };
      if (method === 'reviews.cancel') next.status = 'cancelled';
      if (method === 'reviews.respond') {
        next.status = 'answered';
        next.response = draft;
        next.replyTurnId = 'turn_' + crypto.randomBytes(4).toString('hex');
      }
      t.reviews.set(next.id, next);
      updateReviewCount(t);
      persist(t.summary.id, { type: 'review.updated', review: next });
      if (method === 'reviews.respond') {
        // Receipt of the reply is a fake turn, without a CLI or model.
        const text = reviewReply(next, draft);
        persist(t.summary.id, { type: 'user.message', text, images: [], reviewId: next.id, reviewResponse: draft }, next.replyTurnId);
        persist(t.summary.id, { type: 'turn.started', turnId: next.replyTurnId }, next.replyTurnId);
        persist(t.summary.id, { type: 'assistant.text', itemId: 'review_reply_' + next.id, text: 'I received your review. This is the mock runner, so no code was changed.' }, next.replyTurnId);
        persist(t.summary.id, { type: 'turn.completed', turnId: next.replyTurnId, outcome: 'completed', durationMs: 0 }, next.replyTurnId);
        setStatus(t.summary.id, 'idle', true);
      }
      return { review: structuredClone(next), ...(next.replyTurnId ? { turnId: next.replyTurnId } : {}) };
    }
    case 'approvals.respond': {
      const t = need(p.threadId);
      const waiter = t.approvalWaiters?.get(p.approvalId);
      persist(t.summary.id, { type: 'approval.resolved', approvalId: p.approvalId, decision: p.decision, message: p.message });
      if (waiter) {
        t.approvalWaiters.delete(p.approvalId);
        waiter(p);
      } else if (p.decision === 'answered' && scriptedTurns().some((x) => x.answer && new RegExp(x.answer, 'i').test(Object.values(p.answers ?? {}).join(' ')))) {
        // A made-up turn that carries on from the answer (MOCK_SCRIPTED_TURNS, `answer`).
        const turn = scriptedTurns().find((x) => x.answer && new RegExp(x.answer, 'i').test(Object.values(p.answers ?? {}).join(' ')));
        // A fresh turn, so the working line counts from the answer rather than from a
        // fixture's question asked days ago ("Bear with me · 63h" in a clip).
        const turnId = 'turn_answer_' + crypto.randomBytes(3).toString('hex');
        persist(t.summary.id, { type: 'turn.started', turnId }, turnId);
        setStatus(t.summary.id, 'running', false);
        playScripted(t.summary.id, turnId, Date.now(), turn, () => false);
      } else {
        // A fixture's approval with no fake turn behind it: finish the turn.
        const text = p.decision === 'deny' ? 'OK, I left it alone.' : p.decision === 'answered' ? `Going with ${Object.values(p.answers ?? {}).join(', ') || 'that'}.` : 'Done.';
        persist(t.summary.id, { type: 'assistant.text', itemId: 'm_' + crypto.randomBytes(4).toString('hex'), text });
        persist(t.summary.id, { type: 'turn.completed', turnId: 'turn_resolved', outcome: 'completed', durationMs: 1200 });
        t.summary.needsYou = true;
        setStatus(t.summary.id, 'idle');
      }
      return {};
    }
    case 'secrets.answer': {
      // docs/protocol.md, "Secrets". The mock keeps nothing: it checks the
      // answer's shape, never writes or logs the value, and closes the card
      // with approval.resolved (never a message).
      const t = need(p.threadId);
      const card = t.events.find((e) => e.type === 'secret.requested' && e.approvalId === p.approvalId);
      if (!card) throw rpcError(-32602, 'No secret card with that approvalId');
      if (t.events.some((e) => e.type === 'approval.resolved' && e.approvalId === p.approvalId)) throw rpcError(-32602, 'That card has already been answered');
      const decline = p.decline === true;
      if (!decline && (typeof p.secret !== 'string' || !p.secret.trim())) throw rpcError(-32602, 'Give the secret or decline');
      // For seeing the card's error line: the real runner fails like this
      // when it can't write the file, and leaves the card open.
      if (!decline && p.secret === 'mock-fail') throw rpcError(-32000, 'Couldn\'t write the secret file (disk full). The card is still open.');
      const decision = decline ? 'deny' : 'answered';
      persist(t.summary.id, { type: 'approval.resolved', approvalId: p.approvalId, decision }, card.turnId);
      const waiter = t.approvalWaiters?.get(p.approvalId);
      if (waiter) {
        t.approvalWaiters.delete(p.approvalId);
        waiter({ decision });
      } else {
        // A fixture's card with no fake turn behind it: finish the turn.
        const text = decline ? 'OK, I left it as it is. Keep Awake will still ask each time.'
          : 'Saved. The rule is in /etc/sudoers.d/keep-awake and allows only the two pmset commands, so the Raycast toggles no longer ask.';
        persist(t.summary.id, { type: 'assistant.text', itemId: 'm_' + crypto.randomBytes(4).toString('hex'), text }, card.turnId);
        persist(t.summary.id, { type: 'turn.completed', turnId: card.turnId ?? 'turn_resolved', outcome: 'completed', durationMs: 2400 }, card.turnId);
        t.summary.needsYou = true;
        setStatus(t.summary.id, 'idle');
      }
      return {};
    }
    case 'actions.run': {
      // A command action "runs" for a moment and its output lands in the
      // transcript; a prompt action is a message, as in the real runner.
      const t = need(p.threadId);
      const action = (t.summary.actions ?? []).find((x) => x.id === p.actionId);
      if (!action) throw rpcError(-32602, `This thread has no action called ${p.actionId}`);
      if (action.kind === 'prompt') return dispatch(client, 'threads.send', { threadId: t.summary.id, text: action.prompt });
      await new Promise((r) => setTimeout(r, 900));
      const ok = action.id !== 'tools.typecheck';
      const text = action.patch === 'welcome'
        ? `You rolled a ${1 + Math.floor(Math.random() * 6)}.\n`
        : ok
        ? `$ ${action.command}\nDone in 2.1s.\n`
        : 'src/dashboard/UsageCard.tsx(42,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n\nFound 1 error in src/dashboard/UsageCard.tsx:42\n';
      const event = persist(t.summary.id, {
        type: 'action.run', actionId: action.id, patch: action.patch, title: action.title, command: action.command,
        ok, exitCode: ok ? 0 : 2, text, truncated: false, durationMs: 2100,
      });
      return { ok, exitCode: ok ? 0 : 2, durationMs: 2100, seq: event.seq };
    }
    case 'patches.trust': {
      // As the real runner: the waiting files load, and give what they give.
      const t = need(p.threadId);
      for (const { file, hash } of p.files ?? []) {
        const patch = (t.summary.patches ?? []).find((x) => x.file === file && x.untrusted);
        if (!patch || patch.hash !== hash) throw rpcError(-32602, `${file} isn't one of this thread's patches waiting to be trusted`);
        delete patch.untrusted;
        delete patch.hash;
        t.summary.actions = [...(t.summary.actions ?? []), ...(waitingPatchGives.get(file) ?? [])];
      }
      broadcastSummary(t.summary.id);
      return { trusted: (p.files ?? []).map((f) => f.file) };
    }
    case 'mock.convexPanel': {
      const t = need(p.threadId);
      const deployment = 'happy-otter-123';
      t.summary.panels = [{ id: 'convex.dashboard', title: 'Convex', kind: 'url', patch: 'convex',
        url: `https://dashboard.convex.dev/d/${deployment}`,
        convex: { deployment, deploymentUrl: `https://${deployment}.convex.cloud`, team: 'mike', project: 'walkies' } }];
      t.convexKeyRequests ??= [];
      broadcastSummary(t.summary.id);
      return { keyRequests: t.convexKeyRequests };
    }
    case 'panels.convexDeployments': {
      need(p.threadId);
      return { deployments: [
        { deployment: 'happy-otter-123', deploymentUrl: 'https://happy-otter-123.convex.cloud', label: 'Development' },
        { deployment: 'busy-bear-456', deploymentUrl: 'https://busy-bear-456.ap-southeast-2.convex.cloud', label: 'Production' },
      ] };
    }
    case 'panels.convexKey': {
      const t = need(p.threadId);
      (t.convexKeyRequests ??= []).push({ deployment: p.deployment, renew: p.renew === true });
      throw rpcError(-32000, 'The demo runner has no Convex deploy keys.');
    }
    case 'panels.render': {
      // The Simulator panel's picture: a fixture image, as if simctl took it.
      const t = need(p.threadId);
      const panel = (t.summary.panels ?? []).find((x) => x.id === p.panelId);
      if (!panel) throw rpcError(-32602, `This thread has no panel called ${p.panelId}`);
      if (panel.kind === 'list') {
        await new Promise((r) => setTimeout(r, 200));
        return { items: panel.mockItems ?? [] };
      }
      if (panel.kind !== 'image') return { note: 'This panel has nothing to render.' };
      const file = path.join(here, 'fixtures/demo-upload-resume/media/progress-after.png');
      await new Promise((r) => setTimeout(r, 300));
      return { image: { path: file, mediaType: 'image/png', ...imageSize(file) } };
    }
    case 'threads.hibernateWhen': {
      // Away at once, then a canned answer a moment later, as the real
      // runner does after Opus answers: "talk about X" is a topic, anything
      // else two days on.
      const t = need(p.threadId);
      const s = t.summary;
      const said = String(p.said ?? '').trim();
      s.snoozedUntil = '9999-12-31T00:00:00.000Z';
      s.wakeWhen = { said, pending: true };
      s.live = false;
      broadcastSummary(s.id);
      await new Promise((r) => setTimeout(r, 1500));
      const topic = /talk about (.+)$/i.exec(said)?.[1];
      s.wakeWhen = topic ? { said, topic } : { said };
      if (!topic) s.snoozedUntil = new Date(Date.now() + 2 * 86_400_000).toISOString();
      scheduleWake(s.id);
      broadcastSummary(s.id);
      return { thread: s };
    }
    case 'threads.explain': {
      // A canned answer after a moment, like the small model's few seconds.
      need(p.threadId);
      await new Promise((r) => setTimeout(r, 600));
      const sel = String(p.selection ?? '').slice(0, 60);
      if (p.question) return { answer: `About "${sel}": ${p.question} That's the mock runner's answer to a follow-up.`, model: 'mock' };
      return { answer: `**${sel}** is what the agent called this step. It means the smallest piece to move first, so the rest can follow.\n\n- It's in \`runner/src/explain.ts\`\n- Nothing here goes into the thread`, model: 'mock' };
    }
    case 'threads.commands': {
      // The palette's list (docs/protocol.md, "Slash commands"): Threadbear's
      // own, the CLI's, then skills, as a real Claude thread lists them.
      const t = need(p.threadId);
      const codex = t.summary.provider === 'codex';
      const own = [
        { name: 'model', description: "Switch this thread's model", argumentHint: '[model]', source: 'threadbear' },
        { name: 'effort', description: "Set this thread's effort level", argumentHint: '[low|medium|high|xhigh|max]', source: 'threadbear' },
      ];
      const cli = codex
        ? [
            { name: 'compact', description: 'Summarise the conversation so far to free up context', source: 'cli' },
            { name: 'review', description: 'Review the uncommitted changes, or what you describe', argumentHint: '[instructions]', source: 'cli' },
            { name: 'clear', description: 'Start a fresh session in this thread (the transcript stays)', source: 'threadbear' },
            { name: 'status', description: "The model, effort, context used and the login's limits", source: 'threadbear' },
          ]
        : [
            { name: 'clear', description: 'Clear conversation history and free up context', source: 'cli' },
            { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional custom summarization instructions>', source: 'cli' },
            { name: 'context', description: 'Show current context usage', source: 'cli' },
            { name: 'cost', description: 'Show the total cost and duration of the current session', source: 'cli', scope: 'system', aliases: ['usage', 'stats'] },
            { name: 'config', description: 'Open config panel', source: 'cli' },
            { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', source: 'cli' },
          ];
      const skills = [
        { name: 'code-review', description: 'Review the current diff, or a PR number, branch or path, for correctness bugs, at the effort level given first.', argumentHint: '[low|medium|high] [target]', source: 'skill', scope: 'user', path: `${os.homedir()}/.claude/skills/code-review/SKILL.md` },
        { name: 'computercub', description: "Drive Mac apps and the parts of Chrome extensions can't reach, with the `computercub` command.", source: 'skill' },
        { name: 'cloudflare', description: 'Cloudflare platform: Workers, Pages, KV, D1, R2 and the rest.', source: 'skill' },
        { name: 'claude-api', description: 'Model ids, pricing, params and the Anthropic SDK.', source: 'skill' },
        { name: 'deslop', description: 'A second-pass cleanup over AI-written code using the repo style guide.', source: 'skill', scope: 'project', path: `${t.summary.cwd}/.claude/skills/deslop/SKILL.md` },
        { name: 'delegate', description: 'Get answers from other labs and models, and run consensus panels.', source: 'skill' },
        { name: 'ship', description: 'Drive a branch to merge-ready: PR, checks, bot comments.', source: 'skill' },
      ];
      return { commands: [...own, ...cli, ...skills] };
    }
    case 'threads.highlights': {
      const t = need(p.threadId);
      return highlights.get(t.summary.id) ?? { highlights: [], edited: [] };
    }
    case 'threads.removeHighlight': {
      const t = need(p.threadId);
      const list = highlights.get(t.summary.id);
      if (!list?.highlights.some((h) => h.id === p.highlightId)) throw rpcError(-32602, `This thread has no highlight ${p.highlightId}`);
      list.highlights = list.highlights.filter((h) => h.id !== p.highlightId);
      t.summary.highlightsAt = iso();
      broadcastSummary(t.summary.id);
      return { thread: t.summary };
    }
    case 'mock.pin': {
      // As the agent's `pin` tool would: {threadId, path | url, title?, note?, show?}.
      // For trying the pane opening a pin by itself.
      const t = need(p.threadId);
      const list = highlights.get(t.summary.id) ?? { highlights: [], edited: [] };
      highlights.set(t.summary.id, list);
      const kind = p.path ? 'file' : 'link';
      const id = `${kind}:${p.path ?? p.url}`;
      list.highlights = list.highlights.filter((h) => h.id !== id);
      list.highlights.unshift({
        id, kind, title: p.title ?? (p.path ? path.basename(p.path) : p.url), path: p.path, url: p.url, how: 'pinned',
        note: p.note, ...(p.show ? { show: true } : {}), seq: t.summary.lastSeq, lastSeq: t.summary.lastSeq, at: iso(),
      });
      t.summary.highlightsAt = iso();
      broadcastSummary(t.summary.id);
      return { highlight: list.highlights[0] };
    }
    case 'mock.showPanel': {
      // As the agent's show_panel tool would: {threadId, panel, where?}
      // (docs/protocol.md, "Showing panels"). The panel isn't checked.
      const t = need(p.threadId);
      const named = { highlights: 'Highlights', patches: 'Patches', usage: 'Usage', updates: 'Updates' };
      const title = named[p.panel] ?? t.summary.panels?.find((x) => x.id === p.panel)?.title ?? String(p.panel);
      t.summary.panelRequest = { id: 'pr_' + crypto.randomBytes(4).toString('hex'), panel: String(p.panel), title, ...(p.where ? { where: p.where } : {}), at: iso() };
      broadcastSummary(t.summary.id);
      return { request: t.summary.panelRequest };
    }
    case 'mock.panelState': {
      // What's waiting on the thread and what the app has said it showed.
      const t = need(p.threadId);
      return { request: t.summary.panelRequest ?? null, shown: t.panelsShown ?? [] };
    }
    case 'threads.panelShown': {
      const t = need(p.threadId);
      if (typeof p.requestId !== 'string') throw rpcError(-32602, 'requestId must be a string');
      if (t.summary.panelRequest?.id === p.requestId) {
        delete t.summary.panelRequest;
        (t.panelsShown ??= []).push(p.requestId);
        broadcastSummary(t.summary.id);
      }
      return { thread: t.summary };
    }
    case 'media.import': {
      const source = String(p.path ?? '');
      if (!fs.existsSync(source)) throw rpcError(-32602, `No file at ${source}`);
      const ext = path.extname(source).toLowerCase() || '.png';
      const dest = path.join(dataDir, 'inbox', crypto.randomBytes(8).toString('hex') + ext);
      fs.copyFileSync(source, dest);
      const size = imageSize(dest);
      return { image: { path: dest, mediaType: mediaType(ext), ...size } };
    }
    case 'schedules.list': {
      const list = sortedSchedules();
      return { schedules: p.threadId ? list.filter((x) => x.threadId === p.threadId || x.createdBy === p.threadId) : list };
    }
    case 'remoteThreads.list':
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      return remoteThreads(client);
    case 'runners.setOrder': {
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      if (!Array.isArray(p.runnerIds) || !p.runnerIds.every((x) => typeof x === 'string')) throw rpcError(-32602, 'runnerIds must be a list of runner ids');
      runnerOrder = [...new Set(p.runnerIds)];
      for (const c of clients) if (c.authed && c.as === null) send(c, 'remoteThreads.updated', remoteThreads(c));
      return {};
    }
    case 'runners.list':
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      // With what each one's heartbeat says, for the Runners panel: bruce
      // a release behind and up for a day.
      return {
        runners: runners.map((r) => ({
          id: r.id, name: r.name, icon: r.icon, online: true, lastSeenAt: iso(), self: r.self,
          ...(r.self
            ? { version: '0.1.0+20261105T064853Z-c4d90ca', release: '20261105T064853Z-c4d90ca', startedAt: iso(-16 * 60_000) }
            : { version: '0.1.0+20261104T221010Z-51ae514', release: '20261104T221010Z-51ae514', startedAt: iso(-26 * 3_600_000) }),
        })),
      };
    case 'runners.stats': {
      // Each runner's machine figures, a little different each ask.
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      const GB = 1024 ** 3;
      const wobble = () => Math.round(Math.random() * 8);
      return {
        stats: [
          { runnerId: SELF_RUNNER.id, at: iso(), cpuPercent: 31 + wobble(), cores: 10, memUsed: 17.4 * GB, memTotal: 24 * GB, diskFree: 212 * GB, diskTotal: 994 * GB, load1: 3.42, uptimeSec: 4 * 86400 + 3600, machine: 'Apple M5', os: 'macOS 27.2' },
          { runnerId: 'runner_bruce', at: iso(), cpuPercent: 8 + wobble(), cores: 8, memUsed: 7.4 * GB, memTotal: 8 * GB, diskFree: 41 * GB, diskTotal: 228 * GB, load1: 1.1, uptimeSec: 19 * 86400, machine: 'Apple M1', os: 'macOS 27.1' },
        ],
      };
    }
    case 'schedules.create': {
      if (!p.text) throw rpcError(-32602, 'text is required');
      if (Boolean(p.at) === Boolean(p.cron)) throw rpcError(-32602, 'Give exactly one of at and cron');
      if (p.threadId) need(p.threadId);
      // An id or a name from runners.list, as the real runner takes it.
      const runner = p.runnerId ? runners.find((r) => r.id === p.runnerId || r.name === p.runnerId) : SELF_RUNNER;
      if (!runner) throw rpcError(-32602, `No runner "${p.runnerId}"; runners.list has ${runners.map((r) => r.name).join(', ')}`);
      const away = !runner.self;
      if (away && p.threadId) throw rpcError(-32602, "A schedule that sends to a thread runs on that thread's runner; leave runnerId out.");
      const when = readWhen(p);
      const now = iso();
      // Another runner's folder and account are its own, checked there
      // when it runs: kept as sent, and no folder means its default.
      const settings = away
        ? { ...(p.cwd?.trim() ? { cwd: p.cwd.trim() } : {}), accountId: p.accountId, model: p.model, effort: p.effort, permissionMode: p.permissionMode }
        : { cwd: p.cwd ?? defaults.cwd, accountId: p.accountId ?? defaults.accountId, model: p.model, effort: p.effort, permissionMode: p.permissionMode ?? 'full' };
      const schedule = {
        id: 'sc_' + crypto.randomBytes(5).toString('hex'), title: p.title || p.text.split('\n')[0].slice(0, 60), text: p.text,
        ...(p.at ? { at: new Date(p.at).toISOString() } : { cron: p.cron }), whenText: when.whenText,
        ...(p.threadId ? { threadId: p.threadId } : settings),
        paused: Boolean(p.paused), createdAt: now, updatedAt: now, ...(p.createdBy ? { createdBy: p.createdBy } : {}), runs: 0,
        runnerId: runner.id, runnerName: runner.name, runnerIcon: runner.icon,
      };
      if (!schedule.paused) schedule.nextRunAt = when.runs[0];
      schedules.push(schedule);
      broadcastSchedules();
      return { schedule };
    }
    case 'schedules.update': {
      const schedule = needSchedule(p.scheduleId);
      for (const key of ['title', 'text', 'cwd', 'accountId', 'permissionMode']) if (p[key] !== undefined) schedule[key] = p[key];
      // Another runner's folder, emptied, is its default again.
      if (schedule.runnerId !== SELF_RUNNER.id && !schedule.cwd?.trim()) delete schedule.cwd;
      for (const key of ['model', 'effort', 'timezone']) if (p[key] !== undefined) schedule[key] = p[key] ?? undefined;
      if (p.at || p.cron) {
        const when = readWhen(p);
        if (p.at) { schedule.at = new Date(p.at).toISOString(); delete schedule.cron; delete schedule.finishedAt; }
        else { schedule.cron = p.cron; delete schedule.at; }
        schedule.whenText = when.whenText;
      }
      if (p.paused !== undefined) schedule.paused = Boolean(p.paused);
      schedule.nextRunAt = schedule.paused || schedule.finishedAt ? undefined : readWhen(schedule).runs[0];
      schedule.updatedAt = iso();
      broadcastSchedules();
      return { schedule };
    }
    case 'schedules.delete':
      needSchedule(p.scheduleId);
      schedules = schedules.filter((x) => x.id !== p.scheduleId);
      broadcastSchedules();
      return {};
    case 'schedules.run':
      return runSchedule(needSchedule(p.scheduleId));
    case 'schedules.preview': {
      const when = readWhen(p, Math.min(20, p.count ?? 5));
      return { whenText: when.whenText, runs: when.runs };
    }
    // Settings (docs/protocol.md, "Settings and models"), kept in memory.
    // Like the real runner, the key itself is never kept or sent back:
    // only whether one is set and its last 4 characters.
    // Projects and the librarian (docs/protocol.md, "Projects"). A runner
    // played as old (mock.accounts {old: true}) has none of them.
    case 'projects.list':
    case 'projects.get':
    case 'projects.create':
    case 'projects.update':
    case 'projects.setIcon':
    case 'projects.refreshTasks':
    case 'projects.merge':
    case 'projects.delete':
    case 'threads.setProjects':
    case 'librarian.status':
    case 'librarian.run':
    case 'librarian.update':
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      return projectRequest(method, p);
    // The Connectors gateway (docs/protocol.md, "Connectors"): a made-up
    // one, with a service signed out so the panel and its dot show.
    // mock.connectors changes it.
    case 'connectors.status':
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      if (p.refresh) connectors = { ...connectors, checkedAt: iso() };
      return { connectors };
    case 'instructions.get':
      return { instructions: mockInstructions };
    case 'instructions.set':
      mockInstructions = { text: p.text.trim() ? p.text.trim() + '\n' : '' };
      broadcast('instructions.updated', { instructions: mockInstructions });
      return { instructions: mockInstructions };
    case 'settings.get':
      return { settings };
    case 'settings.update': {
      if (p.defaultCwd !== undefined) {
        if (typeof p.defaultCwd !== 'string' || !p.defaultCwd.trim()) throw rpcError(-32602, 'defaultCwd must be a folder');
        settings.defaultCwd = p.defaultCwd;
        defaults.cwd = p.defaultCwd;
      }
      if (p.idleMinutes !== undefined) {
        if (!Number.isInteger(p.idleMinutes) || p.idleMinutes < 1) throw rpcError(-32602, 'idleMinutes must be a whole number of minutes, at least 1');
        settings.idleMinutes = p.idleMinutes;
      }
      if (p.maxLiveCLIs !== undefined) {
        if (!Number.isInteger(p.maxLiveCLIs) || p.maxLiveCLIs < 1 || p.maxLiveCLIs > 20) throw rpcError(-32602, 'maxLiveCLIs must be 1 to 20');
        settings.maxLiveCLIs = p.maxLiveCLIs;
      }
      if (p.followMain !== undefined) settings.followMain = Boolean(p.followMain);
      if (p.bulletReplies !== undefined) settings.bulletReplies = Boolean(p.bulletReplies);
      const m = p.models ?? {};
      if (m.pool !== undefined) {
        if (m.pool !== null && !poolOf(m.pool)) throw rpcError(-32602, `No pool called ${m.pool}`);
        settings.models.pool = m.pool;
      }
      if (m.privateFolders !== undefined) {
        if (!Array.isArray(m.privateFolders) || m.privateFolders.some((f) => typeof f !== 'string')) throw rpcError(-32602, 'privateFolders must be a list of folders');
        settings.models.privateFolders = m.privateFolders;
      }
      broadcastSettings();
      return { settings };
    }
    // Phone & browser (docs/protocol.md, "Devices"): the paired phones and
    // browsers, kept in memory, and a made-up link for each pair (the
    // demo deployment, a token that opens nothing).
    case 'devices.list':
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      return deviceList();
    case 'devices.pair': {
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      if (!['phone', 'browser'].includes(p.kind)) throw rpcError(-32602, 'kind must be one of phone, browser');
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.kind === 'phone' ? 'iPhone' : 'Browser';
      const days = p.days ?? 90;
      const device = { id: `tok${++deviceSeq}`, kind: p.kind, name, createdAt: iso(), expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(), expired: false };
      devices.unshift(device);
      const token = 'tb_demo' + deviceSeq.toString().padStart(4, '0');
      return p.kind === 'phone'
        ? { device, pairingLink: `threadbear://pair?url=${encodeURIComponent(DEMO_DEPLOYMENT)}&token=${token}` }
        : { device, signInLink: `${DEMO_SITE}/#token=${token}` };
    }
    case 'devices.revoke': {
      if (oldRunner) throw rpcError(-32601, `Unknown method ${method}`);
      const i = devices.findIndex((d) => d.id === p.deviceId);
      if (i < 0) throw rpcError(-32602, `No phone or browser with id ${p.deviceId}`);
      devices.splice(i, 1);
      return deviceList();
    }
    // Mock-only helpers for perf runs, demos and screenshots.
    case 'mock.slow': {
      slow = { ms: Math.max(0, Number(p.ms ?? 0)), queueMs: Math.max(0, Number(p.queueMs ?? 0)) };
      return slow;
    }
    case 'mock.restartPending': {
      // A restart waiting for threads, as `runner.restart` leaves one:
      // runner.status shows it and every client gets the notice. By default
      // it waits for the threads that are busy (as the real runner would);
      // `waitingFor` names them, `cancel: true` withdraws it.
      if (p.cancel) {
        pendingRestart = undefined;
        broadcastNotice('info', 'The pending runner restart was cancelled.');
        return { scheduled: false, waitingFor: [] };
      }
      const busy = [...threads.values()].filter((t) => !t.runnerId).map((t) => t.summary).filter((s) => ['starting', 'running', 'waiting'].includes(s.status)).map((s) => s.id);
      const waitingFor = Array.isArray(p.waitingFor) ? p.waitingFor.filter((id) => threads.has(id)) : busy;
      pendingRestart = { when: 'idle', requestedAt: iso(), waitingFor };
      if (p.reason) pendingRestart.reason = p.reason;
      if (p.resume?.threadId) pendingRestart.resumeThreadId = p.resume.threadId;
      const onYou = waitingFor.filter((id) => threads.get(id)?.summary.status === 'waiting').length;
      broadcastNotice('info', pendingMessage(waitingFor.length, onYou));
      return { scheduled: true, waitingFor };
    }
    case 'mock.connectors': {
      // { state?, error?, services? }: replaces what connectors.status
      // answers and sends connectors.updated.
      connectors = { ...connectors, state: p.state ?? 'ok', services: Array.isArray(p.services) ? p.services : connectors.services, checkedAt: iso() };
      if (typeof p.error === 'string') connectors.error = p.error;
      else delete connectors.error;
      if (connectors.state !== 'ok') connectors.services = [];
      broadcast('connectors.updated', { connectors });
      return { connectors };
    }
    case 'mock.updates': {
      // The runner's own update, as hello and runner.updates carry it:
      // { state, commit?, subject?, reason?, oldRunners?, launcherChanged?, launcherReason?, upstream? }.
      // Threads named in oldRunners get onOldRunner in their summaries, as
      // the real primary marks a draining runner's threads.
      updates = { state: p.state ?? 'idle', oldRunners: Array.isArray(p.oldRunners) ? p.oldRunners : [] };
      for (const k of ['commit', 'subject', 'reason', 'launcherReason']) if (typeof p[k] === 'string') updates[k] = p[k];
      if (p.launcherChanged) updates.launcherChanged = true;
      // Mike's releases (protocol "Mike's releases"), as given.
      if (p.upstream && typeof p.upstream === 'object') updates.upstream = p.upstream;
      const old = new Set(updates.oldRunners.flatMap((r) => r.threads ?? []));
      for (const t of threads.values()) {
        const was = Boolean(t.summary.onOldRunner);
        if (old.has(t.summary.id)) t.summary.onOldRunner = true;
        else delete t.summary.onOldRunner;
        if (was !== old.has(t.summary.id)) broadcastSummary(t.summary.id);
      }
      broadcast('runner.updates', { updates });
      return { updates };
    }
    case 'mock.background': {
      // What a thread's CLI is running in the background, as the real
      // runner reports it between turns: `tasks` is the summary's
      // `background` list ([{ kind, description, finished? }]); empty or
      // missing clears it.
      const t = need(p.threadId);
      const tasks = Array.isArray(p.tasks) ? p.tasks.filter((b) => b && typeof b === 'object').map((b) => ({
        kind: ['agent', 'shell', 'monitor', 'other'].includes(b.kind) ? b.kind : 'other',
        description: String(b.description ?? ''),
        ...(b.finished ? { finished: true } : {}),
      })) : [];
      if (tasks.length) t.summary.background = tasks;
      else delete t.summary.background;
      t.summary.live = tasks.length > 0 || t.summary.live;
      broadcastSummary(t.summary.id);
      return { thread: t.summary };
    }
    case 'mock.accounts': {
      // Replaces the account list ({accounts}), or plays a runner from
      // before step 4 ({old: true}: no usage, no clis.*) until {old: false}.
      if (Array.isArray(p.accounts)) accounts = p.accounts;
      if (typeof p.old === 'boolean') oldRunner = p.old;
      broadcast('accounts.updated', { accounts: publicAccounts() });
      if (!oldRunner) broadcast('pools.updated', { pools });
      return { accounts: publicAccounts(), old: oldRunner };
    }
    case 'mock.restart':
      return restartNow(p);
    case 'mock.clis':
      if (p.wentBack) return wentBack();
      return { clis };
    case 'mock.stream':
      return startStream(need(p.threadId).summary.id, p);
    case 'mock.approval': {
      const t = need(p.threadId);
      const approvalId = 'ap_' + crypto.randomBytes(4).toString('hex');
      persist(t.summary.id, { type: 'approval.requested', approvalId, name: 'Bash', title: p.title ?? 'rm -rf build/', input: { command: p.title ?? 'rm -rf build/' }, options: ['allow', 'allowAlways', 'deny'] });
      setStatus(t.summary.id, 'waiting', true);
      t.approvalWaiters ??= new Map();
      t.approvalWaiters.set(approvalId, () => setStatus(t.summary.id, 'idle', false));
      return { approvalId };
    }
    default:
      throw rpcError(-32601, `Unknown method ${method}`);
  }
}

// ---------------------------------------------------------------- turns

async function fakeTurn(threadId, text, images, turnId = 'turn_' + crypto.randomBytes(4).toString('hex'), origin, extra = {}) {
  const t = threads.get(threadId);
  if (!t) return;
  let interrupted = false;
  t.interrupt = () => { interrupted = true; };
  const started = Date.now();
  persist(threadId, { type: 'user.message', text, images, ...(origin ? { origin } : {}), ...extra }, turnId);
  persist(threadId, { type: 'turn.started', turnId }, turnId);
  setStatus(threadId, 'running');

  // A provider refusal for checking the recovery offer, without sending
  // anything to a real model. Codex's continuation runs normally.
  if (t.summary.provider !== 'codex' && /mock refusal/i.test(text)) {
    const error = "API Error: Opus 5.5's safeguards flagged this message. Claude Code can't respond to this message with Opus 5.5.\n\nTry rephrasing the request in a new session or change your model.\n\nDetails: [reasoning_extraction]";
    persist(threadId, { type: 'error', message: error }, turnId);
    persist(threadId, { type: 'turn.completed', turnId, outcome: 'failed', durationMs: 851, error }, turnId);
    t.interrupt = undefined;
    setStatus(threadId, 'error');
    return;
  }
  // Say "signed out" for a turn refused by the login, as Claude Code's
  // expired OAuth session does: the error row and errorKind auth, which
  // gets the thread its Sign in… line.
  if (/signed out/i.test(text)) {
    const error = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    persist(threadId, { type: 'error', message: error }, turnId);
    persist(threadId, { type: 'turn.completed', turnId, outcome: 'failed', durationMs: 851, error, errorKind: 'auth' }, turnId);
    t.interrupt = undefined;
    setStatus(threadId, 'error');
    return;
  }
  // A made-up turn from MOCK_SCRIPTED_TURNS, for recording the site's clips (site/scripts/clips.mjs).
  const scripted = scriptedTurns().find((s) => s.match && new RegExp(s.match, 'i').test(text));
  if (scripted) return playScripted(threadId, turnId, started, scripted, () => interrupted);

  const thinkId = 'r_' + crypto.randomBytes(4).toString('hex');
  persist(threadId, { type: 'reasoning', itemId: thinkId, text: 'Checking what the message asks for before answering.' }, turnId);

  if (/approval|ask me/i.test(text) || t.summary.permissionMode === 'ask') {
    const approvalId = 'ap_' + crypto.randomBytes(4).toString('hex');
    persist(threadId, { type: 'approval.requested', approvalId, name: 'Bash', title: 'ls -la', input: { command: 'ls -la' }, options: ['allow', 'allowAlways', 'deny'] }, turnId);
    setStatus(threadId, 'waiting', true);
    t.approvalWaiters ??= new Map();
    const decision = await new Promise((resolve) => t.approvalWaiters.set(approvalId, resolve));
    setStatus(threadId, 'running', false);
    if (decision.decision === 'deny') {
      persist(threadId, { type: 'assistant.text', itemId: 'm_' + crypto.randomBytes(4).toString('hex'), text: 'OK, I left it alone.' }, turnId);
      return finishTurn(threadId, turnId, started, 'completed');
    }
  }
  // "password" or "secret" in a message: an ask_secret card first.
  if (/password|secret/i.test(text)) {
    const approvalId = 'sec_' + crypto.randomBytes(4).toString('hex');
    persist(threadId, { type: 'secret.requested', approvalId, label: 'Mac administrator password', reason: 'Install the Keep Awake rule that allows only the two fixed pmset sleep-toggle commands, so Raycast toggles work without repeated prompts.' }, turnId);
    setStatus(threadId, 'waiting', true);
    t.approvalWaiters ??= new Map();
    const answer = await new Promise((resolve) => t.approvalWaiters.set(approvalId, resolve));
    setStatus(threadId, 'running', false);
    if (answer.decision === 'deny') {
      persist(threadId, { type: 'assistant.text', itemId: 'm_' + crypto.randomBytes(4).toString('hex'), text: 'OK, I left it as it is.' }, turnId);
      return finishTurn(threadId, turnId, started, 'completed');
    }
  }
  if (/question/i.test(text)) {
    const approvalId = 'q_' + crypto.randomBytes(4).toString('hex');
    persist(threadId, { type: 'question.requested', approvalId, questions: [{ question: 'Which colour should the button be?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'Matches the sidebar' }, { label: 'Green' }, { label: 'Orange', description: 'Stands out more' }] }] }, turnId);
    setStatus(threadId, 'waiting', true);
    t.approvalWaiters ??= new Map();
    await new Promise((resolve) => t.approvalWaiters.set(approvalId, resolve));
    setStatus(threadId, 'running', false);
  }

  const toolId = 'c_' + crypto.randomBytes(4).toString('hex');
  persist(threadId, { type: 'tool.call', itemId: toolId, name: 'Bash', kind: 'command', title: 'ls ~/dev/me/misc', input: { command: 'ls ~/dev/me/misc' } }, turnId);
  await sleep(300);
  persist(threadId, { type: 'tool.result', itemId: toolId, ok: true, text: 'notes.md\nscratch.swift\ntodo.txt', truncated: false, images: [] }, turnId);

  const reply = `You said: "${text.slice(0, 80)}"${images.length ? ` with ${images.length} image${images.length > 1 ? 's' : ''}` : ''}.\n\nThis is the **mock runner**, so here is a canned answer:\n\n1. It streams in small pieces.\n2. Code blocks render in a monospaced box:\n\n\`\`\`swift\nlet greeting = "Hello"\nprint(greeting)\n\`\`\`\n\nThat's all.`;
  const itemId = 'm_' + crypto.randomBytes(4).toString('hex');
  t.inProgress.set(itemId, { type: 'assistant.text', text: '' });
  for (let i = 0; i < reply.length && !interrupted; i += 6) {
    const chunk = reply.slice(i, i + 6);
    t.inProgress.get(itemId).text += chunk;
    transient(threadId, { type: 'assistant.text.delta', itemId, text: chunk }, turnId);
    await sleep(33);
  }
  const finalText = t.inProgress.get(itemId).text;
  t.inProgress.delete(itemId);
  persist(threadId, { type: 'assistant.text', itemId, text: finalText }, turnId);
  // Say "decisions" for a turn that ends with a card of asks to step
  // through (docs/protocol.md, "Needs you", Answering).
  // "one decision" gives a single ask with no options, like a thread
  // started before end_turn had them. "follow-ups" ends done, with
  // end_turn's next under "Or carry on".
  const said = interrupted ? undefined
    : /follow-ups/i.test(text) ? { needs: 'nothing', next: ['Have the librarian tidy project notes when they get long', 'Add a size warning to the Notes panel'] }
    : /decisions/i.test(text) ? { needs: 'you', asks: DEMO_ASKS }
    : /one decision/i.test(text) ? { needs: 'you', asks: [{ action: 'Say go for Short 2 (Thomas on AI being dumb), or name another' }] }
    : undefined;
  finishTurn(threadId, turnId, started, interrupted ? 'interrupted' : 'completed', said);
}

const DEMO_ASKS = [
  { action: 'Set the other 37 repos to collaborator-only pull requests?', why: "Anyone can open a PR on them today. Your own pushes and merges aren't affected.", options: ['Yes, all 37', 'Just the ones with Actions secrets', 'No, leave them'], suggested: 0, links: [{ title: 'See the list of repos', url: 'https://github.com/mikecann?tab=repositories' }] },
  { action: 'Close issues to collaborators too, with private vulnerability reporting on?', why: 'Turns off public issues on all 41 repos. People could still report security problems privately.', options: ['Yes, close them', 'Leave issues open'], suggested: 0 },
  { action: 'Sign in to GitHub in Chrome so I can check the settings took', where: 'github.com › Settings', why: "Then I'll tick off each repo in [the audit](~/dev/me/misc/security-audit/REPORT.md).", options: ['Done', 'Can you do it?'], links: [{ title: 'Open GitHub sign-in', url: 'https://github.com/login' }, { title: 'See the audit', url: '~/dev/me/misc/security-audit/REPORT.md' }] },
];

/**
 * MOCK_SCRIPTED_TURNS names a JSON file of made-up turns, each
 * { match (a regex for the message) or answer (one for a question's answer), thinking, tools: [{ name, kind, title, input, result, ms }],
 *   reply, chunk, chunkMs, end ({ needs, asks } or { needs, next }) }, played at a believable speed
 * instead of the canned answer. For recording the site's clips; nothing else sets it.
 */
// var, not let: applyScriptedThreads runs at startup, above this line.
var scriptedCache;
function scriptedFile() {
  if (scriptedCache) return scriptedCache;
  const file = process.env.MOCK_SCRIPTED_TURNS;
  const json = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  // An array is the turns alone; an object has `turns` and `threads`.
  scriptedCache = Array.isArray(json) ? { turns: json, threads: {} } : { turns: json.turns ?? [], threads: json.threads ?? {}, dir: file && path.dirname(file) };
  return scriptedCache;
}
function scriptedTurns() {
  return scriptedFile().turns;
}

/**
 * MOCK_SCRIPTED_TURNS's `threads`: { <thread id>: { title, preview, ask (its first message's text),
 * review ({ title, note, options: [{ id, title, note, image: { path, width, height } }] }, image
 * paths relative to the file), panels (added to the thread's), asks (its last turn's card) } }, so a
 * clip shows made-up content
 * of its own rather than the demo's.
 */
function applyScriptedThreads() {
  const { threads: overrides, dir } = scriptedFile();
  for (const [id, o] of Object.entries(overrides)) {
    const t = threads.get(id);
    if (!t) continue;
    if (o.title) t.summary.title = o.title;
    if (o.preview) t.summary.preview = o.preview;
    if (o.ask) {
      const first = t.events.find((e) => e.type === 'user.message');
      if (first) first.text = o.ask;
      t.summary.asked = o.ask;
    }
    if (o.review) {
      for (const event of t.events) {
        if (event.type !== 'review.updated') continue;
        const options = o.review.options.map((option) => ({ reference: false, ...option,
          image: { mediaType: 'image/png', ...option.image, path: path.resolve(dir, option.image.path) } }));
        event.review = { ...event.review, title: o.review.title, note: o.review.note, options };
        t.reviews.set(event.review.id, event.review);
      }
      for (const event of t.events) {
        if (event.type === 'tool.call' && event.name?.endsWith('show_options')) { event.title = `Compare options: ${o.review.title}`; event.input = { title: o.review.title }; }
        if (event.type === 'assistant.text' && o.review.reply) event.text = o.review.reply;
      }
    }
    if (o.panels) t.summary.panels = [...(t.summary.panels ?? []), ...o.panels];
    // `asks`: the card of asks its last turn ended with (docs/protocol.md, "Needs you").
    if (o.asks) {
      const done = t.events.findLast((e) => e.type === 'turn.completed');
      if (done) Object.assign(done, { needs: 'you', asks: o.asks });
      // The summary carries them too, and it's what the app draws the card from.
      t.summary.asks = o.asks;
      t.summary.needsYou = true;
    }
  }
}

async function playScripted(threadId, turnId, started, turn, interrupted) {
  const t = threads.get(threadId);
  await sleep(turn.firstMs ?? 500);
  if (turn.thinking) persist(threadId, { type: 'reasoning', itemId: 'r_' + crypto.randomBytes(4).toString('hex'), text: turn.thinking }, turnId);
  for (const tool of turn.tools ?? []) {
    if (interrupted()) break;
    const toolId = 'c_' + crypto.randomBytes(4).toString('hex');
    persist(threadId, { type: 'tool.call', itemId: toolId, name: tool.name ?? 'Bash', kind: tool.kind ?? 'command', title: tool.title, input: tool.input ?? { command: tool.title } }, turnId);
    await sleep(tool.ms ?? 700);
    persist(threadId, { type: 'tool.result', itemId: toolId, ok: tool.ok ?? true, text: tool.result ?? '', truncated: false, images: [] }, turnId);
  }
  const itemId = 'm_' + crypto.randomBytes(4).toString('hex');
  t.inProgress.set(itemId, { type: 'assistant.text', text: '' });
  const size = turn.chunk ?? 5;
  for (let i = 0; i < turn.reply.length && !interrupted(); i += size) {
    const chunk = turn.reply.slice(i, i + size);
    t.inProgress.get(itemId).text += chunk;
    transient(threadId, { type: 'assistant.text.delta', itemId, text: chunk }, turnId);
    await sleep(turn.chunkMs ?? 30);
  }
  const finalText = t.inProgress.get(itemId).text;
  t.inProgress.delete(itemId);
  persist(threadId, { type: 'assistant.text', itemId, text: finalText }, turnId);
  finishTurn(threadId, turnId, started, interrupted() ? 'interrupted' : 'completed', turn.end);
}

function finishTurn(threadId, turnId, started, outcome, said) {
  const t = threads.get(threadId);
  persist(threadId, { type: 'turn.completed', turnId, outcome, durationMs: Date.now() - started, costUsd: 0.0123, ...(said ?? {}) }, turnId);
  t.interrupt = undefined;
  t.summary.needsYou = true;
  setStatus(threadId, 'idle');
  if (t.fresh && t.events.filter((e) => e.type === 'turn.completed').length === 1) librarianFiles(threadId);
}

/**
 * The librarian's look after a new thread's first turn, as the real one does it: the thread
 * shows as the one it's looking at, then it's put in the project whose name it mentions
 * ("Why does the Walkies map jump…" goes in Walkies), with the transcript's note, the row's
 * project and a "Put it in Walkies" line in the Librarian view. A thread naming no project
 * is left out, as a one-off. Timed so a screen recording can catch each step.
 */
function librarianFiles(threadId) {
  const t = threads.get(threadId);
  const s = t.summary;
  if (s.projects?.length || s.archivedAt) return;
  const asked = t.events.find((e) => e.type === 'user.message')?.text ?? '';
  const words = `${s.title} ${asked}`.toLowerCase();
  const project = projects.find((x) => !x.archived && new RegExp(`\\b${x.title.toLowerCase().replace(/[^a-z0-9 ]/g, '')}\\b`).test(words));
  const before = librarian.current;
  t.timers.push(setTimeout(() => {
    librarian.current = { threadId, threadTitle: s.title, reason: 'first-turn', why: 'Its first turn ended', dueAt: iso(), startedAt: iso() };
    librarian.state = 'working';
    broadcastLibrarian();
  }, 800));
  t.timers.push(setTimeout(() => {
    if (!threads.has(threadId) || s.archivedAt) return;
    const entry = { id: 'l_' + crypto.randomBytes(3).toString('hex'), at: iso(), threadId, threadTitle: s.title, reason: 'first-turn', costUsd: 0.0022 };
    if (project) {
      join(s, project, 'librarian', false, iso(), `Asks about ${project.title}`);
      persist(threadId, { type: 'system.note', text: `Put in ${project.title}` });
      librarian.recent.unshift({ ...entry, outcome: 'joined', text: `Put it in ${project.title}`, projectIds: [project.id] });
      broadcastProjects();
    } else {
      librarian.recent.unshift({ ...entry, outcome: 'nothing', text: 'Left it out: a one-off errand' });
    }
    librarian.looksToday += 1;
    librarian.current = before;
    broadcastSummary(threadId);
    broadcastLibrarian();
  }, 2600));
}

/**
 * Streams `seconds` of deltas at `hz` into an assistant item, then persists
 * it. With `tools: true` it behaves more like a real turn: every 1.5 s the
 * text so far is persisted, a tool call and its result are persisted (each
 * persisted event also sends thread.updated), and a new text item starts.
 */
function startStream(threadId, p) {
  const t = threads.get(threadId);
  const hz = Number(p.hz ?? 30);
  const seconds = Number(p.seconds ?? 60);
  const tools = Boolean(p.tools);
  const turnId = 'turn_stream';
  const newItem = () => 'm_stream_' + crypto.randomBytes(3).toString('hex');
  let itemId = newItem();
  const source = streamText();
  let offset = 0;
  let ticks = 0;
  let toolCount = 0;
  const total = Math.round(hz * seconds);
  const toolEvery = Math.max(1, Math.round(hz * 1.5));
  t.inProgress.set(itemId, { type: 'assistant.text', text: '' });
  setStatus(threadId, 'running');
  // Like a real turn, so the app shows it as running ("Working for 3s").
  persist(threadId, { type: 'turn.started', turnId }, turnId);
  const started = Date.now();
  const finishText = () => {
    const text = t.inProgress.get(itemId)?.text ?? '';
    t.inProgress.delete(itemId);
    if (text) persist(threadId, { type: 'assistant.text', itemId, text }, turnId);
  };
  const timer = setInterval(() => {
    // Roughly what Claude streams: 2 to 12 characters per delta.
    const size = 2 + (ticks % 11);
    // From the text twice over, so a chunk that runs past the end wraps
    // to the start instead of coming up short (which dropped letters and
    // started paragraphs mid-word: "re is how...").
    const at = offset % source.length;
    let chunk = (source + source).slice(at, at + size);
    if (!chunk) chunk = ' ';
    offset += size;
    ticks += 1;
    t.inProgress.get(itemId).text += chunk;
    transient(threadId, { type: 'assistant.text.delta', itemId, text: chunk }, turnId);
    if (tools && ticks % toolEvery === 0 && ticks < total) {
      finishText();
      const toolId = `c_stream_${toolCount++}_` + crypto.randomBytes(2).toString('hex');
      persist(threadId, { type: 'tool.call', itemId: toolId, name: 'Bash', kind: 'command', title: 'npm test', input: { command: 'npm test' } }, turnId);
      persist(threadId, { type: 'tool.result', itemId: toolId, ok: true, text: 'PASS src/upload.test.ts\n  12 passed', truncated: false, images: [] }, turnId);
      itemId = newItem();
      t.inProgress.set(itemId, { type: 'assistant.text', text: '' });
    }
    if (ticks >= total) {
      clearInterval(timer);
      finishText();
      persist(threadId, { type: 'turn.completed', turnId, outcome: 'completed', durationMs: Date.now() - started }, turnId);
      setStatus(threadId, 'idle');
    }
  }, 1000 / hz);
  return { itemId, ticks: total };
}

function streamText() {
  return [
    'Here is how the upload pipeline fits together, step by step.\n\n',
    '## Reading the file\n\nThe app reads the file in **64 KB chunks** so memory stays flat even for large videos. ',
    'Each chunk is hashed as it goes, which means the final checksum is ready the moment the last byte is read.\n\n',
    '```swift\nfor try await chunk in reader.chunks(of: 65_536) {\n    hasher.update(data: chunk)\n    try await upload.send(chunk)\n}\n```\n\n',
    '- Retries use exponential backoff starting at 250 ms.\n- A failed chunk is re-sent on its own, not the whole file.\n- Progress is reported per chunk.\n\n',
    'Then the server confirms the checksum and the upload is marked complete. `UploadStore` keeps the state so a crash mid-way resumes where it left off.\n\n',
  ].join('');
}

// ---------------------------------------------------------------- restarts

// The runner's sentences (pendingMessage in runner/src/restart.ts), which
// the app reads: onYou of the waiting threads wait on an answer from you.
function pendingMessage(waiting, onYou = 0) {
  if (waiting === 0) return 'The runner is restarting now.';
  const answer = Math.min(Math.max(0, onYou), waiting);
  const finishing = waiting - answer;
  const finish = finishing === 1 ? '1 thread finishes' : `${finishing} threads finish`;
  if (answer === 0) return `The runner will restart when ${finish}.`;
  if (finishing === 0) return `The runner will restart when you answer ${answer === 1 ? '1 thread' : `${answer} threads`}.`;
  return `The runner will restart when ${finish} and you answer ${answer}.`;
}

/**
 * Restarts the way the real runner does after `runner.restart`: the notice,
 * every connection dropped and the port closed for `downMs` (default 3 s),
 * then back on the same port with a new version. With `resume` (or a
 * resume given to mock.restartPending) that thread gets the "Runner
 * restarted" note and the resume text as a turn sent by the runner
 * (`origin: "runner"`). The reply goes out before anything closes.
 */
function restartNow(p) {
  const downMs = Number(p.downMs ?? 3000);
  const resumeId = p.resume?.threadId ?? pendingRestart?.resumeThreadId;
  if (resumeId) need(resumeId);
  const oldVersion = runnerVersion;
  const newVersion = `0.0.0-mock+r${restarts + 1}`;
  const text = p.resume?.text ?? 'The runner restarted on release 20261027T101500Z-abc1234. Check that your change works, then carry on.';
  // The real runner never restarts with a turn running: an idle restart
  // waits for the threads it named, and "now" stops them. A pending idle
  // restart's threads finish first here (as if they just had), anything
  // else busy is stopped. Before, the CI demo thread stayed Running through
  // the restart in the design shots.
  const waited = new Set(pendingRestart?.when === 'idle' ? pendingRestart.waitingFor : []);
  for (const [id, t] of threads) {
    const s = t.summary;
    if (!['starting', 'running', 'waiting'].includes(s.status)) continue;
    const turnId = t.events.findLast((e) => e.type === 'turn.started')?.turnId;
    const startedAt = Date.parse(t.events.findLast((e) => e.type === 'turn.started')?.ts ?? '') || Date.now();
    if (waited.has(id) && s.status !== 'waiting') {
      persist(id, { type: 'turn.completed', outcome: 'completed', durationMs: Date.now() - startedAt }, turnId);
      setStatus(id, 'idle', true);
    } else if (!waited.has(id)) {
      // Cards still open expire, as the real runner's do when it stops.
      const answered = new Set(t.events.filter((e) => e.type === 'approval.resolved').map((e) => e.approvalId));
      for (const e of t.events.filter((e) => ['approval.requested', 'question.requested', 'secret.requested'].includes(e.type) && !answered.has(e.approvalId))) {
        persist(id, { type: 'approval.resolved', approvalId: e.approvalId, decision: 'expired' }, turnId);
      }
      persist(id, { type: 'turn.completed', outcome: 'interrupted', durationMs: Date.now() - startedAt }, turnId);
      setStatus(id, 'stopped', false);
    }
  }
  broadcastNotice('info', pendingMessage(0));
  pendingRestart = { when: 'now', requestedAt: iso(), waitingFor: [] };
  setTimeout(() => {
    const port = wss.address()?.port;
    wss.close();
    for (const client of clients) client.ws.terminate();
    clients.clear();
    log(`restarting: down for ${downMs} ms`);
    setTimeout(() => {
      restarts += 1;
      runnerVersion = newVersion;
      pendingRestart = undefined;
      wss = listen(port);
      if (resumeId) {
        persist(resumeId, { type: 'system.note', text: `Runner restarted: ${oldVersion} to ${newVersion}` });
        setTimeout(() => fakeTurn(resumeId, text, [], undefined, 'runner'), 10);
      }
    }, downMs);
  }, 100);
  return { scheduled: true, waitingFor: [], version: newVersion };
}

function notice(client, level, message) {
  if (client.authed && client.ws.readyState === 1) {
    client.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.notice', params: { level, message } }));
  }
}

function broadcastNotice(level, message) {
  for (const client of clients) notice(client, level, message);
}

function broadcast(method, params) {
  const text = JSON.stringify({ jsonrpc: '2.0', method, params });
  for (const c of clients) if (c.authed) c.ws.send(text);
}

function broadcastClis() {
  broadcast('clis.updated', { clis });
}

// clis.update: running straight away, done about 2.5 s later. A version
// that's the kept previous one is "Go back" (the two swap); otherwise it
// installs the latest, past a hold only with force or a version.
function fakeCliUpdate(cli, p) {
  const goingBack = p.version && p.version === cli.previousVersion;
  const target = p.version ?? cli.hold?.version ?? cli.latestVersion ?? cli.installedVersion;
  if (cli.hold && !p.force && !p.version && !goingBack) {
    cli.update = { state: 'failed', targetVersion: target, finishedAt: iso(), message: `${target} is held back: ${cli.hold.reason}` };
    broadcastClis();
    return;
  }
  cli.update = { state: 'running', targetVersion: target };
  broadcastClis();
  setTimeout(() => {
    const was = cli.installedVersion;
    cli.installedVersion = target;
    if (goingBack) cli.previousVersion = was;
    else if (cli.provider === 'codex') cli.previousVersion = was;
    // Like the runner: the version gone back from is held, so it isn't
    // installed again by itself (Update anyway still can).
    if (goingBack) cli.hold = { version: was, reason: 'you went back from it' };
    else delete cli.hold;
    cli.status = cli.hold ? 'held' : target === cli.latestVersion ? 'current' : 'behind';
    cli.checkedAt = iso();
    cli.update = { state: 'succeeded', targetVersion: target, finishedAt: iso() };
    broadcastClis();
  }, 2500);
}

/** mock.clis {wentBack: true}: Codex as it is after "Go back to 0.163.0"
 * from 0.164.0: on 0.163.0, 0.164.0 kept and held because Mike went back. */
function wentBack() {
  const codex = clis.find((c) => c.provider === 'codex');
  Object.assign(codex, {
    installedVersion: '0.163.0', previousVersion: '0.164.0', latestVersion: '0.165.0', status: 'held',
    hold: { version: '0.164.0', reason: 'you went back from it' }, checkedAt: iso(),
  });
  delete codex.update;
  broadcastClis();
  return { clis };
}

function needReview(t, id) {
  const review = t.reviews?.get(id);
  if (!review) throw rpcError(-32602, `Review not found: ${id}`);
  return review;
}

function updateReviewCount(t) {
  const count = [...(t.reviews?.values() ?? [])].filter((review) => review.status === 'pending').length;
  if (count) { t.summary.pendingReviews = count; t.summary.needsYou = true; }
  else {
    const hadReview = Boolean(t.summary.pendingReviews);
    delete t.summary.pendingReviews;
    if (hadReview && t.summary.status !== 'waiting') t.summary.needsYou = false;
  }
}

// ---------------------------------------------------------------- events

function persist(threadId, fields, turnId) {
  const t = threads.get(threadId);
  const s = t.summary;
  const event = { seq: s.lastSeq + 1, ts: iso(), threadId, ...(turnId ? { turnId } : {}), ...fields };
  t.events.push(event);
  s.lastSeq = event.seq;
  // Like the real runner: activity is a message, or a turn starting or
  // ending, not every event. The app reads a running thread's
  // lastActivityAt as when its turn started.
  if (['user.message', 'turn.started', 'turn.completed'].includes(fields.type)) s.lastActivityAt = event.ts;
  s.updatedAt = event.ts;
  if (fields.type === 'assistant.text') s.preview = fields.text.replace(/\s+/g, ' ').slice(0, 140);
  s.asked = askedLine(fields) ?? s.asked;
  // Like the real runner's Needs you: a new turn closes the open card, and
  // a completed one that says it needs Mike opens the next.
  if (fields.type === 'turn.started') { delete s.needs; delete s.asks; delete s.asksSeq; }
  if (fields.type === 'turn.completed' && fields.needs) {
    s.needs = fields.needs;
    if (fields.asks) { s.asks = fields.asks; s.asksSeq = event.seq; }
  }
  sendEvent(threadId, event);
  broadcastSummary(threadId);
  return event;
}

function transient(threadId, fields, turnId) {
  const t = threads.get(threadId);
  const event = { seq: t.summary.lastSeq, ts: iso(), threadId, ...(turnId ? { turnId } : {}), ...fields };
  sendEvent(threadId, event);
}

function sendEvent(threadId, event) {
  const text = JSON.stringify({ jsonrpc: '2.0', method: 'thread.event', params: { threadId, event } });
  for (const client of clients) if (client.authed && client.subs.has(threadId)) client.ws.send(text);
}

function setStatus(threadId, status, needsYou) {
  const s = threads.get(threadId).summary;
  s.status = status;
  s.live = true;
  if (needsYou !== undefined) s.needsYou = needsYou;
  broadcastSummary(threadId);
}

function broadcastSummary(threadId) {
  const t = threads.get(threadId);
  if (t.summary.pendingReviews) t.summary.needsYou = true;
  const owner = t.runnerId ?? null;
  const text = JSON.stringify({ jsonrpc: '2.0', method: 'thread.updated', params: { thread: threads.get(threadId).summary } });
  for (const client of clients) if (client.authed && client.as === owner) client.ws.send(text);
  // This runner's clients hear about bruce's threads from the backend.
  if (owner) for (const client of clients) if (client.authed && client.as === null) send(client, 'remoteThreads.updated', remoteThreads(client));
}

function send(client, method, params) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function ownerOf(threadId) {
  return threads.get(threadId)?.runnerId ?? null;
}

// What remoteThreads.list answers this runner's clients: bruce, online and
// reachable at this mock's own /bruce/rpc with a token copied in, and its
// threads as the backend's sidebar table has them. Bruce's own clients
// see no others.
function remoteThreads(client) {
  if (client.as) return { runners: [], threads: [] };
  const { port } = wss.address();
  const bruce = runners.find((r) => r.id === BRUCE);
  const rows = [...threads.values()].filter((t) => t.runnerId === BRUCE).map(({ summary: s }) => ({
    runnerId: BRUCE, threadId: s.id, title: s.title, cwd: s.cwd, accountId: s.accountId, provider: s.provider,
    ...(s.model ? { model: s.model } : {}), status: s.status, needsYou: Boolean(s.needsYou), unread: s.lastSeq > s.lastSeenSeq,
    preview: s.preview, createdAt: s.createdAt, lastActivityAt: s.lastActivityAt,
    ...(s.snoozedUntil ? { snoozedUntil: s.snoozedUntil } : {}), ...(s.archivedAt ? { archivedAt: s.archivedAt } : {}),
    ...(s.startedBy ? { startedBy: s.startedBy } : {}),
    ...(s.asked ? { asked: s.asked } : {}),
  }));
  return {
    runners: [{
      id: BRUCE, name: bruce.name, icon: bruce.icon, online: true, lastSeenAt: iso(),
      rpcUrl: `ws://127.0.0.1:${port}/bruce/rpc`, tokenFile: path.join(dataDir, `secrets/runners/${BRUCE}.token`),
    }, ...MORE_RUNNERS],
    threads: rows,
    order: runnerOrder,
  };
}


function bruceFile(file) {
  if (file === BRUCE_FILES.picture) return fs.readFileSync(path.join(here, 'fixtures/demo-upload-resume/media/upload-times.png'));
  if (file === BRUCE_FILES.list) {
    return Array.from({ length: 14 }, (_, i) => `/Volumes/CannMedia/Footage/2025/clip-${String(i + 1).padStart(3, '0')}.mov  (copy in /Volumes/CannMedia/Inbox)`).join('\n') + '\n';
  }
  if (file === BRUCE_FILES.blob) {
    return Array.from({ length: 400 }, (_, i) => `/Volumes/CannMedia/Footage/2025/clip-${String((i % 14) + 1).padStart(3, '0')}.mov\n/Volumes/CannMedia/Inbox/clip-${String((i % 14) + 1).padStart(3, '0')} (${i}).mov\n`).join('\n');
  }
  return undefined;
}

// files.read as the runner answers it (runner/src/files.ts): bruce's made-up
// files for bruce's clients, real ones on this Mac for this runner's.
function readFile(client, p) {
  if (typeof p.path !== 'string' || !p.path.startsWith('/')) throw rpcError(-32602, `path must be absolute: ${p.path}`);
  let bytes;
  let modifiedAt;
  if (client.as === BRUCE) {
    const content = bruceFile(p.path);
    if (content === undefined) {
      const isFolder = Object.values(BRUCE_FILES).some((f) => f.startsWith(`${p.path.replace(/\/$/, '')}/`));
      throw rpcError(-32602, `${isFolder ? 'Not a file' : 'No such file'}: ${p.path}`);
    }
    bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    modifiedAt = bruceModifiedAt;
  } else {
    let stat;
    try { stat = fs.statSync(p.path); } catch { throw rpcError(-32602, `No such file: ${p.path}`); }
    if (!stat.isFile()) throw rpcError(-32602, `Not a file: ${p.path}`);
    bytes = fs.readFileSync(p.path);
    modifiedAt = stat.mtime.toISOString();
  }
  if (p.known && p.known.size === bytes.length && p.known.modifiedAt === modifiedAt) {
    return { path: p.path, unchanged: true, size: bytes.length, modifiedAt };
  }
  const max = Math.min(typeof p.maxBytes === 'number' && p.maxBytes > 0 ? p.maxBytes : 16 * 1024 * 1024, 48 * 1024 * 1024);
  const sent = bytes.subarray(0, max);
  const ext = path.extname(p.path).slice(1).toLowerCase();
  const mediaType = { png: 'image/png', txt: 'text/plain', md: 'text/markdown' }[ext] ?? 'application/octet-stream';
  return { path: p.path, size: bytes.length, modifiedAt, mediaType, data: sent.toString('base64'), truncated: bytes.length > sent.length };
}

// files.list as the runner answers it (runner/src/files.ts): a made-up
// folder for bruce's clients (each of bruce's files' folders holds it),
// the real one on this Mac for this runner's.
function listFolder(client, p) {
  if (typeof p.path !== 'string' || !p.path.startsWith('/')) throw rpcError(-32602, `path must be absolute: ${p.path}`);
  if (client.as === BRUCE) {
    const files = Object.values(BRUCE_FILES);
    const within = files.filter((f) => f.startsWith(`${p.path.replace(/\/$/, '')}/`)).map((f) => f.slice(p.path.replace(/\/$/, '').length + 1));
    if (!within.length) throw rpcError(-32602, `No such folder: ${p.path}`);
    const names = [...new Set(within.map((f) => f.split('/')[0]))];
    return {
      path: p.path, truncated: false,
      entries: names.map((name) => {
        const isFolder = !within.includes(name);
        return { name, isFolder, hidden: name.startsWith('.'), modifiedAt: bruceModifiedAt, ...(isFolder ? {} : { size: 4096 }) };
      }),
    };
  }
  let stat;
  try { stat = fs.statSync(p.path); } catch { throw rpcError(-32602, `No such folder: ${p.path}`); }
  if (!stat.isDirectory()) throw rpcError(-32602, `Not a folder: ${p.path}`);
  return {
    path: p.path, truncated: false,
    entries: fs.readdirSync(p.path).map((name) => {
      const s = fs.statSync(path.join(p.path, name));
      return { name, isFolder: s.isDirectory(), hidden: name.startsWith('.'), modifiedAt: s.mtime.toISOString(), ...(s.isDirectory() ? {} : { size: s.size }) };
    }),
  };
}

// Three of bruce's threads, one in each state worth seeing: finished and
// waiting on Mike, idle and read, and a turn running. Their folders and
// the picture are paths on bruce, so nothing here has them.
function addRemoteDemo() {
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const make = (id, title, cwd, minutes, status, turns, { unread = false, needsYou = false } = {}) => {
    const summary = {
      id, title, cwd, accountId: 'claude-main', provider: 'claude', model: 'claude-opus-5-5', permissionMode: 'full',
      status, live: status !== 'idle', needsYou, createdAt: ago(minutes + 90), updatedAt: ago(minutes), lastActivityAt: ago(minutes),
      preview: '', lastSeq: 0, lastSeenSeq: 0,
    };
    const events = [];
    const push = (fields, turnId) => events.push({ seq: events.length + 1, ts: ago(minutes), threadId: id, ...(turnId ? { turnId } : {}), ...fields });
    turns.forEach((turn, i) => {
      const turnId = `${id}_t${i}`;
      push({ type: 'user.message', text: turn.ask, images: turn.images ?? [], ...(turn.origin ? { origin: turn.origin } : {}) }, turnId);
      summary.asked = askedLine(events.at(-1)) ?? summary.asked;
      push({ type: 'turn.started' }, turnId);
      for (const [j, tool] of (turn.tools ?? []).entries()) {
        const itemId = `${id}_c${i}_${j}`;
        push({ type: 'tool.call', itemId, name: 'Bash', kind: 'command', title: tool.command, input: { command: tool.command } }, turnId);
        push({ type: 'tool.result', itemId, ok: true, text: tool.text, truncated: Boolean(tool.blobPath), ...(tool.blobPath ? { blobPath: tool.blobPath } : {}), images: [] }, turnId);
      }
      if (turn.answer) {
        push({ type: 'assistant.text', itemId: `${id}_m${i}`, text: turn.answer }, turnId);
        push({ type: 'turn.completed', outcome: 'completed', durationMs: 42_000, ...(turn.needs ? { needs: turn.needs } : {}) }, turnId);
        summary.preview = turn.answer.replace(/\s+/g, ' ').slice(0, 140);
      }
    });
    summary.lastSeq = events.length;
    summary.lastSeenSeq = unread ? Math.max(0, events.length - 2) : events.length;
    threads.set(id, { summary, events, inProgress: new Map(), timers: [], runnerId: BRUCE });
  };
  make('bruce_backup', 'Check the photo library backup', '/Users/bruce/dev/me/misc', 12, 'idle', [{
    ask: 'Is last night\'s photo library backup complete? Here is what Backblaze showed this morning.',
    images: [{ path: BRUCE_FILES.picture, mediaType: 'image/png', width: 760, height: 420 }],
    answer: 'The backup finished at 3:12 am: **48,210 files**, nothing skipped. The only warning is the external drive, which was asleep for the first pass and caught up on the second.\n\nWant me to keep the drive awake during backups?',
    needs: 'you',
  }], { unread: true, needsYou: true });
  make('bruce_media', 'Tidy the media drive', '/Volumes/CannMedia', 300, 'idle', [{
    ask: 'Find duplicate videos on the media drive.',
    // Sent from the iPhone app, so the transcript shows its phone mark.
    origin: 'phone',
    // Output past the runner's cut, kept whole in a blob on bruce.
    tools: [{ command: 'fdupes -r /Volumes/CannMedia/Footage', text: bruceFile(BRUCE_FILES.blob).slice(0, 600), blobPath: BRUCE_FILES.blob }],
    answer: `Found 14 duplicates, 61 GB in all. I listed them in \`duplicates.txt\` and left the files alone.\n\nThe [full scan](<${BRUCE_FILES.blob}>) has every match.`,
    needs: 'nothing',
  }]);
  // Its Highlights: the list it wrote, a path on bruce.
  // Started by a tool on Bruce: its byline reaches this Mac's sidebar.
  threads.get('bruce_backup').summary.startedBy = { kind: 'tool', label: 'Backup watch', icon: 'externaldrive', why: 'last backup 3 days old' };
  const media = threads.get('bruce_media');
  highlights.set('bruce_media', {
    highlights: [{ id: `file:${BRUCE_FILES.list}`, kind: 'file', title: 'duplicates.txt', path: BRUCE_FILES.list, how: 'written',
      seq: media.summary.lastSeq, lastSeq: media.summary.lastSeq, at: media.summary.lastActivityAt }],
    edited: [],
  });
  make('bruce_render', 'Render the shed walkthrough', '/Users/bruce/dev/me/shed', 1, 'running', [{
    ask: 'Render the shed walkthrough at 1080p and tell me when it is done.',
  }]);
  // A turn under way: its clock started a little while ago.
  const render = threads.get('bruce_render').summary;
  render.lastActivityAt = ago(3);
}

function scheduleWake(threadId) {
  const t = threads.get(threadId);
  const delay = Date.parse(t.summary.snoozedUntil) - Date.now();
  if (!(delay > 0) || delay > 2 ** 31 - 1) return;
  setTimeout(() => {
    const s = t.summary;
    if (s.snoozedUntil && Date.parse(s.snoozedUntil) <= Date.now()) {
      s.snoozedUntil = undefined;
      delete s.wakeWhen;
      s.needsYou = true;
      // As the runner does: a note in the thread, and "Woke up" on the row
      // until it's opened.
      persist(threadId, { type: 'system.note', text: 'Woke up from hibernating.' });
      s.woke = { at: iso(), ...(s.snoozedAt ? { since: s.snoozedAt } : {}) };
      delete s.snoozedAt;
      broadcastSummary(threadId);
    }
  }, delay + 50);
}

// ---------------------------------------------------------------- schedules

// The mock's cron is deliberately small: the five fields with *, lists,
// ranges and steps (no names, no @daily), stepped a minute at a time. The
// real runner's is the one to trust. (Constants inside the functions:
// addDemoSchedules runs while the module is still loading.)
function parseCron(cron) {
  const CRON_FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of the month', 1, 31], ['month', 1, 12], ['day of the week', 0, 7]];
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) throw rpcError(-32602, `A cron has five fields (minute hour day month weekday); "${cron}" has ${parts.length}`);
  return parts.map((part, index) => {
    const [name, min, max] = CRON_FIELDS[index];
    const values = new Set();
    for (const piece of part.split(',')) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(piece);
      if (!match) throw rpcError(-32602, `Can't read the ${name} field: "${piece}"`);
      const from = match[1] === '*' ? min : Number(match[2]);
      const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from;
      const step = Number(match[4] ?? 1);
      if (from < min || to > max || from > to || step < 1) throw rpcError(-32602, `The ${name} field "${piece}" is out of range (${min}-${max})`);
      for (let v = from; v <= to; v += step) values.add(index === 4 ? v % 7 : v);
    }
    return { values, any: part === '*' };
  });
}

function cronRuns(cron, count, after = new Date()) {
  const [minute, hour, dom, month, dow] = parseCron(cron);
  const runs = [];
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 400 * 24 * 60 && runs.length < count; i++, t.setMinutes(t.getMinutes() + 1)) {
    if (!minute.values.has(t.getMinutes()) || !hour.values.has(t.getHours()) || !month.values.has(t.getMonth() + 1)) continue;
    const domOk = dom.values.has(t.getDate());
    const dowOk = dow.values.has(t.getDay());
    // Both day fields restricted: either one is enough, as in cron.
    if (dom.any || dow.any ? domOk && dowOk : domOk || dowOk) runs.push(t.toISOString());
  }
  return runs;
}

function clock(h, m) {
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Canned words for the app's own presets; anything else is the cron itself. */
function cronWords(cron) {
  const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  const [m, h, dom, mon, dow] = String(cron).trim().split(/\s+/);
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || mon !== '*') return `On the cron ${cron}`;
  const at = clock(Number(h), Number(m));
  if (dom === '*' && dow === '*') return `Every day at ${at}`;
  if (dom === '*' && dow === '1-5') return `Weekdays at ${at}`;
  if (dom === '*' && /^[0-7]$/.test(dow)) return `${DAYS[Number(dow) % 7]} at ${at}`;
  if (/^\d+$/.test(dom) && dow === '*') return `Every month on day ${dom} at ${at}`;
  return `On the cron ${cron}`;
}

function onceWords(date) {
  const d = new Date(date);
  return `Once, ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')} at ${clock(d.getHours(), d.getMinutes())}`;
}

/** { whenText, runs } for { at } or { cron }. */
function readWhen(p, count = 5) {
  if (p.at) {
    const at = new Date(p.at);
    if (Number.isNaN(at.getTime())) throw rpcError(-32602, `Can't read the time "${p.at}"`);
    return { whenText: onceWords(at), runs: at > new Date() ? [at.toISOString()] : [] };
  }
  if (p.cron) return { whenText: cronWords(p.cron), runs: cronRuns(p.cron, count) };
  throw rpcError(-32602, 'Give at or cron');
}

function needSchedule(id) {
  const schedule = schedules.find((x) => x.id === id);
  if (!schedule) throw rpcError(-32005, 'Schedule not found');
  return schedule;
}

function sortedSchedules() {
  const rank = (x) => (x.nextRunAt ? Date.parse(x.nextRunAt) : Infinity);
  return [...schedules].sort((a, b) => rank(a) - rank(b));
}

function broadcastSettings() {
  const text = JSON.stringify({ jsonrpc: '2.0', method: 'settings.updated', params: { settings } });
  for (const client of clients) if (client.authed) client.ws.send(text);
}

function broadcastSchedules() {
  const text = JSON.stringify({ jsonrpc: '2.0', method: 'schedules.updated', params: { schedules: sortedSchedules() } });
  for (const client of clients) if (client.authed) client.ws.send(text);
}

/**
 * Sends the schedule's message now, to its thread or a new one. Another
 * runner's is only asked of it (queued, with runRequestedAt), and "bruce"
 * picks it up a few seconds later, so the row's waiting line comes and goes.
 */
function runSchedule(schedule) {
  if (schedule.runnerId && schedule.runnerId !== SELF_RUNNER.id) {
    const asked = iso();
    schedule.runRequestedAt = asked;
    schedule.updatedAt = asked;
    broadcastSchedules();
    setTimeout(() => {
      if (schedule.runRequestedAt !== asked || !schedules.includes(schedule)) return;
      delete schedule.runRequestedAt;
      schedule.runs += 1;
      schedule.lastRun = { at: iso(), outcome: 'sent' };
      if (!schedule.cron) { schedule.finishedAt = iso(); delete schedule.nextRunAt; }
      schedule.updatedAt = iso();
      broadcastSchedules();
    }, 6000);
    return { schedule, queued: true };
  }
  const text = `[Scheduled: "${schedule.title}", ${schedule.whenText}]\n${schedule.text}`;
  const turnId = 'turn_' + crypto.randomBytes(4).toString('hex');
  let threadId = schedule.threadId;
  if (!threadId) {
    threadId = 'th_' + crypto.randomBytes(6).toString('hex');
    const now = iso();
    threads.set(threadId, { summary: {
      id: threadId, title: schedule.title, cwd: schedule.cwd ?? defaults.cwd, accountId: schedule.accountId ?? defaults.accountId,
      provider: 'claude', model: schedule.model, effort: schedule.effort, permissionMode: schedule.permissionMode ?? 'full',
      status: 'starting', live: true, needsYou: false, createdAt: now, updatedAt: now, lastActivityAt: now, preview: '', lastSeq: 0, lastSeenSeq: 0,
      schedule: { id: schedule.id, title: schedule.title },
    }, events: [], inProgress: new Map(), timers: [] });
    broadcastSummary(threadId);
  }
  setTimeout(() => fakeTurn(threadId, text, [], turnId, 'schedule', { scheduleId: schedule.id }), 10);
  schedule.runs += 1;
  schedule.lastRun = { at: iso(), outcome: 'sent', threadId };
  if (!schedule.cron) { schedule.finishedAt = iso(); delete schedule.nextRunAt; }
  schedule.updatedAt = iso();
  broadcastSchedules();
  return { schedule, threadId, turnId };
}

// A few schedules for the demo threads, and one message a schedule sent
// already, so the Scheduled view, the line over a thread's composer and
// the transcript's note all have something to show. They don't fire by
// themselves; schedules.run sends one.
function addDemoSchedules() {
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const make = (fields) => {
    const when = readWhen(fields);
    const schedule = {
      createdAt: ago(60 * 24 * 3), updatedAt: ago(60 * 24), runs: 0, paused: false, whenText: when.whenText,
      runnerId: SELF_RUNNER.id, runnerName: SELF_RUNNER.name, runnerIcon: SELF_RUNNER.icon, ...fields,
    };
    if (!schedule.paused && !schedule.finishedAt) schedule.nextRunAt = when.runs[0];
    schedules.push(schedule);
    return schedule;
  };
  if (threads.has('demo_release_notes')) {
    make({ id: 'sc_demo_prs', title: 'Merged PRs into the notes', text: 'List the PRs merged since yesterday and add any that matter to the 0.4 notes.',
      cron: '0 9 * * 1-5', threadId: 'demo_release_notes', runs: 4, lastRun: { at: ago(60 * 5), outcome: 'sent', threadId: 'demo_release_notes' } });
  }
  if (threads.has('demo_ci_slow')) {
    make({ id: 'sc_demo_ci', title: 'Check the CI run again', text: 'Check whether the cache change made the CI build faster.',
      at: new Date(now + 40 * 60_000).toISOString(), threadId: 'demo_ci_slow', createdBy: 'demo_ci_slow' });
  }
  make({ id: 'sc_demo_deps', title: 'Weekly dependency check', text: 'Look for outdated npm and Swift packages in ~/dev/me and list the ones worth updating.',
    cron: '0 10 * * 1', cwd: defaults.cwd, accountId: defaults.accountId, permissionMode: 'full', runs: 6,
    lastRun: { at: ago(60 * 24 * 6), outcome: 'skipped', note: 'the last thread it started was still running' } });
  // A schedule that starts a new thread each time, and the thread it
  // started last, so the sidebar and header show a scheduled thread.
  if (threads.has('demo_invoice_export')) {
    make({ id: 'sc_demo_invoices', title: 'Quarterly invoice export', text: 'Export last quarter\'s invoices as CSV for the accountant.',
      cron: '0 8 1 1,4,7,10 *', cwd: defaults.cwd, accountId: defaults.accountId, permissionMode: 'full', runs: 3,
      lastRun: { at: ago(60 * 26), outcome: 'sent', threadId: 'demo_invoice_export' } });
    threads.get('demo_invoice_export').summary.schedule = { id: 'sc_demo_invoices', title: 'Quarterly invoice export' };
  }
  // Two on bruce, the other Mac: one in a folder there, and one whose Run
  // now is waiting for bruce to hear about it.
  make({ id: 'sc_demo_bruce_photos', title: 'Photo library check', text: 'Check the photo library on the external drive for files that failed to import.',
    cron: '30 6 * * *', cwd: '/Volumes/CannMedia/Photos', permissionMode: 'full', runs: 12,
    runnerId: 'runner_bruce', runnerName: 'bruce', runnerIcon: 'macmini', lastRun: { at: ago(60 * 8), outcome: 'sent' } });
  make({ id: 'sc_demo_bruce_disk', title: 'Disk space report', text: 'Say how much space is left on each drive and what grew most this week.',
    cron: '0 8 * * 1', permissionMode: 'full', runs: 2, runnerId: 'runner_bruce', runnerName: 'bruce', runnerIcon: 'macmini', runRequestedAt: ago(2) });
  make({ id: 'sc_demo_backup', title: 'Nightly backup report', text: 'Summarise last night\'s Backblaze log and say if anything failed.',
    cron: '0 2 * * *', cwd: '/Users/mike/dev/old-backups', accountId: defaults.accountId, paused: true, runs: 21,
    lastRun: { at: ago(60 * 30), outcome: 'failed', note: 'the folder /Users/mike/dev/old-backups is gone' } });
  // A one-off that has run, under Done in the Scheduled list.
  make({ id: 'sc_demo_renewal', title: 'Check the domain renewal went through', text: 'Look for the renewal receipt in the inbox and say if it charged the right card.',
    at: ago(60 * 20), cwd: defaults.cwd, accountId: defaults.accountId, permissionMode: 'full', runs: 1, finishedAt: ago(60 * 20),
    lastRun: { at: ago(60 * 20), outcome: 'sent' } });

  // What a schedule's message looks like once sent: at the end of the
  // release notes thread, without moving it in the sidebar.
  const t = threads.get('demo_release_notes');
  if (t) {
    let seq = t.summary.lastSeq;
    const ts = t.events.at(-1)?.ts ?? ago(5);
    const push = (fields) => t.events.push({ seq: ++seq, ts, threadId: t.summary.id, turnId: 'turn_sched', ...fields });
    push({ type: 'user.message', origin: 'schedule', scheduleId: 'sc_demo_prs', images: [],
      text: '[Scheduled: "Merged PRs into the notes", Weekdays at 9:00]\nList the PRs merged since yesterday and add any that matter to the 0.4 notes.' });
    push({ type: 'turn.started' });
    push({ type: 'assistant.text', itemId: 'm_sched', text: 'Two PRs merged since yesterday: **#212** (faster thread switching) and **#214** (fix for pasted images). I added both under *Improvements*.' });
    push({ type: 'turn.completed', outcome: 'completed', durationMs: 8400, costUsd: 0.02 });
    t.summary.lastSeq = seq;
    t.summary.lastSeenSeq = seq;
  }
}

// ---------------------------------------------------------------- projects

function projectRequest(method, p) {
  switch (method) {
    case 'projects.list':
      return { projects: listedProjects(p.archived === true) };
    case 'projects.get': {
      const project = needProject(p.projectId);
      return { project: projectView(project), threadIds: newestFirst(membersOf(project.id)).map((s) => s.id) };
    }
    case 'projects.create': {
      const title = String(p.title ?? '').trim();
      if (!title) throw rpcError(-32602, 'title is required');
      const project = {
        id: 'p_' + crypto.randomBytes(4).toString('hex'), title, folders: p.folders ?? [], goals: p.goals ?? '', state: p.state ?? '',
        notes: p.notes ?? '', links: p.links ?? [], createdBy: 'mike', createdAt: iso(), updatedAt: iso(),
      };
      projects.push(project);
      for (const threadId of p.threadIds ?? []) join(need(threadId).summary, project, 'mike', true);
      broadcastProjects();
      return { project: projectView(project) };
    }
    case 'projects.update': {
      const project = needProject(p.projectId);
      for (const key of ['title', 'folders', 'goals', 'notes', 'links']) if (p[key] !== undefined) project[key] = p[key];
      if (p.notion !== undefined) {
        project.notion = p.notion || undefined;
        project.tasks = p.notion ? { url: p.notion, columns: [], items: [], loading: true } : undefined;
      }
      if (p.state !== undefined) { project.state = p.state; project.stateUpdatedAt = iso(); }
      if (p.archived !== undefined) project.archived = Boolean(p.archived) || undefined;
      project.updatedAt = iso();
      if (p.title !== undefined) for (const s of membersOf(project.id)) { renameIn(s, project); broadcastSummary(s.id); }
      broadcastProjects();
      return { project: projectView(project) };
    }
    // The board is canned (addDemoProjects); a read just moves its time on.
    case 'projects.refreshTasks': {
      const project = needProject(p.projectId);
      if (!project.notion) throw rpcError(-32602, `${project.title} has no Notion page.`);
      if (project.tasks && !project.tasks.loading) project.tasks.fetchedAt = iso();
      return { project: projectView(project) };
    }
    case 'projects.setIcon': {
      const project = needProject(p.projectId);
      if (p.path) project.icon = { image: { path: p.path, mediaType: 'image/png' }, from: p.path, by: 'mike', updatedAt: iso() };
      else if (p.symbol) project.icon = { symbol: p.symbol, by: 'mike', updatedAt: iso() };
      else delete project.icon;
      broadcastProjects();
      return { project: projectView(project) };
    }
    case 'projects.merge': {
      const from = needProject(p.projectId);
      const into = needProject(p.intoId);
      if (from === into) throw rpcError(-32602, 'a project can\'t be merged into itself');
      into.folders = [...new Set([...into.folders, ...from.folders])];
      if (from.notes) into.notes = [into.notes, `## From ${from.title}\n\n${from.notes}`].filter(Boolean).join('\n\n');
      into.updatedAt = iso();
      for (const s of membersOf(from.id)) {
        const was = s.projects.find((x) => x.id === from.id);
        s.projects = s.projects.filter((x) => x.id !== from.id);
        if (!s.projects.some((x) => x.id === into.id)) join(s, into, was.by, was.pinned);
        if (!s.projects.length) delete s.projects;
        broadcastSummary(s.id);
      }
      projects = projects.filter((x) => x !== from);
      broadcastProjects();
      return { project: projectView(into) };
    }
    case 'projects.delete': {
      const project = needProject(p.projectId);
      for (const s of membersOf(project.id)) {
        s.projects = s.projects.filter((x) => x.id !== project.id);
        if (!s.projects.length) delete s.projects;
        broadcastSummary(s.id);
      }
      projects = projects.filter((x) => x !== project);
      broadcastProjects();
      return {};
    }
    case 'threads.setProjects': {
      const s = need(p.threadId).summary;
      for (const id of p.add ?? []) {
        const project = needProject(id);
        const already = s.projects?.find((x) => x.id === id);
        // Added by hand: pinned, and Mike's from then on.
        if (already) Object.assign(already, { pinned: true });
        else join(s, project, 'mike', true);
      }
      for (const id of p.remove ?? []) {
        needProject(id);
        s.projects = (s.projects ?? []).filter((x) => x.id !== id);
        if (!s.projects.length) delete s.projects;
      }
      s.updatedAt = iso();
      broadcastSummary(s.id);
      broadcastProjects();
      return { thread: s };
    }
    case 'librarian.status':
      return { librarian };
    case 'librarian.run': {
      const due = new Date(Date.now() + 10_000).toISOString();
      const ids = p.threadId ? [need(p.threadId).summary.id]
        : newestFirst([...threads.values()].filter((t) => !t.runnerId).map((t) => t.summary).filter((s) => !s.projects?.length && !s.archivedAt)).map((s) => s.id);
      for (const id of ids) {
        if (librarian.current?.threadId === id || librarian.queue.some((j) => j.threadId === id)) continue;
        librarian.queue.push({ threadId: id, threadTitle: threads.get(id).summary.title, reason: 'asked', why: 'Asked for', dueAt: due });
      }
      librarian.queue.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
      broadcastLibrarian();
      return { librarian };
    }
    case 'librarian.update':
      if (p.paused !== undefined) {
        librarian.paused = Boolean(p.paused);
        // A paused librarian finishes nothing new: what was under way goes
        // back to the front of the queue.
        if (librarian.paused && librarian.current) {
          const { startedAt: _s, ...job } = librarian.current;
          librarian.queue.unshift(job);
          delete librarian.current;
        }
        librarian.state = librarian.paused ? 'paused' : librarian.queue.length ? 'working' : 'idle';
        if (!librarian.paused && librarian.queue.length && !librarian.current) {
          librarian.current = { ...librarian.queue.shift(), startedAt: iso() };
        }
      }
      broadcastLibrarian();
      return { librarian };
  }
}

/** A project as the protocol sends it: with its thread count and newest activity. */
function projectView(project) {
  const members = membersOf(project.id);
  const newest = Math.max(...members.map((s) => Date.parse(s.lastActivityAt)));
  return { ...project, threadCount: members.length, ...(Number.isFinite(newest) ? { lastActivityAt: new Date(newest).toISOString() } : {}) };
}

function listedProjects(archived) {
  const list = projects.filter((x) => archived || !x.archived).map(projectView);
  return list.sort((a, b) => Date.parse(b.lastActivityAt ?? b.updatedAt) - Date.parse(a.lastActivityAt ?? a.updatedAt));
}

function membersOf(projectId) {
  return [...threads.values()].map((t) => t.summary).filter((s) => s.projects?.some((x) => x.id === projectId));
}

function join(summary, project, by, pinned, at = iso(), why) {
  summary.projects = [...(summary.projects ?? []), { id: project.id, title: project.title, by, ...(pinned ? { pinned: true } : {}), at, ...(why ? { why } : {}) }];
}

function renameIn(summary, project) {
  for (const x of summary.projects ?? []) if (x.id === project.id) x.title = project.title;
}

function needProject(id) {
  const project = projects.find((x) => x.id === id);
  if (!project) throw rpcError(-32007, 'Project not found');
  return project;
}

function broadcastProjects() {
  broadcast('projects.updated', { projects: listedProjects(true) });
}

function broadcastLibrarian() {
  broadcast('librarian.updated', { librarian });
}

// Three projects over the demo threads: one thread in two of them, some in
// none, one the librarian has only just put somewhere (unpinned, with the
// transcript's note saying so), and Walkies giving the dark mode thread
// its Convex panel from another folder. The librarian is part way through
// a look with three more queued, and has done eight things today.
function walkiesTasks(fetchedAt) {
  const card = (n, title, status, who, extra = {}) => ({ id: `t${n}`, title, url: `https://www.notion.so/t${n}`, status, who, ...extra });
  return {
    url: 'https://www.notion.so/1a2b3c4d5e6f40718293a4b5c6d7e8f9',
    fetchedAt,
    columns: [
      { name: 'To do', kind: 'todo', color: 'gray' },
      { name: 'Doing', kind: 'doing', color: 'blue' },
      { name: 'Waiting', kind: 'doing', color: 'orange' },
      { name: 'Done', kind: 'done', color: 'green' },
    ],
    items: [
      card(1, 'Share a walk with a friend', 'To do', ['Mike']),
      card(2, 'Walk replay at the end is too long', 'To do', ['Mike'], { due: '2026-11-07' }),
      card(3, 'Pick the share button colour', 'Doing', ['Mike'], { thread: 'demo_button_colour' }),
      card(4, 'Dark mode for the dashboard', 'Waiting', ['Sam'], { thread: 'demo_dark_mode' }),
      card(5, 'App Store screenshots for 1.1', 'Waiting', ['Sam', 'Mike'], { due: '2026-11-29', dueEnd: '2026-12-04' }),
      card(6, 'Battery check on the old Pixel', 'Done', ['Mike']),
      card(7, 'Car trips stop counting as walks', 'Done', ['Mike']),
      card(8, 'Fix the 5.1.1 rejection', 'Done', ['Mike']),
      card(9, 'Sentry on the backend', 'Done', ['Mike']),
    ],
  };
}

function addDemoProjects() {
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const soon = (seconds) => new Date(now + seconds * 1000).toISOString();
  const tb = {
    id: 'p_3b1d9e20', title: 'Threadbear', folders: ['/Users/mike/dev/me/threadbear'],
    goals: 'Mike\'s own agent app: a runner that drives the Claude and Codex CLIs, and a native Mac app over it. Done is when it replaces T3 Code for everyday work.',
    state: 'Projects and the librarian are next: protocol written, runner and app being built in parallel. Settings tabs renamed; release notes for 0.4 drafted.',
    notes: '**Checks**: `./check.sh` runs everything, `--quick` for the runner only.\n\nNever restart the live runner from a thread; merge to main and it follows.\n\nThe protocol is the contract: change `docs/protocol.md` first.',
    links: [{ title: 'Website', url: 'https://threadbear.example.app/' }],
    createdBy: 'librarian', createdByThread: 'demo_release_notes', createdAt: ago(60 * 24 * 9), updatedAt: ago(3), stateUpdatedAt: ago(41),
    // The three kinds of icon: a picture (the app's own), a symbol, and
    // Walkies with none yet, which shows its letter.
    icon: { image: { path: fileURLToPath(new URL('../../icons/threadbear.png', import.meta.url)), mediaType: 'image/png' }, from: '/Users/mike/dev/me/threadbear/app/icons/threadbear.png', by: 'librarian', updatedAt: ago(60) },
  };
  const photo = {
    id: 'p_7a2c41f0', title: 'Photo sync', folders: ['/Users/mike/dev/photo-sync'],
    goals: 'Back up the family photo library to B2 without babysitting it: resumable uploads, a nightly report, and builds that don\'t take fifteen minutes.',
    state: 'Uploads resume after a crash in testing; waiting on Mike to pick the chunk size. CI is slow because the lockfile change broke the cache key.',
    notes: '', links: [], createdBy: 'librarian', createdByThread: 'demo_upload_resume', createdAt: ago(60 * 24 * 4), updatedAt: ago(41), stateUpdatedAt: ago(41),
    icon: { symbol: 'photo', by: 'librarian', updatedAt: ago(60) },
  };
  const walkies = {
    id: 'p_c9e8d102', title: 'Walkies', folders: ['/Users/mike/dev/walkies', '/Users/mike/dev/walkies-backend'],
    goals: 'The dog walking app: iOS client and Convex backend. Next milestone is sharing a walk with a friend.',
    state: 'Share button colour being picked; dark mode for the dashboard done and waiting for review.',
    notes: '', createdBy: 'mike', createdAt: ago(60 * 24 * 20), updatedAt: ago(60 * 2),
    // Shown at the top of its threads' Highlights.
    links: [
      { title: 'Live site', url: 'https://walkies.example.app/' },
      { title: 'Admin', url: 'https://walkies.example.app/admin' },
      { title: 'App Store', url: 'https://apps.apple.com/app/walkies/id6700000000' },
    ],
    // A task board from Notion (docs/protocol.md, "Project tasks").
    notion: 'https://www.notion.so/Walkies-1a2b3c4d5e6f40718293a4b5c6d7e8f9',
    tasks: walkiesTasks(ago(2)),
  };
  projects = [tb, photo, walkies];
  // `why` is the librarian's reason, behind the project's ⓘ in Highlights.
  const put = (threadId, project, by, pinned, minutesAgo, why) => {
    const t = threads.get(threadId);
    if (t) join(t.summary, project, by, pinned, ago(minutesAgo), why);
  };
  put('demo_settings_tabs', tb, 'librarian', false, 3, 'Renames the Settings tabs in the Mac app');
  put('demo_sqlite_vs_files', tb, 'agent', true, 60 * 30);
  put('demo_release_notes', tb, 'mike', true, 60 * 24 * 9);
  put('demo_quick_ask_readme', tb, 'librarian', false, 60 * 24 * 6);
  put('demo_ci_slow', photo, 'agent', true, 60 * 3);
  put('demo_ci_slow', tb, 'librarian', false, 60 * 2, 'Mentions the runner\'s check script');
  put('demo_upload_resume', photo, 'librarian', true, 60 * 24 * 4, 'Makes uploads resume after a crash');
  put('demo_build_scripts', photo, 'librarian', false, 60 * 24 * 3);
  put('demo_button_colour', walkies, 'librarian', false, 18, 'Picks the share button colour for Walkies');
  put('demo_dark_mode', walkies, 'mike', true, 60 * 24 * 2);

  // Walkies' backend folder gives the dark mode thread (which is in misc)
  // its Convex panel, and a patch of its own.
  const dark = threads.get('demo_dark_mode');
  if (dark) {
    for (const panel of dark.summary.panels ?? []) if (panel.patch === 'convex') panel.projectId = walkies.id;
    dark.summary.actions = [
      ...(dark.summary.actions ?? []),
      { id: 'walkies.seed-walks', title: 'Seed walks', kind: 'command', command: 'npx convex run seed:walks', patch: 'walkies',
        folder: '/Users/mike/dev/walkies-backend', projectId: walkies.id },
    ];
    dark.summary.patches = [
      { id: 'tools', source: 'project', file: '/Users/mike/dev/me/misc/.threadbear/patches/tools.ts', folder: '/Users/mike/dev/me/misc' },
      { id: 'convex', source: 'builtin', folder: '/Users/mike/dev/walkies-backend', projectId: walkies.id },
      { id: 'walkies', source: 'project', file: '/Users/mike/dev/walkies-backend/.threadbear/patches/walkies.ts', folder: '/Users/mike/dev/walkies-backend', projectId: walkies.id },
    ];
  }

  // The librarian's note in the thread it has just put somewhere.
  const tabs = threads.get('demo_settings_tabs');
  if (tabs) {
    const seq = ++tabs.summary.lastSeq;
    tabs.summary.lastSeenSeq = seq;
    tabs.events.push({ seq, ts: ago(3), threadId: tabs.summary.id, type: 'system.note', text: 'Put in Threadbear' });
  }

  const title = (id) => threads.get(id)?.summary.title ?? id;
  librarian = {
    state: 'working', paused: false,
    current: { threadId: 'demo_landing_pages', threadTitle: title('demo_landing_pages'), reason: 'first-turn', why: 'Its first turn ended', dueAt: ago(0.2), startedAt: ago(0.1) },
    queue: [
      { threadId: 'demo_codex_poster', threadTitle: title('demo_codex_poster'), reason: 'new-folder', why: 'Edited files in ~/dev/meetup-site', dueAt: soon(40) },
      { threadId: 'demo_ci_slow', threadTitle: title('demo_ci_slow'), reason: 'catch-up', why: '4 turns since the last look', dueAt: soon(25 * 60) },
      { threadId: 'demo_upload_resume', threadTitle: title('demo_upload_resume'), reason: 'catch-up', why: '2 turns since the last look', dueAt: soon(52 * 60) },
    ],
    recent: [
      { id: 'l8', at: ago(3), threadId: 'demo_settings_tabs', threadTitle: title('demo_settings_tabs'), reason: 'first-turn', outcome: 'joined', text: 'Put it in Threadbear', projectIds: [tb.id], costUsd: 0.0021 },
      { id: 'l7', at: ago(18), threadId: 'demo_button_colour', threadTitle: title('demo_button_colour'), reason: 'new-folder', outcome: 'joined', text: 'Put it in Walkies', projectIds: [walkies.id], costUsd: 0.0024 },
      { id: 'l6', at: ago(41), threadId: 'demo_ci_slow', threadTitle: title('demo_ci_slow'), reason: 'catch-up', outcome: 'updated', text: 'Photo sync\'s state', projectIds: [photo.id], costUsd: 0.0031 },
      { id: 'l5', at: ago(70), threadId: 'demo_invoice_export', threadTitle: title('demo_invoice_export'), reason: 'first-turn', outcome: 'nothing', text: 'Left it out: a one-off errand', costUsd: 0.0017 },
      { id: 'l4', at: ago(60 * 2), threadId: 'demo_ci_slow', threadTitle: title('demo_ci_slow'), reason: 'new-folder', outcome: 'joined', text: 'Put it in Threadbear too', projectIds: [tb.id], costUsd: 0.0026 },
      { id: 'l3', at: ago(60 * 3), threadId: 'demo_tunnel', threadTitle: title('demo_tunnel'), reason: 'asked', outcome: 'skipped', text: 'Archived before its first look' },
      { id: 'l2', at: ago(60 * 4), threadId: 'demo_sqlite_vs_files', threadTitle: title('demo_sqlite_vs_files'), reason: 'catch-up', outcome: 'updated', text: 'Threadbear\'s state', projectIds: [tb.id], costUsd: 0.0029 },
      { id: 'l1', at: ago(60 * 5), threadId: 'demo_landing_pages', threadTitle: title('demo_landing_pages'), reason: 'first-turn', outcome: 'failed', text: 'Claude took too long to answer' },
    ],
    looksToday: 14, spentTodayUsd: 0, skippedToday: 3, tokensToday: 52_400, notionalTodayUsd: 0.011,
  };
}

// ---------------------------------------------------------------- fixtures

function defaultFixtureDirs() {
  const dirs = [path.join(here, 'fixtures')];
  const privateDir = path.resolve(here, '../../.fixtures');
  if (fs.existsSync(privateDir)) dirs.push(privateDir);
  // Not .fixtures/threads, where `tb export` puts Mike's real threads: they'd
  // sort above the demo threads in every screenshot. Pass --fixtures for them.
  return dirs;
}

// The demo threads were made with times "n minutes ago" (make-synthetic.mjs,
// newest a minute old). Moved so that's true whenever the mock runs: fixed
// times aged every design shot by the hour, and the sidebar's truncation
// changed with them, so shots never matched their baseline. Real exports
// keep their times. (Functions, not module constants: loadFixtures runs
// while the module is still loading.)
function shiftToNow(loaded) {
  const TIME_FIELDS = ['createdAt', 'updatedAt', 'lastActivityAt', 'snoozedUntil', 'archivedAt'];
  const newest = Math.max(...loaded.map((t) => Date.parse(t.summary.lastActivityAt)).filter(Number.isFinite));
  if (!Number.isFinite(newest)) return;
  const by = Date.now() - 60_000 - newest;
  const move = (iso) => (typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + by).toISOString() : iso);
  for (const t of loaded) {
    for (const k of TIME_FIELDS) if (t.summary[k] !== undefined) t.summary[k] = move(t.summary[k]);
    for (const e of t.events) e.ts = move(e.ts);
  }
}

// Two demo threads get panels, as the real runner gives a thread in a
// Convex or Xcode project: a page (a small one of our own, so screenshots
// need no network or login) and the Simulator picture.
// Sub-agents for the running CI thread (docs/protocol.md, Subagent): one
// still going whose transcript grows every few seconds, one it started
// itself, one that has reported back and one that failed. Their
// transcripts are what threads.subagent answers with.
function addDemoSubagents() {
  const t = threads.get('demo_ci_slow');
  if (!t) return;
  const now = Date.now();
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  t.summary.subagents = [
    { id: 'a_cache', itemId: 'agent_cache', description: 'Compare the cache keys', agentType: 'Explore', status: 'completed', background: false,
      summary: 'The lockfile hash changed on 21 Oct, so every run since misses the cache.', toolUses: 4, startedAt: at(200), endedAt: at(150) },
    { id: 'a_bisect', itemId: 'agent_bisect', description: 'Find the commit that slowed the build', agentType: 'general-purpose', status: 'running', background: true,
      activity: 'Running git bisect on the last 40 commits', toolUses: 2, startedAt: at(95) },
    { id: 'a_bisect_tests', parentId: 'a_bisect', description: 'Time the test step on each commit', agentType: 'fork', status: 'running', background: false,
      activity: 'Reading run-845.log', toolUses: 1, startedAt: at(40) },
    { id: 'a_docker', itemId: 'agent_docker', description: 'Check the Docker layer cache', agentType: 'Explore', status: 'failed', background: true,
      summary: 'Couldn\'t reach the registry.', toolUses: 1, startedAt: at(180), endedAt: at(170) },
  ];
  const ev = (list) => list.map((e, i) => ({ seq: i + 1, ts: at(90 - i * 5), ...e }));
  t.subagentEvents = new Map([
    ['a_cache', ev([
      { type: 'user.message', text: 'Compare the cache keys in run-812.log and run-845.log and say why the second one missed.', images: [] },
      { type: 'tool.call', itemId: 'c1', name: 'Bash', kind: 'command', title: 'grep "cache key" run-812.log run-845.log', input: { command: 'grep "cache key" run-812.log run-845.log' } },
      { type: 'tool.result', itemId: 'c1', ok: true, text: 'run-812.log: cache key node-modules-9f2c\nrun-845.log: cache key node-modules-41ab', truncated: false, images: [] },
      { type: 'tool.call', itemId: 'c2', name: 'Bash', kind: 'command', title: 'git log -p package-lock.json', input: { command: 'git log --since=2026-10-20 -p package-lock.json | head -40' } },
      { type: 'tool.result', itemId: 'c2', ok: true, text: 'commit 7d1e2a0 (21 Oct)\n    Bump sharp to 0.34', truncated: false, images: [] },
      { type: 'assistant.text', itemId: 'm1', text: 'The keys differ because **package-lock.json** changed on 21 Oct (`7d1e2a0`, the sharp bump). The cache is keyed on the lockfile hash, so every run since misses it and installs from scratch.' },
    ])],
    ['a_bisect', ev([
      { type: 'user.message', text: 'Find which commit made the CI build slow. Bisect the last 40 commits on main, timing `npm run build` on each.', images: [] },
      { type: 'reasoning', itemId: 'r1', text: 'Forty commits is about six steps of bisect. The test step looks like the slow part, so I\'ll have a fork time that in parallel.' },
      { type: 'tool.call', itemId: 'b1', name: 'Bash', kind: 'command', title: 'git bisect start main 7d1e2a0~5', input: { command: 'git bisect start main 7d1e2a0~5' } },
      { type: 'tool.result', itemId: 'b1', ok: true, text: 'Bisecting: 20 revisions left to test after this (roughly 4 steps)', truncated: false, images: [] },
      { type: 'tool.call', itemId: 'b2', name: 'Agent', kind: 'task', title: 'Time the test step on each commit', input: { description: 'Time the test step on each commit', subagent_type: 'fork' } },
    ])],
    ['a_bisect_tests', ev([
      { type: 'user.message', text: 'Time the test step on each commit the bisect stops at.', images: [] },
      { type: 'tool.call', itemId: 't1', name: 'Read', kind: 'read', title: 'Read run-845.log', input: { file_path: '/Users/mike/dev/photo-sync/run-845.log' } },
    ])],
    ['a_docker', ev([
      { type: 'user.message', text: 'Check whether the Docker layer cache is being used on CI.', images: [] },
      { type: 'tool.call', itemId: 'd1', name: 'Bash', kind: 'command', title: 'docker buildx du --builder ci', input: { command: 'docker buildx du --builder ci' } },
      { type: 'tool.result', itemId: 'd1', ok: false, text: 'error: dial tcp registry.internal:443: i/o timeout', truncated: false, images: [] },
      { type: 'assistant.text', itemId: 'm1', text: 'I couldn\'t reach the registry, so I can\'t say whether the layer cache is used.' },
    ])],
  ]);
  // The running one does a few more things, so an open transcript has
  // something to pick up.
  const steps = [
    { activity: 'Running npm run build on 3f9c2d1', call: { name: 'Bash', kind: 'command', title: 'npm run build', input: { command: 'npm run build' } }, result: 'Built in 4m 58s' },
    { activity: 'Marking 3f9c2d1 good', call: { name: 'Bash', kind: 'command', title: 'git bisect good', input: { command: 'git bisect good' } }, result: 'Bisecting: 10 revisions left to test after this (roughly 3 steps)' },
    { activity: 'Running npm run build on 7d1e2a0', call: { name: 'Bash', kind: 'command', title: 'npm run build', input: { command: 'npm run build' } }, result: 'Built in 13m 02s' },
  ];
  steps.forEach((step, i) => {
    const timer = setTimeout(() => {
      const list = t.subagentEvents.get('a_bisect');
      const itemId = `b${3 + i}`;
      list.push({ seq: list.length + 1, ts: iso(), type: 'tool.call', itemId, ...step.call });
      list.push({ seq: list.length + 1, ts: iso(), type: 'tool.result', itemId, ok: true, text: step.result, truncated: false, images: [] });
      const s = t.summary.subagents.find((x) => x.id === 'a_bisect');
      s.activity = step.activity;
      s.toolUses += 1;
      broadcastSummary(t.summary.id);
    }, 6000 * (i + 1));
    timer.unref?.();
    t.timers.push(timer);
  });
}

// Every demo thread is in the pool that has its login, as a new thread
// would be, except the SQLite one, which stays pinned to its login, and the
// release notes, which wait in Evenings for its one login to have room.
function addDemoPools() {
  for (const t of threads.values()) {
    const s = t.summary;
    if (s.id === 'demo_sqlite_vs_files') continue;
    if (s.id === 'demo_release_notes') {
      const login = accounts.find((a) => a.id === 'claude-4');
      const reset = login?.usage?.windows?.find((w) => w.kind === 'five_hour')?.resetsAt;
      Object.assign(s, { accountId: 'claude-4', poolId: 'evenings' });
      if (reset) s.waitingForRoom = { until: new Date(Date.parse(reset) + 60_000).toISOString(), accountId: 'claude-4' };
      continue;
    }
    s.poolId ??= pools.find((pool) => pool.accountIds.includes(s.accountId))?.id;
  }
}

function addDemoPanels() {
  const page = `<!doctype html><meta charset="utf-8"><title>Convex dashboard</title>
<style>body{margin:0;font:13px -apple-system,system-ui;background:#1b1b1d;color:#d8d8dc;display:flex;height:100vh}
nav{width:150px;border-right:1px solid #2b2b2e;padding:14px 0}nav div{padding:6px 16px;color:#9a9aa0}nav .on{background:#28282b;color:#e8e8ec;border-radius:6px;margin:0 8px;padding:6px 8px}
main{flex:1;padding:16px 18px}h1{font-size:14px;margin:0 0 12px;display:flex;gap:8px;align-items:center}
.tag{font-size:11px;color:#9a9aa0;border:1px solid #39393d;border-radius:10px;padding:1px 7px;font-weight:400}
table{border-collapse:collapse;font:12px ui-monospace,Menlo,monospace;color:#c8c8cc}td,th{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid #2b2b2e}th{color:#8a8a90;font-weight:500}
p{color:#8a8a90;font-size:12px;line-height:1.5;margin-top:18px}
@media (prefers-color-scheme: light){body{background:#fff;color:#222}nav{border-color:#e6e6e8}nav div{color:#666}nav .on{background:#f0f0f2;color:#111}table{color:#333}td,th{border-color:#ececef}th,p,.tag{color:#777}.tag{border-color:#ddd}}</style>
<nav><div>dashboard</div><div>notes</div><div>scratchpad</div><div>snapshots</div><div class="on">usage</div><div>videos</div></nav>
<main><h1>usage <span class="tag">dev</span><span class="tag">1 document</span></h1>
<table><tr><th>_id</th><th>month</th><th>spendUsd</th><th>limitUsd</th></tr><tr><td>j57c…9m2</td><td>"2026-10"</td><td>41.8</td><td>80</td></tr></table>
${process.env.MOCK_SCRIPTED_TURNS ? '' : "<p>The mock runner's stand-in for the Convex dashboard. A real thread in a Convex project gets dashboard.convex.dev for its deployment here.</p>"}</main>`;
  const convex = threads.get('demo_dark_mode');
  if (convex) {
    convex.summary.panels = [{
      id: 'convex.dashboard', title: 'Convex', kind: 'url', patch: 'convex',
      url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page), note: 'happy-otter-123 (dev)',
    }];
    // As a project's .threadbear/patches/tools.ts would give it.
    convex.summary.actions = [
      { id: 'tools.typecheck', title: 'Typecheck', kind: 'command', command: 'npx tsc --noEmit', patch: 'tools' },
      { id: 'tools.open-logs', title: 'Open logs', kind: 'prompt', prompt: 'Tail the Convex logs and tell me about any errors.', patch: 'tools' },
      { id: 'tools.deploy-to-prod', title: 'Deploy to prod', kind: 'command', command: 'npx convex deploy', patch: 'tools', note: 'Asks nothing; be sure' },
      { id: 'tools.reseed-dev-db', title: 'Reseed dev DB', kind: 'command', command: 'npx convex run seed:reset && npx convex import --replace fixtures/dev.zip', patch: 'tools' },
    ];
    convex.summary.patches = [
      { id: 'convex', source: 'builtin' },
      { id: 'tools', source: 'project', file: '/Users/mike/dev/me/misc/.threadbear/patches/tools.ts' },
    ];
  }
  const hooked = threads.get('demo_build_scripts');
  if (hooked) {
    // A repo whose own Claude Code settings run a hook, not trusted yet:
    // the runner started Claude without them (claude-trust.ts).
    hooked.summary.patches = [
      { id: 'claude-settings', source: 'claude', file: '/Users/mike/dev/photo-sync/.claude/settings.json',
        untrusted: 'new', hash: 'c'.repeat(64), helpers: ['/Users/mike/dev/photo-sync/.claude/hooks/session-start.mjs'] },
    ];
  }
  const ios = threads.get('demo_button_colour');
  if (ios) {
    // A patch that came with a pull, not trusted yet: listed, not loaded.
    ios.summary.patches = [
      { id: 'xcode', source: 'builtin' },
      { id: 'convex', source: 'builtin' },
      { id: 'release', source: 'project', file: '/Users/mike/dev/walkies/.threadbear/patches/release.ts', folder: '/Users/mike/dev/walkies',
        untrusted: 'new', hash: 'a'.repeat(64) },
    ];
    waitingPatchGives.set('/Users/mike/dev/walkies/.threadbear/patches/release.ts', [
      { id: 'release.upload-build', title: 'Upload build', kind: 'command', command: './scripts/upload.sh', patch: 'release' },
    ]);
    ios.summary.panels = [
      { id: 'xcode.simulator', title: 'Simulator', kind: 'image', patch: 'xcode', note: 'Walkies' },
      { id: 'convex.dashboard', title: 'Convex', kind: 'url', patch: 'convex', url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page), note: 'walkies-dev (dev)' },
    ];
  }
}

// The landing pages thread works in a real folder under the data dir, so its
// highlights are files the app can preview: a mockup it pinned, a doc it
// wrote, a screenshot it opened. Its other threads' highlights are only
// listed (their folders are made up).
function addDemoHighlights() {
  const site = threads.get('demo_landing_pages');
  if (site) {
    const root = path.join(path.resolve(dataDir), 'work', 'site');
    const file = (rel, text) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (typeof text === 'string') fs.writeFileSync(full, text); else fs.copyFileSync(text.copy, full);
      return full;
    };
    const home = file('mockups/home.html', homeMockup());
    const pricing = file('mockups/pricing.html', homeMockup('Pricing'));
    const review = file('docs/copy-review.md', `# Copy review: home, pricing, docs

The new hero is shorter, and every page now leads with what the app does.

## Home
- Headline: "Your agents, on a desk you can see." Nine words, down from twenty.
- The three cards say what you get, not how it works.

## Pricing
- Plan names stay as they are.
- The prices are placeholders until Mike sends the real ones.

## Docs
- Search moves to the top of the page.
`);
    const before = file('screens/pricing-before.png', { copy: path.join(here, 'fixtures/demo-upload-resume/media/progress-before.png') });
    file('logs/docs-build.txt', 'Error: Could not resolve image /docs/hero.png\n  at src/pages/docs.astro:12\nBuild failed in 14.2s.\n');
    site.summary.cwd = root;
    const at = (seq) => site.events.find((e) => e.seq === seq)?.ts ?? iso();
    const h = (seq, fields) => ({ seq, lastSeq: seq, at: at(seq), ...fields });
    highlights.set(site.summary.id, {
      highlights: [
        h(9, { id: `file:${home}`, kind: 'file', title: 'home.html', path: home, how: 'pinned', show: true,
          note: 'The new hero with the three plan cards under it. Is the headline too long?' }),
        h(9, { id: 'pr:https://github.com/mikecann/site/pull/48', kind: 'pr', title: 'mikecann/site#48', url: 'https://github.com/mikecann/site/pull/48', how: 'created' }),
        // No branch: an agent's `git commit -q` then `git log --oneline -1`
        // prints none, which is most commits in real threads.
        h(8, { id: 'commit:4b7d0a8', kind: 'commit', title: 'Pricing cards from the new design', sha: '4b7d0a8', how: 'committed' }),
        h(7, { id: `file:${review}`, kind: 'file', title: 'copy-review.md', path: review, how: 'written' }),
        h(7, { id: `file:${pricing}`, kind: 'file', title: 'pricing.html', path: pricing, how: 'written' }),
        h(6, { id: 'link:http://localhost:4321/', kind: 'link', title: 'localhost:4321', url: 'http://localhost:4321/', how: 'opened' }),
        h(5, { id: 'commit:9f3c2e1', kind: 'commit', title: 'Rebuild the home page on the new hero', sha: '9f3c2e1', branch: 'landing-rebuild', pushed: true, how: 'committed' }),
        h(4, { id: `file:${before}`, kind: 'file', title: 'pricing-before.png', path: before, how: 'opened' }),
        h(3, { id: 'link:https://developer.apple.com/design/human-interface-guidelines/typography', kind: 'link', title: 'Typography',
          url: 'https://developer.apple.com/design/human-interface-guidelines/typography', how: 'mentioned' }),
      ],
      edited: ['src/components/PlanCard.astro', 'src/pages/pricing.astro', 'src/components/Hero.astro', 'src/pages/index.astro', 'src/styles/landing.css']
        .map((rel) => path.join(root, rel)),
      brief: { text: 'The home page is rebuilt and pushed. Pricing and docs are still with their sub-agents, and the plan prices are placeholders until Mike sends the real ones.', at: iso() },
    });
    // A list panel, as a project's patch with an `items` function gives one.
    site.summary.panels = [{
      id: 'deploys.previews', title: 'Previews', kind: 'list', icon: 'paperplane', patch: 'deploys', note: 'landing-rebuild',
      mockItems: [
        // Grouped under headings, with a date at the end of the line and a
        // sentence long enough to wrap onto its second line.
        { title: 'Home', detail: 'Ready, with the new hero, the three plan cards and the footer links all pointing at the rebuilt pages', url: 'https://site-git-landing-rebuild.vercel.app', icon: 'globe', tone: 'done', section: 'This branch', trailing: '4m' },
        { title: 'Pricing', detail: 'Waiting on the plan prices', url: 'https://site-git-landing-rebuild.vercel.app/pricing', icon: 'globe', tone: 'attention', section: 'This branch', trailing: '12m' },
        { title: 'Docs', detail: 'Build failed: no image at /docs/hero.png', path: path.join(root, 'logs/docs-build.txt'), icon: 'globe', tone: 'failed', section: 'This branch', trailing: '20m' },
        { title: 'Local', detail: 'astro dev on port 4321', url: 'http://localhost:4321/', icon: 'laptopcomputer', section: 'Elsewhere' },
        { title: 'Production', detail: 'main, deployed 2 days ago', url: 'https://example.com', icon: 'globe', section: 'Elsewhere', trailing: '2d' },
      ],
    }];
    site.summary.patches = [{ id: 'deploys', source: 'project', file: path.join(root, '.threadbear/patches/deploys.ts') }];
  }
  // The thread with open asks: Highlights lists them under Needs you.
  const beta = threads.get('demo_testflight_beta');
  if (beta) {
    const at = beta.events.at(-1)?.ts ?? iso();
    highlights.set(beta.summary.id, {
      highlights: [
        { id: 'link:https://appstoreconnect.apple.com/business', kind: 'link', title: 'App Store Connect', url: 'https://appstoreconnect.apple.com/business', how: 'mentioned', seq: beta.summary.lastSeq, lastSeq: beta.summary.lastSeq, at },
      ],
      edited: ['ios/App/Info.plist', 'ios/fastlane/Fastfile', 'ios/RELEASE_NOTES.md']
        .map((rel) => `/Users/mike/dev/me/app/${rel}`),
    });
  }
  // Threads Mike didn't start (docs/protocol.md, "Who started a thread").
  for (const [id, startedBy] of [
    ['demo_ci_slow', { kind: 'tool', label: 'Sentry', icon: 'ladybug', why: '1 event, 0 users' }],
    ['demo_settings_tabs', { kind: 'thread', label: 'Agent', threadId: 'demo_upload_resume', threadTitle: 'Uploads', why: 'fixing a hook it hit' }],
    ['demo_build_scripts', { kind: 'librarian', label: 'Librarian' }],
  ]) {
    const t = threads.get(id);
    if (t) t.summary.startedBy = startedBy;
  }
  const upload = threads.get('demo_upload_resume');
  if (upload) {
    const repo = upload.summary.cwd;
    const at = (seq) => upload.events.find((e) => e.seq === seq)?.ts ?? iso();
    const h = (seq, fields) => ({ seq, lastSeq: seq, at: at(seq), ...fields });
    highlights.set(upload.summary.id, {
      highlights: [
        h(20, { id: `file:${repo}/docs/resume-design.md`, kind: 'file', title: 'resume-design.md', path: `${repo}/docs/resume-design.md`, how: 'written' }),
        h(12, { id: 'link:https://developer.apple.com/documentation/foundation/urlsession', kind: 'link', title: 'URLSession', url: 'https://developer.apple.com/documentation/foundation/urlsession', how: 'mentioned' }),
      ],
      edited: [`${repo}/Sources/Upload/UploadTask.swift`, `${repo}/Sources/Upload/ChunkStore.swift`, `${repo}/Tests/UploadTests/ResumeTests.swift`],
    });
  }
}

/// A landing page mockup, light and dark, as an agent might write one.
function homeMockup(page = 'Home') {
  return `<!doctype html><meta charset="utf-8"><title>${page} mockup</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6d6a64;--card:#fff;--line:#e8e5de;--accent:#c46a2b}
@media (prefers-color-scheme: dark){:root{--bg:#1c1b1a;--fg:#ecebe8;--muted:#9c988f;--card:#252422;--line:#34322f;--accent:#e08a4a}}
body{margin:0;font:15px/1.5 -apple-system,system-ui;background:var(--bg);color:var(--fg)}
nav{display:flex;gap:18px;padding:16px 28px;font-size:13px;color:var(--muted)}nav b{color:var(--fg);margin-right:auto}
header{padding:36px 28px 24px}h1{font-size:30px;line-height:1.15;margin:0 0 10px;letter-spacing:-.01em}
header p{color:var(--muted);margin:0 0 18px;max-width:30em}
.cta{display:inline-block;background:var(--accent);color:#fff;border-radius:8px;padding:8px 14px;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:8px 28px 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.card h3{margin:0 0 4px;font-size:14px}
.card p{margin:0;color:var(--muted);font-size:13px}
</style>
<nav><b>Threadbear</b><span>${page === 'Home' ? 'Pricing' : 'Home'}</span><span>Docs</span></nav>
<header><h1>Your agents, on a desk you can see.</h1>
<p>Every thread, what it made and what it needs from you, in one quiet window.</p><span class="cta">Download for Mac</span></header>
<section class="cards">
<div class="card"><h3>Threads</h3><p>Claude and Codex side by side, on any of your accounts.</p></div>
<div class="card"><h3>Highlights</h3><p>Files, links and commits stay put while the transcript scrolls.</p></div>
<div class="card"><h3>Patches</h3><p>Buttons and panels your project gives its threads.</p></div>
</section>`;
}

// Like the real runner's askedLine, roughly: the sidebar's "You: ..." is
// Mike's own messages only (a review's reply goes in whole here).
function askedLine(e) {
  if (e.type !== 'user.message' || (e.origin && e.origin !== 'phone') || e.text.startsWith('[Sent by the agent')) return undefined;
  return e.text.replace(/\s+/g, ' ').trim().slice(0, 140) || undefined;
}

function loadFixtures() {
  for (const root of fixtureDirs) {
    if (!fs.existsSync(root)) continue;
    const loaded = [];
    // A folder of fixtures, or one fixture itself (what `tb export` prints).
    const names = fs.existsSync(path.join(root, 'thread.json')) ? ['.'] : fs.readdirSync(root).sort();
    for (const name of names) {
      const dir = path.join(root, name);
      const threadFile = path.join(dir, 'thread.json');
      const eventsFile = path.join(dir, 'events.ndjson');
      if (!fs.existsSync(threadFile) || !fs.existsSync(eventsFile)) continue;
      const summary = JSON.parse(fs.readFileSync(threadFile, 'utf8'));
      // Media paths in fixtures are relative to the fixture folder.
      const fixPaths = (images) => (images ?? []).map((img) => ({ ...img, path: path.isAbsolute(img.path) ? img.path : path.join(dir, img.path) }));
      const events = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => {
        const event = JSON.parse(line);
        event.threadId = summary.id;
        if (event.images) event.images = fixPaths(event.images);
        if (event.type === 'review.updated') event.review.options = event.review.options.map((option) => ({ ...option, image: fixPaths([option.image])[0] }));
        return event;
      });
      summary.lastSeq = events.at(-1)?.seq ?? 0;
      summary.lastSeenSeq ??= summary.lastSeq;
      // As the real runner learns it for a thread from before it.
      summary.asked ??= events.map(askedLine).findLast(Boolean);
      const reviews = new Map();
      for (const event of events) if (event.type === 'review.updated') reviews.set(event.review.id, event.review);
      const buttons = new Map();
      for (const event of events) if (event.type === 'button.updated') buttons.set(event.button.id, event.button);
      const t = { summary, events, reviews, buttons, inProgress: new Map(), timers: [], dir };
      updateReviewCount(t);
      loaded.push(t);
    }
    // Real paths: /tmp is /private/tmp, and dev-app.sh passes the one,
    // the module's own path is the other.
    if (fs.realpathSync(root) === fs.realpathSync(path.join(here, 'fixtures'))) shiftToNow(loaded);
    for (const t of loaded) {
      const { summary, events } = t;
      // A fixture caught mid-turn: start its clock a few seconds ago, so the
      // app's "Working for" line reads like a live turn whenever it's run.
      if (summary.status === 'running') {
        const started = events.findLast((e) => e.type === 'turn.started');
        if (started) {
          started.ts = new Date(Date.now() - 14_000).toISOString();
          summary.lastActivityAt = started.ts;
        }
      }
      // Keep a fixture's waiting or running status so the sidebar has
      // something in every section; tb export makes real ones idle.
      summary.status ??= 'idle';
      summary.live = false;
      threads.set(summary.id, t);
    }
  }
}

function addFillers(count) {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = `th_filler_${i}`;
    const ts = new Date(now - (i + 5) * 3_600_000).toISOString();
    const summary = {
      id, title: `Filler thread ${i + 1}`, cwd: defaults.cwd, accountId: 'claude-main', provider: 'claude',
      permissionMode: 'full', status: 'idle', live: false, needsYou: false, createdAt: ts, updatedAt: ts, lastActivityAt: ts,
      preview: 'A short synthetic thread for memory tests.', lastSeq: 0, lastSeenSeq: 0,
    };
    const events = [];
    let seq = 0;
    const push = (fields) => events.push({ seq: ++seq, ts, threadId: id, turnId: `t${Math.floor(seq / 12)}`, ...fields });
    for (let turn = 0; turn < 40; turn++) {
      push({ type: 'user.message', text: `Question ${turn + 1}: can you check the build log for warnings?`, images: [] });
      push({ type: 'tool.call', itemId: `c${turn}`, name: 'Bash', kind: 'command', title: 'swift build 2>&1 | grep warning', input: { command: 'swift build' } });
      push({ type: 'tool.result', itemId: `c${turn}`, ok: true, text: 'warning: unused variable `x`\n'.repeat(20), truncated: false, images: [] });
      push({ type: 'assistant.text', itemId: `m${turn}`, text: `There are **20 warnings**, all the same unused variable. Here's the fix:\n\n\`\`\`swift\n_ = compute()\n\`\`\`\n\nWant me to apply it?` });
      push({ type: 'turn.completed', turnId: `t${turn}`, outcome: 'completed', durationMs: 4200 + turn, costUsd: 0.01 });
    }
    summary.lastSeq = seq;
    summary.lastSeenSeq = seq;
    threads.set(id, { summary, events, inProgress: new Map(), timers: [] });
  }
}

// ---------------------------------------------------------------- helpers

function need(threadId) {
  const t = threads.get(threadId);
  if (!t) throw rpcError(-32004, 'Thread not found');
  return t;
}

function newestFirst(list) {
  return [...list].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

function reply(client, id, result, error) {
  if (client.ws.readyState !== 1) return;
  client.ws.send(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }));
}

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Now, or `offset` ms from now.
function iso(offset = 0) {
  return new Date(Date.now() + offset).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mediaType(ext) {
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] ?? 'image/png';
}

function imageSize(file) {
  const b = fs.readFileSync(file).subarray(0, 64 * 1024);
  if (b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const length = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + length;
    }
  }
  return {};
}

function parseArgs(argv) {
  const out = { fixtures: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? (i++, next) : true;
    if (key === 'fixtures') out.fixtures.push(value);
    else out[key] = value;
  }
  return out;
}

function log(message) {
  if (!quiet) console.log(`mock-runner: ${message}`);
}

if (typeof args['exit-with-pid-file'] === 'string') watchOwner(args['exit-with-pid-file']);

function watchOwner(file) {
  // A missing file is allowed for a while: the app isn't started yet, or
  // dev-app.sh rebuild is between quitting it and starting the new build.
  let missingSince = Date.now();
  const timer = setInterval(() => {
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch {
      if (!fs.existsSync(path.dirname(file)) || Date.now() - missingSince > 120_000) stop('its pid file is gone');
      return;
    }
    missingSince = Date.now();
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
    } catch (e) {
      // EPERM means it's there but not ours to signal.
      if (e.code === 'ESRCH') stop(`the app (pid ${pid}) quit`);
    }
  }, 2000);
  timer.unref();
  function stop(why) {
    log(`exiting: ${why}`);
    wss.close();
    process.exit(0);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close();
    process.exit(0);
  });
}
