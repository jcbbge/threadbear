import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { PANEL_ACK_WAIT_MS, resolvePanel } from '../../src/panel-requests.ts';
import { AGENT_MESSAGE_PREFIX } from '../../src/protocol.ts';
import type { Panel } from '../../src/protocol.ts';

// docs/protocol.md, "Showing panels".

const convex: Panel = { id: 'convex.dashboard', title: 'Convex', kind: 'url', url: 'https://dashboard.convex.dev', patch: 'convex' };
const sim: Panel = { id: 'xcode.simulator', title: 'Simulator', kind: 'image', patch: 'xcode' };

test('a panel is named by its id or title in any case; the built-in ones by name', () => {
  const has = { panels: [convex, sim], hasPatches: true };
  assert.deepEqual(resolvePanel('highlights', has), { id: 'highlights', title: 'Highlights' });
  assert.deepEqual(resolvePanel(' Usage ', has), { id: 'usage', title: 'Usage' });
  assert.deepEqual(resolvePanel('updates', has), { id: 'updates', title: 'Updates' });
  assert.deepEqual(resolvePanel('Connectors', has), { id: 'connectors', title: 'Connectors' });
  assert.deepEqual(resolvePanel('Browser', has), { id: 'threadbear.browser', title: 'Browser' });
  assert.deepEqual(resolvePanel('threadbear.browser', has), { id: 'threadbear.browser', title: 'Browser' });
  assert.deepEqual(resolvePanel('Patches', has), { id: 'patches', title: 'Patches' });
  assert.deepEqual(resolvePanel('convex.dashboard', has), { id: 'convex.dashboard', title: 'Convex' });
  assert.deepEqual(resolvePanel('CONVEX', has), { id: 'convex.dashboard', title: 'Convex' });
  assert.deepEqual(resolvePanel('simulator', has), { id: 'xcode.simulator', title: 'Simulator' });
  assert.throws(() => resolvePanel('storybook', has), /No panel called storybook\. This thread has highlights, patches, browser, convex\.dashboard \(Convex\), xcode\.simulator \(Simulator\), usage, updates and connectors\./);
  // Patches is only a panel when the thread has patches.
  assert.throws(() => resolvePanel('patches', { panels: [], hasPatches: false }), /This thread has highlights, browser, usage, updates and connectors\./);
  assert.throws(() => resolvePanel('  ', has), /Name a panel/);
});

// The show_panel tool, as an agent calls it.
function showTool(h: ReturnType<typeof makeHarness>, threadId: string) {
  const t = buildThreadbearTools(h.runner, threadId).find((x) => x.name === 'show_panel');
  assert.ok(t, 'show_panel');
  return async (args: Record<string, unknown>) => {
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
}

function convexFolder(): string {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'convex'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

test('show_panel puts a request on the thread, and says it waits when the app does not show it', async () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Set up the schema', accountId: 'claude-3', cwd: convexFolder() });
  const pending = showTool(h, thread.id)({ panel: 'convex', where: 'right' });
  // The tool first checks the caller isn't sandboxed (a sandboxed one asks).
  await tick();
  const asked = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(asked as never), []);
  assert.equal(asked.panelRequest?.panel, 'convex.dashboard');
  assert.equal(asked.panelRequest?.title, 'Convex');
  assert.equal(asked.panelRequest?.where, 'right');
  assert.ok(h.notes.some((n) => n.method === 'thread.updated' && n.params.thread.panelRequest?.id === asked.panelRequest?.id), 'the summary goes out');
  h.clock.advance(PANEL_ACK_WAIT_MS);
  const res = await pending;
  assert.equal(res.error, false, res.text);
  assert.match(res.text, /Convex will open when the user next looks at this thread/);
  // Still waiting on the thread for him, and kept across a restart.
  assert.ok(h.runner.get(thread.id).panelRequest);
  h.runner.flush();
  const rec = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', thread.id, 'thread.json'), 'utf8'));
  assert.equal(rec.panelRequest.panel, 'convex.dashboard');
});

test('the app showing it clears the request and the tool says Mike has it in front of him', async () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  const pending = showTool(h, thread.id)({ panel: 'Highlights' });
  await tick();
  const request = h.runner.get(thread.id).panelRequest!;
  assert.equal(request.where, undefined);
  // A stale id changes nothing.
  h.runner.panelShown(thread.id, 'not-this-one');
  assert.equal(h.runner.get(thread.id).panelRequest?.id, request.id);
  const { thread: after } = h.runner.panelShown(thread.id, request.id);
  assert.equal(after.panelRequest, undefined);
  const res = await pending;
  assert.match(res.text, /Highlights is open in front of the user now/);
});

test('an unknown panel is an error that lists the thread\'s', async () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  const res = await showTool(h, thread.id)({ panel: 'storybook' });
  assert.equal(res.error, true);
  assert.match(res.text, /No panel called storybook\. This thread has highlights, browser, usage, updates and connectors\./);
  assert.equal(h.runner.get(thread.id).panelRequest, undefined);
});

test('a newer request replaces the waiting one; Mike\'s own message clears it, an agent\'s does not', async () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  h.adapter.last.init();
  h.adapter.last.result('completed');
  const first = h.runner.showPanel(thread.id, { panel: 'usage' });
  const firstId = h.runner.get(thread.id).panelRequest!.id;
  const second = h.runner.showPanel(thread.id, { panel: 'updates', where: 'window' });
  assert.equal((await first).shown, false, 'the replaced one stops waiting');
  assert.notEqual(h.runner.get(thread.id).panelRequest!.id, firstId);
  assert.equal(h.runner.get(thread.id).panelRequest!.panel, 'updates');

  h.runner.send(thread.id, `${AGENT_MESSAGE_PREFIX}"Other" (abcd1234)]\n\nFYI`);
  assert.ok(h.runner.get(thread.id).panelRequest, 'an agent message leaves it');
  h.runner.send(thread.id, 'carry on', [], { origin: 'runner' });
  assert.ok(h.runner.get(thread.id).panelRequest, 'a runner message leaves it');
  h.runner.send(thread.id, 'thanks, looks good');
  assert.equal(h.runner.get(thread.id).panelRequest, undefined, 'Mike has seen the reply it went with');
  assert.equal((await second).shown, false);
});

test('a bad place is refused', async () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  await assert.rejects(h.runner.showPanel(thread.id, { panel: 'usage', where: 'middle' as never }), /where is tab, left, right, top, bottom or window/);
});
