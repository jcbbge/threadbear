import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { BringIn, parseBringIn, releaseDay } from '../../src/bring-in.ts';
import type { BringInSetting } from '../../src/bring-in.ts';
import type { UpstreamStatus } from '../../src/upstream.ts';

const DAY = 24 * 60 * 60_000;

function rig(setting: BringInSetting = 5) {
  const clock = new FakeClock();
  const started: { text: string; title: string; why: string }[] = [];
  const sent: { threadId: string; text: string }[] = [];
  const archived = new Set<string>();
  const s = { setting };
  const b = new BringIn({
    home: tmpDir('tb-bring-in-'),
    clock,
    log: nullLogger,
    setting: () => s.setting,
    start: (r) => {
      started.push(r);
      return `t${started.length}`;
    },
    open: (id) => !archived.has(id),
    send: (threadId, text) => sent.push({ threadId, text }),
  });
  return { b, clock, started, sent, archived, s };
}

function release(tag: string, changes = 3, important?: { commit: string; why: string }[]): UpstreamStatus {
  return { state: 'available', release: { tag, commit: 'c', changes, subjects: [], ...(important ? { important } : {}) } };
}

test('waits out the timer from the first look, then starts one thread', () => {
  const { b, clock, started } = rig(5);
  assert.equal(b.consider(release('release/2026-11-01')), 'waiting');
  clock.advance(4 * DAY);
  assert.equal(b.consider(release('release/2026-11-05')), 'waiting');
  clock.advance(1 * DAY);
  assert.equal(b.consider(release('release/2026-11-06')), 'started');
  assert.equal(started.length, 1);
  assert.equal(started[0].title, "Bring in Mike's release of 6 Nov");
  assert.match(started[0].text, /docs\/bringing-in-updates\.md/);
  assert.match(started[0].text, /every 5 days/);
  // The verified commit, not a ref name a later fetch could move (F31).
  assert.match(started[0].text, /merge its commit c /);
});

test('nothing waiting starts nothing, however long it has been', () => {
  const { b, clock, started } = rig(5);
  b.consider({ state: 'idle' });
  clock.advance(30 * DAY);
  assert.equal(b.consider({ state: 'idle' }), 'nothing');
  assert.equal(b.consider(release('release/2026-11-06', 0)), 'nothing');
  assert.equal(started.length, 0);
});

test('never a second thread while the first is open: a newer release goes to it, on the same timer', () => {
  const { b, clock, started, sent, archived } = rig(5);
  b.consider(release('release/2026-11-01'));
  clock.advance(5 * DAY);
  assert.equal(b.consider(release('release/2026-11-06')), 'started');
  // A newer one before the timer's up waits for it.
  assert.equal(b.consider(release('release/2026-11-07')), 'waiting');
  clock.advance(5 * DAY);
  assert.equal(b.consider(release('release/2026-11-11')), 'sent');
  assert.equal(started.length, 1);
  assert.deepEqual(sent.map((x) => x.threadId), ['t1']);
  assert.match(sent[0].text, /release\/2026-11-11/);
  assert.match(sent[0].text, /merge its commit c,/);
  // Already told it about this one: nothing more, however long.
  clock.advance(10 * DAY);
  assert.equal(b.consider(release('release/2026-11-11')), 'waiting');
  // Archived: the next one is a new thread.
  archived.add('t1');
  clock.advance(5 * DAY);
  assert.equal(b.consider(release('release/2026-11-13')), 'started');
  assert.equal(started.length, 2);
});

test('an important release goes straight away, once, unless it is off', () => {
  const { b, started, s } = rig(5);
  const imp = [{ commit: 'abc', why: 'keeps API keys out of Convex' }];
  assert.equal(b.consider(release('release/2026-11-06', 3, imp)), 'started');
  assert.equal(started[0].title, 'Important update from Mike (6 Nov)');
  assert.match(started[0].text, /keeps API keys out of Convex/);
  // Seen: the same important commit doesn't go again, even in a newer release.
  assert.equal(b.consider(release('release/2026-11-07', 4, imp)), 'waiting');
  s.setting = 'off';
  assert.equal(b.consider(release('release/2026-11-08', 5, [{ commit: 'def', why: 'another' }])), 'off');
});

test("'important' only ever starts one for an important release", () => {
  const { b, clock, started } = rig('important');
  b.consider(release('release/2026-11-01'));
  clock.advance(60 * DAY);
  assert.equal(b.consider(release('release/2026-12-30')), 'waiting');
  assert.equal(b.consider(release('release/2026-12-31', 3, [{ commit: 'x', why: 'data fix' }])), 'started');
  assert.match(started[0].text, /only starts these for releases Mike marks important/);
});

test("a Bring Them In thread someone started by hand counts as the open one", () => {
  const clock = new FakeClock();
  const started: string[] = [];
  const sent: string[] = [];
  const b = new BringIn({
    home: tmpDir('tb-bring-in-'), clock, log: nullLogger, setting: () => 5,
    start: () => { started.push('x'); return 'mine'; },
    open: (id) => id === 'theirs',
    send: (id) => sent.push(id),
    openByHand: () => 'theirs',
  });
  b.consider(release('release/2026-11-01'));
  clock.advance(5 * DAY);
  assert.equal(b.consider(release('release/2026-11-06')), 'sent');
  assert.deepEqual(sent, ['theirs']);
  assert.equal(started.length, 0);
});

test('parseBringIn and releaseDay', () => {
  assert.equal(parseBringIn(5), 5);
  assert.equal(parseBringIn('important'), 'important');
  assert.equal(parseBringIn('off'), 'off');
  for (const bad of [0, -1, 1.5, 400, 'weekly', null, undefined]) assert.equal(parseBringIn(bad), undefined, String(bad));
  assert.equal(releaseDay('release/2026-11-06'), '6 Nov');
});
