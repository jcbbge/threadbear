// Handovers (docs/protocol.md, "Handovers"): a new runner takes over while
// the old one finishes the turns it has. This is the part between the two:
//
// - drain files: run/drain-<pid>.json says where a draining runner listens
//   and which threads it still has;
// - Peers: the primary's connections to draining runners, which pass
//   requests about their threads to them and their notifications back;
// - PrimaryLink: a draining runner's way back to the primary, for agent
//   tools that act on other threads, schedules or projects;
// - ThreadRouter: what the agent tools drive, on either side, so they reach
//   a thread wherever it is.
import type { StartRequest } from './cross-runner.ts';
import type { SecretAnswer, SecretRequest } from './runner/approvals.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { RUNNER_VERSION, paths } from './config.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import type { Logger } from './log.ts';
import { RunnerClient, RpcClientError } from './client.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { PermissionMode, ThreadSummary } from './protocol.ts';
import type { Notification, Runner } from './runner.ts';
import type { UsageReading } from './usage.ts';
import type { AgentApprovalRequest, ProjectControl, ScheduleControl, ThreadControl } from './threadbear-mcp.ts';
import type { ToolApprovalAnswer } from './adapters/types.ts';
import type { Scheduler } from './schedules.ts';
import type { CommandHost } from './sync.ts';
import type { DrainProjectOp, MembershipChange, Projects } from './projects.ts';
import { processInfo } from './proc.ts';

// `auth: 'challenge'`: this runner answers the RPC's auth challenge
// (docs/protocol.md, "Auth"). A drain file without it is from an older
// runner, which only knows the bearer header.
export type DrainInfo = { pid: number; port: number; version: string; release?: string; since: string; threads: string[]; auth?: 'challenge' };
export type Bucket = 'inbox' | 'snoozed' | 'archived';
export const ALL_BUCKETS: Bucket[] = ['inbox', 'snoozed', 'archived'];

export function drainFile(home: string, pid: number): string {
  return path.join(paths.run(home), `drain-${pid}.json`);
}

// The process-group list a draining runner keeps (ProcessRegistry.moveTo).
export function drainChildrenName(pid: number): string {
  return `children-${pid}.json`;
}

export function writeDrainInfo(home: string, info: DrainInfo): void {
  atomicWriteFileSync(drainFile(home, info.pid), JSON.stringify(info, null, 2) + '\n');
}

export function removeDrainInfo(home: string, pid: number): void {
  fs.rmSync(drainFile(home, pid), { force: true });
}

export function listDrainInfos(home: string): DrainInfo[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(paths.run(home));
  } catch {
    return [];
  }
  const out: DrainInfo[] = [];
  for (const n of names) {
    if (!/^drain-\d+\.json$/.test(n)) continue;
    const info = readJsonSync<DrainInfo>(path.join(paths.run(home), n));
    if (info && typeof info.pid === 'number' && typeof info.port === 'number' && Array.isArray(info.threads)) out.push(info);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// A runner process (main.ts under a supervisor), not a recycled pid.
export function runnerAlive(pid: number): boolean {
  const info = processInfo(pid);
  return Boolean(info && /main\.ts/.test(info.command));
}

export function bucketOf(t: Pick<ThreadSummary, 'archivedAt' | 'snoozedUntil'>, now: number): Bucket {
  if (t.archivedAt) return 'archived';
  if (t.snoozedUntil && Date.parse(t.snoozedUntil) > now) return 'snoozed';
  return 'inbox';
}

// Newest activity first, as Runner.list sorts; the first copy of an id wins.
export function mergeSummaries(...lists: ThreadSummary[][]): ThreadSummary[] {
  const seen = new Set<string>();
  const out: ThreadSummary[] = [];
  for (const t of lists.flat()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
}

// The peer's error as the caller's: its code and message come through
// unchanged, and a dropped connection reads as "try again".
function asRpcError(e: unknown): RpcError {
  if (e instanceof RpcError) return e;
  if (e instanceof RpcClientError) return new RpcError(e.code, e.message);
  return new RpcError(ErrorCode.busy, `The other runner couldn't be reached (${(e as Error)?.message ?? e}); try again in a moment.`);
}

// A draining runner's thread as the primary shows it: still on the old
// release until its turn ends.
function marked(t: ThreadSummary): ThreadSummary {
  return { ...t, onOldRunner: true };
}

export function isMoved(e: unknown): boolean {
  return (e instanceof RpcError || e instanceof RpcClientError) && e.code === ErrorCode.moved;
}

// ------------------------------------------------------------------ Peers

export type PeerClient = Pick<RunnerClient, 'call' | 'onNotification' | 'waitClosed' | 'close'>;

type Peer = { info: DrainInfo; client: PeerClient; threads: Map<string, ThreadSummary>; gone: boolean };

export type PeersDeps = {
  home: string;
  token: string;
  log: Logger;
  // Where handed-over threads go, and how the peers' notifications reach
  // this runner's clients (and its schedules and restarter).
  runner: Pick<Runner, 'adopt' | 'publish' | 'waitedOnDeleted'>;
  // Usage readings from the draining runners' turns (drain.usage).
  usage?: (accountId: string, reading: UsageReading) => void;
  // Whenever what status() says changes (runner.updates, main.ts).
  onChange?: () => void;
  // Stops the process groups a dead draining runner left.
  sweep: (pid: number) => Promise<void>;
  // Tests replace these.
  connect?: (port: number, token: string, legacyHeader: boolean, pid: number) => Promise<PeerClient>;
  alive?: (pid: number) => boolean;
  now?: () => number;
  // How long a draining runner that has closed its connection gets to
  // exit before it's counted as dead.
  goneWaitMs?: number;
};

// The primary's side: one connection per draining runner.
export class Peers {
  private deps: PeersDeps;
  private peers = new Map<number, Peer>();
  // Threads of a draining runner that went, between it going and them being
  // taken in here (lost): not on any runner for those few seconds.
  private arriving = new Set<string>();
  private closing = false;

  constructor(deps: PeersDeps) {
    this.deps = deps;
  }

  private alive(pid: number): boolean {
    return (this.deps.alive ?? runnerAlive)(pid);
  }

  // Connects to every draining runner the data dir lists, before this
  // runner loads its threads. Returns the threads they still have, for
  // Runner.start to leave alone. A drain file whose runner is gone is
  // cleared after its process groups are stopped, and its threads are left
  // for start() to load and recover as after a crash.
  async connectAll(): Promise<Set<string>> {
    const kept = new Set<string>();
    for (const info of listDrainInfos(this.deps.home)) {
      if (info.pid === process.pid) continue;
      const peer = this.alive(info.pid) ? await this.connect(info) : undefined;
      if (!peer) {
        this.deps.log.warn('a draining runner is gone; its threads load as after a crash', { pid: info.pid, threads: info.threads });
        await this.cleanUp(info.pid);
        continue;
      }
      for (const id of peer.threads.keys()) kept.add(id);
    }
    return kept;
  }

  private async connect(info: DrainInfo): Promise<Peer | undefined> {
    const connect = this.deps.connect ?? ((port: number, token: string, legacy: boolean, pid: number) => connectDrain(port, token, legacy, pid));
    let client: PeerClient;
    try {
      // The one place a new client may still send the token (docs/
      // protocol.md, "Before the challenge"): a draining runner from before
      // the challenge can't answer one, and it's the drain file, in this
      // runner's own data dir, that says so, never the server. Remove with
      // the old auth paths.
      client = await connect(info.port, this.deps.token, info.auth !== 'challenge', info.pid);
    } catch (e) {
      this.deps.log.error('could not reach a draining runner', { pid: info.pid, port: info.port, error: String(e) });
      return undefined;
    }
    const peer: Peer = { info, client, threads: new Map(), gone: false };
    // Before any call, so nothing it says in between is missed.
    client.onNotification((method, params) => this.onNotification(peer, method, params));
    try {
      const hello = await client.call<{ threads: string[]; version?: string; release?: string }>('drain.hello', {});
      peer.info = { ...info, threads: hello.threads, version: hello.version ?? info.version, release: hello.release ?? info.release };
      const { threads } = await client.call<{ threads: ThreadSummary[] }>('threads.list', { include: ALL_BUCKETS });
      const keeps = new Set(hello.threads);
      for (const t of threads) if (keeps.has(t.id)) peer.threads.set(t.id, marked(t));
      // Live events for each, from here on. The backlog isn't needed: a
      // client that subscribes gets its own through threads.subscribe.
      for (const id of peer.threads.keys()) await client.call('threads.subscribe', { threadId: id, afterSeq: Number.MAX_SAFE_INTEGER });
    } catch (e) {
      this.deps.log.error('could not take over from a draining runner', { pid: info.pid, error: String(e) });
      client.close();
      return undefined;
    }
    this.peers.set(info.pid, peer);
    this.deps.onChange?.();
    this.deps.log.info('connected to a draining runner', { pid: info.pid, version: peer.info.version, threads: [...peer.threads.keys()] });
    void client.waitClosed().then(() => this.lost(peer));
    return peer;
  }

  private onNotification(peer: Peer, method: string, params: any): void {
    // Closed because this runner is draining now: the primary takes these.
    if (this.closing) return;
    const id: unknown = params?.threadId ?? params?.thread?.id;
    switch (method) {
      case 'drain.handedOver': {
        const threadId = String(params?.threadId ?? '');
        if (!peer.threads.delete(threadId)) return;
        this.deps.log.info('a thread came across from the draining runner', { threadId, pid: peer.info.pid });
        // Loads it from disk; its thread.updated goes out from here.
        this.deps.runner.adopt(threadId);
        this.deps.onChange?.();
        return;
      }
      case 'drain.usage':
        if (typeof params?.accountId === 'string' && params.reading) this.deps.usage?.(params.accountId, params.reading);
        return;
      case 'thread.updated': {
        if (typeof id !== 'string' || !peer.threads.has(id)) return;
        const thread = marked(params.thread);
        peer.threads.set(id, thread);
        this.deps.runner.publish({ method, params: { thread } });
        return;
      }
      case 'thread.event':
        if (typeof id !== 'string' || !peer.threads.has(id)) return;
        break;
      case 'thread.deleted':
        if (typeof id !== 'string' || !peer.threads.delete(id)) return;
        // A thread here may be waiting on it (end_turn's waitFor).
        this.deps.runner.waitedOnDeleted(id);
        this.deps.onChange?.();
        break;
      case 'runner.notice':
        break;
      default:
        // accounts, schedules, settings and CLIs are the primary's own.
        return;
    }
    this.deps.runner.publish({ method, params } as Notification);
  }

  // The connection closed. A runner that has handed everything over exits
  // and leaves nothing to do; one that died with threads still on it left
  // them mid-turn, so they're adopted as after a crash.
  private async lost(peer: Peer): Promise<void> {
    if (this.closing || peer.gone) return;
    peer.gone = true;
    const left = [...peer.threads.keys()];
    // Neither its nor here yet until they're taken in below: arriving() says
    // so, or the mirror would take their rows (and messages) for stale.
    for (const id of left) this.arriving.add(id);
    this.peers.delete(peer.info.pid);
    this.deps.onChange?.();
    if (left.length === 0) {
      this.deps.log.info('a draining runner finished', { pid: peer.info.pid });
      return;
    }
    await this.takeIn(peer, left);
  }

  private async takeIn(peer: Peer, left: string[]): Promise<void> {
    // A runner that closed its socket is on its way out; give it a moment
    // to finish exiting before stopping what it left.
    const until = Date.now() + (this.deps.goneWaitMs ?? 10_000);
    while (this.alive(peer.info.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    // This runner is handing over itself now: the next one takes the draining
    // runner on, and stopping it here would stop work that one has.
    if (this.closing) return;
    if (this.alive(peer.info.pid)) {
      this.deps.log.error('a draining runner stopped answering; stopping it', { pid: peer.info.pid });
      try {
        process.kill(peer.info.pid, 'SIGTERM');
      } catch {
        // gone
      }
    }
    this.deps.log.warn('a draining runner went away with threads on it; taking them as after a crash', { pid: peer.info.pid, threads: left });
    await this.cleanUp(peer.info.pid);
    // One that can't be taken in stays arriving, so its row isn't taken for stale.
    for (const id of left) {
      try {
        this.deps.runner.adopt(id, { crashed: true });
        this.arriving.delete(id);
      } catch (e) {
        this.deps.log.error('could not take in a thread a draining runner left', { threadId: id, error: String((e as Error)?.message ?? e) });
      }
    }
  }

  private async cleanUp(pid: number): Promise<void> {
    try {
      await this.deps.sweep(pid);
    } catch (e) {
      this.deps.log.warn("could not stop a draining runner's process groups", { pid, error: String(e) });
    }
    try {
      removeDrainInfo(this.deps.home, pid);
    } catch (e) {
      this.deps.log.warn('could not remove a drain file', { pid, error: String(e) });
    }
  }

  private ownerOf(threadId: string): Peer | undefined {
    for (const p of this.peers.values()) if (p.threads.has(threadId)) return p;
    return undefined;
  }

  owns(threadId: string): boolean {
    return Boolean(this.ownerOf(threadId));
  }

  // A thread a draining runner had when it went, until it's taken in here.
  isArriving(threadId: string): boolean {
    return this.arriving.has(threadId);
  }

  arrivingIds(): string[] {
    return [...this.arriving];
  }

  find(threadId: string): ThreadSummary | undefined {
    return this.ownerOf(threadId)?.threads.get(threadId);
  }

  // Every thread draining runners have, in the given lists.
  summaries(include: Bucket[] = ['inbox']): ThreadSummary[] {
    const want = new Set(include);
    const now = (this.deps.now ?? Date.now)();
    const out: ThreadSummary[] = [];
    for (const p of this.peers.values()) for (const t of p.threads.values()) if (want.has(bucketOf(t, now))) out.push(t);
    return out;
  }

  async search(query: string, limit: number): Promise<ThreadSummary[]> {
    const results = await Promise.all(
      [...this.peers.values()].map((p) =>
        p.client
          .call<{ threads: ThreadSummary[] }>('threads.search', { query, limit })
          .then((r) => r.threads.filter((t) => p.threads.has(t.id)))
          .catch(() => [] as ThreadSummary[]),
      ),
    );
    return results.flat();
  }

  // Passes a request about one of a draining runner's threads to it. Its
  // error comes back as an RpcError with the same code; -32030 (moved)
  // means it has just handed the thread over, which this side has heard by
  // then (the notification comes first on the same connection).
  async call(threadId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const peer = this.ownerOf(threadId);
    if (!peer) throw new RpcError(ErrorCode.moved, 'That thread has moved to this runner.');
    try {
      return await peer.client.call(method, params);
    } catch (e) {
      throw asRpcError(e);
    }
  }

  // For runner.status.
  status(): DrainInfo[] {
    return [...this.peers.values()].map((p) => ({ ...p.info, threads: [...p.threads.keys()] }));
  }

  // `when: "now"`: every draining runner stops too.
  async stopAll(): Promise<void> {
    await Promise.all([...this.peers.values()].map((p) => p.client.call('drain.stop', {}).catch(() => {})));
  }

  close(): void {
    this.closing = true;
    for (const p of this.peers.values()) p.client.close();
    this.peers.clear();
  }
}

// A draining runner's own server: by the challenge, bound to its kind of
// server so nothing on the main port can pass a challenge on to it; or,
// for one from before the challenge, with the bearer header, but only over
// a socket whose other end is that runner's (socketOwnedBy). Its port can
// be taken by someone else while its pid lives on: shutdown closes the
// server before the drain file goes.
export async function connectDrain(port: number, token: string, legacyHeader: boolean, pid: number, owned: Parameters<typeof socketOwnedBy>[2] = {}): Promise<RunnerClient> {
  const url = `ws://127.0.0.1:${port}/rpc`;
  if (!legacyHeader) return RunnerClient.connect(url, token, { server: 'drain' });
  return RunnerClient.connect(url, token, { legacyHeader: true, socket: await socketOwnedBy(port, pid, owned) });
}

const execFileP = promisify(execFile);

// Where lsof is: /usr/sbin on a Mac, /usr/bin on Linux. A fixed path, not a search
// of PATH, as what it says decides who gets the bearer token. With /usr/sbin alone
// every check failed on Linux, and with it the tests a release has to pass, which
// held the cloud runner on an old release for hours (5 Nov).
export function lsofPath(exists: (file: string) => boolean = fs.existsSync): string {
  return ['/usr/sbin/lsof', '/usr/bin/lsof'].find(exists) ?? '/usr/sbin/lsof';
}

// A connected socket to 127.0.0.1:<port> whose other end is an open file of
// `pid`, a process of this user, as lsof sees it; otherwise it throws and
// nothing has been sent. The check is on this very connection (its own
// local port), so whoever has the port can't change between the check and
// what goes over it. Tests pass lsof and ps stand-ins.
export async function socketOwnedBy(
  port: number,
  pid: number,
  opts: { attempts?: number; lsof?: (args: string[]) => Promise<string>; uidOf?: (pid: number) => Promise<number | undefined> } = {},
): Promise<net.Socket> {
  const lsof = opts.lsof ?? (async (args) => (await execFileP(lsofPath(), args, { encoding: 'utf8' })).stdout);
  const uidOf = opts.uidOf ?? (async (p) => {
    const out = (await execFileP('/bin/ps', ['-o', 'uid=', '-p', String(p)], { encoding: 'utf8' }).catch(() => ({ stdout: '' }))).stdout.trim();
    return /^\d+$/.test(out) ? Number(out) : undefined;
  });
  if ((await uidOf(pid)) !== process.getuid?.()) throw new Error(`process ${pid} isn't this user's`);
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const want = `n127.0.0.1:${port}->127.0.0.1:${socket.localPort}`;
  // The runner may not have accepted the connection yet; it does within
  // a moment.
  for (let i = 0; i < (opts.attempts ?? 10); i++) {
    const out = await lsof(['-nP', '-a', '-p', String(pid), `-iTCP@127.0.0.1:${port}`, '-F', 'n']).catch(() => '');
    if (out.split('\n').includes(want)) return socket;
    await new Promise((r) => setTimeout(r, 100));
  }
  socket.destroy();
  throw new Error(`the listener on port ${port} isn't process ${pid}`);
}

// ------------------------------------------------------------ PrimaryLink

// A draining runner's connection to the primary, on the runner's port,
// made when an agent tool first needs it and again after it drops.
export class PrimaryLink {
  private url: string;
  private token: string;
  private client?: Promise<RunnerClient>;

  constructor(host: string, port: number, token: string) {
    this.url = `ws://${host}:${port}/rpc`;
    this.token = token;
  }

  private connect(): Promise<RunnerClient> {
    if (!this.client) {
      // It says hello so the primary's log can name it (THREADBEAR-F: the
      // primary closed one as "not reading" and couldn't say whose it was).
      // Not waited for: frames arrive in order, so it's there before any call.
      const c = RunnerClient.connect(this.url, this.token).then((cl) => {
        void cl.call('hello', { client: 'threadbear-drain', version: RUNNER_VERSION, pid: process.pid }).catch(() => {});
        return cl;
      });
      this.client = c;
      c.then(
        (cl) => void cl.waitClosed().then(() => {
          if (this.client === c) this.client = undefined;
        }),
        () => {
          if (this.client === c) this.client = undefined;
        },
      );
    }
    return this.client;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let client: RunnerClient;
    try {
      client = await this.connect();
    } catch {
      throw new RpcError(ErrorCode.busy, "The new runner isn't answering yet; try again in a moment.");
    }
    try {
      return await client.call<T>(method, params);
    } catch (e) {
      throw asRpcError(e);
    }
  }

  close(): void {
    void this.client?.then((c) => c.close(), () => {});
    this.client = undefined;
  }
}

// ------------------------------------------------------------ ThreadRouter

// Threads that aren't on this runner: on the primary, those draining
// runners still have; on a draining runner, everything it has let go.
export type Elsewhere = {
  owns(threadId: string): boolean;
  find(threadId: string): Promise<ThreadSummary | undefined>;
  list(include: Bucket[]): Promise<ThreadSummary[]>;
  search(query: string, limit: number): Promise<ThreadSummary[]>;
  // A request for the runner that has the thread (params.threadId), or
  // threads.create.
  call(method: string, params: Record<string, unknown>): Promise<any>;
};

export function peersElsewhere(peers: Peers): Elsewhere {
  return {
    owns: (id) => peers.owns(id),
    find: async (id) => peers.find(id),
    list: async (include) => peers.summaries(include),
    search: (q, limit) => peers.search(q, limit),
    call: (method, params) => peers.call(String(params.threadId ?? ''), method, params),
  };
}

export function primaryElsewhere(link: PrimaryLink, runner: Pick<Runner, 'has'>): Elsewhere {
  return {
    owns: (id) => !runner.has(id),
    // Just this thread (THREADBEAR-F): list_schedules looks up every
    // schedule's thread at once, and all 900 summaries for each lookup piled
    // up past the primary's limit, which closed this link. An older primary
    // ignores ids and sends them all, so the one is still picked out here.
    find: async (id) => (await link.call<{ threads: ThreadSummary[] }>('threads.list', { include: ALL_BUCKETS, ids: [id] })).threads.find((t) => t.id === id),
    list: async (include) => (await link.call<{ threads: ThreadSummary[] }>('threads.list', { include })).threads,
    search: async (query, limit) => (await link.call<{ threads: ThreadSummary[] }>('threads.search', { query, limit })).threads,
    call: (method, params) => link.call(method, params),
  };
}

// What the agent tools drive (threadbear-mcp.ts's ThreadControl): this
// runner's own threads directly, the rest wherever they are.
// What main.ts gives the router for other runners: cross-runner.ts's start.
export type CrossRunnerHooks = { start(threadId: string, req: StartRequest): Promise<string | undefined> };

export class ThreadRouter implements ThreadControl {
  private runner: Runner;
  private elsewhere: () => Elsewhere | undefined;
  private cross: () => CrossRunnerHooks | undefined;

  constructor(runner: Runner, elsewhere: () => Elsewhere | undefined, cross: () => CrossRunnerHooks | undefined = () => undefined) {
    this.runner = runner;
    this.elsewhere = elsewhere;
    this.cross = cross;
  }

  // Asking another runner (cross-runner.ts). Only a thread's own agent asks,
  // on the runner that has the thread.
  async startOn(threadId: string, req: StartRequest): Promise<string | undefined> {
    const c = this.cross();
    return c ? c.start(threadId, req) : undefined;
  }

  // The Elsewhere for a thread this runner doesn't have, if any.
  private away(threadId: string): Elsewhere | undefined {
    if (this.runner.has(threadId)) return undefined;
    const e = this.elsewhere();
    return e?.owns(threadId) ? e : undefined;
  }

  hello(): ReturnType<Runner['hello']> {
    return this.runner.hello();
  }

  // Always this runner's: it's asked by the session it runs itself.
  endTurnNudged(threadId: string): boolean {
    return this.runner.endTurnNudged(threadId);
  }

  openSubagentCards(threadId: string): string[] {
    return this.runner.openSubagentCards(threadId);
  }

  async list(include: Bucket[] = ['inbox']): Promise<ThreadSummary[]> {
    const local = this.runner.list(include);
    const e = this.elsewhere();
    return e ? mergeSummaries(local, await e.list(include).catch(() => [])) : local;
  }

  async search(query: string, limit = 50): Promise<ThreadSummary[]> {
    const local = this.runner.search(query, limit);
    const e = this.elsewhere();
    return e ? mergeSummaries(local, await e.search(query, limit).catch(() => [])).slice(0, limit) : local;
  }

  async get(threadId: string): Promise<ThreadSummary> {
    const e = this.away(threadId);
    if (!e) return this.runner.get(threadId);
    const t = await e.find(threadId);
    if (!t) throw new RpcError(ErrorCode.threadNotFound, `Thread not found: ${threadId}`);
    return t;
  }

  async events(threadId: string, opts: Parameters<Runner['events']>[1] = {}): Promise<ReturnType<Runner['events']>> {
    const e = this.away(threadId);
    return e ? e.call('threads.events', { threadId, ...opts }) : this.runner.events(threadId, opts);
  }

  async create(params: Parameters<Runner['create']>[0]): Promise<ReturnType<Runner['create']>> {
    // A draining runner makes no threads; the primary does.
    const e = this.runner.keeping() ? this.elsewhere() : undefined;
    return e ? e.call('threads.create', { ...params }) : this.runner.create(params);
  }

  async send(threadId: string, text: string, images: Parameters<Runner['send']>[2] = [], opts: Parameters<Runner['send']>[3] = {}): Promise<{ turnId: string }> {
    const e = this.away(threadId);
    return e ? e.call('threads.send', { threadId, text, images, ...(opts.answers ? { answers: opts.answers } : {}) }) : this.runner.send(threadId, text, images, opts);
  }

  async createReview(threadId: string, input: Parameters<Runner['createReview']>[1]): Promise<ReturnType<Runner['createReview']>> {
    const e = this.away(threadId);
    return e ? e.call('reviews.create', {threadId, ...input}) : this.runner.createReview(threadId, input);
  }

  // Only a thread's own agent makes its buttons, from its CLI on the
  // runner that has the thread, so this never goes elsewhere either.
  createButton(threadId: string, input: Parameters<Runner['createButton']>[1]): ReturnType<Runner['createButton']> {
    return this.runner.createButton(threadId, input);
  }

  // Only a thread's own agent asks, from its CLI on the runner that has the
  // thread, so this never goes elsewhere.
  requestSecret(threadId: string, req: SecretRequest): Promise<SecretAnswer> {
    return this.runner.requestSecret(threadId, req);
  }

  // A thread on the other runner counts as having full access: this one
  // can't see what its turn started with (threadbear-mcp.ts, "Raising access").
  async accessOf(threadId: string): Promise<PermissionMode> {
    return this.away(threadId) ? 'full' : this.runner.accessOf(threadId);
  }

  // Likewise outside any sandbox, which is the most it could have.
  async confinedOf(threadId: string): Promise<boolean> {
    return this.away(threadId) ? false : this.runner.confinedOf(threadId);
  }

  sandboxed(cwd: string): boolean {
    return this.runner.sandboxed(cwd);
  }

  // Likewise for a threadbear tool's own card (threadbear-mcp.ts, "Raising access").
  requestAgentApproval(threadId: string, req: AgentApprovalRequest): Promise<ToolApprovalAnswer> {
    return this.runner.requestAgentApproval(threadId, req);
  }

  // Only a thread's own agent pins, and its CLI is a child of the runner
  // that has the thread, so these never have to go elsewhere.
  pin(threadId: string, target: Parameters<Runner['pin']>[1]): ReturnType<Runner['pin']> {
    return this.runner.pin(threadId, target);
  }

  unpin(threadId: string, highlightId: string): ReturnType<Runner['unpin']> {
    return this.runner.unpin(threadId, highlightId);
  }

  // Likewise: the request waits on this runner, which the app's
  // threads.panelShown reaches through the primary.
  showPanel(threadId: string, ask: Parameters<Runner['showPanel']>[1]): ReturnType<Runner['showPanel']> {
    return this.runner.showPanel(threadId, ask);
  }

  async update(upd: Parameters<Runner['update']>[0]): Promise<ReturnType<Runner['update']>> {
    const e = this.away(upd.threadId);
    // Said either way, as the primary takes a move with neither as Mike's.
    return e ? e.call('threads.update', { ...upd, unconfine: upd.unconfine === true }) : this.runner.update(upd);
  }

  async interrupt(threadId: string): Promise<Record<string, never>> {
    const e = this.away(threadId);
    // The router is what agents' tools go through, so this isn't Mike's Stop.
    return e ? e.call('threads.interrupt', { threadId, byAgent: true }) : this.runner.interrupt(threadId);
  }

  async delete(threadId: string): Promise<Record<string, never>> {
    const e = this.away(threadId);
    return e ? e.call('threads.delete', { threadId }) : this.runner.delete(threadId);
  }
}

// The phone's commands (sync.ts's CommandHost): this runner's threads
// directly, and one a draining runner still has over there, as the app's
// RPCs go (rpc.ts's forward). Without this a command for a thread
// finishing its turn on the old runner failed with "Thread not found".
export function phoneCommands(runner: Runner, remote?: Pick<Peers, 'owns' | 'call'>): CommandHost {
  const at = <T>(threadId: string, method: string, params: Record<string, unknown>, here: () => T): T | Promise<unknown> => {
    if (runner.has(threadId) || !remote?.owns(threadId)) return here();
    // Just handed over (-32030): this runner has it by now.
    return remote.call(threadId, method, { threadId, ...params }).catch((e) => {
      if (isMoved(e) && runner.has(threadId)) return here();
      throw e;
    });
  };
  return {
    send: (id, text, images, o) => at(id, 'threads.send', { text, ...(images.length ? { images } : {}), origin: o.origin, ...(o.answers ? { answers: o.answers } : {}) }, () => runner.send(id, text, images, o)) as { turnId: string },
    respondApproval: (p) => at(p.threadId, 'approvals.respond', { ...p }, () => runner.respondApproval(p)),
    // Opened by sync.ts already; a thread still on a draining runner gets
    // it over the local link, both runners sharing the one data dir.
    answerSecret: (p) => at(p.threadId, 'secrets.answer', { ...p }, () => runner.answerSecret(p)),
    update: (p) => at(p.threadId, 'threads.update', { ...p }, () => runner.update(p)),
    // Up to whatever it has: markSeen keeps it within the thread's events.
    markSeen: (id) => at(id, 'threads.markSeen', { seq: Number.MAX_SAFE_INTEGER }, () => runner.markSeen(id, runner.get(id).lastSeq)),
    create: (p) => runner.create(p),
    share: (id, p) => at(id, 'threads.share', { ...p }, () => runner.share(id, p)),
    interrupt: (id) => at(id, 'threads.interrupt', {}, () => runner.interrupt(id, { byMike: true })),
    quickAsk: (p) => runner.quickAsk(p),
    pressButton: (id, buttonId) => at(id, 'buttons.press', { buttonId }, () => runner.pressButton(id, buttonId)),
  };
}

// What the schedule tools drive: this runner's Scheduler, or on a draining
// runner (whose scheduler has stopped) the primary's, over the link.
export function scheduleRouter(local: Scheduler, link: () => PrimaryLink | undefined): ScheduleControl {
  const list = async (threadId?: string) => {
    const l = link();
    if (!l) return local.list(threadId);
    return (await l.call<{ schedules: ReturnType<Scheduler['list']> }>('schedules.list', threadId ? { threadId } : {})).schedules;
  };
  return {
    create: async (p) => {
      const l = link();
      return l ? (await l.call('schedules.create', { ...p })).schedule : local.create(p);
    },
    list,
    find: async (idOrPrefix) => {
      if (!link()) return local.find(idOrPrefix);
      const hits = (await list()).filter((s) => s.id === idOrPrefix || s.id.startsWith(idOrPrefix));
      if (hits.length === 1) return hits[0];
      throw new RpcError(ErrorCode.scheduleNotFound, hits.length ? `${idOrPrefix} matches ${hits.length} schedules; use more of the id.` : `No schedule ${idOrPrefix}.`);
    },
    update: async (p) => {
      const l = link();
      return l ? (await l.call('schedules.update', { ...p })).schedule : local.update(p);
    },
    delete: async (scheduleId) => {
      const l = link();
      return l ? l.call('schedules.delete', { scheduleId }) : local.delete(scheduleId);
    },
  };
}

type Link = Pick<PrimaryLink, 'call'>;

// What the project tools drive. Projects belong to the primary, so once
// this runner is draining its tools read and change them there
// (drain.projects), as this runner's own copy stops at the handover. A turn
// kept here can last an hour, so refusing until the handover is over would
// lose most of what agents write at the end of a long turn (29 Oct: 131
// refused calls in three days). Joining or leaving changes the thread,
// though, and a thread kept here is still this runner's: that part happens
// here, against the primary's copy of the project, and moves across with
// the thread.
export function projectRouter(
  local: Projects,
  link: () => Link | undefined,
  opts: { draining: () => boolean; holds: (threadId: string) => boolean },
): ProjectControl {
  // Where a change goes: the primary, once this runner knows where it is.
  const primary = (): Link | undefined => {
    const l = link();
    if (!l && opts.draining()) throw new Error('Threadbear is starting its new runner; try the project tool again in a few seconds.');
    return l;
  };
  const there = async <K extends DrainProjectOp>(l: Link, op: K, args: Parameters<Projects[K]>): Promise<Awaited<ReturnType<Projects[K]>>> => {
    try {
      return (await l.call<{ result: Awaited<ReturnType<Projects[K]>> }>('drain.projects', { op, args })).result;
    } catch (e) {
      // A rollback can leave an older release as the primary.
      if (e instanceof RpcError && e.code === ErrorCode.methodNotFound) {
        throw new Error("The new runner is an older release that can't change projects for a thread finishing its turn on this one. Make the change in your next turn.");
      }
      throw e;
    }
  };
  const changeHere = async (l: Link, threadId: string, change: MembershipChange) => {
    for (const id of [...(change.add ?? []), ...(change.remove ?? [])]) {
      const rec = await there(l, 'find', [id]);
      if (rec) local.adopt(rec);
    }
    return local.changeMembership(threadId, change);
  };
  return {
    list: async (o) => {
      const l = link();
      return l ? there(l, 'list', [o]) : local.list(o);
    },
    get: async (projectId) => {
      const l = link();
      return l ? there(l, 'get', [projectId]) : local.get(projectId);
    },
    // No such project comes back as null.
    find: async (q) => {
      const l = link();
      return l ? ((await there(l, 'find', [q])) ?? undefined) : local.find(q);
    },
    create: async (p) => {
      const l = primary();
      if (!l) return local.create(p);
      // The primary doesn't have the threads kept here: they join here.
      const ids = p.threadIds ?? [];
      const made = await there(l, 'create', [{ ...p, threadIds: ids.filter((t) => !opts.holds(t)) }]);
      for (const t of ids.filter(opts.holds)) await changeHere(l, t, { add: [made.id], by: p.by });
      return made;
    },
    update: async (projectId, params) => {
      const l = primary();
      return l ? there(l, 'update', [projectId, params]) : local.update(projectId, params);
    },
    appendNote: async (projectId, text) => {
      const l = primary();
      return l ? there(l, 'appendNote', [projectId, text]) : local.appendNote(projectId, text);
    },
    addLinks: async (projectId, links) => {
      const l = primary();
      return l ? there(l, 'addLinks', [projectId, links]) : local.addLinks(projectId, links);
    },
    removeLinks: async (projectId, urls) => {
      const l = primary();
      return l ? there(l, 'removeLinks', [projectId, urls]) : local.removeLinks(projectId, urls);
    },
    changeMembership: async (threadId, change) => {
      const l = primary();
      if (!l) return local.changeMembership(threadId, change);
      return opts.holds(threadId) ? changeHere(l, threadId, change) : there(l, 'changeMembership', [threadId, change]);
    },
    chooseIcon: async (projectId, choice, by) => {
      const l = primary();
      return l ? there(l, 'chooseIcon', [projectId, choice, by]) : local.chooseIcon(projectId, choice, by);
    },
  };
}
