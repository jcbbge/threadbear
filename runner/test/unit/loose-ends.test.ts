// Loose ends on the done card (experiment looseEnds; loose-ends.ts and
// runner/loose-ends.ts): what's still open on a finished thread, checked
// by the runner so a plain Archive is safe without asking the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { anyOpen, childLooseEnds, scheduleLooseEnds, worktreeLooseEnds } from '../../src/loose-ends.ts';
import { EXPERIMENTS } from '../../src/experiments.ts';
import type { Schedule } from '../../src/protocol.ts';
import type { WorktreeRecord } from '../../src/worktrees.ts';

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const END_TURN = 'mcp__threadbear__end_turn';

function sh(cwd: string, cmd: string): string {
  return execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A repo on main with a thread's worktree beside it, on its own branch.
function repoWithWorktree(): WorktreeRecord {
  const root = fs.realpathSync(tmpDir('tb-loose-'));
  const main = path.join(root, 'proj');
  fs.mkdirSync(main);
  sh(main, 'git init -q -b main && printf "node_modules\\n" > .gitignore && echo one > a.txt && git add -A && git commit -qm init');
  const wt = path.join(root, 'slot-1');
  sh(main, `git worktree add -q -b thread/abcd1234 ${wt} main`);
  return { repo: 'proj', mainCheckout: main, path: wt, branch: 'thread/abcd1234', base: sh(main, 'git rev-parse main') };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(on = true) {
  const home = tmpDir();
  if (on) fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { looseEnds: true } }));
  return makeHarness(home);
}

function finish(h: ReturnType<typeof setup>, id: string, input: Record<string, unknown> = { needs: 'nothing' }) {
  const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
  s.text(`m${Math.random()}`, 'Done.');
  s.result('completed');
}

test('looseEnds: off by default, with a check-in booked', () => {
  const x = EXPERIMENTS.find((e) => e.id === 'looseEnds');
  assert.equal(x?.on, false);
  assert.match(x?.reminder ?? '', /^[0-9a-f]{8}$/);
});

test('looseEnds: a worktree with nothing left says nothing; commits off main and uncommitted files are named', async () => {
  const w = repoWithWorktree();
  assert.deepEqual(await worktreeLooseEnds(w), []);
  // Ignored files (the linked node_modules, build output) aren't loose ends.
  fs.mkdirSync(path.join(w.path, 'node_modules'));
  fs.writeFileSync(path.join(w.path, 'node_modules', 'x.js'), '');
  assert.deepEqual(await worktreeLooseEnds(w), []);
  sh(w.path, 'echo two > b.txt && git add b.txt && git commit -qm two && echo three > c.txt && echo changed > a.txt');
  assert.deepEqual(await worktreeLooseEnds(w), [
    { kind: 'unlanded', text: "1 commit on thread/abcd1234 isn't on main" },
    { kind: 'uncommitted', text: "2 files in its worktree aren't committed" },
  ]);
  // Landed (main moved to the branch) and committed: nothing left.
  sh(w.path, 'git add -A && git commit -qm three');
  sh(w.mainCheckout, 'git merge -q --ff-only thread/abcd1234');
  assert.deepEqual(await worktreeLooseEnds(w), []);
  // A branch that's gone (cleaned up) isn't one either.
  assert.deepEqual(await worktreeLooseEnds({ ...w, branch: 'thread/gone', path: path.join(w.path, 'nope') }), []);
});

test('looseEnds: threads it started count while working or waiting on Mike; check-ins are listed but leave Archive safe', () => {
  const ends = childLooseEnds([
    { id: 'a', title: 'Fix the relay', working: true, needsYou: false },
    { id: 'b', title: 'Pick a picker', working: false, needsYou: true },
    { id: 'c', title: 'All done', working: false, needsYou: false },
  ]);
  assert.deepEqual(ends.map((e) => [e.kind, e.threadId]), [['thread', 'a'], ['thread', 'b']]);
  assert.match(ends[0].text, /"Fix the relay".*still working/);
  assert.match(ends[1].text, /"Pick a picker".*waiting for you/);
  const sched = (o: Partial<Schedule>): Schedule => ({ id: 'x', title: 'Check-in', text: '', whenText: '', paused: false, createdAt: '', updatedAt: '', runs: 0, ...o });
  const booked = scheduleLooseEnds('t1', [
    sched({ id: '1', threadId: 't1', title: 'Review the week', nextRunAt: '2026-11-13T01:30:00Z' }),
    sched({ id: '2', threadId: 't1', title: 'Paused', nextRunAt: '2026-11-10T00:00:00Z', paused: true }),
    sched({ id: '3', threadId: 'other', title: 'Not this one', nextRunAt: '2026-11-10T00:00:00Z' }),
    sched({ id: '4', threadId: 't1', title: 'Already ran', nextRunAt: undefined }),
  ]);
  assert.deepEqual(booked, [{ kind: 'scheduled', text: 'Review the week', at: '2026-11-13T01:30:00Z' }]);
  assert.equal(anyOpen(booked), false);
  assert.equal(anyOpen([...booked, ...ends]), true);
});

test('looseEnds: a done turn gets a check on its summary, kept up to date, and only for its own card', async () => {
  const h = setup();
  const { thread } = h.runner.create({ text: 'Fix it', accountId: 'claude-main' });
  const id = thread.id;
  const st = h.runner.threads.get(id)!;
  const w = repoWithWorktree();
  st.rec.worktree = w;
  sh(w.path, 'echo two > b.txt && git add b.txt && git commit -qm two');
  finish(h, id);
  await until(() => Boolean(h.runner.get(id).looseEnds), 'the check');
  let s = h.runner.get(id);
  assert.deepEqual(checkSummary(s), []);
  assert.equal(s.looseEnds?.seq, st.rec.lastTurnCompletedSeq);
  assert.deepEqual(s.looseEnds?.ends.map((e) => e.kind), ['unlanded']);

  // A thread it started, still working, shows on its card, and goes once that finishes.
  const child = h.runner.create({ text: 'Side job', accountId: 'claude-main', startedBy: { kind: 'thread', label: 'Agent', threadId: id } }).thread.id;
  h.runner.recheckLooseEnds(st);
  await until(() => Boolean(h.runner.get(id).looseEnds?.ends.some((e) => e.threadId === child)), 'the child listed');
  finish(h, child);
  await until(() => !h.runner.get(id).looseEnds?.ends.some((e) => e.threadId === child), 'the child gone');

  // Landed from a terminal: opening the thread checks again.
  sh(w.mainCheckout, 'git merge -q --ff-only thread/abcd1234');
  h.clock.advance(10_000);
  h.runner.recheckLooseEnds(st, true);
  await until(() => h.runner.get(id).looseEnds?.ends.length === 0, 'nothing left');

  // A check-in it booked is listed (main.ts wires this to the Scheduler).
  h.runner.schedulesFor = (t) => [{ id: 's', title: 'Review the week', text: '', whenText: '', paused: false, createdAt: '', updatedAt: '', runs: 0, threadId: t, nextRunAt: '2026-11-13T01:30:00Z' }];
  h.runner.recheckLooseEnds(st);
  await until(() => h.runner.get(id).looseEnds?.ends[0]?.kind === 'scheduled', 'the check-in');

  // A new turn's card waits for its own check: the old one isn't shown.
  h.runner.send(id, 'one more thing');
  s = h.runner.get(id);
  assert.equal(s.looseEnds, undefined);
});

test('looseEnds: not checked when off, when the turn needs Mike, or when it archives itself', async () => {
  const off = setup(false);
  const a = off.runner.create({ text: 'Fix it', accountId: 'claude-main' }).thread.id;
  finish(off, a);
  const h = setup();
  const b = h.runner.create({ text: 'Fix it', accountId: 'claude-main' }).thread.id;
  finish(h, b, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  const c = h.runner.create({ text: 'Fix it', accountId: 'claude-main' }).thread.id;
  finish(h, c, { needs: 'nothing', archive: true });
  // The one that's on and done, to know the checks have had time to run.
  const d = h.runner.create({ text: 'Fix it', accountId: 'claude-main' }).thread.id;
  finish(h, d);
  await until(() => Boolean(h.runner.get(d).looseEnds), 'the control');
  assert.equal(off.runner.get(a).looseEnds, undefined);
  assert.equal(h.runner.get(b).looseEnds, undefined);
  assert.equal(h.runner.get(c).looseEnds, undefined);
  assert.deepEqual(h.runner.get(d).looseEnds?.ends, []);
});
