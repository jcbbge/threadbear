// The phones registered for push (phone:registerDevice), as push.ts
// needs them, and the thread a push is about.
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { hasLiveToken } from './pushTargets';
import { runnerName } from './sync';
import { hasLiveKey } from './lib';
import { nextHealth } from './pushHealth';

// Only phones whose token is still good (pushTargets.ts): revoking deletes
// a phone's row (tokens.ts), but an expired token's phone, or an old row
// with no tokenId (from before 5 Nov 2026), is skipped here.
export const targets = internalQuery({
  args: {},
  returns: v.array(v.object({ apnsToken: v.string(), environment: v.union(v.literal('sandbox'), v.literal('production')), notify: v.union(v.literal('away'), v.literal('always'), v.literal('off')), pushKey: v.optional(v.string()) })),
  handler: async (ctx) => {
    const now = Date.now();
    const tokens = await ctx.db.query('tokens').collect();
    const out = [];
    for await (const d of ctx.db.query('devices')) {
      if (!hasLiveToken(d, tokens, now)) continue;
      out.push({ apnsToken: d.apnsToken, environment: d.environment, notify: d.notify ?? ('away' as const), ...(d.pushKey ? { pushKey: d.pushKey } : {}) });
    }
    return out;
  },
});

// Deletes the old rows with no tokenId, which get no pushes any more
// (pushTargets.ts); a paired phone has made itself a new one by starting
// up. Tidying only: npx convex run devices:dropUnlinked --prod
export const dropUnlinked = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let n = 0;
    for await (const d of ctx.db.query('devices')) {
      if (d.tokenId) continue;
      await ctx.db.delete(d._id);
      n++;
    }
    return n;
  },
});

export const relayInstall = internalQuery({
  args: { url: v.string() },
  returns: v.union(v.null(), v.object({ installId: v.string(), installKey: v.string() })),
  handler: async (ctx, { url }) => {
    const row = await ctx.db.query('relayInstall').first();
    return row && row.url === url ? { installId: row.installId, installKey: row.installKey } : null;
  },
});

// Replaces any earlier registration (a new relay URL, or one it forgot).
export const saveRelayInstall = internalMutation({
  args: { installId: v.string(), installKey: v.string(), url: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    for await (const row of ctx.db.query('relayInstall')) await ctx.db.delete(row._id);
    await ctx.db.insert('relayInstall', { ...a, createdAt: Date.now() });
    return null;
  },
});

// A registration with the relay starting (push.ts relayInstall). Clears
// any left from earlier ones that never finished.
export const startRelayCheck = internalMutation({
  args: { nonce: v.string() },
  returns: v.null(),
  handler: async (ctx, { nonce }) => {
    for await (const row of ctx.db.query('relayChecks')) if (Date.now() - row.createdAt > RELAY_CHECK_MS) await ctx.db.delete(row._id);
    await ctx.db.insert('relayChecks', { nonce, createdAt: Date.now() });
    return null;
  },
});

// The relay's check (http.ts /relay/verify): true once for a nonce this
// deployment made in the last few minutes, false for anything else.
export const takeRelayCheck = internalMutation({
  args: { nonce: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { nonce }) => {
    const row = await ctx.db
      .query('relayChecks')
      .withIndex('by_nonce', (q) => q.eq('nonce', nonce))
      .first();
    if (!row) return false;
    await ctx.db.delete(row._id);
    return Date.now() - row.createdAt <= RELAY_CHECK_MS;
  },
});

const RELAY_CHECK_MS = 5 * 60_000;

export const clearRelayInstall = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for await (const row of ctx.db.query('relayInstall')) await ctx.db.delete(row._id);
    return null;
  },
});

// After each send (push.ts sendAlert): whether any got through
// (pushHealth.ts), for the owner runner's heartbeat to report.
export const pushOutcome = internalMutation({
  args: { sent: v.number(), failed: v.number(), failure: v.optional(v.string()), via: v.union(v.literal('apple'), v.literal('relay')) },
  returns: v.null(),
  handler: async (ctx, o) => {
    if (o.sent <= 0 && o.failed <= 0) return null;
    const row = await ctx.db.query('pushHealth').first();
    // nextHealth builds a fresh row (sent or failed is above 0 here), so
    // the old row's _id never ends up in it.
    const next = nextHealth(row ?? {}, o, Date.now());
    if (row) await ctx.db.replace(row._id, next);
    else await ctx.db.insert('pushHealth', next);
    return null;
  },
});

// Marks a thread's push as held for "away" phones while Mike is at the Mac;
// sync:setPresence sends it when he leaves.
export const holdPush = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
      .unique();
    if (t && t.needsYou) await ctx.db.patch(t._id, { pushHeldAt: Date.now() });
    return null;
  },
});

// A runner's word that Mike is at its Mac counts while it's still checking
// in; a Mac that's asleep or offline counts as away.
const PRESENCE_FRESH_MS = 3 * 60_000;

// Apple said the token is gone (the app was removed, or it's stale).
export const drop = internalMutation({
  args: { apnsToken: v.string() },
  returns: v.null(),
  handler: async (ctx, { apnsToken }) => {
    const row = await ctx.db
      .query('devices')
      .withIndex('by_apnsToken', (q) => q.eq('apnsToken', apnsToken))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const threadForPush = internalQuery({
  args: { threadId: v.string() },
  // mac: the runner's name, for a thread on a Mac with a runner key of its
  // own (not byOwner), so its push can't pass for the main Mac's.
  returns: v.union(v.null(), v.object({ title: v.string(), status: v.string(), preview: v.string(), needsYou: v.boolean(), atMac: v.boolean(), mac: v.optional(v.string()), pendingApproval: v.optional(v.any()) })),
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
      .unique();
    if (!t) return null;
    const runner = await ctx.db
      .query('runners')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', t.runnerId))
      .unique();
    const atMac = Boolean(runner?.atMac) && Date.now() - (runner?.lastSeenAt ?? 0) < PRESENCE_FRESH_MS;
    // Named unless it's the main key's runner and has no key of its own; one
    // with no row (never heartbeated) goes by its id (runnerName).
    const mac = runner?.byOwner && !(await hasLiveKey(ctx, t.runnerId)) ? undefined : await runnerName(ctx, t.runnerId);
    return { title: t.title, status: t.status, preview: t.preview, needsYou: t.needsYou, atMac, ...(mac ? { mac } : {}), ...(t.pendingApproval ? { pendingApproval: t.pendingApproval } : {}) };
  },
});

export const list = internalQuery({
  args: {},
  returns: v.array(v.object({ environment: v.string(), tokenName: v.string(), updatedAt: v.string(), tokenTail: v.string(), notify: v.string() })),
  handler: async (ctx) => {
    const out = [];
    for await (const d of ctx.db.query('devices')) out.push({ environment: d.environment, tokenName: d.tokenName, updatedAt: new Date(d.updatedAt).toISOString(), tokenTail: d.apnsToken.slice(-6), notify: d.notify ?? 'away' });
    return out;
  },
});
