// Who may share which logins' usage readings (convex/sync.ts sharedUsage,
// docs/protocol.md "Runner keys"), against the in-memory backend. From
// Gautam's 6 Nov 2026 scan of convex/ (F1, F3): a runner key wrote accounts
// rows naming the main Mac's logins, with a reading from 2099 that said
// blocked, and sharedUsage handed them to the main Mac, whose pools then
// never picked those logins; and the same rows were all sharedUsage asked to
// decide which of the main Mac's readings (and its runner id) that key could
// read. What a runner key shares is now the owner key's word alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'tbr_bruce';
const PIXEL_KEY = 'tbr_pixel';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';
const PIXEL = 'a2a95e35639c';
const MINE = 'mike@example.com';
const OTHER = 'work@example.com';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const access = load('runnerAccess');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: BRUCE, keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  await b.ctx.db.insert('runnerKeys', { runnerId: PIXEL, keyHash: await sha256(PIXEL_KEY), name: 'Pixel', createdAt: 2 });
  return b;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const usage = (o: { readAt: string; week: number; resetsAt?: string; blocked?: boolean }) => ({
  windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: o.week, ...(o.resetsAt ? { resetsAt: o.resetsAt } : {}) }],
  readAt: o.readAt,
  source: 'live',
  ...(o.blocked ? { blocked: true } : {}),
});
const account = (id: string, email: string, u: ReturnType<typeof usage>) => ({ id, provider: 'claude', title: id, email, usage: u });
// The exploit's reading: newest of all, out of room until 2099.
const FAKE = usage({ readAt: '2099-01-01T00:00:00Z', week: 0, resetsAt: '2099-01-01T00:00:00Z', blocked: true });
const shared = async (s: Awaited<ReturnType<typeof setup>>, key: string, runnerId: string) => (await call(s.ctx, sync.sharedUsage, { key, runnerId })) as Record<string, any>[];

test('F1: a runner key\'s reading of a login the owner hasn\'t listed for it never reaches the main Mac', async () => {
  const s = await setup();
  const real = usage({ readAt: iso(Date.now() - 60_000), week: 60, resetsAt: iso(Date.now() + 3 * DAY) });
  await call(s.ctx, sync.setAccounts, { key: OWNER, runnerId: M5, accounts: [account('claude-main', MINE, real)] });
  // Bruce's key names the main Mac's login (pools hands any key the emails).
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('claude-main', MINE, FAKE)] });
  await call(s.ctx, sync.upsertAccounts, { key: PIXEL_KEY, runnerId: PIXEL, accounts: [account('claude-1', MINE, FAKE)], removed: [] });
  assert.deepEqual(await shared(s, OWNER, M5), []);
  // A runner from before API 45 sends no runner id: still none of theirs.
  assert.deepEqual((await call(s.ctx, sync.sharedUsage, { key: OWNER }) as any[]).map((r) => r.runnerId), [M5]);
});

test("F1: even listed, a runner key's reading never reaches the main Mac, nor goes on through it", async () => {
  const s = await setup();
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'claude', email: MINE }] });
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: PIXEL, logins: [{ provider: 'claude', email: MINE }] });
  // One window the main Mac hasn't read, at 0% with no reset: as good as blocked.
  const fiveHour = { windows: [{ kind: 'five_hour', title: '5h', remainingPercent: 0 }], readAt: iso(Date.now() - 1000), source: 'live' };
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('claude-main', MINE, FAKE), account('c2', MINE, fiveHour as any)] });
  assert.deepEqual(await shared(s, OWNER, M5), []);
  assert.deepEqual(await call(s.ctx, sync.sharedUsage, { key: OWNER }), [], 'nor to an owner runner from before API 45');
  assert.deepEqual(await shared(s, PIXEL_KEY, PIXEL), []);
});

test('F1: a runner key\'s readings are stored read no later than now, with resets inside their windows, by setAccounts and upsertAccounts', async () => {
  const s = await setup();
  const now = Date.now();
  const odd = { ...FAKE, windows: [...FAKE.windows, { kind: 'five_hour', title: '5h', remainingPercent: 250, resetsAt: '2099-01-01T00:00:00Z' }, { kind: 'monthly', title: 'M', remainingPercent: 5, resetsAt: 'not a date' }] };
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('a', MINE, odd), account('b', OTHER, usage({ readAt: 'whenever', week: 5 }))] });
  await call(s.ctx, sync.upsertAccounts, { key: PIXEL_KEY, runnerId: PIXEL, accounts: [account('c', MINE, FAKE)], removed: [] });
  const by = (id: string) => s.rows('accounts').find((r) => r.id === id)!;
  for (const id of ['a', 'c']) {
    const u = by(id).usage;
    assert.ok(Date.parse(u.readAt) <= Date.now(), `${id}: readAt clamped`);
    assert.ok(Date.parse(u.windows[0].resetsAt) <= now + 7 * DAY + 3_600_000 + 1000, `${id}: weekly reset clamped`);
  }
  const a = by('a').usage;
  assert.equal(a.windows[1].remainingPercent, 100);
  assert.ok(Date.parse(a.windows[1].resetsAt) <= now + 6 * 3_600_000 + 1000, '5-hour reset within 5 hours (and an hour)');
  assert.equal(a.windows[2].resetsAt, undefined, "a reset that isn't a time goes");
  assert.equal(by('b').usage, undefined, "a reading with no time isn't kept");
  // The owner key's own writes are as it sent them.
  await call(s.ctx, sync.setAccounts, { key: OWNER, runnerId: M5, accounts: [account('m', MINE, FAKE)] });
  assert.equal(by('m').usage.readAt, FAKE.readAt);
});

test("F3: a runner key's own accounts rows don't let it read the main Mac's readings, nor learn its runner id", async () => {
  const s = await setup();
  const real = usage({ readAt: iso(Date.now() - 60_000), week: 42, resetsAt: iso(Date.now() + DAY) });
  await call(s.ctx, sync.setAccounts, { key: OWNER, runnerId: M5, accounts: [account('claude-main', MINE, real), account('claude-2', OTHER, real)] });
  // Guesses of the main Mac's logins, written as its own.
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('g1', MINE, real), account('g2', OTHER, real), account('g3', 'x@y.z', real)] });
  assert.deepEqual(await shared(s, BRUCE_KEY, BRUCE), [], 'nothing until the owner lists a login for it');
  assert.deepEqual(await call(s.ctx, sync.sharedUsage, { key: BRUCE_KEY }), []);
  // The owner says Bruce has one of them: only that one, the owner's reading, no runner id.
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'claude', email: MINE }] });
  const rows = await shared(s, BRUCE_KEY, BRUCE);
  assert.deepEqual(rows, [{ provider: 'claude', email: MINE, usage: real, byOwnerKey: true }]);
  assert.equal(JSON.stringify(rows).includes(M5), false, 'never the main Mac\'s runner id');
});

test("F1/F3: a runner key never gets another runner key's reading, even of a login both are listed for", async () => {
  const s = await setup();
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'claude', email: MINE }] });
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: PIXEL, logins: [{ provider: 'claude', email: MINE }] });
  await call(s.ctx, sync.setAccounts, { key: PIXEL_KEY, runnerId: PIXEL, accounts: [account('claude-1', MINE, FAKE)] });
  assert.deepEqual(await shared(s, BRUCE_KEY, BRUCE), []);
});

test("a runner whose key was revoked: its rows still aren't the owner's, and its list went with the key", async () => {
  const s = await setup();
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'claude', email: MINE }] });
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('claude-main', MINE, FAKE)] });
  assert.equal(await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: BRUCE }), 1);
  assert.equal(s.rows('runnerLogins').length, 0);
  // Pixel is listed for the login, and Bruce's old rows are still there.
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: PIXEL, logins: [{ provider: 'claude', email: MINE }] });
  assert.deepEqual(await shared(s, PIXEL_KEY, PIXEL), [], "a revoked key's rows aren't the owner's word");
  assert.deepEqual(await shared(s, OWNER, M5), []);
});

test('only the owner key lists logins, only for a runner with a live key, and a new key for the id starts with none', async () => {
  const s = await setup();
  await assert.rejects(call(s.ctx, sync.setRunnerLogins, { key: BRUCE_KEY, runnerId: BRUCE, logins: [{ provider: 'claude', email: MINE }] }), /forbidden|only the main Mac/);
  await assert.rejects(call(s.ctx, sync.runnerLogins, { key: BRUCE_KEY }), /forbidden|only the main Mac/);
  await assert.rejects(call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: M5, logins: [] }), /no live key/);
  await assert.rejects(call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'claude', email: 'not an email' }] }), /Not a login/);
  await assert.rejects(call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: Array.from({ length: 21 }, (_, i) => ({ provider: 'claude', email: `m${i}@x.com` })) }), /at most 20/);
  assert.equal(await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'Claude', email: ' Mike@Example.com ' }, { provider: 'claude', email: MINE }, { provider: 'codex', email: MINE }] }), 2);
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('claude-main', MINE, FAKE), account('x', OTHER, FAKE)] });
  const list = (await call(s.ctx, sync.runnerLogins, { key: OWNER })) as any[];
  const bruce = list.find((r) => r.runnerId === BRUCE);
  assert.deepEqual(bruce, { runnerId: BRUCE, name: 'bruce', live: true, shared: [{ provider: 'claude', email: MINE }, { provider: 'codex', email: MINE }], claimed: [{ provider: 'claude', email: MINE }, { provider: 'claude', email: OTHER }] });
  // tb runner add --replace: a new key under the id, perhaps another Mac.
  await call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: BRUCE, name: 'bruce', ownerRunnerId: M5, replace: true });
  assert.equal(s.rows('runnerLogins').length, 0);
});

test("F1: a forged reading an older main Mac copied into its own row before the fix isn't passed on", async () => {
  const s = await setup();
  const OLD = 'oldowner0001';
  const real = usage({ readAt: iso(Date.now() - 60_000), week: 42, resetsAt: iso(Date.now() + DAY) });
  // An owner-key runner that took a runner key's 2099 reading in and wrote it as its own.
  await call(s.ctx, sync.setAccounts, { key: OWNER, runnerId: OLD, accounts: [account('claude-main', MINE, FAKE), account('ok', OTHER, real)] });
  await call(s.ctx, sync.setAccounts, { key: OWNER, runnerId: 'oldowner0002', accounts: [account('a', MINE, usage({ readAt: iso(Date.now() - 60_000), week: 0, resetsAt: '2099-01-01T00:00:00Z' }))] });
  assert.deepEqual((await shared(s, OWNER, M5)).map((r) => `${r.runnerId}:${r.email}`), [`${OLD}:${OTHER}`]);
});

test('pools: a runner key sees members named by email and its own runner id, never another runner\'s id', async () => {
  const s = await setup();
  const members = [{ provider: 'claude', email: MINE }, { provider: 'claude', runnerId: M5, accountId: 'claude-x' }, { provider: 'codex', runnerId: BRUCE, accountId: 'codex-main' }];
  await call(s.ctx, sync.savePools, { key: OWNER, runnerId: M5, pools: [{ id: 'claude', title: 'Claude', members }] });
  const bruce = (await call(s.ctx, sync.pools, { key: BRUCE_KEY })) as any[];
  assert.deepEqual(bruce[0].members, [members[0], members[2]]);
  assert.equal(JSON.stringify(bruce).includes(M5), false);
  assert.deepEqual(((await call(s.ctx, sync.pools, { key: OWNER })) as any[])[0].members, members);
});

test('fitUsage: never later than now, resets inside their window, room 0 to 100', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const f = access.fitUsage as (u: any, now: number) => any;
  assert.equal(f({ windows: [], readAt: 'nope', source: 'live' }, now), undefined);
  const out = f({ windows: [{ kind: 'weekly', title: 'W', remainingPercent: -5, resetsAt: '2026-11-08T00:00:00Z' }, { kind: 'odd', title: 'O', remainingPercent: 50, resetsAt: '2030-01-01T00:00:00Z' }], readAt: '2026-11-05T00:00:00Z', source: 'live', blocked: true }, now);
  assert.equal(out.readAt, '2026-11-05T00:00:00Z', 'a past reading as it was');
  assert.equal(out.windows[0].resetsAt, '2026-11-08T00:00:00Z', 'a real reset in two days stays');
  assert.equal(out.windows[0].remainingPercent, 0);
  assert.equal(Date.parse(out.windows[1].resetsAt), now + 31 * 86_400_000 + 3_600_000);
  assert.equal(out.blocked, true, "kept on the runner's own row");
  // A kind named after something every object has still gets a horizon.
  for (const kind of ['constructor', '__proto__', 'toString']) {
    const k = f({ windows: [{ kind, title: 'K', remainingPercent: 0, resetsAt: '2099-01-01T00:00:00Z' }], readAt: '2026-11-05T00:00:00Z', source: 'live' }, now);
    assert.equal(Date.parse(k.windows[0].resetsAt), now + 31 * 86_400_000 + 3_600_000, kind);
  }
});
