import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeNormalizer, wroteFromResult, type NormalizerContext } from '../../src/adapters/claude/normalize.ts';
import type { AdapterOutput } from '../../src/adapters/types.ts';
import { saveBase64Image } from '../../src/media.ts';
import { checkEvent } from '../helpers/protocol-check.ts';
import { tmpDir } from '../helpers/fakes.ts';

const FIX = path.join(import.meta.dirname, '..', 'fixtures');

function load(name: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(FIX, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function ctx(files: Record<string, string> = {}): NormalizerContext & { blobs: Record<string, string>; copied: Record<string, string>; media: string } {
  const media = tmpDir('tb-media-');
  const blobs: Record<string, string> = {};
  const copied: Record<string, string> = {};
  return {
    cwd: '/work/proj',
    media,
    blobs,
    copied,
    readFile: (p) => files[p] ?? null,
    saveImage: (data, mediaType, hint) => saveBase64Image(media, data, mediaType, hint),
    saveBlob: (itemId, text) => {
      blobs[itemId] = text;
      return `/blobs/${itemId}.txt`;
    },
    copyBlob: (itemId, src) => {
      copied[itemId] = src;
      return `/blobs/${itemId}.txt`;
    },
  };
}

// Recordings start with the runner's message, so the normaliser is told
// one was sent, as the adapter does.
function run(name: string, c = ctx()): AdapterOutput[] {
  const n = new ClaudeNormalizer(c);
  n.sent();
  return load(name).flatMap((m) => n.handle(m));
}

function events(outs: AdapterOutput[]) {
  return outs.filter((o): o is Extract<AdapterOutput, { kind: 'event' }> => o.kind === 'event').map((o) => o.event as any);
}

function deltas(outs: AdapterOutput[]) {
  return outs.filter((o): o is Extract<AdapterOutput, { kind: 'delta' }> => o.kind === 'delta').map((o) => o.delta);
}

// Every normalised event, given an envelope, must pass the protocol check.
function assertProtocol(outs: AdapterOutput[]) {
  for (const o of outs) {
    if (o.kind !== 'event' && o.kind !== 'delta') continue;
    const body = o.kind === 'event' ? o.event : o.delta;
    const e = { seq: 1, ts: '2026-10-26T00:00:00.000Z', threadId: 't', ...body };
    assert.deepEqual(checkEvent(e), [], `${body.type} breaks the protocol`);
  }
}

test('plain text reply: session, deltas, one assistant.text, result', () => {
  const outs = run('text.ndjson');
  assertProtocol(outs);
  const session = outs.find((o) => o.kind === 'session');
  assert.ok(session && session.kind === 'session' && session.nativeSessionId && session.model === 'claude-haiku-5-5');
  const texts = events(outs).filter((e) => e.type === 'assistant.text');
  assert.equal(texts.length, 1);
  const ds = deltas(outs);
  assert.ok(ds.length >= 2);
  assert.ok(ds.every((d) => d.type === 'assistant.text.delta' && d.itemId === texts[0].itemId));
  assert.equal(ds.map((d) => d.text).join(''), texts[0].text);
  // The persisted event comes after all of its deltas.
  const lastDelta = outs.findLastIndex((o) => o.kind === 'delta');
  const textIdx = outs.findIndex((o) => o.kind === 'event' && o.event.type === 'assistant.text');
  assert.ok(textIdx > lastDelta);
  const ctxOut = outs.find((o) => o.kind === 'context');
  assert.ok(ctxOut && ctxOut.kind === 'context' && ctxOut.contextTokens > 1000);
  // The result's modelUsage says how big the model's window is, so a client
  // can show how full the context is.
  const last = outs.findLast((o) => o.kind === 'context');
  assert.ok(last && last.kind === 'context');
  assert.equal(last.contextWindow, 1_000_000);
  assert.equal(last.contextTokens, ctxOut.contextTokens);
  const result = outs.at(-1)!;
  assert.equal(result.kind, 'result');
  assert.equal(result.kind === 'result' && result.result.outcome, 'completed');
  assert.ok(result.kind === 'result' && result.result.totalCostUsd! > 0);
});

test('read tool: tool.call with kind and relative title, then tool.result', () => {
  const outs = run('read-tool.ndjson');
  assertProtocol(outs);
  const evs = events(outs);
  const call = evs.find((e) => e.type === 'tool.call');
  assert.equal(call.name, 'Read');
  assert.equal(call.kind, 'read');
  assert.equal(call.title, 'Read note.txt');
  const result = evs.find((e) => e.type === 'tool.result');
  assert.equal(result.itemId, call.itemId);
  assert.equal(result.ok, true);
  assert.match(result.text, /beta/);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.images, []);
  assert.deepEqual(
    evs.map((e) => e.type),
    ['tool.call', 'tool.result', 'assistant.text'],
  );
});

test('image in a tool result is saved to media with its size', () => {
  const c = ctx();
  const outs = run('image-result.ndjson', c);
  assertProtocol(outs);
  const result = events(outs).find((e) => e.type === 'tool.result');
  assert.equal(result.images.length, 1);
  const img = result.images[0];
  assert.equal(img.mediaType, 'image/png');
  assert.equal(img.width, 64);
  assert.equal(img.height, 48);
  assert.ok(img.path.startsWith(c.media));
  assert.ok(fs.existsSync(img.path));
});

test('AskUserQuestion turn: reasoning, tool call, result and answer text', () => {
  const outs = run('ask-question.ndjson');
  assertProtocol(outs);
  const evs = events(outs);
  assert.deepEqual(
    evs.map((e) => e.type),
    ['reasoning', 'tool.call', 'tool.result', 'assistant.text'],
  );
  const reasoning = evs[0];
  const rDeltas = deltas(outs).filter((d) => d.type === 'reasoning.delta');
  assert.ok(rDeltas.length > 0);
  assert.equal(rDeltas.map((d) => d.text).join(''), reasoning.text);
  assert.ok(rDeltas.every((d) => d.itemId === reasoning.itemId));
  assert.equal(evs[1].name, 'AskUserQuestion');
  assert.equal(evs[1].title, 'Ask a question');
  assert.equal(evs[3].text, 'Tea.');
});

test('Edit and Write in ask mode: edit.diff from the CLI patch, new file as all additions', () => {
  const outs = run('edit-ask-mode.ndjson');
  assertProtocol(outs);
  const evs = events(outs);
  assert.deepEqual(
    evs.map((e) => e.type),
    ['reasoning', 'tool.call', 'edit.diff', 'tool.result', 'tool.call', 'edit.diff', 'tool.result', 'assistant.text'],
  );
  const [editCall, editDiff, , writeCall, writeDiff] = evs.slice(1);
  assert.equal(editCall.kind, 'edit');
  assert.equal(editCall.title, 'Edit note.txt');
  assert.equal(editDiff.itemId, editCall.itemId);
  assert.equal(editDiff.path, '/work/proj/note.txt');
  assert.deepEqual(editDiff.hunks, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' alpha', '-beta', '+BETA', ' gamma'] }]);
  assert.equal(writeCall.kind, 'write');
  assert.equal(writeCall.title, 'Write new.txt');
  assert.deepEqual(writeDiff.hunks, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hi'] }]);
});

test('diff shown at approval time is not repeated when the result lands', () => {
  const c = ctx({ '/work/proj/note.txt': 'alpha\nbeta\ngamma\n' });
  const n = new ClaudeNormalizer(c);
  const msgs = load('edit-ask-mode.ndjson');
  const outs: AdapterOutput[] = [];
  for (const m of msgs) {
    outs.push(...n.handle(m));
    const call = outs.at(-1);
    if (call?.kind === 'event' && call.event.type === 'tool.call' && call.event.name === 'Edit') {
      outs.push(...n.beforeApproval(call.event.itemId, 'Edit', call.event.input));
    }
  }
  const diffs = events(outs).filter((e) => e.type === 'edit.diff');
  assert.equal(diffs.length, 2); // one Edit, one Write
  assert.deepEqual(diffs[0].hunks[0].lines, [' alpha', '-beta', '+BETA', ' gamma']);
});

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

test("a successful Edit or Write says what it wrote, by the hash of the bytes rebuilt from the result; a preview or a denied edit says nothing", () => {
  // A recorded ask-mode run (CLI 2.1): Edit beta -> BETA, then Write "hi".
  const c = ctx({ '/work/proj/note.txt': 'alpha\nbeta\ngamma\n' });
  const n = new ClaudeNormalizer(c);
  const outs: AdapterOutput[] = [];
  for (const m of load('edit-ask-mode.ndjson')) {
    outs.push(...n.handle(m));
    const call = outs.at(-1);
    if (call?.kind === 'event' && call.event.type === 'tool.call' && call.event.name === 'Edit') {
      const preview = n.beforeApproval(call.event.itemId, 'Edit', call.event.input);
      assert.ok(preview.length && preview.every((o) => o.kind === 'event'), 'the preview is only an edit.diff');
      outs.push(...preview);
    }
  }
  const wrote = outs.filter((o) => o.kind === 'wrote');
  assert.deepEqual(wrote, [
    { kind: 'wrote', itemId: 'toolu_019BcoFgUrhyzun1BBVKSy8Z', files: [{ path: '/work/proj/note.txt', sha256: sha('alpha\nBETA\ngamma\n'), base: sha('alpha\nbeta\ngamma\n') }] },
    { kind: 'wrote', itemId: 'toolu_013dHVx9Xb6KVXVZYAH7zSgX', files: [{ path: '/work/proj/new.txt', sha256: sha('hi'), base: null }] },
  ]);
  // Each just before its result, so the runner hears it before the turn goes on.
  const next = outs[outs.findIndex((o) => o.kind === 'wrote') + 1];
  assert.ok(next.kind === 'event' && next.event.type === 'tool.result');

  // Denied: no wrote, though the preview named the file.
  const d = new ClaudeNormalizer(ctx({ '/work/proj/a.ts': 'x\n' }));
  const input = { file_path: '/work/proj/a.ts', old_string: 'x', new_string: 'y' };
  const denied = [
    ...d.handle({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input }] }, parent_tool_use_id: null }),
    ...d.beforeApproval('tu1', 'Edit', input),
    ...d.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: "The user doesn't want to proceed with this tool use." }] }, parent_tool_use_id: null }),
  ];
  assert.ok(events(denied).some((e) => e.type === 'edit.diff'));
  assert.equal(denied.filter((o) => o.kind === 'wrote').length, 0);
});

test('wroteFromResult rebuilds an edit as Claude Code applies it, and gives up rather than guess', () => {
  const tur = (o: Record<string, unknown>) => ({ filePath: '/p/a.ts', ...o });
  // Deleting text without its newline takes the newline too.
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: 'a\nb\nc\n', oldString: 'b', newString: '', replaceAll: false }))?.sha256, sha('a\nc\n'));
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: 'x x x', oldString: 'x', newString: 'y', replaceAll: true }))?.sha256, sha('y y y'));
  // An empty old_string on a new file makes it.
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: null, oldString: '', newString: 'new\n' }))?.sha256, sha('new\n'));
  assert.equal(
    wroteFromResult('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b\nb', new_string: 'c' }] }, tur({ originalFile: 'a\nb\n' }))?.sha256,
    sha('c\n'),
  );
  assert.equal(wroteFromResult('Write', { file_path: '/p/a.ts', content: 'from input' }, undefined)?.sha256, sha('from input'));
  // What the edit started from (F21): the rest of the file is that, not
  // the agent's. None for a Write, or an edit of a missing or empty file,
  // whose bytes are all the call's.
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: 'a\nb\nc\n', oldString: 'b', newString: 'B' }))?.base, sha('a\nb\nc\n'));
  assert.equal(wroteFromResult('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }] }, tur({ originalFile: 'a\n' }))?.base, sha('a\n'));
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: null, oldString: '', newString: 'new\n' }))?.base, null);
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: '', oldString: '', newString: 'new\n' }))?.base, null);
  assert.equal(wroteFromResult('Write', { file_path: '/p/a.ts', content: 'all mine' }, tur({ content: 'all mine', originalFile: 'theirs' }))?.base, null);
  // No original text, or text that isn't there: nothing, so nothing is trusted.
  assert.equal(wroteFromResult('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }, undefined), undefined);
  assert.equal(wroteFromResult('Edit', {}, tur({ originalFile: 'abc', oldString: 'zzz', newString: 'y' })), undefined);
});

test('interrupt mid-stream keeps the partial text and reports interrupted', () => {
  const outs = run('interrupt.ndjson');
  assertProtocol(outs);
  const texts = events(outs).filter((e) => e.type === 'assistant.text');
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /^one\ntwo\nthree/);
  const result = outs.at(-1)!;
  assert.equal(result.kind === 'result' && result.result.outcome, 'interrupted');
  assert.equal(result.kind === 'result' && result.result.error, undefined);
});

test('text that streamed without a complete frame is kept at the result', () => {
  const n = new ClaudeNormalizer(ctx());
  const outs = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half a ' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sentence' } }, parent_tool_use_id: null },
    { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 5, errors: ['[ede_diagnostic] x'] },
  ].flatMap((m) => n.handle(m));
  const evs = events(outs);
  assert.deepEqual(evs, [{ type: 'assistant.text', itemId: 'm1:0', text: 'half a sentence' }]);
});

test('tool output over 64 KB is truncated and saved as a blob', () => {
  const c = ctx();
  const n = new ClaudeNormalizer(c);
  const big = 'x'.repeat(70 * 1024);
  n.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat big\nsecond line' } }] }, parent_tool_use_id: null });
  const outs = n.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: big }] }, parent_tool_use_id: null });
  const r = events(outs)[0];
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.text), 64 * 1024);
  assert.equal(r.blobPath, '/blobs/tu1.txt');
  assert.equal(c.blobs.tu1, big);
});

test('tool titles and kinds for common tools', () => {
  const n = new ClaudeNormalizer(ctx());
  const call = (name: string, input: Record<string, unknown>) =>
    events(n.handle({ type: 'assistant', message: { id: `m-${name}`, content: [{ type: 'tool_use', id: `id-${name}`, name, input }] }, parent_tool_use_id: null }))[0];
  assert.deepEqual([call('Bash', { command: 'npm test\nnpm run lint' }).title, call('Bash', { command: 'x' }).kind], ['npm test', 'command']);
  assert.equal(call('Grep', { pattern: 'TODO', path: '/work/proj/src' }).title, 'Search for TODO in src');
  assert.equal(call('Glob', { pattern: '**/*.ts' }).title, 'Find **/*.ts');
  assert.equal(call('WebFetch', { url: 'https://example.com' }).kind, 'web');
  const mcp = call('mcp__paper__get_page', {});
  assert.equal(mcp.kind, 'mcp');
  assert.equal(mcp.title, 'paper: get_page');
  assert.equal(call('Agent', { description: 'Find the bug', prompt: 'p' }).kind, 'task');
  const big = call('Write', { file_path: '/work/proj/a.txt', content: 'y'.repeat(20_000) });
  assert.ok(String(big.input.content).length < 17_000);
});

test('TodoWrite and Task tools become plan.updated', () => {
  const n = new ClaudeNormalizer(ctx());
  let outs = n.handle({
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { todos: [{ content: 'Read code', status: 'completed', activeForm: 'Reading' }, { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing' }] } }] },
    parent_tool_use_id: null,
  });
  assert.deepEqual(events(outs)[1], { type: 'plan.updated', entries: [{ text: 'Read code', status: 'completed' }, { text: 'Fix bug', status: 'in_progress' }] });

  n.handle({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tc', name: 'TaskCreate', input: { subject: 'Write tests', description: 'd' } }] }, parent_tool_use_id: null });
  outs = n.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc', content: 'Task #1 created' }] }, tool_use_result: { task: { id: '1', subject: 'Write tests' } }, parent_tool_use_id: null });
  assert.deepEqual(events(outs).at(-1), { type: 'plan.updated', entries: [{ text: 'Write tests', status: 'pending' }] });
  n.handle({ type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 'tu', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] }, parent_tool_use_id: null });
  outs = n.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] }, tool_use_result: { success: true, taskId: '1' }, parent_tool_use_id: null });
  assert.deepEqual(events(outs).at(-1), { type: 'plan.updated', entries: [{ text: 'Write tests', status: 'completed' }] });
});

test('subagent traffic and replays are ignored', () => {
  const n = new ClaudeNormalizer(ctx());
  assert.deepEqual(n.handle({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'inner' }] }, parent_tool_use_id: 'toolu_x' }), []);
  assert.deepEqual(n.handle({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] }, parent_tool_use_id: null }), []);
});

test('failed results carry the error text', () => {
  const n = new ClaudeNormalizer(ctx());
  const [r] = n.handle({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: overloaded', duration_ms: 3, total_cost_usd: 0 });
  assert.equal(r.kind === 'result' && r.result.outcome, 'failed');
  assert.equal(r.kind === 'result' && r.result.error, 'API Error: overloaded');
});

test('compaction becomes a system note', () => {
  const n = new ClaudeNormalizer(ctx());
  assert.deepEqual(events(n.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1 } })), [
    { type: 'system.note', text: 'Compacted the conversation' },
  ]);
});

// ---------------------------------------------------------------- review fixes

const sys = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, session_id: 's1', ...extra });
const life = (state: string, uuid: string) => ({ type: 'command_lifecycle', command_uuid: uuid, state });
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.01, ...extra });

test('turns the CLI starts itself are reported, with the finished task as a note', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  const turn1 = [life('queued', 'u1'), life('started', 'u1'), sys('init'), result(), life('completed', 'u1')].flatMap((m) => n.handle(m));
  assert.ok(!turn1.some((o) => o.kind === 'cliTurn'));
  const r1 = turn1.find((o) => o.kind === 'result');
  assert.deepEqual(r1?.kind === 'result' && [r1.result.own, r1.result.answers], [undefined, 'u1']);
  // A background shell finishes while nothing is running.
  const own = [
    sys('task_notification', { status: 'completed', task_id: 'b1', summary: 'Background command "sleep 5" completed (exit code 0)' }),
    sys('background_tasks_changed', { tasks: [] }),
    sys('init'),
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'It finished.' }] }, parent_tool_use_id: null },
    result(),
  ].flatMap((m) => n.handle(m));
  assert.deepEqual(own.find((o) => o.kind === 'cliTurn'), { kind: 'cliTurn', note: 'Background command "sleep 5" completed (exit code 0)' });
  assert.deepEqual(own.find((o) => o.kind === 'tasks'), { kind: 'tasks', tasks: [] });
  const r2 = own.find((o) => o.kind === 'result');
  assert.equal(r2?.kind === 'result' && r2.result.own, true);
  // The cliTurn comes before the turn's output.
  assert.ok(own.findIndex((o) => o.kind === 'cliTurn') < own.findIndex((o) => o.kind === 'event'));
});

test('a message queued behind a CLI turn: the CLI turn is its own, the next answers it', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  [life('queued', 'u1'), life('started', 'u1'), sys('init'), result(), life('completed', 'u1')].forEach((m) => n.handle(m));
  n.sent();
  const outs = [
    sys('task_notification', { status: 'completed', summary: 'done' }),
    life('queued', 'u2'),
    sys('init'),
    result(),
    life('started', 'u2'),
    sys('init'),
    result(),
  ].flatMap((m) => n.handle(m));
  const results = outs.filter((o) => o.kind === 'result').map((o) => (o.kind === 'result' ? [o.result.own, o.result.answers] : null));
  assert.deepEqual(results, [[true, undefined], [undefined, 'u2']]);
});

test('a message sent during a turn and folded into it: one result answers both', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  const outs = [life('queued', 'u1'), life('started', 'u1'), sys('init')].flatMap((m) => n.handle(m));
  assert.ok(!outs.some((o) => o.kind === 'cliTurn'));
  n.sent();
  const rest = [
    life('queued', 'u2'),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 4' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null },
    life('started', 'u2'),
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'PINEAPPLE' }] }, parent_tool_use_id: null },
    result({ user_message_uuid: 'u1', user_message_uuids: ['u1', 'u2'], queued_turn_count: 0 }),
    life('completed', 'u2'),
    life('completed', 'u1'),
  ].flatMap((m) => n.handle(m));
  assert.ok(!rest.some((o) => o.kind === 'cliTurn'), 'the fold is not a turn of the CLI\'s own');
  const results = rest.filter((o) => o.kind === 'result');
  assert.equal(results.length, 1);
  const r = results[0].kind === 'result' ? results[0].result : undefined;
  assert.deepEqual([r?.own, r?.answers, r?.answered, r?.queuedTurns], [undefined, 'u2', ['u1', 'u2'], 0]);
});

test('a message sent during a turn that the CLI runs next: the first result says one is waiting', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  [life('queued', 'u1'), life('started', 'u1'), sys('init')].forEach((m) => n.handle(m));
  n.sent();
  const outs = [
    life('queued', 'u2'),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '1 2 3' }] }, parent_tool_use_id: null },
    result({ user_message_uuid: 'u1', user_message_uuids: ['u1'], queued_turn_count: 1 }),
    life('completed', 'u1'),
    life('started', 'u2'),
    sys('init'),
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'PINEAPPLE' }] }, parent_tool_use_id: null },
    result({ user_message_uuid: 'u2', user_message_uuids: ['u2'], queued_turn_count: 0 }),
    life('completed', 'u2'),
  ].flatMap((m) => n.handle(m));
  assert.ok(!outs.some((o) => o.kind === 'cliTurn'));
  const results = outs.filter((o) => o.kind === 'result').map((o) => (o.kind === 'result' ? [o.result.answers, o.result.answered, o.result.queuedTurns] : null));
  assert.deepEqual(results, [['u1', ['u1'], 1], ['u2', ['u2'], 0]]);
});

test('without lifecycle frames, turns are matched by counting messages sent', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  const first = [sys('init'), result()].flatMap((m) => n.handle(m));
  assert.ok(!first.some((o) => o.kind === 'cliTurn'));
  const second = [sys('init'), result()].flatMap((m) => n.handle(m));
  assert.ok(second.some((o) => o.kind === 'cliTurn'), 'nothing was sent, so this one is the CLI\'s own');
});

test('background tasks: ambient ones are left out', () => {
  const n = new ClaudeNormalizer(ctx());
  const outs = n.handle(sys('background_tasks_changed', { tasks: [
    { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' },
    { task_id: 'w1', task_type: 'watcher', description: 'watch', ambient: true },
  ] }));
  assert.deepEqual(outs, [{ kind: 'tasks', tasks: [{ id: 'b1', type: 'local_bash', kind: 'shell', description: 'npm run dev' }] }]);
});

test('background tasks: the CLI\'s task types map to the protocol\'s kinds, unknown ones to other', () => {
  const n = new ClaudeNormalizer(ctx());
  const outs = n.handle(sys('background_tasks_changed', { tasks: [
    { task_id: 'a1', task_type: 'local_agent', description: 'Rebuild page A' },
    { task_id: 'a2', task_type: 'remote_agent', description: 'Review' },
    { task_id: 'a3', task_type: 'in_process_teammate', description: 'Teammate' },
    { task_id: 'm1', task_type: 'monitor', description: 'Watch the deploy' },
    { task_id: 'w1', task_type: 'local_workflow', description: 'A workflow' },
    { task_id: 'x1' },
  ] }));
  assert.equal(outs.length, 1);
  assert.equal(outs[0].kind, 'tasks');
  const tasks = (outs[0] as { kind: 'tasks'; tasks: { id: string; kind: string; type: string; description: string }[] }).tasks;
  assert.deepEqual(tasks.map((t) => [t.id, t.kind]), [['a1', 'agent'], ['a2', 'agent'], ['a3', 'agent'], ['m1', 'monitor'], ['w1', 'other'], ['x1', 'other']]);
  assert.deepEqual(tasks[5], { id: 'x1', type: 'task', kind: 'other', description: '' });
});

test('edit.diff drops the "No newline at end of file" markers', () => {
  const n = new ClaudeNormalizer(ctx());
  n.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/work/proj/a.txt', old_string: 'beta', new_string: 'gamma' } }] }, parent_tool_use_id: null });
  const outs = n.handle({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    tool_use_result: { filePath: '/work/proj/a.txt', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' alpha', '-beta', '\\ No newline at end of file', '+gamma', '\\ No newline at end of file'] }] },
    parent_tool_use_id: null,
  });
  assertProtocol(outs);
  const diff = events(outs).find((e) => e.type === 'edit.diff');
  assert.deepEqual(diff.hunks[0].lines, [' alpha', '-beta', '+gamma']);
});

test('after /compact, earlier local command output the CLI re-sends is not shown again', () => {
  const n = new ClaudeNormalizer(ctx());
  const cost = { type: 'assistant', message: { id: 'aa-1', content: [{ type: 'text', text: 'You are using your subscription' }] }, local_command_source: '<local-command-stdout>You are using your subscription</local-command-stdout>', parent_tool_use_id: null };
  const first = [cost, result({ result: '' })].flatMap((m) => n.handle(m));
  assert.equal(events(first).filter((e) => e.type === 'assistant.text').length, 1);
  const compact = [
    sys('compact_boundary', { compact_metadata: { trigger: 'manual' } }),
    { ...cost, message: { ...cost.message, id: 'bb-2' } },
    result({ result: '' }),
  ].flatMap((m) => n.handle(m));
  assert.deepEqual(events(compact).map((e) => e.type), ['system.note']);
  // A later /cost shows as usual.
  const again = [cost, result({ result: '' })].flatMap((m) => n.handle(m));
  assert.equal(events(again).filter((e) => e.type === 'assistant.text').length, 1);
});

test('tool output cut at 64 KB never splits a character', () => {
  const c = ctx();
  const n = new ClaudeNormalizer(c);
  n.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'euros' } }] }, parent_tool_use_id: null });
  const outs = n.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '€'.repeat(30000) }] }, parent_tool_use_id: null });
  assertProtocol(outs);
  const r = events(outs)[0];
  assert.ok(Buffer.byteLength(r.text) <= 64 * 1024);
  assert.ok(!r.text.includes('�'));
  assert.equal(r.text, '€'.repeat(Math.floor((64 * 1024) / 3)));
  assert.equal(r.truncated, true);
});

test('output the CLI saved to a file is copied into the thread and pointed at', () => {
  const c = ctx();
  const n = new ClaudeNormalizer(c);
  n.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'seq 1 60000' } }] }, parent_tool_use_id: null });
  const preview = '<persisted-output>\nOutput too large (340.7KB). Full output saved to: /acct/projects/x/tool-results/b1.txt\n\nPreview (first 2KB):\n1\n2\n';
  let outs = n.handle({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: preview }] },
    tool_use_result: { stdout: '1\n2\n', persistedOutputPath: '/acct/projects/x/tool-results/b1.txt', persistedOutputSize: 348894 },
    parent_tool_use_id: null,
  });
  let r = events(outs)[0];
  assert.deepEqual([r.text, r.truncated, r.blobPath], [preview, true, '/blobs/tu1.txt']);
  assert.equal(c.copied.tu1, '/acct/projects/x/tool-results/b1.txt');
  // Without the structured field, the path in the preview is used.
  n.handle({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'cat big' } }] }, parent_tool_use_id: null });
  outs = n.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: preview }] }, parent_tool_use_id: null });
  r = events(outs)[0];
  assert.equal(r.blobPath, '/blobs/tu2.txt');
  assert.equal(c.copied.tu2, '/acct/projects/x/tool-results/b1.txt');
});

test('sub-agents: started, progress and finish become subagent updates (recorded run)', () => {
  const outs = run('subagents.ndjson');
  assertProtocol(outs);
  const ups = outs.filter((o): o is Extract<AdapterOutput, { kind: 'subagent' }> => o.kind === 'subagent').map((o) => o.update);
  const first = ups.filter((u) => u.id === 'ab1373fe8b7475ff5');
  assert.deepEqual(first[0], {
    id: 'ab1373fe8b7475ff5',
    started: true,
    status: 'running',
    background: true,
    itemId: 'toolu_015X2kTTJkzTMhD6xZUAVh9C',
    description: 'List files',
    agentType: 'general-purpose',
  });
  assert.ok(first.some((u) => u.activity === 'Running List work directory then echo hello' && u.toolUses === 1));
  assert.ok(first.some((u) => u.status === 'completed'));
  assert.match(first.at(-1)!.summary ?? '', /ls/);
  // The shell the second sub-agent ran is a task too, but not a sub-agent.
  assert.deepEqual([...new Set(ups.map((u) => u.id))], ['ab1373fe8b7475ff5', 'a0129496b4393509d']);
  // Its own messages still stay out of the thread.
  assert.ok(!events(outs).some((e) => e.type === 'tool.call' && e.name === 'Bash'));
});

test('sub-agents: failed and killed, nested, and one a resumed CLI reports', () => {
  const n = new ClaudeNormalizer(ctx());
  const ups = (m: Record<string, unknown>) => n.handle(m).filter((o) => o.kind === 'subagent').map((o) => (o as any).update);
  assert.deepEqual(ups(sys('task_started', { task_id: 'k1', task_type: 'local_agent', description: 'Kid', parent_task_id: 'p1', is_backgrounded: false })), [
    { id: 'k1', started: true, status: 'running', background: false, parentId: 'p1', description: 'Kid' },
  ]);
  assert.deepEqual(ups(sys('task_updated', { task_id: 'k1', patch: { is_backgrounded: true } })), [{ id: 'k1', background: true }]);
  assert.deepEqual(ups(sys('task_updated', { task_id: 'k1', patch: { status: 'failed', error: 'Boom' } })), [{ id: 'k1', status: 'failed', summary: 'Boom' }]);
  assert.deepEqual(ups(sys('task_updated', { task_id: 'k2', patch: { status: 'killed' } })), [], 'unknown task');
  assert.deepEqual(ups(sys('task_started', { task_id: 's1', task_type: 'local_bash', description: 'npm test' })), []);
  assert.deepEqual(ups(sys('task_progress', { task_id: 's1', description: 'npm test', usage: { tool_uses: 0 } })), []);
  assert.deepEqual(ups(sys('task_progress', { task_id: 'old', subagent_type: 'Explore', description: 'Running grep', summary: 'Reading the router', usage: { tool_uses: 4 } })), [
    { id: 'old', activity: 'Reading the router', toolUses: 4 },
  ]);
  assert.deepEqual(ups(sys('task_notification', { task_id: 'old', status: 'stopped', summary: '' })), [{ id: 'old', status: 'stopped' }]);
});

test('init reports the session and the version of the CLI running it', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  const out = n.handle({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-5-5', claude_code_version: '2.1.311' });
  assert.deepEqual(out.filter((o) => o.kind !== 'event'), [
    { kind: 'session', nativeSessionId: 's1', model: 'claude-haiku-5-5' },
    { kind: 'cliVersion', version: '2.1.311' },
  ]);
  // An older CLI without the field just reports the session.
  assert.ok(!n.handle({ type: 'system', subtype: 'init', session_id: 's1', model: 'x' }).some((o) => o.kind === 'cliVersion'));
});

// Opus 5.5 (with summarised thinking) at times sends its reply as a
// thinking block whose signature says "narration", in the very slot a text
// block would take, and never a text block after it. Shown as reasoning,
// Mike lost the reply and end_turn refused the turn (29 Oct 2026). These
// are the first bytes of real signatures from that thread.
const THINKING_SIG = 'CAQSgwwKEAgTGAI4AUIIdGhpbmtpbmcSDHCL3VyUshfP/bVqShoMrDMmssSa4HNEPdUlIjCBvNA2YwVcxIn+';
const NARRATION_SIG = 'CAQSjhEKEQgTGAI4AUIJbmFycmF0aW9uEgwlQ92PE4QEL1MnR7kaDO5+aQgmped7VShGsSIwdgSJ2ZkHJEzG';

test('a thinking block signed as narration is the reply: assistant.text, not reasoning', () => {
  const n = new ClaudeNormalizer(ctx());
  n.sent();
  const frame = (content: unknown[]) => ({ type: 'assistant', message: { id: 'm1', content }, parent_tool_use_id: null });
  const outs = [
    frame([{ type: 'thinking', thinking: 'Wrap up now.', signature: THINKING_SIG }]),
    frame([{ type: 'thinking', thinking: 'Found the bug and fixed it.', signature: NARRATION_SIG }]),
    frame([{ type: 'tool_use', id: 'tu1', name: 'mcp__threadbear__end_turn', input: { needs: 'nothing' } }]),
  ].flatMap((m) => n.handle(m));
  assertProtocol(outs);
  assert.deepEqual(
    events(outs).map((e) => [e.type, e.itemId, e.text ?? e.name]),
    [
      ['reasoning', 'm1:0', 'Wrap up now.'],
      ['assistant.text', 'm1:1', 'Found the bug and fixed it.'],
      ['tool.call', 'tu1', 'mcp__threadbear__end_turn'],
    ],
  );
  // What the API sends for a narration block is a summary of it.
  assert.deepEqual(events(outs).map((e) => e.narration), [undefined, true, undefined]);
});

test('a narration block cut off after its signature streamed is kept as text', () => {
  const n = new ClaudeNormalizer(ctx());
  const se = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });
  const outs = [
    se({ type: 'message_start', message: { id: 'm1' } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'All done.' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: NARRATION_SIG } }),
    { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 5, errors: ['[ede_diagnostic] x'] },
  ].flatMap((m) => n.handle(m));
  assert.deepEqual(events(outs), [{ type: 'assistant.text', itemId: 'm1:0', text: 'All done.', narration: true }]);
});

test("the context window is the session model's, not a sub-agent's", () => {
  const window = (modelUsage: Record<string, unknown>, model = 'claude-opus-5-5[1m]') => {
    const m = new ClaudeNormalizer(ctx());
    m.sent();
    m.handle({ type: 'system', subtype: 'init', session_id: 's1', model });
    m.handle({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 20 } } });
    const outs = m.handle({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, modelUsage });
    const ctxOut = outs.find((o) => o.kind === 'context');
    return ctxOut && ctxOut.kind === 'context' ? [ctxOut.contextTokens, ctxOut.contextWindow] : undefined;
  };
  // The session's model, matched without its "[1m]" suffix, beats a
  // sub-agent's bigger window.
  assert.deepEqual(window({ 'claude-haiku-5-5': { contextWindow: 1_000_000 }, 'claude-opus-5-5': { contextWindow: 200_000 } }), [5030, 200_000]);
  // Only another model listed: can't tell, so no window.
  assert.equal(window({ 'claude-haiku-5-5': { contextWindow: 1_000_000 }, 'claude-sonnet-5-5': { contextWindow: 1_000_000 } }), undefined);
  assert.deepEqual(window({ 'claude-opus-5-5': { contextWindow: 1_000_000 } }, 'opus'), [5030, 1_000_000]);
});
