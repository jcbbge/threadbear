import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from '../helpers/fakes.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { AGENT_MESSAGE_PREFIX } from '../../src/protocol.ts';

function fixture(mode?: 'ask' | 'full') {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Daily brief', accountId: 'claude-3', ...(mode ? { permissionMode: mode } : {}) });
  h.adapter.last.init();
  const folder = path.join(h.home, 'work');
  fs.mkdirSync(folder, { recursive: true });
  return { h, thread, folder };
}

test('a start button starts its thread once, however many times it is pressed', () => {
  const { h, thread, folder } = fixture();
  const { button } = h.runner.createButton(thread.id, { title: 'Fill in the form', start: { text: 'Fill in the Pebble form', cwd: folder } });
  assert.match(button.id, /^[a-z0-9]{8}$/);
  assert.equal(button.start?.permissionMode, 'full');
  const before = h.runner.list(['inbox']).length;
  const first = h.runner.pressButton(thread.id, button.id).button;
  assert.ok(first.pressed);
  const again = h.runner.pressButton(thread.id, button.id).button;
  assert.deepEqual(again.pressed, first.pressed);
  assert.equal(h.runner.list(['inbox']).length, before + 1, 'one new thread, not two');
  const started = h.runner.get(first.pressed!.threadId);
  assert.equal(started.cwd, folder);
  assert.equal(started.startedBy?.label, 'Button');
  assert.equal(started.startedBy?.threadId, thread.id);
  const msg = h.runner.events(started.id).events.find((e) => e.type === 'user.message');
  assert.ok(msg && msg.type === 'user.message' && msg.text.startsWith(AGENT_MESSAGE_PREFIX) && msg.text.endsWith('Fill in the Pebble form'));
  const updates = h.runner.events(thread.id).events.filter((e) => e.type === 'button.updated');
  assert.equal(updates.length, 2, 'made, then pressed');
  // Survives a restart, still pressed.
  const back = h.restart();
  assert.deepEqual(back.runner.listButtons(thread.id).buttons[0].pressed, first.pressed);
});

test('a send button messages its thread once', () => {
  const { h, thread } = fixture();
  const other = h.runner.create({ text: 'Meetup', accountId: 'claude-3' }).thread;
  const { button } = h.runner.createButton(thread.id, { title: 'Ask it', send: { threadId: other.id, text: 'Post the meetup message' } });
  assert.equal(button.send?.threadTitle, h.runner.get(other.id).title);
  const count = () => h.runner.events(other.id).events.filter((e) => e.type === 'user.message').length + h.store.load(other.id)!.queue.length;
  const was = count();
  h.runner.pressButton(thread.id, button.id);
  h.runner.pressButton(thread.id, button.id);
  assert.equal(count(), was + 1);
});

test('buttons are checked when made', () => {
  const { h, thread, folder } = fixture();
  const n = h.runner.events(thread.id).events.length;
  assert.throws(() => h.runner.createButton(thread.id, { title: '', start: { text: 'x', cwd: folder } }), /title/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'x'.repeat(61), start: { text: 'x', cwd: folder } }), /60/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: path.join(folder, 'nope') } }), /Folder not found/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: folder, accountId: 'nobody' } }), /No account/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: folder, poolId: 'nopool' } }), /No pool/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', send: { threadId: 'missing', text: 'x' } }), /No thread/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', send: { threadId: thread.id, text: 'x' } }), /own thread/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go' }), /either start/);
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: folder }, send: { threadId: thread.id, text: 'x' } }), /not both/);
  assert.equal(h.runner.events(thread.id).events.length, n, 'nothing saved');
  assert.throws(() => h.runner.pressButton(thread.id, 'zzzzzzzz'), /not found/);
});

test("a restricted thread's buttons can't reach past its own access", () => {
  const { h, thread, folder } = fixture('ask');
  const made = h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: folder } }).button;
  assert.equal(made.start?.permissionMode, 'ask', "the maker's mode by default");
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: folder, permissionMode: 'full' } }), /can't start a thread with Full access/);
  const full = h.runner.create({ text: 'Other', accountId: 'claude-3' }).thread;
  assert.throws(() => h.runner.createButton(thread.id, { title: 'Go', send: { threadId: full.id, text: 'rm -rf' } }), /send_message asks/);
});

test('a press that fails is saved as failed and can be pressed again', () => {
  const { h, thread, folder } = fixture();
  const sub = path.join(folder, 'gone');
  fs.mkdirSync(sub);
  const { button } = h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: sub } });
  fs.rmdirSync(sub);
  assert.throws(() => h.runner.pressButton(thread.id, button.id), /Folder not found/);
  const failed = h.runner.listButtons(thread.id).buttons[0];
  assert.ok(failed.failed && !failed.pressed);
  fs.mkdirSync(sub);
  const ok = h.runner.pressButton(thread.id, button.id).button;
  assert.ok(ok.pressed && !ok.failed);
});

test('add_button is only handed out with the experiment on, and returns the link', async () => {
  const { h, thread } = fixture();
  assert.equal(buildThreadbearTools(h.runner, thread.id).find((t) => t.name === 'add_button'), undefined);
  const tool = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { replyButtons: () => true }).find((t) => t.name === 'add_button');
  assert.ok(tool);
  const r = await tool.handler({ title: 'Look into it', start: { text: 'Look at the camera panning', folder: '.' } } as any, {} as any);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const id = h.runner.listButtons(thread.id).buttons[0].id;
  assert.match(JSON.stringify(r.content), new RegExp(`\\[Look into it\\]\\(button:${id}\\)`));
});

test('access is checked again when pressed', () => {
  const { h, thread, folder } = fixture();
  const { button } = h.runner.createButton(thread.id, { title: 'Go', start: { text: 'x', cwd: folder } });
  assert.equal(button.start?.permissionMode, 'full');
  h.runner.update({ threadId: thread.id, permissionMode: 'ask' });
  // A running turn keeps the access it started with; once it's over, the new mode counts.
  h.adapter.last.result();
  assert.throws(() => h.runner.pressButton(thread.id, button.id), /now has Ask before edits/);
  assert.ok(h.runner.listButtons(thread.id).buttons[0].failed);
});
