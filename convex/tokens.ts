// Phone tokens: what a phone or a browser holds to read the mirror. Only
// the SHA-256 of a token is stored; the plain token is handed out once, in
// the reply that issues it, and never printed or logged.
//
// Issued two ways:
// - From the Mac app's Settings › Phone & browser, through the runner
//   (sync:issueToken, with the runner key), which draws the pairing QR
//   code or opens the website signed in. The usual way since 28 Oct.
// - From a terminal, by someone logged in to the Convex team:
//     npx convex run tokens:issue '{"name":"iphone","days":90}'          (dev)
//     npx convex run tokens:issue '{"name":"iphone","days":90}' --prod   (prod)
//   Get it onto the phone the way Quick Ask does (a QR code), not the
//   clipboard: ios/scripts/pair-qr.swift and web/scripts/sign-in.swift.
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { pageLimit, sha256 } from './lib';
import { tiedToRevoked } from './pushTargets';

export const tokenKinds = ['phone', 'browser'] as const;
export type TokenKind = (typeof tokenKinds)[number];
export const tokenKind = v.union(...tokenKinds.map((k) => v.literal(k)));

export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;

// A token's row as the Mac app lists it (docs/protocol.md, "Devices").
export const tokenInfo = v.object({
  id: v.string(),
  kind: tokenKind,
  name: v.string(),
  createdAt: v.string(),
  expiresAt: v.string(),
  expired: v.boolean(),
});
export type TokenInfo = { id: string; kind: TokenKind; name: string; createdAt: string; expiresAt: string; expired: boolean };

// Makes a token and stores its hash. The plain token is returned to the
// caller and nowhere else.
export async function issueToken(ctx: MutationCtx, args: { name: string; days?: number; kind?: TokenKind; issuedBy?: string; ownerKeyPrint?: string }): Promise<{ id: string; token: string; expiresAt: string }> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = 'tb_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  // Not NaN, which would make a token that never expires (expiresAt < now is false).
  const days = pageLimit(args.days, DEFAULT_DAYS, MAX_DAYS);
  const expiresAt = now + days * 24 * 60 * 60_000;
  const id = await ctx.db.insert('tokens', { hash: await sha256(token), name: args.name, createdAt: now, expiresAt, ...(args.kind ? { kind: args.kind } : {}), ...(args.issuedBy ? { issuedBy: args.issuedBy } : {}), ...(args.ownerKeyPrint ? { ownerKeyPrint: args.ownerKeyPrint } : {}) });
  return { id, token, expiresAt: new Date(expiresAt).toISOString() };
}

// Rows from before `kind` (28 Oct) were named by hand: the sign-in script
// called browsers "web-…", and everything else was a phone.
export function kindOf(row: { kind?: TokenKind; name: string }): TokenKind {
  return row.kind ?? (row.name.startsWith('web-') ? 'browser' : 'phone');
}

export function toTokenInfo(row: { _id: Id<'tokens'>; name: string; kind?: TokenKind; createdAt: number; expiresAt: number }, now = Date.now()): TokenInfo {
  return { id: row._id, kind: kindOf(row), name: row.name, createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), expired: row.expiresAt < now };
}

// Every token that hasn't been revoked, newest first. Expired ones stay
// listed (so the list says why a phone stopped working) until revoked.
export async function listTokens(ctx: QueryCtx | MutationCtx): Promise<TokenInfo[]> {
  const now = Date.now();
  const out: TokenInfo[] = [];
  for await (const row of ctx.db.query('tokens')) {
    if (!row.revokedAt) out.push(toTokenInfo(row, now));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// Revokes one token by its row id. False when there's no such row.
export async function revokeToken(ctx: MutationCtx, id: string): Promise<boolean> {
  const rowId = ctx.db.normalizeId('tokens', id);
  if (!rowId) return false;
  const row = await ctx.db.get(rowId);
  if (!row) return false;
  if (!row.revokedAt) await ctx.db.patch(rowId, { revokedAt: Date.now() });
  // Even when it was revoked already, so a phone revoked before this
  // cleanup existed loses its pushes the next time it's revoked.
  await dropDevicesOf(ctx, [row]);
  return true;
}

// Deletes the phones registered for push with these (now revoked) tokens,
// and old rows that only name them (pushTargets.ts): otherwise a revoked
// phone's row stays. Later, a batch at a time (dropDevices), never in the
// mutation that revokes: one token can have registered many rows, and a
// revoke that read them all could go past Convex's limits and roll back,
// leaving the token good. Its pushes stop at once all the same, as
// devices:targets skips a revoked token's phones.
async function dropDevicesOf(ctx: MutationCtx, revoked: { _id: Id<'tokens'>; name: string }[]): Promise<void> {
  for (const r of revoked) await ctx.scheduler.runAfter(0, internal.tokens.dropDevices, { tokenId: r._id, name: r.name });
}

const DROP_BATCH = 100;
export const dropDevices = internalMutation({
  args: { tokenId: v.id('tokens'), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { tokenId, name }) => {
    // Only ever a revoked token's phones.
    const t = await ctx.db.get(tokenId);
    if (t && !t.revokedAt) return null;
    let n = 0;
    for (const d of await ctx.db.query('devices').withIndex('by_tokenId', (q) => q.eq('tokenId', tokenId)).take(DROP_BATCH)) {
      await ctx.db.delete(d._id);
      n++;
    }
    if (n < DROP_BATCH) {
      for (const d of await ctx.db.query('devices').withIndex('by_tokenName', (q) => q.eq('tokenName', name).eq('tokenId', undefined)).take(DROP_BATCH - n)) {
        if (!tiedToRevoked(d, { _id: tokenId, name })) continue;
        await ctx.db.delete(d._id);
        n++;
      }
    }
    if (n >= DROP_BATCH) await ctx.scheduler.runAfter(0, internal.tokens.dropDevices, { tokenId, name });
    return null;
  },
});

export const issue = internalMutation({
  args: { name: v.string(), days: v.optional(v.number()), kind: v.optional(tokenKind) },
  returns: v.object({ token: v.string(), expiresAt: v.string() }),
  handler: async (ctx, args) => {
    const { token, expiresAt } = await issueToken(ctx, args);
    return { token, expiresAt };
  },
});

// Revokes every token with the name (a lost phone).
export const revoke = internalMutation({
  args: { name: v.string() },
  returns: v.number(),
  handler: async (ctx, { name }) => {
    let n = 0;
    const named = [];
    for await (const row of ctx.db.query('tokens')) {
      if (row.name !== name) continue;
      named.push(row);
      if (!row.revokedAt) {
        await ctx.db.patch(row._id, { revokedAt: Date.now() });
        n++;
      }
    }
    await dropDevicesOf(ctx, named);
    return n;
  },
});

export const list = internalMutation({
  args: {},
  returns: v.array(v.object({ name: v.string(), kind: tokenKind, createdAt: v.string(), expiresAt: v.string(), revoked: v.boolean() })),
  handler: async (ctx) => {
    const out = [];
    for await (const row of ctx.db.query('tokens')) {
      out.push({ name: row.name, kind: kindOf(row), createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), revoked: Boolean(row.revokedAt) });
    }
    return out;
  },
});
