// Other runners' threads through the backend (relay.ts): rows become
// transcript events in relay seqs, a tail merges without holes, and actions
// go to the thread's runner as commands, with nothing published to the
// runner's own listeners (sync would mirror them as this runner's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Relay, SCALE, mergeTail, relayEvents, type RelayRow, type RelayThreadRow } from '../../src/relay.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import type { RemoteThreads } from '../../src/thread-index.ts';

const T = 'thread-on-bruce';
const at = (s: number) => new Date(Date.parse('2026-11-05T10:00:00Z') + s * 1000).toISOString();
const rows: RelayRow[] = [
  { seq: 3, role: 'user', text: 'Fix it', turn: 'aaaa1111', at: at(0) },
  { seq: 5, role: 'tool', text: 'Read ~/x.ts', toolKind: 'read', turn: 'aaaa1111', at: at(2) },
  { seq: 9, role: 'assistant', text: 'Done', summary: true, turn: 'aaaa1111', at: at(10) },
  { seq: 12, role: 'user', text: 'Again', turn: 'bbbb2222', at: at(20) },
  { seq: 14, role: 'tool', text: 'Ran tests', toolKind: 'command', turn: 'bbbb2222', at: at(21) },
];
const idle: RelayThreadRow = { runnerId: 'bruce', status: 'idle', needs: 'nothing' };

test('rows become events eight seqs apart, with turns, results and ends made up beside them', () => {
  const ev = relayEvents(T, rows, idle, [], false, 'bruce');
  const types = ev.map((e) => `${e.seq}:${e.type}`);
  assert.deepEqual(types, [
    '24:turn.started',
    '25:user.message',
    '41:tool.call',
    '42:tool.result',
    '73:assistant.text',
    '79:turn.completed',
    '96:turn.started',
    '97:user.message',
    '113:tool.call',
    '114:tool.result',
    '119:turn.completed',
  ]);
  assert.equal(ev.find((e) => e.type === 'tool.result')!.text, 'The output is kept on bruce.');
  assert.deepEqual(ev.find((e) => e.type === 'tool.result')!.heldBack, { seq: 5 });
  assert.equal(ev.find((e) => e.seq === 79)!.durationMs, 10_000);
  assert.equal(ev.find((e) => e.seq === 73)!.summary, true);
});

test('a running turn has no end, and its last tool is still running', () => {
  const ev = relayEvents(T, rows, { runnerId: 'bruce', status: 'running' }, [], false, 'bruce');
  assert.equal(ev.some((e) => e.seq === 114), false);
  assert.equal(ev.some((e) => e.seq === 119), false);
  // The earlier turn still ended, at its next row.
  assert.ok(ev.some((e) => e.seq === 79 && e.type === 'turn.completed'));
  // Nor does one whose row has only just said it stopped.
  assert.equal(relayEvents(T, rows, idle, [], false, 'bruce', false).some((e) => e.seq === 119), false);
});

test('no turn.started for the first row held when older rows may still be its turn', () => {
  const ev = relayEvents(T, rows.slice(1), idle, [], true, 'bruce');
  assert.equal(ev[0]!.type, 'tool.call');
});

test("the open card is the last turn's end, and an approval sits at its own seq", () => {
  const asksRow: RelayThreadRow = { runnerId: 'bruce', status: 'idle', needs: 'you', asks: [{ action: 'Pick one', options: ['A', 'B'], ticked: true }] };
  const ev = relayEvents(T, rows, asksRow, [{ slot: 13 * SCALE + 1, pending: { approvalId: 'ap1', kind: 'approval', name: 'Bash', title: 'Run it', options: ['allow', 'deny'], inputSummary: 'npm test' } }], false, 'bruce');
  const end = ev.find((e) => e.seq === 119)!;
  assert.equal(end.needs, 'you');
  assert.deepEqual(end.asks, [{ action: 'Pick one', options: ['A', 'B'], ticked: true }]);
  const ap = ev.find((e) => e.type === 'approval.requested')!;
  assert.equal(ap.seq, 13 * SCALE + 1);
  assert.equal(ap.turnId, 'bbbb2222');
});

test('a tail past what is held asks for the gap; one that overlaps just merges', () => {
  const held = new Map(rows.map((r) => [r.seq, r]));
  assert.deepEqual(mergeTail(held, { messages: [{ seq: 14, role: 'tool', text: 'x', at: at(1) }, { seq: 15, role: 'assistant', text: 'y', at: at(2) }], hasMore: true }), {});
  assert.deepEqual(mergeTail(held, { messages: [{ seq: 40, role: 'assistant', text: 'z', at: at(3) }], hasMore: true }), { gapAfter: 15 });
  assert.ok(held.has(40));
  // A tail that's the whole thread has no gap.
  assert.deepEqual(mergeTail(new Map([[1, rows[0]!]]), { messages: [{ seq: 50, role: 'user', text: 'q', at: at(4) }], hasMore: false }), {});
});

type Call = { kind: string; fn: string; args: Record<string, unknown> };
function harness(opts: { online?: boolean; row?: () => RelayThreadRow & { share?: unknown } } = {}) {
  const calls: Call[] = [];
  const uploads: { url: string; bytes: number; mediaType: string }[] = [];
  const subs = new Map<string, { args: Record<string, unknown>; onUpdate: (v: unknown) => void; closed: boolean }[]>();
  const published: unknown[] = [];
  const subscribed = new Set<string>();
  const clock = new FakeClock();
  const remote: RemoteThreads = {
    runners: [{ id: 'bruce', name: 'bruce', online: opts.online ?? true, lastSeenAt: at(0) }],
    threads: [{ runnerId: 'bruce', threadId: T, title: 'A thread', cwd: '/Users/b/x', accountId: 'claude-main', provider: 'claude', status: 'idle', needsYou: false, unread: true, preview: '', createdAt: at(0), lastActivityAt: at(0) }],
  };
  let commandN = 0;
  const relay = new Relay({
    source: () => ({
      key: 'owner',
      post: async (kind, fn, args) => {
        calls.push({ kind, fn, args });
        if (fn === 'relay:remoteThread') return opts.row?.() ?? idle;
        if (fn === 'relay:remoteMessages') return { messages: rows, hasMore: false };
        if (fn === 'relay:queueCommand') return `cmd${++commandN}`;
        if (fn === 'relay:remoteAccounts') return [{ runnerId: 'bruce', id: 'claude-main', provider: 'claude', title: 'Claude' }];
        if (fn === 'relay:imageUploadUrl') return `https://upload/${calls.length}`;
        return null;
      },
      subscribe: (fn, args, onUpdate) => {
        const list = subs.get(fn) ?? [];
        const s = { args, onUpdate, closed: false };
        list.push(s);
        subs.set(fn, list);
        return () => {
          s.closed = true;
        };
      },
    }),
    remote: () => remote,
    subscribed: (id) => subscribed.has(id),
    publish: (n) => published.push(n),
    clock,
    log: nullLogger,
    readFile: (file) => {
      if (file === '/big.png') return new Uint8Array(26 * 1024 * 1024);
      if (file === '/gone.png') throw new Error('ENOENT');
      return new Uint8Array([1, 2, 3]);
    },
    upload: async (url, bytes, mediaType) => {
      uploads.push({ url, bytes: bytes.byteLength, mediaType });
      return `storage${uploads.length}`;
    },
  });
  return { relay, calls, subs, published, subscribed, clock, remote, uploads };
}

test('it answers only for threads other runners have, and pages in relay seqs', async () => {
  const h = harness();
  assert.equal(h.relay.owns(T), true);
  assert.equal(h.relay.owns('mine'), false);
  const page = (await h.relay.call(T, 'threads.events', { threadId: T, limit: 4 })) as { events: { seq: number }[]; relay: { atStart?: boolean } };
  assert.deepEqual(page.events.map((e) => e.seq), [97, 113, 114, 119]);
  assert.equal(page.relay.atStart, undefined);
  const older = (await h.relay.call(T, 'threads.events', { threadId: T, beforeSeq: 97, limit: 200 })) as { events: { seq: number }[]; relay: { atStart?: boolean } };
  assert.deepEqual(older.events.map((e) => e.seq), [24, 25, 41, 42, 73, 79, 96]);
  assert.equal(older.relay.atStart, true);
});

test('a subscribe watches a tail and the row, and new rows reach clients only', async () => {
  const h = harness();
  await h.relay.call(T, 'threads.events', { threadId: T });
  const back = (await h.relay.call(T, 'threads.subscribe', { threadId: T, afterSeq: 119 })) as { events: { seq: number }[] };
  // Nothing new; only what could have come late, again (the app ignores seqs it has).
  assert.ok(back.events.every((e) => e.seq <= 119 && [2, 3, 4, 7].includes(e.seq % SCALE)));
  const tail = h.subs.get('relay:remoteTail')![0]!;
  assert.equal(tail.args.limit, 15);
  assert.ok(h.subs.get('relay:remoteThread'));
  // The next turn arrives while the thread runs.
  h.subs.get('relay:remoteThread')![0]!.onUpdate({ runnerId: 'bruce', status: 'running' });
  tail.onUpdate({ messages: [...rows.slice(-2), { seq: 20, role: 'user', text: 'More', turn: 'cccc3333', at: at(30) }], hasMore: true });
  await new Promise((r) => setImmediate(r));
  const seqs = h.published.map((n) => (n as { params: { event: { seq: number; type: string } } }).params.event).map((e) => `${e.seq}:${e.type}`);
  assert.deepEqual(seqs, ['160:turn.started', '161:user.message']);
  // An approval comes and is answered from here: its card, then its answer, both late-safe.
  h.subs.get('relay:remoteThread')![0]!.onUpdate({ runnerId: 'bruce', status: 'waiting', pendingApproval: { approvalId: 'ap9', kind: 'approval', seq: 22, name: 'Bash', title: 'Run', options: ['allow', 'deny'] } });
  const respond = h.relay.call(T, 'approvals.respond', { threadId: T, approvalId: 'ap9', decision: 'deny' });
  await new Promise((r) => setImmediate(r));
  const cmd = h.calls.find((c) => c.fn === 'relay:queueCommand')!;
  assert.deepEqual(cmd.args, { key: 'owner', runnerId: 'bruce', threadId: T, kind: 'respond', args: { approvalId: 'ap9', decision: 'deny' } });
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done' });
  await respond;
  const last = h.published.map((n) => (n as { params: { event: { seq: number; type: string; decision?: string } } }).params.event).slice(-2);
  assert.deepEqual(last.map((e) => `${e.seq}:${e.type}`), ['177:approval.requested', '178:approval.resolved']);
  assert.equal(last[1]!.decision, 'deny');
});

test("a turn ends a moment after the row says it stopped, so its last messages come first", async () => {
  const h = harness();
  await h.relay.call(T, 'threads.events', { threadId: T });
  await h.relay.call(T, 'threads.subscribe', { threadId: T, afterSeq: 119 });
  const row = h.subs.get('relay:remoteThread')![0]!;
  const tail = h.subs.get('relay:remoteTail')![0]!;
  row.onUpdate({ runnerId: 'bruce', status: 'running' });
  tail.onUpdate({ messages: [{ seq: 20, role: 'user', text: 'More', turn: 'cccc3333', at: at(30) }], hasMore: true });
  await new Promise((r) => setImmediate(r));
  row.onUpdate({ runnerId: 'bruce', status: 'idle', needs: 'nothing' });
  const kinds = () => h.published.map((n) => (n as { params: { event: { seq: number; type: string } } }).params.event).map((e) => `${e.seq}:${e.type}`);
  assert.equal(kinds().includes('167:turn.completed'), false);
  // Its reply lands after the row said idle.
  tail.onUpdate({ messages: [{ seq: 20, role: 'user', text: 'More', turn: 'cccc3333', at: at(30) }, { seq: 23, role: 'assistant', text: 'Done', turn: 'cccc3333', at: at(31) }], hasMore: true });
  await new Promise((r) => setImmediate(r));
  h.clock.advance(4000);
  assert.deepEqual(kinds().slice(-2), ['185:assistant.text', '191:turn.completed']);
});

test('a thread made from here opens before the sidebar lists it', async () => {
  const h = harness();
  const made = h.relay.create('bruce', { text: 'Start', permissionMode: 'ask' });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done', threadId: 'fresh' });
  await made;
  assert.equal(h.calls.at(-1)!.args.args && (h.calls.at(-1)!.args.args as { permissionMode?: string }).permissionMode, 'ask');
  assert.equal(h.relay.owns('fresh'), true);
});

test('the watch stops a minute after nobody is subscribed', async () => {
  const h = harness();
  await h.relay.call(T, 'threads.subscribe', { threadId: T, afterSeq: 0 });
  h.subscribed.add(T);
  h.clock.advance(30_000);
  assert.equal(h.subs.get('relay:remoteTail')![0]!.closed, false);
  h.subscribed.delete(T);
  for (let i = 0; i < 6; i++) h.clock.advance(15_000);
  assert.equal(h.subs.get('relay:remoteTail')![0]!.closed, true);
  assert.equal(h.subs.get('relay:remoteThread')![0]!.closed, true);
});

test('sends, stops and changes go to the thread runner; settings that only work there are refused', async () => {
  const h = harness();
  const send = h.relay.call(T, 'threads.send', { threadId: T, text: 'hi', answers: [{ action: 'a', answer: 'b' }] });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'taken' });
  assert.deepEqual(await send, { turnId: '' });
  assert.deepEqual(h.calls.at(-1)!.args.args, { text: 'hi', answers: [{ action: 'a', answer: 'b' }] });
  const stop = h.relay.call(T, 'threads.interrupt', { threadId: T });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![1]!.onUpdate({ state: 'done' });
  await stop;
  assert.equal(h.calls.at(-1)!.args.kind, 'interrupt');
  await assert.rejects(h.relay.call(T, 'threads.update', { threadId: T, model: 'opus' }), /isn't possible through Convex yet/);
});

test('pictures go to file storage first, and the command names them', async () => {
  const h = harness();
  const send = h.relay.call(T, 'threads.send', { threadId: T, text: 'look [Picture 1]', images: [{ path: '/a.png', mediaType: 'image/png' }] });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'taken' });
  await send;
  assert.deepEqual(h.uploads, [{ url: 'https://upload/1', bytes: 3, mediaType: 'image/png' }]);
  assert.deepEqual(h.calls.at(-1)!.args.args, { text: 'look [Picture 1]', images: ['storage1'] });

  const made = h.relay.create('bruce', { text: '', images: [{ path: '/b.jpg', mediaType: 'image/jpeg' }, { path: '/c.png', mediaType: 'image/png' }] });
  await new Promise((r) => setImmediate(r));
  const q = h.calls.find((c) => c.fn === 'relay:queueCommand' && c.args.kind === 'create')!;
  assert.deepEqual(q.args.args, { text: '', images: ['storage2', 'storage3'] });
  h.subs.get('relay:commandState')!.at(-1)!.onUpdate({ state: 'done', threadId: 'new1' });
  await made;

  await assert.rejects(h.relay.call(T, 'threads.send', { threadId: T, text: 'x', images: [{ path: '/big.png' }] }), /over 25 MB/);
  await assert.rejects(h.relay.call(T, 'threads.send', { threadId: T, text: 'x', images: [{ path: '/gone.png' }] }), /Couldn't read a picture/);
  const seven = Array.from({ length: 7 }, () => ({ path: '/a.png' }));
  await assert.rejects(h.relay.call(T, 'threads.send', { threadId: T, text: 'x', images: seven }), /At most 6 pictures/);
});

test("a change answers with the thread, as the app decodes any runner's threads.update", async () => {
  // It answered {} and the app's archive failed with "Key 'thread' not found".
  const h = harness();
  const settle = (i: number) => h.subs.get('relay:commandState')![i]!.onUpdate({ state: 'done' });
  const archive = h.relay.call(T, 'threads.update', { threadId: T, archived: true, verdict: 'worked' });
  await new Promise((r) => setImmediate(r));
  settle(0);
  const { thread } = (await archive) as { thread: Record<string, unknown> };
  assert.equal(thread.id, T);
  assert.equal(thread.runnerId, 'bruce');
  assert.equal(thread.title, 'A thread');
  assert.equal(typeof thread.archivedAt, 'string');
  assert.equal(thread.lastSeq, 1, 'still unread');
  const snooze = h.relay.call(T, 'threads.update', { threadId: T, snoozedUntil: 'restart', starred: true, title: 'Renamed' });
  await new Promise((r) => setImmediate(r));
  settle(1);
  await new Promise((r) => setImmediate(r));
  settle(2);
  await new Promise((r) => setImmediate(r));
  settle(3);
  const after = ((await snooze) as { thread: Record<string, unknown> }).thread;
  assert.equal(after.title, 'Renamed');
  assert.equal(after.snoozedUntilRestart, true);
  assert.equal(typeof after.starredAt, 'string');
  assert.equal(after.archivedAt, thread.archivedAt, "the backend's row isn't archived yet, but the archive was done: a later reply mustn't undo it in the app");
  const markSeen = h.relay.call(T, 'threads.markSeen', { threadId: T, seq: 9 });
  await new Promise((r) => setImmediate(r));
  settle(4);
  const seen = ((await markSeen) as { thread: Record<string, unknown> }).thread;
  assert.equal(seen.lastSeq, 0);
  assert.equal(typeof seen.archivedAt, 'string', 'still archived');
  // A minute on, the row has caught up and is the truth again.
  h.clock.advance(61_000);
  const again = h.relay.call(T, 'threads.markSeen', { threadId: T, seq: 9 });
  await new Promise((r) => setImmediate(r));
  settle(5);
  const later = ((await again) as { thread: Record<string, unknown> }).thread;
  assert.equal(later.archivedAt, undefined);
  assert.equal(later.title, 'A thread');
});

test("a change from elsewhere wins once the row shows ours, and one that went through is kept when the next fails", async () => {
  const h = harness();
  let n = 0;
  const answer = async (state: 'done' | 'failed') => {
    await new Promise((r) => setImmediate(r));
    h.subs.get('relay:commandState')![n++]!.onUpdate(state === 'done' ? { state } : { state, note: 'bad time' });
  };
  // Renamed to A from here; the row catches up, then the phone renames it B.
  const rename = h.relay.call(T, 'threads.update', { threadId: T, title: 'A' });
  await answer('done');
  assert.equal(((await rename) as { thread: { title: string } }).thread.title, 'A');
  h.remote.threads[0]!.title = 'A';
  h.remote.threads[0]!.unread = false;
  assert.equal(((await h.relay.call(T, 'threads.markSeen', { threadId: T, seq: 1 })) as { thread: { title: string } }).thread.title, 'A');
  h.remote.threads[0]!.title = 'B';
  assert.equal(((await h.relay.call(T, 'threads.markSeen', { threadId: T, seq: 1 })) as { thread: { title: string } }).thread.title, 'B', "the phone's rename isn't hidden");
  // A rename that goes through, then a snooze that fails: the rename stays.
  const both = h.relay.call(T, 'threads.update', { threadId: T, title: 'C', snoozedUntil: 'not a time' });
  await answer('done');
  await answer('failed');
  await assert.rejects(both, /bad time/);
  assert.equal(((await h.relay.call(T, 'threads.markSeen', { threadId: T, seq: 1 })) as { thread: { title: string } }).thread.title, 'C');
});

test("the sidebar's list keeps an archive made here until the backend's row shows it", async () => {
  // A list sent for some other thread's change, before this row caught up,
  // put the thread just archived back in the inbox.
  const h = harness();
  assert.equal(h.relay.overlay(h.remote), h.remote, 'nothing changed here: the list as it is');
  const archive = h.relay.call(T, 'threads.update', { threadId: T, archived: true });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done' });
  await archive;
  assert.equal(typeof h.relay.overlay(h.remote).threads[0]!.archivedAt, 'string');
  assert.equal(h.remote.threads[0]!.archivedAt, undefined, "the backend's own list isn't changed");
  // The row catches up; then the phone unarchives it, and that shows.
  h.remote.threads[0]!.archivedAt = at(5);
  assert.equal(h.relay.overlay(h.remote).threads[0]!.archivedAt, at(5));
  delete h.remote.threads[0]!.archivedAt;
  assert.equal(h.relay.overlay(h.remote).threads[0]!.archivedAt, undefined);
});

test("sharing answers with the link, read from that runner's row once it shows it", async () => {
  let share: { access: string; slug: string } | undefined;
  const h = harness({ row: () => ({ ...idle, ...(share ? { share } : {}) }) });
  const done = async (i: number) => {
    await new Promise((r) => setImmediate(r));
    h.subs.get('relay:commandState')![i]!.onUpdate({ state: 'done' });
  };
  const on = h.relay.call(T, 'threads.share', { threadId: T, access: 'link' });
  await done(0);
  // Its row hasn't caught up the first time it's read: read again a moment later.
  await new Promise((r) => setImmediate(r));
  share = { access: 'link', slug: 'abc' };
  h.clock.advance(1000);
  assert.deepEqual(((await on) as { thread: { share: unknown } }).thread.share, { access: 'link', slug: 'abc' });
  assert.deepEqual(h.calls.filter((c) => c.fn === 'relay:queueCommand').at(-1)!.args, { key: 'owner', runnerId: 'bruce', threadId: T, kind: 'share', args: { access: 'link' } });
  // A new link: not done until the slug isn't the old one.
  const fresh = h.relay.call(T, 'threads.share', { threadId: T, access: 'link', newLink: true });
  await done(1);
  await new Promise((r) => setImmediate(r));
  share = { access: 'link', slug: 'def' };
  h.clock.advance(1000);
  assert.equal(((await fresh) as { thread: { share: { slug: string } } }).thread.share.slug, 'def');
  // Off keeps the slug, so sharing again brings the same link back.
  share = { access: 'off', slug: 'def' };
  const off = h.relay.call(T, 'threads.share', { threadId: T, access: 'off' });
  await done(2);
  assert.deepEqual(((await off) as { thread: { share: unknown } }).thread.share, { access: 'off', slug: 'def' });
  await assert.rejects(h.relay.call(T, 'threads.share', { threadId: T, access: 'people' }), /access must be/);
});

test("a link that never reaches the row says so, rather than showing none", async () => {
  const h = harness();
  const on = h.relay.call(T, 'threads.share', { threadId: T, access: 'link' });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done' });
  const said = assert.rejects(on, /has shared it, but its link hasn't reached Convex yet/);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    h.clock.advance(1000);
  }
  await said;
});

test("an open thread's share changing there (the website's New link, Stop sharing) is said to the app", async () => {
  const h = harness({ row: () => ({ ...idle, share: { access: 'link', slug: 'abc' } }) });
  await h.relay.call(T, 'threads.subscribe', { threadId: T, afterSeq: 0 });
  const said = () => h.published.filter((n) => (n as { method: string }).method === 'thread.updated').map((n) => (n as { params: { thread: { id: string; runnerId: string; share?: unknown } } }).params.thread);
  // Opened, and it's shared: the app hears so, as the sidebar's rows never say.
  assert.deepEqual(said().map((t) => [t.id, t.runnerId, t.share]), [[T, 'bruce', { access: 'link', slug: 'abc' }]]);
  const row = h.subs.get('relay:remoteThread')![0]!;
  row.onUpdate({ ...idle, status: 'running', share: { access: 'link', slug: 'abc' } });
  assert.equal(said().length, 1, 'nothing new about the share, nothing said');
  row.onUpdate({ ...idle, share: { access: 'link', slug: 'def' } });
  row.onUpdate({ ...idle, share: { access: 'people', slug: 'def' } });
  assert.deepEqual(said().slice(1).map((t) => t.share), [{ access: 'link', slug: 'def' }, { access: 'off', slug: 'def' }]);
  // An app that subscribes again (relaunched) hears it again, as it may not know.
  await h.relay.call(T, 'threads.subscribe', { threadId: T, afterSeq: 0 });
  assert.equal(said().length, 4);
  // A thread never shared says nothing on opening.
  const plain = harness();
  await plain.relay.call(T, 'threads.subscribe', { threadId: T, afterSeq: 0 });
  assert.equal(plain.published.filter((n) => (n as { method: string }).method === 'thread.updated').length, 0);
});

test("stopping a share that Convex doesn't show yet says so, rather than seeming done", async () => {
  const h = harness({ row: () => ({ ...idle, share: { access: 'link', slug: 'abc' } }) });
  const off = h.relay.call(T, 'threads.share', { threadId: T, access: 'off' });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done' });
  const said = assert.rejects(off, /has stopped sharing it, but Convex doesn't show that yet/);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    h.clock.advance(1000);
  }
  await said;
});

test('a failed command says why, and an offline runner is said at once', async () => {
  const h = harness();
  const p = h.relay.call(T, 'threads.update', { threadId: T, archived: true });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'failed', note: 'No thread' });
  await assert.rejects(p, /No thread/);
  const off = harness({ online: false });
  await assert.rejects(off.relay.call(T, 'threads.send', { threadId: T, text: 'x' }), /bruce is offline/);
  assert.equal(off.calls.length, 0);
});

test("a new thread there, a folder there and that runner's logins", async () => {
  const h = harness();
  const made = h.relay.create('bruce', { text: 'Start', cwd: '/Users/b/x', runnerId: 'bruce' });
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done', threadId: 'new1' });
  assert.equal(((await made) as { thread: { id: string } }).thread.id, 'new1');
  assert.deepEqual(h.calls.at(-1)!.args, { key: 'owner', runnerId: 'bruce', kind: 'create', args: { text: 'Start', cwd: '/Users/b/x' } });
  const list = h.relay.listFolder('bruce', '/Users/b');
  await new Promise((r) => setImmediate(r));
  h.subs.get('relay:commandState')![1]!.onUpdate({ state: 'done', result: { path: '/Users/b', entries: [], truncated: false } });
  assert.deepEqual(await list, { path: '/Users/b', entries: [], truncated: false });
  assert.deepEqual(h.calls.at(-1)!.args.args, { method: 'files.list', params: { path: '/Users/b' } });
  const logins = await h.relay.logins('bruce');
  assert.equal(logins.defaults.cwd, '/Users/b/x');
  assert.deepEqual(logins.accounts, [{ id: 'claude-main', provider: 'claude', title: 'Claude', configDir: '' }]);
});

test('an opened tool fills in from its body: its real call, result and diffs, in seqs of their own', () => {
  const bodies = new Map([[14, { state: 'text' as const, text: 'all passed', ok: true, input: JSON.stringify({ command: 'npm test' }), diffs: JSON.stringify([{ path: 'a.ts', hunks: [] }, { path: 'b.ts', hunks: [] }, { path: 'c.ts', hunks: [] }]), images: 2 }]]);
  const ev = relayEvents(T, rows, idle, [], false, 'bruce', true, bodies);
  const of = (n: number) => ev.find((e) => e.seq === 14 * SCALE + n) as Record<string, unknown> | undefined;
  assert.equal(of(2)!.type, 'tool.result', 'the stub stays, and is replaced by itemId');
  assert.deepEqual(of(5)!.input, { command: 'npm test' });
  assert.equal(of(5)!.itemId, of(2)!.itemId);
  assert.equal(of(3)!.path, 'a.ts');
  assert.equal(of(4)!.path, 'b.ts');
  assert.match(String(of(6)!.text), /all passed[\s\S]*Also changed: c\.ts[\s\S]*2 pictures are kept on bruce/);
  assert.equal(of(6)!.heldBack, undefined, 'nothing more to ask for');
  assert.equal(new Set(ev.map((e) => e.seq)).size, ev.length, 'every seq once');
  assert.deepEqual(ev.map((e) => e.seq), [...ev.map((e) => e.seq)].sort((a, b) => a - b));
});

test("a body that's withheld says so, and one that's missing changes nothing", () => {
  const withheld = relayEvents(T, rows, idle, [], false, 'bruce', true, new Map([[14, { state: 'withheld' as const, reason: 'environment' }]]));
  assert.match(String((withheld.find((e) => e.seq === 14 * SCALE + 6) as { text?: string }).text), /can hold secrets/);
  const plain = relayEvents(T, rows, idle, [], false, 'bruce');
  for (const body of [null, { state: 'expired' as const }]) assert.deepEqual(relayEvents(T, rows, idle, [], false, 'bruce', true, new Map([[14, body]])), plain);
});

test("a card from an older runner keeps its seqs: the body's diffs make way", () => {
  const card = { pending: { approvalId: 'a', kind: 'approval' as const, name: 'Bash', title: 'x', options: [] }, slot: 14 * SCALE + 3 };
  const ev = relayEvents(T, rows, idle, [card], false, 'bruce', true, new Map([[14, { state: 'text' as const, text: 'x', diffs: JSON.stringify([{ path: 'a.ts', hunks: [] }]) }]]));
  assert.equal(new Set(ev.map((e) => e.seq)).size, ev.length);
  assert.match(String((ev.find((e) => e.seq === 14 * SCALE + 6) as { text?: string }).text), /Also changed: a\.ts/);
});

test("an agent's archive goes to that runner with by: agent", async () => {
  const h = harness();
  h.subscribed.add(T);
  const done = h.relay.call(T, 'threads.update', { threadId: T, archived: true, archivedBy: 'agent' });
  await new Promise((r) => setImmediate(r));
  for (const s of h.subs.get('relay:commandState') ?? []) s.onUpdate({ state: 'done' });
  await done;
  const q = h.calls.find((c) => c.fn === 'relay:queueCommand')!;
  assert.deepEqual(q.args.args, { archive: true, by: 'agent' });
});

// Daybreak, 7 Nov 2026 ("Remote Plan first threads silently start with full
// access"): Relay.create forwarded only ask, full and auto, so a Plan first
// thread started on another Mac went with no mode and got full access.
test('a new thread there keeps every mode; Plan first goes as Ask plus a flag, and an unknown mode is refused', async () => {
  const sent = async (permissionMode: unknown) => {
    const h = harness();
    const made = h.relay.create('bruce', { text: 'Start', permissionMode });
    await new Promise((r) => setImmediate(r));
    h.subs.get('relay:commandState')![0]!.onUpdate({ state: 'done', threadId: 'new1' });
    await made;
    return h.calls.filter((c) => c.fn === 'relay:queueCommand').at(-1)!.args.args as Record<string, unknown>;
  };
  for (const mode of ['full', 'ask', 'auto'] as const) assert.deepEqual(await sent(mode), { text: 'Start', permissionMode: mode });
  const plan = await sent('plan');
  assert.deepEqual(plan, { text: 'Start', permissionMode: 'ask', plan: true });
  // What a runner from before Plan first reads of it: Ask, never the full-access default.
  const oldReceiver = (a: Record<string, unknown>) => (a.permissionMode === 'ask' || a.permissionMode === 'full' || a.permissionMode === 'auto' ? a.permissionMode : 'full');
  assert.equal(oldReceiver(plan), 'ask');
  assert.deepEqual(await sent(undefined), { text: 'Start' });
  const h = harness();
  await assert.rejects(h.relay.create('bruce', { text: 'Start', permissionMode: 'yolo' }), /permissionMode must be one of/);
  assert.equal(h.calls.filter((c) => c.fn === 'relay:queueCommand').length, 0, 'nothing queued');
});
