// How much room each account has left. Token Stats is the only program that
// reads Keychain logins, renews them or calls Anthropic's usage endpoint;
// Threadbear reads the limits.json it writes as a baseline and adds the
// readings it gets for free from its own turns (Claude's rate_limit_event,
// Codex's account/rateLimits). It never runs `token-stats limits`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AccountUsage, Provider, UsageWindow, UsageWindowKind } from './protocol.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import type { UsageHistory } from './usage-history.ts';

// blockedUntil (ms) says when a block ends when no window does: the runner
// marks a login blocked when a turn hits its limit (pools, runner.ts) and
// the reading didn't already say so.
export type UsageReading = { windows: UsageWindow[]; blocked?: boolean; blockedUntil?: number; email?: string; plan?: string };

// Another runner's reading of one of its logins, from the backend's
// accounts table (sync.ts). A subscription is one limit wherever it's
// signed in, so the same provider and email here is the same login.
// `byOwnerKey`: the main Mac's key wrote it (convex/sync.ts sharedUsage).
// Only those count: a runner key's reading says whatever that key likes,
// and even one window of it could keep this runner's pools off a login
// (Gautam's 6 Nov convex scan, F1). A backend from API 53 sends no other;
// an older one sends everyone's unmarked, and this runner takes none.
// No runnerId for a runner key's runner, which isn't told whose it is.
export type SharedReading = { runnerId?: string; provider: Provider; email: string; usage: AccountUsage; byOwnerKey?: boolean };

// Token Stats hasn't written limits.json for this long: its numbers are old.
export const STALE_MS = 15 * 60_000;
// limits.json is replaced by rename and watched; this catches a missed event.
export const POLL_MS = 60_000;
// The longest delay setTimeout takes (scheduleWake).
export const MAX_TIMER_MS = 2 ** 31 - 1;

const WINDOW_KINDS: readonly UsageWindowKind[] = ['five_hour', 'weekly', 'weekly_model', 'daily', 'monthly', 'allowance', 'other'];
// Kinds an account has at most one of. The rest (per-model weeks,
// allowances, Codex's other buckets) can repeat, told apart by title.
const SINGLE_KINDS = new Set<UsageWindowKind>(['five_hour', 'weekly', 'daily', 'monthly']);

function windowKey(w: UsageWindow): string {
  return SINGLE_KINDS.has(w.kind) ? w.kind : `${w.kind}:${w.title}`;
}

// ---- limits.json ----

// One account in Token Stats' limits.json (version 1). Only what's used is
// typed; unknown fields are ignored.
type BaselineAccount = {
  provider: Provider;
  configDir: string; // ~ expanded; compared through samePathKey
  email?: string;
  plan?: string;
  notice?: string;
  readAt: number; // usageReadAt, else the file's generatedAt
  windows: UsageWindow[];
};

type Baseline = { generatedAt: number; accounts: BaselineAccount[] };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The same folder however it's written: "~/.codex", "/Users/x/.codex/",
// or through a symlink.
// Folders that exist are remembered: list() looks every account up often.
const realpaths = new Map<string, string>();
export function samePathKey(p: string): string {
  const abs = path.resolve(expandTilde(p));
  const known = realpaths.get(abs);
  if (known) return known;
  try {
    const real = fs.realpathSync(abs);
    if (realpaths.size > 200) realpaths.clear();
    realpaths.set(abs, real);
    return real;
  } catch {
    return abs;
  }
}

function readWindow(raw: unknown): UsageWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  if (typeof w.remainingPercent !== 'number' || !Number.isFinite(w.remainingPercent)) return undefined;
  const kind = (WINDOW_KINDS as readonly string[]).includes(w.kind as string) ? (w.kind as UsageWindowKind) : 'other';
  const out: UsageWindow = {
    kind,
    title: str(w.title) ?? kind,
    remainingPercent: Math.max(0, Math.min(100, w.remainingPercent)),
  };
  const resetsAt = str(w.resetsAt);
  if (resetsAt && !Number.isNaN(Date.parse(resetsAt))) out.resetsAt = resetsAt;
  const detail = str(w.detail);
  if (detail) out.detail = detail;
  return out;
}

// Parses limits.json. undefined for anything that isn't version 1 (or a
// file caught half written), so the last good baseline stays.
export function parseLimitsJson(raw: unknown): Baseline | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1 || !Array.isArray(doc.accounts)) return undefined;
  const generatedAt = Date.parse(String(doc.generatedAt ?? ''));
  if (Number.isNaN(generatedAt)) return undefined;
  const accounts: BaselineAccount[] = [];
  for (const item of doc.accounts) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    // "Claude", "Codex", and Grok and Muse, which Threadbear doesn't run.
    const provider = String(a.provider ?? '').toLowerCase();
    if (provider !== 'claude' && provider !== 'codex') continue;
    const configDir = str(a.configDir);
    if (!configDir) continue;
    const readAt = Date.parse(String(a.usageReadAt ?? ''));
    const entry: BaselineAccount = {
      provider,
      configDir: path.resolve(expandTilde(configDir)),
      readAt: Number.isNaN(readAt) ? generatedAt : readAt,
      windows: (Array.isArray(a.windows) ? a.windows : []).map(readWindow).filter((w): w is UsageWindow => !!w),
    };
    const email = str(a.email);
    if (email) entry.email = email;
    const plan = str(a.plan);
    if (plan) entry.plan = plan;
    const notice = str(a.notice);
    if (notice) entry.notice = notice;
    accounts.push(entry);
  }
  return { generatedAt, accounts };
}

// ---- live readings, kept in <data dir>/usage.json ----

type LiveWindow = UsageWindow & { at: number };
type LiveAccount = {
  at: number; // the newest reading
  windows: LiveWindow[];
  blocked?: boolean;
  blockedUntil?: number; // a block ends when the windows that caused it reset
  email?: string;
  plan?: string;
};
type UsageFile = { version: 1; accounts: Record<string, LiveAccount> };

// What the store knows about an account it was asked about, so a change to
// the baseline can be reported by account id.
type KnownAccount = Pick<Account, 'id' | 'provider' | 'configDir' | 'email'>;

export class UsageStore {
  private limitsFile: string;
  private usageFile: string;
  private clock: Clock;
  private log: Logger;
  private baseline?: Baseline;
  private baselineStamp = '';
  private live = new Map<string, LiveAccount>();
  private known = new Map<string, KnownAccount>();
  private sent = new Map<string, AccountUsage | undefined>(); // last reported, per account
  // The newest reading the main Mac's key wrote of each login, by provider:email.
  private shared = new Map<string, { at: number; usage: AccountUsage }>();
  private listeners = new Set<(ids: string[]) => void>();
  private watcher?: fs.FSWatcher;
  private pollTimer?: TimerHandle;
  private wakeTimer?: TimerHandle;
  private wakeAt = 0;
  private running = false;
  // Samples what each login shows over time (usage-history.ts).
  private history?: UsageHistory;

  constructor(o: { limitsFile: string; dataDir: string; clock: Clock; log: Logger; history?: UsageHistory }) {
    this.limitsFile = o.limitsFile;
    this.history = o.history;
    this.usageFile = path.join(o.dataDir, 'usage.json');
    this.clock = o.clock;
    this.log = o.log;
    const saved = readJsonSync<UsageFile>(this.usageFile);
    if (saved?.version === 1 && saved.accounts && typeof saved.accounts === 'object') {
      for (const [id, a] of Object.entries(saved.accounts)) {
        if (a && typeof a.at === 'number' && Array.isArray(a.windows)) this.live.set(id, a);
      }
    }
    this.loadBaseline();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Token Stats replaces limits.json by rename, so watch the folder.
    try {
      const dir = path.dirname(this.limitsFile);
      // Any event in the folder reloads: a rename can be reported under the
      // temp file's name only, and reload() just compares stat() stamps.
      this.watcher = fs.watch(dir, { persistent: false }, () => this.reload());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // No folder yet (Token Stats not installed): the poll picks it up.
    }
    this.schedulePoll();
    this.scheduleWake();
  }

  stop(): void {
    this.running = false;
    this.watcher?.close();
    this.watcher = undefined;
    this.pollTimer?.cancel();
    this.pollTimer = undefined;
    this.wakeTimer?.cancel();
    this.wakeTimer = undefined;
    this.history?.flush();
  }

  onChange(fn: (accountIds: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // A reading from one of the account's own turns.
  record(accountId: string, reading: UsageReading): void {
    const now = this.clock.now();
    const have = this.live.get(accountId);
    const next: LiveAccount = have ? { ...have, windows: [...have.windows] } : { at: now, windows: [] };
    next.at = now;
    for (const w of reading.windows) {
      const key = windowKey(w);
      const i = next.windows.findIndex((x) => windowKey(x) === key);
      const lw: LiveWindow = { ...w, at: now };
      if (i >= 0) next.windows[i] = lw;
      else next.windows.push(lw);
    }
    if (reading.blocked !== undefined) {
      next.blocked = reading.blocked;
      delete next.blockedUntil;
      if (reading.blocked) {
        // The windows at their limit say when the block ends. Without one,
        // the block holds until a reading says otherwise.
        const ends = reading.windows.filter((w) => w.remainingPercent < 1 && w.resetsAt).map((w) => Date.parse(w.resetsAt!));
        if (ends.length) next.blockedUntil = Math.max(...ends);
        else if (reading.blockedUntil !== undefined && Number.isFinite(reading.blockedUntil)) next.blockedUntil = reading.blockedUntil;
      } else delete next.blocked;
    }
    if (reading.email) next.email = reading.email;
    if (reading.plan) next.plan = reading.plan;
    this.live.set(accountId, next);
    this.persist();
    this.changed(false, [accountId]);
  }

  // Other runners' readings (setShared from sync.ts, with this runner's own
  // rows left out). Only the newest per login is kept, and none Token
  // Stats called stale, and none without `byOwnerKey` (SharedReading).
  setShared(rows: SharedReading[]): void {
    const next = new Map<string, { at: number; usage: AccountUsage }>();
    for (const r of rows) {
      const at = Date.parse(r.usage?.readAt ?? '');
      if (r.byOwnerKey !== true || !r.email || !Number.isFinite(at) || r.usage.stale || !Array.isArray(r.usage.windows)) continue;
      const key = `${r.provider}:${r.email.toLowerCase()}`;
      const have = next.get(key);
      if (!have || at > have.at) next.set(key, { at, usage: r.usage });
    }
    this.shared = next;
    this.changed(false);
  }

  // Email and plan for titles: limits.json first (it comes from the
  // profile endpoint), then the account's own last reading.
  identityFor(account: KnownAccount): { email?: string; plan?: string } {
    const base = this.baselineFor(account);
    const live = this.live.get(account.id);
    const out: { email?: string; plan?: string } = {};
    const email = base?.email ?? live?.email;
    if (email) out.email = email;
    const plan = base?.plan ?? live?.plan;
    if (plan) out.plan = plan;
    return out;
  }

  usageFor(account: KnownAccount): AccountUsage | undefined {
    this.known.set(account.id, { id: account.id, provider: account.provider, configDir: account.configDir, ...(account.email ? { email: account.email } : {}) });
    const usage = this.compute(account);
    if (!this.sent.has(account.id)) this.sent.set(account.id, usage);
    return usage;
  }

  private compute(account: KnownAccount): AccountUsage | undefined {
    const now = this.clock.now();
    const base = this.baselineFor(account);
    const live = this.live.get(account.id);
    const email = (account.email ?? live?.email ?? base?.email)?.toLowerCase();
    const shared = email ? this.shared.get(`${account.provider}:${email}`) : undefined;
    // Newer wins, window by window: Token Stats, this runner's own turns,
    // then other runners' readings of the same login.
    type From = 'tokenStats' | 'live' | 'shared';
    const merged = new Map<string, { w: UsageWindow; at: number; from: From }>();
    for (const w of base?.windows ?? []) merged.set(windowKey(w), { w, at: base!.readAt, from: 'tokenStats' });
    for (const lw of live?.windows ?? []) {
      const { at, ...w } = lw;
      const have = merged.get(windowKey(w));
      if (!have || at >= have.at) merged.set(windowKey(w), { w, at, from: 'live' });
    }
    for (const w of shared?.usage.windows ?? []) {
      const have = merged.get(windowKey(w));
      if (!have || shared!.at > have.at) merged.set(windowKey(w), { w, at: shared!.at, from: 'shared' });
    }
    // Another machine found it at its limit after this one last read it:
    // blocked here too, until a window at the limit resets.
    const sharedBlocked =
      !!shared?.usage.blocked &&
      shared.at > (live?.at ?? 0) &&
      (() => {
        const ends = shared.usage.windows.filter((w) => w.remainingPercent < 1 && w.resetsAt).map((w) => Date.parse(w.resetsAt!));
        return ends.length === 0 || ends.some((t) => t > now);
      })();
    const blocked = (!!live?.blocked && (live.blockedUntil === undefined || now < live.blockedUntil)) || sharedBlocked;
    if (merged.size === 0 && !blocked) return undefined;
    // When the account was last read at all, by any source.
    const latest = Math.max(base?.readAt ?? 0, live?.at ?? 0, shared?.at ?? 0);
    let newest: { at: number; from: From } = { at: 0, from: 'tokenStats' };
    const windows: UsageWindow[] = [];
    for (const m of merged.values()) {
      if (m.at > newest.at) newest = { at: m.at, from: m.from };
      // A reading taken after this window reset didn't mention it: the
      // login has no such window any more. Anthropic dropped the 5-hour
      // one from Max plans at the end of Oct 2026, and without this its
      // last reading showed as "5-hour 100% left" forever. A reading before
      // the reset can leave it out (the CLI's single-window fallback), so
      // only one after it counts.
      const reset = m.w.resetsAt ? Date.parse(m.w.resetsAt) : NaN;
      if (reset <= now && latest > m.at && latest > reset) continue;
      windows.push(afterReset(m.w, now));
    }
    if (live && live.at > newest.at) newest = { at: live.at, from: 'live' };
    windows.sort((a, b) => WINDOW_KINDS.indexOf(a.kind) - WINDOW_KINDS.indexOf(b.kind));
    const usage: AccountUsage = {
      windows,
      readAt: new Date(newest.at).toISOString(),
      source: newest.from,
    };
    // Token Stats has gone quiet, and no turn of this account's has
    // brought a reading in that time either.
    if (base && this.baseline && now - this.baseline.generatedAt > STALE_MS && !(live && now - live.at <= STALE_MS) && !(shared && now - shared.at <= STALE_MS)) usage.stale = true;
    if (blocked) usage.blocked = true;
    if (base?.notice) usage.notice = base.notice;
    return usage;
  }

  // limits.json's entry for this account: the same folder, or failing
  // that the same provider and email.
  private baselineFor(account: KnownAccount): BaselineAccount | undefined {
    const accounts = this.baseline?.accounts;
    if (!accounts) return undefined;
    // Resolved at lookup, not at load: a folder made after limits.json was
    // read resolves differently (/var is /private/var on macOS).
    const key = samePathKey(account.configDir);
    const byDir = accounts.find((b) => samePathKey(b.configDir) === key);
    if (byDir) return byDir.provider === account.provider ? byDir : undefined;
    if (!account.email) return undefined;
    const email = account.email.toLowerCase();
    return accounts.find((b) => b.provider === account.provider && b.email?.toLowerCase() === email);
  }

  // Re-reads limits.json if it changed. Called from the watcher and the poll.
  reload(): void {
    if (this.loadBaseline()) this.changed(true);
  }

  private loadBaseline(): boolean {
    let stamp: string;
    try {
      const st = fs.statSync(this.limitsFile);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return false; // missing: keep what we have
    }
    if (stamp === this.baselineStamp) return false;
    const parsed = parseLimitsJson(readJsonSync(this.limitsFile));
    if (!parsed) {
      // Unreadable or another version. Try again when it next changes.
      this.log.warn('usage: limits.json not readable', { file: this.limitsFile });
      this.baselineStamp = stamp;
      return false;
    }
    this.baselineStamp = stamp;
    this.baseline = parsed;
    return true;
  }

  private schedulePoll(): void {
    this.pollTimer = this.clock.setTimeout(() => {
      if (!this.running) return;
      this.reload();
      this.schedulePoll();
    }, POLL_MS);
  }

  // Wakes at the next moment a known account's usage changes by itself: a
  // window resets, a block ends, or the numbers go stale.
  private scheduleWake(): void {
    if (!this.running) return;
    const now = this.clock.now();
    const times: number[] = [];
    for (const a of this.known.values()) {
      const u = this.compute(a);
      for (const w of u?.windows ?? []) if (w.resetsAt) times.push(Date.parse(w.resetsAt));
      const live = this.live.get(a.id);
      if (live?.blockedUntil) times.push(live.blockedUntil);
      if (live) times.push(live.at + STALE_MS + 1);
    }
    if (this.baseline) times.push(this.baseline.generatedAt + STALE_MS + 1);
    const next = Math.min(...times.filter((t) => t > now));
    if (!Number.isFinite(next)) return;
    if (this.wakeTimer && this.wakeAt === next) return;
    this.wakeTimer?.cancel();
    this.wakeAt = next;
    // Node fires a timer over 2^31-1 ms (24.8 days) at once, so a monthly
    // window's reset would wake this every millisecond: wake at the cap
    // instead, which works it out again.
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = undefined;
      this.changed(true);
    }, Math.min(next - now, MAX_TIMER_MS));
  }

  // Tells listeners which accounts' usage changed since it was last
  // reported. A live reading only counts once a window has moved by a
  // point; a new limits.json or a reset counts whatever changed.
  private changed(exact: boolean, also: string[] = []): void {
    const ids: string[] = [];
    for (const a of this.known.values()) {
      const now = this.compute(a);
      this.history?.observe(a.id, now);
      const was = this.sent.get(a.id);
      if (!sameUsage(was, now, exact)) {
        this.sent.set(a.id, now);
        ids.push(a.id);
      }
    }
    // An account no client has asked about yet still gets reported once.
    for (const id of also) if (!this.known.has(id) && !ids.includes(id)) ids.push(id);
    this.scheduleWake();
    if (!ids.length) return;
    for (const fn of this.listeners) {
      try {
        fn(ids);
      } catch (err) {
        this.log.error('usage: change listener failed', { error: String(err) });
      }
    }
  }

  // A draining runner (docs/protocol.md, "Handovers") keeps readings in
  // memory only; usage.json is the new runner's to write.
  stopWriting(): void {
    this.writes = false;
    this.history?.stopWriting();
  }

  private writes = true;

  private persist(): void {
    if (!this.writes) return;
    const doc: UsageFile = { version: 1, accounts: Object.fromEntries(this.live) };
    try {
      atomicWriteFileSync(this.usageFile, JSON.stringify(doc, null, 2) + '\n');
    } catch (err) {
      this.log.warn('usage: could not write usage.json', { error: String(err) });
    }
  }
}

// A window whose reset has passed is full again until the next reading.
function afterReset(w: UsageWindow, now: number): UsageWindow {
  if (!w.resetsAt || Date.parse(w.resetsAt) > now) return w;
  return { kind: w.kind, title: w.title, remainingPercent: 100 };
}

function sameUsage(a: AccountUsage | undefined, b: AccountUsage | undefined, exact: boolean): boolean {
  if (!a || !b) return a === b;
  if (!!a.blocked !== !!b.blocked || !!a.stale !== !!b.stale || a.notice !== b.notice) return false;
  if (a.windows.length !== b.windows.length) return false;
  return a.windows.every((w, i) => {
    const v = b.windows[i];
    if (windowKey(w) !== windowKey(v) || w.resetsAt !== v.resetsAt) return false;
    if (exact) return w.remainingPercent === v.remainingPercent && w.detail === v.detail;
    return Math.abs(w.remainingPercent - v.remainingPercent) < 1;
  });
}

// ---- words ----

// "1 pm", "3:40 pm", and the day before it when it isn't today: "Thu 1 pm",
// or "2 Nov 1 pm" a week or more away. Local time.
export function resetTime(iso: string, now: number): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const clock = `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return clock;
  const days = (d.getTime() - now) / 86_400_000;
  if (days > 0 && days < 6.5) return `${d.toLocaleDateString('en-AU', { weekday: 'short' })} ${clock}`;
  return `${d.getDate()} ${d.toLocaleDateString('en-AU', { month: 'short' })} ${clock}`;
}

// The two windows that decide the room: 5-hour and weekly. Codex Pro Lite
// and Claude's Max plans (since the end of Oct 2026) have only the weekly
// one; Claude Team still has both.
function mainWindows(u: AccountUsage): UsageWindow[] {
  return u.windows.filter((w) => w.kind === 'five_hour' || w.kind === 'weekly');
}

// "5-hour 89% left, weekly 78% left, resets Thu 1 pm", for list_accounts
// and tb. The reset is the tighter window's.
export function usageLine(u: AccountUsage | undefined, now: number = Date.now()): string {
  if (!u) return 'usage unknown';
  const main = mainWindows(u);
  const shown = main.length ? main : u.windows;
  const tight = [...shown].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
  let line: string;
  if (u.blocked) {
    const at = shown.filter((w) => w.remainingPercent < 1 && w.resetsAt).sort((a, b) => Date.parse(b.resetsAt!) - Date.parse(a.resetsAt!))[0] ?? tight;
    line = at?.resetsAt ? `limit reached, resets ${resetTime(at.resetsAt, now)}` : 'limit reached';
  } else if (!shown.length) {
    line = 'usage unknown';
  } else {
    const parts = shown.map((w) => `${w.kind === 'five_hour' ? '5-hour' : w.kind === 'weekly' ? 'weekly' : w.title} ${Math.round(w.remainingPercent)}% left`);
    line = parts.join(', ') + (tight.resetsAt ? `, resets ${resetTime(tight.resetsAt, now)}` : '');
  }
  if (u.stale) line += ` (as of ${resetTime(u.readAt, now)})`;
  return line;
}

// ---- picking an account for a new thread ----

// Under this much room an account isn't picked for a new thread.
export const MIN_ROOM_PERCENT = 10;

// The tighter of the 5-hour and weekly windows, or the only one there is.
// undefined when neither is known.
export function accountRoom(account: Account): number | undefined {
  const main = account.usage ? mainWindows(account.usage) : [];
  if (!main.length) return undefined;
  return Math.min(...main.map((w) => w.remainingPercent));
}

// Which account a new thread starts on when none is named: the one with the
// most room, among the last-used account's provider so a Claude habit stays
// on Claude. Skips blocked accounts, ones under 10%, and ones with a note
// (a login noted "Work only" is kept for that work).
// A tie, or a last-used account with no usage known, stays on the last-used
// one; so does a list where every candidate is skipped. The app's
// AccountUsageText.swift has the same rule and the same test cases
// (runner/test/fixtures/pick-account-cases.json).
export function pickAccount(accounts: Account[], lastUsedId: string | undefined): string | undefined {
  const last = accounts.find((a) => a.id === lastUsedId);
  const provider = last?.provider ?? accounts[0]?.provider;
  const eligible = accounts.filter((a) => a.provider === provider && !a.note && !a.usage?.blocked);
  // Nothing is known about the last-used account, so nothing says another
  // has more room.
  if (last && eligible.includes(last) && accountRoom(last) === undefined) return last.id;
  let best: { id: string; room: number } | undefined;
  for (const a of eligible) {
    const room = accountRoom(a);
    if (room === undefined || room < MIN_ROOM_PERCENT) continue;
    if (!best || room > best.room || (room === best.room && a.id === last?.id)) best = { id: a.id, room };
  }
  return best?.id ?? last?.id;
}
