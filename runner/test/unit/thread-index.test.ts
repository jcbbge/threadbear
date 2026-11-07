// The sidebar table (src/thread-index.ts, step 6 part 2) against a fake
// backend: what it writes, when it doesn't, and what the app hears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { ThreadIndex, runnerTokenFile, type RemoteThreads } from '../../src/thread-index.ts';
import { nullLogger } from '../../src/log.ts';
import type { Notification } from '../../src/runner.ts';

function setup(takesStartedBy?: () => boolean, appConnected?: () => boolean, takesAsked?: () => boolean) {
  const h = makeHarness();
  const writes: { rows: { threadId: string; title: string; preview: string; status: string }[]; removed: string[]; keep?: string[] }[] = [];
  let onRemote: ((v: unknown) => void) | undefined;
  let subscriptions = 0;
  const heard: RemoteThreads[] = [];
  const index = new ThreadIndex({
    post: async (_kind, fn, args) => {
      if (fn === 'sync:setThreadIndex') writes.push(args as never);
      return null;
    },
    subscribe: (fn, args, onUpdate) => {
      assert.equal(fn, 'sync:otherRunnersThreads');
      assert.deepEqual(args, { key: 'k', runnerId: 'r-m5' });
      onRemote = onUpdate;
      subscriptions++;
      return () => {
        onRemote = undefined;
      };
    },
    key: 'k',
    runnerId: 'r-m5',
    home: h.home,
    host: h.runner,
    publish: (n: Notification) => n.method === 'remoteThreads.updated' && heard.push(n.params),
    clock: h.clock,
    log: nullLogger,
    ...(takesStartedBy ? { takesStartedBy } : {}),
    ...(appConnected ? { appConnected } : {}),
    ...(takesAsked ? { takesAsked } : {}),
  });
  const flush = async () => {
    h.clock.advance(1500);
    await tick();
  };
  return { h, index, writes, heard, flush, remote: (v: unknown) => onRemote?.(v), watching: () => Boolean(onRemote), subscriptions: () => subscriptions };
}

test('the first write has every thread and prunes the rest; later ones only what a sidebar shows', async () => {
  const { h, index, writes, flush } = setup();
  const { thread } = h.runner.create({ text: 'Fix the deploy', accountId: 'claude-3' });
  index.start();
  await flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.keep, [thread.id]);
  assert.equal(writes[0]!.rows[0]!.threadId, thread.id);

  // A turn going: once it's running and has said something (it's unread
  // now), more replies move only the preview and last activity. No write.
  const s = h.adapter.last;
  s.init();
  s.text('a1', 'Looking at the logs now');
  await flush();
  const settled = writes.length;
  assert.ok(settled >= 2, 'starting the turn changed its status');
  s.delta('a2', 'And the config');
  s.text('a2', 'And the config too');
  await flush();
  s.text('a3', 'Found it');
  await flush();
  assert.equal(writes.length, settled, 'new replies alone write nothing');

  // A rename does.
  h.runner.update({ threadId: thread.id, title: 'Deploy fix' });
  await flush();
  assert.equal(writes.at(-1)!.rows[0]!.title, 'Deploy fix');
  assert.equal(writes.at(-1)!.keep, undefined);

  // So does deleting it.
  h.runner.delete(thread.id);
  await flush();
  assert.deepEqual(writes.at(-1)!.removed, [thread.id]);
  index.stop();
});

test('other runners’ threads reach the app, with a token file only when one was copied in', async () => {
  const { h, index, heard, remote } = setup();
  index.start();
  const lastSeenAt = h.clock.now() - 30_000;
  const value = {
    runners: [{ runnerId: 'r-bruce', name: 'bruce', icon: 'macmini', lastSeenAt, rpcUrl: 'wss://bruce.example.ts.net:8797/rpc' }],
    threads: [{ runnerId: 'r-bruce', threadId: 't1', title: 'Birthday check', cwd: '/Users/bruce', accountId: 'codex-main', provider: 'codex', status: 'idle', needsYou: false, unread: true, preview: 'No birthdays', createdAt: 'c', lastActivityAt: 'l' }],
  };
  remote(value);
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0]!.runners, [{ id: 'r-bruce', name: 'bruce', icon: 'macmini', online: true, lastSeenAt: new Date(lastSeenAt).toISOString(), rpcUrl: 'wss://bruce.example.ts.net:8797/rpc' }]);
  assert.equal(heard[0]!.threads[0]!.title, 'Birthday check');

  const file = runnerTokenFile(h.home, 'r-bruce');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'secret\n', { mode: 0o600 });
  assert.equal(index.list().runners[0]!.tokenFile, file);
  index.stop();
});

test('a row carries who started the thread, once the backend takes it, and goes again when it does', async () => {
  let takes = false;
  const { h, index, writes, flush } = setup(() => takes);
  const from = h.runner.create({ text: 'The parent', accountId: 'claude-3' }).thread;
  const { thread } = h.runner.create({ text: 'Fix it', accountId: 'claude-3', startedBy: { kind: 'thread', label: 'Agent', threadId: from.id, why: 'fixing a hook' } });
  index.start();
  await flush();
  const row = () => writes.flatMap((w) => w.rows).filter((r) => r.threadId === thread.id).at(-1) as unknown as { startedBy?: unknown };
  assert.equal(row().startedBy, undefined, 'an older backend would turn the batch down');
  takes = true;
  const before = writes.length;
  index.refresh();
  await flush();
  assert.ok(writes.length > before);
  assert.deepEqual(row().startedBy, { kind: 'thread', label: 'Agent', threadTitle: 'The parent', why: 'fixing a hook' });
  index.stop();
});

test('a row carries what Mike last said, once the backend takes it', async () => {
  let takes = false;
  const { h, index, writes, flush } = setup(undefined, undefined, () => takes);
  const { thread } = h.runner.create({ text: 'Try the GPU route', accountId: 'claude-3' });
  index.start();
  await flush();
  const row = () => writes.flatMap((w) => w.rows).filter((r) => r.threadId === thread.id).at(-1) as unknown as { asked?: string };
  assert.equal(row().asked, undefined, 'an older backend would turn the batch down');
  takes = true;
  index.refresh();
  await flush();
  assert.equal(row().asked, 'Try the GPU route');
  index.stop();
});

test('other runners’ threads are watched only while a Mac app is connected', async () => {
  let app = false;
  const { h, index, heard, remote, watching, subscriptions } = setup(undefined, () => app);
  index.start();
  assert.equal(watching(), false, 'no app (Bruce): nothing watched');
  h.clock.advance(60_000);
  await tick();
  assert.equal(watching(), false);

  // An app connecting asks for the list, which starts the watch at once.
  app = true;
  assert.deepEqual(index.list().threads, []);
  assert.equal(watching(), true);
  remote({ runners: [{ runnerId: 'r-bruce', name: 'bruce', lastSeenAt: h.clock.now() }], threads: [] });
  assert.equal(heard.length, 1);

  // A relaunch, gone for under two minutes, keeps the watch.
  app = false;
  h.clock.advance(60_000);
  await tick();
  assert.equal(watching(), true);
  app = true;
  h.clock.advance(15_000);
  await tick();
  app = false;
  h.clock.advance(3 * 60_000);
  await tick();
  assert.equal(watching(), false, 'gone for good: the watch stops');
  assert.equal(index.list().runners[0]!.name, 'bruce', 'what was heard stays for the next app');
  assert.equal(watching(), true);
  assert.equal(subscriptions(), 2);

  // Connected without asking (the periodic check finds it).
  app = false;
  h.clock.advance(3 * 60_000);
  await tick();
  assert.equal(watching(), false);
  app = true;
  h.clock.advance(15_000);
  await tick();
  assert.equal(watching(), true);
  index.stop();
  assert.equal(watching(), false);
});

// A fake backend for API 29: the runners list and the rows by updatedMs,
// answering each subscription from its own `since` the way
// sync:threadIndexSince does, and re-running every live one on a write.
function sinceBackend() {
  const runners = [{ runnerId: 'r-bruce', name: 'bruce', lastSeenAt: Date.now() }];
  const rows: { runnerId: string; threadId: string; title: string; updatedMs: number; deleted?: boolean }[] = [];
  const subs = new Map<number, { fn: string; args: Record<string, unknown>; onUpdate: (v: unknown) => void }>();
  let next = 0;
  let reads = 0; // rows read by threadIndexSince, all runs
  const answer = (s: { fn: string; args: Record<string, unknown> }) => {
    if (s.fn === 'sync:otherRunnersList') return runners;
    const out = [];
    for (const a of s.args.runners as { runnerId: string; since?: number }[]) {
      for (const r of rows) if (r.runnerId === a.runnerId && (a.since === undefined || r.updatedMs >= a.since)) out.push({ ...r, cwd: '/', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: 'c', lastActivityAt: 'l' });
    }
    reads += out.length;
    return out;
  };
  let clock = 1000;
  const write = (threadId: string, title: string, deleted = false) => {
    clock += 1;
    const i = rows.findIndex((r) => r.threadId === threadId);
    const row = { runnerId: 'r-bruce', threadId, title, updatedMs: clock, ...(deleted ? { deleted } : {}) };
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    for (const s of [...subs.values()]) if (s.fn === 'sync:threadIndexSince') s.onUpdate(answer(s));
  };
  const subscribe = (fn: string, args: Record<string, unknown>, onUpdate: (v: unknown) => void) => {
    const id = next++;
    const s = { fn, args, onUpdate };
    subs.set(id, s);
    queueMicrotask(() => subs.has(id) && onUpdate(answer(s)));
    return () => void subs.delete(id);
  };
  return { subscribe, write, live: () => [...subs.values()].map((s) => s.fn), reads: () => reads, resetReads: () => void (reads = 0) };
}

test('with API 29 a re-run reads only the rows that changed, and hears deletions', async () => {
  const b = sinceBackend();
  for (let i = 0; i < 100; i++) b.write(`t${i}`, `Thread ${i}`);
  const h = makeHarness();
  const heard: RemoteThreads[] = [];
  const index = new ThreadIndex({
    post: async () => null,
    subscribe: b.subscribe,
    key: 'k',
    runnerId: 'r-m5',
    home: h.home,
    host: h.runner,
    publish: (n: Notification) => n.method === 'remoteThreads.updated' && heard.push(n.params),
    clock: h.clock,
    log: nullLogger,
    takesSince: () => true,
  });
  index.start();
  // The agent tools wait on this, until the rows have come.
  assert.equal(index.heard(), false);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(index.heard(), true);
  assert.deepEqual(b.live().sort(), ['sync:otherRunnersList', 'sync:threadIndexSince']);
  assert.equal(heard.at(-1)!.threads.length, 100);
  assert.equal(heard.at(-1)!.runners[0]!.name, 'bruce');

  // One thread renamed: a handful of rows read, not a hundred.
  b.resetReads();
  b.write('t7', 'Renamed');
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(b.reads() <= 4, `read ${b.reads()} rows for one change`);
  const after = heard.at(-1)!;
  assert.equal(after.threads.length, 100);
  assert.equal(after.threads.find((t) => t.threadId === 't7')!.title, 'Renamed');
  assert.equal('updatedMs' in after.threads[0]!, false, 'the app gets rows as before');

  // A tombstone takes it out.
  b.write('t8', 'Thread 8', true);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(heard.at(-1)!.threads.length, 99);
  assert.equal(heard.at(-1)!.threads.some((t) => t.threadId === 't8'), false);

  // Watching again starts from a full read, so nothing missed meanwhile matters.
  index.stop();
  assert.deepEqual(b.live(), []);
  index.start();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(heard.at(-1)!.threads.length, 99);
  index.stop();
});

test('the list counts as heard (for the agent tools) once the rows come, not just the runners', async () => {
  const h = makeHarness();
  let rowsAnswer: ((v: unknown) => void) | undefined;
  const index = new ThreadIndex({
    post: async () => null,
    subscribe: (fn, _args, onUpdate) => {
      if (fn === 'sync:otherRunnersList') queueMicrotask(() => onUpdate([{ runnerId: 'r-cloud', name: 'Cloud', lastSeenAt: Date.now() }]));
      else rowsAnswer = onUpdate;
      return () => undefined;
    },
    key: 'k',
    runnerId: 'r-m5',
    home: h.home,
    host: h.runner,
    publish: () => {},
    clock: h.clock,
    log: nullLogger,
    takesSince: () => true,
  });
  index.start();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(index.list().runners.length, 1);
  assert.equal(index.heard(), false, 'runners without their rows');
  rowsAnswer!([{ runnerId: 'r-cloud', threadId: 'ba5bb5ec', title: 'Rust port', updatedMs: 1, cwd: '/', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: 'c', lastActivityAt: 'l' }]);
  assert.equal(index.heard(), true);
  assert.equal(index.list().threads[0]!.title, 'Rust port');
  index.stop();
});

test('a runner key that may not read the other runners’ threads stops watching for good, and says so once', async () => {
  const h = makeHarness();
  const said: string[] = [];
  let subscriptions = 0;
  const log = { ...nullLogger, info: (msg: string) => void said.push(msg), warn: (msg: string) => void said.push(msg) };
  const index = new ThreadIndex({
    post: async () => null,
    subscribe: (_fn, _args, _onUpdate, onError) => {
      subscriptions++;
      // As the backend refuses it (convex/lib.ts forbidden), through the Convex client.
      queueMicrotask(() => onError(Object.assign(new Error('Server Error'), { data: { kind: 'forbidden', message: "This runner's key can't call otherRunnersThreads" } })));
      return () => {};
    },
    key: 'k',
    runnerId: 'r-bruce',
    home: h.home,
    host: h.runner,
    publish: () => {},
    clock: h.clock,
    log: log as never,
    appConnected: () => true,
  });
  index.start();
  await tick();
  assert.equal(subscriptions, 1);
  assert.equal(index.heard(), true, 'a refusal is an answer: nothing to wait for');
  // The periodic check and an app asking again don't try once more.
  h.clock.advance(5 * 60_000);
  await tick();
  index.list();
  await tick();
  assert.equal(subscriptions, 1);
  assert.equal(said.filter((m) => m.startsWith('not watching')).length, 1);
  assert.equal(said.filter((m) => m.includes('subscription failed')).length, 0);
  index.stop();
});

test("a runner key's archived rows, which a backend before API 54 dropped, go again once", async () => {
  const h = makeHarness();
  const live = h.runner.create({ text: 'Still going', accountId: 'claude-3' }).thread;
  const done = h.runner.create({ text: 'All done', accountId: 'claude-3' }).thread;
  h.runner.update({ threadId: done.id, archived: true });
  const make = (seed?: ReturnType<ThreadIndex['snapshot']>) => {
    const writes: { rows: { threadId: string }[] }[] = [];
    const index = new ThreadIndex({
      post: async (_kind, fn, args) => {
        if (fn === 'sync:setThreadIndex') writes.push(args as never);
        return null;
      },
      key: 'tbr_k',
      runnerId: 'r-bruce',
      home: h.home,
      host: h.runner,
      clock: h.clock,
      log: nullLogger,
      appConnected: () => false,
      ...(seed ? { seed: () => seed } : {}),
    });
    return { index, writes };
  };
  const flush = async () => {
    h.clock.advance(1500);
    await tick();
  };
  // A first run sends both, and remembers them as sent.
  const first = make();
  first.index.start();
  await flush();
  const seed = first.index.snapshot()!;
  first.index.stop();
  assert.equal(seed.archived, undefined);
  // The next start has nothing to send, until the backend says 54: then
  // only the archived one goes, heard before the index started.
  const second = make(seed);
  second.index.resendArchived();
  second.index.start();
  await flush();
  assert.deepEqual(second.writes.flatMap((w) => w.rows.map((r) => r.threadId)), [done.id]);
  assert.ok(!second.writes.some((w) => w.rows.some((r) => r.threadId === live.id)));
  const after = second.index.snapshot()!;
  second.index.stop();
  assert.equal(after.archived, true);
  // And never again.
  const third = make(after);
  third.index.start();
  third.index.resendArchived();
  await flush();
  assert.deepEqual(third.writes.flatMap((w) => w.rows.map((r) => r.threadId)), []);
});

test("Mike's runner order (API 58) comes with the other runners, and an update says it at once", async () => {
  const h = makeHarness();
  let orderAnswer: ((v: unknown) => void) | undefined;
  const heard: RemoteThreads[] = [];
  const index = new ThreadIndex({
    post: async () => null,
    subscribe: (fn, args, onUpdate) => {
      if (fn === 'sync:runnerOrder') {
        assert.deepEqual(args, { key: 'k' });
        orderAnswer = onUpdate;
      } else if (fn === 'sync:otherRunnersList') queueMicrotask(() => onUpdate([{ runnerId: 'r-cloud', name: 'Cloud', lastSeenAt: Date.now() }]));
      return () => undefined;
    },
    key: 'k',
    runnerId: 'r-m5',
    home: h.home,
    host: h.runner,
    publish: (n: Notification) => n.method === 'remoteThreads.updated' && heard.push(n.params),
    clock: h.clock,
    log: nullLogger,
    takesSince: () => true,
    takesOrder: () => true,
  });
  index.start();
  index.list();
  for (let i = 0; i < 5; i++) await tick();
  orderAnswer!(['r-cloud', 'r-m5']);
  assert.deepEqual(heard.at(-1)!.order, ['r-cloud', 'r-m5']);
  assert.equal(heard.at(-1)!.runners[0]!.id, 'r-cloud', 'the runners stay with it');
  assert.deepEqual(index.list().order, ['r-cloud', 'r-m5']);
  index.stop();
});

test('an older backend is never asked for the order', async () => {
  const h = makeHarness();
  const asked: string[] = [];
  const index = new ThreadIndex({
    post: async () => null,
    subscribe: (fn) => {
      asked.push(fn);
      return () => undefined;
    },
    key: 'k',
    runnerId: 'r-m5',
    home: h.home,
    host: h.runner,
    clock: h.clock,
    log: nullLogger,
    takesSince: () => true,
    takesOrder: () => false,
  });
  index.start();
  index.list();
  await tick();
  assert.equal(asked.includes('sync:runnerOrder'), false);
  assert.equal(index.list().order, undefined);
  index.stop();
});
