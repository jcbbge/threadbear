// The silent on-device check (src/secret-check.ts), with its helper faked: the
// real one needs Apple's model, which a test mustn't depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { IMAGES_PER_RUN, MAX_QUEUE, MAX_TEXT, RETRY_UNAVAILABLE_MS, SecretCheck, TEXTS_PER_RUN, type SecretCheckDeps } from '../../src/secret-check.ts';

const PRIVATE = 'something private that must never be stored anywhere';

function make(opts: Partial<SecretCheckDeps> = {}) {
  const home = tmpDir();
  const source = path.join(home, 'main.swift');
  fs.writeFileSync(source, '// source\n');
  const jobs: string[][] = [];
  let built = 0;
  const c = new SecretCheck({
    home,
    enabled: true,
    platform: 'darwin',
    source,
    exists: () => false,
    build: async () => {
      built++;
    },
    probe: async () => 'available',
    onAC: async () => true,
    run: async (_helper, j) => {
      jobs.push(j);
      return j.map((_x, id) => ({ id, verdict: 'clean' }));
    },
    setTimer: () => ({ cancel() {} }),
    ...opts,
  });
  return { c, home, jobs, built: () => built };
}

const result = (seq: number, text = `${PRIVATE} ${seq}`, images: { path: string }[] = []) => ({ type: 'tool.result', seq, text, images });

test('off by default does nothing: no helper, no file, no queue', async () => {
  const { c, home, jobs, built } = make({ enabled: false });
  c.see('t', result(1));
  await c.tick();
  assert.equal(c.status().state, 'off');
  assert.equal(built(), 0);
  assert.deepEqual(jobs, []);
  assert.ok(!fs.existsSync(path.join(home, 'secret-check.json')));
});

test('on Linux it says why not, and builds nothing', async () => {
  const { c, built } = make({ platform: 'linux' });
  c.see('t', result(1));
  await c.tick();
  assert.equal(c.status().state, 'unsupported');
  assert.match(c.status().reason!, /Mac/);
  assert.equal(built(), 0);
});

test('Apple Intelligence off: says so, and asks again later rather than each run', async () => {
  let now = 1000;
  let probes = 0;
  const { c, jobs } = make({ now: () => now, probe: async () => (probes++, 'unavailable: Apple Intelligence is off') });
  c.see('t', result(1));
  await c.tick();
  assert.equal(c.status().state, 'unavailable');
  assert.equal(c.status().reason, 'Apple Intelligence is off');
  await c.tick();
  assert.equal(probes, 1);
  assert.deepEqual(jobs, []);
  now += RETRY_UNAVAILABLE_MS + 1;
  await c.tick();
  assert.equal(probes, 2);
});

test('a helper that will not build is a reason, not a crash', async () => {
  const { c } = make({
    build: async () => {
      throw new Error('swiftc failed');
    },
  });
  c.see('t', result(1));
  await c.tick();
  assert.equal(c.status().state, 'unavailable');
  assert.match(c.status().reason!, /swiftc failed/);
});

test('on battery it skips the run and keeps the queue', async () => {
  let ac = false;
  const { c, jobs } = make({ onAC: async () => ac });
  c.see('t', result(1));
  await c.tick();
  assert.deepEqual(jobs, []);
  assert.equal(c.status().skippedOnBattery, 1);
  ac = true;
  await c.tick();
  assert.equal(jobs.length, 1);
});

test('it keeps counts and thread and seq, never the text', async () => {
  const { c, home } = make({ run: async (_h, j) => j.map((_x, id) => ({ id, verdict: id === 0 ? 'secret' : id === 1 ? 'error' : id === 2 ? 'empty' : 'clean' })) });
  c.see('t1', result(5));
  c.see('t2', result(6));
  c.see('t3', result(7, 'short', [{ path: '/shots/a.png' }]));
  c.see('t4', result(8));
  await c.tick();
  const saved = fs.readFileSync(path.join(home, 'secret-check.json'), 'utf8');
  assert.ok(!saved.includes(PRIVATE));
  const parsed = JSON.parse(saved);
  assert.equal(parsed.flagged.length, 1);
  assert.deepEqual(Object.keys(parsed.flagged[0]).sort(), ['at', 'seq', 'source', 'threadId']);
  assert.equal((fs.statSync(path.join(home, 'secret-check.json')).mode & 0o777).toString(8), '600');
  const s = c.status();
  assert.equal(s.flaggedText + s.flaggedImages, 1);
  assert.equal(s.errors, 1);
  assert.ok(!JSON.stringify(s).includes(PRIVATE));
});

test('compares with the rules on text, and survives a restart', async () => {
  const key = `sk-${'a1b2'.repeat(12)}`;
  const verdict = { value: 'clean' };
  const { c, home } = make({ run: async (_h, j) => j.map((_x, id) => ({ id, verdict: verdict.value })) });
  c.see('t', result(1, `found ${key} in the output of something`));
  await c.tick();
  assert.equal(c.status().rulesOnly, 1);
  verdict.value = 'secret';
  c.see('t', result(2, `found ${key} in the output of something`));
  await c.tick();
  assert.equal(c.status().rulesAndModel, 1);
  const again = new SecretCheck({ home, enabled: true, platform: 'darwin', setTimer: () => ({ cancel() {} }) });
  assert.equal(again.status().rulesOnly, 1);
  assert.equal(again.status().checkedText, 2);
  assert.ok(!fs.readFileSync(path.join(home, 'secret-check.json'), 'utf8').includes(key));
});

test('a capped sample: a limit per run and on the queue, and long text is cut', async () => {
  const { c, jobs } = make();
  for (let i = 0; i < MAX_QUEUE + 50; i++) c.see('t', result(i, `${'x'.repeat(MAX_TEXT + 100)} ${i}`));
  for (let i = 0; i < 20; i++) c.see('t', result(1000 + i, 'short', [{ path: `/s/${i}.png` }]));
  await c.tick();
  const parsed = jobs[0]!.map((j) => JSON.parse(j) as { text?: string; image?: string });
  assert.ok(parsed.filter((j) => j.text).length <= TEXTS_PER_RUN);
  assert.ok(parsed.filter((j) => j.image).length <= IMAGES_PER_RUN);
  assert.ok(parsed.every((j) => !j.text || j.text.length <= MAX_TEXT));
});

test('only tool output is looked at', async () => {
  const { c, jobs } = make();
  c.see('t', { type: 'assistant.text', seq: 1, text: PRIVATE });
  c.see('t', { type: 'tool.result', text: PRIVATE }); // a delta has no seq
  await c.tick();
  assert.deepEqual(jobs, []);
});

test('a helper that dies part way counts as errors and leaves nothing behind', async () => {
  const { c } = make({ run: async () => [] });
  c.see('t', result(1));
  c.see('t', result(2));
  await c.tick();
  assert.equal(c.status().errors, 2);
  assert.equal(c.status().checkedText, 0);
});

test('stop means stop: a run in progress is cancelled and saves nothing', async () => {
  let release: (v: { id: number; verdict: string }[]) => void = () => {};
  let signal: AbortSignal | undefined;
  const { c, home } = make({
    run: (_h, _j, s) => {
      signal = s;
      return new Promise((r) => (release = r));
    },
  });
  c.see('t', result(1));
  const running = c.tick();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  c.stop();
  assert.equal(signal?.aborted, true);
  release([{ id: 0, verdict: 'secret' }]);
  await running;
  assert.equal(c.status().flaggedText, 0);
  assert.ok(!fs.existsSync(path.join(home, 'secret-check.json')));
});

test('stopped during the first build: no probe, and it never turns on', async () => {
  let finish: () => void = () => {};
  let probes = 0;
  const { c } = make({
    build: () => new Promise((r) => (finish = r)),
    probe: async () => (probes++, 'available'),
  });
  c.see('t', result(1));
  const running = c.tick();
  await new Promise((r) => setImmediate(r));
  c.stop();
  finish();
  await running;
  assert.equal(probes, 0);
  assert.notEqual(c.status().state, 'on');
});

test('before its first look it says it is starting, not unavailable', async () => {
  const { c } = make({});
  assert.equal(c.status().state, 'starting');
  assert.equal(c.on, true);
  assert.equal(c.status().reason, undefined);
});
