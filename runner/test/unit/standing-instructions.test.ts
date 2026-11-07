// Mike's standing instructions (instructions.ts): a fresh session gets them
// with its instructions; a live or resumed one hears a change once, before
// his next message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';

test('standing instructions reach a fresh session, and each change reaches a live one once', async () => {
  let standing = 'You are a world-class copywriter.';
  const cwd = tmpDir();
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Write a tagline', cwd, accountId: 'claude-3' });
  await tick();
  assert.match(h.adapter.last.opts.instructions ?? '', /standing instructions \(set in Threadbear, Settings > General[\s\S]*world-class copywriter/);
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'Write a tagline');
  const finish = async () => {
    h.adapter.last.init();
    h.adapter.last.result('completed');
    await tick();
  };
  await finish();
  // Unchanged: nothing before the next message.
  h.runner.send(thread.id, 'another');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'another');
  await finish();
  // Changed while it's live: said once, before the next message.
  standing = 'Be brief.';
  h.runner.send(thread.id, 'and now');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user's standing instructions have changed[\s\S]*Be brief\.\n\nand now$/);
  await finish();
  h.runner.send(thread.id, 'again');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'again');
  await finish();
  // Cleared: said once too.
  standing = '';
  h.runner.send(thread.id, 'last');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user cleared their standing instructions[\s\S]*\n\nlast$/);
});

test('with none set, sessions get nothing extra', async () => {
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => '  ' });
  h.runner.create({ text: 'Hi', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  assert.equal(h.adapter.last.opts.instructions, undefined);
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'Hi');
});

test("a change says so in the transcript, and a session with none writes nothing on the thread's record", async () => {
  let standing = '';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Hi', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  const finish = async () => {
    h.adapter.last.init();
    h.adapter.last.result('completed');
    await tick();
  };
  await finish();
  h.runner.send(thread.id, 'again');
  await tick();
  await finish();
  assert.equal(h.store.load(thread.id)?.instructionsTold, undefined);
  assert.equal(h.events(thread.id).filter((e: { text?: string }) => /standing instructions/.test(e.text ?? '')).length, 0);
  standing = 'Be brief.';
  h.runner.send(thread.id, 'now');
  await tick();
  assert.equal(h.events(thread.id).filter((e: { type: string; text?: string }) => e.type === 'system.note' && /standing instructions/.test(e.text ?? '')).length, 1);
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user's standing instructions\.\n\n[\s\S]*Be brief\.\n\nnow$/);
});

test('a command keeps the news for the next message', async () => {
  let standing = '';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Hi', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  standing = 'Be brief.';
  h.runner.send(thread.id, '/compact');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, '/compact');
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  h.runner.send(thread.id, 'next');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /Be brief\.\n\nnext$/);
});

// What the review by another lab found (7 Nov): three ways a session could keep
// instructions it should have been told about.
test('a change reaches a message sent into a running turn', async () => {
  let standing = 'Be brief.';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  h.adapter.last.init();
  standing = '';
  h.runner.send(thread.id, 'one more thing');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user cleared their standing instructions[\s\S]*one more thing$/);
});

test("a send that fails doesn't use up the news", async () => {
  let standing = 'Be brief.';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  standing = '';
  const session = h.adapter.last;
  const send = session.send.bind(session);
  session.send = () => {
    throw new Error('a picture went missing');
  };
  const st = h.runner.threads.get(thread.id)!;
  assert.throws(() => h.runner.sendWithInstructionsNews(st, { id: 'x', text: 'lost', images: [] }), /picture/);
  assert.notEqual(st.rec.instructionsTold, 'cleared');
  assert.equal(h.events(thread.id).filter((e: { text?: string }) => /standing instructions/.test(e.text ?? '')).length, 0);
  session.send = send;
  h.runner.send(thread.id, 'again');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user cleared their standing instructions/);
});

test('going back past a clear says it again, and a session that never had any hears nothing', async () => {
  const run = async (first: string) => {
    let standing = first;
    const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
    h.adapter.rewind = async () => ({ resumeAt: 'entry-1' });
    const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
    await tick();
    const finish = async () => {
      h.adapter.last.init();
      h.adapter.last.result('completed');
      await tick();
    };
    await finish();
    standing = '';
    const { turnId } = h.runner.send(thread.id, 'second');
    await tick();
    const told = h.adapter.last.sent.at(-1)!.text;
    await finish();
    const seq = h.store.log(thread.id).read(1, h.store.log(thread.id).lastSeq).find((e) => e.type === 'user.message' && e.turnId === turnId)!.seq;
    await h.runner.editMessage(thread.id, seq, 'second, edited');
    await tick();
    return { told, edited: h.adapter.last.sent.at(-1)!.text };
  };
  const held = await run('Be brief.');
  assert.match(held.told, /cleared their standing instructions/);
  assert.match(held.edited, /^Note from Threadbear: the user cleared their standing instructions[\s\S]*second, edited$/);
  const never = await run('');
  assert.equal(never.told, 'second');
  assert.equal(never.edited, 'second, edited');
});

// The second round of that review.
test('news sent into a turn that was stopped goes again', async () => {
  let standing = 'Be brief.';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  h.adapter.last.init();
  standing = '';
  h.runner.send(thread.id, 'also');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /cleared their standing instructions/);
  h.runner.interrupt(thread.id);
  await tick();
  h.adapter.last.result('interrupted');
  await tick();
  h.runner.send(thread.id, 'next');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user cleared their standing instructions[\s\S]*next$/);
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  h.runner.send(thread.id, 'then');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'then');
});

test("after Claude's /clear the next message says what's current", async () => {
  let standing = 'Be brief.';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  standing = '';
  h.runner.send(thread.id, 'told');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /cleared their standing instructions/);
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  h.runner.send(thread.id, '/clear');
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  h.runner.send(thread.id, 'fresh');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: the user cleared their standing instructions[\s\S]*fresh$/);
});

test('a fresh session with none keeps that it was told, and one that never had any writes nothing', async () => {
  let standing = 'Be brief.';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  const rec = h.runner.threads.get(thread.id)!.rec;
  standing = '';
  assert.deepEqual(h.runner.briefFor(rec, false), {});
  assert.equal(rec.instructionsTold, 'cleared');
  const never = { ...rec, instructionsTold: undefined };
  h.runner.briefFor(never, false);
  assert.equal(never.instructionsTold, undefined);
});

test("failing to write the note doesn't fail a message the CLI has", async () => {
  let standing = 'Be brief.';
  const h = makeHarness(tmpDir(), {}, { standingInstructions: () => standing });
  const { thread } = h.runner.create({ text: 'Start', cwd: tmpDir(), accountId: 'claude-3' });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  standing = 'Be kind.';
  const st = h.runner.threads.get(thread.id)!;
  const emit = h.runner.emit;
  h.runner.emit = () => {
    throw new Error('disk full');
  };
  h.runner.sendWithInstructionsNews(st, { id: 'x', text: 'hello', images: [] });
  h.runner.emit = emit;
  assert.match(h.adapter.last.sent.at(-1)!.text, /Be kind\.\n\nhello$/);
});
