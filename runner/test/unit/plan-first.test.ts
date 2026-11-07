// "Plan first" (docs/protocol.md): a plan card Mike approves or sends back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { RpcError } from '../../src/protocol.ts';
import { PLAN_GO_AHEAD } from '../../src/runner/approvals.ts';
import { WROTE_INSTEAD } from '../../src/runner.ts';

function planThread(h: ReturnType<typeof makeHarness>, from: 'full' | 'ask' = 'full') {
  const { thread } = h.runner.create({ text: 'Add CSV export', accountId: 'claude-3', permissionMode: from });
  h.runner.update({ threadId: thread.id, permissionMode: 'plan' });
  const s = h.adapter.last;
  s.init();
  return { id: thread.id, s };
}

// Claude's part: the plan, then its ExitPlanMode call waiting on an approval.
function propose(s: ReturnType<typeof planThread>['s'], itemId = 'tu-plan') {
  s.out({ kind: 'planProposed', itemId, text: '1. Add toCsv\n2. Add a button' });
  return s.sink.requestApproval({ toolUseId: itemId, name: 'ExitPlanMode', title: 'Finish the plan', input: { plan: '...' }, canAlwaysAllow: false, signal: new AbortController().signal });
}

test('choosing Plan first remembers the mode to go back to', () => {
  const h = makeHarness();
  const { id, s } = planThread(h, 'ask');
  assert.equal(h.runner.get(id).permissionMode, 'plan');
  assert.deepEqual(s.modes, ['plan']);
});

test('Go ahead allows the ExitPlanMode call and leaves plan mode for the earlier mode', async () => {
  const h = makeHarness();
  const { id, s } = planThread(h, 'ask');
  const answer = propose(s);
  const proposed = h.events(id).find((e) => e.type === 'plan.proposed');
  assert.equal(proposed.itemId, 'tu-plan');
  assert.match(proposed.text, /toCsv/);
  assert.equal(h.runner.get(id).needsYou, true);
  h.runner.approvePlan({ threadId: id, itemId: 'tu-plan' });
  assert.deepEqual(await answer, { decision: 'allow', message: undefined, mode: 'ask' });
  const types = h.events(id).map((e) => e.type);
  assert.ok(types.indexOf('plan.resolved') > types.indexOf('approval.resolved'));
  assert.equal(h.events(id).find((e) => e.type === 'plan.resolved').decision, 'go');
  assert.equal(h.runner.get(id).permissionMode, 'ask');
  // The CLI switches through the approval's answer, not a second call.
  assert.deepEqual(s.modes, ['plan']);
  assert.throws(() => h.runner.approvePlan({ threadId: id, itemId: 'tu-plan' }), RpcError);
});

test('allowing the plan from any card (Return, the phone) goes ahead too, to full by default', async () => {
  const h = makeHarness();
  const { id, s } = planThread(h);
  const answer = propose(s);
  const req = h.events(id).find((e) => e.type === 'approval.requested');
  assert.deepEqual(req.options, ['allow', 'deny']);
  h.runner.respondApproval({ threadId: id, approvalId: req.approvalId, decision: 'allow' });
  assert.equal((await answer).mode, 'full');
  assert.equal(h.runner.get(id).permissionMode, 'full');
});

test('writing instead of approving sends the plan back and stays in plan mode', async () => {
  const h = makeHarness();
  const { id, s } = planThread(h);
  const answer = propose(s);
  h.runner.send(id, 'Use the existing export helper instead');
  assert.deepEqual(await answer, { decision: 'deny', message: WROTE_INSTEAD });
  assert.deepEqual(h.events(id).filter((e) => e.type === 'plan.resolved').map((e) => e.decision), ['revise']);
  assert.equal(h.runner.get(id).permissionMode, 'plan');
  assert.throws(() => h.runner.approvePlan({ threadId: id, itemId: 'tu-plan' }), /no longer waiting/);
});

test("a plan with no call waiting (Codex's, or after a restart) goes ahead in words", async () => {
  const h = makeHarness();
  const { id, s } = planThread(h);
  s.out({ kind: 'planProposed', itemId: 'item-7', text: 'Step one' });
  s.result();
  await tick();
  h.runner.approvePlan({ threadId: id, itemId: 'item-7' });
  await tick();
  assert.equal(h.runner.get(id).permissionMode, 'full');
  assert.deepEqual(s.modes, ['plan', 'full']);
  const sent = h.events(id).filter((e) => e.type === 'user.message').at(-1);
  assert.equal(sent.text, PLAN_GO_AHEAD);
  // Its own Go ahead isn't read as sending the plan back.
  assert.deepEqual(h.events(id).filter((e) => e.type === 'plan.resolved').map((e) => e.decision), ['go']);
});

test('a message to a waiting Codex plan sends it back; a newer plan replaces an older one', async () => {
  const h = makeHarness();
  const { id, s } = planThread(h);
  s.out({ kind: 'planProposed', itemId: 'a', text: 'One' });
  s.out({ kind: 'planProposed', itemId: 'b', text: 'Two' });
  s.result();
  await tick();
  h.runner.send(id, 'Smaller steps please');
  assert.deepEqual(
    h.events(id).filter((e) => e.type === 'plan.resolved').map((e) => [e.itemId, e.decision]),
    [['a', 'revise'], ['b', 'revise']],
  );
  assert.equal(h.runner.get(id).permissionMode, 'plan');
});
