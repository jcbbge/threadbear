// The order Mike puts his runners in on the phone (convex/phone.ts,
// setRunnerOrder, API 56): phone:runners lists them in it, and a new thread
// that names no runner goes to the first one online in it, so the M5 asleep
// doesn't leave the phone with nowhere to start one (6 Nov).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'tbr_bruce';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';
const CLOUD = 'cloud0000001';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

async function setup({ m5Awake }: { m5Awake: boolean }) {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('runnerKeys', { runnerId: BRUCE, keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  // Made in this order, so the table's own order is cloud, Bruce, the M5.
  await b.ctx.db.insert('runners', { runnerId: CLOUD, name: 'cloud', version: 'v', startedAt: 'x', draining: false, threadCount: 5, lastSeenAt: now - 60 * 60_000 });
  await b.ctx.db.insert('runners', { runnerId: BRUCE, name: 'bruce', version: 'v', startedAt: 'x', draining: false, threadCount: 1_000_000, lastSeenAt: now });
  await b.ctx.db.insert('runners', { runnerId: M5, name: 'm5', version: 'v', startedAt: 'x', draining: false, threadCount: 100, lastSeenAt: m5Awake ? now : now - 10 * 60_000, byOwner: true });
  const token = 'phone-token';
  await b.ctx.db.insert('tokens', { hash: await sha256(token), name: 'phone', expiresAt: now + 100_000, createdAt: now });
  const listed = async () => ((await call(b.ctx, phone.runners, { token })) as { runnerId: string }[]).map((r) => r.runnerId);
  const startsOn = async () => {
    await call(b.ctx, phone.create, { token, text: 'hi' });
    return b.rows('commands').at(-1)!.runnerId as string;
  };
  return { ...b, token, listed, startsOn };
}

test('with no order, the main Mac is listed first asleep or not, the rest as they first came, never by thread count', async () => {
  const s = await setup({ m5Awake: false });
  assert.deepEqual(await s.listed(), [M5, CLOUD, BRUCE]);
  // And a new thread still waits for it, as before there was an order.
  assert.equal(await s.startsOn(), 'any');
});

test('a new thread goes to the first runner online in the order, so the M5 asleep sends it to the next', async () => {
  const s = await setup({ m5Awake: false });
  await call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: [M5, CLOUD, BRUCE] });
  assert.deepEqual(await s.listed(), [M5, CLOUD, BRUCE]);
  // The M5 and the cloud box are both offline: Bruce, the next one up.
  assert.equal(await s.startsOn(), BRUCE);
  // Bruce's key sees it, being where Mike's order put it.
  const bruceSees = (await call(s.ctx, sync.pendingCommands, { key: BRUCE_KEY, runnerId: BRUCE })) as unknown[];
  assert.equal(bruceSees.length, 1);
});

test('with the M5 awake and first in the order, new threads go to it', async () => {
  const s = await setup({ m5Awake: true });
  await call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: [M5, BRUCE] });
  assert.equal(await s.startsOn(), M5);
});

test("a runner left out of the order goes after it; none of the order online falls back to the main Mac's rule", async () => {
  const s = await setup({ m5Awake: true });
  await call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: [CLOUD, 'gone00000001'] });
  assert.deepEqual(await s.listed(), [CLOUD, M5, BRUCE]);
  // Only the placed one says so, for the phone's automatic pick.
  const rows = (await call(s.ctx, phone.runners, { token: s.token })) as { runnerId: string; placed?: boolean }[];
  assert.deepEqual(rows.filter((r) => r.placed).map((r) => r.runnerId), [CLOUD]);
  assert.deepEqual(rows.filter((r) => (r as { main?: boolean }).main).map((r) => r.runnerId), [M5]);
  // The cloud box is offline and the other id has no runner: the main Mac, not Bruce.
  assert.equal(await s.startsOn(), M5);
});

test('a draining runner is passed over, and saving again replaces the order', async () => {
  const s = await setup({ m5Awake: true });
  await call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: [BRUCE, M5] });
  await s.ctx.db.patch(s.rows('runners').find((r) => r.runnerId === BRUCE)!._id, { draining: true });
  assert.equal(await s.startsOn(), M5);
  await call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: [M5, M5, BRUCE] });
  assert.equal(s.rows('runnerOrder').length, 1);
  assert.deepEqual(s.rows('runnerOrder')[0]!.runnerIds, [M5, BRUCE]);
});

test("only a phone token sets the order, and it's size-checked", async () => {
  const s = await setup({ m5Awake: true });
  assert.equal(await outcome(call(s.ctx, phone.setRunnerOrder, { token: 'not-a-token', runnerIds: [BRUCE] })), 'auth');
  assert.equal(await outcome(call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: [''] })), 'invalid');
  assert.equal(await outcome(call(s.ctx, phone.setRunnerOrder, { token: s.token, runnerIds: Array.from({ length: 51 }, (_, i) => `r${i}`) })), 'invalid');
  assert.equal(s.rows('runnerOrder').length, 0);
});

test('with no owner-key Mac known, no runner is marked main, so the phone leaves the choice to the backend', async () => {
  const s = await setup({ m5Awake: false });
  await s.ctx.db.patch(s.rows('runners').find((r) => r.runnerId === M5)!._id, { byOwner: undefined });
  const rows = (await call(s.ctx, phone.runners, { token: s.token })) as { main?: boolean }[];
  assert.equal(rows.filter((r) => r.main).length, 0);
  assert.equal(await s.startsOn(), 'any');
});

test("the Mac sets the same order with the main key, and a runner key can't read or move it", async () => {
  const s = await setup({ m5Awake: false });
  await call(s.ctx, sync.setRunnerOrder, { key: OWNER, runnerIds: [M5, BRUCE, CLOUD] });
  assert.deepEqual(await call(s.ctx, sync.runnerOrder, { key: OWNER }), [M5, BRUCE, CLOUD]);
  assert.deepEqual(await s.listed(), [M5, BRUCE, CLOUD]);
  assert.equal(await s.startsOn(), BRUCE);
  assert.equal(await outcome(call(s.ctx, sync.setRunnerOrder, { key: BRUCE_KEY, runnerIds: [BRUCE, M5] })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.runnerOrder, { key: BRUCE_KEY })), 'forbidden');
  assert.deepEqual(s.rows('runnerOrder')[0]!.runnerIds, [M5, BRUCE, CLOUD]);
});
