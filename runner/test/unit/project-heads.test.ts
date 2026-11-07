// The list of projects from small rows, and two reads that no longer take in
// what the caller doesn't need (convex/projectHeads.ts, phone.ts, sync.ts), run
// against the in-memory backend. Nothing here can measure bytes: what these
// tests pin is which rows each function touches and writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';
import { SHARED_USAGE_OTHERS_API_VERSION, sharedUsageArgs } from '../../src/sync.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'tbr_bruce';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';
const TOKEN = 'tb_phone';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: BRUCE, keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'phone', expiresAt: Date.now() + 100_000, createdAt: 1 });
  return b;
}

const project = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Project ${id}`,
  folders: ['/a'],
  goals: 'GOALS',
  state: 'STATE',
  notes: 'NOTES',
  createdBy: 'mike',
  archived: false,
  createdAt: 'c',
  updatedAt: 'u1',
  threadCount: 2,
  ...extra,
});
const heartbeat = (key: string, runnerId: string) => ({ key, runner: { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 0 } });

test('the list comes from small rows: no notes, goals, state or folders, and apps get the shape they always did', async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1'), project('p2', { archived: true })] });
  assert.equal(s.rows('projectHeads').length, 2);
  for (const head of s.rows('projectHeads')) {
    for (const big of ['notes', 'goals', 'state', 'folders']) assert.equal(head[big], undefined);
  }
  const list = (await call(s.ctx, phone.projects, { token: TOKEN })) as Record<string, any>[];
  assert.deepEqual(list.map((p) => p.id), ['p1']);
  assert.deepEqual([list[0]!.goals, list[0]!.state, list[0]!.notes, list[0]!.folders], ['', '', '', []]);
  assert.equal(list[0]!.title, 'Project p1');
  assert.equal(list[0]!.threadCount, 2);
  assert.deepEqual(((await call(s.ctx, phone.projects, { token: TOKEN, archived: true })) as any[]).map((p) => p.id).sort(), ['p1', 'p2']);
});

test('one project whole, for its page; a gone one is null', async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1')] });
  const p = (await call(s.ctx, phone.project, { token: TOKEN, runnerId: M5, id: 'p1' })) as Record<string, any>;
  assert.deepEqual([p.goals, p.state, p.notes, p.folders], ['GOALS', 'STATE', 'NOTES', ['/a']]);
  assert.equal(await call(s.ctx, phone.project, { token: TOKEN, runnerId: M5, id: 'nope' }), null);
  await assert.rejects(call(s.ctx, phone.project, { token: 'tb_wrong', runnerId: M5, id: 'p1' }));
});

test('editing notes, goals or state leaves the list row alone, so nobody watching the list re-runs', async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1')] });
  const before = s.rows('projectHeads')[0]!;
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: 'NEW', goals: 'NEW', state: 'NEW', updatedAt: 'u2' })], removed: [] });
  assert.equal(s.rows('projectHeads')[0], before);
  // Nor does a whole list saying the same thing.
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: 'NEWER', updatedAt: 'u3' })] });
  assert.equal(s.rows('projectHeads')[0]!._id, before._id);
  assert.equal(s.rows('projectHeads')[0], before);
  // A title, count or activity is what a list shows.
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { title: 'Renamed' })], removed: [] });
  assert.equal(s.rows('projectHeads')[0]!.title, 'Renamed');
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { title: 'Renamed', lastActivityAt: 'later', icon: { symbol: 'star', by: 'mike' } })], removed: [] });
  assert.equal(s.rows('projectHeads')[0]!.lastActivityAt, 'later');
  assert.equal(s.rows('projectHeads')[0]!.icon.symbol, 'star');
});

test('a project gone goes from the list, by upsert and by the whole list', async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1'), project('p2'), project('p3')] });
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [], removed: ['p1'] });
  assert.deepEqual(s.rows('projectHeads').map((h) => h.id).sort(), ['p2', 'p3']);
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p3')] });
  assert.deepEqual(s.rows('projectHeads').map((h) => h.id), ['p3']);
});

test('projects from before the table: all copied on the first heartbeat, an offline runner\'s too, once, and listed meanwhile', async () => {
  const s = await setup();
  await s.ctx.db.insert('projects', { ...project('old'), runnerId: M5 });
  await s.ctx.db.insert('projects', { ...project('offline'), runnerId: 'asleep000001' });
  // Until a heartbeat: still listed, from `projects`, in the list's shape.
  const before = (await call(s.ctx, phone.projects, { token: TOKEN })) as Record<string, any>[];
  assert.deepEqual(before.map((p) => p.id).sort(), ['offline', 'old']);
  assert.equal(before[0]!.notes, '');
  assert.equal(s.rows('projectHeads').length, 0);
  await call(s.ctx, sync.heartbeat, heartbeat(BRUCE_KEY, BRUCE));
  assert.deepEqual(s.rows('projectHeads').map((h) => h.id).sort(), ['offline', 'old']);
  assert.deepEqual(((await call(s.ctx, phone.projects, { token: TOKEN })) as any[]).map((p) => p.id).sort(), ['offline', 'old']);
  // Not read again: a row put in by hand isn't picked up by the next heartbeat.
  await s.ctx.db.insert('projects', { ...project('later'), runnerId: M5 });
  await call(s.ctx, sync.heartbeat, heartbeat(OWNER, M5));
  assert.equal(s.rows('projectHeads').some((h) => h.id === 'later'), false);
});

test("one runner's list doesn't touch another's", async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1')] });
  await call(s.ctx, sync.setProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: [project('p1')] });
  await call(s.ctx, sync.setProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: [] });
  assert.deepEqual(s.rows('projectHeads').map((h) => h.runnerId), [M5]);
});

const account = (id: string, email: string) => ({ id, provider: 'claude', title: id, email, usage: { windows: [], readAt: '2026-11-06T00:00:00.000Z', source: 'live' } });

test("sync:sharedUsage with the caller's runner id leaves its own rows out, and without one tells everyone's", async () => {
  const s = await setup();
  await call(s.ctx, sync.setAccounts, { key: OWNER, runnerId: M5, accounts: [account('a', 'one@x.com')] });
  await call(s.ctx, sync.setAccounts, { key: BRUCE_KEY, runnerId: BRUCE, accounts: [account('b', 'one@x.com'), account('c', 'other@x.com')] });
  // Which of Bruce's logins count is the owner's word (shared-usage-trust.test.ts).
  await call(s.ctx, sync.setRunnerLogins, { key: OWNER, runnerId: BRUCE, logins: [{ provider: 'claude', email: 'one@x.com' }, { provider: 'claude', email: 'other@x.com' }] });
  const of = (rows: unknown) => (rows as { runnerId?: string; email: string }[]).map((r) => `${r.runnerId ?? '?'}:${r.email}`).sort();
  // The owner: a runner key's rows are nobody's word (shared-usage-trust.test.ts).
  assert.deepEqual(of(await call(s.ctx, sync.sharedUsage, { key: OWNER, runnerId: M5 })), []);
  // A runner from before sends none, and is told about its own.
  assert.deepEqual(of(await call(s.ctx, sync.sharedUsage, { key: OWNER })), [`${M5}:one@x.com`]);
  // A runner key: never its own, whatever it sends, only the owner's readings of
  // its listed logins, and not whose they are.
  assert.deepEqual(of(await call(s.ctx, sync.sharedUsage, { key: BRUCE_KEY, runnerId: M5 })), ['?:one@x.com']);
  assert.deepEqual(of(await call(s.ctx, sync.sharedUsage, { key: BRUCE_KEY })), ['?:one@x.com']);
});

test('a runner sends its id only to a backend that takes it', () => {
  assert.deepEqual(sharedUsageArgs('k', 'r1', SHARED_USAGE_OTHERS_API_VERSION), { key: 'k', runnerId: 'r1' });
  assert.deepEqual(sharedUsageArgs('k', 'r1', SHARED_USAGE_OTHERS_API_VERSION - 1), { key: 'k' });
});

test("sync:schedules gives a runner key its own schedules and the owner everyone's", async () => {
  const s = await setup();
  const sched = (id: string, runnerId: string) => ({ runnerId, id, title: id, text: 't', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, owned: true });
  await s.ctx.db.insert('schedules', sched('m', M5));
  await s.ctx.db.insert('schedules', sched('b', BRUCE));
  await s.ctx.db.insert('schedules', { ...sched('mirrored', BRUCE), owned: undefined });
  const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id).sort();
  assert.deepEqual(ids(await call(s.ctx, sync.schedules, { key: BRUCE_KEY })), ['b']);
  assert.deepEqual(ids(await call(s.ctx, sync.schedules, { key: OWNER })), ['b', 'm']);
});

// ------------------------------------------------------------ sync:schedulesSince

const owned = (id: string, runnerId: string, extra: Record<string, unknown> = {}) => ({ id, runnerId, title: id, text: 'run this', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, ...extra });
const idsOf = (a: unknown) => (a as { rows: { id: string }[] }).rows.map((r) => r.id).sort();

test('schedulesSince: the whole table once, then only what was written since', async () => {
  const s = await setup();
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5) });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('b', M5) });
  // A row from before the stamp is in the whole read.
  await s.ctx.db.insert('schedules', { ...owned('old', M5), owned: true });
  // And a mirrored row isn't a schedule.
  await s.ctx.db.insert('schedules', { ...owned('mirror', M5), updatedMs: Date.now() });
  const first = (await call(s.ctx, sync.schedulesSince, { key: OWNER })) as { rows: any[]; at: number };
  assert.deepEqual(idsOf(first), ['a', 'b', 'old']);
  for (const r of first.rows) assert.equal(r.claim, undefined);
  const since = first.at + 10;
  assert.deepEqual(idsOf(await call(s.ctx, sync.schedulesSince, { key: OWNER, since })), []);
  await new Promise((r) => setTimeout(r, 15));
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5, { title: 'new' }) });
  const next = (await call(s.ctx, sync.schedulesSince, { key: OWNER, since })) as { rows: any[] };
  assert.deepEqual(next.rows.map((r) => [r.id, r.title]), [['a', 'new']]);
  assert.equal(typeof next.rows[0].updatedMs, 'number');
});

test('schedulesSince: a claim stamps nothing, a run and a requested run do', async () => {
  const s = await setup();
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5, { nextRunAt: '2026-01-01T00:00:00.000Z' }) });
  const stamp = () => s.rows('schedules').find((r) => r.id === 'a')!.updatedMs;
  const before = stamp();
  await new Promise((r) => setTimeout(r, 3));
  assert.equal(await call(s.ctx, sync.claimSchedule, { key: OWNER, runnerId: M5, scheduleId: 'a', holder: 'h', kind: 'due', expect: '2026-01-01T00:00:00.000Z' }), true);
  assert.equal(stamp(), before);
  await call(s.ctx, sync.releaseSchedule, { key: OWNER, scheduleId: 'a', holder: 'h' });
  assert.equal(stamp(), before);
  await call(s.ctx, sync.scheduleRan, { key: OWNER, scheduleId: 'a', holder: 'h', lastRun: { at: 'x', outcome: 'sent' }, sent: true, expectUpdatedAt: 'u' });
  const ran = stamp();
  assert.ok(ran > before);
  await new Promise((r) => setTimeout(r, 3));
  await call(s.ctx, sync.requestScheduleRun, { key: OWNER, scheduleId: 'a', at: 'now' });
  assert.ok(stamp() > ran);
});

test('schedulesSince: a schedule deleted or moved is heard of as gone, and an id that came back is a row', async () => {
  const s = await setup();
  const since = Date.now() - 1000;
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5) });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('b', M5) });
  assert.equal(await call(s.ctx, sync.deleteSchedule, { key: OWNER, scheduleId: 'a' }), true);
  let got = (await call(s.ctx, sync.schedulesSince, { key: OWNER, since })) as { rows: any[]; gone: string[] };
  assert.deepEqual([got.rows.map((r) => r.id), got.gone], [['b'], ['a']]);
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5) });
  got = (await call(s.ctx, sync.schedulesSince, { key: OWNER, since })) as { rows: any[]; gone: string[] };
  assert.deepEqual([idsOf(got), got.gone], [['a', 'b'], []]);
  // Moved off Bruce by the owner: Bruce follows only its own rows, so it's told.
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: { ...owned('11111111-1111-4111-8111-111111111111', BRUCE) } });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('11111111-1111-4111-8111-111111111111', M5) });
  got = (await call(s.ctx, sync.schedulesSince, { key: BRUCE_KEY, since })) as { rows: any[]; gone: string[] };
  assert.deepEqual([got.rows, got.gone], [[], ['11111111-1111-4111-8111-111111111111']]);
});

test("schedulesSince: a runner key hears only of its own, and can't read or learn of another's", async () => {
  const s = await setup();
  const since = Date.now() - 1000;
  const mine = '22222222-2222-4222-8222-222222222222';
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('secret-m5', M5) });
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: owned(mine, BRUCE) });
  await call(s.ctx, sync.deleteSchedule, { key: OWNER, scheduleId: 'secret-m5' });
  assert.deepEqual(idsOf(await call(s.ctx, sync.schedulesSince, { key: BRUCE_KEY })), [mine]);
  const got = (await call(s.ctx, sync.schedulesSince, { key: BRUCE_KEY, since })) as { rows: any[]; gone: string[] };
  assert.deepEqual([idsOf(got), got.gone], [[mine], []]);
});

test('schedulesSince: one the audit takes out is heard of as gone', async () => {
  const s = await setup();
  const since = Date.now() - 1000;
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5) });
  const { rows } = (await call(s.ctx, sync.audit, { key: OWNER, section: 'schedules' })) as { rows: { kind: string; id: string; version: string }[] };
  assert.equal(await call(s.ctx, sync.auditRemove, { key: OWNER, rows: rows.map((r) => ({ kind: r.kind, id: r.id, version: r.version })) }), 1);
  assert.deepEqual(((await call(s.ctx, sync.schedulesSince, { key: OWNER, since })) as { gone: string[] }).gone, ['a']);
});

test('schedulesSince: from too long ago, says to read it whole again', async () => {
  const s = await setup();
  const got = (await call(s.ctx, sync.schedulesSince, { key: OWNER, since: Date.now() - 13 * 3_600_000 })) as { more?: boolean };
  assert.equal(got.more, true);
});

test('the older queries still answer with what their validators allow', async () => {
  const s = await setup();
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: owned('a', M5) });
  const [row] = (await call(s.ctx, sync.schedules, { key: OWNER })) as Record<string, unknown>[];
  assert.equal('updatedMs' in row!, false);
  await s.ctx.db.insert('tokens', { hash: await sha256('tb_two'), name: 'p2', expiresAt: Date.now() + 100_000, createdAt: 1 });
  const [phoneRow] = (await call(s.ctx, phone.schedules, { token: 'tb_two' })) as Record<string, unknown>[];
  assert.equal('updatedMs' in phoneRow!, false);
});

// API 50: notes in a row of their own, so the rest of a project changing
// doesn't rewrite them (convex/projectNotes.ts).
test('notes live apart: the project row holds none, and a change without notes leaves them alone', async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1'), project('p2', { notes: '' })] });
  assert.deepEqual(s.rows('projects').map((p) => p.notes), ['', '']);
  assert.deepEqual(s.rows('projectNotes').map((n) => [n.id, n.notes]), [['p1', 'NOTES']]);
  const notesRow = s.rows('projectNotes')[0]!;
  const { notes: _n, ...noNotes } = project('p1', { state: 'NEW STATE', updatedAt: 'u2' });
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [noNotes], removed: [] });
  assert.equal(s.rows('projectNotes')[0], notesRow);
  const p = (await call(s.ctx, phone.project, { token: TOKEN, runnerId: M5, id: 'p1' })) as Record<string, any>;
  assert.deepEqual([p.state, p.notes], ['NEW STATE', 'NOTES']);
  // Notes given are written, and the same list again writes nothing.
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: 'EDITED' })], removed: [] });
  assert.equal(s.rows('projectNotes')[0]!.notes, 'EDITED');
  const edited = s.rows('projectNotes')[0]!;
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: 'EDITED' }), project('p2', { notes: '' })] });
  assert.equal(s.rows('projectNotes')[0], edited);
  // Emptied, or the project gone: the row goes.
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: '' })], removed: [] });
  assert.equal(s.rows('projectNotes').length, 0);
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: 'BACK' })], removed: [] });
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [], removed: ['p1'] });
  assert.equal(s.rows('projectNotes').length, 0);
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p3', { notes: 'THREE' })] });
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [] });
  assert.equal(s.rows('projectNotes').length, 0);
});

test('a row from before keeps showing its notes, and they move out the first time it is written without them', async () => {
  const s = await setup();
  await s.ctx.db.insert('projects', { ...project('old', { notes: 'OLD NOTES' }), runnerId: M5 });
  const read = async () => ((await call(s.ctx, phone.project, { token: TOKEN, runnerId: M5, id: 'old' })) as Record<string, any>).notes;
  assert.equal(await read(), 'OLD NOTES');
  const { notes: _n, ...noNotes } = project('old', { state: 'MOVED ON' });
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: M5, projects: [noNotes], removed: [] });
  assert.equal(s.rows('projects')[0]!.notes, '');
  assert.deepEqual(s.rows('projectNotes').map((n) => n.notes), ['OLD NOTES']);
  assert.equal(await read(), 'OLD NOTES');
});

test("one runner's notes are its own", async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: M5, projects: [project('p1', { notes: 'MINE' })] });
  await call(s.ctx, sync.setProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: [project('p1', { notes: 'BRUCE' })] });
  await call(s.ctx, sync.setProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: [] });
  assert.deepEqual(s.rows('projectNotes').map((n) => [n.runnerId, n.notes]), [[M5, 'MINE']]);
  const p = (await call(s.ctx, phone.project, { token: TOKEN, runnerId: M5, id: 'p1' })) as Record<string, any>;
  assert.equal(p.notes, 'MINE');
});
