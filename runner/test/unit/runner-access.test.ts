// Per-runner keys (convex/runnerAccess.ts, docs/protocol.md "Runner keys"):
// the owner key does everything, a runner key acts as its own runner only.
// The plain rules, without a deployment, plus a check that every function
// in convex/sync.ts is sorted and asks the gate under its own name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { convexPoster, forbiddenText } from '../../src/sync.ts';
import { ACCESS, actsAs, badRunnerStats, callerFrom, isIsoTime, mayCall, mayClaim, mayFinish, mayTake, mayTouch, mayUseStorage, mayWrite, ownsCard, sameKey, wholeIn, type Caller } from '../../../convex/runnerAccess.ts';

const OWNER_KEY = 'owner-key-of-the-deployment';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';
const owner = callerFrom(OWNER_KEY, OWNER_KEY, null) as Caller;
const bruce = callerFrom('tbr_bruce', OWNER_KEY, { runnerId: BRUCE }) as Caller;

test('the owner key is the owner; a runner key is its own runner; anything else is nobody', () => {
  assert.deepEqual(owner, { owner: true });
  assert.deepEqual(bruce, { owner: false, runnerId: BRUCE });
  assert.equal(callerFrom('wrong', OWNER_KEY, null), null);
  assert.equal(callerFrom('', OWNER_KEY, null), null);
  // A deployment with no RUNNER_KEY set has no owner, and an empty key never matches one.
  assert.equal(callerFrom('', undefined, null), null);
  assert.equal(callerFrom(OWNER_KEY, undefined, null), null);
});

test('while RUNNER_KEY is rotated, RUNNER_KEY_NEXT is the owner too', () => {
  assert.deepEqual(callerFrom('new-owner', [OWNER_KEY, 'new-owner'], null), { owner: true });
  assert.deepEqual(callerFrom(OWNER_KEY, [OWNER_KEY, 'new-owner'], null), { owner: true });
  assert.deepEqual(callerFrom(OWNER_KEY, [OWNER_KEY, undefined], null), { owner: true });
  assert.equal(callerFrom('', [undefined, undefined], null), null);
  // Once rotated, the old one (Bruce's copy of it, say) is nobody.
  assert.equal(callerFrom(OWNER_KEY, ['new-owner', undefined], null), null);
});

test('a revoked runner key fails', () => {
  assert.equal(callerFrom('tbr_bruce', OWNER_KEY, { runnerId: BRUCE, revokedAt: 1 }), null);
});

test('keys are compared whole', () => {
  assert.equal(sameKey('abc', 'abc'), true);
  assert.equal(sameKey('abc', 'abd'), false);
  assert.equal(sameKey('abc', 'abcd'), false);
  assert.equal(sameKey('', 'a'), false);
});

test("Bruce's key can't heartbeat, prune or read commands as the M5, and can as itself", () => {
  assert.equal(actsAs(bruce, M5), false);
  assert.equal(actsAs(bruce, BRUCE), true);
  // heartbeat, pendingCommands, prune, setPresence, bye all go by actsAs.
  for (const fn of ['heartbeat', 'pendingCommands', 'prune', 'setPresence', 'bye', 'messageHeads', 'setThreadIndex']) assert.equal(mayCall(bruce, fn), true, fn);
});

test("Bruce's key can't write, take or move the M5's threads, and can write its own", () => {
  // Rewriting an M5 thread as it is (its secret card's key, say).
  assert.equal(mayWrite(bruce, M5, M5), false);
  // Taking it by writing it under Bruce's id.
  assert.equal(mayWrite(bruce, BRUCE, M5), false);
  // Moving one of its own to the M5, or making a new one there.
  assert.equal(mayWrite(bruce, M5, BRUCE), false);
  assert.equal(mayWrite(bruce, M5, undefined), false);
  // Its own, new or already there.
  assert.equal(mayWrite(bruce, BRUCE, undefined), true);
  assert.equal(mayWrite(bruce, BRUCE, BRUCE), true);
  // Messages, pictures and removal go by the row's runner.
  assert.equal(mayTouch(bruce, M5), false);
  assert.equal(mayTouch(bruce, BRUCE), true);
  // No row: nothing a runner key may add to or take from.
  assert.equal(mayTouch(bruce, undefined), false);
  assert.equal(mayTouch(owner, undefined), true);
});

test("Bruce's key claims only ids that have had nothing but Bruce", () => {
  assert.equal(mayClaim(bruce, { claimedBy: [], leftovers: false }), true);
  assert.equal(mayClaim(bruce, { claimedBy: [BRUCE], leftovers: false }), true);
  assert.equal(mayClaim(bruce, { claimedBy: [M5], leftovers: false }), false);
  assert.equal(mayClaim(bruce, { claimedBy: [BRUCE, M5], leftovers: false }), false);
  assert.equal(mayClaim(bruce, { claimedBy: [], leftovers: true }), false);
  assert.equal(mayClaim(owner, { claimedBy: [M5, BRUCE], leftovers: true }), true);
});

test("Bruce's key uses only files its runner uploaded", () => {
  assert.equal(mayUseStorage(bruce, BRUCE), true);
  assert.equal(mayUseStorage(bruce, M5), false);
  // The owner's or the phone's: no record, and nobody's to take.
  assert.equal(mayUseStorage(bruce, undefined), false);
  assert.equal(mayUseStorage(owner, undefined), true);
});

test("Bruce's key can't put a schedule on the M5", () => {
  // A schedule is that Mac running its text with its permissions.
  assert.equal(mayWrite(bruce, M5, undefined), false);
  assert.equal(mayWrite(bruce, BRUCE, M5), false);
  assert.equal(mayTouch(bruce, M5), false); // delete, release, ran, requestRun
});

test("Bruce's key takes only its own commands: never the M5's or \"any\"", () => {
  assert.equal(mayTake(bruce, { runnerId: M5 }), false);
  assert.equal(mayTake(bruce, { runnerId: BRUCE }), true);
  assert.equal(mayTake(bruce, { runnerId: 'any' }), false);
  assert.equal(mayTake(owner, { runnerId: 'any' }), true);
  assert.equal(mayFinish(bruce, { runnerId: M5 }), false);
  assert.equal(mayFinish(bruce, { runnerId: BRUCE }), true);
  assert.equal(mayFinish(bruce, { runnerId: 'any' }), false);
});

test("Bruce's key can't pair a phone, manage keys or read the other runners' threads", () => {
  for (const fn of ['issueToken', 'listTokens', 'revokeToken', 'addRunnerKey', 'listRunnerKeys', 'revokeRunnerKey', 'otherRunnersList', 'threadIndexSince', 'otherRunnersThreads']) {
    assert.equal(mayCall(bruce, fn), false, fn);
    assert.equal(mayCall(owner, fn), true, fn);
  }
  // A function nobody sorted is owner-only.
  assert.equal(mayCall(bruce, 'somethingNew'), false);
});

test('pocket cards: a runner key has only the ones its runner filed', () => {
  assert.equal(ownsCard(bruce, { runnerId: BRUCE }), true);
  assert.equal(ownsCard(bruce, { runnerId: M5 }), false);
  assert.equal(ownsCard(bruce, {}), false);
  assert.equal(ownsCard(owner, {}), true);
});

test('the owner key can do everything', () => {
  for (const fn of Object.keys(ACCESS)) assert.equal(mayCall(owner, fn), true, fn);
  assert.equal(actsAs(owner, M5), true);
  assert.equal(actsAs(owner, BRUCE), true);
  assert.equal(mayWrite(owner, BRUCE, M5), true);
  assert.equal(mayTouch(owner, M5), true);
  assert.equal(mayTake(owner, { runnerId: M5 }), true);
  assert.equal(mayFinish(owner, { runnerId: 'any' }), true);
});

test('every function in convex/sync.ts and convex/relay.ts is sorted, and asks the gate under its own name', () => {
  const src = ['sync.ts', 'relay.ts'].map((f) => fs.readFileSync(path.join(import.meta.dirname, '../../../convex', f), 'utf8')).join('\n');
  const exported = [...src.matchAll(/^export const (\w+) = (?:mutation|query)\(/gm)].map((m) => m[1]!);
  assert.ok(exported.length > 40, 'found the functions');
  assert.deepEqual([...exported].sort(), Object.keys(ACCESS).sort());
  // Each function's body, up to the next export.
  const parts = src.split(/^(?=export const \w+ = (?:mutation|query|internalMutation)\()/m);
  for (const name of exported) {
    const body = parts.find((p) => p.startsWith(`export const ${name} =`))!;
    assert.match(body, new RegExp(`runnerAuth\\(ctx, key, '${name}'\\)`), `${name} asks runnerAuth as '${name}'`);
    assert.doesNotMatch(body, /checkRunnerKey/, `${name} doesn't use the old check`);
  }
});

test("docs/protocol.md's table lists every function as ACCESS sorts it", () => {
  const doc = fs.readFileSync(path.join(import.meta.dirname, '../../../docs/protocol.md'), 'utf8');
  const label = { owner: 'owner only', own: 'its own', shared: 'any runner' } as const;
  for (const [fn, access] of Object.entries(ACCESS)) {
    assert.ok(new RegExp(`\\| \`${fn}\` \\| ${label[access]} \\|`).test(doc), `${fn} in the table as ${label[access]}`);
  }
});

test("the runner tells a runner key's refusal from other errors, over HTTP and from a subscription", async () => {
  const message = "This runner's key can't call issueToken: only the main Mac's key (the deployment's RUNNER_KEY) can.";
  const fetchFn = (async () =>
    new Response(JSON.stringify({ status: 'error', errorMessage: 'Uncaught ConvexError: ...', errorData: { kind: 'forbidden', message } }), { status: 400 })) as unknown as typeof fetch;
  const err = await convexPoster('https://x.convex.cloud', fetchFn)('mutation', 'sync:issueToken', {}).catch((e: unknown) => e);
  assert.equal(forbiddenText(err), message);
  // A subscription error that only has the data as JSON in its text.
  assert.equal(forbiddenText(new Error(`[Request ID: 1] Server Error Uncaught ConvexError: {"kind":"forbidden","message":"no"}`)), 'no');
  assert.equal(forbiddenText(new Error('bad runner key')), undefined);
  assert.equal(forbiddenText(Object.assign(new Error('x'), { data: { kind: 'auth', message: 'bad runner key' } })), undefined);
});

// Daybreak, 7 Nov 2026: another runner's heartbeat startedAt of
// "2026-11-05T01:00:00+////" and its stats' cores of 1e20 each stopped the
// Mac app. The backend keeps them out (sync:heartbeat, sync:setRunnerStats).
test("a runner key's startedAt has to be a time, and its figures in range", () => {
  for (const ok of ['2026-11-05T01:00:00.000Z', '2026-11-05T01:00:00Z', '2026-11-05T01:00:00+01:30', '2026-11-05T01:00:00-0130', '2026-11-05T01:00:00.123456789Z', '2026-11-05T01:00:00']) {
    assert.ok(isIsoTime(ok), ok);
  }
  for (const bad of ['2026-11-05T01:00:00+////', '2026-11-05T01:00:00+0a:00', '2026-11-05T01:00:00+24:00', '2026-13-05T01:00:00Z', 'yesterday', '', '2026-11-05T01:00:00Z ', '2026-11-05T01:00:00Z\n', `2026-11-05T01:00:00.${'1'.repeat(80)}Z`, 42]) {
    assert.ok(!isIsoTime(bad), String(bad));
  }
  assert.ok(wholeIn(3, 10) && wholeIn(0, 10) && !wholeIn(-1, 10) && !wholeIn(1.5, 10) && !wholeIn(11, 10) && !wholeIn(Infinity, 10) && !wholeIn('3', 10));
  const stats = { cpuPercent: 12, cores: 8, memUsed: 1e9, memTotal: 2e9, diskFree: 1e10, diskTotal: 2e10, load1: 1.5, uptimeSec: 3600 };
  assert.equal(badRunnerStats(stats), undefined);
  const { load1: _, ...noLoad } = stats;
  assert.equal(badRunnerStats(noLoad), undefined);
  for (const [field, value] of [['cores', 1e20], ['cores', 8.5], ['cores', -1], ['cpuPercent', 101], ['memUsed', 1e300], ['diskFree', -5], ['uptimeSec', Infinity], ['load1', NaN], ['memTotal', undefined]] as const) {
    assert.match(badRunnerStats({ ...stats, [field]: value }) ?? '', new RegExp(`stats\\.${field}`), `${field} ${value}`);
  }
});
