// Other runners' threads read and steered through the backend (API 44,
// docs/protocol.md "Other runners' threads through the backend"): the main
// Mac's runner reads another runner's thread from its messages and threads
// rows, and asks that runner to act on it with a `commands` row, as the
// phone does. The Mac app talks only to its own runner; runners never talk
// to each other. All owner only (runnerAccess.ts ACCESS): a runner key
// can't read another runner's threads or queue work for it.
//
// Read rules (docs/full-convex.md): the live tail is a few rows, older pages
// are read once and kept on the runner, a thread's row is one document, and
// a command's state is one get by id.
import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { checkRunnerId, forbidden, runnerAuth } from './lib';
import { docBytes } from './runnerAccess';

// The live tail: enough for a message or two of tool rows between texts.
export const TAIL_MAX = 15;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
// What a queued command's args may be at most. A send's text is the longest.
const ARGS_MAX_BYTES = 64 * 1024;

const relayRow = v.object({
  seq: v.number(),
  role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool')),
  text: v.string(),
  origin: v.optional(v.string()),
  toolKind: v.optional(v.string()),
  summary: v.optional(v.boolean()),
  turn: v.optional(v.string()),
  wokeBy: v.optional(v.array(v.object({ kind: v.string(), description: v.string() }))),
  at: v.string(),
});

type Row = { seq: number; role: 'user' | 'assistant' | 'tool'; text: string; origin?: string; toolKind?: string; summary?: boolean; turn?: string; wokeBy?: { kind: string; description: string }[]; at: string };
function toRow(m: Row): Row {
  return {
    seq: m.seq,
    role: m.role,
    text: m.text,
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.toolKind ? { toolKind: m.toolKind } : {}),
    ...(m.summary ? { summary: true } : {}),
    ...(m.turn ? { turn: m.turn } : {}),
    ...(m.wokeBy ? { wokeBy: m.wokeBy } : {}),
    at: m.at,
  };
}

/** The newest rows of a thread, oldest first: the live tail. */
export const remoteTail = query({
  args: { key: v.string(), threadId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ messages: v.array(relayRow), hasMore: v.boolean() }),
  handler: async (ctx, { key, threadId, limit }) => {
    await runnerAuth(ctx, key, 'remoteTail');
    const want = Math.max(1, Math.min(TAIL_MAX, Math.floor(limit ?? TAIL_MAX)));
    const rows = await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).order('desc').take(want + 1);
    return { messages: rows.slice(0, want).reverse().map(toRow), hasMore: rows.length > want };
  },
});

/**
 * A page of a thread's rows, read once: the `limit` before `beforeSeq`, or
 * after `afterSeq` (filling what a tail skipped), or the newest. Oldest first.
 */
export const remoteMessages = query({
  args: { key: v.string(), threadId: v.string(), beforeSeq: v.optional(v.number()), afterSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ messages: v.array(relayRow), hasMore: v.boolean() }),
  handler: async (ctx, { key, threadId, beforeSeq, afterSeq, limit }) => {
    await runnerAuth(ctx, key, 'remoteMessages');
    const want = Math.max(1, Math.min(PAGE_MAX, Math.floor(limit ?? PAGE_DEFAULT)));
    if (afterSeq !== undefined) {
      const rows = await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).gt('seq', afterSeq)).order('asc').take(want + 1);
      return { messages: rows.slice(0, want).map(toRow), hasMore: rows.length > want };
    }
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_thread_seq', (q) => (beforeSeq === undefined ? q.eq('threadId', threadId) : q.eq('threadId', threadId).lt('seq', beforeSeq)))
      .order('desc')
      .take(want + 1);
    return { messages: rows.slice(0, want).reverse().map(toRow), hasMore: rows.length > want };
  },
});

/** One thread's row (its state, open approval and card), live while it's open. Null once it's gone. */
export const remoteThread = query({
  args: { key: v.string(), threadId: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { key, threadId }) => {
    await runnerAuth(ctx, key, 'remoteThread');
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!t) return null;
    // The secret card's key stays: the runner seals an answer to it, as the phone does.
    const { _id, _creationTime, pushedAt: _p, pushHeldAt: _h, ...rest } = t;
    return rest;
  },
});

// What a command from the main Mac may carry, kind by kind: only what that
// runner's apply() reads, so nothing else is stored. Each gets `from: "mac"`,
// so a message it sends isn't marked as the phone's (phone.ts never sets it).
const KINDS = ['send', 'respond', 'update', 'create', 'interrupt', 'call', 'share'] as const;
type Kind = (typeof KINDS)[number];
// Methods a `call` may run on the other runner, and nothing else: answers
// with no file contents or tool output in them (step 4 brings those, scrubbed).
export const CALLS = new Set(['files.list']);

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}
function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function commandArgs(kind: Kind, raw: unknown): Record<string, unknown> {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bad = (why: string) => new ConvexError({ kind: 'badArgs', message: why });
  let out: Record<string, unknown>;
  switch (kind) {
    case 'send':
      if (str(a.text) === undefined) throw bad('a send needs text');
      out = pick(a, ['text', 'answers']);
      break;
    case 'respond':
      if (!str(a.approvalId) || !['allow', 'allowAlways', 'deny', 'answered'].includes(String(a.decision))) throw bad('a respond needs approvalId and decision');
      // A secret's answer only ever goes sealed to that runner's key.
      if (a.secret === true && a.decision === 'answered' && !a.sealed) throw bad('a secret goes sealed');
      out = pick(a, ['approvalId', 'decision', 'message', 'answers', 'secret', 'sealed']);
      break;
    case 'update':
      out = pick(a, ['snooze', 'wake', 'archive', 'unarchive', 'markSeen', 'title', 'star']);
      if (Object.keys(out).length !== 1) throw bad('an update changes one thing');
      // How it went, with an archive (API 42), as phone:update takes it.
      if (out.archive === true && ['worked', 'didntWork', 'notNeeded'].includes(String(a.verdict))) out.verdict = a.verdict;
      break;
    case 'create':
      // A picture alone is enough, as from the phone.
      if (str(a.text) === undefined || (!str(a.text)!.trim() && !(Array.isArray(a.images) && a.images.length))) throw bad('a new thread needs text');
      out = pick(a, ['text', 'cwd', 'accountId', 'model', 'effort']);
      // "Ask before edits" from the composer: left out, the thread gets full access.
      if (a.permissionMode === 'ask' || a.permissionMode === 'full' || a.permissionMode === 'auto') out.permissionMode = a.permissionMode;
      break;
    case 'interrupt':
      out = {};
      break;
    case 'call':
      if (!CALLS.has(String(a.method))) throw bad(`only ${[...CALLS].join(', ')} can be asked of another runner`);
      // Only what the one allowed call reads: anything else in here would sit in
      // the row, under field names scrubbing skips.
      out = { method: a.method, params: typeof (a.params as { path?: unknown } | undefined)?.path === 'string' ? { path: (a.params as { path: string }).path } : {} };
      break;
    case 'share':
      if (a.access !== 'off' && a.access !== 'link') throw bad('access is "off" or "link"');
      out = pick(a, ['access', 'newLink']);
      break;
  }
  if (docBytes(out) > ARGS_MAX_BYTES) throw bad('too long');
  return out;
}

/**
 * Asks another runner to act on one of its threads (or, for a create or a
 * call, on itself). A thread's command goes to the runner the backend says
 * has the thread, never one the caller names, so it can't be aimed at a
 * runner that would take it for one of its own.
 */
export const queueCommand = mutation({
  args: { key: v.string(), runnerId: v.string(), threadId: v.optional(v.string()), kind: v.union(...KINDS.map((k) => v.literal(k))), args: v.any() },
  returns: v.id('commands'),
  handler: async (ctx, { key, runnerId, threadId, kind, args }) => {
    await runnerAuth(ctx, key, 'queueCommand');
    checkRunnerId(runnerId);
    const runner = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
    if (!runner) throw new ConvexError({ kind: 'notFound', message: 'no such runner' });
    if (threadId !== undefined) {
      const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
      if (!t) throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
      if (t.runnerId !== runnerId) throw forbidden("queue that: the thread isn't that runner's");
    } else if (kind !== 'create' && kind !== 'call') {
      throw new ConvexError({ kind: 'badArgs', message: `a ${kind} needs a thread` });
    }
    const out = commandArgs(kind, args);
    // Pictures pasted on the Mac, put in file storage with imageUploadUrl:
    // carried as the phone's photos are (phone.ts commandImages), and
    // deleted by sync:finishCommand once that runner has its copy.
    if (kind === 'send' || kind === 'create') Object.assign(out, await relayImages(ctx, (args as { images?: unknown } | undefined)?.images));
    return ctx.db.insert('commands', { runnerId, ...(threadId !== undefined ? { threadId } : {}), kind, args: { ...out, from: 'mac' }, state: 'pending', createdAt: Date.now() });
  },
});

// At most what the phone may send in one message.
export const MAX_RELAY_IMAGES = 6;

// Storage ids from the main Mac as `{ storageId, url }`, the URL worked out
// here so a command never names an address of the caller's choosing.
async function relayImages(ctx: { storage: { getUrl(id: Id<'_storage'>): Promise<string | null> } }, raw: unknown): Promise<{ images?: { storageId: string; url: string }[] }> {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) throw new ConvexError({ kind: 'badArgs', message: 'images are storage ids' });
  if (!raw.length) return {};
  if (raw.length > MAX_RELAY_IMAGES) throw new ConvexError({ kind: 'badArgs', message: `at most ${MAX_RELAY_IMAGES} pictures` });
  const images = [];
  for (const storageId of raw as string[]) {
    let url: string | null = null;
    try {
      url = await ctx.storage.getUrl(storageId as Id<'_storage'>);
    } catch {
      url = null;
    }
    if (!url) throw new ConvexError({ kind: 'notFound', message: 'that picture has gone' });
    images.push({ storageId, url });
  }
  return { images };
}

/** Where the main Mac POSTs a picture for another runner's thread, before queueCommand names it. */
export const imageUploadUrl = mutation({
  args: { key: v.string() },
  returns: v.string(),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'imageUploadUrl');
    return ctx.storage.generateUploadUrl();
  },
});

/** Where a command the main Mac queued has got to, one get by id: watched until it's done or failed. */
export const commandState = query({
  args: { key: v.string(), commandId: v.id('commands') },
  returns: v.union(
    v.null(),
    v.object({ state: v.union(v.literal('pending'), v.literal('taken'), v.literal('done'), v.literal('failed')), note: v.optional(v.string()), threadId: v.optional(v.string()), result: v.optional(v.any()) }),
  ),
  handler: async (ctx, { key, commandId }) => {
    await runnerAuth(ctx, key, 'commandState');
    const c = await ctx.db.get(commandId);
    if (!c) return null;
    let result: unknown;
    try {
      result = c.result !== undefined ? JSON.parse(c.result) : undefined;
    } catch {
      result = undefined;
    }
    return { state: c.state, ...(c.note ? { note: c.note } : {}), ...(c.resultThreadId ? { threadId: c.resultThreadId } : {}), ...(result !== undefined ? { result } : {}) };
  },
});

/** Another runner's logins, with their models, for the new-thread pickers on the main Mac. */
export const remoteAccounts = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'remoteAccounts');
    const out = [];
    for (const a of await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(50)) {
      const { _id, _creationTime, usage: _u, ...rest } = a;
      out.push(rest);
    }
    return out;
  },
});
