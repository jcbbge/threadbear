// Full sync's bodies (src/full-sync.ts, sync.ts; docs/full-convex.md step 4): what
// goes up when a tool finishes, and that with `sync.full` off nothing does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { BodyCollector, BODY_DIFFS_BYTES, BODY_INPUT_BYTES, BODY_TEXT_BYTES, cutUtf8, prepareBody, type BodyDoc } from '../../src/full-sync.ts';
import { BACKEND_API_VERSION, BODIES_API_VERSION, ConvexSync } from '../../src/sync.ts';
import { Scrubber } from '../../src/scrub.ts';
import { nullLogger } from '../../src/log.ts';
import type { PersistedEvent } from '../../src/protocol.ts';

const ts = '2026-11-06T01:00:00.000Z';
const T = 'thread-1';
// Made up here, so no key-shaped text sits in the repo.
const KEY = `sk-${'f4Ke'.repeat(11)}`;
const base = (seq: number) => ({ seq, ts, threadId: T, turnId: 'turn-1' });
const call = (seq: number, itemId: string, input: Record<string, unknown> = { command: 'ls' }): PersistedEvent => ({ ...base(seq), type: 'tool.call', itemId, name: 'Bash', kind: 'command', title: 'ls', input }) as PersistedEvent;
const result = (seq: number, itemId: string, text = 'out', images: unknown[] = []): PersistedEvent => ({ ...base(seq), type: 'tool.result', itemId, ok: true, text, truncated: false, images }) as PersistedEvent;
const diff = (seq: number, itemId: string, p = 'a.ts'): PersistedEvent => ({ ...base(seq), type: 'edit.diff', itemId, path: p, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }) as PersistedEvent;
const reasoning = (seq: number, text: string): PersistedEvent => ({ ...base(seq), type: 'reasoning', itemId: `r${seq}`, text }) as PersistedEvent;
const text = (seq: number, t: string): PersistedEvent => ({ ...base(seq), type: 'assistant.text', itemId: `a${seq}`, text: t }) as PersistedEvent;
const done = (seq: number): PersistedEvent => ({ ...base(seq), type: 'turn.completed', turnId: 'turn-1', outcome: 'completed', durationMs: 1 }) as unknown as PersistedEvent;
const id = (s: string) => s;

test('a tool goes up once it has finished, under its call: input, diffs, output and what came before', () => {
  const c = new BodyCollector();
  assert.deepEqual(c.see(T, reasoning(1, 'thinking')), []);
  assert.deepEqual(c.see(T, call(2, 'i')), []);
  assert.deepEqual(c.see(T, diff(3, 'i')), []);
  const [b] = c.see(T, result(4, 'i', 'done', [{ path: '/m/a.png' }]));
  assert.equal(b!.seq, 2, "the call's seq, which is its message row's");
  assert.equal(b!.text, 'done');
  assert.deepEqual(b!.input, { command: 'ls' });
  assert.equal(b!.diffs![0]!.path, 'a.ts');
  assert.equal(b!.reasoning, 'thinking');
  assert.equal(b!.images, 1, 'how many, not where: pictures stay on the runner');
  assert.ok(!JSON.stringify(b).includes('/m/a.png'));
});

test('a command or file that can hold secrets sends nothing of itself, input included', () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i', { command: 'npx convex env list' }));
  const [b] = c.see(T, result(2, 'i', `API_KEY=${KEY}`));
  assert.deepEqual(b, { threadId: T, seq: 1, from: 1, withheld: true, reason: 'environment' });
  c.see(T, call(3, 'j', { file_path: '/x/.env.local' }));
  assert.deepEqual(c.see(T, result(4, 'j', 'secret'))[0], { threadId: T, seq: 3, from: 3, withheld: true, reason: 'secret file' });
});

test("a result whose call it never saw isn't sent: nothing can say it's safe", () => {
  const c = new BodyCollector();
  assert.deepEqual(c.see(T, result(5, 'unknown')), []);
});

test('a tool that never answered goes up at the end of its turn with what is known', () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i'));
  const out = c.see(T, done(2));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.seq, 1);
  assert.equal(out[0]!.text, undefined);
  // Still going in the background: its answer goes up over that.
  const late = c.see(T, result(3, 'i', 'at last'));
  assert.equal(late[0]!.seq, 1);
  assert.equal(late[0]!.text, 'at last');
  assert.equal(c.head(T), 3);
});

test('an unanswered tool holds nobody back once what is known has gone up', () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i'));
  c.see(T, done(2));
  c.see(T, text(3, 'x'));
  assert.equal(c.head(T), 3);
});

test('the head stays behind the reasoning a tool needs, for a replay to make the same body', () => {
  const c = new BodyCollector();
  c.see(T, reasoning(10, 'why'));
  c.see(T, call(11, 'i'));
  assert.equal(c.head(T), 9);
  const [b] = c.see(T, result(12, 'i'));
  assert.equal(b!.from, 10);
});

test('a patch that only names its file in a diff is withheld by it, and so is a list of paths', () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i', { changes: 1 }));
  c.see(T, diff(2, 'i', '/vault/.env'));
  assert.equal(c.see(T, result(3, 'i'))[0]!.withheld, true);
  c.see(T, call(4, 'j', { paths: ['/ok.ts', '/vault/secrets.txt'] }));
  assert.equal(c.see(T, result(5, 'j'))[0]!.withheld, true);
});

test('ordinary shell variations on what is withheld are withheld', () => {
  for (const command of ['security -q find-generic-password -s demo -w | cut -c1-8', '/usr/bin/env | cut -d= -f2', 'cat .env* | cut -d= -f2', 'aws sts assume-role --role-arn x --role-session-name y | jq -r .Credentials.SecretAccessKey', "jq -r '.tokens.refresh_token' ~/.codex/auth.json", 'cat ~/.claude/.credentials.json']) {
    const c = new BodyCollector();
    c.see(T, call(1, 'i', { command }));
    assert.equal(c.see(T, result(2, 'i'))[0]!.withheld, true, command);
  }
});

test("reading a background job's output is only as safe as the job", () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'bad', { command: 'security find-generic-password -s demo -w', run_in_background: true }));
  c.see(T, result(2, 'bad', 'Command running in background with ID: demo-job'));
  c.see(T, call(3, 'read', { bash_id: 'demo-job' }));
  assert.equal(c.see(T, result(4, 'read', 'copper-canoe-482619'))[0]!.withheld, true);
  c.see(T, call(5, 'ok', { command: 'npm test', run_in_background: true }));
  c.see(T, result(6, 'ok', 'Command running in background with ID: fine-job'));
  c.see(T, call(7, 'read2', { bash_id: 'fine-job' }));
  assert.equal(c.see(T, result(8, 'read2', 'passed'))[0]!.text, 'passed');
  // One it never saw start: can't be known.
  c.see(T, call(9, 'read3', { task_id: 'who-knows' }));
  assert.equal(c.see(T, result(10, 'read3', 'x'))[0]!.withheld, true);
  c.see(T, { ...call(13, 'stop', { task_id: 'who-knows' }), name: 'TaskStop' } as PersistedEvent);
  assert.equal(c.see(T, result(14, 'stop', 'stopped'))[0]!.withheld, undefined, 'stopping one reads nothing of it');
  // Its output file read directly.
  c.see(T, call(15, 'file', { file_path: '/private/tmp/x/tasks/abc123.output' }));
  assert.equal(c.see(T, result(16, 'file', 'x'))[0]!.withheld, true);
});

test('a command cut before it got here is withheld, as what was cut is unknown', () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i', { command: 'true ' + ' '.repeat(100) + '\n[truncated]' }));
  assert.deepEqual(c.see(T, result(2, 'i'))[0]!.reason, 'too long to check');
});

test('what is held of a huge diff stays bounded, naming the file', () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i'));
  const huge = { ...base(2), type: 'edit.diff', itemId: 'i', path: 'big.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['z'.repeat(BODY_DIFFS_BYTES * 3)] }] } as PersistedEvent;
  c.see(T, huge);
  assert.deepEqual(c.see(T, result(3, 'i'))[0]!.diffs, [{ path: 'big.ts', hunks: [] }]);
});

test('reasoning with no tool to go with goes with the message after it', () => {
  const c = new BodyCollector();
  c.see(T, reasoning(1, 'hmm'));
  assert.deepEqual(c.see(T, text(2, 'Said')), [{ threadId: T, seq: 2, from: 1, reasoning: 'hmm' }]);
  c.see(T, reasoning(3, 'then this'));
  assert.deepEqual(c.see(T, done(4)), [{ threadId: T, seq: 3, from: 3, reasoning: 'then this' }]);
});

test('each event counts once, and the head stays behind anything unfinished', () => {
  const c = new BodyCollector();
  c.see(T, call(5, 'i'));
  c.see(T, text(6, 'x'));
  assert.equal(c.head(T), 4, 'a restart has to read the call again');
  assert.equal(c.see(T, result(7, 'i')).length, 1);
  assert.equal(c.head(T), 7);
  assert.deepEqual(c.see(T, result(7, 'i')), [], 'seen');
});

test('prepareBody: scrubbed everywhere, and input and diffs stay JSON', () => {
  const c = new Scrubber({ env: {}, folders: false });
  const doc = prepareBody(
    {
      threadId: T,
      seq: 1,
      text: `out ${KEY}`,
      input: { command: `curl -H "Authorization: Bearer ${KEY}"`, key: KEY, cwd: KEY, seenAt: KEY },
      diffs: [{ path: 'a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+const k = "${KEY}"`] }] }],
      reasoning: `saw ${KEY}`,
    },
    c.strict,
  );
  assert.ok(!JSON.stringify(doc).includes(KEY), 'and not under a name a row would skip');
  assert.equal((JSON.parse(doc.input!) as { key: string }).key, '[REDACTED]');
  // The rules can't see the name beside the value when they're given one string.
  const named = prepareBody({ threadId: T, seq: 2, input: { password: 'violet-canoe-lantern', apiKey: 'process.env.API_KEY', title: 'violet-canoe-lantern' } }, c.strict);
  assert.deepEqual(JSON.parse(named.input!), { password: '[REDACTED]', apiKey: 'process.env.API_KEY', title: 'violet-canoe-lantern' });
  const shapes = prepareBody({ threadId: T, seq: 3, input: { password: 482619, token: ['violet-canoe-lantern'], secret: 'violet.canoe-lantern', apiKey: { value: 'x' }, passwd: '482619', limit: 5 } }, c.strict);
  assert.deepEqual(JSON.parse(shapes.input!), { password: '[REDACTED]', token: ['[REDACTED]'], secret: '[REDACTED]', apiKey: { value: '[REDACTED]' }, passwd: '[REDACTED]', limit: 5 });
  assert.equal(JSON.parse(doc.diffs!)[0].path, 'a.ts');
});

test('a known value under a secret name is taken out, even looking like a reference', () => {
  const c = new Scrubber({ env: { MY_PASSWORD: '$violet-canoe-482619' }, folders: false });
  const doc = prepareBody({ threadId: T, seq: 1, input: { password: '$violet-canoe-482619' } }, c.strict);
  assert.ok(!doc.input!.includes('violet-canoe'));
});

test('prepareBody: scrubbed before it is cut, so a value across the cut is still found', () => {
  const c = new Scrubber({ env: {}, folders: false });
  const doc = prepareBody({ threadId: T, seq: 1, text: `${'x'.repeat(BODY_TEXT_BYTES - 10)} ${KEY}` }, c.strict);
  assert.ok(!doc.text!.includes(KEY.slice(0, 10)));
});

test('prepareBody: too big is cut to fit with a note, and says so', () => {
  const doc = prepareBody(
    {
      threadId: T,
      seq: 1,
      text: 'é'.repeat(BODY_TEXT_BYTES),
      input: { content: 'y'.repeat(BODY_INPUT_BYTES * 2), other: 1 },
      diffs: [{ path: 'big.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['z'.repeat(BODY_DIFFS_BYTES * 2)] }] }],
    },
    id,
  );
  assert.equal(doc.cut, true);
  assert.ok(Buffer.byteLength(doc.text!) <= BODY_TEXT_BYTES + 100);
  assert.match(doc.text!, /the rest is on the runner/);
  assert.ok(!doc.text!.includes('�'), 'not cut through a character');
  assert.ok(Buffer.byteLength(doc.input!) <= BODY_INPUT_BYTES);
  assert.equal((JSON.parse(doc.input!) as { other: number }).other, 1);
  assert.deepEqual(JSON.parse(doc.diffs!), [{ path: 'big.ts', hunks: [] }]);
  assert.equal(cutUtf8('héllo', 2), 'h');
});

type Call = { kind: string; fn: string; args: Record<string, unknown> };

function setup(opts: { full?: boolean; apiVersion?: number; fail?: () => boolean; scrubber?: Scrubber; cachePath?: string; stored?: PersistedEvent[]; home?: string } = {}) {
  const h = makeHarness();
  const thread = h.runner.create({ text: 'go', cwd: h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const calls: Call[] = [];
  const listeners = new Set<(n: unknown) => void>();
  const stored = opts.stored ?? [];
  const sync = new ConvexSync({
    config: { enabled: true, url: 'https://x.convex.cloud', name: 'TestMac', runnerId: 'r1', ...(opts.full === undefined ? { full: true } : opts.full ? { full: true } : {}) },
    key: 'k',
    runner: {
      onNotification: (fn: (n: never) => void) => {
        listeners.add(fn as never);
        return () => listeners.delete(fn as never);
      },
      list: (i: never) => h.runner.list(i),
      get: (tid: string) => ({ ...h.runner.get(tid), lastSeq: Math.max(0, ...stored.map((e) => e.seq)) }),
      events: (_id: string, o: { afterSeq?: number; limit?: number }) => ({ events: stored.filter((e) => e.seq > (o.afterSeq ?? 0)).slice(0, o.limit ?? 1000) }),
    } as never,
    version: '0.1.0+test',
    startedAt: ts,
    clock: h.clock,
    log: nullLogger,
    scrubber: opts.scrubber ?? new Scrubber({ env: {}, folders: false }),
    ...(opts.cachePath ? { cachePath: opts.cachePath } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    post: async (kind: 'mutation' | 'query', fn: string, args: Record<string, unknown>) => {
      if (fn === 'sync:appendBodies' && opts.fail?.()) throw new Error('network');
      calls.push({ kind, fn, args });
      if (fn === 'sync:heartbeat') return { apiVersion: opts.apiVersion ?? BACKEND_API_VERSION };
      return null;
    },
  } as never);
  const see = (e: PersistedEvent) => {
    for (const l of listeners) l({ method: 'thread.event', params: { threadId: thread.id, event: e } });
  };
  const sent = (): BodyDoc[] => calls.filter((c) => c.fn === 'sync:appendBodies').flatMap((c) => c.args.bodies as BodyDoc[]);
  return { h, sync, calls, see, sent, thread };
}

test('off: nothing is followed or sent, whatever happens', async () => {
  const { sync, see, calls } = setup({ full: false });
  sync.start();
  await sync.flushNow();
  see(call(1, 'i'));
  see(result(2, 'i', 'output'));
  await sync.flushNow();
  assert.equal(calls.filter((c) => c.fn === 'sync:appendBodies').length, 0);
  assert.equal(sync.status().full, undefined);
  await sync.stop();
});

test('on: what finishes goes up scrubbed and counted, and a one-line row still goes', async () => {
  const { sync, see, sent, calls, thread } = setup();
  sync.start();
  await sync.flushNow();
  see(call(1, 'i', { command: `echo ${KEY}` }));
  see(result(2, 'i', `saw ${KEY}`));
  see(call(3, 'j', { command: 'printenv' }));
  see(result(4, 'j', `LOTS=${KEY}`));
  await sync.flushNow();
  const [a, b] = sent();
  assert.equal(a!.threadId, thread.id);
  assert.equal(a!.text, 'saw [REDACTED]');
  assert.ok(!a!.input!.includes(KEY));
  assert.deepEqual(b, { threadId: thread.id, seq: 3, withheld: true, reason: 'environment' });
  assert.ok(!JSON.stringify(calls).includes(KEY));
  assert.ok(calls.some((c) => c.fn === 'sync:appendMessages'));
  const st = sync.status().full!;
  assert.equal(st.bodies, 1);
  assert.equal(st.withheld, 1);
  assert.equal(st.pending, 0);
  await sync.stop();
});

test('the check failing holds that body back whole', async () => {
  const scrubber = new Scrubber({ env: {}, folders: false });
  const { sync, see, sent } = setup({ scrubber });
  sync.start();
  await sync.flushNow();
  const real = scrubber.text;
  (scrubber as { text: (t: string) => string }).text = (t) => (t.includes('boom') ? (() => { throw new Error('nope'); })() : real(t));
  scrubber.strict = (t) => (scrubber as { text: (t: string) => string }).text(t);
  see(call(1, 'i'));
  see(result(2, 'i', `boom ${KEY}`));
  await sync.flushNow();
  assert.deepEqual(sent()[0]!.withheld, true);
  assert.equal(sent()[0]!.text, undefined);
  assert.ok(!JSON.stringify(sent()).includes(KEY));
  await sync.stop();
});

test('a failed upload is sent again and blocks nothing else', async () => {
  let down = true;
  const { sync, see, sent, calls } = setup({ fail: () => down });
  sync.start();
  await sync.flushNow();
  see(call(1, 'i'));
  see(text(2, 'hello'));
  see(result(3, 'i'));
  await sync.flushNow();
  assert.equal(sent().length, 0);
  assert.ok(calls.some((c) => c.fn === 'sync:appendMessages'), "the mirror's own rows went");
  assert.equal(sync.status().full!.pending, 1);
  assert.equal(sync.status().state, 'error');
  down = false;
  await sync.flushNow();
  assert.equal(sent().length, 1);
  assert.equal(sync.status().full!.pending, 0);
  await sync.stop();
});

test('a backend too old to take them gets none, and tb status can say why', async () => {
  const { sync, see, calls } = setup({ apiVersion: BODIES_API_VERSION - 1 });
  sync.start();
  await sync.flushNow();
  see(call(1, 'i'));
  see(result(2, 'i'));
  await sync.flushNow();
  assert.equal(calls.filter((c) => c.fn === 'sync:appendBodies').length, 0);
  assert.equal(sync.status().full!.backendTooOld, true);
  await sync.stop();
});

test('many go in more than one mutation, in order', async () => {
  const { sync, see, calls, sent } = setup();
  sync.start();
  await sync.flushNow();
  for (let n = 0; n < 120; n++) {
    see(call(n * 2 + 1, `i${n}`));
    see(result(n * 2 + 2, `i${n}`));
  }
  await sync.flushNow();
  assert.ok(calls.filter((c) => c.fn === 'sync:appendBodies').length >= 3);
  assert.deepEqual(sent().map((b) => b.seq), Array.from({ length: 120 }, (_, n) => n * 2 + 1));
  await sync.stop();
});

test('a restart sends what finished while it was away, not what had gone up, and never scans', async () => {
  const cachePath = path.join(tmpDir('tb-full-'), 'sync-sent.json');
  const stored: PersistedEvent[] = [];
  const first = setup({ cachePath, stored });
  first.sync.start();
  await first.sync.flushNow();
  stored.push(call(1, 'i'), result(2, 'i'), call(3, 'j'));
  for (const e of stored) first.see(e);
  await first.sync.flushNow();
  await tick();
  // Written over a full write, as a first start does.
  await first.sync.flushNow();
  assert.deepEqual(first.sent().map((b) => b.seq), [1]);
  await first.sync.stop();
  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { bodies?: Record<string, number> };
  assert.equal(saved.bodies?.[first.thread.id], 2, 'behind the tool still open');

  // Same thread id: the note is what's read from.
  stored.push(result(4, 'j', 'finished while away'), call(5, 'k'), result(6, 'k'));
  const again = setup({ cachePath, stored });
  const seen: string[] = [];
  void seen;
  // A different harness has a different id, so point its note at it.
  const file = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { bodies: Record<string, number> };
  fs.writeFileSync(cachePath, JSON.stringify({ ...file, bodies: { [again.thread.id]: 2 } }));
  again.sync.start();
  await again.sync.flushNow();
  assert.deepEqual(again.sent().map((b) => b.seq), [3, 5]);
  assert.equal(again.sent()[0]!.text, 'finished while away');
  await again.sync.stop();
});

test('turned on with no note: forward only, from now', async () => {
  const stored: PersistedEvent[] = [call(1, 'old'), result(2, 'old', 'from before it was on')];
  const { sync, see, sent } = setup({ stored, cachePath: path.join(tmpDir('tb-full-'), 'sync-sent.json') });
  sync.start();
  await sync.flushNow();
  see(call(3, 'i'));
  see(result(4, 'i', 'new'));
  await sync.flushNow();
  assert.deepEqual(sent().map((b) => b.seq), [3]);
  await sync.stop();
});

test('a jump in seqs reads what was missed: a thread that came across from the release before', async () => {
  const stored: PersistedEvent[] = [call(1, 'a'), result(2, 'a'), call(3, 'b'), result(4, 'b', 'while away')];
  const { sync, see, sent } = setup({ stored });
  sync.start();
  await sync.flushNow();
  see(stored[0]!);
  see(stored[1]!);
  await sync.flushNow();
  stored.push(call(5, 'c'), result(6, 'c'));
  see(stored[5]!);
  see(stored[4]!); // late: seen, and ignored
  await sync.flushNow();
  const seqs = sent().map((b) => b.seq);
  assert.ok(seqs.includes(3), 'the tool it missed');
  assert.equal(sent().find((b) => b.seq === 3)!.text, 'while away');
  await sync.stop();
});

test('a queue that moves under a write loses only what was evicted', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { sync, see, sent, calls } = setup();
  const s = sync as unknown as { bodies: unknown[]; deps: { config: object }; post: (k: string, f: string, a: object) => Promise<unknown> };
  sync.start();
  await sync.flushNow();
  see(call(1, 'a'));
  see(result(2, 'a'));
  const real = s.post;
  let waited = false;
  s.post = async (k, f, a) => {
    if (f === 'sync:appendBodies' && !waited) {
      waited = true;
      await gate;
    }
    return real.call(sync, k, f, a);
  };
  const flushing = sync.flushNow();
  await tick();
  see(call(3, 'b'));
  see(result(4, 'b'));
  release();
  await flushing;
  await sync.flushNow();
  assert.deepEqual(sent().map((b) => b.seq), [1, 3], 'the one queued during the write still goes');
  assert.ok(calls.length);
  await sync.stop();
});

test('giving up on a catch-up lets the head move on, so no start reads the same events again', async () => {
  const c = new BodyCollector();
  c.see(T, call(1, 'i'));
  assert.equal(c.head(T), 0);
  c.abandon(T);
  c.resume(T, 40000);
  assert.equal(c.head(T), 40000);
});

test('turned off: the note goes at the start, so turning it on again sends nothing from while it was off', async () => {
  const cachePath = path.join(tmpDir('tb-full-'), 'sync-sent.json');
  const first = setup({ cachePath, stored: [] });
  first.sync.start();
  await first.sync.flushNow();
  first.see(call(1, 'i'));
  first.see(result(2, 'i'));
  await first.sync.flushNow();
  await first.sync.flushNow();
  await first.sync.stop();
  assert.ok((JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { bodies?: object }).bodies, 'it had one');
  const off = setup({ cachePath, full: false });
  off.sync.start();
  assert.equal((JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { bodies?: object }).bodies, undefined);
  await off.sync.stop();
  // The mirror off altogether, with full sync still set: the same.
  fs.writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(cachePath, 'utf8')), bodies: { x: 1 } }));
  const h = makeHarness();
  const offWhole = new ConvexSync({ config: { enabled: false, full: true, url: 'https://x.convex.cloud' }, key: 'k', runner: h.runner, version: 'x', startedAt: ts, clock: h.clock, log: nullLogger, cachePath } as never);
  offWhole.start();
  assert.equal((JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { bodies?: object }).bodies, undefined);
});

test('a picture: only what that tool handed back, never for a withheld tool, and only when full sync is on', async () => {
  const home = tmpDir('tb-full-home-');
  const h = setup({ home });
  const media = path.join(home, 'threads', h.thread.id, 'media');
  fs.mkdirSync(media, { recursive: true });
  const shot = path.join(media, 'shot.png');
  // A tiny real PNG header, so it's taken for one.
  fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'));
  const events = [call(1, 'i'), result(2, 'i', 'x', [{ path: shot, mediaType: 'image/png' }, { path: '/etc/passwd', mediaType: 'image/png' }]), call(3, 'j', { command: 'cat .env' }), result(4, 'j', 'x', [{ path: shot, mediaType: 'image/png' }])];
  const sync = h.sync as unknown as { sendHeldPicture: (t: string, s: number, i: number) => Promise<void>; deps: { runner: { events: unknown }; home: string }; upload: unknown; backendApiVersion: number };
  sync.deps.runner.events = () => ({ events });
  sync.upload = async () => 'storage1';
  sync.backendApiVersion = BODIES_API_VERSION;
  await sync.sendHeldPicture(h.thread.id, 1, 0);
  const up = h.calls.find((c) => c.fn === 'sync:addHeldPicture')!;
  assert.deepEqual([up.args.seq, up.args.index, up.args.storageId], [1, 0, 'storage1']);
  await assert.rejects(sync.sendHeldPicture(h.thread.id, 1, 1), /isn't available/, 'a path outside its media folder');
  await assert.rejects(sync.sendHeldPicture(h.thread.id, 1, 2), /No such picture/);
  await assert.rejects(sync.sendHeldPicture(h.thread.id, 3, 0), /stays on the runner/);
  await assert.rejects(sync.sendHeldPicture(h.thread.id, 2, 0), /No such tool/, 'a seq that is not a call');
  const off = setup({ full: false, home });
  await assert.rejects((off.sync as unknown as typeof sync).sendHeldPicture(off.thread.id, 1, 0), /off on this runner/);
});
