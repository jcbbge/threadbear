import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { describeAt, describeCron, nextRuns, parseCron } from '../../src/cron.ts';
import { Scheduler, scheduleMethods, type ScheduleBackend, type StoredSchedule } from '../../src/schedules.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { ErrorCode, RpcError } from '../../src/protocol.ts';
import { nullLogger } from '../../src/log.ts';
import { readRunnerJson } from '../../src/config.ts';
import { toOwnedScheduleDoc, SCHEDULE_POOLS_API_VERSION } from '../../src/sync.ts';
import { keptCheckFile } from '../../src/schedule-check.ts';

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const runs = (cron: string, from: string, zone: string, n = 3) => nextRuns(parseCron(cron), Date.parse(from), zone, n).map(iso);

// ------------------------------------------------------------------- cron

test('cron: the common shapes in words', () => {
  const words = (c: string) => describeCron(parseCron(c));
  assert.equal(words('0 9 * * 1-5'), 'Weekdays at 9:00');
  assert.equal(words('30 7 * * 0,6'), 'Weekends at 7:30');
  assert.equal(words('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(words('* * * * *'), 'Every minute');
  assert.equal(words('@hourly'), 'Every hour');
  assert.equal(words('5 * * * *'), 'Every hour at :05');
  assert.equal(words('0 */2 * * *'), 'Every 2 hours');
  assert.equal(words('@daily'), 'Every day at 0:00');
  assert.equal(words('0 9,17 * * mon,wed'), 'Every Monday and Wednesday at 9:00 and 17:00');
  assert.equal(words('0 9 1 * *'), 'On the 1st of every month at 9:00');
  assert.equal(words('0 9 1 jan *'), 'On the 1st of January at 9:00');
  assert.equal(words('7-9 3 * * *'), 'Cron 7-9 3 * * *');
  assert.equal(describeCron(parseCron('0 9 * * 1-5'), 'Australia/Perth'), 'Weekdays at 9:00 (Australia/Perth)');
  assert.equal(describeAt(Date.parse('2026-10-28T07:30:00Z'), 'Australia/Perth', Date.parse('2026-10-26T00:00:00Z')), 'Once, Wed 28 Oct at 15:30');
  assert.equal(describeAt(Date.parse('2027-01-02T07:30:00Z'), 'UTC', Date.parse('2026-10-26T00:00:00Z')), 'Once, Sat 2 Jan 2027 at 7:30');
});

test('cron: next runs in a zone', () => {
  // 12:00 UTC on Monday 26 Oct is 20:00 in Perth, so the next weekday 9:00 is Tuesday's.
  assert.deepEqual(runs('0 9 * * 1-5', '2026-10-26T12:00:00Z', 'Australia/Perth'), [
    '2026-10-27T01:00:00.000Z',
    '2026-10-28T01:00:00.000Z',
    '2026-10-29T01:00:00.000Z',
  ]);
  assert.deepEqual(runs('*/20 * * * *', '2026-10-26T12:05:00Z', 'UTC'), ['2026-10-26T12:20:00.000Z', '2026-10-26T12:40:00.000Z', '2026-10-26T13:00:00.000Z']);
  // Strictly after: a run due right now is the next one's.
  assert.deepEqual(runs('0 12 * * *', '2026-10-26T12:00:00Z', 'UTC', 1), ['2026-10-27T12:00:00.000Z']);
  // Both day fields restricted: either matches (the 13th, or a Friday).
  assert.deepEqual(runs('0 0 13 * 5', '2026-11-01T00:00:00Z', 'UTC', 3), ['2026-11-06T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '2026-11-20T00:00:00.000Z']);
  // 7 is Sunday too.
  assert.deepEqual(runs('0 0 * * 7', '2026-10-26T00:00:00Z', 'UTC', 1), ['2026-11-01T00:00:00.000Z']);
  assert.deepEqual(runs('0 0 30 2 *', '2026-10-26T00:00:00Z', 'UTC'), [], '30 February never comes');
});

test('cron: daylight saving, skipped and repeated times', () => {
  // Sydney jumps from 2:00 to 3:00 on 4 Oct 2026: that day's 2:30 runs at 3:00.
  const syd = runs('30 2 * * *', '2026-10-02T00:00:00Z', 'Australia/Sydney').map((t) =>
    new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit', day: 'numeric', hour12: false }),
  );
  assert.deepEqual(syd, ['3, 02:30', '4, 03:00', '5, 02:30']);
  // New York's 1:00 to 2:00 happens twice on 1 Nov 2026: 1:30 runs once, the first time.
  assert.deepEqual(runs('30 1 * * *', '2026-10-31T00:00:00Z', 'America/New_York', 3), [
    '2026-10-31T05:30:00.000Z',
    '2026-11-01T05:30:00.000Z',
    '2026-11-02T06:30:00.000Z',
  ]);
});

test('cron: mistakes say what is wrong', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /Minute 61 is out of range/);
  assert.throws(() => parseCron('0 9 * * funday'), /Can't read "funday"/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
  assert.throws(() => parseCron('0 17-9 * * *'), /backwards/);
});

// -------------------------------------------------------------- scheduler

function setup(h = makeHarness()) {
  const updates: unknown[] = [];
  h.runner.onNotification((n) => n.method === 'schedules.updated' && updates.push(n.params));
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC' });
  sched.start();
  return { h, sched, updates };
}

function idleThread(h: ReturnType<typeof makeHarness>) {
  const { thread } = h.runner.create({ text: 'Watch the deploy', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.result('completed');
  return { thread, s };
}

test('a one-off sends to its thread when due, says it was scheduled, then is done', async () => {
  const { h, sched, updates } = setup();
  const { thread, s } = idleThread(h);
  const sc = await sched.create({ text: 'Check the deploy again', at: iso(h.clock.now() + 10 * MIN), threadId: thread.id });
  assert.equal(sc.title, 'Check the deploy again');
  assert.equal(sc.whenText, 'Once, Mon 26 Oct at 12:10');
  assert.equal(sc.nextRunAt, '2026-10-26T12:10:00.000Z');
  assert.equal(updates.length, 1);

  h.clock.advance(9 * MIN);
  assert.equal(s.sent.length, 1, 'not yet');
  h.clock.advance(MIN);
  await tick();
  const msg = h.events(thread.id).filter((e) => e.type === 'user.message').at(-1);
  assert.equal(msg.origin, 'schedule');
  assert.equal(msg.scheduleId, sc.id);
  assert.equal(msg.text, '[Scheduled: "Check the deploy again", Once, Mon 26 Oct at 12:10]\n\nCheck the deploy again');
  assert.equal(s.sent.at(-1)?.text, msg.text);

  const done = sched.find(sc.id);
  assert.equal(done.runs, 1);
  assert.equal(done.nextRunAt, undefined);
  assert.equal(done.finishedAt, '2026-10-26T12:10:00.000Z');
  assert.deepEqual(done.lastRun, { at: '2026-10-26T12:10:00.000Z', outcome: 'sent', threadId: thread.id });

  // Kept on disk, and gone a week later.
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'schedules.json'), 'utf8'));
  assert.equal(saved.schedules[0].id, sc.id);
  assert.equal(saved.schedules[0].whenText, undefined, 'whenText is worked out, not stored');
  h.clock.advance(8 * 86_400_000);
  assert.deepEqual(sched.list(), []);
  sched.stop();
});

test('a schedule for a busy thread waits for its turn to end rather than joining it', async () => {
  const { h, sched } = setup();
  const { thread } = h.runner.create({ text: 'Long job', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  // An `at` already passed runs straight away.
  await sched.create({ text: 'Status?', at: iso(h.clock.now() - MIN), threadId: thread.id });
  await tick();
  assert.equal(s.sent.length, 1, 'not steered into the running turn');
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message').length, 1);
  s.result('completed');
  await tick();
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1].text, /^\[Scheduled: "Status\?"/);
  sched.stop();
});

test('a cron starts a new thread each time, and skips a run while the last thread is still going', async () => {
  const { h, sched } = setup();
  const sc = await sched.create({ text: 'Summarise my inbox', title: 'Inbox summary', cron: '*/30 * * * *', accountId: 'claude-3', model: 'claude-haiku-5-5' });
  assert.equal(sc.cwd, h.cfg.defaults.cwd);
  assert.equal(sc.whenText, 'Every 30 minutes');
  assert.equal(sc.nextRunAt, '2026-10-26T12:30:00.000Z');

  h.clock.advance(30 * MIN);
  await tick();
  const first = h.runner.list().find((t) => t.title === 'Inbox summary');
  assert.ok(first, 'a new thread with the schedule title');
  assert.equal(first.accountId, 'claude-3');
  assert.equal(first.model, 'claude-haiku-5-5');
  assert.equal(h.events(first.id)[0].origin, 'schedule');
  // The thread remembers the schedule that started it, even once renamed.
  assert.deepEqual(first.schedule, { id: sc.id, title: 'Inbox summary' });
  h.runner.update({ threadId: first.id, title: 'Renamed' });
  assert.deepEqual(h.runner.get(first.id).schedule, { id: sc.id, title: 'Inbox summary' });
  assert.equal(sched.find(sc.id).nextRunAt, '2026-10-26T13:00:00.000Z');

  // Still running at 13:00: skipped.
  h.clock.advance(30 * MIN);
  await tick();
  assert.equal(h.runner.list().filter((t) => t.schedule?.id === sc.id).length, 1);
  assert.equal(sched.find(sc.id).lastRun?.outcome, 'skipped');

  h.adapter.last.init();
  h.adapter.last.result('completed');
  h.clock.advance(30 * MIN);
  await tick();
  assert.equal(h.runner.list().filter((t) => t.schedule?.id === sc.id).length, 2);
  assert.equal(sched.find(sc.id).runs, 2);
  sched.stop();
});

test('runs missed while the runner was stopped happen once, then the cron carries on from now', async () => {
  const { h, sched } = setup();
  const { thread } = idleThread(h);
  const sc = await sched.create({ text: 'ping', cron: '*/5 * * * *', threadId: thread.id });
  sched.stop();
  h.clock.advance(2 * 60 * MIN);
  const again = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC' });
  again.start();
  await tick();
  // The CLI was let go while idle, so count the thread's messages, not one session's.
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message').length, 2, 'one catch-up run, not 24');
  assert.equal(again.find(sc.id).nextRunAt, '2026-10-26T14:05:00.000Z');
  again.stop();
});

test('while the runner is restarting a due run waits', async () => {
  const { h, sched } = setup();
  const { thread, s } = idleThread(h);
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  const sc = await sched.create({ text: 'later', at: iso(h.clock.now() + MIN), threadId: thread.id });
  h.clock.advance(2 * MIN);
  assert.equal(s.sent.length, 1);
  const still = sched.find(sc.id);
  assert.equal(still.nextRunAt, sc.nextRunAt, 'still due');
  assert.equal(still.lastRun, undefined);
  sched.stop();
});

test('a failed run says why, and deleting the thread deletes its schedules', async () => {
  const { h, sched } = setup();
  const { thread } = idleThread(h);
  const dir = path.join(h.home, 'gone-soon');
  fs.mkdirSync(dir);
  const job = await sched.create({ text: 'build', cron: '@hourly', cwd: dir, accountId: 'claude-3' });
  fs.rmSync(dir, { recursive: true });
  h.clock.advance(60 * MIN);
  const failed = sched.find(job.id);
  assert.equal(failed.lastRun?.outcome, 'failed');
  assert.match(failed.lastRun?.note ?? '', /Folder not found/);
  assert.equal(failed.nextRunAt, '2026-10-26T14:00:00.000Z', 'carries on next time');

  await sched.create({ text: 'a', cron: '@daily', threadId: thread.id });
  assert.equal(sched.list(thread.id).length, 1);
  h.runner.delete(thread.id);
  assert.equal(sched.list(thread.id).length, 0);
  assert.equal(sched.list().length, 1);
  sched.stop();
});

test('pause, resume, edit and run now', async () => {
  const { h, sched } = setup();
  const { thread, s } = idleThread(h);
  const sc = await sched.create({ text: 'standup notes', cron: '0 9 * * 1-5', threadId: thread.id });
  assert.equal((await sched.update({ scheduleId: sc.id.slice(0, 6), paused: true })).nextRunAt, undefined);
  const ran = await sched.runNow(sc.id);
  await tick();
  assert.equal(ran.threadId, thread.id);
  assert.equal(s.sent.length, 2, 'run now works while paused');
  const resumed = await sched.update({ scheduleId: sc.id, paused: false });
  assert.equal(resumed.nextRunAt, '2026-10-27T09:00:00.000Z');
  const once = await sched.update({ scheduleId: sc.id, at: '2026-10-26T15:00:00Z' });
  assert.equal(once.cron, undefined);
  assert.equal(once.nextRunAt, '2026-10-26T15:00:00.000Z');
  await assert.rejects(sched.update({ scheduleId: sc.id, cwd: '/tmp' }), /sends to a thread/);
  await sched.delete(sc.id);
  assert.throws(() => sched.find(sc.id), (e: unknown) => e instanceof RpcError && e.code === ErrorCode.scheduleNotFound);
  sched.stop();
});

// The standup that needed the login with Slack (5 Nov): a pool lets a
// schedule's threads start on whichever of its logins has room.
test('a new-thread schedule can run on a pool instead of one login', async () => {
  const { h, sched } = setup();
  const m = scheduleMethods(sched);
  const before = readRunnerJson(h.home).defaults ?? {};
  const pools = h.runner.hello().pools.map((x) => x.id);
  assert.ok(pools.includes('claude'), `the harness has a claude pool: ${pools.join(', ')}`);
  await assert.rejects(sched.create({ text: 'x', cron: '@daily', poolId: 'nope' }), /No pool called nope/);
  await assert.rejects(sched.create({ text: 'x', cron: '@daily', poolId: 'claude', accountId: 'claude-3' }), /not both/);

  const sc = await sched.create({ text: 'Draft the standup', cron: '0 9 * * 1-5', poolId: 'claude' });
  assert.equal(sc.poolId, 'claude');
  const ran = await sched.runNow(sc.id);
  const t = h.runner.get(ran.threadId!);
  assert.equal(t.poolId, 'claude', 'its thread is in the pool, so it moves when a login runs dry');
  assert.deepEqual(readRunnerJson(h.home).defaults ?? {}, before, "a schedule's run doesn't change what the next new thread starts on");

  // One or the other: a login pins it, a pool takes the pin away, null leaves neither.
  const pinned = (await m['schedules.update']({ scheduleId: sc.id, accountId: 'claude-3' })) as { schedule: { accountId?: string; poolId?: string } };
  assert.deepEqual([pinned.schedule.accountId, pinned.schedule.poolId], ['claude-3', undefined]);
  const pooled = await sched.update({ scheduleId: sc.id, poolId: 'claude' });
  assert.deepEqual([pooled.accountId, pooled.poolId], [undefined, 'claude']);
  const neither = (await m['schedules.update']({ scheduleId: sc.id, poolId: null })) as { schedule: { accountId?: string; poolId?: string } };
  assert.deepEqual([neither.schedule.accountId, neither.schedule.poolId], [undefined, undefined]);

  // A backend older than 36 would turn the whole row down.
  const row = { ...sched.find(sc.id), poolId: 'claude', runnerId: 'r1' };
  assert.equal(toOwnedScheduleDoc(row, SCHEDULE_POOLS_API_VERSION).poolId, 'claude');
  assert.ok(!('poolId' in toOwnedScheduleDoc(row, SCHEDULE_POOLS_API_VERSION - 1)));
  sched.stop();
});

test('the methods check what they are given', async () => {
  const { h, sched } = setup();
  const m = scheduleMethods(sched);
  const code = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (e) {
      return (e as RpcError).code;
    }
    return 0;
  };
  assert.equal(await code(() => m['schedules.create']({ text: 'x', cron: '0 9 * *' })), ErrorCode.badParams);
  assert.equal(await code(() => m['schedules.create']({ text: 'x', cron: '0 0 30 2 *' })), ErrorCode.badParams);
  assert.equal(await code(() => m['schedules.create']({ text: 'x' })), ErrorCode.badParams);
  assert.equal(await code(() => m['schedules.create']({ text: 'x', at: 'soon' })), ErrorCode.badParams);
  assert.equal(await code(() => m['schedules.create']({ text: 'x', cron: '@daily', timezone: 'Mars/Olympus' })), ErrorCode.badParams);
  assert.equal(await code(() => m['schedules.create']({ text: 'x', cron: '@daily', threadId: 'nope' })), ErrorCode.threadNotFound);
  assert.equal(await code(() => m['schedules.create']({ text: 'x', cron: '@daily', accountId: 'claude-99' })), ErrorCode.accountNotFound);
  assert.equal(await code(() => m['schedules.delete']({ scheduleId: 'nope' })), ErrorCode.scheduleNotFound);
  const p = m['schedules.preview']({ cron: '0 9 * * 1-5', count: 2 }) as { whenText: string; runs: string[] };
  assert.deepEqual(p, { whenText: 'Weekdays at 9:00', runs: ['2026-10-27T09:00:00.000Z', '2026-10-28T09:00:00.000Z'] });
  assert.equal(h.runner.list().length, 0);
  sched.stop();
});

test('agents schedule messages to their own thread by default', async () => {
  const { h, sched } = setup();
  const { thread, s } = idleThread(h);
  const list = buildThreadbearTools(h.runner, thread.id, () => h.clock.now(), sched);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = list.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, error: Boolean(r.isError) };
  };
  const made = await call('schedule_message', { text: 'Look at CI again', when: '20m' });
  assert.equal(made.error, false, made.text);
  assert.match(made.text, /Look at CI again {2}\[Once, Mon 26 Oct at 12:20; next in 20m .*\] {2}to this thread/);
  assert.equal(sched.list()[0].createdBy, thread.id);
  assert.equal((await call('schedule_message', { text: 'x' })).error, true, 'needs a when or a cron');
  assert.equal((await call('schedule_message', { text: 'x', cron: '@daily', model: 'opus' })).error, true, 'model is for new threads');

  const daily = await call('schedule_message', { text: 'Morning summary', cron: '0 8 * * *', new_thread: true });
  assert.match(daily.text, /Every day at 8:00; next in 20h .*to a new thread in /);
  assert.match((await call('list_schedules', {})).text, /Look at CI again[\s\S]*Morning summary/);

  // A new-thread schedule's account, model and folder can move (the
  // standup that needed the login with Slack, 5 Nov); a thread's can't.
  const dailyId = sched.list().find((x) => x.title === 'Morning summary')!.id;
  const moved = await call('update_schedule', { scheduleId: dailyId.slice(0, 8), account: 'claude-3', model: 'opus', effort: 'high', permissionMode: 'ask', folder: '..' });
  assert.equal(moved.error, false, moved.text);
  assert.match(moved.text, /\(claude-3, opus, high, ask\)/);
  const after = await sched.find(dailyId);
  assert.deepEqual([after.accountId, after.model, after.effort, after.permissionMode, after.cwd], ['claude-3', 'opus', 'high', 'ask', path.dirname(thread.cwd)]);
  await call('update_schedule', { scheduleId: dailyId, model: null, effort: null });
  assert.deepEqual([(await sched.find(dailyId)).model, (await sched.find(dailyId)).effort], [undefined, undefined]);
  assert.match((await call('update_schedule', { scheduleId: dailyId, account: 'nobody' })).text, /No account nobody/);
  const pooled = await call('update_schedule', { scheduleId: dailyId, pool: 'Claude' });
  assert.match(pooled.text, /\(claude pool, /, pooled.text);
  assert.deepEqual([(await sched.find(dailyId)).accountId, (await sched.find(dailyId)).poolId], [undefined, 'claude']);
  await call('update_schedule', { scheduleId: dailyId, pool: null });
  assert.equal((await sched.find(dailyId)).poolId, undefined);
  const viaPool = await call('schedule_message', { text: 'Evening summary', cron: '0 18 * * *', new_thread: true, pool: 'claude' });
  assert.match(viaPool.text, /claude pool/, viaPool.text);
  assert.equal((await call('schedule_message', { text: 'x', when: '1h', pool: 'claude' })).error, true, 'pool is for new threads');

  const id = sched.list()[0].id.slice(0, 8);
  const refused = await call('update_schedule', { scheduleId: id, account: 'claude-3' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /sends to a thread/);
  assert.match((await call('update_schedule', { scheduleId: id, paused: true })).text, /paused/);
  assert.match((await call('delete_schedule', { scheduleId: id })).text, /Deleted the schedule "Look at CI again"/);
  h.clock.advance(30 * MIN);
  await tick();
  assert.equal(s.sent.length, 1, 'the deleted one never sent');
  sched.stop();
});

// ------------------------------------------------------- in the backend (API 9)

// The backend's schedules table as convex/sync.ts keeps it: a row per
// schedule, claims that lapse, and every change sent to each subscriber.
function fakeBackend(clock: { now(): number }, runners: { id: string; name: string; icon?: string; version?: string; release?: string; startedAt?: string; draining?: boolean }[] = []) {
  const rows = new Map<string, StoredSchedule & { claim?: { holder: string; until: number } }>();
  const subs = new Set<(rows: StoredSchedule[]) => void>();
  const calls: string[] = [];
  let down = false;
  const push = () => {
    const list = [...rows.values()].map(({ claim: _c, ...r }) => structuredClone(r));
    for (const fn of subs) queueMicrotask(() => fn(structuredClone(list)));
  };
  const check = (what: string) => {
    calls.push(what);
    if (down) throw new Error('fetch failed');
  };
  const forHolder = (holder: string, runnerId: string): ScheduleBackend => ({
    subscribe: (onRows) => {
      subs.add(onRows);
      push();
      return () => subs.delete(onRows);
    },
    save: async (sc) => {
      check(`save ${sc.title}`);
      const old = rows.get(sc.id);
      rows.set(sc.id, { ...structuredClone(sc), ...(old?.claim && old.nextRunAt === sc.nextRunAt ? { claim: old.claim } : {}) });
      push();
    },
    remove: async (id) => {
      check(`remove ${id}`);
      rows.delete(id);
      push();
    },
    adopt: async (list) => {
      check(`adopt ${list.length}`);
      for (const r of list) if (!rows.has(r.id)) rows.set(r.id, structuredClone(r));
      push();
    },
    claim: async (id, kind, expect) => {
      check(`claim ${kind} ${holder}`);
      const r = rows.get(id);
      if (!r || r.runnerId !== runnerId) return false;
      if (r.claim && r.claim.until > clock.now() && r.claim.holder !== holder) return false;
      if (kind === 'due' && (r.paused || r.nextRunAt !== expect)) return false;
      if (kind === 'request' && r.runRequestedAt !== expect) return false;
      r.claim = { holder, until: clock.now() + 2 * MIN };
      return true;
    },
    release: async (id) => {
      const r = rows.get(id);
      if (r?.claim?.holder === holder) delete r.claim;
    },
    ran: async (p) => {
      check(`ran ${p.lastRun.outcome}`);
      const r = rows.get(p.scheduleId);
      if (!r) return;
      r.lastRun = p.lastRun;
      r.runs += p.sent ? 1 : 0;
      if (r.claim?.holder === holder) delete r.claim;
      if (p.request !== undefined && r.runRequestedAt === p.request) delete r.runRequestedAt;
      if (r.updatedAt === p.expectUpdatedAt) {
        if (p.nextRunAt) r.nextRunAt = p.nextRunAt;
        else delete r.nextRunAt;
        if (p.finishedAt) r.finishedAt = p.finishedAt;
      }
      push();
    },
    requestRun: async (id, at) => {
      check('requestRun');
      const r = rows.get(id);
      if (!r) return false;
      r.runRequestedAt = at;
      push();
      return true;
    },
    runners: async () => runners.map((r) => ({ ...r, lastSeenAt: clock.now() })),
  });
  return {
    rows,
    calls,
    for: forHolder,
    setDown: (d: boolean) => {
      down = d;
    },
  };
}

const M5 = { id: 'r-m5', name: 'm5', icon: 'laptopcomputer' };
const BRUCE = { id: 'r-bruce', name: 'bruce', icon: 'macmini' };

function backendScheduler(h: ReturnType<typeof makeHarness>, self = M5, home = h.home) {
  fs.mkdirSync(home, { recursive: true });
  const sched = new Scheduler({ runner: h.runner, home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self, syncOn: true });
  sched.start();
  return sched;
}

// From the cross-lab review of the raising-access fix (6 Nov 2026): each
// update copies the record, so two at once lost the earlier one's change.
test('two updates at once both land: a rename after a lowering keeps it lowered', async () => {
  const h = makeHarness();
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true });
  sched.start();
  const b = fakeBackend(h.clock, [M5, BRUCE]);
  const be = b.for('m5-a', M5.id);
  let slow = false;
  await sched.attach({
    ...be,
    save: async (sc) => {
      if (slow && sc.permissionMode === 'ask') await new Promise((r) => setTimeout(r, 30));
      return be.save(sc);
    },
  });
  await tick();
  const sc = await sched.create({ text: 'Tidy', cron: '@daily', title: 'Daily' });
  slow = true;
  const lowered = sched.update({ scheduleId: sc.id, permissionMode: 'ask' });
  const renamed = sched.update({ scheduleId: sc.id, title: 'Daily 2' });
  await Promise.all([lowered, renamed]);
  const now = await sched.find(sc.id);
  assert.deepEqual([now.permissionMode, now.title], ['ask', 'Daily 2']);
  assert.equal(b.rows.get(sc.id)?.permissionMode, 'ask');
  sched.stop();
});

test('meeting a backend moves schedules.json up once, then the file is only its copy', async () => {
  const h = makeHarness();
  const { thread } = idleThread(h);
  const local = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true });
  local.start();
  const sc = await local.create({ text: 'ping', cron: '@hourly', threadId: thread.id });
  assert.equal(local.inBackend(), false, 'its own file until a backend says API 9');

  const b = fakeBackend(h.clock, [M5, BRUCE]);
  await local.attach(b.for('m5-a', M5.id));
  await tick();
  assert.equal(local.inBackend(), true);
  assert.deepEqual(b.calls.slice(0, 1), ['adopt 1']);
  assert.equal(b.rows.get(sc.id)?.runnerId, M5.id);
  assert.equal(b.rows.get(sc.id)?.whenText, 'Every hour');
  const listed = local.list()[0];
  assert.equal(listed.runnerId, M5.id);
  assert.equal(listed.runnerName, 'm5');
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'schedules.json'), 'utf8'));
  assert.equal(saved.version, 2);
  local.stop();

  // The next start doesn't move it up again, and sends nothing before the
  // backend is attached.
  const again = backendScheduler(h);
  assert.equal(again.inBackend(), true);
  assert.equal(again.list().length, 1, 'listed from the copy');
  await again.attach(b.for('m5-b', M5.id));
  await tick();
  assert.equal(b.calls.filter((c) => c.startsWith('adopt')).length, 1);
  again.stop();
});

test('a due run is claimed, so two runner processes under one id send it once', async () => {
  const h = makeHarness();
  const { thread } = idleThread(h);
  const b = fakeBackend(h.clock, [M5]);
  // The release that's draining and the new one, as in a handover.
  const old = backendScheduler(h, M5, path.join(h.home, 'old'));
  const now = backendScheduler(h, M5, path.join(h.home, 'new'));
  await old.attach(b.for('m5-old', M5.id));
  await now.attach(b.for('m5-new', M5.id));
  const sc = await now.create({ text: 'Check CI', at: iso(h.clock.now() + 10 * MIN), threadId: thread.id });
  await tick();
  h.clock.advance(10 * MIN);
  for (let i = 0; i < 5; i++) await tick();
  const sent = h.events(thread.id).filter((e) => e.type === 'user.message' && e.scheduleId === sc.id);
  assert.equal(sent.length, 1, 'sent once');
  const row = b.rows.get(sc.id)!;
  assert.equal(row.runs, 1);
  assert.equal(row.finishedAt, '2026-10-26T12:10:00.000Z');
  assert.equal(row.nextRunAt, undefined);
  assert.equal(row.claim, undefined, 'the claim is let go once it ran');
  old.stop();
  now.stop();
});

test('a check\'s output survives a handover in the backend too, and is sent once by the next runner', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5]);
  // A check that keeps state: prints its news once.
  const seen: string[] = [];
  let told = false;
  const runCheck = async (p: { command: string }) => {
    seen.push(p.command);
    if (told) return { ok: true as const, output: '' };
    told = true;
    return { ok: true as const, output: 'fork: 3 new commits' };
  };
  // Both releases share the runner's data dir, as in a real handover.
  const make = () => {
    const s = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true, checksOn: () => true, runCheck });
    s.start();
    return s;
  };
  const old = make();
  await old.attach(b.for('m5-old', M5.id));
  const sc = await old.create({ text: 'Look at the forks', title: 'Fork watch', at: iso(h.clock.now() + MIN), check: 'fork-watch' });
  await tick();
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  h.clock.advance(MIN);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(seen.length, 1, 'the check ran');
  assert.equal(b.rows.get(sc.id)?.claim, undefined, 'the refused run let its claim go');
  assert.equal(b.rows.get(sc.id)?.runs, 0);
  old.stop();

  h.runner.refusing = undefined;
  const next = make();
  await next.attach(b.for('m5-new', M5.id));
  for (let i = 0; i < 5; i++) await tick();
  h.clock.advance(MIN);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(seen.length, 1, 'not run again');
  const t = h.runner.list(['inbox', 'snoozed', 'archived']).find((x) => x.title === 'Fork watch');
  assert.ok(t, 'sent');
  assert.match(h.events(t.id).find((e) => e.type === 'user.message').text, /3 new commits/);
  assert.equal(b.rows.get(sc.id)?.runs, 1);
  next.stop();
});

test('a backend schedule deleted while its check runs sends nothing', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5]);
  let finish!: (r: { ok: true; output: string }) => void;
  const s = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true, checksOn: () => true, runCheck: () => new Promise((r) => (finish = r)) });
  s.start();
  await s.attach(b.for('m5', M5.id));
  const sc = await s.create({ text: 'Look', title: 'Fork watch', cron: '*/5 * * * *', check: 'fork-watch' });
  await tick();
  h.clock.advance(5 * MIN);
  for (let i = 0; i < 5; i++) await tick();
  await s.delete(sc.id);
  for (let i = 0; i < 5; i++) await tick();
  finish({ ok: true, output: 'news' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.runner.list(['inbox', 'snoozed', 'archived']).filter((x) => x.title === 'Fork watch').length, 0);
  assert.ok(!fs.existsSync(keptCheckFile(h.home, sc.id, 'fork-watch')));
  s.stop();
});

test('a backend run uses the schedule as it is once its claim comes back, not as it was', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5]);
  const seen: string[] = [];
  const s = new Scheduler({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true, checksOn: () => true,
    runCheck: async (p) => {
      seen.push(p.command);
      return { ok: true, output: '' };
    },
  });
  s.start();
  // Claims held until let go, as a slow backend would.
  const real = b.for('m5', M5.id);
  let letGo: (() => void) | undefined;
  const slow: ScheduleBackend = { ...real, claim: (id, kind, expect) => new Promise((r) => (letGo = () => void real.claim(id, kind, expect).then(r))) };
  await s.attach(slow);
  const sc = await s.create({ text: 'Look', title: 'Fork watch', cron: '*/5 * * * *', check: 'check-a' });
  await tick();
  // A's news, kept from a send a restart refused.
  fs.mkdirSync(path.join(h.home, 'schedule-checks'), { recursive: true });
  fs.writeFileSync(keptCheckFile(h.home, sc.id, 'check-a'), JSON.stringify({ check: 'check-a', at: 'x', extra: '\n\nnews from a' }));
  h.clock.advance(5 * MIN);
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(letGo, 'claiming');
  // Changed while the claim is out.
  await s.update({ scheduleId: sc.id, check: 'check-b' });
  for (let i = 0; i < 5; i++) await tick();
  letGo!();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(seen, ['check-b']);
  assert.equal(h.runner.list(['inbox', 'snoozed', 'archived']).filter((x) => x.title === 'Fork watch').length, 0, "a's news isn't sent as b's");
  assert.ok(fs.existsSync(keptCheckFile(h.home, sc.id, 'check-a')), 'and is still kept for a');
  s.stop();
});

test('runners.list gives each runner\'s version, start and whether it\'s updating, for the Runners panel', async () => {
  const h = makeHarness();
  const bruce = { ...BRUCE, version: '0.4.0', release: 'r-abc', startedAt: '2026-11-05T01:00:00.000Z', draining: true };
  const b = fakeBackend(h.clock, [M5, bruce]);
  const me = { ...M5, version: '0.4.1', release: 'r-def', startedAt: '2026-11-05T02:00:00.000Z' };
  const m5 = backendScheduler(h, me, path.join(h.home, 'm5'));
  await m5.attach(b.for('m5', M5.id));
  const [self, other] = await m5.runners();
  assert.deepEqual(self, { id: M5.id, name: 'm5', icon: 'laptopcomputer', online: true, self: true, version: '0.4.1', release: 'r-def', startedAt: '2026-11-05T02:00:00.000Z' });
  assert.equal(other!.version, '0.4.0');
  assert.equal(other!.release, 'r-abc');
  assert.equal(other!.startedAt, '2026-11-05T01:00:00.000Z');
  assert.equal(other!.draining, true);
  m5.stop();
});

test('a schedule made for another runner runs there, with that runner\'s folder', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5, BRUCE]);
  const m5 = backendScheduler(h, M5, path.join(h.home, 'm5'));
  const bruce = backendScheduler(h, BRUCE, path.join(h.home, 'bruce'));
  await m5.attach(b.for('m5', M5.id));
  await bruce.attach(b.for('bruce', BRUCE.id));

  // A folder that only exists on Bruce isn't checked on the M5.
  const made = await m5.create({ text: 'Summarise Slack', title: 'Slack summary', cron: '0 * * * *', cwd: '/nowhere/on/this/mac', accountId: 'codex-main', runnerId: 'Bruce' });
  assert.equal(made.runnerId, BRUCE.id);
  assert.equal(made.runnerName, 'bruce');
  assert.equal(made.runnerIcon, 'macmini');
  assert.deepEqual((await m5.runners()).map((r) => [r.name, r.icon]), [['m5', 'laptopcomputer'], ['bruce', 'macmini']]);
  assert.equal(made.cwd, '/nowhere/on/this/mac');
  await tick();
  assert.equal(bruce.list().length, 1, 'bruce sees it');
  await assert.rejects(m5.create({ text: 'x', cron: '@daily', runnerId: 'tinker' }), /No runner called tinker. Runners: m5, bruce/);
  await assert.rejects(m5.create({ text: 'x', cron: '@daily', threadId: 'whatever', runnerId: 'bruce' }), /runs on that thread's runner/);

  // Due: Bruce takes it and it fails there (no such folder, no such
  // account), the M5 never tries.
  h.clock.advance(60 * MIN);
  for (let i = 0; i < 5; i++) await tick();
  const row = b.rows.get(made.id)!;
  assert.equal(row.lastRun?.outcome, 'failed');
  assert.equal(b.calls.filter((c) => c === 'claim due m5').length, 0, 'the M5 leaves it alone');
  assert.equal(row.nextRunAt, '2026-10-26T14:00:00.000Z', 'carries on next time');

  // Run now from the M5: asked for, and run by Bruce. With no folder it uses
  // Bruce's default.
  await m5.update({ scheduleId: made.id, cwd: '' });
  await tick();
  assert.equal(b.rows.get(made.id)?.cwd, undefined);
  await bruce.update({ scheduleId: made.id, accountId: 'claude-3' });
  const asked = await m5.runNow(made.id);
  assert.equal(asked.queued, true);
  assert.equal(asked.threadId, undefined);
  for (let i = 0; i < 5; i++) await tick();
  const started = h.runner.list().find((t) => t.schedule?.id === made.id);
  assert.ok(started, 'Bruce started the thread');
  assert.equal(started.cwd, h.cfg.defaults.cwd);
  assert.equal(b.rows.get(made.id)?.runRequestedAt, undefined);
  assert.equal(b.rows.get(made.id)?.runs, 1);
  m5.stop();
  bruce.stop();
});

test('with the backend out of reach, changes fail and say so', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5]);
  const first = backendScheduler(h);
  await first.attach(b.for('m5', M5.id));
  first.stop();
  // Started again: its file is the backend's copy, and until the backend is
  // attached there's nowhere to write.
  const sched = backendScheduler(h);
  await assert.rejects(sched.create({ text: 'x', cron: '@daily' }), /can't reach right now/, 'before the backend is attached');
  await sched.attach(b.for('m5', M5.id));
  b.setDown(true);
  await assert.rejects(sched.create({ text: 'x', cron: '@daily' }), /Couldn't save the schedule to the backend: fetch failed/);
  assert.equal(sched.list().length, 0);
  sched.stop();
});

test('with sync turned off, its own schedules come back from the copy as its own', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5, BRUCE]);
  const sched = backendScheduler(h);
  await sched.attach(b.for('m5', M5.id));
  await sched.create({ text: 'mine', cron: '@daily' });
  await sched.create({ text: 'bruce', cron: '@daily', runnerId: 'bruce' });
  await tick();
  sched.stop();
  const off = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: false });
  off.start();
  assert.deepEqual(off.list().map((s) => [s.title, s.runnerId]), [['mine', undefined]]);
  off.stop();
});

test('a schedule made while the file is being moved up is moved up too', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5]);
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true });
  sched.start();
  const early = await sched.create({ text: 'early', cron: '@daily' });
  const backend = b.for('m5', M5.id);
  // The adopt call is slow; meanwhile one is made, one changed, one deleted.
  let late: Awaited<ReturnType<Scheduler['create']>> | undefined;
  const slow: ScheduleBackend = {
    ...backend,
    adopt: async (rows) => {
      await backend.adopt(rows);
      if (!late) {
        late = await sched.create({ text: 'late', cron: '@hourly' });
        await sched.update({ scheduleId: early.id, title: 'early, renamed' });
      }
    },
  };
  await sched.attach(slow);
  await tick();
  assert.deepEqual([...b.rows.values()].map((r) => r.title).sort(), ['early, renamed', 'late']);
  assert.deepEqual(sched.list().map((s) => s.title).sort(), ['early, renamed', 'late']);
  sched.stop();
});

test('on a runner key the scheduler still moves up and lists runners, without the main key\'s adopt and runner list', async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [M5, BRUCE]);
  const refused = () => Promise.reject(Object.assign(new Error('Server Error'), { data: { kind: 'forbidden', message: "This runner's key can't call adoptSchedules" } }));
  const backend = { ...b.for('bruce', BRUCE.id), adopt: refused, runners: refused };
  const home = path.join(h.home, 'bruce');
  fs.mkdirSync(home, { recursive: true });
  const local = new Scheduler({ runner: h.runner, home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: BRUCE, syncOn: false });
  local.start();
  await local.create({ text: 'ping', cron: '@hourly', cwd: h.home });
  local.stop();
  const s = new Scheduler({ runner: h.runner, home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: BRUCE, syncOn: true });
  s.start();
  await s.attach(backend as never);
  assert.equal(s.inBackend(), true);
  assert.equal([...b.rows.values()].filter((r) => r.runnerId === BRUCE.id).length, 1, 'saved one by one instead');
  assert.deepEqual((await s.runners()).map((r) => r.id), [BRUCE.id]);
  s.stop();
});

test("schedules a runner key can't bring up stay on this Mac, running from its own file, and it says so", async () => {
  const h = makeHarness();
  const b = fakeBackend(h.clock, [BRUCE]);
  const home = path.join(h.home, 'bruce2');
  fs.mkdirSync(home, { recursive: true });
  const local = new Scheduler({ runner: h.runner, home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: BRUCE, syncOn: false });
  local.start();
  const sc = await local.create({ text: 'a long prompt', cron: '@hourly', cwd: h.home });
  local.stop();
  const backend = { ...b.for('bruce', BRUCE.id), adopt: async () => ({ held: [{ id: sc.id, why: "it's over 12000 bytes" }] }) };
  const s = new Scheduler({ runner: h.runner, home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: BRUCE, syncOn: true });
  s.start();
  await s.attach(backend as never);
  assert.equal(s.inBackend(), false, 'still its own file');
  assert.deepEqual(s.heldLocal().map((x) => x.id), [sc.id]);
  assert.equal(s.list().length, 1, 'nothing lost');
  s.stop();
});

// Daybreak, 6 Nov 2026 ("Schedule refresh can run a secondary runner's job on
// the primary"): the main Mac claims its schedule; while the claim or its
// check is out, Mike deletes it and a runner key saves a schedule of its own
// under the same id (same check, its own words, Full access). The main Mac's
// subscription has every runner's rows, so the new row turns up under the
// claimed id. Nothing is sent for it: what was claimed is gone.
async function replaceUnderClaim(b: ReturnType<typeof fakeBackend>, id: string, how: 'secondary' | 'owner') {
  const old = structuredClone(b.rows.get(id)!);
  delete old.claim;
  await b.for('phone', M5.id).remove(id);
  const evil = { ...old, title: 'ATTACKER JOB', text: 'ATTACKER INSTRUCTIONS', permissionMode: 'full' as const };
  if (how === 'secondary') await b.for('bruce', BRUCE.id).save({ ...evil, runnerId: BRUCE.id });
  // Mike making a new one under the old id (his own key may): a new
  // schedule all the same, not the one claimed.
  else await b.for('phone', M5.id).save({ ...evil, createdAt: iso(Date.parse(old.createdAt) + 1) });
}

for (const how of ['secondary', 'owner'] as const) {
  test(`a schedule replaced under its id while its check runs isn't sent as the claimed one (${how})`, async () => {
    const h = makeHarness();
    const b = fakeBackend(h.clock, [M5, BRUCE]);
    let finish: ((r: { ok: true; output: string }) => void) | undefined;
    const s = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', self: M5, syncOn: true, checksOn: () => true, runCheck: () => new Promise((r) => (finish = r)) });
    s.start();
    await s.attach(b.for('m5', M5.id));
    const sc = await s.create({ text: 'Benign', title: 'BENIGN JOB', cron: '*/5 * * * *', check: 'news-check', permissionMode: 'ask' });
    await tick();
    h.clock.advance(5 * MIN);
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(finish, 'its check is running, under the claim');
    await replaceUnderClaim(b, sc.id, how);
    for (let i = 0; i < 5; i++) await tick();
    finish!({ ok: true, output: 'news' });
    for (let i = 0; i < 10; i++) await tick();
    const made = h.runner.list(['inbox', 'snoozed', 'archived']);
    assert.equal(made.filter((t) => t.title === 'ATTACKER JOB').length, 0, 'the replacement is not sent');
    assert.ok(!made.some((t) => h.events(t.id).some((e) => e.type === 'user.message' && /ATTACKER/.test(e.text))));
    assert.ok(!made.some((t) => t.permissionMode === 'full' && t.schedule?.id === sc.id), 'nothing in Full access from it');
    if (how === 'secondary') assert.equal(b.rows.get(sc.id)?.lastRun, undefined, "and nothing recorded on the other runner's row");
    s.stop();
  });

  test(`a requested run whose schedule is replaced while the claim is out isn't sent (${how})`, async () => {
    const h = makeHarness();
    const b = fakeBackend(h.clock, [M5, BRUCE]);
    const s = backendScheduler(h);
    const real = b.for('m5', M5.id);
    let letGo: (() => void) | undefined;
    // The claim lands at once; only its answer is slow to come back.
    const slow: ScheduleBackend = {
      ...real,
      claim: (id, kind, expect) => {
        const landed = real.claim(id, kind, expect);
        return kind === 'request' ? new Promise((r) => (letGo = () => void landed.then(r))) : landed;
      },
    };
    await s.attach(slow);
    const sc = await s.create({ text: 'Benign', title: 'BENIGN JOB', cron: '0 0 1 1 *', permissionMode: 'ask' });
    await tick();
    // Run now from another Mac: a request the M5 claims.
    await b.for('bruce', BRUCE.id).requestRun(sc.id, iso(h.clock.now()));
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(letGo, 'claiming the request');
    await replaceUnderClaim(b, sc.id, how);
    // The replacement asks for a run too, so the old request's claim could
    // be taken for it.
    for (let i = 0; i < 5; i++) await tick();
    letGo!();
    for (let i = 0; i < 10; i++) await tick();
    const made = h.runner.list(['inbox', 'snoozed', 'archived']);
    assert.equal(made.filter((t) => t.title === 'ATTACKER JOB' || t.title === 'BENIGN JOB').length, 0, 'nothing is sent for it');
    s.stop();
  });
}
