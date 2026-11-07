// Small JSON-RPC client for the runner, used by the tb CLI and the tests.
import { WebSocket } from 'ws';
import { awakeTimeout } from './awake-timer.ts';
import { answerChallenge, loopbackPort, RunnerNotProvedError, type AuthServer } from './rpc-auth.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RpcClientError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// How long the runner has to send its challenge and prove itself.
const AUTH_TIMEOUT_MS = 5000;
// auth.prove's id, apart from call()'s numbers.
const AUTH_ID = 'auth';

export type RunnerClientOptions = {
  // Sends the token as a bearer header instead of answering a challenge.
  // Only for a runner a file in the data dir says can't answer one (a
  // draining runner older than the challenge, handover.ts); never chosen
  // from what a server says (docs/protocol.md, "Auth").
  legacyHeader?: boolean;
  authTimeoutMs?: number;
  // The kind of server this means to reach, which the proofs are bound to:
  // 'drain' for a draining runner's own server (handover.ts), else the
  // runner's main one.
  server?: AuthServer;
  // An already connected socket to speak over (handover.ts checks whose
  // the other end is before the bearer header goes out on it).
  socket?: import('node:net').Socket;
};

export class RunnerClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<(method: string, params: any) => void>();
  readonly opened: Promise<void>;
  closeInfo?: { code: number; reason: string };
  // Until the runner has proved itself, what it sends goes to the
  // handshake, never to calls or handlers.
  private proving?: (msg: any) => void;

  // With a token, `opened` resolves once both sides have proved they have
  // it (docs/protocol.md, "Auth"); the token itself never goes out.
  // Without one (tests), it resolves when the socket opens.
  constructor(url: string, token?: string, opts: RunnerClientOptions = {}) {
    const legacy = Boolean(token && opts.legacyHeader);
    const socket = opts.socket;
    this.ws = new WebSocket(url, {
      ...(legacy ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      ...(socket ? { createConnection: () => socket } : {}),
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('error', reject);
      this.ws.once('close', (code) => reject(new Error(code === 4401 ? "the runner didn't accept the token" : `connection closed (${code})`)));
      if (!token || legacy) {
        this.ws.once('open', () => resolve());
        return;
      }
      const fail = (e: Error) => {
        this.proving = undefined;
        timer.clear();
        reject(e);
        this.ws.close();
      };
      // Counts only time this process was awake: a starved tb (or test)
      // would otherwise give up with the proof already in the socket.
      const timer = awakeTimeout(opts.authTimeoutMs ?? AUTH_TIMEOUT_MS, () => fail(new RunnerNotProvedError("The runner didn't prove itself in time.")));
      let check: ((result: unknown) => boolean) | undefined;
      this.proving = (msg) => {
        if (!check) {
          let answer: ReturnType<typeof answerChallenge>;
          try {
            answer = answerChallenge(token, msg, { id: AUTH_ID, port: loopbackPort(url), server: opts.server });
          } catch (e) {
            return fail(e as Error);
          }
          check = answer.runnerProved;
          this.ws.send(JSON.stringify(answer.request));
          return;
        }
        if (msg?.id !== AUTH_ID) return fail(new RunnerNotProvedError('The runner sent something else before proving itself.'));
        if (msg.error) return fail(new RpcClientError(msg.error.code, msg.error.message));
        if (!check(msg.result)) return fail(new RunnerNotProvedError("The runner's proof was wrong, so it isn't the runner."));
        this.proving = undefined;
        timer.clear();
        resolve();
      };
    });
    // Nobody may be awaiting it (a client closed early).
    this.opened.catch(() => {});
    this.ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        if (this.proving) this.proving(undefined);
        return;
      }
      if (this.proving) return this.proving(msg);
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcClientError(msg.error.code, msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg.method, msg.params);
      }
    });
    this.ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      for (const p of this.pending.values()) p.reject(new Error(`connection closed (${code})`));
      this.pending.clear();
    });
  }

  static async connect(url: string, token: string, opts: RunnerClientOptions = {}): Promise<RunnerClient> {
    const c = new RunnerClient(url, token, opts);
    await c.opened;
    return c;
  }

  onNotification(fn: (method: string, params: any) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // A call on a closed socket would otherwise wait forever.
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`connection not open (${this.closeInfo ? `closed ${this.closeInfo.code}` : 'state ' + this.ws.readyState})`));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  sendRaw(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  waitClosed(): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  close(): void {
    this.ws.close();
  }
}
