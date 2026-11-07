// A thread as the Mac and the iPhone show it once its turns are over: the
// message that started a turn, one "Worked for 2m 13s" line holding the
// work, then the reply. A port of the iPhone's Turns.fold
// (ios/ThreadbearKit/Sources/ThreadbearKit/Turns.swift); keep the two
// picking the same reply. Tests: node --test web/src/turns.test.ts
import type { MessageButton } from './reply-buttons';

export type TurnMessage = {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  origin?: string;
  toolKind?: string;
  summary?: boolean;
  turn?: string;
  // The reply buttons its text links (API 59, reply-buttons.ts).
  buttons?: MessageButton[];
  at: string;
};

export type Item<M extends TurnMessage = TurnMessage> =
  | { kind: 'message'; m: M }
  | { kind: 'tools'; items: M[] }
  | { kind: 'worked'; items: Item<M>[]; ms?: number; key: number };

// Tool calls between two messages go together as one run.
export function group<M extends TurnMessage>(messages: M[]): Item<M>[] {
  const out: Item<M>[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (m.role === 'tool') {
      if (last?.kind === 'tools') last.items.push(m);
      else out.push({ kind: 'tools', items: [m] });
    } else out.push({ kind: 'message', m });
  }
  return out;
}

// A turn starts at a message from Mike, the phone, a schedule or another
// agent; one the runner sent (a restart, a resume) joins the turn before it.
export function startsTurn(m: TurnMessage): boolean {
  return m.role === 'user' && m.origin !== 'runner';
}

export function fold<M extends TurnMessage>(messages: M[], busy: boolean): Item<M>[] {
  const turns: M[][] = [[]];
  for (const m of messages) {
    if (startsTurn(m) && turns.at(-1)!.length) turns.push([]);
    turns.at(-1)!.push(m);
  }
  const out: Item<M>[] = [];
  turns.forEach((turn, i) => {
    if (!turn.length) return;
    const starter = startsTurn(turn[0]!) ? turn[0]! : undefined;
    const body = starter ? turn.slice(1) : turn;
    if (starter) out.push({ kind: 'message', m: starter });
    // The turn still going shows its work as it comes.
    if (busy && i === turns.length - 1) {
      out.push(...group(body));
      return;
    }
    const reply = replies(body);
    if (!reply.length) {
      out.push(...group(body));
      return;
    }
    const keep = new Set(reply);
    const folded = body.filter((_, j) => !keep.has(j));
    // Nothing to fold (a quick answer, no tools): just the reply.
    if (folded.some((m) => m.role === 'tool' || m.role === 'assistant')) {
      const end = Date.parse(body[Math.max(...reply)]!.at);
      const ms = starter ? end - Date.parse(starter.at) : undefined;
      out.push({ kind: 'worked', items: group(folded), ms, key: folded[0]!.seq });
    } else out.push(...group(folded));
    for (const j of [...reply].sort((a, b) => a - b)) out.push({ kind: 'message', m: body[j]! });
  });
  return out;
}

// Which of a finished stretch's messages are its replies, as the Mac picks
// them: each turn has its own, so one the runner or the CLI started doesn't
// fold away the answer before it, unless a summary covers them. A summary
// from a wake-up doesn't.
export function replies(body: TurnMessage[]): number[] {
  const turns: [number, number][] = [];
  let start = 0;
  for (let i = 1; i < body.length; i++) {
    const newTurn = body[i]!.turn !== undefined && body[i]!.turn !== body[i - 1]!.turn;
    if (body[i]!.role === 'user' || newTurn) {
      turns.push([start, i]);
      start = i;
    }
  }
  if (body.length) turns.push([start, body.length]);
  let covers = -1;
  turns.forEach(([a, b], k) => {
    const wakeUp = a > 0 && body[a]!.role !== 'user';
    if (!wakeUp && body.slice(a, b).some((m) => m.role === 'assistant' && m.summary)) covers = k;
  });
  return turns.slice(Math.max(0, covers)).flatMap(([a, b]) => replyIndexes(body.slice(a, b)).map((j) => j + a));
}

// A finished turn's reply: the messages after its last step (and before
// the summary) when they say more than the summary's bullets; else the
// bullets; else the last thing the agent wrote.
export function replyIndexes(body: TurnMessage[]): number[] {
  const summary = lastIndex(body, (m) => m.role === 'assistant' && !!m.summary);
  const lastStep = lastIndex(body, isStep);
  if (summary >= 0 && lastStep < summary) {
    const words: number[] = [];
    for (let j = lastStep + 1; j < summary; j++) if (body[j]!.role === 'assistant' && !body[j]!.summary) words.push(j);
    const length = words.reduce((n, j) => n + body[j]!.text.length, 0);
    return length > body[summary]!.text.length ? words : [summary];
  }
  const last = lastIndex(body, (m) => m.role === 'assistant');
  return last >= 0 ? [last] : [];
}

// A step of work: a tool call outside Threadbear's own tools and
// ToolSearch, or a message sent into the turn.
function isStep(m: TurnMessage): boolean {
  if (m.role === 'user') return true;
  if (m.role === 'assistant') return false;
  return !(m.text.startsWith('threadbear: ') || m.text.startsWith('Find tools: '));
}

function lastIndex<T>(xs: T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i;
  return -1;
}

// "Worked for 2m 13s", as the Mac says it.
export function workedTitle(ms?: number): string {
  if (ms === undefined || ms < 1000) return 'Worked';
  return `Worked for ${duration(ms)}`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 3600)}h ${m}m`;
}

// To the minute, for the shared page's byline: "18m", "1h 5m".
export function roughly(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The turns of a thread, for the shared page's outline: each starts at a
// message that starts a turn, and runs to the next. Time worked is from
// that message to the last one before the next turn.
export type Turn<M extends TurnMessage = TurnMessage> = { starter?: M; messages: M[]; ms?: number };

export function splitTurns<M extends TurnMessage>(messages: M[]): Turn<M>[] {
  const out: Turn<M>[] = [];
  for (const m of messages) {
    if (startsTurn(m) || !out.length) out.push({ starter: startsTurn(m) ? m : undefined, messages: [] });
    out.at(-1)!.messages.push(m);
  }
  for (const t of out) {
    // To the last thing said, as fold times a turn to its reply, not to a
    // tool line after it (end_turn).
    const last = [...t.messages].reverse().find((m) => m.role !== 'tool');
    if (t.starter && last && last !== t.starter) t.ms = Date.parse(last.at) - Date.parse(t.starter.at);
  }
  return out;
}
