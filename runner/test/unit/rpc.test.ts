import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { RpcError } from '../../src/protocol.ts';
import { nullLogger } from '../../src/log.ts';
import { checkSequence, checkSummary } from '../helpers/protocol-check.ts';
import { patiently } from '../helpers/patience.ts';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import { authProof, isNonce, newNonce } from '../../src/rpc-auth.ts';

const TOKEN = 'test-token-0123456789';
// What the runner's main server binds its proofs to.
const main = (port: number) => ({ server: 'primary' as const, port });

async function serve(extra: Partial<ConstructorParameters<typeof RpcServer>[0]> = {}) {
  const h = makeHarness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: TOKEN, runner: h.runner, log: nullLogger, ...extra });
  const { port } = await server.listen();
  const url = `ws://127.0.0.1:${port}/rpc`;
  return { h, server, url, port };
}

test('local tools queue a panel only with a connected Mac app, including through a handover', async () => {
  const calls: string[] = [];
  const remote = { owns: (id: string) => id === 'away', call: async (_id: string, method: string) => { calls.push(method); return { available: true, shown: false }; }, summaries: () => [], search: async () => [] };
  const { h, server, url } = await serve({ remote });
  const c = await RunnerClient.connect(url, TOKEN);
  const mac = await RunnerClient.connect(url, TOKEN);
  try {
    const { thread } = h.runner.create({ text: 'Browser handoff', accountId: 'claude-3' });
    assert.deepEqual(await c.call('threads.showPanel', { threadId: thread.id, panel: 'browser' }), { available: false });
    assert.equal(h.runner.get(thread.id).panelRequest, undefined);
    assert.deepEqual(await c.call('threads.showPanel', { threadId: 'away', panel: 'browser' }), { available: false });
    assert.deepEqual(calls, []);
    await mac.call('hello', { client: 'threadbear-mac' });
    assert.deepEqual(await c.call('threads.showPanel', { threadId: thread.id, panel: 'browser' }), { available: false }, 'an older Mac app uses the Chrome fallback');
    await mac.call('hello', { client: 'threadbear-mac', browserPanel: true });
    const pending = c.call('threads.showPanel', { threadId: thread.id, panel: 'browser' });
    await patiently(() => Boolean(h.runner.get(thread.id).panelRequest));
    assert.equal(h.runner.get(thread.id).panelRequest?.panel, 'threadbear.browser');
    h.clock.advance(2000);
    assert.equal((await pending).available, true);
    await c.call('threads.showPanel', { threadId: 'away', panel: 'browser' });
    assert.deepEqual(calls, ['threads.showPanel']);
  } finally { c.close(); mac.close(); await server.close(); }
});

test('challenge auth, hello, and JSON-RPC errors', async () => {
  const { server, url } = await serve();
  const c = await RunnerClient.connect(url, TOKEN);
  const hello = await c.call('hello', { client: 'test', version: '1' });
  assert.equal(hello.protocol, 1);
  assert.deepEqual(hello.accounts.map((a: { id: string }) => a.id), ['claude-main', 'claude-3']);
  assert.ok(hello.defaults.cwd);
  await assert.rejects(c.call('threads.events', { threadId: 'missing' }), (e: { code: number }) => e.code === -32004);
  await assert.rejects(c.call('threads.create', { text: 1 }), (e: { code: number }) => e.code === -32602);
  await assert.rejects(c.call('threads.create', { text: 'x', accountId: 'claude-42' }), (e: { code: number }) => e.code === -32010);
  await assert.rejects(c.call('threads.create', { text: 'x', effort: 'huge' }), (e: { code: number; message: string }) => e.code === -32602 && /effort must be one of/.test(e.message));
  await assert.rejects(c.call('nope.method'), (e: { code: number }) => e.code === -32601);
  c.close();
  await server.close();
});

test('old clients still get in: first-message auth with the token; anything else first closes with 4401', async () => {
  const { server, url } = await serve();
  const ok = new RunnerClient(url, undefined);
  await ok.opened;
  assert.deepEqual(await ok.call('auth', { token: TOKEN }), {});
  assert.equal((await ok.call('hello', { client: 't', version: '1' })).protocol, 1);
  ok.close();

  const bad = new RunnerClient(url, undefined);
  await bad.opened;
  bad.sendRaw({ jsonrpc: '2.0', id: 1, method: 'threads.list', params: {} });
  assert.equal((await bad.waitClosed()).code, 4401);

  const wrong = new RunnerClient(url, undefined);
  await wrong.opened;
  wrong.sendRaw({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: 'wrong-token' } });
  assert.equal((await wrong.waitClosed()).code, 4401);
  await server.close();
});

// The upgrade's status and the first message, from a bare ws client.
function rawConnect(url: string, headers?: Record<string, string>): Promise<{ ws?: WebSocket; status?: number; first?: any }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once('error', () => resolve({}));
    ws.once('message', (data) => resolve({ ws, first: JSON.parse(data.toString()) }));
    // A bearer-authed socket gets no challenge, so nothing to wait for.
    if (headers) ws.once('open', () => setTimeout(() => resolve({ ws }), 50));
  });
}

test('challenge auth: the runner challenges, the client proves, the runner proves back', async () => {
  const { server, url, port } = await serve();
  const { ws, first } = await rawConnect(url);
  assert.equal(first.method, 'auth.challenge');
  assert.equal(first.params.version, 1);
  assert.equal(first.params.port, port);
  assert.ok(isNonce(first.params.nonce));
  const clientNonce = newNonce();
  const reply = new Promise<any>((r) => ws!.once('message', (d) => r(JSON.parse(d.toString()))));
  ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 'auth', method: 'auth.prove', params: { nonce: clientNonce, proof: authProof(TOKEN, 'client', first.params.nonce, clientNonce, main(port)) } }));
  const answer = await reply;
  assert.equal(answer.id, 'auth');
  assert.equal(answer.result.proof, authProof(TOKEN, 'runner', first.params.nonce, clientNonce, main(port)));
  ws!.close();

  // A proof made without the token, or the runner's own proof played back.
  for (const proof of [authProof('wrong-token', 'client', 'x', clientNonce, main(port)), 'nope']) {
    const { ws: w, first: f } = await rawConnect(url);
    const closed = new Promise<number>((r) => w!.once('close', (code) => r(code)));
    w!.send(JSON.stringify({ jsonrpc: '2.0', id: 'auth', method: 'auth.prove', params: { nonce: clientNonce, proof: proof === 'nope' ? authProof(TOKEN, 'runner', f.params.nonce, clientNonce, main(port)) : proof } }));
    assert.equal(await closed, 4401);
  }

  // RunnerClient does all that, and a wrong token is refused.
  const c = await RunnerClient.connect(url, TOKEN);
  assert.equal((await c.call('hello', { client: 't', version: '1' })).protocol, 1);
  c.close();
  const wrong = new RunnerClient(url, 'wrong-token');
  await assert.rejects(wrong.opened);
  assert.equal((await wrong.waitClosed()).code, 4401);
  await server.close();
});

test('an old client\'s bearer header still works; a wrong one is turned away at the upgrade', async () => {
  const { server, url } = await serve();
  const good = await rawConnect(url, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(good.first, undefined, 'no challenge for a bearer-authed client');
  const reply = new Promise<any>((r) => good.ws!.once('message', (d) => r(JSON.parse(d.toString()))));
  good.ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { client: 't', version: '1' } }));
  assert.equal((await reply).result.protocol, 1);
  good.ws!.close();
  assert.equal((await rawConnect(url, { Authorization: 'Bearer wrong-token' })).status, 401);
  assert.equal((await rawConnect(url, { Authorization: 'Basic abc' })).status, 401);
  assert.equal((await rawConnect(url.replace('/rpc', '/other'))).status, 400);
  await server.close();
});

// Something else on the runner's port while it's down (another account
// can bind it then), recording what it's sent. `silent` says nothing,
// `old` talks like a runner from before the challenge, `challenge` makes
// one up and answers with a made-up proof.
async function impostor(mode: 'silent' | 'old' | 'challenge') {
  const seen: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws, req) => {
    seen.push(JSON.stringify(req.headers));
    if (mode === 'challenge') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth.challenge', params: { version: 1, nonce: 'b'.repeat(64) } }));
    if (mode === 'old') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'runner.notice', params: { level: 'info', message: 'hi' } }));
    ws.on('message', (d) => {
      seen.push(d.toString());
      const id = JSON.parse(d.toString()).id;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result: mode === 'challenge' ? { proof: 'c'.repeat(64) } : {} }));
    });
  });
  const port = (wss.address() as { port: number }).port;
  const close = () => {
    for (const ws of wss.clients) ws.terminate();
    return new Promise<void>((r) => wss.close(() => r()));
  };
  return { port, url: `ws://127.0.0.1:${port}/rpc`, seen, close };
}

test('a listener on the runner\'s port never gets the token from tb or deploy, whatever it pretends to be', async () => {
  // A path in a variable: rpc-client.mjs has no types.
  const rpcClient = new URL('../../scripts/rpc-client.mjs', import.meta.url).href;
  const { connectRpc } = await import(rpcClient);
  for (const mode of ['silent', 'old', 'challenge'] as const) {
    const imp = await impostor(mode);
    const c = new RunnerClient(imp.url, TOKEN, { authTimeoutMs: 300 });
    await assert.rejects(c.opened, /prove|challenge|isn't the runner/i, mode);
    await assert.rejects(connectRpc(imp.port, TOKEN, 300), /prove|challenge|isn't the runner/i, mode);
    for (const for_ of imp.seen) {
      assert.ok(!for_.includes(TOKEN), `${mode}: the token reached it: ${for_}`);
      assert.ok(!/"authorization"/i.test(for_), `${mode}: an Authorization header reached it`);
    }
    assert.ok(imp.seen.length >= 2, `${mode}: both clients reached it`);
    (c as any).ws.terminate();
    await imp.close();
  }
});

test('reconnecting after an outage: the impostor that held the port gets nothing, the real runner lets the client in', async () => {
  const { server, port } = await serve();
  const url = `ws://127.0.0.1:${port}/rpc`;
  (await RunnerClient.connect(url, TOKEN)).close();
  await server.close();
  // Down; something else takes the port.
  const seen: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws, req) => {
    seen.push(JSON.stringify(req.headers));
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'auth.challenge', params: { version: 1, nonce: 'b'.repeat(64) } }));
    ws.on('message', (d) => {
      seen.push(d.toString());
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'auth', result: { proof: 'c'.repeat(64) } }));
    });
  });
  await assert.rejects(RunnerClient.connect(url, TOKEN), /isn't the runner/);
  assert.ok(seen.length === 2 && seen.every((x) => !x.includes(TOKEN) && !/"authorization"/i.test(x)), seen.join('\n'));
  // A proof it was given is no good on the real runner, whose nonce is fresh.
  const replay = JSON.parse(seen[1]!);
  for (const x of wss.clients) x.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  const back = await serve({ port });
  const { ws, first } = await rawConnect(url);
  assert.notEqual(first.params.nonce, 'b'.repeat(64));
  const closed = new Promise<number>((r) => ws!.once('close', (code) => r(code)));
  ws!.send(JSON.stringify(replay));
  assert.equal(await closed, 4401);
  const c = await RunnerClient.connect(url, TOKEN);
  assert.equal((await c.call('hello', { client: 't', version: '1' })).protocol, 1);
  c.close();
  await back.server.close();
});

test('before auth: frames over 64 KiB are refused, and only so many sockets may wait', async () => {
  const { server, url, port } = await serve({ maxPendingAuth: 3 });
  // A big frame is closed with 1009 by the frame limit, before the runner
  // reads (let alone parses) any of it.
  const big = await rawConnect(url);
  const closed = new Promise<number>((r) => big.ws!.once('close', (code) => r(code)));
  big.ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: TOKEN, pad: 'x'.repeat(100 * 1024) } }));
  assert.equal(await closed, 1009);
  // Even with a valid bearer too much would be refused before auth; with
  // the challenge, three waiting sockets fill it and the fourth is 503.
  const waiting = [await rawConnect(url), await rawConnect(url), await rawConnect(url)];
  assert.ok(waiting.every((w) => w.first?.method === 'auth.challenge'));
  assert.equal((await rawConnect(url)).status, 503);
  // A bearer-authed old client isn't waiting, so it still gets in.
  const old = await rawConnect(url, { Authorization: `Bearer ${TOKEN}` });
  assert.ok(old.ws);
  old.ws!.close();
  // One proving itself frees a slot.
  const w = waiting[0]!;
  const n = newNonce();
  const proved = new Promise<any>((r) => w.ws!.once('message', (d) => r(JSON.parse(d.toString()))));
  w.ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 'auth', method: 'auth.prove', params: { nonce: n, proof: authProof(TOKEN, 'client', w.first.params.nonce, n, main(port)) } }));
  assert.ok((await proved).result.proof);
  const next = await rawConnect(url);
  assert.equal(next.first?.method, 'auth.challenge');
  // So does one refused, once it's gone: within a second even if it never
  // answers the close, and not before, so refused sockets can't pile up.
  assert.equal((await rawConnect(url)).status, 503);
  (waiting[1]!.ws as any)._socket.removeAllListeners('data');
  waiting[1]!.ws!.send('not json');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await rawConnect(url)).status, 503, 'still counted until it has gone');
  await patiently(() => (server as any).pendingAuth() < 3);
  const after = await rawConnect(url);
  assert.equal(after.first?.method, 'auth.challenge');
  for (const x of [...waiting, next, after]) x.ws?.terminate();
  await server.close();
});

test('once authenticated, a client can send big frames and gets big transcript pages', async () => {
  const { server, url } = await serve();
  const pad = 'y'.repeat(2 * 1024 * 1024);
  for (const c of [await RunnerClient.connect(url, TOKEN), await RunnerClient.connect(url, TOKEN, { legacyHeader: true })]) {
    // Over the pre-auth limit, answered rather than closed.
    await assert.rejects(c.call('nope.method', { pad }), (e: { code: number }) => e.code === -32601);
    const { thread } = await c.call('threads.create', { text: 'z'.repeat(300 * 1024), accountId: 'claude-3' });
    const page = await c.call('threads.events', { threadId: thread.id });
    assert.ok(JSON.stringify(page).length > 300 * 1024, 'a page over the pre-auth limit');
    assert.equal(c.closeInfo, undefined);
    c.close();
  }
  await server.close();
});

// Whatever holds port P passing everything through to a real runner on
// another port, as something that took the main port while the runner was
// down could with a draining runner's.
async function relay(backend: string) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const backendCloses: number[] = [];
  wss.on('connection', (front) => {
    const back = new WebSocket(backend);
    const early: string[] = [];
    back.on('open', () => early.splice(0).forEach((m) => back.send(m)));
    back.on('message', (d) => front.readyState === WebSocket.OPEN && front.send(d.toString()));
    front.on('message', (d) => (back.readyState === WebSocket.OPEN ? back.send(d.toString()) : early.push(d.toString())));
    back.on('close', (code) => {
      backendCloses.push(code);
      front.terminate();
    });
    front.on('close', () => back.terminate());
  });
  const port = (wss.address() as { port: number }).port;
  const close = () => {
    for (const ws of wss.clients) ws.terminate();
    return new Promise<void>((r) => wss.close(() => r()));
  };
  return { url: `ws://127.0.0.1:${port}/rpc`, backendCloses, close };
}

test('a challenge relayed from a runner on another port can\'t be answered: the proofs are bound to the port and kind of server', async () => {
  const drain = await serve({ onlyOwn: true });
  const other = await serve();
  for (const backend of [drain, other]) {
    const r = await relay(backend.url);
    await assert.rejects(RunnerClient.connect(r.url, TOKEN), /isn't the runner|prove|closed|accept/i);
    const { connectRpc } = await import(new URL('../../scripts/rpc-client.mjs', import.meta.url).href);
    await assert.rejects(connectRpc(Number(new URL(r.url).port), TOKEN, 1000));
    await patiently(() => r.backendCloses.length >= 2);
    assert.deepEqual(r.backendCloses, [4401, 4401], 'the real runner turned the relayed proof down');
    await r.close();
  }
  // Straight to them, each is fine; the drain server only for a client
  // that meant to reach one (the primary, in a handover).
  (await RunnerClient.connect(other.url, TOKEN)).close();
  (await RunnerClient.connect(drain.url, TOKEN, { server: 'drain' })).close();
  await assert.rejects(RunnerClient.connect(drain.url, TOKEN));
  await drain.server.close();
  await other.server.close();
});

// A bare upgrade, then a text frame header that says 65,537 bytes, and then
// nothing: no payload, no answer to the close.
function oversizedFrame(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.once('data', (d) => {
      if (!d.toString('latin1').startsWith('HTTP/1.1 101')) return reject(new Error(d.toString('latin1').split('\r\n')[0]));
      const head = Buffer.alloc(14);
      head[0] = 0x81;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(65537n, 2);
      sock.write(head);
      resolve(sock);
    });
    sock.on('error', () => {});
  });
}

test('a socket refused for an oversized frame is cut off at once and counts as waiting until it\'s gone', async () => {
  const { server, port } = await serve({ maxPendingAuth: 1 });
  const pending = () => (server as any).pendingAuth() as number;
  for (let i = 0; i < 4; i++) {
    const sock = await oversizedFrame(port);
    const t0 = Date.now();
    await new Promise((r) => sock.once('close', r));
    assert.ok(Date.now() - t0 < 1000, 'terminated, not left in ws\'s 30 s close');
    await patiently(() => pending() === 0);
  }
  // While one is still there, the next is turned away.
  const held = await rawConnect(`ws://127.0.0.1:${port}/rpc`);
  assert.equal(pending(), 1);
  assert.equal((await rawConnect(`ws://127.0.0.1:${port}/rpc`)).status, 503);
  held.ws!.terminate();
  await server.close();
});

test('proofs match the Mac app\'s (RunnerAuthTests.swift)', () => {
  const r = 'a'.repeat(64);
  const c = '0123456789abcdef'.repeat(4);
  assert.equal(authProof('test-token-0123456789', 'client', r, c, main(8797)), '3ff1854cab19b025f45ba2df4f40da330a65cee664c32eb9c3a69e471b570a0a');
  assert.equal(authProof('test-token-0123456789', 'runner', r, c, main(8797)), '8230a5ad1a4a1ddeab7cee6ffcd1a4ab7b4926a1b8a1fe23eeccd12faef46d5a');
});

test('health endpoint answers without a token', async () => {
  const { server, port } = await serve();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await res.json(), { ok: true });
  await server.close();
});

test('subscribe replays the gap then streams; thread.updated goes to everyone', async () => {
  const { h, server, url } = await serve();
  const a = await RunnerClient.connect(url, TOKEN);
  const b = await RunnerClient.connect(url, TOKEN);
  const aNotes: { method: string; params: any }[] = [];
  const bNotes: { method: string; params: any }[] = [];
  a.onNotification((method, params) => aNotes.push({ method, params }));
  b.onNotification((method, params) => bNotes.push({ method, params }));

  const created = await a.call('threads.create', { text: 'hello', accountId: 'claude-3' });
  assert.deepEqual(checkSummary(created.thread), []);
  const id = created.thread.id;
  const s = h.adapter.last;
  s.init();
  s.text('m1:0', 'first');

  const sub = await a.call('threads.subscribe', { threadId: id, afterSeq: 1 });
  assert.deepEqual(sub.events.map((e: { seq: number }) => e.seq), [2, 3]);
  s.delta('m2:0', 'str');
  h.clock.advance(40);
  s.text('m2:0', 'streamed');
  s.result('completed', 0.001);
  // Wait for them to arrive: a fixed 50 ms wasn't always enough on a
  // busy Mac (29 Oct).
  const arrived = () => aNotes.filter((n) => n.method === 'thread.event').length >= 3 && bNotes.some((n) => n.method === 'thread.updated');
  await patiently(arrived);

  const live = aNotes.filter((n) => n.method === 'thread.event').map((n) => n.params.event);
  assert.deepEqual(checkSequence([...sub.events, ...live], 1), []);
  assert.deepEqual(live.map((e) => e.type), ['assistant.text.delta', 'assistant.text', 'turn.completed']);
  assert.equal(bNotes.filter((n) => n.method === 'thread.event').length, 0, 'b never subscribed');
  assert.ok(bNotes.some((n) => n.method === 'thread.updated' && n.params.thread.id === id));
  for (const n of bNotes) if (n.method === 'thread.updated') assert.deepEqual(checkSummary(n.params.thread), []);

  await a.call('threads.unsubscribe', { threadId: id });
  await b.call('threads.send', { threadId: id, text: 'again' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(aNotes.filter((n) => n.method === 'thread.event').length, live.length, 'no events after unsubscribe');

  const page = await b.call('threads.events', { threadId: id });
  assert.equal(page.firstSeq, 1);
  assert.equal(page.lastSeq, page.events.at(-1).seq);
  assert.deepEqual(page.inProgress, []);
  const seen = await b.call('threads.markSeen', { threadId: id, seq: page.lastSeq });
  assert.equal(seen.thread.lastSeenSeq, page.lastSeq);
  const list = await b.call('threads.list', { include: ['inbox', 'snoozed', 'archived'] });
  assert.deepEqual(list.threads.map((t: { id: string }) => t.id), [id]);
  await assert.rejects(b.call('threads.list', { include: ['bogus'] }), (e: { code: number }) => e.code === -32602);
  await assert.rejects(b.call('threads.send', { threadId: id, text: 'x', answers: [{ action: 'a' }] }), (e: { code: number }) => e.code === -32602);
  // A phone command the primary passed on keeps its origin; nothing else
  // can be claimed.
  await b.call('threads.send', { threadId: id, text: 'from the phone', origin: 'phone' });
  await new Promise((r) => setTimeout(r, 30));
  const phoned = (await b.call('threads.events', { threadId: id })).events.find((e: { type: string; text?: string }) => e.type === 'user.message' && e.text === 'from the phone');
  assert.equal(phoned?.origin, 'phone');
  await assert.rejects(b.call('threads.send', { threadId: id, text: 'x', origin: 'runner' }), (e: { code: number }) => e.code === -32602);
  a.close();
  b.close();
  await server.close();
});

test('unauthenticated sockets are dropped: silence past the timeout, or a binary frame', async () => {
  const { server, url } = await serve({ authTimeoutMs: 200 });
  const quiet = new RunnerClient(url, undefined);
  await quiet.opened;
  assert.equal((await quiet.waitClosed()).code, 4401);
  const binary = new RunnerClient(url, undefined);
  await binary.opened;
  (binary as any).ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await binary.waitClosed()).code, 4401);
  // An authenticated client isn't affected by the timer.
  const ok = await RunnerClient.connect(url, TOKEN);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await ok.call('hello', { client: 't', version: '1' })).protocol, 1);
  ok.close();
  await server.close();
});

test('seqs and limits must be whole numbers', async () => {
  const { server, url } = await serve();
  const c = await RunnerClient.connect(url, TOKEN);
  const { thread } = await c.call('threads.create', { text: 'hi', accountId: 'claude-3' });
  for (const [method, params] of [
    ['threads.events', { threadId: thread.id, afterSeq: 1.5 }],
    ['threads.events', { threadId: thread.id, beforeSeq: 2.5 }],
    ['threads.events', { threadId: thread.id, limit: 0.5 }],
    ['threads.subscribe', { threadId: thread.id, afterSeq: 1.5 }],
    ['threads.search', { query: 'hi', limit: 1.5 }],
  ] as const) {
    await assert.rejects(c.call(method, params), (e: { code: number }) => e.code === -32602, `${method} ${JSON.stringify(params)}`);
  }
  c.close();
  await server.close();
});

test('hello is followed by notices the client missed, such as a missing claude binary', async () => {
  const { server, url } = await serve();
  const c = await RunnerClient.connect(url, TOKEN);
  const notices: any[] = [];
  c.onNotification((method, params) => {
    if (method === 'runner.notice') notices.push(params);
  });
  await c.call('hello', { client: 't', version: '1' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(notices.some((n) => n.level === 'error' && /claude CLI isn't at/.test(n.message)));
  c.close();
  await server.close();
});

test('a subscriber that stops reading loses deltas, then is disconnected', async () => {
  const { h, server, url } = await serve({ skipDeltasBytes: 64 * 1024, closeBytes: 1024 * 1024 });
  const reader = await RunnerClient.connect(url, TOKEN);
  const stalled = await RunnerClient.connect(url, TOKEN);
  const { thread } = await reader.call('threads.create', { text: 'hi', accountId: 'claude-3' });
  await stalled.call('threads.subscribe', { threadId: thread.id });
  (stalled as any).ws._socket.pause();
  const s = h.adapter.last;
  s.init();
  const big = 'x'.repeat(256 * 1024);
  // Until the server drops it from its clients. The stalled client can't see
  // its close while paused, and ws gives it 30 s to answer before cutting it
  // off with a 1006, which more of these writes outlasted at background
  // priority (2 Nov).
  const clients = (server as any).conns as Set<unknown>;
  for (let i = 0; i < 400 && clients.size === 2; i++) {
    s.text(`m${i}:0`, big);
    await new Promise((r) => setImmediate(r));
  }
  (stalled as any).ws._socket.resume();
  const closed = await stalled.waitClosed();
  assert.equal(closed.code, 4408);
  // Everyone else is fine, and the stalled client can catch up from its seq.
  assert.equal((await reader.call('hello', { client: 't', version: '1' })).protocol, 1);
  reader.close();
  await server.close();
});

test('close does not wait long for a client that never answers the close', async () => {
  const { server, url } = await serve({ closeGraceMs: 200 });
  const ok = await RunnerClient.connect(url, TOKEN);
  // Stops reading, so it never answers the runner's close frame; ws alone
  // would wait 30 s for it.
  const silent = await RunnerClient.connect(url, TOKEN);
  (silent as any).ws._socket.pause();
  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 5000, `close took ${Date.now() - started} ms`);
  assert.equal((await ok.waitClosed()).code, 1001);
  (silent as any).ws._socket.resume();
  await silent.waitClosed();
});

test('panels.render answers after the screenshot, with an image or a note; unknown panels are bad params', async () => {
  const root = (await import('../helpers/fakes.ts')).tmpDir();
  const project = `${root}/Walkies`;
  const fs = await import('node:fs');
  fs.mkdirSync(`${project}/Walkies.xcodeproj`, { recursive: true });
  let shots = 0;
  const h = makeHarness(undefined, {}, {
    panelsRoot: root,
    screenshot: async (file: string) => {
      shots++;
      if (shots > 1) throw new Error('No devices are booted.');
      fs.writeFileSync(file, (await import('../helpers/png.ts')).makePng(20, 10));
    },
  });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: TOKEN, runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  const c = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, TOKEN);
  const { thread } = await c.call('threads.create', { text: 'hi', cwd: project });
  assert.deepEqual(thread.panels.map((p: { id: string }) => p.id), ['xcode.simulator']);
  const first = await c.call('panels.render', { threadId: thread.id, panelId: 'xcode.simulator' });
  assert.equal(first.image.width, 20);
  assert.equal(first.note, undefined);
  const second = await c.call('panels.render', { threadId: thread.id, panelId: 'xcode.simulator' });
  assert.equal(second.image, undefined);
  assert.match(second.note, /No simulator is booted/);
  await assert.rejects(c.call('panels.render', { threadId: thread.id, panelId: 'nope' }), (e: { code: number }) => e.code === -32602);
  await assert.rejects(c.call('panels.render', { threadId: 'missing', panelId: 'nope' }), (e: { code: number }) => e.code === -32004);
  c.close();
  await server.close();
});

test('clis.* call CliUpdates and return at once; without it they are -32601; clis.updated reaches every client', async () => {
  const calls: unknown[][] = [];
  const status = [{ provider: 'codex', path: '/t/codex', managedBy: 'threadbear', installedVersion: '0.164.0', status: 'current', policy: 'auto', inUse: [] }] as never[];
  let changed: (c: never[]) => void = () => {};
  const clis = {
    list: () => (calls.push(['list']), status),
    check: (p?: string) => (calls.push(['check', p]), status),
    update: (p: string, o?: object) => (calls.push(['update', p, o]), status),
    setPolicy: (p: string, policy: string) => (calls.push(['setPolicy', p, policy]), status),
    onChange: (fn: (c: never[]) => void) => ((changed = fn), () => {}),
  };
  const { h, server, url } = await serve({ clis });
  h.runner.attachClis(clis);
  const c = await RunnerClient.connect(url, TOKEN);
  const got: { method: string; params: any }[] = [];
  c.onNotification((method, params) => got.push({ method, params }));
  const hello = await c.call('hello', { client: 'test', version: '1' });
  assert.equal(hello.clis[0].installedVersion, '0.164.0');
  assert.deepEqual(await c.call('clis.list'), { clis: status });
  await c.call('clis.check', {});
  await c.call('clis.check', { provider: 'claude' });
  await c.call('clis.update', { provider: 'codex', version: '0.164.0', force: true });
  await c.call('clis.update', { provider: 'claude' });
  await c.call('clis.setPolicy', { provider: 'codex', policy: 'notify' });
  assert.deepEqual(calls.filter((x) => x[0] !== 'list'), [
    ['check', undefined],
    ['check', 'claude'],
    ['update', 'codex', { version: '0.164.0', force: true }],
    ['update', 'claude', {}],
    ['setPolicy', 'codex', 'notify'],
  ]);
  const badParams = (e: { code: number }) => e.code === -32602;
  await assert.rejects(c.call('clis.update', { provider: 'grok' }), badParams);
  await assert.rejects(c.call('clis.update', {}), badParams);
  await assert.rejects(c.call('clis.update', { provider: 'codex', version: '../../evil' }), badParams);
  await assert.rejects(c.call('clis.update', { provider: 'codex', force: 'yes' }), badParams);
  await assert.rejects(c.call('clis.setPolicy', { provider: 'codex', policy: 'sometimes' }), badParams);
  await assert.rejects(c.call('clis.check', { provider: 3 }), badParams);
  changed(status);
  // Wait for it, not a fixed time: the whole suite runs at once.
  await patiently(() => got.some((n) => n.method === 'clis.updated'));
  assert.deepEqual(got.find((n) => n.method === 'clis.updated')?.params, { clis: status });
  c.close();
  await server.close();

  const old = await serve();
  const o = await RunnerClient.connect(old.url, TOKEN);
  for (const m of ['clis.list', 'clis.check', 'clis.update', 'clis.setPolicy']) {
    await assert.rejects(o.call(m, { provider: 'codex', policy: 'auto' }), (e: { code: number }) => e.code === -32601, m);
  }
  assert.equal((await o.call('hello', { client: 'test', version: '1' })).clis, undefined);
  o.close();
  await old.server.close();
});

// Handovers (docs/protocol.md): the primary passes a request about a
// draining runner's thread to it, lists its threads with its own, and
// handles the request itself if that thread has just come across.
test('threads.panelShown clears the thread\'s panel request, and goes to a draining runner that has the thread', async () => {
  const away = { id: 'away-2', title: 'Busy elsewhere', status: 'running', lastActivityAt: '2099-01-01T00:00:00.000Z' } as any;
  const calls: { threadId: string; method: string }[] = [];
  const remote = {
    owns: (id: string) => id === away.id,
    call: async (threadId: string, method: string) => {
      calls.push({ threadId, method });
      return { thread: away };
    },
    summaries: () => [away],
    search: async () => [away],
  };
  const { h, server, url } = await serve({ remote: remote as any });
  const { thread } = h.runner.create({ text: 'here', accountId: 'claude-3' });
  const c = await RunnerClient.connect(url, TOKEN);
  try {
    const shown = h.runner.showPanel(thread.id, { panel: 'usage' });
    const request = h.runner.get(thread.id).panelRequest!;
    const res = await c.call('threads.panelShown', { threadId: thread.id, requestId: request.id });
    assert.deepEqual(checkSummary(res.thread), []);
    assert.equal(res.thread.panelRequest, undefined);
    assert.equal((await shown).shown, true);
    await assert.rejects(c.call('threads.panelShown', { threadId: thread.id }), (e: { code: number }) => e.code === -32602);
    await c.call('threads.panelShown', { threadId: away.id, requestId: 'r1' });
    assert.deepEqual(calls, [{ threadId: away.id, method: 'threads.panelShown' }]);
  } finally {
    c.close();
    await server.close();
  }
});

// Every request that names a thread goes to the draining runner holding it.
// patches.trust wasn't on the list, so pressing Trust on a thread that was
// finishing its turn on the old runner during an update said "Thread not
// found" (Mike, 7 Nov). This reads the methods from rpc.ts so a new one
// can't miss the list again.
test('every request about a thread reaches the draining runner that has it', async () => {
  const src = fs.readFileSync(new URL('../../src/rpc.ts', import.meta.url), 'utf8');
  const named = new Set<string>();
  for (const block of src.split(/\n\s*case '/).slice(1)) {
    const method = block.slice(0, block.indexOf("'"));
    const body = block.slice(0, block.search(/\n\s*(case '|default:)/) >>> 0);
    if (/'threadId'/.test(body)) named.add(method);
  }
  // Only this connection's own subscription list; nothing to pass on.
  named.delete('threads.unsubscribe');
  assert.ok(named.has('patches.trust') && named.has('actions.run'), [...named].join(', '));
  const calls: string[] = [];
  const remote = { owns: (id: string) => id === 'away-3', call: async (_id: string, method: string) => { calls.push(method); return {}; }, summaries: () => [], search: async () => [] };
  const { server, url } = await serve({ remote: remote as any });
  const c = await RunnerClient.connect(url, TOKEN);
  try {
    // threads.showPanel only goes on with a Mac app to show it.
    await c.call('hello', { client: 'threadbear-mac' });
    for (const method of named) await c.call(method, { threadId: 'away-3' }).catch((e) => assert.fail(`${method}: ${e.message}`));
    assert.deepEqual(calls.sort(), [...named].sort());
  } finally {
    c.close();
    await server.close();
  }
});

test('requests about a draining runner\'s thread go to it; a moved answer is handled here', async () => {
  const away = { id: 'away-1', title: 'Busy elsewhere', status: 'running', lastActivityAt: '2099-01-01T00:00:00.000Z' } as any;
  const calls: { threadId: string; method: string }[] = [];
  let owns = true;
  const remote = {
    owns: (id: string) => owns && id === away.id,
    call: async (threadId: string, method: string) => {
      calls.push({ threadId, method });
      if (method === 'threads.send') return { turnId: 'remote-turn' };
      if (method === 'threads.subscribe') return { events: [], inProgress: [] };
      throw new RpcError(-32030, 'That thread has moved.');
    },
    summaries: () => (owns ? [away] : []),
    search: async () => (owns ? [away] : []),
  };
  const { h, server, url } = await serve({ remote: remote as any });
  const local = h.runner.create({ text: 'here', accountId: 'claude-3' }).thread;
  const c = await RunnerClient.connect(url, TOKEN);
  try {
    const { threads } = await c.call('threads.list', {});
    assert.deepEqual(threads.map((t: { id: string }) => t.id), [away.id, local.id]);
    assert.deepEqual((await c.call('threads.search', { query: 'busy' })).threads.map((t: { id: string }) => t.id), [away.id]);
    assert.deepEqual(await c.call('threads.send', { threadId: away.id, text: 'hi' }), { turnId: 'remote-turn' });
    await c.call('threads.subscribe', { threadId: away.id });
    // Its live events now reach this client through the primary.
    const got: unknown[] = [];
    c.onNotification((m, p) => m === 'thread.event' && got.push(p));
    h.runner.publish({ method: 'thread.event', params: { threadId: away.id, event: { type: 'system.note', text: 'from over there', seq: 9, ts: '' } } } as any);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.length, 1);
    // Requests about this runner's own threads stay here.
    await c.call('threads.markSeen', { threadId: local.id, seq: 1 });
    assert.ok(!calls.some((x) => x.threadId === local.id));
    // An error from the draining runner comes back with its code...
    await assert.rejects(c.call('threads.interrupt', { threadId: away.id }), (e: { code: number }) => e.code === -32030);
    // ...unless the thread has come across meanwhile: then it's handled here.
    owns = false;
    await assert.rejects(c.call('threads.interrupt', { threadId: away.id }), (e: { code: number }) => e.code === -32004);
  } finally {
    c.close();
    await server.close();
  }
});

// THREADBEAR-F (7 Nov): a thread finishing its turn on a draining runner ran
// list_schedules all, which looks up ~200 schedules' thread titles at once.
// Each lookup asked the new runner for every thread's summary (2.8 MB with
// 931 threads), so a dozen answers sat unsent in one tick and the new runner
// closed the draining runner's link as "not reading". A lookup now asks for
// its one thread, and an older runner that lists them all still works.
test("a draining runner's lookups of other threads ask the new runner for just those", async () => {
  const { h, server, port } = await serve({ closeBytes: 256 * 1024 });
  const { PrimaryLink, primaryElsewhere } = await import('../../src/handover.ts');
  const ids = Array.from({ length: 60 }, (_, i) => h.runner.create({ text: `thread ${i} ${'x'.repeat(2000)}`, accountId: 'claude-3' }).thread.id);
  const link = new PrimaryLink('127.0.0.1', port, TOKEN);
  const elsewhere = primaryElsewhere(link, { has: () => false });
  try {
    const found = await Promise.all(ids.map((id) => elsewhere.find(id)));
    assert.deepEqual(found.map((t) => t?.id), ids);
    assert.equal(await elsewhere.find('missing'), undefined);
    // An older runner ignores ids and sends the lot; find still picks its own.
    const old = primaryElsewhere({ call: async () => ({ threads: h.runner.list(['inbox', 'snoozed', 'archived']) }) } as any, { has: () => false });
    assert.equal((await old.find(ids[3]))?.id, ids[3]);
  } finally {
    link.close();
    await server.close();
  }
});

test('threads.list with ids answers only those threads, here and on a draining runner', async () => {
  const away = { id: 'away-1', title: 'Busy elsewhere', status: 'running', lastActivityAt: '2099-01-01T00:00:00.000Z' } as any;
  const remote = { owns: (id: string) => id === away.id, call: async () => ({}), summaries: () => [away], search: async () => [] };
  const { h, server, url } = await serve({ remote: remote as any });
  const a = h.runner.create({ text: 'one', accountId: 'claude-3' }).thread;
  h.runner.create({ text: 'two', accountId: 'claude-3' });
  const archived = h.runner.create({ text: 'three', accountId: 'claude-3' }).thread;
  h.runner.update({ threadId: archived.id, archived: true });
  const c = await RunnerClient.connect(url, TOKEN);
  try {
    const ids = (r: { threads: { id: string }[] }) => r.threads.map((t) => t.id).sort();
    assert.deepEqual(ids(await c.call('threads.list', { include: ['inbox', 'snoozed', 'archived'], ids: [a.id, away.id, archived.id, 'nope'] })), [a.id, archived.id, away.id].sort());
    // include still applies.
    assert.deepEqual(ids(await c.call('threads.list', { ids: [a.id, archived.id] })), [a.id]);
    await assert.rejects(c.call('threads.list', { ids: 'x' }), (e: { code: number }) => e.code === -32602);
  } finally {
    c.close();
    await server.close();
  }
});

// The same on the tools' side (Codex's review of the fix): every tool that
// takes a thread id listed all of them to resolve it, so a dozen parallel
// read_thread calls on a draining runner were the same pile-up. A whole id
// is looked up by itself; a prefix still needs the list.
test("the agent tools resolve a whole thread id without listing every thread", async () => {
  const h = makeHarness();
  const { buildThreadbearTools } = await import('../../src/threadbear-mcp.ts');
  const self = h.runner.create({ text: 'me', accountId: 'claude-3' }).thread;
  const other = h.runner.create({ text: 'the other one', accountId: 'claude-3' }).thread;
  let lists = 0;
  const control = new Proxy(h.runner, {
    get(target, key) {
      const v = Reflect.get(target, key, target);
      if (key === 'list') return (...a: unknown[]) => (lists++, (v as Function).apply(target, a));
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const read = buildThreadbearTools(control as any, self.id).find((t) => t.name === 'read_thread')!;
  const whole = await read.handler({ threadId: other.id } as never, {} as never);
  assert.equal(whole.isError, undefined, JSON.stringify(whole));
  assert.match(JSON.stringify(whole), /the other one/);
  assert.equal(lists, 0);
  const prefix = await read.handler({ threadId: other.id.slice(0, 8) } as never, {} as never);
  assert.match(JSON.stringify(prefix), /the other one/);
  assert.equal(lists, 1);
  const missing = await read.handler({ threadId: '00000000-0000-0000-0000-000000000000' } as never, {} as never);
  assert.equal(missing.isError, true);
});
