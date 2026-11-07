// Handovers (docs/protocol.md): a draining runner lets go of idle threads
// at once, keeps busy ones until nothing would be cut short, and a new
// runner on the same data dir adopts each one it hands over.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneCommands, ThreadRouter } from '../../src/handover.ts';
import { FakeAccounts, FakeAdapter, makeHarness, testConfig, tick, type Harness } from '../helpers/fakes.ts';
import { Runner, type Notification } from '../../src/runner.ts';
import { ThreadStore } from '../../src/store.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { ErrorCode, RpcError } from '../../src/protocol.ts';

const MIN = 60_000;

function create(h: Harness, text = 'Fix the tests') {
  return h.runner.create({ text, accountId: 'claude-3' });
}

// A second runner on the same data dir, as the new release would be.
function primary(h: Harness, skip: string[]) {
  const adapter = new FakeAdapter();
  const notes: Notification[] = [];
  const runner = new Runner({
    config: testConfig(h.home),
    store: new ThreadStore(h.home),
    adapters: { claude: adapter, codex: new FakeAdapter('codex') },
    accounts: new FakeAccounts(),
    clock: new FakeClock(),
    log: nullLogger,
    defer: (fn) => fn(),
    copyTranscript: () => false,
  });
  runner.onNotification((n) => notes.push(n));
  runner.start({ skip: new Set(skip) });
  return { runner, adapter, notes };
}

function threadFile(h: Harness, id: string): string {
  return path.join(h.home, 'threads', id, 'thread.json');
}

test('a draining runner lets idle threads go at once and keeps a busy one until its turn ends', async () => {
  const h = makeHarness();
  const idle = create(h, 'idle one').thread;
  const s1 = h.adapter.last;
  s1.init();
  s1.result('completed');
  const busy = create(h, 'busy one').thread;
  const s2 = h.adapter.last;
  s2.init();
  const handed: string[] = [];
  await h.runner.beginDrain([busy.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN });
  // The idle CLI exited and the runner no longer has the thread.
  assert.equal(s1.ended, true);
  assert.equal(h.runner.has(idle.id), false);
  assert.deepEqual(h.runner.keeping(), [busy.id]);
  assert.deepEqual(handed, []);
  // New threads belong on the new runner.
  assert.throws(() => create(h, 'new'), (e: unknown) => e instanceof RpcError && e.code === ErrorCode.busy);

  // The new runner loads the idle thread but not the busy one.
  const b = primary(h, [busy.id]);
  assert.deepEqual(b.runner.threadIds(), [idle.id]);

  s2.text('m1:0', 'done');
  s2.result('completed');
  await tick();
  assert.equal(s2.ended, true);
  assert.deepEqual(handed, [busy.id]);
  assert.deepEqual(h.runner.keeping(), []);
  const adopted = b.runner.adopt(busy.id)!;
  assert.equal(adopted.status, 'idle');
  assert.equal(adopted.lastSeq, h.store.log(busy.id).lastSeq);
  // It carries on there: the next message resumes the same session.
  b.runner.send(busy.id, 'and then');
  assert.equal(b.adapter.last.opts.resume, true);
  assert.equal(b.adapter.last.opts.sessionId, s2.opts.sessionId);
});

// The old runner still answers the app on the runner's port for a few
// seconds after letting the idle threads go, until its drain port is up.
// Mike picked an effort then and saw "Thread not found" (7 Nov): the app
// tries again on the new runner on these words (AppModel.turnedAwayByRestart).
test('a thread a draining runner has let go is "handing over", not "not found", until the new runner has it', async () => {
  const h = makeHarness();
  const idle = create(h, 'idle one').thread;
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await h.runner.beginDrain([], { onHandedOver: () => {}, backgroundMs: 30 * MIN });
  assert.equal(h.runner.has(idle.id), false);
  const handingOver = (e: unknown) => e instanceof RpcError && e.code === ErrorCode.busy && e.message.startsWith('The runner is handing over to a new one');
  assert.throws(() => h.runner.update({ threadId: idle.id, effort: 'high' }), handingOver);
  assert.throws(() => h.runner.get(idle.id), handingOver);
  assert.throws(() => h.runner.send(idle.id, 'hello'), handingOver);
  // Without a drain, a thread that isn't there is still not found.
  const fresh = makeHarness();
  assert.throws(() => fresh.runner.get(idle.id), (e: unknown) => e instanceof RpcError && e.code === ErrorCode.threadNotFound);
});

test('a message queued during the turn moves across with the thread and starts on the new runner', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN });
  const b = primary(h, [t.id]);
  // Queued (as a schedule's message is) rather than steered into the turn.
  const queued = h.runner.send(t.id, 'next thing', [], { queue: true });
  s.result('completed');
  await tick();
  assert.deepEqual(handed, [t.id]);
  // Nothing more started on the old runner.
  assert.equal(h.adapter.sessions.length, 1);
  b.runner.adopt(t.id);
  assert.deepEqual(b.adapter.last.sent, [{ id: queued.turnId, text: 'next thing', images: [] }]);
  assert.equal(b.runner.get(t.id).status, 'starting');
});

test('a message to a thread that background work is holding starts at once on the old runner', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  // Background work keeps it after the turn.
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm test' }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN });
  assert.deepEqual(handed, []);
  // Waiting for the work to end could take half an hour, with Mike's answer
  // unread and his card still open.
  h.runner.send(t.id, 'how did it go?');
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1].text, 'how did it go?');
  assert.equal(h.runner.get(t.id).status, 'running');
  // It still moves across once the turn and the work are over.
  s.result('completed');
  s.out({ kind: 'tasks', tasks: [] });
  await tick();
  h.clock.advance(20_000); // past the wake grace
  await tick();
  assert.deepEqual(handed, [t.id]);
  const b = primary(h, [t.id]);
  b.runner.adopt(t.id);
  b.runner.send(t.id, 'and then');
  assert.equal(b.adapter.last.opts.resume, true);
  assert.equal(b.adapter.last.opts.sessionId, s.opts.sessionId);
});

test('a message queued during the turn starts on the old runner if background work outlives the turn', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm test' }] });
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN });
  h.runner.send(t.id, 'next thing', [], { queue: true });
  s.result('completed');
  await tick();
  assert.deepEqual(handed, []);
  assert.equal(s.sent.at(-1)?.text, 'next thing');
});

test('a message to a thread on its way across waits for the new runner', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN, checkMs: MIN });
  // The limit passes: the runner starts letting go of it, which stops the
  // work. Starting a turn now would be on a CLI that's leaving.
  h.clock.advance(30 * MIN);
  h.runner.send(t.id, 'how did it go?');
  assert.equal(s.sent.length, 1);
  await tick();
  assert.deepEqual(handed, [t.id]);
  const b = primary(h, [t.id]);
  b.runner.adopt(t.id);
  assert.equal(b.adapter.last.sent[0].text, 'how did it go?');
});

test('background work holds a kept thread for backgroundMs after its turn, then is stopped with a note', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN, checkMs: MIN });
  h.clock.advance(29 * MIN);
  await tick();
  assert.deepEqual(handed, []);
  assert.equal(s.ended, false);
  h.clock.advance(MIN);
  await tick();
  assert.deepEqual(handed, [t.id]);
  assert.equal(s.endedHard, true);
  const notes = h.events(t.id).filter((e) => e.type === 'system.note').map((e) => e.text);
  assert.ok(notes.some((n) => /Stopped background work.*npm run dev/.test(n)), notes.join('\n'));
});

// A kept thread whose background work has just been stopped at the limit,
// and the new runner, which hasn't loaded it yet.
async function stoppedAtTheLimit(h: Harness, description = 'Wait for the scan') {
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN, checkMs: MIN });
  h.clock.advance(30 * MIN);
  await tick();
  assert.deepEqual(handed, [t.id]);
  return { t, b: primary(h, [t.id]) };
}

test('a thread whose background work a handover stopped is woken once on the new runner', async () => {
  const h = makeHarness();
  const { t, b } = await stoppedAtTheLimit(h);
  b.runner.adopt(t.id);
  const sent = b.adapter.last.sent;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /stopped this background job/);
  assert.match(sent[0].text, /Wait for the scan/);
  const message = b.runner.events(t.id, {}).events.filter((e) => e.type === 'user.message').at(-1) as any;
  assert.equal(message.origin, 'runner');
  // Told, so a later start or look doesn't say it again.
  b.adapter.last.init();
  b.adapter.last.result('completed');
  await tick();
  b.runner.tellStoppedWork();
  assert.equal(b.adapter.last.sent.length, 1);
});

test('a thread put away after its background work stopped is left alone', async () => {
  const h = makeHarness();
  const { t, b } = await stoppedAtTheLimit(h);
  const rec = JSON.parse(fs.readFileSync(threadFile(h, t.id), 'utf8'));
  rec.archivedAt = new Date(h.clock.now()).toISOString();
  fs.writeFileSync(threadFile(h, t.id), JSON.stringify(rec));
  b.runner.adopt(t.id);
  assert.equal(b.adapter.sessions.length, 0);
  assert.ok(b.runner.get(t.id).archivedAt, 'still archived');
});

test('a stopped wait started again wakes the thread at most three times until someone writes', async () => {
  const h = makeHarness();
  const { t, b } = await stoppedAtTheLimit(h);
  const stopAgainOn = async (r: ReturnType<typeof primary>) => {
    r.runner.adopt(t.id);
    const texts = r.adapter.sessions.flatMap((s: any) => s.sent.map((m: any) => m.text as string));
    const s = r.adapter.last;
    if (!texts.length) return { texts, next: undefined };
    s.init();
    s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'Wait for the scan' }] });
    s.result('completed');
    await r.runner.shutdown();
    return { texts, next: primary(h, [t.id]) };
  };
  const first = await stopAgainOn(b);
  assert.equal(first.texts.length, 1);
  assert.doesNotMatch(first.texts[0], /won't wake/);
  const second = await stopAgainOn(first.next!);
  assert.equal(second.texts.length, 1);
  const third = await stopAgainOn(second.next!);
  assert.equal(third.texts.length, 1);
  assert.match(third.texts[0], /won't wake this thread for this again/);
  const last = third.next!;
  last.runner.adopt(t.id);
  assert.equal(last.adapter.sessions.length, 0, 'not a fourth time');
  const notes = last.runner.events(t.id, {}).events.filter((e) => e.type === 'system.note').map((e) => (e as any).text as string);
  assert.match(notes.at(-1)!, /Not waking this thread/);
  // Someone writing starts the count again (sendTo clears it).
  last.runner.send(t.id, 'carry on');
  await last.runner.shutdown();
  assert.equal(JSON.parse(fs.readFileSync(threadFile(h, t.id), 'utf8')).stoppedWorkWakes, undefined);
});

test('a thread whose background work a plain restart stopped is told once the next runner is up', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'Wait for the scan' }] });
  s.result('completed');
  await h.runner.shutdown();
  const b = primary(h, []);
  assert.equal(b.adapter.sessions.length, 0, 'not before it is listening');
  b.runner.tellStoppedWork();
  assert.match(b.adapter.last.sent[0].text, /Wait for the scan/);
});

test('a runner away for more than a day leaves a note rather than waking the thread', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'Wait for the scan' }] });
  s.result('completed');
  await h.runner.shutdown();
  const rec = JSON.parse(fs.readFileSync(threadFile(h, t.id), 'utf8'));
  rec.stoppedWork.at = new Date(Date.parse(rec.stoppedWork.at) - 25 * 60 * MIN).toISOString();
  fs.writeFileSync(threadFile(h, t.id), JSON.stringify(rec));
  const b = primary(h, []);
  b.runner.tellStoppedWork();
  assert.equal(b.adapter.sessions.length, 0);
  const notes = b.runner.events(t.id, {}).events.filter((e) => e.type === 'system.note').map((e) => (e as any).text as string);
  assert.match(notes.at(-1)!, /Not waking this thread.*more than a day/);
});

test('by default a background wait is held for 4 hours after its last turn, so an update does not cut it off', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'Wait for the scan' }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), checkMs: MIN });
  h.clock.advance(239 * MIN);
  await tick();
  assert.deepEqual(handed, []);
  assert.equal(s.ended, false);
  h.clock.advance(MIN);
  await tick();
  assert.deepEqual(handed, [t.id]);
});

test('a thread kept in use goes across once it has been on the old runner 12 hours and gone quiet for 30 minutes', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), checkMs: MIN });
  // Someone keeps using it, so the 4 hours never pass.
  for (const hours of [3, 3, 3, 2.75]) {
    h.clock.advance(hours * 60 * MIN);
    await tick();
    h.runner.send(t.id, 'one more thing');
    s.result('completed');
    await tick();
  }
  // 11 hours 45 in. Twelve hours pass, but it was only just used.
  h.clock.advance(29 * MIN);
  await tick();
  assert.deepEqual(handed, []);
  h.clock.advance(MIN);
  await tick();
  assert.deepEqual(handed, [t.id]);
});

test('an approval holds a kept thread until it is answered', async () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'edit it', accountId: 'claude-3', permissionMode: 'ask' }).thread;
  const s = h.adapter.last;
  s.init();
  const decision = s.sink.requestApproval({ toolUseId: 'tu1', name: 'Bash', title: 'rm -rf build', input: { command: 'rm -rf build' }, canAlwaysAllow: true, signal: new AbortController().signal });
  const approvalId = (h.events(t.id).find((e) => e.type === 'approval.requested') as any).approvalId;
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN });
  h.runner.respondApproval({ threadId: t.id, approvalId, decision: 'allow' });
  assert.equal((await decision).decision, 'allow');
  assert.deepEqual(handed, []);
  s.result('completed');
  await tick();
  assert.deepEqual(handed, [t.id]);
});

test('a thread left by a draining runner that died is adopted as after a crash', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  h.adapter.last.init();
  h.runner.flush();
  // The old runner is gone mid-turn; thread.json still says running.
  const b = primary(h, [t.id]);
  const adopted = b.runner.adopt(t.id, { crashed: true })!;
  assert.equal(adopted.status, 'stopped');
  const last = b.notes.filter((n) => n.method === 'thread.event').map((n: any) => n.params.event).at(-1);
  assert.equal(last.type, 'turn.completed');
  assert.equal(last.outcome, 'interrupted');
});

test('a kept thread hibernated until the runner restarts wakes when it comes across', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN });
  h.runner.update({ threadId: t.id, snoozedUntil: 'restart' });
  s.result('interrupted');
  await tick();
  assert.deepEqual(handed, [t.id]);
  const b = primary(h, [t.id]);
  const adopted = b.runner.adopt(t.id)!;
  assert.equal(adopted.snoozedUntil, undefined);
  assert.equal(adopted.snoozedUntilRestart, undefined);
});

test('Peers: a draining runner\'s threads are marked onOldRunner, its usage readings come here, and changes are told', async () => {
  const h = makeHarness();
  const home = h.home;
  const { writeDrainInfo, Peers } = await import('../../src/handover.ts');
  writeDrainInfo(home, { pid: 424242, port: 1, version: 'old', since: new Date().toISOString(), threads: ['t-old'] });
  let notify: (m: string, p: any) => void = () => {};
  const client = {
    call: async (method: string) => {
      if (method === 'drain.hello') return { threads: ['t-old'], version: 'old' };
      if (method === 'threads.list') return { threads: [{ id: 't-old', title: 'Old', status: 'running', lastActivityAt: '2026-01-01T00:00:00Z' }] };
      return {};
    },
    onNotification: (fn: (m: string, p: any) => void) => ((notify = fn), () => {}),
    waitClosed: () => new Promise<never>(() => {}),
    close: () => {},
  };
  const published: any[] = [];
  const readings: string[] = [];
  let changes = 0;
  const peers = new Peers({
    home,
    token: 't',
    log: nullLogger,
    runner: { adopt: () => undefined, publish: (n) => published.push(n), waitedOnDeleted: () => {} },
    sweep: async () => {},
    connect: async () => client as any,
    alive: () => true,
    usage: (accountId) => readings.push(accountId),
    onChange: () => changes++,
  });
  assert.deepEqual([...(await peers.connectAll())], ['t-old']);
  assert.equal(changes, 1);
  assert.equal(peers.find('t-old')!.onOldRunner, true);
  notify('thread.updated', { thread: { id: 't-old', title: 'Old', status: 'idle', lastActivityAt: '2026-01-01T00:01:00Z' } });
  assert.equal(published.at(-1).params.thread.onOldRunner, true);
  notify('drain.usage', { accountId: 'claude-3', reading: { windows: [] } });
  assert.deepEqual(readings, ['claude-3']);
  notify('drain.handedOver', { threadId: 't-old' });
  assert.equal(changes, 2);
  assert.deepEqual(peers.status()[0].threads, []);
});

test('subagents hold a kept thread until they finish (up to agentMs); shells only for backgroundMs', async () => {
  const h = makeHarness();
  const t = create(h).thread;
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'a1', type: 'local_agent', kind: 'agent', description: 'Build the worktree feature' }] });
  s.result('completed');
  const handed: string[] = [];
  await h.runner.beginDrain([t.id], { onHandedOver: (id) => handed.push(id), backgroundMs: 30 * MIN, agentMs: 240 * MIN, checkMs: MIN });
  // Past the shells' limit, the subagent still holds it.
  h.clock.advance(60 * MIN);
  await tick();
  assert.deepEqual(handed, []);
  assert.equal(s.ended, false);
  // It finishes; the thread goes across without anything being stopped.
  s.out({ kind: 'tasks', tasks: [] });
  h.clock.advance(20_000);
  await tick();
  h.clock.advance(MIN);
  await tick();
  assert.deepEqual(handed, [t.id]);
  assert.equal(s.endedHard, false);
});

test('Peers: once closed (this runner is draining), a thread coming across is not taken in here', async () => {
  const h = makeHarness();
  const { writeDrainInfo, Peers } = await import('../../src/handover.ts');
  writeDrainInfo(h.home, { pid: 434343, port: 1, version: 'old', since: new Date().toISOString(), threads: ['t-old'] });
  let notify: (m: string, p: any) => void = () => {};
  const client = {
    call: async (method: string) => (method === 'drain.hello' ? { threads: ['t-old'] } : method === 'threads.list' ? { threads: [{ id: 't-old', title: 'Old', lastActivityAt: '' }] } : {}),
    onNotification: (fn: (m: string, p: any) => void) => ((notify = fn), () => {}),
    waitClosed: () => new Promise<never>(() => {}),
    close: () => {},
  };
  const adopted: string[] = [];
  const peers = new Peers({ home: h.home, token: 't', log: nullLogger, runner: { adopt: (id) => (adopted.push(id), undefined), publish: () => {}, waitedOnDeleted: () => {} }, sweep: async () => {}, connect: async () => client as any, alive: () => true });
  await peers.connectAll();
  peers.close();
  notify('drain.handedOver', { threadId: 't-old' });
  assert.deepEqual(adopted, []);
});

test("the phone's commands reach a thread a draining runner still has", async () => {
  // 28 Oct: the phone's markSeen for a thread finishing its turn on the
  // old runner went to the primary's own runner and failed, again and
  // again, with "Thread not found".
  const { phoneCommands } = await import('../../src/handover.ts');
  const h = makeHarness();
  const idle = create(h, 'idle one').thread;
  h.adapter.last.init();
  h.adapter.last.result('completed');
  const busy = create(h, 'busy one').thread;
  h.adapter.last.init();
  await h.runner.beginDrain([busy.id], { onHandedOver: () => {}, backgroundMs: 30 * MIN });
  const b = primary(h, [busy.id]);
  const sent: [string, Record<string, unknown>][] = [];
  let moved = false;
  const remote = {
    owns: (id: string) => id === busy.id,
    call: async (_id: string, method: string, params: Record<string, unknown>) => {
      if (moved) {
        // The handover's notification lands first, then the answer.
        b.runner.adopt(busy.id);
        throw new RpcError(ErrorCode.moved, 'moved');
      }
      sent.push([method, params]);
      return {};
    },
  };
  const host = phoneCommands(b.runner, remote);
  await host.send(busy.id, 'from my phone', [], { origin: 'phone' });
  await host.markSeen(busy.id);
  await host.update({ threadId: busy.id, archived: true });
  await host.respondApproval({ threadId: busy.id, approvalId: 'a1', decision: 'allow' });
  await host.share(busy.id, { access: 'link' });
  assert.deepEqual(sent.map(([m]) => m), ['threads.send', 'threads.markSeen', 'threads.update', 'approvals.respond', 'threads.share']);
  assert.deepEqual(sent[0][1], { threadId: busy.id, text: 'from my phone', origin: 'phone' });
  assert.ok((sent[1][1].seq as number) >= Number.MAX_SAFE_INTEGER, 'seen up to whatever it has');
  // The primary's own threads are done here.
  await host.update({ threadId: idle.id, title: 'Renamed' });
  assert.equal(b.runner.get(idle.id).title, 'Renamed');
  assert.equal(sent.length, 5);
  // Handed over just as the command went: done here instead.
  moved = true;
  await host.update({ threadId: busy.id, title: 'Came across' });
  assert.equal(b.runner.get(busy.id).title, 'Came across');
});

test('a handed-over thread from before `asked` learns it from its log', () => {
  const h = makeHarness();
  const t = create(h, 'busy one').thread;
  h.runner.flush();
  const rec = JSON.parse(fs.readFileSync(threadFile(h, t.id), 'utf8'));
  delete rec.asked;
  fs.writeFileSync(threadFile(h, t.id), JSON.stringify(rec));
  const b = primary(h, [t.id]);
  assert.equal(b.runner.adopt(t.id)?.asked, 'busy one');
});

test('Peers: the bearer header goes only to a draining runner whose own drain file says it predates the challenge', async () => {
  // docs/protocol.md, "Before the challenge": the first handover onto a
  // release with the challenge is from one without it, which can't answer
  // one. The drain file, in this runner's own data dir, is what says so;
  // one from a challenge runner gets the challenge.
  const h = makeHarness();
  const { writeDrainInfo, Peers } = await import('../../src/handover.ts');
  writeDrainInfo(h.home, { pid: 454545, port: 1, version: 'old', since: new Date().toISOString(), threads: ['t-old'] });
  writeDrainInfo(h.home, { pid: 464646, port: 2, version: 'new', since: new Date().toISOString(), threads: ['t-new'], auth: 'challenge' });
  const asked: [number, boolean][] = [];
  const client = (threads: string[]) => ({
    call: async (method: string) => (method === 'drain.hello' ? { threads } : method === 'threads.list' ? { threads: threads.map((id) => ({ id, title: id, lastActivityAt: '' })) } : {}),
    onNotification: () => () => {},
    waitClosed: () => new Promise<never>(() => {}),
    close: () => {},
  });
  const peers = new Peers({
    home: h.home, token: 't', log: nullLogger, sweep: async () => {}, alive: () => true,
    runner: { adopt: () => undefined, publish: () => {}, waitedOnDeleted: () => {} },
    connect: async (port, _token, legacy) => (asked.push([port, legacy]), client(port === 1 ? ['t-old'] : ['t-new']) as any),
  });
  await peers.connectAll();
  assert.deepEqual(asked, [[1, true], [2, false]]);
  peers.close();
});

test('connectDrain: the bearer header goes only over a socket whose other end is the draining runner itself', async () => {
  const { connectDrain, socketOwnedBy } = await import('../../src/handover.ts');
  const { WebSocketServer } = await import('ws');
  const { spawn } = await import('node:child_process');
  // The listener is this test's process, so it plays the old draining
  // runner whose pid the drain file names.
  const seen: (string | undefined)[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws, req) => {
    seen.push(req.headers.authorization);
    ws.on('message', (d) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(d.toString()).id, result: { ok: true } })));
  });
  const port = (wss.address() as { port: number }).port;
  const c = await connectDrain(port, 'tok', true, process.pid);
  assert.deepEqual(await c.call('drain.hello'), { ok: true });
  c.close();
  assert.deepEqual(seen, ['Bearer tok']);

  // The drain file's pid is alive and ours, but something else has its port
  // (here, this process for a sleep's pid): nothing is sent.
  const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    await assert.rejects(connectDrain(port, 'tok', true, other.pid!, { attempts: 2 }), /isn't process/);
    // Someone else's process: refused before it even connects.
    await assert.rejects(socketOwnedBy(port, process.pid, { uidOf: async () => 0 }), /isn't this user's/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen, ['Bearer tok'], 'no request reached the listener');
  } finally {
    other.kill();
  }
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
});

test('connectDrain: a challenge draining runner is reached by the challenge, bound to its kind of server', async () => {
  const { connectDrain } = await import('../../src/handover.ts');
  const { RpcServer } = await import('../../src/rpc.ts');
  const h = makeHarness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: 'tok', runner: h.runner, log: nullLogger, onlyOwn: true });
  const { port } = await server.listen();
  const c = await connectDrain(port, 'tok', false, 1);
  assert.equal((await c.call('hello', { client: 't', version: '1' })).protocol, 1);
  c.close();
  await server.close();
});

test('lsof is looked for only where a Mac and Linux keep it', async () => {
  const { lsofPath } = await import('../../src/handover.ts');
  assert.equal(lsofPath((f) => f === '/usr/sbin/lsof'), '/usr/sbin/lsof');
  assert.equal(lsofPath((f) => f === '/usr/bin/lsof'), '/usr/bin/lsof');
  assert.equal(lsofPath(() => false), '/usr/sbin/lsof', 'neither: fails as a missing tool, and the check refuses');
});

// From the cross-lab review of the sync fixes (Codex, 7 Nov 2026): a draining
// runner whose socket closes is let go of before its threads are taken in, so
// for a few seconds they were on no runner, and the mirror's prune or its
// missing-row check could take their rows and messages for stale.
test('Peers: the threads of a draining runner that went are arriving until they are taken in', async () => {
  const h = makeHarness();
  const { writeDrainInfo, Peers } = await import('../../src/handover.ts');
  writeDrainInfo(h.home, { pid: 424243, port: 1, version: 'old', since: new Date().toISOString(), threads: ['t-old'] });
  let closed!: () => void;
  const client = {
    call: async (method: string) => (method === 'drain.hello' ? { threads: ['t-old'] } : method === 'threads.list' ? { threads: [{ id: 't-old', title: 'Old', lastActivityAt: '' }] } : {}),
    onNotification: () => () => {},
    waitClosed: () => new Promise<void>((r) => (closed = r)),
    close: () => {},
  };
  const adopted: string[] = [];
  let seenWhileWaiting: boolean | undefined;
  let alive = true;
  let gone = false;
  const peers = new Peers({
    home: h.home, token: 't', log: nullLogger, sweep: async () => {}, goneWaitMs: 400,
    alive: () => {
      if (gone && alive) seenWhileWaiting ??= peers.isArriving('t-old') && !peers.owns('t-old');
      return alive;
    },
    runner: { adopt: (id) => (adopted.push(id), undefined), publish: () => {}, waitedOnDeleted: () => {} },
    connect: async () => client as any,
  });
  await peers.connectAll();
  assert.equal(peers.owns('t-old'), true);
  gone = true;
  closed();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seenWhileWaiting, true, 'between the socket closing and being taken in');
  assert.deepEqual(peers.arrivingIds(), ['t-old']);
  alive = false;
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(adopted, ['t-old']);
  assert.equal(peers.isArriving('t-old'), false);
});

test("Peers: a thread that can't be taken in stays arriving, and one being handed over itself stops nothing", async () => {
  const h = makeHarness();
  const { writeDrainInfo, removeDrainInfo, Peers } = await import('../../src/handover.ts');
  const make = (pid: number, threads: string[], adopt: (id: string) => void, staysUp = false) => {
    writeDrainInfo(h.home, { pid, port: 1, version: 'old', since: new Date().toISOString(), threads });
    let closed!: () => void;
    let gone = false;
    const swept: number[] = [];
    const peers = new Peers({
      home: h.home, token: 't', log: nullLogger, goneWaitMs: staysUp ? 400 : 50, alive: () => staysUp || !gone,
      sweep: async (p) => void swept.push(p),
      runner: { adopt: (id) => (adopt(id), undefined), publish: () => {}, waitedOnDeleted: () => {} },
      connect: async () => ({
        call: async (method: string) => (method === 'drain.hello' ? { threads } : method === 'threads.list' ? { threads: threads.map((id) => ({ id, title: id, lastActivityAt: '' })) } : {}),
        onNotification: () => () => {},
        waitClosed: () => new Promise<void>((r) => (closed = r)),
        close: () => {},
      }) as any,
    });
    return { peers, close: () => ((gone = true), closed()), swept };
  };
  const adopted: string[] = [];
  const a = make(424250, ['bad', 'good'], (id) => {
    if (id === 'bad') throw new Error('disk full');
    adopted.push(id);
  });
  await a.peers.connectAll();
  a.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(adopted, ['good'], 'the rest are still taken in');
  assert.deepEqual(a.peers.arrivingIds(), ['bad']);
  removeDrainInfo(h.home, 424250);

  // Handing over itself while it waits: the draining runner isn't stopped from here.
  const took: string[] = [];
  const b = make(424251, ['t'], (id) => took.push(id), true);
  await b.peers.connectAll();
  b.close();
  await new Promise((r) => setTimeout(r, 100));
  b.peers.close();
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(b.swept, []);
  assert.deepEqual(took, []);
});

// docs/protocol.md, "Who stopped it": his Stop on the phone says so; an agent's
// interrupt_thread, which goes through the router, doesn't.
test("only the phone's Stop counts as Mike's, not an agent's interrupt_thread", async () => {
  const h = makeHarness();
  const ask = () => {
    const { thread } = h.runner.create({ text: 'go', cwd: h.cfg.defaults.cwd, accountId: 'claude-3', permissionMode: 'ask' });
    const s = h.adapter.last;
    s.init();
    s.result();
    return { id: thread.id, answer: s.sink.requestApproval({ name: 'Write', title: 'Write a', input: {}, canAlwaysAllow: false, signal: new AbortController().signal }) };
  };
  const phone = ask();
  await phoneCommands(h.runner).interrupt!(phone.id);
  assert.equal((await phone.answer).stopped, true);
  const agent = ask();
  await new ThreadRouter(h.runner, () => undefined).interrupt(agent.id);
  assert.equal((await agent.answer).stopped, undefined);
});
