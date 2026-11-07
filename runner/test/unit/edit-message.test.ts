// Editing an earlier message (docs/protocol.md, "Editing a message").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, type Harness, type FakeSession } from '../helpers/fakes.ts';
import { checkSequence } from '../helpers/protocol-check.ts';
import { diffLines } from '../../src/diff.ts';
import { RpcError, type PersistedEvent } from '../../src/protocol.ts';
import { RewindRefusedError, type RewindResult } from '../../src/adapters/types.ts';

function log(h: Harness, id: string): PersistedEvent[] {
  return h.store.log(id).read(1, h.store.log(id).lastSeq);
}

// A finished turn whose agent wrote `file`.
function turnThatWrites(s: FakeSession, file: string, text: string, item: string): void {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, text);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: item, name: 'Write', kind: 'write', title: `Write ${path.basename(file)}`, input: { file_path: file } } });
  s.out({ kind: 'event', event: { type: 'edit.diff', itemId: item, path: file, hunks: diffLines(before, text) } });
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: item, ok: true, text: '', truncated: false, images: [] } });
  s.text(`${item}-reply`, 'Done.');
  s.result();
}

// A Claude thread with two finished turns, the second writing a file, and
// a rewind that cuts back to the first turn's reply.
async function twoTurns(h: Harness, rewind: (h: Harness) => Promise<RewindResult> = async () => ({ resumeAt: 'entry-1' })) {
  h.adapter.rewind = async (req) => {
    h.adapter.rewound.push(req);
    return rewind(h);
  };
  const { thread } = h.runner.create({ text: 'Make a plan', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.text('a1', 'Here is the plan.');
  s.result();
  const file = path.join(thread.cwd, 'notes.txt');
  fs.writeFileSync(file, 'first\n');
  const { turnId: second } = h.runner.send(thread.id, 'Write it to notes.txt');
  turnThatWrites(s, file, 'first\nthe plan\n', 'w1');
  const seq = log(h, thread.id).find((e) => e.type === 'user.message' && e.turnId === second)!.seq;
  return { thread, s, file, second, seq };
}

test('an edit cuts the conversation back, undoes the file change and sends the new text', async () => {
  const h = makeHarness();
  const { thread, file, second, seq } = await twoTurns(h);
  const r = await h.runner.editMessage(thread.id, seq, 'Write it to plan.txt instead');
  // The session was cut before the edited message, on its own id.
  assert.deepEqual(h.adapter.rewound.map((q) => [q.messageId, q.sessionId]), [[second, h.runner.get(thread.id).nativeSessionId]]);
  // No checkpoints, so the runner reversed the diff.
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\n');
  const evs = log(h, thread.id);
  assert.deepEqual(checkSequence(evs), []);
  const rew = evs.find((e) => e.type === 'thread.rewound')!;
  assert.equal(rew.type === 'thread.rewound' && rew.fromSeq, seq);
  assert.equal(rew.type === 'thread.rewound' && rew.toSeq, rew.seq - 1);
  assert.deepEqual(rew.type === 'thread.rewound' && rew.files, { undone: [file], failed: [], how: 'diffs' });
  assert.deepEqual(r.rewound, { seq: rew.seq, fromSeq: seq, toSeq: rew.seq - 1, files: { undone: [file], failed: [], how: 'diffs' } });
  const edited = evs[rew.seq];
  assert.equal(edited.type, 'user.message');
  assert.equal(edited.type === 'user.message' && edited.text, 'Write it to plan.txt instead');
  assert.equal(edited.type === 'user.message' && edited.editOf, seq);
  assert.equal(edited.turnId, r.turnId);
  // A fresh CLI resumes at the cut and gets the new text.
  const next = h.adapter.last;
  assert.equal(next.opts.resume, true);
  assert.equal(next.opts.resumeAt, 'entry-1');
  assert.deepEqual(next.sent.map((m) => m.text), ['Write it to plan.txt instead']);
  // Once a turn has run there, later starts resume at the end again.
  next.init();
  next.result();
  assert.equal(h.store.load(thread.id)?.resumeAt ?? h.runner.threadRecords().find((x) => x.id === thread.id)?.resumeAt, undefined);
  // The cut message is gone from what the librarian and handoffs read.
  const gist = h.runner.threadGist(thread.id);
  assert.ok(!gist.recent.some((m) => m.text.includes('notes.txt')), JSON.stringify(gist));
  assert.deepEqual(h.runner.cuts(thread.id), [{ from: seq, to: rew.seq - 1 }]);
});

test('editing during a turn stops it first; messages queued behind it go, ones sent during the edit follow', async () => {
  const h = makeHarness();
  const { thread, s, seq } = await twoTurns(h);
  h.runner.send(thread.id, 'And another thing');
  assert.equal(h.runner.get(thread.id).status, 'running');
  // Queued behind the running turn: it was sent after the edited message.
  h.runner.send(thread.id, 'queued before the edit', [], { queue: true });
  const editing = h.runner.editMessage(thread.id, seq, 'Edited');
  await tick();
  assert.equal(s.interrupts, 1);
  h.runner.send(thread.id, 'sent during the edit');
  s.result('interrupted');
  const r = await editing;
  const evs = log(h, thread.id);
  const texts = evs.filter((e) => e.type === 'user.message' && e.seq > r.rewound.seq).map((e) => (e.type === 'user.message' ? e.text : ''));
  assert.deepEqual(texts, ['Edited']);
  const next = h.adapter.last;
  next.init();
  next.result();
  await tick();
  const after = log(h, thread.id).filter((e) => e.type === 'user.message' && e.seq > r.rewound.seq).map((e) => (e.type === 'user.message' ? e.text : ''));
  assert.deepEqual(after, ['Edited', 'sent during the edit']);
});

test('only Mike\'s own messages that started a turn can be edited', async () => {
  const h = makeHarness();
  const { thread, s, seq } = await twoTurns(h);
  const bad = async (seqToEdit: number, re: RegExp) => {
    await assert.rejects(h.runner.editMessage(thread.id, seqToEdit, 'x'), (e: unknown) => e instanceof RpcError && e.code === -32602 && re.test(e.message));
  };
  // A message sent into a running turn.
  h.runner.send(thread.id, 'Start something');
  h.runner.send(thread.id, 'steered in');
  const steered = log(h, thread.id).find((e) => e.type === 'user.message' && e.text === 'steered in')!.seq;
  await bad(steered, /already running/);
  h.runner.interrupt(thread.id);
  s.result('interrupted');
  // Not a message at all, and one from the runner.
  await bad(seq + 1, /no message/);
  h.runner.send(thread.id, 'Runner restarted, carry on', [], { origin: 'runner' });
  s.result();
  assert.equal(h.runner.get(thread.id).status, 'idle');
  const fromRunner = log(h, thread.id).find((e) => e.type === 'user.message' && e.origin === 'runner')!.seq;
  await bad(fromRunner, /your own/);
  // Once cut, a message can't be edited again.
  await h.runner.editMessage(thread.id, seq, 'Edited');
  await bad(seq, /earlier edit/);
});

test('a session that no longer has the message refuses, and nothing is cut', async () => {
  const h = makeHarness();
  const { thread, file, seq } = await twoTurns(h, async () => {
    throw new RewindRefusedError("This message isn't in the thread's current session.");
  });
  await assert.rejects(h.runner.editMessage(thread.id, seq, 'Edited'), (e: unknown) => e instanceof RpcError && e.code === -32602);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\nthe plan\n');
  assert.ok(!log(h, thread.id).some((e) => e.type === 'thread.rewound'));
  // The thread still works.
  h.runner.send(thread.id, 'carry on');
  assert.equal(h.runner.get(thread.id).status !== 'error', true);
});

test('checkpoints the CLI rewound are reported as such, and the diffs are left alone', async () => {
  const h = makeHarness();
  const { thread, file, seq } = await twoTurns(h, async () => ({ resumeAt: 'entry-1', files: { undone: ['/x/notes.txt'], failed: [] } }));
  const r = await h.runner.editMessage(thread.id, seq, 'Edited');
  assert.deepEqual(r.rewound.files, { undone: ['/x/notes.txt'], failed: [], how: 'checkpoint' });
  // The CLI did the files; the runner didn't reverse its diffs as well.
  assert.equal(fs.readFileSync(file, 'utf8'), 'first\nthe plan\n');
});

test('editing the first message starts a fresh session; with history before it, a handoff note carries it', async () => {
  const h = makeHarness();
  h.adapter.rewind = async () => ({ fresh: true });
  const { thread } = h.runner.create({ text: 'Hello', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.text('a1', 'Hi there');
  s.result();
  const firstSeq = log(h, thread.id).find((e) => e.type === 'user.message')!.seq;
  const oldSession = h.runner.get(thread.id).nativeSessionId;
  await h.runner.editMessage(thread.id, firstSeq, 'Hello again');
  const fresh = h.adapter.last;
  assert.equal(fresh.opts.resume, false);
  assert.notEqual(fresh.opts.sessionId, oldSession);
  // Nothing came before it, so no note.
  assert.deepEqual(fresh.sent.map((m) => m.text), ['Hello again']);

  // A session that started part way through the thread (another login,
  // say): editing its first message keeps what came before as a note.
  fresh.init();
  fresh.text('a2', 'Hello to you');
  fresh.result();
  const { turnId } = h.runner.send(thread.id, 'Second question');
  const secondSeq = log(h, thread.id).find((e) => e.turnId === turnId && e.type === 'user.message')!.seq;
  fresh.result();
  await h.runner.editMessage(thread.id, secondSeq, 'Second question, edited');
  const sent = h.adapter.last.sent.map((m) => m.text);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /handoff/i);
  assert.match(sent[0], /Hello again/);
  assert.match(sent[0], /Second question, edited$/);
  assert.doesNotMatch(sent[0], /Second question\n/);
});

// 4 Nov: Mike edited a message he'd just sent while an upload started
// turns earlier was still running in the background, and the release
// that the edit needs took the upload with it, without a word.
test('an edit while background work runs refuses until told to stop it', async () => {
  const h = makeHarness();
  const { thread, s, seq } = await twoTurns(h);
  s.out({ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'Upload the video' }] });
  await assert.rejects(
    h.runner.editMessage(thread.id, seq, 'Write it to plan.txt instead'),
    (e: unknown) => e instanceof RpcError && e.code === -32050 && /Upload the video/.test(e.message),
  );
  // Nothing was touched: the CLI and its task are still live, nothing cut.
  assert.equal(s.ended, false);
  assert.deepEqual(h.adapter.rewound, []);
  assert.ok(!log(h, thread.id).some((e) => e.type === 'thread.rewound'));
  // Told to, it stops the work, says so, and edits.
  await h.runner.editMessage(thread.id, seq, 'Write it to plan.txt instead', [], { stopBackground: true });
  assert.equal(s.endedHard, true);
  assert.ok(log(h, thread.id).some((e) => e.type === 'system.note' && /Upload the video/.test(e.text)));
  assert.ok(log(h, thread.id).some((e) => e.type === 'thread.rewound'));
});

test('an edit into a slash command the runner answers: messages sent meanwhile still go, and the cut waits for the CLI', async () => {
  const h = makeHarness();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { thread, s, seq } = await twoTurns(h, async () => {
    await gate;
    return { resumeAt: 'entry-1' };
  });
  s.text('a2', 'Done.');
  s.result();
  await tick();
  const editing = h.runner.editMessage(thread.id, seq, '/model opus');
  await tick();
  h.runner.send(thread.id, 'sent during the edit');
  release();
  await editing;
  await tick();
  const next = h.adapter.last;
  assert.equal(h.runner.get(thread.id).model, 'opus');
  // The message sent meanwhile started a CLI, cut at the edit.
  assert.equal(next.sent.at(-1)?.text, 'sent during the edit');
  assert.equal(next.opts.resumeAt, 'entry-1');
});
