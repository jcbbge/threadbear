// Schedule checks (experiment scheduleChecks, src/schedule-check.ts): a
// command run before each run; nothing printed skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { Scheduler } from '../../src/schedules.ts';
import { nullLogger } from '../../src/log.ts';
import { checkLimitMs, checkOutcome, checkRunningElsewhere, keptCheckFile, markCheckRunning, runCheck, type CheckResult } from '../../src/schedule-check.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { toOwnedScheduleDoc } from '../../src/sync.ts';

const MIN = 60_000;

function setup(o: { on?: boolean; result?: () => CheckResult } = {}) {
  const h = makeHarness();
  const seen: { command: string; cwd: string }[] = [];
  const sched = new Scheduler({
    runner: h.runner,
    home: h.home,
    clock: h.clock,
    log: nullLogger,
    zone: () => 'UTC',
    checksOn: () => o.on ?? true,
    runCheck: async (p) => {
      seen.push({ command: p.command, cwd: p.cwd });
      return o.result?.() ?? { ok: true, output: '' };
    },
  });
  sched.start();
  return { h, sched, seen };
}

const newThreads = (h: ReturnType<typeof makeHarness>) => h.runner.list(['inbox', 'snoozed', 'archived']).filter((t) => t.title === 'Watch Sentry');

test('scheduleChecks: a check that prints nothing skips the run, and no thread starts', async () => {
  const { h, sched, seen } = setup();
  const sc = await sched.create({ text: 'Triage new Sentry issues', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'sentry-new-issues' });
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'sentry-new-issues');
  assert.equal(newThreads(h).length, 0);
  const after = sched.find(sc.id);
  assert.equal(after.lastRun?.outcome, 'skipped');
  assert.match(after.lastRun!.note!, /nothing new/);
  assert.equal(after.runs, 0);
  assert.ok(Date.parse(after.nextRunAt!) > h.clock.now(), 'planned for its next time');
  sched.stop();
});

test('scheduleChecks: what the check prints goes into the message', async () => {
  const { h, sched } = setup({ result: () => ({ ok: true, output: 'ISSUE-42 TypeError in sync' }) });
  await sched.create({ text: 'Triage new Sentry issues', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'sentry-new-issues' });
  h.clock.advance(5 * MIN);
  await tick(6);
  const [t] = newThreads(h);
  assert.ok(t, 'a thread started');
  const msg = h.events(t.id).find((e) => e.type === 'user.message').text as string;
  assert.match(msg, /Triage new Sentry issues/);
  assert.match(msg, /Its check found this:[\s\S]*ISSUE-42 TypeError in sync/);
  sched.stop();
});

test('scheduleChecks: a failing check runs anyway, with the error', async () => {
  const { h, sched } = setup({ result: () => ({ ok: false, output: 'sentry: command not found', why: 'it exited with 127' }) });
  await sched.create({ text: 'Triage', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'sentry-new-issues' });
  h.clock.advance(5 * MIN);
  await tick(6);
  const [t] = newThreads(h);
  const msg = h.events(t.id).find((e) => e.type === 'user.message').text as string;
  assert.match(msg, /Its check failed \(it exited with 127\), so this run went ahead anyway/);
  assert.match(msg, /command not found/);
  sched.stop();
});

test('scheduleChecks: with the experiment off the check is ignored and it runs as before', async () => {
  const { h, sched, seen } = setup({ on: false });
  await sched.create({ text: 'Triage', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'sentry-new-issues' });
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.length, 0);
  assert.equal(newThreads(h).length, 1);
  sched.stop();
});

test('scheduleChecks: update sets and takes off the check; Run now skips it', async () => {
  const { h, sched, seen } = setup();
  const sc = await sched.create({ text: 'Triage', title: 'Watch Sentry', cron: '@daily' });
  assert.equal((await sched.update({ scheduleId: sc.id, check: '  ls new/  ' })).check, 'ls new/');
  await sched.runNow(sc.id);
  assert.equal(seen.length, 0, 'Run now is asked for by hand, so it runs');
  assert.equal(newThreads(h).length, 1);
  assert.equal((await sched.update({ scheduleId: sc.id, check: null })).check, undefined);
  await assert.rejects(sched.update({ scheduleId: sc.id, check: 'x'.repeat(2001) }), /at most 2000/);
  sched.stop();
});

test('scheduleChecks: the backend gets the check only from API 51', () => {
  const s = { id: 'a', runnerId: 'r', title: 't', text: 'x', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, check: 'ls' };
  assert.equal(toOwnedScheduleDoc(s as never, 50).check, undefined);
  assert.equal(toOwnedScheduleDoc(s as never, 51).check, 'ls');
});

test('scheduleChecks: the tools offer check only while the experiment is on', () => {
  const { h, sched } = setup();
  const names = (on: boolean) => {
    const tools = buildThreadbearTools(h.runner, 'x', Date.now, sched, undefined, undefined, { scheduleChecks: () => on }) as unknown as { name: string; inputSchema: Record<string, unknown> }[];
    return Object.keys(tools.find((t) => t.name === 'schedule_message')!.inputSchema);
  };
  assert.ok(!names(false).includes('check'));
  assert.ok(names(true).includes('check'));
  sched.stop();
});

test('runCheck: runs in the folder with a state file, keeps what it prints, and times out', async () => {
  const home = tmpDir();
  const cwd = tmpDir('tb-check-cwd-');
  fs.writeFileSync(path.join(cwd, 'new.txt'), 'two new issues');
  const r = await runCheck({ command: 'cat new.txt; echo "$THREADBEAR_SCHEDULE_ID" > "$THREADBEAR_CHECK_STATE"', cwd, home, scheduleId: 'abc' });
  assert.deepEqual(r, { ok: true, output: 'two new issues' });
  assert.equal(fs.readFileSync(path.join(home, 'schedule-checks', 'abc.state'), 'utf8').trim(), 'abc');
  assert.deepEqual(await runCheck({ command: 'true', cwd, home, scheduleId: 'abc' }), { ok: true, output: '' });
  const bad = await runCheck({ command: 'echo nope >&2; exit 3', cwd, home, scheduleId: 'abc' });
  assert.deepEqual(bad, { ok: false, output: 'nope', why: 'it exited with 3' });
  const slow = await runCheck({ command: 'sleep 5', cwd, home, scheduleId: 'abc', timeoutMs: 200 });
  assert.equal(slow.ok, false);
  assert.match((slow as { why: string }).why, /longer than/);
  assert.deepEqual(checkOutcome({ ok: true, output: '' }), { skip: 'Its check found nothing new.' });
});

// A check that keeps state reports each thing once, so what it printed has
// to reach a thread even when a restart lands between the check and the
// send (6 Nov 2026: schedule 54f11e8a's report was lost in a handover, and
// the next runner's check found "nothing new").

// A check like the fork watch: prints what it hasn't printed before.
function onceCheck(news: string) {
  let told = false;
  return () => {
    if (told) return { ok: true as const, output: '' };
    told = true;
    return { ok: true as const, output: news };
  };
}

function schedulerOn(h: ReturnType<typeof makeHarness>, result: () => CheckResult | Promise<CheckResult>, seen: string[] = []) {
  const sched = new Scheduler({
    runner: h.runner,
    home: h.home,
    clock: h.clock,
    log: nullLogger,
    zone: () => 'UTC',
    checksOn: () => true,
    runCheck: async (p) => {
      seen.push(p.command);
      return result();
    },
  });
  sched.start();
  return sched;
}

const sentText = (h: ReturnType<typeof makeHarness>) => newThreads(h).map((t) => h.events(t.id).find((e) => e.type === 'user.message').text as string);

test('scheduleChecks: what a check printed survives a restart that refuses the send', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  const result = onceCheck('fork: someone/threadbear 3 new commits');
  const old = schedulerOn(h, result, seen);
  const sc = await old.create({ text: 'Look at the forks', title: 'Watch Sentry', at: new Date(h.clock.now() + MIN).toISOString(), check: 'fork-watch' });
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 1, 'the check ran');
  assert.equal(newThreads(h).length, 0, 'the send was refused');
  assert.equal(old.find(sc.id).lastRun, undefined, 'still due');
  old.stop();

  // The next runner sends what the check printed, without running it again.
  h.runner.refusing = undefined;
  const next = schedulerOn(h, result, seen);
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 1, 'not run again');
  const [msg] = sentText(h);
  assert.match(msg ?? '', /3 new commits/);
  assert.equal(next.find(sc.id).lastRun?.outcome, 'sent');
  next.stop();
});

test('scheduleChecks: what a check printed survives the runner stopping mid-check', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  let finish!: (r: CheckResult) => void;
  const old = schedulerOn(h, () => new Promise<CheckResult>((r) => (finish = r)), seen);
  const sc = await old.create({ text: 'Look at the forks', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'fork-watch' });
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.length, 1, 'the check started');
  old.stop();
  const settled = old.settled();
  finish({ ok: true, output: 'fork: someone/threadbear 3 new commits' });
  await settled;
  assert.equal(newThreads(h).length, 0);

  const next = schedulerOn(h, () => ({ ok: true, output: '' }), seen);
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 1, 'not run again');
  assert.match(sentText(h)[0] ?? '', /3 new commits/);
  assert.equal(next.find(sc.id).runs, 1);
  // Once sent it's gone: the next run asks the check again.
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.length, 2);
  assert.equal(next.find(sc.id).lastRun?.outcome, 'skipped');
  assert.equal(newThreads(h).length, 1);
  next.stop();
});

test('scheduleChecks: Run now sends what was kept, and a changed check runs afresh', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  const old = schedulerOn(h, onceCheck('old news'), seen);
  const sc = await old.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'fork-watch' });
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  h.clock.advance(5 * MIN);
  await tick(6);
  h.runner.refusing = undefined;
  // Run now doesn't run the check, but carries what it kept.
  await old.runNow(sc.id);
  assert.equal(seen.length, 1);
  assert.match(sentText(h)[0], /old news/);
  h.adapter.last.init();
  h.adapter.last.result('completed');
  // So the next due run asks the check again.
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.length, 2);
  assert.equal(old.find(sc.id).lastRun?.outcome, 'skipped');

  // A changed check runs, rather than sending what another command kept.
  fs.writeFileSync(keptCheckFile(h.home, sc.id, 'fork-watch'), JSON.stringify({ check: 'fork-watch', at: 'x', extra: '\n\nnews from the old check' }));
  await old.update({ scheduleId: sc.id, check: 'fork-watch --all' });
  old.stop();
  const last = schedulerOn(h, () => ({ ok: true, output: 'from the new check' }), seen);
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.at(-1), 'fork-watch --all');
  assert.ok(sentText(h).some((m) => /from the new check/.test(m)));
  assert.ok(!sentText(h).some((m) => /news from the old check/.test(m)));
  last.stop();
});

test('scheduleChecks: settled() waits for a check under way, so the runner exits only once its output is kept', async () => {
  const h = makeHarness();
  let finish!: (r: CheckResult) => void;
  const old = schedulerOn(h, () => new Promise<CheckResult>((r) => (finish = r)));
  const sc = await old.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'fork-watch' });
  h.clock.advance(5 * MIN);
  await tick(6);
  old.stop();
  let done = false;
  const settled = old.settled().then(() => (done = true));
  await tick(6);
  assert.equal(done, false, 'still waiting on the check');
  finish({ ok: true, output: 'the news' });
  await settled;
  const kept = JSON.parse(fs.readFileSync(keptCheckFile(h.home, sc.id, 'fork-watch'), 'utf8'));
  assert.match(kept.extra, /the news/);
  assert.equal(kept.check, 'fork-watch');
});

test('scheduleChecks: while another runner process has the check under way, the run waits rather than running it again', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  const sched = schedulerOn(h, () => ({ ok: true, output: '' }), seen);
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', at: new Date(h.clock.now() + MIN).toISOString(), check: 'fork-watch' });
  // The old release, still running it (the test runner's parent stands in
  // for a live process).
  const dir = path.join(h.home, 'schedule-checks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sc.id}.running.json`), JSON.stringify({ pid: process.ppid, at: h.clock.now() }));
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 0, 'not run here');
  const still = sched.find(sc.id);
  assert.equal(still.finishedAt, undefined, 'the one-off is still due');
  assert.equal(still.lastRun, undefined);
  // The old one finishes and keeps what it printed; the next tick sends it.
  fs.rmSync(path.join(dir, `${sc.id}.running.json`));
  fs.writeFileSync(keptCheckFile(h.home, sc.id, 'fork-watch'), JSON.stringify({ check: 'fork-watch', at: 'x', extra: '\n\nIts check found this: the news' }));
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 0);
  assert.match(sentText(h)[0] ?? '', /the news/);
  // A marker left by a process that's gone doesn't hold anything up.
  fs.writeFileSync(path.join(dir, `${sc.id}.running.json`), JSON.stringify({ pid: 999_999_999, at: h.clock.now() }));
  const next = await sched.create({ text: 'Look', title: 'Watch Sentry', at: new Date(h.clock.now() + MIN).toISOString(), check: 'fork-watch' });
  fs.renameSync(path.join(dir, `${sc.id}.running.json`), path.join(dir, `${next.id}.running.json`));
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 1);
  sched.stop();
});

test('scheduleChecks: a check changed while it runs is not sent under the new one, and comes back with the old', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  let finish!: (r: CheckResult) => void;
  let slow = true;
  const sched = schedulerOn(h, () => (slow ? new Promise<CheckResult>((r) => (finish = r)) : { ok: true, output: '' }), seen);
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'check-a' });
  h.clock.advance(5 * MIN);
  await tick(6);
  await sched.update({ scheduleId: sc.id, check: 'check-b' });
  slow = false;
  finish({ ok: true, output: 'news from a' });
  await tick(6);
  assert.equal(newThreads(h).length, 0, "a's news isn't sent as b's");
  assert.equal(sched.find(sc.id).lastRun, undefined, 'left due');
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.at(-1), 'check-b');
  assert.equal(newThreads(h).length, 0);
  // Put back, a's news reaches a thread after all, without a running again.
  await sched.update({ scheduleId: sc.id, check: 'check-a' });
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.deepEqual(seen, ['check-a', 'check-b']);
  assert.match(sentText(h)[0] ?? '', /news from a/);
  sched.stop();
});

test('scheduleChecks: a schedule deleted mid-check sends nothing and keeps nothing', async () => {
  const h = makeHarness();
  let finish!: (r: CheckResult) => void;
  const sched = schedulerOn(h, () => new Promise<CheckResult>((r) => (finish = r)));
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'check-a' });
  h.clock.advance(5 * MIN);
  await tick(6);
  await sched.delete(sc.id);
  finish({ ok: true, output: 'news' });
  await tick(6);
  assert.equal(newThreads(h).length, 0);
  assert.ok(!fs.existsSync(keptCheckFile(h.home, sc.id, 'check-a')));
  sched.stop();
});

test('scheduleChecks: a one-off whose send fails keeps what its check printed, for when it is given a new time', async () => {
  const h = makeHarness();
  const dir = path.join(h.home, 'gone-soon');
  fs.mkdirSync(dir);
  const seen: string[] = [];
  const sched = schedulerOn(h, onceCheck('the news'), seen);
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', at: new Date(h.clock.now() + MIN).toISOString(), cwd: dir, check: 'fork-watch' });
  fs.rmSync(dir, { recursive: true });
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(sched.find(sc.id).lastRun?.outcome, 'failed');
  assert.ok(sched.find(sc.id).finishedAt);
  fs.mkdirSync(dir);
  await sched.update({ scheduleId: sc.id, at: new Date(h.clock.now() + MIN).toISOString() });
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 1);
  assert.match(sentText(h)[0] ?? '', /the news/);
  sched.stop();
});

test('scheduleChecks: a new check printing news leaves the old one\'s kept news alone', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  const outputs: Record<string, () => CheckResult> = { 'check-a': onceCheck('news from a'), 'check-b': onceCheck('news from b') };
  let current = 'check-a';
  const sched = schedulerOn(h, () => outputs[current](), seen);
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'check-a' });
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  h.clock.advance(5 * MIN);
  await tick(6);
  h.runner.refusing = undefined;
  current = 'check-b';
  // Run in the same millisecond A's news was kept, as on a fast machine.
  await sched.update({ scheduleId: sc.id, check: 'check-b' });
  await tick(6);
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.ok(sentText(h).some((m) => /news from b/.test(m)));
  h.adapter.last.init();
  h.adapter.last.result('completed');
  current = 'check-a';
  await sched.update({ scheduleId: sc.id, check: 'check-a' });
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.equal(seen.filter((c) => c === 'check-a').length, 1, 'a not run again');
  assert.ok(sentText(h).some((m) => /news from a/.test(m)));
  sched.stop();
});

test('scheduleChecks: Run now waits while the check is running, here or in the old runner', async () => {
  const h = makeHarness();
  let finish!: (r: CheckResult) => void;
  const sched = schedulerOn(h, () => new Promise<CheckResult>((r) => (finish = r)));
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', at: new Date(h.clock.now() + MIN).toISOString(), check: 'fork-watch' });
  h.clock.advance(MIN);
  await tick(6);
  await assert.rejects(sched.runNow(sc.id), /check is running/);
  finish({ ok: true, output: 'the news' });
  await tick(6);
  assert.match(sentText(h)[0] ?? '', /the news/);

  const other = await sched.create({ text: 'Look', title: 'Watch Sentry', cron: '@daily', check: 'fork-watch' });
  fs.writeFileSync(path.join(h.home, 'schedule-checks', `${other.id}.running.json`), JSON.stringify({ pid: process.ppid, at: h.clock.now() }));
  await assert.rejects(sched.runNow(other.id), /check is running/);
  sched.stop();
});

test('scheduleChecks: a check whose output can\'t be written down is still not run again by this runner', async () => {
  const h = makeHarness();
  const seen: string[] = [];
  const sched = schedulerOn(h, onceCheck('the news'), seen);
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'fork-watch' });
  // A folder where the kept file would go makes the write fail.
  fs.mkdirSync(keptCheckFile(h.home, sc.id, 'fork-watch'), { recursive: true });
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  h.clock.advance(5 * MIN);
  await tick(6);
  h.runner.refusing = undefined;
  h.clock.advance(MIN);
  await tick(6);
  assert.equal(seen.length, 1);
  assert.match(sentText(h)[0] ?? '', /the news/);
  sched.stop();
});

test('scheduleChecks: output kept only in memory is written down before the runner exits', async () => {
  const h = makeHarness();
  const sched = schedulerOn(h, onceCheck('the news'));
  const sc = await sched.create({ text: 'Look', title: 'Watch Sentry', cron: '*/5 * * * *', check: 'fork-watch' });
  const file = keptCheckFile(h.home, sc.id, 'fork-watch');
  fs.mkdirSync(file, { recursive: true });
  h.runner.refuseNewTurns('The runner is restarting; send again in a moment.');
  h.clock.advance(5 * MIN);
  await tick(6);
  fs.rmdirSync(file);
  sched.stop();
  await sched.settled();
  assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).extra, /the news/);
});

// A check that needs longer than a minute (6 Nov 2026: the Slack watch's
// read through `codex exec` took 77 s and failed every hour, schedule
// 7a3a98d9) says so on its schedule.
test('scheduleChecks: a schedule sets how long its check may take, 60 s without, at most 300', async () => {
  const h = makeHarness();
  const limits: (number | undefined)[] = [];
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', checksOn: () => true, runCheck: async (p) => (limits.push(p.timeoutMs), { ok: true, output: '' }) });
  sched.start();
  const sc = await sched.create({ text: 'Read Slack', title: 'Slack', cron: '*/5 * * * *', check: 'slack-read', checkTimeoutSecs: 180 });
  assert.equal(sc.checkTimeoutSecs, 180);
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.deepEqual(limits, [180_000]);
  assert.equal((await sched.update({ scheduleId: sc.id, checkTimeoutSecs: null })).checkTimeoutSecs, undefined);
  h.clock.advance(5 * MIN);
  await tick(6);
  assert.deepEqual(limits, [180_000, 60_000]);
  for (const bad of [0, 301, 1.5]) await assert.rejects(sched.update({ scheduleId: sc.id, checkTimeoutSecs: bad }), /from 1 to 300/);
  await assert.rejects(sched.create({ text: 'x', cron: '@daily', check: 'ls', checkTimeoutSecs: 600 }), /from 1 to 300/);
  // Taking the check off keeps its time, for when one is put back.
  await sched.update({ scheduleId: sc.id, checkTimeoutSecs: 120 });
  assert.equal((await sched.update({ scheduleId: sc.id, check: null })).checkTimeoutSecs, 120);
  sched.stop();
});

test('scheduleChecks: a stop waits out the longest check under way, not just a minute', async () => {
  const h = makeHarness();
  let finish!: (r: CheckResult) => void;
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', checksOn: () => true, runCheck: () => new Promise<CheckResult>((r) => (finish = r)) });
  sched.start();
  await sched.create({ text: 'Read Slack', title: 'Slack', cron: '*/5 * * * *', check: 'slack-read', checkTimeoutSecs: 180 });
  h.clock.advance(5 * MIN);
  await tick(6);
  sched.stop();
  let done = false;
  const settled = sched.settled().then(() => (done = true));
  h.clock.advance(90_000);
  await tick(6);
  assert.equal(done, false, 'still within its 180 s');
  finish({ ok: true, output: '' });
  await settled;
});

test("scheduleChecks: another process's marker stays live for twice its own check's limit", () => {
  const h = makeHarness();
  const dir = path.join(h.home, 'schedule-checks');
  fs.mkdirSync(dir, { recursive: true });
  const at = 1_000_000;
  // The test runner's parent stands in for the other, live process.
  fs.writeFileSync(path.join(dir, 's1.running.json'), JSON.stringify({ pid: process.ppid, at, limitMs: 180_000 }));
  assert.equal(checkRunningElsewhere(h.home, 's1', at + 300_000), true);
  assert.equal(checkRunningElsewhere(h.home, 's1', at + 361_000), false);
  // An older release's marker has no limit: a minute, as before.
  fs.writeFileSync(path.join(dir, 's1.running.json'), JSON.stringify({ pid: process.ppid, at }));
  assert.equal(checkRunningElsewhere(h.home, 's1', at + 121_000), false);
  // Our own marker carries the limit it was given.
  markCheckRunning(h.home, 's2', at, 180_000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's2.running.json'), 'utf8')).limitMs, 180_000);
});

test('scheduleChecks: the backend gets checkTimeoutSecs only from API 55, and the tools offer it with check', () => {
  const s = { id: 'a', runnerId: 'r', title: 't', text: 'x', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, check: 'ls', checkTimeoutSecs: 180 };
  assert.equal(toOwnedScheduleDoc(s as never, 54).checkTimeoutSecs, undefined);
  assert.equal(toOwnedScheduleDoc(s as never, 54).check, 'ls');
  assert.equal(toOwnedScheduleDoc(s as never, 55).checkTimeoutSecs, 180);
  const { h, sched } = setup();
  for (const name of ['schedule_message', 'update_schedule']) {
    const keys = (on: boolean) => {
      const tools = buildThreadbearTools(h.runner, 'x', Date.now, sched, undefined, undefined, { scheduleChecks: () => on }) as unknown as { name: string; inputSchema: Record<string, unknown> }[];
      return Object.keys(tools.find((t) => t.name === name)!.inputSchema);
    };
    assert.ok(keys(true).includes('checkTimeoutSecs'), name);
    assert.ok(!keys(false).includes('checkTimeoutSecs'), name);
  }
  sched.stop();
});

test('runCheck: a timeout says how to give the check longer', async () => {
  const slow = await runCheck({ command: 'sleep 5', cwd: tmpDir(), home: tmpDir(), scheduleId: 'abc', timeoutMs: 200 });
  assert.match((slow as { why: string }).why, /checkTimeoutSecs can give it up to 300/);
});

test('checkLimitMs: a value from the backend that is not a positive number is the default, and over 300 is capped', () => {
  for (const v of [undefined, -1, 0, NaN, '180', null]) assert.equal(checkLimitMs(v), 60_000, String(v));
  assert.equal(checkLimitMs(180), 180_000);
  assert.equal(checkLimitMs(9999), 300_000);
});
