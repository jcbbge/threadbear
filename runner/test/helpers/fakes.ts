import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentSession, SessionSink, StartSessionOptions, UserInput, AdapterOutput, TurnResult, RewindRequest, RewindResult } from '../../src/adapters/types.ts';
import type { Account, EffortLevel, ModelChoice, PermissionMode, Provider } from '../../src/protocol.ts';
import type { Config } from '../../src/config.ts';
import { ensureHome } from '../../src/config.ts';
import { ThreadStore } from '../../src/store.ts';
import { Runner, type Notification, type RunnerDeps } from '../../src/runner.ts';
import { FakeClock } from '../../src/clock.ts';
import type { LearnedAccountInfo } from '../../src/accounts.ts';
import { nullLogger } from '../../src/log.ts';
import { TRUST_ALL } from '../../src/patch-trust.ts';

export class FakeSession implements AgentSession {
  opts: StartSessionOptions;
  sink: SessionSink;
  sent: UserInput[] = [];
  interrupts = 0;
  ended = false;
  endedHard = false;
  killed = false;
  models: (string | undefined)[] = [];
  efforts: (EffortLevel | undefined)[] = [];
  modes: PermissionMode[] = [];
  cwds: string[] = []; // setCwd calls (adapters that move folders)
  interruptError?: Error;
  // When set, end() waits for exit() like a real CLI that takes a moment
  // to shut down after its input ends.
  slowExit = false;
  private exitNow?: () => void;

  constructor(opts: StartSessionOptions, sink: SessionSink) {
    this.opts = opts;
    this.sink = sink;
  }
  send(input: UserInput): void {
    this.sent.push(input);
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
    if (this.interruptError) throw this.interruptError;
  }
  async setModel(model: string | undefined): Promise<void> {
    this.models.push(model);
  }
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    this.efforts.push(effort);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.modes.push(mode);
  }
  // Only on an adapter that moves folders (FakeAdapter sets it up).
  setCwd?: (cwd: string) => Promise<void>;
  async end(opts: { hard?: boolean } = {}): Promise<void> {
    this.ended = true;
    this.endedHard = Boolean(opts.hard);
    if (this.slowExit) await new Promise<void>((r) => (this.exitNow = r));
    this.sink.exited();
  }
  exit(): void {
    this.exitNow?.();
  }
  kill(): void {
    this.killed = true;
    this.sink.exited(new Error('killed'));
  }
  // Test helpers that play the CLI's part.
  out(o: AdapterOutput): void {
    this.sink.output(o);
  }
  init(id = this.opts.sessionId, model = 'claude-haiku-5-5'): void {
    this.out({ kind: 'session', nativeSessionId: id, model });
  }
  effort(level: EffortLevel): void {
    this.out({ kind: 'effort', level });
  }
  text(itemId: string, text: string): void {
    this.out({ kind: 'event', event: { type: 'assistant.text', itemId, text } });
  }
  delta(itemId: string, text: string): void {
    this.out({ kind: 'delta', delta: { type: 'assistant.text.delta', itemId, text } });
  }
  // `extra` plays the CLI's lifecycle frames: which messages the turn
  // answered (`answered`, `answers`) or that it was the CLI's own (`own`).
  result(outcome: 'completed' | 'interrupted' | 'failed' = 'completed', totalCostUsd?: number, error?: string, extra: Partial<TurnResult> = {}): void {
    this.out({ kind: 'result', result: { outcome, durationMs: 10, totalCostUsd, error, ...extra } });
  }
}

// Codex's adapter flags (section A): folder moves in the same session,
// settings from the next turn, no turn of its own after background work.
export const CODEX_FLAGS = { movesFolders: true, settingsApplyNextTurn: true, wakesAfterTasks: false } as const;

export class FakeAdapter implements AgentAdapter {
  readonly provider: Provider;
  readonly movesFolders?: boolean;
  readonly settingsApplyNextTurn?: boolean;
  readonly wakesAfterTasks?: boolean;
  sessions: FakeSession[] = [];
  slowExit = false;
  // Set by a test that wants the runner's model probe to find something.
  models?: (account: Account) => Promise<ModelChoice[]>;
  // Set by a test of the composer's command picker.
  commands?: (account: Account, cwd: string, untrusted?: Record<string, unknown>) => Promise<import('../../src/slash-commands.ts').SlashCommand[]>;
  archived: { accountId: string; nativeSessionId: string }[] = [];
  archive?: (account: Account, nativeSessionId: string) => Promise<void>;
  // Set by a test of editing a message; `rewound` keeps what it was asked.
  rewind?: (req: RewindRequest) => Promise<RewindResult>;
  rewound: RewindRequest[] = [];
  binaries: string[] = [];
  constructor(provider: Provider = 'claude', flags: { movesFolders?: boolean; settingsApplyNextTurn?: boolean; wakesAfterTasks?: boolean; archives?: boolean } = {}) {
    this.provider = provider;
    if (flags.movesFolders !== undefined) this.movesFolders = flags.movesFolders;
    if (flags.settingsApplyNextTurn !== undefined) this.settingsApplyNextTurn = flags.settingsApplyNextTurn;
    if (flags.wakesAfterTasks !== undefined) this.wakesAfterTasks = flags.wakesAfterTasks;
    if (flags.archives) {
      this.archive = async (account, nativeSessionId) => {
        this.archived.push({ accountId: account.id, nativeSessionId });
      };
    }
  }
  start(opts: StartSessionOptions, sink: SessionSink): AgentSession {
    const s = new FakeSession(opts, sink);
    s.slowExit = this.slowExit;
    if (this.movesFolders) {
      s.setCwd = async (cwd) => {
        s.cwds.push(cwd);
      };
    }
    this.sessions.push(s);
    return s;
  }
  // The binaries its live sessions run (the Codex adapter's, for E).
  binariesInUse(): string[] {
    return this.binaries;
  }
  get last(): FakeSession {
    return this.sessions[this.sessions.length - 1];
  }
}

const made: string[] = [];
process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

// A temp folder that's removed when the test process exits.
export function tmpDir(prefix = 'tb-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

export function testConfig(home: string, extra: Partial<Config> = {}): Config {
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    home,
    port: 0,
    host: '127.0.0.1',
    logFile: path.join(home, 'runner.log'),
    claudePath: '/nonexistent/claude',
    idleMs: 30 * 60_000,
    maxLive: 6,
    defaults: { cwd },
    claudeMainDir: path.join(home, 'no-claude-main'),
    claudeMainJson: path.join(home, 'no-claude-main.json'),
    tokenStatsAccountsDir: path.join(home, 'no-accounts'),
    // Nothing under the real ~/.codex or Token Stats, and no CLI installs.
    codexArgs: [],
    codexMainDir: path.join(home, 'no-codex-main'),
    tokenStatsLimitsFile: path.join(home, 'no-limits.json'),
    cliUpdates: { claude: 'off', codex: 'off', checkMinutes: 60, keepCodexVersions: 2 },
    accountNotes: {},
    followMain: false,
    bulletReplies: true,
    oneReply: false,
    models: { pool: 'claude', privateFolders: [] },
    // Never the real Convex project from a test (sync.test.ts passes a fake).
    sync: { enabled: false },
    ...extra,
  };
}

export const ACCOUNTS: Account[] = [
  { id: 'claude-main', provider: 'claude', title: 'main@example.com', configDir: '/tmp/main' },
  { id: 'claude-3', provider: 'claude', title: 'three@example.com', configDir: '/tmp/three' },
];

export const CODEX_MODELS: ModelChoice[] = [
  { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', title: 'GPT-6.1-Sol', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-6-luna', model: 'gpt-6-luna', title: 'GPT-6-Luna', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
];

export const CODEX_ACCOUNT: Account = {
  id: 'codex-main',
  provider: 'codex',
  title: 'Codex · main@example.com',
  email: 'main@example.com',
  configDir: '/tmp/codex-main',
  defaultModel: 'gpt-6.1-sol',
};

// The Claude logins plus codex-main, with its model list (null: not known yet).
export function withCodex(models: ModelChoice[] | null = CODEX_MODELS): Account[] {
  return [...ACCOUNTS, { ...CODEX_ACCOUNT, ...(models ? { models } : {}) }];
}

// Stands in for AccountRegistry: a fixed list, plus what the runner learns
// (a probe's model list, an observed default), applied the way it does.
export class FakeAccounts {
  private learned = new Map<string, LearnedAccountInfo>();
  base: Account[]; // a test can change it, as a rescan would find
  constructor(base: Account[] = ACCOUNTS) {
    this.base = base;
  }
  list(): Account[] {
    return this.base.map((a) => {
      const info = this.learned.get(a.id);
      if (!info) return a;
      const out = { ...a };
      if (info.defaultModel) out.defaultModel = info.defaultModel;
      if (info.models) out.models = info.models;
      return out;
    });
  }
  get(id: string): Account | undefined {
    return this.list().find((a) => a.id === id);
  }
  learn(id: string, info: LearnedAccountInfo): boolean {
    const have = this.learned.get(id) ?? {};
    const next = { ...have, ...info };
    if (JSON.stringify(next) === JSON.stringify(have)) return false;
    this.learned.set(id, next);
    return true;
  }
}

export type Harness = {
  home: string;
  cfg: Config;
  clock: FakeClock;
  adapter: FakeAdapter;
  codex: FakeAdapter; // Codex-style flags, archives
  runner: Runner;
  store: ThreadStore;
  notes: Notification[];
  events(threadId: string): any[];
  restart(): Harness;
};

export function makeHarness(home = tmpDir(), cfgExtra: Partial<Config> = {}, depsExtra: Partial<RunnerDeps> = {}): Harness {
  ensureHome(home);
  const cfg = testConfig(home, cfgExtra);
  const clock = new FakeClock();
  const adapter = new FakeAdapter();
  const codex = new FakeAdapter('codex', { ...CODEX_FLAGS, archives: true });
  const store = new ThreadStore(home);
  const runner = new Runner({
    config: cfg,
    store,
    adapters: { claude: adapter, codex },
    accounts: new FakeAccounts(),
    clock,
    log: nullLogger,
    defer: (fn) => fn(),
    // Patch trust has its own tests; the rest load every patch file.
    patchTrust: TRUST_ALL,
    // Never touch a real Claude config dir from a test.
    copyTranscript: () => false,
    subagentTranscript: () => null,
    // Never probe the real network: the API is always there unless a test says.
    reachable: async () => true,
    // Setup and hooks at normal priority: on a busy Mac a background shell
    // can miss a test's wait. background.test.ts covers the real path.
    backgroundJobs: false,
    ...depsExtra,
  });
  const notes: Notification[] = [];
  runner.onNotification((n) => notes.push(n));
  runner.start();
  return {
    home,
    cfg,
    clock,
    adapter,
    codex,
    runner,
    store,
    notes,
    events: (threadId) =>
      notes.filter((n) => n.method === 'thread.event' && n.params.threadId === threadId).map((n) => (n as any).params.event),
    restart: () => makeHarness(home, cfgExtra, depsExtra),
  };
}

// Lets promise callbacks (deliver(), interrupt().catch) run.
export async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}
