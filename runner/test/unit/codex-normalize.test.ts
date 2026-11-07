// Replays the sanitised Codex captures (test/fixtures/codex/, made by
// scripts/sanitize-codex-recording.ts) through CodexNormalizer, the way the
// adapter feeds it, and checks what comes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CodexNormalizer,
  IGNORED_METHODS,
  MAPPED_METHODS,
  OVERSIZED_LINE,
  innerCommand,
  limitsFromAccount,
  limitsFromRateLimits,
  parseHunks,
  stripLeakedToolCall,
} from '../../src/adapters/codex/normalize.ts';
import { fileContext, type NormalizerContext } from '../../src/adapters/context.ts';
import type { AdapterOutput } from '../../src/adapters/types.ts';
import { checkEvent } from '../helpers/protocol-check.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { TINY_PNG_B64, leaks, sanitizeRecords, toNdjson, type Rec } from '../../scripts/sanitize-codex-recording.ts';

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'codex');

type Env = { cwd: string; codexHome: string; media: string; blobs: string; ctx: NormalizerContext };

function env(): Env {
  const root = tmpDir('tb-codex-norm-');
  const cwd = path.join(root, 'proj');
  const codexHome = path.join(root, 'codex-home');
  const media = path.join(root, 'media');
  const blobs = path.join(root, 'blobs');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return { cwd, codexHome, media, blobs, ctx: fileContext(cwd, media, blobs) };
}

function load(name: string, e: Env): Rec[] {
  return fs
    .readFileSync(path.join(FIX, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.replaceAll('/work/proj', e.cwd).replaceAll('/codex-home', e.codexHome)) as Rec);
}

type Replay = { outs: AdapterOutput[]; normalizers: Record<string, CodexNormalizer> };

// Feeds a fixture through one normaliser per app-server process, as the
// adapter would: it says which turn/start is the runner's ("turn-<id>"),
// routes a subagent's traffic with its child thread id, and turns the
// account reads into limits.
function replay(lines: Rec[], e: Env): Replay {
  const outs: AdapterOutput[] = [];
  const normalizers: Record<string, CodexNormalizer> = {};
  const state: Record<string, { requests: Map<unknown, string>; thread?: string }> = {};
  for (const r of lines) {
    const n = (normalizers[r.proc] ??= new CodexNormalizer(e.ctx));
    const s = (state[r.proc] ??= { requests: new Map() });
    const m = r.msg as Record<string, any>;
    if (r.dir === 'out') {
      if (typeof m.method === 'string' && m.id !== undefined) {
        s.requests.set(m.id, m.method);
        if (m.method === 'turn/start') n.startingTurn(`turn-${m.id}`);
      }
      continue;
    }
    if (m.method === undefined) {
      const method = s.requests.get(m.id);
      const res = m.result as Record<string, any> | undefined;
      if (!res) continue;
      if ((method === 'thread/start' || method === 'thread/resume') && res.thread?.id) {
        s.thread = res.thread.id;
        n.setThread(res.thread.id, res.model);
      } else if (method === 'turn/start' && res.turn?.id) n.turnAccepted(res.turn.id);
      else if (method === 'account/rateLimits/read') outs.push(...[limitsFromRateLimits(res)].filter((x) => x !== null));
      else if (method === 'account/read') outs.push(...[limitsFromAccount(res)].filter((x) => x !== null));
      continue;
    }
    if (m.id !== undefined) continue; // a server request: approvals.ts's
    const tid = m.params?.threadId;
    const from = s.thread && typeof tid === 'string' && tid !== s.thread ? { childThreadId: tid } : undefined;
    outs.push(...n.handle(m.method, m.params, from));
  }
  return { outs, normalizers };
}

function run(name: string, e = env(), prepare?: (lines: Rec[], e: Env) => void): Replay & { e: Env } {
  const lines = load(name, e);
  prepare?.(lines, e);
  const r = replay(lines, e);
  assertProtocol(r.outs);
  return { ...r, e };
}

const events = (outs: AdapterOutput[]) => outs.filter((o) => o.kind === 'event').map((o) => (o as Extract<AdapterOutput, { kind: 'event' }>).event as any);
const deltas = (outs: AdapterOutput[]) => outs.filter((o) => o.kind === 'delta').map((o) => (o as Extract<AdapterOutput, { kind: 'delta' }>).delta);
const results = (outs: AdapterOutput[]) => outs.filter((o) => o.kind === 'result').map((o) => (o as Extract<AdapterOutput, { kind: 'result' }>).result);
const of = <K extends AdapterOutput['kind']>(outs: AdapterOutput[], kind: K) => outs.filter((o): o is Extract<AdapterOutput, { kind: K }> => o.kind === kind);

function assertProtocol(outs: AdapterOutput[]): void {
  for (const o of outs) {
    if (o.kind !== 'event' && o.kind !== 'delta') continue;
    const body = o.kind === 'event' ? o.event : o.delta;
    assert.deepEqual(checkEvent({ seq: 1, ts: '2026-10-27T00:00:00.000Z', threadId: 't', ...body }), [], `${body.type} breaks the protocol`);
  }
}

function fixtureThread(lines: Rec[]): string {
  const start = lines.find((l) => (l.msg as any).result?.thread?.id);
  return (start!.msg as any).result.thread.id;
}

test('text: deltas, one assistant.text, our turn answered, usage and context', () => {
  const { outs } = run('text');
  const texts = events(outs).filter((e) => e.type === 'assistant.text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'hello');
  assert.equal(deltas(outs).map((d) => d.text).join(''), 'hello');
  const [r] = results(outs);
  assert.equal(r.outcome, 'completed');
  assert.equal(r.answers, 'turn-3');
  assert.equal(r.own, undefined);
  assert.ok(r.durationMs > 0);
  assert.equal(r.totalCostUsd, undefined);
  assert.deepEqual(r.usage, { inputTokens: 15318, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0 });
  const ctx = of(outs, 'context').at(-1)!;
  assert.equal(ctx.contextWindow, 258400);
  assert.equal(ctx.contextTokens, 15323);
  assert.ok(!of(outs, 'cliTurn').length, 'our own turn is no cliTurn');
  // thread/settings/updated: effort low; the model matches what start reported.
  assert.deepEqual(of(outs, 'effort').map((o) => o.level), ['low']);
  assert.equal(of(outs, 'session').length, 0);
  // account/updated gives the plan.
  assert.ok(of(outs, 'limits').some((l) => l.plan === 'Pro Lite' && l.windows.length === 0));
});

test('command-and-add: the shell row, the add as a write with its diff, both results', () => {
  const { outs, e } = run('command-and-add');
  const evs = events(outs);
  const shell = evs.find((x) => x.type === 'tool.call' && x.name === 'shell');
  assert.equal(shell.title, 'echo hi');
  assert.equal(shell.kind, 'command');
  assert.deepEqual(shell.input, { command: 'echo hi', cwd: e.cwd });
  const shellResult = evs.find((x) => x.type === 'tool.result' && x.itemId === shell.itemId);
  assert.equal(shellResult.ok, true);
  assert.equal(shellResult.text, 'hi\n');
  const patch = evs.find((x) => x.type === 'tool.call' && x.name === 'apply_patch');
  assert.equal(patch.kind, 'write');
  assert.equal(patch.title, 'Edit a.txt');
  const diff = evs.find((x) => x.type === 'edit.diff' && x.itemId === patch.itemId);
  assert.equal(diff.path, path.join(e.cwd, 'a.txt'));
  assert.deepEqual(diff.hunks, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }]);
  assert.equal(evs.find((x) => x.type === 'tool.result' && x.itemId === patch.itemId).ok, true);
  // The commentary and the final answer both show.
  assert.deepEqual(evs.filter((x) => x.type === 'assistant.text').map((x) => x.text), ['I’ll run the command, then create `a.txt` with `apply_patch`.', 'done']);
  // Usage is this turn's share of the thread's running total.
  const [r] = results(outs);
  assert.equal(r.answers, 'turn-4');
  assert.ok((r.usage as any).inputTokens > 40000 && (r.usage as any).cachedInputTokens > 0);
});

test('update-patch: the hunk-only diff parsed into a hunk', () => {
  const { outs, e } = run('update-patch');
  const diff = events(outs).find((x) => x.type === 'edit.diff');
  assert.equal(diff.path, path.join(e.cwd, 'a.txt'));
  assert.deepEqual(diff.hunks, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }]);
  assert.equal(events(outs).find((x) => x.type === 'tool.call').kind, 'edit');
});

test('multi-file-patch: three edit.diff paths on one item, then one replaced', () => {
  const { outs, e } = run('multi-file-patch');
  const evs = events(outs);
  const call = evs.find((x) => x.type === 'tool.call');
  assert.equal(call.title, 'Edit 3 files');
  assert.equal(call.kind, 'edit');
  assert.deepEqual(call.input.paths, ['src/a.ts', 'src/new.ts', 'old.txt'].map((p) => path.join(e.cwd, p)));
  const diffs = evs.filter((x) => x.type === 'edit.diff');
  assert.ok(diffs.every((d) => d.itemId === call.itemId));
  assert.deepEqual(diffs.slice(0, 3).map((d) => path.relative(e.cwd, d.path)), ['src/a.ts', 'src/new.ts', 'old.txt']);
  assert.deepEqual(diffs[0].hunks[0].lines, [' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;']);
  assert.deepEqual(diffs[1].hunks[0].lines, ['+export const n = 1;', '+export const m = 2;']);
  assert.deepEqual(diffs[2].hunks, [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-gone'] }]);
  // patchUpdated sends the changed path again; the app replaces its diff.
  assert.equal(diffs.length, 4);
  assert.equal(diffs[3].path, diffs[0].path);
  assert.ok(diffs[3].hunks[0].lines.includes('+const b = 5;'));
});

test('approvals (luna): a declined command and a declined patch close with ok false', () => {
  const { outs } = run('approvals');
  const evs = events(outs);
  const calls = evs.filter((x) => x.type === 'tool.call');
  assert.deepEqual(calls.map((c) => c.name), ['shell', 'apply_patch']);
  for (const c of calls) {
    const r = evs.find((x) => x.type === 'tool.result' && x.itemId === c.itemId);
    assert.equal(r.ok, false);
    assert.equal(r.text, 'Declined');
  }
  assert.equal(results(outs).length, 2);
});

test('approvals-accepted (sol): accepted rows ok, ls runs as a listing, declined ones not ok', () => {
  const { outs } = run('approvals-accepted');
  const evs = events(outs);
  const rows = evs.filter((x) => x.type === 'tool.call').map((c) => ({ c, r: evs.find((x) => x.type === 'tool.result' && x.itemId === c.itemId) }));
  assert.deepEqual(rows.map(({ c }) => c.title), ['touch b.txt', 'Edit c.txt', 'ls', 'touch d.txt', rows[4].c.title]);
  assert.deepEqual(rows.map(({ r }) => r.ok), [true, true, true, false, false]);
  assert.equal(rows[2].c.kind, 'search');
  assert.equal(rows[2].r.text, 'b.txt\nc.txt\n');
  assert.equal(results(outs).length, 5);
});

test('interrupt: the open command closes as interrupted and the turn ends interrupted', () => {
  const { outs, normalizers } = run('interrupt');
  const evs = events(outs);
  const call = evs.find((x) => x.type === 'tool.call');
  assert.equal(call.title, 'sleep 30');
  const r = evs.find((x) => x.type === 'tool.result' && x.itemId === call.itemId);
  assert.deepEqual([r.ok, r.text], [false, 'Interrupted']);
  assert.equal(results(outs)[0].outcome, 'interrupted');
  assert.equal(of(outs, 'tasks').length, 0, 'an interrupted command is no background terminal');
  assert.deepEqual(normalizers.A.interruptedCommands(), [call.itemId]);
});

test('failure: the API error is pulled out of its JSON, with the warning noted once', () => {
  const { outs } = run('failure');
  const [r] = results(outs);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.error, "The 'gpt-does-not-exist-tb' model is not supported when using Codex with a ChatGPT account.");
  assert.equal(r.errorKind, undefined, 'codexErrorInfo "other" has no kind');
  const notes = events(outs).filter((x) => x.type === 'system.note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /^Model metadata for `gpt-does-not-exist-tb` not found/);
});

test('resume: the restored total is the baseline, so usage is the new turn only', () => {
  const { outs } = run('resume');
  const rs = results(outs);
  assert.equal(rs.length, 2);
  assert.ok(events(outs).some((x) => x.type === 'assistant.text' && /pineapple/i.test(x.text)));
  const second = rs[1].usage as any;
  // A whole thread's total would be over 30k by now; one small turn is ~15k.
  assert.ok(second.inputTokens > 10000 && second.inputTokens < 20000, `usage ${JSON.stringify(second)}`);
  assert.equal(rs[1].answers, 'turn-4');
});

test('image-in: the sent image is only echoed, nothing else comes of it', () => {
  const { outs } = run('image-in');
  const evs = events(outs);
  assert.equal(evs.filter((x) => x.type === 'tool.call').length, 0);
  assert.equal(evs.find((x) => x.type === 'assistant.text').text.toLowerCase().replace(/\W/g, ''), 'red');
});

test('image-view: the viewed file is copied into the media folder', () => {
  const { outs, e } = run('image-view', env(), (_l, e) => fs.writeFileSync(path.join(e.cwd, 'dot.png'), makePng(32, 32, [255, 255, 255])));
  const evs = events(outs);
  const call = evs.find((x) => x.type === 'tool.call');
  assert.deepEqual([call.name, call.kind, call.title], ['view_image', 'read', 'View dot.png']);
  const r = evs.find((x) => x.type === 'tool.result' && x.itemId === call.itemId);
  assert.equal(r.ok, true);
  assert.equal(r.images.length, 1);
  assert.equal(path.dirname(r.images[0].path), e.media);
  assert.deepEqual([r.images[0].mediaType, r.images[0].width, r.images[0].height], ['image/png', 32, 32]);
});

test('image-view: a file:// path is stripped before copying', () => {
  const e = env();
  fs.writeFileSync(path.join(e.cwd, 'dot.png'), makePng(5, 5));
  const lines = load('image-view', e);
  for (const l of lines) {
    const item = (l.msg as any).params?.item;
    if (item?.type === 'imageView') item.path = `file://${item.path}`;
  }
  const { outs } = replay(lines, e);
  const evs = events(outs);
  assert.equal(evs.find((x) => x.type === 'tool.call').title, 'View dot.png');
  assert.equal(evs.find((x) => x.type === 'tool.result').images[0].width, 5);
});

test('image-generation: copied from savedPath, prompt as text, no base64 anywhere', () => {
  const e = env();
  const lines = load('image-generation', e);
  const thread = fixtureThread(lines);
  const item = lines.map((l) => (l.msg as any).params?.item).find((i) => i?.type === 'imageGeneration' && i.savedPath);
  fs.mkdirSync(path.join(e.codexHome, 'generated_images', thread), { recursive: true });
  fs.writeFileSync(item.savedPath, makePng(20, 10, [0, 0, 255]));
  const { outs } = replay(lines, e);
  assertProtocol(outs);
  const evs = events(outs);
  const call = evs.find((x) => x.type === 'tool.call');
  assert.deepEqual([call.name, call.kind, call.title, call.input], ['image_generation', 'image', 'Generate image', {}]);
  const r = evs.find((x) => x.type === 'tool.result' && x.itemId === call.itemId);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'a single flat blue square icon on a white background');
  assert.deepEqual({ ...r.images[0], path: path.dirname(r.images[0].path) }, { path: e.media, mediaType: 'image/png', width: 20, height: 10 });
  // The original stays where Codex put it.
  assert.ok(fs.existsSync(item.savedPath));
  assert.ok(!JSON.stringify(outs).includes(TINY_PNG_B64), 'the base64 result never reaches an event');
});

test('image-generation: falls back to the base64 result when savedPath is missing', () => {
  const { outs, e } = run('image-generation');
  const r = events(outs).find((x) => x.type === 'tool.result');
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.images[0].path), e.media);
  // The sanitiser's stand-in PNG is 4 x 4.
  assert.deepEqual([r.images[0].width, r.images[0].height], [4, 4]);
});

test('image-generation: a usage-limit failure and a remote-only image', () => {
  const e = env();
  const n = new CodexNormalizer(e.ctx);
  n.setThread('th');
  n.handle('item/started', { threadId: 'th', item: { type: 'imageGeneration', id: 'ig1', status: 'in_progress', revisedPrompt: null, result: '', failure: null } });
  const failed = events(n.handle('item/completed', { threadId: 'th', item: { type: 'imageGeneration', id: 'ig1', status: 'failed', revisedPrompt: null, result: '', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1793599387 } } }));
  assert.equal(failed[0].ok, false);
  assert.match(failed[0].text, /^Image generation limit reached, resets \S+/);
  const remote = events(n.handle('item/completed', { threadId: 'th', item: { type: 'imageGeneration', id: 'ig2', status: 'completed', revisedPrompt: 'a cat', failure: null, fileId: 'file_123', inputImages: [{ path: '/x/photo.jpg', sha256: 'a' }, { path: '/x/style.png', sha256: 'b' }] } }));
  const r = remote.find((x) => x.type === 'tool.result');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'a cat\nEdited from photo.jpg, style.png\nThe image is stored remotely (file_123)');
});

test('mcp-image: an MCP image block and an image resource saved, a dynamic data: URL saved', () => {
  const { outs, e } = run('mcp-image');
  const evs = events(outs);
  const mcp = evs.find((x) => x.type === 'tool.call' && x.name === 'mcp__computer-use__screenshot');
  assert.equal(mcp.kind, 'mcp');
  assert.deepEqual(mcp.input, { display: 1 });
  assert.deepEqual(deltas(outs).filter((d) => d.itemId === mcp.itemId).map((d) => d.text), ['Capturing\n']);
  const mr = evs.find((x) => x.type === 'tool.result' && x.itemId === mcp.itemId);
  assert.equal(mr.ok, true);
  assert.equal(mr.text, 'Captured display 1');
  assert.equal(mr.images.length, 2);
  assert.ok(mr.images.every((i: any) => path.dirname(i.path) === e.media && i.width === 6 && i.height === 3));
  assert.match(path.basename(mr.images[0].path), /^computer-use_screenshot-[0-9a-f]{10}\.png$/);
  const dyn = evs.find((x) => x.type === 'tool.call' && x.name === 'mcp__threadbear__read_thread');
  assert.equal(dyn.title, 'Read this thread');
  const dr = evs.find((x) => x.type === 'tool.result' && x.itemId === dyn.itemId);
  assert.equal(dr.images.length, 1);
  assert.equal(dr.text, 'Here is the picture.\nhttps://example.com/pic.png');
});

test('rate-limits: the codex bucket, credits, plan and a blocked reading', () => {
  const { outs } = run('rate-limits');
  const limits = of(outs, 'limits');
  const read = limits.find((l) => l.windows.length > 0)!;
  assert.deepEqual(read.windows, [{ kind: 'weekly', title: 'Weekly', remainingPercent: 95, resetsAt: new Date(1793599387 * 1000).toISOString(), detail: '1,234 credits' }]);
  assert.equal(read.plan, 'Pro Lite');
  assert.equal(read.blocked, false, 'always said, so a block can lift');
  assert.ok(limits.some((l) => l.windows.length === 0 && l.plan === 'Pro Lite'), 'account/read and account/updated give the plan');
  assert.ok(limits.every((l) => l.email === undefined), 'the sanitised captures have no email');
  // Both windows, another bucket, and a reached limit.
  const both = limitsFromRateLimits({
    ordinaryUsageAllowed: false,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: { usedPercent: 22.5, windowDurationMins: 10080, resetsAt: null }, credits: { hasCredits: false, unlimited: false, balance: null }, planType: 'pro', rateLimitReachedType: null },
    rateLimitsByLimitId: { other_model: { limitId: 'other_model', limitName: 'GPT-6-Astra', primary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: null }, secondary: null } },
  })!;
  assert.deepEqual(both.windows.map((w) => [w.kind, w.title, w.remainingPercent]), [['five_hour', '5-hour', 89], ['weekly', 'Weekly', 77.5], ['other', 'GPT-6-Astra', 50]]);
  assert.equal(both.blocked, true);
  assert.equal(both.plan, 'Pro');
  assert.equal(limitsFromRateLimits({ rateLimits: { limitId: 'codex', primary: null, secondary: null, rateLimitReachedType: 'rate_limit_reached' } })!.blocked, true);
  assert.equal(limitsFromAccount({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'prolite' } })!.email, 'someone@example.com');
});

test('reasoning: deltas build the summary with no leading blank line; an empty item gives nothing', () => {
  const { outs } = run('reasoning');
  const rs = events(outs).filter((x) => x.type === 'reasoning');
  assert.equal(rs.length, 1, 'only the first thread reasoned; the second item was empty');
  assert.match(rs[0].text, /^\*\*Calculating time differences\*\*\n\n/);
  const ds = deltas(outs).filter((d) => d.type === 'reasoning.delta' && d.itemId === rs[0].itemId);
  assert.equal(ds.map((d) => d.text).join(''), rs[0].text);
  assert.equal(results(outs).length, 2);
});

test('reasoning: a second summary part is joined by a blank line', () => {
  const n = new CodexNormalizer(env().ctx);
  const outs = [
    ...n.handle('item/started', { item: { type: 'reasoning', id: 'r1', summary: [], content: [] } }),
    ...n.handle('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 0 }),
    ...n.handle('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '**One**\n\nfirst' }),
    ...n.handle('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 1 }),
    ...n.handle('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '**Two**\n\nsecond' }),
    ...n.handle('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['**One**\n\nfirst', '**Two**\n\nsecond'], content: [] } }),
  ];
  assert.equal(deltas(outs).map((d) => d.text).join(''), events(outs)[0].text);
  assert.equal(events(outs)[0].text, '**One**\n\nfirst\n\n**Two**\n\nsecond');
});

test('dynamic-tools: a Threadbear tool call shows as mcp__threadbear__<tool>, before and after a resume', () => {
  const { outs } = run('dynamic-tools');
  const evs = events(outs);
  const calls = evs.filter((x) => x.type === 'tool.call' && x.name.startsWith('mcp__'));
  assert.deepEqual(calls.map((c) => [c.name, c.kind]), [['mcp__threadbear__secret_word', 'mcp'], ['mcp__threadbear__secret_word', 'mcp']]);
  const texts = calls.map((c) => evs.find((x) => x.type === 'tool.result' && x.itemId === c.itemId)).map((r) => [r.ok, r.text]);
  assert.deepEqual(texts, [[true, 'The secret word is marmalade.'], [true, 'The secret word is quince.']]);
});

test('subagent: a row titled from agentPath, its result the child answer, the child image in the parent', () => {
  const { outs, e } = run('subagent', env(), (_l, e) => fs.writeFileSync(path.join(e.cwd, 'swatch.png'), makePng(16, 16, [0, 64, 255])));
  const evs = events(outs);
  const lines = load('subagent', e);
  const parent = fixtureThread(lines);
  const spawn = evs.find((x) => x.type === 'tool.call' && x.name === 'spawn_agent');
  assert.deepEqual([spawn.kind, spawn.title, spawn.input.model], ['task', 'image_color', 'gpt-6-luna']);
  const spawnAt = evs.indexOf(spawn);
  const view = evs.find((x) => x.type === 'tool.call' && x.name === 'view_image');
  assert.ok(evs.indexOf(view) > spawnAt, 'the child image comes after the subagent row');
  assert.match(view.itemId, /^[0-9a-f-]{36}\/exec-/);
  assert.notEqual(view.itemId.split('/')[0], parent);
  const viewResult = evs.find((x) => x.type === 'tool.result' && x.itemId === view.itemId);
  assert.equal(viewResult.images[0].width, 16);
  const spawnResult = evs.find((x) => x.type === 'tool.result' && x.itemId === spawn.itemId);
  assert.deepEqual([spawnResult.ok, spawnResult.text], [true, 'Blue']);
  // The child's command, turns and text stay out of the parent; `wait` is hidden.
  assert.equal(evs.filter((x) => x.type === 'tool.call').length, 2);
  assert.deepEqual(evs.filter((x) => x.type === 'assistant.text').map((x) => x.text), ['Blue']);
  assert.equal(results(outs).length, 1);
  assert.equal(of(outs, 'cliTurn').length, 0);
  assert.equal(of(outs, 'tasks').length, 0);
});

test('background-terminal: left open at a completed turn, reported in tasks, then filled in and dropped', () => {
  const { outs } = run('background-terminal');
  const call = events(outs).find((x) => x.type === 'tool.call');
  const resultAt = outs.findIndex((o) => o.kind === 'result');
  const before = outs.slice(0, resultAt);
  const after = outs.slice(resultAt + 1);
  assert.ok(!events(before).some((x) => x.type === 'tool.result' && x.itemId === call.itemId), 'not closed at the turn end');
  const tasks = of(before, 'tasks');
  assert.deepEqual(tasks.at(-1)!.tasks, [{ id: call.itemId, type: 'shell', kind: 'shell', description: call.input.command }]);
  assert.equal(results(outs)[0].outcome, 'completed');
  assert.deepEqual(deltas(after).map((d) => [d.itemId, d.text]), [[call.itemId, 'finished\n']]);
  const late = events(after).find((x) => x.type === 'tool.result');
  assert.equal(late.itemId, call.itemId);
  assert.equal(late.ok, true);
  assert.deepEqual(of(after, 'tasks').at(-1)!.tasks, []);
});

test('real-config: every notification method is mapped or ignored; the MCP failure and the warning noted once; no hook text', () => {
  const e = env();
  const lines = load('real-config', e);
  const known = new Set<string>([...MAPPED_METHODS, ...IGNORED_METHODS]);
  const methods = new Set(lines.filter((l) => l.dir === 'in' && (l.msg as any).method && (l.msg as any).id === undefined).map((l) => (l.msg as any).method as string));
  assert.deepEqual([...methods].filter((m) => !known.has(m)), []);
  const { outs } = replay(lines, e);
  assertProtocol(outs);
  const notes = events(outs).filter((x) => x.type === 'system.note').map((x) => x.text);
  assert.equal(notes.filter((t) => t.startsWith('Under-development features enabled')).length, 1);
  assert.deepEqual(notes.filter((t) => t.startsWith('MCP server')), ['MCP server paper didn\'t start: MCP startup failed: handshaking with MCP server failed']);
  assert.ok(!JSON.stringify(outs).includes('hook'), 'hooks are never shown');
  assert.equal(events(outs).find((x) => x.type === 'assistant.text').text, 'ok');
});

test('a turn that is not ours is a cliTurn and its result is own', () => {
  const n = new CodexNormalizer(env().ctx);
  n.setThread('th', 'gpt-6-luna');
  const outs = [...n.handle('turn/started', { threadId: 'th', turn: { id: 'goal-1', status: 'inProgress' } }), ...n.handle('turn/completed', { threadId: 'th', turn: { id: 'goal-1', status: 'completed', durationMs: 5 } })];
  assert.equal(of(outs, 'cliTurn').length, 1);
  assert.equal(results(outs)[0].own, true);
});

test('a turn/started before the turn/start reply still counts as ours', () => {
  const n = new CodexNormalizer(env().ctx);
  n.setThread('th');
  n.startingTurn('runner-1');
  const outs = [...n.handle('turn/started', { threadId: 'th', turn: { id: 'c1' } })];
  n.turnAccepted('c1');
  outs.push(...n.handle('turn/completed', { threadId: 'th', turn: { id: 'c1', status: 'completed', durationMs: 1 } }));
  assert.equal(of(outs, 'cliTurn').length, 0);
  assert.equal(results(outs)[0].answers, 'runner-1');
});

test('a child turn is neither a cliTurn nor the end of the parent turn; its tokens are not context', () => {
  const n = new CodexNormalizer(env().ctx);
  n.setThread('th');
  const from = { childThreadId: 'child' };
  const outs = [
    ...n.handle('turn/started', { threadId: 'child', turn: { id: 'ct' } }, from),
    ...n.handle('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: { total: { totalTokens: 9 }, last: { totalTokens: 9 } } }, from),
    ...n.handle('item/started', { threadId: 'child', item: { type: 'commandExecution', id: 'x', command: 'ls' } }, from),
    ...n.handle('turn/completed', { threadId: 'child', turn: { id: 'ct', status: 'completed' } }, from),
  ];
  assert.deepEqual(outs, []);
});

test('settings: a new model is reported as a session, effort once per change', () => {
  const n = new CodexNormalizer(env().ctx);
  n.setThread('th', 'gpt-6-luna');
  const s = (model: string, effort: string | null) => n.handle('thread/settings/updated', { threadId: 'th', threadSettings: { model, effort } });
  assert.deepEqual(s('gpt-6-luna', 'low'), [{ kind: 'effort', level: 'low' }]);
  assert.deepEqual(s('gpt-6-luna', 'low'), []);
  assert.deepEqual(s('gpt-6.1-sol', 'ultra'), [{ kind: 'effort', level: 'ultra' }, { kind: 'session', nativeSessionId: 'th', model: 'gpt-6.1-sol' }]);
  assert.deepEqual(s('gpt-6.1-sol', 'bogus'), []);
});

test('errors: a retry noted once per turn; a usage-limit failure gets its errorKind', () => {
  const n = new CodexNormalizer(env().ctx);
  n.setThread('th');
  n.startingTurn('r1');
  const outs = [
    ...n.handle('turn/started', { threadId: 'th', turn: { id: 't1' } }),
    ...n.handle('error', { threadId: 'th', willRetry: true, error: { message: 'stream disconnected' } }),
    ...n.handle('error', { threadId: 'th', willRetry: true, error: { message: 'stream disconnected again' } }),
    ...n.handle('error', { threadId: 'th', willRetry: false, error: { message: 'You have hit your usage limit.' } }),
    ...n.handle('turn/completed', { threadId: 'th', turn: { id: 't1', status: 'failed', durationMs: 3, error: { message: '', codexErrorInfo: 'usageLimitExceeded' } } }),
  ];
  assert.deepEqual(events(outs).map((x) => x.text), ['Retrying: stream disconnected']);
  const [r] = results(outs);
  assert.deepEqual([r.outcome, r.error, r.errorKind], ['failed', 'You have hit your usage limit.', 'usageLimit']);
  const kinds = ['contextWindowExceeded', 'unauthorized', { httpConnectionFailed: { httpStatusCode: 502 } }, { httpConnectionFailed: { httpStatusCode: null } }, { responseStreamDisconnected: {} }].map((info, i) => {
    n.handle('turn/started', { threadId: 'th', turn: { id: `k${i}` } });
    return results(n.handle('turn/completed', { threadId: 'th', turn: { id: `k${i}`, status: 'failed', error: { message: 'x', codexErrorInfo: info } } }))[0].errorKind;
  });
  assert.deepEqual(kinds, ['contextWindow', 'auth', undefined, 'network', 'network']);
});

test('plan updates: steps and statuses, a new explanation noted', () => {
  const n = new CodexNormalizer(env().ctx);
  const outs = [
    ...n.handle('turn/plan/updated', { explanation: 'Doing it in two steps', plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }, { step: 'Test', status: 'pending' }] }),
    ...n.handle('turn/plan/updated', { explanation: 'Doing it in two steps', plan: [{ step: 'Read', status: 'completed' }] }),
  ];
  const evs = events(outs);
  assert.deepEqual(evs[0].entries, [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Test', status: 'pending' }]);
  assert.deepEqual(evs.filter((x) => x.type === 'system.note').map((x) => x.text), ['Doing it in two steps']);
});

test("plan mode's proposed plan is a plan card; a subagent's isn't", () => {
  const n = new CodexNormalizer(env().ctx);
  const outs = [
    ...n.handle('item/started', { item: { type: 'plan', id: 'p1', text: '' } }),
    ...n.handle('item/completed', { item: { type: 'plan', id: 'p1', text: '1. Read\n2. Write\n' } }),
  ];
  assert.deepEqual(outs.filter((o) => o.kind === 'planProposed'), [{ kind: 'planProposed', itemId: 'p1', text: '1. Read\n2. Write' }]);
  assert.equal(events(outs).length, 0);
});

test('an unknown item type shows as a plain row, closed with its text', () => {
  const n = new CodexNormalizer(env().ctx);
  const outs = [
    ...n.handle('item/started', { item: { type: 'hologram', id: 'h1', status: 'inProgress' } }),
    ...n.handle('item/completed', { item: { type: 'hologram', id: 'h1', status: 'completed', caption: 'A floating cube' } }),
  ];
  assertProtocol(outs);
  const evs = events(outs);
  assert.deepEqual([evs[0].name, evs[0].kind, evs[0].title], ['codex_hologram', 'other', 'Codex hologram']);
  assert.deepEqual([evs[1].ok, evs[1].text], [true, 'A floating cube']);
});

test('other rows: web search, sleep, collab tools, compaction once, review notes', () => {
  const n = new CodexNormalizer(env().ctx);
  n.handle('turn/started', { turn: { id: 't' } });
  const outs = [
    ...n.handle('item/started', { item: { type: 'webSearch', id: 'w', query: 'codex app-server', action: null, results: null } }),
    ...n.handle('item/completed', { item: { type: 'webSearch', id: 'w', query: 'codex app-server', action: null, results: [{ title: 'Docs', url: 'https://example.com' }] } }),
    ...n.handle('item/started', { item: { type: 'sleep', id: 's', durationMs: 2000 } }),
    ...n.handle('item/completed', { item: { type: 'sleep', id: 's', durationMs: 2000 } }),
    ...n.handle('item/started', { item: { type: 'collabAgentToolCall', id: 'c', tool: 'sendInput', status: 'inProgress', prompt: 'Check the tests\nthen report', receiverThreadIds: [] } }),
    ...n.handle('item/completed', { item: { type: 'collabAgentToolCall', id: 'c', tool: 'sendInput', status: 'completed', prompt: 'Check the tests\nthen report', receiverThreadIds: [] } }),
    ...n.handle('item/completed', { item: { type: 'collabAgentToolCall', id: 'wait1', tool: 'wait', status: 'completed', receiverThreadIds: [] } }),
    ...n.handle('item/completed', { item: { type: 'contextCompaction', id: 'cc' } }),
    ...n.handle('thread/compacted', { threadId: 'th', turnId: 't' }),
    ...n.handle('item/started', { item: { type: 'enteredReviewMode', id: 'rv', review: 'x' } }),
    ...n.handle('item/completed', { item: { type: 'enteredReviewMode', id: 'rv', review: 'x' } }),
  ];
  assertProtocol(outs);
  const evs = events(outs);
  const calls = evs.filter((x) => x.type === 'tool.call').map((x) => [x.kind, x.title]);
  assert.deepEqual(calls, [['web', 'Search the web for codex app-server'], ['other', 'Wait'], ['task', 'Check the tests']]);
  assert.equal(evs.find((x) => x.type === 'tool.result' && x.itemId === 'w').text, 'Docs https://example.com');
  assert.deepEqual(evs.filter((x) => x.type === 'system.note').map((x) => x.text), ['Compacted the conversation', 'Review started']);
  assert.ok(!evs.some((x) => x.itemId === 'wait1'), 'wait has no row and no result');
});

test('MCP errors and failed dynamic tools are not ok', () => {
  const n = new CodexNormalizer(env().ctx);
  n.handle('item/started', { item: { type: 'mcpToolCall', id: 'm', server: 's', tool: 't', arguments: {}, status: 'inProgress' } });
  const m = events(n.handle('item/completed', { item: { type: 'mcpToolCall', id: 'm', server: 's', tool: 't', arguments: {}, status: 'failed', error: { message: 'tool exploded' }, result: null } }))[0];
  assert.deepEqual([m.ok, m.text], [false, 'tool exploded']);
  const d = events(n.handle('item/completed', { item: { type: 'dynamicToolCall', id: 'd', namespace: null, tool: 'mystery', arguments: {}, status: 'completed', success: false, contentItems: [{ type: 'inputText', text: 'No such tool' }] } }));
  assert.equal(d[0].name, 'mystery', 'a completion with no start opens its row');
  assert.deepEqual([d[1].ok, d[1].text], [false, 'No such tool']);
});

test('lineTooLarge: an item whose completion line was skipped closes as "Too large to show"', () => {
  const n = new CodexNormalizer(env().ctx);
  n.setThread('th');
  n.handle('turn/started', { threadId: 'th', turn: { id: 't' } });
  n.handle('item/started', { threadId: 'th', item: { type: 'imageGeneration', id: 'ig-big', status: 'in_progress', result: '', revisedPrompt: null, failure: null } });
  n.handle('item/started', { threadId: 'th', item: { type: 'commandExecution', id: 'cmd', command: 'sleep 9', commandActions: [] } });
  n.lineTooLarge('{"method":"item/completed","params":{"item":{"type":"imageGeneration","id":"ig-big","status":"completed","result":"iVBORw0KGgo');
  const outs = n.handle('turn/completed', { threadId: 'th', turn: { id: 't', status: 'completed', durationMs: 1 } });
  const r = events(outs).find((x) => x.type === 'tool.result');
  assert.deepEqual([r.itemId, r.ok, r.text], ['ig-big', false, 'Too large to show']);
  assert.deepEqual(of(outs, 'tasks')[0].tasks.map((t) => t.id), ['cmd'], 'the open command is still a background terminal');
  // A line it can't place marks the turn's other open items.
  n.handle('turn/started', { threadId: 'th', turn: { id: 't2' } });
  n.handle('item/started', { threadId: 'th', item: { type: 'mcpToolCall', id: 'mm', server: 's', tool: 't', arguments: {} } });
  n.lineTooLarge('{"garbage');
  const r2 = events(n.handle('turn/completed', { threadId: 'th', turn: { id: 't2', status: 'completed' } })).find((x) => x.type === 'tool.result');
  assert.equal(r2.text, 'Too large to show');
  // The same through handle(), as the adapter's line reader reports it.
  n.handle('turn/started', { threadId: 'th', turn: { id: 't3' } });
  n.handle('item/started', { threadId: 'child', item: { type: 'imageView', id: 'v', path: '/nope.png' } }, { childThreadId: 'child' });
  n.handle(OVERSIZED_LINE, { bytes: 300_000_000, method: 'item/completed', itemId: 'v' }, { childThreadId: 'child' });
  const r3 = events(n.handle('turn/completed', { threadId: 'th', turn: { id: 't3', status: 'completed' } })).find((x) => x.type === 'tool.result');
  assert.deepEqual([r3.itemId, r3.text], ['child/v', 'Too large to show']);
});

test('a 2.5 MB image completion line decodes and saves, and closeOpen ends what is left', () => {
  const e = env();
  const n = new CodexNormalizer(e.ctx);
  // A real PNG with 1.9 MB of padding after its end, as big as Mike's real
  // generated images get on the wire.
  const big = Buffer.concat([makePng(800, 800, [1, 2, 3]), Buffer.alloc(1_900_000, 7)]);
  const line = JSON.stringify({ method: 'item/completed', params: { threadId: 'th', item: { type: 'imageGeneration', id: 'ig', status: 'completed', revisedPrompt: 'x', result: big.toString('base64'), failure: null } } });
  assert.ok(line.length >= 2_500_000);
  const msg = JSON.parse(line);
  const r = events(n.handle(msg.method, msg.params))[1];
  assert.equal(r.ok, true);
  assert.deepEqual([r.images[0].width, r.images[0].height], [800, 800]);
  n.handle('item/started', { item: { type: 'commandExecution', id: 'bg', command: 'sleep 99' } });
  n.handle('turn/completed', { turn: { id: 'x', status: 'completed' } });
  const closed = n.closeOpen('The session ended');
  assert.deepEqual(events(closed).map((x) => [x.itemId, x.ok, x.text]), [['bg', false, 'The session ended']]);
  assert.deepEqual(of(closed, 'tasks')[0].tasks, []);
});

test('big command output is cut to 64 KB with the rest in a blob', () => {
  const e = env();
  const n = new CodexNormalizer(e.ctx);
  n.handle('item/started', { item: { type: 'commandExecution', id: 'out', command: 'yes' } });
  const r = events(n.handle('item/completed', { item: { type: 'commandExecution', id: 'out', command: 'yes', status: 'completed', exitCode: 0, aggregatedOutput: 'y\n'.repeat(50_000) } }))[0];
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.text), 64 * 1024);
  assert.equal(fs.readFileSync(r.blobPath, 'utf8').length, 100_000);
  const nul = events(n.handle('item/completed', { item: { type: 'commandExecution', id: 'nul', command: 'true', status: 'completed', exitCode: 0, aggregatedOutput: null } }));
  assert.equal(nul.at(-1).text, '');
});

test('innerCommand strips the shell wrapper, keeping quotes inside', () => {
  assert.equal(innerCommand("/bin/zsh -lc 'echo hi'"), 'echo hi');
  assert.equal(innerCommand('/bin/zsh -lc ls'), 'ls');
  assert.equal(innerCommand("/bin/zsh -lc 'echo '\\''quoted'\\'''"), "echo 'quoted'");
  assert.equal(innerCommand('bash -c "echo \\"x\\""'), 'echo "x"');
  assert.equal(innerCommand('git status'), 'git status');
  assert.equal(innerCommand("/bin/zsh -lc 'a' 'b'"), "/bin/zsh -lc 'a' 'b'");
});

test('parseHunks reads counts, defaults and context lines', () => {
  assert.deepEqual(parseHunks('--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn\n a\n-b\n+c\n+d\n\\ No newline at end of file\n'), [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' a', '-b', '+c', '+d'] }]);
});

test('the sanitiser rewrites temp folders, swaps base64, drops the account id, and its check finds leaks', () => {
  const recs: Rec[] = [
    { proc: 'A', dir: 'in', msg: { id: 1, result: { userAgent: 'x/0.164.0 (Mac OS 26.6.2; arm64) unknown', codexHome: '/Users/someone/.codex', accountId: 'acct-1234567', workspaceRouting: { chatgptAccountId: 'acct-1234567' } } } },
    { proc: 'A', dir: 'in', msg: { method: 'item/completed', params: { item: { type: 'imageGeneration', id: 'i', result: 'A'.repeat(5000), savedPath: '/Users/someone/.codex/generated_images/t/i.png' }, threadId: 't' } } },
    { proc: 'A', dir: 'in', msg: { method: 'item/started', params: { item: { type: 'commandExecution', id: 'c', command: "/bin/zsh -lc 'ls /private/tmp/tb-spike2-ask.9Wbvay/x'", cwd: '/tmp/tb-step4-rec/run' } } } },
    { proc: 'A', dir: 'in', msg: { method: 'turn/moderationMetadata', params: { metadata: {} } } },
    { proc: 'A', dir: 'in', msg: { method: 'remoteControl/status/changed', params: { serverName: 'somehost.local', installationId: 'inst-7654321' } } },
  ];
  const { records, secrets } = sanitizeRecords(recs);
  const text = toNdjson(records);
  assert.equal(records.length, 4, 'moderation metadata dropped');
  assert.deepEqual(leaks(text, secrets, ['someone']), []);
  assert.ok(text.includes('(macOS; arm64)') && text.includes('"/codex-home"') && text.includes('/codex-home/generated_images/t/i.png'));
  assert.ok(text.includes("ls /work/proj/x") && text.includes('"cwd":"/work/proj"'));
  assert.ok(text.includes(TINY_PNG_B64) && !text.includes('AAAAAAAAAA'));
  assert.ok(secrets.includes('acct-1234567') && secrets.includes('inst-7654321'));
  // The check itself.
  assert.ok(leaks('{"x":"someone@example.com"}', [], []).length);
  assert.ok(leaks('{"x":"/Users/bob/a"}', [], []).length);
  assert.ok(leaks('{"x":"abc...[400 chars]"}', [], []).length);
  assert.ok(leaks('{"x":"acct-1234567"}', ['acct-1234567'], []).length);
  assert.ok(leaks(`{"x":"${'QUJD'.repeat(600)}"}`, [], []).length);
  assert.ok(leaks('{"host":"Bobs-Mac"}', [], ['bobs-mac']).length);
  assert.ok(leaks('{"x":"/home/vision/a"}', [], ['vision']).length);
  assert.deepEqual(leaks('{"revision":"r1"}', [], ['vision']), []);
});

test('the committed Codex fixtures hold nothing private', () => {
  for (const f of fs.readdirSync(FIX).filter((f) => f.endsWith('.ndjson'))) {
    const text = fs.readFileSync(path.join(FIX, f), 'utf8');
    assert.deepEqual(leaks(text), [], f);
  }
});

// GPT-6.1-Sol wrote its end_turn call into a final answer rather than make
// it, and Mike read the lot (28 Oct 2026).
test('a tool call written into a message is cut off it', () => {
  const leaked =
    'Nothing needed from you right now; the review is finished.\n fortheassistant to=functions.exec کامنتری code segmente\ntext(await tools.threadbear__end_turn({needs:"nothing"}));\n 只有精品functions.exec (commentary) ым\nScript completed\nWall time 0.1 seconds\nOutput:\n{"needs":"nothing"}';
  assert.equal(stripLeakedToolCall(leaked), 'Nothing needed from you right now; the review is finished.');
  assert.equal(stripLeakedToolCall('Done.\nto=functions.exec code'), 'Done.');
  // Plain text, and a message about the token, keep every word.
  for (const keep of ['All done.', 'It wrote `to=functions.exec` into the reply.', 'Set to=5 and rerun.']) assert.equal(stripLeakedToolCall(keep), keep);
});

test("a patch never says it wrote files, applied or not: patch trust can't tie Codex's result to bytes", () => {
  const n = new CodexNormalizer(env().ctx);
  const changes = [
    { path: '/w/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
    { path: '/w/old.ts', kind: { type: 'update', move_path: '/w/moved.ts' }, diff: '' },
    { path: '/w/new.ts', kind: { type: 'add' }, diff: 'n\n' },
    { path: '/w/gone.ts', kind: { type: 'delete' }, diff: 'g\n' },
  ];
  const wrote = (outs: AdapterOutput[]) => outs.filter((o) => o.kind === 'wrote');
  for (const status of ['declined', 'failed']) {
    const id = `p-${status}`;
    assert.deepEqual(wrote(n.handle('item/started', { threadId: 'th', item: { type: 'fileChange', id, changes, status: 'inProgress' } })), []);
    assert.deepEqual(wrote(n.handle('item/fileChange/patchUpdated', { threadId: 'th', itemId: id, changes })), []);
    assert.deepEqual(wrote(n.handle('item/completed', { threadId: 'th', item: { type: 'fileChange', id, changes, status } })), [], status);
  }
  n.handle('item/started', { threadId: 'th', item: { type: 'fileChange', id: 'ok', changes, status: 'inProgress' } });
  const done = n.handle('item/completed', { threadId: 'th', item: { type: 'fileChange', id: 'ok', changes, status: 'completed' } });
  assert.deepEqual(wrote(done), []);
  assert.ok(done.some((o) => o.kind === 'event' && o.event.type === 'tool.result' && o.event.ok));
});
