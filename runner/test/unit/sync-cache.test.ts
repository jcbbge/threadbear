// What the mirror writes again when a runner restarts, and the writes it now
// leaves out (docs/convex-backend.md, "Usage and the free plan"). The cost was
// real: 12 to 15 starts a day, each rewriting all of Mike's 710 thread rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { ConvexSync, BACKEND_API_VERSION, HEARTBEAT_MS, MISSING_GRACE_MS, PREVIEW_HOLD_MS, SETTLE_MS, USAGE_COPY_MS, PROJECT_ACTIVITY_MS, type ThreadDoc } from '../../src/sync.ts';
import { loadSyncCache, SYNC_CACHE_MAX_AGE_MS } from '../../src/sync-cache.ts';
import { nullLogger } from '../../src/log.ts';

type Call = { kind: string; fn: string; args: Record<string, unknown> };

function setup(opts: { apiVersion?: number; firstSeen?: () => boolean; heads?: { threadId: string; lastSeq: number }[] } = {}) {
  const h = makeHarness();
  const cachePath = path.join(tmpDir('tb-sync-cache-'), 'sync-sent.json');
  const statePath = path.join(path.dirname(cachePath), 'sync-state.json');
  const calls: Call[] = [];
  const firstSeen = { value: false };
  const failing: { value?: string } = {};
  const holdRemove: { value?: Promise<void> } = {};
  const holdUpsert: { value?: Promise<void> } = {};
  const failUpsert = { value: false };
  const icon: { value?: string } = {};
  const rejectIcon = { value: false };
  const apiVersion = { value: opts.apiVersion ?? BACKEND_API_VERSION };
  // The mirror's rows shared by link (sync:sharedThreads), and the threads
  // still finishing on the release before (a handover).
  const shared = { value: [] as string[] };
  const elsewhere = new Set<string>();
  const make = () =>
    new ConvexSync({
      config: { enabled: true, url: 'https://x.convex.cloud', name: 'TestMac', runnerId: 'r1', ...(icon.value ? { icon: icon.value } : {}) },
      key: 'k',
      runner: h.runner,
      version: '0.1.0+test',
      startedAt: '2026-10-27T00:00:00.000Z',
      clock: h.clock,
      log: nullLogger,
      cachePath,
      statePath,
      home: h.home,
      subscriber: { subscribe: () => () => {}, close: async () => {} },
      elsewhere: (id) => elsewhere.has(id),
      elsewhereIds: () => [...elsewhere],
      post: async (kind, fn, args) => {
        calls.push({ kind, fn, args });
        if (fn === failing.value) throw new Error('down');
        if (fn === 'sync:removeThreads' && holdRemove.value) await holdRemove.value;
        if (fn === 'sync:upsertThreads' && holdUpsert.value) await holdUpsert.value;
        if (fn === 'sync:upsertThreads' && failUpsert.value) throw new Error('down');
        if (fn === 'sync:heartbeat') {
          if (rejectIcon.value && (args.runner as { icon?: string }).icon) throw new Error('ArgumentValidationError: icon');
          return { apiVersion: apiVersion.value, ...(firstSeen.value || opts.firstSeen?.() ? { firstSeen: true } : {}) };
        }
        if (fn === 'sync:messageHeads') return opts.heads ?? [];
        if (fn === 'sync:sharedThreads') return shared.value;
        return null;
      },
    });
  const named = (fn: string) => calls.filter((c) => c.fn === fn);
  const docs = () => named('sync:upsertThreads').flatMap((c) => c.args.threads as ThreadDoc[]);
  return { h, make, calls, named, docs, cachePath, firstSeen, failing, holdRemove, holdUpsert, failUpsert, icon, rejectIcon, apiVersion, shared, elsewhere };
}

const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function firstStart(s: ReturnType<typeof setup>) {
  const sync = s.make();
  sync.start();
  await settle(); // the heartbeat's answer says which backend this is
  await sync.flushNow();
  s.h.clock.advance(2000);
  await settle();
  await sync.flushNow();
  await sync.stop();
  return sync;
}

test('a restart with nothing changed writes nothing and reads no thread rows', async () => {
  const s = setup();
  for (const text of ['one', 'two', 'three']) s.h.runner.create({ text, cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' });
  await firstStart(s);
  assert.equal(s.named('sync:prune').length, 1);
  assert.ok(s.docs().length >= 3);
  assert.ok(fs.existsSync(s.cachePath));

  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  s.h.clock.advance(2000);
  await settle();
  await again.flushNow();
  for (const fn of ['sync:upsertThreads', 'sync:prune', 'sync:messageHeads', 'sync:setProjects', 'sync:setThreadIndex', 'sync:setAccounts']) {
    assert.deepEqual(s.named(fn), [], `${fn} on a restart with nothing changed`);
  }
  assert.equal(s.named('sync:heartbeat').length, 1);
  await again.stop();
});

test('a restart writes the thread that changed while it was down, and its new messages', async () => {
  const s = setup();
  const a = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const b = s.h.runner.create({ text: 'two', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  await firstStart(s);
  const seqBefore = s.h.runner.get(a.id).lastSeq;

  s.h.runner.update({ threadId: a.id, title: 'Renamed while down' });
  s.h.runner.send(a.id, 'a new message while down');
  await settle();

  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  s.h.clock.advance(2000);
  await settle();
  await again.flushNow();
  assert.deepEqual([...new Set(s.docs().map((d) => d.threadId))], [a.id]);
  assert.equal(s.docs().at(-1)!.title, 'Renamed while down');
  assert.ok(!s.docs().some((d) => d.threadId === b.id));
  const sent = s.named('sync:appendMessages').flatMap((c) => c.args.messages as { threadId: string; seq: number; text: string }[]);
  assert.ok(sent.some((m) => m.threadId === a.id && m.seq > seqBefore && m.text === 'a new message while down'), 'the new message went up');
  assert.ok(!sent.some((m) => m.seq <= seqBefore && m.threadId === a.id), 'older ones did not go again');
  await again.stop();
});

test('once the file is too old, or for another deployment, a start writes everything', async () => {
  const s = setup();
  s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' });
  await firstStart(s);
  const now = s.h.clock.now();
  assert.ok(loadSyncCache(s.cachePath, { url: 'https://x.convex.cloud', runnerId: 'r1', now }));
  assert.equal(loadSyncCache(s.cachePath, { url: 'https://other.convex.cloud', runnerId: 'r1', now }), undefined);
  assert.equal(loadSyncCache(s.cachePath, { url: 'https://x.convex.cloud', runnerId: 'other', now }), undefined);
  assert.equal(loadSyncCache(s.cachePath, { url: 'https://x.convex.cloud', runnerId: 'r1', now: now + SYNC_CACHE_MAX_AGE_MS }), undefined);

  s.calls.length = 0;
  s.h.clock.advance(SYNC_CACHE_MAX_AGE_MS);
  const again = s.make();
  again.start();
  await settle();
  await again.flushNow();
  assert.equal(s.named('sync:prune').length, 1);
  assert.ok(s.docs().length >= 1);
  await again.stop();
});

test('a damaged file is a full write, not a failure', async () => {
  const s = setup();
  s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' });
  fs.writeFileSync(s.cachePath, '{not json');
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  assert.equal(s.named('sync:prune').length, 1);
  await sync.stop();
});

test('a deployment that has never met this runner gets everything again', async () => {
  let first = false;
  const s = setup({ firstSeen: () => first });
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  await firstStart(s);

  s.calls.length = 0;
  first = true;
  const again = s.make();
  again.start();
  await settle();
  await again.flushNow();
  assert.ok(s.docs().some((d) => d.threadId === t.id), 'the row went again');
  assert.equal(s.named('sync:prune').length, 1);
  await again.stop();
});

test('a restart during that recovery keeps recovering, sidebar rows included', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  await firstStart(s);
  assert.ok(fs.existsSync(s.cachePath));

  // The deployment has lost everything, and this start stops before writing.
  s.firstSeen.value = true;
  s.calls.length = 0;
  const one = s.make();
  one.start();
  await settle();
  assert.equal(fs.existsSync(s.cachePath), false, 'what it remembered goes at once');
  await one.stop();

  // firstSeen is false from here on: the row exists now.
  s.firstSeen.value = false;
  s.calls.length = 0;
  const two = s.make();
  two.start();
  await settle();
  await two.flushNow();
  s.h.clock.advance(1500);
  await settle();
  assert.ok(s.docs().some((d) => d.threadId === t.id), 'thread rows went');
  const index = s.named('sync:setThreadIndex');
  assert.ok(index.some((c) => (c.args.rows as { threadId: string }[]).some((r) => r.threadId === t.id)), 'sidebar rows went');
  await two.stop();
});

test('a removal that failed is still tried after a restart', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(1500);
  await settle();
  s.failing.value = 'sync:removeThreads';
  s.h.runner.delete(t.id);
  await settle();
  await sync.flushNow();
  await sync.stop();
  s.failing.value = undefined;
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  await again.flushNow();
  assert.deepEqual(s.named('sync:removeThreads')[0]?.args.threadIds, [t.id]);
  await again.stop();
});

test('a removal still on its way when the file is saved is in it', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(1500);
  await settle();
  let release!: () => void;
  s.holdRemove.value = new Promise<void>((r) => (release = r));
  s.h.runner.delete(t.id);
  s.h.clock.advance(2100);
  await settle();
  assert.equal(s.named('sync:removeThreads').length, 1, 'on its way');
  s.h.clock.advance(31_000); // the save's timer
  await settle();
  const c = loadSyncCache(s.cachePath, { url: 'https://x.convex.cloud', runnerId: 'r1', now: s.h.clock.now() })!;
  assert.deepEqual(c.removed, [t.id]);
  s.holdRemove.value = undefined;
  release();
  await settle();
  await sync.stop();
});

test('a thread the file says was removed, turning up by handover, is not deleted', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(1500);
  await settle();
  const row = s.h.runner.get(t.id);
  s.failing.value = 'sync:removeThreads';
  s.h.runner.delete(t.id);
  await settle();
  await sync.flushNow();
  await sync.stop();
  s.failing.value = undefined;
  s.calls.length = 0;
  const again = s.make();
  again.start();
  s.h.runner.publish({ method: 'thread.updated', params: { thread: row } });
  await settle();
  await again.flushNow();
  assert.deepEqual(s.named('sync:removeThreads'), []);
  await again.stop();
});

test('a removal waiting behind another write is in the file, and a thread turning up cancels it', async () => {
  const s = setup();
  const gone = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const other = s.h.runner.create({ text: 'two', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(1500);
  await settle();
  const goneRow = s.h.runner.get(gone.id);
  s.failing.value = 'sync:removeThreads';
  s.h.runner.delete(gone.id);
  await settle();
  await sync.flushNow();
  await sync.stop();
  s.failing.value = undefined;

  // Starts knowing the removal; a write is held up as it flushes.
  let release!: () => void;
  s.holdUpsert.value = new Promise<void>((r) => (release = r));
  s.calls.length = 0;
  const again = s.make();
  again.start();
  s.h.runner.update({ threadId: other.id, title: 'Changed' });
  await settle();
  const flushing = again.flushNow();
  await settle();
  assert.equal(s.named('sync:upsertThreads').length, 1, 'held up');
  s.h.runner.publish({ method: 'thread.updated', params: { thread: goneRow } });
  s.holdUpsert.value = undefined;
  release();
  await flushing;
  await settle();
  assert.deepEqual(s.named('sync:removeThreads'), [], 'the thread that turned up is not deleted');
  await again.stop();
});

test('a start with a record waits for rows to settle before comparing', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  await firstStart(s);
  const row = s.h.runner.get(t.id);
  s.calls.length = 0;
  const again = s.make();
  again.start();
  // As a thread looks before its patch links have loaded, then with them.
  s.h.runner.publish({ method: 'thread.updated', params: { thread: { ...row, title: 'Not loaded yet' } } });
  s.h.clock.advance(SETTLE_MS - 1);
  await settle();
  s.h.runner.publish({ method: 'thread.updated', params: { thread: row } });
  s.h.clock.advance(1);
  await settle();
  s.h.clock.advance(3000);
  await settle();
  assert.deepEqual(s.docs(), [], 'nothing to write once it has');
  // And a real change after that goes as it always did.
  s.h.runner.update({ threadId: t.id, title: 'Really changed' });
  s.h.clock.advance(3000);
  await settle();
  assert.equal(s.docs().at(-1)?.title, 'Really changed');
  await again.stop();
});

test('a thread changing back while its write is on the way goes again', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(PREVIEW_HOLD_MS + 3000);
  await settle();
  await sync.flushNow();
  const row = s.h.runner.get(t.id);
  s.calls.length = 0;
  let release!: () => void;
  s.holdUpsert.value = new Promise<void>((r) => (release = r));
  s.h.runner.publish({ method: 'thread.updated', params: { thread: { ...row, title: 'Passing' } } });
  s.h.clock.advance(3000);
  await settle();
  assert.equal(s.named('sync:upsertThreads').length, 1, 'on its way');
  s.h.runner.publish({ method: 'thread.updated', params: { thread: row } });
  s.holdUpsert.value = undefined;
  release();
  await settle();
  s.h.clock.advance(3000);
  await settle();
  assert.equal(s.docs().at(-1)!.title, row.title, 'the mirror ends on the real title');
  await sync.stop();
});

test('a new thread goes up straight away while settling, so its push can fire', async () => {
  const s = setup();
  s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' });
  await firstStart(s);
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  const t = s.h.runner.create({ text: 'new while settling', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  s.h.clock.advance(2100);
  await settle();
  assert.ok(s.docs().some((d) => d.threadId === t.id));
  await again.stop();
});

test('a write that fails after the thread went back retries the thread as it is', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(PREVIEW_HOLD_MS + 3000);
  await settle();
  await sync.flushNow();
  const row = s.h.runner.get(t.id);
  s.calls.length = 0;
  let release!: () => void;
  s.holdUpsert.value = new Promise<void>((r) => (release = r));
  s.failUpsert.value = true;
  s.h.runner.publish({ method: 'thread.updated', params: { thread: { ...row, title: 'Passing' } } });
  s.h.clock.advance(3000);
  await settle();
  s.h.runner.publish({ method: 'thread.updated', params: { thread: row } });
  s.holdUpsert.value = undefined;
  release();
  await settle();
  s.failUpsert.value = false;
  s.calls.length = 0;
  s.h.clock.advance(6000);
  await settle();
  assert.deepEqual(s.docs().filter((d) => d.title === 'Passing'), [], 'what failed is not written later');
  await sync.stop();
});

test('a heartbeat lost to the network keeps the version from the file', async () => {
  const s = setup();
  s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' });
  await firstStart(s);
  s.failing.value = 'sync:heartbeat';
  const again = s.make();
  again.start();
  await settle();
  assert.equal(again.status().backend?.apiVersion, BACKEND_API_VERSION);
  s.failing.value = undefined;
  await again.stop();
});

test('a backend older than the file says can still be learned', async () => {
  const s = setup();
  s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' });
  await firstStart(s);
  // An old backend's validator turns the heartbeat down for carrying `icon`,
  // which only goes to one known to take it.
  s.icon.value = 'macmini';
  s.rejectIcon.value = true;
  s.apiVersion.value = 5;
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  assert.ok(s.named('sync:heartbeat').at(-1)!.args.runner && (s.named('sync:heartbeat').at(-1)!.args.runner as { icon?: string }).icon, 'first try: with the icon, from the file');
  s.h.clock.advance(HEARTBEAT_MS);
  await settle();
  assert.equal((s.named('sync:heartbeat').at(-1)!.args.runner as { icon?: string }).icon, undefined, 'then without');
  assert.equal(again.status().backend?.apiVersion, 5);
  await again.stop();
});

test('a thread deleted while running is gone from the file, so it does not come back as known', async () => {
  const s = setup();
  const a = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.runner.delete(a.id);
  await settle();
  await sync.flushNow();
  await sync.stop();
  const c = loadSyncCache(s.cachePath, { url: 'https://x.convex.cloud', runnerId: 'r1', now: s.h.clock.now() })!;
  assert.equal(c.threads[a.id], undefined);
});

test('a preview moving alone waits; anything else takes it along straight away', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(2000);
  await settle();
  await sync.flushNow();
  const row = () => s.h.runner.get(t.id);
  const say = (preview: string, extra: Record<string, unknown> = {}) => s.h.runner.publish({ method: 'thread.updated', params: { thread: { ...row(), preview, ...extra } } });

  s.calls.length = 0;
  say('thinking about it');
  say('still thinking');
  s.h.clock.advance(PREVIEW_HOLD_MS - 2100);
  await settle();
  assert.equal(s.docs().length, 0, 'nothing yet');
  s.h.clock.advance(2200);
  await settle();
  s.h.clock.advance(2100);
  await settle();
  assert.equal(s.docs().length, 1);
  assert.equal(s.docs()[0]!.preview, 'still thinking', 'the latest one, once');

  s.calls.length = 0;
  say('another line');
  say('another line', { title: 'New title' });
  s.h.clock.advance(2100);
  await settle();
  const sent = s.docs();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.title, 'New title');
  assert.equal(sent[0]!.preview, 'another line', 'the preview rode along');
  await sync.stop();
});

test('an unread dot that flips back before the hold is up costs no write', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'one', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  s.h.clock.advance(2000);
  await settle();
  await sync.flushNow();
  const was = s.h.runner.get(t.id);
  s.calls.length = 0;
  s.h.runner.publish({ method: 'thread.updated', params: { thread: { ...was, lastSeq: was.lastSeq + 5 } } });
  s.h.runner.publish({ method: 'thread.updated', params: { thread: { ...was, lastSeq: was.lastSeq + 5, lastSeenSeq: was.lastSeq + 5 } } });
  s.h.runner.publish({ method: 'thread.updated', params: { thread: was } });
  s.h.clock.advance(PREVIEW_HOLD_MS + 3000);
  await settle();
  assert.deepEqual(s.docs(), []);
  await sync.stop();
});

test('accounts: only the login that changed goes, and a reading time alone is no change', async () => {
  const s = setup();
  const acct = (id: string, remainingPercent: number, readAt = '2026-11-05T00:00:00Z') => ({ id, provider: 'claude', title: id, usage: { windows: [{ kind: 'week', title: 'Week', remainingPercent }], readAt, source: 'x' } });
  const sync = s.make();
  sync.start();
  await settle();
  const publish = (accounts: unknown[]) => s.h.runner.publish({ method: 'accounts.updated', params: { accounts } } as never);
  publish([acct('a', 50), acct('b', 50)]);
  await sync.flushNow();
  assert.equal(s.named('sync:setAccounts').at(-1)!.args.accounts && (s.named('sync:setAccounts').at(-1)!.args.accounts as unknown[]).length, 2);

  s.calls.length = 0;
  publish([acct('a', 50, '2026-11-05T01:00:00Z'), acct('b', 50, '2026-11-05T01:00:00Z')]);
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertAccounts'), []);
  assert.deepEqual(s.named('sync:setAccounts'), []);

  publish([acct('a', 40, '2026-11-05T02:00:00Z'), acct('b', 50, '2026-11-05T02:00:00Z')]);
  await sync.flushNow();
  const up = s.named('sync:upsertAccounts');
  assert.equal(up.length, 1);
  assert.deepEqual((up[0]!.args.accounts as { id: string }[]).map((a) => a.id), ['a']);
  assert.deepEqual(up[0]!.args.removed, []);

  s.calls.length = 0;
  publish([acct('a', 40, '2026-11-05T02:00:00Z')]);
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertAccounts')[0]!.args.removed, ['b']);
  await sync.stop();
});

test('a reading copied from another runner goes at most every ten minutes; its own at once', async () => {
  const s = setup();
  const acct = (remainingPercent: number, source: string, blocked = false) => ({ id: 'a', provider: 'claude', title: 'a', usage: { windows: [{ kind: 'week', title: 'Week', remainingPercent }], readAt: 'x', source, ...(blocked ? { blocked: true } : {}) } });
  const sync = s.make();
  sync.start();
  await settle();
  const publish = (a: unknown) => s.h.runner.publish({ method: 'accounts.updated', params: { accounts: [a] } } as never);
  publish(acct(50, 'live'));
  await sync.flushNow();
  publish(acct(49, 'shared')); // the first copy since starting goes
  await sync.flushNow();
  s.calls.length = 0;

  publish(acct(48, 'shared'));
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertAccounts'), [], 'held back');
  publish(acct(48, 'tokenStats'));
  await sync.flushNow();
  assert.equal(s.named('sync:upsertAccounts').length, 1, 'its own reading goes straight away');

  s.calls.length = 0;
  publish(acct(47, 'shared'));
  await sync.flushNow();
  publish(acct(46, 'shared', true));
  await sync.flushNow();
  assert.equal(s.named('sync:upsertAccounts').length, 1, 'at its limit goes straight away');

  s.calls.length = 0;
  publish(acct(45, 'shared'));
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertAccounts'), []);
  s.h.clock.advance(USAGE_COPY_MS + 3000);
  await settle();
  assert.equal(s.named('sync:upsertAccounts').length, 1, 'it does go in the end');
  await sync.stop();
});

test('its own reading after a held copy goes up, even matching what is there', async () => {
  const s = setup();
  const acct = (remainingPercent: number, source: string, readAt: string) => ({ id: 'a', provider: 'claude', title: 'a', usage: { windows: [{ kind: 'week', title: 'Week', remainingPercent }], readAt, source } });
  const sync = s.make();
  sync.start();
  await settle();
  const publish = (a: unknown) => s.h.runner.publish({ method: 'accounts.updated', params: { accounts: [a] } } as never);
  publish(acct(50, 'live', 't0'));
  await sync.flushNow();
  publish(acct(49, 'shared', 't1')); // goes: the first copy
  await sync.flushNow();
  publish(acct(48, 'shared', 't2')); // held
  await sync.flushNow();
  s.calls.length = 0;
  publish(acct(49, 'live', 't3'));
  await sync.flushNow();
  const up = s.named('sync:upsertAccounts');
  assert.equal(up.length, 1);
  assert.equal((up[0]!.args.accounts as { usage: { readAt: string } }[])[0]!.usage.readAt, 't3');
  await sync.stop();
});

test('an older backend still gets the whole account list when one changes', async () => {
  const s = setup({ apiVersion: 36 });
  const acct = (id: string, remainingPercent: number) => ({ id, provider: 'claude', title: id, usage: { windows: [{ kind: 'week', title: 'Week', remainingPercent }], readAt: 'x', source: 'x' } });
  const sync = s.make();
  sync.start();
  await settle();
  s.h.runner.publish({ method: 'accounts.updated', params: { accounts: [acct('a', 50), acct('b', 50)] } } as never);
  await sync.flushNow();
  s.calls.length = 0;
  s.h.runner.publish({ method: 'accounts.updated', params: { accounts: [acct('a', 40), acct('b', 50)] } } as never);
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertAccounts'), []);
  assert.equal((s.named('sync:setAccounts')[0]!.args.accounts as unknown[]).length, 2);
  await sync.stop();
});

test('a project moving only by last activity goes at most every ten minutes, and then does go', async () => {
  const s = setup();
  const project = (lastActivityAt: string, title = 'P') => ({ id: 'p1', title, folders: [], goals: '', state: '', notes: '', createdBy: 'mike', archived: false, createdAt: 'x', updatedAt: 'x', threadCount: 1, lastActivityAt });
  const sync = s.make();
  sync.start();
  await settle();
  const publish = (p: unknown) => s.h.runner.publish({ method: 'projects.updated', params: { projects: [p] } } as never);
  publish(project('t0'));
  await sync.flushNow();
  publish(project('t1'));
  await sync.flushNow(); // the first one since starting goes
  s.calls.length = 0;
  publish(project('t2'));
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertProjects'), [], 'held back');

  publish(project('t2', 'Renamed'));
  await sync.flushNow();
  assert.equal(s.named('sync:upsertProjects').length, 1, 'a real change goes at once, with the time');

  s.calls.length = 0;
  publish(project('t3', 'Renamed'));
  await sync.flushNow();
  assert.deepEqual(s.named('sync:upsertProjects'), []);
  s.h.clock.advance(PROJECT_ACTIVITY_MS + 2100);
  await settle();
  await sync.flushNow();
  const sent = s.named('sync:upsertProjects');
  assert.equal(sent.length, 1, 'it does go in the end, with no further change needed');
  assert.equal((sent[0]!.args.projects as { lastActivityAt: string }[])[0]!.lastActivityAt, 't3');
  await sync.stop();
});

test('a row with a secret in it is not written again by a restart', async () => {
  const s = setup();
  const secret = `sk-${'a1b2'.repeat(12)}`;
  const t = s.h.runner.create({ text: `use ${secret}`, cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  s.h.runner.update({ threadId: t.id, title: `about ${secret}` });
  await firstStart(s);
  assert.ok(s.docs().some((d) => d.threadId === t.id && d.title === 'about [REDACTED]'));
  assert.ok(!JSON.stringify(s.docs()).includes(secret));
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  s.h.clock.advance(2000);
  await settle();
  await again.flushNow();
  assert.deepEqual(s.named('sync:upsertThreads'), []);
  assert.deepEqual(s.named('sync:appendMessages'), []);
  await again.stop();
});

// Daybreak, 6 Nov 2026 ("Cached restarts leave deleted shared threads publicly
// accessible"): a shared thread deleted while sync was off never reached the
// mirror's removals, and a start from the file skipped the prune, so its link
// stayed readable by anyone with the slug.
test('a thread deleted while sync was off is taken out of the mirror by a start from the file', async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'private', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const kept = s.h.runner.create({ text: 'kept', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  s.h.runner.share(t.id, { access: 'link' });
  await firstStart(s);
  assert.ok(s.docs().some((d) => d.threadId === t.id && d.share?.access === 'link'));
  // Sync off (nothing listening), the thread deleted.
  s.h.runner.delete(t.id);
  s.shared.value = [t.id];
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  s.h.clock.advance(SETTLE_MS);
  await settle();
  await again.flushNow();
  await again.flushNow();
  assert.deepEqual(s.named('sync:removeThreads'), [], 'not straight away: it may be between releases');
  s.h.clock.advance(MISSING_GRACE_MS);
  await settle();
  await again.flushNow();
  assert.ok(s.named('sync:removeThreads').some((c) => (c.args.threadIds as string[]).includes(t.id)), 'its row goes');
  assert.ok(!s.named('sync:removeThreads').some((c) => (c.args.threadIds as string[]).includes(kept.id)));
  await again.stop();
  const c = loadSyncCache(s.cachePath, { url: 'https://x.convex.cloud', runnerId: 'r1', now: s.h.clock.now() })!;
  assert.equal(c.threads[t.id], undefined, 'and the file no longer says the mirror has it');
});

test("a thread finishing on the release before isn't taken out for not being here yet", async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'busy', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  s.h.runner.share(t.id, { access: 'link' });
  await firstStart(s);
  const row = s.h.runner.get(t.id);
  s.h.runner.delete(t.id);
  s.elsewhere.add(t.id);
  s.shared.value = [t.id];
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  s.h.clock.advance(SETTLE_MS);
  await settle();
  await again.flushNow();
  await again.flushNow();
  assert.deepEqual(s.named('sync:removeThreads'), []);
  assert.deepEqual(s.named('sync:upsertThreads'), []);
  s.h.clock.advance(MISSING_GRACE_MS);
  await settle();
  await again.flushNow();
  assert.deepEqual(s.named('sync:removeThreads'), []);
  s.h.runner.publish({ method: 'thread.updated', params: { thread: row } });
  await again.stop();
});

// From the cross-lab review (Codex, 7 Nov 2026): a draining release whose
// connection drops is let go of a few seconds before its threads are taken in,
// so a thread can be neither here nor elsewhere for a moment. Its row (and its
// messages) wait out MISSING_GRACE_MS, and it turning up cancels that.
test("a thread missing for a moment at a start from the file isn't taken out", async () => {
  const s = setup();
  const t = s.h.runner.create({ text: 'between releases', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  s.h.runner.share(t.id, { access: 'link' });
  await firstStart(s);
  const row = s.h.runner.get(t.id);
  s.h.runner.delete(t.id);
  s.shared.value = [t.id];
  s.calls.length = 0;
  const again = s.make();
  again.start();
  await settle();
  s.h.clock.advance(SETTLE_MS);
  await settle();
  await again.flushNow();
  s.h.clock.advance(10_000);
  s.h.runner.publish({ method: 'thread.updated', params: { thread: row } });
  await settle();
  s.h.clock.advance(MISSING_GRACE_MS);
  await settle();
  await again.flushNow();
  assert.deepEqual(s.named('sync:removeThreads'), []);
  await again.stop();
});

test("a full write's prune keeps the threads finishing on the release before", async () => {
  const s = setup();
  const here = s.h.runner.create({ text: 'here', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  s.elsewhere.add('busy-on-the-old-release');
  const sync = s.make();
  sync.start();
  await settle();
  await sync.flushNow();
  const keep = s.named('sync:prune')[0]?.args.keep as string[];
  assert.ok(keep.includes(here.id) && keep.includes('busy-on-the-old-release'), JSON.stringify(keep));
  await sync.stop();
});

// The same leak from the other side: the mirror has a link the runner stopped
// (its write lost after it landed, or never sent), and the file says "off" went.
for (const start of ['from the file', 'in full'] as const) {
  test(`a share the mirror still has is stopped by the next start, ${start}, and every hour after`, async () => {
    const s = setup();
    const t = s.h.runner.create({ text: 'private', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
    s.h.runner.share(t.id, { access: 'link' });
    s.h.runner.share(t.id, { access: 'off' });
    await firstStart(s);
    if (start === 'in full') fs.rmSync(s.cachePath);
    s.shared.value = [t.id];
    s.calls.length = 0;
    const again = s.make();
    again.start();
    await settle();
    s.h.clock.advance(SETTLE_MS);
    await settle();
    await again.flushNow();
    await again.flushNow();
    const offs = () => s.docs().filter((d) => d.threadId === t.id && d.share?.access === 'off').length;
    assert.ok(offs() >= 1, 'its row goes again, off');
    // Still running, it happens again (a write lost meanwhile): the hourly check finds it.
    s.calls.length = 0;
    s.h.clock.advance(61 * 60_000);
    await settle();
    await again.flushNow();
    await again.flushNow();
    assert.equal(s.named('sync:sharedThreads').length, 1, 'checked again within the hour');
    assert.ok(offs() >= 1, "written off again");
    await again.stop();
  });
}
