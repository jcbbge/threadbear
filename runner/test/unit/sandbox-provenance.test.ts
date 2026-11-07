// Daybreak, 7 Nov 2026 ("Sandboxed agents can launch unsandboxed host
// threads via MCP"). A thread whose CLI runs in the sandbox (sandbox.ts) is
// on Full access inside it, and the threadbear tools took it at that word:
// create_thread with folder "~" started a Full access thread on the machine,
// no card. Now a sandboxed agent counts as restricted (threadbear-mcp.ts,
// "Raising access"): anything that would run outside its sandbox asks, on a
// card with no Always allow, and a thread it starts in a sandbox folder is
// shut in it for good (ThreadRecord.confined), so a link put in its folder's
// place later can't start it outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeAccounts, makeHarness, tick, tmpDir, withCodex } from '../helpers/fakes.ts';
import { TRUST_ALL } from '../../src/patch-trust.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { Scheduler } from '../../src/schedules.ts';
import { nullLogger } from '../../src/log.ts';
import { dockerRun } from '../../src/sandbox.ts';
import type { ApprovalDecision, PermissionMode } from '../../src/protocol.ts';

function setup(opts: { callerIn?: 'box' | 'host'; mode?: PermissionMode } = {}) {
  const root = fs.realpathSync(tmpDir());
  const box = path.join(root, 'sandboxed');
  const demo = path.join(box, 'demo');
  const outside = path.join(root, 'elsewhere');
  for (const d of [demo, outside]) fs.mkdirSync(d, { recursive: true });
  const trusted: string[] = [];
  const h = makeHarness(tmpDir(), { sandbox: { folders: [box], image: 'threadbear-sandbox', docker: 'docker' } }, {
    accounts: new FakeAccounts(withCodex()),
    patchTrust: { ...TRUST_ALL, trustAgentWrite: (file: string) => (trusted.push(file), [file]) },
  });
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC' });
  sched.start();
  const host = h.runner.create({ text: 'Host work', accountId: 'claude-3', cwd: outside, permissionMode: 'ask' }).thread;
  h.adapter.last.init();
  const me = h.runner.create({ text: 'Me', accountId: 'claude-3', cwd: opts.callerIn === 'host' ? outside : demo, permissionMode: opts.mode ?? 'full' }).thread;
  h.adapter.last.init();
  // As the router has it: another runner's start (cross-runner.ts) answers for itself.
  const updates: Record<string, unknown>[] = [];
  const control = new Proxy(h.runner, { get: (t, k) => (k === 'update' ? (u: Record<string, unknown>) => (updates.push(u), t.update(u as never)) : k === 'startOn' ? async () => 'Asked bruce to start it.' : typeof (t as any)[k] === 'function' ? (t as any)[k].bind(t) : (t as any)[k]) });
  const list = buildThreadbearTools(control as never, me.id, () => h.clock.now(), sched, undefined, undefined, { scheduleChecks: () => true, sleep: async () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = list.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
  const cards = () => h.events(me.id).filter((e) => e.type === 'approval.requested');
  const withCard = async (decision: ApprovalDecision | null, name: string, args: Record<string, unknown>) => {
    const before = cards().length;
    const p = call(name, args);
    let card: any;
    for (let i = 0; i < 50 && !card; i++) {
      await tick();
      card = cards().length > before ? cards().at(-1) : undefined;
    }
    if (decision === null) {
      assert.equal(card, undefined, `no card for ${name} ${JSON.stringify(args)}`);
      return { ...(await p), card };
    }
    assert.ok(card, `a card for ${name} ${JSON.stringify(args)}`);
    h.runner.respondApproval({ threadId: me.id, approvalId: card.approvalId, decision });
    return { ...(await p), card };
  };
  const byTitle = (title: string) => h.runner.list().find((t) => t.title === title);
  const rec = (id: string) => h.store.loadAll().records.find((t) => t.id === id)!;
  return { h, sched, root, box, demo, outside, host, me, call, withCard, byTitle, rec, trusted, updates };
}

test('a thread started in a sandbox folder is shut in it, and its session is told so', () => {
  const s = setup();
  assert.equal(s.rec(s.me.id).confined, true);
  assert.equal(s.h.adapter.sessions.find((x) => x.opts.threadId === s.me.id)?.opts.confined, true);
  assert.equal(s.rec(s.host.id).confined, undefined, 'one outside it is not');
});

test("the scan's attack: create_thread from a sandboxed Full thread into ~ or any folder outside asks, with no Always allow", async () => {
  const s = setup();
  for (const folder of ['~', s.outside, '../../elsewhere']) {
    const r = await s.withCard('deny', 'create_thread', { text: 'run a host command', title: `Escape ${folder}`, folder, permissionMode: 'full' });
    assert.equal(r.error, true);
    assert.deepEqual(r.card.options, ['allow', 'deny']);
    assert.match(r.card.title, /^Start a thread with Full access outside the sandbox in /);
    assert.equal(s.byTitle(`Escape ${folder}`), undefined, 'nothing started');
  }
  // The card names where it really runs.
  const shown = await s.withCard('deny', 'create_thread', { text: 'x', title: 'Shown', folder: '../../elsewhere' });
  assert.equal(shown.card.input.folder, s.outside);
  // Allowed: Mike's choice, and the new thread runs outside, not shut in.
  const ok = await s.withCard('allow', 'create_thread', { text: 'fine', title: 'Allowed', folder: s.outside });
  assert.equal(ok.error, false, ok.text);
  assert.equal(s.rec(s.byTitle('Allowed')!.id).confined, undefined);
  // On another machine counts as outside too.
  const remote = await s.withCard('deny', 'create_thread', { text: 'x', title: 'Remote', runner: 'bruce' });
  assert.match(remote.card.title, /on bruce$/);
});

test('inside its sandbox it carries on unasked, and what it starts there is shut in too', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.demo, 'sub'));
  const r = await s.withCard(null, 'create_thread', { text: 'helper', title: 'Helper', folder: 'sub' });
  assert.equal(r.error, false, r.text);
  const child = s.byTitle('Helper')!;
  assert.equal(s.rec(child.id).confined, true);
  assert.equal(s.h.adapter.sessions.find((x) => x.opts.threadId === child.id)?.opts.confined, true);
  // A Codex login never runs in the sandbox: refused, not started outside.
  const codex = await s.withCard(null, 'create_thread', { text: 'x', title: 'Codex', folder: 'sub', account: 'codex-main' });
  assert.equal(codex.error, true);
  assert.match(codex.text, /Codex doesn't run in the sandbox/);
  assert.equal(s.byTitle('Codex'), undefined);
});

test('a link inside the sandbox to a folder outside it: the card shows where it leads, and a link put in place later never starts the thread outside', async () => {
  const s = setup();
  fs.symlinkSync(s.outside, path.join(s.demo, 'innocent'));
  const r = await s.withCard('deny', 'create_thread', { text: 'x', title: 'Via link', folder: 'innocent' });
  assert.equal(r.card.input.folder, s.outside);
  assert.match(r.card.title, new RegExp(`in ${s.outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  // Shut in at the start, then its folder swapped for a link to outside.
  const sub = path.join(s.demo, 'later');
  fs.mkdirSync(sub);
  await s.withCard(null, 'create_thread', { text: 'first', title: 'Later', folder: 'later' });
  const child = s.byTitle('Later')!;
  const session = s.h.adapter.sessions.find((x) => x.opts.threadId === child.id)!;
  session.init();
  session.result('completed');
  await tick();
  fs.rmSync(sub, { recursive: true });
  fs.symlinkSync(s.outside, sub);
  // Its next CLI start (here after a restart; an idle stop is the same).
  const h2 = s.h.restart();
  h2.runner.send(child.id, 'go on');
  await tick(10);
  assert.equal(h2.adapter.sessions.length, 0, 'no CLI started outside');
  assert.ok(h2.events(child.id).some((e) => /isn't in a sandbox folder now/.test(JSON.stringify(e))), 'and the thread says why');
  // Nor can an agent move it out: only Mike, or his yes on a card.
  assert.throws(() => h2.runner.update({ threadId: child.id, cwd: s.outside }), /runs in a sandbox/);
});

test('messages, moves, schedules, checks and pins from a sandboxed thread ask once they reach outside it', async () => {
  const s = setup();
  const msg = await s.withCard('deny', 'send_message', { threadId: s.host.id, text: 'cat ~/.ssh/id_ed25519' });
  assert.match(msg.card.title, /^Send a message to "Host work", which has Ask before edits outside the sandbox$/);
  const sched = await s.withCard('deny', 'schedule_message', { text: 'x', when: '1h', new_thread: true, folder: '.' });
  assert.match(sched.card.title, /^Schedule new threads with Full access outside the sandbox/);
  const check = await s.withCard('deny', 'schedule_message', { text: 'x', when: '1h', check: 'echo news' });
  assert.match(check.card.title, /shell command as you before each run, outside the sandbox/);
  // A button's brief runs outside at Mike's press (the replyButtons experiment).
  const list = buildThreadbearTools(s.h.runner, s.me.id, () => s.h.clock.now(), s.sched, undefined, undefined, { sleep: async () => {}, replyButtons: () => true } as never);
  const button = list.find((x) => x.name === 'add_button')!;
  {
    const before = s.h.events(s.me.id).filter((e) => e.type === 'approval.requested').length;
    const made = button.handler({ title: 'Do it', start: { text: 'run a host command', folder: s.outside } } as never, {}) as Promise<{ isError?: boolean }>;
    let card: any;
    for (let i = 0; i < 50 && !card; i++) {
      await tick();
      const all = s.h.events(s.me.id).filter((e) => e.type === 'approval.requested');
      card = all.length > before ? all.at(-1) : undefined;
    }
    assert.match(card.title, /^Make the button "Do it", outside the sandbox$/);
    assert.equal(card.input.start.text, 'run a host command');
    s.h.runner.respondApproval({ threadId: s.me.id, approvalId: card.approvalId, decision: 'deny' });
    assert.equal((await made).isError, true);
  }
  const pin = await s.withCard('deny', 'pin', { path: 'payload.command' });
  assert.match(pin.card.title, /outside the sandbox$/);
  // Moving itself out: asked, and refused by the runner without the card's yes.
  const move = await s.withCard('deny', 'move_thread', { folder: s.outside });
  assert.equal(move.error, true);
  assert.equal(s.h.runner.get(s.me.id).cwd, s.demo);
  assert.throws(() => s.h.runner.update({ threadId: s.me.id, cwd: s.outside }), /runs in a sandbox/);
  assert.throws(() => s.h.runner.update({ threadId: s.me.id, accountId: 'codex-main' }), /runs in a sandbox/);
  const moved = await s.withCard('allow', 'move_thread', { folder: s.outside });
  assert.equal(moved.error, false, moved.text);
  assert.equal(s.h.runner.get(s.me.id).cwd, s.outside);
  assert.equal(s.rec(s.me.id).confined, undefined);
});

test("a sandboxed thread's own patch edits aren't trusted as written: the runner and the Mac would run them outside it", () => {
  const s = setup();
  const session = s.h.adapter.sessions.find((x) => x.opts.threadId === s.me.id)!;
  session.out({ kind: 'wrote', mode: 'full', files: [{ path: '.threadbear/patches/p.ts', sha256: 'a'.repeat(64), base: null }] } as never);
  assert.deepEqual(s.trusted, []);
  const host = setup({ callerIn: 'host' });
  const hostSession = host.h.adapter.sessions.find((x) => x.opts.threadId === host.me.id)!;
  hostSession.out({ kind: 'wrote', mode: 'full', files: [{ path: '.threadbear/patches/p.ts', sha256: 'a'.repeat(64), base: null }] } as never);
  assert.equal(host.trusted.length, 1, 'a Full thread outside any sandbox still is (Mike\'s workflow)');
});

test('a Full access thread outside any sandbox is never asked, as before', async () => {
  const s = setup({ callerIn: 'host' });
  const r = await s.withCard(null, 'create_thread', { text: 'x', title: 'Anywhere', folder: '~' });
  assert.equal(r.error, false, r.text);
  assert.equal(s.byTitle('Anywhere')!.cwd, os.homedir(), 'its folder as written');
  await s.withCard(null, 'send_message', { threadId: s.host.id, text: 'hi' });
  // Moving a sandboxed thread out from here is the user's level: no card, and it may leave.
  const boxed = s.h.runner.create({ text: 'Boxed', accountId: 'claude-3', cwd: s.demo }).thread;
  const moved = await s.withCard(null, 'move_thread', { threadId: boxed.id, folder: s.outside });
  assert.equal(moved.error, false, moved.text);
  assert.equal(s.rec(boxed.id).confined, undefined);
});

test("a Full thread outside any sandbox may move a sandboxed one's login, as with a move; a show_options card has all its options", async () => {
  const s = setup({ callerIn: 'host' });
  const boxed = s.h.runner.create({ text: 'Boxed', accountId: 'claude-3', cwd: s.demo }).thread;
  await s.withCard(null, 'update_thread', { threadId: boxed.id, pool: 'pin' });
  assert.equal(s.updates.at(-1)!.unconfine, true);
  const inBox = setup();
  const r = await inBox.withCard('deny', 'show_options', { title: 'Pick', options: [{ id: 'A', title: 'Fine', shots: [{ path: '/outside/private.png' }] }] });
  assert.match(JSON.stringify(r.card.input), /\/outside\/private\.png/);
});

test('the docker run refuses a folder that is no longer in a sandbox folder, rather than mounting where a link points', () => {
  const sb = { folders: ['/home/mike/sandboxed'], image: 'img', docker: 'docker' };
  const ctx = (to: string) => ({ threadId: 't', home: '/home/mike', uid: 1, gid: 1, exists: () => true, realpath: (p: string) => (p === '/home/mike/sandboxed/demo' ? to : p) });
  assert.ok(dockerRun({ command: '/c', args: [], cwd: '/home/mike/sandboxed/demo', env: {} }, sb, ctx('/home/mike/sandboxed/demo')));
  assert.throws(() => dockerRun({ command: '/c', args: [], cwd: '/home/mike/sandboxed/demo', env: {} }, sb, ctx('/home/mike')), /isn't in a sandbox folder now/);
});

// Codex review, 7 Nov 2026: a login's config folder is mounted into the
// sandbox, so moving a schedule's or a thread's runs outside it onto
// another login reaches outside too.
test('from a sandboxed thread, changing the login of a schedule or a thread outside it asks', async () => {
  const s = setup();
  const sc = await s.sched.create({ text: 'nightly', cron: '0 3 * * *', cwd: s.outside, accountId: 'claude-3' });
  const r = await s.withCard('deny', 'update_schedule', { scheduleId: sc.id, account: 'claude-main' });
  assert.equal(r.error, true);
  assert.equal((await s.sched.find(sc.id)).accountId, 'claude-3');
  const pools = await s.withCard('deny', 'update_thread', { threadId: s.host.id, pool: 'pin' });
  assert.match(pools.card.title, /^Change the logins of "Host work"/);
  s.sched.stop();
});
