import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import type { PersistedEvent } from '../../src/protocol.ts';
import { commitsIn, emptyHighlights, linksIn, observe, openTargets, pinItem, pushedBranches, remove, unpin, upsert, view, HIGHLIGHTS_KEPT } from '../../src/highlights.ts';

const HOME = '/Users/mike';
const CWD = '/Users/mike/dev/app';
const FILES = new Set(['/Users/mike/dev/app/docs/plan.md', '/Users/mike/dev/app/mock.html', '/Users/mike/notes/todo.md']);
const ctx = { cwd: CWD, home: HOME, exists: (p: string) => FILES.has(p) };

let seq = 0;
function ev(body: Record<string, unknown>): PersistedEvent {
  seq++;
  return { seq, ts: `2026-10-27T10:00:${String(seq).padStart(2, '0')}.000Z`, threadId: 't', ...body } as PersistedEvent;
}

test('links, PRs and existing files in a reply are found; code blocks and missing files are not', () => {
  const found = linksIn(
    [
      'The PR is [#19](https://github.com/mikecann/poddle/pull/19), preview at https://next-abc.vercel.app.',
      'Plan in `~/dev/app/docs/plan.md` and [the mockup](/Users/mike/dev/app/mock.html), notes at `/Users/mike/notes/todo.md:12`.',
      '`/Users/mike/missing.md` is gone.',
      '```',
      'https://example.com/in-a-code-block',
      '```',
      'Dev server: http://localhost:5173/, also http://localhost:5173 and **https://moose.convex.site**.',
    ].join('\n'),
    { cwd: CWD, home: HOME, isFile: ctx.exists },
  );
  assert.deepEqual(found.map((f) => f.id), [
    'pr:https://github.com/mikecann/poddle/pull/19',
    'file:/Users/mike/dev/app/mock.html',
    'file:/Users/mike/dev/app/docs/plan.md',
    'file:/Users/mike/notes/todo.md',
    'link:https://next-abc.vercel.app',
    'link:http://localhost:5173',
    'link:https://moose.convex.site',
  ]);
  assert.equal(found[0]!.title, 'mikecann/poddle#19');
  assert.equal(found[1]!.title, 'the mockup');
  assert.equal(found[2]!.title, 'plan.md');
});

test('open targets skip flags and the app after -a', () => {
  assert.deepEqual(openTargets('cd docs && open -a "Google Chrome" "mock up.html" && open https://x.dev/a'), ['mock up.html', 'https://x.dev/a']);
  assert.deepEqual(openTargets('echo open this; open -R ~/f.png --args --foo'), ['~/f.png']);
  assert.deepEqual(openTargets('git commit -m "open it"'), []);
});

test('git commit and push output', () => {
  assert.deepEqual(commitsIn('[main 91aba3e] App: hold ⌘ to see the keys\n 2 files changed'), [{ branch: 'main', sha: '91aba3e', message: 'App: hold ⌘ to see the keys' }]);
  assert.deepEqual(commitsIn('[feature (root-commit) abcdef1234] First'), [{ branch: 'feature', sha: 'abcdef1', message: 'First' }]);
  assert.deepEqual(pushedBranches('To github.com:mikecann/threadbear.git\n   d9896b4..91aba3e  main -> main\n * [new branch]      highlights -> highlights\n'), ['main', 'highlights']);
});

test('a thread\'s events become highlights: written review files, opens, PRs, commits and edits', () => {
  seq = 0;
  const state = emptyHighlights();
  const events = [
    ev({ type: 'tool.call', itemId: 'w1', name: 'Write', kind: 'write', title: 'Write', input: { file_path: 'docs/plan.md' } }),
    ev({ type: 'tool.call', itemId: 'w2', name: 'Write', kind: 'write', title: 'Write', input: { file_path: '/Users/mike/dev/app/src/x.ts' } }),
    ev({ type: 'edit.diff', itemId: 'e1', path: 'src/y.ts', hunks: [] }),
    ev({ type: 'tool.call', itemId: 'o1', name: 'Bash', kind: 'command', title: 'open', input: { command: 'open mock.html' } }),
    ev({ type: 'tool.call', itemId: 'c1', name: 'Bash', kind: 'command', title: 'git', input: { command: 'git add x && git commit -m "Add x"' } }),
    ev({ type: 'tool.result', itemId: 'c1', ok: true, text: '[feat 1234567] Add x\n 1 file changed', truncated: false, images: [] }),
    ev({ type: 'tool.call', itemId: 'p1', name: 'Bash', kind: 'command', title: 'gh', input: { command: 'git push -u origin feat && gh pr create --fill' } }),
    ev({ type: 'tool.result', itemId: 'p1', ok: true, text: ' * [new branch]      feat -> feat\nhttps://github.com/mikecann/app/pull/7\n', truncated: false, images: [] }),
    ev({ type: 'assistant.text', itemId: 'a1', text: 'Opened https://github.com/mikecann/app/pull/7 for you.' }),
  ];
  assert.equal(observe(state, events, ctx), true);
  const v = view(state);
  const byId = Object.fromEntries(v.highlights.map((h) => [h.id, h]));
  assert.equal(byId['file:/Users/mike/dev/app/docs/plan.md']?.how, 'written');
  assert.equal(byId['file:/Users/mike/dev/app/src/x.ts'], undefined, 'code goes in edited, not the list');
  assert.equal(byId['file:/Users/mike/dev/app/mock.html']?.how, 'opened');
  const commit = byId['commit:1234567']!;
  assert.deepEqual([commit.branch, commit.title, commit.pushed], ['feat', 'Add x', true]);
  const pr = byId['pr:https://github.com/mikecann/app/pull/7']!;
  assert.equal(pr.how, 'created', 'a later mention keeps how it was found');
  assert.equal(pr.lastSeq, 9);
  assert.equal(v.highlights[0]!.id, pr.id, 'newest mention first');
  assert.deepEqual(v.edited, ['/Users/mike/dev/app/src/y.ts', '/Users/mike/dev/app/src/x.ts', '/Users/mike/dev/app/docs/plan.md']);
  assert.equal(state.pending, undefined);
  // Seen events aren't read twice.
  assert.equal(observe(state, events, ctx), false);
});

test('Codex file changes and shell commands count too', () => {
  seq = 0;
  const state = emptyHighlights();
  observe(state, [
    ev({ type: 'tool.call', itemId: 'f', name: 'apply_patch', kind: 'write', title: 'Add', input: { paths: ['/Users/mike/notes/todo.md'] } }),
    ev({ type: 'tool.call', itemId: 's', name: 'shell', kind: 'command', title: 'open', input: { command: 'open plan.md', cwd: '/Users/mike/dev/app/docs' } }),
  ], ctx);
  assert.deepEqual(view(state).highlights.map((h) => [h.id, h.how]).sort(), [
    ['file:/Users/mike/dev/app/docs/plan.md', 'opened'],
    ['file:/Users/mike/notes/todo.md', 'written'],
  ]);
});

test('pins come first, merge with a found item, and unpin or remove take them off', () => {
  seq = 0;
  const state = emptyHighlights();
  observe(state, [ev({ type: 'assistant.text', itemId: 'a', text: 'See `/Users/mike/dev/app/mock.html` and https://a.dev/x' })], ctx);
  upsert(state, pinItem({ path: '/Users/mike/dev/app/mock.html', title: 'Sidebar mockup', note: 'Pick one of the three', show: true }, 5, '2026-10-27T10:01:00.000Z'));
  const v = view(state);
  assert.equal(v.highlights.length, 2);
  assert.deepEqual([v.highlights[0]!.how, v.highlights[0]!.title, v.highlights[0]!.note, v.highlights[0]!.show, v.highlights[0]!.seq], ['pinned', 'Sidebar mockup', 'Pick one of the three', true, 5]);
  assert.equal(unpin(state, 'file:/Users/mike/dev/app/mock.html'), true);
  assert.equal(unpin(state, 'link:https://a.dev/x'), false, 'only pins unpin');
  assert.equal(remove(state, 'link:https://a.dev/x'), true);
  observe(state, [ev({ type: 'assistant.text', itemId: 'b', text: 'Again: https://a.dev/x and `/Users/mike/dev/app/mock.html`' })], ctx);
  assert.deepEqual(view(state).highlights.map((h) => h.id), ['file:/Users/mike/dev/app/mock.html'], 'a removed one never comes back; an unpinned one can');
});

test('the list keeps the newest found items and every pin', () => {
  seq = 0;
  const state = emptyHighlights();
  upsert(state, pinItem({ url: 'https://pinned.dev' }, 0, '2026-10-27T10:00:00.000Z'));
  for (let i = 0; i < HIGHLIGHTS_KEPT + 5; i++) observe(state, [ev({ type: 'assistant.text', itemId: `a${i}`, text: `https://site${i}.dev` })], ctx);
  const v = view(state);
  assert.equal(v.highlights.length, HIGHLIGHTS_KEPT + 1);
  assert.equal(v.highlights[0]!.id, 'link:https://pinned.dev');
  assert.ok(!v.highlights.some((h) => h.id === 'link:https://site0.dev'));
});

// ------------------------------------------------- through the runner

test('the runner keeps a thread\'s highlights from its events, pins from the tool, and the brief', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mock.html'), '<p>hi</p>');
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Make a mockup', accountId: 'claude-3', cwd: dir });
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'w', name: 'Write', kind: 'write', title: 'Write', input: { file_path: path.join(dir, 'mock.html') } } });
  s.text('m1', 'Done: [PR](https://github.com/mikecann/app/pull/3).');
  s.result('completed');
  const first = h.runner.highlights(thread.id);
  assert.deepEqual(first.highlights.map((x) => [x.id, x.how]), [
    ['pr:https://github.com/mikecann/app/pull/3', 'mentioned'],
    [`file:${path.join(dir, 'mock.html')}`, 'written'],
  ]);
  assert.deepEqual(first.edited, [path.join(dir, 'mock.html')]);
  assert.equal(h.runner.get(thread.id).highlightsAt, undefined, 'found ones move lastSeq, not highlightsAt');

  const tools = buildThreadbearTools(h.runner, thread.id);
  const pin = tools.find((t) => t.name === 'pin')!;
  const res = await pin.handler({ path: 'mock.html', note: 'Pick a layout', show: true } as never, {} as never);
  assert.equal(res.isError, undefined, JSON.stringify(res));
  assert.doesNotMatch(JSON.stringify(res), /has scripts/, 'a page without scripts gets no warning');
  // One that draws itself is blank in the Mac app's static preview: say so.
  fs.writeFileSync(path.join(dir, 'chart.html'), '<div id=c></div><SCRIPT>draw()</SCRIPT>');
  const scripted = await pin.handler({ path: 'chart.html' } as never, {} as never);
  assert.match(JSON.stringify(scripted), /has scripts.*Run them/);
  h.runner.unpin(thread.id, `file:${path.join(dir, 'chart.html')}`);
  const bad = await pin.handler({ path: 'nope.html' } as never, {} as never);
  assert.equal(bad.isError, true);
  const after = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(after as never), []);
  assert.ok(after.highlightsAt);
  const pinned = h.runner.highlights(thread.id).highlights[0]!;
  assert.deepEqual([pinned.how, pinned.note, pinned.show], ['pinned', 'Pick a layout', true]);

  h.runner.removeHighlight(thread.id, 'pr:https://github.com/mikecann/app/pull/3');
  assert.deepEqual(h.runner.highlights(thread.id).highlights.map((x) => x.kind), ['file']);
  assert.throws(() => h.runner.removeHighlight(thread.id, 'pr:nope'), /no highlight/);

  h.runner.setBrief(thread.id, '  Waiting on Mike to pick a layout.  ');
  assert.deepEqual(h.runner.highlights(thread.id).brief?.text, 'Waiting on Mike to pick a layout.');

  // Kept with the thread across a restart, and not read twice.
  h.runner.flush();
  const rec = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', thread.id, 'thread.json'), 'utf8'));
  assert.equal(rec.highlights.items.length, 1);
  assert.equal(rec.brief.text, 'Waiting on Mike to pick a layout.');
});

test('a quiet commit shown with git log --oneline, and a quiet push', () => {
  seq = 0;
  const state = emptyHighlights();
  observe(state, [
    ev({ type: 'tool.call', itemId: 'c', name: 'Bash', kind: 'command', title: 'git', input: { command: "git add -A && git commit -q -F - <<'EOF'\nFind one episode\nEOF\ngit log --oneline -1" } }),
    ev({ type: 'tool.result', itemId: 'c', ok: true, text: '456680b (HEAD -> single-episode) Find one episode\n', truncated: false, images: [] }),
    ev({ type: 'tool.call', itemId: 'p', name: 'Bash', kind: 'command', title: 'git', input: { command: 'git push -q -u origin single-episode' } }),
    ev({ type: 'tool.result', itemId: 'p', ok: true, text: 'remote: https://github.com/mikecann/poddle/pull/new/single-episode\n', truncated: false, images: [] }),
    ev({ type: 'tool.call', itemId: 'l', name: 'Bash', kind: 'command', title: 'git', input: { command: 'git log --oneline -3' } }),
    ev({ type: 'tool.result', itemId: 'l', ok: true, text: 'aaaaaaa Not a commit this thread made\n', truncated: false, images: [] }),
  ], ctx);
  assert.deepEqual(view(state).highlights.map((h) => [h.id, h.title, h.branch, h.pushed]), [['commit:456680b', 'Find one episode', 'single-episode', true]]);
});

test('pageHasScripts: handlers and javascript: links count, and a FIFO never blocks', async () => {
  const { pageHasScripts } = await import('../../src/runner/highlights.ts');
  const dir = tmpDir();
  const page = (name: string, html: string) => (fs.writeFileSync(path.join(dir, name), html), path.join(dir, name));
  assert.equal(pageHasScripts(page('a.html', '<body onload="draw()">')), true);
  assert.equal(pageHasScripts(page('a2.html', '<body\n  onload = "draw()">')), true);
  assert.equal(pageHasScripts(page('b.htm', '<a href="javascript:go()">go</a>')), true);
  assert.equal(pageHasScripts(page('c.html', '<p>Just words, once = twice</p>')), false);
  assert.equal(pageHasScripts(page('d.md', '<script>x</script>')), false, 'only pages');
  const { execFileSync } = await import('node:child_process');
  execFileSync('mkfifo', [path.join(dir, 'pipe.html')]);
  assert.equal(pageHasScripts(path.join(dir, 'pipe.html')), false);
});

test('git commands count only when they run, not when they are words in a message', async () => {
  const { gitRuns } = await import('../../src/highlights.ts');
  assert.equal(gitRuns('cd x && git -C y commit -qm "a" && git log --oneline -3', 'commit'), 1);
  assert.equal(gitRuns("cat >> t.ts <<'EOF'\n  input: { command: 'git push -q' }\nEOF", 'push'), 0);
  assert.equal(gitRuns('git commit -m "then git push it"', 'push'), 0);
  assert.equal(gitRuns('(cd a && git push) ; git push origin b', 'push'), 2);
});
