// The runner's small-model layer (models/index.ts) and the Settings
// window's side of it (settings.ts): what is sent and what never is, how
// answers are read, runner.json, and the titles and explain features built
// on it. Calls run on a fake Claude pool; models-pool.test.ts covers which
// login answers and the CLI itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeHarness, tick, tmpDir, testConfig } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { ensureHome, loadConfig, readToken } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { HAIKU, Models, isPrivate } from '../../src/models/index.ts';
import type { ModelSettings } from '../../src/models/index.ts';
import type { CliRequest, CliResponse } from '../../src/models/claude-pool.ts';
import { ledgerPath } from '../../src/models/ledger.ts';
import { SettingsService, modelMethods, settingsMethods } from '../../src/settings.ts';
import { cleanTitle } from '../../src/runner.ts';
import type { Notification } from '../../src/runner.ts';
import { RpcServer } from '../../src/rpc.ts';
import { ErrorCode, RpcError } from '../../src/protocol.ts';
import type { Account, Pool } from '../../src/protocol.ts';

function acct(id: string, room: number): Account {
  return {
    id,
    provider: 'claude',
    title: id,
    configDir: `/tmp/no-such/${id}`,
    usage: { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: room }], readAt: new Date().toISOString(), source: 'live' },
  };
}

// A 'claude' pool of two Claude logins, with the CLI faked: each call gets
// the next reply, 'ok' once they run out.
function setup(opts: { settings?: Partial<ModelSettings>; replies?: CliResponse[] } = {}) {
  const home = tmpDir();
  ensureHome(home);
  const settings: ModelSettings = { privateFolders: [], pool: 'claude', ...opts.settings };
  const accounts = [acct('claude-main', 50), acct('claude-1', 80)];
  const pools: Pool[] = [{ id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-1'] }];
  const cli: CliRequest[] = [];
  const replies = [...(opts.replies ?? [])];
  const models = new Models({
    home,
    clock: new FakeClock(),
    log: nullLogger,
    settings: () => settings,
    claudePath: '/fake/claude',
    poolHost: {
      pool: (id) => {
        const pool = pools.find((p) => p.id === id);
        return pool ? { pool, accounts: pool.accountIds.map((x) => accounts.find((a) => a.id === x)!).filter(Boolean) } : undefined;
      },
      ranDry: () => {},
    },
    askCli: async (req) => {
      cli.push(req);
      return replies.shift() ?? { ok: true, text: 'ok' };
    },
  });
  const ledger = () =>
    fs.existsSync(ledgerPath(home))
      ? fs.readFileSync(ledgerPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
  return { home, settings, models, cli, ledger };
}

const answer = (text: string): CliResponse => ({ ok: true, text });

test('models: a call goes to a pool login, and the usage file records it without the text', async () => {
  const s = setup({ replies: [{ ok: true, text: '  Fix the flaky upload test \n', inputTokens: 10, outputTokens: 3 }] });
  const r = await s.models.generate({ feature: 'titles', prompt: 'secret words in a thread', system: 'Name it' });
  assert.ok(r.ok);
  assert.equal(r.value, 'Fix the flaky upload test');
  assert.equal(r.model, `${HAIKU} on claude-1`);
  assert.equal(r.tokens, 13);
  assert.equal(s.cli[0].model, HAIKU);
  assert.equal(s.cli[0].system, 'Name it');
  assert.equal(s.cli[0].user, 'secret words in a thread');
  const lines = s.ledger();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].feature, 'titles');
  assert.equal(lines[0].job, 'generate');
  assert.equal(lines[0].model, HAIKU);
  assert.equal(lines[0].accountId, 'claude-1');
  assert.equal(lines[0].inputTokens, 10);
  assert.equal(lines[0].costUsd, undefined, 'nothing is spent');
  assert.ok(!JSON.stringify(lines).includes('secret'), 'no text from the call is kept');
});

test('models: private folders and everything under them are never sent', async () => {
  const s = setup({ settings: { privateFolders: ['/work/client'] } });
  for (const cwd of ['/work/client', '/work/client/app']) {
    const r = await s.models.generate({ feature: 'titles', cwd, prompt: 'x' });
    assert.equal(r.ok ? 'sent' : r.reason, 'private', cwd);
  }
  assert.equal(s.cli.length, 0);
  assert.equal(s.ledger().length, 0);
  // A sibling that merely starts with the same letters isn't under it.
  assert.ok((await s.models.generate({ feature: 'titles', cwd: '/work/client-other', prompt: 'x' })).ok);
  assert.equal(isPrivate('~/dev/x', ['~/dev']), true);
});

test('models: extract reads fields, null for ones not given, and an unreadable answer fails', async () => {
  const s = setup({ replies: [answer('here you go: not json'), answer('```json\n{"ask": "Set the API key", "where": null}\n```')] });
  const fields = { ask: 'what the agent needs', where: 'which site' };
  const bad = await s.models.extract({ feature: 'asks', text: 'transcript', fields });
  assert.equal(bad.ok ? 'sent' : bad.reason, 'provider');
  const r = await s.models.extract({ feature: 'asks', text: 'transcript', fields });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { ask: 'Set the API key', where: null });
  assert.deepEqual((s.cli[1].jsonSchema as any).required, ['ask', 'where']);
  assert.match(s.cli[1].system ?? '', /- where: which site/);
  assert.deepEqual(s.ledger().map((l) => [l.model, l.ok, l.error]), [
    [HAIKU, false, 'unreadable answer'],
    [HAIKU, true, undefined],
  ]);
});

test('models: classify answers one of the labels or fails', async () => {
  const s = setup({ replies: [answer('{"label":"needs-you"}'), answer('{"label":"maybe"}')] });
  const r = await s.models.classify({ feature: 'triage', text: 'x', labels: ['needs-you', 'fyi', 'needs-you'] });
  assert.ok(r.ok && r.value === 'needs-you');
  assert.deepEqual((s.cli[0].jsonSchema as any).properties.label.enum, ['needs-you', 'fyi']);
  const r2 = await s.models.classify({ feature: 'triage', text: 'x', labels: ['needs-you', 'fyi'] });
  assert.equal(r2.ok ? 'sent' : r2.reason, 'provider');
});

test('models: strong generates go to Opus', async () => {
  const s = setup();
  await s.models.generate({ feature: 'wake', prompt: 'x', strong: true });
  assert.equal(s.cli[0].model, 'claude-opus-5-5');
  assert.equal(s.ledger()[0].job, 'decide');
});

// ------------------------------------------------------------- settings

// No pool host, so every call says no-pool.
function settingsSetup() {
  const home = tmpDir();
  ensureHome(home);
  const cfg = testConfig(home);
  const published: Notification[] = [];
  const models = new Models({ home, clock: new FakeClock(), log: nullLogger, settings: () => cfg.models });
  const svc = new SettingsService({ config: cfg, publish: (n) => published.push(n) });
  const methods = { ...settingsMethods(svc), ...modelMethods(models) };
  return { home, cfg, published, svc, methods, models };
}

test('settings: get shows the pool and private folders, and nothing of a key or spend', () => {
  const s = settingsSetup();
  assert.deepEqual(s.svc.get().models, { pool: 'claude', privateFolders: [] });
  assert.equal(s.methods['settings.setKey'], undefined, 'there is no key to set');
});

test('settings: update saves to runner.json, applies at once, and a bad field changes nothing', () => {
  const s = settingsSetup();
  const other = path.join(s.home, 'other');
  fs.mkdirSync(other);
  // dailyBudgetUsd: what an older app still sends; ignored.
  const r = s.methods['settings.update']({ defaultCwd: other, idleMinutes: 10, maxLiveCLIs: 3, followMain: false, bulletReplies: false, models: { dailyBudgetUsd: 2.5, privateFolders: ['~/client', ' ', '~/client'] } }) as { settings: any };
  assert.equal(r.settings.defaultCwd, other);
  assert.equal(s.cfg.idleMs, 10 * 60_000);
  assert.equal(s.cfg.maxLive, 3);
  assert.deepEqual(s.cfg.models, { pool: 'claude', privateFolders: ['~/client'] });
  assert.equal(r.settings.followMain, false);
  assert.equal(r.settings.bulletReplies, false);
  assert.equal(s.cfg.bulletReplies, false);
  assert.equal(s.published.length, 1);
  assert.equal(s.published[0].method, 'settings.updated');
  const json = JSON.parse(fs.readFileSync(path.join(s.home, 'runner.json'), 'utf8'));
  assert.equal(json.idleMinutes, 10);
  assert.equal(json.followMain, false);
  assert.equal(json.bulletReplies, false);
  assert.deepEqual(json.models, { privateFolders: ['~/client'] });
  // A fresh load reads the same.
  const cfg = loadConfig({ THREADBEAR_HOME: s.home });
  assert.deepEqual(cfg.models.privateFolders, ['~/client']);
  assert.equal(cfg.defaults.cwd, other);

  for (const bad of [{ defaultCwd: '/nope/not/here' }, { idleMinutes: 0 }, { maxLiveCLIs: 2.5 }, { models: { privateFolders: 'x' } }, { idleMinutes: 5, models: { pool: ' ' } }]) {
    assert.throws(() => s.methods['settings.update'](bad), (e: RpcError) => e.code === ErrorCode.badParams, JSON.stringify(bad));
  }
  assert.equal(s.cfg.idleMs, 10 * 60_000, 'a refused update changed nothing');
});

test("settings: bringIn is every 5 days until changed, and keeps the rest of runner.json's releases", () => {
  const s = settingsSetup();
  assert.equal(s.svc.get().bringIn, 5);
  const file = path.join(s.home, 'runner.json');
  fs.writeFileSync(file, JSON.stringify({ releases: { publish: false, signingKey: '~/k' } }));
  for (const v of [3, 'important', 'off'] as const) {
    const r = s.methods['settings.update']({ bringIn: v }) as { settings: any };
    assert.equal(r.settings.bringIn, v);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).releases, { publish: false, signingKey: '~/k', bringIn: 'off' });
  for (const bad of [0, 2.5, 'weekly', true]) {
    assert.throws(() => s.methods['settings.update']({ bringIn: bad }), (e: RpcError) => e.code === ErrorCode.badParams, String(bad));
  }
});

test('settings: a fresh runner.json means the Claude pool and no private folders', () => {
  const cfg = loadConfig({ THREADBEAR_HOME: tmpDir() });
  assert.deepEqual(cfg.models, { pool: 'claude', privateFolders: [] });
});

test('models.run: refuses bad params and says why a call was not sent', async () => {
  const s = settingsSetup();
  await assert.rejects(async () => s.methods['models.run']({ job: 'classify', text: 'x', labels: ['one'] }), (e: RpcError) => e.code === ErrorCode.badParams);
  await assert.rejects(async () => s.methods['models.run']({ job: 'dance', text: 'x' }), (e: RpcError) => e.code === ErrorCode.badParams);
  const r = await s.methods['models.run']({ job: 'generate', text: 'x' });
  assert.deepEqual((r as any).reason, 'no-pool');
  assert.equal(s.models.unavailable(), 'Needs a Claude pool to run on');
});

// --------------------------------------------------------------- titles

test('titles: a model title replaces the first line, unless one was set meanwhile', async () => {
  const asked: any[] = [];
  let answer = '"Fix the upload test."';
  const models = { generate: async (p: any) => (asked.push(p), { ok: true as const, value: answer, model: HAIKU }) };
  const h = makeHarness(undefined, {}, { models });
  const { thread } = h.runner.create({ text: 'can you look at why the upload test keeps failing on CI', accountId: 'claude-3' });
  assert.equal(thread.title, 'can you look at why the upload test keeps failing on CI');
  await tick();
  assert.equal(h.runner.get(thread.id)!.title, 'Fix the upload test');
  assert.equal(asked[0].feature, 'titles');
  assert.equal(asked[0].cwd, thread.cwd, 'the folder goes along, for private folders');

  // Named by hand before the model answered: the hand wins.
  let release!: () => void;
  const slow = { generate: (p: any) => new Promise<any>((r) => (release = () => r({ ok: true, value: 'Model title', model: HAIKU }))) };
  const h2 = makeHarness(undefined, {}, { models: slow });
  const t2 = h2.runner.create({ text: 'something', accountId: 'claude-3' }).thread;
  h2.runner.update({ threadId: t2.id, title: 'Mine' });
  release();
  await tick();
  assert.equal(h2.runner.get(t2.id)!.title, 'Mine');

  // A title given at create isn't asked about at all; a failure keeps the first line.
  answer = 'unused';
  const before = asked.length;
  h.runner.create({ text: 'x', title: 'Given', accountId: 'claude-3' });
  assert.equal(asked.length, before);
  const failing = { generate: async () => ({ ok: false as const, reason: 'no-pool' as const, message: '' }) };
  const h3 = makeHarness(undefined, {}, { models: failing });
  const t3 = h3.runner.create({ text: 'first line\nsecond', accountId: 'claude-3' }).thread;
  await tick();
  assert.equal(h3.runner.get(t3.id)!.title, 'first line');
});

test('titles: retitle names the threads still on their first line, and only those', async () => {
  // No pool at first, so every thread keeps its first line, as before there was one.
  let keyed = false;
  const asked: string[] = [];
  const models = {
    generate: async (p: any) => {
      if (!keyed) return { ok: false as const, reason: 'no-pool' as const, message: 'No pool' };
      const msg = p.prompt.replace(/^Message:\n/, '');
      asked.push(msg);
      if (msg.startsWith('client')) return { ok: false as const, reason: 'private' as const, message: 'private folder' };
      return { ok: true as const, value: `Named: ${msg.split('\n')[0].slice(0, 20)}`, model: HAIKU };
    },
  };
  const h = makeHarness(undefined, {}, { models });
  const make = (text: string, extra: Record<string, unknown> = {}) => h.runner.create({ text, accountId: 'claude-3', ...extra }).thread.id;
  const plain = make('can you look at why the upload test keeps failing on CI');
  const long = make('x'.repeat(90) + '\nsecond line');
  const archived = make('tidy the readme');
  h.runner.update({ threadId: archived, archived: true });
  const given = make('started by a schedule', { title: 'Morning digest' });
  const renamed = make('something I renamed');
  h.runner.update({ threadId: renamed, title: 'My name for it' });
  const client = make('client work in a private folder');
  await tick();

  // Already named by a model: its title no longer matches its first line.
  keyed = true;
  const named = make('this one got a model title when it started');
  await tick();
  assert.equal(h.runner.get(named).title, 'Named: this one got a model');
  asked.length = 0;

  const dry = await h.runner.retitle({ dryRun: true });
  assert.deepEqual(dry.threads.map((t) => t.threadId).sort(), [plain, long, archived, client].sort());
  assert.ok(dry.threads.every((t) => t.to === undefined && t.reason === undefined));
  assert.equal(asked.length, 0, 'a dry run asks nothing');

  const res = await h.runner.retitle({});
  const by = new Map(res.threads.map((t) => [t.threadId, t]));
  assert.equal(by.get(plain)!.from, 'can you look at why the upload test keeps failing on CI');
  assert.equal(by.get(plain)!.to, 'Named: can you look at why');
  assert.equal(h.runner.get(plain).title, 'Named: can you look at why');
  assert.equal(h.runner.get(long).title, 'Named: xxxxxxxxxxxxxxxxxxxx', 'a first line cut to 60 characters still counts');
  assert.equal(h.runner.get(archived).title, 'Named: tidy the readme');
  assert.equal(by.get(client)!.reason, 'private folder');
  assert.equal(h.runner.get(client).title, 'client work in a private folder');
  for (const id of [given, renamed, named]) assert.ok(!by.has(id));
  assert.equal(h.runner.get(given).title, 'Morning digest');
  assert.equal(h.runner.get(renamed).title, 'My name for it');

  // Run again: only the one that failed is left.
  asked.length = 0;
  const again = await h.runner.retitle({});
  assert.deepEqual(again.threads.map((t) => t.threadId), [client]);

  // By id it names them again, model titles included, but never one named by hand.
  asked.length = 0;
  const byId = await h.runner.retitle({ threadIds: [named, plain, renamed] });
  assert.deepEqual(byId.threads.map((t) => t.threadId).sort(), [named, plain].sort());
  assert.equal(asked.length, 2);
  await assert.rejects(async () => h.runner.retitle({ threadIds: ['nope'] }), (e: RpcError) => e.code === ErrorCode.threadNotFound);
});

test('titles: naming an older thread also sends the start of its first reply', async () => {
  const asked: any[] = [];
  const models = { generate: async (p: any) => (asked.push(p), { ok: false as const, reason: 'no-pool' as const, message: '' }) };
  const h = makeHarness(undefined, {}, { models });
  const id = h.runner.create({ text: 'Explain thread count', accountId: 'claude-3' }).thread.id;
  await tick();
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'The sidebar counts threads that are running, plus the ones waiting on you.');
  s.result();
  await tick();
  asked.length = 0;
  await h.runner.retitle({});
  assert.equal(asked.length, 1);
  assert.match(asked[0].prompt, /Explain thread count/);
  assert.match(asked[0].prompt, /The sidebar counts threads that are running/);
});

test('titles: cleanTitle tidies what a model says', () => {
  assert.equal(cleanTitle('Title: "Ship the settings window."'), 'Ship the settings window');
  assert.equal(cleanTitle('\n**Debug flaky CI**\nextra'), 'Debug flaky CI');
  assert.equal(cleanTitle('Fix the upload test — a short thread about CI'), 'Fix the upload test');
  assert.equal(cleanTitle('Fix README typo "directons"'), 'Fix README typo "directons"', 'quotes inside stay');
  // Rambling or cut off by the token limit: no title, so the first line stays.
  assert.equal(cleanTitle('x'.repeat(80)), '');
  assert.equal(cleanTitle('Adding Cmd plus and Cmd minus zoom shortcuts to the whole Threadbear window'), '');
});

// ------------------------------------------------------------------ tb

test('tb settings and tb models over a real socket', async () => {
  const s = settingsSetup();
  const h = makeHarness(s.home);
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: readToken(s.home), runner: h.runner, log: nullLogger, methods: s.methods });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const TB = path.join(import.meta.dirname, '..', '..', 'bin', 'tb');
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = '';
      const p = spawn(process.execPath, [TB, ...args], { env: { ...process.env, THREADBEAR_HOME: s.home, THREADBEAR_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.once('exit', (code) => resolve({ code, out }));
    });
  try {
    let r = await run(['settings']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Small jobs on\s+the claude pool/);
    assert.match(r.out, /Private folders\s+none/);
    assert.doesNotMatch(r.out, /OpenRouter|budget|Spent/i);
    r = await run(['models']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Small jobs on\s+the claude pool/);
    r = await run(['models', 'pool', 'off']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Small jobs on\s+nothing/);
    r = await run(['models', 'key']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Unknown: tb models key/);
  } finally {
    await server.close();
  }
});

// --------------------------------------------------------------- explain

test('explain: asks the small model about the selection, and writes nothing to the thread', async () => {
  const asked: any[] = [];
  let reply: any = { ok: true, value: '  It means the committee approves people who joined online.  ', model: HAIKU };
  const models = { generate: async (p: any) => (asked.push(p), p.feature === 'explain' ? reply : { ok: false, reason: 'no-pool', message: '' }) };
  const h = makeHarness(undefined, {}, { models });
  const { thread } = h.runner.create({ text: 'what should we move onto the library first?', accountId: 'claude-3' });
  await tick();
  const before = h.runner.get(thread.id)!.lastSeq;
  const r = await h.runner.explain({ threadId: thread.id, selection: 'the library', message: 'what should we move onto the library first?' });
  assert.equal(r.answer, 'It means the committee approves people who joined online.');
  assert.equal(r.model, HAIKU);
  const p = asked.find((a) => a.feature === 'explain');
  assert.equal(p.cwd, thread.cwd, 'the folder goes along, for private folders');
  assert.match(p.prompt, /What the user selected:\n"the library"/);
  assert.match(p.prompt, /The message the user selected from:\nwhat should we move/);
  assert.match(p.prompt, /Explain what the user selected\.$/);
  assert.equal(h.runner.get(thread.id)!.lastSeq, before, 'nothing goes into the thread');

  // A follow-up sends the earlier answer and the new question.
  asked.length = 0;
  await h.runner.explain({ threadId: thread.id, selection: 'the library', earlier: [{ answer: 'It is the state machines library.' }], question: 'which repo?' });
  assert.match(asked[0].prompt, /You explained:\nIt is the state machines library\./);
  assert.match(asked[0].prompt, /The user now asks: which repo\?$/);

  // No model: the reason comes back as an error.
  reply = { ok: false, reason: 'private', message: 'This thread is in a private folder.' };
  await assert.rejects(h.runner.explain({ threadId: thread.id, selection: 'x' }), (e: any) => e instanceof RpcError && e.message === 'This thread is in a private folder.');
});
