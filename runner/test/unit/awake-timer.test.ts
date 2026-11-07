import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { awakeTimeout } from '../../src/awake-timer.ts';
import { RunnerClient } from '../../src/client.ts';
import { RpcServer } from '../../src/rpc.ts';
import { nullLogger } from '../../src/log.ts';
import { makeHarness } from '../helpers/fakes.ts';

// Blocks the event loop the way a starved process stalls.
function stall(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

test('fires after the time, and clear() stops it', async () => {
  let fired = 0;
  const start = performance.now();
  await new Promise<void>((res) => awakeTimeout(80, () => (fired++, res())));
  assert.equal(fired, 1);
  assert.ok(performance.now() - start >= 75);
  const t = awakeTimeout(30, () => fired++);
  t.clear();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fired, 1);
});

test("a stall of the process doesn't use up the time", async () => {
  let fired = false;
  const t = awakeTimeout(300, () => (fired = true));
  await new Promise((r) => setTimeout(r, 50));
  stall(600);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired, false, 'the 600 ms stall counted');
  t.clear();
});

test('the handshake survives the process stalling past both auth timeouts mid-way', async () => {
  // A runner and a client in one process, as in the unit tests, on a
  // machine so loaded that node isn't scheduled for longer than either
  // side's auth timeout (restart.test.ts failed this way under a load of
  // 60+, 6 Nov). The replies are in the sockets when it wakes.
  const { runner } = makeHarness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: 'tok', runner, log: nullLogger, methods: { ping: () => 'pong' }, authTimeoutMs: 200 });
  const { port } = await server.listen();
  try {
    // Stall at each point of the handshake: as the challenge arrives (both
    // timers running), and just after the client sends its proof (so it's
    // queued in the server's socket, and the server's in the client's
    // once the server answers on waking).
    for (const at of ['challenge', 'proof'] as const) {
      const c = new RunnerClient(`ws://127.0.0.1:${port}/rpc`, 'tok', { authTimeoutMs: 200 });
      const ws = (c as any).ws;
      if (at === 'challenge') ws.prependOnceListener('message', () => stall(400));
      else {
        const send = ws.send.bind(ws);
        ws.send = (data: string, ...rest: unknown[]) => {
          send(data, ...rest);
          if (data.includes('auth.prove')) stall(400);
        };
      }
      const t0 = performance.now(); await c.opened.catch((e) => { throw new Error(at + ' after ' + Math.round(performance.now() - t0) + ': ' + e.message); });
      assert.equal(await c.call('ping'), 'pong', at);
      c.close();
    }
  } finally {
    await server.close();
  }
});

test('a client still gives up on a server that never proves itself', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  const c = new RunnerClient(`ws://127.0.0.1:${port}/rpc`, 'tok', { authTimeoutMs: 150 });
  await assert.rejects(c.opened, /prove itself in time/);
  for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => wss.close(r));
});
