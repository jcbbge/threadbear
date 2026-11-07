// Full sync's bodies (docs/full-convex.md step 4; `sync.full` in runner.json, off
// by default). A tool's output, input and diffs go to the backend when it
// finishes, one row under the seq of its one-line `messages` row, so whoever opens
// that row can fetch all of it once. Never a delta, and only from when it's on.
//
// The local copy of a thread is never changed: this only decides what goes up, and
// `prepareBody` is the one place it's scrubbed and made to fit.
import type { Hunk, PersistedEvent } from './protocol.ts';
import { scrubEveryString } from './redaction.ts';
import { outputOfJob, withholdPath, withholdReason } from './withhold.ts';
import { safeEnd } from './safe-cut.ts';

// The most of each that goes up. Larger than almost anything real: on 5 Nov the
// biggest input in 120 threads was 18 KB, and a result is already cut at 64 KB.
export const BODY_TEXT_BYTES = 96 * 1024;
export const BODY_INPUT_BYTES = 48 * 1024;
export const BODY_DIFFS_BYTES = 64 * 1024;
export const BODY_REASONING_BYTES = 32 * 1024;
const INPUT_STRING_BYTES = 8 * 1024;
// Reasoning held in memory for a thread until a tool or message takes it.
const REASONING_HELD_CHARS = 64 * 1024;
// Tools a thread can have running at once before the oldest stops being followed.
const OPEN_PER_THREAD = 200;
// What's held of a tool until it goes up: twice what can go, as scrubbing can shorten
// it. Past that the end won't fit anyway.
const RAW_TEXT_CHARS = BODY_TEXT_BYTES * 2;
const RAW_DIFF_CHARS = BODY_DIFFS_BYTES * 2;

export type RawBody = {
  threadId: string;
  seq: number;
  // A catch-up has to read from here to make this body again: not sent.
  from?: number;
  withheld?: true;
  reason?: string;
  text?: string;
  ok?: boolean;
  truncated?: boolean;
  input?: Record<string, unknown>;
  diffs?: { path: string; hunks: Hunk[] }[];
  reasoning?: string;
  images?: number;
};

// As the backend's sync:appendBodies takes it: scrubbed, cut to fit, input and
// diffs as JSON text.
export type BodyDoc = {
  threadId: string;
  seq: number;
  withheld?: true;
  reason?: string;
  text?: string;
  ok?: boolean;
  truncated?: boolean;
  input?: string;
  diffs?: string;
  reasoning?: string;
  images?: number;
  cut?: true;
};

type Open = {
  seq: number;
  from: number;
  input: Record<string, unknown>;
  withheld?: string;
  diffs: Map<string, Hunk[]>;
  diffChars: number;
  reasoning?: string;
  // Its turn ended with it still going: what's known went up, and a late answer
  // (a background command) goes up over that. Nothing to read again for it.
  sentEarly?: boolean;
};
type ThreadState = {
  open: Map<string, Open>;
  reasoning?: { seq: number; text: string };
  last: number;
  // Background jobs this runner watched start, from a command that could go up. What
  // a later tool reads of any other job could be anything: it stays on the runner.
  safeJobs: Set<string>;
};
const SAFE_JOBS = 500;

export function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// At most `max` bytes, on a character's edge.
export function cutUtf8(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  // A character cut in half decodes to U+FFFD.
  if (out.endsWith('�')) out = out.slice(0, -1);
  return out;
}

function shortenStrings(v: unknown): unknown {
  if (typeof v === 'string') return bytes(v) > INPUT_STRING_BYTES ? `${cutUtf8(v, INPUT_STRING_BYTES)}\n[cut: the rest is on the runner]` : v;
  if (Array.isArray(v)) return v.map(shortenStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortenStrings(x)]));
  return v;
}

const CUT_NOTE = '\n\n[cut: the rest is on the runner]';

/**
 * What goes up for a body: scrubbed first and only then cut, so a value can't be
 * split in two and each half missed. `scrub` may throw: the caller holds that
 * body back whole rather than send anything of it.
 */
export function prepareBody(raw: RawBody, scrub: (text: string) => string): BodyDoc {
  const { threadId, seq } = raw;
  if (raw.withheld) return { threadId, seq, withheld: true, ...(raw.reason ? { reason: raw.reason } : {}) };
  const doc: BodyDoc = { threadId, seq };
  let cut = false;
  if (raw.text !== undefined) {
    const clean = scrub(raw.text);
    const short = cutUtf8(clean, BODY_TEXT_BYTES);
    doc.text = short === clean ? clean : short + CUT_NOTE;
    if (short !== clean) cut = true;
  }
  if (raw.ok !== undefined) doc.ok = raw.ok;
  if (raw.truncated) doc.truncated = true;
  if (raw.input && Object.keys(raw.input).length) {
    const clean = scrubEveryString(raw.input, scrub);
    let json = JSON.stringify(clean);
    if (bytes(json) > BODY_INPUT_BYTES) {
      json = JSON.stringify(shortenStrings(clean));
      cut = true;
      if (bytes(json) > BODY_INPUT_BYTES) json = JSON.stringify({ note: "The input was too long. It's kept on the runner." });
    }
    doc.input = json;
  }
  if (raw.diffs?.length) {
    const clean = scrubEveryString(raw.diffs, scrub) as { path: string; hunks: Hunk[] }[];
    let json = JSON.stringify(clean);
    if (bytes(json) > BODY_DIFFS_BYTES) {
      // Which files, without what changed in them.
      json = JSON.stringify(clean.map((d) => ({ path: d.path, hunks: [] })));
      cut = true;
    }
    // Very many of them: nothing, as the note says it's on the runner.
    if (bytes(json) <= BODY_DIFFS_BYTES) doc.diffs = json;
  }
  if (raw.reasoning) {
    const clean = scrub(raw.reasoning);
    const short = cutUtf8(clean, BODY_REASONING_BYTES);
    doc.reasoning = short;
    if (short !== clean) cut = true;
  }
  if (raw.images) doc.images = raw.images;
  if (cut) doc.cut = true;
  return doc;
}

/** Follows a runner's events and says what's finished. Pure, so a catch-up after a restart goes the same way as the live stream. */
export class BodyCollector {
  private threads = new Map<string, ThreadState>();

  private state(threadId: string): ThreadState {
    let t = this.threads.get(threadId);
    if (!t) {
      t = { open: new Map(), last: 0, safeJobs: new Set() };
      this.threads.set(threadId, t);
    }
    return t;
  }

  private takeReasoning(t: ThreadState): { seq: number; text: string } | undefined {
    const r = t.reasoning;
    t.reasoning = undefined;
    return r;
  }

  private finish(threadId: string, o: Open, result?: { text: string; ok: boolean; truncated: boolean; images: number }): RawBody {
    // Withheld whatever it printed: its command or file can hold secrets. Nothing
    // of it goes up, its input included, and there's no way to ask for it.
    if (o.withheld) return { threadId, seq: o.seq, from: o.from, withheld: true, reason: o.withheld };
    return {
      threadId,
      seq: o.seq,
      from: o.from,
      ...(result ? { text: result.text, ok: result.ok, ...(result.truncated ? { truncated: true } : {}), ...(result.images ? { images: result.images } : {}) } : {}),
      input: o.input,
      ...(o.diffs.size ? { diffs: [...o.diffs].map(([path, hunks]) => ({ path, hunks })) } : {}),
      ...(o.reasoning ? { reasoning: o.reasoning } : {}),
    };
  }

  /** The bodies this event finishes. Each event once: one it's seen is nothing. */
  see(threadId: string, e: PersistedEvent): RawBody[] {
    const t = this.state(threadId);
    if (e.seq <= t.last) return [];
    t.last = e.seq;
    switch (e.type) {
      case 'reasoning': {
        if (!e.text) return [];
        if (!t.reasoning) t.reasoning = { seq: e.seq, text: '' };
        if (t.reasoning.text.length < REASONING_HELD_CHARS) t.reasoning.text += (t.reasoning.text ? '\n\n' : '') + e.text.slice(0, safeEnd(e.text, REASONING_HELD_CHARS));
        return [];
      }
      case 'tool.call': {
        const reasoning = this.takeReasoning(t);
        // Stopping a job prints nothing of what it printed.
        const job = /stop|kill/i.test(e.name) ? undefined : outputOfJob(e.input);
        const withheld = withholdReason(e) ?? (job !== undefined && !t.safeJobs.has(job) ? 'output of an earlier command' : undefined);
        t.open.set(e.itemId, { seq: e.seq, from: reasoning?.seq ?? e.seq, input: e.input ?? {}, withheld, diffs: new Map(), diffChars: 0, ...(reasoning ? { reasoning: reasoning.text } : {}) });
        // A runaway thread can't hold memory for ever. That tool shows as kept on
        // the runner.
        if (t.open.size > OPEN_PER_THREAD) t.open.delete(t.open.keys().next().value!);
        return [];
      }
      case 'edit.diff': {
        const o = t.open.get(e.itemId);
        if (!o) return [];
        // The file it changed decides as well: a patch can name it only here, and
        // its diff can hold what the file did.
        const why = withholdPath(e.path);
        if (why) o.withheld = why;
        const chars = JSON.stringify(e.hunks).length;
        // Which file, without what changed, once it's more than can go.
        const fits = o.diffChars + chars <= RAW_DIFF_CHARS;
        if (fits) o.diffChars += chars;
        o.diffs.set(e.path, fits ? e.hunks : []);
        return [];
      }
      case 'tool.result': {
        const o = t.open.get(e.itemId);
        // From before this runner was following (forward only), so nothing can say
        // whether it's safe to send: it stays on the runner.
        if (!o) return [];
        t.open.delete(e.itemId);
        // A job started here that could go up: what's read of it later can too.
        if (!o.withheld && o.input.run_in_background === true) {
          const id = /\bID:?\s*["'`]?([\w-]+)/i.exec(e.text ?? '')?.[1];
          if (id) {
            if (t.safeJobs.size >= SAFE_JOBS) t.safeJobs.clear();
            t.safeJobs.add(id);
          }
        }
        return [this.finish(threadId, o, { text: (e.text ?? '').slice(0, safeEnd(e.text ?? '', RAW_TEXT_CHARS)), ok: e.ok !== false, truncated: e.truncated === true, images: e.images?.length ?? 0 })];
      }
      case 'assistant.text': {
        // What it thought just before saying this, with no tool to go with.
        const reasoning = this.takeReasoning(t);
        return reasoning ? [{ threadId, seq: e.seq, from: reasoning.seq, reasoning: reasoning.text }] : [];
      }
      case 'turn.completed': {
        // Tools with no answer yet (stopped, or still going in the background): what's
        // known of them, and they stay open in case an answer comes after all.
        const out: RawBody[] = [];
        for (const o of t.open.values()) {
          if (o.sentEarly) continue;
          o.sentEarly = true;
          out.push(this.finish(threadId, o));
        }
        const reasoning = this.takeReasoning(t);
        if (reasoning) out.push({ threadId, seq: reasoning.seq, from: reasoning.seq, reasoning: reasoning.text });
        return out;
      }
      default:
        return [];
    }
  }

  /** A catch-up starts here: nothing before this seq is still needed. */
  head(threadId: string): number | undefined {
    const t = this.threads.get(threadId);
    if (!t) return undefined;
    let low = t.last;
    for (const o of t.open.values()) if (!o.sentEarly) low = Math.min(low, o.from - 1);
    if (t.reasoning) low = Math.min(low, t.reasoning.seq - 1);
    return low;
  }

  /** Too far behind to read on: what it was waiting for stays on the runner, and it goes on from here. */
  abandon(threadId: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.open.clear();
    t.reasoning = undefined;
  }

  /** The newest seq seen, for telling that events were missed. */
  lastSeen(threadId: string): number | undefined {
    return this.threads.get(threadId)?.last;
  }

  /** Reading from here on, for a catch-up: forward only, so nothing earlier is looked at. */
  resume(threadId: string, head: number): void {
    const t = this.state(threadId);
    if (t.last < head) t.last = head;
  }

  threadIds(): string[] {
    return [...this.threads.keys()];
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
}
