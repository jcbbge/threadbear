// Usage history (docs/protocol.md): the token tally read from the CLIs'
// transcripts, the limit samples and usage.stats. Temp folders and a fake
// clock only; nothing reads a real transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TokenTally, HOUR_MS } from '../../src/token-tally.ts';
import type { TallyAccount } from '../../src/token-tally.ts';
import { UsageHistory, MAX_GAP_MS } from '../../src/usage-history.ts';
import { UsageStore } from '../../src/usage.ts';
import { usageStatsMethods } from '../../src/usage-stats.ts';
import type { AccountUsage } from '../../src/protocol.ts';
import { RpcError } from '../../src/protocol.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { tmpDir } from '../helpers/fakes.ts';

const NOW = Date.parse('2026-10-29T10:30:00.000Z');
const H = (iso: string) => Date.parse(iso);

function assistant(id: string, at: string, usage: { input?: number; output?: number; read?: number; write?: number }): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      model: 'claude-x',
      content: [{ type: 'text', text: 'hi "type":"assistant"' }],
      usage: { input_tokens: usage.input ?? 0, output_tokens: usage.output ?? 0, cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.write ?? 0 },
    },
  });
}

function tokenCount(at: string, total: { input: number; cached: number; output: number; write?: number } | null): string {
  return JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: total ? { total_token_usage: { input_tokens: total.input, cached_input_tokens: total.cached, cache_write_input_tokens: total.write ?? 0, output_tokens: total.output } } : null,
    },
  });
}

function setup() {
  const home = tmpDir();
  const claudeDir = path.join(home, 'claude-a');
  const codexDir = path.join(home, 'codex-a');
  fs.mkdirSync(path.join(claudeDir, 'projects', 'proj', 'sess', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(codexDir, 'sessions', '2026', '10', '29'), { recursive: true });
  const accounts: TallyAccount[] = [
    { id: 'claude-a', provider: 'claude', configDir: claudeDir },
    { id: 'codex-a', provider: 'codex', configDir: codexDir },
  ];
  const clock = new FakeClock(NOW);
  const data = path.join(home, 'data');
  fs.mkdirSync(data);
  const make = () => new TokenTally({ dataDir: data, clock, log: nullLogger, accounts: () => accounts });
  return { home, claudeDir, codexDir, accounts, clock, data, make };
}

function hoursOf(t: TokenTally, id: string) {
  return t.rows(0).find((r) => r.accountId === id)?.hours ?? [];
}

test('tally: a streamed Claude message written three times counts once, at its biggest', async () => {
  const s = setup();
  const f = path.join(s.claudeDir, 'projects', 'proj', 'a.jsonl');
  fs.writeFileSync(
    f,
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-29T09:00:00Z', message: { content: 'hello' } }),
      assistant('m1', '2026-10-29T09:10:00Z', { input: 10, output: 1, read: 100, write: 5 }),
      assistant('m1', '2026-10-29T09:10:01Z', { input: 10, output: 20, read: 100, write: 5 }),
      assistant('m1', '2026-10-29T09:10:02Z', { input: 10, output: 30, read: 100, write: 5 }),
      assistant('m2', '2026-10-29T10:05:00Z', { input: 1, output: 2, read: 3, write: 4 }),
    ].join('\n') + '\n',
  );
  const t = s.make();
  assert.equal(t.isReady(), false);
  await t.pass();
  assert.equal(t.isReady(), true);
  assert.deepEqual(hoursOf(t, 'claude-a'), [
    [H('2026-10-29T09:00:00Z'), 10, 30, 100, 5],
    [H('2026-10-29T10:00:00Z'), 1, 2, 3, 4],
  ]);
});

test('tally: subagent transcripts count, appended lines are read once, a partial line waits', async () => {
  const s = setup();
  const f = path.join(s.claudeDir, 'projects', 'proj', 'sess', 'subagents', 'agent-1.jsonl');
  fs.writeFileSync(f, assistant('m1', '2026-10-29T10:00:00Z', { input: 5, output: 5 }) + '\n');
  const t = s.make();
  await t.pass();
  assert.deepEqual(hoursOf(t, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 5, 5, 0, 0]]);
  // Nothing new: nothing added.
  await t.pass();
  assert.deepEqual(hoursOf(t, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 5, 5, 0, 0]]);
  // Half a line, then the rest of it.
  const line = assistant('m2', '2026-10-29T10:20:00Z', { input: 1, output: 1 });
  fs.appendFileSync(f, line.slice(0, 40));
  await t.pass();
  assert.deepEqual(hoursOf(t, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 5, 5, 0, 0]]);
  fs.appendFileSync(f, line.slice(40) + '\n');
  await t.pass();
  assert.deepEqual(hoursOf(t, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 6, 6, 0, 0]]);
  // A message streamed across two looks only adds its growth.
  fs.appendFileSync(f, assistant('m2', '2026-10-29T10:20:01Z', { input: 1, output: 9 }) + '\n');
  await t.pass();
  assert.deepEqual(hoursOf(t, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 6, 14, 0, 0]]);
});

test('tally: what it read survives a restart, and a file cut short is read again', async () => {
  const s = setup();
  const f = path.join(s.claudeDir, 'projects', 'proj', 'a.jsonl');
  fs.writeFileSync(f, assistant('m1', '2026-10-29T10:00:00Z', { input: 5 }) + '\n' + assistant('m2', '2026-10-29T10:01:00Z', { input: 5 }) + '\n');
  const t1 = s.make();
  await t1.pass();
  await t1.flushed();
  const t2 = s.make();
  assert.equal(t2.isReady(), true, 'ready is kept');
  await t2.pass();
  assert.deepEqual(hoursOf(t2, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 10, 0, 0, 0]], 'not counted twice');
  fs.writeFileSync(f, assistant('m3', '2026-10-29T10:02:00Z', { input: 1 }) + '\n');
  await t2.pass();
  assert.deepEqual(hoursOf(t2, 'claude-a'), [[H('2026-10-29T10:00:00Z'), 11, 0, 0, 0]]);
});

test('tally: Codex counts each total less the last, with cached input as cache reads', async () => {
  const s = setup();
  const f = path.join(s.codexDir, 'sessions', '2026', '10', '29', 'rollout-x-abc.jsonl');
  fs.writeFileSync(
    f,
    [
      JSON.stringify({ timestamp: '2026-10-29T09:00:00Z', type: 'turn_context', payload: { model: 'gpt-x' } }),
      tokenCount('2026-10-29T09:10:00Z', { input: 1000, cached: 600, output: 50 }),
      tokenCount('2026-10-29T09:10:01Z', null),
      tokenCount('2026-10-29T10:10:00Z', { input: 3000, cached: 2500, output: 80 }),
    ].join('\n') + '\n',
  );
  const t = s.make();
  await t.pass();
  assert.deepEqual(hoursOf(t, 'codex-a'), [
    [H('2026-10-29T09:00:00Z'), 400, 50, 600, 0],
    [H('2026-10-29T10:00:00Z'), 100, 30, 1900, 0],
  ]);
  // Archived: the same session moves to archived_sessions and grows.
  const archived = path.join(s.codexDir, 'archived_sessions', 'rollout-x-abc.jsonl');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(f, archived);
  fs.appendFileSync(archived, tokenCount('2026-10-29T10:20:00Z', { input: 3100, cached: 2500, output: 90 }) + '\n');
  await t.pass();
  assert.deepEqual(hoursOf(t, 'codex-a'), [
    [H('2026-10-29T09:00:00Z'), 400, 50, 600, 0],
    [H('2026-10-29T10:00:00Z'), 200, 40, 1900, 0],
  ]);
});

test('tally: old files are skipped on the first read, old hours are dropped, rows filter by time', async () => {
  const s = setup();
  const old = path.join(s.claudeDir, 'projects', 'proj', 'old.jsonl');
  fs.writeFileSync(old, assistant('o1', '2026-10-01T10:00:00Z', { input: 99 }) + '\n');
  const oldTime = new Date('2026-10-01T10:00:00Z');
  fs.utimesSync(old, oldTime, oldTime);
  const f = path.join(s.claudeDir, 'projects', 'proj', 'a.jsonl');
  fs.writeFileSync(f, assistant('a1', '2026-10-13T10:00:00Z', { input: 7 }) + '\n' + assistant('a2', '2026-10-29T08:00:00Z', { input: 3 }) + '\n');
  const t = s.make();
  await t.pass();
  // 10-13 is more than 15 days before 10-29: its hour isn't kept.
  assert.deepEqual(hoursOf(t, 'claude-a'), [[H('2026-10-29T08:00:00Z'), 3, 0, 0, 0]]);
  s.clock.advance(16 * 24 * HOUR_MS);
  await t.pass();
  assert.deepEqual(t.rows(0), [], 'everything is older than 15 days now');
  await t.flushed();
  const t2 = s.make();
  await t2.pass();
  assert.deepEqual(t2.rows(0), []);
  // rows(since) keeps an hour that ends after `since`.
  const s2 = setup();
  fs.writeFileSync(path.join(s2.claudeDir, 'projects', 'proj', 'b.jsonl'), assistant('b1', '2026-10-29T08:59:00Z', { input: 1 }) + '\n' + assistant('b2', '2026-10-29T10:00:00Z', { input: 2 }) + '\n');
  const t3 = s2.make();
  await t3.pass();
  assert.deepEqual(t3.rows(H('2026-10-29T09:30:00Z'))[0].hours, [[H('2026-10-29T10:00:00Z'), 2, 0, 0, 0]]);
});

test('tally: two logins on the same folder count it once; a stopped tally writes nothing', async () => {
  const s = setup();
  s.accounts.push({ id: 'claude-b', provider: 'claude', configDir: s.claudeDir });
  fs.writeFileSync(path.join(s.claudeDir, 'projects', 'proj', 'a.jsonl'), assistant('m1', '2026-10-29T10:00:00Z', { input: 5 }) + '\n');
  const t = s.make();
  await t.pass();
  assert.deepEqual(t.rows(0).map((r) => r.accountId), ['claude-a']);
  const s2 = setup();
  const t2 = s2.make();
  t2.stopWriting();
  await t2.pass();
  await t2.flushed();
  assert.equal(fs.existsSync(path.join(s2.data, 'token-tally.json')), false);
});

function usage(fiveHour: number, weekly: number): AccountUsage {
  return {
    windows: [
      { kind: 'five_hour', title: '5-hour', remainingPercent: fiveHour },
      { kind: 'weekly', title: 'Weekly', remainingPercent: weekly },
      { kind: 'weekly_model', title: 'Weekly Fable', remainingPercent: 50 },
    ],
    readAt: new Date(NOW).toISOString(),
    source: 'tokenStats',
  };
}

test('history: keeps a sample on a move of half a point, a reset, or every 30 minutes', () => {
  const home = tmpDir();
  const clock = new FakeClock(NOW);
  const h = new UsageHistory({ dataDir: home, clock, log: nullLogger });
  h.observe('a', usage(80, 50));
  clock.advance(60_000);
  h.observe('a', usage(79.8, 50)); // too small for either
  clock.advance(60_000);
  h.observe('a', usage(79.4, 49)); // both moved
  clock.advance(60_000);
  h.observe('a', usage(100, 49)); // a reset
  clock.advance(MAX_GAP_MS);
  h.observe('a', usage(100, 49)); // flat, but 30 minutes on
  h.observe('a', undefined);
  const rows = h.rows(0);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.samples.map((s) => s[1])]),
    [
      ['five_hour', [80, 79.4, 100, 100]],
      ['weekly', [50, 49, 49]],
      // A model's own week goes out with its title, after the main two.
      ['weekly_model', [50, 50]],
    ],
  );
  assert.equal(rows[2].title, 'Weekly Fable');
  assert.equal(rows[0].samples[1][0], NOW + 120_000);
  // Saved (a few seconds after a burst) and read back.
  clock.advance(10_000);
  const again = new UsageHistory({ dataDir: home, clock, log: nullLogger });
  assert.deepEqual(again.rows(0), rows);
  // Older than 8 days goes.
  clock.advance(9 * 24 * HOUR_MS);
  again.observe('a', usage(90, 40));
  assert.deepEqual(again.rows(0).map((r) => r.samples.length), [1, 1, 1]);
});

test('history: UsageStore feeds it, and a draining runner writes nothing', () => {
  const home = tmpDir();
  const clock = new FakeClock(NOW);
  const history = new UsageHistory({ dataDir: home, clock, log: nullLogger });
  const store = new UsageStore({ limitsFile: path.join(home, 'none.json'), dataDir: home, clock, log: nullLogger, history });
  const account = { id: 'claude-a', provider: 'claude' as const, configDir: '/tmp/x' };
  store.usageFor(account);
  store.record('claude-a', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 70 }, { kind: 'weekly', title: 'Weekly', remainingPercent: 60 }] });
  assert.deepEqual(history.rows(0).map((r) => [r.kind, r.samples.map((s) => s[1])]), [['five_hour', [70]], ['weekly', [60]]]);
  store.stopWriting();
  clock.advance(60_000);
  store.record('claude-a', { windows: [{ kind: 'five_hour', title: '5-hour', remainingPercent: 60 }] });
  clock.advance(60_000);
  assert.equal(fs.existsSync(path.join(home, 'usage-history.json')), false);
  assert.deepEqual(history.rows(0)[0].samples.map((s) => s[1]), [70, 60], 'still kept in memory');
});

test('usage.stats: the shape, days filtering both, and bad days', async () => {
  const s = setup();
  fs.writeFileSync(
    path.join(s.claudeDir, 'projects', 'proj', 'a.jsonl'),
    assistant('m1', '2026-10-25T10:00:00Z', { input: 5 }) + '\n' + assistant('m2', '2026-10-29T10:00:00Z', { input: 1, output: 2 }) + '\n',
  );
  const tally = s.make();
  await tally.pass();
  const history = new UsageHistory({ dataDir: s.data, clock: s.clock, log: nullLogger });
  history.observe('claude-a', usage(80, 50));
  const m = usageStatsMethods({ tally, history, clock: s.clock })['usage.stats'];
  const all = m({}) as { generatedAt: string; ready: boolean; tokens: unknown; limits: unknown };
  assert.equal(all.generatedAt, new Date(NOW).toISOString());
  assert.equal(all.ready, true);
  assert.deepEqual(all.tokens, [{ accountId: 'claude-a', hours: [[H('2026-10-25T10:00:00Z'), 5, 0, 0, 0], [H('2026-10-29T10:00:00Z'), 1, 2, 0, 0]] }]);
  assert.deepEqual(all.limits, [
    { accountId: 'claude-a', kind: 'five_hour', samples: [[NOW, 80]] },
    { accountId: 'claude-a', kind: 'weekly', samples: [[NOW, 50]] },
    { accountId: 'claude-a', kind: 'weekly_model', title: 'Weekly Fable', samples: [[NOW, 50]] },
  ]);
  const one = m({ days: 1 }) as { tokens: { hours: unknown[] }[] };
  assert.equal(one.tokens[0].hours.length, 1);
  for (const days of [0, 15, 2.5, '3']) {
    assert.throws(() => m({ days }), (e: unknown) => e instanceof RpcError && e.code === -32602);
  }
});
