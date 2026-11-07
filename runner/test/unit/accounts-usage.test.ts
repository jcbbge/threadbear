// Accounts and usage (step 4, D): Codex discovery, Token Stats' limits.json
// baseline, live readings, merging, persistence and pickAccount. Nothing
// here reads a real auth.json, config.toml or limits.json.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AccountUsage, UsageWindow } from '../../src/protocol.ts';
import { AccountRegistry, discoverAccounts, readCodexConfig } from '../../src/accounts.ts';
import { UsageStore, accountRoom, parseLimitsJson, samePathKey, pickAccount, resetTime, usageLine } from '../../src/usage.ts';
import { ClaudeNormalizer, rateLimitReading } from '../../src/adapters/claude/normalize.ts';
import type { AdapterOutput } from '../../src/adapters/types.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { tmpDir } from '../helpers/fakes.ts';

const FIX = path.join(import.meta.dirname, '..', 'fixtures');
const LIMITS_FIXTURE = fs.readFileSync(path.join(FIX, 'token-stats', 'limits.json'), 'utf8');
// The fixture's generatedAt.
const GENERATED = Date.parse('2026-10-27T03:53:19Z');

// ---- pickAccount: the shared case table ----

type Case = {
  name: string;
  lastUsedId: string | null;
  accounts: { id: string; provider: 'claude' | 'codex'; note?: string; blocked?: boolean; windows?: [UsageWindow['kind'], number][] }[];
  expected: string | null;
};

function caseAccount(a: Case['accounts'][number]): Account {
  const out: Account = { id: a.id, provider: a.provider, title: a.id, configDir: `/tmp/${a.id}` };
  if (a.note) out.note = a.note;
  if (a.windows || a.blocked) {
    out.usage = {
      windows: (a.windows ?? []).map(([kind, remainingPercent]) => ({ kind, title: kind, remainingPercent })),
      readAt: '2026-10-27T03:45:30.000Z',
      source: 'tokenStats',
    };
    if (a.blocked) out.usage.blocked = true;
  }
  return out;
}

const CASES = (JSON.parse(fs.readFileSync(path.join(FIX, 'pick-account-cases.json'), 'utf8')) as { cases: Case[] }).cases;
for (const c of CASES) {
  test(`pickAccount: ${c.name}`, () => {
    assert.equal(pickAccount(c.accounts.map(caseAccount), c.lastUsedId ?? undefined) ?? null, c.expected);
  });
}

test('accountRoom: tighter of 5-hour and weekly, or the only one', () => {
  assert.equal(accountRoom(caseAccount({ id: 'a', provider: 'claude', windows: [['five_hour', 89], ['weekly', 78], ['weekly_model', 2]] })), 78);
  assert.equal(accountRoom(caseAccount({ id: 'a', provider: 'codex', windows: [['weekly', 93]] })), 93);
  assert.equal(accountRoom(caseAccount({ id: 'a', provider: 'claude', windows: [['allowance', 50]] })), undefined);
  assert.equal(accountRoom(caseAccount({ id: 'a', provider: 'claude' })), undefined);
});

// ---- limits.json ----

test("limits.json in today's shape: capitalised providers, Grok and Muse skipped, nulls and fractions", () => {
  const b = parseLimitsJson(JSON.parse(LIMITS_FIXTURE))!;
  assert.equal(b.generatedAt, GENERATED);
  assert.deepEqual(b.accounts.map((a) => a.provider), ['codex', 'claude', 'claude', 'claude', 'claude']);
  const codex = b.accounts[0];
  assert.equal(codex.configDir, samePathKey(path.join(os.homedir(), '.codex')), '~ expanded');
  assert.equal(codex.plan, 'Pro Lite');
  assert.equal(codex.notice, '64,390 credits · 2 limit resets available');
  assert.deepEqual(codex.windows, [{ kind: 'weekly', title: 'Weekly', remainingPercent: 93, resetsAt: '2026-11-02T06:03:07Z' }]);
  const three = b.accounts.find((a) => a.email === 'three@example.com')!;
  assert.deepEqual(three.windows[0], { kind: 'five_hour', title: '5-hour', remainingPercent: 100 }, 'resetsAt null is left out');
  const one = b.accounts.find((a) => a.email === 'one@example.com')!;
  assert.deepEqual(one.windows[3], { kind: 'allowance', title: '$250 allowance', remainingPercent: 53.11612, resetsAt: '2026-11-05T07:59:00Z', detail: '$132.79 left' });
  assert.equal(b.accounts.find((a) => a.email === 'main@example.com')!.notice, undefined, 'notice null');
  assert.equal(parseLimitsJson({ ...JSON.parse(LIMITS_FIXTURE), version: 2 }), undefined, 'another version is not read');
  assert.equal(parseLimitsJson({ version: 1, generatedAt: 'x', accounts: [] }), undefined);
  // Unknown fields and kinds don't break it.
  const odd = parseLimitsJson({ version: 1, generatedAt: '2026-10-27T00:00:00Z', extra: 1, accounts: [{ provider: 'CLAUDE', configDir: '/x', windows: [{ kind: 'hourly', title: 'Hourly', remainingPercent: 120 }, { kind: 'weekly' }] }] })!;
  assert.deepEqual(odd.accounts[0].windows, [{ kind: 'other', title: 'Hourly', remainingPercent: 100 }]);
});

// A temp Token Stats layout: the fixture's /Users/example paths moved
// under root, and the store reading it.
function setup(o: { now?: number; limits?: string } = {}) {
  const root = tmpDir('tb-usage-');
  const dataDir = path.join(root, 'data');
  const tsDir = path.join(root, 'Token Stats');
  fs.mkdirSync(tsDir, { recursive: true });
  const limitsFile = path.join(tsDir, 'limits.json');
  const home = path.join(root, 'home');
  const write = (text: string) => {
    const tmp = limitsFile + '.tmp';
    fs.writeFileSync(tmp, text.replaceAll('/Users/example', home));
    fs.renameSync(tmp, limitsFile);
  };
  write(o.limits ?? LIMITS_FIXTURE);
  const clock = new FakeClock(o.now ?? GENERATED + 60_000);
  const make = () => new UsageStore({ limitsFile, dataDir, clock, log: nullLogger });
  const acct = (id: string, configDir: string, provider: Account['provider'] = 'claude', email?: string): Account => ({ id, provider, title: id, configDir, ...(email ? { email } : {}) });
  const accounts = {
    main: acct('claude-main', path.join(home, '.claude')),
    one: acct('claude-1', path.join(home, 'Library/Application Support/Token Stats/Accounts/claude-1')),
    two: acct('claude-2', path.join(home, 'Library/Application Support/Token Stats/Accounts/claude-2') + '/'),
    three: acct('claude-3', path.join(home, 'Library/Application Support/Token Stats/Accounts/claude-3')),
  };
  return { root, dataDir, limitsFile, home, write, clock, make, acct, accounts };
}

function pct(u: AccountUsage | undefined, kind: string): number | undefined {
  return u?.windows.find((w) => w.kind === kind)?.remainingPercent;
}

test('baseline matched by folder: trailing slash either side, ~, a symlink, or provider and email', () => {
  const s = setup();
  const store = s.make();
  assert.equal(pct(store.usageFor(s.accounts.main), 'weekly'), 13);
  assert.equal(pct(store.usageFor(s.accounts.two), 'five_hour'), 0, 'account path with a trailing slash');
  assert.equal(pct(store.usageFor(s.accounts.three), 'weekly'), 62, "limits.json's path with a trailing slash");
  // "~/.codex" in the file is the home folder's .codex, however the
  // account writes it. Only the path is compared; nothing inside is read.
  const codexHome = path.join(os.homedir(), '.codex');
  assert.equal(pct(store.usageFor(s.acct('codex-main', codexHome + '/', 'codex')), 'weekly'), 93);
  // A symlink to claude-1's folder is the same account.
  fs.mkdirSync(s.accounts.one.configDir, { recursive: true });
  const link = path.join(s.root, 'link-to-one');
  fs.symlinkSync(s.accounts.one.configDir, link);
  assert.equal(pct(store.usageFor(s.acct('claude-1', link)), 'allowance'), 53.11612);
  // A folder limits.json doesn't name: provider plus email.
  assert.equal(pct(store.usageFor(s.acct('claude-9', '/elsewhere', 'claude', 'THREE@example.com')), 'weekly'), 62);
  assert.equal(store.usageFor(s.acct('codex-9', '/elsewhere', 'codex', 'three@example.com')), undefined, 'not across providers');
  assert.equal(store.usageFor(s.acct('claude-9', '/elsewhere')), undefined);
  const u = store.usageFor(s.accounts.one)!;
  assert.equal(u.source, 'tokenStats');
  assert.equal(u.readAt, '2026-10-27T03:53:18.000Z');
  assert.equal(u.notice, '$48.85 extra usage spent');
  assert.equal(u.stale, undefined);
  assert.deepEqual(store.identityFor(s.accounts.one), { email: 'one@example.com', plan: 'Max' });
});

test('newer wins, window by window; a reading with no windows only sets the plan', () => {
  const s = setup();
  const store = s.make();
  store.record('claude-main', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 40, resetsAt: '2026-10-27T08:10:00.000Z' }], blocked: false });
  let u = store.usageFor(s.accounts.main)!;
  assert.equal(pct(u, 'five_hour'), 40, 'the live reading is newer than usageReadAt');
  assert.equal(pct(u, 'weekly'), 13, 'windows the reading lacks keep the baseline');
  assert.equal(pct(u, 'weekly_model'), 97);
  assert.equal(u.source, 'live');
  assert.equal(u.readAt, new Date(s.clock.now()).toISOString());
  // Token Stats writes again, newer than the live reading: it wins.
  s.clock.advance(5 * 60_000);
  const next = JSON.parse(LIMITS_FIXTURE);
  next.generatedAt = new Date(s.clock.now()).toISOString();
  next.accounts.find((a: any) => a.label === '~/.claude').usageReadAt = next.generatedAt;
  next.accounts.find((a: any) => a.label === '~/.claude').windows[0].remainingPercent = 35;
  s.write(JSON.stringify(next));
  store.reload();
  u = store.usageFor(s.accounts.main)!;
  assert.equal(pct(u, 'five_hour'), 35);
  assert.equal(u.source, 'tokenStats');
  // Codex's account/updated: no windows, a plan.
  store.record('codex-1', { windows: [], plan: 'Pro' });
  const codex1 = s.acct('codex-1', '/nowhere', 'codex');
  assert.equal(store.usageFor(codex1), undefined);
  assert.deepEqual(store.identityFor(codex1), { plan: 'Pro' });
});

test('a passed reset is back to 100%, and the store says so when it happens', () => {
  const s = setup();
  const store = s.make();
  store.start();
  try {
    const changes: string[][] = [];
    store.onChange((ids) => changes.push(ids));
    assert.equal(pct(store.usageFor(s.accounts.two), 'five_hour'), 0);
    // claude-2's 5-hour window resets at 05:29:59Z.
    s.clock.advance(Date.parse('2026-10-27T05:30:00Z') - s.clock.now());
    assert.ok(changes.some((ids) => ids.includes('claude-2')), 'reported when the reset passed');
    const w = store.usageFor(s.accounts.two)!.windows.find((x) => x.kind === 'five_hour')!;
    assert.deepEqual(w, { kind: 'five_hour', title: '5-hour', remainingPercent: 100 });
    // The allowance's money left goes with the reset too.
    s.clock.advance(Date.parse('2026-11-06T00:00:00Z') - s.clock.now());
    const a = store.usageFor(s.accounts.one)!.windows.find((x) => x.kind === 'allowance')!;
    assert.deepEqual(a, { kind: 'allowance', title: '$250 allowance', remainingPercent: 100 });
  } finally {
    store.stop();
  }
});

// Anthropic dropped the 5-hour window from Max plans at the end of Oct
// 2026 (Team kept it). The old reading has to go, not show as 100% left.
test('a window that a reading after its reset leaves out is gone', () => {
  const s = setup();
  const store = s.make();
  const nowhere = s.acct('claude-9', '/elsewhere');
  const resets = new Date(s.clock.now() + 3600_000).toISOString();
  store.record('claude-9', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 40, resetsAt: resets }, { kind: 'weekly', title: 'Weekly', remainingPercent: 70 }] });
  // A reading before the reset that leaves it out (the CLI's single-window
  // fallback) doesn't drop it.
  s.clock.advance(30 * 60_000);
  store.record('claude-9', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 69 }] });
  assert.equal(pct(store.usageFor(nowhere), 'five_hour'), 40);
  // Past the reset with nothing newer: full again.
  s.clock.advance(60 * 60_000);
  assert.equal(pct(store.usageFor(nowhere), 'five_hour'), 100);
  // A reading after the reset without it: the login has no such window.
  store.record('claude-9', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 68 }] });
  assert.deepEqual(store.usageFor(nowhere)!.windows.map((w) => w.kind), ['weekly']);
  // Token Stats' newer file without it counts too: claude-main's old live
  // 5-hour window goes once limits.json is read after its reset.
  store.record('claude-main', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 40, resetsAt: new Date(s.clock.now() + 60_000).toISOString() }] });
  s.clock.advance(5 * 60_000);
  const next = JSON.parse(LIMITS_FIXTURE);
  next.generatedAt = new Date(s.clock.now()).toISOString();
  const main = next.accounts.find((a: any) => a.label === '~/.claude');
  main.usageReadAt = next.generatedAt;
  main.windows = main.windows.filter((w: any) => w.kind !== 'five_hour');
  s.write(JSON.stringify(next));
  store.reload();
  assert.equal(pct(store.usageFor(s.accounts.main), 'five_hour'), undefined);
  assert.equal(pct(store.usageFor(s.accounts.main), 'weekly'), 13);
});

test("stale: Token Stats quiet for 15 minutes and no live reading in that time", () => {
  const s = setup();
  const store = s.make();
  store.start();
  try {
    const changes: string[][] = [];
    store.onChange((ids) => changes.push(ids));
    assert.equal(store.usageFor(s.accounts.main)!.stale, undefined);
    assert.equal(store.usageFor(s.accounts.three)!.stale, undefined);
    s.clock.advance(5 * 60_000);
    store.record('claude-3', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 61 }], blocked: false });
    s.clock.advance(11 * 60_000); // 17 minutes after generatedAt
    assert.equal(store.usageFor(s.accounts.main)!.stale, true);
    assert.ok(changes.some((ids) => ids.includes('claude-main')), 'going stale is a change');
    assert.equal(store.usageFor(s.accounts.three)!.stale, undefined, 'a live reading 11 minutes ago');
    s.clock.advance(5 * 60_000);
    assert.equal(store.usageFor(s.accounts.three)!.stale, true);
    assert.equal(store.usageFor(s.acct('codex-7', '/nowhere', 'codex')), undefined, 'no baseline, nothing to be stale');
  } finally {
    store.stop();
  }
});

// The real rate_limit_event shape (CLI through SDK 0.3.310), with made-up
// ids. unifiedWindows isn't in sdk.d.ts.
const RATE_LIMIT_EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1793002800,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.62, resetsAt: 1793002800, status: 'allowed' },
      seven_day: { utilization: 0.05, resetsAt: 1793250000, status: 'allowed' },
    },
  },
  uuid: '00000000-0000-4000-8000-000000000001',
  session_id: '00000000-0000-4000-8000-000000000002',
};

function normalizer(): ClaudeNormalizer {
  const none = () => null;
  return new ClaudeNormalizer({ cwd: '/work', readFile: none, saveImage: () => null, saveBlob: () => '', copyBlob: () => '' } as any);
}

test("Claude's rate_limit_event becomes a limits reading the store keeps", () => {
  const out = normalizer().handle(RATE_LIMIT_EVENT);
  assert.deepEqual(out, [
    {
      kind: 'limits',
      blocked: false,
      windows: [
        { kind: 'five_hour', title: '5-hour', remainingPercent: 38, resetsAt: new Date(1793002800_000).toISOString() },
        { kind: 'weekly', title: 'Weekly', remainingPercent: 95, resetsAt: new Date(1793250000_000).toISOString() },
      ],
    },
  ]);
  // Recorded an hour before its resets, after the fixture's own reading.
  const s = setup();
  const store = s.make();
  const reading = out[0] as Extract<AdapterOutput, { kind: 'limits' }>;
  store.record('claude-3', { ...reading, windows: reading.windows.map((w) => ({ ...w, resetsAt: new Date(s.clock.now() + 3600_000).toISOString() })) });
  const u = store.usageFor(s.accounts.three)!;
  assert.equal(pct(u, 'five_hour'), 38);
  assert.equal(pct(u, 'weekly'), 95);
  assert.equal(pct(u, 'weekly_model'), 84, 'the baseline fills what live readings lack');
  // The documented single window, for a CLI without unifiedWindows.
  assert.deepEqual(rateLimitReading({ status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.9, resetsAt: 1793250000 }), {
    windows: [{ kind: 'weekly_model', title: 'Weekly Opus', remainingPercent: 10, resetsAt: new Date(1793250000_000).toISOString() }],
    blocked: false,
  });
  // Fable's own week, which the CLI calls the overage-included window.
  assert.deepEqual(
    rateLimitReading({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: 1793250000 }, seven_day_overage_included: { utilization: 0.35, resetsAt: 1793250000 } } })?.windows.map((w) => [w.kind, w.title, w.remainingPercent]),
    [['weekly', 'Weekly', 80], ['weekly_model', 'Weekly Fable', 65]],
  );
  assert.deepEqual(rateLimitReading({ status: 'allowed', rateLimitType: 'overage' }), { windows: [], blocked: false });
  assert.equal(rateLimitReading(undefined), undefined);
});

test('a refused login fails the turn as auth, and its made-up reply is dropped', () => {
  const n = normalizer();
  // What Claude Code 2.1.316 sent on Tinker Desk (2 Nov 2026) for an
  // expired login: a synthetic assistant message, then the result.
  const said = n.handle({
    type: 'assistant', error: 'authentication_failed', isApiErrorMessage: true,
    message: { id: 'synthetic-1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
  });
  assert.equal(said.some((o) => o.kind === 'event' && o.event.type === 'assistant.text'), false);
  const [res] = n.handle({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', duration_ms: 851 });
  assert.equal((res as any).result.outcome, 'failed');
  assert.equal((res as any).result.errorKind, 'auth');
  // Per turn, like the limit.
  const [next] = n.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', duration_ms: 5 });
  assert.equal((next as any).result.errorKind, undefined);
  // The words alone are enough.
  const [byText] = normalizer().handle({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', duration_ms: 5 });
  assert.equal((byText as any).result.errorKind, 'auth');
});

test("a turn that couldn't reach the API fails as network; an answer from the API doesn't", () => {
  const kind = (result: string) => (normalizer().handle({ type: 'result', subtype: 'success', is_error: true, result, duration_ms: 5 })[0] as any).result.errorKind;
  // What Mike's threads ended with when his internet went down (3 Nov 2026).
  assert.equal(kind("API Error: Can't reach the API server — check your internet or DNS"), 'network');
  assert.equal(kind("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"), 'network');
  assert.equal(kind('API Error: No internet route — check your connection or VPN (ENETUNREACH)'), 'network');
  assert.equal(kind('API Error: Connection dropped (ECONNRESET)'), 'network');
  assert.equal(kind('API Error: Unable to connect to API. Check your internet connection'), 'network');
  assert.equal(kind('API Error: Request timed out.'), 'network');
  assert.equal(kind('API Error: 500 Internal server error'), undefined);
  assert.equal(kind('API Error: 529 Overloaded'), undefined);
  // Words quoted from somewhere else in a reply aren't the turn's failure.
  assert.equal(kind("The build said: API Error: Can't reach the API server"), undefined);
});

test('a rejected rate limit blocks the account, fails the turn as usageLimit, and ends at the reset', () => {
  const n = normalizer();
  // The 5-hour window resets ten minutes after the fixture was written.
  const reset = Math.floor(GENERATED / 1000) + 600;
  const rejected = {
    ...RATE_LIMIT_EVENT,
    rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset, status: 'rejected' }, seven_day: { utilization: 0.4, resetsAt: reset + 86_400, status: 'allowed' } } },
  };
  const [limits] = n.handle(rejected) as Extract<AdapterOutput, { kind: 'limits' }>[];
  assert.equal(limits.blocked, true);
  const [res] = n.handle({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 7pm", duration_ms: 5 });
  assert.equal(res.kind, 'result');
  assert.equal((res as any).result.outcome, 'failed');
  assert.equal((res as any).result.errorKind, 'usageLimit');
  // The flag is per turn: the next failure is just a failure.
  const [next] = n.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', duration_ms: 5 });
  assert.equal((next as any).result.errorKind, undefined);
  // The message alone is enough, for a CLI that sent no event first.
  const [byText] = normalizer().handle({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1793002800', duration_ms: 5 });
  assert.equal((byText as any).result.errorKind, 'usageLimit');

  const s = setup({ now: GENERATED + 1000 });
  const store = s.make();
  store.start();
  try {
    const changes: string[][] = [];
    store.onChange((ids) => changes.push(ids));
    store.usageFor(s.accounts.three);
    store.record('claude-3', limits);
    let u = store.usageFor(s.accounts.three)!;
    assert.equal(u.blocked, true);
    assert.equal(pct(u, 'five_hour'), 0);
    assert.match(usageLine(u, s.clock.now()), /^limit reached, resets /);
    s.clock.advance(reset * 1000 - s.clock.now());
    u = store.usageFor(s.accounts.three)!;
    assert.equal(u.blocked, undefined, 'the window that blocked it has reset');
    assert.equal(pct(u, 'five_hour'), 100);
    assert.ok(changes.filter((ids) => ids.includes('claude-3')).length >= 2);
    // A later reading that's allowed clears a block with no reset known.
    store.record('claude-3', { windows: [], blocked: true });
    assert.equal(store.usageFor(s.accounts.three)!.blocked, true);
    store.record('claude-3', { windows: [], blocked: false });
    assert.equal(store.usageFor(s.accounts.three)!.blocked, undefined);
  } finally {
    store.stop();
  }
});

// What section B makes of Codex's account/rateLimits/read (the real 0.164.0
// shape, Pro Lite: primary weekly, secondary null) plus a second, non-codex
// bucket: the codex weekly window, and the other bucket as an extra window
// titled from its limit name. Credits go in detail.
const CODEX_READ = {
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1793599387 }, secondary: null, planType: 'prolite', rateLimitReachedType: null },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1793599387 }, secondary: null, planType: 'prolite', rateLimitReachedType: null },
    codex_image: { limitId: 'codex_image', limitName: 'Images', primary: { usedPercent: 25, windowDurationMins: 1440, resetsAt: 1793100000 }, secondary: null, planType: 'prolite', rateLimitReachedType: null },
  },
};

test('Codex readings: weekly only, an extra bucket beside it, merged over the baseline', () => {
  const codexWeekly: UsageWindow = { kind: 'weekly', title: 'Weekly', remainingPercent: 100 - CODEX_READ.rateLimits.primary.usedPercent, resetsAt: new Date(CODEX_READ.rateLimits.primary.resetsAt * 1000).toISOString(), detail: '64,390 credits' };
  const images = CODEX_READ.rateLimitsByLimitId.codex_image;
  const imageWindow: UsageWindow = { kind: 'other', title: images.limitName, remainingPercent: 100 - images.primary.usedPercent, resetsAt: new Date(images.primary.resetsAt * 1000).toISOString() };
  const s = setup();
  const store = s.make();
  const codex = s.acct('codex-main', path.join(os.homedir(), '.codex'), 'codex');
  store.record('codex-main', { windows: [codexWeekly, imageWindow], blocked: false, plan: 'Pro Lite' });
  // A second other bucket is its own window, not a replacement.
  store.record('codex-main', { windows: [{ kind: 'other', title: 'Spark', remainingPercent: 50 }] });
  const u = store.usageFor(codex)!;
  assert.deepEqual(u.windows.map((w) => [w.kind, w.title, w.remainingPercent]), [['weekly', 'Weekly', 95], ['other', 'Images', 75], ['other', 'Spark', 50]]);
  assert.equal(u.notice, '64,390 credits · 2 limit resets available');
  assert.equal(accountRoom({ ...codex, usage: u }), 95, 'only the weekly window is room');
  assert.equal(usageLine(u, s.clock.now()).split(',')[0], 'weekly 95% left');
});

test('usage.json keeps live readings across a restart', () => {
  const s = setup();
  const a = s.make();
  a.record('claude-main', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 41 }], blocked: false, email: 'live@example.com' });
  const saved = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'usage.json'), 'utf8'));
  assert.equal(saved.version, 1);
  const b = s.make();
  assert.equal(pct(b.usageFor(s.accounts.main), 'five_hour'), 41, 'numbers straight away');
  assert.deepEqual(b.identityFor(s.acct('claude-main', '/nowhere')), { email: 'live@example.com' });
  // A broken usage.json is ignored.
  fs.writeFileSync(path.join(s.dataDir, 'usage.json'), '{ nope');
  assert.equal(pct(s.make().usageFor(s.accounts.main), 'five_hour'), 86);
});

test('a new limits.json is picked up by the 60-second check', () => {
  const s = setup();
  const store = s.make();
  store.start();
  try {
    const changes: string[][] = [];
    store.onChange((ids) => changes.push(ids));
    store.usageFor(s.accounts.main);
    const next = JSON.parse(LIMITS_FIXTURE);
    next.accounts.find((a: any) => a.label === '~/.claude').windows[1].remainingPercent = 12;
    s.write(JSON.stringify(next));
    // Synchronously, before any watch event can arrive: only the poll runs.
    s.clock.advance(60_000);
    assert.equal(pct(store.usageFor(s.accounts.main), 'weekly'), 12);
    assert.deepEqual(changes, [['claude-main']]);
    // A half-written or foreign file leaves the last good numbers.
    fs.writeFileSync(s.limitsFile, '{ "version": 1, ');
    s.clock.advance(60_000);
    assert.equal(pct(store.usageFor(s.accounts.main), 'weekly'), 12);
  } finally {
    store.stop();
  }
});

test('a new limits.json is picked up by the folder watch', async () => {
  const s = setup();
  const store = s.make();
  store.start();
  try {
    store.usageFor(s.accounts.main);
    const changed = new Promise<string[]>((resolve) => store.onChange(resolve));
    const next = JSON.parse(LIMITS_FIXTURE);
    next.accounts.find((a: any) => a.label === '~/.claude').windows[1].remainingPercent = 11;
    s.write(JSON.stringify(next));
    // FSEvents can drop a write made just after the watch starts, more so on
    // a busy Mac, so write it again until the watch sees one.
    const again = setInterval(() => s.write(JSON.stringify(next)), 1_000);
    let timer: NodeJS.Timeout | undefined;
    const ids = await Promise.race([changed, new Promise<null>((r) => (timer = setTimeout(() => r(null), 15_000)))]);
    clearInterval(again);
    clearTimeout(timer);
    assert.deepEqual(ids, ['claude-main'], 'no poll ran (fake clock), so the watch did it');
    assert.equal(pct(store.usageFor(s.accounts.main), 'weekly'), 11);
  } finally {
    store.stop();
  }
});

test('a missing limits.json: live readings only, and it is read once it appears', () => {
  const s = setup();
  fs.rmSync(s.limitsFile);
  const store = s.make();
  store.start();
  try {
    assert.equal(store.usageFor(s.accounts.main), undefined);
    s.write(LIMITS_FIXTURE);
    s.clock.advance(60_000);
    assert.equal(pct(store.usageFor(s.accounts.main), 'weekly'), 13);
  } finally {
    store.stop();
  }
});

test('live readings that move less than a point are not a change', () => {
  const s = setup();
  const store = s.make();
  const changes: string[][] = [];
  store.onChange((ids) => changes.push(ids));
  store.usageFor(s.accounts.main);
  store.record('claude-main', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 85.5, resetsAt: '2026-10-27T08:10:00Z' }], blocked: false });
  assert.deepEqual(changes, [], '86 to 85.5');
  store.record('claude-main', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 84.9, resetsAt: '2026-10-27T08:10:00Z' }], blocked: false });
  assert.deepEqual(changes, [['claude-main']]);
  // An account nobody has listed yet is still reported.
  store.record('claude-7', { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 50 }] });
  assert.deepEqual(changes.at(-1), ['claude-7']);
});

test('usageLine', () => {
  const now = new Date(2026, 9, 27, 9, 0).getTime(); // a Tuesday, local time
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const u = (windows: UsageWindow[], extra: Partial<AccountUsage> = {}): AccountUsage => ({ windows, readAt: new Date(now).toISOString(), source: 'tokenStats', ...extra });
  assert.equal(
    usageLine(u([{ kind: 'five_hour', title: '5-hour', remainingPercent: 89.4, resetsAt: at(27, 15, 40) }, { kind: 'weekly', title: 'Weekly', remainingPercent: 78, resetsAt: at(29, 13) }, { kind: 'weekly_model', title: 'Weekly Fable', remainingPercent: 5 }]), now),
    '5-hour 89% left, weekly 78% left, resets Thu 1 pm',
  );
  assert.equal(usageLine(u([{ kind: 'five_hour', title: '5-hour', remainingPercent: 20, resetsAt: at(27, 15, 40) }, { kind: 'weekly', title: 'Weekly', remainingPercent: 78 }]), now), '5-hour 20% left, weekly 78% left, resets 3:40 pm');
  assert.equal(usageLine(u([{ kind: 'weekly', title: 'Weekly', remainingPercent: 93, resetsAt: new Date(2026, 10, 5, 6).toISOString() }]), now), 'weekly 93% left, resets 5 Nov 6 am');
  assert.equal(usageLine(u([{ kind: 'five_hour', title: '5-hour', remainingPercent: 0, resetsAt: at(27, 15, 40) }], { blocked: true }), now), 'limit reached, resets 3:40 pm');
  assert.equal(usageLine(u([{ kind: 'weekly', title: 'Weekly', remainingPercent: 50 }], { stale: true, readAt: new Date(2026, 9, 27, 6, 2).toISOString() }), now), 'weekly 50% left (as of 6:02 am)');
  assert.equal(usageLine(undefined), 'usage unknown');
  assert.equal(resetTime(at(28, 0, 5), now), 'Wed 12:05 am');
});

// ---- discovery ----

function discoveryRoot() {
  const root = tmpDir('tb-disc-');
  const main = path.join(root, 'dot-claude');
  fs.mkdirSync(main);
  const accts = path.join(root, 'Accounts');
  const codexMain = path.join(root, 'dot-codex');
  fs.mkdirSync(codexMain);
  return { root, main, accts, codexMain, cfg: { claudeMainDir: main, claudeMainJson: path.join(root, 'claude.json'), tokenStatsAccountsDir: accts, codexMainDir: codexMain, accountNotes: { 'claude-2': 'Convex work only' } } };
}

test('Codex logins: auth.json exists (never opened) or the Keychain store, in ~/.codex and codex-N', () => {
  const d = discoveryRoot();
  fs.writeFileSync(path.join(d.codexMain, 'auth.json'), '');
  for (const n of ['codex-1', 'codex-2', 'codex-3', 'codex-x', 'claude-2']) fs.mkdirSync(path.join(d.accts, n), { recursive: true });
  fs.writeFileSync(path.join(d.accts, 'codex-1', 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  fs.writeFileSync(path.join(d.accts, 'codex-2', 'config.toml'), 'cli_auth_credentials_store = "file"\n'); // file store, no auth.json
  fs.writeFileSync(path.join(d.accts, 'codex-3', 'config.toml'), '[x]\ncli_auth_credentials_store = "auto"\n'); // inside a table
  fs.writeFileSync(path.join(d.accts, 'codex-x', 'auth.json'), '');
  const found = discoverAccounts(d.cfg);
  assert.deepEqual(found.map((a) => [a.id, a.provider, a.title]), [
    ['claude-main', 'claude', 'claude-main'],
    ['claude-2', 'claude', 'claude-2'],
    ['codex-main', 'codex', 'Codex · codex-main'],
    ['codex-1', 'codex', 'Codex · codex-1'],
  ]);
  assert.equal(found.find((a) => a.id === 'claude-2')!.note, 'Convex work only');
  assert.equal(found.find((a) => a.id === 'codex-main')!.configDir, d.codexMain);
  // No codexMainDir (an older config shape): no codex-main.
  assert.ok(!discoverAccounts({ ...d.cfg, codexMainDir: undefined }).some((a) => a.id === 'codex-main'));
  // An empty ~/.codex isn't a login.
  fs.rmSync(path.join(d.codexMain, 'auth.json'));
  assert.ok(!discoverAccounts(d.cfg).some((a) => a.id === 'codex-main'));
});

test("Codex defaults from config.toml's top-level keys only", () => {
  const d = discoveryRoot();
  fs.writeFileSync(path.join(d.codexMain, 'auth.json'), '');
  fs.writeFileSync(
    path.join(d.codexMain, 'config.toml'),
    [
      '# top',
      'model = "gpt-6.1-sol"   # a comment',
      "model_reasoning_effort = 'high'",
      'approval_policy = "never"',
      '',
      '[profiles.fast]',
      'model = "gpt-6-luna"',
      'model_reasoning_effort = "low"',
      '[mcp_servers.x]',
      'env = { TOKEN = "SHOULD-NOT-APPEAR" }',
    ].join('\n'),
  );
  assert.deepEqual(readCodexConfig(path.join(d.codexMain, 'config.toml')), { model: 'gpt-6.1-sol', effort: 'high' });
  const codex = discoverAccounts(d.cfg).find((a) => a.id === 'codex-main')!;
  assert.equal(codex.defaultModel, 'gpt-6.1-sol');
  assert.equal(codex.defaultEffort, 'high');
  assert.ok(!JSON.stringify(codex).includes('SHOULD-NOT-APPEAR'));
  // An effort Threadbear doesn't know is left out; a table before the keys hides them.
  fs.writeFileSync(path.join(d.codexMain, 'config.toml'), 'model_reasoning_effort = "minimal"\n');
  assert.deepEqual(readCodexConfig(path.join(d.codexMain, 'config.toml')), {});
  fs.writeFileSync(path.join(d.codexMain, 'config.toml'), '[features]\nmodel = "gpt-6-luna"\n');
  assert.deepEqual(readCodexConfig(path.join(d.codexMain, 'config.toml')), {});
  assert.deepEqual(readCodexConfig(path.join(d.root, 'missing.toml')), {});
  // A turn's model corrects config.toml's, as for Claude.
  const registry = new AccountRegistry(d.cfg);
  registry.list();
  registry.learn('codex-main', { defaultModel: 'gpt-6-luna' });
  assert.equal(registry.get('codex-main')!.defaultModel, 'gpt-6-luna');
});

test('registry: titles, email and plan from limits.json, usage on every account, rescans reported', () => {
  const d = discoveryRoot();
  fs.writeFileSync(path.join(d.codexMain, 'auth.json'), '');
  // .claude.json once held a stale address; limits.json's comes from the profile.
  fs.writeFileSync(path.join(d.root, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.com' } }));
  fs.mkdirSync(path.join(d.accts, 'claude-2'), { recursive: true });
  fs.writeFileSync(path.join(d.accts, 'claude-2', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two-local@example.com' } }));
  const limits = JSON.parse(LIMITS_FIXTURE);
  limits.accounts.find((a: any) => a.label === '~/.claude').configDir = d.main;
  limits.accounts.find((a: any) => a.label === '~/.codex').configDir = d.codexMain + '/';
  const limitsFile = path.join(d.root, 'limits.json');
  fs.writeFileSync(limitsFile, JSON.stringify(limits));
  const clock = new FakeClock(GENERATED + 60_000);
  const usage = new UsageStore({ limitsFile, dataDir: path.join(d.root, 'data'), clock, log: nullLogger });
  const registry = new AccountRegistry(d.cfg, usage);
  const list = registry.list();
  const main = list.find((a) => a.id === 'claude-main')!;
  assert.equal(main.title, 'main@example.com');
  assert.equal(main.email, 'main@example.com');
  assert.equal(main.plan, 'Max');
  assert.equal(pct(main.usage, 'weekly'), 13);
  const codex = list.find((a) => a.id === 'codex-main')!;
  assert.equal(codex.title, 'Codex · codex@example.com');
  assert.equal(codex.plan, 'Pro Lite');
  assert.equal(pct(codex.usage, 'weekly'), 93);
  const two = list.find((a) => a.id === 'claude-2')!;
  assert.equal(two.title, 'two-local@example.com', 'not in limits.json by folder or email: .claude.json');
  assert.equal(two.note, 'Convex work only');
  assert.equal(two.usage, undefined);
  // Live readings show on the next list without a rescan.
  usage.record('claude-main', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 50 }], blocked: false });
  assert.equal(pct(registry.get('claude-main')!.usage, 'five_hour'), 50);
  // pickAccount over the real list: claude-main (13% weekly) and claude-2
  // (noted, no usage) leave the last-used one.
  assert.equal(pickAccount(registry.list(), 'claude-main'), 'claude-main');

  // A rescan that finds a new login is reported.
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const seen: Account[][] = [];
    registry.onChange((accounts) => seen.push(accounts));
    registry.list();
    mock.timers.tick(11_000);
    registry.list();
    assert.equal(seen.length, 0, 'same list, no change');
    fs.mkdirSync(path.join(d.accts, 'claude-3'));
    mock.timers.tick(11_000);
    registry.list();
    assert.equal(seen.length, 1);
    assert.ok(seen[0].some((a) => a.id === 'claude-3'));
  } finally {
    mock.timers.reset();
  }
});
