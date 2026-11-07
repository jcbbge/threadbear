// WebSocket JSON-RPC 2.0 server at ws://127.0.0.1:<port>/rpc.
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { awakeTimeout, type AwakeTimer } from './awake-timer.ts';
import { WebSocketServer, WebSocket } from 'ws';
import type { Runner, Notification, CliControl } from './runner.ts';
import type { Logger } from './log.ts';
import { ARCHIVE_VERDICTS, CLI_POLICIES, EFFORT_LEVELS, ErrorCode, PROVIDERS, RpcError, isEffortLevel, isProvider } from './protocol.ts';
import type { ArchiveVerdict, ApprovalDecision, AskAnswer, CliPolicy, EffortLevel, ImageRef, PermissionMode, Provider, ShareAccess, ThreadStartedBy, ThreadSummary } from './protocol.ts';
import { MAX_BYLINE } from './needs.ts';
import { isMoved, mergeSummaries, type Bucket } from './handover.ts';
import { AUTH_VERSION, authProof, isNonce, newNonce, proofMatches, type AuthChannel } from './rpc-auth.ts';
import { cutSafely } from './safe-cut.ts';

type Conn = {
  id: number;
  ws: WebSocket;
  authed: boolean;
  subs: Set<string>;
  client?: string;
  // hello's version and pid, and when it connected, for the log.
  clientVersion?: string;
  clientPid?: number;
  since: number;
  browserPanel?: boolean;
  authTimer?: AwakeTimer;
  // This connection's auth.challenge nonce (docs/protocol.md, "Auth").
  challenge?: string;
};

// Until a connection has authenticated (docs/protocol.md, "Auth"), it gets
// a small frame limit, a short deadline, and only so many of them may wait
// at once: without these, anyone on the Mac could open sockets and send
// 64 MiB frames for the runner to buffer and JSON-parse before it even
// looked at the credentials.
const AUTH_TIMEOUT_MS = 3000;
const PREAUTH_MAX_PAYLOAD = 64 * 1024;
const MAX_PENDING_AUTH = 16;
// What an authenticated client may send in one frame.
const MAX_PAYLOAD = 64 * 1024 * 1024;
// Backpressure for a client that stops reading (a hung app, a debugger):
// past SKIP_DELTAS_BYTES of unsent data, transient deltas are skipped (the
// persisted event replaces them anyway); past CLOSE_BYTES the socket is
// closed with 4408, and the client reconnects and replays from its last seq.
const SKIP_DELTAS_BYTES = 1024 * 1024;
const CLOSE_BYTES = 32 * 1024 * 1024;
// How long close() waits for clients to finish closing before dropping them.
const CLOSE_GRACE_MS = 1000;

// Requests about one thread. During a handover (docs/protocol.md) the
// primary passes these to the draining runner that has the thread, and a
// draining runner answers -32030 for one it has let go.
const THREAD_METHODS = new Set([
  'reviews.list',
  'reviews.create',
  'reviews.get',
  'reviews.save',
  'reviews.respond',
  'reviews.cancel',
  'buttons.list',
  'buttons.press',
  'threads.send',
  'threads.edit',
  'threads.interrupt',
  'threads.update',
  'threads.delete',
  'threads.events',
  'threads.subscribe',
  'threads.heldBody',
  'threads.markSeen',
  'threads.highlights',
  'threads.commands',
  'threads.explain',
  'threads.hibernateWhen',
  'threads.removeHighlight',
  'threads.panelShown',
  'threads.showPanel',
  'threads.tickAsk',
  'threads.share',
  'approvals.respond',
  'plans.approve',
  'secrets.answer',
  'panels.render',
  'panels.convexKey',
  'panels.convexDeployments',
  'panels.convexLogin',
  'actions.run',
  'patches.trust',
  'threads.subagent',
]);

// Draining runners' threads, as the primary's server sees them (handover.ts
// Peers).
export type RemoteThreads = {
  owns(threadId: string): boolean;
  call(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  summaries(include: Bucket[]): ThreadSummary[];
  search(query: string, limit: number): Promise<ThreadSummary[]>;
};

// relay.ts's Relay, as the server uses it.
export type RelayHandler = {
  owns(threadId: string): boolean;
  call(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  create(runnerId: string, params: Record<string, unknown>): Promise<unknown>;
  listFolder(runnerId: string, path: string): Promise<unknown>;
  logins(runnerId: string): Promise<unknown>;
};

export type RpcServerOptions = {
  host: string;
  port: number;
  token: string;
  runner: Runner;
  log: Logger;
  // Methods served beside the runner's own (runner.status and
  // runner.restart, from restart.ts), and notices for a client that has
  // just said hello beside the runner's.
  methods?: Record<string, (params: Record<string, unknown>) => unknown>;
  helloNotices?: () => { level: 'info' | 'warning' | 'error'; message: string }[];
  // E's CliUpdates, for clis.*. Without it they answer -32601, as an older
  // runner's would.
  clis?: CliControl;
  // The primary's draining runners, whose threads it passes requests to.
  remote?: RemoteThreads;
  // A draining runner's own server: only the threads it still has.
  onlyOwn?: boolean;
  // Other runners' threads, through the backend (relay.ts). Without it, or
  // for a thread it doesn't own, they're unknown here as before.
  relay?: RelayHandler;
  // hello's `updates` (docs/protocol.md, "Runner updates").
  updates?: () => unknown;
  // The Mac app's hello with its build (docs/protocol.md, "App restarts").
  appHello?: (build: { commit: string; short: string; tree: string }) => void;
  // Tests shorten these.
  authTimeoutMs?: number;
  maxPendingAuth?: number;
  skipDeltasBytes?: number;
  closeBytes?: number;
  closeGraceMs?: number;
};

export class RpcServer {
  private opts: RpcServerOptions;
  private http: http.Server;
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private nextId = 1;
  private unlisten: () => void;

  constructor(opts: RpcServerOptions) {
    this.opts = opts;
    this.http = http.createServer((req, res) => {
      // Unauthenticated health check for scripts; it says nothing else.
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // A socket that never finishes its request headers is let go sooner
    // than Node's minute.
    this.http.headersTimeout = 10_000;
    // The upgrade is handled here rather than by ws so a wrong header or
    // too many connections waiting to authenticate is refused before it
    // becomes a WebSocket. Every socket starts on the small pre-auth frame
    // limit; unlock() raises it once the client has authenticated.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: PREAUTH_MAX_PAYLOAD });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    // The HTTP server's errors (EADDRINUSE on listen): listen() reports
    // those, and without a listener here they'd crash the process. ws used
    // to listen for them when it owned the upgrade.
    this.http.on('error', (e) => opts.log.warn('rpc server error', { error: String(e) }));
    this.wss.on('error', (e) => opts.log.warn('websocket server error', { error: String(e) }));
    this.unlisten = opts.runner.onNotification((n) => this.broadcast(n));
  }

  listen(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.off('error', reject);
        const addr = this.http.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : this.opts.port });
      });
    });
  }

  async close(): Promise<void> {
    this.unlisten();
    for (const c of this.conns) {
      c.authTimer?.clear();
      c.ws.close(1001, 'runner stopping');
    }
    // wss.close waits for every client to answer the close, and ws gives a
    // silent one (a suspended app, a script blocked on `launchctl kickstart
    // -k`, which waits for this very exit) 30 s. That's past launchd's
    // ExitTimeOut, which would SIGKILL the runner and leave its CLIs for the
    // next start to sweep, so cut stragglers off after a moment.
    const cutOff = setTimeout(() => {
      for (const ws of this.wss.clients) ws.terminate();
    }, this.opts.closeGraceMs ?? CLOSE_GRACE_MS);
    await new Promise<void>((r) => this.wss.close(() => r()));
    clearTimeout(cutOff);
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  // Clients that have authenticated and are still connected (a draining
  // runner's server counts the primaries listening to it).
  connectedClients(): number {
    let n = 0;
    for (const c of this.conns) if (c.authed && c.ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  /** Whether any client is subscribed to a thread (relay.ts watches only then). */
  isSubscribed(threadId: string): boolean {
    for (const c of this.conns) if (c.authed && c.subs.has(threadId) && c.ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  /** A notification for clients only, never the runner's own listeners: relay.ts's events are another runner's, which sync must not mirror as this one's. */
  notifyClients(n: Notification): void {
    this.broadcast(n);
  }

  // Whether the Mac app itself is connected (hello's client), for presence.ts.
  appConnected(browserPanel = false): boolean {
    for (const c of this.conns) if (c.authed && c.client === 'threadbear-mac' && (!browserPanel || c.browserPanel) && c.ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  private tokenOk(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private pendingAuth(): number {
    let n = 0;
    for (const c of this.conns) if (!c.authed) n++;
    return n;
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const refuse = (status: number, text: string) => {
      if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if ((req.url ?? '').split('?')[0] !== '/rpc') return refuse(400, 'Bad Request');
    // An old client's bearer header (docs/protocol.md, "Before the
    // challenge"): right, it's in; wrong, it's refused here. No header means
    // the challenge.
    const header = req.headers.authorization;
    let authed = false;
    if (header !== undefined) {
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!m || !this.tokenOk(m[1].trim())) return refuse(401, 'Unauthorized');
      authed = true;
    } else if (this.pendingAuth() >= (this.opts.maxPendingAuth ?? MAX_PENDING_AUTH)) {
      return refuse(503, 'Service Unavailable');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, authed));
  }

  // Raises an authenticated socket's frame limit. ws has no public way to
  // change maxPayload on a live socket, so this sets its receiver's
  // (ws 8.x; rpc.test.ts fails if a ws update moves it).
  private unlock(conn: Conn): void {
    conn.authed = true;
    conn.authTimer?.clear();
    conn.challenge = undefined;
    const receiver = (conn.ws as unknown as { _receiver?: { _maxPayload?: unknown } })._receiver;
    if (receiver && typeof receiver._maxPayload === 'number') receiver._maxPayload = MAX_PAYLOAD;
    else this.opts.log.warn('could not raise the frame limit for an authenticated client', { conn: conn.id });
  }

  // Closes an unauthenticated connection with 4401, and cuts it off if it
  // doesn't answer the close within a second: ws would otherwise keep a
  // client that ignores it for 30 s. It counts as waiting until it's gone,
  // so refused sockets can't pile up past the cap.
  private refuseConn(conn: Conn): void {
    conn.authTimer?.clear();
    conn.ws.close(4401, 'unauthorized');
    setTimeout(() => conn.ws.terminate(), 1000).unref();
  }

  // What this server's proofs are bound to (docs/protocol.md, "Auth"): the
  // kind of server and the port it listens on.
  private channel(): AuthChannel {
    const addr = this.http.address();
    return { server: this.opts.onlyOwn ? 'drain' : 'primary', port: typeof addr === 'object' && addr ? addr.port : this.opts.port };
  }

  private onConnection(ws: WebSocket, headerAuthed: boolean): void {
    const conn: Conn = { id: this.nextId++, ws, authed: false, subs: new Set(), since: Date.now() };
    this.conns.add(conn);
    if (headerAuthed) {
      this.unlock(conn);
    } else {
      // Awake time only, as in client.ts: a stalled runner mustn't drop
      // a client whose proof is already waiting in the socket.
      conn.authTimer = awakeTimeout(this.opts.authTimeoutMs ?? AUTH_TIMEOUT_MS, () => {
        if (!conn.authed) this.refuseConn(conn);
      });
      conn.challenge = newNonce();
      this.send(conn, { jsonrpc: '2.0', method: 'auth.challenge', params: { version: AUTH_VERSION, nonce: conn.challenge, port: this.channel().port } });
    }
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // The protocol is text only; before auth, anything else is refused.
        if (!conn.authed) this.refuseConn(conn);
        return;
      }
      this.onMessage(conn, data.toString());
    });
    ws.on('close', () => {
      conn.authTimer?.clear();
      this.conns.delete(conn);
    });
    // A protocol error (a frame over the limit, bad UTF-8): ws closes with
    // 1009 or 1002 and waits up to 30 s for the other side to answer. Cut it
    // off now; it stays counted (against the pending cap, if it hadn't
    // authenticated) until its 'close'.
    ws.on('error', () => {
      conn.authTimer?.clear();
      ws.terminate();
    });
  }

  private send(conn: Conn, obj: unknown): void {
    if (conn.ws.readyState === WebSocket.OPEN) this.write(conn, JSON.stringify(obj), false);
  }

  private write(conn: Conn, msg: string, skippable: boolean): void {
    const buffered = conn.ws.bufferedAmount;
    if (buffered > (this.opts.closeBytes ?? CLOSE_BYTES)) {
      this.opts.log.warn('client is not reading; closing it', {
        conn: conn.id, client: conn.client ?? 'no hello', version: conn.clientVersion, pid: conn.clientPid,
        subs: conn.subs.size, connectedSecs: Math.round((Date.now() - conn.since) / 1000), buffered,
      });
      conn.ws.close(4408, 'too far behind');
      this.conns.delete(conn);
      return;
    }
    if (skippable && buffered > (this.opts.skipDeltasBytes ?? SKIP_DELTAS_BYTES)) return;
    conn.ws.send(msg);
  }

  private broadcast(n: Notification): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method: n.method, params: n.params });
    const transient = n.method === 'thread.event' && n.params.event.type.endsWith('.delta');
    for (const c of [...this.conns]) {
      if (!c.authed || c.ws.readyState !== WebSocket.OPEN) continue;
      if (n.method === 'thread.event' && !c.subs.has(n.params.threadId)) continue;
      this.write(c, msg, transient);
    }
  }

  // The one message a connection may send before it has authenticated
  // (at most PREAUTH_MAX_PAYLOAD, so parsing it is cheap): auth.prove
  // answering this connection's challenge, or an old client's auth with
  // the token itself. Anything else closes it.
  private onAuthMessage(conn: Conn, raw: string): void {
    let msg: { id?: string | number | null; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.refuseConn(conn);
    }
    const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null;
    const p = (msg && typeof msg === 'object' && msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    if (msg?.method === 'auth.prove' && conn.challenge && isNonce(p.nonce) && p.nonce !== conn.challenge
      && proofMatches(authProof(this.opts.token, 'client', conn.challenge, p.nonce, this.channel()), p.proof)) {
      const proof = authProof(this.opts.token, 'runner', conn.challenge, p.nonce, this.channel());
      this.unlock(conn);
      this.send(conn, { jsonrpc: '2.0', id, result: { proof } });
      return;
    }
    if (msg?.method === 'auth' && this.tokenOk(p.token)) {
      this.unlock(conn);
      if (id !== null) this.send(conn, { jsonrpc: '2.0', id, result: {} });
      return;
    }
    this.refuseConn(conn);
  }

  private onMessage(conn: Conn, raw: string): void {
    if (!conn.authed) return this.onAuthMessage(conn, raw);
    let msg: { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(conn, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.parseError, message: 'Parse error' } });
    }
    const id = msg?.id ?? null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return this.send(conn, { jsonrpc: '2.0', id, error: { code: ErrorCode.invalidRequest, message: 'Invalid request' } });
    }
    let result: unknown;
    try {
      result = this.dispatch(conn, msg.method, (msg.params ?? {}) as Record<string, unknown>);
    } catch (e) {
      if (id === null) return;
      if (e instanceof RpcError) {
        return this.send(conn, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
      }
      this.opts.log.error('request failed', { method: msg.method, error: String(e) });
      return this.send(conn, { jsonrpc: '2.0', id, error: { code: ErrorCode.other, message: (e as Error)?.message ?? String(e) } });
    }
    // A handler that has to wait (panels.render takes a screenshot) returns
    // a promise; everything else answers in this tick.
    if (result instanceof Promise) {
      result.then(
        (value) => {
          if (id !== null) this.send(conn, { jsonrpc: '2.0', id, result: value });
        },
        (e) => {
          if (id === null) return;
          if (e instanceof RpcError) {
            this.send(conn, { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
          } else {
            this.opts.log.error('request failed', { method: msg.method, error: String(e) });
            this.send(conn, { jsonrpc: '2.0', id, error: { code: ErrorCode.other, message: (e as Error)?.message ?? String(e) } });
          }
        },
      );
      return;
    }
    if (id !== null) this.send(conn, { jsonrpc: '2.0', id, result });
    // Things the app should know about that happened before it connected
    // (a missing claude binary, CLIs stopped at startup).
    if (msg.method === 'hello') {
      for (const n of [...this.opts.runner.noticesForNewClient(), ...(this.opts.helloNotices?.() ?? [])]) {
        this.send(conn, { jsonrpc: '2.0', method: 'runner.notice', params: n });
      }
    }
  }

  // A request about a draining runner's thread, passed to it. Its answer
  // comes back unchanged. A subscribe starts this client's live stream in
  // the same tick its backlog arrives: events the draining runner sent
  // before the backlog are in it, and those after come through here. If it
  // has just handed the thread over (-32030), this runner has it by then,
  // and handles the request itself.
  private forward(conn: Conn, method: string, p: Record<string, unknown>, threadId: string): Promise<unknown> {
    return this.opts.remote!.call(threadId, method, p).then(
      (res) => {
        if (method === 'threads.subscribe') conn.subs.add(threadId);
        return res;
      },
      (e) => {
        if (isMoved(e) && this.opts.runner.has(threadId)) return this.dispatch(conn, method, p);
        throw e;
      },
    );
  }

  private mustClis(method: string): CliControl {
    if (!this.opts.clis) throw new RpcError(ErrorCode.methodNotFound, `Unknown method ${method}`);
    return this.opts.clis;
  }

  // Every handler is synchronous, so a subscribe's replay and the start of
  // its live stream happen in the same tick and nothing can slip between.
  private dispatch(conn: Conn, method: string, p: Record<string, unknown>): unknown {
    const r = this.opts.runner;
    // A local tool needs to know whether its handoff can reach the Mac app.
    // Check on the primary, before forwarding to the runner owning the thread.
    if (method === 'threads.showPanel' && !this.opts.onlyOwn) {
      const browser = ['browser', 'threadbear.browser'].includes(String(p.panel).trim().toLowerCase());
      if (!this.appConnected(browser)) return { available: false };
    }
    const tid = typeof p.threadId === 'string' ? p.threadId : undefined;
    if (tid !== undefined && THREAD_METHODS.has(method) && !r.has(tid)) {
      if (this.opts.remote?.owns(tid)) return this.forward(conn, method, p, tid);
      if (this.opts.onlyOwn) throw new RpcError(ErrorCode.moved, 'This runner has handed that thread over to the new one.');
      if (this.opts.relay?.owns(tid)) {
        return this.opts.relay.call(tid, method, p).then((res) => {
          if (method === 'threads.subscribe') conn.subs.add(tid);
          return res;
        });
      }
    }
    switch (method) {
      case 'auth':
        return {};
      case 'hello': {
        conn.client = optString(p, 'client');
        conn.clientVersion = typeof p.version === 'string' ? p.version : undefined;
        conn.clientPid = typeof p.pid === 'number' ? p.pid : undefined;
        conn.browserPanel = p.browserPanel === true;
        // Only the Mac app's own builds: a dev build has none.
        const build = p.build as Record<string, unknown> | undefined;
        if (conn.client === 'threadbear-mac' && build && typeof build === 'object'
          && typeof build.commit === 'string' && typeof build.short === 'string' && typeof build.tree === 'string' && build.tree) {
          this.opts.appHello?.({ commit: build.commit, short: build.short, tree: build.tree });
        }
        const updates = this.opts.updates?.();
        return updates ? { ...r.hello(), updates } : r.hello();
      }
      case 'threads.list': {
        const include = p.include === undefined ? undefined : stringArray(p, 'include');
        for (const x of include ?? []) {
          if (x !== 'inbox' && x !== 'snoozed' && x !== 'archived') throw bad(`unknown include value ${x}`);
        }
        const ids = p.ids === undefined ? undefined : stringArray(p, 'ids');
        const local = r.list(include as Bucket[] | undefined, ids);
        const only = ids && new Set(ids);
        const remote = this.opts.remote?.summaries((include as Bucket[] | undefined) ?? ['inbox']).filter((t) => !only || only.has(t.id));
        return { threads: remote?.length ? mergeSummaries(local, remote) : local };
      }
      case 'threads.search': {
        const query = reqString(p, 'query');
        const limit = optInt(p, 'limit');
        const local = r.search(query, limit);
        const remote = this.opts.remote;
        if (!remote) return { threads: local };
        return remote.search(query, limit ?? 50).then((more) => ({ threads: mergeSummaries(local, more).slice(0, limit ?? 50) }));
      }
      case 'threads.create': {
        // On another runner (docs/protocol.md, "Other runners' threads through the backend").
        if (typeof p.runnerId === 'string' && this.opts.relay) {
          return this.opts.relay.create(p.runnerId, p).then((res) => {
            // Never one of this runner's own: its requests would come here.
            const id = (res as { thread?: { id?: unknown } }).thread?.id;
            if (typeof id === 'string' && r.has(id)) throw new RpcError(ErrorCode.other, "The other runner named one of this Mac's threads as the new one.");
            return res;
          });
        }
        if (p.worktree !== undefined && typeof p.worktree !== 'boolean') throw bad('worktree must be a boolean');
        const res = r.create({
          text: optString(p, 'text') ?? '',
          images: optImages(p),
          cwd: optString(p, 'cwd'),
          accountId: optString(p, 'accountId'),
          poolId: optString(p, 'poolId'),
          model: optString(p, 'model'),
          effort: optEffort(p),
          permissionMode: optMode(p),
          title: optString(p, 'title'),
          ...(p.worktree === false ? { worktree: false } : {}),
          // Only ever narrows (a draining runner passing on a sandboxed
          // agent's create_thread), so any client may ask for it.
          ...(p.confined === true ? { confined: true } : {}),
          ...optStartedBy(p),
        });
        return { thread: res.thread, turnId: res.turnId };
      }
      case 'threads.samples':
        return r.samples({ cwd: reqString(p, 'cwd'), remove: p.remove === true });
      case 'reviews.list':
        return r.listReviews(reqString(p, 'threadId'));
      case 'reviews.create':
        return r.createReview(reqString(p, 'threadId'), p as Parameters<Runner['createReview']>[1]);
      case 'reviews.get':
        return r.getReview(reqString(p, 'threadId'), reqString(p, 'reviewId'));
      case 'reviews.save':
        return r.saveReview(reqString(p, 'threadId'), reqString(p, 'reviewId'), p.revision as number, p.draft as Parameters<Runner['saveReview']>[3]);
      case 'reviews.respond':
        return r.respondReview(reqString(p, 'threadId'), reqString(p, 'reviewId'), p.revision as number, p.draft as Parameters<Runner['respondReview']>[3]);
      case 'reviews.cancel':
        return r.cancelReview(reqString(p, 'threadId'), reqString(p, 'reviewId'), p.revision as number);
      case 'buttons.list':
        return r.listButtons(reqString(p, 'threadId'));
      case 'buttons.press':
        return r.pressButton(reqString(p, 'threadId'), reqString(p, 'buttonId'));
      case 'threads.send':
        return r.send(reqString(p, 'threadId'), optString(p, 'text') ?? '', optImages(p) ?? [], { ...optAnswers(p), ...optPhoneOrigin(p) });
      case 'threads.edit':
        return r.editMessage(reqString(p, 'threadId'), reqNumber(p, 'seq'), optString(p, 'text') ?? '', optImages(p) ?? [], { stopBackground: p.stopBackground === true });
      case 'threads.interrupt':
        // Sent on for an agent's interrupt_thread (handover.ts), it isn't his Stop.
        return r.interrupt(reqString(p, 'threadId'), { byMike: p.byAgent !== true });
      case 'threads.update': {
        const upd: Parameters<Runner['update']>[0] = { threadId: reqString(p, 'threadId') };
        if (p.title !== undefined) upd.title = reqString(p, 'title');
        if (p.titleBy !== undefined) {
          if (p.titleBy !== 'mike' && p.titleBy !== 'agent') throw bad('titleBy must be "mike" or "agent"');
          upd.titleBy = p.titleBy;
        }
        if (p.cwd !== undefined) upd.cwd = reqString(p, 'cwd');
        if (p.accountId !== undefined) upd.accountId = reqString(p, 'accountId');
        // From a client with the runner's token (the app, tb): its move may
        // take a thread out of a sandbox, unless it says it mayn't (a
        // draining runner passing on an agent's move: unconfine false).
        if (p.cwd !== undefined || p.accountId !== undefined || p.poolId !== undefined) upd.unconfine = p.unconfine !== false;
        if (p.poolId !== undefined) upd.poolId = p.poolId === null ? null : reqString(p, 'poolId');
        if (p.model !== undefined) upd.model = p.model === null ? null : reqString(p, 'model');
        if (p.effort !== undefined) upd.effort = p.effort === null ? null : optEffort(p);
        if (p.permissionMode !== undefined) upd.permissionMode = optMode(p);
        if (p.snoozedUntil !== undefined) upd.snoozedUntil = p.snoozedUntil === null ? null : reqString(p, 'snoozedUntil');
        if (p.archived !== undefined) {
          if (typeof p.archived !== 'boolean') throw bad('archived must be a boolean');
          upd.archived = p.archived;
        }
        if (p.archivedBy !== undefined) {
          if (p.archivedBy !== 'mike' && p.archivedBy !== 'agent' && p.archivedBy !== 'threadbear') throw bad('archivedBy must be "mike", "agent" or "threadbear"');
          upd.archivedBy = p.archivedBy;
        }
        if (p.verdict !== undefined) {
          if (!ARCHIVE_VERDICTS.includes(p.verdict as ArchiveVerdict)) throw bad(`verdict must be one of ${ARCHIVE_VERDICTS.join(', ')}`);
          if (p.archived !== true) throw bad('verdict goes with archived: true');
          upd.verdict = p.verdict as ArchiveVerdict;
        }
        if (p.starred !== undefined) {
          if (typeof p.starred !== 'boolean') throw bad('starred must be a boolean');
          upd.starred = p.starred;
        }
        return r.update(upd);
      }
      case 'threads.retitle': {
        if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') throw bad('dryRun must be a boolean');
        const threadIds = p.threadIds === undefined ? undefined : stringArray(p, 'threadIds');
        return r.retitle({ dryRun: p.dryRun === true, threadIds });
      }
      case 'threads.delete':
        return r.delete(reqString(p, 'threadId'));
      case 'threads.events':
        return r.events(reqString(p, 'threadId'), {
          afterSeq: optInt(p, 'afterSeq'),
          beforeSeq: optInt(p, 'beforeSeq'),
          limit: optInt(p, 'limit'),
        });
      case 'threads.subagent':
        return r.subagent(reqString(p, 'threadId'), reqString(p, 'subagentId'));
      case 'threads.subscribe': {
        const threadId = reqString(p, 'threadId');
        const backlog = r.backlog(threadId, optInt(p, 'afterSeq') ?? 0);
        conn.subs.add(threadId);
        // Opened: the done card's loose ends may have moved since (a land
        // from a terminal, another thread's turn).
        r.recheckLooseEnds(r.threads.get(threadId), true);
        return backlog;
      }
      case 'threads.unsubscribe':
        conn.subs.delete(reqString(p, 'threadId'));
        return {};
      case 'threads.markSeen':
        return r.markSeen(reqString(p, 'threadId'), reqNumber(p, 'seq'));
      case 'threads.highlights':
        return r.highlights(reqString(p, 'threadId'));
      case 'threads.explain': {
        const selection = reqString(p, 'selection');
        if (!selection.trim()) throw bad('selection is empty');
        const question = p.question === undefined ? undefined : reqString(p, 'question');
        let earlier: { question?: string; answer: string }[] | undefined;
        if (p.earlier !== undefined) {
          if (!Array.isArray(p.earlier)) throw bad('earlier must be an array');
          earlier = p.earlier.map((t: any) => {
            if (!t || typeof t.answer !== 'string' || (t.question !== undefined && typeof t.question !== 'string')) throw bad('earlier: each is { question?, answer }');
            return { question: t.question, answer: t.answer };
          });
        }
        return r.explain({ threadId: reqString(p, 'threadId'), selection, message: p.message === undefined ? undefined : reqString(p, 'message'), question, earlier });
      }
      case 'threads.commands':
        return r.threadCommands(reqString(p, 'threadId'));
      case 'threads.hibernateWhen':
        return r.hibernateWhen({ threadId: reqString(p, 'threadId'), said: reqString(p, 'said') });
      case 'threads.removeHighlight':
        return r.removeHighlight(reqString(p, 'threadId'), reqString(p, 'highlightId'));
      case 'threads.panelShown':
        return r.panelShown(reqString(p, 'threadId'), reqString(p, 'requestId'));
      case 'threads.showPanel':
        return r.showPanel(reqString(p, 'threadId'), { panel: reqString(p, 'panel') }).then(result => ({ available: true, ...result }));
      case 'threads.share': {
        const access = reqString(p, 'access');
        if (access !== 'off' && access !== 'link') throw bad('access is "off" or "link"');
        if (p.newLink !== undefined && typeof p.newLink !== 'boolean') throw bad('newLink must be a boolean');
        return r.share(reqString(p, 'threadId'), { access: access as ShareAccess, ...(p.newLink ? { newLink: true } : {}) });
      }
      case 'threads.tickAsk':
        if (typeof p.ticked !== 'boolean') throw bad('ticked must be a boolean');
        return r.tickAsk(reqString(p, 'threadId'), reqNumber(p, 'asksSeq'), reqNumber(p, 'index'), p.ticked);
      case 'approvals.respond': {
        const decision = reqString(p, 'decision') as ApprovalDecision;
        if (!['allow', 'allowAlways', 'deny', 'answered'].includes(decision)) throw bad('bad decision');
        let answers: Record<string, string> | undefined;
        if (p.answers !== undefined) {
          if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw bad('answers must be an object');
          answers = {};
          for (const [k, v] of Object.entries(p.answers)) {
            answers[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
          }
        }
        return r.respondApproval({
          threadId: reqString(p, 'threadId'),
          approvalId: reqString(p, 'approvalId'),
          decision,
          message: optString(p, 'message'),
          answers,
          // A draining runner passing on the phone's answer (handover.ts):
          // it only ever narrows what counts, so any client may say it.
          ...(p.remote === true ? { remote: true } : {}),
        });
      }
      case 'plans.approve':
        return r.approvePlan({ threadId: reqString(p, 'threadId'), itemId: reqString(p, 'itemId') });
      case 'secrets.answer': {
        // docs/protocol.md, "Secrets". Nothing here logs params, and the
        // errors below never quote them.
        const decline = p.decline === true;
        if (!decline && typeof p.secret !== 'string') throw bad('secret or decline is required');
        return r.answerSecret({
          threadId: reqString(p, 'threadId'),
          approvalId: reqString(p, 'approvalId'),
          ...(decline ? { decline: true } : { secret: p.secret as string }),
        });
      }
      case 'pools.list':
        return r.listPools();
      case 'pools.save':
        return r.savePools(p.pools);
      case 'media.import':
        return r.importMedia(reqString(p, 'path'));
      case 'panels.render':
        return r.renderPanel(reqString(p, 'threadId'), reqString(p, 'panelId'));
      case 'panels.convexKey':
        return r.convexPanelKey(reqString(p, 'threadId'), reqString(p, 'panelId'), p.renew === true, optString(p, 'deployment'));
      case 'panels.convexLogin':
        return r.convexPanelLogin(reqString(p, 'threadId'), reqString(p, 'panelId'), p.check === true, p.force === true);
      case 'panels.convexDeployments':
        return r.convexPanelDeployments(reqString(p, 'threadId'), reqString(p, 'panelId'), p.refresh === true);
      case 'patches.trust': {
        if (!Array.isArray(p.files) || !p.files.length) throw bad('files must be a non-empty array');
        const files = p.files.map((f: unknown) => {
          const o = f as { file?: unknown; hash?: unknown };
          if (!o || typeof o.file !== 'string' || typeof o.hash !== 'string') throw bad('each file needs file and hash');
          return { file: o.file, hash: o.hash };
        });
        return r.trustPatches(reqString(p, 'threadId'), files);
      }
      case 'actions.run':
        return r.runAction(reqString(p, 'threadId'), reqString(p, 'actionId'));
      // Each starts its work and answers at once; progress comes through
      // clis.updated.
      case 'clis.list':
        return { clis: this.mustClis(method).list() };
      case 'clis.check': {
        const provider = p.provider === undefined || p.provider === null ? undefined : reqProvider(p);
        return { clis: this.mustClis(method).check(provider) };
      }
      case 'clis.update': {
        const provider = reqProvider(p);
        const o: { version?: string; force?: boolean } = {};
        const version = optString(p, 'version');
        if (version !== undefined) {
          if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw bad('version must be a version number like 0.164.0');
          o.version = version;
        }
        if (p.force !== undefined && p.force !== null) {
          if (typeof p.force !== 'boolean') throw bad('force must be a boolean');
          if (p.force) o.force = true;
        }
        return { clis: this.mustClis(method).update(provider, o) };
      }
      case 'clis.setPolicy': {
        const provider = reqProvider(p);
        const policy = p.policy;
        if (typeof policy !== 'string' || !(CLI_POLICIES as readonly string[]).includes(policy)) throw bad(`policy must be one of ${CLI_POLICIES.join(', ')}`);
        return { clis: this.mustClis(method).setPolicy(provider, policy as CliPolicy) };
      }
      default: {
        // hasOwn, so "constructor" and friends aren't methods.
        // A folder on another runner, for the folder browser on one of its threads.
        if (method === 'files.list' && typeof p.runnerId === 'string' && this.opts.relay) return this.opts.relay.listFolder(p.runnerId, reqString(p, 'path'));
        if (method === 'files.read' && typeof p.runnerId === 'string') throw new RpcError(ErrorCode.other, 'Files on another runner are kept there for now.');
        if (method === 'remoteThreads.logins') {
          if (!this.opts.relay) throw new RpcError(ErrorCode.other, "This Mac's runner can't reach other runners through Convex.");
          return this.opts.relay.logins(reqString(p, 'runnerId'));
        }
        const methods = this.opts.methods;
        if (methods && Object.hasOwn(methods, method)) return methods[method](p);
        throw new RpcError(ErrorCode.methodNotFound, `Unknown method ${method}`);
      }
    }
  }
}

function reqProvider(p: Record<string, unknown>): Provider {
  if (!isProvider(p.provider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
  return p.provider;
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

function reqString(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function optString(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function reqNumber(p: Record<string, unknown>, k: string): number {
  const v = p[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a number`);
  return v;
}

function optNumber(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a number`);
  return v;
}

// Seqs and limits index the event log, so they must be whole numbers.
function optInt(p: Record<string, unknown>, k: string): number | undefined {
  const v = optNumber(p, k);
  if (v !== undefined && !Number.isInteger(v)) throw bad(`${k} must be a whole number`);
  return v;
}

function stringArray(p: Record<string, unknown>, k: string): string[] {
  const v = p[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${k} must be an array of strings`);
  return v as string[];
}

// Who started a new thread (docs/protocol.md, "Who started a thread"). It's
// shown on Mike's row, so it's cut to what a row can hold, on one line.
const STARTED_BY_KINDS = new Set(['tool', 'thread', 'schedule', 'librarian', 'runner']);
function optStartedBy(p: Record<string, unknown>): { startedBy?: ThreadStartedBy } {
  const v = p.startedBy;
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object') throw bad('startedBy must be an object');
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !STARTED_BY_KINDS.has(o.kind)) throw bad('startedBy.kind must be tool, thread, schedule, librarian or runner');
  const words = (x: unknown, max: number) => (typeof x === 'string' ? cutSafely(x.replace(/\s+/g, ' ').trim(), max) : '');
  const label = words(o.label, 40);
  if (!label) throw bad('startedBy.label required');
  const icon = words(o.icon, 60);
  const why = words(o.why, MAX_BYLINE);
  const threadId = words(o.threadId, 60);
  return { startedBy: { kind: o.kind as ThreadStartedBy['kind'], label, ...(icon ? { icon } : {}), ...(threadId ? { threadId } : {}), ...(why ? { why } : {}) } };
}

function optMode(p: Record<string, unknown>): PermissionMode | undefined {
  const v = p.permissionMode;
  if (v === undefined || v === null) return undefined;
  if (v !== 'full' && v !== 'ask' && v !== 'auto' && v !== 'plan') throw bad('permissionMode must be "full", "ask", "auto" or "plan"');
  return v;
}

function optEffort(p: Record<string, unknown>): EffortLevel | undefined {
  const v = p.effort;
  if (v === undefined || v === null) return undefined;
  if (!isEffortLevel(v)) throw bad(`effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  return v;
}

// threads.send's answers (Needs you, Answering): short, and only for the
// app to show, so anything malformed is refused rather than half kept.
// Only a phone command the primary passed on to a draining runner says
// where it came from (docs/protocol.md, threads.send).
function optPhoneOrigin(p: Record<string, unknown>): { origin?: 'phone' } {
  if (p.origin === undefined) return {};
  if (p.origin !== 'phone') throw bad('origin can only be "phone"');
  return { origin: 'phone' };
}

function optAnswers(p: Record<string, unknown>): { answers?: AskAnswer[] } {
  const v = p.answers;
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v) || v.length > 10) throw bad('answers must be an array of at most 10');
  const answers = v.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.action !== 'string' || typeof r.answer !== 'string') throw bad('each answer needs an action and an answer');
    return { action: r.action.slice(0, 500), answer: r.answer.slice(0, 4000) };
  });
  return answers.length ? { answers } : {};
}

function optImages(p: Record<string, unknown>): ImageRef[] | undefined {
  const v = p.images;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad('images must be an array');
  return v.map((x) => {
    if (!x || typeof x !== 'object' || typeof (x as ImageRef).path !== 'string') throw bad('each image needs a path');
    return x as ImageRef;
  });
}
