import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FakeAccounts, makeHarness, withCodex } from '../helpers/fakes.ts';
import { formatSelf } from '../../src/tb-dev.ts';
import { RpcServer } from '../../src/rpc.ts';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, readToken, runnerUrl } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { backgroundFlag } from '../../src/protocol.ts';
import { patiently } from '../helpers/patience.ts';

const TB = path.join(import.meta.dirname, '..', '..', 'bin', 'tb');

async function serve() {
  const h = makeHarness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: readToken(h.home), runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  return { h, server, url: `ws://127.0.0.1:${port}/rpc` };
}

function tb(h: { home: string }, url: string, args: string[], env: Record<string, string> = {}) {
  let out = '';
  const p = spawn(process.execPath, [TB, ...args], { env: { ...process.env, THREADBEAR_HOME: h.home, THREADBEAR_URL: url, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.once('exit', (code) => r(code)));
  return { out: () => out, exited, kill: () => p.kill() };
}

const settled = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

test('tb tail --until-done waits for the turn that is running, not an old one in the backlog', async () => {
  const { h, server, url } = await serve();
  const { thread } = h.runner.create({ text: 'first', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'one');
  s.result();
  h.runner.send(thread.id, 'second');
  const t = tb(h, url, ['tail', thread.id.slice(0, 8), '--until-done']);
  try {
    assert.equal(await settled(t.exited, 1500), false, 'still tailing while the second turn runs');
    s.text('m2:0', 'two');
    s.result();
    assert.equal(await t.exited, 0);
    assert.match(t.out(), /one[\s\S]*> second[\s\S]*two/);
    // With nothing running it prints the backlog and stops.
    const idle = tb(h, url, ['tail', thread.id, '--until-done']);
    assert.equal(await idle.exited, 0);
  } finally {
    t.kill();
    await server.close();
  }
});

test('tb send --wait shows the new message and leaves the thread unread', async () => {
  const { h, server, url } = await serve();
  const { thread } = h.runner.create({ text: 'first', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.result();
  const seenBefore = h.runner.get(thread.id).lastSeenSeq;
  const t = tb(h, url, ['send', thread.id, 'hello there', '--wait']);
  try {
    // tb can take 5 s just to start on a Mac busy rendering.
    await patiently(() => s.sent.length >= 2);
    assert.equal(s.sent.length, 2);
    s.text('m2:0', 'hi back');
    s.result();
    assert.equal(await t.exited, 0);
    assert.match(t.out(), /> hello there[\s\S]*hi back/);
    assert.equal(h.runner.get(thread.id).lastSeenSeq, seenBefore, 'not marked seen');
  } finally {
    t.kill();
    await server.close();
  }
});

test('inside a thread, tb will not delete, interrupt, snooze or archive that thread, as the threadbear tools will not', async () => {
  const { h, server, url } = await serve();
  const self = h.runner.create({ text: 'me', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  const other = h.runner.create({ text: 'other', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  h.adapter.last.result();
  const inThread = { THREADBEAR_THREAD_ID: self.id };
  try {
    for (const args of [['delete', self.id.slice(0, 8)], ['interrupt', self.id], ['snooze', self.id, '1h'], ['archive', self.id]]) {
      const t = tb(h, url, args, inThread);
      assert.equal(await t.exited, 1, args[0]);
      assert.match(t.out(), /this runs in|delete itself/, args[0]);
    }
    const s = h.runner.get(self.id);
    assert.equal(s.status, 'running', 'its turn carries on');
    assert.equal(s.archivedAt, undefined);
    assert.equal(s.snoozedUntil, undefined);
    // Its own approval cards are Mike's, through tb approve and a raw call alike.
    void h.adapter.sessions.find((x) => x.opts.threadId === self.id)!.sink.requestApproval({ name: 'Bash', title: 'rm -rf build', input: { command: 'rm -rf build' }, canAlwaysAllow: true, signal: new AbortController().signal });
    const approvalId = h.events(self.id).find((e) => e.type === 'approval.requested').approvalId;
    for (const args of [['approve', self.id, approvalId, 'allow'], ['answer', self.id.slice(0, 8), approvalId, 'yes'], ['rpc', 'approvals.respond', JSON.stringify({ threadId: self.id, approvalId, decision: 'allow' })], ['rpc', 'plans.approve', JSON.stringify({ threadId: self.id, itemId: 'tu-plan' })]]) {
      const t = tb(h, url, args, inThread);
      assert.equal(await t.exited, 1, args[0]);
      assert.match(t.out(), /own card; the user answers it/, args[0]);
    }
    assert.equal(h.runner.get(self.id).status, 'waiting', 'still waiting on Mike');
    // Unarchiving itself, and other threads, are fine.
    assert.equal(await tb(h, url, ['unarchive', self.id], inThread).exited, 0);
    assert.equal(await tb(h, url, ['archive', other.id], inThread).exited, 0);
    assert.ok(h.runner.get(other.id).archivedAt);
    assert.equal(await tb(h, url, ['delete', other.id], inThread).exited, 0);
    assert.throws(() => h.runner.get(other.id));
  } finally {
    await server.close();
  }
});

test('tb finds a runner on port 0 through runner.json, as the CLIs of a dev or sandbox runner must', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-port-'));
  try {
    fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ port: 4242 }));
    const env = { THREADBEAR_HOME: home, THREADBEAR_PORT: '0' };
    assert.equal(runnerUrl(loadConfig(env), env), 'ws://127.0.0.1:4242/rpc');
    const fixed = { THREADBEAR_HOME: home, THREADBEAR_PORT: '5151' };
    assert.equal(runnerUrl(loadConfig(fixed), fixed), 'ws://127.0.0.1:5151/rpc');
    const url = { ...env, THREADBEAR_URL: 'ws://127.0.0.1:1/rpc' };
    assert.equal(runnerUrl(loadConfig(url), url), 'ws://127.0.0.1:1/rpc');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('tb refuses flags its command does not read, explains one command with --help, and prints a seq range of events', async () => {
  const { h, server, url } = await serve();
  const { thread } = h.runner.create({ text: 'first', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'one');
  s.result();
  try {
    let t = tb(h, url, ['show', thread.id, '--from', '3']);
    assert.equal(await t.exited, 2);
    assert.match(t.out(), /^tb show doesn't take --from\. It takes --last, --tools\.\nSee tb show --help\.\n$/);
    t = tb(h, url, ['show', '--help']);
    assert.equal(await t.exited, 0);
    assert.match(t.out(), /^  tb show <threadId> \[--last N\] \[--tools\]\n +the thread as plain text/);
    assert.doesNotMatch(t.out(), /tb new/);
    t = tb(h, url, ['unarchive', '--help']);
    assert.equal(await t.exited, 0);
    assert.match(t.out(), /tb unarchive <threadId>/);

    const all = h.events(thread.id);
    t = tb(h, url, ['events', thread.id, '--from', '2', '--to', '3']);
    assert.equal(await t.exited, 0, t.out());
    const lines = t.out().trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => Number(l.slice(0, 5))), [2, 3], t.out());
    assert.equal(lines[0], '    2  (turn started)');
    assert.ok(all.length > 3);
    t = tb(h, url, ['events', thread.id, '--from', '2', '--json']);
    assert.equal(await t.exited, 0);
    assert.deepEqual(t.out().trimEnd().split('\n').map((l) => JSON.parse(l).seq), all.slice(1).map((e) => e.seq));
    t = tb(h, url, ['events', thread.id, '--from', '3', '--to', '2']);
    assert.equal(await t.exited, 1);
    assert.match(t.out(), /--to is before --from/);
  } finally {
    await server.close();
  }
});

test('tb list says what a thread is still running in the background', () => {
  assert.equal(backgroundFlag(undefined), '');
  assert.equal(backgroundFlag([]), '');
  assert.equal(backgroundFlag([{ kind: 'agent', description: 'a' }]), '1 sub-agent in the background');
  assert.equal(
    backgroundFlag([{ kind: 'agent', description: 'a' }, { kind: 'agent', description: 'b' }, { kind: 'shell', description: 'npm test' }, { kind: 'agent', description: 'c', finished: true }]),
    '2 sub-agents, 1 shell job, 1 just finished in the background',
  );
  assert.equal(backgroundFlag([{ kind: 'other', description: 'x', finished: true }]), '1 just finished');
});

test('tb new on codex-main with a model and effort, tb accounts with and without an account', async () => {
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex().map((a) => (a.id === 'claude-3' ? { ...a, note: 'Convex work only' } : a))) });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: readToken(h.home), runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  try {
    const n = tb(h, url, ['new', 'draw a bear', '--account', 'codex-main', '--model', 'gpt-6-luna', '--effort', 'low']);
    assert.equal(await n.exited, 0, n.out());
    const id = n.out().trim();
    const t = h.runner.get(id);
    assert.equal(t.provider, 'codex');
    assert.equal(t.model, 'gpt-6-luna');
    assert.equal(t.effort, 'low');
    assert.equal(h.codex.last.opts.model, 'gpt-6-luna');
    assert.match(formatSelf(t), /Account: codex-main \(Codex\), model gpt-6-luna/);

    const m = tb(h, url, ['accounts', 'codex-main']);
    assert.equal(await m.exited, 0, m.out());
    assert.match(m.out(), /^codex-main \(Codex\)/);
    assert.match(m.out(), /\* gpt-6\.1-sol +GPT-6\.1-Sol +efforts: low, medium, high, xhigh, max, ultra \(own level low\)/);
    assert.match(m.out(), /\n {2}gpt-6-luna +GPT-6-Luna/);
    assert.match(m.out(), /Account default: gpt-6\.1-sol/);
    const j = tb(h, url, ['accounts', 'codex-main', '--json']);
    assert.equal(await j.exited, 0);
    assert.equal(JSON.parse(j.out()).models.length, 2);
    const none = tb(h, url, ['accounts', 'claude-3']);
    assert.equal(await none.exited, 0);
    assert.match(none.out(), /hasn't been asked for its models yet/);
    const missing = tb(h, url, ['accounts', 'nope']);
    assert.equal(await missing.exited, 1);
    assert.match(missing.out(), /No account nope/);

    const a = tb(h, url, ['accounts']);
    assert.equal(await a.exited, 0);
    // The provider once, then the email (not "Codex  Codex · ...").
    assert.match(a.out(), /^\* codex-main +Codex +main@example\.com$/m);
    assert.doesNotMatch(a.out(), /Codex · /);
    assert.match(a.out(), /^ {2}claude-3 +Claude +three@example\.com {2}\(Convex work only\)$/m);
  } finally {
    await server.close();
  }
});

test('tb pools lists the pools with their logins, and tb new --pool starts a thread on one', async () => {
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex()) });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: readToken(h.home), runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  try {
    const p = tb(h, url, ['pools']);
    assert.equal(await p.exited, 0, p.out());
    assert.match(p.out(), /^\* claude +Claude +claude-main room unknown, claude-3 room unknown$/m);
    assert.match(p.out(), /^ {2}codex +Codex +codex-main room unknown$/m);
    const j = tb(h, url, ['pools', '--json']);
    assert.equal(await j.exited, 0);
    assert.equal(JSON.parse(j.out()).defaultPoolId, 'claude');
    const n = tb(h, url, ['new', 'draw a bear', '--pool', 'codex']);
    assert.equal(await n.exited, 0, n.out());
    const t = h.runner.get(n.out().trim());
    assert.equal(t.poolId, 'codex');
    assert.equal(t.provider, 'codex');
    const bad = tb(h, url, ['new', 'x', '--pool', 'nope']);
    assert.equal(await bad.exited, 1);
    assert.match(bad.out(), /No pool called nope/);
  } finally {
    await server.close();
  }
});
