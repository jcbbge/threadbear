// The Convex mirror against a real deployment: the repo's local one, named
// in .env.e2e at the repo root (gitignored; `npx convex deployment create
// mikec:threadbear:local --select` writes .env.local, which is then copied
// to .env.e2e so the Sydney dev deployment can stay selected for everyday
// work). Every convex command here passes `--env-file .env.e2e`, so
// nothing touches the Sydney project. Starts `npx convex dev` for the local
// backend, points a runner at it with its own key, and reads back what it
// wrote through the deployment's HTTP API and the phone's queries. No CLI
// is spawned (claudePath points nowhere) so it costs nothing. Skips
// without .env.e2e.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { RunnerClient } from '../../src/client.ts';
import { readRunnerJson } from '../../src/config.ts';
import { BACKEND_API_VERSION } from '../../src/sync.ts';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');
const REPO = path.join(RUNNER_DIR, '..');
const ENV_FILE = path.join(REPO, '.env.e2e');
const ENV_ARGS = ['--env-file', ENV_FILE];
const run = promisify(execFile);

function readEnvLocal(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const envLocal = readEnvLocal();
const CONVEX_URL = envLocal.CONVEX_URL;
const LOCAL = Boolean(CONVEX_URL && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(CONVEX_URL));

describe('convex mirror e2e', { skip: LOCAL ? false : 'no local Convex deployment in .env.e2e at the repo root' }, () => {
  let convexDev: ChildProcess;
  let convexOut = '';
  let runner: ChildProcess;
  let runnerOut = '';
  let client: RunnerClient;
  let home: string;
  const key = 'e2e-' + crypto.randomBytes(8).toString('hex');
  // `convex dev --env-file` still rewrites .env.local to the deployment it
  // ran against, which would leave the repo pointed at the local one.
  const envLocalPath = path.join(REPO, '.env.local');
  const envLocalBefore = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf8') : undefined;

  const api = async (kind: 'query' | 'mutation', fn: string, args: Record<string, unknown>): Promise<any> => {
    const res = await fetch(`${CONVEX_URL}/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: fn, args, format: 'json' }) });
    const body = (await res.json()) as { status: string; value?: unknown; errorMessage?: string };
    if (body.status !== 'success') throw new Error(body.errorMessage ?? `HTTP ${res.status}`);
    return body.value;
  };
  const until = async <T,>(what: string, fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => undefined);
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  before(async () => {
    // The local backend, with the functions pushed to it.
    convexDev = spawn('npx', ['convex', 'dev', ...ENV_ARGS, '--tail-logs', 'disable', '--typecheck', 'disable'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    convexDev.stdout!.on('data', (d) => (convexOut += d));
    convexDev.stderr!.on('data', (d) => (convexOut += d));
    await until('convex dev to be ready', async () => (/Convex functions ready/.test(convexOut) ? true : undefined), 180_000).catch((e) => {
      throw new Error(`${e.message}\n${convexOut}`);
    });
    await run('npx', ['convex', 'env', 'set', ...ENV_ARGS, 'RUNNER_KEY', key], { cwd: REPO });

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sync-e2e-'));
    fs.mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'secrets', 'convex-key'), key + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sync: { name: 'E2E Mac' } }));
    // A fake claude-main login, so a thread can be made; its turn fails at
    // once because claudePath points nowhere, which is all this needs.
    fs.mkdirSync(path.join(home, 'fake-main'), { recursive: true });
    fs.writeFileSync(path.join(home, 'fake-main.json'), JSON.stringify({ oauthAccount: { emailAddress: 'e2e@example.com' } }));
    const env = { ...process.env };
    delete env.THREADBEAR_SYNC; // check.sh sets it off for every other test
    runner = spawn(process.execPath, ['src/main.ts'], {
      cwd: RUNNER_DIR,
      env: {
        ...env,
        THREADBEAR_HOME: home,
        THREADBEAR_PORT: '0',
        THREADBEAR_LOG: path.join(home, 'runner.log'),
        THREADBEAR_CLAUDE_PATH: '/nonexistent/claude',
        THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
        THREADBEAR_CLAUDE_MAIN_DIR: path.join(home, 'fake-main'),
        THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'fake-main.json'),
        THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex-main'),
        THREADBEAR_TOKEN_STATS_LIMITS: path.join(home, 'no-limits.json'),
        THREADBEAR_CLI_UPDATES: 'off', THREADBEAR_TOKEN_TALLY: 'off',
        THREADBEAR_SYNC_URL: CONVEX_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runner.stdout!.on('data', (d) => (runnerOut += d));
    runner.stderr!.on('data', (d) => (runnerOut += d));
    const port = await until('the runner to listen', async () => {
      const m = /listening on (\d+)/.exec(runnerOut);
      return m ? Number(m[1]) : undefined;
    }, 30_000);
    const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
    client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
    await client.call('hello', { client: 'sync-e2e', version: '1' });
  });

  after(async () => {
    client?.close();
    if (runner && runner.exitCode === null) {
      const exited = new Promise((r) => runner.once('exit', r));
      runner.kill('SIGTERM');
      await exited;
    }
    if (convexDev?.pid && convexDev.exitCode === null) {
      // The CLI and the local backend it started.
      try {
        process.kill(-convexDev.pid, 'SIGTERM');
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (envLocalBefore !== undefined) fs.writeFileSync(envLocalPath, envLocalBefore);
    else if (fs.existsSync(envLocalPath)) fs.rmSync(envLocalPath);
  });

  // Step 6 (docs/protocol.md, Schedules, "Runners"): with an API 9 backend
  // the runner moves its schedules into the table, makes them there, takes
  // each due run with a claim, runs what another runner asked for, and can
  // put one on another runner (here a pretend "bruce" that only heartbeats).
  test('schedules live in the backend: made there, claimed when due, run on request, made for another runner', async () => {
    const runnerId = readRunnerJson(home).sync?.runnerId;
    const owned = async () => (await api('query', 'sync:schedules', { key })) as any[];
    const row = (id: string) => owned().then((rows) => rows.find((r) => r.id === id));

    // Made through the runner once it has attached (the first heartbeat).
    const daily = await until('the scheduler to attach', async () => {
      try {
        return ((await client.call('schedules.create', { text: 'Daily check', cron: '0 9 * * *', cwd: home, accountId: 'claude-main' })) as any).schedule;
      } catch {
        return undefined;
      }
    });
    const saved = await until('the row', () => row(daily.id));
    assert.equal(saved.runnerId, runnerId);
    assert.equal(saved.whenText, 'Every day at 9:00');
    assert.equal(saved.cwd, home);
    // Made before the first heartbeat it was the file's, and moved up; either
    // way it's listed with this runner's name now.
    const listed = await until('the runner name', async () => {
      const l = ((await client.call('schedules.list')) as any).schedules.find((x: any) => x.id === daily.id);
      return l?.runnerName ? l : undefined;
    });
    assert.equal(listed.runnerName, 'E2E Mac');

    // Another runner, as the backend knows it.
    await api('mutation', 'sync:heartbeat', { key, runner: { runnerId: 'e2e-bruce', name: 'bruce', version: 'x', startedAt: new Date().toISOString(), draining: false, threadCount: 0 } });
    // The local deployment keeps the runners of earlier runs (said goodbye,
    // so not offered); this one is first.
    const runners = ((await client.call('runners.list')) as any).runners;
    assert.deepEqual([runners[0].name, runners[0].self], ['E2E Mac', true]);
    assert.ok(runners.some((r: any) => r.id === 'e2e-bruce' && r.name === 'bruce' && r.online && !r.self), JSON.stringify(runners));
    const away = ((await client.call('schedules.create', { text: 'On Bruce', cron: '@hourly', runnerId: 'bruce' })) as any).schedule;
    assert.equal(away.runnerId, 'e2e-bruce');
    assert.equal(away.runnerName, 'bruce');
    assert.equal((await until('bruce\'s row', () => row(away.id))).cwd, undefined, "bruce's default folder");
    // Run now on bruce's: asked for, not run here.
    const asked = (await client.call('schedules.run', { scheduleId: away.id })) as any;
    assert.equal(asked.queued, true);
    assert.ok((await row(away.id)).runRequestedAt);

    // Due: an `at` already passed runs straight away, once.
    const once = ((await client.call('schedules.create', { text: 'Now please', at: new Date(Date.now() - 60_000).toISOString(), cwd: home, accountId: 'claude-main' })) as any).schedule;
    const ran = await until('the due run', async () => {
      const r = await row(once.id);
      return r?.finishedAt ? r : undefined;
    });
    assert.equal(ran.runs, 1);
    assert.equal(ran.lastRun.outcome, 'sent');
    assert.equal(ran.nextRunAt, undefined);

    // A run another runner asked for on ours: this runner sends it.
    await api('mutation', 'sync:requestScheduleRun', { key, scheduleId: daily.id, at: new Date().toISOString() });
    const requested = await until('the requested run', async () => {
      const r = await row(daily.id);
      return r?.runs === 1 && !r.runRequestedAt ? r : undefined;
    });
    assert.equal(requested.nextRunAt, saved.nextRunAt, 'a run now keeps the next time');
    const started = ((await client.call('threads.list', { include: ['inbox'] })) as any).threads.filter((t: any) => t.schedule?.id === daily.id || t.schedule?.id === once.id);
    assert.equal(started.length, 2, 'one thread each');

    // Delete goes to the backend.
    for (const sc of [daily, away, once]) await client.call('schedules.delete', { scheduleId: sc.id });
    await until('the rows to go', async () => ((await owned()).some((r) => [daily.id, away.id, once.id].includes(r.id)) ? undefined : true));
    for (const t of started) await client.call('threads.delete', { threadId: t.id });
    const saidOnDisk = JSON.parse(fs.readFileSync(path.join(home, 'schedules.json'), 'utf8'));
    assert.equal(saidOnDisk.version, 2, 'the file is the backend copy');
    // Bruce goes, so the phone's main runner online is this one again.
    await api('mutation', 'sync:bye', { key, runnerId: 'e2e-bruce' });
  });

  // Step 6 part 2 (docs/protocol.md, "Other runners' threads"): the runner
  // writes its sidebar rows, and hands the app another runner's rows (here a
  // pretend "e2e-other" that only heartbeats and writes its index).
  test('API 45: the sidebar\'s schedule rows, figures only while watched, and schedule commands', async () => {
    const issued = await run('npx', ['convex', 'run', ...ENV_ARGS, 'tokens:issue', JSON.stringify({ name: 'web-e2e-45', days: 1 })], { cwd: REPO });
    const token = JSON.parse(issued.stdout.slice(issued.stdout.indexOf('{'))).token as string;
    const phone = { token };
    const beat = (runnerId: string, more: Record<string, unknown> = {}) => api('mutation', 'sync:heartbeat', { key, runner: { runnerId, name: runnerId, version: '1', startedAt: new Date().toISOString(), draining: false, threadCount: 0, ...more } });
    const save = (id: string, more: Record<string, unknown> = {}) =>
      api('mutation', 'sync:saveSchedule', { key, schedule: { id, runnerId: 'e2e-45', title: id, text: 'a long message', whenText: 'soon', paused: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runs: 0, nextRunAt: '2030-01-01T00:00:00.000Z', threadId: `thread-${id}`, ...more } });
    const wakes = async () => ((await api('query', 'phone:wakes', phone)) as { scheduleId: string; nextRunAt?: string }[]).filter((w) => w.scheduleId.startsWith('e2e45'));

    // A schedule from before the table comes in on its runner's first heartbeat.
    await save('e2e45-old');
    await beat('e2e-45');
    assert.deepEqual((await wakes()).map((w) => w.scheduleId), ['e2e45-old']);

    // Pausing drops its row, resuming brings it back, deleting drops it for good.
    await save('e2e45-old', { paused: true });
    assert.deepEqual(await wakes(), []);
    await save('e2e45-old');
    assert.equal((await wakes()).length, 1);
    await api('mutation', 'sync:deleteSchedule', { key, scheduleId: 'e2e45-old' });
    assert.deepEqual(await wakes(), []);

    // A run moves its next time; a claim doesn't touch the row.
    await save('e2e45-run');
    const before = (await wakes())[0];
    assert.equal(await api('mutation', 'sync:claimSchedule', { key, runnerId: 'e2e-45', scheduleId: 'e2e45-run', holder: 'h', kind: 'request', expect: 'never' }), false);
    await api('mutation', 'sync:scheduleRan', { key, scheduleId: 'e2e45-run', holder: 'h', lastRun: { at: new Date().toISOString(), outcome: 'sent' }, sent: true, expectUpdatedAt: 'not this one' });
    assert.deepEqual((await wakes())[0], before, 'changed underneath: the time it worked out stands');
    const row = ((await api('query', 'phone:schedules', phone)) as { id: string; updatedAt: string }[]).find((x) => x.id === 'e2e45-run')!;
    await api('mutation', 'sync:scheduleRan', { key, scheduleId: 'e2e45-run', holder: 'h', lastRun: { at: new Date().toISOString(), outcome: 'sent' }, sent: true, expectUpdatedAt: row.updatedAt, nextRunAt: '2031-01-01T00:00:00.000Z' });
    assert.equal((await wakes())[0]!.nextRunAt, '2031-01-01T00:00:00.000Z');
    await api('mutation', 'sync:scheduleRan', { key, scheduleId: 'e2e45-run', holder: 'h', lastRun: { at: new Date().toISOString(), outcome: 'sent' }, sent: true, expectUpdatedAt: row.updatedAt, finishedAt: new Date().toISOString() });
    assert.deepEqual(await wakes(), [], 'finished');

    // A schedule command goes to the schedule's own runner.
    await save('e2e45-cmd');
    const commandId = await api('mutation', 'phone:schedule', { ...phone, scheduleId: 'e2e45-cmd', action: 'pause' });
    assert.ok(commandId);
    await assert.rejects(api('mutation', 'phone:schedule', { ...phone, scheduleId: 'nope', action: 'pause' }));
    await api('mutation', 'sync:deleteSchedule', { key, scheduleId: 'e2e45-cmd' });

    // Figures: the watch row, a report, and pressure on the runner's row.
    await api('mutation', 'phone:watchRunners', phone);
    const watch = await api('query', 'sync:runnerWatch', { key });
    assert.ok(watch.until > Date.now());
    await api('mutation', 'sync:setRunnerStats', { key, runnerId: 'e2e-45', stats: { cpuPercent: 12, cores: 8, memUsed: 1, memTotal: 2, diskFree: 3, diskTotal: 4, uptimeSec: 5, machine: 'Apple M5', os: 'macOS 27.2' } });
    await api('mutation', 'sync:setRunnerStats', { key, runnerId: 'e2e-45', stats: { cpuPercent: 40, cores: 8, memUsed: 1, memTotal: 2, diskFree: 3, diskTotal: 4, uptimeSec: 5 } });
    const stats = ((await api('query', 'phone:runnerStats', phone)) as { runnerId: string; cpuPercent: number; at: string }[]).filter((x) => x.runnerId === 'e2e-45');
    assert.equal(stats.length, 1, 'one row per runner');
    assert.equal(stats[0]!.cpuPercent, 40);
    await beat('e2e-45', { pressure: 'memory' });
    const listed = () => api('query', 'phone:runners', phone).then((rows: { runnerId: string; pressure?: string; startedAt?: string }[]) => rows.find((x) => x.runnerId === 'e2e-45')!);
    assert.equal((await listed()).pressure, 'memory');
    assert.ok((await listed()).startedAt);
    await beat('e2e-45');
    assert.equal((await listed()).pressure, undefined, 'cleared when it recovers');

    // A runner key reports for its own runner only, and sees the watch.
    const made = await api('mutation', 'sync:addRunnerKey', { key, runnerId: 'e2e-45-keyed', name: 'e2e-45-keyed', ownerRunnerId: 'e2e-45', replace: true });
    const runnerKey = (made as { key: string }).key;
    const figures = { cpuPercent: 1, cores: 1, memUsed: 1, memTotal: 2, diskFree: 1, diskTotal: 2, uptimeSec: 1 };
    await api('mutation', 'sync:setRunnerStats', { key: runnerKey, runnerId: 'e2e-45-keyed', stats: { ...figures, os: 'x'.repeat(500) } });
    const keyed = ((await api('query', 'phone:runnerStats', phone)) as { runnerId: string; os?: string }[]).find((x) => x.runnerId === 'e2e-45-keyed')!;
    assert.ok(keyed.os!.length <= 128, 'its labels are cut to fit');
    await assert.rejects(api('mutation', 'sync:setRunnerStats', { key: runnerKey, runnerId: 'e2e-45', stats: figures }));
    assert.equal(((await api('query', 'phone:runnerStats', phone)) as { runnerId: string; cpuPercent: number }[]).find((x) => x.runnerId === 'e2e-45')!.cpuPercent, 40, 'another runner\'s row is untouched');
    assert.ok((await api('query', 'sync:runnerWatch', { key: runnerKey }))?.until);

    // The real runner in this test reports too, while it's watched.
    await until('this runner\'s own figures', async () => {
      const mine = ((await api('query', 'phone:runnerStats', phone)) as { runnerId: string; memTotal: number }[]).filter((x) => x.runnerId !== 'e2e-45');
      return mine.find((x) => x.memTotal > 0);
    }, 90_000);
    await run('npx', ['convex', 'run', ...ENV_ARGS, 'tokens:revoke', JSON.stringify({ name: 'web-e2e-45' })], { cwd: REPO });
  });

  test('API 37: one account at a time, firstSeen, and a thread row without its messages', async () => {
    // Its own each run: the local deployment keeps its rows between runs.
    const runnerId = 'e2e-accounts-' + crypto.randomBytes(4).toString('hex');
    const beat = (r: string) => api('mutation', 'sync:heartbeat', { key, runner: { runnerId: r, name: r, version: 'x', startedAt: 'x', draining: false, threadCount: 0 } });
    assert.deepEqual(await beat(runnerId), { apiVersion: BACKEND_API_VERSION, firstSeen: true });
    assert.deepEqual(await beat(runnerId), { apiVersion: BACKEND_API_VERSION });

    const acct = (id: string, title: string) => ({ id, provider: 'claude', title, usage: { windows: [{ kind: 'week', title: 'Week', remainingPercent: 40 }], readAt: '2026-11-05T00:00:00Z', source: 'x' } });
    const { token } = await api('mutation', 'sync:issueToken', { key, kind: 'browser', name: 'e2e-37' });
    const mine = async () => ((await api('query', 'phone:accounts', { token })) as { id: string; title: string; runnerId: string }[]).filter((a) => a.runnerId === runnerId).map((a) => `${a.id}:${a.title}`).sort();
    await api('mutation', 'sync:setAccounts', { key, runnerId, accounts: [acct('a', 'A'), acct('b', 'B')] });
    await api('mutation', 'sync:upsertAccounts', { key, runnerId, accounts: [acct('a', 'A2'), acct('c', 'C')], removed: ['b', 'never-there'] });
    assert.deepEqual(await mine(), ['a:A2', 'c:C']);

    const threadId = 'e2e-row-' + crypto.randomBytes(4).toString('hex');
    const doc = { threadId, runnerId, title: 'Row', cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: 'p', createdAt: 'x', lastActivityAt: 'x', lastActivityMs: 1, view: 'inbox' };
    await api('mutation', 'sync:upsertThreads', { key, threads: [doc] });
    assert.deepEqual(await api('query', 'phone:threadRow', { token, threadId }), doc);
    await api('mutation', 'sync:removeThreads', { key, threadIds: [threadId] });
    await assert.rejects(api('query', 'phone:threadRow', { token, threadId }));
    // API 43: a list once, then only what changed.
    const a = 'e2e-a-' + crypto.randomBytes(4).toString('hex');
    const b = 'e2e-b-' + crypto.randomBytes(4).toString('hex');
    const start = await api('query', 'phone:threadsAt', { token, view: 'inbox' });
    assert.equal(typeof start.at, 'number');
    await api('mutation', 'sync:upsertThreads', { key, threads: [{ ...doc, threadId: a }, { ...doc, threadId: b }] });
    const since = start.at - 5000;
    const heard = await api('query', 'phone:threadsSince', { token, since });
    const ids = heard.rows.map((r: { threadId: string }) => r.threadId);
    assert.ok(ids.includes(a) && ids.includes(b), JSON.stringify(ids));
    assert.equal(typeof heard.rows.find((r: { threadId: string }) => r.threadId === a).updatedMs, 'number');
    const later = Math.max(...heard.rows.map((r: { updatedMs: number }) => r.updatedMs)) + 1;
    assert.deepEqual((await api('query', 'phone:threadsSince', { token, since: later })).rows, []);
    await api('mutation', 'sync:upsertThreads', { key, threads: [{ ...doc, threadId: a, view: 'den' }] });
    await api('mutation', 'sync:removeThreads', { key, threadIds: [b] });
    const moved = await api('query', 'phone:threadsSince', { token, since: later });
    assert.equal(moved.rows.find((r: { threadId: string }) => r.threadId === a)?.view, 'den');
    assert.ok(moved.gone.includes(b));
    // Removed and made again: the row's what's true, whatever order they came in.
    await api('mutation', 'sync:upsertThreads', { key, threads: [{ ...doc, threadId: b }] });
    const back = await api('query', 'phone:threadsSince', { token, since: later });
    assert.ok(back.rows.some((r: { threadId: string }) => r.threadId === b));
    assert.equal(back.gone.includes(b), false);
    await api('mutation', 'sync:removeThreads', { key, threadIds: [b] });
    // From further back than deletions are kept: load the list again.
    assert.equal((await api('query', 'phone:threadsSince', { token, since: start.at - 24 * 60 * 60_000 })).more, true);
    // The runner's own read of its rows still passes its validator.
    await api('query', 'sync:threadsOf', { key, runnerId });
    await api('mutation', 'sync:removeThreads', { key, threadIds: [a] });

    // Offline again, or the phone's next new thread could pick this runner.
    await api('mutation', 'sync:bye', { key, runnerId });
  });

  test('API 48: the project list is small rows, one project is whole, and search reaches goals and state', async () => {
    const runnerId = 'e2e-heads-' + crypto.randomBytes(4).toString('hex');
    const pid = 'e2e-head-' + crypto.randomBytes(4).toString('hex');
    const word = 'zq' + crypto.randomBytes(5).toString('hex');
    const secret = `sk-${'e2e3'.repeat(12)}`;
    await api('mutation', 'sync:heartbeat', { key, runner: { runnerId, name: runnerId, version: 'x', startedAt: 'x', draining: false, threadCount: 0 } });
    const { token } = (await api('mutation', 'sync:issueToken', { key, kind: 'browser', name: 'e2e-48' })) as { token: string };
    const doc = { id: pid, title: `Title ${secret}`, folders: ['/x'], goals: `the ${word} goal`, state: 'going', notes: 'long notes', createdBy: 'user', archived: false, createdAt: 'x', updatedAt: 'x', threadCount: 0 };
    await api('mutation', 'sync:setProjects', { key, runnerId, projects: [doc] });
    type Row = { runnerId: string; id: string; title: string; goals: string; notes: string };
    const listed = ((await api('query', 'phone:projects', { token })) as Row[]).find((p) => p.id === pid)!;
    assert.equal(listed.title, 'Title [REDACTED]', 'the small row has the scrubbed title');
    assert.equal(listed.goals, '');
    assert.equal(listed.notes, '');
    const whole = (await api('query', 'phone:project', { token, runnerId, id: pid })) as Row;
    assert.equal(whole.goals, `the ${word} goal`);
    assert.equal(whole.notes, 'long notes');
    assert.deepEqual(await api('query', 'phone:projectSearch', { token, text: word.toUpperCase() }), [{ runnerId, id: pid }]);
    assert.deepEqual(await api('query', 'phone:projectSearch', { token, text: 'no-project-says-this' }), []);
    // A row from before the rules: rewriting it takes the list's copy of the title too.
    const old = path.join(home, 'old-project.jsonl');
    const oldId = pid + '-old';
    fs.writeFileSync(old, JSON.stringify({ ...doc, id: oldId, runnerId }) + '\n');
    await run('npx', ['convex', 'import', ...ENV_ARGS, '--append', '--yes', '--table', 'projects', old], { cwd: REPO });
    fs.writeFileSync(old, JSON.stringify({ runnerId, id: oldId, title: doc.title, createdBy: 'user', archived: false, createdAt: 'x', updatedAt: 'x', threadCount: 0 }) + '\n');
    await run('npx', ['convex', 'import', ...ENV_ARGS, '--append', '--yes', '--table', 'projectHeads', old], { cwd: REPO });
    const oldTitle = async () => ((await api('query', 'phone:projects', { token })) as Row[]).find((p) => p.id === oldId)!.title;
    assert.ok((await oldTitle()).includes(secret));
    const script: string = '../../scripts/scrub-stored.mjs';
    const { scrubStored } = await import(script);
    await scrubStored({ post: (fn: string, args: Record<string, unknown>) => api('mutation', fn, args), key, tables: ['projects'], apply: true, batch: 50 });
    assert.equal(await oldTitle(), 'Title [REDACTED]', 'the head follows when only `projects` is rewritten');
    await api('mutation', 'sync:setProjects', { key, runnerId, projects: [] });
    assert.ok(!((await api('query', 'phone:projects', { token })) as Row[]).some((p) => p.id === pid), 'its small row goes with it');
    await api('mutation', 'sync:bye', { key, runnerId });
  });

  test('API 40: a project lists its threads newest first, archived ones too, and follows moves and deletes', async () => {
    const runnerId = 'e2e-links-' + crypto.randomBytes(4).toString('hex');
    const pid = 'e2e-proj-' + crypto.randomBytes(4).toString('hex');
    const other = pid + '-other';
    const { token } = await api('mutation', 'sync:issueToken', { key, kind: 'browser', name: 'e2e-40' });
    const doc = (n: number, view: string, projects: string[]) => ({
      threadId: `${runnerId}-t${n}`, runnerId, title: `T${n}`, cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: 'p',
      createdAt: 'x', lastActivityAt: 'x', lastActivityMs: n, view, projects: projects.map((id) => ({ id, title: id })),
    });
    const titles = async (projectId: string, limit?: number) =>
      ((await api('query', 'phone:projectThreads', { token, projectId, ...(limit ? { limit } : {}) })) as { title: string; view: string }[]).map((t) => `${t.title}:${t.view}`);
    await api('mutation', 'sync:upsertThreads', { key, threads: [doc(1, 'den', [pid]), doc(2, 'inbox', [pid, other]), doc(3, 'hibernating', [pid]), doc(4, 'inbox', [])] });
    assert.deepEqual(await titles(pid), ['T3:hibernating', 'T2:inbox', 'T1:den']);
    assert.deepEqual(await titles(other), ['T2:inbox']);
    assert.deepEqual(await titles(pid, 2), ['T3:hibernating', 'T2:inbox']);
    // A turn moves T1 to the top; T2 leaves the project; T3 is deleted.
    await api('mutation', 'sync:upsertThreads', { key, threads: [{ ...doc(1, 'inbox', [pid]), lastActivityMs: 10 }, doc(2, 'inbox', [other])] });
    await api('mutation', 'sync:removeThreads', { key, threadIds: [`${runnerId}-t3`] });
    assert.deepEqual(await titles(pid), ['T1:inbox']);
    // A prune drops the links of the threads it deletes.
    await api('mutation', 'sync:prune', { key, runnerId, keep: [`${runnerId}-t1`, `${runnerId}-t4`] });
    assert.deepEqual(await titles(other), []);
    // The backfill relinks what's there without doubling anything.
    await api('mutation', 'sync:heartbeat', { key, runner: { runnerId, name: runnerId, version: 'x', startedAt: 'x', draining: false, threadCount: 0 } });
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(await titles(pid), ['T1:inbox']);
    await assert.rejects(api('query', 'phone:projectThreads', { token: 'tb_wrong', projectId: pid }), /auth|token/);
    await api('mutation', 'sync:removeThreads', { key, threadIds: [`${runnerId}-t1`, `${runnerId}-t4`] });
    await api('mutation', 'sync:bye', { key, runnerId });
  });

  test('the sidebar table: this runner\'s rows go up, another runner\'s come back as remoteThreads', async () => {
    const runnerId = readRunnerJson(home).sync?.runnerId;
    const { thread } = (await client.call('threads.create', { text: 'index me', cwd: home, accountId: 'claude-main' })) as any;
    const mine = await until('this runner\'s index row', async () => {
      const r = (await api('query', 'sync:otherRunnersThreads', { key, runnerId: 'someone-else' })) as any;
      return r.threads.find((t: any) => t.threadId === thread.id);
    });
    assert.equal(mine.runnerId, runnerId);
    assert.equal(mine.title, 'index me');

    await api('mutation', 'sync:heartbeat', { key, runner: { runnerId: 'e2e-other', name: 'other', version: 'x', startedAt: new Date().toISOString(), draining: false, threadCount: 1, icon: 'macmini', rpcUrl: 'wss://other.example.ts.net/rpc' } });
    const row = { threadId: 'other-t1', title: 'On the other Mac', cwd: '/Users/other', accountId: 'codex-main', provider: 'codex', status: 'idle', needsYou: true, unread: false, preview: 'done', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
    await api('mutation', 'sync:setThreadIndex', { key, runnerId: 'e2e-other', rows: [row], removed: [] });
    const remote = await until('remoteThreads.list', async () => {
      const r = (await client.call('remoteThreads.list')) as any;
      return r.threads.some((t: any) => t.threadId === 'other-t1') ? r : undefined;
    });
    const other = remote.runners.find((r: any) => r.id === 'e2e-other');
    assert.deepEqual([other.name, other.icon, other.online, other.rpcUrl, other.tokenFile], ['other', 'macmini', true, 'wss://other.example.ts.net/rpc', undefined]);
    assert.ok(!remote.runners.some((r: any) => r.id === runnerId), 'not this runner itself');
    assert.equal(remote.threads.find((t: any) => t.threadId === 'other-t1').needsYou, true);

    // Its thread goes, and the other runner signs off.
    await api('mutation', 'sync:setThreadIndex', { key, runnerId: 'e2e-other', rows: [], removed: ['other-t1'] });
    await until('the row to go', async () => (((await client.call('remoteThreads.list')) as any).threads.some((t: any) => t.threadId === 'other-t1') ? undefined : true));
    await api('mutation', 'sync:bye', { key, runnerId: 'e2e-other' });
    await client.call('threads.delete', { threadId: thread.id });
    await until('this runner\'s row to go', async () => {
      const r = (await api('query', 'sync:otherRunnersThreads', { key, runnerId: 'someone-else' })) as any;
      return r.threads.some((t: any) => t.threadId === thread.id) ? undefined : true;
    });
  });

  // docs/convex-backend.md, "Secret scrubbing": what an older runner would send
  // is scrubbed on the way in, and a row from before the rules can be rewritten.
  test('scrubbing: the backend checks what an old runner sends, and scrub-stored rewrites old rows', async () => {
    const secret = `sk-${'e2e1'.repeat(12)}`;
    const threadId = `scrub-${crypto.randomBytes(4).toString('hex')}`;
    const { token } = (await api('mutation', 'sync:issueToken', { key, kind: 'phone', name: 'scrub-e2e' })) as { token: string };
    const runnerId = readRunnerJson(home).sync?.runnerId;
    const at = new Date().toISOString();
    await api('mutation', 'sync:upsertThreads', {
      key,
      threads: [{ threadId, runnerId, title: `title ${secret}`, cwd: '/tmp/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: `preview ${secret}`, createdAt: at, lastActivityAt: at, lastActivityMs: Date.now(), view: 'inbox' }],
    });
    await api('mutation', 'sync:appendMessages', { key, messages: [{ threadId, seq: 1, role: 'user', text: `here it is ${secret}`, at }] });
    const read = () => api('query', 'phone:messages', { token, threadId, limit: 50 }) as Promise<{ messages: { seq: number; text: string }[] }>;
    let page = await read();
    assert.equal(page.messages[0]!.text, 'here it is [REDACTED]');
    const rows = (await api('query', 'phone:threads', { token, view: 'inbox' })) as { threadId: string; title: string; preview: string }[];
    const row = rows.find((r) => r.threadId === threadId)!;
    assert.equal(row.title, 'title [REDACTED]');
    assert.equal(row.preview, 'preview [REDACTED]');
    assert.equal(await api('mutation', 'sync:savePocketCard', { key, card: { title: `card ${secret}`, text: `text ${secret}` } }), 'added');
    const cards = (await api('query', 'sync:pocketCards', { key })) as { title: string; text: string }[];
    assert.ok(!JSON.stringify(cards).includes(secret));
    assert.equal(await api('mutation', 'sync:removePocketCard', { key, title: `card ${secret}` }), true);

    // A row stored before the rules: straight in, past the mutations.
    const old = path.join(home, 'old-rows.jsonl');
    fs.writeFileSync(old, JSON.stringify({ threadId, seq: 2, role: 'assistant', text: `old row ${secret}`, at }) + '\n');
    await run('npx', ['convex', 'import', ...ENV_ARGS, '--append', '--yes', '--table', 'messages', old], { cwd: REPO });
    page = await read();
    assert.ok(page.messages.some((m) => m.seq === 2 && m.text.includes(secret)));

    const script: string = '../../scripts/scrub-stored.mjs';
    const { scrubStored } = await import(script);
    const post = (fn: string, args: Record<string, unknown>) => api('mutation', fn, args);
    const dry = await scrubStored({ post, key, tables: ['messages'], batch: 50 });
    assert.equal(dry.messages.changed, 1, 'just the old row');
    assert.ok((await read()).messages.some((m) => m.seq === 2 && m.text.includes(secret)), 'a dry run changes nothing');
    assert.ok(!JSON.stringify(dry).includes(secret), 'ids and counts, never the text');
    const applied = await scrubStored({ post, key, tables: ['messages'], apply: true, batch: 50 });
    assert.equal(applied.messages.changed, 1);
    assert.equal((await read()).messages.find((m) => m.seq === 2)!.text, 'old row [REDACTED]');
    const again = await scrubStored({ post, key, tables: ['messages'], batch: 50 });
    assert.equal(again.messages.changed, 0);
    await api('mutation', 'sync:removeThreads', { key, threadIds: [threadId] });
  });

  // Words stored as typed are only for the runner to get exactly: once a command
  // is over, however it ended, they're gone from the row.
  test('scrubbing: a finished command keeps none of its words, and a call only its path', async () => {
    const secret = `sk-${'e2e2'.repeat(12)}`;
    const runnerId = `e2e-away-${crypto.randomBytes(3).toString('hex')}`;
    await api('mutation', 'sync:heartbeat', { key, runner: { runnerId, name: runnerId, version: 'x', startedAt: 'x', draining: false, threadCount: 0 } });
    const at = new Date().toISOString();
    const thread = async () => {
      const threadId = `cmd-${crypto.randomBytes(4).toString('hex')}`;
      await api('mutation', 'sync:upsertThreads', { key, threads: [{ threadId, runnerId, title: 't', cwd: '/tmp/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: 'p', createdAt: at, lastActivityAt: at, lastActivityMs: Date.now(), view: 'inbox' }] });
      return threadId;
    };
    const send = (threadId: string) => api('mutation', 'relay:queueCommand', { key, runnerId, threadId, kind: 'send', args: { text: `use ${secret}` } }) as Promise<string>;
    const rows = async () => {
      const { stdout } = await run('npx', ['convex', 'data', ...ENV_ARGS, 'commands', '--limit', '200', '--format', 'jsonl'], { cwd: REPO });
      return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { _id: string; args?: unknown; result?: string });
    };
    const pending = () => api('query', 'sync:pendingCommands', { key, runnerId }) as Promise<{ commandId: string; args: Record<string, unknown> }[]>;

    // Done: the runner got the words as typed, and the row then lets them go.
    const done = await send(await thread());
    assert.equal((await pending()).find((c) => c.commandId === done)!.args.text, `use ${secret}`);
    assert.equal(await api('mutation', 'sync:takeCommand', { key, commandId: done }), true);
    await api('mutation', 'sync:finishCommand', { key, commandId: done, ok: true });

    // Failed by the backend, with no finishCommand: the thread went first.
    const goneThread = await thread();
    const gone = await send(goneThread);
    await api('mutation', 'sync:removeThreads', { key, threadIds: [goneThread] });
    assert.equal(await api('mutation', 'sync:takeCommand', { key, commandId: gone }), false);

    // A call: nothing but the path stays, and its answer is still JSON.
    const call = (await api('mutation', 'relay:queueCommand', { key, runnerId, kind: 'call', args: { method: 'files.list', params: { path: '/tmp', commentAt: secret } } })) as string;
    assert.deepEqual((await pending()).find((c) => c.commandId === call)!.args.params, { path: '/tmp' });
    await api('mutation', 'sync:takeCommand', { key, commandId: call });
    const name = 'security unlock-keychain -p "madeUpPassword123"';
    await api('mutation', 'sync:finishCommand', { key, commandId: call, ok: true, result: JSON.stringify({ entries: [{ name, key: secret, cwd: secret }] }) });
    const state = (await api('query', 'relay:commandState', { key, commandId: call })) as { state: string; result?: { entries: { name: string }[] } };
    assert.equal(state.state, 'done');
    assert.ok(state.result?.entries[0] && !state.result.entries[0].name.includes('madeUpPassword123'));
    assert.ok(!JSON.stringify(state.result).includes(secret), 'not under a name scrubbing skips in a row, either');

    const all = await rows();
    for (const id of [done, gone]) assert.deepEqual(all.find((r) => r._id === id)!.args, {}, 'nothing left of the words');
    assert.ok(!JSON.stringify(all).includes(secret));
    await api('mutation', 'sync:bye', { key, runnerId });
  });

  test('API 52: tool output: scrubbed again on the way in, read once by seq, gone with its thread', async () => {
    const secret = `sk-${'e2e5'.repeat(12)}`;
    const runnerId = `e2e-full-${crypto.randomBytes(3).toString('hex')}`;
    const threadId = `body-${crypto.randomBytes(4).toString('hex')}`;
    const at = new Date().toISOString();
    const { token } = (await api('mutation', 'sync:issueToken', { key, kind: 'browser', name: 'e2e-50' })) as { token: string };
    await api('mutation', 'sync:heartbeat', { key, runner: { runnerId, name: runnerId, version: 'x', startedAt: 'x', draining: false, threadCount: 0 } });
    await api('mutation', 'sync:upsertThreads', { key, threads: [{ threadId, runnerId, title: 't', cwd: '/tmp/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: 'p', createdAt: at, lastActivityAt: at, lastActivityMs: Date.now(), view: 'inbox' }] });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await api('mutation', 'sync:appendMessages', { key, messages: [{ threadId, seq: 1, role: 'tool', text: 'Ran x', at: old }, { threadId, seq: 3, role: 'tool', text: 'Ran y', at }] });
    // What an older runner, with no scrubbing of its own, might send.
    await api('mutation', 'sync:appendBodies', {
      key,
      bodies: [
        { threadId, seq: 3, text: `out ${secret}`, ok: true, input: JSON.stringify({ command: `echo ${secret}`, key: secret, cwd: secret }), diffs: JSON.stringify([{ path: 'a.ts', hunks: [{ lines: [`+${secret}`] }] }]), reasoning: secret, images: 2 },
        { threadId, seq: 5, withheld: true, reason: 'environment' },
        { threadId, seq: 7, text: 'x', input: 'not json' },
      ],
    });
    const body = (seq: number) => api('query', 'phone:eventBody', { token, threadId, seq }) as Promise<any>;
    const got = await body(3);
    assert.equal(got.state, 'text');
    assert.ok(!JSON.stringify(got).includes(secret), 'not under a name a row would skip, either');
    assert.equal(JSON.parse(got.input).key, '[REDACTED]');
    assert.equal(JSON.parse(got.diffs)[0].path, 'a.ts');
    assert.equal(got.images, 2);
    assert.deepEqual(await api('query', 'sync:remoteBody', { key, threadId, seq: 3 }), got);
    assert.deepEqual(await body(5), { state: 'withheld', reason: 'environment' });
    assert.equal((await body(7)).input, undefined, "JSON that isn't stored as text");
    assert.deepEqual(await body(1), { state: 'expired' }, 'its row is older than the body would be kept');
    assert.equal(await body(99), null);
    await assert.rejects(api('query', 'phone:eventBody', { token: 'tb_nope', threadId, seq: 3 }));
    await assert.rejects(api('query', 'sync:remoteBody', { key: 'nope', threadId, seq: 3 }));
    // Nothing on a shared page's way in: it takes no token and has no such function.
    const rows = async () => {
      const { stdout } = await run('npx', ['convex', 'data', ...ENV_ARGS, 'eventBodies', '--limit', '500', '--format', 'jsonl'], { cwd: REPO });
      return stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { _id: string; _creationTime: number; threadId: string; seq: number });
    };
    const before = (await rows()).filter((r) => r.threadId === threadId);
    assert.equal(before.length, 3);
    // The same again (a restart, a lost reply): nothing is written.
    await api('mutation', 'sync:appendBodies', { key, bodies: [{ threadId, seq: 5, withheld: true, reason: 'environment' }] });
    assert.deepEqual((await rows()).filter((r) => r.threadId === threadId), before);
    // A picture's command goes to its runner, and there's nothing to show until it's up.
    const command = (await api('mutation', 'phone:requestPicture', { token, threadId, seq: 3, index: 0 })) as string;
    assert.ok((await api('query', 'sync:pendingCommands', { key, runnerId }) as { commandId: string; kind: string }[]).some((c) => c.commandId === command && c.kind === 'picture'));
    assert.equal(await api('query', 'phone:heldPicture', { token, threadId, seq: 3, index: 0 }), null);
    await api('mutation', 'sync:removeThreads', { key, threadIds: [threadId] });
    await until('its tool output to go', async () => ((await rows()).some((r) => r.threadId === threadId) ? undefined : true), 15_000);
    await api('mutation', 'sync:bye', { key, runnerId });
  });

  test('a thread is mirrored, updated, and removed; the runner is listed and signs off', async () => {
    const runnerId = readRunnerJson(home).sync?.runnerId;
    assert.ok(runnerId, 'the runner made itself an id');

    const status = (await client.call('runner.status')) as any;
    assert.equal(status.sync?.state, 'ok');
    assert.equal(status.sync?.url, CONVEX_URL);
    assert.equal(status.sync?.name, 'E2E Mac');

    const runners = await until('the heartbeat', async () => {
      const list = (await api('query', 'sync:runnersList', { key })) as any[];
      const me = list.find((r) => r.runnerId === runnerId);
      return me ?? undefined;
    });
    assert.equal(runners.name, 'E2E Mac');
    assert.ok(runners.lastSeenAt > Date.now() - 60_000);

    // No accounts, so the create needs none; the turn fails at once (no
    // claude), which is fine: the thread exists and is mirrored.
    const { thread: made } = (await client.call('threads.create', { text: 'hello from the e2e', cwd: home, accountId: 'claude-main' })) as any;

    const row = await until('the thread row', async () => {
      const rows = (await api('query', 'sync:threadsOf', { key, runnerId })) as any[];
      return rows.find((r) => r.threadId === made.id);
    }, 90_000); // A loaded Mac: it failed at the default with load over 100.
    assert.equal(row.runnerId, runnerId);
    assert.equal(row.view, 'inbox');
    assert.equal(row.cwd, home);

    await client.call('threads.update', { threadId: made.id, title: 'Renamed from the e2e', archived: true });
    const renamed = await until('the rename and den', async () => {
      const rows = (await api('query', 'sync:threadsOf', { key, runnerId })) as any[];
      const r = rows.find((x) => x.threadId === made.id);
      return r?.title === 'Renamed from the e2e' && r.view === 'den' ? r : undefined;
    });
    assert.ok(renamed.archivedAt);

    // The phone's own queries, with a token issued the documented way.
    const { stdout } = await run('npx', ['convex', 'run', ...ENV_ARGS, 'tokens:issue', JSON.stringify({ name: 'e2e', days: 1 })], { cwd: REPO });
    // convex run prints the result as pretty JSON, after any log lines.
    const issued = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { token: string };
    const den = (await api('query', 'phone:threads', { token: issued.token, view: 'den' })) as any[];
    assert.ok(den.some((r) => r.threadId === made.id));
    // phone:search finds archived threads by a word of the title, the last
    // one as a prefix; the search index catches up a moment after the write.
    await until('phone:search', async () => {
      const found = (await api('query', 'phone:search', { token: issued.token, text: 'renamed fr' })) as any[];
      return found.some((r) => r.threadId === made.id && r.view === 'den') || undefined;
    });
    assert.deepEqual(await api('query', 'phone:search', { token: issued.token, text: 'nothingmatchesthis' }), []);
    const one = (await api('query', 'phone:thread', { token: issued.token, threadId: made.id })) as any;
    assert.equal(one.thread.title, 'Renamed from the e2e');
    await assert.rejects(api('query', 'phone:threads', { token: 'tb_wrong', view: 'inbox' }), /auth|token/);

    // Messages: the first message was mirrored (the turn itself failed,
    // there's no claude, so there's no reply).
    const withMessages = await until('the first message', async () => {
      const r = (await api('query', 'phone:thread', { token: issued.token, threadId: made.id })) as any;
      return r.messages.length ? r : undefined;
    });
    assert.deepEqual(withMessages.messages.map((m: any) => [m.seq, m.role, m.text]), [[1, 'user', 'hello from the e2e']]);

    // Lists: the fake login is in accounts.
    const accounts = await until('the accounts list', async () => {
      const a = (await api('query', 'phone:accounts', { token: issued.token })) as any[];
      return a.length ? a : undefined;
    });
    assert.ok(accounts.some((a) => a.id === 'claude-main' && a.email === 'e2e@example.com'), JSON.stringify(accounts));

    // A command from the phone: the runner takes it, applies it (the
    // message lands in the transcript as from the phone), and finishes it.
    await client.call('threads.update', { threadId: made.id, archived: false });
    const commandId = (await api('mutation', 'phone:send', { token: issued.token, threadId: made.id, text: 'sent from the phone' })) as string;
    const outcome = await until('the command to finish', async () => {
      const c = (await api('query', 'phone:command', { token: issued.token, commandId })) as any;
      return c.state === 'done' || c.state === 'failed' ? c : undefined;
    });
    assert.equal(outcome.state, 'done', JSON.stringify(outcome));
    const { events } = (await client.call('threads.events', { threadId: made.id })) as any;
    const fromPhone = events.find((e: any) => e.type === 'user.message' && e.text === 'sent from the phone');
    assert.equal(fromPhone?.origin, 'phone');
    // And it's mirrored back as a message.
    await until('the phone message in the mirror', async () => {
      const r = (await api('query', 'phone:thread', { token: issued.token, threadId: made.id })) as any;
      return r.messages.some((m: any) => m.text === 'sent from the phone' && m.origin === 'phone') ? true : undefined;
    });
    // To this runner by name: with none, it goes to the main runner, and tests before
    // this one leave pretend ones online that nothing would answer for.
    const created = (await api('mutation', 'phone:create', { token: issued.token, runnerId, text: 'a thread from the phone', cwd: home, accountId: 'claude-main' })) as string;
    const createdOutcome = await until('the create to finish', async () => {
      const c = (await api('query', 'phone:command', { token: issued.token, commandId: created })) as any;
      return c.state === 'done' || c.state === 'failed' ? c : undefined;
    });
    assert.equal(createdOutcome.state, 'done', JSON.stringify(createdOutcome));
    assert.ok(createdOutcome.threadId);
    const newThread = (await client.call('threads.list', { include: ['inbox'] }) as any).threads.find((t: any) => t.id === createdOutcome.threadId);
    assert.equal(newThread?.title, 'a thread from the phone');
    await client.call('threads.delete', { threadId: createdOutcome.threadId });
    // With no runner named, a new thread goes to the runner with the most
    // threads, even when a spare Mac heartbeat last: a phone thread once went
    // to Bruce, which has none of Mike's repos and no printer.
    const beat = (id: string, threadCount: number) => api('mutation', 'sync:heartbeat', { key, runner: { runnerId: id, name: id, version: 'x', startedAt: new Date().toISOString(), draining: false, threadCount } });
    await beat('e2e-main', 100_000);
    await beat('e2e-spare', 0);
    const routed = (await api('mutation', 'phone:create', { token: issued.token, text: 'which runner?' })) as string;
    const toMain = (await api('query', 'sync:pendingCommands', { key, runnerId: 'e2e-main' })) as any[];
    assert.ok(toMain.some((c) => c.commandId === routed), JSON.stringify(toMain));
    await api('mutation', 'sync:takeCommand', { key, commandId: routed });
    await api('mutation', 'sync:finishCommand', { key, commandId: routed, ok: true });
    for (const id of ['e2e-main', 'e2e-spare']) await api('mutation', 'sync:bye', { key, runnerId: id });
    await client.call('threads.update', { threadId: made.id, archived: true });
    await run('npx', ['convex', 'run', ...ENV_ARGS, 'tokens:revoke', JSON.stringify({ name: 'e2e' })], { cwd: REPO });

    await client.call('threads.delete', { threadId: made.id });
    await until('the row to go', async () => {
      const rows = (await api('query', 'sync:threadsOf', { key, runnerId })) as any[];
      return rows.some((r) => r.threadId === made.id) ? undefined : true;
    });

    // A stop for good says bye: lastSeenAt goes to 0.
    client.close();
    const exited = new Promise((r) => runner.once('exit', r));
    runner.kill('SIGTERM');
    await exited;
    await until('the goodbye', async () => {
      const list = (await api('query', 'sync:runnersList', { key })) as any[];
      const me = list.find((r) => r.runnerId === runnerId);
      return me && me.lastSeenAt === 0 ? true : undefined;
    });
  });
});
