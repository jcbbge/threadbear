// The Connectors gateway (plugbear, optional; runner.json's gateway): which of its
// services are signed in, for the app's Connectors panel, and the sign-in
// problems an agent runs into, for end_turn to turn into an ask
// (docs/protocol.md, "Connectors").
//
// The runner asks the gateway's open /health every few minutes and when
// the panel opens; the app never calls the gateway itself. /health has changed
// shape once already (a map of id to state, then a list of objects with a
// title, a message and a connect URL), so everything here is read
// leniently: a field it doesn't know is ignored, a missing one has a
// fallback.

import fs from 'node:fs';
import type { PersistedEvent } from './protocol.ts';
import { credentialUrlProblem } from './secure-url.ts';

// How often /health is asked when nobody's looking. A sign-in that lapses
// shows within this; the panel opening asks straight away.
export const POLL_MS = 3 * 60_000;
// An open panel asking again within this gets the answer it just had.
export const FRESH_MS = 10_000;
const TIMEOUT_MS = 5_000;

// The states the app knows. Anything else the gateway says is `unknown`,
// shown with its message.
export type ServiceState = 'connected' | 'signed_out' | 'connecting' | 'error' | 'disabled' | 'unknown';

export type ConnectorService = {
  id: string;
  title: string;
  state: ServiceState;
  message?: string;
  // Where Mike signs this one in: the gateway's own page for it.
  connectUrl?: string;
};

export type ConnectorsStatus = {
  // off: no gateway set up. checking: the first answer hasn't come.
  // unreachable: the last ask failed (error says how).
  state: 'ok' | 'unreachable' | 'off' | 'checking';
  url?: string; // the gateway's base, https://host:port
  checkedAt?: string;
  error?: string;
  version?: string;
  release?: string;
  services: ConnectorService[];
};

// ------------------------------------------------------------------ /health

const STATE_WORDS: Record<string, ServiceState> = {
  ready: 'connected',
  connected: 'connected',
  ok: 'connected',
  signed_in: 'connected',
  needs_sign_in: 'signed_out',
  signed_out: 'signed_out',
  needs_auth: 'signed_out',
  unauthorized: 'signed_out',
  idle: 'connecting',
  connecting: 'connecting',
  starting: 'connecting',
  error: 'error',
  failed: 'error',
  unreachable: 'error',
  disabled: 'disabled',
  off: 'disabled',
};

export function serviceState(raw: unknown): ServiceState {
  if (typeof raw !== 'string') return 'unknown';
  return STATE_WORDS[raw.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? 'unknown';
}

// "notion" as "Notion", for a gateway that sends no titles.
function titleFor(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function str(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

// A connect URL as the gateway gave it, made absolute against its base;
// only http(s), as it becomes a button.
function connectUrlFor(raw: unknown, base: string): string | undefined {
  const s = str(raw, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s, base + '/');
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// /health's body as the panel shows it. Takes both shapes: `upstreams` as
// { id: state } (the first gateway) or as [{ id, title, state, message,
// connectUrl }]. A service that isn't connected with no URL of its own
// gets the gateway's page for it, /admin/connect/<id>.
export function parseHealth(body: unknown, base: string): Pick<ConnectorsStatus, 'version' | 'release' | 'services'> {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const out: Pick<ConnectorsStatus, 'version' | 'release' | 'services'> = { services: [] };
  const version = str(o.version, 100);
  if (version) out.version = version;
  const release = str(o.release, 100);
  if (release) out.release = release;
  const raw = o.upstreams ?? o.services;
  const items: Record<string, unknown>[] = Array.isArray(raw)
    ? raw.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>).map(([id, v]) => (v && typeof v === 'object' ? { id, ...(v as Record<string, unknown>) } : { id, state: v }))
      : [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = str(item.id, 100);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const state = serviceState(item.state ?? item.status);
    const service: ConnectorService = { id, title: str(item.title, 100) ?? str(item.name, 100) ?? titleFor(id), state };
    const message = str(item.message) ?? str(item.error) ?? str(item.lastError);
    if (message) service.message = message;
    const url = connectUrlFor(item.connectUrl ?? item.connect_url ?? item.connectURL, base);
    if (url) service.connectUrl = url;
    else if (state !== 'connected' && state !== 'disabled') service.connectUrl = `${base}/admin/connect/${encodeURIComponent(id)}`;
    out.services.push(service);
  }
  return out;
}

// The gateway's base URL from its MCP URL (https://host:8443/mcp). Only
// https, or plain http to this Mac (a test's fake gateway): its MCP calls
// carry the gateway's token (secure-url.ts).
export function gatewayBase(url: string): string | undefined {
  if (credentialUrlProblem(url)) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
}

// Where the gateway is: runner.json's `connectors.url` when set (an empty
// one, or enabled: false, turns it off), else the `connectors` MCP server
// in the main Claude login's ~/.claude.json, which install-clients.sh
// writes. Only that one field is read from it.
export function findGateway(json: { url?: unknown; enabled?: unknown } | undefined, claudeJsonPath: string): string | undefined {
  const found = gatewayUrlFrom(json, claudeJsonPath);
  return found ? gatewayBase(found.url) : undefined;
}

// The gateway URL as configured, unchecked, and where it came from (for
// saying why one is refused, config.ts).
export function gatewayUrlFrom(json: { url?: unknown; enabled?: unknown } | undefined, claudeJsonPath: string): { url: string; from: string } | undefined {
  if (json?.enabled === false) return undefined;
  if (typeof json?.url === 'string') return json.url.trim() ? { url: json.url.trim(), from: 'connectors.url in runner.json' } : undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as { mcpServers?: Record<string, { url?: unknown }> };
    const url = parsed?.mcpServers?.connectors?.url;
    return typeof url === 'string' && url.trim() ? { url: url.trim(), from: `the connectors MCP server in ${claudeJsonPath}` } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- monitor

type Timer = { cancel(): void };

export type ConnectorsMonitorOptions = {
  url?: string; // the base; none means off
  offReason?: string; // why it's off when a URL was refused (config.ts connectorsRefused)
  fetch?: typeof fetch;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  onChange?: (s: ConnectorsStatus) => void;
  log?: { info(msg: string, data?: Record<string, unknown>): void };
};

// Asks /health every POLL_MS and on demand, one ask at a time, and says
// when what the panel would show changes.
export class ConnectorsMonitor {
  private current: ConnectorsStatus;
  private inFlight?: Promise<ConnectorsStatus>;
  private lastAt = 0;
  private timer?: Timer;
  private stopped = false;
  private lastKey = '';

  private readonly opts: ConnectorsMonitorOptions;

  constructor(opts: ConnectorsMonitorOptions) {
    this.opts = opts;
    this.current = opts.url ? { state: 'checking', url: opts.url, services: [] } : { state: 'off', ...(opts.offReason ? { error: opts.offReason } : {}), services: [] };
  }

  status(): ConnectorsStatus {
    return this.current;
  }

  start(): void {
    if (!this.opts.url) return;
    this.stopped = false;
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  // A fresh answer, unless one came within FRESH_MS (or `force`).
  refresh(force = false): Promise<ConnectorsStatus> {
    if (!this.opts.url) return Promise.resolve(this.current);
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!force && this.lastAt && now - this.lastAt < FRESH_MS) return Promise.resolve(this.current);
    this.inFlight = this.ask().finally(() => {
      this.inFlight = undefined;
      this.schedule();
    });
    return this.inFlight;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private schedule(): void {
    this.timer?.cancel();
    if (this.stopped || !this.opts.url) return;
    const set =
      this.opts.setTimeout ??
      ((fn: () => void, ms: number): Timer => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      });
    this.timer = set(() => void this.refresh(true), POLL_MS);
  }

  private async ask(): Promise<ConnectorsStatus> {
    const base = this.opts.url!;
    const doFetch = this.opts.fetch ?? fetch;
    let next: ConnectorsStatus;
    try {
      // No redirects: what /health says becomes sign-in links in front of
      // Mike, so it has to come from the gateway itself.
      const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' }, redirect: 'error' });
      if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error("the gateway's answer wasn't JSON");
      }
      next = { state: 'ok', url: base, ...parseHealth(body, base), checkedAt: new Date(this.now()).toISOString() };
    } catch (e) {
      next = { state: 'unreachable', url: base, error: plainError(e), services: [], checkedAt: new Date(this.now()).toISOString() };
    }
    this.lastAt = this.now();
    this.set(next);
    return next;
  }

  private set(next: ConnectorsStatus): void {
    // checkedAt alone moving isn't news.
    const { checkedAt: _, ...rest } = next;
    const key = JSON.stringify(rest);
    this.current = next;
    if (key === this.lastKey) return;
    if (this.lastKey) this.opts.log?.info('connectors changed', { state: next.state, signedOut: next.services.filter((s) => s.state === 'signed_out').map((s) => s.id) });
    this.lastKey = key;
    this.opts.onChange?.(next);
  }
}

// Why a fetch failed, in a few words.
function plainError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `no answer in ${TIMEOUT_MS / 1000} seconds`;
  const code = err?.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "couldn't find it (is Tailscale on?)";
  if (code === 'ECONNREFUSED') return 'it refused the connection (is the gateway running?)';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'no route to it (is Tailscale on?)';
  return (err?.message ?? String(e)).slice(0, 200);
}

// ------------------------------------------------------- sign-in problems

export type SignInProblem = {
  service: string; // as Mike would name it: "Notion", "Gmail"
  source: 'gateway' | 'claude.ai';
  url?: string; // where to sign it in
};

// claude.ai's per-login connectors are signed in on claude.ai.
export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

// claude.ai's auth error, at the start of a failed call's result: MCP
// server "claude.ai Gmail" needs you to sign in again
const CLAUDE_AI = /^(?:error:\s*)?MCP server ["“]([^"”\n]{1,80})["”] needs you to (?:sign|log) in again/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g;

// The gateway's MCP server, as install-clients.sh names it (findGateway
// reads the same entry): its tools are mcp__connectors__<service>__<tool>,
// and its own are mcp__connectors__connectors__<tool> (status, approvals).
export const GATEWAY_TOOL_PREFIX = 'mcp__connectors__';

// What a tool result says about signing in, from where it came from and
// whether it failed, never from what it says: what a connector reads (an
// email, a Notion page) is anyone's words, and this becomes a sign-in ask
// in front of Mike. Daybreak's verify-fix (5 Nov) found an email saying
// "Gmail needs signing in again" still raised one, with the link stripped.
//
// - claude.ai's servers: only a failed call whose result starts with the
//   CLI's auth error for that very server.
// - The gateway's: a call to a service's `__sign_in` stub (the one tool a
//   signed-out service lists), or any failed call to one of its tools.
//   That only names candidates (`ids`: the tool's prefix, and the service
//   in any `/admin/connect/<id>` link, as a prefix can differ from the id,
//   cf for cloudflare; naming one can't make an ask). The gateway's own
//   /health, which the runner asks itself, has to say that service is
//   signed out (turnSignIns), and its title and connect page are what the
//   ask uses. No gateway set up, or no answer from it: no ask.
export type SignInSignal = { source: 'claude.ai'; problem: SignInProblem } | { source: 'gateway'; ids: string[] };

export function signInSignal(toolName: string, ok: boolean, text: string, gateway?: string): SignInSignal | undefined {
  if (!toolName.startsWith('mcp__') || toolName.startsWith('mcp__threadbear__')) return undefined;
  if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) {
    const origin = gateway ? gatewayBase(gateway) : undefined;
    const [prefix, ...rest] = toolName.slice(GATEWAY_TOOL_PREFIX.length).split('__');
    if (!origin || !prefix || !rest.length || prefix === 'connectors') return undefined;
    if (rest.join('__') !== 'sign_in' && ok) return undefined;
    const ids = new Set([prefix]);
    for (const raw of text.slice(0, 4000).match(URL_IN_TEXT) ?? []) {
      try {
        const u = new URL(raw.replace(/[.,;:]+$/, ''));
        const m = /^\/admin\/connect\/([^/]+)$/.exec(u.pathname);
        if (m) ids.add(decodeURIComponent(m[1]));
      } catch {
        // not a link
      }
    }
    return { source: 'gateway', ids: [...ids] };
  }
  if (ok) return undefined;
  const ai = CLAUDE_AI.exec(text.trimStart());
  if (!ai) return undefined;
  // "claude.ai Gmail" is the server mcp__claude_ai_Gmail__*.
  const server = 'mcp__' + ai[1].trim().replace(/[^A-Za-z0-9_-]/g, '_') + '__';
  if (!toolName.startsWith(server)) return undefined;
  return { source: 'claude.ai', problem: { service: ai[1].replace(/^claude\.ai\s+/i, '').trim(), source: 'claude.ai', url: CLAUDE_AI_CONNECTORS_URL } };
}

// The sign-in problems in the current turn's events (oldest first, from
// its turn.started on), one per service. `gateway`: the gateway's base;
// `health`: its /health services, asked fresh, or undefined when it can't
// be reached. Only asked when a gateway tool gave a signal.
export async function turnSignIns(
  events: PersistedEvent[],
  gateway?: string,
  health?: () => Promise<ConnectorService[] | undefined>,
): Promise<SignInProblem[]> {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  const names = new Map<string, string>();
  const out = new Map<string, SignInProblem>();
  const candidates: string[][] = [];
  for (const e of events.slice(start)) {
    if (e.type === 'tool.call') names.set(e.itemId, e.name);
    else if (e.type === 'tool.result') {
      const signal = signInSignal(names.get(e.itemId) ?? '', e.ok, e.text ?? '', gateway);
      if (signal?.source === 'claude.ai' && !out.has(signal.problem.service.toLowerCase())) out.set(signal.problem.service.toLowerCase(), signal.problem);
      else if (signal?.source === 'gateway') candidates.push(signal.ids);
    }
  }
  const services = candidates.length && health ? await health().catch(() => undefined) : undefined;
  for (const ids of candidates) {
    const s = services?.find((x) => ids.includes(x.id) && x.state === 'signed_out');
    if (s && !out.has(s.title.toLowerCase())) out.set(s.title.toLowerCase(), { service: s.title, source: 'gateway', ...(s.connectUrl ? { url: s.connectUrl } : {}) });
  }
  return [...out.values()];
}

// How end_turn's one nudge per turn starts, so it can tell it already
// gave it.
export const SIGN_IN_NUDGE = 'Not ended yet: this turn ran into';

type AskLike = { action?: string; why?: string; links?: { url?: string }[] };

// The problems an end_turn's asks don't already cover: an ask linking the
// sign-in page, or naming the service, covers it.
export function uncovered(problems: SignInProblem[], asks: AskLike[] | undefined): SignInProblem[] {
  return problems.filter((p) => {
    const name = p.service.toLowerCase();
    return !(asks ?? []).some((a) => {
      if (p.url && a.links?.some((l) => l.url === p.url)) return true;
      return `${a.action ?? ''} ${a.why ?? ''}`.toLowerCase().includes(name);
    });
  });
}

// The nudge: what needs signing in and where, and what to do about it.
export function signInNudge(problems: SignInProblem[]): string {
  const lines = problems.map((p) => {
    const where = p.source === 'claude.ai' ? `on claude.ai, for this thread's login: ${p.url}` : p.url ? `in the Connectors gateway: ${p.url}` : "in the Connectors gateway (Threadbear's Connectors panel has the button)";
    return `- ${p.service} needs signing in again, ${where}`;
  });
  return (
    `${SIGN_IN_NUDGE} a service that needs the user to sign in again:\n${lines.join('\n')}\n` +
    'If the work needs it, give the user an ask for it in end_turn (needs "you"), with that page as a link titled like "Sign in to <service>", and say what you\'ll do once they have. ' +
    "If it didn't matter, call end_turn again as you were: this note comes once a turn."
  );
}

// Whether this turn already had the nudge (an end_turn result that starts
// with it).
export function nudgedThisTurn(events: PersistedEvent[]): boolean {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn.started') {
      start = i + 1;
      break;
    }
  }
  return events.slice(start).some((e) => e.type === 'tool.result' && typeof e.text === 'string' && e.text.startsWith(SIGN_IN_NUDGE));
}

// ------------------------------------------------------------------ RPC

// connectors.status: what the panel shows. { refresh: true } asks /health
// first (the panel opening, or Check now), unless it did within FRESH_MS.
export function connectorsMethods(m: Pick<ConnectorsMonitor, 'status' | 'refresh'>): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'connectors.status': (p) => (p.refresh === true ? m.refresh().then((connectors) => ({ connectors })) : { connectors: m.status() }),
  };
}
