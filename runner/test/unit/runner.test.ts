import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { checkSequence, checkSummary } from '../helpers/protocol-check.ts';
import { makePng } from '../helpers/png.ts';
import { RpcError } from '../../src/protocol.ts';
import { askedLine, UNTIL_RESTART, WROTE_INSTEAD } from '../../src/runner.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

const MIN = 60_000;

// Hooks and actions run real shells, so a test waits for their events.
async function until(check: () => boolean, what = 'the condition', ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function create(h: ReturnType<typeof makeHarness>, extra: Record<string, unknown> = {}) {
  return h.runner.create({ text: 'Fix the tests\nmore detail here', accountId: 'claude-3', ...extra });
}

test('create starts a turn: user.message, turn.started, a CLI with a pre-assigned session', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h, { model: 'claude-haiku-5-5' });
  assert.deepEqual(checkSummary(thread), []);
  assert.equal(thread.title, 'Fix the tests');
  assert.equal(thread.status, 'starting');
  assert.equal(thread.live, true);
  const s = h.adapter.last;
  assert.equal(s.opts.resume, false);
  assert.match(s.opts.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(s.opts.model, 'claude-haiku-5-5');
  assert.equal(s.opts.account.id, 'claude-3');
  assert.equal(s.opts.permissionMode, 'full');
  // The turnId goes with the message, so the CLI's turns can be matched to it.
  assert.deepEqual(s.sent, [{ id: turnId, text: 'Fix the tests\nmore detail here', images: [] }]);
  const evs = h.events(thread.id);
  assert.deepEqual(evs.map((e) => e.type), ['user.message', 'turn.started']);
  assert.ok(evs.every((e) => e.turnId === turnId));
  s.init();
  assert.equal(h.runner.get(thread.id).status, 'running');
  assert.equal(h.runner.get(thread.id).nativeSessionId, s.opts.sessionId);
});

test('deltas are coalesced, carry the last seq, and inProgress shows the partial text', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.delta('m1:0', 'Hel');
  s.delta('m1:0', 'lo ');
  s.delta('m1:0', 'there');
  assert.equal(h.events(thread.id).filter((e) => e.type === 'assistant.text.delta').length, 0, 'nothing sent before the flush interval');
  const page = h.runner.events(thread.id);
  assert.deepEqual(page.inProgress, [{ itemId: 'm1:0', type: 'assistant.text', text: 'Hello there' }]);
  const deltas = h.events(thread.id).filter((e) => e.type === 'assistant.text.delta');
  assert.equal(deltas.length, 1, 'events() flushed one coalesced delta');
  assert.equal(deltas[0].text, 'Hello there');
  assert.equal(deltas[0].seq, 2);
  s.delta('m1:0', '!');
  h.clock.advance(40);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'assistant.text.delta').length, 2);
  s.text('m1:0', 'Hello there!');
  assert.deepEqual(h.runner.events(thread.id).inProgress, []);
  s.result('completed', 0.01);
  const evs = h.events(thread.id);
  assert.deepEqual(checkSequence(evs), []);
  assert.deepEqual(
    evs.filter((e) => !e.type.endsWith('.delta')).map((e) => e.type),
    ['user.message', 'turn.started', 'assistant.text', 'turn.completed'],
  );
  const done = evs.at(-1);
  assert.equal(done.outcome, 'completed');
  assert.equal(done.costUsd, 0.01);
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'idle');
  assert.equal(t.preview, 'Hello there!');
  assert.equal(t.needsYou, true);
  assert.equal(t.costUsd, 0.01);
  assert.equal(h.runner.markSeen(thread.id, t.lastSeq).thread.needsYou, false);
});

test('seq replay: events pages and subscribe backlog have no gaps', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  for (let i = 0; i < 20; i++) s.text(`m${i}:0`, `reply ${i}`);
  s.result();
  const all = h.runner.events(thread.id, { limit: 1000 }).events;
  assert.equal(all.length, 23);
  assert.deepEqual(all.map((e) => e.seq), Array.from({ length: 23 }, (_, i) => i + 1));
  const newest = h.runner.events(thread.id, { limit: 5 });
  assert.deepEqual([newest.firstSeq, newest.lastSeq], [19, 23]);
  const older = h.runner.events(thread.id, { beforeSeq: 19, limit: 5 });
  assert.deepEqual(older.events.map((e) => e.seq), [14, 15, 16, 17, 18]);
  const after = h.runner.events(thread.id, { afterSeq: 20 });
  assert.deepEqual(after.events.map((e) => e.seq), [21, 22, 23]);
  const between = h.runner.events(thread.id, { afterSeq: 5, beforeSeq: 9 });
  assert.deepEqual(between.events.map((e) => e.seq), [6, 7, 8]);
  assert.deepEqual(h.runner.backlog(thread.id, 21).events.map((e) => e.seq), [22, 23]);
  // A restarted runner reads the same log.
  const h2 = h.restart();
  assert.equal(h2.runner.events(thread.id, { limit: 1000 }).events.length, 23);
  assert.equal(h2.runner.get(thread.id).lastSeq, 23);
});

test('idle release after 30 minutes, then the next send resumes the session', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'done');
  s.result('completed', 0.002);
  assert.ok(h.runner.hasIdleTimer(thread.id));
  h.clock.advance(30 * MIN - 1);
  assert.equal(s.ended, false);
  assert.equal(h.runner.isLive(thread.id), true);
  h.clock.advance(1);
  assert.equal(s.ended, true);
  await tick();
  assert.equal(h.runner.get(thread.id).live, false);
  const again = h.runner.send(thread.id, 'and again');
  await tick();
  assert.equal(h.adapter.sessions.length, 2);
  const s2 = h.adapter.last;
  assert.equal(s2.opts.resume, true);
  assert.equal(s2.opts.sessionId, s.opts.sessionId);
  assert.deepEqual(s2.sent, [{ id: again.turnId, text: 'and again', images: [] }]);
  const notes = h.events(thread.id).filter((e) => e.type === 'system.note');
  assert.deepEqual(notes.map((e) => e.text), ['Resumed session']);
  s2.init();
  // The CLI's cost total carries on across a resume.
  s2.result('completed', 0.005);
  const last = h.events(thread.id).at(-1);
  assert.equal(last.costUsd, 0.003);
  assert.equal(h.runner.get(thread.id).costUsd, 0.005);
});

test('a message from the phone tells the agent so, and where Mike is; the transcript keeps what he typed', async () => {
  let atMac: boolean | undefined;
  const h = makeHarness(undefined, {}, { atMac: () => atMac });
  const { thread, turnId } = create(h, { origin: 'phone' });
  const s = h.adapter.last;
  // Presence not checked yet: just where it came from.
  assert.deepEqual(s.sent, [{ id: turnId, text: '[Sent from the iPhone app]\nFix the tests\nmore detail here', images: [] }]);
  s.init();
  // Steered into the running turn, while he's away.
  atMac = false;
  h.runner.send(thread.id, 'on the bus', [], { origin: 'phone' });
  assert.equal(s.sent[1].text, '[Sent from the iPhone app, away from the Mac]\non the bus');
  // Typed at the Mac: nothing added.
  h.runner.send(thread.id, 'back at my desk');
  assert.equal(s.sent[2].text, 'back at my desk');
  s.result('completed', 0.01);
  await tick();
  // A new turn, sent from the phone at the desk.
  atMac = true;
  h.runner.send(thread.id, 'from the couch', [], { origin: 'phone' });
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)?.text, '[Sent from the iPhone app, at the Mac]\nfrom the couch');
  const typed = h.events(thread.id).filter((e) => e.type === 'user.message').map((e) => e.text);
  assert.deepEqual(typed, ['Fix the tests\nmore detail here', 'on the bus', 'back at my desk', 'from the couch']);
});

test('a send during a turn goes into it: shown at once, handed to the CLI, answered by that turn', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  const { turnId: got } = h.runner.send(thread.id, 'second');
  assert.equal(got, turnId, 'the reply names the running turn');
  assert.equal(s.sent.length, 2, 'went to the CLI straight away');
  assert.equal(s.sent[1].text, 'second');
  assert.notEqual(s.sent[1].id, turnId, 'with an id of its own, so the CLI can say when it was answered');
  const evs = h.events(thread.id);
  const um = evs.filter((e) => e.type === 'user.message');
  assert.equal(um.length, 2);
  assert.equal(um[1].turnId, turnId, 'shown in the running turn');
  assert.ok(evs.indexOf(um[1]) > evs.findIndex((e) => e.type === 'turn.started'));
  assert.equal(h.runner.get(thread.id).status, 'running');
  // The CLI folded it in: one result answers both.
  s.result('completed', 0.01, undefined, { answered: [turnId, s.sent[1].id!], answers: s.sent[1].id });
  const done = h.events(thread.id).filter((e) => e.type === 'turn.completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].turnId, turnId);
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.equal(h.runner.hasIdleTimer(thread.id), true);
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

test('a message sent during a turn that the CLI runs next keeps the turn open until it is answered', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'second');
  const second = s.sent[1].id!;
  s.text('m1:0', 'First answer.');
  // The reply was already finishing, so the CLI answers the first message
  // alone and runs the second straight after.
  s.result('completed', 0.01, undefined, { answered: [turnId], answers: turnId, queuedTurns: 1 });
  assert.equal(h.events(thread.id).filter((e) => e.type === 'turn.completed').length, 0, 'the turn goes on');
  assert.equal(h.runner.get(thread.id).status, 'running');
  assert.equal(h.runner.hasIdleTimer(thread.id), false);
  s.init();
  s.text('m2:0', 'Second answer.');
  s.result('completed', 0.03, undefined, { answered: [second], answers: second, queuedTurns: 0 });
  const evs = h.events(thread.id).filter((e) => !e.type.endsWith('.delta'));
  assert.deepEqual(
    evs.map((e) => e.type),
    ['user.message', 'turn.started', 'user.message', 'assistant.text', 'assistant.text', 'turn.completed'],
  );
  assert.ok(evs.every((e) => e.turnId === turnId), 'one thread turn for both CLI turns');
  assert.equal(evs.at(-1).costUsd, 0.03, 'the cost of both');
  assert.equal(h.runner.get(thread.id).status, 'idle');
});

test('a failure part way through a turn with a message still to answer is shown, and the turn goes on', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'second');
  const second = s.sent[1].id!;
  s.result('failed', 0.01, 'API overloaded', { answered: [turnId], answers: turnId, queuedTurns: 1 });
  let evs = h.events(thread.id);
  assert.equal(evs.at(-1).type, 'error');
  assert.equal(evs.at(-1).message, 'API overloaded');
  assert.equal(h.runner.get(thread.id).status, 'running');
  s.init();
  s.result('completed', 0.02, undefined, { answered: [second], answers: second, queuedTurns: 0 });
  evs = h.events(thread.id);
  assert.equal(evs.at(-1).type, 'turn.completed');
  assert.equal(evs.at(-1).outcome, 'completed');
  assert.equal(h.runner.get(thread.id).status, 'idle');
});

test('Stop cancels a message sent during the turn; it stays in the transcript', async () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'second');
  h.runner.interrupt(thread.id);
  await tick();
  assert.equal(s.interrupts, 1);
  // The CLI cancelled the queued message along with the turn.
  s.result('interrupted', 0.01, undefined, { answered: [turnId], answers: turnId, queuedTurns: 0 });
  const evs = h.events(thread.id);
  assert.equal(evs.at(-1).type, 'turn.completed');
  assert.equal(evs.at(-1).outcome, 'interrupted');
  assert.equal(evs.filter((e) => e.type === 'user.message').length, 2);
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.equal(s.sent.length, 2, 'nothing sent again');
  // Sent after Stop was pressed, before the CLI stopped: waits for the next turn.
  h.runner.interrupt(thread.id);
  assert.equal(h.runner.get(thread.id).status, 'idle');
});

test('a message sent after Stop, before the CLI has stopped, waits for the next turn', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.interrupt(thread.id);
  const { turnId: next } = h.runner.send(thread.id, 'try again');
  assert.equal(s.sent.length, 1, 'not handed to a CLI that is about to cancel its queue');
  s.result('interrupted');
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1].id, next);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message' && e.turnId === next).length, 1);
});

test('the CLI dropping a message sent during the turn ends the turn with a note', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'second');
  s.result('failed', 0.01, 'boom', { answered: [turnId], answers: turnId, queuedTurns: 0 });
  const evs = h.events(thread.id);
  assert.deepEqual(evs.slice(-3).map((e) => e.type), ['system.note', 'error', 'turn.completed']);
  assert.match(evs.at(-3).text, /dropped/);
  assert.equal(h.runner.get(thread.id).status, 'error');
});

test('a message sent while the last CLI is still leaving waits for the next turn', async () => {
  const h = makeHarness();
  h.adapter.slowExit = true;
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  h.clock.advance(30 * MIN);
  assert.equal(s.ended, true, 'released when idle');
  const { turnId: first } = h.runner.send(thread.id, 'first');
  const { turnId: second } = h.runner.send(thread.id, 'second');
  assert.notEqual(second, first, 'no CLI to join, so it gets a turn of its own');
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message').length, 2, 'the first is shown; the second waits');
  s.exit();
  await tick();
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.deepEqual(s2.sent.map((m) => m.id), [first]);
  s2.init();
  s2.result('completed', undefined, undefined, { answered: [first], answers: first });
  assert.deepEqual(s2.sent.map((m) => m.id), [first, second]);
  const um = h.events(thread.id).filter((e) => e.type === 'user.message');
  assert.deepEqual(um.slice(1).map((e) => e.turnId), [first, second]);
});

test('a message sent during a turn with a folder change due waits for the next turn', async () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  const dir = tmpDir();
  h.runner.update({ threadId: thread.id, cwd: dir });
  const { turnId: next } = h.runner.send(thread.id, 'in the new folder');
  assert.notEqual(next, turnId);
  assert.equal(s.sent.length, 1, 'meant for the new folder, not this CLI');
  s.result('completed', undefined, undefined, { answered: [turnId], answers: turnId });
  await tick();
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.cwd, dir);
  assert.deepEqual(s2.sent.map((m) => m.id), [next]);
});

test('interrupt asks the CLI to stop and the turn ends as interrupted', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.delta('m1:0', 'one two');
  h.runner.interrupt(thread.id);
  await tick();
  assert.equal(s.interrupts, 1);
  s.text('m1:0', 'one two');
  s.result('failed', 0.001, 'aborted');
  const done = h.events(thread.id).at(-1);
  assert.equal(done.type, 'turn.completed');
  assert.equal(done.outcome, 'interrupted');
  assert.equal(done.error, undefined);
  assert.equal(h.runner.get(thread.id).status, 'idle');
});

test('interrupt before the CLI is ready kills it and still ends the turn', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.interruptError = new Error('not ready');
  h.runner.interrupt(thread.id);
  await tick();
  assert.equal(s.killed, true);
  const done = h.events(thread.id).at(-1);
  assert.equal(done.outcome, 'interrupted');
  assert.equal(h.runner.get(thread.id).live, false);
});

test('ask mode: approval card, waiting status, allow resolves the CLI callback', async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  assert.equal(s.opts.permissionMode, 'ask');
  s.init();
  const ac = new AbortController();
  const answer = s.sink.requestApproval({ toolUseId: 'tu1', name: 'Bash', title: 'rm -rf build', input: { command: 'rm -rf build' }, canAlwaysAllow: true, signal: ac.signal });
  const req = h.events(thread.id).find((e) => e.type === 'approval.requested');
  assert.deepEqual(req.options, ['allow', 'allowAlways', 'deny']);
  assert.equal(req.itemId, 'tu1');
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'waiting');
  assert.equal(t.needsYou, true);
  assert.throws(() => h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'answered' }), RpcError);
  h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'allowAlways' });
  assert.deepEqual(await answer, { decision: 'allowAlways', message: undefined });
  const resolved = h.events(thread.id).find((e) => e.type === 'approval.resolved');
  assert.equal(resolved.decision, 'allowAlways');
  assert.equal(h.runner.get(thread.id).status, 'running');
  assert.throws(() => h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'allow' }), /no longer pending/);
});

test('questions are answered by question text, header or index', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  const questions = [
    { question: 'Tea or coffee?', header: 'Drink', multiSelect: false, options: [{ label: 'Tea' }, { label: 'Coffee' }] },
    { question: 'Milk?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
  ];
  const answer = s.sink.requestQuestion({ toolUseId: 'q1', questions, signal: new AbortController().signal });
  const req = h.events(thread.id).find((e) => e.type === 'question.requested');
  assert.deepEqual(req.questions, questions);
  h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'answered', answers: { Drink: 'Tea', '1': 'No' } });
  assert.deepEqual((await answer).answers, { 'Tea or coffee?': 'Tea', 'Milk?': 'No' });
  assert.equal(h.events(thread.id).at(-1).decision, 'answered');
});

test('a message written while a card is open declines the card so the CLI reads it', async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  const questions = [{ question: 'Which name?', multiSelect: false, options: [{ label: 'browse' }] }];
  const question = s.sink.requestQuestion({ toolUseId: 'q1', questions, signal: new AbortController().signal });
  const approval = s.sink.requestApproval({ toolUseId: 't1', name: 'Edit', title: 'Edit a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  assert.equal(h.runner.get(thread.id).status, 'waiting');
  h.runner.send(thread.id, 'Can you come up with some more options?');
  assert.deepEqual(await question, { answers: null, message: WROTE_INSTEAD });
  assert.deepEqual(await approval, { decision: 'deny', message: WROTE_INSTEAD });
  assert.deepEqual(h.events(thread.id).filter((e) => e.type === 'approval.resolved').map((e) => e.decision), ['deny', 'deny']);
  assert.equal(s.sent.at(-1)?.text, 'Can you come up with some more options?');
  assert.equal(h.runner.get(thread.id).status, 'running');
});

test('pending approvals expire when the CLI cancels or the turn is interrupted', async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  const ac = new AbortController();
  const a1 = s.sink.requestApproval({ name: 'Edit', title: 'Edit a.ts', input: {}, canAlwaysAllow: false, signal: ac.signal });
  ac.abort();
  assert.equal((await a1).decision, 'expired');
  const a2 = s.sink.requestApproval({ name: 'Edit', title: 'Edit a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  h.runner.interrupt(thread.id);
  assert.equal((await a2).decision, 'expired');
  const resolved = h.events(thread.id).filter((e) => e.type === 'approval.resolved').map((e) => e.decision);
  assert.deepEqual(resolved, ['expired', 'expired']);
});

test('snooze releases the CLI, hides the thread, and brings it back unread', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.markSeen(thread.id, 99);
  const until = new Date(h.clock.now() + 60 * MIN).toISOString();
  const res = h.runner.update({ threadId: thread.id, snoozedUntil: until });
  assert.equal(res.thread.snoozedUntil, until);
  assert.equal(s.ended, true);
  await tick();
  assert.equal(h.runner.get(thread.id).live, false);
  assert.deepEqual(h.runner.list().map((t) => t.id), []);
  assert.deepEqual(h.runner.list(['snoozed']).map((t) => t.id), [thread.id]);
  h.clock.advance(60 * MIN);
  assert.deepEqual(h.runner.list().map((t) => t.id), [thread.id]);
  const t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.needsYou, true);
  // It says it woke, and for how long it was away, until he looks.
  assert.equal(h.events(thread.id).at(-1).text, 'Woke up after hibernating for an hour.');
  assert.deepEqual(t.woke, { at: new Date(h.clock.now()).toISOString(), since: new Date(h.clock.now() - 60 * MIN).toISOString() });
  const seen = h.runner.markSeen(thread.id, t.lastSeq).thread;
  assert.equal(seen.needsYou, false);
  assert.equal(seen.woke, undefined);
});

test('the wake note counts from when it first went away, even if the time changed', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 60 * MIN).toISOString() });
  h.clock.advance(30 * MIN);
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 2 * 24 * 60 * MIN).toISOString() });
  h.clock.advance(2 * 24 * 60 * MIN);
  assert.equal(h.events(thread.id).at(-1).text, 'Woke up after hibernating for 2 days.');
  assert.ok(h.runner.get(thread.id).woke);
  // A message from him clears it as looking would.
  h.runner.send(thread.id, 'thanks');
  assert.equal(h.runner.get(thread.id).woke, undefined);
});

test('hibernating until a restart stops the turn, holds the restart no longer, and wakes on the next start', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  assert.equal(h.runner.get(thread.id).status, 'running');
  const res = h.runner.update({ threadId: thread.id, snoozedUntil: 'restart' });
  assert.equal(res.thread.snoozedUntilRestart, true);
  assert.equal(res.thread.snoozedUntil, UNTIL_RESTART);
  await tick();
  assert.equal(s.interrupts, 1);
  s.result('failed');
  // Not busy and no CLI left, so a pending restart no longer waits for it.
  assert.equal(s.ended, true);
  assert.notEqual(h.runner.get(thread.id).status, 'running');
  // A day on it's still away; only a start brings it back.
  h.clock.advance(24 * 60 * MIN);
  assert.deepEqual(h.runner.list(['snoozed']).map((t) => t.id), [thread.id]);
  const h2 = h.restart();
  const t = h2.runner.get(thread.id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.snoozedUntilRestart, undefined);
  // The restarted harness's clock starts again, so no time away to give.
  assert.equal(h2.events(thread.id).at(-1).text, 'Woke up, as the runner restarted.');
  assert.ok(t.woke);
  assert.equal(t.needsYou, true);
  assert.deepEqual(h2.runner.list().map((x) => x.id), [thread.id]);
});

test('a star stays through hibernating, archiving and a restart, keeps its time, and stops nothing', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  const first = h.runner.update({ threadId: thread.id, starred: true }).thread.starredAt;
  assert.ok(first);
  assert.equal(h.runner.get(thread.id).status, 'running', 'starring leaves the turn going');
  assert.equal(s.interrupts, 0);
  h.clock.advance(MIN);
  assert.equal(h.runner.update({ threadId: thread.id, starred: true }).thread.starredAt, first, 'starred again: keeps its place');
  h.runner.update({ threadId: thread.id, archived: true });
  assert.equal(h.runner.get(thread.id).starredAt, first);
  h.runner.update({ threadId: thread.id, archived: false });
  h.runner.update({ threadId: thread.id, snoozedUntil: 'restart' });
  const h2 = h.restart();
  assert.equal(h2.runner.get(thread.id).starredAt, first, 'kept on disk');
  assert.equal(h2.runner.update({ threadId: thread.id, starred: false }).thread.starredAt, undefined);
});

test('a dated snooze or a message clears an until-restart snooze', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: thread.id, snoozedUntil: 'restart' });
  const until = new Date(h.clock.now() + 60 * MIN).toISOString();
  const dated = h.runner.update({ threadId: thread.id, snoozedUntil: until }).thread;
  assert.equal(dated.snoozedUntil, until);
  assert.equal(dated.snoozedUntilRestart, undefined);
  h.runner.update({ threadId: thread.id, snoozedUntil: 'restart' });
  h.runner.send(thread.id, 'back to it');
  assert.equal(h.runner.get(thread.id).snoozedUntilRestart, undefined);
  assert.throws(() => h.runner.update({ threadId: thread.id, snoozedUntil: 'later' }), /ISO time, "restart" or "release"/);
});

test('an archive says who did it, and Mike\'s verdict goes in the thread', () => {
  const h = makeHarness();
  const { thread } = create(h);
  // ⌘E or a swipe: Mike, no verdict, no note.
  const plain = h.runner.update({ threadId: thread.id, archived: true }).thread;
  assert.equal(plain.archivedBy, 'mike');
  assert.equal(plain.archiveVerdict, undefined);
  assert.ok(!h.events(thread.id).some((e) => e.type === 'system.note' && /Archived by you/.test(e.text)));
  // Back, then the done card's menu: the verdict, and a note saying it.
  h.runner.update({ threadId: thread.id, archived: false });
  assert.equal(h.runner.get(thread.id).archivedBy, undefined, 'only while archived');
  const picked = h.runner.update({ threadId: thread.id, archived: true, verdict: 'worked' }).thread;
  assert.equal(picked.archivedBy, 'mike');
  assert.equal(picked.archiveVerdict, 'worked');
  assert.equal(h.events(thread.id).filter((e) => e.type === 'system.note').at(-1).text, 'Archived by you: it worked.');
  // Brought back by a message and put away by an agent: the old verdict goes.
  h.runner.send(thread.id, 'one more thing');
  assert.equal(h.runner.get(thread.id).archiveVerdict, undefined);
  const byAgent = h.runner.update({ threadId: thread.id, archived: true, archivedBy: 'agent', verdict: 'worked' }).thread;
  assert.equal(byAgent.archivedBy, 'agent');
  assert.equal(byAgent.archiveVerdict, undefined, "only Mike's verdict counts");
});

test('archive mid-turn interrupts, then releases the CLI; unarchive brings it back', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.update({ threadId: thread.id, archived: true });
  await tick();
  assert.equal(s.interrupts, 1);
  s.result('failed');
  assert.equal(s.ended, true, 'released straight after the turn');
  assert.equal(h.events(thread.id).at(-1).outcome, 'interrupted');
  assert.deepEqual(h.runner.list(['archived']).map((t) => t.id), [thread.id]);
  assert.ok(h.runner.get(thread.id).archivedAt);
  h.runner.update({ threadId: thread.id, archived: false });
  assert.deepEqual(h.runner.list().map((t) => t.id), [thread.id]);
});

test('changing account or folder starts a new native session with a handoff note', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'The tests pass now.');
  s.result('completed', 0.01);
  const other = tmpDir();
  h.runner.update({ threadId: thread.id, accountId: 'claude-main', cwd: other });
  assert.equal(s.ended, true);
  await tick();
  h.runner.send(thread.id, 'Now commit it');
  await tick();
  const s2 = h.adapter.last;
  assert.equal(s2.opts.resume, false);
  assert.notEqual(s2.opts.sessionId, s.opts.sessionId);
  assert.equal(s2.opts.account.id, 'claude-main');
  assert.equal(s2.opts.cwd, other);
  const sent = s2.sent[0].text;
  assert.match(sent, /^\[Threadbear handoff\]/);
  assert.match(sent, /User: Fix the tests/);
  assert.match(sent, /Assistant: The tests pass now\./);
  assert.ok(sent.endsWith('Now commit it'));
  assert.ok(!sent.includes('User: Now commit it'), 'the new message is not repeated in the note');
  const um = h.events(thread.id).filter((e) => e.type === 'user.message').at(-1);
  assert.equal(um.text, 'Now commit it', 'the transcript keeps what the user typed');
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && /Started a new session/.test(e.text)));
  // Cost keeps adding up across native sessions.
  s2.init();
  s2.result('completed', 0.004);
  assert.equal(h.runner.get(thread.id).costUsd, 0.014);
});

test('a send while the CLI is shutting down waits for it, then starts the next one', async () => {
  for (const how of ['idle', 'folder'] as const) {
    const h = makeHarness();
    h.adapter.slowExit = true;
    const { thread } = create(h);
    const s = h.adapter.last;
    s.init();
    s.result();
    if (how === 'idle') h.clock.advance(30 * MIN);
    else h.runner.update({ threadId: thread.id, cwd: tmpDir() });
    assert.equal(s.ended, true, `${how}: release started`);
    const { turnId } = h.runner.send(thread.id, 'next');
    await tick();
    assert.equal(h.adapter.sessions.length, 1, `${how}: never two CLIs on one thread`);
    s.exit();
    await tick();
    const evs = h.events(thread.id).filter((e) => e.turnId === turnId);
    assert.ok(!evs.some((e) => e.type === 'error' || e.type === 'turn.completed'), `${how}: the old CLI exiting doesn't end the new turn`);
    assert.equal(h.adapter.sessions.length, 2, `${how}: the next CLI started`);
    const s2 = h.adapter.last;
    assert.equal(s2.opts.resume, how === 'idle');
    assert.ok(s2.sent[0].text.endsWith('next'));
    s2.init();
    s2.result();
    assert.equal(h.events(thread.id).at(-1).outcome, 'completed');
    assert.equal(h.runner.get(thread.id).live, true);
  }
});

test('model and permission mode changes go to the live CLI', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.update({ threadId: thread.id, model: 'claude-haiku-5-5', permissionMode: 'ask' });
  assert.deepEqual(s.models, ['claude-haiku-5-5']);
  assert.deepEqual(s.modes, ['ask']);
  const t = h.runner.update({ threadId: thread.id, model: null }).thread;
  assert.equal(t.model, undefined);
  assert.deepEqual(s.models, ['claude-haiku-5-5', undefined]);
});

test('effort goes to the CLI at start and on change; null is the model\'s own level', () => {
  const h = makeHarness();
  const { thread } = create(h, { effort: 'low' });
  assert.deepEqual(checkSummary(thread), []);
  assert.equal(thread.effort, 'low');
  const s = h.adapter.last;
  assert.equal(s.opts.effort, 'low');
  s.init();
  h.runner.update({ threadId: thread.id, effort: 'max' });
  assert.deepEqual(s.efforts, ['max']);
  const t = h.runner.update({ threadId: thread.id, effort: null }).thread;
  assert.equal(t.effort, undefined);
  assert.deepEqual(s.efforts, ['max', undefined]);
  // What the CLI reports it ran at shows on the summary.
  s.effort('high');
  assert.equal(h.runner.get(thread.id).effortInUse, 'high');
  assert.deepEqual(checkSummary(h.runner.get(thread.id)), []);
});

test("a turn on a thread with no model shows the account's real default", () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init(undefined, 'claude-fable-5-1');
  const t = h.runner.get(thread.id);
  assert.equal(t.model, undefined);
  assert.equal(t.modelInUse, 'claude-fable-5-1');
  const note = h.notes.find((n) => n.method === 'accounts.updated');
  assert.ok(note && note.method === 'accounts.updated');
  assert.equal(note.params.accounts.find((a) => a.id === 'claude-3')?.defaultModel, 'claude-fable-5-1');
  assert.equal(h.runner.hello().accounts.find((a) => a.id === 'claude-3')?.defaultModel, 'claude-fable-5-1');
  // The same again isn't news.
  const before = h.notes.length;
  s.init(undefined, 'claude-fable-5-1');
  assert.equal(h.notes.filter((n) => n.method === 'accounts.updated').length, 1);
  assert.ok(h.notes.length >= before);
  // A thread with a model of its own says nothing about the default.
  const b = create(h, { model: 'haiku' }).thread;
  h.adapter.last.init(undefined, 'claude-haiku-5-5');
  assert.equal(h.runner.get(b.id).modelInUse, 'claude-haiku-5-5');
  assert.equal(h.runner.hello().accounts.find((a) => a.id === 'claude-3')?.defaultModel, 'claude-fable-5-1');
});

test('the model list comes from the adapter at startup and reaches clients', async () => {
  const h = makeHarness();
  const choices = [{ id: 'opus', model: 'claude-opus-5-5', title: 'Opus 5.5', effortLevels: ['low', 'high'] as const }];
  const asked: string[] = [];
  h.adapter.models = async (account) => {
    asked.push(account.id);
    return choices.map((c) => ({ ...c, effortLevels: [...c.effortLevels] }));
  };
  await h.runner.probeModels();
  assert.deepEqual(asked, ['claude-main', 'claude-3']);
  const note = h.notes.find((n) => n.method === 'accounts.updated');
  assert.ok(note && note.method === 'accounts.updated');
  assert.deepEqual(h.runner.hello().accounts.map((a) => a.models?.[0]?.title), ['Opus 5.5', 'Opus 5.5']);
  // A CLI that can't answer leaves the list unknown and the runner going.
  h.adapter.models = async () => {
    throw new Error('no cli');
  };
  await h.runner.probeModels();
  assert.equal(h.runner.hello().accounts[0].models?.length, 1);
});

test('a CLI that dies mid-turn fails the turn with an error event', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.sink.exited(new Error('Claude Code process exited with code 1'));
  const evs = h.events(thread.id);
  assert.deepEqual(evs.slice(-2).map((e) => e.type), ['error', 'turn.completed']);
  assert.equal(evs.at(-1).outcome, 'failed');
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'error');
  assert.equal(t.live, false);
});

test('startup recovery: mid-turn threads stop, approvals expire, queued text is kept', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  void s.sink.requestApproval({ name: 'Bash', title: 'ls', input: {}, canAlwaysAllow: true, signal: new AbortController().signal });
  h.runner.send(thread.id, 'queued while waiting');
  const approvalId = h.events(thread.id).find((e) => e.type === 'approval.requested').approvalId;
  // Simulate the runner dying: a new runner loads the same data dir.
  const h2 = h.restart();
  const t = h2.runner.get(thread.id);
  assert.equal(t.status, 'stopped');
  assert.equal(t.live, false);
  assert.equal(t.needsYou, true);
  const evs = h2.runner.events(thread.id).events;
  // The message went into the turn, so it's in the transcript already and
  // there's nothing queued to report.
  const tail = evs.slice(-3);
  assert.deepEqual(tail.map((e) => e.type), ['user.message', 'approval.resolved', 'turn.completed']);
  assert.equal((tail[0] as any).text, 'queued while waiting');
  assert.equal((tail[0] as any).turnId, turnId);
  assert.equal((tail[1] as any).approvalId, approvalId);
  assert.equal((tail[1] as any).decision, 'expired');
  assert.equal((tail[2] as any).turnId, turnId);
  assert.equal((tail[2] as any).outcome, 'interrupted');
  assert.deepEqual(checkSequence(evs), []);
  // Sending again resumes the session it had.
  h2.runner.send(thread.id, 'carry on');
  assert.equal(h2.adapter.last.opts.resume, true);
});

test("startup recovery: a subagent's card with no turn closes, and no turn is resumed for it", () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  void s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  const req = h.events(thread.id).at(-1) as any;
  const turns = h.events(thread.id).filter((e) => e.type === 'turn.completed').length;
  (h.runner as any).flush();
  const h2 = h.restart();
  const t = h2.runner.get(thread.id);
  assert.equal(t.status, 'idle', 'nothing was cut short but the subagent');
  const evs = h2.runner.events(thread.id).events;
  const closed = evs.find((e) => e.type === 'approval.resolved') as any;
  assert.equal(closed.approvalId, req.approvalId);
  assert.equal(closed.decision, 'expired');
  assert.equal(evs.filter((e) => e.type === 'turn.completed').length, turns, 'no turn to end');
  assert.deepEqual(checkSequence(evs), []);
});

// Codex review: thread.json a step behind the log, so the card looks open.
test("startup recovery: a card answered on disk keeps its answer", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  const answer = s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  const req = h.events(thread.id).at(-1) as any;
  const runner = h.runner as any;
  runner.flush();
  const stale = fs.readFileSync(path.join(h.cfg.home, 'threads', thread.id, 'thread.json'), 'utf8');
  h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'allow' });
  await answer;
  runner.flush();
  fs.writeFileSync(path.join(h.cfg.home, 'threads', thread.id, 'thread.json'), stale);
  const h2 = h.restart();
  const closed = h2.runner.events(thread.id).events.filter((e) => e.type === 'approval.resolved') as any[];
  assert.deepEqual(closed.map((e) => e.decision), ['allow']);
  assert.equal(h2.runner.get(thread.id).status, 'idle');
});

// Codex review: the parent's turn.completed reached the log, then a crash
// before thread.json was saved: recovery trusted the log's turn to have closed
// every card, and a subagent's stayed drawn as open for good.
test("startup recovery: a subagent's card open when the turn ended on disk still closes", () => {
  const h = makeHarness();
  const { thread, turnId } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  void s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  const req = h.events(thread.id).find((e) => e.type === 'approval.requested') as any;
  // The event log has the turn's end, thread.json doesn't yet.
  const runner = h.runner as any;
  runner.flush();
  const log = runner.store.log(thread.id);
  log.append({ seq: log.lastSeq + 1, ts: new Date().toISOString(), threadId: thread.id, turnId, type: 'turn.completed', outcome: 'completed', durationMs: 1 });
  const h2 = h.restart();
  assert.equal(h2.runner.get(thread.id).status, 'idle');
  const closed = h2.runner.events(thread.id).events.filter((e) => e.type === 'approval.resolved') as any[];
  assert.deepEqual(closed.map((e) => e.approvalId), [req.approvalId]);
});

test('startup recovery: a message still waiting for its turn is kept as a note', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  // A folder change is due on the next turn, so the message waits for it
  // rather than joining this one.
  h.runner.update({ threadId: thread.id, cwd: tmpDir() });
  h.runner.send(thread.id, 'queued while waiting');
  assert.equal(s.sent.length, 1);
  const h2 = h.restart();
  const evs = h2.runner.events(thread.id).events;
  const tail = evs.slice(-2);
  assert.deepEqual(tail.map((e) => e.type), ['turn.completed', 'system.note']);
  assert.equal((tail[0] as any).turnId, turnId);
  assert.match((tail[1] as any).text, /queued while waiting/);
  assert.deepEqual(checkSequence(evs), []);
});

test('stopping the runner mid-turn ends the turn as stopped, not failed', async () => {
  const h = makeHarness();
  const { thread, turnId } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.delta('m1:0', 'partial answer');
  const approval = s.sink.requestApproval({ name: 'Bash', title: 'ls', input: {}, canAlwaysAllow: true, signal: new AbortController().signal });
  await h.runner.shutdown();
  assert.equal((await approval).decision, 'expired');
  // The CLI dies as the runner kills its process group; that's not an error.
  s.sink.exited(new Error('Claude Code process exited with code 143'));
  const evs = h.events(thread.id).filter((e) => !e.type.endsWith('.delta'));
  assert.deepEqual(evs.slice(-3).map((e) => e.type), ['assistant.text', 'approval.resolved', 'turn.completed']);
  assert.equal(evs.at(-3).text, 'partial answer');
  const done = evs.at(-1);
  assert.equal(done.turnId, turnId);
  assert.equal(done.outcome, 'interrupted');
  assert.ok(!evs.some((e) => e.type === 'error'));
  assert.equal(h.runner.get(thread.id).status, 'stopped');
  // The next runner has nothing left to recover and resumes the session.
  const h2 = h.restart();
  assert.equal(h2.runner.get(thread.id).status, 'stopped');
  assert.equal(h2.runner.events(thread.id).events.at(-1)!.type, 'turn.completed');
  h2.runner.send(thread.id, 'carry on');
  assert.equal(h2.adapter.last.opts.resume, true);
});

test('list, search and protocol errors', () => {
  const h = makeHarness();
  const a = create(h).thread;
  h.clock.advance(1000);
  const b = h.runner.create({ text: 'Plan the garden shed', accountId: 'claude-main' }).thread;
  assert.deepEqual(h.runner.list().map((t) => t.id), [b.id, a.id]);
  assert.deepEqual(h.runner.search('garden').map((t) => t.id), [b.id]);
  assert.deepEqual(h.runner.search('FIX tests').map((t) => t.id), [a.id]);
  h.runner.update({ threadId: a.id, archived: true });
  assert.deepEqual(h.runner.search('fix').map((t) => t.id), [a.id], 'search includes archived threads');
  assert.throws(() => h.runner.get('nope'), (e: RpcError) => e.code === -32004);
  assert.throws(() => h.runner.create({ text: 'x', accountId: 'claude-99' }), (e: RpcError) => e.code === -32010);
  assert.throws(() => h.runner.create({ text: 'x', cwd: '/definitely/not/here' }), (e: RpcError) => e.code === -32602);
  assert.throws(() => h.runner.send(a.id, ''), (e: RpcError) => e.code === -32602);
});

test('images are copied into the thread media folder and sent with the message', () => {
  const h = makeHarness();
  const src = path.join(h.home, 'shot.png');
  fs.writeFileSync(src, makePng(20, 10));
  const { image } = h.runner.importMedia(src);
  assert.ok(image.path.startsWith(path.join(h.home, 'inbox')));
  assert.deepEqual([image.mediaType, image.width, image.height], ['image/png', 20, 10]);
  const { thread } = h.runner.create({ text: 'What is this?', images: [image] });
  const um = h.events(thread.id)[0];
  assert.equal(um.images.length, 1);
  assert.ok(um.images[0].path.startsWith(path.join(h.home, 'threads', thread.id, 'media')));
  assert.equal(um.images[0].width, 20);
  assert.deepEqual(h.adapter.last.sent[0].images, um.images);
  fs.rmSync(image.path);
  assert.ok(fs.existsSync(um.images[0].path), 'the thread keeps its copy when inbox is cleaned');
});

test('default account is the last one used', () => {
  const h = makeHarness();
  assert.equal(h.runner.hello().defaults.accountId, 'claude-main');
  create(h);
  assert.equal(h.runner.hello().defaults.accountId, 'claude-3');
  assert.equal(h.runner.create({ text: 'x' }).thread.accountId, 'claude-3');
});

test("runner.json's default model is used when a new thread names none", () => {
  // dev-runner.sh sets it, so a thread started from a debug app's composer
  // runs on the cheapest model rather than the account's default.
  const h = makeHarness(tmpDir(), { defaults: { cwd: tmpDir(), model: 'claude-haiku-5-5' } });
  assert.equal(h.runner.hello().defaults.model, 'claude-haiku-5-5');
  const a = h.runner.create({ text: 'x', accountId: 'claude-3' }).thread;
  assert.equal(a.model, 'claude-haiku-5-5');
  assert.equal(h.adapter.last.opts.model, 'claude-haiku-5-5');
  const b = h.runner.create({ text: 'y', accountId: 'claude-3', model: 'sonnet' }).thread;
  assert.equal(b.model, 'sonnet', 'a model given wins');
  assert.equal(makeHarness().runner.hello().defaults.model, undefined);
});

// ---------------------------------------------------------------- review fixes

test('a turn the CLI starts by itself gets turn events, a running status and needsYou', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq);
  assert.equal(h.runner.get(thread.id).needsYou, false);
  // A background shell finished; the CLI starts a turn on its own.
  s.out({ kind: 'cliTurn', note: 'Background command "sleep 5" completed (exit code 0)' });
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'running');
  assert.equal(h.runner.hasIdleTimer(thread.id), false, 'no idle release while it runs');
  s.text('m9:0', 'The background job finished.');
  // A message sent now goes into that turn, like any running turn.
  const { turnId: got } = h.runner.send(thread.id, 'thanks');
  assert.equal(s.sent.length, 2);
  const msgId = s.sent[1].id!;
  const started = h.events(thread.id).filter((e) => e.type === 'turn.started');
  const auto = started[1];
  assert.equal(got, auto.turnId);
  // The CLI's own turn ended before it took the message; it answers it next.
  s.result('completed', 0, undefined, { own: true, queuedTurns: 1 });
  assert.equal(h.runner.get(thread.id).status, 'running', 'the turn waits for the answer');
  s.init();
  s.text('m10:0', 'You are welcome.');
  s.result('completed', 0, undefined, { answered: [msgId], answers: msgId, queuedTurns: 0 });
  const evs = h.events(thread.id).filter((e) => !e.type.endsWith('.delta'));
  const autoEvents = evs.filter((e) => e.turnId === auto.turnId).map((e) => e.type);
  assert.deepEqual(autoEvents, ['turn.started', 'system.note', 'assistant.text', 'user.message', 'assistant.text', 'turn.completed']);
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
  assert.equal(h.runner.get(thread.id).needsYou, true);
  assert.equal(h.runner.hasIdleTimer(thread.id), true);
});

test("a message sent while only a background subagent's card is open starts a turn at once, and the card stays", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq);
  const started = h.events(thread.id).filter((e) => e.type === 'turn.started').length;
  const answer = s.sink.requestApproval({ name: 'Bash', title: 'npm test', input: {}, canAlwaysAllow: true, signal: new AbortController().signal });
  assert.equal(h.events(thread.id).filter((e) => e.type === 'turn.started').length, started, "a card isn't a turn");
  assert.equal(h.runner.get(thread.id).status, 'waiting');
  const { turnId: next } = h.runner.send(thread.id, 'while you wait');
  assert.equal(s.sent.length, 2, "it isn't held back behind the card");
  assert.equal(s.sent[1].id, next);
  assert.equal(h.runner.get(thread.id).status, 'waiting', 'the card is still open');
  const approvalId = h.events(thread.id).find((e) => e.type === 'approval.requested').approvalId;
  h.runner.respondApproval({ threadId: thread.id, approvalId, decision: 'allow' });
  assert.equal((await answer).decision, 'allow');
  assert.equal(h.runner.get(thread.id).status, 'running', 'his message is still being answered');
  s.result();
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

test("a CLI turn that starts while the thread's message waits in the CLI doesn't end that message's turn", () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  // The CLI was already busy with its own turn when the message arrived.
  s.out({ kind: 'cliTurn' });
  s.text('m1:0', 'Otters have thick fur.');
  s.out({ kind: 'result', result: { outcome: 'completed', durationMs: 5, own: true } });
  assert.equal(h.runner.get(thread.id).status, 'running', 'still waiting for its own answer');
  assert.ok(!h.events(thread.id).some((e) => e.type === 'turn.completed'));
  // A stale answer for some other message doesn't end it either.
  s.out({ kind: 'result', result: { outcome: 'completed', durationMs: 5, answers: 'some-other-id' } });
  assert.ok(!h.events(thread.id).some((e) => e.type === 'turn.completed'));
  s.text('m2:0', 'PINEAPPLE');
  s.out({ kind: 'result', result: { outcome: 'completed', durationMs: 5, answers: turnId } });
  const done = h.events(thread.id).filter((e) => e.type === 'turn.completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].turnId, turnId);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'turn.started').length, 1);
  assert.equal(h.runner.get(thread.id).status, 'idle');
});

test('a background subagent asking for approval with no turn running gets a card and no turn', async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  const answer = s.sink.requestApproval({ name: 'Bash', title: 'mkdir late-made', input: { command: 'mkdir late-made' }, canAlwaysAllow: true, signal: new AbortController().signal });
  const req = h.events(thread.id).find((e) => e.type === 'approval.requested');
  assert.ok(req, 'the card is shown');
  assert.equal(req.itemId, undefined);
  assert.equal(req.turnId, undefined);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'turn.started').length, 1);
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'waiting');
  assert.equal(t.needsYou, true);
  h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'allow' });
  assert.equal((await answer).decision, 'allow');
  assert.equal(h.runner.get(thread.id).status, 'idle');
  // The subagent finishes; the CLI's own turn reports it, then ends.
  s.out({ kind: 'cliTurn', note: 'Agent "make a folder" completed' });
  s.text('m5:0', 'Made the folder.');
  s.out({ kind: 'result', result: { outcome: 'completed', durationMs: 5, own: true } });
  assert.equal(h.events(thread.id).at(-1).type, 'turn.completed');
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

// 7 Nov 2026, thread 7a98a6fd: two subagents' cards waited half an hour with
// Mike away, then the parent's next turn ended and took them with it. The CLI
// then told the parent he had stopped them.
test("a subagent's card outlives its parent's turn, and can still be answered", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'auto' });
  const s = h.adapter.last;
  s.init();
  const answer = s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  let settled = false;
  void answer.then(() => (settled = true));
  s.result();
  await tick();
  assert.equal(settled, false, 'the turn ending leaves it open');
  const req = h.events(thread.id).find((e) => e.type === 'approval.requested');
  assert.ok(!h.events(thread.id).some((e) => e.type === 'approval.resolved'));
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'waiting', "still waiting on him, not finished");
  assert.equal(t.needsYou, true);
  h.runner.markSeen(thread.id, t.lastSeq);
  assert.equal(h.runner.get(thread.id).needsYou, true, 'reading the thread leaves it in Needs you');
  // A later turn of the CLI's own, opened and ended, leaves it open too.
  s.out({ kind: 'cliTurn' });
  assert.equal(h.runner.get(thread.id).status, 'waiting');
  s.out({ kind: 'result', result: { outcome: 'completed', durationMs: 5, own: true } });
  assert.equal(settled, false);
  h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'allow' });
  assert.equal((await answer).decision, 'allow');
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

test("the agent's own card still closes with its turn, and says the turn ended", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  const answer = s.sink.requestApproval({ toolUseId: 't1', name: 'Bash', title: 'ls', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  s.result();
  const a = await answer;
  assert.equal(a.decision, 'expired');
  assert.equal(a.message, 'The turn ended.');
  assert.equal(a.stopped, undefined, 'nobody stopped it');
  assert.equal(h.runner.get(thread.id).status, 'idle');
});

test("Stop closes a subagent's card with no turn running, and it's the only thing that says stopped", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  const answer = s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  const question = s.sink.requestQuestion({ questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }], signal: new AbortController().signal });
  h.runner.interrupt(thread.id, { byMike: true });
  const a = await answer;
  assert.equal(a.decision, 'expired');
  assert.equal(a.stopped, true);
  const q = await question;
  assert.equal(q.answers, null);
  assert.equal(q.stopped, true, 'a question stops its asker too');
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

test("an agent's or the runner's stop isn't told to the agent as Mike's", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  const answer = s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  h.runner.interrupt(thread.id);
  const a = await answer;
  assert.equal(a.decision, 'expired');
  assert.equal(a.stopped, undefined);
});

test("a subagent's card closes when its CLI goes, with no turn running", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  const answer = s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  s.kill();
  const a = await answer;
  assert.equal(a.decision, 'expired');
  assert.equal(a.message, 'The CLI stopped.');
  assert.equal(a.stopped, undefined);
  assert.equal(h.runner.get(thread.id).status, 'idle', 'nothing left to wait for');
});

test("a card answered with no turn and nothing running starts the idle countdown", async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  const answer = s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  assert.equal(h.runner.hasIdleTimer(thread.id), false, "it won't let go of a CLI with a card open");
  const req = h.events(thread.id).find((e) => e.type === 'approval.requested');
  h.runner.respondApproval({ threadId: thread.id, approvalId: req.approvalId, decision: 'deny' });
  await answer;
  assert.equal(h.runner.hasIdleTimer(thread.id), true);
});

test('an interrupted turn the CLI never ends is ended after a grace period', async () => {
  const h = makeHarness();
  const { thread, turnId } = create(h);
  const s = h.adapter.last;
  s.init();
  h.runner.interrupt(thread.id);
  await tick();
  assert.equal(s.interrupts, 1);
  h.clock.advance(9_999);
  assert.equal(h.runner.get(thread.id).status, 'running');
  h.clock.advance(1);
  const done = h.events(thread.id).at(-1);
  assert.equal(done.type, 'turn.completed');
  assert.equal(done.turnId, turnId);
  assert.equal(done.outcome, 'interrupted');
  assert.equal(h.runner.get(thread.id).status, 'idle');
  // A late result from the CLI changes nothing.
  s.result('interrupted');
  assert.equal(h.events(thread.id).filter((e) => e.type === 'turn.completed').length, 1);
});

test('background work keeps the CLI past the idle time; release afterwards', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] });
  s.result();
  assert.equal(h.runner.hasIdleTimer(thread.id), false);
  h.clock.advance(3 * 30 * MIN);
  assert.equal(s.ended, false, 'not released while the job runs');
  s.out({ kind: 'tasks', tasks: [] });
  assert.equal(h.runner.hasIdleTimer(thread.id), true);
  h.clock.advance(30 * MIN);
  assert.equal(s.ended, true);
  assert.equal(s.endedHard, false);
});

test('background sub-agents and shell jobs are in the summary until the agent has read their results', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  const updates: any[] = [];
  const off = h.runner.onNotification((n: any) => {
    if (n.method === 'thread.updated' && n.params.thread.id === thread.id) updates.push(n.params.thread);
  });
  const agent = (n: number) => ({ id: `a${n}`, type: 'local_agent', kind: 'agent' as const, description: `Rebuild landing page ${n}` });
  const shell = { id: 'b1', type: 'local_bash', kind: 'shell' as const, description: 'npm test' };
  s.out({ kind: 'tasks', tasks: [agent(1), agent(2), agent(3), shell] });
  s.result();
  let t = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.status, 'idle');
  assert.deepEqual(t.background, [
    { kind: 'agent', description: 'Rebuild landing page 1' },
    { kind: 'agent', description: 'Rebuild landing page 2' },
    { kind: 'agent', description: 'Rebuild landing page 3' },
    { kind: 'shell', description: 'npm test' },
  ]);
  assert.ok(updates.some((u) => u.background?.length === 4), 'the app heard about the background work');
  // One sub-agent finishes: it stays in the list as finished while the
  // CLI gets round to the turn that reads its result.
  s.out({ kind: 'tasks', tasks: [agent(2), agent(3), shell] });
  t = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(t), []);
  assert.deepEqual(t.background, [
    { kind: 'agent', description: 'Rebuild landing page 2' },
    { kind: 'agent', description: 'Rebuild landing page 3' },
    { kind: 'shell', description: 'npm test' },
    { kind: 'agent', description: 'Rebuild landing page 1', finished: true },
  ]);
  assert.deepEqual(h.runner.backgroundWork(), [{ threadId: thread.id, tasks: ['Rebuild landing page 2', 'Rebuild landing page 3', 'npm test', 'Rebuild landing page 1 (just finished, which the agent is about to look at)'] }]);
  // The CLI starts its own turn to read it: the finished entry goes, the
  // rest stay through the turn.
  s.out({ kind: 'cliTurn', note: 'Agent "Rebuild landing page 1" completed' });
  t = h.runner.get(thread.id);
  assert.equal(t.status, 'running');
  assert.deepEqual(t.background?.map((b) => b.description), ['Rebuild landing page 2', 'Rebuild landing page 3', 'npm test']);
  s.result();
  assert.deepEqual(h.runner.get(thread.id).background?.length, 3);
  // Everything else finishes and nothing reads it in time: the grace
  // runs out and the list clears.
  s.out({ kind: 'tasks', tasks: [] });
  t = h.runner.get(thread.id);
  assert.equal(t.background?.length, 3);
  assert.ok(t.background?.every((b) => b.finished));
  h.clock.advance(15_000);
  t = h.runner.get(thread.id);
  assert.equal(t.background, undefined);
  assert.equal(t.status, 'idle');
  assert.ok(updates.at(-1).background === undefined, 'the app heard it clear');
  off();
});

test('a task that ends during a turn is finished in the summary only after the turn, until the CLI reads it', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm test' }] });
  s.out({ kind: 'tasks', tasks: [] });
  // Still running the turn: the CLI may fold the result into it.
  assert.equal(h.runner.get(thread.id).background, undefined);
  s.result();
  assert.deepEqual(h.runner.get(thread.id).background, [{ kind: 'shell', description: 'npm test', finished: true }]);
  s.out({ kind: 'cliTurn', note: 'Background command "npm test" completed (exit code 0)' });
  assert.equal(h.runner.get(thread.id).background, undefined);
});

test('a turn background work woke says what finished, sub-agents and shells alike', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [
    { id: 'a1', type: 'local_agent', kind: 'agent', description: 'Mine the repo for stories' },
    { id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm test' },
    { id: 'a2', type: 'local_agent', kind: 'agent', description: 'Prior art' },
  ] });
  s.result();
  s.out({ kind: 'tasks', tasks: [{ id: 'a2', type: 'local_agent', kind: 'agent', description: 'Prior art' }] });
  s.out({ kind: 'cliTurn', note: 'Agent "Mine the repo for stories" completed' });
  let started = h.events(thread.id).filter((e) => e.type === 'turn.started');
  assert.equal(started.length, 2);
  assert.equal(started[0].wokeBy, undefined, "Mike's own turn wasn't woken");
  assert.deepEqual(started[1].wokeBy, [
    { kind: 'agent', description: 'Mine the repo for stories' },
    { kind: 'shell', description: 'npm test' },
  ]);
  s.result();
  // A background sub-agent asking for an approval starts a turn too, but
  // nothing finished: no wokeBy.
  (h.runner as any).openCliTurn((h.runner as any).threads.get(thread.id));
  started = h.events(thread.id).filter((e) => e.type === 'turn.started');
  assert.equal(started.at(-1).wokeBy, undefined);
});

test('releasing or losing the CLI clears the background list', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'a1', type: 'local_agent', kind: 'agent', description: 'Check the docs' }] });
  s.result();
  assert.equal(h.runner.get(thread.id).background?.length, 1);
  h.runner.update({ threadId: thread.id, archived: true });
  await tick();
  assert.equal(h.runner.get(thread.id).background, undefined);
});

test('snoozing a thread with background work stops it straight away and says so', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] });
  s.result();
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 60 * MIN).toISOString() });
  assert.equal(s.ended, true);
  assert.equal(s.endedHard, true, 'killed rather than waiting for the job');
  const note = h.events(thread.id).at(-1);
  assert.equal(note.type, 'system.note');
  assert.match(note.text, /Stopped background work.*npm run dev/);
  await tick();
  assert.equal(h.runner.get(thread.id).live, false);
});

test('a CLI turn left open when its CLI is released ends as interrupted', async () => {
  const h = makeHarness();
  h.adapter.slowExit = true;
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  h.runner.update({ threadId: thread.id, archived: true });
  assert.equal(s.ended, true);
  // While it shuts down, a background job's notification starts a turn.
  s.out({ kind: 'cliTurn' });
  assert.equal(h.runner.get(thread.id).status, 'running');
  s.exit();
  await tick();
  const done = h.events(thread.id).at(-1);
  assert.equal(done.type, 'turn.completed');
  assert.equal(done.outcome, 'interrupted');
  assert.equal(h.runner.get(thread.id).status, 'idle');
  assert.equal(h.runner.get(thread.id).live, false);
});

test('"Always allow" rules are kept on the thread and given to the next CLI', async () => {
  const h = makeHarness();
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  assert.deepEqual(s.opts.allowRules, []);
  s.init();
  s.out({ kind: 'allowRules', rules: ['Bash(touch second.txt)'] });
  s.out({ kind: 'allowRules', rules: ['Bash(touch second.txt)', 'Write'] });
  s.result();
  h.clock.advance(30 * MIN);
  await tick();
  h.runner.send(thread.id, 'next');
  await tick();
  assert.deepEqual(h.adapter.last.opts.allowRules, ['Bash(touch second.txt)', 'Write']);
  // And after a runner restart.
  const h2 = h.restart();
  h2.runner.send(thread.id, 'again');
  await tick();
  assert.deepEqual(h2.adapter.last.opts.allowRules, ['Bash(touch second.txt)', 'Write']);
});

test('live CLIs are capped: starting one more releases the longest-idle one', async () => {
  const h = makeHarness(undefined, { maxLive: 2 });
  const a = create(h).thread;
  const sa = h.adapter.last;
  sa.init();
  sa.result();
  h.clock.advance(1000);
  const b = create(h).thread;
  const sb = h.adapter.last;
  sb.init();
  // b is mid-turn, so it can't be picked.
  h.clock.advance(1000);
  const c = create(h).thread;
  await tick();
  assert.equal(sa.ended, true, 'the idle one went');
  assert.equal(sb.ended, false, 'the busy one stayed');
  assert.equal(h.runner.isLive(c.id), true);
  // Nothing idle left to release: the cap is passed rather than stopping work.
  h.adapter.last.init();
  await tick();
  create(h);
  await tick();
  assert.equal(sb.ended, false);
  assert.equal(h.runner.isLive(a.id), false);
  assert.equal(h.runner.isLive(b.id), true);
});

test('a send can say which asks it answers: kept on its user.message, in a turn or starting one', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  const answers = [{ action: 'Merge #52?', answer: 'Merge' }];
  // While the turn runs with nothing queued it goes straight in.
  h.runner.send(thread.id, 'Merge #52?\nMerge', [], { answers });
  const steered = h.events(thread.id).filter((e) => e.type === 'user.message').at(-1) as any;
  assert.deepEqual(steered.answers, answers);
  assert.equal(steered.text, 'Merge #52?\nMerge');
  s.result('completed', 0, undefined, { answered: s.sent.map((m) => m.id!) });
  // A send that starts a turn of its own keeps them too.
  h.runner.send(thread.id, 'Pick one\nB', [], { answers: [{ action: 'Pick one', answer: 'B' }] });
  const last = h.events(thread.id).filter((e) => e.type === 'user.message').at(-1) as any;
  assert.equal(last.text, 'Pick one\nB');
  assert.deepEqual(last.answers, [{ action: 'Pick one', answer: 'B' }]);
  // A plain send has none.
  assert.equal((h.events(thread.id).find((e) => e.type === 'user.message') as any).answers, undefined);
});

test('a send the disk refuses leaves no stuck turn behind', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  const file = path.join(h.home, 'threads', thread.id, 'events.ndjson');
  fs.chmodSync(file, 0o444);
  try {
    assert.throws(() => h.runner.send(thread.id, 'this one fails'), /EACCES|permission/i);
  } finally {
    fs.chmodSync(file, 0o644);
  }
  const t = h.runner.get(thread.id);
  assert.equal(t.status, 'idle');
  assert.equal(s.sent.length, 1, 'nothing went to the CLI');
  const { turnId } = h.runner.send(thread.id, 'this one works');
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1].id, turnId);
  assert.equal(h.runner.get(thread.id).status, 'running');
  assert.deepEqual(checkSequence(h.runner.events(thread.id).events), []);
});

test('recovery: approvals keep their turnId, and a turn already ended on disk is not ended twice', () => {
  const h = makeHarness();
  const { thread, turnId } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  void s.sink.requestApproval({ name: 'Bash', title: 'ls', input: {}, canAlwaysAllow: true, signal: new AbortController().signal });
  const h2 = h.restart();
  const resolved = h2.runner.events(thread.id).events.find((e) => e.type === 'approval.resolved')!;
  assert.equal(resolved.turnId, turnId);

  // A crash between appending turn.completed and saving thread.json.
  const h3 = makeHarness();
  const t = h3.runner.create({ text: 'hi', accountId: 'claude-3' });
  const s3 = h3.adapter.last;
  s3.init();
  const recFile = path.join(h3.home, 'threads', t.thread.id, 'thread.json');
  const midTurn = fs.readFileSync(recFile, 'utf8');
  s3.result();
  fs.writeFileSync(recFile, midTurn); // thread.json still says running
  assert.equal(JSON.parse(midTurn).status, 'running');
  const h4 = h3.restart();
  const evs = h4.runner.events(t.thread.id).events;
  assert.equal(evs.filter((e) => e.type === 'turn.completed').length, 1);
  assert.equal(h4.runner.get(t.thread.id).status, 'idle');
  assert.equal(h4.runner.get(t.thread.id).lastSeq, evs.at(-1)!.seq);
});

test('an unreadable thread.json is rebuilt from the event log instead of the thread vanishing', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'All fixed.');
  s.result();
  const dir = path.join(h.home, 'threads', thread.id);
  fs.writeFileSync(path.join(dir, 'thread.json'), '');
  const h2 = h.restart();
  const t = h2.runner.list().find((x) => x.id === thread.id)!;
  assert.ok(t, 'still listed');
  assert.equal(t.title, 'Fix the tests');
  assert.equal(t.preview, 'All fixed.');
  assert.equal(t.permissionMode, 'ask');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('thread.json.unreadable-')), 'the bad file is kept aside');
  assert.match(h2.runner.events(thread.id).events.at(-1)!.type, /system.note/);
  h2.runner.send(thread.id, 'carry on');
  await tick();
  const s2 = h2.adapter.last;
  assert.equal(s2.opts.resume, false);
  assert.match(s2.sent[0].text, /earlier session couldn't be found/);
  assert.match(s2.sent[0].text, /Assistant: All fixed\./);
});

test('blank folders, search limit 0 and startup notices', () => {
  const h = makeHarness();
  const t = h.runner.create({ text: 'x', cwd: '  ', accountId: 'claude-3' }).thread;
  assert.equal(t.cwd, h.cfg.defaults.cwd, 'a blank folder means the default');
  assert.throws(() => h.runner.update({ threadId: t.id, cwd: '' }), (e: RpcError) => e.code === -32602);
  assert.deepEqual(h.runner.search('x', 0), []);
  assert.equal(h.runner.search('x', 1).length, 1);
  // The test config points at a claude binary that doesn't exist.
  const notices = h.runner.noticesForNewClient();
  assert.ok(notices.some((n) => n.level === 'error' && /claude CLI isn't at/.test(n.message)));
  // A restart that found a thread mid-turn says so to the next client.
  const h2 = h.restart();
  assert.ok(h2.runner.noticesForNewClient().some((n) => /mid-turn/.test(n.message)));
  h2.clock.advance(11 * MIN);
  assert.ok(!h2.runner.noticesForNewClient().some((n) => /mid-turn/.test(n.message)));
});

test('a thread in a Convex project has the dashboard panel; a folder change refreshes them', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, 'convex'), { recursive: true });
  fs.writeFileSync(path.join(project, '.env.local'), 'CONVEX_DEPLOYMENT=dev:quick-fox-77\n');
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  const h = makeHarness(undefined, {}, { panelsRoot: root });
  const { thread } = create(h, { cwd: project });
  assert.deepEqual(checkSummary(thread), []);
  assert.deepEqual(thread.panels, [
    { id: 'convex.dashboard', title: 'Convex', kind: 'url', url: 'https://dashboard.convex.dev/d/quick-fox-77', icon: 'cylinder.split.1x2', patch: 'convex', note: 'quick-fox-77 (dev)' },
  ]);
  // The folder is read again only now and then (in the background), unless
  // the folder changes.
  fs.rmSync(path.join(project, 'convex'), { recursive: true });
  await tick();
  await h.runner.patchesIdle();
  assert.equal(h.runner.get(thread.id).panels?.length, 1, 'still cached');
  h.clock.advance(16_000);
  h.runner.get(thread.id);
  await tick();
  await h.runner.patchesIdle();
  assert.equal(h.runner.get(thread.id).panels, undefined, 'gone after the TTL');
  assert.equal(h.notes.filter((n) => n.method === 'thread.updated').at(-1)?.params.thread.panels, undefined, 'a summary went out for the change');
  fs.mkdirSync(path.join(project, 'convex'));
  const moved = h.runner.update({ threadId: thread.id, cwd: plain }).thread;
  assert.equal(moved.panels, undefined);
  const back = h.runner.update({ threadId: thread.id, cwd: project }).thread;
  assert.equal(back.panels?.[0].id, 'convex.dashboard');
});

test('panels.convexKey makes a deploy key in the project folder, for the panel only', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, 'convex'), { recursive: true });
  fs.writeFileSync(path.join(project, '.env.local'), 'CONVEX_DEPLOYMENT=dev:quick-fox-77\nCONVEX_URL=https://quick-fox-77.convex.cloud\n');
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const calls: string[] = [];
  const h = makeHarness(undefined, {}, {
    panelsRoot: root,
    convexKeyRun: async (command, cwd) => {
      calls.push(cwd);
      if (command.includes('--inline-query')) return { ok: true,
        text: JSON.stringify(command.includes('--deployment prod') ? 'https://busy-bear-2.ap-southeast-2.convex.cloud' : 'https://quick-fox-77.convex.cloud'),
        truncated: false, durationMs: 1 };
      fs.writeFileSync(/--save-env '([^']+)'/.exec(command)![1], 'CONVEX_DEPLOY_KEY=dev:quick-fox-77|k\n');
      return { ok: true, text: '', truncated: false, durationMs: 1 };
    },
  });
  const { thread } = create(h, { cwd: path.join(project, 'convex') });
  assert.deepEqual(thread.panels?.[0].convex, { deployment: 'quick-fox-77', deploymentUrl: 'https://quick-fox-77.convex.cloud' });
  assert.deepEqual(await h.runner.convexPanelKey(thread.id, 'convex.dashboard'), { deployment: 'quick-fox-77', deploymentUrl: 'https://quick-fox-77.convex.cloud', adminKey: 'dev:quick-fox-77|k' });
  assert.deepEqual(calls, [project]);
  assert.ok(fs.existsSync(path.join(h.home, 'secrets', 'convex-panels', 'quick-fox-77.json')));
  await assert.rejects(h.runner.convexPanelKey(thread.id, 'nope'), /no panel called nope/);
  const listed = await h.runner.convexPanelDeployments(thread.id, 'convex.dashboard');
  assert.equal(listed.deployments[1].label, 'Production');
  assert.equal(listed.deployments[1].deployment, 'busy-bear-2');
  assert.equal((await h.runner.convexPanelKey(thread.id, 'convex.dashboard', false, 'busy-bear-2')).deploymentUrl, 'https://busy-bear-2.ap-southeast-2.convex.cloud');
  await assert.rejects(h.runner.convexPanelKey(thread.id, 'convex.dashboard', false, 'unrelated-project-3'), /no deployment called unrelated-project-3/);
  assert.equal(calls.length, 4, 'configured key, two read-only lookups, selected key; no call for an unrelated deployment');
  // The key is only in the answer: never in the thread's events or summary.
  assert.ok(!JSON.stringify(h.runner.get(thread.id)).includes('quick-fox-77|k'));
  assert.ok(!JSON.stringify(h.notes).includes('quick-fox-77|k'));
  // Sign-in is offered through the panel, so only for a panel it has.
  assert.deepEqual(await h.runner.convexPanelLogin(thread.id, 'convex.dashboard', true), { state: 'idle' });
  await assert.rejects(h.runner.convexPanelLogin(thread.id, 'nope'), /no panel called nope/);
});

test('patch files give a thread actions; a command action runs in the folder and lands in the transcript', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(project, '.threadbear/patches/tools.ts'), `export default { actions: [
    { title: "Say hi", run: "echo hi from $PWD; echo thread $THREADBEAR_THREAD_ID" },
    { title: "Fail", run: "echo bad >&2; exit 2" },
    { title: "Explain", prompt: "Explain this folder." },
    { title: "Docs", url: "https://example.com/docs" },
  ] };`);
  const opened: string[] = [];
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000, openUrl: async (u: string) => void opened.push(u) });
  const { thread } = create(h, { cwd: project });
  // The first summary has the built-in bits only; the files follow.
  assert.equal(thread.actions, undefined);
  await tick();
  await h.runner.patchesIdle();
  const loaded = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(loaded), []);
  assert.deepEqual(loaded.actions?.map((a) => a.id), ['tools.say-hi', 'tools.fail', 'tools.explain', 'tools.docs']);
  assert.deepEqual(loaded.patches, [{ id: 'tools', source: 'project', file: path.join(project, '.threadbear/patches/tools.ts') }]);
  // No note for patches found on the first read.
  assert.ok(!h.events(thread.id).some((e) => e.type === 'system.note'));

  const r = await h.runner.runAction(thread.id, 'tools.say-hi');
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  const run = h.events(thread.id).find((e) => e.type === 'action.run');
  assert.ok(run);
  assert.equal(run.seq, r.seq);
  assert.deepEqual(checkSequence(h.events(thread.id).filter((e) => !e.type.endsWith('.delta'))), []);
  assert.equal(run.actionId, 'tools.say-hi');
  assert.equal(run.title, 'Say hi');
  assert.equal(run.patch, 'tools');
  assert.match(run.text, new RegExp(`hi from ${fs.realpathSync(project)}\nthread ${thread.id}`));
  assert.equal(run.ok, true);

  const bad = await h.runner.runAction(thread.id, 'tools.fail');
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 2);
  const failed = h.events(thread.id).filter((e) => e.type === 'action.run').at(-1);
  assert.equal(failed.ok, false);
  assert.equal(failed.text.trim(), 'bad');

  // A url action is opened (for an older app that asks the runner), with
  // nothing added to the transcript.
  const before = h.events(thread.id).length;
  const page = await h.runner.runAction(thread.id, 'tools.docs');
  assert.equal(page.ok, true);
  assert.equal(page.seq, undefined);
  assert.deepEqual(opened, ['https://example.com/docs']);
  assert.equal(h.events(thread.id).length, before);

  // A prompt action is a message.
  const sent = await h.runner.runAction(thread.id, 'tools.explain');
  assert.ok(sent.turnId);
  const messages = h.events(thread.id).filter((e) => e.type === 'user.message');
  assert.equal(messages.at(-1).text, 'Explain this folder.');

  await assert.rejects(h.runner.runAction(thread.id, 'tools.nope'), (e: RpcError) => e.code === -32602);
});

test('a patch file written later is noticed within the TTL and said in the transcript; two runs of one action at once are refused', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(project, { recursive: true });
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  const { thread } = create(h, { cwd: project });
  await tick();
  await h.runner.patchesIdle();
  assert.equal(h.runner.get(thread.id).patches, undefined);
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(project, '.threadbear/patches/slow.ts'), `export default { actions: [{ title: "Wait", run: "sleep 1" }], panels: [{ title: "Docs", url: "http://localhost:8000" }] };`);
  h.clock.advance(16_000);
  h.runner.get(thread.id);
  await tick();
  await h.runner.patchesIdle();
  const notes = h.events(thread.id).filter((e) => e.type === 'system.note').map((e) => e.text);
  assert.deepEqual(notes, ['Patch slow added: action Wait, panel Docs.']);
  assert.equal(h.runner.get(thread.id).panels?.[0].id, 'slow.docs');

  const first = h.runner.runAction(thread.id, 'slow.wait');
  await tick();
  await h.runner.patchesIdle();
  await assert.rejects(h.runner.runAction(thread.id, 'slow.wait'), (e: RpcError) => e.code === -32020 && /already running/.test(e.message));
  assert.equal((await first).ok, true);

  // Broken later: said once, not on every read.
  fs.writeFileSync(path.join(project, '.threadbear/patches/slow.ts'), `export default 42;`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(project, '.threadbear/patches/slow.ts'), later, later);
  for (let i = 0; i < 2; i++) {
    h.clock.advance(16_000);
    h.runner.get(thread.id);
    await tick();
    await h.runner.patchesIdle();
  }
  const after = h.events(thread.id).filter((e) => e.type === 'system.note').map((e) => e.text);
  assert.deepEqual(after.slice(1), ['Patch slow couldn\'t load: The default export should be an object with actions and/or panels.']);
  assert.equal(h.runner.get(thread.id).actions, undefined);
});

test('live state: threads in the same folder share one run of a command, and a slow one is joined, not started again', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(project, 'count'), '2');
  // Each run adds a line to runs, so the test can count them.
  fs.writeFileSync(path.join(project, '.threadbear/patches/review.ts'), `
    const count = async ({ sh }) => Number((await sh("echo run >> runs; cat count")).trim());
    export default { actions: [{ title: "Your turn", prompt: "Do my comments.", badge: count }] };`);
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  const a = create(h, { cwd: project }).thread;
  const b = create(h, { cwd: project }).thread;
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await tick();
    }
    await h.runner.patchesIdle();
  };
  await settle();
  const runs = () => fs.readFileSync(path.join(project, 'runs'), 'utf8').trim().split('\n').length;
  assert.deepEqual([a, b].map((t) => h.runner.get(t.id).actions?.[0].badge), [2, 2]);
  assert.equal(runs(), 1, 'one run for both threads');
  h.clock.advance(21_000);
  await settle();
  assert.equal(runs(), 2, 'the next poll runs it again, once');
});

test('live state: a when chip comes and goes by itself on the poll, with its badge', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  // A comment count in a file stands in for tandem comments --json.
  fs.writeFileSync(path.join(project, 'count'), '0');
  fs.writeFileSync(path.join(project, '.threadbear/patches/review.ts'), `
    const count = async ({ sh }) => Number((await sh("cat count")).trim());
    export default { actions: [{ title: "Your turn", prompt: "Do my comments.", when: async (c) => (await count(c)) > 0, badge: count }] };`);
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  const { thread } = create(h, { cwd: project });
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await tick();
    }
  };
  await settle();
  assert.equal(h.runner.get(thread.id).actions, undefined);
  fs.writeFileSync(path.join(project, 'count'), '3');
  // No summary asked for: the poll reads it again by itself.
  h.clock.advance(21_000);
  await settle();
  const shown = h.runner.get(thread.id);
  assert.deepEqual(shown.actions?.map((a) => [a.title, a.badge]), [['Your turn', 3]]);
  assert.deepEqual(checkSummary(shown), []);
  // A chip coming and going isn't a patch change worth a note.
  assert.ok(!h.events(thread.id).some((e) => e.type === 'system.note'));
  fs.writeFileSync(path.join(project, 'count'), '0');
  h.clock.advance(21_000);
  await settle();
  assert.equal(h.runner.get(thread.id).actions, undefined);
});

test('a turn.end hook runs after a turn that edited a matching file, and a failure is told to the agent twice at most', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(project, '.threadbear/patches/checks.ts'), `export default { hooks: [
    { title: "Typecheck", on: "turn.end", run: "echo 'a.ts(1,1): error TS1' >&2; exit 1", edited: "**/*.ts" },
    { title: "Count", on: "turn.end", run: "echo counted", tell: "never" },
  ] };`);
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  const { thread } = create(h, { cwd: project });
  await tick();
  await h.runner.patchesIdle();
  assert.equal(h.runner.get(thread.id).hooks?.length, 2);

  // A turn that edits nothing: only the unfiltered hook runs, and says nothing.
  let s = h.adapter.last;
  s.init();
  s.text('m1', 'Looked around.');
  s.result('completed');
  const runsSoFar = () => h.events(thread.id).filter((e) => e.type === 'action.run');
  await until(() => runsSoFar().length >= 1, 'the first hook run');
  let runs = runsSoFar();
  assert.deepEqual(runs.map((e) => [e.actionId, e.ok, e.trigger]), [['checks.count', true, 'turn.end']]);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message').length, 1);
  assert.deepEqual(checkSequence(h.events(thread.id).filter((e) => !e.type.endsWith('.delta'))), []);

  // A turn that edits a .ts file: Typecheck runs, fails, and the agent hears.
  h.runner.send(thread.id, 'Edit a.ts');
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'c1', name: 'Edit', kind: 'edit', title: 'Edit a.ts', input: { file_path: path.join(project, 'a.ts') } } });
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'c1', ok: true, text: '', truncated: false, images: [] } });
  s.result('completed');
  await until(() => runsSoFar().length >= 3, 'both hooks after the edit');
  runs = runsSoFar();
  assert.equal(runs.length, 3);
  const typecheck = runs.find((e) => e.actionId === 'checks.typecheck');
  assert.equal(typecheck.ok, false);
  assert.equal(typecheck.exitCode, 1);
  assert.match(typecheck.text, /error TS1/);
  let told = h.events(thread.id).filter((e) => e.type === 'user.message' && e.origin === 'runner');
  assert.equal(told.length, 1);
  assert.match(told[0].text, /^\[Threadbear hook\] Typecheck \(patch checks\) ran after your turn and failed \(exit 1\):\n\n```\na\.ts\(1,1\): error TS1\n```/);
  assert.equal(h.runner.get(thread.id).status, 'running', 'the hook message started a turn');

  // The agent "fixes" it, editing the file again; the hook fails again and
  // is told again, then after the limit it's only posted.
  // Two more turns: the second told run, then one past the limit, after
  // which no turn starts (so there's no third to try in).
  for (let i = 0; i < 2; i++) {
    const before = runsSoFar().length;
    s.out({ kind: 'event', event: { type: 'edit.diff', itemId: `e${i}`, path: 'a.ts', hunks: [] } });
    s.result('completed');
    await until(() => runsSoFar().length >= before + 2, `hook run ${i}`);
    await tick(5);
  }
  told = h.events(thread.id).filter((e) => e.type === 'user.message' && e.origin === 'runner');
  assert.equal(told.length, 2, 'told twice, then left in the transcript');
  assert.equal(h.events(thread.id).filter((e) => e.actionId === 'checks.typecheck').length, 3, 'but it still ran every time');
  assert.equal(h.runner.get(thread.id).status, 'idle');

  // A message from a person resets the count.
  h.runner.send(thread.id, 'Try once more');
  s.out({ kind: 'event', event: { type: 'edit.diff', itemId: 'e9', path: 'a.ts', hunks: [] } });
  const before = runsSoFar().length;
  s.result('completed');
  await until(() => runsSoFar().length >= before + 2, 'the last hook run');
  await tick(5);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message' && e.origin === 'runner').length, 3);
});

test('hooks don\'t run after an interrupted or failed turn, or a turn the runner opened for background work', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(project, '.threadbear/patches/h.ts'), `export default { hooks: [{ title: "Every", on: "turn.end", run: "echo ran", tell: "never" }] };`);
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  const { thread } = create(h, { cwd: project });
  await tick();
  const s = h.adapter.last;
  s.init();
  s.result('failed', undefined, 'boom');
  await tick(10);
  h.runner.send(thread.id, 'again');
  s.result('interrupted');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.events(thread.id).filter((e) => e.type === 'action.run').length, 0);
  h.runner.send(thread.id, 'and again');
  s.result('completed');
  await until(() => h.events(thread.id).some((e) => e.type === 'action.run'), 'the hook after a completed turn');
  assert.equal(h.events(thread.id).filter((e) => e.type === 'action.run').length, 1);
});

// docs/protocol.md, "Needs you".
const END_TURN = 'mcp__threadbear__end_turn';

function endTurnCall(s: ReturnType<typeof makeHarness>['adapter']['last'], itemId: string, input: Record<string, unknown>) {
  s.out({ kind: 'event', event: { type: 'tool.call', itemId, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
}

test('needs you: end_turn "nothing" keeps a finished thread out of Needs you; "you" opens a card of asks', () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  s.text('m1', 'All fixed.\n\n**What I need from you**\n\n1. This list is ignored: the tool call wins.');
  endTurnCall(s, 't1', { needs: 'nothing', next: ['Write the docs'] });
  s.result('completed');
  let t = h.runner.get(thread.id);
  const done = h.events(thread.id).at(-1);
  assert.equal(done.needs, 'nothing');
  assert.equal(done.needsFrom, 'tool');
  // The done card's follow-ups ride on the turn's own event.
  assert.deepEqual(done.next, ['Write the docs']);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.needs, 'nothing');
  assert.equal(t.needsYou, false, 'finished and unread, but it said it needs nothing');
  assert.ok(t.lastSeq > t.lastSeenSeq, 'still unread');

  h.runner.send(thread.id, 'Now the docs');
  s = h.adapter.last;
  s.text('m2', 'Docs are drafted.');
  endTurnCall(s, 't2', { needs: 'you', asks: [{ action: 'Paste the key', where: 'Settings', reply: 'done' }, { action: 'Pick a budget' }] });
  s.result('completed');
  t = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.needsYou, true);
  assert.equal(t.needs, 'you');
  assert.deepEqual(t.asks, [{ action: 'Paste the key', where: 'Settings', reply: 'done' }, { action: 'Pick a budget' }]);
  assert.equal(t.asksSeq, h.events(thread.id).at(-1).seq);

  // Ticking: an asks.ticked event, nothing sent, and still read if it was.
  h.runner.markSeen(thread.id, t.lastSeq);
  const sent = s.sent.length;
  t = h.runner.tickAsk(thread.id, t.asksSeq!, 0, true).thread;
  assert.deepEqual(t.asks, [{ action: 'Paste the key', where: 'Settings', reply: 'done', ticked: true }, { action: 'Pick a budget' }]);
  assert.equal(s.sent.length, sent);
  const tickEv = h.events(thread.id).at(-1);
  assert.equal(tickEv.type, 'asks.ticked');
  assert.deepEqual(tickEv.ticked, [0]);
  assert.equal(tickEv.turnId, undefined);
  assert.equal(t.lastSeenSeq, t.lastSeq);
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
  assert.throws(() => h.runner.tickAsk(thread.id, t.asksSeq! - 1, 0, true), RpcError);
  assert.throws(() => h.runner.tickAsk(thread.id, t.asksSeq!, 2, true), RpcError);
  t = h.runner.tickAsk(thread.id, t.asksSeq!, 0, false).thread;
  assert.deepEqual(t.asks![0], { action: 'Paste the key', where: 'Settings', reply: 'done' });
});

// What sub-agents find can change what the agent asks, so a card left open
// while they work isn't Mike's yet (2 Nov). A job watching for him to do
// something is the opposite (1 Nov), so it doesn't hold anything back.
test('needs you: asks wait for sub-agents to finish, not for shell jobs', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  const agent = { id: 'a1', type: 'local_agent', kind: 'agent' as const, description: 'Sweep the messages' };
  const shell = { id: 'b1', type: 'local_bash', kind: 'shell' as const, description: 'Watch for the Pi' };
  s.out({ kind: 'tasks', tasks: [agent, shell] });
  endTurnCall(s, 't1', { needs: 'you', asks: [{ action: 'Pick a format' }] });
  s.result('completed');
  let t = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.needsYou, false, 'the sub-agent is still working');
  assert.equal(t.needs, 'you', 'the card is still there to answer early');
  assert.deepEqual(t.asks, [{ action: 'Pick a format' }]);

  // The sub-agent finishes: still held while its result waits to be read.
  s.out({ kind: 'tasks', tasks: [shell] });
  assert.equal(h.runner.get(thread.id).needsYou, false, 'a result is about to be read');

  // Nothing read it in time: only the watching job is left, so it's his move.
  h.clock.advance(15_000);
  t = h.runner.get(thread.id);
  assert.deepEqual(t.background, [{ kind: 'shell', description: 'Watch for the Pi' }]);
  assert.equal(t.needsYou, true);
});

test('needs you: text after an accepted end_turn is dropped, until Mike writes again mid-turn', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  const result = (itemId: string, text: string) =>
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: true, text, truncated: false, images: [] } });
  // A refused end_turn doesn't end anything, even one a provider reports as
  // ok: the reply after it shows.
  endTurnCall(s, 't0', { needs: 'nothing' });
  result('t0', 'Not ended: Mike hasn\'t had a reply this turn.');
  s.text('m1', 'The answer.');
  endTurnCall(s, 't1', { needs: 'nothing' });
  result('t1', 'Noted: this thread is done.');
  // The repeat under it, streamed and then whole, goes nowhere.
  s.out({ kind: 'delta', delta: { type: 'assistant.text.delta', itemId: 'm2', text: 'The ans' } });
  s.text('m2', 'The answer.');
  const texts = () => h.events(thread.id).filter((e) => e.type === 'assistant.text').map((e) => e.text);
  assert.deepEqual(texts(), ['The answer.']);
  assert.equal(h.runner.get(thread.id).preview, 'The answer.');
  // A message sent into the running turn is owed a reply of its own.
  h.runner.send(thread.id, 'One more thing');
  s.text('m3', 'Sure.');
  s.result('completed');
  assert.deepEqual(texts(), ['The answer.', 'Sure.']);
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

test('needs you: without end_turn the closing section is read; with neither, a finished turn counts as before', () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  s.text('m1', 'Built it.\n\n**What I need from you**\n\n1. Restart the app, then reply "done".');
  s.result('completed');
  let t = h.runner.get(thread.id);
  assert.equal(h.events(thread.id).at(-1).needsFrom, 'text');
  assert.deepEqual(t.asks, [{ action: 'Restart the app, then reply "done".', reply: 'done' }]);
  assert.equal(t.needsYou, true);

  h.runner.send(thread.id, 'done');
  s = h.adapter.last;
  s.text('m2', 'Works now. Nothing needed from you right now.');
  s.result('completed');
  t = h.runner.get(thread.id);
  assert.equal(t.needs, 'nothing');
  assert.equal(t.asks, undefined, 'the old card closed');
  assert.equal(t.needsYou, false);

  h.runner.send(thread.id, 'and again');
  s = h.adapter.last;
  s.text('m3', 'Here you go.');
  s.result('completed');
  t = h.runner.get(thread.id);
  assert.equal(t.needs, undefined);
  assert.equal(h.events(thread.id).at(-1).needs, undefined);
  assert.equal(t.needsYou, true, 'today\'s rule: finished and unread');
});

test('needs you: an interrupted turn says nothing, and a sub-agent\'s end_turn is ignored', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  s.text('m1', 'Nothing needed from you right now.');
  endTurnCall(s, 'child-1/t1', { needs: 'nothing' });
  s.result('interrupted');
  let t = h.runner.get(thread.id);
  assert.equal(t.needs, undefined);
  assert.equal(h.events(thread.id).at(-1).needs, undefined);

  h.runner.send(thread.id, 'go on');
  s = h.adapter.last;
  endTurnCall(s, 'child-1/t2', { needs: 'nothing' });
  s.text('m2', 'Finished.');
  s.result('completed');
  t = h.runner.get(thread.id);
  assert.equal(t.needs, undefined, "a Codex child's call isn't the thread's");
  assert.equal(t.needsYou, true);
});

test('needs you: end_turn with archive archives the thread once its turn is over, only when it needs nothing', () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  // Asking for something and archiving would hide the ask: it stays in the inbox.
  endTurnCall(s, 't1', { needs: 'you', asks: [{ action: 'Say yes' }], archive: true });
  s.result('completed');
  let t = h.runner.get(thread.id);
  assert.equal(t.archivedAt, undefined);
  assert.equal(t.needsYou, true);

  h.runner.send(thread.id, 'yes, and archive this one');
  s = h.adapter.last;
  s.text('m1', 'Done. Archiving this thread, as you asked.');
  endTurnCall(s, 't2', { needs: 'nothing', archive: true });
  // Not while the turn is still running: archiving stops the CLI.
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
  s.result('completed');
  t = h.runner.get(thread.id);
  assert.ok(t.archivedAt, 'archived once the turn completed');
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && /archived/i.test(String(e.text))), 'says why it went');
  assert.deepEqual(checkSequence(h.events(thread.id)), []);
});

test('needs you: an interrupted turn, or one without archive, leaves the thread where it is', () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  endTurnCall(s, 't1', { needs: 'nothing', archive: true });
  s.result('interrupted');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);

  h.runner.send(thread.id, 'go on');
  s = h.adapter.last;
  endTurnCall(s, 't2', { needs: 'nothing' });
  s.result('completed');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
});

test('a scheduled run puts an archived thread back in the archive when it ends with nothing for Mike', () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  endTurnCall(s, 't1', { needs: 'nothing' });
  s.result('completed');
  h.runner.update({ threadId: thread.id, archived: true });
  assert.ok(h.runner.get(thread.id).archivedAt);

  // Nothing new: it comes out for the run, then goes back as Mike left it.
  h.runner.send(thread.id, 'Check for a reply', [], { origin: 'schedule', scheduleId: 'sch_1' });
  assert.equal(h.runner.get(thread.id).archivedAt, undefined, 'out of the archive while it runs');
  s = h.adapter.last;
  s.init();
  endTurnCall(s, 't2', { needs: 'nothing' });
  s.result('completed');
  let t = h.runner.get(thread.id);
  assert.ok(t.archivedAt, 'back in the archive');
  assert.equal(t.archivedBy, 'mike');
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && /back in the archive/i.test(String(e.text))), 'says why');

  // A run that needs him stays in the inbox.
  h.runner.send(thread.id, 'Check for a reply', [], { origin: 'schedule', scheduleId: 'sch_1' });
  s = h.adapter.last;
  s.init();
  endTurnCall(s, 't3', { needs: 'you', asks: [{ action: 'Send the reply?' }] });
  s.result('completed');
  t = h.runner.get(thread.id);
  assert.equal(t.archivedAt, undefined, 'stays out when it needs Mike');

  // So does one Mike wrote into, even if it then ends with nothing.
  h.runner.update({ threadId: thread.id, archived: true });
  h.runner.send(thread.id, 'Check for a reply', [], { origin: 'schedule', scheduleId: 'sch_1' });
  s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'also tell me the size');
  endTurnCall(s, 't4', { needs: 'nothing' });
  s.result('completed');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined, 'his message keeps it out');

  // And a scheduled message to a thread in the inbox never archives it.
  s = h.adapter.last;
  endTurnCall(s, 't5', { needs: 'nothing' });
  s.result('completed');
  h.runner.send(thread.id, 'Check for a reply', [], { origin: 'schedule', scheduleId: 'sch_1' });
  s = h.adapter.last;
  endTurnCall(s, 't6', { needs: 'nothing' });
  s.result('completed');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined, 'only one that came out of the archive goes back');
});

test('a scheduled run that asks Mike something, or is stopped, keeps the thread out even after a later run finds nothing', () => {
  const h = makeHarness();
  const { thread } = create(h);
  let s = h.adapter.last;
  s.init();
  endTurnCall(s, 't1', { needs: 'nothing' });
  s.result('completed');
  h.runner.update({ threadId: thread.id, archived: true });

  // Run A asks him something while run B waits in the queue: B finding
  // nothing mustn't archive A's question.
  h.runner.send(thread.id, 'Check A', [], { origin: 'schedule', scheduleId: 'sch_a' });
  s = h.adapter.last;
  s.init();
  h.runner.send(thread.id, 'Check B', [], { origin: 'schedule', scheduleId: 'sch_b', queue: true });
  endTurnCall(s, 't2', { needs: 'you', asks: [{ action: 'Send the reply?' }] });
  s.result('completed');
  s = h.adapter.last;
  endTurnCall(s, 't3', { needs: 'nothing' });
  s.result('completed');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined, "B doesn't archive A's question");

  // Stopped: it stays out, and the next run that finds nothing leaves it there.
  h.runner.update({ threadId: thread.id, archived: true });
  h.runner.send(thread.id, 'Check again', [], { origin: 'schedule', scheduleId: 'sch_a' });
  s = h.adapter.last;
  s.init();
  h.runner.interrupt(thread.id);
  s.result('interrupted');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
  h.runner.send(thread.id, 'Keep going', [], { origin: 'runner' });
  s = h.adapter.last;
  endTurnCall(s, 't4', { needs: 'nothing' });
  s.result('completed');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined, 'a stopped run leaves no mark behind');
});

test('needs you: the card survives a reload of the thread record', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  endTurnCall(s, 't1', { needs: 'you', asks: [{ action: 'Say yes' }] });
  s.result('completed');
  const seq = h.runner.get(thread.id).asksSeq!;
  h.runner.tickAsk(thread.id, seq, 0, true);
  const h2 = h.restart();
  const t = h2.runner.get(thread.id);
  assert.deepEqual(t.asks, [{ action: 'Say yes', ticked: true }]);
  assert.equal(t.asksSeq, seq);
});

test('sharing: a link that stays across off and on, and a new link on request', () => {
  const h = makeHarness();
  const { thread } = create(h);
  assert.equal(h.runner.get(thread.id).share, undefined);

  let t = h.runner.share(thread.id, { access: 'link' }).thread;
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.share!.access, 'link');
  assert.match(t.share!.slug, /^[A-Za-z0-9_-]{22}$/);
  const slug = t.share!.slug;

  // Off keeps the link, so sharing again brings it back.
  t = h.runner.share(thread.id, { access: 'off' }).thread;
  assert.deepEqual(checkSummary(t), []);
  assert.equal(t.share!.access, 'off');
  t = h.runner.share(thread.id, { access: 'link' }).thread;
  assert.equal(t.share!.slug, slug);

  t = h.runner.share(thread.id, { access: 'link', newLink: true }).thread;
  assert.notEqual(t.share!.slug, slug);

  // Sharing with specific people went on 29 Oct.
  assert.throws(() => h.runner.share(thread.id, { access: 'people' as 'link' }), RpcError);
  assert.equal(h.runner.get(thread.id).share!.access, 'link');
});

test('who started a thread: a row says so when it was not Mike, and end_turn says how it came out', () => {
  const h = makeHarness();
  // Mike's own has none, and a byline can't give it one.
  const mine = create(h).thread;
  assert.equal(mine.startedBy, undefined);
  let s = h.adapter.last;
  s.init();
  s.text('m1', 'Done.');
  endTurnCall(s, 't1', { needs: 'nothing', byline: 'should be dropped' });
  s.result('completed');
  assert.equal(h.runner.get(mine.id).startedBy, undefined);

  // A tool's, with the starter's why until the thread's own end_turn.
  const tool = create(h, { startedBy: { kind: 'tool', label: 'Sentry', icon: 'ladybug', why: '1 event, 0 users' } }).thread;
  assert.deepEqual(tool.startedBy, { kind: 'tool', label: 'Sentry', icon: 'ladybug', why: '1 event, 0 users' });
  assert.deepEqual(checkSummary(tool), []);
  s = h.adapter.last;
  s.init();
  s.text('m2', 'A blip.');
  endTurnCall(s, 't2', { needs: 'nothing', byline: '  network blip,\n nothing to do ' });
  s.result('completed');
  assert.equal(h.runner.get(tool.id).startedBy?.why, 'network blip, nothing to do');

  // A stopped turn's end_turn says nothing, and no byline leaves it as it was.
  s = h.adapter.last;
  h.runner.send(tool.id, 'again', []);
  s = h.adapter.last;
  s.text('m3', 'Still a blip.');
  endTurnCall(s, 't3', { needs: 'nothing' });
  s.result('completed');
  assert.equal(h.runner.get(tool.id).startedBy?.why, 'network blip, nothing to do');

  // Another thread's names it, with its title then.
  const agent = create(h, { startedBy: { kind: 'thread', label: 'Agent', threadId: mine.id } }).thread;
  assert.equal(agent.startedBy?.threadTitle, mine.title);
  assert.equal(agent.startedBy?.threadId, mine.id);
});

test('who started a thread: the runner and a schedule each say so', () => {
  const h = makeHarness();
  const notice = h.runner.noticeOnMac(undefined, 'A dialog', 'A dialog is waiting');
  assert.deepEqual(h.runner.get(notice).startedBy, { kind: 'runner', label: 'Threadbear' });
  const scheduled = create(h, { origin: 'schedule', scheduleId: 'sc1', title: 'Nightly' }).thread;
  assert.deepEqual(scheduled.startedBy, { kind: 'schedule', label: 'Schedule' });
});

test('asked: the summary carries Mike\'s last message, not a schedule\'s or an agent\'s', () => {
  const h = makeHarness();
  const { thread } = create(h);
  assert.equal(thread.asked, 'Fix the tests more detail here');
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'Done.');
  s.result();
  h.runner.send(thread.id, 'Nightly check', [], { origin: 'schedule', scheduleId: 'sc1' });
  assert.equal(h.runner.get(thread.id).asked, 'Fix the tests more detail here');
  h.adapter.last.result();
  h.runner.send(thread.id, '[Sent by the agent in the thread abc] hello');
  assert.equal(h.runner.get(thread.id).asked, 'Fix the tests more detail here');
  h.adapter.last.result();
  h.runner.send(thread.id, 'And   the\nlint too', [], { origin: 'phone' });
  assert.equal(h.runner.get(thread.id).asked, 'And the lint too');
  assert.deepEqual(checkSummary(h.runner.get(thread.id)), []);
});

test('asked: a review reply is Mike\'s notes, or the option he picked', () => {
  const review = { id: 'r1', title: 'Grey line', status: 'answered', options: [{ id: 'A', title: 'Results', path: '/a.png' }, { id: 'C', title: 'What you asked', path: '/c.png' }] } as never;
  const head = 'Review: Grey line (r1)\n\n';
  assert.equal(askedLine({ text: head + 'Notes on C (What you asked): try this', reviewId: 'r1', reviewResponse: { notes: { C: 'try this' } } }, [review]), 'try this');
  assert.equal(askedLine({ text: head + 'Picked C. What you asked.', reviewId: 'r1', reviewResponse: { pickedId: 'C', notes: {} } }, [review]), 'Picked What you asked');
  assert.equal(askedLine({ text: head + 'Picked A + C. Results + What you asked.', reviewId: 'r1', reviewResponse: { pickedId: 'A', pickedIds: ['A', 'C'], notes: {} } }, [review]), 'Picked Results + What you asked');
  assert.equal(askedLine({ text: head + 'Picked A.\n\nThe first one', reviewId: 'r1', reviewResponse: { pickedId: 'A', notes: {}, reply: 'The first one' } }, [review]), 'The first one');
  assert.equal(askedLine({ text: head + 'Picked none of them.', reviewId: 'r1', reviewResponse: { notes: {}, none: true } }, [review]), 'None of them');
  assert.equal(askedLine({ text: 'Carry on', origin: 'runner' }), undefined);
});

test('asked: a thread from before it learns it from its log on restart', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.flush();
  const file = path.join(h.home, 'threads', thread.id, 'thread.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete rec.asked;
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(h.restart().runner.get(thread.id).asked, 'Fix the tests more detail here');
});
