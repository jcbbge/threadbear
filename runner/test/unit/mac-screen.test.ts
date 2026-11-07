import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';
import { LOOK_MS, MacScreen, TELL_AFTER_MS, canOpen, parseDialogCount, type ScreenProbe } from '../../src/mac-screen.ts';

class FakeProbe implements ScreenProbe {
  count: number | undefined = 0;
  access: boolean | undefined = true;
  app = true;
  async dialogs() {
    return this.count;
  }
  fullDiskAccess() {
    return this.access;
  }
  hasApp() {
    return this.app;
  }
}

function setUp() {
  const h = makeHarness();
  const probe = new FakeProbe();
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mac-screen-')), 'mac-screen.json');
  const make = () => new MacScreen({ host: h.runner, clock: h.clock, log: nullLogger, machine: 'bruce', stateFile, probe });
  const screen = make();
  const look = async (ms = LOOK_MS, s = screen) => {
    h.clock.advance(ms);
    await s.look();
  };
  const noticeThreads = () => h.runner.list().filter((t) => /bruce/.test(t.title));
  const notes = (id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => String(e.text));
  return { h, probe, screen, make, look, noticeThreads, notes };
}

test('a dialog left waiting gets a thread in Needs you, without starting a CLI', async () => {
  const { h, probe, look, noticeThreads, notes } = setUp();
  probe.count = 1;
  await look();
  assert.equal(noticeThreads().length, 0, 'someone may be about to answer it');
  await look(TELL_AFTER_MS);
  const [t] = noticeThreads();
  assert.ok(t);
  assert.equal(t.needsYou, true);
  assert.match(notes(t.id)[0], /dialog has been waiting on bruce/);
  assert.match(notes(t.id)[0], /Full Disk Access/);
  assert.equal(h.adapter.sessions.length, 0, 'telling costs no model call');
  await look();
  await look();
  assert.equal(notes(t.id).length, 1, 'said once');
});

test('the thread archives itself when the dialog goes, and the next dialog gets a new one', async () => {
  const { h, probe, look, noticeThreads, notes } = setUp();
  probe.count = 2;
  await look();
  await look(TELL_AFTER_MS);
  const id = noticeThreads()[0].id;
  probe.count = 0;
  await look();
  assert.match(notes(id)[1], /gone/);
  assert.deepEqual(noticeThreads().map((t) => t.id), [], "nothing's left to do, so it leaves the inbox");
  assert.equal(h.runner.list(['archived']).find((t) => t.id === id)?.needsYou, false);
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  assert.equal(noticeThreads().length, 1);
  assert.notEqual(noticeThreads()[0].id, id);
});

test('a notice thread someone has written in stays when the dialog goes', async () => {
  const { h, probe, look, noticeThreads } = setUp();
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  const id = noticeThreads()[0].id;
  h.runner.send(id, 'What was the dialog?');
  const session = h.adapter.last;
  session.init();
  session.result();
  await tick();
  probe.count = 0;
  await look();
  const t = h.runner.list().find((x) => x.id === id);
  // Its own unread reply may still want reading, so only where it is matters.
  assert.ok(t, 'still in the inbox');
});

test('a notice thread still asking for Full Disk Access stays when the dialog goes', async () => {
  const { probe, look, noticeThreads, notes } = setUp();
  probe.app = false;
  probe.access = false;
  await look();
  const id = noticeThreads()[0].id;
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  probe.count = 0;
  await look();
  assert.equal(noticeThreads()[0]?.id, id);
  assert.match(notes(id).at(-1)!, /gone/);
});

test('a dialog that goes before the wait is up is never mentioned', async () => {
  const { probe, look, noticeThreads } = setUp();
  probe.count = 1;
  await look();
  probe.count = 0;
  await look();
  probe.count = 1;
  await look(TELL_AFTER_MS - 1000);
  assert.equal(noticeThreads().length, 0);
});

test('restarts neither reset the wait nor say it again', async () => {
  const { probe, make, look, noticeThreads, notes } = setUp();
  // Bruce's runner restarts on every commit to main, so a wait held only in
  // memory might never reach its 5 minutes.
  probe.count = 1;
  await look(LOOK_MS, make());
  await look(TELL_AFTER_MS, make());
  const [t] = noticeThreads();
  assert.ok(t);
  await look(LOOK_MS, make());
  assert.equal(noticeThreads().length, 1);
  assert.equal(notes(t.id).length, 1);
});

test('not being able to look says nothing, either way', async () => {
  const { probe, look, noticeThreads, notes } = setUp();
  probe.count = undefined;
  await look();
  await look(TELL_AFTER_MS);
  assert.equal(noticeThreads().length, 0);
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  const [t] = noticeThreads();
  probe.count = undefined;
  await look();
  assert.equal(notes(t.id).length, 1, "it isn't known to have gone");
});

test('a Mac with no Threadbear app and no Full Disk Access is told once, up front', async () => {
  const { probe, make, look, noticeThreads, notes } = setUp();
  probe.app = false;
  probe.access = false;
  await look(LOOK_MS, make());
  const [t] = noticeThreads();
  assert.ok(t);
  assert.equal(t.needsYou, true);
  assert.match(notes(t.id)[0], /doesn't have Full Disk Access on bruce/);
  await look(LOOK_MS, make());
  assert.equal(notes(t.id).length, 1);
});

test('granting Full Disk Access says so and archives the notice thread', async () => {
  const { h, probe, make, look, noticeThreads, notes } = setUp();
  // ganttbookM5, 5 Nov 2026: told at its first start, granted 80 seconds
  // later, and the thread went on saying it was missing.
  probe.app = false;
  probe.access = false;
  await look(LOOK_MS, make());
  const id = noticeThreads()[0].id;
  probe.access = true;
  await look(LOOK_MS, make());
  assert.match(notes(id).at(-1)!, /has Full Disk Access on bruce now/);
  assert.deepEqual(noticeThreads().map((t) => t.id), [], "nothing's left to do, so it leaves the inbox");
  assert.equal(h.runner.list(['archived']).find((t) => t.id === id)?.needsYou, false);
  await look(LOOK_MS, make());
  assert.equal(notes(id).length, 2, 'said once');
  probe.access = false;
  await look(LOOK_MS, make());
  assert.equal(noticeThreads().length, 1, 'losing it again is told again');
});

test('granting Full Disk Access keeps the thread while a dialog it told of is still up', async () => {
  const { probe, look, noticeThreads, notes } = setUp();
  probe.app = false;
  probe.access = false;
  await look();
  const id = noticeThreads()[0].id;
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  probe.access = true;
  await look();
  assert.match(notes(id).at(-1)!, /has Full Disk Access/);
  assert.equal(noticeThreads()[0]?.id, id, 'the dialog still needs answering');
  assert.equal(noticeThreads()[0]?.needsYou, true, 'and it stays in Needs you');
  probe.count = 0;
  await look();
  assert.deepEqual(noticeThreads(), [], 'and goes with it');
});

test('a Mac with the app, or the access, is not nagged about it', async () => {
  const a = setUp();
  a.probe.app = true;
  a.probe.access = false;
  await a.look();
  assert.equal(a.noticeThreads().length, 0);
  const b = setUp();
  b.probe.app = false;
  b.probe.access = true;
  await b.look();
  assert.equal(b.noticeThreads().length, 0);
  const c = setUp();
  c.probe.app = false;
  c.probe.access = undefined;
  await c.look();
  assert.equal(c.noticeThreads().length, 0);
});

test('an archived or deleted notice thread is left alone, and a new one made', async () => {
  const { h, probe, look, noticeThreads } = setUp();
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  const first = noticeThreads()[0].id;
  h.runner.delete(first);
  probe.count = 0;
  await look();
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  const [next] = noticeThreads();
  assert.ok(next);
  assert.notEqual(next.id, first);
});

test('status says what tb status shows', async () => {
  const { h, probe, screen, look } = setUp();
  assert.deepEqual(screen.status(), { dialogs: 0 });
  probe.count = 2;
  probe.access = false;
  await look();
  const at = new Date(h.clock.now()).toISOString();
  assert.deepEqual(screen.status(), { fullDiskAccess: false, dialogs: 2, dialogsSince: at });
});

test('canOpen tells a file that opens from one that will not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-screen-'));
  const file = path.join(dir, 'x');
  fs.writeFileSync(file, 'x');
  assert.equal(canOpen(file), true);
  assert.equal(canOpen(path.join(dir, 'missing')), undefined);
  // Root can open anything, so there's no refusal to see when run as root.
  if (process.getuid?.() !== 0) {
    fs.chmodSync(file, 0o000);
    assert.equal(canOpen(file), false);
    fs.chmodSync(file, 0o600);
  }
});

test('parseDialogCount reads what osascript prints', () => {
  assert.equal(parseDialogCount('2\n'), 2);
  assert.equal(parseDialogCount('0\n'), 0);
  assert.equal(parseDialogCount(''), undefined);
  assert.equal(parseDialogCount('error'), undefined);
});

test("a dialog going while the access can't be told keeps the access notice", async () => {
  const { probe, look, noticeThreads, notes } = setUp();
  // Codex's review, 6 Nov 2026: a look that couldn't tell (an odd error
  // opening TCC.db) isn't a grant, so it mustn't archive the access note,
  // which is never said again once it's been said.
  probe.app = false;
  probe.access = false;
  await look();
  const id = noticeThreads()[0].id;
  probe.count = 1;
  await look();
  await look(TELL_AFTER_MS);
  probe.access = undefined;
  probe.count = 0;
  await look();
  assert.match(notes(id).at(-1)!, /has gone/);
  assert.equal(noticeThreads()[0]?.id, id);
  assert.equal(noticeThreads()[0]?.needsYou, true);
});
