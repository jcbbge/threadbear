// What a runner key or a phone token can make the backend keep, and what it
// costs to clean up (Daybreak, 7 Nov 2026): picture rows, phone uploads,
// commands, pages, phone registrations. Each test plays the write-up's
// attack against the backend's own functions in the in-memory database
// (test/helpers/convex-memory.ts), which counts the bytes a call reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'tbr_bruce';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';
const TOKEN = 'phone-token';
const OTHER_TOKEN = 'other-phone';
const DAY = 24 * 60 * 60_000;
// Convex's most a mutation or query may read.
const READ_LIMIT = 16 * 1024 * 1024;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const share = load('share');
const relay = load('relay');
const tokens = load('tokens');
const devices = load('devices');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: BRUCE, keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  const now = Date.now();
  const tokenId = await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  const otherId = await b.ctx.db.insert('tokens', { hash: await sha256(OTHER_TOKEN), name: 'web', kind: 'browser', expiresAt: now + 100 * DAY, createdAt: now });
  // A backend whose rows from before the limits have been seen to (limitsMigration); its own tests start without.
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  for (const [runnerId, byOwner] of [[M5, true], [BRUCE, false]] as const) {
    await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: now, ...(byOwner ? { byOwner } : {}) });
  }
  return { ...b, tokenId, otherId };
}
type S = Awaited<ReturnType<typeof setup>>;

const thread = (threadId: string, runnerId: string) => ({ threadId, runnerId, title: 'T', view: 'inbox', needsYou: false });

// A file uploaded the way a runner key's runner does (/runner/upload).
async function runnerUpload(s: S, id: string, bytes = 1): Promise<string> {
  const ticket = new URL(await call(s.ctx, sync.iconUploadUrl, { key: BRUCE_KEY })).searchParams.get('ticket')!;
  assert.equal(await call(s.ctx, sync.redeemUpload, { ticket, storageId: s.file(id), bytes }), true);
  return id;
}

// A photo uploaded the way the phone does now (/phone/upload).
async function phoneUpload(s: S, id: string, token = TOKEN, bytes = 1): Promise<string> {
  const url = new URL(await call(s.ctx, phone.imageUploadUrl, { token }));
  assert.equal(url.origin + url.pathname, 'https://site.example/phone/upload');
  assert.equal(await call(s.ctx, phone.redeemPhoneUpload, { ticket: url.searchParams.get('ticket'), storageId: s.file(id), bytes }), true);
  return id;
}

async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// Runs pruneFiles until it stops rescheduling itself, each run under Convex's read limit.
async function pruneFilesUntilDone(s: S): Promise<number> {
  for (let runs = 1; runs <= 100; runs++) {
    s.scheduled.length = 0;
    s.resetReads();
    await call(s.ctx, sync.pruneFiles, {});
    assert.ok(s.bytesRead() < READ_LIMIT, `run ${runs} read ${s.bytesRead()} bytes`);
    if (!s.scheduled.some((x: any) => /pruneFiles/.test(x.fn))) return runs;
  }
  throw new Error('pruneFiles never finished');
}

// A backend from before the limits: no marks, so the first heartbeat starts
// limitsMigration. Runs it to the end, each step under the read limit.
async function unmigrated(s: S) {
  for (const m of s.rows('backendMarks').filter((r) => r.name.startsWith('limits-'))) await s.ctx.db.delete(m._id);
}
async function migrate(s: S): Promise<void> {
  await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: M5, name: 'm5', version: 'v', startedAt: 'x', draining: false, threadCount: 1 } });
  for (let runs = 0; runs < 2000; runs++) {
    const i = s.scheduled.findIndex((x: any) => /limitsMigration/.test(x.fn));
    if (i < 0) {
      assert.ok(s.rows('backendMarks').some((m) => m.name === 'limits-2026-11-07-done'), 'the migration finished');
      return;
    }
    const [next] = s.scheduled.splice(i, 1) as { args: Record<string, unknown> }[];
    s.resetReads();
    await call(s.ctx, sync.limitsMigration, next!.args);
    assert.ok(s.bytesRead() < READ_LIMIT, `migration read ${s.bytesRead()}`);
  }
  throw new Error('limitsMigration never finished');
}

// A `picture` command from the phone, taken by Bruce, as the runner has it when it uploads.
async function askForPicture(s: S, threadId: string, seq: number, index = 0) {
  const commandId = await call(s.ctx, phone.requestPicture, { token: TOKEN, threadId, seq, index });
  assert.equal(await call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId }), true);
  return commandId;
}

const held = (s: S, args: Record<string, unknown>) => call(s.ctx, sync.addHeldPicture, { key: BRUCE_KEY, threadId: 'B', seq: 1, index: 0, mediaType: 'image/png', ...args });

// ------------------------------------------------------------ held pictures

test("Daybreak's held-picture PoC: one small upload can't become 20 MB of rows", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const file = await runnerUpload(s, 'one-byte');
  const big = 'x'.repeat(512 * 1024);
  const kinds: string[] = [];
  for (let seq = 1; seq <= 40; seq++) kinds.push(await outcome(held(s, { seq, storageId: file, mediaType: big })));
  assert.deepEqual([...new Set(kinds)], ['badArgs']);
  assert.equal(s.rows('heldPictures').length, 0);
});

test('a runner key holds a picture only when asked, of a type it sends, one row per upload', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const file = await runnerUpload(s, 'pic');
  // Nobody asked for it.
  assert.equal(await outcome(held(s, { seq: 1, storageId: file })), 'forbidden');
  // Asked for, with a good type: kept. A retry of the same row is fine.
  await askForPicture(s, 'B', 1);
  assert.equal(await outcome(held(s, { seq: 1, storageId: file })), 'ok');
  assert.equal(await outcome(held(s, { seq: 1, storageId: file })), 'ok');
  assert.equal(s.rows('heldPictures').length, 1);
  // The same upload for another picture someone asked for: one file, one row.
  await askForPicture(s, 'B', 2);
  assert.equal(await outcome(held(s, { seq: 2, storageId: file })), 'forbidden');
  // Types and numbers it never sends.
  const other = await runnerUpload(s, 'pic2');
  for (const bad of [{ mediaType: 'text/html' }, { mediaType: 'image/png'.padEnd(200, ' ') }, { width: Number.NaN }, { height: 1e12 }, { index: 101 }, { seq: -1 }, { seq: Number.POSITIVE_INFINITY }]) {
    assert.equal(await outcome(held(s, { seq: 2, storageId: other, ...bad })), 'badArgs', JSON.stringify(bad));
  }
  assert.equal(await outcome(held(s, { seq: 2, storageId: other })), 'ok');
  assert.equal(s.rows('heldPictures').length, 2);
});

test("reply and share pictures from a runner key: capped paths, real types, one row per upload", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const file = await runnerUpload(s, 'f');
  const reply = (args: Record<string, unknown>) => call(s.ctx, sync.addReplyImage, { key: BRUCE_KEY, threadId: 'B', seq: 1, path: 'a.png', storageId: file, mediaType: 'image/png', ...args });
  const shared = (args: Record<string, unknown>) => call(s.ctx, sync.addShareImage, { key: BRUCE_KEY, threadId: 'B', seq: 1, path: 'a.png', storageId: file, mediaType: 'image/png', ...args });
  assert.equal(await outcome(reply({ path: 'p'.repeat(512 * 1024) })), 'badArgs');
  assert.equal(await outcome(reply({ src: 's'.repeat(512 * 1024) })), 'badArgs');
  assert.equal(await outcome(shared({ mediaType: 'm'.repeat(512 * 1024) })), 'badArgs');
  assert.equal(await outcome(reply({})), 'ok');
  // The same upload again under new seqs, in either table.
  for (let seq = 2; seq < 6; seq++) assert.equal(await outcome(reply({ seq })), 'forbidden');
  assert.equal(await outcome(shared({ seq: 9 })), 'forbidden');
  assert.equal(s.rows('replyImages').length + s.rows('shareImages').length, 1);
  // The owner's runner is trusted with its own rows, as before.
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('O', M5)] });
  const mine = s.file('owner-file');
  await call(s.ctx, sync.addReplyImage, { key: OWNER, threadId: 'O', seq: 1, path: 'x.heic', storageId: mine, mediaType: 'image/heic' });
  assert.equal(s.rows('replyImages').length, 2);
});

test('cleanup of many oversized held pictures sharing one file stays under the read limit, even with one expired', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const file = await runnerUpload(s, 'shared');
  // Rows from before the caps (written straight to the table), 40 x 512 KiB on one file.
  const big = 'x'.repeat(512 * 1024);
  const old = Date.now() - 2 * DAY;
  await s.ctx.db.insert('heldPictures', { threadId: 'B', seq: 1, index: 0, storageId: file, mediaType: big, at: old });
  for (let seq = 2; seq <= 40; seq++) await s.ctx.db.insert('heldPictures', { threadId: 'B', seq, index: 0, storageId: file, mediaType: big, at: Date.now() });
  // Cleanup waits for the migration, which cuts them down.
  await unmigrated(s);
  s.resetReads();
  await call(s.ctx, sync.pruneFiles, {});
  assert.equal(s.rows('heldPictures').length, 40, 'nothing before the migration');
  await migrate(s);
  assert.ok(s.rows('heldPictures').every((r) => r.mediaType.length <= 100));
  await pruneFilesUntilDone(s);
  assert.equal(s.rows('heldPictures').length, 39, 'the expired one went');
  assert.equal(s.hasFile(file), true, 'the others still name the file');
  // All of them expired: they go over a few runs, and the file with the last.
  await later(2 * DAY, () => pruneFilesUntilDone(s));
  assert.equal(s.rows('heldPictures').length, 0);
  assert.equal(s.hasFile(file), false);
});

test('a file in a waiting command is found without reading every waiting command', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('T', M5)] });
  // Lots waiting for another runner, each carrying a big message.
  for (let i = 0; i < 30; i++) await s.ctx.db.insert('commands', { runnerId: BRUCE, kind: 'create', args: { text: 'w'.repeat(600 * 1024) }, state: 'pending', createdAt: Date.now() });
  // A photo in two messages, as phone.ts queue records them.
  const photo = s.file('photo');
  const send = async () => {
    const commandId = await s.ctx.db.insert('commands', { runnerId: M5, threadId: 'T', kind: 'send', args: { text: 'look', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: Date.now() });
    await s.ctx.db.insert('commandFiles', { storageId: photo, commandId });
    return commandId;
  };
  const first = await send();
  const second = await send();
  for (const [commandId, left] of [[first, true], [second, false]] as const) {
    assert.equal(await call(s.ctx, sync.takeCommand, { key: OWNER, commandId }), true);
    s.resetReads();
    await call(s.ctx, sync.finishCommand, { key: OWNER, commandId, ok: true });
    assert.ok(s.bytesRead() < 1024 * 1024, `finishing read ${s.bytesRead()} bytes`);
    assert.equal(s.hasFile(photo), left, left ? 'still on its way in the other' : 'gone once nothing names it');
  }
});

// ------------------------------------------------------------ phone uploads

test('phone uploads go through a ticket of its own, with an hourly and daily allowance', async () => {
  const s = await setup();
  const url = new URL(await call(s.ctx, phone.imageUploadUrl, { token: TOKEN }));
  assert.equal(url.pathname, '/phone/upload', 'not a raw Convex upload URL');
  const ticket = url.searchParams.get('ticket')!;
  assert.equal(await call(s.ctx, phone.phoneTicketOk, { ticket }), true);
  // Too big; then spent.
  assert.equal(await call(s.ctx, phone.redeemPhoneUpload, { ticket, storageId: s.file('huge'), bytes: 11 * 1024 * 1024 }), false);
  assert.equal(await call(s.ctx, phone.phoneTicketOk, { ticket }), false);
  // An hour's worth, then no more URLs.
  let refused = 'ok';
  let n = 1;
  for (; n < 200 && refused === 'ok'; n++) refused = await outcome(call(s.ctx, phone.imageUploadUrl, { token: TOKEN }));
  assert.equal(refused, 'rateLimited');
  assert.ok(n <= 62, `stopped after ${n}`);
  // The day's bytes, from another token's tickets spread over hours.
  const s2 = await setup();
  let later429 = false;
  for (let i = 0; i < 40 && !later429; i++) {
    const t = new URL(await later(i * 60 * 60_000 / 2, () => call(s2.ctx, phone.imageUploadUrl, { token: OTHER_TOKEN }))).searchParams.get('ticket');
    later429 = (await later(i * 60 * 60_000 / 2, () => call(s2.ctx, phone.redeemPhoneUpload, { ticket: t, storageId: s2.file(`p${i}`), bytes: 9 * 1024 * 1024 }))) === 'later';
  }
  assert.ok(later429, 'over the day it answers later');
});

test("a revoked phone's ticket stores nothing", async () => {
  const s = await setup();
  const ticket = new URL(await call(s.ctx, phone.imageUploadUrl, { token: TOKEN })).searchParams.get('ticket');
  await call(s.ctx, sync.revokeToken, { key: OWNER, id: s.tokenId });
  assert.equal(await call(s.ctx, phone.phoneTicketOk, { ticket }), false);
  assert.equal(await call(s.ctx, phone.redeemPhoneUpload, { ticket, storageId: s.file('late'), bytes: 1 }), false);
});

test("a photo picked and never sent goes after a day; one in a waiting message stays until it's taken", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('T', M5)] });
  const orphan = await phoneUpload(s, 'orphan');
  const sent = await phoneUpload(s, 'sent');
  const commandId = await call(s.ctx, phone.send, { token: TOKEN, threadId: 'T', text: 'x', images: [sent] });
  await later(DAY + 60_000, () => pruneFilesUntilDone(s));
  assert.equal(s.hasFile(orphan), false);
  assert.equal(s.hasFile(sent), true);
  assert.equal(s.rows('phoneUploads').length, 0, 'the records go after a day');
  await call(s.ctx, sync.takeCommand, { key: OWNER, commandId });
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId, ok: true });
  assert.equal(s.hasFile(sent), false);
});

test("discardImage deletes only this phone's own unsent uploads", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('O', M5)] });
  // Bruce's share picture, the owner's reply picture and project icon, a held
  // picture, a runner key's upload not yet attached, another token's photo,
  // and a file with no record at all.
  const shareFile = await runnerUpload(s, 'share');
  await call(s.ctx, sync.addShareImage, { key: BRUCE_KEY, threadId: 'B', seq: 1, path: 'a.png', storageId: shareFile, mediaType: 'image/png' });
  const replyFile = s.file('reply');
  await call(s.ctx, sync.addReplyImage, { key: OWNER, threadId: 'O', seq: 1, path: 'r.png', storageId: replyFile, mediaType: 'image/png' });
  const loose = await runnerUpload(s, 'loose');
  const bare = s.file('bare');
  const kept = async (storageId: string) => {
    assert.equal(await outcome(call(s.ctx, phone.discardImage, { token: TOKEN, storageId })), 'ok');
    assert.equal(s.hasFile(storageId), true, storageId);
  };
  for (const storageId of [shareFile, replyFile, loose, bare]) await kept(storageId);
  await kept(await phoneUpload(s, 'theirs', OTHER_TOKEN));
  // Its own unsent photo goes.
  const mine = await phoneUpload(s, 'mine');
  await call(s.ctx, phone.discardImage, { token: TOKEN, storageId: mine });
  assert.equal(s.hasFile(mine), false);
});

test("a phone's message can carry only that phone's own uploads", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const shareFile = await runnerUpload(s, 'share');
  await call(s.ctx, sync.addShareImage, { key: BRUCE_KEY, threadId: 'B', seq: 1, path: 'a.png', storageId: shareFile, mediaType: 'image/png' });
  const refused = async (storageId: string) => assert.equal(await outcome(call(s.ctx, phone.send, { token: TOKEN, threadId: 'B', text: 'x', images: [storageId] })), 'notFound', storageId);
  for (const storageId of [shareFile, s.file('bare')]) await refused(storageId);
  await refused(await phoneUpload(s, 'theirs', OTHER_TOKEN));
  const mine = await phoneUpload(s, 'mine');
  assert.equal(await outcome(call(s.ctx, phone.send, { token: TOKEN, threadId: 'B', text: 'x', images: [mine] })), 'ok');
  assert.equal(s.rows('commandFiles').length, 1);
});

// ------------------------------------------------------------ commands

test("a phone can't queue commands for a runner that doesn't exist", async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, phone.create, { token: TOKEN, text: 'x', runnerId: 'fake-runner-1' })), 'notFound');
  assert.equal(await outcome(call(s.ctx, phone.quickAsk, { token: TOKEN, question: 'q', answer: 'a', askedAt: 1, runnerId: 'fake-runner-2' })), 'notFound');
  assert.equal(s.rows('commands').length, 0);
  // Real ones, and "any", still go.
  assert.equal(await outcome(call(s.ctx, phone.create, { token: TOKEN, text: 'x', runnerId: BRUCE })), 'ok');
  assert.equal(await outcome(call(s.ctx, phone.create, { token: TOKEN, text: 'x', runnerId: 'any' })), 'ok');
  assert.equal(await outcome(call(s.ctx, phone.create, { token: TOKEN, text: 'x' })), 'ok');
});

test('what waits for one runner is capped, in number and in bytes', async () => {
  const s = await setup();
  let refused = 'ok';
  let n = 0;
  for (; n < 300 && refused === 'ok'; n++) refused = await outcome(call(s.ctx, phone.create, { token: TOKEN, text: 'x', runnerId: BRUCE }));
  assert.equal(refused, 'tooMany');
  assert.ok(n <= 201, `stopped after ${n}`);
  // Another runner isn't held up by Bruce's.
  assert.equal(await outcome(call(s.ctx, phone.create, { token: TOKEN, text: 'x', runnerId: M5 })), 'ok');
  // Big ones stop sooner, and checking reads no more than the cap.
  const s2 = await setup();
  refused = 'ok';
  for (n = 0; n < 100 && refused === 'ok'; n++) refused = await outcome(call(s2.ctx, phone.create, { token: TOKEN, text: 'y'.repeat(700 * 1024), runnerId: BRUCE }));
  assert.equal(refused, 'tooMany');
  assert.ok(n < 20, `stopped after ${n}`);
  s2.resetReads();
  await outcome(call(s2.ctx, phone.create, { token: TOKEN, text: 'y', runnerId: BRUCE }));
  assert.ok(s2.bytesRead() < 10 * 1024 * 1024, `read ${s2.bytesRead()}`);
});

test('a command no runner takes in two weeks is failed and its photos deleted', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const photo = await phoneUpload(s, 'photo');
  const commandId = await call(s.ctx, phone.send, { token: TOKEN, threadId: 'B', text: 'x', images: [photo] });
  // A week on it's still waiting.
  await later(7 * DAY, () => pruneFilesUntilDone(s));
  assert.equal((await s.ctx.db.get(commandId))?.state, 'pending');
  assert.equal(s.hasFile(photo), true);
  await later(15 * DAY, () => pruneFilesUntilDone(s));
  const c = await s.ctx.db.get(commandId);
  assert.equal(c?.state, 'failed');
  assert.equal(c?.args.text, undefined, 'its words dropped');
  assert.equal(s.hasFile(photo), false);
  // Then pruned like any finished command, with its record of photos.
  await later(17 * DAY, () => call(s.ctx, sync.pruneOld, {}));
  assert.equal(await s.ctx.db.get(commandId), null);
  assert.equal(s.rows('commandFiles').length, 0);
});

// ------------------------------------------------------------ pages

test('non-finite page sizes are refused, and a page reads only its own rows', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [{ ...thread('T', M5), share: { access: 'link', slug: 'link1' } }] });
  for (let seq = 1; seq <= 3000; seq++) await s.ctx.db.insert('messages', { threadId: 'T', seq, role: seq % 10 ? 'tool' : 'assistant', text: `m${seq}`, at: 'now' });
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(await outcome(call(s.ctx, share.view, { slug: 'link1', limit })), 'invalid', `share ${limit}`);
    assert.equal(await outcome(call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', limit, tools: true })), 'invalid', `phone ${limit}`);
    assert.equal(await outcome(call(s.ctx, phone.projectThreads, { token: TOKEN, projectId: 'p', limit })), 'invalid', `projects ${limit}`);
    assert.equal(await outcome(call(s.ctx, relay.remoteTail, { key: OWNER, threadId: 'T', limit })), 'invalid', `tail ${limit}`);
    assert.equal(await outcome(call(s.ctx, relay.remoteMessages, { key: OWNER, threadId: 'T', limit })), 'invalid', `remote ${limit}`);
  }
  // Ordinary pages as before, reading what they return and one more.
  s.resetReads();
  const page = await call(s.ctx, share.view, { slug: 'link1', limit: 30 });
  assert.equal(page.messages.length, 30);
  assert.equal(page.hasMore, true);
  assert.ok(s.reads() <= 31 + 5, `share read ${s.reads()} rows`);
  const mine = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', limit: 2.7, tools: true });
  assert.equal(mine.messages.length, 2);
  // Text only: tool rows are looked past, but not without end.
  s.resetReads();
  const text = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', limit: 2000 });
  assert.ok(text.messages.every((m: any) => m.role !== 'tool'));
  assert.ok(s.reads() <= 2000 + 1 + 4000 + 5, `phone read ${s.reads()} rows`);
  // A thread that's nearly all tool rows: the page stops looking, and says there's more.
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('U', M5)] });
  await s.ctx.db.insert('messages', { threadId: 'U', seq: 1, role: 'user', text: 'first', at: 'now' });
  for (let seq = 2; seq <= 10_000; seq++) await s.ctx.db.insert('messages', { threadId: 'U', seq, role: 'tool', text: 't', at: 'now' });
  s.resetReads();
  const tools = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'U', limit: 50 });
  assert.ok(s.reads() <= 50 + 1 + 4000 + 5, `phone read ${s.reads()} rows`);
  assert.equal(tools.hasMore, true);
  // A token can't be made that never expires.
  assert.equal(await outcome(call(s.ctx, tokens.issue, { name: 'x', days: Number.NaN })), 'invalid');
});

// ------------------------------------------------------------ phone registrations

const apns = (n: number) => n.toString(16).padStart(64, '0');

test('one phone token keeps at most a few registrations, and only real-looking ones', async () => {
  const s = await setup();
  for (let i = 0; i < 300; i++) await call(s.ctx, phone.registerDevice, { token: TOKEN, apnsToken: apns(i), environment: 'production' });
  const mine = s.rows('devices').filter((d) => d.tokenId === s.tokenId);
  assert.equal(mine.length, 5);
  assert.ok(mine.some((d) => d.apnsToken === apns(299)), 'the newest stays');
  assert.equal(await outcome(call(s.ctx, phone.registerDevice, { token: TOKEN, apnsToken: 'z'.repeat(100_000), environment: 'sandbox' })), 'invalid');
  assert.equal(await outcome(call(s.ctx, phone.registerDevice, { token: TOKEN, apnsToken: '', environment: 'sandbox' })), 'invalid');
  // Registering the same phone again replaces its row.
  await call(s.ctx, phone.registerDevice, { token: TOKEN, apnsToken: apns(299), environment: 'production' });
  assert.equal(s.rows('devices').filter((d) => d.tokenId === s.tokenId).length, 5);
});

test('revoking a token with a flood of registrations commits at once, and they go in batches', async () => {
  const s = await setup();
  // Rows a token made before the cap, straight in the table: far more than one mutation may read.
  for (let i = 0; i < 5000; i++) await s.ctx.db.insert('devices', { apnsToken: apns(i), environment: 'production', tokenName: 'iphone', tokenId: s.tokenId, updatedAt: i, pushKey: 'k'.repeat(3000) });
  // And old name-only rows, and another phone's row.
  for (let i = 0; i < 150; i++) await s.ctx.db.insert('devices', { apnsToken: apns(10_000 + i), environment: 'production', tokenName: 'iphone', updatedAt: i });
  await s.ctx.db.insert('devices', { apnsToken: apns(99_999), environment: 'production', tokenName: 'web', tokenId: s.otherId, updatedAt: 1 });
  s.resetReads();
  assert.equal(await call(s.ctx, sync.revokeToken, { key: OWNER, id: s.tokenId }), true);
  assert.ok(s.bytesRead() < 64 * 1024, `revoke read ${s.bytesRead()} bytes`);
  // Revoked now, whatever the cleanup does: the token reads nothing and gets no pushes.
  assert.equal(await outcome(call(s.ctx, phone.me, { token: TOKEN })), 'auth');
  const targets = await call(s.ctx, devices.targets, {});
  assert.deepEqual(targets.map((t: any) => t.apnsToken), [apns(99_999)]);
  // The cleanup, a batch a run, each well under the read limit.
  let runs = 0;
  while (s.scheduled.length && runs < 200) {
    const next = s.scheduled.shift() as { fn: string; args: Record<string, unknown> };
    assert.match(next.fn, /dropDevices/);
    s.resetReads();
    await call(s.ctx, tokens.dropDevices, next.args);
    assert.ok(s.bytesRead() < 2 * 1024 * 1024, `batch read ${s.bytesRead()}`);
    runs++;
  }
  assert.deepEqual(s.rows('devices').map((d) => d.apnsToken), [apns(99_999)]);
  assert.ok(runs > 10, `took ${runs} runs`);
});

test("dropDevices never deletes a live token's phones", async () => {
  const s = await setup();
  await call(s.ctx, phone.registerDevice, { token: TOKEN, apnsToken: apns(1), environment: 'production' });
  await call(s.ctx, tokens.dropDevices, { tokenId: s.tokenId, name: 'iphone' });
  assert.equal(s.rows('devices').length, 1);
});

// ------------------------------------------------------------ second round (Codex review)

test("a runner key's notes on finished commands are cut, and pruneOld reads finished ones by size", async () => {
  const s = await setup();
  for (let i = 0; i < 40; i++) {
    const commandId = await s.ctx.db.insert('commands', { runnerId: BRUCE, kind: 'create', args: { text: 'x' }, state: 'pending', createdAt: Date.now() });
    await call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId });
    await call(s.ctx, sync.finishCommand, { key: BRUCE_KEY, commandId, ok: false, note: 'n'.repeat(512 * 1024) });
  }
  assert.ok(s.rows('commands').every((c) => (c.note ?? '').length <= 500));
  // Big finished rows from before the cut: a run stops by bytes, and carries on.
  for (let i = 0; i < 40; i++) await s.ctx.db.insert('commands', { runnerId: BRUCE, kind: 'create', args: {}, state: 'failed', note: 'n'.repeat(512 * 1024), createdAt: 1, doneAt: 1 });
  await later(2 * DAY, async () => {
    for (let runs = 0; s.rows('commands').length && runs < 50; runs++) {
      s.resetReads();
      await call(s.ctx, sync.pruneOld, {});
      assert.ok(s.bytesRead() < READ_LIMIT, `pruneOld read ${s.bytesRead()}`);
    }
  });
  assert.equal(s.rows('commands').length, 0);
});

test('pruneFiles waits for the migration, which cuts big picture rows in every table', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  // 20 small expired held pictures, each on a file a big pre-cap share row also names.
  for (let i = 0; i < 20; i++) {
    const f = await runnerUpload(s, `f${i}`);
    await s.ctx.db.insert('shareImages', { threadId: 'B', seq: i, path: 'p', storageId: f, mediaType: 'm'.repeat(900 * 1024) });
    await s.ctx.db.insert('heldPictures', { threadId: 'B', seq: i, index: 0, storageId: f, mediaType: 'image/png', at: 1 });
  }
  await unmigrated(s);
  await migrate(s);
  assert.ok(s.rows('shareImages').every((r) => r.mediaType.length <= 100));
  await pruneFilesUntilDone(s);
  assert.equal(s.rows('heldPictures').length, 0);
  assert.equal(s.rows('shareImages').length, 20, 'the share rows still name their files');
});

test('a photo in many messages, all cancelled, is deleted rather than kept for good', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const photo = await phoneUpload(s, 'photo');
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push(await call(s.ctx, phone.send, { token: TOKEN, threadId: 'B', text: 'x', images: [photo] }));
  // A day on, its upload record has gone; the messages still hold it.
  await later(DAY + 60_000, () => pruneFilesUntilDone(s));
  assert.equal(s.hasFile(photo), true);
  for (const commandId of ids) assert.equal(await call(s.ctx, phone.cancel, { token: TOKEN, commandId }), true);
  assert.equal(s.hasFile(photo), false);
  assert.equal(s.rows('commandFiles').length, 0);
});

test('every runner-key upload counts as at least 64 KB, so how many it keeps is bounded', async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await runnerUpload(s, `empty${i}`, 0);
  const usage = s.rows('runnerStorage').find((r) => r.runnerId === BRUCE)!;
  assert.equal(usage.bytes, 3 * 64 * 1024);
});

test('a one-message page of a thread of big messages reads only what it needs', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('T', M5)] });
  for (let seq = 1; seq <= 1800; seq++) await s.ctx.db.insert('messages', { threadId: 'T', seq, role: 'assistant', text: 'a'.repeat(10_000), at: 'now' });
  s.resetReads();
  const page = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', limit: 1 });
  assert.equal(page.messages.length, 1);
  assert.ok(s.bytesRead() < 100 * 1024, `read ${s.bytesRead()}`);
});

test('removing a thread with more than a mutation may read goes in runs, each under the limit', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  const file = await runnerUpload(s, 'held');
  for (let seq = 1; seq <= 40; seq++) await s.ctx.db.insert('heldPictures', { threadId: 'B', seq, index: 0, storageId: file, mediaType: 'x'.repeat(512 * 1024), at: Date.now() });
  for (let seq = 1; seq <= 2000; seq++) await s.ctx.db.insert('messages', { threadId: 'B', seq, role: 'assistant', text: 'a'.repeat(10_000), at: 'now', runnerId: BRUCE });
  s.resetReads();
  await call(s.ctx, sync.removeThreads, { key: BRUCE_KEY, threadIds: ['B'] });
  assert.ok(s.bytesRead() < READ_LIMIT, `remove read ${s.bytesRead()}`);
  for (let runs = 0; runs < 100; runs++) {
    const i = s.scheduled.findIndex((x: any) => /dropThreadRows/.test(x.fn));
    if (i < 0) break;
    const [next] = s.scheduled.splice(i, 1) as { args: Record<string, unknown> }[];
    s.resetReads();
    await call(s.ctx, sync.dropThreadRows, next!.args);
    assert.ok(s.bytesRead() < READ_LIMIT, `run read ${s.bytesRead()}`);
  }
  assert.equal(s.rows('messages').filter((m) => m.threadId === 'B').length, 0);
  assert.equal(s.rows('heldPictures').length, 0);
  assert.equal(s.hasFile(file), false);
});

test("a page's pictures are bounded, and an older page reads only its own", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [{ ...thread('T', M5), share: { access: 'link', slug: 'pics' } }] });
  for (let seq = 1; seq <= 100; seq++) await s.ctx.db.insert('messages', { threadId: 'T', seq, role: 'assistant', text: 'm', at: 'now' });
  for (let i = 0; i < 2000; i++) await s.ctx.db.insert('shareImages', { threadId: 'T', seq: 100, path: `p${i}`, storageId: s.file(`s${i}`), mediaType: 'image/png' });
  for (let i = 0; i < 50; i++) await s.ctx.db.insert('replyImages', { threadId: 'T', seq: 99, path: `r${i}`, storageId: s.file(`r${i}`), mediaType: 'image/png' });
  s.resetReads();
  const page = await call(s.ctx, share.view, { slug: 'pics', limit: 1 });
  assert.ok(page.images.length <= 300);
  assert.ok(s.reads() < 400, `share read ${s.reads()} rows`);
  // An older page (before seq 99) gets none of the newer pictures.
  const older = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', beforeSeq: 99, limit: 10, tools: true });
  assert.equal(older.images, undefined);
  assert.equal(await outcome(call(s.ctx, phone.images, { token: TOKEN, threadId: 'T', from: Number.NaN })), 'invalid');
});

test('the migration deletes registrations with no real APNs token, and records files of commands already waiting', async () => {
  const s = await setup();
  for (let i = 0; i < 40; i++) await s.ctx.db.insert('devices', { apnsToken: 'z'.repeat(512 * 1024) + i, environment: 'production', tokenName: 'iphone', tokenId: s.tokenId, updatedAt: i });
  await s.ctx.db.insert('devices', { apnsToken: apns(7), environment: 'production', tokenName: 'iphone', tokenId: s.tokenId, updatedAt: 99 });
  const photo = s.file('old-photo');
  const a = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'create', args: { text: 'x', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: Date.now() });
  const b = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'create', args: { text: 'y', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: Date.now() });
  await unmigrated(s);
  await migrate(s);
  assert.deepEqual(s.rows('devices').map((d) => d.apnsToken), [apns(7)]);
  // Finishing one of two messages made before the deploy leaves the photo for the other.
  await call(s.ctx, sync.takeCommand, { key: OWNER, commandId: a });
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId: a, ok: true });
  assert.equal(s.hasFile(photo), true);
  await call(s.ctx, sync.takeCommand, { key: OWNER, commandId: b });
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId: b, ok: true });
  assert.equal(s.hasFile(photo), false);
  // Only once.
  s.scheduled.length = 0;
  await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: M5, name: 'm5', version: 'v', startedAt: 'x', draining: false, threadCount: 1 } });
  assert.ok(!s.scheduled.some((x: any) => /limitsMigration/.test(x.fn)));
});

test("taking over other tokens' registrations still keeps a token to five", async () => {
  const s = await setup();
  for (let i = 0; i < 10; i++) await call(s.ctx, phone.registerDevice, { token: OTHER_TOKEN, apnsToken: apns(i), environment: 'production' });
  for (let i = 0; i < 10; i++) await call(s.ctx, phone.registerDevice, { token: TOKEN, apnsToken: apns(i), environment: 'production' });
  assert.ok(s.rows('devices').filter((d) => d.tokenId === s.tokenId).length <= 5);
});

test('a command taken and never finished expires too', async () => {
  const s = await setup();
  const commandId = await call(s.ctx, phone.create, { token: TOKEN, text: 'x', runnerId: BRUCE });
  await call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId });
  await later(15 * DAY, () => pruneFilesUntilDone(s));
  assert.equal((await s.ctx.db.get(commandId))?.state, 'failed');
});

// ------------------------------------------------------------ third round (Codex review)

// Runs every scheduled call of `fn` until none is left, each under the read limit.
async function drain(s: S, name: string, fn: any): Promise<number> {
  let runs = 0;
  for (; runs < 500; runs++) {
    const i = s.scheduled.findIndex((x: any) => new RegExp(name).test(x.fn));
    if (i < 0) return runs;
    const [next] = s.scheduled.splice(i, 1) as { args: Record<string, unknown> }[];
    s.resetReads();
    await call(s.ctx, fn, next!.args);
    assert.ok(s.bytesRead() < READ_LIMIT, `${name} read ${s.bytesRead()}`);
  }
  throw new Error(`${name} never finished`);
}

test("taking over a big runner-key thread waits for its rows to go, and nobody writes under it meanwhile", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  for (let seq = 1; seq <= 600; seq++) await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'B', seq, role: 'assistant', text: `bruce ${seq} ` + 'b'.repeat(9_000), at: 'now' }] });
  const pic = await runnerUpload(s, 'bruce-pic');
  await call(s.ctx, sync.addReplyImage, { key: BRUCE_KEY, threadId: 'B', seq: 600, path: 'a.png', storageId: pic, mediaType: 'image/png' });
  await s.ctx.db.insert('eventBodies', { threadId: 'B', seq: 3, runnerId: BRUCE, text: 'tool output', at: Date.now() });
  const takeover = () => call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('B', M5)] });
  s.resetReads();
  const first = await takeover();
  assert.ok(s.bytesRead() < READ_LIMIT);
  assert.deepEqual(first.skipped, ['B'], 'waits');
  assert.equal((await s.ctx.db.query('threads').withIndex('by_threadId', (q: any) => q.eq('threadId', 'B')).unique()).runnerId, BRUCE, "still Bruce's meanwhile");
  // Meanwhile: the owner's messages wait (skipped, sent again), Bruce's go nowhere.
  const owner = await call(s.ctx, sync.appendMessages, { key: OWNER, messages: [1, 2, 601].map((seq) => ({ threadId: 'B', seq, role: 'user', text: `owner ${seq}`, at: 'now' })) });
  assert.deepEqual(owner.skipped, ['B:1', 'B:2', 'B:601']);
  await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'B', seq: 700, role: 'assistant', text: 'late bruce', at: 'now' }] });
  assert.deepEqual((await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] })).skipped, ['B']);
  assert.ok((await drain(s, 'dropThreadRows', sync.dropThreadRows)) >= 1);
  assert.equal(s.rows('messages').filter((m) => m.threadId === 'B').length, 0);
  assert.equal(s.rows('eventBodies').length, 0);
  assert.equal(s.hasFile(pic), false);
  // Still Bruce's to nobody until the owner's next write of it, which goes through.
  await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'B', seq: 800, role: 'assistant', text: 'later bruce', at: 'now' }] });
  assert.deepEqual((await takeover()).skipped, []);
  assert.equal(s.rows('threads').find((t) => t.threadId === 'B')!.runnerId, M5);
  assert.deepEqual((await call(s.ctx, sync.appendMessages, { key: OWNER, messages: [{ threadId: 'B', seq: 1, role: 'user', text: 'owner 1', at: 'now' }] })).skipped, []);
  assert.deepEqual(s.rows('messages').filter((m) => m.threadId === 'B').map((m) => m.text), ['owner 1']);
  assert.equal(s.rows('threadClears').length, 0);
});

test("a removed thread's id stays closed until its rows have gone, so a thread made under it starts clean", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('R', BRUCE)] });
  for (let seq = 1; seq <= 600; seq++) await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'R', seq, role: 'assistant', text: 'r'.repeat(9_000), at: 'now' }] });
  await call(s.ctx, sync.removeThreads, { key: BRUCE_KEY, threadIds: ['R'] });
  assert.deepEqual((await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('R', M5)] })).skipped, ['R']);
  await drain(s, 'dropThreadRows', sync.dropThreadRows);
  assert.deepEqual((await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('R', M5)] })).skipped, []);
  assert.equal(s.rows('messages').filter((m) => m.threadId === 'R').length, 0);
});

test('removing many threads with big tool output together stays under the read limit', async () => {
  const s = await setup();
  const ids = Array.from({ length: 40 }, (_, i) => `E${i}`);
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: ids.map((id) => thread(id, BRUCE)) });
  for (const id of ids) await s.ctx.db.insert('eventBodies', { threadId: id, seq: 1, runnerId: BRUCE, text: 'x'.repeat(500 * 1024), at: Date.now() });
  s.resetReads();
  await call(s.ctx, sync.removeThreads, { key: BRUCE_KEY, threadIds: ids });
  assert.ok(s.bytesRead() < READ_LIMIT, `remove read ${s.bytesRead()}`);
  await drain(s, 'dropThreadRows', sync.dropThreadRows);
  assert.equal(s.rows('eventBodies').length, 0);
});

test('before the migration, checking many photos shares one allowance for old commands', async () => {
  const s = await setup();
  await unmigrated(s);
  for (let i = 0; i < 3; i++) await s.ctx.db.insert('commands', { runnerId: BRUCE, kind: 'create', args: { text: 'w'.repeat(1000 * 1024) }, state: 'pending', createdAt: Date.now() });
  const photos = Array.from({ length: 6 }, (_, i) => ({ storageId: s.file(`p${i}`), url: 'u' }));
  const c = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'create', args: { text: 'x', images: photos }, state: 'pending', createdAt: Date.now() });
  await call(s.ctx, sync.takeCommand, { key: OWNER, commandId: c });
  s.resetReads();
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId: c, ok: true });
  assert.ok(s.bytesRead() < READ_LIMIT, `finish read ${s.bytesRead()}`);
});

test('pruneFiles starts the migration itself when no Mac has heartbeated', async () => {
  const s = await setup();
  await unmigrated(s);
  await call(s.ctx, sync.pruneFiles, {});
  assert.ok(s.scheduled.some((x: any) => /limitsMigration/.test(x.fn)));
  await drain(s, 'limitsMigration', sync.limitsMigration);
  assert.ok(s.rows('backendMarks').some((m) => m.name === 'limits-2026-11-07-done'));
});

test('before the migration, a photo two old commands share stays until both are done', async () => {
  const s = await setup();
  await unmigrated(s);
  const photo = s.file('old-photo');
  const a = await s.ctx.db.insert('commands', { runnerId: M5, kind: 'create', args: { text: 'x', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: Date.now() });
  await s.ctx.db.insert('commands', { runnerId: M5, kind: 'create', args: { text: 'y', images: [{ storageId: photo, url: 'u' }] }, state: 'pending', createdAt: Date.now() });
  await call(s.ctx, sync.takeCommand, { key: OWNER, commandId: a });
  await call(s.ctx, sync.finishCommand, { key: OWNER, commandId: a, ok: true });
  assert.equal(s.hasFile(photo), true);
});

test('clearing threads before the migration charges for big old rows its checks read', async () => {
  const s = await setup();
  await unmigrated(s);
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('O', M5), thread('P', M5)] });
  for (let i = 0; i < 20; i++) {
    const f = s.file(`f${i}`);
    await s.ctx.db.insert('shareImages', { threadId: 'O', seq: i, path: 'p', storageId: f, mediaType: 'image/png' });
    await s.ctx.db.insert('replyImages', { threadId: 'P', seq: i, path: 'p', storageId: f, mediaType: 'm'.repeat(900 * 1024) });
  }
  s.resetReads();
  await call(s.ctx, sync.removeThreads, { key: OWNER, threadIds: ['O'] });
  assert.ok(s.bytesRead() < READ_LIMIT, `remove read ${s.bytesRead()}`);
  await drain(s, 'dropThreadRows', sync.dropThreadRows);
  assert.equal(s.rows('shareImages').length, 0);
  // Forty threads with one big old row each, removed together.
  const s2 = await setup();
  await unmigrated(s2);
  const ids = Array.from({ length: 40 }, (_, i) => `T${i}`);
  await call(s2.ctx, sync.upsertThreads, { key: OWNER, threads: ids.map((id) => thread(id, M5)) });
  for (const id of ids) await s2.ctx.db.insert('heldPictures', { threadId: id, seq: 1, index: 0, storageId: s2.file(`h${id}`), mediaType: 'x'.repeat(512 * 1024), at: Date.now() });
  s2.resetReads();
  await call(s2.ctx, sync.removeThreads, { key: OWNER, threadIds: ids });
  assert.ok(s2.bytesRead() < READ_LIMIT, `remove read ${s2.bytesRead()}`);
  await drain(s2, 'dropThreadRows', sync.dropThreadRows);
  assert.equal(s2.rows('heldPictures').length, 0);
});

test('a text page past big tool rows stops at a few MB and says there is more', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('T', M5)] });
  await s.ctx.db.insert('messages', { threadId: 'T', seq: 1, role: 'assistant', text: 'old text', at: 'now' });
  for (let seq = 2; seq <= 1801; seq++) await s.ctx.db.insert('messages', { threadId: 'T', seq, role: 'tool', text: 't'.repeat(10_000), at: 'now' });
  s.resetReads();
  const page = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', limit: 1 });
  assert.ok(s.bytesRead() < 10 * 1024 * 1024, `read ${s.bytesRead()}`);
  assert.equal(page.hasMore, true);
  for (let seq = 2000; seq <= 4000; seq++) await s.ctx.db.insert('messages', { threadId: 'T', seq, role: 'assistant', text: 'a'.repeat(10_000), at: 'now' });
  await s.ctx.db.patch(s.rows('threads').find((t) => t.threadId === 'T')!._id, { share: { access: 'link', slug: 'bigpage' } });
  s.resetReads();
  const shared = await call(s.ctx, share.view, { slug: 'bigpage', limit: 2000 });
  assert.ok(s.bytesRead() < 10 * 1024 * 1024, `share read ${s.bytesRead()}`);
  assert.equal(shared.hasMore, true);
  s.resetReads();
  const big = await call(s.ctx, phone.messages, { token: TOKEN, threadId: 'T', limit: 2000, tools: true });
  assert.ok(s.bytesRead() < 10 * 1024 * 1024, `read ${s.bytesRead()}`);
  assert.equal(big.hasMore, true);
});

test("removing a runner key's thread gives back exactly the message bytes it was charged", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('KEEP', BRUCE), thread('SCRATCH', BRUCE)] });
  await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'KEEP', seq: 1, role: 'assistant', text: 'k', at: 'now' }] });
  const used = () => s.rows('runnerStorage').find((r) => r.runnerId === BRUCE)!.messageBytes;
  const base = used();
  for (let seq = 1; seq <= 200; seq++) await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'SCRATCH', seq, role: 'assistant', text: 's', at: 'now' }] });
  await call(s.ctx, sync.removeThreads, { key: BRUCE_KEY, threadIds: ['SCRATCH'] });
  assert.equal(used(), base);
});

test('the migration trims a legacy flood of real-looking registrations to five a token', async () => {
  const s = await setup();
  for (let i = 0; i < 300; i++) await s.ctx.db.insert('devices', { apnsToken: apns(i), environment: 'production', tokenName: 'iphone', tokenId: s.tokenId, updatedAt: i });
  for (let i = 0; i < 300; i++) await s.ctx.db.insert('devices', { apnsToken: apns(5000 + i), environment: 'production', tokenName: 'old', updatedAt: i });
  await unmigrated(s);
  await migrate(s);
  const left = s.rows('devices');
  assert.equal(left.length, 5);
  assert.ok(left.some((d) => d.apnsToken === apns(299)), 'the newest stay');
});

test('past the picture cap a page gets the newest pictures', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('T', M5)] });
  for (let seq = 1; seq <= 400; seq++) await s.ctx.db.insert('replyImages', { threadId: 'T', seq, path: `r${seq}`, storageId: s.file(`r${seq}`), mediaType: 'image/png' });
  const pics = await call(s.ctx, phone.images, { token: TOKEN, threadId: 'T', from: 0 });
  assert.equal(pics.length, 300);
  assert.equal(pics.at(-1).seq, 400);
});

// ------------------------------------------------------------ fourth round (Codex review)

test('removing a thread while a takeover waits opens its id once the rows have gone', async () => {
  for (const when of ['before the rows have gone', 'after']) {
    const s = await setup();
    await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
    for (let seq = 1; seq <= 600; seq++) await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'B', seq, role: 'assistant', text: 'b'.repeat(9_000), at: 'now' }] });
    assert.deepEqual((await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('B', M5)] })).skipped, ['B']);
    if (when === 'after') await drain(s, 'dropThreadRows', sync.dropThreadRows);
    await call(s.ctx, sync.removeThreads, { key: OWNER, threadIds: ['B'] });
    await drain(s, 'dropThreadRows', sync.dropThreadRows);
    assert.equal(s.rows('threadClears').length, 0, when);
    assert.deepEqual((await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('B', M5)] })).skipped, [], when);
    assert.equal(s.rows('messages').filter((m) => m.threadId === 'B').length, 0);
  }
});

test("under a closed id the owner hears to try again, its picture is answered later, and a runner key isn't told to retry", async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] });
  for (let seq = 1; seq <= 600; seq++) await call(s.ctx, sync.appendMessages, { key: BRUCE_KEY, messages: [{ threadId: 'B', seq, role: 'assistant', text: 'b'.repeat(9_000), at: 'now' }] });
  assert.deepEqual((await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('B', M5)] })).closed, ['B']);
  const m = await call(s.ctx, sync.appendMessages, { key: OWNER, messages: [{ threadId: 'B', seq: 601, role: 'user', text: 'x', at: 'now' }] });
  assert.deepEqual(m.closed, ['B']);
  const b = await call(s.ctx, sync.appendBodies, { key: OWNER, bodies: [{ threadId: 'B', seq: 601, text: 'x' }] });
  assert.deepEqual(b.closed, ['B']);
  // Old pictures on their way out don't count as sent.
  await s.ctx.db.insert('replyImages', { threadId: 'B', seq: 1, path: 'old.png', storageId: s.file('old'), mediaType: 'image/png' });
  assert.deepEqual(await call(s.ctx, sync.replyImages, { key: OWNER, threadId: 'B' }), []);
  assert.deepEqual(await call(s.ctx, sync.shareImages, { key: OWNER, threadId: 'B' }), []);
  const pic = s.file('owner-pic');
  assert.deepEqual(await call(s.ctx, sync.addReplyImage, { key: OWNER, threadId: 'B', seq: 601, path: 'a.png', storageId: pic, mediaType: 'image/png' }), { later: true });
  assert.equal(s.hasFile(pic), false, 'its upload goes; the runner uploads again');
  assert.equal((await call(s.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [thread('B', BRUCE)] })).closed, undefined);
});

test('before the migration, checks past the old-command allowance read no more commands', async () => {
  const s = await setup();
  await unmigrated(s);
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('O', M5)] });
  await s.ctx.db.insert('commands', { runnerId: BRUCE, kind: 'create', args: { text: 'w'.repeat(900 * 1024) }, state: 'pending', createdAt: Date.now() });
  for (let i = 0; i < 30; i++) await s.ctx.db.insert('shareImages', { threadId: 'O', seq: i, path: `p${i}`, storageId: s.file(`f${i}`), mediaType: 'image/png' });
  s.resetReads();
  await call(s.ctx, sync.dropShareImages, { key: OWNER, threadId: 'O' });
  assert.ok(s.bytesRead() < READ_LIMIT, `read ${s.bytesRead()}`);
});
