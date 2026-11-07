import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';
import { UpdateFixer, type UpdateFailure } from '../../src/fix-update.ts';

function rig() {
  const started: { text: string; title: string; why: string }[] = [];
  const sent: { threadId: string; text: string }[] = [];
  const archived = new Set<string>();
  const home = tmpDir('tb-fix-update-');
  const f = new UpdateFixer({
    home,
    log: nullLogger,
    start: (r) => {
      started.push(r);
      return `t${started.length}`;
    },
    open: (id) => !archived.has(id),
    send: (threadId, text) => sent.push({ threadId, text }),
  });
  return { f, home, started, sent, archived };
}

function failure(commit: string, kind: UpdateFailure['kind'] = 'build'): UpdateFailure {
  return { kind, commit: `${commit}full`, short: commit, subject: 'Steering', error: 'test/unit/rpc.test.ts failed', logFile: '/tmp/update.log' };
}

test('a failed update starts one thread that fixes it, lands it and archives itself', () => {
  const { f, home, started } = rig();
  assert.equal(f.failed(failure('c2')), 'started');
  assert.equal(started.length, 1);
  assert.equal(started[0].title, 'Fix the runner update to main c2');
  assert.match(started[0].text, /couldn't update to main at c2 \(Steering\): test\/unit\/rpc\.test\.ts failed/);
  assert.match(started[0].text, /\/tmp\/update\.log/);
  assert.match(started[0].text, /archive: true/);
  // A flake with nothing to land: clearing the failed record retries it.
  assert.ok(started[0].text.includes(`${home}/runner/update.json`));
});

test('the same failure again says nothing; a newer one goes to the open thread', () => {
  const { f, started, sent } = rig();
  f.failed(failure('c2'));
  assert.equal(f.failed(failure('c2')), 'already');
  assert.equal(f.failed(failure('c3')), 'sent');
  assert.equal(started.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, 't1');
  assert.match(sent[0].text, /failed again at a newer commit.*c3/s);
  // The backend failing at the same commit is news too.
  assert.equal(f.failed(failure('c3', 'backend')), 'sent');
});

test('once the thread is archived, the next failure starts a fresh one', () => {
  const { f, started, archived } = rig();
  f.failed(failure('c2'));
  archived.add('t1');
  assert.equal(f.failed(failure('c2')), 'started');
  assert.equal(started.length, 2);
});

test('a backend failure says the next commit is what retries it', () => {
  const { f, started } = rig();
  f.failed(failure('c4', 'backend'));
  assert.equal(started[0].title, 'Fix the backend deploy at main c4');
  assert.match(started[0].text, /Convex backend couldn't be deployed at main c4/);
  assert.doesNotMatch(started[0].text, /update\.json/);
});
