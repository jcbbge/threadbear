// node --test web/src/sections.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archived, archiveShown, build, clampWidth, hibernating, isFiltering, matches, neighbour, NO_FILTER, passes, placeChoices, readFolded, readOrder, readWidth, shows, SIDEBAR_DEFAULT, SIDEBAR_MIN, urgency, wakeLine, wakesOf, type ThreadRow } from './sections.ts';

const NOW = Date.parse('2026-11-05T10:00:00Z');
let n = 0;
const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({ threadId: `t${++n}`, title: 'A thread', preview: '', cwd: '/Users/me/dev/acme', status: 'idle', needsYou: false, unread: false, lastActivityMs: NOW - 1000 * n, ...over });
const ids = (rows: ThreadRow[]) => rows.map((r) => r.threadId);
const none = new Map<string, number>();

test('each thread goes in the heading the Mac puts it under', () => {
  const asks = row({ needs: 'you', asks: [{ ticked: false }] });
  const answer = row({ status: 'waiting', working: 'a job' });
  const busy = row({ status: 'running' });
  const background = row({ working: 'sub-agents' });
  const plain = row();
  const star = row({ starredAt: '2026-11-01T00:00:00Z', status: 'running' });
  const starAsleep = row({ starredAt: '2026-11-02T00:00:00Z', snoozedUntilRestart: true });
  const asleep = row({ snoozedUntil: '2026-11-06T00:00:00Z' });
  const gone = row({ archivedAt: '2026-11-01T00:00:00Z' });
  const s = build([asks, answer, busy, background, plain, star, starAsleep, asleep, gone], NOW, none, 'needsYou');
  assert.deepEqual(ids(s.starred), ids([star, starAsleep]));
  assert.deepEqual(new Set(ids(s.inbox)), new Set(ids([asks, answer, plain])));
  assert.deepEqual(new Set(ids(s.running)), new Set(ids([busy, background])));
  assert.deepEqual(s.scheduled, []);
});

test('a snooze that has passed is back in the inbox', () => {
  const r = row({ snoozedUntil: '2026-11-05T09:00:00Z' });
  assert.deepEqual(ids(build([r], NOW, none, 'needsYou').inbox), [r.threadId]);
});

test('idle with a schedule due goes under Hibernating, unless it wants Mike', () => {
  const idle = row();
  const wanting = row({ needs: 'you' });
  const wakes = wakesOf([
    { threadId: idle.threadId, nextRunAt: '2026-11-05T11:00:00Z' },
    { threadId: wanting.threadId, nextRunAt: '2026-11-05T11:00:00Z' },
  ]);
  const s = build([idle, wanting], NOW, wakes, 'needsYou');
  assert.deepEqual(ids(s.scheduled), [idle.threadId]);
  assert.deepEqual(ids(s.inbox), [wanting.threadId]);
});

test('paused and finished schedules wake nothing, and the soonest counts', () => {
  const wakes = wakesOf([
    { threadId: 'a', nextRunAt: '2026-11-05T11:00:00Z', paused: true },
    { threadId: 'b', nextRunAt: '2026-11-05T11:00:00Z', finishedAt: '2026-11-05T00:00:00Z' },
    { threadId: 'c', nextRunAt: '2026-11-05T12:00:00Z' },
    { threadId: 'c', nextRunAt: '2026-11-05T11:00:00Z' },
    { nextRunAt: '2026-11-05T11:00:00Z' },
  ]);
  assert.deepEqual([...wakes.keys()], ['c']);
  assert.equal(wakes.get('c'), Date.parse('2026-11-05T11:00:00Z'));
});

test('Hibernating is soonest to wake first, back on restart last, each once', () => {
  const scheduled = row();
  const soon = row({ snoozedUntil: '2026-11-05T10:30:00Z' });
  const restart = row({ snoozedUntilRestart: true });
  const wakes = new Map([[scheduled.threadId, Date.parse('2026-11-05T11:00:00Z')]]);
  assert.deepEqual(ids(hibernating([scheduled], [restart, soon, scheduled], wakes)), ids([soon, scheduled, restart]));
});

test('the inbox sorts by what needs Mike, newest or oldest', () => {
  const old = row({ lastActivityMs: NOW - 5000 });
  const failedRead = row({ status: 'error', lastActivityMs: NOW - 4000 });
  const unread = row({ unread: true, lastActivityMs: NOW - 3000 });
  const asked = row({ status: 'waiting', lastActivityMs: NOW - 2000 });
  const fresh = row({ lastActivityMs: NOW - 1000 });
  const all = [old, failedRead, unread, asked, fresh];
  assert.deepEqual(ids(build(all, NOW, none, 'needsYou').inbox), ids([asked, unread, failedRead, fresh, old]));
  assert.deepEqual(ids(build(all, NOW, none, 'newest').inbox), ids([fresh, asked, unread, failedRead, old]));
  assert.deepEqual(ids(build(all, NOW, none, 'oldest').inbox), ids([old, failedRead, unread, asked, fresh]));
});

test('urgency: a failure that is unread outranks a plain unread', () => {
  assert.equal(urgency(row({ unread: true, status: 'error' })), 1);
  assert.equal(urgency(row({ unread: true })), 2);
  assert.equal(urgency(row({ status: 'stopped' })), 3);
  assert.equal(urgency(row()), 4);
});

test('stars stay in the order they were starred', () => {
  const second = row({ starredAt: '2026-11-02T00:00:00Z', lastActivityMs: NOW });
  const first = row({ starredAt: '2026-11-01T00:00:00Z', lastActivityMs: NOW - 9000 });
  assert.deepEqual(ids(build([second, first], NOW, none, 'needsYou').starred), ids([first, second]));
});

test('archived threads go most recently archived first', () => {
  const a = row({ archivedAt: '2026-11-01T00:00:00Z' });
  const b = row({ archivedAt: '2026-11-03T00:00:00Z' });
  assert.deepEqual(ids(archived([a, b])), ids([b, a]));
});

test('search looks in the title, last reply and place, ignoring case and accents', () => {
  const r = row({ title: 'Fix the Café menu', preview: 'Landed the change', projects: [{ id: 'p', title: 'Lets Build It' }] });
  assert.ok(matches(r, 'cafe'));
  assert.ok(matches(r, '  LANDED '));
  assert.ok(matches(r, 'build'));
  assert.ok(matches(r, ''));
  assert.ok(!matches(r, 'acme'), 'a thread in a project is known by the project, not its folder');
  assert.ok(matches(row({ cwd: '/Users/me/dev/acme/' }), 'acme'));
  assert.ok(!matches(r, 'nothing like it'));
});

test('filters pick out what needs Mike, unread, shared, and a place', () => {
  const asked = row({ needs: 'you' });
  const question = row({ status: 'waiting' });
  const unread = row({ unread: true });
  const shared = row({ share: { access: 'link' } });
  const stopped = row({ share: { access: 'none' } });
  const inProject = row({ projects: [{ id: 'p', title: 'Poddle' }] });
  const all = [asked, question, unread, shared, stopped, inProject];
  const of = (f: Parameters<typeof passes>[1]) => ids(all.filter((r) => passes(r, f)));
  assert.deepEqual(of(NO_FILTER), ids(all));
  assert.deepEqual(of({ show: 'needsYou' }), ids([asked, question]));
  assert.deepEqual(of({ show: 'unread' }), ids([unread]));
  assert.deepEqual(of({ show: 'shared' }), ids([shared]));
  assert.deepEqual(of({ show: 'all', place: 'Poddle' }), ids([inProject]));
  assert.deepEqual(of({ show: 'unread', place: 'acme' }), ids([unread]));
  assert.ok(!isFiltering(NO_FILTER));
  assert.ok(isFiltering({ show: 'all', place: 'Poddle' }));
});

test('a thread put away never needs Mike or counts as unread', () => {
  const gone = row({ archivedAt: '2026-11-01T00:00:00Z', needs: 'you', needsYou: true, unread: true });
  const asleep = row({ snoozedUntil: '2026-11-06T00:00:00Z', needsYou: true, unread: true });
  const woken = row({ snoozedUntil: '2026-11-05T09:00:00Z', needsYou: true, unread: true });
  for (const show of ['needsYou', 'unread'] as const) {
    assert.ok(!passes(gone, { show }, NOW), show);
    assert.ok(!passes(asleep, { show }, NOW), show);
    assert.ok(passes(woken, { show }, NOW), show);
  }
  assert.ok(passes(gone, { show: 'all', place: 'acme' }, NOW), 'a project filter still reaches them');
});

test('the open thread stays under a status filter, but not a search or another place', () => {
  const read = row({ title: 'Read now', projects: [{ id: 'p', title: 'Poddle' }] });
  assert.ok(!shows(read, '', { show: 'unread' }));
  assert.ok(shows(read, '', { show: 'unread' }, read.threadId));
  assert.ok(!shows(read, 'something else', { show: 'unread' }, read.threadId));
  assert.ok(!shows(read, '', { show: 'all', place: 'acme' }, read.threadId));
});

test('place choices count each thread once, most threads first', () => {
  const dupe = row({ projects: [{ id: 'p', title: 'Poddle' }] });
  const choices = placeChoices([dupe, dupe, row({ projects: [{ id: 'p', title: 'Poddle' }] }), row({ cwd: '/x/acme' })]);
  assert.deepEqual(choices, [
    { place: 'Poddle', count: 2 },
    { place: 'acme', count: 1 },
  ]);
});

test('the archive shows a few, more on asking, every match while narrowing, and the open thread', () => {
  const rows = Array.from({ length: 30 }, () => row());
  assert.deepEqual([archiveShown(rows, 20, false).rows.length, archiveShown(rows, 20, false).more], [20, 10]);
  assert.deepEqual([archiveShown(rows, 70, false).rows.length, archiveShown(rows, 70, false).more], [30, 0]);
  assert.deepEqual([archiveShown(rows, 20, true).rows.length, archiveShown(rows, 20, true).more], [30, 0]);
  assert.equal(archiveShown(rows, 20, false, rows[24]!.threadId).rows.length, 25);
});

test('the arrow keys walk the drawn rows and stop at the ends', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(neighbour(order, 'b', 1), 'c');
  assert.equal(neighbour(order, 'b', -1), 'a');
  assert.equal(neighbour(order, 'c', 1), undefined);
  assert.equal(neighbour(order, 'a', -1), undefined);
  assert.equal(neighbour(order, undefined, 1), 'a');
  assert.equal(neighbour(order, undefined, -1), 'c');
  assert.equal(neighbour(order, 'gone', 1), 'a');
});

test('folds start as the Mac does and survive a bad saved value', () => {
  assert.deepEqual([...readFolded(null)], ['hibernating', 'archived']);
  assert.deepEqual([...readFolded('not json')], ['hibernating', 'archived']);
  assert.deepEqual([...readFolded('[]')], []);
  assert.deepEqual([...readFolded('["inbox","nonsense"]')], ['inbox']);
});

test('the sort order falls back to needs you first', () => {
  assert.equal(readOrder(null), 'needsYou');
  assert.equal(readOrder('oldest'), 'oldest');
  assert.equal(readOrder('sideways'), 'needsYou');
});

test('the sidebar stays between its limits and leaves the thread room', () => {
  assert.equal(clampWidth(100, 1600), SIDEBAR_MIN);
  assert.equal(clampWidth(350.4, 1600), 350);
  assert.equal(clampWidth(5000, 2560), 600);
  assert.equal(clampWidth(5000, 900), 436);
  assert.equal(clampWidth(5000, 500), SIDEBAR_MIN);
  assert.equal(readWidth(null), SIDEBAR_DEFAULT);
  assert.equal(readWidth('banana'), SIDEBAR_DEFAULT);
  assert.equal(readWidth('410'), 410);
});

test('a hibernating row that waits for more than a time says so first', () => {
  const now = Date.parse('2026-11-05T09:00:00Z');
  const r = row({ snoozedUntil: '2026-11-06T09:00:00Z', wakeNote: '"Convex I/O" finishes' });
  assert.equal(wakeLine(r, ['misc'], now), 'Until "Convex I/O" finishes · misc');
  assert.equal(wakeLine(row({ snoozedUntil: '2026-11-06T09:00:00Z' }), ['misc'], now), undefined);
  // Awake again: the note is stale.
  assert.equal(wakeLine(row({ wakeNote: 'the runner updates' }), ['misc'], now), undefined);
});
