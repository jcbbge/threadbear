// Shared by the runner-facing and phone-facing functions: who may call what.
import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { callerFrom, FORBIDDEN, forbiddenMessage, isOwnerKey, mayCall, validRunnerId, type Caller } from './runnerAccess';

// The runner's functions carry the key from its secrets/convex-key: the
// owner key (the deployment's RUNNER_KEY, set with `npx convex env set
// RUNNER_KEY <key>`) or a runner key (runnerKeys, `tb runner add`). Every
// function in sync.ts starts here under its own name, which
// runnerAccess.ts ACCESS sorts into owner only, its own runner's, or any
// runner's; what "its own" is for each, the function checks with the
// Caller this returns.
export async function runnerAuth(ctx: QueryCtx | MutationCtx, key: string, fn: string): Promise<Caller> {
  const owners = [process.env.RUNNER_KEY, process.env.RUNNER_KEY_NEXT];
  // The owner key needs no lookup; anything else may be a runner key.
  const row = key && !isOwnerKey(key, owners) ? await runnerKeyRow(ctx, key) : null;
  const c = callerFrom(key, owners, row);
  if (!c) throw new ConvexError({ kind: 'auth', message: 'bad runner key' });
  if (!mayCall(c, fn)) throw forbidden(`call ${fn}: only the main Mac's key (the deployment's RUNNER_KEY) can`);
  return c;
}

async function runnerKeyRow(ctx: QueryCtx | MutationCtx, key: string) {
  const hash = await sha256(key);
  return ctx.db
    .query('runnerKeys')
    .withIndex('by_hash', (q) => q.eq('keyHash', hash))
    .first();
}

// A runner key reaching past its own runner. `what` finishes "This runner's
// key can't ...".
export function forbidden(what: string): ConvexError<{ kind: string; message: string }> {
  return new ConvexError({ kind: FORBIDDEN, message: forbiddenMessage(what) });
}

// A runner id that isn't one (runnerAccess.ts validRunnerId): refused as
// it arrives, before anything compares it.
export function checkRunnerId(runnerId: string): void {
  if (!validRunnerId(runnerId)) throw new ConvexError({ kind: 'badArgs', message: 'runnerId must be 1 to 64 letters, digits, - or _, and not "any"' });
}

// Throws unless the caller may act as `runnerId`. A runner key acts as its
// own runner only. The owner key acts as any runner but one with a live key
// of its own: that Mac should be using its key now, so an old copy of the
// owner key left on it can't go on acting for it.
export async function actAs(ctx: QueryCtx | MutationCtx, c: Caller, runnerId: string): Promise<void> {
  checkRunnerId(runnerId);
  if (!c.owner) {
    if (c.runnerId !== runnerId) throw forbidden(`act as runner ${runnerId}`);
    return;
  }
  if (await hasLiveKey(ctx, runnerId)) throw forbidden(`act as runner ${runnerId} with the main key, as that runner has a key of its own`);
}

export async function hasLiveKey(ctx: QueryCtx | MutationCtx, runnerId: string): Promise<boolean> {
  for await (const row of ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) if (!row.revokedAt) return true;
  return false;
}

// A phone's token (tokens.ts) is checked by its SHA-256 hash; the plain
// token is never stored.
export async function checkPhoneToken(ctx: QueryCtx | MutationCtx, token: string): Promise<{ id: Id<'tokens'>; name: string; expiresAt: number }> {
  const hash = await sha256(token);
  const row = await ctx.db
    .query('tokens')
    .withIndex('by_hash', (q) => q.eq('hash', hash))
    .unique();
  if (!row || row.revokedAt || row.expiresAt < Date.now()) throw new ConvexError({ kind: 'auth', message: 'bad or expired phone token' });
  return { id: row._id, name: row.name, expiresAt: row.expiresAt };
}

// A page size a caller asked for, as a whole number from 1 to `max`. Convex's
// v.number() lets NaN and the infinities through, and Math.min/max/floor keep
// NaN, so a loop bounded by `out.length >= want` would never stop: anything
// that isn't a finite number is refused rather than clamped.
export function pageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit)) throw new ConvexError({ kind: 'invalid', message: 'limit must be a number' });
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Someone has a Runners view open: the website's (phone:watchRunners) or the
// Mac app's runner details (sync:watchRunnersFromMac). Runners report their
// figures until this lapses (API 45, 46). Each viewer renews it every 30 s
// at most, so a closed view stops them within RUNNER_WATCH_MS.
export const RUNNER_WATCH_MS = 45_000;
export async function watchRunnersFor(ctx: MutationCtx): Promise<void> {
  const until = Date.now() + RUNNER_WATCH_MS;
  const row = await ctx.db.query('runnerWatch').first();
  if (row) await ctx.db.patch(row._id, { until });
  else await ctx.db.insert('runnerWatch', { until });
}

// Every runner's latest figures (runnerStats), `at` as an ISO string, for
// phone:runnerStats and sync:runnerStatsList alike.
export async function runnerStatsRows(ctx: QueryCtx) {
  const out = [];
  for await (const s of ctx.db.query('runnerStats')) {
    const { _id, _creationTime, at, ...rest } = s;
    out.push({ ...rest, at: new Date(at).toISOString() });
  }
  return out;
}

// Mike's runner order (the runnerOrder row, API 56): set from the phone's
// Settings (phone:setRunnerOrder) or the Mac's (sync:setRunnerOrder, the
// owner key only, API 58), one order for both. New threads that name no
// runner start on the first one online in it (phone.ts mainRunner).
export async function readRunnerOrder(ctx: QueryCtx): Promise<string[]> {
  return (await ctx.db.query('runnerOrder').first())?.runnerIds ?? [];
}

export async function saveRunnerOrder(ctx: MutationCtx, runnerIds: string[]): Promise<void> {
  if (runnerIds.length > 50 || runnerIds.some((id) => !id || id.length > 100)) throw new ConvexError({ kind: 'invalid', message: 'runnerIds must be at most 50 ids of 1 to 100 characters' });
  const ids = [...new Set(runnerIds)];
  const row = await ctx.db.query('runnerOrder').first();
  if (row) await ctx.db.patch(row._id, { runnerIds: ids });
  else await ctx.db.insert('runnerOrder', { runnerIds: ids });
}
