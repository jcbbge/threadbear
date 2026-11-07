import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, type Harness } from '../helpers/fakes.ts';
import { Restarter, restartPath, resumesPath, donePath, restartMethods, parseRestartParams, takeResume, pendingMessage, type RestartFile } from '../../src/restart.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { RpcError } from '../../src/protocol.ts';
import { checkSequence } from '../helpers/protocol-check.ts';
import { tmpDir } from '../helpers/fakes.ts';

const MIN = 60_000;

// A Restarter on a harness, standing in for main.ts: restart() only counts.
function withRestarter(h: Harness, version = '0.1.0+old', extra: { release?: string; rolledBack?: string; rolledBackFrom?: string; branch?: string } = {}) {
  const state = { restarts: 0 };
  const r = new Restarter({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, version, release: 'old', ...extra, restart: () => state.restarts++ });
  return { r, state };
}

const TASKS = [{ id: 'b1', type: 'local_bash', kind: 'shell' as const, description: 'npm run e2e' }];

// The restart note and the runner's message that follows it.
function noteAndResume(h: Harness, threadId: string): [any, any] {
  const evs = h.events(threadId);
  const i = evs.findLastIndex((e) => e.type === 'system.note' && e.text.startsWith('Runner restarted'));
  return [evs[i], evs.slice(i).find((e) => e.type === 'user.message')];
}

// A saved restart.json with one resume, as an earlier runner left it.
function saveRestart(h: Harness, threadId: string, extra: Partial<RestartFile> = {}, resume: Record<string, unknown> = {}): void {
  const now = new Date(h.clock.now()).toISOString();
  const file: RestartFile = { when: 'idle', requestedAt: now, shutdownAt: now, fromVersion: 'a', resumes: [{ threadId, text: 'go on', requestedAt: now, ...resume }], ...extra };
  fs.writeFileSync(restartPath(h.home), JSON.stringify(file));
}

function create(h: Harness, extra: Record<string, unknown> = {}) {
  return h.runner.create({ text: 'Deploy the runner', accountId: 'claude-3', ...extra });
}

function notices(h: Harness): string[] {
  return h.notes.filter((n) => n.method === 'runner.notice').map((n) => (n.params as { message: string }).message);
}

function saved(h: Harness): RestartFile {
  return JSON.parse(fs.readFileSync(restartPath(h.home), 'utf8'));
}

test('with nothing running a restart starts at once, after the reply, and is saved first', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const res = r.request({ reason: 'new release' });
  assert.deepEqual(res, { scheduled: true, waitingFor: [] });
  assert.equal(state.restarts, 0, 'not inside the request, so the reply goes out first');
  await tick();
  assert.equal(state.restarts, 1);
  const file = saved(h);
  assert.equal(file.when, 'idle');
  assert.equal(file.reason, 'new release');
  assert.equal(file.fromVersion, '0.1.0+old');
  assert.ok(file.shutdownAt, 'the shutdown time is saved for the resume age');
  assert.deepEqual(notices(h), ['The runner is restarting now.']);
  // A second request while restarting merges and doesn't restart twice.
  assert.deepEqual(r.request({}), { scheduled: true, waitingFor: [] });
  await tick();
  assert.equal(state.restarts, 1);
});

test('idle waits for running threads and for approvals and questions', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  const res = r.request({ when: 'idle' });
  assert.deepEqual(res, { scheduled: true, waitingFor: [thread.id] });
  assert.deepEqual(notices(h), ['The runner will restart when 1 thread finishes.']);
  assert.deepEqual(r.helloNotices(), [{ level: 'info', message: 'The runner will restart when 1 thread finishes.' }]);
  assert.deepEqual(r.status().pendingRestart?.waitingFor, [thread.id]);

  // Blocked on an approval, then a question: still busy.
  const approval = s.sink.requestApproval({ toolUseId: 't1', name: 'Bash', title: 'ls', input: { command: 'ls' }, canAlwaysAllow: true, signal: new AbortController().signal });
  assert.equal(h.runner.get(thread.id).status, 'waiting');
  await tick();
  assert.equal(state.restarts, 0);
  const approvalId = h.events(thread.id).find((e) => e.type === 'approval.requested').approvalId;
  h.runner.respondApproval({ threadId: thread.id, approvalId, decision: 'allow' });
  assert.equal((await approval).decision, 'allow');
  const question = s.sink.requestQuestion({ toolUseId: 't2', questions: [{ question: 'Tea?', multiSelect: false, options: [{ label: 'Yes' }] }], signal: new AbortController().signal });
  await tick();
  assert.equal(state.restarts, 0);
  const questionId = h.events(thread.id).find((e) => e.type === 'question.requested').approvalId;
  h.runner.respondApproval({ threadId: thread.id, approvalId: questionId, decision: 'answered', answers: { '0': 'Yes' } });
  await question;
  await tick();
  assert.equal(state.restarts, 0, 'the turn is still running');

  s.result();
  assert.equal(state.restarts, 0, 'checked after the tick, not inside the turn ending');
  await tick();
  assert.equal(state.restarts, 1);
});

test('a background subagent asking for approval after its turn ended keeps the runner up', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h, { permissionMode: 'ask' });
  const s = h.adapter.last;
  s.init();
  s.result();
  // The subagent asks with no turn running: the runner opens one for it.
  void s.sink.requestApproval({ name: 'Write', title: 'Write x', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  assert.equal(h.runner.get(thread.id).status, 'waiting');
  assert.deepEqual(r.request({}).waitingFor, [thread.id]);
  // It waits on Mike, not on the thread finishing, and says so.
  assert.deepEqual(notices(h), ['The runner will restart when you answer 1 thread.']);
  assert.deepEqual(r.helloNotices(), [{ level: 'info', message: 'The runner will restart when you answer 1 thread.' }]);
  await tick();
  assert.equal(state.restarts, 0);
});

test('an idle restart waits for a running turn.end hook, and goes once it has ended', async () => {
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.threadbear/patches'), { recursive: true });
  fs.writeFileSync(path.join(project, '.threadbear/patches/h.ts'), `export default { hooks: [{ title: "Slow", on: "turn.end", run: "sleep 0.3", tell: "never" }] };`);
  const h = makeHarness(undefined, {}, { panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  const { r, state } = withRestarter(h);
  const { thread } = create(h, { cwd: project });
  await tick();
  await h.runner.patchesIdle();
  const s = h.adapter.last;
  s.init();
  s.result('completed');
  assert.equal(h.runner.get(thread.id).status, 'idle', 'nothing else holds it');
  assert.deepEqual(r.request({ when: 'idle' }).waitingFor, [thread.id]);
  await tick();
  assert.equal(state.restarts, 0);
  const end = Date.now() + 5000;
  while (state.restarts === 0 && Date.now() < end) await new Promise((res) => setTimeout(res, 10));
  assert.equal(state.restarts, 1);
  assert.ok(h.events(thread.id).some((e) => e.type === 'action.run' && e.trigger === 'turn.end'), 'with its result in the thread');
});

test('a send while a restart is pending still works, and the restart waits for it', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const a = create(h).thread;
  const sa = h.adapter.last;
  sa.init();
  const b = create(h).thread;
  const sb = h.adapter.last;
  sb.init();
  sb.result();
  assert.deepEqual(r.request({}).waitingFor, [a.id]);

  // Queued behind A's turn: when that ends the next one starts in the same
  // tick, so the runner never looks idle in between.
  h.runner.send(a.id, 'and one more thing');
  sa.result();
  await tick();
  assert.equal(state.restarts, 0);
  assert.equal(h.runner.get(a.id).status, 'running');
  assert.equal(sa.sent.length, 2, 'the queued message reached the CLI');

  // A new turn in an idle thread counts too.
  h.runner.send(b.id, 'also this');
  await tick();
  sa.result();
  await tick();
  assert.equal(state.restarts, 0, 'B is running now');
  assert.deepEqual(r.status().pendingRestart?.waitingFor, [b.id]);
  sb.result();
  await tick();
  assert.equal(state.restarts, 1);
});

test('deleting the thread a restart waits for lets it go ahead', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  assert.deepEqual(r.request({}).waitingFor, [thread.id]);
  await tick();
  assert.equal(state.restarts, 0);
  // delete_thread from another thread's agent, or tb delete: the thread is
  // gone without a thread.updated, which is all the idle check listened to.
  h.runner.delete(thread.id);
  await tick();
  assert.equal(state.restarts, 1);
});

test('"now" restarts straight away and wins over a pending idle restart', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  assert.deepEqual(r.request({ resume: { threadId: thread.id, text: 'carry on' } }).waitingFor, [thread.id]);
  await tick();
  assert.equal(state.restarts, 0);
  assert.deepEqual(r.request({ when: 'now', reason: 'stuck' }), { scheduled: true, waitingFor: [] });
  await tick();
  assert.equal(state.restarts, 1);
  const file = saved(h);
  assert.equal(file.when, 'now');
  assert.equal(file.reason, 'stuck');
  assert.deepEqual(file.resumes.map((x) => x.threadId), [thread.id], 'the earlier resume is kept');
});

test('runner.status reports the version, live CLIs, busy threads and the pending restart', () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const a = create(h).thread;
  h.adapter.last.init();
  const b = create(h).thread;
  h.adapter.last.init();
  h.adapter.last.result();
  let s = r.status();
  assert.equal(s.version, '0.1.0+old');
  assert.equal(s.release, 'old');
  assert.equal(s.pid, process.pid);
  assert.equal(s.home, h.home);
  assert.equal(s.liveClis, 2);
  assert.deepEqual(s.running, [a.id]);
  assert.equal(s.pendingRestart, undefined);
  assert.deepEqual(r.helloNotices(), []);
  r.request({ reason: 'deploy', resume: { threadId: b.id, text: 'check it' } });
  s = r.status();
  assert.deepEqual(s.pendingRestart, { when: 'idle', requestedAt: new Date(h.clock.now()).toISOString(), waitingFor: [a.id], reason: 'deploy', resumeThreadId: b.id });
});

test('a resume for a thread that does not exist is refused up front', () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  assert.throws(() => r.request({ resume: { threadId: 'nope', text: 'x' } }), (e: RpcError) => e.code === -32004);
  assert.equal(fs.existsSync(restartPath(h.home)), false);
});

test('after a restart the thread gets a note and its resume as a turn from the runner', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h, '0.1.0+old');
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  r.request({ resume: { threadId: thread.id, text: 'The runner restarted. Check it works, then carry on.' } });
  await tick();

  const h2 = h.restart();
  const r2 = withRestarter(h2, '0.1.0+new').r;
  r2.resumeAfterRestart();
  assert.equal(fs.existsSync(restartPath(h.home)), false, 'restart.json is gone once handled');
  const evs = h2.events(thread.id);
  // The new CLI resumes the native session, as any message after a restart does.
  assert.deepEqual(evs.map((e) => e.type), ['system.note', 'user.message', 'turn.started', 'system.note']);
  assert.equal(evs[0].text, 'Runner restarted: 0.1.0+old to 0.1.0+new');
  assert.equal(evs[1].origin, 'runner');
  assert.equal(evs[1].text, 'The runner restarted. Check it works, then carry on.');
  assert.equal(evs[3].text, 'Resumed session');
  assert.deepEqual(checkSequence(h2.runner.events(thread.id).events), []);
  await tick();
  assert.equal(h2.adapter.last.sent[0].text, 'The runner restarted. Check it works, then carry on.');
  // Messages people send carry no origin.
  h2.adapter.last.init();
  h2.adapter.last.result();
  h2.runner.send(thread.id, 'thanks');
  assert.equal(h2.events(thread.id).filter((e) => e.type === 'user.message').at(-1).origin, undefined);
  // Nothing left to resume on the start after that.
  const h3 = h2.restart();
  withRestarter(h3).r.resumeAfterRestart();
  assert.deepEqual(h3.events(thread.id).filter((e) => e.type !== 'turn.completed'), [], 'only recovery of the turn left running');
});

test('after a crash rollback the resumed thread hears which release it is really on', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h, '0.1.0+old');
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  r.request({ resume: { threadId: thread.id, text: 'carry on' } });
  await tick();
  // The new release crashed at startup and launch.mjs went back to "old".
  const h2 = h.restart();
  const rolledBack = 'Release new kept crashing at startup, so the runner went back to old.';
  new Restarter({ runner: h2.runner, home: h2.home, clock: h2.clock, log: nullLogger, version: '0.1.0+old', rolledBack, restart: () => {} }).resumeAfterRestart();
  const note = h2.events(thread.id).find((e) => e.type === 'system.note');
  assert.equal(note.text, `Runner restarted: 0.1.0+old to 0.1.0+old\n\n${rolledBack}`);
  // The model can't see notes, so the message says it too.
  const msg = h2.events(thread.id).find((e) => e.type === 'user.message');
  assert.equal(msg.text, `Note from the runner: ${rolledBack} Check tb logs before going on. Your message for after the restart follows.\n\ncarry on`);
});

test('a resume queued behind a running turn keeps its origin', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.runner.send(thread.id, 'from the runner', [], { origin: 'runner' });
  h.adapter.last.result();
  const msgs = h.events(thread.id).filter((e) => e.type === 'user.message');
  assert.deepEqual(msgs.map((m) => m.origin), [undefined, 'runner']);
});

test('a crash while a restart is pending still delivers the resume on the next start', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  r.request({ resume: { threadId: thread.id, text: 'carry on' } });
  await tick();
  assert.equal(state.restarts, 0, 'still waiting for the turn');
  assert.equal(saved(h).shutdownAt, undefined);

  // The runner dies mid-turn; launchd starts it again.
  h.clock.advance(5 * MIN);
  const h2 = h.restart();
  h2.clock.advance(5 * MIN);
  withRestarter(h2, '0.1.0+new').r.resumeAfterRestart();
  const evs: any[] = h2.runner.events(thread.id).events;
  const i = evs.findIndex((e) => e.type === 'system.note' && e.text.startsWith('Runner restarted'));
  assert.equal(evs[i - 1].type, 'turn.completed', 'recovery ended the turn the crash cut short');
  assert.equal(evs[i - 1].outcome, 'interrupted');
  assert.equal(evs[i].text, 'Runner restarted: 0.1.0+old to 0.1.0+new');
  assert.equal(evs[i + 1].type, 'user.message');
  assert.equal(evs[i + 1].origin, 'runner');
  assert.equal(evs[i + 2].type, 'turn.started');
  assert.equal(fs.existsSync(restartPath(h.home)), false);
});

test('a resume more than 15 minutes old only leaves the note', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  const sessions = h.adapter.sessions.length;
  const at = new Date(h.clock.now() - 16 * MIN).toISOString();
  const file: RestartFile = { when: 'idle', requestedAt: at, shutdownAt: at, fromVersion: '0.1.0+old', resumes: [{ threadId: thread.id, text: 'carry on', requestedAt: at }] };
  fs.writeFileSync(restartPath(h.home), JSON.stringify(file));
  withRestarter(h, '0.1.0+new').r.resumeAfterRestart();
  const last = h.events(thread.id).at(-1);
  assert.equal(last.type, 'system.note');
  assert.match(last.text, /^Runner restarted: 0\.1\.0\+old to 0\.1\.0\+new\n\nNot carrying on by itself: the request is more than 15 minutes old\.$/);
  assert.equal(h.adapter.sessions.length, sessions);
  assert.equal(fs.existsSync(restartPath(h.home)), false);
});

test('the age counts from the shutdown, so a restart that waited a long time still resumes', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  const file: RestartFile = {
    when: 'idle',
    requestedAt: new Date(h.clock.now() - 90 * MIN).toISOString(),
    shutdownAt: new Date(h.clock.now() - 1 * MIN).toISOString(),
    fromVersion: 'a',
    resumes: [{ threadId: thread.id, text: 'carry on', requestedAt: new Date(h.clock.now() - 90 * MIN).toISOString() }],
  };
  fs.writeFileSync(restartPath(h.home), JSON.stringify(file));
  withRestarter(h, 'b').r.resumeAfterRestart();
  assert.equal(h.events(thread.id).at(-1).type, 'turn.started');
});

test('at most 3 automatic resumes per thread an hour; past that, only the note', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.result();
  const restartOnce = () => {
    const now = new Date(h.clock.now()).toISOString();
    const file: RestartFile = { when: 'idle', requestedAt: now, shutdownAt: now, fromVersion: 'a', resumes: [{ threadId: thread.id, text: 'go on', requestedAt: now }] };
    fs.writeFileSync(restartPath(h.home), JSON.stringify(file));
    const before = h.events(thread.id).length;
    withRestarter(h, 'b').r.resumeAfterRestart();
    const added = h.events(thread.id).slice(before);
    const live = h.adapter.last;
    // Finish the resumed turn so the next one starts cleanly.
    if (added.some((e) => e.type === 'user.message')) {
      live.init();
      live.result();
    }
    return added;
  };
  for (let i = 0; i < 3; i++) {
    const added = restartOnce();
    assert.equal(added.filter((e) => e.type === 'user.message' && e.origin === 'runner').length, 1, `resume ${i + 1} is sent`);
    h.clock.advance(10 * MIN);
  }
  const fourth = restartOnce();
  assert.deepEqual(fourth.map((e) => e.type), ['system.note']);
  assert.match(fourth[0].text, /already been resumed 3 times in the last hour/);
  // An hour after the first one, there's room again.
  h.clock.advance(31 * MIN);
  assert.equal(restartOnce().filter((e) => e.type === 'user.message').length, 1);
  // The guard is per thread and lives in run/resumes.json.
  assert.ok(fs.existsSync(resumesPath(h.home)));
  assert.equal(takeResume(h.home, 'another-thread', h.clock.now()), true);
});

test('snoozed or archived threads get the note, saying why, but are not woken by a resume', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: thread.id, archived: true });
  const now = new Date(h.clock.now()).toISOString();
  fs.writeFileSync(restartPath(h.home), JSON.stringify({ when: 'idle', requestedAt: now, fromVersion: 'a', resumes: [{ threadId: thread.id, text: 'go', requestedAt: now }] }));
  withRestarter(h, 'b').r.resumeAfterRestart();
  const last = h.events(thread.id).at(-1);
  assert.equal(last.type, 'system.note');
  assert.equal(last.text, 'Runner restarted: a to b\n\nNot carrying on by itself: this thread is archived.');
  assert.ok(h.runner.get(thread.id).archivedAt, 'still archived');

  const t2 = create(h).thread;
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: t2.id, snoozedUntil: new Date(h.clock.now() + 60 * MIN).toISOString() });
  saveRestart(h, t2.id);
  withRestarter(h, 'b').r.resumeAfterRestart();
  assert.match(h.events(t2.id).at(-1).text, /Not carrying on by itself: this thread is snoozed\.$/);
});

test('a thread hibernating until the restart wakes before the resume, so it is carried on', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: thread.id, snoozedUntil: 'restart' });
  saveRestart(h, thread.id);
  const h2 = h.restart();
  withRestarter(h2, 'b').r.resumeAfterRestart();
  const [note, resume] = noteAndResume(h2, thread.id);
  assert.equal(note.text, 'Runner restarted: a to b');
  assert.equal(resume.text, 'go on');
  assert.equal(h2.runner.get(thread.id).snoozedUntil, undefined);
});

test('an unreadable restart.json, or one for a deleted thread, is dropped without harm', () => {
  const h = makeHarness();
  fs.writeFileSync(restartPath(h.home), '{ not json');
  withRestarter(h).r.resumeAfterRestart();
  assert.equal(fs.existsSync(restartPath(h.home)), false);
  const now = new Date(h.clock.now()).toISOString();
  fs.writeFileSync(restartPath(h.home), JSON.stringify({ when: 'idle', requestedAt: now, fromVersion: 'a', resumes: [{ threadId: 'gone', text: 'x', requestedAt: now }] }));
  withRestarter(h).r.resumeAfterRestart();
  assert.equal(fs.existsSync(restartPath(h.home)), false);
});

test('restart params are checked', () => {
  assert.deepEqual(parseRestartParams({}), {});
  assert.deepEqual(parseRestartParams({ when: 'now', reason: ' x ', resume: { threadId: 't', text: 'go' } }), { when: 'now', reason: 'x', resume: { threadId: 't', text: 'go' } });
  assert.deepEqual(parseRestartParams({ cancel: true, release: 'r1' }), { cancel: true, release: 'r1' });
  assert.deepEqual(parseRestartParams({ cancel: false }), {});
  for (const bad of [{ when: 'later' }, { reason: 3 }, { resume: 'x' }, { resume: { threadId: 't' } }, { resume: { threadId: 't', text: '  ' } }, { resume: [] }, { cancel: 'yes' }, { release: 3 }, { release: '' }, { backgroundWaitMs: -1 }, { backgroundWaitMs: '30m' }]) {
    assert.throws(() => parseRestartParams(bad), (e: RpcError) => e.code === -32602, JSON.stringify(bad));
  }
  assert.equal(pendingMessage(2), 'The runner will restart when 2 threads finish.');
});

test('the restart notices are the sentences the Mac app reads', () => {
  // RunnerRestart.parse (app/Sources/ThreadbearCore/RPC/RunnerRestart.swift)
  // goes by these prefixes and adds up the numbers after "when"; the mock
  // runner has the same sentences. Change all three together.
  assert.equal(pendingMessage(0), 'The runner is restarting now.');
  assert.equal(pendingMessage(1), 'The runner will restart when 1 thread finishes.');
  assert.equal(pendingMessage(3), 'The runner will restart when 3 threads finish.');
  assert.equal(pendingMessage(3, 2), 'The runner will restart when 1 thread finishes and you answer 2.');
  assert.equal(pendingMessage(3, 1), 'The runner will restart when 2 threads finish and you answer 1.');
  assert.equal(pendingMessage(1, 1), 'The runner will restart when you answer 1 thread.');
  assert.equal(pendingMessage(2, 2), 'The runner will restart when you answer 2 threads.');
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'restart.ts'), 'utf8');
  assert.match(src, /'The pending runner restart was cancelled\.'/);
});

test('background shells and subagents hold an idle restart until they finish', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: TASKS });
  s.result();
  assert.equal(h.runner.get(thread.id).status, 'idle', 'the turn is over');
  assert.deepEqual(r.request({}).waitingFor, [thread.id]);
  assert.deepEqual(r.status().background, [{ threadId: thread.id, tasks: ['npm run e2e'] }]);
  assert.deepEqual(r.status().running, []);
  assert.deepEqual(r.status().pendingRestart?.waitingFor, [thread.id]);
  await tick();
  assert.equal(state.restarts, 0);
  // The work ends: the CLI's task list empties, it runs a turn to read the
  // result, and then the restart goes ahead.
  s.out({ kind: 'tasks', tasks: [] });
  s.out({ kind: 'cliTurn' });
  s.result();
  await tick();
  assert.equal(state.restarts, 1);
});

test('when background work ends, the restart also waits for the turn the CLI starts to read the result', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: TASKS });
  s.result();
  r.request({});
  // The CLI says the list is empty a moment before its own turn starts.
  s.out({ kind: 'tasks', tasks: [] });
  await tick();
  assert.equal(state.restarts, 0, 'not in the gap before the turn');
  assert.match(r.status().background?.[0].tasks[0] ?? '', /just finished/);
  s.out({ kind: 'cliTurn', note: 'Background command "npm run e2e" completed' });
  await tick();
  assert.equal(state.restarts, 0, 'the turn is running');
  s.result();
  await tick();
  assert.equal(state.restarts, 1);

  // If the CLI never starts one, the restart goes ahead after a while.
  const h2 = makeHarness();
  const r2 = withRestarter(h2);
  create(h2);
  const s2 = h2.adapter.last;
  s2.init();
  s2.out({ kind: 'tasks', tasks: TASKS });
  s2.result();
  r2.r.request({});
  s2.out({ kind: 'tasks', tasks: [] });
  await tick();
  assert.equal(r2.state.restarts, 0);
  h2.clock.advance(15_000);
  await tick();
  assert.equal(r2.state.restarts, 1);
});

test('background work that ends during a turn: the restart waits for the turn the CLI may start after it', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: TASKS });
  r.request({});
  // npm run e2e finishes while the model writes its last message. The CLI
  // holds the notification and starts a turn of its own after the result.
  s.out({ kind: 'tasks', tasks: [] });
  s.result();
  await tick();
  assert.equal(state.restarts, 0, 'not between the result and the CLI turn');
  assert.deepEqual(r.status().pendingRestart?.waitingFor, [thread.id]);
  s.out({ kind: 'cliTurn', note: 'Background command "npm run e2e" completed' });
  s.result();
  await tick();
  assert.equal(state.restarts, 1);

  // If the CLI folded it into the turn instead, the restart goes ahead
  // after the grace period.
  const h2 = makeHarness();
  const r2 = withRestarter(h2);
  create(h2);
  const s2 = h2.adapter.last;
  s2.init();
  s2.out({ kind: 'tasks', tasks: TASKS });
  r2.r.request({});
  s2.out({ kind: 'tasks', tasks: [] });
  s2.result();
  await tick();
  assert.equal(r2.state.restarts, 0);
  h2.clock.advance(15_000);
  await tick();
  assert.equal(r2.state.restarts, 1);
});

test('background work holds a restart for backgroundWaitMs at most, turns for as long as they take', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const dev = create(h).thread;
  const sd = h.adapter.last;
  sd.init();
  sd.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] });
  sd.result();
  const busy = create(h).thread;
  const sb = h.adapter.last;
  sb.init();
  const res = r.request({ backgroundWaitMs: 10 * MIN });
  assert.deepEqual(new Set(res.waitingFor), new Set([dev.id, busy.id]));
  assert.deepEqual(res.background, [{ threadId: dev.id, tasks: ['npm run dev'] }], 'named, so the scripts can say what it waits for');
  assert.equal(saved(h).backgroundUntil, new Date(h.clock.now() + 10 * MIN).toISOString());
  assert.equal(r.status().pendingRestart?.backgroundUntil, saved(h).backgroundUntil);
  // A later request with a longer limit doesn't extend it.
  r.request({ backgroundWaitMs: 60 * MIN });
  assert.equal(saved(h).backgroundUntil, new Date(h.clock.now() + 10 * MIN).toISOString());
  h.clock.advance(10 * MIN);
  await tick();
  assert.equal(state.restarts, 0, 'the turn still holds it');
  assert.deepEqual(r.status().pendingRestart?.waitingFor, [busy.id]);
  sb.result();
  await tick();
  assert.equal(state.restarts, 1, 'the dev server no longer does');
  await h.runner.shutdown();
  assert.equal(h.events(dev.id).at(-1).text, 'Stopped background work when the runner stopped: npm run dev');

  // With only background work left, the limit itself sets it off.
  const h2 = makeHarness();
  const r2 = withRestarter(h2);
  create(h2);
  const s2 = h2.adapter.last;
  s2.init();
  s2.out({ kind: 'tasks', tasks: TASKS });
  s2.result();
  r2.r.request({ backgroundWaitMs: 60_000 });
  await tick();
  assert.equal(r2.state.restarts, 0);
  h2.clock.advance(60_000);
  await tick();
  assert.equal(r2.state.restarts, 1);
});

test('a restart that does stop background work says so in that thread', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'tasks', tasks: TASKS });
  s.result();
  r.request({ when: 'now' });
  await tick();
  assert.equal(state.restarts, 1);
  // main.ts's stop: the runner shuts down.
  await h.runner.shutdown();
  const note = h.events(thread.id).at(-1);
  assert.equal(note.type, 'system.note');
  assert.equal(note.text, 'Stopped background work when the runner stopped: npm run e2e');
});

test('once the restart has begun, new sends and threads are refused', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  r.request({});
  assert.throws(() => h.runner.send(thread.id, 'one more'), (e: RpcError) => e.code === -32020 && /restarting/.test(e.message));
  assert.throws(() => create(h), (e: RpcError) => e.code === -32020);
});

test('a pending restart can be cancelled until it begins', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  assert.deepEqual(r.request({ cancel: true }), { scheduled: false, waitingFor: [] }, 'nothing to cancel');
  r.request({ resume: { threadId: thread.id, text: 'go' } });
  assert.ok(fs.existsSync(restartPath(h.home)));
  assert.deepEqual(r.request({ cancel: true }), { scheduled: false, waitingFor: [] });
  assert.equal(fs.existsSync(restartPath(h.home)), false);
  assert.equal(r.status().pendingRestart, undefined);
  assert.ok(notices(h).includes('The pending runner restart was cancelled.'));
  h.adapter.last.result();
  await tick();
  assert.equal(state.restarts, 0, 'nothing restarts when the thread finishes');
  r.request({});
  assert.throws(() => r.request({ cancel: true }), (e: RpcError) => e.code === -32020);
});

test("cancelling a deploy's restart points current back at the running release", () => {
  const h = makeHarness();
  // A data dir with releases A (running) and B (a deploy made current).
  const dir = path.join(h.home, 'runner');
  for (const id of ['A', 'B']) {
    fs.mkdirSync(path.join(dir, 'releases', id, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'releases', id, 'src', 'main.ts'), '');
  }
  fs.symlinkSync(path.join('releases', 'B'), path.join(dir, 'current'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ current: 'B', previous: 'A', lastGood: 'A', boots: [] }));
  const { thread } = create(h);
  h.adapter.last.init();
  const { r } = withRestarter(h, '0.1.0+A', { release: 'A' });
  r.request({ release: 'B', resume: { threadId: thread.id, text: 'check B' } });
  const res = r.request({ cancel: true });
  assert.equal(res.scheduled, false);
  assert.equal(res.note, "current points at A again (the release running now), so B won't start on the next restart.");
  assert.equal(fs.readlinkSync(path.join(dir, 'current')), path.join('releases', 'A'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).current, 'A');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).lastGood, 'A', 'the rest is kept');

  // A restart that wasn't a deploy's leaves current alone.
  fs.rmSync(path.join(dir, 'current'));
  fs.symlinkSync(path.join('releases', 'B'), path.join(dir, 'current'));
  r.request({});
  assert.deepEqual(r.request({ cancel: true }), { scheduled: false, waitingFor: [] });
  assert.equal(fs.readlinkSync(path.join(dir, 'current')), path.join('releases', 'B'));

  // A runner run from source can't go back to itself, so it says so.
  const { r: src } = withRestarter(h, '0.1.0+source', { release: undefined });
  src.request({ release: 'B' });
  assert.equal(src.request({ cancel: true }).note, "Release B is still current and starts on the runner's next restart (a crash or a reboot too).");
  assert.equal(fs.readlinkSync(path.join(dir, 'current')), path.join('releases', 'B'));
});

test('a runner stopped some other way while a restart waits counts as restarted from then', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const a = create(h).thread;
  h.adapter.last.init();
  const t = create(h).thread;
  h.adapter.last.init();
  h.adapter.last.result();
  // T deploys at 0 and its restart waits for A's long turn.
  r.request({ resume: { threadId: t.id, text: 'check it' } });
  h.clock.advance(20 * MIN);
  // Mike stops waiting: launchctl kickstart sends SIGTERM, and main.ts's stop.
  r.stopping();
  assert.equal(saved(h).shutdownAt, new Date(h.clock.now()).toISOString());
  await h.runner.shutdown();
  const h2 = h.restart();
  h2.clock.advance(20 * MIN + 1000);
  withRestarter(h2, '0.1.0+new').r.resumeAfterRestart();
  assert.equal(h2.events(t.id).filter((e) => e.type === 'user.message' && e.origin === 'runner').length, 1, 'carried on, not dropped as 20 minutes old');
  assert.equal(h.runner.get(a.id).status, 'stopped', 'the long turn was the one cut short');
});

test("a merged resume's age counts from its own request when the runner died before shutting down", () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  const old = new Date(h.clock.now() - 21 * MIN).toISOString();
  const recent = new Date(h.clock.now() - 1 * MIN).toISOString();
  fs.writeFileSync(restartPath(h.home), JSON.stringify({ when: 'idle', requestedAt: old, fromVersion: 'a', resumes: [{ threadId: thread.id, text: 'go', requestedAt: recent }] }));
  withRestarter(h, 'b').r.resumeAfterRestart();
  assert.equal(h.events(thread.id).at(-1).type, 'turn.started');
});

test('a snoozed thread keeps its queued message through a restart and sends it when it wakes', async () => {
  const h = makeHarness();
  const { r, state } = withRestarter(h);
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  // A folder change is due on the next turn, so the message waits for it
  // rather than joining the running turn.
  h.runner.update({ threadId: thread.id, cwd: tmpDir() });
  h.runner.send(thread.id, 'please also do X');
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 60 * MIN).toISOString() });
  // Snoozing mid-turn interrupts it; the queue is held for the wake-up.
  s.result('interrupted');
  await tick();
  r.request({});
  await tick();
  assert.equal(state.restarts, 1);
  await h.runner.shutdown();
  const h2 = h.restart();
  assert.deepEqual(
    h2.events(thread.id).filter((e) => e.type === 'system.note'),
    [],
    'no "queued message was never sent" note',
  );
  h2.clock.advance(61 * MIN);
  await tick();
  const sent = h2.events(thread.id).filter((e) => e.type === 'user.message');
  assert.deepEqual(sent.map((e) => e.text), ['please also do X']);
});

test('a snooze that ends while the runner is down still sends the queued message', async () => {
  const h = makeHarness();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  // A folder change is due on the next turn, so the message waits for it
  // rather than joining the running turn.
  h.runner.update({ threadId: thread.id, cwd: tmpDir() });
  h.runner.send(thread.id, 'please also do X');
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 60 * MIN).toISOString() });
  s.result('interrupted');
  await h.runner.shutdown();
  // Down overnight: by the next start the snooze has long ended. (Each
  // harness's clock starts at the same time, so the snooze moves back.)
  const file = path.join(h.home, 'threads', thread.id, 'thread.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.snoozedUntil = new Date(h.clock.now() - 60 * MIN).toISOString();
  fs.writeFileSync(file, JSON.stringify(rec));
  const h2 = h.restart();
  const evs = h2.events(thread.id);
  assert.deepEqual(evs.filter((e) => e.type === 'system.note' && /queued message/.test(e.text)), [], 'not dropped with a note');
  assert.deepEqual(evs.filter((e) => e.type === 'user.message').map((e) => e.text), ['please also do X']);
  assert.equal(h2.runner.get(thread.id).snoozedUntil, undefined);
});

test('a thread someone has written in since it asked is not resumed over them', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const other = create(h).thread;
  const so = h.adapter.last;
  so.init();
  const { thread } = create(h);
  const s = h.adapter.last;
  s.init();
  r.request({ resume: { threadId: thread.id, text: 'Check that your change works, then carry on.' } });
  s.result();
  // Mike: "stop, don't carry on". The restart still waits for the other thread.
  h.runner.send(thread.id, "stop, don't carry on");
  s.result();
  so.result();
  await tick();
  await h.runner.shutdown();
  const h2 = h.restart();
  withRestarter(h2, 'b').r.resumeAfterRestart();
  const last = h2.events(thread.id).at(-1);
  assert.equal(last.type, 'system.note');
  assert.match(last.text, /Not carrying on by itself: a message was sent to this thread after the restart was asked for\.$/);
});

test('a thread resumed on a release other than the one it deployed is told so, in the note and the message', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  // It deployed B, B kept crashing, and launch.mjs went back to A.
  const rolledBack = 'Release B kept crashing at startup, so the runner went back to A.';
  saveRestart(h, thread.id, {}, { release: 'B', text: 'The runner restarted on release B. Check that your change works, then carry on.' });
  withRestarter(h, '0.1.0+A', { release: 'A', rolledBack }).r.resumeAfterRestart();
  const [note, msg] = noteAndResume(h, thread.id);
  assert.equal(note.text, `Runner restarted: a to 0.1.0+A\n\n${rolledBack}`);
  assert.equal(msg.origin, 'runner');
  assert.equal(
    msg.text,
    `Note from the runner: ${rolledBack} Release B isn't running (this is A), so the change it carries isn't live. Check tb logs before going on. Your message for after the restart follows.\n\nThe runner restarted on release B. Check that your change works, then carry on.`,
  );

  // A later deploy replaced it before it ran: no rollback, still told.
  const h2 = makeHarness();
  const t2 = create(h2).thread;
  h2.adapter.last.init();
  h2.adapter.last.result();
  saveRestart(h2, t2.id, {}, { release: 'B1' });
  withRestarter(h2, '0.1.0+B2', { release: 'B2', branch: 'feature' }).r.resumeAfterRestart();
  const [note2, msg2] = noteAndResume(h2, t2.id);
  assert.equal(note2.text, "Runner restarted: a to 0.1.0+B2 (from branch feature)\n\nRelease B1 isn't running (this is B2), so the change it carries isn't live.");
  assert.match(msg2.text, /^Note from the runner: Release B1 isn't running/);

  // The release it asked for is running: the text goes as it is.
  const h3 = makeHarness();
  const t3 = create(h3).thread;
  h3.adapter.last.init();
  h3.adapter.last.result();
  saveRestart(h3, t3.id, {}, { release: 'B' });
  withRestarter(h3, '0.1.0+B', { release: 'B', branch: 'main' }).r.resumeAfterRestart();
  const [note3, msg3] = noteAndResume(h3, t3.id);
  assert.equal(note3.text, 'Runner restarted: a to 0.1.0+B');
  assert.equal(msg3.text, 'go on');
});

test('a release that crashes after handling the restart: the one launch.mjs goes back to resumes the thread again', () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  // From the event log on disk: each harness only sees what it emitted.
  const onDisk = (hh: Harness): any[] => {
    const log = hh.store.log(thread.id);
    return log.read(1, log.lastSeq);
  };
  const resumed = (hh: Harness) => onDisk(hh).filter((e) => e.type === 'user.message' && e.origin === 'runner').length;
  saveRestart(h, thread.id, { fromVersion: '0.1.0+A' }, { release: 'B', text: 'check B' });
  // The sequence launch.mjs produces for a release that dies once it is
  // listening: B's first start handles it and resumes the thread, then dies.
  withRestarter(h, '0.1.0+B', { release: 'B' }).r.resumeAfterRestart();
  assert.equal(fs.existsSync(restartPath(h.home)), false);
  assert.ok(fs.existsSync(donePath(h.home)), 'kept until B proves itself');
  assert.equal(resumed(h), 1);
  // B's second start (launch.mjs gives it two): nothing is resumed twice,
  // and the file stays for the rollback that may follow.
  const h2 = h.restart();
  withRestarter(h2, '0.1.0+B', { release: 'B' }).r.resumeAfterRestart();
  assert.equal(resumed(h2), 1);
  assert.ok(fs.existsSync(donePath(h.home)), 'still there for the rollback');
  // B dies again, and launch.mjs's third start goes back to A, which
  // carries the thread on once more and says why.
  const h3 = h2.restart();
  const rolledBack = 'Release B kept crashing at startup, so the runner went back to A.';
  withRestarter(h3, '0.1.0+A', { release: 'A', rolledBack, rolledBackFrom: 'B' }).r.resumeAfterRestart();
  const evs = h3.events(thread.id);
  const note = evs.findLast((e) => e.type === 'system.note' && e.text.startsWith('Runner restarted'));
  assert.equal(note.text, `Runner restarted: 0.1.0+B to 0.1.0+A\n\n${rolledBack}`);
  const msg = evs.findLast((e) => e.type === 'user.message');
  assert.equal(msg.origin, 'runner');
  assert.match(msg.text, /^Note from the runner: Release B kept crashing at startup.*\n\ncheck B$/s);
  assert.equal(resumed(h3), 2);
  assert.equal(fs.existsSync(donePath(h.home)), false, 'only once');
  // The second resume stands in for B's: one counted against the hour, not two.
  assert.equal(JSON.parse(fs.readFileSync(resumesPath(h.home), 'utf8'))[thread.id].length, 1);

  // A rollback from some other release doesn't count: B didn't crash.
  fs.rmSync(resumesPath(h.home), { force: true });
  saveRestart(h3, thread.id, { fromVersion: '0.1.0+A' }, { release: 'B', text: 'check B' });
  withRestarter(h3, '0.1.0+B', { release: 'B' }).r.resumeAfterRestart();
  const hx = h3.restart();
  const before = resumed(hx);
  withRestarter(hx, '0.1.0+A', { release: 'A', rolledBack: 'Release C kept crashing at startup, so the runner went back to A.', rolledBackFrom: 'C' }).r.resumeAfterRestart();
  assert.equal(resumed(hx), before, 'nothing resumed');
  assert.equal(fs.existsSync(donePath(h.home)), false);

  // Nor does another release starting normally (a later deploy).
  saveRestart(hx, thread.id, { fromVersion: '0.1.0+A' }, { release: 'B', text: 'check B' });
  withRestarter(hx, '0.1.0+B', { release: 'B' }).r.resumeAfterRestart();
  const hy = hx.restart();
  withRestarter(hy, '0.1.0+C', { release: 'C' }).r.resumeAfterRestart();
  assert.equal(fs.existsSync(donePath(h.home)), false);

  // A clean stop isn't a crash either.
  saveRestart(hy, thread.id, { fromVersion: '0.1.0+A' }, { release: 'B', text: 'check B' });
  const rb = withRestarter(hy, '0.1.0+B', { release: 'B' }).r;
  rb.resumeAfterRestart();
  rb.stopping();
  assert.equal(fs.existsSync(donePath(h.home)), false);

  // A runner that stays up long enough drops it.
  saveRestart(hy, thread.id);
  const r4 = withRestarter(hy, '0.1.0+A', { release: 'A' }).r;
  r4.resumeAfterRestart();
  assert.ok(fs.existsSync(donePath(h.home)));
  r4.proven();
  assert.equal(fs.existsSync(donePath(h.home)), false);
});

test('runner.restart saves the release and where the thread was', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  r.request({ release: 'B', resume: { threadId: thread.id, text: 'go' } });
  const file = saved(h);
  assert.equal(file.release, 'B');
  assert.equal(file.resumes[0].release, 'B');
  assert.equal(file.resumes[0].afterSeq, h.runner.get(thread.id).lastSeq);
  assert.equal(r.status().pendingRestart?.release, 'B');
});

test('runner.restart and runner.status over the WebSocket, with the pending notice after hello', async () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: 'tok', runner: h.runner, log: nullLogger, methods: restartMethods(r), helloNotices: () => r.helloNotices() });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  const { thread } = create(h);
  h.adapter.last.init();
  // Not the 5 s a real client allows: with the Mac's load near 100 (6 Nov)
  // the handshake took longer and failed every tb land's check.
  const c = await RunnerClient.connect(url, 'tok', { authTimeoutMs: 30_000 });
  try {
    assert.deepEqual((await c.call('runner.status')).running, [thread.id]);
    assert.deepEqual(await c.call('runner.restart', { resume: { threadId: thread.id, text: 'go on' } }), { scheduled: true, waitingFor: [thread.id] });
    await assert.rejects(c.call('runner.restart', { when: 'sometime' }), (e: { code: number }) => e.code === -32602);
    await assert.rejects(c.call('runner.restart', { resume: { threadId: 'missing', text: 'x' } }), (e: { code: number }) => e.code === -32004);
    // Only the methods given are served; nothing from Object's prototype.
    await assert.rejects(c.call('constructor'), (e: { code: number }) => e.code === -32601);
    const c2 = await RunnerClient.connect(url, 'tok');
    const seen: string[] = [];
    c2.onNotification((m, p) => m === 'runner.notice' && seen.push(p.message));
    await c2.call('hello', { client: 'test', version: '1' });
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(seen.includes('The runner will restart when 1 thread finishes.'), seen.join('; '));
    c2.close();
  } finally {
    c.close();
    await server.close();
  }
});

test('every CLI gets THREADBEAR_THREAD_ID, THREADBEAR_HOME and THREADBEAR_RUNNER_VERSION', () => {
  const h = makeHarness();
  const { thread } = create(h);
  const env = h.adapter.last.opts.env!;
  assert.equal(env.THREADBEAR_THREAD_ID, thread.id);
  assert.equal(env.THREADBEAR_HOME, h.home);
  assert.equal(env.THREADBEAR_RUNNER_HOME, h.home);
  // Where a picture goes to be on the thread's shared page (docs/protocol.md, "Sharing").
  assert.equal(env.THREADBEAR_MEDIA_DIR, path.join(h.home, 'threads', thread.id, 'media'));
  assert.match(env.THREADBEAR_RUNNER_VERSION, /^\d+\.\d+\.\d+\+/);
  // This runner's bin/ first, so a bare `tb` in the thread is its tb.
  assert.equal(env.PATH.split(':')[0], path.resolve(import.meta.dirname, '..', '..', 'bin'));
  assert.ok(fs.existsSync(path.join(env.PATH.split(':')[0], 'tb')));
  assert.equal(env.PATH.split(':').slice(1).join(':'), process.env.PATH);

  // The Claude adapter puts them in the CLI's environment, over anything
  // inherited (a runner started from inside a thread has its own).
  let options: any;
  const queryFn = ((args: { options: unknown }) => {
    options = args.options;
    return { async *[Symbol.asyncIterator]() {}, close() {}, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} };
  }) as any;
  const dir = tmpDir();
  const saved = process.env.THREADBEAR_THREAD_ID;
  process.env.THREADBEAR_THREAD_ID = 'the-parent-thread';
  try {
    new ClaudeAdapter({ claudePath: '/nonexistent', registry: new ProcessRegistry(dir, nullLogger), log: nullLogger, queryFn }).start(
      {
        threadId: 't1',
        cwd: dir,
        account: { id: 'claude-3', provider: 'claude', title: 'x', configDir: dir },
        permissionMode: 'full',
        sessionId: '00000000-0000-0000-0000-000000000002',
        resume: false,
        mediaDir: dir,
        blobsDir: dir,
        tmpDir: dir,
        env: { THREADBEAR_THREAD_ID: 't1', THREADBEAR_HOME: '/tmp/home', THREADBEAR_RUNNER_VERSION: '9.9.9+x' },
      },
      { output() {}, requestApproval: async () => ({ decision: 'deny' }), requestQuestion: async () => ({ answers: null }), exited() {} },
    );
  } finally {
    if (saved === undefined) delete process.env.THREADBEAR_THREAD_ID;
    else process.env.THREADBEAR_THREAD_ID = saved;
  }
  assert.equal(options.env.THREADBEAR_THREAD_ID, 't1');
  assert.equal(options.env.THREADBEAR_HOME, '/tmp/home');
  assert.equal(options.env.THREADBEAR_RUNNER_VERSION, '9.9.9+x');
  assert.equal(options.env.CLAUDE_CONFIG_DIR, dir, 'the account still applies');
});

test("a crash rollback's resume replaces the crashed release's in the hourly count", () => {
  const h = makeHarness();
  const { thread } = create(h);
  h.adapter.last.init();
  h.adapter.last.result();
  // Good deploy, broken deploy: two resumes already this hour.
  const earlier = new Date(h.clock.now() - 20 * MIN).toISOString();
  fs.mkdirSync(path.dirname(resumesPath(h.home)), { recursive: true });
  fs.writeFileSync(resumesPath(h.home), JSON.stringify({ [thread.id]: [earlier, earlier] }));
  saveRestart(h, thread.id, { fromVersion: '0.1.0+A' }, { release: 'B', text: 'check B' });
  // B resumes it (the third), then crashes; launch.mjs goes back to A.
  withRestarter(h, '0.1.0+B', { release: 'B' }).r.resumeAfterRestart();
  const h2 = h.restart();
  h2.clock.advance(20_000);
  withRestarter(h2, '0.1.0+A', { release: 'A', rolledBack: 'Release B kept crashing at startup, so the runner went back to A.', rolledBackFrom: 'B' }).r.resumeAfterRestart();
  const evs = h2.events(thread.id);
  const note = evs.findLast((e) => e.type === 'system.note' && e.text.startsWith('Runner restarted'));
  assert.doesNotMatch(note.text, /Not carrying on/, 'A still carries it on');
  assert.equal(evs.findLast((e) => e.type === 'user.message')?.origin, 'runner');
  assert.equal(JSON.parse(fs.readFileSync(resumesPath(h.home), 'utf8'))[thread.id].length, 3);
});

test('runner.restart says when the resume it was asked for will not be sent, without using one up', () => {
  const h = makeHarness();
  const { r } = withRestarter(h);
  const { thread } = create(h);
  h.adapter.last.init();
  assert.equal(r.request({ resume: { threadId: thread.id, text: 'go' } }).noResume, undefined);
  const stamp = new Date(h.clock.now()).toISOString();
  fs.mkdirSync(path.dirname(resumesPath(h.home)), { recursive: true });
  fs.writeFileSync(resumesPath(h.home), JSON.stringify({ [thread.id]: [stamp, stamp, stamp] }));
  const res = r.request({ resume: { threadId: thread.id, text: 'go' } });
  assert.equal(res.noResume, 'this thread has already been resumed 3 times in the last hour');
  assert.deepEqual(res.waitingFor, [thread.id]);
  assert.equal(JSON.parse(fs.readFileSync(resumesPath(h.home), 'utf8'))[thread.id].length, 3, 'only checked');
  // No resume asked for, nothing to say.
  assert.equal(r.request({}).noResume, undefined);
});

test('runner.status names the release launch.mjs went back from, while this one runs because of it', () => {
  const h = makeHarness();
  const dir = path.join(h.home, 'runner');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(h.clock.now()).toISOString();
  const write = (extra: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ current: 'A', previous: 'B', lastGood: 'A', boots: [], rolledBack: { from: 'B', to: 'A', at, reportedAt: at }, ...extra }));
  write({});
  assert.deepEqual(withRestarter(h, '0.1.0+A', { release: 'A' }).r.status().rolledBack, { from: 'B', at });
  // Another release running: not about this one.
  assert.equal(withRestarter(h, '0.1.0+C', { release: 'C' }).r.status().rolledBack, undefined);
  // Activated on purpose since (deploy-runner.sh --rollback onto A).
  write({ activated: { release: 'A', at: new Date(h.clock.now() + MIN).toISOString() } });
  assert.equal(withRestarter(h, '0.1.0+A', { release: 'A' }).r.status().rolledBack, undefined);
  // From source, there are no releases.
  assert.equal(withRestarter(h, '0.1.0+source', { release: undefined }).r.status().rolledBack, undefined);
});
