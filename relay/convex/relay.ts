// The relay's records: installs and the daily counts (schema.ts).
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { MAX_REASONS, reasonKey } from './reasons';
import { countVersions, storedVersion } from './versions';

// Per install, so one runaway backend can't flood anyone's phone or Apple.
export const SENDS_PER_HOUR = 120;
// Registrations a day for one checked deployment. It only registers again
// when it lost its install, so this only stops a backend stuck in a loop;
// nobody else can use it up, as only the deployment passes the check.
export const REGISTRATIONS_PER_DEPLOYMENT_PER_DAY = 20;

export const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// For a deployment that passed the check (http.ts, verify.ts): one install
// per deployment, so registering again gives the same install a new key
// and the old key stops working. Its hourly send count carries over.
export const registerVerified = internalMutation({
  args: { deployment: v.string(), version: v.optional(v.string()) },
  returns: v.object({ installId: v.string(), installKey: v.string() }),
  handler: async (ctx, { deployment, version }) => {
    const today = day();
    const existing = await ctx.db
      .query('installs')
      .withIndex('by_deployment', (q) => q.eq('deployment', deployment))
      .first();
    const registeredToday = existing?.registeredDay === today ? (existing.registeredToday ?? 0) : 0;
    if (registeredToday >= REGISTRATIONS_PER_DEPLOYMENT_PER_DAY) throw new ConvexError({ kind: 'busy', message: 'this deployment registered too often today; try again tomorrow' });
    const installKey = 'k_' + randomHex(24);
    const now = Date.now();
    const fields = { keyHash: await sha256(installKey), lastSeenAt: now, ...(version !== undefined ? { version: storedVersion(version) } : {}), deployment, registeredDay: today, registeredToday: registeredToday + 1 };
    let installId: string;
    if (existing) {
      installId = existing.installId;
      await ctx.db.patch(existing._id, fields);
    } else {
      installId = 'i_' + randomHex(12);
      await ctx.db.insert('installs', { installId, createdAt: now, hourStart: now, hourSends: 0, ...fields });
    }
    await countRegistration(ctx, today);
    return { installId, installKey };
  },
});

async function countRegistration(ctx: MutationCtx, today: string): Promise<void> {
  const counts = await ctx.db
    .query('days')
    .withIndex('by_day', (q) => q.eq('day', today))
    .unique();
  if (counts) await ctx.db.patch(counts._id, { registrations: counts.registrations + 1 });
  else await ctx.db.insert('days', { day: today, sends: 0, failed: 0, registrations: 1 });
}

// Checks the install's key and rate limit, and counts the send.
export const admit = internalMutation({
  args: { installId: v.string(), installKey: v.string(), version: v.optional(v.string()) },
  returns: v.union(v.literal('ok'), v.literal('auth'), v.literal('limited')),
  handler: async (ctx, { installId, installKey, version }) => {
    const row = await ctx.db
      .query('installs')
      .withIndex('by_installId', (q) => q.eq('installId', installId))
      .unique();
    if (!row || row.keyHash !== (await sha256(installKey))) return 'auth';
    const now = Date.now();
    const fresh = now - row.hourStart >= 3_600_000;
    const sends = fresh ? 0 : row.hourSends;
    if (sends >= SENDS_PER_HOUR) return 'limited';
    await ctx.db.patch(row._id, { lastSeenAt: now, hourStart: fresh ? now : row.hourStart, hourSends: sends + 1, ...(version !== undefined ? { version: storedVersion(version) } : {}) });
    return 'ok';
  },
});

export const counted = internalMutation({
  args: { ok: v.boolean(), status: v.optional(v.number()), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { ok, status, reason }) => {
    const today = day();
    const counts = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', today))
      .unique();
    const add = { sends: ok ? 1 : 0, failed: ok ? 0 : 1 };
    const reasons = { ...(counts?.reasons ?? {}) };
    if (!ok) {
      let key = reasonKey(status ?? 0, reason);
      if (!(key in reasons) && Object.keys(reasons).length >= MAX_REASONS) key = 'other';
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    const tally = ok ? {} : { reasons };
    if (counts) await ctx.db.patch(counts._id, { sends: counts.sends + add.sends, failed: counts.failed + add.failed, ...tally });
    else await ctx.db.insert('days', { day: today, registrations: 0, ...add, ...tally });
    return null;
  },
});

// For Mike: `npx convex run relay:stats --prod`.
export const stats = internalQuery({
  args: {},
  returns: v.object({ installs: v.number(), activeLast7Days: v.number(), versions: v.record(v.string(), v.number()), days: v.array(v.object({ day: v.string(), sends: v.number(), failed: v.number(), registrations: v.number(), reasons: v.optional(v.record(v.string(), v.number())) })) }),
  handler: async (ctx) => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    let installs = 0;
    let active = 0;
    const seen: (string | undefined)[] = [];
    for await (const i of ctx.db.query('installs')) {
      installs++;
      if (i.lastSeenAt >= weekAgo) active++;
      seen.push(i.version);
    }
    // In a Map, and anything stored before the rule as "other" (versions.ts).
    const versions = countVersions(seen);
    const days = (await ctx.db.query('days').withIndex('by_day').order('desc').take(14)).map(({ day, sends, failed, registrations, reasons }) => ({ day, sends, failed, registrations, ...(reasons ? { reasons } : {}) }));
    return { installs, activeLast7Days: active, versions, days };
  },
});

// Removes an install, for someone asking to be forgotten (or a test):
//   npx convex run relay:forget '{"installId":"i_..."}' --prod
export const forget = internalMutation({
  args: { installId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { installId }) => {
    const row = await ctx.db
      .query('installs')
      .withIndex('by_installId', (q) => q.eq('installId', installId))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return Boolean(row);
  },
});

// Wipes the test day's counts too, when there was nothing real in it.
export const resetDay = internalMutation({
  args: { day: v.string() },
  returns: v.null(),
  handler: async (ctx, { day }) => {
    const row = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', day))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
