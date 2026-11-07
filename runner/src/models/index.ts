// The runner's own small-model calls (docs/protocol.md, "Settings and
// models"): classify, extract, summarize and generate, on one of the Claude
// logins in a pool, through the official CLI. Features ask for a job, not
// a model; ROUTES says which model answers it. A call never throws: a
// failed one says why, and the feature falls back to what it did before
// there was a model to ask.
//
// There used to be OpenRouter too, with a key, a daily budget and a spend
// to show. Mike dropped it (29 Oct 2026): every feature is Haiku or Opus,
// which his subscription runs anyway, and a key was one more thing for
// anyone setting Threadbear up.
import path from 'node:path';
import type { Clock } from '../clock.ts';
import type { Logger } from '../log.ts';
import type { Account, Pool } from '../protocol.ts';
import { expandHome } from '../config.ts';
import { pickInPool } from '../pools.ts';
import { askCli, cliDir } from './claude-pool.ts';
import type { AskCli, CliResponse } from './claude-pool.ts';
import { Ledger } from './ledger.ts';
import { outermostBraces } from '../linear-text.ts';
import type { UsageLine } from './ledger.ts';

export type ModelJob = 'classify' | 'extract' | 'summarize' | 'generate' | 'decide';

// Haiku for everything small; Opus for the few calls that need judgment
// more than speed (a generate with `strong`: Mike's words for when to wake
// a thread).
export const HAIKU = 'claude-haiku-5-5';
export const OPUS = 'claude-opus-5-5';
// The model a thread kept from Ask starts on when there's no Claude login.
export const ASK_CODEX_MODEL = 'gpt-6-luna';

export const ROUTES: Record<ModelJob, string> = {
  classify: HAIKU,
  extract: HAIKU,
  summarize: HAIKU,
  generate: HAIKU,
  decide: OPUS,
};

// no-pool: no pool, or none of its logins is a Claude one. off: this
// runner makes no model calls (no claude binary).
export type ModelFailure = 'no-pool' | 'off' | 'private' | 'no-room' | 'timeout' | 'provider';

export type ModelResult<T> =
  // tokens: in and out together, when the CLI said. notionalUsd: what the
  // call would have cost on the API, which isn't spent.
  | { ok: true; value: T; model: string; tokens?: number; notionalUsd?: number }
  | { ok: false; reason: ModelFailure; message: string };

// Every call names the feature asking (for the usage file) and, when it
// sends a thread's text, the thread's folder (for private folders).
type Common = { feature: string; cwd?: string };

export type ClassifyParams = Common & { text: string; labels: string[]; instructions?: string };
export type ExtractParams = Common & { text: string; fields: Record<string, string> };
export type SummarizeParams = Common & { text: string; maxWords?: number };
// strong: Opus (ROUTES.decide) rather than Haiku.
export type GenerateParams = Common & { prompt: string; system?: string; maxTokens?: number; strong?: boolean };

// pool: the pool whose Claude logins answer; null for none (no small jobs).
export type ModelSettings = { privateFolders: string[]; pool?: string | null };

// What the Models layer needs of the runner.
export type PoolHost = {
  // The pool and its logins this runner can use, with their room as the
  // runner knows it; undefined when there's no pool by that id.
  pool(id: string): { pool: Pool; accounts: Account[] } | undefined;
  // A login that answered that it's out of room, as a turn would.
  ranDry(accountId: string): void;
};

export type ModelsOptions = {
  home: string;
  clock: Clock;
  log: Logger;
  settings: () => ModelSettings;
  // The runner's pools and the claude binary. Without them every call says
  // no-pool or off.
  poolHost?: PoolHost;
  claudePath?: string;
  registry?: { add(pid: number, command: string): void; remove(pid: number): void };
  // Stands in for the CLI in tests.
  askCli?: AskCli;
  poolTimeoutMs?: number;
};

// A CLI takes 3 to 5 seconds to start and answer, and each is a whole
// process, so only a few at once.
const POOL_TIMEOUT_MS = 60_000;
const POOL_MAX_IN_FLIGHT = 2;
export const DEFAULT_POOL = 'claude';

// A folder in the list, or anywhere under one.
export function isPrivate(cwd: string, folders: string[]): boolean {
  const at = path.resolve(expandHome(cwd));
  return folders.some((f) => {
    const p = path.resolve(expandHome(f));
    return at === p || at.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  });
}

type Failure = { ok: false; reason: ModelFailure; message: string };

// What one call asks the model, and how to read its answer (undefined: it
// said something we can't use).
type Attempt<T> = {
  system?: string;
  user: string;
  maxTokens?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  read: (text: string) => T | undefined;
};

export class Models {
  private opts: ModelsOptions;
  private ledger: Ledger;
  private poolInFlight = 0;
  private poolWaiting: (() => void)[] = [];
  // The login the last call ran on, kept while it has room so its prompt
  // cache stays warm.
  private lastLogin?: string;

  constructor(opts: ModelsOptions) {
    this.opts = opts;
    this.ledger = new Ledger(opts.home);
  }

  // The pool small jobs run on, from the settings.
  poolId(): string | null {
    const p = this.opts.settings().pool;
    return p === undefined ? DEFAULT_POOL : p;
  }

  // Why no call could go out at all, or undefined when one might: there's
  // a pool with a Claude login. Room isn't checked; a call finds that out.
  unavailable(): string | undefined {
    return this.poolLogins() ? undefined : 'Needs a Claude pool to run on';
  }

  private poolLogins(): { pool: Pool; accounts: Account[] } | undefined {
    const id = this.poolId();
    if (id === null || !this.opts.poolHost) return undefined;
    const found = this.opts.poolHost.pool(id);
    if (!found) return undefined;
    const accounts = found.accounts.filter((a) => a.provider === 'claude' && found.pool.accountIds.includes(a.id));
    return accounts.length ? { pool: found.pool, accounts } : undefined;
  }

  // Picks one of `labels` for the text.
  classify(p: ClassifyParams): Promise<ModelResult<string>> {
    const labels = [...new Set(p.labels)];
    return this.run('classify', p, {
      system: `${p.instructions ? p.instructions.trim() + '\n\n' : ''}Answer with one of these labels: ${labels.join(', ')}.`,
      user: p.text,
      maxTokens: 50,
      jsonSchema: {
        name: 'label',
        schema: { type: 'object', properties: { label: { type: 'string', enum: labels } }, required: ['label'], additionalProperties: false },
      },
      read: (text) => {
        const label = (parseObject(text)?.label ?? text.trim()) as unknown;
        return typeof label === 'string' && labels.includes(label) ? label : undefined;
      },
    });
  }

  // Pulls named fields out of the text; `fields` maps each name to a plain
  // description of it. A field the text doesn't give is null.
  extract(p: ExtractParams): Promise<ModelResult<Record<string, string | null>>> {
    const names = Object.keys(p.fields);
    return this.run('extract', p, {
      system: `Extract these fields from the text. Use null for any the text doesn't give.\n${names.map((n) => `- ${n}: ${p.fields[n]}`).join('\n')}`,
      user: p.text,
      maxTokens: 1000,
      jsonSchema: {
        name: 'fields',
        schema: {
          type: 'object',
          properties: Object.fromEntries(names.map((n) => [n, { type: ['string', 'null'], description: p.fields[n] }])),
          required: names,
          additionalProperties: false,
        },
      },
      read: (text) => {
        const obj = parseObject(text);
        if (!obj) return undefined;
        const out: Record<string, string | null> = {};
        for (const n of names) {
          const v = obj[n];
          out[n] = v === undefined || v === null || v === '' ? null : Array.isArray(v) ? v.map(String).join('\n') : String(v);
        }
        return out;
      },
    });
  }

  summarize(p: SummarizeParams): Promise<ModelResult<string>> {
    const words = p.maxWords ?? 80;
    return this.run('summarize', p, {
      system: `Summarise the text in at most ${words} words. Plain text, no preamble.`,
      user: p.text,
      maxTokens: Math.ceil(words * 2) + 50,
      read: (text) => text.trim() || undefined,
    });
  }

  // Whether nothing from this folder may go to a model.
  isPrivateFolder(cwd: string): boolean {
    return isPrivate(cwd, this.opts.settings().privateFolders);
  }

  generate(p: GenerateParams): Promise<ModelResult<string>> {
    return this.run(p.strong ? 'decide' : 'generate', p, { system: p.system, user: p.prompt, maxTokens: p.maxTokens ?? 500, read: (t) => t.trim() || undefined });
  }

  private async run<T>(job: ModelJob, p: Common, a: Attempt<T>): Promise<ModelResult<T>> {
    const s = this.opts.settings();
    if (p.cwd && isPrivate(p.cwd, s.privateFolders)) return { ok: false, reason: 'private', message: `${p.cwd} is a private folder.` };
    const res = await this.viaPool(job, p, ROUTES[job], a);
    return 'skipped' in res ? res.skipped : res;
  }

  // One route: skipped with no pool or no login with room; else run on a
  // login, and on the next one if that says it's out of room.
  private async viaPool<T>(job: ModelJob, p: Common, model: string, a: Attempt<T>): Promise<ModelResult<T> | { ok: false; skipped: Failure }> {
    if (!this.poolLogins()) {
      const id = this.poolId();
      return skip('no-pool', id === null ? 'Small jobs are on no pool.' : `No pool called ${id} has a Claude login.`);
    }
    if (!this.opts.claudePath) return skip('off', 'Pool calls are off in this runner.');
    await this.acquirePool();
    try {
      const tried: string[] = [];
      let title = '';
      for (;;) {
        // Read again each time round: the last call may have used up a login.
        const found = this.poolLogins();
        if (!found) return skip('no-pool', 'The pool has no Claude login.');
        title = found.pool.title;
        const id = pickInPool(found.pool, found.accounts, { provider: 'claude', current: this.lastLogin, exclude: tried });
        const account = id ? found.accounts.find((x) => x.id === id) : undefined;
        if (!account) break;
        tried.push(account.id);
        const started = this.opts.clock.now();
        const res: CliResponse = await (this.opts.askCli ?? askCli)({
          claudePath: this.opts.claudePath,
          account,
          model,
          system: a.system,
          user: a.user,
          jsonSchema: a.jsonSchema?.schema,
          cwd: cliDir(this.opts.home),
          timeoutMs: this.opts.poolTimeoutMs ?? POOL_TIMEOUT_MS,
          registry: this.opts.registry,
        });
        const value = res.ok ? a.read(res.text) : undefined;
        const unreadable = res.ok && value === undefined ? 'unreadable answer' : undefined;
        this.record({
          job,
          feature: p.feature,
          model,
          started,
          ok: res.ok && !unreadable,
          accountId: account.id,
          ...(res.ok ? { inputTokens: res.inputTokens, outputTokens: res.outputTokens, notionalUsd: res.notionalUsd } : {}),
          ...(!res.ok ? { error: res.message } : unreadable ? { error: unreadable } : {}),
        });
        if (res.ok && value !== undefined) {
          this.lastLogin = account.id;
          return { ok: true, value, model: `${model} on ${account.id}`, ...tokensOf(res), ...(res.notionalUsd !== undefined ? { notionalUsd: res.notionalUsd } : {}) };
        }
        if (!res.ok && res.limit) {
          this.opts.poolHost?.ranDry(account.id);
          if (this.lastLogin === account.id) this.lastLogin = undefined;
          continue;
        }
        if (!res.ok && res.timedOut) return { ok: false, reason: 'timeout', message: res.message };
        return { ok: false, reason: 'provider', message: res.ok ? "The model's answer couldn't be read." : res.message };
      }
      return skip('no-room', `Every login in ${title || 'the pool'} is out of room.`);
    } finally {
      this.releasePool();
    }
  }

  private record(r: { job: ModelJob; feature: string; model: string; started: number; ok: boolean } & Partial<Omit<UsageLine, 'ts' | 'ms'>>): void {
    const now = this.opts.clock.now();
    const { started, error, ...rest } = r;
    const line: UsageLine = {
      ts: new Date(now).toISOString(),
      ...rest,
      ms: now - started,
      ...(error ? { error: error.slice(0, 300) } : {}),
    };
    for (const k of Object.keys(line) as (keyof UsageLine)[]) if (line[k] === undefined) delete line[k];
    this.ledger.add(line);
    if (!line.ok) this.opts.log.warn('model call failed', { feature: r.feature, job: r.job, model: r.model, accountId: r.accountId, error: line.error });
  }

  private acquirePool(): Promise<void> {
    if (this.poolInFlight < POOL_MAX_IN_FLIGHT) {
      this.poolInFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.poolWaiting.push(resolve));
  }

  private releasePool(): void {
    const next = this.poolWaiting.shift();
    if (next) next();
    else this.poolInFlight--;
  }

}

function skip(reason: ModelFailure, message: string): { ok: false; skipped: Failure } {
  return { ok: false, skipped: { ok: false, reason, message } };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  // Models sometimes wrap JSON in a code fence. First "{" to last "}", by
  // indexOf: `/\{[\s\S]*\}/` was quadratic in a reply of "{"s.
  const json = outermostBraces(text);
  if (json === undefined) return undefined;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function tokensOf(res: { inputTokens?: number; outputTokens?: number }): { tokens?: number } {
  return res.inputTokens === undefined && res.outputTokens === undefined ? {} : { tokens: (res.inputTokens ?? 0) + (res.outputTokens ?? 0) };
}
