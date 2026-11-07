import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { Projects, drainProjectMethods, projectMethods, BRIEF_MAX, NOTES_LONG, type ProjectHost } from '../../src/projects.ts';
import { projectRouter, type PrimaryLink } from '../../src/handover.ts';
import type { PocketCardInput, PocketCardSummary } from '../../src/sync.ts';
import { Librarian, type LibrarianPocket, librarianMethods, saysNoFit, mainCheckout, SETTLE_MS, CATCH_UP_MS, CATCH_UP_MIN_CHARS, FIRST_MESSAGE_MS, SWEEP_MS } from '../../src/librarian.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger, type Logger } from '../../src/log.ts';
import { ErrorCode, RpcError } from '../../src/protocol.ts';
import { commandFolders } from '../../src/tools.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';

// A harness whose runner has projects, with a fake home holding repos.
function setup(opts: { pocket?: () => LibrarianPocket | undefined; models?: (p: GenerateParams) => Promise<ModelResult<string>> | ModelResult<string>; log?: Logger; privateFolder?: (cwd: string) => boolean } = {}) {
  const root = tmpDir();
  const repo = (rel: string, files: Record<string, string> = {}) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  };
  const misc = path.join(root, 'dev/misc');
  fs.mkdirSync(misc, { recursive: true });
  const home = tmpDir();
  const projects = new Projects({ home, clock: new FakeClock(), log: nullLogger, userHome: root });
  const asked: GenerateParams[] = [];
  const models = opts.models
    ? {
        generate: async (p: GenerateParams) => {
          asked.push(p);
          return opts.models!(p);
        },
        isPrivateFolder: opts.privateFolder,
      }
    : undefined;
  const h = makeHarness(home, {}, { projects, panelsRoot: root, actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 5000 });
  projects.start(h.runner);
  const librarian = new Librarian({ host: h.runner, projects, models, clock: h.clock, log: opts.log ?? nullLogger, home, userHome: root, pocket: opts.pocket });
  librarian.start();
  const create = (text = 'Work on the app', cwd = misc) => h.runner.create({ text, cwd, accountId: 'claude-3' });
  // Ends the thread's running turn as the CLI would.
  // `commands` are Bash calls it made.
  const finish = async (threadId: string, edited: string[] = [], commands: string[] = []) => {
    const s = h.adapter.sessions.filter((x) => x.opts.threadId === threadId).at(-1)!;
    s.init();
    for (const file of edited) s.out({ kind: 'event', event: { type: 'tool.call', itemId: `w${Math.random()}`, name: 'Write', kind: 'write', input: { file_path: file, content: 'x' } } as never });
    for (const command of commands) s.out({ kind: 'event', event: { type: 'tool.call', itemId: `b${Math.random()}`, name: 'Bash', kind: 'command', input: { command } } as never });
    s.result('completed');
    await tick();
  };
  return { h, root, misc, repo, projects, librarian, asked, create, finish };
}

test("the librarian keeps why a thread is in each project, and takes it out of a wrong guess only when it says so", async () => {
  let answer: unknown = {};
  const s = setup({ models: () => reply(answer) });
  const { h, create, finish, librarian, projects } = s;
  const dir = projects.create({ title: 'Components directory', by: 'mike' });
  const cal = projects.create({ title: 'Calendar', by: 'mike' });
  const kept = projects.create({ title: 'Kept', by: 'mike' });
  // A wrong first guess, with its reason.
  answer = { projects: [dir.id, kept.id], reasons: { [dir.id]: 'Mentions the directory', [kept.id]: 'Also this' } };
  const { thread } = create('Check my photos');
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  const whys = () => h.runner.get(thread.id).projects?.map((m) => [m.title, m.why]);
  assert.deepEqual(whys(), [['Components directory', 'Mentions the directory'], ['Kept', 'Also this']]);
  checkSummary(h.runner.get(thread.id));
  // Mike keeps one (it's pinned and its reason stays).
  projects.changeMembership(thread.id, { add: [kept.id], by: 'mike' });
  // A catch-up that only leaves it out of projects keeps it there, as before.
  answer = { projects: [cal.id], reasons: { [cal.id]: 'Shortlists photos for the calendar' } };
  h.runner.send(thread.id, 'more about photos '.repeat(40));
  await tick();
  await finish(thread.id);
  h.clock.advance(CATCH_UP_MS + SETTLE_MS);
  await tick(8);
  assert.equal(librarian.status().recent[0].text, 'Put it in Calendar');
  assert.deepEqual(whys(), [['Components directory', 'Mentions the directory'], ['Kept', 'Also this'], ['Calendar', 'Shortlists photos for the calendar']]);
  // One that says to leave it takes it out, but never out of Mike's.
  answer = { projects: [cal.id], reasons: { [cal.id]: 'Picks photos for the calendar' }, leave: { [dir.id]: 'Not a components thread', [kept.id]: 'Nor this' } };
  h.runner.send(thread.id, 'and more photos '.repeat(40));
  await tick();
  await finish(thread.id);
  h.clock.advance(CATCH_UP_MS + SETTLE_MS);
  await tick(8);
  assert.equal(librarian.status().recent[0].text, 'Took it out of Components directory: not a components thread');
  assert.equal(librarian.status().recent[0].outcome, 'left');
  // The newer reason replaces the old one on its own guess.
  assert.deepEqual(whys(), [['Kept', 'Also this'], ['Calendar', 'Picks photos for the calendar']]);
  // Not remembered as Mike's no: a later look may put it back.
  assert.equal(rec(h, thread.id).projectsLeft, undefined);
});

const rec = (h: ReturnType<typeof makeHarness>, id: string) => h.runner.threadRecords().find((t) => t.id === id)!;
const reply = (v: unknown): ModelResult<string> => ({ ok: true, value: JSON.stringify(v), model: 'haiku' });

// ------------------------------------------------------------- projects

test('Mike makes a project with a thread in it: pinned, in the summary, counted, kept', () => {
  const { h, repo, projects, create } = setup();
  const app = repo('dev/app');
  const { thread } = create();
  const p = projects.create({ title: '  Poddle ', folders: [app], goals: 'A podcast player', threadIds: [thread.id.slice(0, 8)], by: 'mike' });
  assert.match(p.id, /^p_[0-9a-f]{8}$/);
  assert.equal(p.title, 'Poddle');
  assert.equal(p.threadCount, 1);
  const s = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(s), []);
  assert.deepEqual(s.projects?.map((m) => [m.id, m.title, m.by, m.pinned]), [[p.id, 'Poddle', 'mike', true]]);
  const sent = h.notes.filter((n) => n.method === 'projects.updated');
  assert.ok(sent.length >= 1);
  // A rename reaches the thread's summary.
  projects.update(p.id, { title: 'Poddle app' });
  assert.equal(h.runner.get(thread.id).projects?.[0].title, 'Poddle app');
  // Bad input is refused with what's wrong.
  assert.throws(() => projects.create({ title: ' ', by: 'mike' }), (e: RpcError) => e.code === -32602);
  assert.throws(() => projects.create({ title: 'x', folders: ['/nope/not/here'], by: 'mike' }), /Folder not found/);
  assert.throws(() => projects.get('p_nothere'), (e: RpcError) => e.code === -32007);
  // Saved: a new store reads it back.
  const again = new Projects({ home: h.home, clock: new FakeClock(), log: nullLogger });
  again.start(h.runner);
  assert.equal(again.find('poddle app')?.id, p.id);
  assert.deepEqual(again.get(p.id).threadIds, [thread.id]);
});

test('a folder deleted since it was added does not block later folder changes', () => {
  const { repo, projects } = setup();
  const gone = repo('dev/gone');
  const app = repo('dev/app');
  const p = projects.create({ title: 'Tools', folders: [gone], by: 'mike' });
  fs.rmSync(gone, { recursive: true });
  // The librarian's addFolders keeps the old list and adds to it.
  assert.deepEqual(projects.update(p.id, { folders: [gone, app] }).folders.length, 2);
  // A new folder still has to exist.
  assert.throws(() => projects.update(p.id, { folders: [gone, app, '/nope/not/here'] }), /Folder not found/);
});

// 30 Oct 2026: a catch-all thread checking Qantas bookings went into
// Walkies. Replaying the look, Haiku listed a project 3 times in 6 with
// no reason, or one like "Not that; ignore", while its why said nothing
// fit. These are its answers; none of them may file the thread.
test('the librarian leaves a thread unfiled when its pick has no reason, or one that says it fits none', async () => {
  let answer: unknown = {};
  const s = setup({ models: () => reply(answer) });
  const { h, create, finish, librarian, projects } = s;
  const walkies = projects.create({ title: 'Walkies', folders: [s.repo('dev/walkies'), s.repo('dev/misc/walkies-release-watch')], by: 'mike' });
  const cruise = projects.create({ title: 'Lights cruise', by: 'mike' });
  const { thread } = create('Check my flight is linked with my family\'s booking');
  const bad = [
    { projects: [walkies.id], reasons: {}, why: 'Qantas booking link, not tied to a project' },
    { projects: [cruise.id], reasons: { [cruise.id]: 'Not that; ignore' }, why: 'Qantas flight check, not about any listed project' },
    { projects: [walkies.id], reasons: { [walkies.id]: 'Unrelated to the thread' }, why: 'A one-off travel errand' },
  ];
  for (const [i, a] of bad.entries()) {
    answer = a;
    if (i) h.runner.send(thread.id, 'still on the flights '.repeat(40));
    await tick();
    await finish(thread.id);
    h.clock.advance(CATCH_UP_MS + SETTLE_MS);
    await tick(8);
    assert.equal(h.runner.get(thread.id).projects?.length ?? 0, 0, JSON.stringify(a));
    assert.equal(librarian.status().recent[0].outcome, 'nothing');
  }
  // A real reason still files it.
  answer = { projects: [walkies.id], reasons: { [walkies.id]: 'Plans the dog walk route' } };
  h.runner.send(thread.id, 'now the walk app '.repeat(40));
  await tick();
  await finish(thread.id);
  h.clock.advance(CATCH_UP_MS + SETTLE_MS);
  await tick(8);
  assert.equal(librarian.status().recent[0].text, 'Put it in Walkies');
});

test('saysNoFit spots reasons that say a thread does not belong', () => {
  for (const no of ['Not that; ignore', 'Unrelated', 'No clear fit', 'none', 'Not about this project', "Doesn't fit"]) assert.ok(saysNoFit(no), no);
  for (const yes of ['Edits the Poddle repo', 'Fixes the not-found page', 'Shortlists photos for the calendar entry', 'Notes for the Northern trip']) assert.ok(!saysNoFit(yes), yes);
});

test('membership: the librarian never undoes Mike or an agent, and says what it did', () => {
  const { h, projects, create } = setup();
  const { thread } = create();
  const a = projects.create({ title: 'Alpha', by: 'mike' });
  const b = projects.create({ title: 'Beta', by: 'mike' });
  // The librarian puts it in Alpha: said in the transcript, not pinned.
  const r1 = projects.changeMembership(thread.id, { add: [a.id], by: 'librarian' });
  assert.deepEqual(r1.joined, [a.id]);
  assert.equal(r1.thread.projects?.[0].pinned, undefined);
  assert.ok(h.events(thread.id).some((e) => e.type === 'system.note' && e.text === 'Put in Alpha by the librarian.'));
  // Mike takes it out: remembered, and the librarian can't put it back.
  projects.changeMembership(thread.id, { remove: [a.id], by: 'mike' });
  assert.deepEqual(projects.changeMembership(thread.id, { add: [a.id], by: 'librarian' }).joined, []);
  assert.equal(h.runner.get(thread.id).projects, undefined);
  // An agent joins Beta: pinned, so the librarian can't take it out.
  projects.changeMembership(thread.id, { add: [b.id], by: 'agent' });
  assert.equal(h.runner.get(thread.id).projects?.[0].pinned, true);
  assert.deepEqual(projects.changeMembership(thread.id, { remove: [b.id], by: 'librarian' }).left, []);
  // Mike putting it back in Alpha clears the "never".
  projects.changeMembership(thread.id, { add: [a.id], by: 'mike' });
  assert.deepEqual(h.runner.get(thread.id).projects?.map((m) => m.id), [b.id, a.id]);
  assert.equal(rec(h, thread.id)?.projectsLeft, undefined);
});

test('merge moves threads, folders and notes over; delete takes threads out', () => {
  const { h, repo, projects, create } = setup();
  const one = repo('dev/one');
  const two = repo('dev/two');
  const { thread: t1 } = create('first');
  const { thread: t2 } = create('second');
  const a = projects.create({ title: 'A', folders: [one], notes: 'from a', threadIds: [t1.id], by: 'mike' });
  const b = projects.create({ title: 'B', folders: [two], notes: 'about b', threadIds: [t1.id, t2.id], by: 'mike' });
  const kept = projects.merge(a.id, b.id);
  assert.equal(kept.id, b.id);
  assert.deepEqual(kept.folders, [two, one]);
  assert.equal(kept.notes, 'about b\n\n## From A\n\nfrom a');
  assert.equal(kept.threadCount, 2);
  assert.deepEqual(h.runner.get(t1.id).projects?.map((m) => m.id), [b.id], 'in B once, not twice');
  assert.equal(projects.find(a.id), undefined);
  projects.delete(b.id);
  assert.equal(h.runner.get(t1.id).projects, undefined);
  assert.deepEqual(projects.list(), []);
});

test('the RPC methods: list, get, create, update, setProjects, archive', () => {
  const { h, projects, create } = setup();
  const m = projectMethods(projects);
  const { thread } = create();
  const { project } = m['projects.create']({ title: 'Gamma', goals: 'Do it', threadIds: [thread.id] }) as any;
  assert.equal(project.createdBy, 'mike');
  const got = m['projects.get']({ projectId: project.id }) as any;
  assert.deepEqual(got.threadIds, [thread.id]);
  m['projects.update']({ projectId: project.id, archived: true });
  assert.equal((m['projects.list']({}) as any).projects.length, 0);
  assert.equal((m['projects.list']({ archived: true }) as any).projects[0].archived, true);
  const r = m['threads.setProjects']({ threadId: thread.id, remove: [project.id] }) as any;
  assert.equal(r.thread.projects, undefined);
  assert.throws(() => m['projects.update']({ projectId: project.id, folders: 'nope' }), /folders must be a list/);
});

// ------------------------------------------------------- brief and patches

test('a session hears about a project once: a live one at its next message, a fresh one as instructions', async () => {
  const { h, repo, projects, create, finish } = setup();
  const app = repo('dev/app');
  const p = projects.create({ title: 'Poddle', folders: [app], goals: 'A podcast player for Mike', state: 'Build 12 is in review', by: 'mike' });
  const { thread } = create();
  // Not in any project when its CLI started: no brief.
  assert.equal(h.adapter.last.opts.instructions, undefined);
  await finish(thread.id);
  projects.changeMembership(thread.id, { add: [p.id], by: 'librarian' });
  h.runner.send(thread.id, 'carry on');
  await tick();
  const sent = h.adapter.last.sent.at(-1)!;
  assert.match(sent.text, /^\[Threadbear project\] This thread is now part of the project "Poddle" \(p_[0-9a-f]+\)\. Goals: A podcast player for Mike State: Build 12 is in review/);
  assert.match(sent.text, /\n\ncarry on$/);
  // Said once.
  await finish(thread.id);
  h.runner.send(thread.id, 'again');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'again');
  // A resumed session isn't told again (and Claude Code would ignore new
  // instructions on a resume anyway).
  await finish(thread.id);
  h.clock.advance(h.cfg.idleMs + 1000);
  await tick();
  h.runner.send(thread.id, 'back again');
  await tick();
  assert.equal(h.adapter.last.opts.resume, true);
  assert.equal(h.adapter.last.opts.instructions, undefined);
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'back again');
  // A fresh session (here, a move whose transcript can't come along) gets
  // the whole brief as instructions, and no line before the message.
  await finish(thread.id);
  h.runner.update({ threadId: thread.id, cwd: app });
  h.runner.send(thread.id, 'moved');
  await tick();
  assert.equal(h.adapter.last.opts.resume, false);
  const brief = h.adapter.last.opts.instructions!;
  assert.match(brief, /^\[Threadbear projects\]/);
  assert.match(brief, /## Poddle \(p_[0-9a-f]+\)\nFolders: ~\/dev\/app\nGoals: A podcast player for Mike\nState: Build 12 is in review/);
  assert.doesNotMatch(h.adapter.last.sent.at(-1)!.text, /Threadbear project/);
});

test('the brief stays short however many projects there are', () => {
  const { projects, create, h } = setup();
  const { thread } = create();
  const long = 'x'.repeat(1900);
  for (let i = 0; i < 4; i++) {
    const p = projects.create({ title: `P${i}`, goals: long, state: long, by: 'mike' });
    projects.changeMembership(thread.id, { add: [p.id], by: 'mike' });
  }
  const brief = projects.brief(rec(h, thread.id))!;
  const body = brief.slice(brief.indexOf('## '));
  assert.ok(body.length <= BRIEF_MAX + 200, `brief body ${body.length}`);
  assert.equal((brief.match(/^## /gm) ?? []).length, 4);
});

test("a thread in a project gets its folders' patches, and their actions run in that folder", async () => {
  const { h, repo, projects, create } = setup();
  const app = repo('dev/app', { '.threadbear/patches/tools.ts': `export default { actions: [{ title: "Where", run: "pwd" }] };` });
  const { thread } = create();
  await tick();
  await h.runner.patchesIdle();
  assert.equal(h.runner.get(thread.id).actions, undefined);
  projects.create({ title: 'App', folders: [app], threadIds: [thread.id], by: 'mike' });
  // The new set loads in the background.
  h.runner.get(thread.id);
  await tick(6);
  await h.runner.patchesIdle();
  const s = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(s), []);
  assert.deepEqual(s.actions?.map((a) => [a.id, a.folder]), [['tools.where', app]]);
  const r = await h.runner.runAction(thread.id, 'tools.where');
  assert.equal(r.ok, true);
  const run = h.events(thread.id).find((e) => e.type === 'action.run');
  assert.equal(run.text.trim(), fs.realpathSync(app));
});

// ----------------------------------------------------------- the librarian

test('the librarian looks after the first turn: makes a project and files the thread', async () => {
  const s = setup({
    models: (p) => {
      assert.equal(p.feature, 'projects');
      assert.match(p.prompt, /Projects:\n\(none yet\)/);
      assert.match(p.prompt, /Thread "Build the podcast player", in ~\/dev\/misc \(not a repo: a catch-all folder\)/);
      assert.match(p.prompt, /Edited files in: ~\/dev\/poddle/);
      assert.match(p.prompt, /First message: Build the podcast player/);
      return reply({ projects: [], new: { title: 'Poddle', folders: ['~/dev/poddle', '~/dev/misc'], goals: 'A podcast player', state: 'Just started' }, state: {}, why: 'New app work' });
    },
  });
  const { h, repo, create, finish, librarian, projects } = s;
  const poddle = repo('dev/poddle');
  const { thread } = create('Build the podcast player');
  await finish(thread.id, [path.join(poddle, 'src/app.ts')]);
  const st = librarian.status();
  assert.equal(st.state, 'idle');
  // Its first message queued a look; the turn ending before it ran makes
  // it a first-turn look, still as soon.
  assert.deepEqual(st.queue.map((j) => [j.reason, j.why]), [['first-turn', 'Its first turn ended']]);
  assert.equal(Date.parse(st.queue[0].dueAt) - h.clock.now(), FIRST_MESSAGE_MS);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  const after = librarian.status();
  assert.equal(after.queue.length, 0);
  assert.equal(after.looksToday, 1);
  assert.equal(after.spentTodayUsd, 0, 'looks run on the pool, so nothing is spent');
  assert.deepEqual(after.recent.map((e) => [e.outcome, e.text, e.reason]), [['created', 'Made Poddle and put it there', 'first-turn']]);
  const [p] = projects.list();
  // The catch-all folder isn't a project folder.
  assert.deepEqual(p.folders, [poddle]);
  assert.equal(p.createdBy, 'librarian');
  assert.equal(p.createdByThread, thread.id);
  assert.deepEqual(h.runner.get(thread.id).projects?.map((m) => [m.title, m.by]), [['Poddle', 'librarian']]);
  assert.ok(h.notes.some((n) => n.method === 'librarian.updated'));
});

test('commandFolders: where cd, pushd and git -C point, a later relative cd following an earlier one', () => {
  const home = '/Users/me';
  const cwd = '/Users/me/dev/misc';
  assert.deepEqual(commandFolders('cd ~/dev/me/sammy-cam && npm test', cwd, home), ['/Users/me/dev/me/sammy-cam']);
  assert.deepEqual(commandFolders('cd "$HOME/dev/my app"; cd web && ls', cwd, home), ['/Users/me/dev/my app', '/Users/me/dev/my app/web']);
  assert.deepEqual(commandFolders('git -C ../blog log -3; pushd /tmp/x', cwd, home), ['/Users/me/dev/blog', '/tmp/x']);
  // A git -C doesn't move later relative cds.
  assert.deepEqual(commandFolders('git -C /a status && cd b', cwd, home), ['/a', '/Users/me/dev/misc/b']);
  // Guesses are skipped: other variables, substitutions, globs, cd -.
  assert.deepEqual(commandFolders('cd $DIR; cd "$(git rev-parse --show-toplevel)"; cd src/*; cd -; echo abcd x', cwd, home), []);
  // Words that only end in cd aren't cd.
  assert.deepEqual(commandFolders('abcd /x; npm run build:cd /y', cwd, home), []);
});

test('the librarian sees the repo a catch-all thread works in through shell commands alone', async () => {
  let answer: unknown = {};
  const s = setup({ models: (p) => {
    assert.match(p.prompt, /Ran commands in: ~\/dev\/sammy-cam\n/);
    return reply(answer);
  } });
  const { h, repo, create, finish, librarian, projects } = s;
  const cam = repo('dev/sammy-cam');
  // Its first turn: no Edit or Write, just commands in the repo (and a
  // look in the catch-all folder it's in, which isn't news).
  answer = { projects: [], new: { title: 'Sammy Cam', folders: ['~/dev/sammy-cam'], goals: 'Watches Sammy', state: 'Fixed a false visit' } };
  const { thread } = create('Sammy Cam saw him on the sofa when he was not');
  await finish(thread.id, [], [`cd ${cam} && npm test`, `cd ${s.misc} && ls`]);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  const [p] = projects.list();
  assert.equal(p.title, 'Sammy Cam');
  assert.deepEqual(p.folders, [cam]);
  // A project made without its folder gets it at the next look, and a
  // turn of commands in a repo the project lacks isn't skipped as quiet.
  projects.update(p.id, { folders: [] });
  answer = { projects: [p.id], addFolders: { [p.id]: ['~/dev/sammy-cam'] } };
  h.runner.send(thread.id, 'ok');
  await tick();
  await finish(thread.id, [], [`git -C ${cam} log -1`]);
  h.clock.advance(CATCH_UP_MS + SETTLE_MS);
  await tick(8);
  assert.equal(librarian.status().recent[0].text, 'Added ~/dev/sammy-cam to Sammy Cam');
  assert.deepEqual(projects.record(p.id)?.folders, [cam]);
});

test('the librarian: catch-up an hour after a look, new folders sooner, state updates, moves', async () => {
  let answer: unknown = { projects: [], new: null, why: 'A one-off question' };
  const s = setup({ models: () => reply(answer) });
  const { h, repo, create, finish, librarian, projects } = s;
  const app = repo('dev/app');
  const other = repo('dev/other');
  const p = projects.create({ title: 'App', folders: [app], state: 'old', by: 'mike' });
  const { thread } = create();
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  assert.equal(librarian.status().recent[0].text, 'Nothing to change: a one-off question');
  // Another turn with nothing new: CATCH_UP_MS after that look.
  h.runner.send(thread.id, 'more');
  await tick();
  await finish(thread.id, [path.join(s.misc, 'notes.md')]);
  const catchUp = librarian.status().queue[0];
  assert.equal(catchUp.reason, 'catch-up');
  assert.ok(Date.parse(catchUp.dueAt) - h.clock.now() > CATCH_UP_MS - 60_000);
  // A turn that edits another repo: sooner, and the better reason wins.
  h.runner.send(thread.id, 'edit app');
  await tick();
  await finish(thread.id, [path.join(app, 'x.ts')]);
  const job = librarian.status().queue[0];
  assert.deepEqual([job.reason, job.why], ['new-folder', 'Edited files in ~/dev/app']);
  answer = { projects: [p.id], reasons: { [p.id]: 'Works on the app' }, state: { [p.id]: 'Working on x.ts' }, addFolders: { [p.id]: ['~/dev/other'] } };
  h.clock.advance(SETTLE_MS);
  await tick(8);
  const entry = librarian.status().recent[0];
  assert.equal(entry.outcome, 'joined');
  assert.equal(entry.text, "Put it in App. Added ~/dev/other to App. Updated App's state");
  assert.equal(projects.record(p.id)?.state, 'Working on x.ts');
  assert.deepEqual(projects.record(p.id)?.folders, [app, other]);
  // A move: looked at again, and it may take out its own guess.
  answer = { projects: [], why: 'Moved away' };
  h.runner.update({ threadId: thread.id, cwd: other });
  assert.equal(librarian.status().queue[0].reason, 'moved');
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.equal(librarian.status().recent[0].text, 'Took it out of App');
  assert.equal(h.runner.get(thread.id).projects, undefined);
});

test('the librarian waits without a pool, skips private folders, can be paused, and backfills', async () => {
  let result: ModelResult<string> = { ok: false, reason: 'no-pool', message: 'Small jobs are on no pool.' };
  const s = setup({ models: () => result });
  const { h, create, finish, librarian } = s;
  const m = librarianMethods(librarian);
  const { thread } = create();
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  let st = librarian.status();
  assert.equal(st.state, 'off');
  assert.equal(st.reason, 'Needs a Claude pool to run on');
  assert.equal(st.queue.length, 1, 'kept for later');
  // Paused: nothing runs even when due.
  m['librarian.update']({ paused: true });
  result = { ok: false, reason: 'private', message: 'private' };
  h.clock.advance(20 * 60_000);
  await tick(6);
  st = librarian.status();
  assert.equal(st.state, 'paused');
  assert.equal(st.queue.length, 1);
  m['librarian.update']({ paused: false });
  await tick(6);
  st = librarian.status();
  assert.equal(st.queue.length, 0);
  assert.deepEqual([st.recent[0].outcome, st.recent[0].text], ['skipped', 'Private folder, not sent']);
  // Backfill: threads it has never looked at, newest first.
  const { thread: t2 } = create('second');
  h.clock.advance(1000);
  const { thread: t3 } = create('third');
  m['librarian.update']({ paused: true });
  const r = m['librarian.run']({}) as any;
  assert.deepEqual(r.librarian.queue.map((j: any) => j.threadId), [t3.id, t2.id]);
  // Deleting a thread drops its job.
  await h.runner.delete(t3.id);
  assert.deepEqual(librarian.status().queue.map((j) => j.threadId), [t2.id]);
  // Kept across a restart.
  const again = new Librarian({ host: h.runner, projects: s.projects, clock: h.clock, log: nullLogger, home: h.home });
  again.start();
  assert.deepEqual(again.status().queue.map((j) => j.threadId), [t2.id]);
  assert.equal(again.status().recent.length, st.recent.length);
  again.stop();
});

// ---------------------------------------------------------- agent tools

test('agent tools: make, read, update, join and leave projects', async () => {
  const { h, repo, projects, create } = setup();
  const app = repo('dev/app');
  const { thread } = create();
  const tools = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, projects);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = await t.handler(args as never, {} as never);
    return { text: r.content.map((c: any) => c.text).join(''), error: Boolean(r.isError) };
  };
  assert.equal((await call('list_projects', {})).text, 'No projects yet. create_project makes one.');
  const made = await call('create_project', { title: 'App', folders: [app], goals: 'Ship it' });
  assert.match(made.text, /^Made the project "App" \(p_[0-9a-f]+\) and put this thread in it\.$/);
  const p = projects.list()[0];
  assert.deepEqual(h.runner.get(thread.id).projects?.map((m) => [m.by, m.pinned]), [['agent', true]]);
  assert.equal(p.createdBy, 'agent');
  assert.deepEqual(await call('update_project', { project: 'app', state: 'Half done', appendNote: 'Use npm ci.' }), { text: `Updated "App" (${p.id}).`, error: false });
  const read = await call('read_project', { project: p.id });
  assert.match(read.text, /^App \(p_[0-9a-f]+\)\nFolders: .*\nGoals: Ship it\nState: Half done\nLinks: none\n\nNotes:\nUse npm ci\.\n\nThreads \(1\):\n- [0-9a-f]{8} ".*" \(this thread\)$/);
  assert.match((await call('list_projects', {})).text, /\(this thread is in it\) · 1 thread · folders .* · state: Half done/);
  assert.match((await call('leave_project', { project: p.id })).text, /no longer in "App"/);
  assert.equal(rec(h, thread.id)?.projectsLeft?.[0], p.id);
  assert.equal((await call('read_project', { project: 'nope' })).error, true);
});

// The primary's side of a handover in these tests: projects with no
// threads of their own, as the kept thread is still on the draining runner.
const noThreads: ProjectHost = {
  threadRecords: () => [],
  editThread: () => {
    throw new Error('the new runner has no threads in this test');
  },
  touchThreads: () => {},
  resolveThread: (id) => {
    throw new Error(`No thread ${id}`);
  },
  publish: () => {},
  onNotification: () => () => {},
};

test('a thread finishing its turn on a draining runner changes projects on the new runner, and joins them where it is', async () => {
  const { h, root, repo, projects, create } = setup();
  const p = projects.create({ title: 'App', folders: [repo('dev/app')], by: 'mike' });
  const { thread } = create();
  // The handover: this runner keeps the busy thread and stops writing
  // projects; the new release reads projects.json and owns it from here.
  projects.freeze();
  const primary = new Projects({ home: h.home, clock: new FakeClock(), log: nullLogger, userHome: root });
  primary.start(noThreads);
  const methods = drainProjectMethods(primary);
  let link: Pick<PrimaryLink, 'call'> | undefined;
  const control = projectRouter(projects, () => link, { draining: () => true, holds: (id) => h.runner.has(id) });
  const tools = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, control);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = await t.handler(args as never, {} as never);
    return { text: r.content.map((c: any) => c.text).join(''), error: Boolean(r.isError) };
  };

  // Until it knows where the new runner is: a few seconds.
  const early = await call('update_project', { project: p.id, appendNote: 'Too soon' });
  assert.equal(early.error, true);
  assert.match(early.text, /try the project tool again in a few seconds/);

  // Over JSON, as the runner's port carries it.
  link = { call: async (method, params = {}) => JSON.parse(JSON.stringify(await methods[method](JSON.parse(JSON.stringify(params))))) };
  assert.deepEqual(await call('update_project', { project: 'app', state: 'Releases live', appendNote: 'Forks follow tags.' }), { text: `Updated "App" (${p.id}).`, error: false });
  assert.equal(primary.record(p.id)?.state, 'Releases live');
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'projects.json'), 'utf8'));
  assert.equal(saved.projects[0].notes, 'Forks follow tags.', "in the new runner's projects.json");
  assert.match((await call('read_project', { project: p.id })).text, /\nState: Releases live\n[\s\S]*\nForks follow tags\.\n/);

  // A project made now is the new runner's. The kept thread joins it here,
  // so the join moves across with the thread.
  const made = await call('create_project', { title: 'Docs' });
  assert.match(made.text, /^Made the project "Docs" \(p_[0-9a-f]+\) and put this thread in it\.$/);
  const docs = primary.find('Docs')!;
  assert.equal(docs.createdBy, 'agent');
  assert.match((await call('join_project', { project: 'App' })).text, /^This thread is in "App" now\.$/);
  assert.deepEqual(rec(h, thread.id).projects?.map((m) => [m.id, m.by, m.pinned]), [
    [docs.id, 'agent', true],
    [p.id, 'agent', true],
  ]);
  const listed = (await call('list_projects', {})).text;
  assert.match(listed, /"App" \(this thread is in it\)/);
  assert.match(listed, /"Docs" \(this thread is in it\)/);

  // A rollback can leave an older release as the new runner.
  link = {
    call: async () => {
      throw new RpcError(ErrorCode.methodNotFound, 'Unknown method drain.projects');
    },
  };
  assert.match((await call('update_project', { project: p.id, state: 'x' })).text, /older release/);
});

test('a project the librarian makes on an asked look stays: the same look never takes the thread out of it', async () => {
  const s = setup({ models: () => reply({ projects: [], new: { title: 'Tandem', folders: [], goals: 'A video editor', state: '' } }) });
  const { h, create, finish, librarian } = s;
  const { thread } = create();
  await finish(thread.id);
  librarian.run(thread.id);
  await tick(8);
  assert.deepEqual(librarian.status().recent.map((e) => e.text), ['Made Tandem and put it there']);
  assert.deepEqual(h.runner.get(thread.id).projects?.map((m) => m.title), ['Tandem']);
});

test('a git worktree counts as its main checkout, never as a folder of its own', async () => {
  let answer: unknown = {};
  const s = setup({ models: () => reply(answer) });
  const { h, repo, root, create, finish, librarian, projects } = s;
  const main = repo('dev/app');
  const wt = path.join(root, 'dev/app-wt');
  fs.mkdirSync(path.join(main, '.git/worktrees/wt'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git/worktrees/wt')}\n`);
  assert.equal(mainCheckout(wt), main);
  assert.equal(mainCheckout(main), main);
  const p = projects.create({ title: 'App', folders: [main], by: 'mike' });
  const { thread } = create();
  answer = { projects: [p.id], reasons: { [p.id]: 'Works on the app' }, addFolders: { [p.id]: ['~/dev/app-wt'] } };
  await finish(thread.id, [path.join(wt, 'src/x.ts')]);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.deepEqual(projects.record(p.id)?.folders, [main], 'the worktree is not added');
  assert.equal(librarian.status().recent[0].text, 'Put it in App');
  // Its edits counted as the main checkout's, which the project has.
  h.runner.send(thread.id, 'more');
  await tick();
  await finish(thread.id, [path.join(wt, 'src/y.ts')]);
  assert.equal(librarian.status().queue[0].reason, 'catch-up');
});

test('the librarian keeps its line on where the thread is up to as the thread\'s brief', async () => {
  const s = setup({ models: () => reply({ projects: [], new: null, state: {}, thread: 'Waiting on Mike to pick a layout.', why: 'A one-off' }) });
  const { h, create, finish, librarian } = s;
  const { thread } = create('Make a mockup');
  await finish(thread.id, []);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  assert.equal(librarian.status().recent[0]?.text, 'Nothing to change: a one-off', 'the brief is not a project change');
  assert.equal(h.runner.highlights(thread.id).brief?.text, 'Waiting on Mike to pick a layout.');
  assert.ok(h.runner.get(thread.id).highlightsAt);
});

test('a quiet catch-up is skipped with no model call, and what it said counts towards the next', async () => {
  const s = setup({ models: () => reply({ projects: [], why: 'A one-off' }) });
  const { h, create, finish, librarian, asked } = s;
  // From local noon: the day's counts roll over at local midnight, and the
  // fake clock's 12:00 UTC start is 23:00 in Sydney, an hour from it.
  const noon = new Date(h.clock.now());
  noon.setHours(12, 0, 0, 0);
  if (noon.getTime() < h.clock.now()) noon.setDate(noon.getDate() + 1);
  h.clock.advance(noon.getTime() - h.clock.now());
  await tick(8);
  const { thread } = create('Work on the app');
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(8);
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  const calls = asked.length;
  // A short turn: no edits, no link, little said.
  const turn = async (text: string) => {
    h.runner.send(thread.id, 'go');
    await tick();
    const sess = h.adapter.sessions.filter((x) => x.opts.threadId === thread.id).at(-1)!;
    sess.init();
    sess.text(`t${Math.random()}`, text);
    sess.result('completed');
    await tick();
  };
  await turn('Done.');
  assert.equal(librarian.status().queue[0].reason, 'catch-up');
  h.clock.advance(CATCH_UP_MS);
  await tick(8);
  assert.equal(asked.length, calls, 'no model call');
  assert.equal(librarian.status().skippedToday, 1);
  assert.equal(librarian.status().queue.length, 0);
  // Another short one, but the two together say enough: a look.
  await turn('x'.repeat(CATCH_UP_MIN_CHARS));
  h.clock.advance(CATCH_UP_MS);
  await tick(8);
  assert.equal(asked.length, calls + 1);
  // A link, however short, is worth a look.
  await turn('Live at https://app.example.com');
  h.clock.advance(CATCH_UP_MS);
  await tick(8);
  assert.equal(asked.length, calls + 2);
  assert.equal(librarian.status().skippedToday, 1);
});

test('the day counts tokens and what pool looks would have cost', async () => {
  const s = setup({ models: () => ({ ok: true, value: JSON.stringify({ projects: [] }), model: 'haiku on claude-3', tokens: 3500, notionalUsd: 0.0009 }) });
  const { h, create, finish, librarian } = s;
  const { thread } = create('Work on the app');
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  const st = librarian.status();
  assert.equal(st.tokensToday, 3500);
  assert.equal(st.notionalTodayUsd, 0.0009);
  assert.equal(st.spentTodayUsd, 0);
});

test('the librarian renames a thread that has moved on, never one Mike or an agent named', async () => {
  let answer: unknown = {};
  const s = setup({ models: (p) => reply(typeof answer === 'function' ? (answer as (p: GenerateParams) => unknown)(p) : answer) });
  const { h, create, finish, librarian } = s;
  const { thread } = create('Hey, does the librarian update titles?');
  // The early look never renames: the title model has only just named it.
  answer = (q: GenerateParams) => {
    assert.match(q.prompt, /Thread "Hey, does the librarian update titles\?"/);
    return { projects: [], title: 'Too soon' };
  };
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(8);
  assert.equal(h.runner.get(thread.id).title, 'Hey, does the librarian update titles?');
  // After a turn it does, tidied like any model title, and says so.
  answer = { projects: [], title: '"Librarian renames drifting threads."', why: 'A feature' };
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.equal(h.runner.get(thread.id).title, 'Librarian renames drifting threads');
  assert.ok(!rec(h, thread.id).titleSet, 'still a model title, so a later look can rename it');
  assert.equal(librarian.status().recent[0].text, 'Renamed it Librarian renames drifting threads');
  // null, the same title, or a rambling one: nothing changes.
  for (const title of [null, 'Librarian renames drifting threads', 'a title that goes on and on and on for far more than ten words in all']) {
    answer = { projects: [], title };
    librarian.run(thread.id);
    await tick(8);
    assert.equal(h.runner.get(thread.id).title, 'Librarian renames drifting threads');
  }
  // Named by an agent: the look is told so, and a title it sends anyway is ignored.
  h.runner.update({ threadId: thread.id, title: 'Picked by the agent', titleBy: 'agent' });
  answer = (q: GenerateParams) => {
    assert.match(q.prompt, /Its title was set by the user or an agent/);
    return { projects: [], title: 'Something else' };
  };
  librarian.run(thread.id);
  await tick(8);
  assert.equal(h.runner.get(thread.id).title, 'Picked by the agent');
});

// "Chrome browser control" kept its name after the tool it's about was
// renamed Paws, then BrowserBear (Mike, 30 Oct 2026).
test('the librarian renames a project whose name has gone out of date, never one Mike named', async () => {
  let answer: unknown = {};
  const s = setup({ models: (p) => reply(typeof answer === 'function' ? (answer as (p: GenerateParams) => unknown)(p) : answer) });
  const { h, create, finish, librarian, projects } = s;
  const p = projects.create({ title: 'Chrome browser control', by: 'librarian' });
  const other = projects.create({ title: 'Other', by: 'agent' });
  const mikes = projects.create({ title: 'Mikes name', by: 'mike' });
  assert.equal(projects.record(p.id)?.titleBy, 'librarian');
  const { thread } = create('Rename Paws to BrowserBear');
  projects.changeMembership(thread.id, { add: [p.id, mikes.id], by: 'agent' });
  // Not from the first message alone.
  answer = { projects: [], retitle: { [p.id]: 'Too soon' } };
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(8);
  assert.equal(projects.record(p.id)?.title, 'Chrome browser control');
  // After a turn: one it's in, tidied; never one it isn't in.
  answer = (q: GenerateParams) => {
    assert.match(q.prompt, new RegExp(`${mikes.id} "Mikes name" \\(named by the user: keep it\\)`));
    assert.doesNotMatch(q.prompt, new RegExp(`${p.id} "Chrome browser control" \\(named`));
    return { projects: [], retitle: { [p.id]: ' "BrowserBear (Chrome browser control)." ', [other.id]: 'Not in it' } };
  };
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.equal(projects.record(p.id)?.title, 'BrowserBear (Chrome browser control)');
  assert.equal(projects.record(p.id)?.titleBy, 'librarian');
  assert.equal(projects.record(other.id)?.title, 'Other');
  assert.equal(librarian.status().recent[0].text, 'Renamed Chrome browser control to BrowserBear (Chrome browser control)');
  // Mike's name stays, whatever the look says.
  answer = { projects: [], retitle: { [mikes.id]: 'Something else' } };
  librarian.run(thread.id);
  await tick(8);
  assert.equal(projects.record(mikes.id)?.title, 'Mikes name');
  // An agent's rename can still be tidied later; Mike's rename in the app
  // (projects.update) makes it his.
  const tools = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, projects);
  await tools.find((x) => x.name === 'update_project')!.handler({ project: p.id, title: 'BrowserBear' } as never, {} as never);
  assert.equal(projects.record(p.id)?.titleBy, 'agent');
  await tools.find((x) => x.name === 'update_project')!.handler({ project: other.id, title: 'Asked for', mikeAsked: true } as never, {} as never);
  assert.equal(projects.record(other.id)?.titleBy, 'mike');
  projectMethods(projects)['projects.update']({ projectId: p.id, title: 'BrowserBear by Mike' });
  assert.equal(projects.record(p.id)?.titleBy, 'mike');
  answer = { projects: [], retitle: { [p.id]: 'BrowserBear again' } };
  librarian.run(thread.id);
  await tick(8);
  assert.equal(projects.record(p.id)?.title, 'BrowserBear by Mike');
});

test('the librarian files a new thread from its first message, then looks again when the first turn ends', async () => {
  let answer: unknown = {};
  const s = setup({ models: (p) => reply(typeof answer === 'function' ? (answer as (p: GenerateParams) => unknown)(p) : answer) });
  const { h, repo, create, finish, librarian, projects } = s;
  const app = repo('dev/app');
  const p = projects.create({ title: 'App', folders: [app], state: 'old', by: 'mike' });
  const { thread } = create('Fix the login screen in the app');
  const job = librarian.status().queue[0];
  assert.deepEqual([job.reason, job.why], ['first-message', 'Its first message came in']);
  assert.equal(Date.parse(job.dueAt) - h.clock.now(), FIRST_MESSAGE_MS);
  answer = (q: GenerateParams) => {
    assert.match(q.prompt, /It has only just started/);
    return { projects: [p.id], reasons: { [p.id]: 'Fixes the login' }, state: { [p.id]: 'Login fixed' } };
  };
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(8);
  assert.deepEqual(h.runner.get(thread.id).projects?.map((m) => m.title), ['App']);
  assert.equal(projects.record(p.id)?.state, 'old', 'an early look never changes the state');
  assert.equal(librarian.status().recent[0].reason, 'first-message');
  // The first turn's end still gets its own look, 10 seconds later.
  answer = { projects: [p.id], reasons: { [p.id]: 'Fixes the login' }, state: { [p.id]: 'Login fixed' } };
  await finish(thread.id, [path.join(app, 'login.ts')]);
  const next = librarian.status().queue[0];
  assert.equal(next.reason, 'first-turn');
  assert.equal(Date.parse(next.dueAt) - h.clock.now(), SETTLE_MS);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.equal(projects.record(p.id)?.state, 'Login fixed');
  // After that, more turns are catch-ups.
  h.runner.send(thread.id, 'more');
  await tick();
  assert.equal(librarian.status().queue.length, 0, 'a later message queues nothing');
  await finish(thread.id);
  assert.equal(librarian.status().queue[0].reason, 'catch-up');
});

test('the librarian sweeps up turns it never heard end, as in a handover', async () => {
  const s = setup({ models: () => reply({ projects: [], new: null, why: 'A one-off' }) });
  const { h, create, finish, librarian } = s;
  // A turn ends while no librarian is listening (the old runner's had
  // stopped for the handover, and the new one never hears it).
  librarian.stop();
  const { thread } = create('Quick question');
  await finish(thread.id);
  const { thread: idle } = create('Never finished');
  const again = new Librarian({ host: h.runner, projects: s.projects, models: { generate: async () => reply({ projects: [], why: 'A one-off' }) }, clock: h.clock, log: nullLogger, home: h.home, userHome: s.root });
  again.start();
  // The sweep on start finds the finished turn, and leaves the thread
  // still in its first.
  const queued = again.status().queue;
  assert.deepEqual(queued.map((j) => [j.threadId, j.reason]), [[thread.id, 'first-turn']]);
  assert.ok(!queued.some((j) => j.threadId === idle.id));
  await tick(8);
  assert.equal(again.status().recent[0].threadId, thread.id);
  // Looked at: the next sweep leaves it.
  h.clock.advance(SWEEP_MS);
  await tick(4);
  assert.ok(!again.status().queue.some((j) => j.threadId === thread.id));
  // A turn whose end it also missed is found by the sweep after it.
  again.stop();
  const third = new Librarian({ host: h.runner, projects: s.projects, models: { generate: async () => reply({}) }, clock: h.clock, log: nullLogger, home: h.home, userHome: s.root });
  h.runner.send(thread.id, 'more');
  await tick();
  await finish(thread.id);
  third.start();
  const job = third.status().queue.find((j) => j.threadId === thread.id)!;
  assert.equal(job.reason, 'catch-up');
  assert.ok(Date.parse(job.dueAt) > h.clock.now(), 'no sooner than CATCH_UP_MS after the last look');
  third.stop();
});

// A logger that keeps its warnings and errors, for "said nothing" checks.
function keepingLogger() {
  const lines: string[] = [];
  const log: Logger = { info() {}, debug() {}, warn: (m) => void lines.push(`warn ${m}`), error: (m) => void lines.push(`error ${m}`) };
  return { log, lines };
}

// A model call that waits until answer() is called.
function heldModel(value: () => unknown) {
  let answer!: () => void;
  const held = new Promise<void>((r) => (answer = r));
  let asked = false;
  return {
    models: async () => {
      asked = true;
      await held;
      return reply(value());
    },
    answer: () => answer(),
    asked: () => asked,
  };
}

test('a thread deleted while the librarian waits on the model is dropped quietly', async () => {
  // THREADBEAR-4: the look carried on and failed with "Thread not found".
  const { log, lines } = keepingLogger();
  let p!: { id: string };
  const m = heldModel(() => ({ projects: [p.id], state: { [p.id]: 'Going' } }));
  const s = setup({ models: () => m.models(), log });
  const { h, repo, create, finish, librarian, projects } = s;
  p = projects.create({ title: 'App', folders: [repo('dev/app')], by: 'mike' });
  const { thread } = create();
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(4);
  assert.ok(m.asked(), 'the look is waiting on the model');
  h.runner.delete(thread.id);
  m.answer();
  await tick(6);
  assert.deepEqual(lines, []);
  const st = librarian.status();
  assert.equal(st.state, 'idle');
  assert.ok(!st.recent.some((e) => e.threadId === thread.id), 'no "failed" line for a thread that has gone');
  assert.notEqual(projects.record(p.id)?.state, 'Going', "the answer about it isn't applied");
});

test('a thread a draining runner lets go mid-look is left to the new runner, quietly', async () => {
  // THREADBEAR-4 as it really happened: the thread wasn't deleted, the old
  // runner had handed it over while its look waited on the model.
  const { log, lines } = keepingLogger();
  const m = heldModel(() => ({ projects: [], new: null }));
  const s = setup({ models: () => m.models(), log });
  const { h, create, finish, librarian } = s;
  const { thread } = create();
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(4);
  assert.ok(m.asked());
  // main.ts's handOver: the librarian stops, then every idle thread is let go.
  librarian.stop();
  await h.runner.beginDrain([], { onHandedOver: () => {}, backgroundMs: 60_000 });
  // The new runner's librarian has read librarian.json by now: the job it
  // was doing is in its queue, so nothing is lost.
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'librarian.json'), 'utf8'));
  assert.deepEqual(saved.queue.map((j: { threadId: string }) => j.threadId), [thread.id]);
  const before = fs.readFileSync(path.join(h.home, 'librarian.json'), 'utf8');
  m.answer();
  await tick(6);
  assert.deepEqual(lines, []);
  // A stopped librarian leaves the file to the new runner's.
  assert.equal(fs.readFileSync(path.join(h.home, 'librarian.json'), 'utf8'), before);
});

test("a thread its agent filed is the agent's to file: the librarian keeps its line and state only", async () => {
  const s = setup({
    models: (q) => {
      assert.match(q.prompt, /Filed by its own agent or the user/);
      return reply({ projects: [other.id], new: { title: 'Another', folders: [], goals: 'x', state: 'y' }, state: { [p.id]: 'Shipped' }, thread: 'Done.' });
    },
  });
  const { h, repo, create, finish, librarian, projects } = s;
  const p = projects.create({ title: 'App', folders: [repo('dev/app')], state: 'old', by: 'mike' });
  const other = projects.create({ title: 'Other', by: 'mike' });
  const { thread } = create();
  projects.changeMembership(thread.id, { add: [p.id], by: 'agent' });
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.deepEqual(h.runner.get(thread.id).projects?.map((m) => m.title), ['App']);
  assert.equal(projects.list().length, 2, 'no new project');
  assert.equal(projects.record(p.id)?.state, 'Shipped');
  assert.equal(librarian.status().recent[0].text, "Updated App's state");
});

test('links: checked, titled from the host, added and retitled by url, merged, at most 8', () => {
  const { projects } = setup();
  const p = projects.create({ title: 'Cruise', links: [{ url: 'https://www.lights.example/' }], by: 'mike' });
  assert.deepEqual(p.links, [{ title: 'lights.example', url: 'https://www.lights.example/' }]);
  assert.throws(() => projects.update(p.id, { links: [{ url: 'file:///etc/hosts' }] }), RpcError);
  assert.throws(() => projects.update(p.id, { links: [{ url: 'not a url' }] }), RpcError);
  const added = projects.addLinks(p.id, [
    { title: 'Live site', url: 'https://www.lights.example' },
    { title: 'Admin', url: 'https://www.lights.example/admin' },
  ]);
  assert.deepEqual(added.links.map((l) => l.title), ['Live site', 'Admin'], 'the same page, with or without its slash, is retitled');
  assert.deepEqual(projects.removeLinks(p.id, ['https://www.lights.example/admin/']).links.map((l) => l.title), ['Live site']);
  const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://x.example/${i}` }));
  assert.throws(() => projects.update(p.id, { links: many }), /at most 8/);
  const other = projects.create({ title: 'Other', links: [{ title: 'Dash', url: 'https://dash.example' }, { url: 'https://www.lights.example/' }], by: 'mike' });
  assert.deepEqual(projects.merge(other.id, p.id).links.map((l) => l.title), ['Live site', 'Dash']);
  // Saved and read back.
  const again = new Projects({ home: (projects as any).file.replace(/\/projects\.json$/, ''), clock: new FakeClock(), log: nullLogger });
  again.start((projects as any).host);
  assert.deepEqual(again.record(p.id)?.links.map((l) => l.title), ['Live site', 'Dash']);
});

test('agent tools set links: create, add, remove, and read_project shows them', async () => {
  const { h, projects, create } = setup();
  const { thread } = create();
  const tools = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, projects);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await tools.find((x) => x.name === name)!.handler(args as never, {} as never);
    return { text: r.content.map((c: any) => c.text).join(''), error: Boolean(r.isError) };
  };
  await call('create_project', { title: 'Cruise', links: [{ title: 'Live site', url: 'https://cruise.example' }] });
  await call('update_project', { project: 'cruise', addLinks: [{ title: 'Admin', url: 'https://cruise.example/admin' }] });
  assert.match((await call('read_project', { project: 'cruise' })).text, /\nLinks: Live site https:\/\/cruise\.example\/ · Admin https:\/\/cruise\.example\/admin\n/);
  await call('update_project', { project: 'cruise', removeLinks: ['https://cruise.example/'] });
  assert.deepEqual(projects.list()[0].links.map((l) => l.title), ['Admin']);
  assert.equal((await call('update_project', { project: 'cruise', addLinks: [{ url: 'ftp://x' }] })).error, true);
});

test('the librarian adds a link only when the thread gave it, to a project the thread is in', async () => {
  let answer: unknown = {};
  const s = setup({ models: () => reply(answer) });
  const { h, create, finish, librarian, projects } = s;
  const p = projects.create({ title: 'Cruise', by: 'mike' });
  const other = projects.create({ title: 'Other', by: 'mike' });
  const { thread } = create('The site is live at https://cruise.example now');
  projects.changeMembership(thread.id, { add: [p.id], by: 'agent' });
  answer = {
    links: {
      [p.id]: [
        { title: 'Live site', url: 'https://cruise.example' },
        { title: 'Made up', url: 'https://invented.example' },
      ],
      [other.id]: [{ title: 'Live site', url: 'https://cruise.example' }],
    },
  };
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.deepEqual(projects.record(p.id)?.links, [{ title: 'Live site', url: 'https://cruise.example/' }]);
  assert.deepEqual(projects.record(other.id)?.links, [], 'not a project the thread is in');
  assert.equal(librarian.status().recent[0].text, 'Added a link to Cruise');
});

test('the librarian wakes a thread hibernating on a topic when Mike talks about it in another', async () => {
  const s = setup({
    models: (p) => {
      if (!p.prompt.includes('Router table jig')) return reply({ projects: [], new: null, state: {}, why: 'x' });
      assert.match(p.prompt, new RegExp(`Hibernating threads waiting for the user to talk about something:\\n- ${waiting.slice(0, 8)} "Plan the workbench drawers": woodworking`));
      return reply({ projects: [], new: null, state: {}, wake: [waiting.slice(0, 8), 'nothere1'], why: 'Woodworking again' });
    },
  });
  const { h, create, librarian } = s;
  const waiting = create('Plan the workbench drawers').thread.id;
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(6);
  h.runner.update({ threadId: waiting, snoozedUntil: new Date(h.clock.now() + 30 * 86_400_000).toISOString() });
  rec(h, waiting).wakeWhen = { said: 'next time I talk about woodworking', topic: 'woodworking' };
  const other = create('Router table jig').thread.id;
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(6);
  assert.equal(librarian.status().recent[0].text, 'Woke Plan the workbench drawers');
  assert.equal(h.runner.get(waiting).snoozedUntil, undefined);
  assert.equal(h.runner.get(waiting).needsYou, true);
  assert.notEqual(other, waiting);
});

test('a thread another is waiting on gets a look soon after any turn, and its met wakes the waiter', async () => {
  const s = setup({
    models: (p) => {
      if (!p.prompt.includes('Hibernating threads waiting until this thread has done something')) return reply({ projects: [], new: null, state: {}, why: 'x' });
      assert.match(p.prompt, new RegExp(`- ${waiter.slice(0, 8)} "Write the plan": until it reports the I/O saving`));
      return reply({ projects: [], new: null, state: {}, met: { [waiter.slice(0, 8)]: 'It posted the saving', nothere1: 'x' }, why: 'Measured' });
    },
  });
  const { h, create, librarian, finish } = s;
  const waiter = create('Write the plan').thread.id;
  const target = create('Measure the I/O saving').thread.id;
  await finish(waiter);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  h.runner.update({ threadId: waiter, snoozedUntil: new Date(h.clock.now() + 86_400_000).toISOString() });
  rec(h, waiter).waitingOn = [{ threadId: target, title: 'Measure the I/O saving', until: 'it reports the I/O saving' }];
  await finish(target);
  const job = librarian.status().queue.find((j) => j.threadId === target);
  assert.equal(job?.reason, 'waited-on');
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.equal(h.runner.get(waiter).snoozedUntil, undefined);
  assert.match(librarian.status().recent[0].text, /Woke Write the plan/);
});

test('a met with no reason, or for a waiter in a private folder, wakes nothing', async () => {
  let prompt = '';
  const s = setup({
    privateFolder: (cwd) => cwd.endsWith('secret'),
    models: (p) => {
      if (!p.prompt.includes('Measure the I/O saving')) return reply({ projects: [], new: null, state: {}, why: 'x' });
      prompt = p.prompt;
      return reply({ projects: [], new: null, state: {}, met: { [open.slice(0, 8)]: false, [hidden.slice(0, 8)]: 'It posted the saving' }, why: 'x' });
    },
  });
  const { h, misc, create, finish } = s;
  const secret = path.join(misc, 'secret');
  fs.mkdirSync(secret, { recursive: true });
  const open = create('Write the plan').thread.id;
  const hidden = create('Private plan', secret).thread.id;
  const target = create('Measure the I/O saving').thread.id;
  for (const w of [open, hidden]) {
    h.runner.update({ threadId: w, snoozedUntil: new Date(h.clock.now() + 86_400_000).toISOString() });
    rec(h, w).waitingOn = [{ threadId: target, title: 'Measure the I/O saving', until: 'it reports the I/O saving' }];
  }
  await finish(target);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.ok(prompt, 'the target was looked at');
  assert.doesNotMatch(prompt, /Private plan/);
  assert.ok(h.runner.get(open).snoozedUntil, 'false is not a reason');
  assert.ok(h.runner.get(hidden).snoozedUntil, 'never shown, so never met');
});

test('a look sees what the thread had attached and messages from the phone', async () => {
  const prompts: string[] = [];
  const s = setup({
    models: (p) => {
      prompts.push(p.prompt);
      return reply({ projects: [], new: null, state: {}, why: 'x' });
    },
  });
  const { h, root, misc, finish } = s;
  const t = h.runner.create({ text: 'Tidy the app', cwd: misc, accountId: 'claude-3', images: [] }).thread.id;
  await finish(t);
  // From the phone, with a picture.
  const picture = path.join(root, 'shot.png');
  // A 1x1 PNG, as the runner reads what it's sent.
  fs.writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  h.runner.send(t, 'the sidebar went blank again', [{ path: picture, mediaType: 'image/png' } as never], { origin: 'phone' });
  await tick();
  await finish(t);
  h.clock.advance(SETTLE_MS);
  await tick(6);
  const seen = prompts.filter((x) => x.includes('Thread "Tidy the app"')).at(-1)!;
  assert.match(seen, /User \(with an image you can't see\): the sidebar went blank again/);
});

// A note that won't fit says how to make room instead of only refusing
// (Mike, 30 Oct: Threadbear's notes hit the cap).
test('update_project says how to make room when the notes are full', async () => {
  const { h, projects, create } = setup();
  const { thread } = create();
  const tools = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, projects);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = await t.handler(args as never, {} as never);
    return { text: r.content.map((c: any) => c.text).join(''), error: Boolean(r.isError) };
  };
  await call('create_project', { title: 'App' });
  await call('update_project', { project: 'app', notes: 'x'.repeat(49_990) });
  const full = await call('update_project', { project: 'app', appendNote: 'One more thing.' });
  assert.equal(full.error, true);
  assert.match(full.text, /The notes are full \(49990 of 50000 characters\)\. Rewrite them shorter with notes/);
});

// Past NOTES_LONG the librarian rewrites a project's notes on the pool,
// keeps the old ones on disk and says so in what it did; it leaves short
// notes alone, notes it couldn't shorten, and notes that changed while
// the model was writing.
test('the librarian tidies long project notes and keeps the old ones', async () => {
  let answer = '```markdown\n## Decisions\n- ' + 'Keep pools provider-agnostic. '.repeat(10) + '\n```';
  let during: (() => void) | undefined;
  const { h, projects, librarian, asked } = setup({
    models: (p) => {
      during?.();
      return { ok: true, value: p.system?.startsWith('You tidy') ? answer : '{}', model: 'haiku' };
    },
  });
  const short = projects.create({ title: 'Short', by: 'mike', notes: 'Use npm ci.' });
  const long = projects.create({ title: 'Long', by: 'mike', notes: 'Landed a thing. '.repeat(NOTES_LONG / 10) });
  const before = projects.record(long.id)!.notes;
  await librarian.keepNotes();
  const tidyCalls = () => asked.filter((p) => p.system?.startsWith('You tidy'));
  assert.equal(tidyCalls().length, 1, 'only the long notes go to the model');
  assert.match(tidyCalls()[0].prompt, /^Project "Long"\n\nNotes:\nLanded a thing\./);
  assert.match(projects.record(long.id)!.notes, /^## Decisions\n- Keep pools/, 'the fence is taken off');
  assert.equal(projects.record(short.id)!.notes, 'Use npm ci.');
  const dir = path.join(h.home, 'project-notes');
  const kept = fs.readdirSync(dir);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startsWith(`${long.id}-`));
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), before);
  const entry = librarian.status().recent[0];
  assert.deepEqual([entry.threadId, entry.reason, entry.outcome, entry.projectIds], ['', 'notes', 'updated', [long.id]]);
  assert.match(entry.text, /^Tidied Long's notes, [\d,]+ to \d+ characters$/);

  // An answer that's no shorter is dropped, and the same notes aren't sent again.
  projects.update(long.id, { notes: before });
  answer = before;
  await librarian.keepNotes();
  await librarian.keepNotes();
  assert.equal(tidyCalls().length, 2);
  assert.equal(projects.record(long.id)!.notes, before);

  // A note added while the model was writing wins; the tidy waits for next time.
  projects.update(long.id, { notes: before + ' One more.' });
  answer = '## Open\n- ' + 'A thing still owed. '.repeat(15);
  during = () => projects.appendNote(long.id, 'Added mid-tidy.');
  await librarian.keepNotes();
  assert.match(projects.record(long.id)!.notes, /Added mid-tidy\.$/);
});

function fakePocket(cards: PocketCardSummary[] = []) {
  const saved: PocketCardInput[] = [];
  const removed: string[] = [];
  const pocket: LibrarianPocket = {
    pocketCards: async () => cards,
    savePocketCard: async (c) => {
      saved.push(c);
      const had = cards.findIndex((x) => x.title.toLowerCase() === c.title.toLowerCase());
      if (had >= 0) cards.splice(had, 1);
      cards.push({ ...c, updatedAt: 'now' });
      return had >= 0 ? 'replaced' : 'added';
    },
    removePocketCard: async (title) => {
      removed.push(title);
      const had = cards.findIndex((x) => x.title === title);
      if (had >= 0) cards.splice(had, 1);
      return had >= 0;
    },
  };
  return { cards, saved, removed, pocket };
}

test("a look files a card when the thread says it's going out, and doesn't file it again once it's taken out", async () => {
  const fake = fakePocket();
  const s = setup({ pocket: () => fake.pocket, models: () => reply({ projects: [], why: 'Errand', pocket: { save: [{ title: 'Post office', text: 'Take the parcel', place: 'post office' }] } }) });
  const { h, create, finish, librarian, asked } = s;
  const { thread } = create("I'm heading to the post office with the parcel");
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.deepEqual(fake.saved.map((c) => [c.title, c.threadId, c.source]), [['Post office', thread.id, 'misc']]);
  assert.match(librarian.status().recent[0].text, /Filed "Post office" in the Pocket/);
  assert.match(asked.at(-1)!.prompt, /Pocket cards from this thread:\n\(none\)/);
  // Mike takes it out on the phone, and the thread's still about the trip.
  fake.cards.length = 0;
  h.runner.send(thread.id, 'On my way there now');
  await tick();
  await finish(thread.id);
  h.clock.advance(CATCH_UP_MS);
  await tick(8);
  assert.ok(asked.length >= 2);
  assert.equal(fake.saved.length, 1);
});

test('a short "posted it" still gets a look, which takes out the thread\'s card', async () => {
  const s0 = fakePocket();
  let answer: unknown = { projects: [], why: 'Errand' };
  const s = setup({ pocket: () => s0.pocket, models: () => reply(answer) });
  const { h, create, finish, asked } = s;
  const { thread } = create('Sort the parcel');
  h.clock.advance(FIRST_MESSAGE_MS);
  await tick(8);
  await finish(thread.id);
  h.clock.advance(SETTLE_MS);
  await tick(8);
  s0.cards.push({ title: 'Post to Corby', text: 'Long Croft Road', threadId: thread.id, updatedAt: 'x' });
  s0.cards.push({ title: 'Europe trip', text: 'EXBEEI', updatedAt: 'x' });
  const calls = asked.length;
  answer = { projects: [], why: 'Posted', pocket: { remove: ['Post to Corby', 'Europe trip'] } };
  h.runner.send(thread.id, 'Posted it');
  await tick();
  await finish(thread.id);
  h.clock.advance(CATCH_UP_MS);
  await tick(8);
  assert.equal(asked.length, calls + 1);
  assert.match(asked.at(-1)!.prompt, /- "Post to Corby": Long Croft Road/);
  assert.match(asked.at(-1)!.prompt, /Other Pocket cards, not yours to touch: "Europe trip"/);
  assert.deepEqual(s0.removed, ['Post to Corby']);
});

test('a look from the first message alone leaves the Pocket to its agent, and a backend that fails costs only the Pocket', async () => {
  const fake = fakePocket();
  const s = setup({ pocket: () => fake.pocket, models: () => reply({ projects: [], why: 'Errand', pocket: { save: [{ title: 'Early', text: 'Too soon' }] } }) });
  const { thread } = s.create("I'm heading to the shops");
  s.h.clock.advance(FIRST_MESSAGE_MS);
  await tick(8);
  assert.match(s.asked.at(-1)!.prompt, /The Pocket is not available/);
  assert.equal(fake.saved.length, 0);
  fake.pocket.pocketCards = async () => {
    throw new Error('no signal');
  };
  await s.finish(thread.id);
  s.h.clock.advance(SETTLE_MS);
  await tick(8);
  assert.match(s.asked.at(-1)!.prompt, /The Pocket is not available/);
  assert.equal(fake.saved.length, 0);
});
