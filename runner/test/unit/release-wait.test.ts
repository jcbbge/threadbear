// Hibernating until the runner starts on a new release (snoozedUntil
// "release"), and the wake note the phone and website show (wake-note.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { wakeNote } from '../../src/wake-note.ts';

function asleepOn(release: string) {
  const home = tmpDir();
  const h = makeHarness(home, {}, { release });
  const { thread } = h.runner.create({ text: 'Measure the I/O saving', accountId: 'claude-3' });
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: thread.id, snoozedUntil: 'release' });
  h.runner.flush();
  return { home, h, id: thread.id };
}

test('snoozedUntil "release": a restart on the same release leaves it asleep, a new release wakes it', () => {
  const { home, h, id } = asleepOn('r1');
  const t = h.runner.get(id);
  assert.equal(t.snoozedUntilRestart, true);
  assert.equal(t.snoozedUntilRelease, true);
  assert.deepEqual(checkSummary(t), []);
  assert.equal(wakeNote(t), 'the runner updates');
  const same = makeHarness(home, {}, { release: 'r1' });
  assert.equal(same.runner.get(id).snoozedUntilRelease, true, 'a crash restart on r1 is not an update');
  same.runner.flush();
  const next = makeHarness(home, {}, { release: 'r2' });
  assert.equal(next.runner.get(id).snoozedUntil, undefined);
  assert.ok(next.events(id).some((e) => e.type === 'system.note' && /^Woke up/.test(e.text)));
});

test('from a source checkout (no release) it acts as a plain restart wait', () => {
  const home = tmpDir();
  const h = makeHarness(home, {}, { release: undefined });
  const { thread } = h.runner.create({ text: 'x', accountId: 'claude-3' });
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.update({ threadId: thread.id, snoozedUntil: 'release' });
  assert.equal(h.runner.get(thread.id).snoozedUntilRelease, undefined);
  assert.equal(wakeNote(h.runner.get(thread.id)), 'the runner restarts');
});

test('wakeNote: threads waited on, a condition, a topic; nothing for a plain time or once awake', () => {
  const s = { snoozedUntil: '2026-11-06T00:00:00Z' };
  assert.equal(wakeNote({ ...s, waitingOn: [{ threadId: 'a', title: 'Convex I/O' }] }), '"Convex I/O" finishes');
  assert.equal(wakeNote({ ...s, waitingOn: [{ threadId: 'a', title: 'A' }, { threadId: 'b', title: 'B' }] }), '"A" and "B" finish');
  assert.equal(wakeNote({ ...s, waitingOn: [{ threadId: 'a', title: 'A', done: true }, { threadId: 'b', title: 'B', until: 'reports the saving' }] }), '"B" reports the saving');
  assert.equal(wakeNote({ ...s, wakeWhen: { said: 'next time', topic: 'woodworking' } }), 'you talk about woodworking');
  assert.equal(wakeNote(s), undefined);
  assert.equal(wakeNote({ waitingOn: [{ threadId: 'a', title: 'A' }] }), undefined);
});

test('the row carries the wake note, and an older backend gets it without', async () => {
  const { forBackend, toThreadDoc, WAKE_NOTE_API_VERSION } = await import('../../src/sync.ts');
  const { h, id } = asleepOn('r1');
  const doc = toThreadDoc(h.runner.get(id), 'mac', Date.now());
  assert.equal(doc.wakeNote, 'the runner updates');
  assert.equal(forBackend(doc, WAKE_NOTE_API_VERSION, Date.now()).wakeNote, 'the runner updates');
  assert.equal(forBackend(doc, WAKE_NOTE_API_VERSION - 1, Date.now()).wakeNote, undefined);
});

test('a long note is cut to fit; waking clears the release marker', () => {
  const long = 'x'.repeat(300);
  const n = wakeNote({ snoozedUntil: '2026-11-06T00:00:00Z', waitingOn: [{ threadId: 'a', title: long, until: long }] })!;
  assert.ok(n.length <= 160 && n.endsWith('…'));
  const { h, id } = asleepOn('r1');
  h.runner.send(id, 'wake up');
  // The marker itself, as an older runner would keep it into a later restart wait.
  assert.equal((h.runner as any).threads.get(id).rec.untilRelease, undefined);
});
