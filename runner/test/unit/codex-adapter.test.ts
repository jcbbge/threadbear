// The Codex session against a fake app-server (test/helpers/fake-app-server.ts)
// and a stub normaliser: the state machine, steering, interrupts, resume,
// child threads, the short-lived processes and the threadbear tools.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { CodexAdapter, CodexSession, codexModelChoices, type CodexAdapterDeps } from '../../src/adapters/codex/adapter.ts';
import { OVERSIZED_LINE } from '../../src/adapters/codex/appserver.ts';
import { FILE_CHANGE_RULE } from '../../src/adapters/codex/approvals.ts';
import { TOOL_GUIDANCE } from '../../src/adapters/codex/tools.ts';
import type { CodexNormalizerLike } from '../../src/adapters/codex/types.ts';
import { CodexNormalizer } from '../../src/adapters/codex/normalize.ts';
import type { NormalizerContext } from '../../src/adapters/context.ts';
import { SessionNotFoundError, type AdapterOutput, type QuestionRequest, type SessionSink, type StartSessionOptions, type ToolApprovalAnswer, type ToolApprovalRequest, type TurnResult } from '../../src/adapters/types.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import type { Account } from '../../src/protocol.ts';
import { FakeCodex, type FakeConn } from '../helpers/fake-app-server.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

const dirs: string[] = [];
function tmp(prefix = 'tb-cxa-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
let shared: Promise<FakeCodex> | undefined;
function fake(): Promise<FakeCodex> {
  shared ??= FakeCodex.create();
  return shared;
}
after(async () => {
  if (shared) await (await shared).close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const account: Account = {
  id: 'codex-main',
  provider: 'codex',
  title: 'Codex · someone@example.com',
  configDir: '/work/codex-home',
  defaultModel: 'gpt-6.1-sol',
  models: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', title: 'GPT-6-Luna', defaultEffort: 'medium' }],
};

type Call = { method: string; params: unknown; from?: { childThreadId: string } };

// Section B's real normaliser, with every call recorded, so the tests see
// what the adapter feeds it as well as what comes out.
function spyNormalizer() {
  const calls: Call[] = [];
  let inner!: CodexNormalizer;
  const spy: CodexNormalizerLike & { calls: Call[] } = {
    calls,
    handle(method, params, from) {
      calls.push(from ? { method, params, from } : { method, params });
      return inner.handle(method, params, from);
    },
    closeOpen(reason) {
      calls.push({ method: 'closeOpen', params: reason });
      return inner.closeOpen(reason);
    },
    setThread: (t, m) => inner.setThread(t, m),
    startingTurn: (id) => inner.startingTurn(id),
    turnAccepted: (id) => inner.turnAccepted(id),
    steered: (id) => inner.steered(id),
  };
  const factory = (ctx: NormalizerContext) => {
    inner = new CodexNormalizer(ctx);
    return spy;
  };
  return { spy, factory };
}

function recorder() {
  const outputs: AdapterOutput[] = [];
  const approvals: ToolApprovalRequest[] = [];
  const questions: QuestionRequest[] = [];
  let exitResolve!: (e: Error | undefined) => void;
  const exited = new Promise<Error | undefined>((r) => (exitResolve = r));
  let exitCount = 0;
  const state = {
    approve: async (_req: ToolApprovalRequest): Promise<ToolApprovalAnswer> => ({ decision: 'allow' }),
  };
  const sink: SessionSink = {
    output: (o) => outputs.push(o),
    requestApproval: (req) => {
      approvals.push(req);
      return state.approve(req);
    },
    requestQuestion: async (req) => {
      questions.push(req);
      return { answers: null };
    },
    exited: (e) => {
      exitCount++;
      exitResolve(e);
    },
  };
  return {
    sink,
    outputs,
    approvals,
    questions,
    exited,
    state,
    exitCount: () => exitCount,
    results: (): TurnResult[] => outputs.filter((o): o is Extract<AdapterOutput, { kind: 'result' }> => o.kind === 'result').map((o) => o.result),
    notes: (): string[] => outputs.flatMap((o) => (o.kind === 'event' && o.event.type === 'system.note' ? [o.event.text] : [])),
    kinds: (): string[] => outputs.map((o) => o.kind),
    // tool.result events, as [itemId, ok, text].
    toolResults: (): [string, boolean, string | undefined][] =>
      outputs.flatMap((o) => (o.kind === 'event' && o.event.type === 'tool.result' ? [[o.event.itemId, o.event.ok, o.event.text] as [string, boolean, string | undefined]] : [])),
    itemIds: (): string[] => outputs.flatMap((o) => (o.kind === 'event' && 'itemId' in o.event ? [String((o.event as { itemId: unknown }).itemId)] : [])),
  };
}

type Harness = Awaited<ReturnType<typeof open>>;

async function open(o: Partial<StartSessionOptions> & { deps?: Partial<CodexAdapterDeps>; adapter?: CodexAdapter } = {}) {
  const f = await fake();
  const { spy: norm, factory } = spyNormalizer();
  const rec = recorder();
  const home = tmp();
  const adapter =
    o.adapter ??
    new CodexAdapter({
      codexBinary: () => f.bin,
      registry: new ProcessRegistry(home, nullLogger),
      log: nullLogger,
      normalizer: factory,
      timings: { reinterruptMs: 100, finishWaitMs: 500, closingRetryStartMs: 20, closingRetryForMs: 1000, terminateMs: 500, spawnRetryForMs: PATIENCE_MS, closeWaitMs: 2000 },
      ...o.deps,
    });
  const { deps: _d, adapter: _a, ...rest } = o;
  const opts: StartSessionOptions = {
    threadId: 'tb-1',
    cwd: home,
    account,
    permissionMode: 'full',
    sessionId: 'placeholder',
    resume: false,
    mediaDir: path.join(home, 'media'),
    blobsDir: path.join(home, 'blobs'),
    tmpDir: home,
    env: { THREADBEAR_THREAD_ID: 'tb-1' },
    ...rest,
  };
  const session = adapter.start(opts, rec.sink) as CodexSession;
  const conn = await f.next();
  await conn.init();
  return { f, adapter, session, conn, rec, norm, opts, home };
}

function threadResult(id: string, extra: Record<string, unknown> = {}) {
  return {
    thread: { id, parentThreadId: null, cwd: '/work/proj', cliVersion: '0.164.0', model: 'gpt-6-luna', reasoningEffort: 'high', status: { type: 'idle' }, turns: [] },
    model: 'gpt-6-luna',
    cwd: '/work/proj',
    instructionSources: [],
    reasoningEffort: 'high',
    ...extra,
  };
}

async function started(h: Harness, threadId = 'th-1'): Promise<void> {
  const req = await h.conn.request('thread/start');
  h.conn.respond(req.id, threadResult(threadId));
  await waitFor(() => h.rec.kinds().includes('session'));
}

// Answers the turn/start and sends turn/started, as Codex does.
async function turnStarts(h: Harness, turnId: string, threadId = 'th-1') {
  const req = await h.conn.request('turn/start');
  h.conn.notify('thread/settings/updated', { threadId });
  h.conn.respond(req.id, { turn: { id: turnId, rootTurnId: turnId, status: 'inProgress', error: null, durationMs: null, items: [] } });
  h.conn.notify('turn/started', { threadId, turn: { id: turnId, rootTurnId: turnId, status: 'inProgress' } });
  return req;
}

function complete(h: Harness, turnId: string, status = 'completed', threadId = 'th-1'): void {
  h.conn.notify('turn/completed', { threadId, turn: { id: turnId, rootTurnId: turnId, status, error: null, durationMs: 1200, items: [] } });
}

async function waitFor(cond: () => boolean, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Starting

test('a new thread: thread/start with the policy, config and tools; then session, cliVersion and effort', async () => {
  const echo = tool('echo', 'Echo text back.', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
  const h = await open({ model: 'gpt-6-luna', deps: { toolsFor: () => [echo] } });
  const req = await h.conn.request('thread/start');
  const p = req.params as Record<string, any>;
  assert.equal(p.cwd, h.home);
  assert.equal(p.model, 'gpt-6-luna');
  assert.equal(p.approvalPolicy, 'never');
  assert.equal(p.sandbox, 'danger-full-access');
  assert.equal(p.approvalsReviewer, 'user');
  // With tools, the guidance on using them goes in as developer instructions.
  assert.deepEqual(p.config, {
    'shell_environment_policy.set.THREADBEAR_THREAD_ID': 'tb-1',
    'tools.update_plan.enabled': true,
    mcp_optional_startup_grace_ms: 10000,
    suppress_unstable_features_warning: true,
    developer_instructions: TOOL_GUIDANCE,
  });
  assert.equal(p.dynamicTools[0].type, 'namespace');
  assert.equal(p.dynamicTools[0].name, 'threadbear');
  assert.equal(p.dynamicTools[0].tools[0].name, 'echo');
  assert.deepEqual(p.dynamicTools[0].tools[0].inputSchema.properties, { text: { type: 'string' } });
  h.conn.respond(req.id, threadResult('th-new'));
  await waitFor(() => h.rec.outputs.length >= 3);
  assert.deepEqual(h.rec.outputs.slice(0, 3), [
    { kind: 'session', nativeSessionId: 'th-new', model: 'gpt-6-luna' },
    { kind: 'cliVersion', version: '0.164.0' },
    { kind: 'effort', level: 'high' },
  ]);
  // The account's login and limits go to the normaliser.
  await waitFor(() => h.norm.calls.some((c) => c.method === 'account/rateLimits/updated') && h.rec.kinds().includes('limits'));
  assert.ok(h.rec.outputs.some((o) => o.kind === 'limits' && o.email === 'someone@example.com' && o.plan === 'Pro Lite'));
  const rl = h.norm.calls.find((c) => c.method === 'account/rateLimits/updated')!.params as { rateLimits: { primary: { usedPercent: number } } };
  assert.equal(rl.rateLimits.primary.usedPercent, 5);
  await h.session.end();
});

test('ask mode starts read-only with approvals on request', async () => {
  const h = await open({ permissionMode: 'ask' });
  const req = await h.conn.request('thread/start');
  assert.equal(req.params.approvalPolicy, 'on-request');
  assert.equal(req.params.sandbox, 'read-only');
  assert.equal(req.params.approvalsReviewer, 'user');
  h.conn.respond(req.id, threadResult('th-1'));
  h.session.send({ id: 'm1', text: 'hi', images: [] });
  const turn = await h.conn.request('turn/start');
  assert.equal(turn.params.approvalPolicy, 'on-request');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.params.approvalsReviewer, 'user');
  await h.session.end();
});

test('resume: thread/resume without tools; the running version wins over the thread\'s', async () => {
  const h = await open({ resume: true, sessionId: 'th-old' });
  const req = await h.conn.request('thread/resume');
  assert.equal(req.params.threadId, 'th-old');
  assert.equal(req.params.excludeTurns, true);
  assert.equal(req.params.dynamicTools, undefined);
  assert.equal((req.params.config as Record<string, unknown>)['shell_environment_policy.set.THREADBEAR_THREAD_ID'], 'tb-1');
  // Made by an older Codex; this process runs 0.164.0.
  h.conn.respond(req.id, threadResult('th-old', { thread: { ...threadResult('th-old').thread, cliVersion: '0.150.0' } }));
  await waitFor(() => h.rec.kinds().includes('cliVersion'));
  assert.deepEqual(h.rec.outputs.find((o) => o.kind === 'cliVersion'), { kind: 'cliVersion', version: '0.164.0' });
  await h.session.end();
});

test('resume retries on the exact "is closing" text, then carries on', async () => {
  const h = await open({ resume: true, sessionId: 'th-old' });
  const first = await h.conn.request('thread/resume');
  h.conn.fail(first.id, -32600, 'thread th-old is closing; retry thread/resume after the thread is closed');
  const second = await h.conn.request('thread/resume');
  h.conn.fail(second.id, -32600, 'thread th-old is closing; retry thread/resume after the thread is closed');
  const third = await h.conn.request('thread/resume');
  h.conn.respond(third.id, threadResult('th-old'));
  await waitFor(() => h.rec.kinds().includes('session'));
  assert.equal(h.rec.exitCount(), 0);
  await h.session.end();
});

test('resume unarchives an archived thread once', async () => {
  const h = await open({ resume: true, sessionId: 'th-old' });
  const first = await h.conn.request('thread/resume');
  h.conn.fail(first.id, -32600, 'thread th-old is archived');
  const un = await h.conn.request('thread/unarchive');
  assert.deepEqual(un.params, { threadId: 'th-old' });
  h.conn.respond(un.id, {});
  const second = await h.conn.request('thread/resume');
  h.conn.respond(second.id, threadResult('th-old'));
  await waitFor(() => h.rec.kinds().includes('session'));
  await h.session.end();
});

test('a thread that is gone ends the session with SessionNotFoundError', async () => {
  const h = await open({ resume: true, sessionId: 'th-gone' });
  const req = await h.conn.request('thread/resume');
  h.conn.fail(req.id, -32600, 'no rollout found for thread id th-gone');
  const e = await h.rec.exited;
  assert.ok(e instanceof SessionNotFoundError);
  await h.conn.closed;
});

test('traffic before thread/start answers is routed once the id is known', async () => {
  const h = await open();
  const req = await h.conn.request('thread/start');
  h.conn.notify('thread/started', { thread: { id: 'th-1', parentThreadId: null } });
  h.conn.notify('mcpServer/startupStatus/updated', { threadId: 'th-1', name: 'paper', status: 'failed', error: 'down' });
  await sleep(30);
  assert.equal(h.norm.calls.filter((c) => c.method === 'mcpServer/startupStatus/updated').length, 0, 'held until the id is known');
  h.conn.respond(req.id, threadResult('th-1'));
  await waitFor(() => h.norm.calls.some((c) => c.method === 'mcpServer/startupStatus/updated'));
  await h.session.end();
});

// ---- Turns

test('a send before start is held, then sent as turn/start with images first', async () => {
  const h = await open();
  h.session.send({ id: 'm1', text: 'what colour?', images: [{ path: '/media/red.png', mediaType: 'image/png' }] });
  await sleep(20);
  assert.equal(h.conn.sent('turn/start').length, 0);
  await started(h);
  const req = await h.conn.request('turn/start');
  assert.equal(req.params.threadId, 'th-1');
  assert.equal(req.params.clientUserMessageId, 'm1');
  assert.deepEqual(req.params.input, [
    { type: 'localImage', path: '/media/red.png' },
    { type: 'text', text: 'what colour?', text_elements: [] },
  ]);
  assert.equal(req.params.summary, 'detailed');
  assert.equal(req.params.cwd, undefined, 'the folder only goes when it moved');
  assert.equal(req.params.effort, undefined);
  await h.session.end();
});

// docs/protocol.md, "Pictures in a message".
test('pictures go to Codex where their [Picture N] markers are, the rest before the words', async () => {
  const h = await open();
  await started(h);
  const pic = (name: string) => ({ path: `/media/${name}.png`, mediaType: 'image/png' });
  h.session.send({ id: 'm1', text: 'this [Picture 2] beside [Picture 1]\n', images: [pic('red'), pic('blue'), pic('green')] });
  const req = await h.conn.request('turn/start');
  assert.deepEqual(req.params.input, [
    { type: 'localImage', path: '/media/green.png' },
    { type: 'text', text: 'this [Picture 2]', text_elements: [] },
    { type: 'localImage', path: '/media/blue.png' },
    { type: 'text', text: ' beside [Picture 1]', text_elements: [] },
    { type: 'localImage', path: '/media/red.png' },
  ]);
  await h.session.end();
});

test('our own turn: no cliTurn, and the result answers our message', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'hi', images: [] });
  await turnStarts(h, 'u1');
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  assert.equal(h.rec.kinds().includes('cliTurn'), false);
  assert.deepEqual(h.rec.results()[0], { outcome: 'completed', durationMs: 1200, answers: 'm1', answered: ['m1'], queuedTurns: 0 });
  // The next message starts a new turn.
  h.session.send({ id: 'm2', text: 'again', images: [] });
  const req = await h.conn.request('turn/start');
  assert.equal(req.params.clientUserMessageId, 'm2');
  await h.session.end();
});

test('a turn/started that beats the turn/start reply counts as ours', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'hi', images: [] });
  const req = await h.conn.request('turn/start');
  h.conn.notify('turn/started', { threadId: 'th-1', turn: { id: 'u1', rootTurnId: 'u1', status: 'inProgress' } });
  await sleep(20);
  h.conn.respond(req.id, { turn: { id: 'u1', status: 'inProgress' } });
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  assert.equal(h.rec.kinds().includes('cliTurn'), false);
  assert.equal(h.rec.results()[0].answers, 'm1');
  await h.session.end();
});

test('a turn Codex starts by itself is a cliTurn, and its result is its own', async () => {
  const h = await open();
  await started(h);
  h.conn.notify('turn/started', { threadId: 'th-1', turn: { id: 'goal-1', rootTurnId: 'goal-1', status: 'inProgress' } });
  await waitFor(() => h.rec.kinds().includes('cliTurn'));
  complete(h, 'goal-1');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'completed', durationMs: 1200, own: true, queuedTurns: 0 });
  await h.session.end();
});

test('steering: a send during the turn becomes turn/steer and shows in answered', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'start', images: [] });
  await turnStarts(h, 'u1');
  h.session.send({ id: 'm2', text: 'also this', images: [] });
  const steer = await h.conn.request('turn/steer');
  assert.deepEqual(steer.params, { threadId: 'th-1', expectedTurnId: 'u1', clientUserMessageId: 'm2', input: [{ type: 'text', text: 'also this', text_elements: [] }] });
  h.conn.respond(steer.id, { turnId: 'u1' });
  await sleep(20);
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'completed', durationMs: 1200, answers: 'm1', answered: ['m1', 'm2'], queuedTurns: 0 });
  await sleep(30);
  assert.equal(h.conn.pending('turn/start').length, 0, 'nothing left to start');
  await h.session.end();
});

test('a send before the turn id is known is steered once it is', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'start', images: [] });
  const req = await h.conn.request('turn/start');
  h.session.send({ id: 'm2', text: 'more', images: [] });
  await sleep(20);
  assert.equal(h.conn.sent('turn/steer').length, 0);
  h.conn.respond(req.id, { turn: { id: 'u1', status: 'inProgress' } });
  const steer = await h.conn.request('turn/steer');
  assert.equal(steer.params.expectedTurnId, 'u1');
  h.conn.respond(steer.id, { turnId: 'u1' });
  await sleep(10);
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0].answered, ['m1', 'm2']);
  await h.session.end();
});

test('a refused steer is held, counted in queuedTurns, and starts the next turn', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'start', images: [] });
  await turnStarts(h, 'u1');
  h.session.send({ id: 'm2', text: 'late', images: [] });
  const steer = await h.conn.request('turn/steer');
  // The turn ended as the steer arrived: Codex refuses it after completing.
  complete(h, 'u1');
  await sleep(20);
  assert.equal(h.rec.results().length, 0, 'the result waits for the steer to settle');
  h.conn.fail(steer.id, -32600, 'expected turn u1 is not active');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'completed', durationMs: 1200, answers: 'm1', answered: ['m1'], queuedTurns: 1 });
  const next = await h.conn.request('turn/start');
  assert.equal(next.params.clientUserMessageId, 'm2');
  h.conn.respond(next.id, { turn: { id: 'u2', status: 'inProgress' } });
  complete(h, 'u2');
  await waitFor(() => h.rec.results().length === 2);
  assert.deepEqual(h.rec.results()[1], { outcome: 'completed', durationMs: 1200, answers: 'm2', answered: ['m2'], queuedTurns: 0 });
  await h.session.end();
});

test('a failed turn/start fails the turn with Codex\'s message', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'hi', images: [] });
  const req = await h.conn.request('turn/start');
  h.conn.fail(req.id, -32600, 'model gpt-nope not found');
  await waitFor(() => h.rec.results().length === 1);
  const r = h.rec.results()[0];
  assert.equal(r.outcome, 'failed');
  assert.equal(r.error, 'model gpt-nope not found');
  assert.deepEqual(r.answered, ['m1']);
  await h.session.end();
});

test('turn/start is retried on "is closing"', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'hi', images: [] });
  const first = await h.conn.request('turn/start');
  h.conn.fail(first.id, -32600, 'thread th-1 is closing; retry after the thread is closed');
  const second = await h.conn.request('turn/start');
  assert.equal(second.params.clientUserMessageId, 'm1');
  h.conn.respond(second.id, { turn: { id: 'u1', status: 'inProgress' } });
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  assert.equal(h.rec.results()[0].outcome, 'completed');
  await h.session.end();
});

// ---- Interrupts

test('interrupt while the turn is still held behind start drops it and its followers', async () => {
  const h = await open();
  h.session.send({ id: 'm1', text: 'one', images: [] });
  h.session.send({ id: 'm2', text: 'two', images: [] });
  await h.session.interrupt();
  assert.deepEqual(h.rec.results(), [{ outcome: 'interrupted', durationMs: 0, answers: 'm1', answered: ['m1', 'm2'], queuedTurns: 0 }]);
  await started(h);
  await sleep(50);
  assert.equal(h.conn.sent('turn/start').length, 0, 'Stop means stop');
  await h.session.end();
});

test('interrupt before the turn id is known waits for it, then interrupts that turn', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'sleep', images: [] });
  const req = await h.conn.request('turn/start');
  h.session.send({ id: 'm2', text: 'queued behind', images: [] });
  await h.session.interrupt();
  await sleep(20);
  assert.equal(h.conn.sent('turn/interrupt').length, 0);
  h.conn.respond(req.id, { turn: { id: 'u1', status: 'inProgress' } });
  const intr = await h.conn.request('turn/interrupt');
  assert.deepEqual(intr.params, { threadId: 'th-1', turnId: 'u1' });
  h.conn.respond(intr.id, {});
  complete(h, 'u1', 'interrupted');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'interrupted', durationMs: 1200, answers: 'm1', answered: ['m1', 'm2'], queuedTurns: 0 });
  assert.equal(h.conn.sent('turn/steer').length, 0, 'the dropped message was never steered');
  await h.session.end();
});

test('an interrupted command is stopped through backgroundTerminals', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'sleep 30', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('item/started', { threadId: 'th-1', turnId: 'u1', item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'sleep 30'", status: 'inProgress' } });
  await sleep(20);
  const stopping = h.session.interrupt();
  const intr = await h.conn.request('turn/interrupt');
  h.conn.respond(intr.id, {});
  await stopping;
  complete(h, 'u1', 'interrupted');
  const list = await h.conn.request('thread/backgroundTerminals/list');
  assert.deepEqual(list.params, { threadId: 'th-1' });
  h.conn.respond(list.id, { data: [{ itemId: 'exec-1', processId: '64113', command: 'sleep 30', cwd: '/w' }, { itemId: 'exec-other', processId: '1', command: 'x', cwd: '/w' }], nextCursor: null });
  const term = await h.conn.request('thread/backgroundTerminals/terminate');
  assert.deepEqual(term.params, { threadId: 'th-1', processId: '64113' });
  h.conn.respond(term.id, { terminated: true });
  await waitFor(() => h.rec.results().length === 1);
  assert.equal(h.rec.results()[0].outcome, 'interrupted');
  assert.equal(h.conn.sent('thread/backgroundTerminals/terminate').length, 1, 'only the open command of that turn');
  assert.equal(h.rec.exitCount(), 0, 'the session lives on');
  await h.session.end();
});

test('when the command can\'t be stopped the session ends, which stops it', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'sleep 30', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('item/started', { threadId: 'th-1', turnId: 'u1', item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'sleep 30'", cwd: '/w', status: 'inProgress', commandActions: [] } });
  await sleep(20);
  const stopping = h.session.interrupt();
  h.conn.respond((await h.conn.request('turn/interrupt')).id, {});
  await stopping;
  complete(h, 'u1', 'interrupted');
  const list = await h.conn.request('thread/backgroundTerminals/list');
  h.conn.respond(list.id, { data: [{ itemId: 'exec-1', processId: '7', command: 'sleep 30', cwd: '/w' }], nextCursor: null });
  const term = await h.conn.request('thread/backgroundTerminals/terminate');
  h.conn.respond(term.id, { terminated: false });
  const e = await h.rec.exited;
  assert.equal(e, undefined);
  await h.conn.closed;
  // The runner's turn ends with exited() (as interrupted, since Stop was
  // pressed); the next message resumes in a fresh process.
  assert.equal(h.rec.results().length, 0);
  assert.deepEqual(h.rec.toolResults(), [['exec-1', false, 'Interrupted']], "the normaliser's other outputs still go out");
});

test('a message behind an interrupted turn that hasn\'t finished waits, re-interrupting, then starts', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'long', images: [] });
  await turnStarts(h, 'u1');
  const stopping = h.session.interrupt();
  h.conn.respond((await h.conn.request('turn/interrupt')).id, {});
  await stopping;
  // The runner gave up waiting and sends the next message.
  h.session.send({ id: 'm2', text: 'next', images: [] });
  const again = await h.conn.request('turn/interrupt', 1000);
  assert.deepEqual(again.params, { threadId: 'th-1', turnId: 'u1' });
  h.conn.respond(again.id, {});
  assert.equal(h.conn.sent('turn/start').length, 1, 'no turn/start while the old turn runs (it would steer it)');
  assert.equal(h.conn.sent('turn/steer').length, 0);
  complete(h, 'u1', 'interrupted');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'interrupted', durationMs: 1200, answers: 'm1', answered: ['m1'], queuedTurns: 1 });
  const next = await h.conn.request('turn/start');
  assert.equal(next.params.clientUserMessageId, 'm2');
  await h.session.end();
});

test('a message behind an interrupted turn fails after the wait', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'long', images: [] });
  await turnStarts(h, 'u1');
  h.conn.auto.set('turn/interrupt', () => ({}));
  await h.session.interrupt();
  h.session.send({ id: 'm2', text: 'next', images: [] });
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'failed', error: 'Codex is still finishing the last turn', durationMs: 0, answers: 'm2', answered: ['m2'], queuedTurns: 0 });
  await h.session.end();
});

// ---- Ending

test('end() closes stdin and reports exited without waiting for thread/closed', async () => {
  const h = await open();
  await started(h);
  const t0 = Date.now();
  await h.session.end();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await h.rec.exited, undefined);
  await h.conn.closed;
  assert.equal(h.conn.sent('thread/unsubscribe').length, 0);
  assert.equal(h.rec.exitCount(), 1);
});

test('end({hard}) during a turn closes its open items; kill() reports at once', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'x', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('item/started', { threadId: 'th-1', turnId: 'u1', item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'sleep 30'", cwd: '/w', status: 'inProgress', commandActions: [] } });
  await waitFor(() => h.rec.itemIds().includes('exec-1'));
  await h.session.end({ hard: true });
  assert.deepEqual(h.rec.toolResults(), [['exec-1', false, 'Interrupted']]);
  assert.equal(h.rec.exitCount(), 1);

  const k = await open();
  await started(k);
  k.session.kill();
  assert.equal(k.rec.exitCount(), 1);
  await k.conn.closed;
  assert.equal(k.rec.exitCount(), 1);
});

test('a process that dies ends the session with the error, closing the turn', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'x', images: [] });
  await turnStarts(h, 'u1');
  h.conn.exit(9);
  const e = await h.rec.exited;
  assert.match(e!.message, /code 9/);
  assert.ok(h.norm.calls.some((c) => c.method === 'closeOpen'));
  await assert.rejects(h.session.interrupt(), /already exited/);
});

test('notLoaded for our live thread ends the session, but not during our own resume', async () => {
  const h = await open({ resume: true, sessionId: 'th-1' });
  const req = await h.conn.request('thread/resume');
  // Our resume causes notLoaded then idle by itself.
  h.conn.notify('thread/status/changed', { threadId: 'th-1', status: { type: 'notLoaded' } });
  h.conn.notify('thread/status/changed', { threadId: 'th-1', status: { type: 'idle' } });
  await sleep(30);
  h.conn.respond(req.id, threadResult('th-1'));
  await waitFor(() => h.rec.kinds().includes('session'));
  assert.equal(h.rec.exitCount(), 0);
  // Later, another client's request unloads it.
  h.conn.notify('thread/status/changed', { threadId: 'th-1', status: { type: 'notLoaded' } });
  assert.equal(await h.rec.exited, undefined);
  await h.conn.closed;
});

// ---- Threads that aren't ours

test('subagents: traffic is marked with the child id, approvals reach this sink with no itemId', async () => {
  const h = await open({ permissionMode: 'ask' });
  await started(h);
  h.session.send({ id: 'm1', text: 'spawn one', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('item/started', { threadId: 'th-1', turnId: 'u1', item: { type: 'subAgentActivity', id: 'sa-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/image_color' } });
  h.conn.notify('turn/started', { threadId: 'child-1', turn: { id: 'cu1', rootTurnId: 'u1', status: 'inProgress' } });
  h.conn.notify('item/started', { threadId: 'child-1', turnId: 'cu1', item: { type: 'imageView', id: 'exec-v', path: '/w/swatch.png' } });
  h.conn.notify('item/completed', { threadId: 'child-1', turnId: 'cu1', item: { type: 'imageView', id: 'exec-v', path: '/w/swatch.png' } });
  await waitFor(() => h.rec.itemIds().includes('child-1/exec-v'));
  const childCalls = h.norm.calls.filter((c) => c.from);
  assert.deepEqual(childCalls.map((c) => [c.method, c.from!.childThreadId]), [['turn/started', 'child-1'], ['item/started', 'child-1'], ['item/completed', 'child-1']]);
  assert.equal(h.rec.kinds().includes('cliTurn'), false, "a child's turn is never a cliTurn");
  assert.equal(h.rec.results().length, 0, "a child's result never reaches the runner");
  // The child's approval: request id 0, threadId the child's.
  const answer = h.conn.serverRequest('item/commandExecution/requestApproval', {
    kind: 'command', threadId: 'child-1', turnId: 'cu1', itemId: 'exec-61fe', reason: 'spike test file', command: "/bin/zsh -lc 'touch seen.txt'",
    proposedExecpolicyAmendment: ['touch', 'seen.txt'], availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'seen.txt'] } }, 'cancel'],
  });
  assert.deepEqual((await answer).result, { decision: 'accept' });
  assert.equal(h.rec.approvals[0].toolUseId, undefined);
  assert.equal(h.rec.approvals[0].title, 'touch seen.txt');
  // A parent approval points at its item.
  const own = h.conn.serverRequest('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'u1', itemId: 'fc-1', reason: null, grantRoot: null });
  await own;
  assert.equal(h.rec.approvals[1].toolUseId, 'fc-1');
  await h.session.end();
});

test("a file change that renames a file into .threadbear/patches asks, past the thread's file-change rule, with no Always allow", async () => {
  const h = await open({ permissionMode: 'ask', allowRules: [FILE_CHANGE_RULE] });
  await started(h);
  h.session.send({ id: 'm1', text: 'tidy up', images: [] });
  await turnStarts(h, 'u1');
  const cwd = h.opts.cwd;
  const change = { path: path.join(cwd, 'notes.ts'), kind: { type: 'update', move_path: path.join(cwd, '.threadbear', 'patches', 'notes.ts') }, diff: '' };
  h.conn.notify('item/started', { threadId: 'th-1', turnId: 'u1', item: { type: 'fileChange', id: 'fc-m', changes: [change], status: 'inProgress' } });
  await sleep(30);
  const asked = h.conn.serverRequest('item/fileChange/requestApproval', { threadId: 'th-1', turnId: 'u1', itemId: 'fc-m', reason: null, grantRoot: null });
  await waitFor(() => h.rec.approvals.length === 1);
  assert.equal(h.rec.approvals[0].canAlwaysAllow, false);
  assert.match(h.rec.approvals[0].title, /Threadbear runs this file as code/);
  await asked;
  await h.session.end();
});

test('a child whose spawn was missed is found by rootTurnId, or by thread/read', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'x', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('turn/started', { threadId: 'child-a', turn: { id: 'ca', rootTurnId: 'u1', status: 'inProgress' } });
  await waitFor(() => h.norm.calls.some((c) => c.from?.childThreadId === 'child-a'));
  // Nothing to go on but the id: ask Codex.
  h.conn.notify('item/completed', { threadId: 'child-b', turnId: 'cb', item: { type: 'imageView', id: 'v1', path: '/a.png' } });
  h.conn.notify('item/completed', { threadId: 'child-b', turnId: 'cb', item: { type: 'imageView', id: 'v2', path: '/b.png' } });
  const read = await h.conn.request('thread/read');
  assert.deepEqual(read.params, { threadId: 'child-b' });
  h.conn.respond(read.id, { thread: { id: 'child-b', parentThreadId: 'th-1' } });
  await waitFor(() => h.norm.calls.filter((c) => c.from?.childThreadId === 'child-b').length === 2);
  // And a stranger is dropped.
  h.conn.notify('item/completed', { threadId: 'other', turnId: 'x', item: { type: 'imageView', id: 'v3', path: '/c.png' } });
  const r2 = await h.conn.request('thread/read');
  h.conn.respond(r2.id, { thread: { id: 'other', parentThreadId: 'someone-else' } });
  await sleep(30);
  assert.equal(h.norm.calls.some((c) => c.from?.childThreadId === 'other'), false);
  await h.session.end();
  // archive() then archives the children this runner saw, after the parent.
  const archiving = h.adapter.archive(account, 'th-1');
  const conn = await h.f.next();
  await conn.init();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const req = await conn.request('thread/archive');
    ids.push(req.params.threadId as string);
    conn.respond(req.id, {});
  }
  await archiving;
  assert.deepEqual(ids, ['th-1', 'child-a', 'child-b']);
});

test('notifications with no thread id belong to the session; configWarning is a runner notice once', async () => {
  const notices: string[] = [];
  const h = await open({ deps: { onNotice: (t) => notices.push(t) } });
  // The start-up read is answered by hand, after a newer update (the order
  // that used to let the older reading win).
  const readAnswer = h.conn.auto.get('account/rateLimits/read')!;
  h.conn.auto.delete('account/rateLimits/read');
  h.conn.notify('configWarning', { summary: 'bad key in config.toml', details: 'line 3' });
  await started(h);
  const read = await h.conn.request('account/rateLimits/read');
  h.conn.notify('warning', { threadId: null, message: 'something' });
  h.conn.notify('deprecationNotice', { summary: 'old thing', details: null });
  h.conn.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1 }, secondary: null } });
  await waitFor(() => h.norm.calls.filter((c) => c.method === 'account/rateLimits/updated').length === 1);
  h.conn.respond(read.id, readAnswer(read.params, read));
  await waitFor(() => h.norm.calls.filter((c) => c.method === 'account/rateLimits/updated').length === 2);
  const methods = h.norm.calls.map((c) => c.method);
  for (const m of ['configWarning', 'warning', 'deprecationNotice']) assert.ok(methods.includes(m), m);
  const last = h.norm.calls.filter((c) => c.method === 'account/rateLimits/updated').at(-1)!.params as { rateLimits: { primary: { usedPercent: number } }; ordinaryUsageAllowed: boolean };
  assert.equal(last.rateLimits.primary.usedPercent, 9);
  assert.deepEqual(notices, ['Codex config: bad key in config.toml: line 3']);
  await h.session.end();
  // The same warning from another session isn't noticed again.
  const again = await open({ adapter: h.adapter });
  again.conn.notify('configWarning', { summary: 'bad key in config.toml', details: 'line 3' });
  await started(again);
  await again.session.end();
  assert.equal(notices.length, 1);
});

test('a line over the guard reaches the normaliser as an oversized item, and the turn goes on', async () => {
  const h = await open({ deps: { maxLineBytes: 300_000 } });
  await started(h);
  h.session.send({ id: 'm1', text: 'draw', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('item/completed', { item: { type: 'imageGeneration', id: 'ig_1', result: 'Q'.repeat(400_000) }, threadId: 'th-1', turnId: 'u1' });
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  const big = h.norm.calls.find((c) => c.method === OVERSIZED_LINE)!.params as Record<string, unknown>;
  assert.equal(big.itemId, 'ig_1');
  assert.equal(big.method, 'item/completed');
  assert.equal(h.rec.results()[0].outcome, 'completed');
  await h.session.end();
});

// ---- Settings

test('folder, model, effort and mode changes go on the next turn/start', async () => {
  const h = await open({ effort: 'low' });
  await started(h);
  h.session.send({ id: 'm1', text: 'a', images: [] });
  let req = await turnStarts(h, 'u1');
  assert.equal(req.params.effort, 'low');
  assert.equal(req.params.model, undefined);
  const other = tmp('tb-cxa-moved-');
  await h.session.setCwd!(other);
  await h.session.setModel('gpt-6-luna');
  await h.session.setPermissionMode('ask');
  await h.session.setEffort(undefined);
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  h.session.send({ id: 'm2', text: 'b', images: [] });
  req = await turnStarts(h, 'u2');
  assert.equal(req.params.cwd, other);
  assert.equal(req.params.model, 'gpt-6-luna');
  assert.equal(req.params.effort, 'medium', "back to the model's own level");
  assert.equal(req.params.approvalPolicy, 'on-request');
  complete(h, 'u2');
  await waitFor(() => h.rec.results().length === 2);
  h.session.send({ id: 'm3', text: 'c', images: [] });
  req = await turnStarts(h, 'u3');
  assert.equal(req.params.cwd, undefined, 'the folder only goes once');
  await h.session.end();
});

test('Plan first: plan mode goes on turn/start as the plan collaboration mode, and default goes once after', async () => {
  const h = await open({ permissionMode: 'plan' });
  await started(h);
  h.session.send({ id: 'm1', text: 'a', images: [] });
  let req = await turnStarts(h, 'u1');
  assert.equal(req.params.approvalPolicy, 'on-request');
  assert.deepEqual(req.params.collaborationMode, { mode: 'plan', settings: { model: 'gpt-6-luna', reasoning_effort: null, developer_instructions: null } });
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  await h.session.setPermissionMode('full');
  h.session.send({ id: 'm2', text: 'Go ahead with the plan.', images: [] });
  req = await turnStarts(h, 'u2');
  assert.equal((req.params.collaborationMode as { mode: string }).mode, 'default');
  assert.equal(req.params.approvalPolicy, 'never');
  complete(h, 'u2');
  await waitFor(() => h.rec.results().length === 2);
  h.session.send({ id: 'm3', text: 'c', images: [] });
  req = await turnStarts(h, 'u3');
  assert.equal(req.params.collaborationMode, undefined, 'only sent while it matters');
  await h.session.end();
});

// ---- Tools

test('threadbear tools: a known one runs, an unknown one says so, delete_thread asks first', async () => {
  const calls: string[] = [];
  const list = tool('list_threads', 'List threads.', { query: z.string().optional() }, async ({ query }) => {
    calls.push(`list ${query ?? ''}`);
    return { content: [{ type: 'text', text: 'thread a\nthread b' }] };
  });
  const del = tool('delete_thread', 'Delete a thread.', { threadId: z.string() }, async ({ threadId }) => {
    calls.push(`delete ${threadId}`);
    return { content: [{ type: 'text', text: 'Deleted.' }] };
  });
  const h = await open({ deps: { toolsFor: () => [list, del] } });
  await started(h);
  h.session.send({ id: 'm1', text: 'x', images: [] });
  await turnStarts(h, 'u1');
  const ok = await h.conn.serverRequest('item/tool/call', { threadId: 'th-1', turnId: 'u1', callId: 'exec-1', namespace: 'threadbear', tool: 'list_threads', arguments: { query: 'fix' } });
  assert.deepEqual(ok.result, { contentItems: [{ type: 'inputText', text: 'thread a\nthread b' }], success: true });
  const gone = await h.conn.serverRequest('item/tool/call', { threadId: 'th-1', turnId: 'u1', callId: 'exec-2', namespace: 'threadbear', tool: 'old_tool', arguments: {} });
  assert.equal((gone.result as { success: boolean }).success, false);
  assert.match((gone.result as { contentItems: { text: string }[] }).contentItems[0].text, /no tool called threadbear\.old_tool/);
  const badArgs = await h.conn.serverRequest('item/tool/call', { threadId: 'th-1', turnId: 'u1', callId: 'exec-3', namespace: 'threadbear', tool: 'delete_thread', arguments: {} });
  assert.equal((badArgs.result as { success: boolean }).success, false);
  h.rec.state.approve = async () => ({ decision: 'deny' });
  const denied = await h.conn.serverRequest('item/tool/call', { threadId: 'th-1', turnId: 'u1', callId: 'exec-4', namespace: 'threadbear', tool: 'delete_thread', arguments: { threadId: 'abc' } });
  assert.equal((denied.result as { success: boolean }).success, false);
  assert.equal(h.rec.approvals.at(-1)!.name, 'mcp__threadbear__delete_thread');
  assert.equal(h.rec.approvals.at(-1)!.canAlwaysAllow, false);
  assert.equal(h.rec.approvals.at(-1)!.toolUseId, 'exec-4');
  h.rec.state.approve = async () => ({ decision: 'allow' });
  const allowed = await h.conn.serverRequest('item/tool/call', { threadId: 'th-1', turnId: 'u1', callId: 'exec-5', namespace: 'threadbear', tool: 'delete_thread', arguments: { threadId: 'abc' } });
  assert.equal((allowed.result as { success: boolean }).success, true);
  assert.deepEqual(calls, ['list fix', 'delete abc']);
  // Anything Codex asks that we don't handle gets -32601 straight away.
  const unknown = await h.conn.serverRequest('account/chatgptAuthTokens/refresh', {});
  assert.equal((unknown.error as { code: number }).code, -32601);
  const time = await h.conn.serverRequest('currentTime/read', {});
  assert.ok(Math.abs((time.result as { currentTimeAt: number }).currentTimeAt - Date.now() / 1000) < 5);
  await h.session.end();
});

// ---- Short-lived processes

test('models() asks a short-lived process for model/list without hidden models', async () => {
  const f = await fake();
  const adapter = new CodexAdapter({ codexBinary: () => f.bin, registry: new ProcessRegistry(tmp(), nullLogger), log: nullLogger, normalizer: spyNormalizer().factory });
  const p = adapter.models(account);
  const conn = await f.next();
  await conn.init();
  assert.deepEqual(adapter.binariesInUse(), [f.bin], 'the short-lived process counts as in use');
  const req = await conn.request('model/list');
  assert.deepEqual(req.params, { includeHidden: false });
  conn.respond(req.id, {
    data: [
      { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Best', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'ultra', description: '' }, { reasoningEffort: 'minimal', description: '' }] },
    ],
    nextCursor: 'page2',
  });
  const req2 = await conn.request('model/list');
  assert.deepEqual(req2.params, { includeHidden: false, cursor: 'page2' });
  conn.respond(req2.id, { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast and affordable', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'max', description: '' }] }], nextCursor: null });
  const models = await p;
  assert.deepEqual(models, [
    { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', title: 'GPT-6.1-Sol', description: 'Best', effortLevels: ['low', 'ultra'], defaultEffort: 'low' },
    { id: 'gpt-6-luna', model: 'gpt-6-luna', title: 'GPT-6-Luna', description: 'Fast and affordable', effortLevels: ['max'], defaultEffort: 'medium' },
  ]);
  await conn.closed;
  assert.deepEqual(adapter.binariesInUse(), []);
  assert.deepEqual(codexModelChoices([{ id: 'gpt-reserve', hidden: true }, null, { id: '' }]), []);
});

test('archive() archives in a short-lived process and closes it', async () => {
  const f = await fake();
  const adapter = new CodexAdapter({ codexBinary: () => f.bin, registry: new ProcessRegistry(tmp(), nullLogger), log: nullLogger, normalizer: spyNormalizer().factory });
  const p = adapter.archive(account, 'th-9');
  const conn = await f.next();
  await conn.init();
  assert.equal(conn.hello.env.CODEX_HOME, '/work/codex-home');
  const req = await conn.request('thread/archive');
  assert.deepEqual(req.params, { threadId: 'th-9' });
  conn.respond(req.id, {});
  await p;
  await conn.closed;
  // A failure reaches the caller (the runner logs it).
  const q = adapter.archive(account, 'th-x');
  const c2 = await f.next();
  await c2.init();
  c2.fail((await c2.request('thread/archive')).id, -32600, 'no rollout found for thread id th-x');
  await assert.rejects(q, /no rollout found/);
});

test('binariesInUse lists live sessions until they end', async () => {
  const h = await open();
  await started(h);
  assert.deepEqual(h.adapter.binariesInUse(), [h.f.bin]);
  assert.equal(h.adapter.movesFolders, true);
  assert.equal(h.adapter.settingsApplyNextTurn, true);
  assert.equal(h.adapter.wakesAfterTasks, false);
  await h.session.end();
  assert.deepEqual(h.adapter.binariesInUse(), []);
});

test('built as the runner builds it (no normaliser given), a turn runs on section B\'s normaliser', async () => {
  const f = await fake();
  const adapter = new CodexAdapter({ codexBinary: () => f.bin, codexArgs: ['--disable', 'memories'], registry: new ProcessRegistry(tmp(), nullLogger), log: nullLogger, toolsFor: () => [] });
  const h = await open({ adapter });
  assert.deepEqual(h.conn.hello.argv, ['app-server', '--disable', 'memories']);
  await started(h);
  h.session.send({ id: 'm1', text: 'hi', images: [] });
  await turnStarts(h, 'u1');
  h.conn.notify('item/agentMessage/delta', { threadId: 'th-1', turnId: 'u1', itemId: 'msg-1', delta: 'hel' });
  h.conn.notify('item/completed', { threadId: 'th-1', turnId: 'u1', item: { type: 'agentMessage', id: 'msg-1', text: 'hello', phase: 'final_answer' } });
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  assert.ok(h.rec.outputs.some((o) => o.kind === 'event' && o.event.type === 'assistant.text'));
  assert.deepEqual(h.rec.results()[0], { outcome: 'completed', durationMs: 1200, answers: 'm1', answered: ['m1'], queuedTurns: 0 });
  assert.equal(h.rec.kinds().includes('cliTurn'), false);
  await h.session.end();
});

test('in ask mode every threadbear tool that changes something asks first; read-only ones run', async () => {
  const ran: string[] = [];
  const mk = (name: string, readOnly = false) =>
    tool(name, `${name}.`, { threadId: z.string().optional(), permissionMode: z.string().optional() }, async () => {
      ran.push(name);
      return { content: [{ type: 'text', text: 'ok' }] };
    }, readOnly ? { annotations: { readOnlyHint: true } } : undefined);
  const tools = [mk('list_threads'), mk('read_thread', true), mk('update_thread'), mk('create_thread'), mk('send_message'), mk('move_thread'), mk('schedule_message'), mk('update_schedule'), mk('interrupt_thread'), mk('delete_thread')];
  const h = await open({ permissionMode: 'ask', deps: { toolsFor: () => tools } });
  await started(h);
  h.session.send({ id: 'm1', text: 'x', images: [] });
  await turnStarts(h, 'u1');
  const call = (tool: string, args: Record<string, unknown> = {}, id = tool) =>
    h.conn.serverRequest('item/tool/call', { threadId: 'th-1', turnId: 'u1', callId: `exec-${id}`, namespace: 'threadbear', tool, arguments: args });
  const ok = (r: Record<string, unknown>) => (r.result as { success: boolean }).success;
  // Read-only: no card.
  assert.equal(ok(await call('list_threads')), true);
  assert.equal(ok(await call('read_thread')), true);
  assert.equal(h.rec.approvals.length, 0);
  // An ask-mode thread can't give itself full access without Mike.
  h.rec.state.approve = async () => ({ decision: 'deny' });
  assert.equal(ok(await call('update_thread', { permissionMode: 'full' })), false);
  assert.equal(h.rec.approvals.at(-1)!.name, 'mcp__threadbear__update_thread');
  assert.equal(h.rec.approvals.at(-1)!.canAlwaysAllow, true);
  for (const t of ['create_thread', 'send_message', 'move_thread', 'schedule_message', 'update_schedule', 'interrupt_thread']) {
    assert.equal(ok(await call(t)), false, t);
    assert.equal(h.rec.approvals.at(-1)!.name, `mcp__threadbear__${t}`);
  }
  assert.deepEqual(ran, ['list_threads', 'read_thread'], 'nothing that changes something ran');
  // "Always allow" for one tool keeps a rule, and it isn't asked again.
  h.rec.state.approve = async () => ({ decision: 'allowAlways' });
  assert.equal(ok(await call('send_message', {}, 'a')), true);
  assert.ok(h.rec.outputs.some((o) => o.kind === 'allowRules' && o.rules.includes('mcp__threadbear__send_message')));
  const asked = h.rec.approvals.length;
  assert.equal(ok(await call('send_message', {}, 'b')), true);
  assert.equal(h.rec.approvals.length, asked);
  // The mode now, not the turn's: switched to full, nothing asks but delete.
  await h.session.setPermissionMode('full');
  h.rec.state.approve = async () => ({ decision: 'deny' });
  assert.equal(ok(await call('update_thread', {}, 'c')), true);
  assert.equal(h.rec.approvals.length, asked);
  assert.equal(ok(await call('delete_thread', { threadId: 'x' })), false);
  assert.equal(h.rec.approvals.at(-1)!.canAlwaysAllow, false);
  await h.session.end();
});

test('a message sent while the turn is ending waits for the next turn, even when a late steer is refused', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'start', images: [] });
  await turnStarts(h, 'u1');
  h.session.send({ id: 'm2', text: 'steer me', images: [] });
  const steer = await h.conn.request('turn/steer');
  // The turn completes while m2's steer is still unanswered...
  complete(h, 'u1');
  await waitFor(() => h.norm.calls.some((c) => c.method === 'turn/completed'));
  // ...and m3 arrives while the end waits on it: it mustn't steer.
  h.session.send({ id: 'm3', text: 'late', images: [] });
  await sleep(30);
  assert.equal(h.conn.sent('turn/steer').length, 1);
  h.conn.fail(steer.id, -32600, 'no active turn to steer');
  await waitFor(() => h.rec.results().length === 1);
  assert.deepEqual(h.rec.results()[0], { outcome: 'completed', durationMs: 1200, answers: 'm1', answered: ['m1'], queuedTurns: 2 });
  // Both start the next turn: m2 by turn/start, m3 steered into it.
  const next = await h.conn.request('turn/start');
  assert.equal(next.params.clientUserMessageId, 'm2');
  h.conn.respond(next.id, { turn: { id: 'u2', status: 'inProgress' } });
  const s3 = await h.conn.request('turn/steer');
  assert.equal(s3.params.clientUserMessageId, 'm3');
  h.conn.respond(s3.id, { turnId: 'u2' });
  await sleep(10);
  complete(h, 'u2');
  await waitFor(() => h.rec.results().length === 2);
  assert.deepEqual(h.rec.results()[1], { outcome: 'completed', durationMs: 1200, answers: 'm2', answered: ['m2', 'm3'], queuedTurns: 0 });
  await h.session.end();
});

test('a steer refused after its turn has ended still starts a turn', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: 'start', images: [] });
  await turnStarts(h, 'u1');
  // Reach into the race directly: a held message while idle must go out.
  (h.session as unknown as { held: unknown[] }).held.push({ id: 'm9', text: 'stranded', images: [] });
  complete(h, 'u1');
  const next = await h.conn.request('turn/start');
  assert.equal(next.params.clientUserMessageId, 'm9');
  await h.session.end();
});

test('end() while the process is still being retried leaves nothing running', async () => {
  const f = await fake();
  const rec = recorder();
  const home = tmp();
  const adapter = new CodexAdapter({
    codexBinary: () => f.bin,
    registry: new ProcessRegistry(home, nullLogger),
    log: nullLogger,
    timings: { spawnRetryMs: 300, spawnRetryForMs: PATIENCE_MS, closeWaitMs: 2000 },
  });
  const session = adapter.start(
    { threadId: 'tb-r', cwd: home, account, permissionMode: 'full', sessionId: 'x', resume: false, mediaDir: home, blobsDir: home, tmpDir: home },
    rec.sink,
  ) as CodexSession;
  const first = await f.next();
  await first.request('initialize');
  first.exit(1);
  await first.closed;
  await session.end();
  assert.equal(rec.exitCount(), 1);
  await assert.rejects(f.next(800), /no process started/);
  assert.deepEqual(adapter.binariesInUse(), []);
});

test('auto on Codex is as careful as ask, as Codex has no classifier', async () => {
  const h = await open({ permissionMode: 'auto' });
  const req = await h.conn.request('thread/start');
  assert.equal(req.params.approvalPolicy, 'on-request');
  assert.equal(req.params.sandbox, 'read-only');
  h.conn.respond(req.id, threadResult('th-1'));
});

// Slash commands (docs/protocol.md, "Slash commands"): the ones Codex's
// terminal app runs become the app-server calls that do them.
test('/compact is thread/compact/start, and its turn (id from turn/started) answers the message', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: '/compact', images: [] });
  const req = await h.conn.request('thread/compact/start');
  assert.deepEqual(req.params, { threadId: 'th-1' });
  // Codex answers first, with no turn, then starts one.
  h.conn.respond(req.id, {});
  await sleep(20);
  h.conn.notify('turn/started', { threadId: 'th-1', turn: { id: 'c1', rootTurnId: 'c1', status: 'inProgress' } });
  await sleep(20);
  complete(h, 'c1');
  await waitFor(() => h.rec.results().length === 1);
  assert.equal(h.rec.kinds().includes('cliTurn'), false);
  assert.equal(h.rec.results()[0].answers, 'm1');
  await h.session.end();
});

test('/review is review/start: the uncommitted changes, or what it says', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: '/review', images: [] });
  let req = await h.conn.request('review/start');
  assert.deepEqual(req.params, { threadId: 'th-1', target: { type: 'uncommittedChanges' }, delivery: 'inline' });
  h.conn.respond(req.id, { turn: { id: 'r1', status: 'inProgress' }, reviewThreadId: 'th-1' });
  h.conn.notify('turn/started', { threadId: 'th-1', turn: { id: 'r1', rootTurnId: 'r1', status: 'inProgress' } });
  complete(h, 'r1');
  await waitFor(() => h.rec.results().length === 1);
  h.session.send({ id: 'm2', text: '/review the auth change', images: [] });
  req = await h.conn.request('review/start');
  assert.deepEqual(req.params.target, { type: 'custom', instructions: 'the auth change' });
  await h.session.end();
});

test('/<skill> adds the skill to the turn; other commands and paths go as words', async () => {
  const h = await open();
  await started(h);
  h.session.send({ id: 'm1', text: '/deslop the runner', images: [] });
  const sk = await h.conn.request('skills/list');
  h.conn.respond(sk.id, { data: [{ cwd: h.home, skills: [{ name: 'deslop', description: 'd', path: '/s/deslop/SKILL.md', enabled: true }] }] });
  const req = await turnStarts(h, 'u1');
  assert.deepEqual(req.params.input, [
    { type: 'skill', name: 'deslop', path: '/s/deslop/SKILL.md' },
    { type: 'text', text: '/deslop the runner', text_elements: [] },
  ]);
  complete(h, 'u1');
  await waitFor(() => h.rec.results().length === 1);
  h.session.send({ id: 'm2', text: '/Users/mike/x.md looks off', images: [] });
  const words = await h.conn.request('turn/start');
  assert.deepEqual(words.params.input, [{ type: 'text', text: '/Users/mike/x.md looks off', text_elements: [] }]);
  await h.session.end();
});

test('a folder move waits past /compact for the next turn/start, and a Stop during a compaction goes once its turn starts', async () => {
  const h = await open();
  await started(h);
  const other = tmp('tb-cxa-moved-');
  await h.session.setCwd!(other);
  h.session.send({ id: 'm1', text: '/compact', images: [] });
  const req = await h.conn.request('thread/compact/start');
  h.conn.respond(req.id, {});
  await sleep(20);
  const stopping = h.session.interrupt();
  await sleep(20);
  assert.equal(h.conn.sent('turn/interrupt').length, 0, 'no turn id yet');
  h.conn.notify('turn/started', { threadId: 'th-1', turn: { id: 'c1', rootTurnId: 'c1', status: 'inProgress' } });
  const intr = await h.conn.request('turn/interrupt');
  assert.equal(intr.params.turnId, 'c1');
  h.conn.respond(intr.id, {});
  complete(h, 'c1', 'interrupted');
  await stopping;
  await waitFor(() => h.rec.results().length === 1);
  h.session.send({ id: 'm2', text: 'b', images: [] });
  const next = await turnStarts(h, 'u2');
  assert.equal(next.params.cwd, other);
  await h.session.end();
});

test('/review with a folder move still to send is a turn, which carries the move', async () => {
  const h = await open();
  await started(h);
  const other = tmp('tb-cxa-moved-');
  await h.session.setCwd!(other);
  h.session.send({ id: 'm1', text: '/review', images: [] });
  const req = await turnStarts(h, 'u1');
  assert.equal(req.params.cwd, other);
  assert.equal(h.conn.sent('review/start').length, 0);
  await h.session.end();
});
