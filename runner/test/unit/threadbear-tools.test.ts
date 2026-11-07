import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAccounts, makeHarness, tick, tmpDir, withCodex } from '../helpers/fakes.ts';
import { copySessionTranscript, projectDirName } from '../../src/transcripts.ts';
import { buildThreadbearTools, parseWhen, threadbearMcpServer, type RemoteControl } from '../../src/threadbear-mcp.ts';
import { Relay, type RelayRow } from '../../src/relay.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import type { RemoteThreads } from '../../src/thread-index.ts';
import { needsFromTool } from '../../src/needs.ts';
import { CodexTools, type ToolDefinition } from '../../src/adapters/codex/tools.ts';
import { toolTitle } from '../../src/tools.ts';

function start(h: ReturnType<typeof makeHarness>, text = 'Fix the tests', extra: Record<string, unknown> = {}) {
  const { thread } = h.runner.create({ text, accountId: 'claude-3', ...extra });
  const s = h.adapter.last;
  s.init();
  return { thread, s };
}

function tools(h: ReturnType<typeof makeHarness>, selfId: string, bulletReplies?: () => boolean, oneReply?: () => boolean) {
  // end_turn's wait for its own call to land is counted, not slept.
  const slept: number[] = [];
  const list = buildThreadbearTools(h.runner, selfId, () => Date.parse('2026-10-26T12:00:00Z'), undefined, undefined, undefined, {
    bulletReplies,
    oneReply,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = list.find((x) => x.name === name);
    assert.ok(t, `tool ${name}`);
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
  return { list, call, slept };
}

// What the CLI has told the runner by the time the end_turn handler runs:
// the agent's text (if any), then the end_turn call itself.
const END_TURN = 'mcp__threadbear__end_turn';
function toolCall(s: ReturnType<typeof makeHarness>['adapter']['last'], itemId: string, name: string, input: Record<string, unknown> = {}) {
  s.out({ kind: 'event', event: { type: 'tool.call', itemId, name, kind: name === 'Bash' ? 'command' : 'mcp', title: name, input } });
}
function toolResult(s: ReturnType<typeof makeHarness>['adapter']['last'], itemId: string) {
  s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: true, text: 'ok', truncated: false, images: [] } });
}

// ------------------------------------------------------------ transcripts

test('projectDirName matches how the CLI names folders', () => {
  assert.equal(projectDirName('/Users/m5-mike/dev/me/misc'), '-Users-m5-mike-dev-me-misc');
  assert.equal(projectDirName('/Users/x/.agents/a_b c'), '-Users-x--agents-a-b-c');
});

test('copySessionTranscript copies the jsonl and the subagent folder, using real paths', () => {
  const config = tmpDir();
  const a = fs.realpathSync(tmpDir());
  const b = tmpDir(); // under /var -> /private/var, so the real path differs
  const sid = '0b7a4c1e-1111-2222-3333-444455556666';
  const src = path.join(config, 'projects', projectDirName(a));
  fs.mkdirSync(path.join(src, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(src, `${sid}.jsonl`), '{"x":1}\n');
  fs.writeFileSync(path.join(src, sid, 'subagents', 'agent-1.jsonl'), '{}\n');
  assert.equal(copySessionTranscript(config, config, a, b, sid), true);
  const dest = path.join(config, 'projects', projectDirName(fs.realpathSync(b)));
  assert.equal(fs.readFileSync(path.join(dest, `${sid}.jsonl`), 'utf8'), '{"x":1}\n');
  assert.ok(fs.existsSync(path.join(dest, sid, 'subagents', 'agent-1.jsonl')));
  assert.ok(fs.existsSync(path.join(src, `${sid}.jsonl`)), 'the original stays');
  assert.equal(copySessionTranscript(config, config, a, b, 'not-there'), false);
  assert.equal(copySessionTranscript(config, config, a, b, '../evil'), false);
});

test('copySessionTranscript copies into another login\'s config dir, in the same folder', () => {
  const from = tmpDir();
  const to = tmpDir();
  const cwd = fs.realpathSync(tmpDir());
  const sid = '0b7a4c1e-1111-2222-3333-777788889999';
  const src = path.join(from, 'projects', projectDirName(cwd));
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, `${sid}.jsonl`), '{"y":2}\n');
  assert.equal(copySessionTranscript(from, to, cwd, cwd, sid), true);
  assert.equal(fs.readFileSync(path.join(to, 'projects', projectDirName(cwd), `${sid}.jsonl`), 'utf8'), '{"y":2}\n');
  assert.ok(fs.existsSync(path.join(src, `${sid}.jsonl`)), 'the original stays');
  // Nothing in the old login's folder: nothing to carry.
  assert.equal(copySessionTranscript(to, from, tmpDir(), cwd, sid), false);
});

// ------------------------------------------------------ moving a thread

test('a folder move on the same account carries the transcript and resumes the same session', async () => {
  const copies: string[][] = [];
  const h = makeHarness(undefined, {}, {
    copyTranscript: (fromConfig, toConfig, from, to, sid) => {
      copies.push([fromConfig, toConfig, from, to, sid]);
      return true;
    },
  });
  const { thread, s } = start(h);
  s.result('completed', 0.01);
  const other = tmpDir();
  h.runner.update({ threadId: thread.id, cwd: other });
  await tick();
  h.runner.send(thread.id, 'Now commit it');
  await tick();
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.cwd, other);
  assert.equal(s2.opts.resume, true, 'resumes rather than starting fresh');
  assert.equal(s2.opts.sessionId, s.opts.sessionId);
  assert.equal(s2.sent[0].text, 'Now commit it', 'no handoff note');
  assert.deepEqual(copies, [['/tmp/three', '/tmp/three', h.cfg.defaults.cwd, other, s.opts.sessionId]]);
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && /^Moved to /.test(e.text)));
});

test('a move falls back to the handoff note when the transcript cannot be carried', async () => {
  let called = 0;
  const h = makeHarness(undefined, {}, {
    copyTranscript: () => {
      called++;
      return false;
    },
  });
  const { thread, s } = start(h);
  s.text('m1:0', 'Done.');
  s.result();
  h.runner.update({ threadId: thread.id, cwd: tmpDir() });
  await tick();
  h.runner.send(thread.id, 'next');
  await tick();
  const s2 = h.adapter.last;
  assert.equal(s2.opts.resume, false);
  assert.match(s2.sent[0].text, /^\[Threadbear handoff\]/);
  assert.equal(called, 1, 'copy attempts');
});

test('a move to another Claude login carries the transcript into its config dir and resumes there', async () => {
  const copies: string[][] = [];
  const h = makeHarness(undefined, {}, { copyTranscript: (fc, tc, f, t, sid) => (copies.push([fc, tc, f, t, sid]), true) });
  const { thread, s } = start(h);
  s.text('m1:0', 'Done.');
  s.result();
  h.runner.update({ threadId: thread.id, accountId: 'claude-main' });
  await tick();
  h.runner.send(thread.id, 'next');
  await tick();
  const s2 = h.adapter.last;
  assert.equal(s2.opts.account.id, 'claude-main');
  assert.equal(s2.opts.resume, true);
  assert.equal(s2.opts.sessionId, s.opts.sessionId);
  assert.equal(s2.sent[0].text, 'next', 'no handoff note');
  assert.deepEqual(copies, [['/tmp/three', '/tmp/main', h.cfg.defaults.cwd, h.cfg.defaults.cwd, s.opts.sessionId]]);
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && e.text === 'Resumed the session on main@example.com, with the whole conversation.'));
});

test('if the carried transcript will not resume, the fresh session gets the handoff note', async () => {
  const h = makeHarness(undefined, {}, { copyTranscript: () => true });
  const { thread, s } = start(h);
  s.text('m1:0', 'The tests pass now.');
  s.result();
  h.runner.update({ threadId: thread.id, cwd: tmpDir() });
  await tick();
  h.runner.send(thread.id, 'Now commit it');
  await tick();
  const s2 = h.adapter.last;
  assert.equal(s2.opts.resume, true);
  s2.sink.exited(new Error('No conversation found with session ID x'));
  await tick();
  const s3 = h.adapter.last;
  assert.notEqual(s3, s2);
  assert.equal(s3.opts.resume, false);
  assert.match(s3.sent[0].text, /^\[Threadbear handoff\][\s\S]*The tests pass now\.[\s\S]*Now commit it$/);
});

// ---------------------------------------------------------------- delete

test('delete stops the CLI, moves the files to trash and tells clients', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const dir = h.store.threadDir(thread.id);
  assert.ok(fs.existsSync(dir));
  h.runner.delete(thread.id);
  await tick();
  assert.equal(s.endedHard, true);
  assert.ok(!fs.existsSync(dir));
  const trashed = fs.readdirSync(path.join(h.home, 'trash'));
  assert.equal(trashed.length, 1);
  assert.ok(trashed[0].startsWith(thread.id));
  assert.ok(h.notes.some((n) => n.method === 'thread.deleted' && n.params.threadId === thread.id));
  assert.throws(() => h.runner.get(thread.id), (e: { code: number }) => e.code === -32004);
  // Late output from the old CLI goes nowhere and doesn't bring the folder back.
  s.text('m1:0', 'late');
  s.result();
  h.runner.flush();
  assert.ok(!fs.existsSync(dir));
  assert.equal(h.restart().runner.list(['inbox', 'snoozed', 'archived']).length, 0, 'gone after a restart too');
});

// ----------------------------------------------------------------- tools

test('list, read and account tools', async () => {
  const h = makeHarness();
  const { thread: a, s } = start(h, 'First thread');
  s.text('m1:0', 'Hello from the agent');
  s.result();
  const { thread: b } = start(h, 'Second thread');
  const t = tools(h, a.id);
  const list = await t.call('list_threads');
  assert.match(list.text, /First thread .*this thread/);
  assert.match(list.text, /Second thread/);
  const read = await t.call('read_thread', { threadId: b.id.slice(0, 8) });
  assert.match(read.text, /title: Second thread/);
  const self = await t.call('read_thread');
  assert.match(self.text, /User \(.*\):\nFirst thread/);
  assert.match(self.text, /Agent \(.*\):\nHello from the agent/);
  // The runner's resume after a restart isn't Mike's.
  h.runner.send(a.id, 'The runner restarted on release R. Check your change.', [], { origin: 'runner' });
  const resumed = await t.call('read_thread');
  assert.match(resumed.text, /Runner \(.*\):\nThe runner restarted on release R/);
  assert.doesNotMatch(resumed.text, /User \(.*\):\nThe runner restarted/);
  assert.match((await t.call('list_accounts')).text, /claude-3 {2}three@example\.com/);
  assert.match((await t.call('list_threads', { query: 'Second' })).text, /Second thread/);
  const missing = await t.call('read_thread', { threadId: 'zzzz' });
  assert.equal(missing.error, true);
});

test('create and send say where the message came from', async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Boss thread');
  const t = tools(h, me.id);
  const made = await t.call('create_thread', { text: 'Write the docs\nin detail', account: 'three', folder: '.' });
  assert.equal(made.error, false, made.text);
  const child = h.runner.list().find((x) => x.title === 'Write the docs')!;
  assert.ok(child, 'title from the first line, without the prefix');
  assert.equal(child.cwd, me.cwd);
  const cs = h.adapter.last;
  assert.match(cs.sent[0].text, /^\[Sent by the agent in the thread "Boss thread"/);
  cs.init();
  cs.result();
  await t.call('send_message', { threadId: child.id, text: 'Also add examples' });
  const um = h.events(child.id).filter((e) => e.type === 'user.message').at(-1);
  assert.match(um.text, /^\[Sent by the agent[\s\S]*Also add examples$/);
  assert.equal((await t.call('send_message', { threadId: me.id, text: 'x' })).error, true, 'not to itself');
});

test('update renames and snoozes others, but will not stop its own turn', async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Me');
  const { thread: other } = start(h, 'Other');
  const t = tools(h, me.id);
  assert.match((await t.call('update_thread', { title: 'Renamed me' })).text, /title: Renamed me/);
  const own = await t.call('update_thread', { archived: true });
  assert.equal(own.error, true);
  assert.match(own.text, /end_turn with needs "nothing" and archive: true, or snooze:/, 'says the way that works');
  const ownSnooze = await t.call('update_thread', { snooze: '2h' });
  assert.equal(ownSnooze.error, true);
  assert.match(ownSnooze.text, /snooze: and when to wake/);
  assert.equal(h.runner.get(me.id).archivedAt, undefined);
  // An agent's archive says so, and read_thread tells a sweep who did it.
  const archived = await t.call('update_thread', { threadId: other.id, archived: true });
  assert.match(archived.text, /archived: \S+ by an agent/);
  assert.equal(h.runner.get(other.id).archivedBy, 'agent');
  h.runner.update({ threadId: other.id, archived: false });
  h.runner.update({ threadId: other.id, archived: true, verdict: 'didntWork' });
  assert.match((await t.call('list_threads', { include: ['archived'] })).text, /archived by the user: it didn't work/);
  h.runner.update({ threadId: other.id, archived: false });
  const snoozed = await t.call('update_thread', { threadId: other.id, snooze: '2h' });
  assert.match(snoozed.text, /snoozed until: 2026-10-26T14:00:00\.000Z/);
  await t.call('update_thread', { threadId: other.id, snooze: 'off' });
  assert.equal(h.runner.get(other.id).snoozedUntil, undefined);
});

test('move_thread on itself switches folder after the turn and carries on with `then`', async () => {
  const h = makeHarness(undefined, {}, { copyTranscript: () => true });
  const { thread: me, s } = start(h, 'Move me');
  const dest = tmpDir();
  const t = tools(h, me.id);
  const r = await t.call('move_thread', { folder: dest, then: 'Carry on with the tests' });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /when this turn ends.*carries on by itself/);
  assert.equal(h.adapter.sessions.length, 1, 'the running turn is left alone');
  assert.equal(h.runner.get(me.id).cwd, dest);
  s.result();
  await tick();
  const s2 = h.adapter.last;
  assert.notEqual(s2, s);
  assert.equal(s2.opts.cwd, dest);
  assert.equal(s2.opts.resume, true);
  assert.match(s2.sent[0].text, /^\[Sent by the agent before moving to .*\]\n\nCarry on with the tests$/);
  assert.equal((await t.call('move_thread', { folder: '/definitely/not/here' })).error, true);
});

test("move_thread's `then` to another login isn't taken for Mike: the turn finishes, then it carries on there", async () => {
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex()) });
  const { thread: me, s } = start(h, 'Move me');
  const t = tools(h, me.id);
  const r = await t.call('move_thread', { folder: '.', account: 'codex-main', then: 'Carry on with the tests' });
  assert.equal(r.error, false, r.text);
  await tick();
  // As Mike's message it stopped the turn that sent it ("Stopped here so … can take over").
  assert.equal(s.interrupts, 0, 'the running turn is left alone');
  s.result();
  await tick();
  const first = h.codex.last.sent[0].text;
  assert.match(first, /^\[Threadbear handoff\][\s\S]*\[Sent by the agent before moving to .*\]\n\nCarry on with the tests$/);
  const read = (await t.call('read_thread', { messages: 5 })).text;
  assert.match(read, /Agent \([^)]*\):\n\[Sent by the agent before moving to /);
  assert.doesNotMatch(read, /User \([^)]*\):\n\[Sent by the agent/);
});

test('interrupt and delete refuse this thread and work on others', async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Me');
  const { thread: other, s: os } = start(h, 'Other');
  const t = tools(h, me.id);
  assert.equal((await t.call('interrupt_thread', { threadId: me.id })).error, true);
  assert.equal((await t.call('delete_thread', { threadId: me.id })).error, true);
  await t.call('interrupt_thread', { threadId: other.id });
  assert.equal(os.interrupts, 1);
  const del = await t.call('delete_thread', { threadId: other.id.slice(0, 8) });
  assert.match(del.text, /Deleted "Other"/);
  assert.equal(h.runner.list().length, 1);
});

test('`id` works as a thread id, and a missing one is an error rather than "this thread"', async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Me');
  const { thread: other } = start(h, 'Other');
  const t = tools(h, me.id);
  await t.call('update_thread', { id: other.id, title: 'Renamed other' });
  assert.equal(h.runner.get(other.id).title, 'Renamed other');
  assert.equal(h.runner.get(me.id).title, 'Me');
  assert.equal((await t.call('delete_thread', {})).error, true);
  assert.equal(h.runner.list().length, 2);
});

test("update_thread leaves a title Mike gave alone unless he asked for the new one", async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Me');
  const { thread: other } = start(h, 'Other');
  const t = tools(h, me.id);
  // An agent's title doesn't stop a later agent rename.
  await t.call('update_thread', { id: other.id, title: 'Agent name' });
  await t.call('update_thread', { id: other.id, title: 'Better agent name' });
  assert.equal(h.runner.get(other.id).title, 'Better agent name');
  // Mike renames it in the app (threads.update, no titleBy).
  h.runner.update({ threadId: other.id, title: 'Mike name' });
  const refused = await t.call('update_thread', { id: other.id, title: 'Agent again', snooze: '2h' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /The user named this thread "Mike name" themselves/);
  assert.equal(h.runner.get(other.id).title, 'Mike name');
  assert.equal(h.runner.get(other.id).snoozedUntil, undefined, 'nothing else in the refused call changed');
  // The same title, or one Mike asked for, goes through.
  assert.equal((await t.call('update_thread', { id: other.id, title: 'Mike name', snooze: 'off' })).error, false);
  assert.equal((await t.call('update_thread', { id: other.id, title: 'Asked for', mikeAsked: true })).error, false);
  assert.equal(h.runner.get(other.id).title, 'Asked for');
  assert.equal((await t.call('update_thread', { id: other.id, title: 'Sneaky' })).error, true, 'still his');
});

test('the delete approval names the thread', async () => {
  const h = makeHarness();
  const { thread: other } = start(h, 'Old experiment');
  const { thread: me, s } = start(h, 'Me', { permissionMode: 'ask' });
  const answer = s.sink.requestApproval({
    toolUseId: 'tu1',
    name: 'mcp__threadbear__delete_thread',
    title: 'Delete thread x',
    input: { id: other.id.slice(0, 8) },
    canAlwaysAllow: false,
    signal: new AbortController().signal,
  });
  const ask = h.events(me.id).find((e) => e.type === 'approval.requested');
  assert.equal(ask.title, 'Delete the thread "Old experiment"');
  h.runner.respondApproval({ threadId: me.id, approvalId: ask.approvalId, decision: 'deny' });
  assert.equal((await answer).decision, 'deny');
});

test('parseWhen and tool titles', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(parseWhen('30m', now), '2026-10-26T12:30:00.000Z');
  assert.equal(parseWhen('1d', now), '2026-10-27T12:00:00.000Z');
  assert.throws(() => parseWhen('soonish', now));
  assert.equal(toolTitle('mcp__threadbear__move_thread', { folder: '~/dev/x' }, '/'), 'Move this thread to ~/dev/x');
  assert.equal(toolTitle('mcp__threadbear__delete_thread', { threadId: 'abcdef123456' }, '/'), 'Delete thread abcdef12');
});

test('list_accounts shows each login\'s provider, note, room left and models; create and move take Codex accounts', async () => {
  const usage = { windows: [{ kind: 'five_hour' as const, title: '5-hour', remainingPercent: 89 }, { kind: 'weekly' as const, title: 'Weekly', remainingPercent: 78 }], readAt: '2026-10-26T12:00:00Z', source: 'tokenStats' as const };
  const accounts = withCodex().map((a) =>
    a.id === 'claude-3' ? { ...a, note: 'Convex work only', email: 'three@example.com', usage } : a.id === 'claude-main' ? { ...a, email: 'main@example.com' } : a,
  );
  const h = makeHarness(undefined, { defaults: { cwd: '', models: { codex: 'gpt-6-luna' } } }, { accounts: new FakeAccounts(accounts) });
  h.cfg.defaults.cwd = path.join(h.home, 'work');
  const { thread: me } = h.runner.create({ text: 'Boss', accountId: 'claude-main' });
  h.adapter.last.init();
  const t = tools(h, me.id);
  const list = (await t.call('list_accounts')).text;
  assert.match(list, /claude-main {2}main@example\.com {2}\[Claude; usage unknown; default for new threads\]/);
  assert.match(list, /claude-3 {2}three@example\.com {2}\[Claude; Convex work only; 5-hour 89% left, weekly 78% left\]/);
  assert.match(list, /codex-main {2}Codex · main@example\.com {2}\[Codex; usage unknown\]\n {4}models: gpt-6\.1-sol \(default\), gpt-6-luna/);

  // claude-main and codex-main share an email: that's refused, not guessed.
  const clash = await t.call('create_thread', { text: 'x', account: 'main@example.com' });
  assert.equal(clash.error, true);
  assert.match(clash.text, /fits claude-main .* and codex-main .*; use the id/);
  // "codex" names the one Codex login; ultra passes the schema.
  const made = await t.call('create_thread', { text: 'Draw a bear', account: 'codex', effort: 'ultra' });
  assert.equal(made.error, false, made.text);
  assert.match(made.text, /on codex-main \(gpt-6-luna\)\.$/);
  const child = h.runner.list().find((x) => x.title === 'Draw a bear')!;
  assert.equal(child.provider, 'codex');
  assert.equal(child.model, 'gpt-6-luna');
  assert.equal(child.effort, undefined, 'luna has no ultra: dropped with a note');
  assert.equal(h.codex.last.opts.account.id, 'codex-main');
  const read = await t.call('read_thread', { threadId: child.id });
  assert.match(read.text, /account: codex-main \(Codex\)/);

  // move_thread to the Codex login: fresh session there, on its defaults.
  h.adapter.last.result();
  const moved = await t.call('move_thread', { threadId: me.id, folder: '.', account: 'codex-main' });
  assert.equal(moved.error, false, moved.text);
  assert.equal(h.runner.get(me.id).provider, 'codex');
  assert.equal(h.runner.get(me.id).model, 'gpt-6-luna');
});

test('pools in the tools: list_accounts prints them, create_thread and update_thread take a pool, and a named model picks its provider', async () => {
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex()) });
  const { thread: me } = h.runner.create({ text: 'Boss', accountId: 'claude-main' });
  h.adapter.last.init();
  const t = tools(h, me.id);
  const list = (await t.call('list_accounts')).text;
  assert.match(list, /Pools \(a new thread in a pool's folder starts on that pool\):\nclaude {2}Claude: claude-main room unknown, claude-3 room unknown {2}\[new threads start here\]\ncodex {2}Codex: codex-main room unknown/);
  // A Claude model with no account or pool, while Codex is the default: Claude.
  h.runner.create({ text: 'x', accountId: 'codex-main' });
  const opus = await t.call('create_thread', { text: 'Use Opus', model: 'claude-opus-5-5' });
  assert.equal(opus.error, false, opus.text);
  const o = h.runner.list().find((x) => x.title === 'Use Opus')!;
  assert.equal(o.provider, 'claude');
  assert.equal(o.poolId, 'claude');
  assert.equal(o.model, 'claude-opus-5-5');
  assert.match(opus.text, /\(claude-opus-5-5\)\. It's in the claude pool/);
  // By title, ignoring case; an unknown one says which there are.
  const made = await t.call('create_thread', { text: 'On Codex', pool: 'CODEX' });
  assert.equal(made.error, false, made.text);
  assert.equal(h.runner.list().find((x) => x.title === 'On Codex')!.poolId, 'codex');
  const bad = await t.call('create_thread', { text: 'y', pool: 'grok' });
  assert.equal(bad.error, true);
  assert.match(bad.text, /No pool grok\. Pools: claude \(Claude\), codex \(Codex\)/);
  // update_thread: "pin" pins, a pool puts it back.
  const pinned = await t.call('update_thread', { threadId: o.id, pool: 'pin' });
  assert.match(pinned.text, /pool: none \(pinned to its account\)/);
  const back = await t.call('update_thread', { threadId: o.id, pool: 'claude' });
  assert.match(back.text, /pool: claude/);
  assert.equal((await t.call('update_thread', { threadId: o.id, pool: null })).error, false);
  assert.equal(h.runner.get(o.id).poolId, undefined);
});

// ------------------------------------------------------------ end_turn

test('end_turn only acknowledges; its description says when to call it', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { list, call, slept } = tools(h, thread.id);
  const t = list.find((x) => x.name === 'end_turn')!;
  assert.match(t.description, /last thing in every turn/);
  assert.match(t.description, /refused until the turn has a reply/);
  assert.doesNotMatch(t.description, /thinking|scratchpad|internal reasoning/i);
  assert.match(t.description, /Sub-agents never call this/);
  s.text('m1', 'Yes or no?');
  toolCall(s, 'e1', END_TURN, { needs: 'you' });
  const r = await call('end_turn', { needs: 'you', asks: [{ action: 'Say yes', why: 'It decides the rest.' }] });
  assert.equal(r.error, false);
  assert.match(r.text, /Needs you/);
  toolResult(s, 'e1');
  toolCall(s, 'e2', END_TURN, { needs: 'nothing' });
  assert.match((await call('end_turn', { needs: 'nothing' })).text, /done/);
  assert.deepEqual(slept, [], 'the call had landed; nothing to wait for');
  // The runner reads the call from the thread's events, not the handler.
  assert.equal(h.runner.get(thread.id).needs, undefined);
});

// An agent drafted its answer in thinking, ran two commands and called
// end_turn; Mike saw a folded work group and a card, twice (28 Oct 2026).
test('end_turn is refused until the turn has replied to Mike in text', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call, slept } = tools(h, thread.id);
  toolCall(s, 'b1', 'Bash', { command: 'grep sammy' });
  toolResult(s, 'b1');
  toolCall(s, 'e1', END_TURN, { needs: 'nothing' });
  let r = await call('end_turn', { needs: 'nothing' });
  assert.equal(r.error, true);
  assert.match(r.text, /hasn't had a reply this turn/);
  assert.match(r.text, /write the whole answer as ordinary text/);
  assert.match(r.text, /result and any supporting evidence/);
  // So an agent sure it had answered doesn't take the check for broken.
  assert.match(r.text, /a refused end_turn isn't a tool result/);
  assert.match(r.text, /If you think you already answered, they haven't seen any of it/);
  assert.doesNotMatch(r.text, /thinking|thought|scratchpad|internal reasoning/i);
  toolResult(s, 'e1');
  // A progress line before more work isn't the reply either.
  s.text('m1', 'Found it, one more check.');
  toolCall(s, 'b2', 'Bash', { command: 'git log' });
  toolResult(s, 'b2');
  toolCall(s, 'e2', END_TURN, { needs: 'nothing' });
  r = await call('end_turn', { needs: 'nothing' });
  assert.equal(r.error, true);
  toolResult(s, 'e2');
  // The reply, then one of Threadbear's own tools, then end_turn: fine.
  s.text('m2', 'No, the camera is not where the delay is.');
  toolCall(s, 'p1', 'mcp__threadbear__pin', { url: '/tmp/x.png' });
  toolResult(s, 'p1');
  toolCall(s, 'e3', END_TURN, { needs: 'nothing' });
  r = await call('end_turn', { needs: 'nothing' });
  assert.equal(r.error, false);
  assert.match(r.text, /done/);
  assert.deepEqual(slept, []);
});

// The summary is the turn's reply (docs/protocol.md, "The summary"): in 36
// test sessions Opus left its final message as prose, and put bullets in
// end_turn every time (29 Oct 2026).
test('end_turn with a summary needs no message first, and the runner writes it as the reply', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  s.text('m1', 'Looking at the slug code.');
  toolCall(s, 'b1', 'Bash', { command: 'npm test', description: 'Run the tests' });
  toolResult(s, 'b1');
  const input = { summary: ['- Fixed the slug bug.', '[Tests pass](work:npm test).'], asks: [{ action: 'Redirect the old URLs?', why: 'Two posts move.' }] };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  assert.equal(r.error, false);
  assert.match(r.text, /Needs you/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  const summary = h.events(thread.id).find((e) => e.type === 'assistant.text' && 'summary' in e && e.summary);
  assert.ok(summary, 'a summary text after the call');
  assert.equal(summary.type === 'assistant.text' && summary.text, '- Fixed the slug bug.\n- [Tests pass](work:npm test).');
  assert.equal(summary.type === 'assistant.text' && summary.itemId, 'e1.summary');
  assert.match(h.runner.get(thread.id).preview ?? '', /^- Fixed the slug bug/);
  // Text written after it is dropped, as after any accepted end_turn.
  s.text('m2', 'All in the card above.');
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && e.text === 'All in the card above.'));
  s.out({ kind: 'event', event: { type: 'reasoning', itemId: 'r1', text: "I'd already wrapped up." } });
  assert.ok(!h.events(thread.id).some((e) => e.type === 'reasoning'), 'thinking after it is dropped too');
  s.result('completed');
  await tick();
  // needs came from the asks.
  assert.equal(h.runner.get(thread.id).needs, 'you');
});

// Opus once sent its card four times in one turn (29 Oct 2026).
test('end_turn is taken once a turn', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  toolCall(s, 'e1', END_TURN, { summary: ['Done.'] });
  const r1 = await call('end_turn', { summary: ['Done.'] });
  assert.equal(r1.error, false);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r1.text, truncated: false, images: [] } });
  toolCall(s, 'e2', END_TURN, { summary: ['Done again.'] });
  const r2 = await call('end_turn', { summary: ['Done again.'] });
  assert.equal(r2.error, true);
  assert.match(r2.text, /Already ended/);
});

// Thread 46de9389 (7 Nov 2026): a `tb land` sent to the background finished
// just before the agent's "landing now" end_turn, in the same CLI turn. The
// CLI handed the agent its notification with that end_turn's result, and the
// real report's end_turn was refused, so the card kept "landing now".
test('a background task that finishes around end_turn opens the turn again once the agent has read it', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  const send = async (itemId: string, input: Record<string, unknown>) => {
    toolCall(s, itemId, END_TURN, input);
    const r = await call('end_turn', input);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
    return r;
  };
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Land" completed (exit code 0)', wake: true } });
  s.text('m1', 'tb land is still running. I will finish up when it lands.');
  const first = await send('e1', { headline: 'Landing now', needs: 'nothing' });
  assert.equal(first.error, false);
  // The agent reads the notification, and carries on.
  toolCall(s, 'b1', 'Bash', { command: 'git push' });
  toolResult(s, 'b1');
  s.text('m2', 'Landed on main and pushed.');
  const second = await send('e2', { headline: 'Landed and pushed', needs: 'nothing' });
  assert.equal(second.error, false, second.text);
  assert.ok(h.events(thread.id).some((e) => e.type === 'assistant.text' && e.text === 'Landed on main and pushed.'), 'the report is kept');
  assert.equal(h.runner.get(thread.id).preview, 'Landed and pushed');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(thread.id).preview, 'Landed and pushed');
});

// From Codex's review: a repeat the agent was already writing when the note
// came wasn't written with it, so it's refused, and the call after it is not.
test('a background task that finishes after end_turn opens the turn from the step after the next result', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  const send = async (itemId: string, input: Record<string, unknown>) => {
    toolCall(s, itemId, END_TURN, input);
    const r = await call('end_turn', input);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
    return r;
  };
  s.text('m1', 'Waiting on the build.');
  await send('e1', { headline: 'Building', needs: 'nothing', summary: ['Started the build.'] });
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Build" completed (exit code 0)', wake: true } });
  const stale = await send('e2', { headline: 'Building still', needs: 'nothing' });
  assert.equal(stale.error, true);
  assert.match(stale.text, /Already ended/);
  s.text('m2', 'The build passed, and here is what it found in full.');
  assert.ok(h.events(thread.id).some((e) => e.type === 'assistant.text' && e.itemId === 'm2'), 'the report is kept');
  assert.equal(h.runner.get(thread.id).preview, 'The build passed, and here is what it found in full.');
  const third = await send('e3', { headline: 'Built', needs: 'nothing' });
  assert.equal(third.error, false, third.text);
  assert.equal(h.runner.get(thread.id).preview, 'Built');
});

// From Codex's review: results that come back together are one step, so a
// Bash result just before end_turn's own doesn't count as the agent reading it.
test('a background task read with a batch of results opens the turn after the whole batch', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  s.text('m1', 'Pushing, and that is it.');
  toolCall(s, 'b1', 'Bash', { command: 'git push' });
  const input = { headline: 'Pushing', needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, input);
  const r1 = await call('end_turn', input);
  assert.equal(r1.error, false);
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Land" completed (exit code 0)', wake: true } });
  toolResult(s, 'b1');
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r1.text, truncated: false, images: [] } });
  s.text('m2', 'Landed and pushed.');
  assert.ok(h.events(thread.id).some((e) => e.type === 'assistant.text' && e.itemId === 'm2'), 'the report is kept');
  const again = { headline: 'Landed', needs: 'nothing' };
  toolCall(s, 'e2', END_TURN, again);
  const r2 = await call('end_turn', again);
  assert.equal(r2.error, false, r2.text);
});

// From Codex's review: the agent may stop without another end_turn while
// other background work runs, and the ask its reply had still stands.
test('one reply: an ask taken from the reply stands through a wake with no new end_turn', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const input = { headline: 'Ready', needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: !r.error, text: r.text, truncated: false, images: [] } });
  s.text('m1', 'It is ready.\n\n**What I need from you**\n1. Press Bring Them In, then tell me how it went.');
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Build" completed (exit code 0)', wake: true } });
  toolCall(s, 'b1', 'Bash', { command: 'cat build.log' });
  toolResult(s, 'b1');
  s.text('m2', 'The other build passed too.');
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(thread.id).needs, 'you');
});

// From Codex's review, round two: the SDK can run a call before its frame
// reaches the events, so a call with the wake handed over and no step since
// is the agent's step after reading it.
test('a background task handed over just before an end_turn whose frame has not landed yet', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Land" completed (exit code 0)', wake: true } });
  s.text('m1', 'Still landing.');
  const input = { headline: 'Landing', needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, input);
  const r1 = await call('end_turn', input);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r1.text, truncated: false, images: [] } });
  const r2 = await call('end_turn', { headline: 'Landed', needs: 'nothing', summary: ['Landed and pushed.'] });
  assert.equal(r2.error, false, r2.text);
});

test('two background tasks, the second after the first was handed over, open the turn twice', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  const send = async (itemId: string, input: Record<string, unknown>) => {
    toolCall(s, itemId, END_TURN, input);
    const r = await call('end_turn', input);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
    return r;
  };
  const note = (what: string) => s.out({ kind: 'event', event: { type: 'system.note', text: `Background command "${what}" completed (exit code 0)`, wake: true } });
  note('Build');
  s.text('m1', 'Waiting on the build and the tests.');
  await send('e1', { headline: 'Waiting', needs: 'nothing' });
  note('Tests');
  s.text('m2', 'The build passed.');
  assert.equal((await send('e2', { headline: 'Built', needs: 'nothing' })).error, false);
  s.text('m3', 'The tests passed too.');
  const third = await send('e3', { headline: 'Built and tested', needs: 'nothing' });
  assert.equal(third.error, false, third.text);
  assert.equal(h.runner.get(thread.id).preview, 'Built and tested');
});

test('one reply: a report written after a wake is marked as the reply too', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const input = { headline: 'Landing', needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: !r.error, text: r.text, truncated: false, images: [] } });
  s.text('m1', 'Still landing.');
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Land" completed (exit code 0)', wake: true } });
  toolCall(s, 'b1', 'Bash', { command: 'git push' });
  toolResult(s, 'b1');
  s.text('m2', 'Landed and pushed.');
  const m2 = h.events(thread.id).find((e: { type: string; itemId?: string }) => e.type === 'assistant.text' && e.itemId === 'm2');
  assert.equal(m2?.final, true);
});

test('a background task the agent had read before its end_turn still leaves a repeat refused', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  const send = async (itemId: string, input: Record<string, unknown>) => {
    toolCall(s, itemId, END_TURN, input);
    const r = await call('end_turn', input);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
    return r;
  };
  s.out({ kind: 'event', event: { type: 'system.note', text: 'Background command "Build" completed (exit code 0)', wake: true } });
  toolCall(s, 'b1', 'Bash', { command: 'cat build.log' });
  toolResult(s, 'b1');
  s.text('m1', 'The build passed.');
  await send('e1', { headline: 'Built', needs: 'nothing' });
  const again = await send('e2', { headline: 'Built again', needs: 'nothing' });
  assert.equal(again.error, true);
  assert.match(again.text, /Already ended/);
  assert.equal(h.runner.get(thread.id).preview, 'Built');
});

// Thread cdfccbc3 (1 Nov 2026): "Archive" sent from the phone just after
// end_turn, with both ways to do it refused. The agent scheduled a message to
// itself a minute later, and only that looked like an answer.
test('one reply: a message that arrives after end_turn can have the thread archived', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const result = (itemId: string, r: { text: string; error: boolean }) =>
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
  const first = { headline: 'Fixed', needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, first);
  result('e1', await call('end_turn', first));
  h.runner.send(thread.id, 'Archive');
  s.text('m1', 'That is fixed.');
  // The CLI finishes the turn it was on, then runs the message as its next,
  // all inside the one thread turn.
  const [firstId, secondId] = s.sent.map((m) => m.id!);
  s.result('completed', undefined, undefined, { answered: [firstId], answers: firstId, queuedTurns: 1 });
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
  const again = { headline: 'Archiving', needs: 'nothing', archive: true };
  toolCall(s, 'e2', END_TURN, again);
  const r = await call('end_turn', again);
  assert.equal(r.error, false);
  assert.match(r.text, /^Noted: this thread is done/);
  result('e2', r);
  s.text('m2', 'Archiving this now.');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
  s.result('completed', undefined, undefined, { answered: [secondId], answers: secondId, queuedTurns: 0 });
  await tick();
  assert.ok(h.runner.get(thread.id).archivedAt, 'archived once the turn is over');
});

// Thread 7ac017b7 (3 Nov 2026), from the card through to the event the app draws.
test('one reply: a reply that writes its card out again keeps the card and loses the repeat', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const input = { headline: 'Ready', asks: [{ question: 'Press Bring Them In on Tinker Desk.' }] };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: !r.error, text: r.text, truncated: false, images: [] } });
  s.text('m1', 'It is ready.\n\n**What I need from you**\n1. Press Bring Them In, then tell me how it went.');
  s.result('completed');
  const reply = h.events(thread.id).find((e: { type: string; itemId?: string }) => e.type === 'assistant.text' && e.itemId === 'm1');
  assert.equal(reply.text, 'It is ready.');
  assert.equal(reply.final, true);
  const t = h.runner.get(thread.id);
  assert.equal(t.needs, 'you');
  assert.deepEqual(t.asks?.map((a: { action: string }) => a.action), ['Press Bring Them In on Tinker Desk.']);
  assert.equal(h.events(thread.id).at(-1).needsFrom, 'tool');
});

test('a message after end_turn takes back an archive it asked for', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const input = { needs: 'nothing', archive: true };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  h.runner.send(thread.id, "Wait, don't, one more thing");
  const [firstId, secondId] = s.sent.map((m) => m.id!);
  s.result('completed', undefined, undefined, { answered: [firstId], answers: firstId, queuedTurns: 1 });
  s.text('m1', 'Sure, what is it?');
  s.result('completed', undefined, undefined, { answered: [secondId], answers: secondId, queuedTurns: 0 });
  await tick();
  assert.equal(h.runner.get(thread.id).status, 'idle', 'the turn is over');
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
});

test('a repeat end_turn with no new message: archive is added and the card stands, anything else is refused and changes nothing', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const send = async (itemId: string, input: Record<string, unknown>) => {
    toolCall(s, itemId, END_TURN, input);
    const r = await call('end_turn', input);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
    return r;
  };
  await send('e1', { headline: 'Fixed', needs: 'nothing', next: ['Do the next thing'] });
  s.text('m1', 'That is fixed.');
  // The refused one's card doesn't replace the one that was taken.
  const refused = await send('e2', { needs: 'you', asks: [{ question: 'Really?' }] });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Already ended/);
  const added = await send('e3', { needs: 'nothing', archive: true });
  assert.equal(added.error, false);
  assert.match(added.text, /will be archived/);
  const n = h.events(thread.id).filter((e) => e.type === 'assistant.text').length;
  s.result('completed');
  await tick();
  const t = h.runner.get(thread.id);
  assert.ok(t.archivedAt);
  const done = h.events(thread.id).filter((e) => e.type === 'turn.completed').at(-1) as { needs?: string; next?: string[] };
  assert.equal(done.needs, 'nothing');
  assert.deepEqual(done.next, ['Do the next thing']);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'assistant.text').length, n);
});

test('a repeat end_turn with no new message can add snooze, and the card stands', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const send = async (itemId: string, input: Record<string, unknown>) => {
    toolCall(s, itemId, END_TURN, input);
    const r = await call('end_turn', input);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId, ok: !r.error, text: r.text, truncated: false, images: [] } });
    return r;
  };
  await send('e1', { headline: 'Ordered', needs: 'nothing', next: ['Check the parts fit'] });
  s.text('m1', 'Ordered the parts.');
  const added = await send('e2', { headline: 'Hibernating', needs: 'nothing', snooze: '1d' });
  assert.equal(added.error, false);
  assert.match(added.text, /will hibernate/);
  s.result('completed');
  await tick();
  const t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, new Date(h.clock.now() + 86_400_000).toISOString());
  const done = h.events(thread.id).filter((e) => e.type === 'turn.completed').at(-1) as { next?: string[] };
  assert.deepEqual(done.next, ['Check the parts fit']);
});

test('end_turn refuses snooze "off" and over-long words, in both forms, so the agent can say it again', async () => {
  for (const oneReply of [true, false]) {
    const h = makeHarness();
    const { thread, s } = start(h);
    s.text('m1', 'Done.');
    const { call } = tools(h, thread.id, undefined, () => oneReply);
    const off = await call('end_turn', { needs: 'nothing', summary: ['Done.'], snooze: 'off' });
    assert.equal(off.error, true);
    assert.match(off.text, /^Not ended: snooze takes when/);
    const long = await call('end_turn', { needs: 'nothing', summary: ['Done.'], snooze: 'x'.repeat(301) });
    assert.equal(long.error, true);
    const fine = await call('end_turn', { needs: 'nothing', summary: ['Done.'], snooze: 'when the phone arrives' });
    assert.equal(fine.error, false, fine.text);
    if (!oneReply) assert.match(fine.text, /will be hibernated once the turn is over/);
  }
});

test('a repeat end_turn cannot archive a turn that is waiting on Mike', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  const asks = { needs: 'you', asks: [{ question: 'Deploy it?' }] };
  toolCall(s, 'e1', END_TURN, asks);
  const r = await call('end_turn', asks);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  const again = { needs: 'nothing', archive: true };
  toolCall(s, 'e2', END_TURN, again);
  const refused = await call('end_turn', again);
  assert.equal(refused.error, true);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e2', ok: false, text: refused.text, truncated: false, images: [] } });
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(thread.id).archivedAt, undefined);
  assert.equal(h.runner.get(thread.id).needs, 'you');
});

test("Codex's summary is the reply, and its final answer after it doesn't take over the preview", async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const t = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { provider: 'codex' }).find((x) => x.name === 'end_turn')!;
  toolCall(s, 'e1', END_TURN, { summary: ['Fixed it.'] });
  const r = (await t.handler({ summary: ['Fixed it.'] } as never, {})) as { content: { text: string }[]; isError?: boolean };
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /one short line/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.content[0].text, truncated: false, images: [] } });
  s.text('m1', 'Done.');
  const texts = h.events(thread.id).filter((e) => e.type === 'assistant.text');
  assert.deepEqual(texts.map((e) => e.type === 'assistant.text' && e.text), ['- Fixed it.', 'Done.']);
  assert.equal(h.runner.get(thread.id).preview, '- Fixed it.');
});

// Thread 66935d23, 29 Oct 2026: a walkthrough written in a narration block
// reached Mike as the API's one-paragraph summary of it, and the agent's
// rewrite after end_turn was dropped as a repeat.
test('a reply that came only as a summary: end_turn asks for it again, and the rewrite takes its place', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  const summary = "I've resent the full step-by-step setup instructions.";
  s.out({ kind: 'event', event: { type: 'assistant.text', itemId: 'm1:1', text: summary, narration: true } });
  toolCall(s, 'e1', END_TURN, { needs: 'you' });
  const r = await call('end_turn', { needs: 'you', asks: [{ action: 'Do step 1', why: 'It comes first.' }] });
  assert.equal(r.error, false, 'a summary is still a reply: no refusal loop');
  assert.match(r.text, /^Noted: this thread will wait in Needs you/);
  assert.match(r.text, /only a short summary of your last message/);
  assert.match(r.text, /Write the whole message again now, as ordinary text with nothing after it/);
  assert.doesNotMatch(r.text, /Stop here/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  // The rewrite, streamed then whole: kept, under the summary's itemId.
  s.out({ kind: 'delta', delta: { type: 'assistant.text.delta', itemId: 'm2:0', text: '**Step 1' } });
  s.text('m2:0', '**Step 1:** open the Claude app.\n\n**Step 2:** paste the prompt.');
  // Anything after that is a repeat again.
  s.text('m3:0', 'Over to you.');
  const texts = h.events(thread.id).filter((e) => e.type === 'assistant.text');
  assert.deepEqual(
    texts.map((e) => [e.itemId, e.text, e.type === 'assistant.text' && e.narration]),
    [
      ['m1:1', summary, true],
      ['m1:1', '**Step 1:** open the Claude app.\n\n**Step 2:** paste the prompt.', undefined],
    ],
  );
  assert.equal(h.runner.get(thread.id).preview, '**Step 1:** open the Claude app. **Step 2:** paste the prompt.');
  s.result('completed');
  // An agent reading the thread gets the reply, not the summary as well.
  const read = await call('read_thread', { threadId: thread.id });
  assert.match(read.text, /Step 2/);
  assert.doesNotMatch(read.text, /resent the full/);
});

test('end_turn asks once for a try at a step a card offers to take back, in both forms', async () => {
  const forms = [
    { oneReply: true, offering: { asks: [{ question: 'Turn on the setting.', options: [{ label: 'Done' }, { label: 'Can you do it?' }] }] }, plain: { asks: [{ question: 'Sign in to the store.', options: [{ label: 'Signed in' }, { label: 'Hold off' }] }] } },
    { oneReply: false, offering: { summary: ['Built it.'], asks: [{ action: 'Turn on the setting.', why: 'It stops it quitting.', options: ['Done', 'Can you do it?'] }] }, plain: { summary: ['Built it.'], asks: [{ action: 'Sign in to the store.', why: 'It needs your password.', options: ['Signed in', 'Hold off'] }] } },
  ];
  for (const { oneReply, offering, plain } of forms) {
    const h = makeHarness();
    const { thread, s } = start(h);
    s.text('m1', 'Built it.');
    const { call } = tools(h, thread.id, undefined, () => oneReply);
    toolCall(s, 'e1', END_TURN, offering);
    const refused = await call('end_turn', offering);
    assert.equal(refused.error, true);
    assert.match(refused.text, /^Not ended: this card offers/);
    assert.match(refused.text, /a password or code, a payment, something physical/);
    s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: false, text: refused.text, truncated: false, images: [] } });
    assert.equal(h.events(thread.id).filter((e) => e.type === 'tool.result' && e.itemId === 'e1').length, 1);

    // Once a turn: called again as it was, the card stands, button and all.
    s.text('m2', 'Tried it: it needs a code.');
    toolCall(s, 'e2', END_TURN, offering);
    const taken = await call('end_turn', offering);
    assert.equal(taken.error, false, taken.text);
    assert.deepEqual(needsFromTool(offering)?.asks?.[0].options, ['Done', 'Can you do it?']);

    // A card with no such answer is never held up.
    const other = makeHarness();
    const o = start(other);
    o.s.text('m1', 'Built it.');
    toolCall(o.s, 'e1', END_TURN, plain);
    const fine = await tools(other, o.thread.id, undefined, () => oneReply).call('end_turn', plain);
    assert.equal(fine.error, false, fine.text);
  }
});

test('bullet replies off: bullets alone are refused, and the summary gives way to the message', async () => {
  const h = makeHarness(undefined, { bulletReplies: false });
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, () => false);
  toolCall(s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(s, 'b1');
  const args = { summary: ['Fixed the loader bug; tests pass.'], needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, args);
  const refused = await call('end_turn', args);
  assert.equal(refused.error, true);
  assert.match(refused.text, /^Not ended/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: false, text: refused.text, truncated: false, images: [] } });
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && e.summary), 'no bullets from a refused call');

  s.text('m1:0', 'Fixed it.');
  toolCall(s, 'e2', END_TURN, args);
  const r = await call('end_turn', args);
  assert.equal(r.error, false);
  assert.doesNotMatch(r.text, /your bullets/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e2', ok: true, text: r.text, truncated: false, images: [] } });
  const summary = h.events(thread.id).find((e) => e.type === 'assistant.text' && e.summary);
  assert.ok(summary?.type === 'assistant.text' && summary.givesWay === true);
  assert.equal(h.runner.get(thread.id).preview, '- Fixed the loader bug; tests pass.', 'previews keep the bullets');
});

test('bullet replies off: a message that came only as narration is asked for again, and kept at any length', async () => {
  const h = makeHarness(undefined, { bulletReplies: false });
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, () => false);
  s.out({ kind: 'event', event: { type: 'assistant.text', itemId: 'm1:1', text: "I've explained the fix.", narration: true } });
  const args = { summary: ['Explained the fix in plenty of detail for you.'], needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, args);
  const r = await call('end_turn', args);
  assert.equal(r.error, false, 'no refusal loop');
  assert.match(r.text, /Write the whole message again now/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  s.text('m2:0', 'It was the loader.');
  s.text('m3:0', 'Over to you.');
  const texts = h.events(thread.id).filter((e) => e.type === 'assistant.text').map((e) => e.itemId);
  assert.deepEqual(texts, ['m1:1', 'e1.summary', 'm2:0']);
});

test('bullet replies off: Codex is asked for its whole final answer', async () => {
  const h = makeHarness(undefined, { bulletReplies: false });
  const { thread } = start(h);
  const list = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { provider: 'codex', bulletReplies: () => false });
  const t = list.find((x) => x.name === 'end_turn')!;
  const r = (await t.handler({ summary: ['Fixed it.'] } as never, {})) as { content: { text: string }[] };
  assert.equal(r.content[0].text, 'Noted. Now write your final answer: it ends the turn.');
});

// Thread 2a0a9c2c, 30 Oct 2026: asked for the details for a call to Qantas,
// Opus called end_turn with "Put together the details you'll need" as a
// bullet and wrote the details after it, where the runner dropped them.
test('bullets with no message since the last step: end_turn says stop without asking for more, and a message after it is kept', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  toolCall(s, 'b1', 'Bash', { command: 'browserbear read 1' });
  toolResult(s, 'b1');
  const args = { summary: ["Put together the details you'll need for the Qantas call."], needs: 'you', asks: [{ action: 'Tell me what they said.', why: 'So I can update the trip page.' }] };
  toolCall(s, 'e1', END_TURN, args);
  const r = await call('end_turn', args);
  assert.equal(r.error, false);
  assert.match(r.text, /^Noted: this thread will wait in Needs you/);
  assert.match(r.text, /Stop here, with no more text: the user has your bullets/);
  // Asking whether the bullets stood for more had every agent write a
  // prose repeat of them (30 Oct 2026).
  assert.doesNotMatch(r.text, /write it now|haven't written/);
  assert.doesNotMatch(r.text, /second message/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  // A line shorter than the bullets says no more than them: dropped.
  s.text('m1:0', 'Over to you.');
  // Thinking, as Opus did, then the details, streamed then whole.
  s.out({ kind: 'event', event: { type: 'reasoning', itemId: 'm2:0', text: 'The user has not got the details yet.' } });
  s.out({ kind: 'delta', delta: { type: 'assistant.text.delta', itemId: 'm2:1', text: '**Phone:**' } });
  s.text('m2:1', '**Phone:** 13 13 13\n\n**Bookings:** EXBEEI (you), E9SMYP (Kelsie and Joshua), last name CANN');
  // Anything after that is a repeat again.
  s.text('m3:0', 'Over to you. ' + 'x'.repeat(100));
  const texts = h.events(thread.id).filter((e) => e.type === 'assistant.text');
  assert.deepEqual(
    texts.map((e) => [e.itemId, e.text]),
    [
      ['e1.summary', "- Put together the details you'll need for the Qantas call."],
      ['m2:1', '**Phone:** 13 13 13\n\n**Bookings:** EXBEEI (you), E9SMYP (Kelsie and Joshua), last name CANN'],
    ],
  );
  assert.ok(!h.events(thread.id).some((e) => e.type === 'reasoning' && e.itemId === 'm2:0'), 'thinking after end_turn still goes');
  // The bullets stay the preview, as on the phone.
  assert.equal(h.runner.get(thread.id).preview, "- Put together the details you'll need for the Qantas call.");
});

test('bullets after a message: end_turn says stop, and text after it is dropped', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id);
  toolCall(s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(s, 'b1');
  s.text('m1:0', 'Tests pass. The bug was a missing await in the loader.');
  const args = { summary: ['Fixed the loader bug; tests pass.'], needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, args);
  const r = await call('end_turn', args);
  assert.equal(r.error, false);
  assert.match(r.text, /Stop here, with no more text/);
  assert.match(r.text, /nothing written now reaches them/);
  assert.doesNotMatch(r.text, /the user has your bullets/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  s.text('m2:0', 'Tests pass. The bug was a missing await in the loader.');
  const texts = h.events(thread.id).filter((e) => e.type === 'assistant.text');
  assert.deepEqual(texts.map((e) => e.itemId), ['m1:0', 'e1.summary']);
});

// Codex's final answer ends its turn, so its end_turn comes just before it.
// Told to call it after, Codex never did (28 Oct 2026).
test("Codex's end_turn comes before the final answer: never refused, and the answer after it is kept", async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const t = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { provider: 'codex' }).find((x) => x.name === 'end_turn')!;
  assert.match(t.description, /just before your final answer/);
  assert.doesNotMatch(t.description, /after your final message/);
  toolCall(s, 'b1', 'Bash', { command: 'gh pr view 384' });
  toolResult(s, 'b1');
  toolCall(s, 'e1', END_TURN, { needs: 'nothing' });
  const r = (await t.handler({ needs: 'nothing' } as never, {})) as { content: { text: string }[]; isError?: boolean };
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /Now write your final answer/);
  // Not the "ended" result, so the runner keeps the answer that follows.
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.content[0].text, truncated: false, images: [] } });
  s.text('m1', 'Looks fine. Nothing needed from you.');
  assert.ok(h.events(thread.id).some((e) => e.type === 'assistant.text' && e.text === 'Looks fine. Nothing needed from you.'));
});

// Codex's half of the 6 Nov fix: end_turn asked in "Ask before edits".
test("A Codex thread in ask mode ends its turn and reads without asking, and asks before changing anything", async () => {
  const h = makeHarness();
  const { thread } = start(h);
  const list = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { provider: 'codex', sleep: async () => {} });
  const asked: string[] = [];
  const codex = new CodexTools(list as ToolDefinition[], {
    requestApproval: async (r) => {
      asked.push(r.name.split('__').at(-1)!);
      return { decision: 'deny' };
    },
    cwd: () => '/tmp',
    mode: () => 'ask',
    rules: () => [],
    addRules: () => {},
  });
  const call = (tool: string, args: Record<string, unknown>) => codex.call({ threadId: 'n', turnId: 't', callId: tool, namespace: 'threadbear', tool, arguments: args }, { fromChild: false, signal: new AbortController().signal });
  assert.ok((await call('end_turn', { needs: 'nothing', summary: ['Checked it.'] })).success);
  assert.ok((await call('list_threads', {})).success);
  assert.deepEqual(asked, []);
  assert.equal((await call('send_message', { id: thread.id, text: 'hi' })).success, false);
  assert.deepEqual(asked, ['send_message']);
});

// A Codex thread's tool list is fixed when it starts, so what it was told
// end_turn takes can be from before One reply changed (1 Nov 2026, thread
// d8c829e8, refused for leaving out a question its schema never mentioned).
test("A Codex thread's end_turn is answered in the form the thread was given, whichever the setting is now", async () => {
  const h = makeHarness();
  const { thread } = start(h);
  const call = async (oneReply: boolean, args: Record<string, unknown>) => {
    const list = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { provider: 'codex', oneReply: () => oneReply, sleep: async () => {} });
    const codex = new CodexTools(list as ToolDefinition[], { requestApproval: async () => ({ decision: 'allow' }), cwd: () => '/tmp', mode: () => 'full', rules: () => [], addRules: () => {} });
    const r = await codex.call({ threadId: 'n', turnId: 't', callId: 'c', namespace: 'threadbear', tool: 'end_turn', arguments: args }, { fromChild: false, signal: new AbortController().signal });
    return { ok: r.success, text: r.contentItems.map((c) => ('text' in c ? c.text : '')).join('') };
  };
  const bulletsAsk = { needs: 'you', summary: ['Reopened the tab.'], asks: [{ action: 'Complete Google verification in Chrome.', why: 'The dashboard is behind it.', reply: 'done', options: ['Done'] }] };
  const oneReplyAsk = { headline: 'Needs Google verification', needs: 'you', asks: [{ question: 'Complete Google verification in Chrome.', options: [{ label: 'Done', does: 'I carry on' }] }] };
  const bullet = /Now write your final answer/;
  const reply = /Now write your reply/;
  for (const setting of [true, false]) {
    let r = await call(setting, bulletsAsk);
    assert.ok(r.ok, r.text);
    assert.match(r.text, bullet, 'a thread with the old form hears the old form back');
    r = await call(setting, oneReplyAsk);
    assert.ok(r.ok, r.text);
    assert.match(r.text, reply, "a one-reply call's reply is what the runner keeps");
    // No asks and a summary: bullets, or its summary would be lost.
    r = await call(setting, { needs: 'nothing', summary: ['Checked it.'] });
    assert.match(r.text, bullet);
    r = await call(setting, { headline: 'Checked it', needs: 'nothing' });
    assert.match(r.text, reply);
    // Written after being refused by an older runner: both at once.
    r = await call(setting, { needs: 'you', summary: ['Reopened the tab.'], asks: [{ question: 'Complete Google verification.' }] });
    assert.ok(r.ok, r.text);
    assert.match(r.text, reply);
    // Nothing to tell them apart: the setting's form.
    r = await call(setting, { needs: 'nothing' });
    assert.match(r.text, setting ? reply : bullet);
    // Still checked against the form it's in.
    r = await call(setting, { asks: [{ action: 'No why.' }] });
    assert.equal(r.ok, false);
    assert.match(r.text, /asks\[0\]\.why/);
  }
  // A new thread is only shown the setting's form.
  const shown = (oneReply: boolean) => buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, { provider: 'codex', oneReply: () => oneReply }).find((x) => x.name === 'end_turn')!.description;
  assert.notEqual(shown(true), shown(false));
});

// A resumed Claude session keeps the end_turn it first loaded, whatever the
// server lists now, so a call in the older form reaches a server on the newer
// one (1 Nov 2026, thread 1b770c6a: refused with a bare zod error). These go
// through the real MCP server, as its own validation is what refused it.
function mcpClient(h: ReturnType<typeof makeHarness>, selfId: string, oneReply: boolean) {
  const server = threadbearMcpServer(h.runner, selfId, undefined, undefined, undefined, () => true, undefined, () => oneReply);
  const waiting = new Map<number, (r: { result?: { tools?: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] }; description: string }[]; content?: { text: string }[]; isError?: boolean } }) => void>();
  const transport = {
    onmessage: undefined as undefined | ((m: unknown) => void),
    start: async () => {},
    close: async () => {},
    send: async (m: { id: number; result: never }) => void waiting.get(m.id)?.(m),
  };
  let id = 0;
  const request = async (method: string, params: unknown) => {
    await (server.instance as unknown as { connected?: boolean; connect: (t: unknown) => Promise<void> }).connect(transport).catch(() => {});
    const n = ++id;
    return new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>((resolve) => {
      waiting.set(n, resolve);
      transport.onmessage!({ jsonrpc: '2.0', id: n, method, params });
    });
  };
  return {
    endTurnShown: async () => (await request('tools/list', {})).result!.tools!.find((t) => t.name === 'end_turn')!,
    endTurn: async (args: Record<string, unknown>) => {
      const { result } = await request('tools/call', { name: 'end_turn', arguments: args });
      return { text: result!.content!.map((c) => c.text).join('\n'), error: Boolean(result!.isError) };
    },
  };
}

const OLD_ASK = { summary: ['Worked out the story.'], needs: 'you', asks: [{ action: 'Which story should be the spine?', why: "Once you pick, I'll build it.", options: ['No state', 'One database'], suggested: 0 }] };

test('A Claude session on the older end_turn, with its message written, is taken as it is, under one reply', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const mcp = mcpClient(h, thread.id, true);
  s.text('m1', 'Here is the whole story, as the old description said to write it first.');
  toolCall(s, 'e1', END_TURN, OLD_ASK);
  const r = await mcp.endTurn(OLD_ASK);
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /Stop here/);
  assert.match(r.text, /your message above is the reply/);
  assert.doesNotMatch(r.text, /Now write your reply/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  // Its message is the reply: the bullets don't come in over it.
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && e.summary));
  s.result('completed');
  await tick();
  const card = h.runner.get(thread.id);
  assert.equal(card.needs, 'you');
  assert.equal(card.asks?.[0]?.action, 'Which story should be the spine?');
  assert.deepEqual(card.asks?.[0]?.options, ['No state', 'One database']);
  assert.equal(card.asks?.[0]?.suggested, 0);
});

test('A Claude session on the older end_turn with no message yet is asked for it, and that is the reply', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const mcp = mcpClient(h, thread.id, true);
  toolCall(s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(s, 'b1');
  toolCall(s, 'e1', END_TURN, OLD_ASK);
  const r = await mcp.endTurn(OLD_ASK);
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /Now write your reply/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  s.text('m1', 'The tests pass.');
  const reply = h.events(thread.id).find((e) => e.type === 'assistant.text' && e.itemId === 'm1');
  assert.ok(reply && reply.type === 'assistant.text' && reply.final);
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && e.summary));
});

// The other way round: One reply turned off. This CLI ends the turn at an
// accepted end_turn (adapter.ts, terminalMcpTools), so "write your reply next"
// would never be read: it's the bullets handler that has to answer.
test('A Claude session on the one-reply end_turn, with One reply off, writes its reply first', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const mcp = mcpClient(h, thread.id, false);
  const input = { headline: 'Needs a pick', asks: [{ question: 'Which story?', options: [{ label: 'No state', does: 'I prototype it' }] }] };
  toolCall(s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(s, 'b1');
  toolCall(s, 'e1', END_TURN, input);
  const refused = await mcp.endTurn(input);
  assert.equal(refused.error, true);
  assert.match(refused.text, /Please write the whole answer as ordinary text/);
  s.text('m1', 'Three stories, here they are.');
  toolCall(s, 'e2', END_TURN, input);
  const r = await mcp.endTurn(input);
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^Noted: this thread will wait in Needs you/);
  assert.doesNotMatch(r.text, /Now write your reply/);
});

test("end_turn lists only today's form, whichever forms it takes", async () => {
  const h = makeHarness();
  const { thread } = start(h);
  const one = await mcpClient(h, thread.id, true).endTurnShown();
  assert.deepEqual(Object.keys(one.inputSchema.properties).sort(), ['archive', 'asks', 'byline', 'headline', 'needs', 'next', 'snooze', 'waitFor']);
  assert.ok(!one.inputSchema.required?.length, 'every field is optional');
  const ask = (one.inputSchema.properties.asks as { items: { required: string[]; properties: Record<string, { description?: string; items?: { type?: string } }> } }).items;
  assert.deepEqual(ask.required, ['question']);
  assert.equal(ask.properties.options.items?.type, 'object');
  assert.match(ask.properties.question.description ?? '', /One sentence/);
  assert.match((one.inputSchema.properties.headline as { description: string }).description, /for the sidebar/);
  const bullets = await mcpClient(h, thread.id, false).endTurnShown();
  assert.ok('summary' in bullets.inputSchema.properties);
  assert.ok(!('headline' in bullets.inputSchema.properties));
});

test("An end_turn that fits neither form hears today's shape and order in words", async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const garbled = { asks: [{ question: 'Which one?', options: ['A string, in the wrong form'] }] };
  toolCall(s, 'e1', END_TURN, garbled);
  const one = await mcpClient(h, thread.id, true).endTurn(garbled);
  assert.equal(one.error, true);
  assert.match(one.text, /asks\[0\]\.options\[0\]/);
  assert.match(one.text, /\{ headline\?, needs\?, asks\?: \{ question, options\?: \{ label, does\? \}\[\], suggested\?, links\? \}\[\], next\?, archive\?, snooze\?, waitFor\? \}/);
  assert.match(one.text, /then write your reply after it/);
  assert.doesNotMatch(one.text, /MCP error/);
  const old = await mcpClient(h, thread.id, false).endTurn({ needs: 'maybe' });
  assert.equal(old.error, true);
  assert.match(old.text, /\{ needs\?, summary\?: string\[\], asks\?: \{ action, why/);
  assert.match(old.text, /after writing your reply/);
});

// The SDK runs the tool as soon as it reads the call, so the handler can run
// before the runner has logged the frames before it.
test("end_turn waits for its own call to land, and takes a call that never lands (a sub-agent's) at its word", async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call, slept } = tools(h, thread.id);
  // The text and the call arrive while the handler is waiting.
  let polls = 0;
  const late = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, undefined, {
    sleep: async () => {
      if (++polls === 3) {
        s.text('m1', 'All done.');
        toolCall(s, 'e1', END_TURN, { needs: 'nothing' });
      }
    },
  }).find((x) => x.name === 'end_turn')!;
  const r = (await late.handler({ needs: 'nothing' } as never, {})) as { isError?: boolean };
  assert.equal(r.isError, undefined);
  assert.equal(polls, 3);
  // Never lands: acknowledged after the wait, as the events can't judge it.
  toolResult(s, 'e1');
  toolCall(s, 'b1', 'Bash', { command: 'ls' });
  toolResult(s, 'b1');
  const r2 = await call('end_turn', { needs: 'nothing' });
  assert.equal(r2.error, false);
  assert.ok(slept.length >= 20 && slept.every((ms) => ms === 50), `waited about a second in short sleeps: ${slept.length}`);
});

// ------------------------------------------------------------ instructions

// The CLI defers MCP tools (an agent sees only their names), so the server's
// instructions are the one place sure to tell an agent when to reach for
// show_options and pin. Without them an agent pinned three mockups and asked
// Mike to choose in chat.
test('both instruction texts say when to use show_options and pin', async () => {
  const { threadbearMcpServer } = await import('../../src/threadbear-mcp.ts');
  const { TOOL_GUIDANCE } = await import('../../src/adapters/codex/tools.ts');
  const claude = threadbearMcpServer({} as never, 'self');
  const instructions = (claude.instance as unknown as { server: { _instructions?: string } }).server._instructions ?? '';
  for (const [who, text] of [['claude', instructions], ['codex', TOOL_GUIDANCE]] as const) {
    assert.match(text, /show_options/, who);
    assert.match(text, /\bpin\b/, who);
  }
});

// The Pocket lives in the Convex backend, so with phone sync off the tool
// isn't offered. Its instruction line was there anyway, telling agents in
// every such copy (a fork with no Convex yet, say) to use a tool they didn't
// have (4 Nov 2026).
test('only a thread that has the pocket tool is told to use it, Claude or Codex', async () => {
  const { threadbearMcpServer } = await import('../../src/threadbear-mcp.ts');
  const { toolGuidance } = await import('../../src/adapters/codex/tools.ts');
  const instructionsOf = (pocket?: () => never) => {
    const server = threadbearMcpServer({} as never, 'self', undefined, undefined, undefined, () => true, pocket);
    return (server.instance as unknown as { server: { _instructions?: string } }).server._instructions ?? '';
  };
  assert.doesNotMatch(instructionsOf(), /\bpocket\b/);
  assert.doesNotMatch(instructionsOf(() => undefined as never), /\bpocket\b/);
  assert.match(instructionsOf(() => ({}) as never), /file it on their phone with pocket/);
  const def = (name: string) => ({ name, description: '', inputSchema: {} }) as unknown as ToolDefinition;
  assert.doesNotMatch(toolGuidance([def('pin')]), /\bpocket\b/);
  assert.match(toolGuidance([def('pin'), def('pocket')]), /file it on their phone with pocket/);
});

// A new user's first thread asked how the app works, and with nothing to
// read the agent searched the disk for threadbear*, setting off macOS's
// folder prompts. Every thread, Claude or Codex, is now pointed at the guide.
test('the guide is in the checkout a release was built from, or two folders up from a source runner', async () => {
  const { guidePath } = await import('../../src/threadbear-mcp.ts');
  assert.equal(guidePath({ checkout: '/Users/someone/threadbear' }, '/ignored'), '/Users/someone/threadbear/docs/guide.md');
  assert.equal(guidePath(undefined, '/src/repo'), '/src/repo/docs/guide.md');
  // A release from before releases recorded their checkout.
  assert.equal(guidePath({}, '/src/repo'), '/src/repo/docs/guide.md');
  // This test runs from a checkout, whose repo has the guide.
  assert.ok(fs.existsSync(guidePath(undefined)), guidePath(undefined));
});

test('the guide line names the guide and the repo, and is left out when the guide is missing', async () => {
  const { guideLine } = await import('../../src/threadbear-mcp.ts');
  const line = guideLine('/Users/someone/threadbear/docs/guide.md', () => true);
  assert.match(line, /\/Users\/someone\/threadbear\/docs\/guide\.md/);
  assert.match(line, /code are in \/Users\/someone\/threadbear\./);
  assert.match(line, /Don't search the filesystem/);
  assert.equal(guideLine('/nowhere/docs/guide.md', () => false), '');
});

test('the patches line sends button and panel asks to a patch file, by the protocol beside the guide', async () => {
  const { patchesLine } = await import('../../src/threadbear-mcp.ts');
  const line = patchesLine('/Users/someone/threadbear/docs/guide.md', () => true);
  assert.match(line, /\.threadbear\/patches\/<name>\.ts/);
  assert.match(line, /\/Users\/someone\/threadbear\/docs\/protocol\.md/);
  assert.match(line, /Edit or Write/);
  assert.match(line, /not a pin/);
  assert.equal(patchesLine('/nowhere/docs/guide.md', () => false), '');
});

test("a Claude or Codex thread's instructions point at the guide", async () => {
  const { guidePath, threadbearMcpServer } = await import('../../src/threadbear-mcp.ts');
  const { TOOL_GUIDANCE } = await import('../../src/adapters/codex/tools.ts');
  const server = threadbearMcpServer({} as never, 'self');
  const instructions = (server.instance as unknown as { server: { _instructions?: string } }).server._instructions ?? '';
  assert.ok(instructions.includes(guidePath()), instructions);
  assert.ok(TOOL_GUIDANCE.includes(guidePath()), TOOL_GUIDANCE);
});

// A turn that wrote its message and stopped is nudged to call end_turn, told
// "your message above is the reply". Asking for a reply after that got a
// second one that took the first's place: thread 9bc89060's real answer folded
// under "The bear picture test is still waiting on you", and a77c6b42's 2,359
// characters under 96 (1 Nov 2026).
test('one reply: an end_turn the Stop hook asked for keeps the message already written', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  toolCall(s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(s, 'b1');
  s.text('m1', 'The tests pass, and here is what they cover in full.');
  s.out({ kind: 'endTurnNudge' });
  const input = { headline: 'Tests pass', needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  assert.equal(r.error, false);
  assert.doesNotMatch(r.text, /Now write your reply/);
  assert.match(r.text, /^Noted: this thread is done/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  assert.equal(h.runner.get(thread.id).preview, 'Tests pass');
  // Anything it writes anyway is a repeat, and doesn't reach Mike.
  s.text('m2', 'All done.');
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && e.itemId === 'm2'));
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && e.final));
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(thread.id).needs, 'nothing');
});

test("end_turn tells the agent which sub-agents are parked on a card", async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const one = tools(h, thread.id, undefined, () => true);
  void s.sink.requestApproval({ name: 'Write', title: 'Write a.ts', input: {}, canAlwaysAllow: false, signal: new AbortController().signal });
  toolCall(s, 'e1', END_TURN, {});
  const said = (await one.call('end_turn', {})).text;
  assert.match(said, /^Noted: this thread/);
  assert.match(said, /Now write your reply/);
  assert.match(said, /A sub-agent of yours is parked until the user answers an approval card in this thread, not working: "Write a\.ts"/);
});

test('one reply: a nudged end_turn with no message to keep still asks for the reply', async () => {
  const h = makeHarness();
  // No words since its last step.
  const first = start(h);
  const one = tools(h, first.thread.id, undefined, () => true);
  first.s.text('m1', 'Starting on it.');
  toolCall(first.s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(first.s, 'b1');
  first.s.out({ kind: 'endTurnNudge' });
  toolCall(first.s, 'e1', END_TURN, {});
  assert.match((await one.call('end_turn', {})).text, /Now write your reply/);
  // Only a narration block, which is a paraphrase of what it wrote.
  const second = start(h);
  const two = tools(h, second.thread.id, undefined, () => true);
  second.s.out({ kind: 'event', event: { type: 'assistant.text', itemId: 'n1', text: 'It explained the fix.', narration: true } });
  second.s.out({ kind: 'endTurnNudge' });
  toolCall(second.s, 'e2', END_TURN, {});
  assert.match((await two.call('end_turn', {})).text, /Now write your reply/);
  // A turn nudged earlier doesn't carry over to the next one.
  second.s.result('completed');
  await tick();
  assert.equal(h.runner.endTurnNudged(second.thread.id), false);
});

// 5 Nov 2026, thread 1d9689e6: a Slack draft for Mike to approve was
// written before end_turn, as narration, and the reply after it was "Nothing
// has been sent yet." Words since the last step fold away with one reply, so
// the result asks for a self-contained answer; words before a step don't count.
test('one reply: after hidden text, end_turn asks for the answer and evidence, including drafts', async () => {
  const h = makeHarness();
  const again = /self-contained answer with the result and supporting evidence/;
  const input = { headline: 'Draft update for Jamie ready to send', asks: [{ question: 'Send the Hetzner update to Jamie in your Slack DM?', options: [{ label: 'Send it' }, { label: "I'll edit and send" }] }] };
  // The draft as narration, straight before the call.
  const first = start(h);
  const one = tools(h, first.thread.id, undefined, () => true);
  toolCall(first.s, 'b1', 'Bash', { command: 'slack-read D081T2X5SG6' });
  toolResult(first.s, 'b1');
  first.s.out({ kind: 'event', event: { type: 'assistant.text', itemId: 'n1', text: 'The Hetzner Linux runner is up and sits in threadbear beside your Mac and Bruce.', narration: true } });
  toolCall(first.s, 'e1', END_TURN, input);
  let r = await one.call('end_turn', input);
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /Now write your reply/);
  assert.match(r.text, again);
  assert.match(r.text, /If the user needs a draft or descriptions of choices/);
  assert.doesNotMatch(r.text, /thinking|working|write it again/i);
  // Plain text counts too, and a done turn hears it as well.
  const second = start(h);
  const two = tools(h, second.thread.id, undefined, () => true);
  second.s.text('m1', 'Three ways to share pools: A, B and C, and here is each.');
  toolCall(second.s, 'e2', END_TURN, { headline: 'Laid out three designs', needs: 'nothing' });
  r = await two.call('end_turn', { headline: 'Laid out three designs', needs: 'nothing' });
  assert.match(r.text, /^Noted: this thread is done/);
  assert.match(r.text, again);
  assert.match(r.text, /Include any requested draft, explanation or descriptions of choices in full/);
  // A status line before a step is just working: nothing to write again.
  const third = start(h);
  const three = tools(h, third.thread.id, undefined, () => true);
  third.s.text('m1', 'Checking the DM with Jamie first.');
  toolCall(third.s, 'b1', 'Bash', { command: 'slack-read D081T2X5SG6' });
  toolResult(third.s, 'b1');
  toolCall(third.s, 'e3', END_TURN, input);
  r = await three.call('end_turn', input);
  assert.match(r.text, /Now write your reply/);
  assert.doesNotMatch(r.text, again);
  assert.match(r.text, /If the user needs a draft or descriptions of choices/, 'what the asks are about always goes in the reply');
});

// One reply (docs/protocol.md, "One reply"; 1 Nov 2026): end_turn carries
// the card and a headline, and the message after it is the reply.
test('one reply: end_turn takes the card, never asks for a message first, and says the reply comes next', async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call, list } = tools(h, thread.id, undefined, () => true);
  const t = list.find((x) => x.name === 'end_turn');
  assert.match(t?.description ?? '', /write your reply as ordinary text straight after it/);
  assert.ok(!('summary' in (t?.inputSchema ?? {})), 'no bullets to fill in');
  toolCall(s, 'b1', 'Bash', { command: 'npm test' });
  toolResult(s, 'b1');
  // No words since the last step: fine, the reply comes after.
  const input = { headline: 'Limit fixed and committed; deploy waits on you', asks: [{ question: 'Deploy main to production?', options: [{ label: 'Deploy it', does: 'I deploy and check it went out' }, { label: 'Hold off' }], suggested: 0 }] };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  assert.equal(r.error, false);
  assert.match(r.text, /^Noted: this thread will wait in Needs you/);
  assert.match(r.text, /Now write your reply/);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  // No summary is written: the reply is the next message.
  assert.ok(!h.events(thread.id).some((e) => e.type === 'assistant.text' && 'summary' in e && e.summary));
  assert.equal(h.runner.get(thread.id).preview, 'Limit fixed and committed; deploy waits on you');
  // The reply streams, then lands whole, marked final.
  s.out({ kind: 'delta', delta: { type: 'assistant.text.delta', itemId: 'm1', text: 'Users now get 3' } });
  s.text('m1', 'Users now get 3 requests a day. A deploy also sends #48 and #49.');
  const reply = h.events(thread.id).find((e) => e.type === 'assistant.text' && e.itemId === 'm1');
  assert.ok(reply && reply.type === 'assistant.text' && reply.final, 'the reply is kept and marked final');
  // The headline stays the preview.
  assert.equal(h.runner.get(thread.id).preview, 'Limit fixed and committed; deploy waits on you');
  s.result('completed');
  await tick();
  const card = h.runner.get(thread.id);
  assert.equal(card.needs, 'you');
  // A second call in the same turn is refused, as before.
  const again = await call('end_turn', input);
  assert.equal(again.error, true);
});

test('one reply: a question and answers with notes become an ask with option notes', () => {
  const needs = needsFromTool({ asks: [{ question: 'Deploy main to production?', options: [{ label: 'Deploy it', does: 'I deploy and check it went out' }, { label: 'Hold off' }], suggested: 0 }] });
  assert.deepEqual(needs, { needs: 'you', asks: [{ action: 'Deploy main to production?', options: ['Deploy it', 'Hold off'], optionNotes: ['I deploy and check it went out', ''], suggested: 0 }] });
  // Plain labels, as before: no notes.
  assert.deepEqual(needsFromTool({ asks: [{ action: 'Merge?', options: ['Merge', 'Wait'] }] }), { needs: 'you', asks: [{ action: 'Merge?', options: ['Merge', 'Wait'] }] });
});

test("one reply: a reply that ends in a What I need from you section gives the card, and loses the section", async () => {
  const h = makeHarness();
  const { thread, s } = start(h);
  const { call } = tools(h, thread.id, undefined, () => true);
  toolCall(s, 'b1', 'Bash', { command: 'git commit -m fix' });
  toolResult(s, 'b1');
  // Sonnet's way: needs nothing and no asks, with the ask in the reply.
  const input = { needs: 'nothing' };
  toolCall(s, 'e1', END_TURN, input);
  const r = await call('end_turn', input);
  s.out({ kind: 'event', event: { type: 'tool.result', itemId: 'e1', ok: true, text: r.text, truncated: false, images: [] } });
  s.text('m1', "I fixed the off-by-one and committed it. I haven't deployed.\n\nWhat I need from you:\n1. Tell me whether to deploy `02057bb`.");
  const reply = h.events(thread.id).find((e) => e.type === 'assistant.text' && e.itemId === 'm1');
  assert.equal(reply?.type === 'assistant.text' && reply.text, "I fixed the off-by-one and committed it. I haven't deployed.");
  s.result('completed');
  await tick();
  assert.equal(h.runner.get(thread.id).needs, 'you');
});

// ------------------------------------------------------------ other runners' threads

// Another runner's thread, reached through the backend as the Mac app does
// (relay.ts): list_threads lists and searches it with its runner, read_thread
// reads its messages, send_message queues a send for that runner. On 6 Nov
// an M5 thread was told there was no "Rust port" thread when Mike's sidebar
// showed it on the cloud runner.
function farRelay(opts: { takes?: boolean } = {}) {
  const at = (s: number) => new Date(Date.parse('2026-10-26T11:00:00Z') + s * 1000).toISOString();
  const FAR = 'ba5bb5ec-15bf-4382-9812-2b0fe15f4087';
  const rows: RelayRow[] = [
    { seq: 3, role: 'user', text: 'Port the runner to Rust for Linux', turn: 't1', at: at(0) },
    { seq: 5, role: 'tool', text: 'Ran cargo build', toolKind: 'command', turn: 't1', at: at(2) },
    { seq: 9, role: 'assistant', text: 'The Linux build runs.', turn: 't1', at: at(10) },
  ];
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const clock = new FakeClock();
  const remote: RemoteThreads = {
    runners: [{ id: 'cloud', name: 'Cloud', online: true, lastSeenAt: at(0) }],
    threads: [
      { runnerId: 'cloud', threadId: FAR, title: 'Rust port for Linux and Windows', cwd: '/root/dev/threadbear', accountId: 'claude-main', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: 'The Linux build runs.', createdAt: at(0), lastActivityAt: at(10) },
      { runnerId: 'cloud', threadId: 'aaaa0000-old', title: 'Old cloud thing', cwd: '/root', accountId: 'claude-main', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: at(0), lastActivityAt: at(0), archivedAt: at(1) },
    ],
  };
  const relay = new Relay({
    source: () => ({
      key: 'owner',
      post: async (_kind, fn, args) => {
        calls.push({ fn, args });
        if (fn === 'relay:remoteThread') return { runnerId: 'cloud', status: 'idle', needs: 'nothing' };
        if (fn === 'relay:remoteMessages') return { messages: args.beforeSeq ? [] : rows, hasMore: false };
        if (fn === 'relay:queueCommand') return 'cmd1';
        return null;
      },
      // That runner takes the command at once, or (takes: false) never answers.
      subscribe: (fn, _args, onUpdate) => {
        if (fn === 'relay:commandState' && opts.takes !== false) queueMicrotask(() => onUpdate({ state: 'done' }));
        return () => undefined;
      },
    }),
    remote: () => remote,
    subscribed: () => false,
    publish: () => undefined,
    clock,
    log: nullLogger,
  });
  const control: RemoteControl = { list: async () => remote, call: (id, method, p) => relay.call(id, method, { threadId: id, ...p }) };
  return { FAR, calls, control, relay, clock };
}

function toolsWith(h: ReturnType<typeof makeHarness>, selfId: string, remote?: RemoteControl) {
  const list = buildThreadbearTools(h.runner, selfId, () => Date.parse('2026-10-26T12:00:00Z'), undefined, undefined, undefined, { remote: () => remote, sleep: async () => undefined });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await list.find((x) => x.name === name)!.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
}

test("another runner's threads: listed with their runner, searched, read and messaged through the backend", async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Review the YouTube comments');
  const f = farRelay();
  const call = toolsWith(h, me.id, f.control);

  const inbox = await call('list_threads');
  assert.match(inbox.text, /ba5bb5ec {2}Rust port for Linux and Windows {2}\[idle, inbox, on Cloud\]/);
  assert.match(inbox.text, /Review the YouTube comments/);
  assert.doesNotMatch(inbox.text, /Old cloud thing/, 'archived stays out of the inbox');
  // Newest activity first: this thread (just made) is newer than the cloud one.
  assert.ok(inbox.text.indexOf('Review the YouTube') < inbox.text.indexOf('Rust port'));
  assert.match((await call('list_threads', { include: ['archived'] })).text, /Old cloud thing {2}\[idle, archived, on Cloud\]/);
  const found = await call('list_threads', { query: 'rust', include: ['inbox', 'snoozed', 'archived'] });
  assert.match(found.text, /Rust port .*on Cloud/);
  assert.doesNotMatch(found.text, /YouTube/);

  const read = await call('read_thread', { threadId: 'ba5bb5ec' });
  assert.equal(read.error, false, read.text);
  assert.match(read.text, /title: Rust port for Linux and Windows/);
  assert.match(read.text, /runner: Cloud/);
  assert.match(read.text, /User \(.*\):\nPort the runner to Rust for Linux/);
  assert.match(read.text, /Agent \(.*\):\nThe Linux build runs\./);
  assert.doesNotMatch(read.text, /cargo build/, 'tool calls left out, as for this runner\'s threads');

  const sent = await call('send_message', { threadId: 'ba5bb5ec', text: 'How far did the Linux port get?' });
  assert.equal(sent.error, false, sent.text);
  assert.match(sent.text, /Sent to ba5bb5ec "Rust port for Linux and Windows" on Cloud/);
  const q = f.calls.find((c) => c.fn === 'relay:queueCommand')!;
  assert.equal(q.args.threadId, f.FAR);
  assert.equal(q.args.kind, 'send');
  assert.match(String((q.args.args as { text: string }).text), /^\[Sent by the agent in the thread "Review the YouTube comments"[\s\S]*How far did the Linux port get\?$/);

  // The tools that change a thread here say where it is, not that it's missing.
  const moved = await call('update_thread', { threadId: 'ba5bb5ec', title: 'x' });
  assert.equal(moved.error, true);
  assert.match(moved.text, /runs on Cloud/);
});

test("another runner's thread can be archived, snoozed and stopped, and says it was an agent; nothing else changes there", async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Tidier');
  const f = farRelay();
  const call = toolsWith(h, me.id, f.control);
  const updates = () => f.calls.filter((c) => c.fn === 'relay:queueCommand').map((c) => ({ kind: c.args.kind, args: c.args.args }));

  const archived = await call('update_thread', { threadId: 'ba5bb5ec', archived: true });
  assert.equal(archived.error, false, archived.text);
  assert.match(archived.text, /"Rust port for Linux and Windows" on Cloud is archived/);
  assert.deepEqual(updates().at(-1), { kind: 'update', args: { archive: true, by: 'agent' } });

  const snoozed = await call('update_thread', { threadId: 'ba5bb5ec', snooze: '2h' });
  assert.equal(snoozed.error, false, snoozed.text);
  assert.deepEqual(updates().at(-1), { kind: 'update', args: { snooze: { until: '2026-10-26T14:00:00.000Z' } } });
  await call('update_thread', { threadId: 'ba5bb5ec', snooze: 'off' });
  assert.deepEqual(updates().at(-1), { kind: 'update', args: { wake: true } });

  const stopped = await call('interrupt_thread', { threadId: 'ba5bb5ec' });
  assert.equal(stopped.error, false, stopped.text);
  assert.match(stopped.text, /Asked Cloud to stop "Rust port/);
  assert.equal(updates().at(-1)!.kind, 'interrupt');

  // A title, model, pool or mode stays with that runner; nothing is queued.
  const before = updates().length;
  for (const args of [{ title: 'x' }, { model: 'opus' }, { permissionMode: 'ask' }, { snooze: 'release' }, {}]) {
    const r = await call('update_thread', { threadId: 'ba5bb5ec', ...args });
    assert.equal(r.error, true, JSON.stringify(args));
  }
  assert.equal(updates().length, before);
  // Moves and deletes still say where it is.
  assert.match((await call('move_thread', { threadId: 'ba5bb5ec', folder: '/tmp' })).text, /runs on Cloud/);
});

test("a message another runner hasn't taken yet is said to be queued, not sent", async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Asker');
  const f = farRelay({ takes: false });
  const call = toolsWith(h, me.id, f.control);
  const sending = call('send_message', { threadId: 'ba5bb5ec', text: 'Hello?' });
  await tick();
  f.clock.advance(20_000);
  const r = await sending;
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^Queued for ba5bb5ec .* on Cloud, which hasn't picked it up yet/);
});

test("without the backend (sync off, or a runner key) the tools list only this runner's threads", async () => {
  const h = makeHarness();
  const { thread: me } = start(h, 'Local only');
  const call = toolsWith(h, me.id, undefined);
  assert.doesNotMatch((await call('list_threads', { query: 'rust' })).text, /Rust/);
  assert.match((await call('read_thread', { threadId: 'ba5bb5ec' })).text, /No thread with id ba5bb5ec/);
  // And a backend that fails leaves the local list working.
  const broken = toolsWith(h, me.id, { list: async () => { throw new Error('offline'); }, call: async () => { throw new Error('offline'); } });
  assert.match((await broken('list_threads')).text, /Local only/);
});
