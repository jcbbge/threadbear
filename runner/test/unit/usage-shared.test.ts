// Readings other runners took of the same login (docs/protocol.md,
// "Accounts", "Shared readings"): a subscription is one limit wherever it's
// signed in, so the newest reading from any machine counts, window by
// window, as with Token Stats and the runner's own turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { AccountUsage } from '../../src/protocol.ts';
import { UsageStore } from '../../src/usage.ts';
import { loginOk } from '../../src/pools.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { tmpDir } from '../helpers/fakes.ts';

const T0 = Date.parse('2026-11-05T05:00:00.000Z');
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

function store() {
  const dir = tmpDir();
  const clock = new FakeClock(T0);
  const usage = new UsageStore({ limitsFile: path.join(dir, 'none', 'limits.json'), dataDir: dir, clock, log: nullLogger });
  return { usage, clock };
}
const GMAIL = { id: 'claude-main', provider: 'claude' as const, configDir: '/tmp/x', email: 'mike.cann@gmail.com' };
const weekly = (u: AccountUsage | undefined) => u?.windows.find((w) => w.kind === 'weekly')?.remainingPercent;
const reading = (mins: number, week: number, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: week, resetsAt: iso(3 * 24 * 60) }], readAt: iso(mins), source: 'tokenStats', ...extra,
});

test("the Mac's newer reading of the same login wins over the server's old one", () => {
  const { usage, clock } = store();
  // The server's own turn, an hour ago: 97% of the week left.
  usage.record('claude-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 97, resetsAt: iso(3 * 24 * 60) }] });
  clock.advance(60 * 60_000);
  let heard: string[] = [];
  usage.onChange((ids) => (heard = ids));
  usage.usageFor(GMAIL);
  usage.setShared([{ runnerId: 'm5', provider: 'claude', email: 'Mike.Cann@gmail.com', usage: reading(55, 32), byOwnerKey: true }]);
  const u = usage.usageFor(GMAIL);
  assert.equal(weekly(u), 32);
  assert.equal(u?.source, 'shared');
  assert.deepEqual(heard, ['claude-main'], 'clients hear');
  // The server's own next turn is newer again.
  clock.advance(60_000);
  usage.record('claude-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 30, resetsAt: iso(3 * 24 * 60) }] });
  assert.equal(weekly(usage.usageFor(GMAIL)), 30);
});

test('an older reading from elsewhere, another login, or a stale one changes nothing', () => {
  const { usage, clock } = store();
  clock.advance(60 * 60_000);
  usage.record('claude-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 50, resetsAt: iso(3 * 24 * 60) }] });
  usage.setShared([
    { runnerId: 'm5', provider: 'claude', email: 'mike.cann@gmail.com', usage: reading(10, 5), byOwnerKey: true },
    { runnerId: 'm5', provider: 'claude', email: 'mike@gangbusters.io', usage: reading(70, 1), byOwnerKey: true },
    { runnerId: 'm5', provider: 'codex', email: 'mike.cann@gmail.com', usage: reading(70, 1), byOwnerKey: true },
    { runnerId: 'bruce', provider: 'claude', email: 'mike.cann@gmail.com', usage: reading(70, 2, { stale: true }), byOwnerKey: true },
  ]);
  const u = usage.usageFor(GMAIL);
  assert.equal(weekly(u), 50);
  assert.equal(u?.source, 'live');
});

test('a login another machine found at its limit counts as blocked here until it resets', () => {
  const { usage, clock } = store();
  usage.usageFor(GMAIL);
  const atLimit: AccountUsage = { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0, resetsAt: iso(120) }], readAt: iso(5), source: 'live', blocked: true };
  clock.advance(10 * 60_000);
  usage.setShared([{ runnerId: 'm5', provider: 'claude', email: 'mike.cann@gmail.com', usage: atLimit, byOwnerKey: true }]);
  assert.equal(usage.usageFor(GMAIL)?.blocked, true);
  clock.advance(121 * 60_000);
  assert.notEqual(usage.usageFor(GMAIL)?.blocked, true, 'its reset has passed');
});

test('a login with no email known takes nothing from elsewhere', () => {
  const { usage } = store();
  const noEmail = { ...GMAIL, email: undefined };
  usage.setShared([{ runnerId: 'm5', provider: 'claude', email: 'mike.cann@gmail.com', usage: reading(0, 10), byOwnerKey: true }]);
  assert.equal(usage.usageFor(noEmail), undefined);
});

// Gautam's 6 Nov 2026 convex scan, F1: a runner key's reading (one without
// byOwnerKey) said the main Mac's login was out until 2099, and the main
// Mac took it as the newest and blocked the login in its pools. Codex's
// review of the first fix: even as a hint that only filled a window nothing
// else had read, a made-up 5-hour window at 0% kept the login out of its
// pool. Now a reading the main Mac's key didn't write counts for nothing.
const FAKE = (): AccountUsage => ({ windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0, resetsAt: '2099-01-01T00:00:00Z' }], readAt: '2099-01-01T00:00:00Z', source: 'live', blocked: true });
const acct = (u: AccountUsage | undefined) => ({ id: 'claude-main', provider: 'claude', title: 'Main', configDir: '/tmp/x', usage: u }) as any;

test("F1: a runner key's reading never blocks a login, nor wins over this runner's own", () => {
  const { usage, clock } = store();
  usage.record('claude-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 70, resetsAt: iso(3 * 24 * 60) }] });
  clock.advance(10 * 60_000);
  usage.usageFor(GMAIL);
  usage.setShared([{ provider: 'claude', email: 'mike.cann@gmail.com', usage: FAKE() }]);
  const u = usage.usageFor(GMAIL);
  assert.notEqual(u?.blocked, true);
  assert.equal(weekly(u), 70, 'its own reading stands');
  assert.equal(u?.source, 'live');
  assert.ok(Date.parse(u!.readAt) <= clock.now(), 'nothing from 2099');
  assert.equal(loginOk(acct(u)), true, 'so the pool still starts turns on it');
});

test("F1: a runner key's reading doesn't fill in a window nothing else has read, low or full", () => {
  const { usage, clock } = store();
  // A Max plan's login: weekly only.
  usage.record('claude-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 80, resetsAt: iso(3 * 24 * 60) }] });
  clock.advance(60_000);
  usage.setShared([{ provider: 'claude', email: 'mike.cann@gmail.com', usage: { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 0 }], readAt: iso(1), source: 'live' } }]);
  const u = usage.usageFor(GMAIL)!;
  assert.deepEqual(u.windows.map((w) => w.kind), ['weekly']);
  assert.equal(loginOk(acct(u)), true);
  // Nor says a login nobody has read here is full.
  const { usage: fresh } = store();
  fresh.setShared([{ provider: 'claude', email: 'mike.cann@gmail.com', usage: { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100 }], readAt: iso(0), source: 'live' } }]);
  assert.equal(fresh.usageFor(GMAIL), undefined);
});

test("the main Mac's key's reading still counts, and an unmarked one beside it doesn't", () => {
  const { usage, clock } = store();
  usage.record('claude-main', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 90, resetsAt: iso(3 * 24 * 60) }] });
  clock.advance(10 * 60_000);
  const atLimit: AccountUsage = { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0, resetsAt: iso(120) }], readAt: iso(5), source: 'live', blocked: true };
  usage.setShared([
    { provider: 'claude', email: 'mike.cann@gmail.com', usage: atLimit, byOwnerKey: true },
    { provider: 'claude', email: 'mike.cann@gmail.com', usage: { ...FAKE(), blocked: undefined, readAt: iso(9), windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100, resetsAt: iso(3 * 24 * 60) }] } },
  ]);
  const u = usage.usageFor(GMAIL);
  assert.equal(u?.blocked, true);
  assert.equal(weekly(u), 0);
});

test('a reset more than 24.8 days off wakes the store at the timer cap, not every millisecond', () => {
  const dir = tmpDir();
  const delays: number[] = [];
  let now = T0;
  const clock = { now: () => now, setTimeout: (_fn: () => void, ms: number) => (delays.push(ms), { cancel() {} }) };
  const usage = new UsageStore({ limitsFile: path.join(dir, 'none', 'limits.json'), dataDir: dir, clock, log: nullLogger });
  usage.start();
  usage.usageFor(GMAIL);
  usage.record('claude-main', { windows: [{ kind: 'monthly', title: 'Month', remainingPercent: 50, resetsAt: iso(31 * 24 * 60) }] });
  // Once the reading is past going stale, the month's reset is the next thing to wake for.
  now = T0 + 20 * 60_000;
  usage.setShared([]);
  usage.stop();
  assert.ok(delays.length >= 2);
  assert.ok(delays.every((d) => d <= 2 ** 31 - 1), `every delay fits a Node timer: ${delays.join(', ')}`);
});
