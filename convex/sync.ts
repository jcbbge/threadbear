// What the runner writes (runner/src/sync.ts). Every mutation carries the
// runner key (lib.ts). Rows are current state, so writing the same thing
// twice is harmless, and a runner that was offline writes each changed
// row once when it's back.
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { messageButton, threadFields, views } from './schema';
import { API_VERSION } from './version';
import { actAs, checkRunnerId, forbidden, hasLiveKey, pageLimit, readRunnerOrder, runnerAuth, runnerStatsRows, saveRunnerOrder, sha256, watchRunnersFor } from './lib';
import { scrubDoc, scrubEveryString, SCRUB_RULES_VERSION, HELD_BACK } from './redaction';
import { dropHead, seedHeads, syncHead, syncHeads } from './projectHeads';
import { dropNotes, putNotes, syncNotes } from './projectNotes';
import { badRunnerStats, cutBytes, docBytes, fitUsage, impossibleUsage, isIsoTime, LOGIN_EMAIL, LOGIN_PROVIDER, loginKey, mayClaim, NAME_CHARS, mayFinish, mayTake, mayTouch, mayUseStorage, mayWrite, nameSkeleton, normalName, ownsCard, SCHEDULE_ID, utf8Bytes, wholeIn, type Caller, type UsageDoc } from './runnerAccess';
import { dropWake, seedWakes, syncWake } from './wakes';
import { pushFailing, pushOff } from './pushHealth';
import { issueToken as makeToken, listTokens as allTokens, revokeToken as revokeOne, tokenInfo, tokenKind, MAX_DAYS } from './tokens';

// The second pass on anything a runner sends (docs/convex-backend.md, "Secret
// scrubbing"): a runner scrubs first, but one on an older release doesn't, and
// nothing that comes through here should depend on that. A string whose check
// fails is stored as HELD_BACK rather than as it came, and the log says so.
function clean<T>(value: T): T {
  return scrubDoc(value, undefined, (e) => console.error(`secret check failed, stored "${HELD_BACK}" instead:`, (e as Error)?.name));
}

// A call's answer is JSON text. Scrubbing the text whole can leave it unparseable
// (a rule's match crossing an escaped quote), so scrub what it says and write it
// again. Text that doesn't parse isn't kept: nothing could read it anyway.
function cleanResult(result: string): string | undefined {
  try {
    return JSON.stringify(scrubEveryString(JSON.parse(result), clean));
  } catch {
    return undefined;
  }
}

// What a command keeps once it's over, however it ended. Its words were stored as
// typed only so the runner could get them exactly, and nothing reads them after
// that. Dropped rather than scrubbed, as a value only the sender knew would get
// through any scrubbing here. Its photos stay named, for deleteIfUnused to count.
export function finishedArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return Array.isArray(args?.images) ? { images: args.images } : {};
}

// Finished commands and paged messages older than this are pruned.
const KEEP_FINISHED_MS = 24 * 60 * 60_000;
// Rows pruneOld touches a run, well under Convex's per-mutation limits.
const PRUNE_BATCH = 1_000;
const PRUNE_MESSAGES = 5;
const PRUNE_COMMAND_BYTES = 4 * 1024 * 1024;
const TOMBSTONE_DAYS = 30;

const threadDoc = v.object({ ...threadFields, view: v.union(...views.map((x) => v.literal(x))) });

async function threadRow(ctx: QueryCtx | MutationCtx, threadId: string) {
  return ctx.db
    .query('threads')
    .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
    .unique();
}

// Things keyed by a thread id (its messages and pictures) are its runner's
// (runnerAccess.ts mayTouch). "none": a runner key naming an id that isn't
// its runner's thread, there or not: its write is dropped and its read is
// empty, the same either way, so a key learns nothing about other runners'
// ids, and a runner that deleted the thread meanwhile doesn't retry for ever.
async function ownThread(ctx: QueryCtx | MutationCtx, caller: Caller, threadId: string): Promise<'yes' | 'none'> {
  if (caller.owner) return 'yes';
  const row = await threadRow(ctx, threadId);
  if (!row || !mayTouch(caller, row.runnerId)) return 'none';
  // On its way to the owner (threadClears): no longer its runner's to write.
  return (await ctx.db.query('threadClears').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).first()) ? 'none' : 'yes';
}

// Whether the caller may make a row under a thread id: its own row's, or one
// with no tombstone, sidebar row or leftovers of another runner's
// (runnerAccess.ts mayClaim).
async function claimable(ctx: QueryCtx | MutationCtx, caller: Caller, threadId: string): Promise<boolean> {
  if (caller.owner) return true;
  const row = await threadRow(ctx, threadId);
  if (row) return row.runnerId === caller.runnerId;
  const claimedBy: string[] = [];
  for await (const t of ctx.db.query('threadTombstones').withIndex('by_threadId', (q) => q.eq('threadId', threadId))) claimedBy.push(t.runnerId);
  for await (const t of ctx.db.query('threadIndex').withIndex('by_threadId', (q) => q.eq('threadId', threadId))) claimedBy.push(t.runnerId);
  const leftovers =
    (await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).first()) !== null ||
    (await ctx.db.query('shareImages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).first()) !== null ||
    (await ctx.db.query('replyImages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).first()) !== null;
  return mayClaim(caller, { claimedBy, leftovers });
}

// ------------------------------------------------------------ share links
// A link's slug is one thread's for good: /s/<slug> must never start showing
// another thread. A runner key may take one only if no other row has it and
// no other runner's thread ever did (a deleted thread's, or one replaced by
// Share again with a new link: tombstones with `slug`). The owner may; the
// other rows then lose it.

async function slugFree(ctx: QueryCtx | MutationCtx, caller: Caller, threadId: string, slug: string): Promise<boolean> {
  if (caller.owner) return true;
  for await (const t of ctx.db.query('threads').withIndex('by_share_slug', (q) => q.eq('share.slug', slug))) if (t.threadId !== threadId) return false;
  for await (const t of ctx.db.query('threadTombstones').withIndex('by_slug', (q) => q.eq('slug', slug))) if (t.runnerId !== caller.runnerId) return false;
  return true;
}

async function retireSlug(ctx: MutationCtx, threadId: string, runnerId: string, slug: string): Promise<void> {
  for await (const t of ctx.db.query('threadTombstones').withIndex('by_slug', (q) => q.eq('slug', slug))) if (t.threadId === threadId && t.runnerId === runnerId) return;
  await ctx.db.insert('threadTombstones', { threadId, runnerId, slug, at: Date.now() });
}

// ------------------------------------------------------------ stored files
// Nothing in a storage id says who uploaded it, so a runner key's uploads go
// through convex/http.ts /runner/upload, which records them (storageOwners),
// and it attaches or deletes only files of its own; the phone's go through
// /phone/upload (phoneUploads), likewise. A file is deleted only once nothing
// names it: a picture row, a project icon, or a phone command still waiting
// to be taken or finished. Files the owner key uploaded have no record and
// are no runner key's.

// Whether anything still names the file. Existence, not a count: each table
// is one indexed read that stops at the first row, so many rows naming one
// file (or a few big ones) can't make a delete read more than a handful of
// documents, and a command is found through commandFiles rather than by
// reading every waiting command.
const PICTURE_TABLES = ['shareImages', 'replyImages', 'projectIcons', 'heldPictures'] as const;
// A commandFiles row lasts only while its command waits or is taken (it goes
// in endCommandFiles), so one is enough, and no command is read.
export async function storageInUse(ctx: QueryCtx | MutationCtx, storageId: Id<'_storage'>): Promise<boolean> {
  for (const table of [...PICTURE_TABLES, 'commandFiles'] as const) {
    if (await ctx.db.query(table).withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first()) return true;
  }
  // Until limitsMigration has written commandFiles for commands made before
  // it, those are looked through the old way, up to a few MB: past that the
  // file counts as in use (it goes once they're over, by pruneFiles).
  // The allowance is the mutation's, however many files it checks.
  if (!(await markSet(ctx, LIMITS_DONE))) {
    const budget = clearBudget(ctx as MutationCtx);
    if ((budget.oldCommands ?? 0) > OLD_COMMANDS_READ) return true;
    for (const state of ['pending', 'taken'] as const) {
      for await (const c of ctx.db.query('commands').withIndex('by_state', (q) => q.eq('state', state))) {
        if (Array.isArray(c.args?.images) && c.args.images.some((i: { storageId?: string }) => i?.storageId === storageId)) return true;
        if ((budget.oldCommands = (budget.oldCommands ?? 0) + docBytes(c)) > OLD_COMMANDS_READ) return true;
      }
    }
  }
  return false;
}
const OLD_COMMANDS_READ = 2 * 1024 * 1024;

// A command is over (finished, failed, cancelled, expired): its photos are no
// longer on their way. Call before deleteIfUnused on them.
export const MAX_COMMAND_FILES = 6;
export async function endCommandFiles(ctx: MutationCtx, commandId: Id<'commands'>): Promise<void> {
  for (const f of await ctx.db.query('commandFiles').withIndex('by_commandId', (q) => q.eq('commandId', commandId)).take(MAX_COMMAND_FILES)) await ctx.db.delete(f._id);
}

async function uploadedBy(ctx: QueryCtx | MutationCtx, storageId: Id<'_storage'>): Promise<string | undefined> {
  return (await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first())?.runnerId;
}

async function mustMayUseStorage(ctx: MutationCtx, caller: Caller, storageId: Id<'_storage'>): Promise<void> {
  if (!mayUseStorage(caller, await uploadedBy(ctx, storageId))) throw forbidden("use a stored file its runner didn't upload");
  const row = await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first();
  if (row && !row.attachedAt) await ctx.db.patch(row._id, { attachedAt: Date.now() });
}

// Deletes a file nothing names any more. Call after the row naming it has
// gone (or was never written).
export async function deleteIfUnused(ctx: MutationCtx, storageId: Id<'_storage'>): Promise<void> {
  if (await storageInUse(ctx, storageId)) return;
  if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
  for (const row of await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).collect()) {
    await ctx.db.delete(row._id);
    const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).unique();
    if (usage) await ctx.db.patch(usage._id, { bytes: Math.max(0, usage.bytes - (row.bytes ?? 0)) });
  }
}

// As deleteIfUnused, and for a runner key only a file it uploaded: nothing
// naming a file never makes it anyone's to delete.
async function freeStorage(ctx: MutationCtx, caller: Caller, storageId: Id<'_storage'>): Promise<void> {
  if (!mayUseStorage(caller, await uploadedBy(ctx, storageId))) return;
  await deleteIfUnused(ctx, storageId);
}

// Everything stored under a thread id but its row: messages, pictures, tool
// output, and its runner's sidebar row. A thread removed, pruned, or taken
// over by the owner (upsertThreads): nothing one runner wrote survives
// under another. Its rows go as far as this mutation's share of reading
// goes (CLEAR_BYTES, across every thread it clears), as a thread can hold
// more than one mutation may read (a runner key's 48 MB of messages). The
// rest go in runs of their own (dropThreadRows), and until they have, the
// id is closed (threadClears): nobody writes under it (the owner's writes
// are skipped and sent again, a runner key's dropped), so what's left is
// only ever the old rows, and a thread made under it, or taken over, never
// shows them. False: a takeover has to wait for that.
async function clearThread(ctx: MutationCtx, threadId: string, runnerId: string | undefined, share: { slug: string } | undefined, mode: 'removed' | 'moving' = 'removed'): Promise<boolean> {
  const clearing = await clearingOf(ctx, threadId);
  // A takeover goes on waiting for its rows. A removal while they go (a
  // takeover's or an earlier removal's) leaves them to it, and the id opens
  // when they've gone, as there's no takeover left to finish.
  if (clearing && !clearing.done && mode === 'moving') return false;
  if (clearing && !clearing.done) {
    if (clearing.moving) await ctx.db.patch(clearing._id, { moving: undefined });
  } else if (clearing) await ctx.db.delete(clearing._id);
  else if (await clearRows(ctx, threadId, clearBudget(ctx))) {
    await ctx.db.insert('threadClears', { threadId, runnerId: runnerId ?? '', ...(mode === 'moving' ? { moving: true } : {}) });
    await ctx.scheduler.runAfter(0, internal.sync.dropThreadRows, { threadId });
    if (mode === 'moving') return false;
  }
  if (!runnerId) return true;
  const had = await ctx.db.query('threadTombstones').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).collect();
  if (!had.some((t) => t.runnerId === runnerId && !t.slug)) await ctx.db.insert('threadTombstones', { threadId, runnerId, at: Date.now() });
  if (share?.slug) await retireSlug(ctx, threadId, runnerId, share.slug);
  return true;
}

// Nothing may be written under the id: its rows are still going, or it's
// on its way to the owner (done, waiting for the takeover itself).
async function closedId(ctx: QueryCtx | MutationCtx, threadId: string): Promise<boolean> {
  return (await clearingOf(ctx, threadId)) !== null;
}

// The id's rows still going (clearThread), if they are.
export async function clearingOf(ctx: QueryCtx | MutationCtx, threadId: string) {
  return ctx.db.query('threadClears').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).first();
}

// What one mutation spends clearing threads' rows, shared by every
// clearThread in it (removeThreads and prune clear many). A file's check
// (storageInUse) is charged as what it may read: a row from each picture
// table, a few KB since the caps, up to a MiB each before limitsMigration.
const CLEAR_BYTES = 4 * 1024 * 1024;
const CLEAR_HARD = 10 * 1024 * 1024;
const CLEAR_CHECK_BYTES = 64 * 1024;
const OLD_ROWS_CHECK_BYTES = 5 * 1024 * 1024;
type Budget = { bytes: number; check?: number; oldCommands?: number };
const clearBudgets = new WeakMap<object, Budget>();
function clearBudget(ctx: MutationCtx): Budget {
  let b = clearBudgets.get(ctx);
  if (!b) clearBudgets.set(ctx, (b = { bytes: 0 }));
  return b;
}
async function checkCost(ctx: MutationCtx, budget: Budget): Promise<number> {
  budget.check ??= (await markSet(ctx, LIMITS_DONE)) ? CLEAR_CHECK_BYTES : OLD_ROWS_CHECK_BYTES;
  return budget.check;
}

// What a row was charged as when it went in (appendMessages): without the
// fields Convex adds, so taking it out gives back exactly that.
function storedBytes(row: Record<string, unknown>): number {
  const { _id, _creationTime, ...rest } = row;
  return docBytes(rest);
}

// Deletes a thread's rows, a table at a time, until the budget is spent
// (counting every row read, and a file's check for each picture). Nothing
// new goes in under the id meanwhile (threadClears), so every row read is
// deleted and each run starts again from the top. True: there's more.
const CLEAR_TABLES = ['messages', 'shareImages', 'replyImages', 'heldPictures', 'eventBodies'] as const;
async function clearRows(ctx: MutationCtx, threadId: string, budget: Budget): Promise<boolean> {
  const messages = new Map<string, number>();
  const bodies = new Map<string, number>();
  let more = false;
  rows: for (const table of CLEAR_TABLES) {
    const q = ctx.db.query(table).withIndex('by_thread_seq', (x) => x.eq('threadId', threadId));
    // Spent: whether this table has anything left is one row read (charged),
    // up to CLEAR_HARD; past that, assume it has, for a run of its own to see.
    if (budget.bytes >= CLEAR_BYTES) {
      const peek = budget.bytes < CLEAR_HARD ? await q.first() : true;
      if (peek && peek !== true) budget.bytes += docBytes(peek);
      if (peek) {
        more = true;
        break;
      }
      continue;
    }
    for await (const row of q as AsyncIterable<Record<string, any>>) {
      // Spent, with a row still here (read, so charged): the rest next run.
      const spent = budget.bytes >= CLEAR_BYTES;
      budget.bytes += docBytes(row);
      if (spent || budget.bytes >= CLEAR_HARD) {
        more = true;
        break rows;
      }
      await ctx.db.delete(row._id);
      if (table === 'messages') {
        if (row.runnerId) messages.set(row.runnerId, (messages.get(row.runnerId) ?? 0) + storedBytes(row));
      } else if (table === 'eventBodies') {
        if (row.runnerId) bodies.set(row.runnerId, (bodies.get(row.runnerId) ?? 0) + docBytes(strippedBody(row as Doc<'eventBodies'>)));
      } else {
        budget.bytes += await checkCost(ctx, budget);
        await deleteIfUnused(ctx, row.storageId);
      }
    }
  }
  for (const [runnerId, bytes] of messages) await countMessageBytes(ctx, runnerId, -bytes);
  for (const [runnerId, bytes] of bodies) await countBodyBytes(ctx, runnerId, -bytes);
  return more;
}

// The rest of a thread clearThread couldn't finish, a run at a time. Once
// it's all gone the id opens again; for a takeover the row stays closed to
// its old runner (done) until the owner's next write of it goes through.
export const dropThreadRows = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const clearing = await clearingOf(ctx, threadId);
    if (!clearing || clearing.done) return null;
    if (await clearRows(ctx, threadId, { bytes: 0 })) await ctx.scheduler.runAfter(0, internal.sync.dropThreadRows, { threadId });
    else if (clearing.moving) await ctx.db.patch(clearing._id, { done: true });
    else await ctx.db.delete(clearing._id);
    return null;
  },
});

// A thread's row and everything under it, with a tombstone so a runner key
// can't take the id or its link later (claimable, slugFree). removeThreads
// and prune; a runner key only ever reaches its own (their callers check).
async function dropThread(ctx: MutationCtx, threadId: string, row: Doc<'threads'> | null): Promise<void> {
  if (row) {
    await ctx.db.delete(row._id);
    await ctx.db.insert('threadGone', { threadId, at: Date.now() });
    await moveView(ctx, row.runnerId, row.view, undefined);
    await refill(ctx, row.runnerId, row.view);
  }
  // Its project links go with it (removeThreads, prune, purge).
  await linkThread(ctx, threadId, null);
  await clearThread(ctx, threadId, row?.runnerId, row?.share);
}

// ------------------------------------------------------------ caps
// What one runner key may write. The phone and the main Mac read some lists
// whole (the inbox and hibernating views, projects, schedules, the other
// runners' sidebars), so each runner key's share of each is budgeted in
// UTF-8 bytes, with at most MAX_RUNNER_KEYS live keys, so even all of them
// full stay well under Convex's 16 MiB a read: inbox or hibernating 200 x 8
// KB, projects 50 x 32 KB, sidebar rows 800 x 2 KB, schedules 100 x 8 KB
// (each 1.6 MB or less a key, 6.4 MB for four). The owner key isn't capped:
// the main runner is trusted with its own lists.
//
// What a runner's flush writes (threads, messages, sidebar rows, projects,
// accounts, its heartbeat, a run recorded on a schedule) is trimmed to fit,
// or skipped and said back (`skipped`), never refused, so one odd row can't
// stall the rest of a legitimate runner's mirror. Only what an agent asks for
// directly (a Pocket card, a schedule) is refused when it's too big, so the
// agent hears why.
// With three runner keys all at their caps, the database holds at most about
// 3 x 75 MB of theirs (messages 48 MB, threads 3,000 x 8 KB, the rest under
// 5 MB) and file storage 3 x 150 MB: inside Convex's free plan with room
// for the main Mac's own (docs/protocol.md, "Caps").
export const MAX_RUNNER_KEYS = 3;
const INDEX_READ_PER_RUNNER = 2_000;
export const RUNNER_KEY_CAPS = {
  threadDoc: 8_192,
  threadText: 1_000, // title, preview, cwd, working line, each
  threadsInView: 300, // per view the phone reads whole (inbox, hibernating)
  // A runner key's threads in all, every view (the M5 had 714 on 5 Nov,
  // Bruce 7): past it a new one waits (left out, sent again later).
  threads: 3_000,
  message: 10_000,
  messageDoc: 12_288,
  // A runner key's messages' bytes in all: past it its oldest anywhere give
  // way before a new one goes in. The M5's whole history, about 83,000
  // messages, is about 21 MB.
  messageBytes: 48 * 1024 * 1024,
  evictPerWrite: 200,
  // Tool output (eventBodies, API 52), per row and in all. Past the budget its
  // oldest go first, a few a write as they're whole rows to read.
  bodyDoc: 512 * 1024,
  bodyBytes: 32 * 1024 * 1024,
  bodyEvictPerWrite: 20,
  pushesPerMinute: 10,
  indexRow: 2_048,
  indexRows: 800, // every row, tombstones too, archived ones too (API 54)
  // How many of its oldest rows a write past that looks through for an archived one to give way.
  indexEvictScan: 100,
  cardTitle: 60,
  cardText: 2_000,
  cardPlace: 100,
  cardSource: 200,
  cards: 50,
  // The longest real prompt on 5 Nov was 2,286 bytes (M5 and Bruce): 5x that.
  scheduleDoc: 16_384,
  scheduleText: 12_000,
  schedules: 100,
  projectDoc: 32_768,
  projects: 50,
  accountDoc: 8_192,
  accounts: 20,
  runnerField: 300, // a heartbeat's icon, version, rpcUrl
  note: 500, // a schedule run's note
} as const;
const CAP = RUNNER_KEY_CAPS;

function tooBig(what: string, max: number): ConvexError<{ kind: string; message: string }> {
  return new ConvexError({ kind: 'badArgs', message: `${what} is over ${max} bytes, more than a runner key may write` });
}
// For what an agent asks for directly: refused, so it hears why.
function capText(caller: Caller, what: string, value: string | undefined, max: number): void {
  if (!caller.owner && value !== undefined && utf8Bytes(value) > max) throw tooBig(what, max);
}
function capDoc(caller: Caller, what: string, doc: unknown, max: number): void {
  if (!caller.owner && docBytes(doc) > max) throw tooBig(what, max);
}
// What a picture row may say when a runner key writes it (addReplyImage,
// addShareImage, addHeldPicture): a type the runner sends (runner/src/media.ts
// sniffImage), whole numbers in range, short paths. Refused rather than cut: a
// row's path is how its runner knows what it sent, so a cut one would go again
// and again. Each row is then a few KB at most.
export const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime']);
const PICTURE_PATH = 2_048;
const PICTURE_SIDE = 100_000;
const PICTURE_INDEX = 100;
function checkPicture(caller: Caller, img: { seq: number; index?: number; path?: string; src?: string; mediaType: string; width?: number; height?: number }): void {
  if (caller.owner) return;
  const whole = (n: number, lo: number, hi: number) => Number.isSafeInteger(n) && n >= lo && n <= hi;
  const bad = (what: string) => new ConvexError({ kind: 'badArgs', message: `a picture's ${what} isn't one a runner key may write` });
  if (!PICTURE_TYPES.has(img.mediaType)) throw bad('type');
  if (!whole(img.seq, 0, Number.MAX_SAFE_INTEGER)) throw bad('seq');
  if (img.index !== undefined && !whole(img.index, 0, PICTURE_INDEX)) throw bad('index');
  for (const side of [img.width, img.height]) if (side !== undefined && !whole(side, 1, PICTURE_SIDE)) throw bad('size');
  if (img.path !== undefined && utf8Bytes(img.path) > PICTURE_PATH) throw tooBig("a picture's path", PICTURE_PATH);
  if (img.src !== undefined && utf8Bytes(img.src) > PICTURE_PATH) throw tooBig("a picture's src", PICTURE_PATH);
}

// A runner key's upload goes on one row. Ownership alone would let one small
// file be named by any number of rows (a new seq each), which no upload cap
// sees. A retry of the same row is caught before this, by its own key.
async function mustBeUnnamed(ctx: MutationCtx, caller: Caller, storageId: Id<'_storage'>): Promise<void> {
  if (!caller.owner && (await storageInUse(ctx, storageId))) throw forbidden('put one stored file on two rows');
}

// What adding a picture answers. later: not now, its thread id's old rows are
// still going (clearThread); the runner keeps it and sends it again.
const pictureAnswer = v.union(v.null(), v.object({ later: v.literal(true) }));

function tooMany(what: string, max: number): ConvexError<{ kind: string; message: string }> {
  return new ConvexError({ kind: 'tooMany', message: `A runner key may keep at most ${max} ${what}` });
}

// A runner key's thread row cut to fit, or undefined: its text fields cut,
// then the open card, follow-ups, links and projects dropped if it's still
// too big (the phone shows the thread without them).
function fitThread<T extends Record<string, any>>(t: T): T | undefined {
  const out: Record<string, any> = { ...t };
  // Never in the future: lists are by activity, and a far-off time would
  // push every other Mac's threads off them.
  if (typeof out.lastActivityMs === 'number') out.lastActivityMs = Math.min(out.lastActivityMs, Date.now());
  for (const f of ['title', 'preview', 'cwd', 'working', 'asked']) if (typeof out[f] === 'string') out[f] = cutBytes(out[f], f === 'title' ? 300 : CAP.threadText);
  if (out.startedBy) out.startedBy = { ...out.startedBy, label: cutBytes(String(out.startedBy.label ?? ''), 100), ...(out.startedBy.why !== undefined ? { why: cutBytes(String(out.startedBy.why), 300) } : {}) };
  // The card waiting on Mike is cut, never dropped: the phone shows the
  // thread waiting, and its push goes, with shorter text.
  const card = out.pendingApproval;
  if (card) out.pendingApproval = fitApproval(card, 150);
  for (const f of ['asks', 'next', 'links', 'projects']) {
    if (docBytes(out) <= CAP.threadDoc) break;
    delete out[f];
  }
  // Still too big: option descriptions go, then the card says to answer on the Mac.
  if (card && docBytes(out) > CAP.threadDoc) out.pendingApproval = fitApproval(card, 0);
  if (card && docBytes(out) > CAP.threadDoc) out.pendingApproval = onTheMac(card);
  return docBytes(out) <= CAP.threadDoc ? (out as T) : undefined;
}

// Never what an answer is matched on: a question's text, header and its
// options' labels stay exactly as they are (the runner matches the phone's
// answer by them). Only option descriptions, an approval's title and input
// line, and a secret card's wording are cut.
function fitApproval(p: Record<string, any>, descBytes: number): Record<string, any> {
  const c = (x: unknown, n: number) => cutBytes(String(x ?? ''), n);
  if (p.kind === 'question') return { ...p, questions: (p.questions ?? []).map((q: any) => ({ ...q, options: (q.options ?? []).map((o: any) => ({ label: o.label, ...(o.description !== undefined && descBytes > 0 ? { description: c(o.description, descBytes) } : {}) })) })) };
  if (p.kind === 'secret') return { ...p, label: c(p.label, 200), reason: c(p.reason, 500), ...(p.placeholder !== undefined ? { placeholder: c(p.placeholder, 100) } : {}) };
  return { ...p, title: c(p.title, 300), ...(p.inputSummary !== undefined ? { inputSummary: c(p.inputSummary, 300) } : {}) };
}

// What the phone gets when even that doesn't fit: a card it can't answer
// from, saying where to. (Its push says the same.)
function onTheMac(p: Record<string, any>): Record<string, any> {
  return { approvalId: p.approvalId, kind: 'approval', name: String(p.name ?? p.kind ?? 'question').slice(0, 60), title: p.kind === 'question' ? 'A question is waiting. Answer it on the Mac.' : 'This is waiting for you. Answer it on the Mac.', options: [] };
}

// A runner key's message cut to fit whole (CAP.messageDoc): its text, and
// every other field too.
function fitMessage<T extends Record<string, any>>(m: T): T | undefined {
  const out: Record<string, any> = { ...m, text: cutBytes(String(m.text ?? ''), CAP.message), at: cutBytes(String(m.at ?? ''), 64) };
  for (const f of ['origin', 'toolKind', 'turn']) if (typeof out[f] === 'string') out[f] = cutBytes(out[f], 100);
  if (Array.isArray(out.wokeBy)) out.wokeBy = out.wokeBy.slice(0, 5).map((w: any) => ({ kind: cutBytes(String(w?.kind ?? ''), 40), description: cutBytes(String(w?.description ?? ''), 200) }));
  if (Array.isArray(out.buttons)) out.buttons = out.buttons.slice(0, MESSAGE_BUTTONS).map((b: any) => fitButton(b));
  return docBytes(out) <= CAP.messageDoc ? (out as T) : undefined;
}

// A message links at most this many buttons that the mirror keeps.
const MESSAGE_BUTTONS = 20;
function fitButton(b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { id: cutBytes(String(b.id ?? ''), 16), title: cutBytes(String(b.title ?? ''), 200), kind: b.kind === 'send' ? 'send' : 'start' };
  if (typeof b.target === 'string') out.target = cutBytes(b.target, 200);
  if (typeof b.pressedThreadId === 'string') out.pressedThreadId = cutBytes(b.pressedThreadId, 64);
  if (typeof b.failed === 'string') out.failed = cutBytes(b.failed, 300);
  return out;
}

// Whether a row's buttons already say what the runner sent.
function sameButtons(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function fitIndexRow<T extends Record<string, any>>(r: T): T | undefined {
  const out: Record<string, any> = { ...r };
  for (const f of ['title', 'preview', 'cwd', 'asked']) if (typeof out[f] === 'string') out[f] = cutBytes(out[f], 300);
  if (out.startedBy) out.startedBy = { ...out.startedBy, label: cutBytes(String(out.startedBy.label ?? ''), 100), ...(out.startedBy.why !== undefined ? { why: cutBytes(String(out.startedBy.why), 300) } : {}), ...(out.startedBy.threadTitle !== undefined ? { threadTitle: cutBytes(String(out.startedBy.threadTitle), 200) } : {}) };
  return docBytes(out) <= CAP.indexRow ? (out as T) : undefined;
}

// A runner key's projects cut to fit, ones that still don't left out, and
// at most CAP.projects, open ones first.
function fitProjects<T extends Record<string, any>>(caller: Caller, projects: T[]): T[] {
  if (caller.owner) return projects;
  // One per id (the last given wins), so a list can't repeat its way past the count.
  const byId = new Map<string, T>();
  for (const p of projects) byId.set(String(p.id), p);
  const fit = [...byId.values()].map((p) => fitProject(p)).filter((p): p is T => p !== undefined);
  return [...fit.filter((p) => !p.archived), ...fit.filter((p) => p.archived)].slice(0, CAP.projects);
}

function fitProject<T extends Record<string, any>>(p: T): T | undefined {
  const out: Record<string, any> = { ...p };
  for (const f of ['notes', 'goals', 'state']) if (typeof out[f] === 'string') out[f] = cutBytes(out[f], 8_000);
  out.title = cutBytes(String(out.title ?? ''), 300);
  return docBytes(out) <= CAP.projectDoc ? (out as T) : undefined;
}

// A runner key's pushes: at most CAP.pushesPerMinute a minute, so flipping
// threads to "needs you" can't flood the phone.
async function countMessageBytes(ctx: MutationCtx, runnerId: string, delta: number): Promise<void> {
  const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (usage) await ctx.db.patch(usage._id, { messageBytes: Math.max(0, (usage.messageBytes ?? 0) + delta) });
  else if (delta > 0) await ctx.db.insert('runnerStorage', { runnerId, bytes: 0, messageBytes: delta });
}

async function pushAllowed(ctx: MutationCtx, runnerId: string, now: number): Promise<boolean> {
  const minute = Math.floor(now / 60_000);
  const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  const pushes = usage?.pushMinute === minute ? (usage.pushes ?? 0) : 0;
  if (pushes >= CAP.pushesPerMinute) return false;
  if (usage) await ctx.db.patch(usage._id, { pushMinute: minute, pushes: pushes + 1 });
  else await ctx.db.insert('runnerStorage', { runnerId, bytes: 0, pushMinute: minute, pushes: 1 });
  return true;
}

// Every other runner's sidebar row for a thread, marked gone (watchers drop
// it, pruneOld deletes it a day later).
async function buryIndexRows(ctx: MutationCtx, threadId: string, keepRunnerId: string): Promise<void> {
  for (const row of await ctx.db.query('threadIndex').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).collect()) {
    if (row.runnerId !== keepRunnerId && !row.deleted) await ctx.db.patch(row._id, { deleted: true, updatedMs: Date.now() });
  }
}

// ------------------------------------------------------------ view counts (API 30)
type View = (typeof views)[number];

// Counts a runner's threads from scratch: its first count, and each prune.
async function recountViews(ctx: MutationCtx, runnerId: string): Promise<void> {
  const counts = { hibernating: 0, den: 0, inbox: 0, overflow: 0, total: 0 };
  for await (const t of ctx.db.query('threads').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
    counts[t.view]++;
    counts.total++;
  }
  const row = await ctx.db.query('viewCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (row) await ctx.db.patch(row._id, counts);
  else await ctx.db.insert('viewCounts', { runnerId, ...counts });
}

// A runner's counts, counted from scratch the first time (or for a row from
// before inbox, overflow and total were kept).
async function viewCountsOf(ctx: MutationCtx, runnerId: string) {
  let row = await ctx.db.query('viewCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (!row || row.inbox === undefined || row.overflow === undefined || row.total === undefined) {
    await recountViews(ctx, runnerId);
    row = await ctx.db.query('viewCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  }
  return row!;
}

// A thread written or deleted: called after the write, so a runner with no
// count yet is counted from what's there now, this write included.
async function moveView(ctx: MutationCtx, runnerId: string, from: View | 'overflow' | undefined, to: View | 'overflow' | undefined): Promise<void> {
  if (from === to) return;
  const row = await ctx.db.query('viewCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (!row || row.inbox === undefined || row.overflow === undefined || row.total === undefined) return recountViews(ctx, runnerId);
  const next = { hibernating: row.hibernating, den: row.den, inbox: row.inbox, overflow: row.overflow, total: row.total };
  if (from) next[from] = Math.max(0, next[from] - 1);
  else next.total++;
  if (to) next[to]++;
  else next.total = Math.max(0, next.total - 1);
  await ctx.db.patch(row._id, next);
}

// A list (inbox or hibernating) with room again: its most recent
// overflowed thread comes back to it, without waiting for its next write.
async function refill(ctx: MutationCtx, runnerId: string, view: View | 'overflow' | undefined): Promise<void> {
  if (view !== 'inbox' && view !== 'hibernating') return;
  const back = await ctx.db.query('threads').withIndex('by_runner_want', (q) => q.eq('runnerId', runnerId).eq('wantView', view)).order('desc').first();
  if (!back || back.view !== 'overflow') return;
  await ctx.db.patch(back._id, { view, wantView: undefined, updatedMs: Date.now() });
  await moveView(ctx, runnerId, 'overflow', view);
}

// ------------------------------------------------------------ project links (API 40)
// Brings a thread's projectThreads rows in line with its row: one per
// project it's in. No row (deleted) drops them all. A link never carries
// the thread's activity: keeping that current patched a link on every
// turn, about 35 MB a day of I/O (thread 9b6113da), so a project's threads
// come out by when they joined it and phone:projectThreads sorts the page.
async function linkThread(ctx: MutationCtx, threadId: string, t: { runnerId: string; projects?: { id: string }[] } | null): Promise<void> {
  const want = new Set((t?.projects ?? []).map((p) => p.id));
  for await (const row of ctx.db.query('projectThreads').withIndex('by_threadId', (q) => q.eq('threadId', threadId))) {
    if (!t || !want.has(row.projectId)) {
      await ctx.db.delete(row._id);
      continue;
    }
    want.delete(row.projectId);
    if (row.runnerId !== t.runnerId) await ctx.db.patch(row._id, { runnerId: t.runnerId });
  }
  for (const projectId of want) await ctx.db.insert('projectThreads', { runnerId: t!.runnerId, projectId, threadId });
}

// The project ids on a thread row, in a fixed order, so upsertThreads can
// tell whether its links need touching without reading them.
const projectKey = (t: { projects?: { id: string }[] } | null | undefined) => (t?.projects ?? []).map((p) => p.id).sort().join(' ');

// Links every thread a runner already had when this table arrived, a page
// at a time so no one transaction reads them all. heartbeat starts it once
// per runner (viewCounts.projectsLinked).
const LINK_PAGE = 100;
export const linkProjects = internalMutation({
  args: { runnerId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { runnerId, cursor }) => {
    const page = await ctx.db
      .query('threads')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))
      .paginate({ numItems: LINK_PAGE, cursor });
    for (const t of page.page) await linkThread(ctx, t.threadId, t);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.sync.linkProjects, { runnerId, cursor: page.continueCursor });
    return null;
  },
});

// A push goes out when a thread starts needing Mike (needsYou goes from
// false to true), at most one per thread this often, so a status that
// flaps doesn't ring his phone over and over.
const PUSH_COOLDOWN_MS = 30_000;

export const upsertThreads = mutation({
  args: { key: v.string(), threads: v.array(threadDoc) },
  // skipped: a runner key's rows left out for being over a cap (CAP); the
  // runner logs them and carries on. closed: those of them whose id's old
  // rows are still going (clearThread), for a runner to try again soon.
  returns: v.object({ skipped: v.array(v.string()), closed: v.optional(v.array(v.string())) }),
  handler: async (ctx, { key, threads }) => {
    const caller = await runnerAuth(ctx, key, 'upsertThreads');
    threads = clean(threads);
    const closed: string[] = [];
    const now = Date.now();
    const skipped: string[] = [];
    for (const given of threads) {
      checkRunnerId(given.runnerId);
      const t = caller.owner ? given : fitThread(given);
      if (!t) {
        skipped.push(given.threadId);
        continue;
      }
      const existing = await threadRow(ctx, t.threadId);
      // A runner key writes only its own threads, and never one that's
      // another runner's: the row says where the phone's commands for it go
      // and carries its secret card's key (docs/protocol.md, "Runner keys").
      if (!mayWrite(caller, t.runnerId, existing?.runnerId)) throw forbidden(`write thread ${t.threadId}`);
      // Nor the main key as a runner that has a key of its own (lib.ts actAs).
      if (caller.owner && (await hasLiveKey(ctx, t.runnerId))) throw forbidden(`write threads as runner ${t.runnerId} with the main key, as that runner has a key of its own`);
      // A new row: not under an id another runner has had, or with
      // anything left under it (a pruned thread's messages).
      if (!existing && !(await claimable(ctx, caller, t.threadId))) throw forbidden(`write thread ${t.threadId}`);
      const slug = t.share?.slug;
      if (slug && !(await slugFree(ctx, caller, t.threadId, slug))) throw forbidden('use that share link');
      // The owner writing a thread another runner had (only the owner can):
      // it starts clean, so nothing that runner wrote under the id (its
      // messages, pictures, link, sidebar row) shows as the new one's.
      const transfer = existing !== null && existing.runnerId !== t.runnerId;
      // Its old rows first: with more than this mutation may read, the
      // takeover waits (skipped, sent again) while they go in runs of their
      // own. Likewise any write under an id whose rows are still going.
      if (transfer ? !(await clearThread(ctx, t.threadId, existing.runnerId, existing.share, 'moving')) : await clearingOf(ctx, t.threadId)) {
        skipped.push(t.threadId);
        // Only the owner's: a runner key's thread on its way away isn't worth its trying again.
        if (caller.owner) closed.push(t.threadId);
        continue;
      }
      // A runner key's views are capped (CAP), the most recent in them: past
      // the cap, the view's oldest row moves out of the list (view
      // "overflow", wantView where it belongs), or this one does if it's
      // the oldest. Nothing under either is touched: messages, pictures and
      // share link stay, a read by id still shows the thread where it
      // belongs, and the next write of it brings it back if it's recent.
      // Counted from viewCounts and only the oldest row read: a view with
      // thousands of rows is never read whole here. A new thread past the
      // runner key's total (CAP.threads) waits: left out and said, so the
      // runner sends it again later; nothing is deleted to make room.
      let stored: { view: Doc<'threads'>['view']; wantView?: (typeof views)[number] } = { view: t.view };
      if (!caller.owner) {
        const vc = await viewCountsOf(ctx, t.runnerId);
        if (!existing && (vc.total ?? 0) >= CAP.threads) {
          skipped.push(t.threadId);
          continue;
        }
        if ((t.view === 'inbox' || t.view === 'hibernating') && (!existing || existing.view !== t.view) && (vc[t.view] ?? 0) >= CAP.threadsInView) {
          const oldest = await ctx.db.query('threads').withIndex('by_runner_view', (q) => q.eq('runnerId', t.runnerId).eq('view', t.view)).first();
          if (!oldest || (oldest.lastActivityMs ?? 0) >= (t.lastActivityMs ?? 0)) stored = { view: 'overflow', wantView: t.view };
          else {
            const was = oldest.view;
            await ctx.db.patch(oldest._id, { view: 'overflow', wantView: t.view, updatedMs: now });
            await moveView(ctx, oldest.runnerId, was, 'overflow');
          }
        }
      }
      // The owner making a thread, or taking one over: any other runner's
      // sidebar row for it goes, a fresh insert's included.
      if (caller.owner && (transfer || !existing)) await buryIndexRows(ctx, t.threadId, t.runnerId);
      if (transfer) {
        // That runner's Pocket cards on the thread go too: its text mustn't
        // pass for the new thread's own.
        for (const c of await ctx.db.query('pocketCards').withIndex('by_runnerId', (q) => q.eq('runnerId', existing.runnerId)).collect()) {
          if (c.threadId === t.threadId) await ctx.db.delete(c._id);
        }
      } else if (existing?.share?.slug && existing.share.slug !== slug) await retireSlug(ctx, t.threadId, existing.runnerId, existing.share.slug);
      // A link is one thread's: any other row with it (from before this
      // check) loses it to the owner's.
      if (slug && caller.owner) {
        for (const other of await ctx.db.query('threads').withIndex('by_share_slug', (q) => q.eq('share.slug', slug)).collect()) {
          if (other.threadId !== t.threadId) await ctx.db.patch(other._id, { share: undefined, updatedMs: now });
        }
      }
      const before = transfer ? null : existing;
      const wantsPush = t.needsYou && before !== null && !before.needsYou && (before.pushedAt ?? 0) < now - PUSH_COOLDOWN_MS;
      // A held push stays held only while the thread still needs Mike.
      const held = t.needsYou && before?.pushHeldAt && !wantsPush ? { pushHeldAt: before.pushHeldAt } : {};
      const row = { ...t, ...stored, updatedMs: now };
      // What it was, read before the write replaces the row.
      const was = existing ? { view: existing.view, runnerId: existing.runnerId } : undefined;
      if (existing) await ctx.db.replace(existing._id, { ...row, ...(wantsPush ? { pushedAt: now } : before?.pushedAt ? { pushedAt: before.pushedAt } : {}), ...held });
      else await ctx.db.insert('threads', row);
      if (transfer && was) {
        await moveView(ctx, was.runnerId, was.view, undefined);
        await moveView(ctx, t.runnerId, undefined, row.view);
      } else {
        await moveView(ctx, t.runnerId, was?.view, row.view);
        // It left a capped list: an overflowed one takes the room.
        if (was && was.view !== row.view) await refill(ctx, t.runnerId, was.view);
      }
      // Most writes are a status flip in the same projects: only a new
      // thread, one taken over, or one whose projects changed reads its links.
      if (!existing || transfer || projectKey(existing) !== projectKey(row)) await linkThread(ctx, t.threadId, row);
      if (wantsPush && (caller.owner || (await pushAllowed(ctx, t.runnerId, now)))) await ctx.scheduler.runAfter(0, internal.push.notify, { threadId: t.threadId });
    }
    return { skipped, ...(closed.length ? { closed } : {}) };
  },
});

// Whether Mike is at this runner's Mac, sent by the runner when it changes
// (API 3). Leaving sends the pushes that were held back while he was there,
// for threads that still need him.
export const setPresence = mutation({
  args: { key: v.string(), runnerId: v.string(), atMac: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, atMac }) => {
    const caller = await runnerAuth(ctx, key, 'setPresence');
    await actAs(ctx, caller, runnerId);
    const runner = await ctx.db
      .query('runners')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))
      .unique();
    if (runner) await ctx.db.patch(runner._id, { atMac, atMacAt: Date.now() });
    if (atMac) return null;
    // Only rows with a held push: reading all of them grew with every
    // thread kept (docs/convex-backend.md, "Usage and the free plan").
    const held = await ctx.db
      .query('threads')
      .withIndex('by_runner_pushHeld', (q) => q.eq('runnerId', runnerId).gt('pushHeldAt', 0))
      .collect();
    for (const t of held) {
      await ctx.db.patch(t._id, { pushHeldAt: undefined });
      if (t.needsYou) await ctx.scheduler.runAfter(0, internal.push.notify, { threadId: t.threadId, held: true });
    }
    return null;
  },
});

export const removeThreads = mutation({
  args: { key: v.string(), threadIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, threadIds }) => {
    const caller = await runnerAuth(ctx, key, 'removeThreads');
    for (const threadId of threadIds) {
      const row = await ctx.db
        .query('threads')
        .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
        .unique();
      // A runner key leaves alone what isn't its own thread, there or not (ownThread).
      if (!caller.owner && !(row && mayTouch(caller, row.runnerId))) continue;
      await dropThread(ctx, threadId, row);
    }
    return null;
  },
});

// ------------------------------------------------------------ reply pictures
// What an agent showed Mike, for the phone (API 24; schema.ts, replyImages):
// the runner asks what's up (replyImages), uploads each new file to an upload
// URL (iconUploadUrl) and records it (addReplyImage).

export const replyImages = query({
  args: { key: v.string(), threadId: v.string() },
  returns: v.array(v.object({ seq: v.number(), path: v.string() })),
  handler: async (ctx, { key, threadId }) => {
    const caller = await runnerAuth(ctx, key, 'replyImages');
    // Its id's old rows still going: none of them count as sent, so the runner sends its own.
    if ((await ownThread(ctx, caller, threadId)) === 'none' || (await closedId(ctx, threadId))) return [];
    const out = [];
    for await (const img of ctx.db.query('replyImages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId))) out.push({ seq: img.seq, path: img.path });
    return out;
  },
});

export const addReplyImage = mutation({
  args: {
    key: v.string(),
    threadId: v.string(),
    seq: v.number(),
    path: v.string(),
    src: v.optional(v.string()),
    pinned: v.optional(v.boolean()),
    storageId: v.id('_storage'),
    mediaType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  returns: pictureAnswer,
  handler: async (ctx, { key, ...sent }) => {
    const caller = await runnerAuth(ctx, key, 'addReplyImage');
    checkPicture(caller, sent);
    const img = clean(sent);
    const mine = await ownThread(ctx, caller, img.threadId);
    await mustMayUseStorage(ctx, caller, img.storageId);
    // No row to put it on: the upload goes, unless something else has it.
    if (mine === 'none') return (await freeStorage(ctx, caller, img.storageId), null);
    // Its id's old rows still going (only the owner gets here): so does this
    // upload, and the runner keeps the picture to send again.
    if (await closedId(ctx, img.threadId)) return (await freeStorage(ctx, caller, img.storageId), { later: true as const });
    // Sent twice (a retry after a lost reply): keep the first, drop the copy.
    const same = await ctx.db
      .query('replyImages')
      .withIndex('by_thread_seq', (q) => q.eq('threadId', img.threadId).eq('seq', img.seq))
      .filter((q) => q.eq(q.field('path'), img.path))
      .first();
    if (same) await freeStorage(ctx, caller, img.storageId);
    else {
      await mustBeUnnamed(ctx, caller, img.storageId);
      await ctx.db.insert('replyImages', img);
    }
    return null;
  },
});

// ------------------------------------------------------------ shared pictures
// A shared thread's pictures (API 8; docs/website.md, "Sharing"): the runner
// asks what's up (shareImages), uploads each new file to an upload URL
// (iconUploadUrl serves for these too) and records it (addShareImage).
// When the thread stops being shared it drops them all.

// The thread is the caller's (dropShareImages checks), so its pictures are too.
async function dropImages(ctx: MutationCtx, threadId: string): Promise<number> {
  let n = 0;
  for await (const img of ctx.db.query('shareImages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId))) {
    await ctx.db.delete(img._id);
    await deleteIfUnused(ctx, img.storageId);
    n++;
  }
  return n;
}

export const shareImages = query({
  args: { key: v.string(), threadId: v.string() },
  returns: v.array(v.object({ seq: v.number(), path: v.string() })),
  handler: async (ctx, { key, threadId }) => {
    const caller = await runnerAuth(ctx, key, 'shareImages');
    if ((await ownThread(ctx, caller, threadId)) === 'none' || (await closedId(ctx, threadId))) return [];
    const out = [];
    for await (const img of ctx.db.query('shareImages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId))) out.push({ seq: img.seq, path: img.path });
    return out;
  },
});

export const addShareImage = mutation({
  args: {
    key: v.string(),
    threadId: v.string(),
    seq: v.number(),
    path: v.string(),
    src: v.optional(v.string()),
    storageId: v.id('_storage'),
    mediaType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  returns: pictureAnswer,
  handler: async (ctx, { key, ...sent }) => {
    const caller = await runnerAuth(ctx, key, 'addShareImage');
    checkPicture(caller, sent);
    const img = clean(sent);
    const mine = await ownThread(ctx, caller, img.threadId);
    await mustMayUseStorage(ctx, caller, img.storageId);
    if (mine === 'none') return (await freeStorage(ctx, caller, img.storageId), null);
    if (await closedId(ctx, img.threadId)) return (await freeStorage(ctx, caller, img.storageId), { later: true as const });
    // Sent twice (a retry after a lost reply): keep the first, drop the copy.
    const same = await ctx.db
      .query('shareImages')
      .withIndex('by_thread_seq', (q) => q.eq('threadId', img.threadId).eq('seq', img.seq))
      .filter((q) => q.eq(q.field('path'), img.path))
      .first();
    if (same) await freeStorage(ctx, caller, img.storageId);
    else {
      await mustBeUnnamed(ctx, caller, img.storageId);
      await ctx.db.insert('shareImages', img);
    }
    return null;
  },
});

export const dropShareImages = mutation({
  args: { key: v.string(), threadId: v.string() },
  returns: v.number(),
  handler: async (ctx, { key, threadId }) => {
    const caller = await runnerAuth(ctx, key, 'dropShareImages');
    if ((await ownThread(ctx, caller, threadId)) === 'none') return 0;
    return dropImages(ctx, threadId);
  },
});

// After a runner has written everything it has: rows of its that it no
// longer knows (deleted while it was offline) go.
export const prune = mutation({
  args: { key: v.string(), runnerId: v.string(), keep: v.array(v.string()) },
  returns: v.number(),
  handler: async (ctx, { key, runnerId, keep }) => {
    const caller = await runnerAuth(ctx, key, 'prune');
    await actAs(ctx, caller, runnerId);
    const keepSet = new Set(keep);
    let n = 0;
    const gone = [];
    for await (const row of ctx.db.query('threads').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) if (!keepSet.has(row.threadId)) gone.push(row);
    // As removeThreads: its messages and pictures go with it, and the id
    // gets a tombstone, so nothing private is left under it for another
    // runner's key to pick up with a row of its own.
    for (const row of gone) {
      await dropThread(ctx, row.threadId, row);
      n++;
    }
    await recountViews(ctx, runnerId);
    return n;
  },
});

// The ids of a runner's rows that are shared by link, so anyone with the slug
// can read them (share.ts). The runner checks them against its own threads on
// every start and every hour after (runner/src/sync.ts reconcileShares): one
// it has deleted goes, and one it has stopped sharing is written again. Only
// the shared rows are read, by index (API 60).
export const sharedThreads = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'sharedThreads');
    await actAs(ctx, caller, runnerId);
    const out: string[] = [];
    for await (const row of ctx.db.query('threads').withIndex('by_runner_share', (q) => q.eq('runnerId', runnerId).eq('share.access', 'link'))) out.push(row.threadId);
    return out;
  },
});

export const heartbeat = mutation({
  args: {
    key: v.string(),
    runner: v.object({
      runnerId: v.string(),
      name: v.string(),
      version: v.string(),
      release: v.optional(v.string()),
      startedAt: v.string(),
      draining: v.boolean(),
      threadCount: v.number(),
      icon: v.optional(v.string()),
      rpcUrl: v.optional(v.string()),
      pressure: v.optional(v.union(v.literal('memory'), v.literal('disk'))),
    }),
  },
  // The backend's API version (version.ts), so the runner can tell when it's
  // talking to an older backend than it was built for. firstSeen (API 37):
  // this deployment had no row for this runner, so a runner that thinks it has
  // written everything (sync-cache.ts) knows to write it again.
  // ownerKeyRotating (owner key only): RUNNER_KEY_NEXT is still set, which
  // tb status says, as it should only last while tb runner rotate-owner runs.
  // pushFailing (owner key only): pushes from this backend haven't got
  // through lately, and why (pushHealth.ts), for tb status and the app.
  // pushOff: it can't send any (pushHealth.ts pushOff), for the same.
  returns: v.object({
    apiVersion: v.number(),
    firstSeen: v.optional(v.boolean()),
    ownerKeyRotating: v.optional(v.boolean()),
    pushOff: v.optional(v.boolean()),
    pushFailing: v.optional(v.object({ failure: v.string(), since: v.number(), failed: v.number(), via: v.union(v.literal('apple'), v.literal('relay')) })),
  }),
  handler: async (ctx, { key, runner }) => {
    const caller = await runnerAuth(ctx, key, 'heartbeat');
    runner = clean(runner);
    // A runner key heartbeats as its own runner only: the row has the
    // rpcUrl other Macs' apps dial.
    await actAs(ctx, caller, runner.runnerId);
    // A runner key's heartbeat fields are cut to fit, never refused: a
    // refused heartbeat would leave that Mac showing offline.
    if (!caller.owner) for (const field of ['version', 'release', 'startedAt', 'icon', 'rpcUrl'] as const) if (typeof runner[field] === 'string') (runner as Record<string, unknown>)[field] = cutBytes(runner[field], CAP.runnerField);
    // The Mac app reads startedAt as a time and the count as a number, so
    // anything else is left out rather than passed on (an offset of
    // "+////" once crashed the app's date parser; Daybreak, 7 Nov 2026).
    // The app checks them too, for rows written before this.
    if (!caller.owner) runner = { ...runner, startedAt: isIsoTime(runner.startedAt) ? runner.startedAt : '', threadCount: wholeIn(runner.threadCount, 1_000_000) ? runner.threadCount : 0 };
    const name = caller.owner ? runner.name : await uniqueName(ctx, runner.runnerId, runner.name);
    const row = { ...runner, name, lastSeenAt: Date.now(), ...(caller.owner ? { byOwner: true } : {}) };
    const existing = await ctx.db
      .query('runners')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', runner.runnerId))
      .unique();
    // Presence is setPresence's to change; a heartbeat keeps it.
    if (existing) await ctx.db.replace(existing._id, { ...row, wakesSeeded: true, ...(existing.atMac !== undefined ? { atMac: existing.atMac, atMacAt: existing.atMacAt } : {}) });
    else await ctx.db.insert('runners', { ...row, wakesSeeded: true });
    // API 45: once per runner, its schedules from before scheduleWakes.
    if (!existing?.wakesSeeded) await seedWakes(ctx, runner.runnerId);
    // A runner from before view counts gets its count within a minute of
    // this backend, without waiting for a thread to change.
    if (!(await ctx.db.query('viewCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runner.runnerId)).unique())) await recountViews(ctx, runner.runnerId);
    // API 40: link the threads it had before projectThreads, once. Marked
    // before it runs, so the next heartbeat doesn't start a second pass.
    const counted = await ctx.db.query('viewCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runner.runnerId)).unique();
    if (counted && !counted.projectsLinked) {
      await ctx.db.patch(counted._id, { projectsLinked: true });
      await ctx.scheduler.runAfter(0, internal.sync.linkProjects, { runnerId: runner.runnerId, cursor: null });
    }
    // API 48: every project from before projectHeads, once.
    await seedHeads(ctx);
    // 7 Nov 2026: rows from before the backend's limits, once (limitsMigration).
    await startLimitsMigration(ctx);
    const failing = caller.owner ? pushFailing(await ctx.db.query('pushHealth').first(), Date.now()) : null;
    return { apiVersion: API_VERSION, ...(existing ? {} : { firstSeen: true }), ...(caller.owner && process.env.RUNNER_KEY_NEXT ? { ownerKeyRotating: true } : {}), ...(caller.owner && pushOff(process.env) ? { pushOff: true } : {}), ...(failing ? { pushFailing: failing } : {}) };
  },
});

// A runner key's runner can't go by another runner's name in the phone's
// and the app's lists (so Mike sends a thread to the wrong Mac). Its name is
// folded first (runnerAccess.ts normalName: printable ASCII, curly quotes
// made straight, at most 40 characters), never refused: one with nothing
// left goes by its runner id. One that looks like another runner's
// (nameSkeleton: case, "rn" for "m", 0 for O, 1 for l) gets its id after it,
// and the name it ends with is checked the same way.
async function uniqueName(ctx: MutationCtx, runnerId: string, raw: string): Promise<string> {
  const name = normalName(raw) || runnerId;
  const taken = new Set<string>();
  for await (const r of ctx.db.query('runners')) if (r.runnerId !== runnerId) taken.add(nameSkeleton(r.name));
  // The base is cut so the suffix always fits; a few tries, then the id alone
  // (unique among runners by itself), so this always ends.
  const base = (suffix: string) => `${name.slice(0, Math.max(1, NAME_CHARS - suffix.length)).trim()}${suffix}`;
  for (const suffix of ['', ` (${runnerId.slice(0, 6)})`, ` (${runnerId})`, ` (${runnerId}) 2`, ` (${runnerId}) 3`]) {
    const candidate = base(suffix);
    if (!taken.has(nameSkeleton(candidate))) return candidate;
  }
  return runnerId;
}

// ------------------------------------------------------------ runner figures (API 45)
// Until when someone has the website's Runners view open (phone:watchRunners).
// A runner subscribes, and reports only while this is in the future.
export const runnerWatch = query({
  args: { key: v.string() },
  returns: v.union(v.null(), v.object({ until: v.number() })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnerWatch');
    const row = await ctx.db.query('runnerWatch').first();
    return row ? { until: row.until } : null;
  },
});

// The Mac app's runner details are open (API 46): the same watch as the
// website's (phone:watchRunners), through the main Mac's runner. Owner only,
// as it wakes every runner.
export const watchRunnersFromMac = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'watchRunnersFromMac');
    await watchRunnersFor(ctx);
    return null;
  },
});

// Every runner's latest figures for the Mac app's Runners panel (API 46), as
// phone:runnerStats gives them to the website. Owner only: they're every
// runner's.
export const runnerStatsList = query({
  args: { key: v.string() },
  returns: v.array(v.object({ runnerId: v.string(), at: v.string(), cpuPercent: v.number(), cores: v.number(), memUsed: v.number(), memTotal: v.number(), diskFree: v.number(), diskTotal: v.number(), load1: v.optional(v.number()), uptimeSec: v.number(), machine: v.optional(v.string()), os: v.optional(v.string()) })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnerStatsList');
    return runnerStatsRows(ctx);
  },
});

export const setRunnerStats = mutation({
  args: {
    key: v.string(),
    runnerId: v.string(),
    stats: v.object({
      cpuPercent: v.number(),
      cores: v.number(),
      memUsed: v.number(),
      memTotal: v.number(),
      diskFree: v.number(),
      diskTotal: v.number(),
      load1: v.optional(v.number()),
      uptimeSec: v.number(),
      machine: v.optional(v.string()),
      os: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, stats }) => {
    // A runner key reports for its own runner only, and its labels are cut to
    // fit, as its heartbeat's are.
    const caller = await runnerAuth(ctx, key, 'setRunnerStats');
    await actAs(ctx, caller, runnerId);
    const cleaned = clean(stats);
    // Another runner's figures reach the Mac app's Swift, where Int(1e20)
    // stopped it (Daybreak, 7 Nov 2026), so they're checked from any key.
    const bad = badRunnerStats(cleaned);
    if (bad) throw new ConvexError({ kind: 'badArgs', message: bad });
    const labels = caller.owner ? {} : { ...(cleaned.machine !== undefined ? { machine: cutBytes(cleaned.machine, 128) } : {}), ...(cleaned.os !== undefined ? { os: cutBytes(cleaned.os, 128) } : {}) };
    const row = { runnerId, at: Date.now(), ...cleaned, ...labels };
    const existing = await ctx.db.query('runnerStats').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert('runnerStats', row);
    return null;
  },
});

// A runner stopping for good (not handing over) says so, so the phone
// shows it offline at once rather than 3 minutes later.
export const bye = mutation({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'bye');
    await actAs(ctx, caller, runnerId);
    const existing = await ctx.db
      .query('runners')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { lastSeenAt: 0 });
    return null;
  },
});

// For the runner's own checks and tests: what's mirrored for a runner.
export const threadsOf = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.object({ ...threadFields, view: v.union(...views.map((x) => v.literal(x))) })),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'threadsOf');
    await actAs(ctx, caller, runnerId);
    const out = [];
    for await (const row of ctx.db.query('threads').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
      const { _id, _creationTime, pushedAt: _p, pushHeldAt: _h, updatedMs: _u, wantView, ...rest } = row;
      out.push({ ...rest, view: rest.view === 'overflow' ? (wantView ?? 'inbox') : rest.view });
    }
    return out;
  },
});

export const runnersList = query({
  args: { key: v.string() },
  returns: v.array(
    v.object({
      runnerId: v.string(),
      name: v.string(),
      version: v.string(),
      release: v.optional(v.string()),
      startedAt: v.string(),
      draining: v.boolean(),
      threadCount: v.number(),
      lastSeenAt: v.number(),
      icon: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnersList');
    const out = [];
    // Picked by name: the row keeps fields of its own (atMac and atMacAt,
    // from setPresence), and returning one fails the validator.
    for await (const r of ctx.db.query('runners')) {
      out.push({
        runnerId: r.runnerId,
        name: r.name,
        version: r.version,
        ...(r.release !== undefined ? { release: r.release } : {}),
        startedAt: r.startedAt,
        draining: r.draining,
        threadCount: r.threadCount,
        lastSeenAt: r.lastSeenAt,
        ...(r.icon !== undefined ? { icon: r.icon } : {}),
      });
    }
    return out;
  },
});

// ------------------------------------------------------------ tokens
// The Mac app's Settings › Phone & browser, through the runner (API 6;
// docs/protocol.md "Devices"): issues the token a new phone or browser
// holds, lists them, revokes one. The plain token goes back in the reply
// that issued it and nowhere else.

export const issueToken = mutation({
  args: { key: v.string(), kind: tokenKind, name: v.string(), days: v.optional(v.number()) },
  returns: v.object({ id: v.string(), token: v.string(), expiresAt: v.string() }),
  handler: async (ctx, { key, kind, name, days }) => {
    await runnerAuth(ctx, key, 'issueToken');
    const trimmed = clean(name.trim().slice(0, 80));
    if (!trimmed) throw new ConvexError({ kind: 'badArgs', message: 'name must not be blank' });
    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > MAX_DAYS)) throw new ConvexError({ kind: 'badArgs', message: `days must be 1 to ${MAX_DAYS}` });
    // Which main key made it, so an audit after a rotation can tell (tb runner audit).
    return makeToken(ctx, { kind, name: trimmed, days, issuedBy: 'owner', ownerKeyPrint: (await sha256(key)).slice(0, 8) });
  },
});

export const listTokens = query({
  args: { key: v.string() },
  returns: v.array(tokenInfo),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'listTokens');
    return allTokens(ctx);
  },
});

export const revokeToken = mutation({
  args: { key: v.string(), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { key, id }) => {
    await runnerAuth(ctx, key, 'revokeToken');
    return revokeOne(ctx, id);
  },
});

// ------------------------------------------------------------ messages

const messageDoc = v.object({
  threadId: v.string(),
  seq: v.number(),
  role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool')),
  text: v.string(),
  origin: v.optional(v.string()),
  toolKind: v.optional(v.string()),
  summary: v.optional(v.boolean()), // API 14
  turn: v.optional(v.string()), // API 26
  wokeBy: v.optional(v.array(v.object({ kind: v.string(), description: v.string() }))), // API 33
  buttons: v.optional(v.array(messageButton)), // API 59
  at: v.string(),
  pagedAt: v.optional(v.number()), // an old phone asked for it (loadEarlier): phone:thread shows it for a day
});

// Adds messages (text, and one line per tool call), keyed by seq so writing
// one twice is harmless. Every message is kept (until API 2 only the newest
// 20 were). A row sent again with pagedAt is an old phone's "Load earlier
// messages", so the mark goes on the row that's already there.
// skipped: a runner key's messages that wait for room ("<threadId>:<seq>"),
// which the runner doesn't count as sent and sends again.
export const appendMessages = mutation({
  args: { key: v.string(), messages: v.array(messageDoc) },
  returns: v.object({ skipped: v.array(v.string()), closed: v.optional(v.array(v.string())) }),
  handler: async (ctx, { key, messages }) => {
    const caller = await runnerAuth(ctx, key, 'appendMessages');
    messages = clean(messages);
    const checked = new Map<string, 'yes' | 'none'>();
    const skipped: string[] = [];
    const closed = new Set<string>();
    const insertedNow = new Set<string>();
    let evicted = 0;
    for (const given of messages) {
      // A runner key's message for a thread with no row is dropped: it
      // would show in whatever thread is made under that id later.
      if (!checked.has(given.threadId)) checked.set(given.threadId, await ownThread(ctx, caller, given.threadId));
      if (checked.get(given.threadId) === 'none') continue;
      // Rows still going under the id (clearThread): the owner's wait, and
      // are sent again (closed tells the runner to, whatever came after them).
      if (caller.owner && (await closedId(ctx, given.threadId))) {
        skipped.push(`${given.threadId}:${given.seq}`);
        closed.add(given.threadId);
        continue;
      }
      // Cut to fit whole rather than refused (CAP): the runner cuts text at 8,000 characters itself.
      const m = caller.owner ? given : fitMessage(given);
      if (!m) continue;
      const existing = await ctx.db
        .query('messages')
        .withIndex('by_thread_seq', (q) => q.eq('threadId', m.threadId).eq('seq', m.seq))
        .unique();
      if (!existing) {
        // A runner key's messages stay within CAP.messageBytes: past it, its
        // oldest anywhere go first, before this one goes in (so a new
        // thread's are never the ones lost), at most CAP.evictPerWrite a
        // call; one there's still no room for waits (skipped, sent again).
        if (!caller.owner) {
          const doc = { ...m, runnerId: caller.runnerId };
          const size = docBytes(doc);
          let usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId)).unique();
          let used = usage?.messageBytes ?? 0;
          while (used + size > CAP.messageBytes && evicted < CAP.evictPerWrite) {
            const oldest = await ctx.db.query('messages').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId)).first();
            // Only older ones than this call's: never one it has just put in.
            if (!oldest || insertedNow.has(String(oldest._id))) break;
            await ctx.db.delete(oldest._id);
            used = Math.max(0, used - storedBytes(oldest));
            evicted++;
          }
          if (used + size > CAP.messageBytes) {
            if (usage) await ctx.db.patch(usage._id, { messageBytes: used });
            skipped.push(`${m.threadId}:${m.seq}`);
            continue;
          }
          if (usage) await ctx.db.patch(usage._id, { messageBytes: used + size });
          else await ctx.db.insert('runnerStorage', { runnerId: caller.runnerId, bytes: 0, messageBytes: size });
          insertedNow.add(String(await ctx.db.insert('messages', doc)));
        } else await ctx.db.insert('messages', m);
      }
      // The owner's own message at a seq is the real one: one something else
      // put there first (the old shared key, at a seq the thread hadn't
      // reached) is written over when the runner sends it again.
      else if (caller.owner && (existing.text !== m.text || existing.role !== m.role)) await ctx.db.replace(existing._id, { ...m, ...(m.pagedAt ?? existing.pagedAt ? { pagedAt: m.pagedAt ?? existing.pagedAt } : {}) });
      else {
        // A row sent again for its buttons (API 59: one was pressed) changes
        // only them, so what woke the turn and an old phone's paged mark stay.
        // From before API 59 no row carries any, and an older runner never
        // sends one again, so nothing here clears them.
        const patch: Partial<Doc<'messages'>> = {};
        if (m.pagedAt && !existing.pagedAt) patch.pagedAt = m.pagedAt;
        const buttons = keepPresses(existing.buttons, m.buttons);
        if (!sameButtons(existing.buttons, buttons)) patch.buttons = buttons;
        if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      }
    }
    return { skipped, ...(closed.size ? { closed: [...closed] } : {}) };
  },
});

// A press is final: a slower, older send of the row (one queued before the
// press) mustn't turn a pressed button back into one that can be pressed
// (Codex's review, 7 Nov 2026).
function keepPresses<B extends { id: string; pressedThreadId?: string; failed?: string }>(old: B[] | undefined, next: B[] | undefined): B[] | undefined {
  if (!old?.length || !next) return next;
  return next.map((b) => {
    const was = old.find((o) => o.id === b.id);
    if (!was?.pressedThreadId || b.pressedThreadId) return b;
    const { failed: _failed, ...rest } = b;
    return { ...rest, pressedThreadId: was.pressedThreadId } as B;
  });
}

// The newest message seq per thread of a runner, so a runner starting up
// only sends what the mirror doesn't have.
export const messageHeads = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.object({ threadId: v.string(), lastSeq: v.number() })),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'messageHeads');
    await actAs(ctx, caller, runnerId);
    const out = [];
    for await (const t of ctx.db.query('threads').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
      const newest = await ctx.db
        .query('messages')
        .withIndex('by_thread_seq', (q) => q.eq('threadId', t.threadId))
        .order('desc')
        .first();
      if (newest) out.push({ threadId: t.threadId, lastSeq: newest.seq });
    }
    return out;
  },
});

// ------------------------------------------------------------ lists
// Projects, schedules and accounts: the runner sends its whole list each
// time one changes, and the rows of that runner are replaced.

const projectDoc = v.object({
  id: v.string(),
  title: v.string(),
  folders: v.array(v.string()),
  goals: v.string(),
  state: v.string(),
  notes: v.string(),
  createdBy: v.string(),
  archived: v.boolean(),
  createdAt: v.string(),
  updatedAt: v.string(),
  threadCount: v.number(),
  lastActivityAt: v.optional(v.string()),
  icon: v.optional(v.object({ symbol: v.optional(v.string()), picture: v.optional(v.string()), by: v.string() })),
});

const scheduleDoc = v.object({
  id: v.string(),
  title: v.string(),
  text: v.string(),
  at: v.optional(v.string()),
  cron: v.optional(v.string()),
  timezone: v.optional(v.string()),
  whenText: v.string(),
  threadId: v.optional(v.string()),
  cwd: v.optional(v.string()),
  accountId: v.optional(v.string()),
  model: v.optional(v.string()),
  paused: v.boolean(),
  createdAt: v.string(),
  updatedAt: v.string(),
  nextRunAt: v.optional(v.string()),
  finishedAt: v.optional(v.string()),
  runs: v.number(),
  lastRun: v.optional(v.object({ at: v.string(), outcome: v.string(), threadId: v.optional(v.string()), note: v.optional(v.string()) })),
});

const accountDoc = v.object({
  id: v.string(),
  provider: v.string(),
  title: v.string(),
  note: v.optional(v.string()),
  email: v.optional(v.string()),
  plan: v.optional(v.string()),
  defaultModel: v.optional(v.string()),
  // API 20: what the phone's new thread pickers offer.
  models: v.optional(v.array(v.object({ id: v.string(), title: v.string(), effortLevels: v.optional(v.array(v.string())), defaultEffort: v.optional(v.string()) }))),
  defaultEffort: v.optional(v.string()),
  usage: v.optional(
    v.object({
      windows: v.array(v.object({ kind: v.string(), title: v.string(), remainingPercent: v.number(), resetsAt: v.optional(v.string()), detail: v.optional(v.string()) })),
      readAt: v.string(),
      source: v.string(),
      stale: v.optional(v.boolean()),
      blocked: v.optional(v.boolean()),
      notice: v.optional(v.string()),
    }),
  ),
});

async function replaceRows(ctx: { db: any }, table: 'projects' | 'schedules' | 'accounts', runnerId: string, rows: Record<string, unknown>[]): Promise<void> {
  for await (const row of ctx.db.query(table).withIndex('by_runnerId', (q: any) => q.eq('runnerId', runnerId))) await ctx.db.delete(row._id);
  for (const row of rows) await ctx.db.insert(table, { ...row, runnerId });
}

export const setProjects = mutation({
  args: { key: v.string(), runnerId: v.string(), projects: v.array(projectDoc) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, projects: given }) => {
    const caller = await runnerAuth(ctx, key, 'setProjects');
    given = clean(given);
    await actAs(ctx, caller, runnerId);
    const projects = fitProjects(caller, given);
    // Notes in projectNotes (API 50), the rows without them.
    await replaceRows(ctx, 'projects', runnerId, projects.map((p) => ({ ...p, notes: '' })));
    await syncNotes(ctx, runnerId, projects);
    await syncHeads(ctx, runnerId, projects.map((p) => ({ ...p, runnerId })));
    // A picture for a project that's gone, or that has no picture any more,
    // goes with it. One the runner hasn't replaced yet stays, so the phone
    // keeps showing the old picture rather than a letter meanwhile.
    const wanted = new Set(projects.filter((p) => p.icon?.picture).map((p) => p.id));
    for await (const row of ctx.db.query('projectIcons').withIndex('by_runner_project', (q) => q.eq('runnerId', runnerId))) {
      if (wanted.has(row.projectId)) continue;
      await ctx.db.delete(row._id);
      await freeStorage(ctx, caller, row.storageId);
    }
    return null;
  },
});

// API 30: only the projects that changed since the runner last wrote them,
// and the ones gone. A project's lastActivityAt moves with every turn in it,
// and setProjects rewrote every project (Mike's, with long notes, about
// 460 KB a time) for each. The runner still sends the whole list with
// setProjects once after it starts.
//
// API 50: a project's notes are left out when they haven't changed, and live
// in projectNotes, so the rest of a project changing doesn't rewrite them.
const projectChange = v.object({ ...projectDoc.fields, notes: v.optional(v.string()) });

export const upsertProjects = mutation({
  args: { key: v.string(), runnerId: v.string(), projects: v.array(projectChange), removed: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, projects: given, removed }) => {
    const caller = await runnerAuth(ctx, key, 'upsertProjects');
    given = clean(given);
    await actAs(ctx, caller, runnerId);
    const one = (id: string) => ctx.db.query('projects').withIndex('by_runner_id', (q) => q.eq('runnerId', runnerId).eq('id', id)).unique();
    // As setProjects: a picture goes when its project does, or has none now.
    const dropIcon = async (projectId: string) => {
      const icon = await ctx.db.query('projectIcons').withIndex('by_runner_project', (q) => q.eq('runnerId', runnerId).eq('projectId', projectId)).unique();
      if (!icon) return;
      await ctx.db.delete(icon._id);
      await freeStorage(ctx, caller, icon.storageId);
    };
    let projects = fitProjects(caller, given);
    if (!caller.owner) {
      // New ones past the cap are left out, as setProjects would.
      const ids = new Set((await ctx.db.query('projects').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(CAP.projects + 1)).map((p) => p.id));
      for (const id of removed) ids.delete(id);
      projects = projects.filter((p) => {
        if (ids.has(p.id)) return true;
        if (ids.size >= CAP.projects) return false;
        ids.add(p.id);
        return true;
      });
    }
    for (const { notes, ...p } of projects) {
      const existing = await one(p.id);
      // Notes left out are as they were: in projectNotes, or still in an
      // older row, from which they move out now.
      if (notes !== undefined) await putNotes(ctx, runnerId, p.id, notes);
      else if (existing?.notes) await putNotes(ctx, runnerId, p.id, existing.notes);
      const doc = { ...p, notes: '', runnerId };
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert('projects', doc);
      await syncHead(ctx, { ...p, runnerId });
      if (!p.icon?.picture) await dropIcon(p.id);
    }
    for (const id of removed) {
      const existing = await one(id);
      if (existing) await ctx.db.delete(existing._id);
      await dropHead(ctx, runnerId, id);
      await dropNotes(ctx, runnerId, id);
      await dropIcon(id);
    }
    return null;
  },
});

// ------------------------------------------------------------ project icons
// The runner puts each project's picture in file storage (API 5): it asks
// for an upload URL, POSTs the bytes there, then records the storage id
// against the project. projectIcons says what it has already sent, so a
// restart doesn't send every picture again.

export const projectIcons = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.object({ projectId: v.string(), picture: v.string() })),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'projectIcons');
    await actAs(ctx, caller, runnerId);
    const out = [];
    for await (const row of ctx.db.query('projectIcons').withIndex('by_runner_project', (q) => q.eq('runnerId', runnerId))) {
      out.push({ projectId: row.projectId, picture: row.picture });
    }
    return out;
  },
});

// A runner key gets a one-use URL on this deployment's own HTTP route
// (convex/http.ts /runner/upload), which stores the file and records it as
// that runner's (storageOwners), so the key can later attach it, and only
// it. At most UPLOADS_PER_HOUR an hour; one never attached goes after a day
// (pruneOld). The owner key gets Convex's own upload URL, as before.
const UPLOADS_PER_HOUR = 300;
const TICKET_MS = 60 * 60_000;

export const iconUploadUrl = mutation({
  args: { key: v.string() },
  returns: v.string(),
  handler: async (ctx, { key }) => {
    const caller = await runnerAuth(ctx, key, 'iconUploadUrl');
    if (caller.owner) return ctx.storage.generateUploadUrl();
    const now = Date.now();
    const recent = await ctx.db.query('uploadTickets').withIndex('by_runner_issued', (q) => q.eq('runnerId', caller.runnerId).gte('issuedAt', now - TICKET_MS)).collect();
    if (recent.length >= UPLOADS_PER_HOUR) throw new ConvexError({ kind: 'rateLimited', message: `This runner's key has had ${UPLOADS_PER_HOUR} upload URLs in the last hour; try again later.` });
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new ConvexError({ kind: 'config', message: 'CONVEX_SITE_URL is not set' });
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await ctx.db.insert('uploadTickets', { ticketHash: await sha256(ticket), runnerId: caller.runnerId, ...(caller.keyId ? { keyId: caller.keyId as Id<'runnerKeys'> } : {}), issuedAt: now });
    return `${site.replace(/\/+$/, '')}/runner/upload?ticket=${ticket}`;
  },
});

// Unused, under an hour old, and its key still live: revoking or replacing
// a key ends the uploads it had started.
async function liveTicket(ctx: QueryCtx | MutationCtx, ticket: string) {
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  const hash = await sha256(ticket);
  const row = await ctx.db.query('uploadTickets').withIndex('by_hash', (q) => q.eq('ticketHash', hash)).first();
  if (!row || row.usedAt || row.issuedAt <= Date.now() - TICKET_MS || !row.keyId) return null;
  const key = await ctx.db.get(row.keyId);
  return key && !key.revokedAt ? row : null;
}

// A file a runner key uploads: at most this big, and at most this much an
// hour, so a key can't fill the deployment's storage.
export const MAX_RUNNER_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_BYTES_PER_HOUR = 200 * 1024 * 1024;
const STORED_BYTES_PER_RUNNER = 150 * 1024 * 1024;
const MIN_UPLOAD_CHARGE = 64 * 1024;

// For /runner/upload, before it stores anything.
export const uploadTicketOk = internalQuery({
  args: { ticket: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { ticket }) => (await liveTicket(ctx, ticket)) !== null,
});

// The stored file is the ticket's runner's. False (the route then deletes
// the file): the ticket was used meanwhile, or has run out.
// "later": over the hour's or the stored allowance, which time or deleting
// fixes, so the runner keeps the picture and tries again (convex/http.ts
// answers 429); false: a dead ticket or a file over the size cap.
export const redeemUpload = internalMutation({
  args: { ticket: v.string(), storageId: v.id('_storage'), bytes: v.number() },
  returns: v.union(v.boolean(), v.literal('later')),
  handler: async (ctx, { ticket, storageId, bytes }) => {
    const row = await liveTicket(ctx, ticket);
    if (!row) return false;
    const now = Date.now();
    if (!(bytes >= 0) || bytes > MAX_RUNNER_UPLOAD_BYTES) {
      await ctx.db.patch(row._id, { usedAt: now, bytes: MAX_RUNNER_UPLOAD_BYTES });
      return false;
    }
    // Each file counts as at least MIN_UPLOAD_CHARGE, so how many a runner key
    // keeps is bounded too (150 MB / 64 KB = 2,400), and with one row per file
    // so are its picture rows, however small the files.
    bytes = Math.max(bytes, MIN_UPLOAD_CHARGE);
    // Spent whatever happens: a refused ticket can't be tried again.
    await ctx.db.patch(row._id, { usedAt: now, bytes });
    // The hour's bytes come from the tickets, which outlive the files
    // (deleting an upload doesn't give its bytes back), and all a runner
    // keeps stored is capped too.
    let used = 0;
    for await (const t of ctx.db.query('uploadTickets').withIndex('by_runner_issued', (q) => q.eq('runnerId', row.runnerId).gt('issuedAt', now - 2 * TICKET_MS))) if (t._id !== row._id && t.usedAt && t.usedAt > now - TICKET_MS) used += t.bytes ?? 0;
    if (used + bytes > UPLOAD_BYTES_PER_HOUR) return 'later';
    const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).unique();
    if ((usage?.bytes ?? 0) + bytes > STORED_BYTES_PER_RUNNER) return 'later';
    if (usage) await ctx.db.patch(usage._id, { bytes: usage.bytes + bytes });
    else await ctx.db.insert('runnerStorage', { runnerId: row.runnerId, bytes });
    await ctx.db.insert('storageOwners', { storageId, runnerId: row.runnerId, at: now, bytes });
    return true;
  },
});

export const setProjectIcon = mutation({
  args: { key: v.string(), runnerId: v.string(), projectId: v.string(), picture: v.string(), storageId: v.id('_storage'), mediaType: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, projectId, picture, storageId, mediaType }) => {
    const caller = await runnerAuth(ctx, key, 'setProjectIcon');
    await actAs(ctx, caller, runnerId);
    await mustMayUseStorage(ctx, caller, storageId);
    if (!caller.owner) {
      // Only on a project of its own, and the whole row small (CAP).
      if (!(await ctx.db.query('projects').withIndex('by_runner_id', (q) => q.eq('runnerId', runnerId).eq('id', projectId)).unique())) throw forbidden('set a picture on a project its runner has no row for');
      picture = cutBytes(picture, 200);
      mediaType = cutBytes(mediaType, 100);
    }
    mediaType = clean(mediaType);
    const now = Date.now();
    const existing = await ctx.db
      .query('projectIcons')
      .withIndex('by_runner_project', (q) => q.eq('runnerId', runnerId).eq('projectId', projectId))
      .unique();
    // One row per upload, as for pictures: the same icon again is this row's.
    if (existing?.storageId !== storageId) await mustBeUnnamed(ctx, caller, storageId);
    if (existing) {
      await ctx.db.patch(existing._id, { picture, storageId, mediaType, updatedAt: now });
      if (existing.storageId !== storageId) await freeStorage(ctx, caller, existing.storageId);
    } else {
      await ctx.db.insert('projectIcons', { runnerId, projectId, picture, storageId, mediaType, updatedAt: now });
    }
    return null;
  },
});

// The mirror of a runner's own schedules.json. Rows that are schedules in
// their own right (`owned`, API 9) are left alone, and a mirrored row is
// never written over one: a runner still on an older release, a draining
// one say, mustn't undo a move it hasn't heard of.
export const setSchedules = mutation({
  args: { key: v.string(), runnerId: v.string(), schedules: v.array(scheduleDoc) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, schedules }) => {
    const caller = await runnerAuth(ctx, key, 'setSchedules');
    schedules = clean(schedules);
    await actAs(ctx, caller, runnerId);
    const owned = new Set<string>();
    for await (const row of ctx.db.query('schedules')) {
      if (row.owned) owned.add(row.id);
      else if (row.runnerId === runnerId) {
        await ctx.db.delete(row._id);
        await dropWake(ctx, row.id);
      }
    }
    for (const row of schedules) {
      if (owned.has(row.id)) continue;
      await ctx.db.insert('schedules', { ...row, runnerId });
      await syncWake(ctx, { ...row, runnerId });
    }
    return null;
  },
});

// ------------------------------------------------------------ schedules (API 9)
// Schedules that live here (docs/protocol.md, Schedules, "Runners"). Every
// runner subscribes to the whole list; a schedule's own runner is the only
// one that sends it, and takes each run with claimSchedule first so it's
// sent once even while a handover has two runner processes under one
// runnerId. The runner works out nextRunAt and whenText (it has the cron
// code and the zones); this only stores them.

const CLAIM_MS = 2 * 60_000;

const ownedScheduleDoc = v.object({
  ...scheduleDoc.fields,
  runnerId: v.string(),
  effort: v.optional(v.string()),
  permissionMode: v.optional(v.string()),
  createdBy: v.optional(v.string()),
  runRequestedAt: v.optional(v.string()),
  poolId: v.optional(v.string()),
  check: v.optional(v.string()),
  checkTimeoutSecs: v.optional(v.number()),
});

const lastRunDoc = v.object({ at: v.string(), outcome: v.string(), threadId: v.optional(v.string()), note: v.optional(v.string()) });

async function scheduleRow(ctx: { db: MutationCtx['db'] }, scheduleId: string) {
  const row = await ctx.db
    .query('schedules')
    .withIndex('by_scheduleId', (q) => q.eq('id', scheduleId))
    .filter((q) => q.eq(q.field('owned'), true))
    .first();
  return row ?? undefined;
}

// A runner's owned schedules (mirrored ones from before API 9 don't count).
async function ownedCount(ctx: { db: MutationCtx['db'] }, runnerId: string): Promise<number> {
  let n = 0;
  for await (const r of ctx.db.query('schedules').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) if (r.owned) n++;
  return n;
}

function visibleTo<T extends { runnerId: string }>(caller: Caller, row: T | undefined): T | undefined {
  return row && mayTouch(caller, row.runnerId) ? row : undefined;
}

// Whether any row with this schedule id, owned or an old mirrored one (from
// before API 9), is another runner's: a runner key may not take that id,
// or the other runner's adoption would find it taken and drop its own.
// And one with no row now that went from another runner lately (scheduleGone,
// a day): that runner may still have a run of it claimed or its check going,
// and the main Mac reads every runner's rows, so a row of this runner's under
// the gone id must not turn up there as the one it claimed (Daybreak, 6 Nov;
// the runner checks that too, Scheduler.stillClaimed).
async function scheduleIdTaken(ctx: { db: MutationCtx['db'] }, caller: Caller, scheduleId: string): Promise<boolean> {
  if (caller.owner) return false;
  let live = false;
  for await (const row of ctx.db.query('schedules').withIndex('by_scheduleId', (q) => q.eq('id', scheduleId))) {
    if (row.runnerId !== caller.runnerId) return true;
    live = true;
  }
  if (live) return false;
  for await (const gone of ctx.db.query('scheduleGone').withIndex('by_scheduleId', (q) => q.eq('id', scheduleId))) if (gone.runnerId !== caller.runnerId) return true;
  return false;
}

export const schedules = query({
  args: { key: v.string() },
  returns: v.array(ownedScheduleDoc),
  handler: async (ctx, { key }) => {
    const caller = await runnerAuth(ctx, key, 'schedules');
    const out = [];
    // A runner key's runner lists only its own: another's schedule is its
    // text, folder and permissions, which aren't this runner's to see. By
    // index, so it's all it reads too: reading the whole table cost about 170
    // KB a run and re-ran it for every other runner's claim (API 45).
    const rows = caller.owner ? ctx.db.query('schedules') : ctx.db.query('schedules').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId));
    for await (const row of rows) {
      if (!row.owned) continue;
      const { _id, _creationTime, owned, claim, updatedMs: _u, ...rest } = row;
      out.push(rest);
    }
    return out;
  },
});

const SCHEDULES_SINCE_CAP = 200;
// scheduleGone rows last a day (pruneOld, every 6 hours), so asking from further
// back than this could miss one: read the whole table instead.
const SCHEDULES_SINCE_OLDEST_MS = 12 * 60 * 60_000;

// With no `since`, the whole table and the time to follow it from; with one,
// the rows written at or after it and the ids gone since (API 48). A runner
// asks again from a little before the newest it heard, so each run reads only
// what changed (runner/src/schedule-follow.ts). `more`: read it whole again.
// A runner key's runner reads and hears of only its own, by index.
export const schedulesSince = query({
  // `fresh`: anything different each time, so a whole read isn't served from
  // Convex's cache with the `at` of when it was first made.
  args: { key: v.string(), since: v.optional(v.number()), fresh: v.optional(v.number()) },
  returns: v.object({
    rows: v.array(v.object({ ...ownedScheduleDoc.fields, updatedMs: v.optional(v.number()) })),
    gone: v.array(v.string()),
    at: v.number(),
    more: v.optional(v.boolean()),
  }),
  handler: async (ctx, { key, since }) => {
    const caller = await runnerAuth(ctx, key, 'schedulesSince');
    const own = caller.owner ? undefined : caller.runnerId;
    const at = Date.now();
    const shown = (row: Doc<'schedules'>) => {
      const { _id, _creationTime, owned: _o, claim: _c, ...rest } = row;
      return rest;
    };
    if (since === undefined) {
      const all = own ? ctx.db.query('schedules').withIndex('by_runnerId', (q) => q.eq('runnerId', own)) : ctx.db.query('schedules');
      const rows = [];
      for await (const row of all) if (row.owned) rows.push(shown(row));
      return { rows, gone: [], at };
    }
    if (since < at - SCHEDULES_SINCE_OLDEST_MS) return { rows: [], gone: [], at, more: true };
    const docs = await (own
      ? ctx.db.query('schedules').withIndex('by_runner_updated', (q) => q.eq('runnerId', own).gte('updatedMs', since))
      : ctx.db.query('schedules').withIndex('by_updated', (q) => q.gte('updatedMs', since))
    ).take(SCHEDULES_SINCE_CAP + 1);
    const went = await (own
      ? ctx.db.query('scheduleGone').withIndex('by_runner_at', (q) => q.eq('runnerId', own).gte('at', since))
      : ctx.db.query('scheduleGone').withIndex('by_at', (q) => q.gte('at', since))
    ).take(SCHEDULES_SINCE_CAP + 1);
    if (docs.length > SCHEDULES_SINCE_CAP || went.length > SCHEDULES_SINCE_CAP) return { rows: [], gone: [], at, more: true };
    // An id that's back since it went has a row, which is what's true now.
    const here = new Set(docs.map((d) => d.id));
    return { rows: docs.filter((d) => d.owned).map(shown), gone: went.filter((g) => !here.has(g.id)).map((g) => g.id), at };
  },
});

// Makes or replaces one, as the runner that took schedules.create or
// schedules.update has it. A change to when it runs drops a claim on the
// old time.
export const saveSchedule = mutation({
  args: { key: v.string(), schedule: ownedScheduleDoc },
  returns: v.null(),
  handler: async (ctx, { key, schedule }) => {
    const caller = await runnerAuth(ctx, key, 'saveSchedule');
    schedule = clean(schedule);
    const row = await scheduleRow(ctx, schedule.id);
    // A schedule is its runner sending that text with those permissions,
    // so a runner key puts one only on its own runner (schedules.create
    // with another runnerId needs the main Mac's key).
    checkRunnerId(schedule.runnerId);
    if (!caller.owner && !SCHEDULE_ID.test(schedule.id)) throw new ConvexError({ kind: 'badArgs', message: "A runner key's schedule ids are UUIDs, as its runner makes them." });
    if (!mayWrite(caller, schedule.runnerId, row?.runnerId) || (await scheduleIdTaken(ctx, caller, schedule.id))) throw forbidden(`save schedule ${schedule.id}`);
    capText(caller, "A schedule's text", schedule.text, CAP.scheduleText);
    capDoc(caller, 'A schedule', schedule, CAP.scheduleDoc);
    if (!row && !caller.owner && (await ownedCount(ctx, schedule.runnerId)) >= CAP.schedules) throw tooMany('schedules', CAP.schedules);
    await syncWake(ctx, schedule);
    if (!row) {
      await ctx.db.insert('schedules', { ...schedule, owned: true, updatedMs: Date.now() });
      return null;
    }
    const claim = row.claim && row.nextRunAt === schedule.nextRunAt ? { claim: row.claim } : {};
    // Moved to another runner: the one it was on follows only its own rows.
    if (row.runnerId !== schedule.runnerId) await ctx.db.insert('scheduleGone', { id: row.id, runnerId: row.runnerId, at: Date.now() });
    await ctx.db.replace(row._id, { ...schedule, owned: true, ...claim, updatedMs: Date.now() });
    return null;
  },
});

export const deleteSchedule = mutation({
  args: { key: v.string(), scheduleId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { key, scheduleId }) => {
    const caller = await runnerAuth(ctx, key, 'deleteSchedule');
    // Another runner's schedule is as good as missing to a runner key: no
    // refusal to say it's there or whose it is.
    const row = visibleTo(caller, await scheduleRow(ctx, scheduleId));
    if (!row) return false;
    await ctx.db.delete(row._id);
    await dropWake(ctx, scheduleId);
    await ctx.db.insert('scheduleGone', { id: row.id, runnerId: row.runnerId, at: Date.now() });
    return true;
  },
});

// A runner's schedules.json, the first time it meets API 9: each one it
// has that isn't here yet comes in under its runnerId, and its mirrored
// rows go. Running it twice is harmless.
// For a runner key, all or nothing: if any of its schedules couldn't come
// up (an id that isn't a UUID or is another runner's, over the size or count
// caps), nothing changes and `held` says which and why, so the runner keeps
// running them from its own file rather than losing any (schedules.ts).
export const adoptSchedules = mutation({
  args: { key: v.string(), runnerId: v.string(), schedules: v.array(ownedScheduleDoc) },
  returns: v.object({ held: v.array(v.object({ id: v.string(), why: v.string() })) }),
  handler: async (ctx, { key, runnerId, schedules }) => {
    const caller = await runnerAuth(ctx, key, 'adoptSchedules');
    schedules = clean(schedules);
    await actAs(ctx, caller, runnerId);
    const fresh: typeof schedules = [];
    const held: { id: string; why: string }[] = [];
    let count = caller.owner ? 0 : await ownedCount(ctx, runnerId);
    for (const s of schedules) {
      if (await scheduleRow(ctx, s.id)) continue;
      if (await scheduleIdTaken(ctx, caller, s.id)) {
        if (!caller.owner) held.push({ id: s.id.slice(0, 64), why: "its id is another runner's" });
        continue;
      }
      if (!caller.owner) {
        if (!SCHEDULE_ID.test(s.id)) held.push({ id: s.id.slice(0, 64), why: "its id isn't a UUID" });
        else if (utf8Bytes(s.text) > CAP.scheduleText || docBytes(s) > CAP.scheduleDoc) held.push({ id: s.id, why: `it's over ${CAP.scheduleText} bytes` });
        else if (count >= CAP.schedules) held.push({ id: s.id, why: `over ${CAP.schedules} schedules` });
        else count++;
      }
      fresh.push(s);
    }
    if (held.length) return { held };
    for await (const row of ctx.db.query('schedules').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
      if (!row.owned) {
        await ctx.db.delete(row._id);
        await dropWake(ctx, row.id);
      }
    }
    for (const s of fresh) {
      await ctx.db.insert('schedules', { ...s, runnerId, owned: true, updatedMs: Date.now() });
      await syncWake(ctx, { ...s, runnerId });
    }
    return { held: [] };
  },
});

// Takes a run: "due" while the row is still due at that nextRunAt, or
// "request" for the schedules.run waiting at runRequestedAt. No when it's
// another runner's, paused (a due run), or someone else holds it.
export const claimSchedule = mutation({
  args: {
    key: v.string(),
    runnerId: v.string(),
    scheduleId: v.string(),
    holder: v.string(),
    kind: v.union(v.literal('due'), v.literal('request')),
    expect: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, { key, runnerId, scheduleId, holder, kind, expect }) => {
    const caller = await runnerAuth(ctx, key, 'claimSchedule');
    await actAs(ctx, caller, runnerId);
    const row = await scheduleRow(ctx, scheduleId);
    if (!row || row.runnerId !== runnerId) return false;
    const now = Date.now();
    if (row.claim && row.claim.until > now && row.claim.holder !== holder) return false;
    if (kind === 'due' && (row.paused || row.nextRunAt !== expect)) return false;
    if (kind === 'request' && row.runRequestedAt !== expect) return false;
    // A holder is "<runnerId>:<pid>:<startedAt>"; a runner key's is cut (CAP).
    await ctx.db.patch(row._id, { claim: { holder: caller.owner ? holder : cutBytes(holder, 200), until: now + CLAIM_MS } });
    return true;
  },
});

// Lets go of a run that couldn't be sent yet (its runner is restarting),
// so the next try, or the next runner process, can take it.
export const releaseSchedule = mutation({
  args: { key: v.string(), scheduleId: v.string(), holder: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, scheduleId, holder }) => {
    const caller = await runnerAuth(ctx, key, 'releaseSchedule');
    // Another runner's schedule is as good as missing to a runner key: no
    // refusal to say it's there or whose it is.
    const row = visibleTo(caller, await scheduleRow(ctx, scheduleId));
    if (row?.claim?.holder === holder) await ctx.db.patch(row._id, { claim: undefined });
    return null;
  },
});

// Records a run the holder sent (or skipped, or couldn't send). The next
// time goes in only if nobody changed the schedule meanwhile
// (`expectUpdatedAt`): a change already worked out its own.
export const scheduleRan = mutation({
  args: {
    key: v.string(),
    scheduleId: v.string(),
    holder: v.string(),
    lastRun: lastRunDoc,
    sent: v.boolean(),
    expectUpdatedAt: v.string(),
    nextRunAt: v.optional(v.string()),
    finishedAt: v.optional(v.string()),
    request: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { key, scheduleId, holder, lastRun, sent, expectUpdatedAt, nextRunAt, finishedAt, request }) => {
    const caller = await runnerAuth(ctx, key, 'scheduleRan');
    lastRun = clean(lastRun);
    // Another runner's schedule is as good as missing to a runner key: no
    // refusal to say it's there or whose it is.
    const row = visibleTo(caller, await scheduleRow(ctx, scheduleId));
    if (!row) return null;
    // A runner key's run record is cut to fit: the row it's recorded on is
    // read whole with every other schedule (CAP).
    const run = caller.owner ? lastRun : { ...lastRun, at: cutBytes(lastRun.at, 64), outcome: cutBytes(lastRun.outcome, 64), ...(lastRun.threadId !== undefined ? { threadId: cutBytes(lastRun.threadId, 100) } : {}), ...(lastRun.note !== undefined ? { note: cutBytes(lastRun.note, CAP.note) } : {}) };
    const patch: Record<string, unknown> = { lastRun: run, runs: row.runs + (sent ? 1 : 0), updatedMs: Date.now() };
    if (row.claim?.holder === holder) patch.claim = undefined;
    if (request !== undefined && row.runRequestedAt === request) patch.runRequestedAt = undefined;
    if (row.updatedAt === expectUpdatedAt) {
      patch.nextRunAt = caller.owner || nextRunAt === undefined ? nextRunAt : cutBytes(nextRunAt, 64);
      patch.finishedAt = caller.owner || finishedAt === undefined ? finishedAt : cutBytes(finishedAt, 64);
    }
    // And the row as it will be, checked whole.
    if (!caller.owner && docBytes({ ...row, ...patch }) > CAP.scheduleDoc) delete patch.lastRun;
    if (row.updatedAt === expectUpdatedAt) await syncWake(ctx, { ...row, nextRunAt: patch.nextRunAt as string | undefined, finishedAt: patch.finishedAt as string | undefined });
    await ctx.db.patch(row._id, patch);
    return null;
  },
});

// schedules.run on a runner that isn't the schedule's: its own runner sees
// runRequestedAt and runs it.
export const requestScheduleRun = mutation({
  args: { key: v.string(), scheduleId: v.string(), at: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { key, scheduleId, at }) => {
    const caller = await runnerAuth(ctx, key, 'requestScheduleRun');
    // Another runner's schedule is as good as missing to a runner key: no
    // refusal to say it's there or whose it is.
    const row = visibleTo(caller, await scheduleRow(ctx, scheduleId));
    if (!row) return false;
    await ctx.db.patch(row._id, { runRequestedAt: caller.owner ? at : cutBytes(at, 64), updatedMs: Date.now() });
    return true;
  },
});

// ------------------------------------------------------------ pools (API 38)

const poolMemberDoc = v.object({ provider: v.string(), email: v.optional(v.string()), runnerId: v.optional(v.string()), accountId: v.optional(v.string()) });
const sharedPoolDoc = v.object({ id: v.string(), title: v.string(), members: v.array(poolMemberDoc), folders: v.optional(v.array(v.string())), icon: v.optional(v.string()) });

// Every runner subscribes to this and works out its own pools from it.
export const pools = query({
  args: { key: v.string() },
  returns: v.array(sharedPoolDoc),
  handler: async (ctx, { key }) => {
    const caller = await runnerAuth(ctx, key, 'pools');
    const rows = await ctx.db.query('pools').collect();
    rows.sort((a, b) => a.order - b.order);
    // A member named by runner id (a login with no email known) only counts
    // on that runner, so a runner key has no use for another runner's, and
    // its id is the owner's to know (runnersList).
    const seen = (m: { runnerId?: string }) => caller.owner || m.runnerId === undefined || m.runnerId === caller.runnerId;
    return rows.map(({ id, title, members, folders, icon }) => ({ id, title, members: members.filter(seen), ...(folders ? { folders } : {}), ...(icon ? { icon } : {}) }));
  },
});

// Replaces the whole list, as the runner that took pools.save has it
// (it keeps what it can't see itself). Rows that didn't change aren't
// written, so the other runners' subscriptions don't wake for nothing.
export const savePools = mutation({
  args: { key: v.string(), runnerId: v.string(), pools: v.array(sharedPoolDoc) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, pools }) => {
    await runnerAuth(ctx, key, 'savePools');
    pools = clean(pools);
    await writePools(ctx, runnerId, pools);
    return null;
  },
});

// A runner's runner.json pools, the first time it meets API 38: they go in
// only if the table is empty, so the first runner to arrive sets the list
// and the rest follow it. True when these were taken.
export const adoptPools = mutation({
  args: { key: v.string(), runnerId: v.string(), pools: v.array(sharedPoolDoc) },
  returns: v.boolean(),
  handler: async (ctx, { key, runnerId, pools }) => {
    await runnerAuth(ctx, key, 'adoptPools');
    pools = clean(pools);
    if (pools.length === 0 || (await ctx.db.query('pools').first())) return false;
    await writePools(ctx, runnerId, pools);
    return true;
  },
});

async function writePools(ctx: { db: MutationCtx['db'] }, runnerId: string, pools: { id: string; title: string; members: { provider: string; email?: string; runnerId?: string; accountId?: string }[]; folders?: string[]; icon?: string }[]): Promise<void> {
  const ids = new Set<string>();
  for (const p of pools) {
    if (!p.id.trim() || ids.has(p.id)) throw new ConvexError(`Pool ids must be unique and not empty: "${p.id}"`);
    ids.add(p.id);
  }
  const existing = await ctx.db.query('pools').collect();
  for (const row of existing) if (!ids.has(row.id)) await ctx.db.delete(row._id);
  const now = new Date().toISOString();
  for (const [order, p] of pools.entries()) {
    const row = existing.find((r) => r.id === p.id);
    const doc = { id: p.id, title: p.title, members: p.members, ...(p.folders?.length ? { folders: p.folders } : {}), ...(p.icon ? { icon: p.icon } : {}), order };
    if (!row) {
      await ctx.db.insert('pools', { ...doc, updatedAt: now, updatedBy: runnerId });
      continue;
    }
    const same = JSON.stringify({ title: row.title, members: row.members, folders: row.folders, icon: row.icon, order: row.order }) === JSON.stringify({ title: doc.title, members: doc.members, folders: doc.folders, icon: doc.icon, order });
    if (!same) await ctx.db.replace(row._id, { ...doc, updatedAt: now, updatedBy: runnerId });
  }
}

// Every runner's latest usage reading of each login it knows the email of
// (API 39): the same subscription signed in on several machines is one
// limit, so each runner takes the newest reading from any of them.
//
// Who wrote a row decides what it's good for (API 53). A runner id that has
// never had a runner key is the owner key's: only that key can write its
// rows (runnerAccess.ts actAs), so they're the main Mac's word and go to
// anyone they concern, marked `byOwnerKey`. Any other runner's rows are its
// key's, which writes what it likes under its own id (any provider, email
// and reading), so they go to nobody: a reading from a tampered Mac's key,
// even of one window nothing else had read, could keep the main Mac's pools
// off a login or send them to a spent one (Gautam's 6 Nov convex scan, F1),
// and once the main Mac took it in, its own rows would pass it on as its
// word. The main Mac's own Token Stats and turns read its logins anyway.
// Which logins a runner key gets the main Mac's readings of is the owner's
// word too, never what that key's rows name (F3): `runnerLogins`, which
// only the owner key writes. It gets no runner id (runnersList is the
// owner's alone).
export const sharedUsage = query({
  args: { key: v.string(), runnerId: v.optional(v.string()) },
  returns: v.array(v.object({ runnerId: v.optional(v.string()), provider: v.string(), email: v.string(), usage: v.any(), byOwnerKey: v.optional(v.boolean()) })),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'sharedUsage');
    // Every runner id that has had a key of its own, live or revoked: its
    // rows are (or were) that key's. Key rows are never deleted, only revoked.
    const keyed = new Set<string>();
    for (const k of await ctx.db.query('runnerKeys').collect()) keyed.add(k.runnerId);
    const sharesOf = async (id: string) => new Set((await ctx.db.query('runnerLogins').withIndex('by_runnerId', (q) => q.eq('runnerId', id)).take(CAP.accounts)).map((l) => loginKey(l.provider, l.email)));
    const mine = caller.owner ? undefined : await sharesOf(caller.runnerId);
    // A runner key the owner hasn't said shares anything gets nothing, and
    // reads nothing more to find that out.
    if (mine && mine.size === 0) return [];
    // Only other runners' rows (API 45): a runner has no use for its own, and
    // reading them re-ran this for each of its own writes. Two ranges of the
    // index, so a write to the caller's rows isn't in what this read. A runner
    // sending no runnerId (from before 45) is told about everyone's, and leaves
    // out its own.
    const me = caller.owner ? runnerId : caller.runnerId;
    const rows = me
      ? [
          ...(await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.lt('runnerId', me)).collect()),
          ...(await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.gt('runnerId', me)).collect()),
        ]
      : await ctx.db.query('accounts').collect();
    const now = Date.now();
    const out = [];
    for (const row of rows) {
      if (!row.email || !row.usage) continue;
      if (keyed.has(row.runnerId)) continue;
      if (mine && !mine.has(loginKey(row.provider, row.email))) continue;
      if (impossibleUsage(row.usage, now)) continue;
      out.push({ ...(caller.owner ? { runnerId: row.runnerId } : {}), provider: row.provider, email: row.email, usage: row.usage, byOwnerKey: true });
    }
    return out;
  },
});

// A runner key's accounts as they may be stored: each reading fitted
// (fitUsage), too big ones left out, at most CAP.accounts.
function fitAccount<T extends { usage?: UsageDoc }>(a: T, now: number): T | undefined {
  if (docBytes(a) > CAP.accountDoc) return undefined;
  if (!a.usage) return a;
  const usage = fitUsage(a.usage, now);
  if (usage) return { ...a, usage };
  const { usage: _gone, ...rest } = a;
  return rest as T;
}

export const setAccounts = mutation({
  args: { key: v.string(), runnerId: v.string(), accounts: v.array(accountDoc) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, accounts }) => {
    const caller = await runnerAuth(ctx, key, 'setAccounts');
    accounts = clean(accounts);
    await actAs(ctx, caller, runnerId);
    // A runner key's: fitted (fitAccount), ones too big left out, and at most CAP.accounts.
    const now = Date.now();
    const fitting = caller.owner ? accounts : accounts.flatMap((a) => fitAccount(a, now) ?? []).slice(0, CAP.accounts);
    await replaceRows(ctx, 'accounts', runnerId, fitting);
    return null;
  },
});

// API 37: only the accounts that changed, and the ones gone. Usage moves one
// login at a time, and setAccounts read and rewrote every login's row for it
// (about 20 KB for Mike's ten). The first send after a start with nothing
// remembered is still setAccounts, the whole list.
export const upsertAccounts = mutation({
  args: { key: v.string(), runnerId: v.string(), accounts: v.array(accountDoc), removed: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, accounts, removed }) => {
    const caller = await runnerAuth(ctx, key, 'upsertAccounts');
    accounts = clean(accounts);
    await actAs(ctx, caller, runnerId);
    const one = (id: string) => ctx.db.query('accounts').withIndex('by_runner_id', (q) => q.eq('runnerId', runnerId).eq('id', id)).unique();
    // A runner key's, as setAccounts: fitted, ones too big left out, at most CAP.accounts.
    let count = caller.owner ? 0 : (await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(CAP.accounts + 1)).length;
    const now = Date.now();
    for (const given of accounts) {
      const a = caller.owner ? given : fitAccount(given, now);
      if (!a) continue;
      const existing = await one(a.id);
      if (existing) await ctx.db.replace(existing._id, { ...a, runnerId });
      else if (caller.owner || count < CAP.accounts) {
        await ctx.db.insert('accounts', { ...a, runnerId });
        count++;
      }
    }
    for (const id of removed) {
      const existing = await one(id);
      if (existing) await ctx.db.delete(existing._id);
    }
    return null;
  },
});

// ------------------------------------------------------------ pocket
// Cards the `pocket` tool files for the phone (schema.ts, pocketCards).

const pocketKey = (title: string) => title.trim().toLowerCase();

// A runner key's cards have keys of their own ("<runnerId>:<title>"), so
// filing one can neither replace the main Mac's card of that title nor say
// one's there.
const cardKey = (caller: Caller, title: string) => (caller.owner ? pocketKey(title) : `${caller.runnerId}:${pocketKey(title)}`);

// What lists call a runner: its heartbeat's name (kept unique for runner
// keys, uniqueName), or its id before it has one.
export async function runnerName(ctx: QueryCtx | MutationCtx, runnerId: string): Promise<string> {
  const name = (await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique())?.name;
  return (name && normalName(name)) || runnerId;
}

export const savePocketCard = mutation({
  args: {
    key: v.string(),
    card: v.object({ title: v.string(), text: v.string(), place: v.optional(v.string()), icon: v.optional(v.string()), threadId: v.optional(v.string()), source: v.optional(v.string()) }),
  },
  returns: v.union(v.literal('added'), v.literal('replaced')),
  handler: async (ctx, { key, card }) => {
    const caller = await runnerAuth(ctx, key, 'savePocketCard');
    card = clean(card);
    capText(caller, "A card's title", card.title, CAP.cardTitle);
    capText(caller, "A card's text", card.text, CAP.cardText);
    capText(caller, "A card's place", card.place, CAP.cardPlace);
    capText(caller, "A card's source", card.source, CAP.cardSource);
    capText(caller, "A card's icon", card.icon, CAP.cardPlace);
    const k = cardKey(caller, card.title);
    const had = await ctx.db.query('pocketCards').withIndex('by_key', (q) => q.eq('key', k)).first();
    // Only its own, as a runner key's titles are its own (cardKey).
    if (had && !ownsCard(caller, had)) throw forbidden('file that Pocket card');
    if (!had && !caller.owner) {
      const mine = await ctx.db.query('pocketCards').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId)).take(CAP.cards);
      if (mine.length >= CAP.cards) throw tooMany('Pocket cards', CAP.cards);
    }
    // A card keeps its look when it's filed again without one.
    const icon = card.icon ?? had?.icon;
    // A runner key's card is marked with its runner, set here, never taken
    // from the card (pocketCards says which Mac filed it, and phone:pocket
    // shows it), and is tied only to a thread of its own runner's: a card
    // claiming to be from one of the main Mac's threads would be treated as
    // that thread's by its librarian.
    let fields: typeof card = card;
    if (!caller.owner) {
      const row = card.threadId ? await threadRow(ctx, card.threadId) : null;
      const { threadId: _t, ...rest } = card;
      fields = row?.runnerId === caller.runnerId ? card : rest;
    }
    const by = caller.owner ? {} : { runnerId: caller.runnerId };
    const doc = { ...fields, ...(icon ? { icon } : {}), title: card.title.trim(), key: k, updatedAt: new Date().toISOString(), ...by };
    if (had) {
      await ctx.db.replace(had._id, doc);
      return 'replaced';
    }
    await ctx.db.insert('pocketCards', doc);
    return 'added';
  },
});

export const removePocketCard = mutation({
  args: { key: v.string(), title: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { key, title }) => {
    const caller = await runnerAuth(ctx, key, 'removePocketCard');
    title = clean(title);
    const had = await ctx.db.query('pocketCards').withIndex('by_key', (q) => q.eq('key', cardKey(caller, title))).first();
    if (had && !ownsCard(caller, had)) throw forbidden('remove that Pocket card');
    if (had) await ctx.db.delete(had._id);
    return had !== null;
  },
});

export const pocketCards = query({
  args: { key: v.string() },
  // filedBy: the runner key's runner that filed it (its id), for the owner
  // only: its text is that Mac's, which the main Mac's agents and librarian
  // take as something to read, never as instructions.
  returns: v.array(v.object({ title: v.string(), text: v.string(), place: v.optional(v.string()), icon: v.optional(v.string()), threadId: v.optional(v.string()), source: v.optional(v.string()), updatedAt: v.string(), filedBy: v.optional(v.string()) })),
  handler: async (ctx, { key }) => {
    const caller = await runnerAuth(ctx, key, 'pocketCards');
    const rows = (await ctx.db.query('pocketCards').collect()).filter((card) => ownsCard(caller, card));
    const out = [];
    for (const c of rows) {
      // By runner id, which nothing it writes can change (its name it can).
      const filedBy = caller.owner && c.runnerId ? c.runnerId : undefined;
      out.push({ title: c.title, text: c.text, ...(c.place ? { place: c.place } : {}), ...(c.icon ? { icon: c.icon } : {}), ...(c.threadId ? { threadId: c.threadId } : {}), ...(c.source ? { source: c.source } : {}), updatedAt: c.updatedAt, ...(filedBy ? { filedBy } : {}) });
    }
    return out;
  },
});

// ------------------------------------------------------------ commands
// What the phone asked for (phone.ts). The owning runner subscribes to
// pendingCommands, takes each one (once: takeCommand says no the second
// time), applies it through the same code the Mac app uses, and finishes
// it with the outcome.

export const pendingCommands = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.object({ commandId: v.id('commands'), kind: v.string(), threadId: v.optional(v.string()), args: v.any(), createdAt: v.number() })),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'pendingCommands');
    await actAs(ctx, caller, runnerId);
    const out = [];
    // "any" (a phone's new thread with no owner's runner online) waits for
    // the owner key: its text is whatever Mike said (runnerAccess.ts mayTake).
    for (const target of caller.owner ? [runnerId, 'any'] : [runnerId]) {
      for await (const c of ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', target).eq('state', 'pending'))) {
        out.push({ commandId: c._id, kind: c.kind, ...(c.threadId ? { threadId: c.threadId } : {}), args: c.args, createdAt: c.createdAt });
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const takeCommand = mutation({
  args: { key: v.string(), commandId: v.id('commands') },
  returns: v.boolean(),
  handler: async (ctx, { key, commandId }) => {
    const caller = await runnerAuth(ctx, key, 'takeCommand');
    const c = await ctx.db.get(commandId);
    if (!c || c.state !== 'pending') return false;
    if (!mayTake(caller, c)) throw forbidden("take that command: it isn't for its runner");
    // A thread's command is for the runner that has the thread now: one
    // queued before the thread moved to another runner (or went) isn't
    // applied by the runner that had it, which may keep a copy.
    if (c.threadId !== undefined && c.runnerId !== 'any') {
      const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', c.threadId!)).unique();
      if (!t || t.runnerId !== c.runnerId) {
        await ctx.db.patch(commandId, { state: 'failed', doneAt: Date.now(), args: finishedArgs(c.args), note: t ? 'That thread is on another runner now.' : 'That thread has gone.' });
        await endCommandFiles(ctx, commandId);
        for (const image of Array.isArray(c.args?.images) ? c.args.images : []) await deleteIfUnused(ctx, image.storageId);
        return false;
      }
    }
    await ctx.db.patch(commandId, { state: 'taken', takenAt: Date.now() });
    return true;
  },
});

// A call's answer is a folder list at most; a day of them stays small.
const RESULT_MAX_BYTES = 256 * 1024;
const NOTE_MAX = 4_000;

export const finishCommand = mutation({
  // result (API 44): a `call`'s answer as JSON text, kept only for one
  // (relay.ts), at most RESULT_MAX_BYTES. Text, so its size is what's stored.
  args: { key: v.string(), commandId: v.id('commands'), ok: v.boolean(), note: v.optional(v.string()), resultThreadId: v.optional(v.string()), result: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, commandId, ok, note, resultThreadId, result }) => {
    const caller = await runnerAuth(ctx, key, 'finishCommand');
    const c = await ctx.db.get(commandId);
    if (!c) return null;
    if (!mayFinish(caller, c)) throw forbidden("finish that command: it isn't for its runner");
    const kept = ok && c.kind === 'call' && result !== undefined && utf8Bytes(result) <= RESULT_MAX_BYTES ? cleanResult(result) : undefined;
    // The thread a create made is the command's runner's (it writes the row
    // before finishing): never another runner's id, which the main Mac would
    // then open as this runner's new thread.
    let made: string | undefined;
    // A press (API 59) names the thread its button started or messaged, also the runner's own.
    if (resultThreadId && (c.kind === 'create' || c.kind === 'quickAsk' || c.kind === 'press')) {
      const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', resultThreadId)).unique();
      if (t && (c.runnerId === 'any' ? caller.owner || t.runnerId === (caller as { runnerId?: string }).runnerId : t.runnerId === c.runnerId)) made = resultThreadId;
    }
    // A note is a line for the phone: cut, so a finished command stays small (pruneOld reads them).
    const said = note ? clean(cutBytes(note, caller.owner ? NOTE_MAX : CAP.note)) : undefined;
    await ctx.db.patch(commandId, { state: ok ? 'done' : 'failed', doneAt: Date.now(), ...(said ? { note: said } : {}), ...(made ? { resultThreadId: made } : {}), ...(kept !== undefined ? { result: kept } : {}) });
    // Its words, and a secret's sealed answer (docs/protocol.md, "Secrets"), have
    // done their job: see finishedArgs.
    await ctx.db.patch(commandId, { args: finishedArgs(c.args) });
    // The runner has its copy of the phone's photos by now, and images are
    // meant to live on the Mac. A failed send keeps its photos on the phone,
    // which uploads them again.
    // Only once nothing else names it: the same photo can be in another
    // runner's command, or in a picture row (deleteIfUnused).
    await endCommandFiles(ctx, commandId);
    for (const image of Array.isArray(c.args?.images) ? c.args.images : []) await deleteIfUnused(ctx, image.storageId);
    return null;
  },
});

// ------------------------------------------------------------ tool output
// Full sync (docs/full-convex.md step 4; sync.full in the runner's runner.json).
// A runner with it off never calls these. See schema.ts eventBodies.
export const BODY_KEEP_MS = 30 * 24 * 60 * 60_000;
// Rows pruneBodies deletes a run. Deleting reads the whole row, so this and the
// cron's 15 minutes are what deleting costs: 9,600 rows a day at most, more than
// the most that comes up, and it goes round again sooner only if it falls behind.
// In bytes too: a mutation may read 16 MiB, and a row can be hundreds of KB.
const BODY_PRUNE_BATCH = 100;
const BODY_PRUNE_BYTES = 4 * 1024 * 1024;
const BODY_SCRUB_ROWS = 25;

const bodyDoc = v.object({
  threadId: v.string(),
  seq: v.number(),
  withheld: v.optional(v.boolean()),
  reason: v.optional(v.string()),
  text: v.optional(v.string()),
  ok: v.optional(v.boolean()),
  truncated: v.optional(v.boolean()),
  input: v.optional(v.string()),
  diffs: v.optional(v.string()),
  reasoning: v.optional(v.string()),
  images: v.optional(v.number()),
  cut: v.optional(v.boolean()),
});

// The second pass on a body. input and diffs are JSON text, and a match can leave
// JSON text unparseable, so what they say is scrubbed and they're written again.
// One that doesn't parse isn't kept: nothing could read it.
function cleanBody<T extends { text?: string; input?: string; diffs?: string; reasoning?: string; reason?: string; images?: number }>(b: T): T {
  const out = { ...b };
  // A count, for a page to draw that many buttons from.
  if (out.images !== undefined && !(Number.isInteger(out.images) && out.images >= 0 && out.images <= 100)) delete out.images;
  for (const k of ['text', 'reasoning', 'reason'] as const) if (out[k] !== undefined) out[k] = clean(out[k]);
  for (const k of ['input', 'diffs'] as const) {
    if (out[k] === undefined) continue;
    const kept = cleanResult(out[k]!);
    if (kept === undefined) delete out[k];
    else out[k] = kept;
  }
  return out;
}

const sameBody = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  (['withheld', 'reason', 'text', 'ok', 'truncated', 'input', 'diffs', 'reasoning', 'images', 'cut'] as const).every((k) => a[k] === b[k]);

async function countBodyBytes(ctx: MutationCtx, runnerId: string, delta: number): Promise<void> {
  const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (usage) await ctx.db.patch(usage._id, { bodyBytes: Math.max(0, (usage.bodyBytes ?? 0) + delta) });
  else if (delta > 0) await ctx.db.insert('runnerStorage', { runnerId, bytes: 0, bodyBytes: delta });
}

function strippedBody(row: Doc<'eventBodies'>) {
  const { _id, _creationTime, ...rest } = row;
  return rest;
}

// skipped: a runner key's that wouldn't fit even after making room, or that's too
// big. The runner doesn't send them again: the tool shows as kept on that runner.
export const appendBodies = mutation({
  args: { key: v.string(), bodies: v.array(bodyDoc) },
  returns: v.object({ skipped: v.array(v.string()), closed: v.optional(v.array(v.string())) }),
  handler: async (ctx, { key, bodies }) => {
    const caller = await runnerAuth(ctx, key, 'appendBodies');
    const skipped: string[] = [];
    const closed = new Set<string>();
    const checked = new Map<string, 'yes' | 'none'>();
    let evicted = 0;
    const now = Date.now();
    for (const given of bodies) {
      if (!checked.has(given.threadId)) checked.set(given.threadId, await ownThread(ctx, caller, given.threadId));
      if (checked.get(given.threadId) === 'none') continue;
      if (caller.owner && (await closedId(ctx, given.threadId))) {
        skipped.push(`${given.threadId}:${given.seq}`);
        closed.add(given.threadId);
        continue;
      }
      if (!Number.isSafeInteger(given.seq)) continue;
      const b = cleanBody(given);
      const existing = await ctx.db
        .query('eventBodies')
        .withIndex('by_thread_seq', (q) => q.eq('threadId', b.threadId).eq('seq', b.seq))
        .first();
      // Sent again after a restart or a lost reply: nothing to write.
      if (existing && sameBody(existing, b)) continue;
      if (caller.owner) {
        if (existing) await ctx.db.replace(existing._id, { ...b, at: existing.at });
        else await ctx.db.insert('eventBodies', { ...b, at: now });
        continue;
      }
      if (existing && existing.runnerId !== caller.runnerId) continue;
      const row = { ...b, runnerId: caller.runnerId, at: existing?.at ?? now };
      const size = docBytes(row);
      if (size > CAP.bodyDoc) {
        skipped.push(`${b.threadId}:${b.seq}`);
        continue;
      }
      const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId)).unique();
      let used = (usage?.bodyBytes ?? 0) - (existing ? docBytes(strippedBody(existing)) : 0);
      while (used + size > CAP.bodyBytes && evicted < CAP.bodyEvictPerWrite) {
        const oldest = await ctx.db.query('eventBodies').withIndex('by_runner_at', (q) => q.eq('runnerId', caller.runnerId)).first();
        if (!oldest || oldest._id === existing?._id) break;
        await ctx.db.delete(oldest._id);
        used = Math.max(0, used - docBytes(strippedBody(oldest)));
        evicted++;
      }
      if (used + size > CAP.bodyBytes) {
        // Some may have gone to make room, even so.
        if (usage) await ctx.db.patch(usage._id, { bodyBytes: used + (existing ? docBytes(strippedBody(existing)) : 0) });
        skipped.push(`${b.threadId}:${b.seq}`);
        continue;
      }
      if (existing) await ctx.db.replace(existing._id, row);
      else await ctx.db.insert('eventBodies', row);
      if (usage) await ctx.db.patch(usage._id, { bodyBytes: used + size });
      else await ctx.db.insert('runnerStorage', { runnerId: caller.runnerId, bytes: 0, bodyBytes: used + size });
    }
    return { skipped, ...(closed.size ? { closed: [...closed] } : {}) };
  },
});

// What opening a tool gets. Null: nothing came up for it (full sync off then, or a
// row from before), and the reader says it's kept on the runner.
export const eventBodyAnswer = v.union(
  v.null(),
  v.object({ state: v.literal('withheld'), reason: v.optional(v.string()) }),
  v.object({ state: v.literal('expired') }),
  v.object({
    state: v.literal('text'),
    text: v.string(),
    ok: v.optional(v.boolean()),
    truncated: v.optional(v.boolean()),
    input: v.optional(v.string()),
    diffs: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    images: v.optional(v.number()),
    cut: v.optional(v.boolean()),
  }),
);

export async function readEventBody(ctx: QueryCtx, threadId: string, seq: number) {
  const row = await ctx.db.query('eventBodies').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).eq('seq', seq)).first();
  if (row) {
    if (row.withheld) return { state: 'withheld' as const, ...(row.reason ? { reason: row.reason } : {}) };
    const { text, ok, truncated, input, diffs, reasoning, images, cut } = row;
    return {
      state: 'text' as const,
      text: text ?? '',
      ...(ok !== undefined ? { ok } : {}),
      ...(truncated ? { truncated } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(diffs !== undefined ? { diffs } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(images ? { images } : {}),
      ...(cut ? { cut } : {}),
    };
  }
  // Gone, or never here? Its row says how old it is: one row, and a small one.
  const m = await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).eq('seq', seq)).first();
  if (m && Date.parse(m.at) < Date.now() - BODY_KEEP_MS) return { state: 'expired' as const };
  return null;
}

// The Mac's relay opening a tool on another runner's thread (runner/src/relay.ts).
export const remoteBody = query({
  args: { key: v.string(), threadId: v.string(), seq: v.number() },
  returns: eventBodyAnswer,
  handler: async (ctx, { key, threadId, seq }) => {
    await runnerAuth(ctx, key, 'remoteBody');
    return readEventBody(ctx, threadId, seq);
  },
});

// Deletes as many as fit one mutation, counting what it read whether or not it's
// deleted. True: there may be more, and something went this time.
async function deleteBodies(ctx: MutationCtx, rows: AsyncIterable<Doc<'eventBodies'>>, keep?: (row: Doc<'eventBodies'>) => boolean): Promise<boolean> {
  const freed = new Map<string, number>();
  let n = 0;
  let deleted = 0;
  let size = 0;
  let more = false;
  for await (const row of rows) {
    const bytes = docBytes(strippedBody(row));
    n++;
    size += bytes;
    if (!keep?.(row)) {
      await ctx.db.delete(row._id);
      deleted++;
      if (row.runnerId) freed.set(row.runnerId, (freed.get(row.runnerId) ?? 0) + bytes);
    }
    if (n >= BODY_PRUNE_BATCH || size >= BODY_PRUNE_BYTES) {
      more = deleted > 0;
      break;
    }
  }
  for (const [runnerId, bytes] of freed) await countBodyBytes(ctx, runnerId, -bytes);
  return more;
}

// `before`: a thread's own rows as of when it went. Its id can come back, whose new
// rows aren't this one's to delete.
export const dropBodies = internalMutation({
  args: { threadId: v.string(), before: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { threadId, before }) => {
    const until = before ?? Date.now();
    const rows = ctx.db.query('eventBodies').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId));
    if (await deleteBodies(ctx, rows, (row) => row.at > until)) await ctx.scheduler.runAfter(0, internal.sync.dropBodies, { threadId, before: until });
    return null;
  },
});

export const pruneBodies = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (await deleteBodies(ctx, ctx.db.query('eventBodies').withIndex('by_at', (q) => q.lt('at', Date.now() - BODY_KEEP_MS)))) await ctx.scheduler.runAfter(60_000, internal.sync.pruneBodies, {});
    return null;
  },
});

// One tool picture a person tapped (a `picture` command), there for a day.
// From a runner key only in answer to that command, which it has taken and
// not finished (runner/src/sync.ts sendHeldPicture records it before it
// finishes the command), so how many there are is how many were asked for.
const PICTURE_COMMANDS_READ = 50;
export const addHeldPicture = mutation({
  args: {
    key: v.string(),
    threadId: v.string(),
    seq: v.number(),
    index: v.number(),
    storageId: v.id('_storage'),
    mediaType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  returns: pictureAnswer,
  handler: async (ctx, { key, mediaType, ...sent }) => {
    const caller = await runnerAuth(ctx, key, 'addHeldPicture');
    checkPicture(caller, { ...sent, mediaType });
    const mine = await ownThread(ctx, caller, sent.threadId);
    await mustMayUseStorage(ctx, caller, sent.storageId);
    if (mine === 'none') return (await freeStorage(ctx, caller, sent.storageId), null);
    if (await closedId(ctx, sent.threadId)) return (await freeStorage(ctx, caller, sent.storageId), { later: true as const });
    if (!caller.owner) {
      const asked = await ctx.db.query('commands').withIndex('by_thread_state', (q) => q.eq('threadId', sent.threadId).eq('state', 'taken')).take(PICTURE_COMMANDS_READ);
      // Refused whole (nothing here is kept): its upload, never attached, goes after a day (pruneFiles).
      if (!asked.some((c) => c.kind === 'picture' && c.runnerId === caller.runnerId && c.args?.seq === sent.seq && c.args?.index === sent.index)) throw forbidden('hold a picture nobody asked for');
    }
    const same = await ctx.db
      .query('heldPictures')
      .withIndex('by_thread_seq', (q) => q.eq('threadId', sent.threadId).eq('seq', sent.seq).eq('index', sent.index))
      .first();
    if (same) await freeStorage(ctx, caller, sent.storageId);
    else {
      await mustBeUnnamed(ctx, caller, sent.storageId);
      await ctx.db.insert('heldPictures', { ...sent, mediaType: clean(mediaType), at: Date.now() });
    }
    return null;
  },
});

// Finished commands older than a day go, and paged marks older than a day
// come off (crons.ts). What deletes stored files is pruneFiles, on its own:
// a bad row there can't hold up the rest, nor this it.
export const pruneOld = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    // At most PRUNE_BATCH rows a run, each kind in turn; with more left it
    // runs again straight away. One mutation that tried to clear a flood in
    // one go would go past Convex's limits, roll back, and do so every run.
    let left = PRUNE_BATCH;
    // By when they finished. A finished command is small (its words dropped, a
    // note cut, a call's answer at most RESULT_MAX_BYTES), and what's read is
    // counted too, so a run of big ones ends the batch rather than the mutation.
    let read = 0;
    for (const state of ['done', 'failed'] as const) {
      for await (const c of ctx.db.query('commands').withIndex('by_state_done', (q) => q.eq('state', state).lt('doneAt', cutoff))) {
        if (left <= 0 || read >= PRUNE_COMMAND_BYTES) {
          left = 0;
          break;
        }
        read += docBytes(c);
        await ctx.db.delete(c._id);
        // Any record of its photos left from before endCommandFiles.
        if (Array.isArray(c.args?.images) && c.args.images.length) await endCommandFiles(ctx, c._id);
        left--;
      }
    }
    // Rows an old phone paged in drop back out of its view after a day; the
    // rows themselves stay, since every message is kept now. Fewer at a
    // time: a message row can be up to a few hundred KB (the main key's
    // aren't capped), and what's read is what counts.
    for (const m of await ctx.db.query('messages').withIndex('by_pagedAt', (q) => q.gt('pagedAt', 0).lt('pagedAt', cutoff)).take(Math.max(0, Math.min(left, PRUNE_MESSAGES)))) {
      await ctx.db.patch(m._id, { pagedAt: undefined });
      left -= Math.ceil(PRUNE_BATCH / PRUNE_MESSAGES);
    }
    // What sync:schedulesSince told runners went, likewise.
    for (const t of await ctx.db.query('scheduleGone').withIndex('by_at', (q) => q.lt('at', cutoff)).take(Math.max(0, left))) {
      await ctx.db.delete(t._id);
      left--;
    }
    // What phone:threadsSince told clients went, once they've had a day to hear.
    for (const t of await ctx.db.query('threadGone').withIndex('by_at', (q) => q.lt('at', cutoff)).take(Math.max(0, left))) {
      await ctx.db.delete(t._id);
      left--;
    }
    // Thread tombstones after TOMBSTONE_DAYS: by then whatever was under the
    // id is long gone. A share link's stays, so a public link never comes back.
    for (const t of await ctx.db.query('threadTombstones').withIndex('by_slug_at', (q) => q.eq('slug', undefined).lt('at', Date.now() - TOMBSTONE_DAYS * 86_400_000)).take(Math.max(0, left))) {
      await ctx.db.delete(t._id);
      left--;
    }
    // Upload URLs a day old, and runner keys' uploads never attached to
    // anything in a day (iconUploadUrl): one still named somewhere (a row
    // the owner wrote) is marked attached instead.
    for (const t of await ctx.db.query('uploadTickets').withIndex('by_issued', (q) => q.lt('issuedAt', cutoff)).take(Math.max(0, left))) {
      await ctx.db.delete(t._id);
      left--;
    }
    // Thread index tombstones (API 29), once watchers have had a day to see them.
    for (const t of await ctx.db.query('threadIndex').withIndex('by_deleted_updated', (q) => q.eq('deleted', true).lt('updatedMs', cutoff)).take(Math.max(0, left))) {
      await ctx.db.delete(t._id);
      left--;
    }
    // Only when it did a full batch's work: there may be more.
    if (left <= 0) await ctx.scheduler.runAfter(0, internal.sync.pruneOld, {});
    return null;
  },
});

// Stored files' rows that run out (crons.ts), each kind a mutation's share at a
// time, counted by what it read rather than how many: tool pictures tapped
// over a day ago, runner keys' and phones' uploads never attached in a day,
// and commands no runner took or finished in COMMAND_KEEP_MS. Each
// deleteIfUnused reads a few rows of its own (storageInUse), charged as a
// share of the row it's for, so rows from before picture rows were capped
// (up to 1 MiB each) still go, a few a run, rather than stopping it for good.
// With more left it runs again straight away.
export const COMMAND_KEEP_MS = 14 * 24 * 60 * 60_000;
const FILE_PRUNE_ROWS = 200;
const FILE_PRUNE_BYTES = 6 * 1024 * 1024;
// What storageInUse reads for one file: a row from each picture table, a few
// KB each since the caps (and limitsMigration cut the ones from before).
const FILE_CHECK_BYTES = 64 * 1024;
export const pruneFiles = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Not until rows from before the caps are cut down, or a check could read
    // far more than it's charged. Starts that if no heartbeat has (every Mac
    // asleep when this backend went up).
    if (!(await markSet(ctx, LIMITS_DONE))) {
      await startLimitsMigration(ctx);
      return null;
    }
    const now = Date.now();
    const cutoff = now - KEEP_FINISHED_MS;
    let rows = 0;
    let bytes = 0;
    const full = () => rows >= FILE_PRUNE_ROWS || bytes >= FILE_PRUNE_BYTES;
    const charge = (doc: unknown, checks: number) => {
      rows++;
      bytes += docBytes(doc) + checks * FILE_CHECK_BYTES;
    };
    for await (const img of ctx.db.query('heldPictures').withIndex('by_at', (q) => q.lt('at', cutoff))) {
      if (full()) break;
      charge(img, 1);
      await ctx.db.delete(img._id);
      await deleteIfUnused(ctx, img.storageId);
    }
    for await (const o of ctx.db.query('storageOwners').withIndex('by_unattached', (q) => q.eq('attachedAt', undefined).lt('at', cutoff))) {
      if (full()) break;
      charge(o, 1);
      if (await storageInUse(ctx, o.storageId)) await ctx.db.patch(o._id, { attachedAt: now });
      else await deleteIfUnused(ctx, o.storageId);
    }
    // The phone's: a photo picked and never sent, or a ticket never used. One
    // still in a waiting command stays (deleteIfUnused) until that's over.
    for await (const u of ctx.db.query('phoneUploads').withIndex('by_issued', (q) => q.lt('issuedAt', cutoff))) {
      if (full()) break;
      charge(u, u.storageId ? 1 : 0);
      await ctx.db.delete(u._id);
      if (u.storageId) await deleteIfUnused(ctx, u.storageId);
    }
    // Waiting or taken for weeks: its runner is gone, or never came back.
    for (const state of ['pending', 'taken'] as const) {
      for await (const c of ctx.db.query('commands').withIndex('by_state_created', (q) => q.eq('state', state).lt('createdAt', now - COMMAND_KEEP_MS))) {
        if (full()) break;
        const images = Array.isArray(c.args?.images) ? c.args.images : [];
        charge(c, images.length);
        await ctx.db.patch(c._id, { state: 'failed', doneAt: now, args: finishedArgs(c.args), note: state === 'pending' ? 'No runner took it in time.' : 'Its runner never finished it.' });
        await endCommandFiles(ctx, c._id);
        for (const image of images) await deleteIfUnused(ctx, image.storageId);
      }
    }
    if (full()) await ctx.scheduler.runAfter(0, internal.sync.pruneFiles, {});
    return null;
  },
});

// Rows written before the backend's limits (7 Nov 2026), once, a page at a
// time: picture rows cut to their caps (a mediaType, path or src of up to a
// MiB each would make every later check read that much), registrations with
// no real APNs token deleted (they never reached a phone), and commandFiles
// rows for commands already on their way, so a delete elsewhere still sees
// them. pruneFiles waits for it. Started by the first heartbeat (any key).
const LIMITS_STARTED = 'limits-2026-11-07';
const LIMITS_DONE = 'limits-2026-11-07-done';
const MIGRATE_PAGE = 8;
const APNS_TOKEN = /^[0-9a-fA-F]{16,200}$/;
const MAX_DEVICES_PER_TOKEN = 5;
async function markSet(ctx: QueryCtx | MutationCtx, name: string): Promise<boolean> {
  return (await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', name)).first()) !== null;
}
async function startLimitsMigration(ctx: MutationCtx): Promise<void> {
  if (await markSet(ctx, LIMITS_STARTED)) return;
  await ctx.db.insert('backendMarks', { name: LIMITS_STARTED });
  await ctx.scheduler.runAfter(0, internal.sync.limitsMigration, { step: 0, cursor: null });
}
const MIGRATE_STEPS = ['heldPictures', 'shareImages', 'replyImages', 'projectIcons', 'devices', 'deviceCap', 'pending', 'taken'] as const;
export const limitsMigration = internalMutation({
  args: { step: v.number(), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { step, cursor }) => {
    const what = MIGRATE_STEPS[step];
    if (!what) {
      if (!(await markSet(ctx, LIMITS_DONE))) await ctx.db.insert('backendMarks', { name: LIMITS_DONE });
      return null;
    }
    const q =
      what === 'pending' || what === 'taken'
        ? ctx.db.query('commands').withIndex('by_state', (x) => x.eq('state', what))
        : ctx.db.query(what === 'deviceCap' ? 'devices' : what);
    const page = await (q as any).paginate({ numItems: MIGRATE_PAGE, cursor });
    for (const row of page.page as Record<string, any>[]) {
      if (what === 'devices') {
        // Junk, or from before tokenId (they get no pushes: pushTargets.ts; devices:dropUnlinked).
        if (!row.tokenId || !APNS_TOKEN.test(row.apnsToken) || (row.pushKey !== undefined && row.pushKey.length > 100) || utf8Bytes(row.tokenName) > 200) await ctx.db.delete(row._id);
      } else if (what === 'deviceCap') {
        // Past a token's newest MAX_DEVICES_PER_TOKEN (phone.ts registerDevice); small rows by now.
        const newest = row.tokenId ? await ctx.db.query('devices').withIndex('by_tokenId', (x) => x.eq('tokenId', row.tokenId)).order('desc').take(MAX_DEVICES_PER_TOKEN) : [];
        if (row.tokenId && !newest.some((d) => d._id === row._id)) await ctx.db.delete(row._id);
      } else if (what === 'pending' || what === 'taken') {
        for (const image of Array.isArray(row.args?.images) ? row.args.images.slice(0, MAX_COMMAND_FILES) : []) {
          if (!image?.storageId) continue;
          const had = await ctx.db.query('commandFiles').withIndex('by_commandId', (x) => x.eq('commandId', row._id)).take(MAX_COMMAND_FILES);
          if (!had.some((f) => f.storageId === image.storageId)) await ctx.db.insert('commandFiles', { storageId: image.storageId, commandId: row._id });
        }
      } else if (docBytes(row) > 8 * 1024) {
        const cut: Record<string, string> = {};
        for (const [field, max] of [['mediaType', 100], ['path', PICTURE_PATH], ['src', PICTURE_PATH], ['picture', 200]] as const) {
          if (typeof row[field] === 'string' && utf8Bytes(row[field]) > max) cut[field] = cutBytes(row[field], max);
        }
        if (Object.keys(cut).length) await ctx.db.patch(row._id, cut);
      }
    }
    await ctx.scheduler.runAfter(0, internal.sync.limitsMigration, page.isDone ? { step: step + 1, cursor: null } : { step, cursor: page.continueCursor });
    return null;
  },
});

// ------------------------------------------------------------ thread index (API 12)
// The Mac app's view of other runners' threads (docs/step6-plan.md, part 2).
// A runner writes its own rows when what a sidebar shows changes; a Mac
// app's runner watches the other runners' rows and hands them to the app.

const indexDoc = v.object({
  threadId: v.string(),
  title: v.string(),
  cwd: v.string(),
  accountId: v.string(),
  provider: v.string(),
  model: v.optional(v.string()),
  status: v.string(),
  needsYou: v.boolean(),
  unread: v.boolean(),
  preview: v.string(),
  createdAt: v.string(),
  lastActivityAt: v.string(),
  snoozedUntil: v.optional(v.string()),
  archivedAt: v.optional(v.string()),
  starredAt: v.optional(v.string()),
  startedBy: v.optional(v.object({ kind: v.string(), label: v.string(), icon: v.optional(v.string()), threadTitle: v.optional(v.string()), why: v.optional(v.string()) })),
  asked: v.optional(v.string()), // since API 32
});

// Rows made or changed, and threads gone. With `keep`, every row of the
// runner whose thread isn't in it goes too (the first write after start).
export const setThreadIndex = mutation({
  args: { key: v.string(), runnerId: v.string(), rows: v.array(indexDoc), removed: v.array(v.string()), keep: v.optional(v.array(v.string())) },
  returns: v.null(),
  handler: async (ctx, { key, runnerId, rows, removed, keep }) => {
    const caller = await runnerAuth(ctx, key, 'setThreadIndex');
    rows = clean(rows);
    await actAs(ctx, caller, runnerId);
    // One runner's writes come one at a time, so its rows' updatedMs only
    // go up, which is what threadIndexSince relies on.
    const updatedMs = Date.now();
    // A runner key's rows are capped in number (CAP.indexRows), tombstones
    // included, keeping the most recent: a new one past the cap takes the
    // place of its oldest row, an archived one first. Archived threads are
    // listed too (API 54), so the main Mac's Archived list can reopen them;
    // rows too big even when cut are left out.
    let count = caller.owner ? 0 : (await ctx.db.query('threadIndex').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(CAP.indexRows + 1)).length;
    for (const given of rows) {
      const row = caller.owner ? given : fitIndexRow(given);
      if (!row) continue;
      const existing = await ctx.db
        .query('threadIndex')
        .withIndex('by_runner_thread', (q) => q.eq('runnerId', runnerId).eq('threadId', row.threadId))
        .unique();
      // One thread id is one runner's: a runner key's row for a thread
      // another runner has (or had) is left out, and one it wrote before the
      // thread became another's goes, so the Mac's sidebar never lists it
      // twice or under the wrong Mac. Checked on every write, not just the first.
      if (!(await claimable(ctx, caller, row.threadId))) {
        if (existing && !existing.deleted) await ctx.db.patch(existing._id, { deleted: true, updatedMs });
        continue;
      }
      if (existing) await ctx.db.replace(existing._id, { ...row, runnerId, updatedMs });
      else {
        if (!caller.owner && count >= CAP.indexRows) {
          // A tombstone gives way first, then the oldest archived row among
          // the oldest few, and a live one only when there's neither.
          const oldestFew = await ctx.db.query('threadIndex').withIndex('by_runner_updated', (q) => q.eq('runnerId', runnerId)).take(CAP.indexEvictScan);
          const oldest =
            (await ctx.db.query('threadIndex').withIndex('by_runner_deleted', (q) => q.eq('runnerId', runnerId).eq('deleted', true)).first()) ??
            oldestFew.find((r) => r.archivedAt) ??
            oldestFew[0];
          if (oldest) {
            await ctx.db.delete(oldest._id);
            count--;
          }
        }
        await ctx.db.insert('threadIndex', { ...row, runnerId, updatedMs });
        count++;
      }
    }
    // A gone thread's row stays a day as a tombstone, so a watcher reading
    // only what changed hears it went.
    const bury = async (row: Doc<'threadIndex'>) => {
      if (!row.deleted) await ctx.db.patch(row._id, { deleted: true, updatedMs });
    };
    for (const threadId of removed) {
      const row = await ctx.db
        .query('threadIndex')
        .withIndex('by_runner_thread', (q) => q.eq('runnerId', runnerId).eq('threadId', threadId))
        .unique();
      if (row) await bury(row);
    }
    // The first write after a start says which threads it still has.
    if (keep) {
      const kept = new Set([...keep, ...rows.map((r) => r.threadId)]);
      for await (const row of ctx.db.query('threadIndex').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
        if (!kept.has(row.threadId)) await bury(row);
      }
    }
    return null;
  },
});

const remoteRunner = v.object({ runnerId: v.string(), name: v.string(), icon: v.optional(v.string()), lastSeenAt: v.number(), rpcUrl: v.optional(v.string()) });

async function otherRunners(ctx: QueryCtx, runnerId: string) {
  const runners = [];
  for await (const r of ctx.db.query('runners')) {
    if (r.runnerId === runnerId) continue;
    runners.push({
      runnerId: r.runnerId,
      name: r.name,
      lastSeenAt: r.lastSeenAt,
      ...(r.icon !== undefined ? { icon: r.icon } : {}),
      ...(r.rpcUrl !== undefined ? { rpcUrl: r.rpcUrl } : {}),
    });
  }
  return runners;
}

// API 29: the other runners on their own, so a heartbeat re-runs only this
// small read, not the read of their threads.
export const otherRunnersList = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(remoteRunner),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'otherRunnersList');
    return otherRunners(ctx, runnerId);
  },
});

// API 58: Mike's runner order (lib.ts readRunnerOrder), the same one the
// phone sets, for the Mac's Settings > Runners. The main Mac's key only: a
// runner key can neither see nor move it, so no Mac with one can put
// itself first for his new threads.
export const runnerOrder = query({
  args: { key: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnerOrder');
    return readRunnerOrder(ctx);
  },
});

export const setRunnerOrder = mutation({
  args: { key: v.string(), runnerIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, runnerIds }) => {
    await runnerAuth(ctx, key, 'setRunnerOrder');
    await saveRunnerOrder(ctx, runnerIds);
    return null;
  },
});

// API 29: the given runners' rows written at or after `since` (each
// runner's own clock of updatedMs), tombstones included; with no `since`,
// all of that runner's rows. A watching runner re-subscribes with the
// newest updatedMs it has seen, so each re-run reads only what changed
// rather than every row (docs/convex-backend.md, "Usage and the free plan").
// At-or-after rather than after, so a row written in the same millisecond
// as the last answer isn't missed; reading it again is harmless.
export const threadIndexSince = query({
  args: { key: v.string(), runners: v.array(v.object({ runnerId: v.string(), since: v.optional(v.number()) })) },
  returns: v.array(v.object({ ...indexDoc.fields, runnerId: v.string(), updatedMs: v.optional(v.number()), deleted: v.optional(v.boolean()) })),
  handler: async (ctx, { key, runners }) => {
    await runnerAuth(ctx, key, 'threadIndexSince');
    const out = [];
    for (const { runnerId, since } of runners) {
      const rows =
        since === undefined
          ? ctx.db.query('threadIndex').withIndex('by_runner_updated', (q) => q.eq('runnerId', runnerId))
          : ctx.db.query('threadIndex').withIndex('by_runner_updated', (q) => q.eq('runnerId', runnerId).gte('updatedMs', since));
      // Bounded per runner: a runner key keeps at most CAP.indexRows; the
      // main key's own runners are the main Mac's to keep in check.
      for (const t of await rows.take(INDEX_READ_PER_RUNNER)) {
        const { _id, _creationTime, ...rest } = t;
        out.push(rest);
      }
    }
    return out;
  },
});

export const otherRunnersThreads = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.object({
    runners: v.array(remoteRunner),
    threads: v.array(v.object({ ...indexDoc.fields, runnerId: v.string() })),
  }),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'otherRunnersThreads');
    const runners = await otherRunners(ctx, runnerId);
    const threads = [];
    for (const r of runners) {
      for (const t of await ctx.db.query('threadIndex').withIndex('by_runnerId', (q) => q.eq('runnerId', r.runnerId)).take(INDEX_READ_PER_RUNNER)) {
        if (t.deleted) continue;
        const { _id, _creationTime, updatedMs: _u, deleted: _d, ...rest } = t;
        threads.push(rest);
      }
    }
    return { runners, threads };
  },
});

// ------------------------------------------------------------ runner keys (API 41)
// The main Mac's `tb runner add|list|revoke` (docs/protocol.md, "Runner
// keys"): a key for one other runner, which authenticates as that runnerId
// alone. The plain key goes back in the reply that made it and nowhere
// else; only its hash is kept.

const runnerKeyInfo = v.object({ runnerId: v.string(), name: v.string(), createdAt: v.string(), revokedAt: v.optional(v.string()) });

// `ownerRunnerId` is the main Mac's own runner id, as it asks: a key for it
// would let another Mac write as the main one. Ids are checked as given,
// never trimmed (lib.ts checkRunnerId), so what the asker compared is what
// the key is for.
// Over a runner id that has a live key only with `replace`: the CLI asks for
// it after showing which runner that is, so a Mac claiming another's id
// can't quietly take its place.
async function makeRunnerKey(ctx: MutationCtx, runnerId: string, name: string, ownerRunnerId: string, replace: boolean): Promise<{ runnerId: string; key: string }> {
  checkRunnerId(runnerId);
  if (runnerId === ownerRunnerId) throw new ConvexError({ kind: 'badArgs', message: "That's the main Mac's own runner id: a runner key is for another Mac." });
  if (!replace && (await hasLiveKey(ctx, runnerId))) throw new ConvexError({ kind: 'badArgs', message: `Runner ${runnerId} already has a live key. To replace it, ask again with replace.` });
  // Every id the main key names as its own is kept, so the audit can flag a
  // key made for one (with an earlier shared key). Not a refusal: an earlier
  // holder could have named any id, and Mike must still be able to key it.
  if (!(await ctx.db.query('ownerRunnerIds').withIndex('by_runnerId', (q) => q.eq('runnerId', ownerRunnerId)).first())) await ctx.db.insert('ownerRunnerIds', { runnerId: ownerRunnerId, at: Date.now() });
  let live = 0;
  for await (const k of ctx.db.query('runnerKeys')) if (!k.revokedAt && k.runnerId !== runnerId) live++;
  // Each runner key's share of the lists read whole is budgeted for at most this many (CAP).
  if (live >= MAX_RUNNER_KEYS) throw new ConvexError({ kind: 'tooMany', message: `At most ${MAX_RUNNER_KEYS} runner keys: revoke one first.` });
  const label = name.trim().slice(0, 80);
  if (!label) throw new ConvexError({ kind: 'badArgs', message: 'name must not be blank' });
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = 'tbr_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  // One live key per runner: a new one is how a key is rotated.
  for await (const row of ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
    if (!row.revokedAt) await ctx.db.patch(row._id, { revokedAt: now });
  }
  // A new key shares no logins until the owner says (tb runner logins), as
  // it may be a different Mac under the same id.
  await dropRunnerLogins(ctx, runnerId);
  await ctx.db.insert('runnerKeys', { runnerId, keyHash: await sha256(key), name: label, createdAt: now });
  // It's no longer the main key's runner: off the phone's default at once,
  // not when it next heartbeats (phone.ts mainRunner).
  const row = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (row?.byOwner) await ctx.db.patch(row._id, { byOwner: undefined });
  return { runnerId, key };
}

export const addRunnerKey = mutation({
  args: { key: v.string(), runnerId: v.string(), name: v.string(), ownerRunnerId: v.string(), replace: v.optional(v.boolean()) },
  returns: v.object({ runnerId: v.string(), key: v.string() }),
  handler: async (ctx, { key, runnerId, name, ownerRunnerId, replace }) => {
    await runnerAuth(ctx, key, 'addRunnerKey');
    // runner-keys.ts posts straight to the backend, not through ConvexSync's
    // scrubbing wrapper, so this pass is the only one its name gets.
    return makeRunnerKey(ctx, runnerId, clean(name), ownerRunnerId, Boolean(replace));
  },
});

// `rotating`: RUNNER_KEY_NEXT is set, so two owner keys work. It should
// only be for the minutes `tb runner rotate-owner` takes.
export const listRunnerKeys = query({
  args: { key: v.string() },
  returns: v.object({ keys: v.array(runnerKeyInfo), rotating: v.boolean() }),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'listRunnerKeys');
    const rows = await ctx.db.query('runnerKeys').collect();
    const keys = rows.map((r) => ({ runnerId: r.runnerId, name: r.name, createdAt: new Date(r.createdAt).toISOString(), ...(r.revokedAt ? { revokedAt: new Date(r.revokedAt).toISOString() } : {}) }));
    return { keys, rotating: Boolean(process.env.RUNNER_KEY_NEXT) };
  },
});

// How many live keys it revoked (0: that runner had none).
export const revokeRunnerKey = mutation({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.number(),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'revokeRunnerKey');
    checkRunnerId(runnerId);
    let n = 0;
    for await (const row of ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))) {
      if (row.revokedAt) continue;
      await ctx.db.patch(row._id, { revokedAt: Date.now() });
      n++;
    }
    // What it shared goes with it (dropRunnerLogins).
    await dropRunnerLogins(ctx, runnerId);
    return n;
  },
});

// ------------------------------------------------------------ shared logins (API 53)
// Which logins a runner key's runner shares with the main Mac, as the owner
// says (`tb runner logins`): sharedUsage goes by these alone.

const loginDoc = v.object({ provider: v.string(), email: v.string() });

async function dropRunnerLogins(ctx: { db: MutationCtx['db'] }, runnerId: string): Promise<void> {
  for (const l of await ctx.db.query('runnerLogins').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).collect()) await ctx.db.delete(l._id);
}

// Replaces that runner's list; an empty one stops it sharing. Only for a
// runner with a live key of its own: one on the main key is the main Mac's
// word already. Revoking or replacing its key empties the list.
export const setRunnerLogins = mutation({
  args: { key: v.string(), runnerId: v.string(), logins: v.array(loginDoc) },
  returns: v.number(),
  handler: async (ctx, { key, runnerId, logins }) => {
    await runnerAuth(ctx, key, 'setRunnerLogins');
    checkRunnerId(runnerId);
    if (!(await hasLiveKey(ctx, runnerId))) throw new ConvexError({ kind: 'badArgs', message: `Runner ${runnerId} has no live key of its own (tb runner list shows them): a runner on the main key needs no list.` });
    const seen = new Set<string>();
    const rows: { provider: string; email: string }[] = [];
    for (const l of logins) {
      const provider = l.provider.trim().toLowerCase();
      const email = l.email.trim().toLowerCase();
      if (!LOGIN_PROVIDER.test(provider) || !LOGIN_EMAIL.test(email)) throw new ConvexError({ kind: 'badArgs', message: `Not a login: give each as provider:email, like claude:you@example.com.` });
      if (seen.has(loginKey(provider, email))) continue;
      seen.add(loginKey(provider, email));
      rows.push({ provider, email });
    }
    if (rows.length > CAP.accounts) throw tooMany('shared logins for one runner', CAP.accounts);
    await dropRunnerLogins(ctx, runnerId);
    const at = Date.now();
    for (const r of rows) await ctx.db.insert('runnerLogins', { runnerId, ...r, at });
    return rows.length;
  },
});

// Each runner with a key of its own: the logins it shares (the owner's
// list), and the ones its own accounts rows name, which are only what that
// runner says it has, for Mike to check before adding them.
export const runnerLogins = query({
  args: { key: v.string() },
  returns: v.array(v.object({ runnerId: v.string(), name: v.string(), live: v.boolean(), shared: v.array(loginDoc), claimed: v.array(loginDoc) })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnerLogins');
    // Named as its newest key is.
    const byRunner = new Map<string, { name: string; live: boolean }>();
    for (const k of (await ctx.db.query('runnerKeys').collect()).sort((a, b) => a.createdAt - b.createdAt)) byRunner.set(k.runnerId, { name: k.name, live: Boolean(byRunner.get(k.runnerId)?.live) || !k.revokedAt });
    const out = [];
    for (const [runnerId, { name, live }] of byRunner) {
      const shared = (await ctx.db.query('runnerLogins').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(CAP.accounts)).map(({ provider, email }) => ({ provider, email }));
      const claimed: { provider: string; email: string }[] = [];
      for (const a of await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(CAP.accounts)) {
        if (a.email && !claimed.some((c) => loginKey(c.provider, c.email) === loginKey(a.provider, a.email!))) claimed.push({ provider: cutBytes(a.provider, 40), email: cutBytes(a.email, 200) });
      }
      out.push({ runnerId, name, live, shared, claimed });
    }
    return out;
  },
});

// ------------------------------------------------------------ audit (tb runner audit)
// What a Mac that held the shared key before runner keys could have left
// behind, which rotating the key doesn't undo: phone tokens, runner keys,
// schedules (any runner, any text, folder and permissions), Pocket cards
// filed with the main key, and messages past a thread's own last seq (the
// runner gives those: `heads`, from its own threads). Owner only. Listed
// for Mike to judge; auditRemove takes out what he picks.

const AUDIT_TEXT = 160;
// A page of one section at a time, so a flood of rows, or rows made huge
// with the old shared key (the main key's writes aren't capped), can't make
// the audit itself fail: credentials are read live ones only, straight from
// an index, and planted messages a few at a time.
// Pages are sized by how big a row can be: tokens and keys are small; a
// schedule, card or picture row the old shared key wrote could be huge
// (the main key's writes aren't capped), and a whole row is read either way.
const AUDIT_PAGE = 100;
const AUDIT_SCHEDULES = 10;
const AUDIT_CARDS = 5;
const AUDIT_MESSAGES = 5;
const AUDIT_PICTURES = 5;
const sections = ['tokens', 'runnerKeys', 'schedules', 'runnerSchedules', 'cards', 'messages', 'replyImages', 'shareImages'] as const;
type Section = (typeof sections)[number];

// What a row was when the audit showed it: auditRemove touches it only if it still is.
function versionOf(kind: string, row: Record<string, any>): string {
  if (kind === 'token') return `${row.expiresAt}:${row.revokedAt ?? ''}`;
  if (kind === 'key') return `${row.createdAt}:${row.revokedAt ?? ''}`;
  if (kind === 'schedule') return String(row.updatedAt);
  if (kind === 'card') return String(row.updatedAt);
  return String(row._creationTime);
}

export const audit = query({
  args: {
    key: v.string(),
    section: v.union(...sections.map((x) => v.literal(x))),
    cursor: v.optional(v.string()),
    heads: v.optional(v.array(v.object({ threadId: v.string(), lastSeq: v.number() }))),
    // This Mac's own runner id, so a runner key made for it is flagged.
    ownRunnerId: v.optional(v.string()),
  },
  returns: v.object({ ownerKeyPrint: v.string(), rows: v.array(v.any()), next: v.optional(v.string()) }),
  handler: async (ctx, { key, section, cursor, heads, ownRunnerId }) => {
    await runnerAuth(ctx, key, 'audit');
    const ownerKeyPrint = (await sha256(key)).slice(0, 8);
    const after = cursor && /^\d+(\.\d+)?$/.test(cursor) ? Number(cursor) : -1;
    const done = (rows: Record<string, unknown>[], last?: number, full?: boolean) => ({ ownerKeyPrint, rows, ...(full && last !== undefined ? { next: String(last) } : {}) });
    const t = (x: unknown, n = AUDIT_TEXT) => String(x ?? '').slice(0, n);
    if (section === 'tokens') {
      const page = await ctx.db.query('tokens').withIndex('by_revokedAt', (q) => q.eq('revokedAt', undefined).gt('_creationTime', after)).take(AUDIT_PAGE);
      const rows = page.filter((r) => r.expiresAt >= Date.now()).map((r) => ({ kind: 'token', id: r._id, version: versionOf('token', r), name: t(r.name, 60), ...(r.kind ? { tokenKind: r.kind } : {}), createdAt: new Date(r.createdAt).toISOString(), expiresAt: new Date(r.expiresAt).toISOString(), ...(r.issuedBy ? { issuedBy: r.issuedBy } : {}), ...(r.ownerKeyPrint ? { ownerKeyPrint: r.ownerKeyPrint } : {}) }));
      return done(rows, page[page.length - 1]?._creationTime, page.length === AUDIT_PAGE);
    }
    if (section === 'runnerKeys') {
      const page = await ctx.db.query('runnerKeys').withIndex('by_revokedAt', (q) => q.eq('revokedAt', undefined).gt('_creationTime', after)).take(AUDIT_PAGE);
      const rows = [];
      for (const r of page) {
        const mainMac = r.runnerId === ownRunnerId || (await ctx.db.query('ownerRunnerIds').withIndex('by_runnerId', (q) => q.eq('runnerId', r.runnerId)).first()) !== null;
        rows.push({ kind: 'key', id: r._id, version: versionOf('key', r), runnerId: r.runnerId, name: t(r.name, 60), createdAt: new Date(r.createdAt).toISOString(), mainMac });
      }
      return done(rows, page[page.length - 1]?._creationTime, page.length === AUDIT_PAGE);
    }
    if (section === 'schedules' || section === 'runnerSchedules') {
      // The main key's runners' schedules, and apart from them a runner
      // key's own (their churn mustn't change the list a --drop is checked against).
      const page = await ctx.db.query('schedules').withIndex('by_creation_time', (q) => q.gt('_creationTime', after)).take(AUDIT_SCHEDULES);
      const keyed = new Map<string, boolean>();
      const rows = [];
      for (const r of page) {
        if (!r.owned) continue;
        if (!keyed.has(r.runnerId)) keyed.set(r.runnerId, await hasLiveKey(ctx, r.runnerId));
        if (keyed.get(r.runnerId) !== (section === 'runnerSchedules')) continue;
        rows.push({ kind: 'schedule', id: r._id, version: versionOf('schedule', r), scheduleId: t(r.id, 64), runnerId: r.runnerId, title: t(r.title), text: t(r.text), ...(r.cwd ? { cwd: t(r.cwd) } : {}), ...(r.permissionMode ? { permissionMode: r.permissionMode } : {}), ...(r.createdBy ? { createdBy: t(r.createdBy, 40) } : {}), createdAt: t(r.createdAt, 40) });
      }
      return done(rows, page[page.length - 1]?._creationTime, page.length === AUDIT_SCHEDULES);
    }
    if (section === 'cards') {
      const page = await ctx.db.query('pocketCards').withIndex('by_runnerId', (q) => q.eq('runnerId', undefined).gt('_creationTime', after)).take(AUDIT_CARDS);
      return done(page.map((c) => ({ kind: 'card', id: c._id, version: versionOf('card', c), title: t(c.title, 60), ...(c.threadId ? { threadId: t(c.threadId, 64) } : {}), updatedAt: t(c.updatedAt, 40) })), page[page.length - 1]?._creationTime, page.length === AUDIT_CARDS);
    }
    // Per thread, past its own last seq. The cursor is "<thread index>:<seq>".
    const list = heads ?? [];
    let [i, seq] = cursor && /^\d+:-?\d+$/.test(cursor) ? cursor.split(':').map(Number) as [number, number] : [0, -Infinity];
    for (; i < list.length; i++, seq = -Infinity) {
      const { threadId, lastSeq } = list[i]!;
      const from = Math.max(lastSeq, seq);
      const n = section === 'messages' ? AUDIT_MESSAGES : AUDIT_PICTURES;
      const page = await ctx.db.query(section).withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).gt('seq', from)).take(n);
      if (!page.length) continue;
      const rows = page.map((r: any) => (section === 'messages' ? { kind: 'message', id: r._id, version: versionOf('message', r), threadId: t(threadId, 64), seq: r.seq, text: t(r.text, 100) } : { kind: 'picture', id: r._id, version: versionOf('picture', r), table: section, threadId: t(threadId, 64), seq: r.seq, path: t(r.path, 100) }));
      const last = page[page.length - 1]!.seq;
      return { ownerKeyPrint, rows, next: page.length === n ? `${i}:${last}` : `${i + 1}:-1` };
    }
    return { ownerKeyPrint, rows: [] };
  },
});

// Exactly the rows the audit listed, each only if it's still the version it
// showed: a key replaced or a schedule edited since isn't touched.
export const auditRemove = mutation({
  args: { key: v.string(), rows: v.array(v.object({ kind: v.string(), id: v.string(), version: v.string() })) },
  returns: v.number(),
  handler: async (ctx, { key, rows }) => {
    await runnerAuth(ctx, key, 'auditRemove');
    let n = 0;
    const tableOf: Record<string, string[]> = { token: ['tokens'], key: ['runnerKeys'], schedule: ['schedules'], card: ['pocketCards'], message: ['messages'], picture: ['replyImages', 'shareImages'] };
    for (const r of rows) {
      for (const table of tableOf[r.kind] ?? []) {
        const id = ctx.db.normalizeId(table as 'tokens', r.id);
        const row = id ? ((await ctx.db.get(id)) as Record<string, any> | null) : null;
        if (!row || versionOf(r.kind, row) !== r.version) continue;
        if (r.kind === 'token') {
          if (await revokeOne(ctx, r.id)) n++;
        } else if (r.kind === 'key') {
          await ctx.db.patch(row._id, { revokedAt: Date.now() });
          await dropRunnerLogins(ctx, row.runnerId);
          n++;
        } else {
          await ctx.db.delete(row._id);
          if (r.kind === 'picture') await deleteIfUnused(ctx, row.storageId);
          if (r.kind === 'schedule') {
            await ctx.db.insert('scheduleGone', { id: row.id, runnerId: row.runnerId, at: Date.now() });
            if (!(await scheduleRow(ctx, row.id))) await dropWake(ctx, row.id);
          }
          n++;
        }
      }
    }
    return n;
  },
});

// `tb runner revoke <runnerId> --purge`: everything a runner wrote, once its
// key is revoked (a live one would write it all again): threads with their
// messages and pictures, sidebar rows, Pocket cards, schedules, projects
// with their pictures, accounts, its runner row. A batch a call, so a big
// runner takes a few; `done` says when there's nothing left.
const PURGE_BATCH = 50;
const PURGE_MESSAGES = 200;
export const purgeRunner = mutation({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'purgeRunner');
    checkRunnerId(runnerId);
    if (await hasLiveKey(ctx, runnerId)) throw new ConvexError({ kind: 'badArgs', message: `Revoke runner ${runnerId}'s key first (tb runner revoke ${runnerId}), or it writes everything again.` });
    // Only a runner that had a key of its own: one that never did is the
    // main key's (a Mac still on the main key comes straight back, and its
    // schedules here are the only copy).
    if (!(await ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).first())) throw new ConvexError({ kind: 'badArgs', message: `Runner ${runnerId} never had a key of its own: not purging it.` });
    // Never the main Mac's own: its schedules there are the only copy.
    if (await ctx.db.query('ownerRunnerIds').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).first()) throw new ConvexError({ kind: 'badArgs', message: `${runnerId} is a runner id the main key has named as its own: not purging it.` });
    let left = PURGE_BATCH;
    // A thread at a time, its messages and pictures a page a call, so a long
    // one takes a few calls rather than one too big to finish.
    const t = await ctx.db.query('threads').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).first();
    if (t) {
      const msgs = await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', t.threadId)).take(PURGE_MESSAGES);
      for (const m of msgs) await ctx.db.delete(m._id);
      if (msgs.length === PURGE_MESSAGES) return { done: false };
      for (const table of ['replyImages', 'shareImages'] as const) {
        const imgs = await ctx.db.query(table).withIndex('by_thread_seq', (q) => q.eq('threadId', t.threadId)).take(PURGE_BATCH);
        for (const img of imgs) {
          await ctx.db.delete(img._id);
          await deleteIfUnused(ctx, img.storageId);
        }
        if (imgs.length === PURGE_BATCH) return { done: false };
      }
      await dropThread(ctx, t.threadId, t);
      return { done: false };
    }
    for (const table of ['threadIndex', 'pocketCards', 'runnerRequests', 'schedules', 'projects', 'projectHeads', 'projectNotes', 'accounts', 'runnerLogins'] as const) {
      if (left <= 0) break;
      for (const r of await ctx.db.query(table).withIndex('by_runnerId', (q: any) => q.eq('runnerId', runnerId)).take(left)) {
        await ctx.db.delete(r._id);
        // The owner's runner holds a copy of every schedule, this one's too.
        if (table === 'schedules') {
          await ctx.db.insert('scheduleGone', { id: (r as Doc<'schedules'>).id, runnerId, at: Date.now() });
          // An old mirror row can share its id with another runner's live schedule,
          // whose wake this is then, so it stays.
          if (!(await scheduleRow(ctx, (r as Doc<'schedules'>).id))) await dropWake(ctx, (r as Doc<'schedules'>).id);
        }
        left--;
      }
    }
    if (left > 0) {
      for (const icon of await ctx.db.query('projectIcons').withIndex('by_runner_project', (q) => q.eq('runnerId', runnerId)).take(left)) {
        await ctx.db.delete(icon._id);
        await deleteIfUnused(ctx, icon.storageId);
        left--;
      }
    }
    if (left > 0) {
      for (const table of ['runners', 'viewCounts'] as const) {
        const row = await ctx.db.query(table).withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
        if (row) await ctx.db.delete(row._id);
      }
      return { done: true };
    }
    return { done: false };
  },
});

// ------------------------------------------------------------ rewriting what's stored
// Today's rules over rows stored before them: `appendMessages` never rewrites a
// row, and a runner doesn't send one again, so a new rule doesn't reach old
// rows by itself. runner/scripts/scrub-stored.mjs calls this a page at a time,
// by hand, dry run unless told otherwise. It says which rows and how many,
// never what was in them. Nothing changes for a runner: what it remembers
// sending is unaffected, so it re-sends nothing. The owner key's only.
const SCRUB_TABLES = ['messages', 'threads', 'threadIndex', 'projects', 'schedules', 'pocketCards', 'accounts', 'commands', 'replyImages', 'shareImages', 'pools', 'runners', 'tokens', 'runnerKeys', 'runnerStats', 'projectIcons', 'projectHeads', 'projectNotes', 'eventBodies'] as const;

function sameOr<T extends Record<string, any>>(doc: T, next: T): T {
  return Object.keys({ ...doc, ...next }).every((k) => doc[k] === next[k]) ? doc : next;
}

export const scrubStoredBatch = mutation({
  args: {
    key: v.string(),
    table: v.union(...SCRUB_TABLES.map((t) => v.literal(t))),
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
    limit: v.optional(v.number()),
  },
  returns: v.object({ scanned: v.number(), changed: v.array(v.string()), cursor: v.string(), done: v.boolean(), rulesVersion: v.number() }),
  handler: async (ctx, { key, table, cursor, apply, limit }) => {
    await runnerAuth(ctx, key, 'scrubStoredBatch');
    // Fewer of these at a time, as a row can be hundreds of KB.
    const most = table === 'eventBodies' ? BODY_SCRUB_ROWS : 500;
    const page = await (ctx.db.query(table) as any).paginate({ numItems: pageLimit(limit, Math.min(200, most), most), cursor });
    const changed: string[] = [];
    for (const row of page.page as Record<string, any>[]) {
      // A command still on its way has to reach the runner as it was typed.
      if (table === 'commands' && (row.state === 'pending' || row.state === 'taken')) continue;
      const { _id, _creationTime, ...doc } = row;
      // Tool output's input and diffs are JSON text, to be scrubbed as JSON.
      const scrubbed: Record<string, any> = table === 'eventBodies' ? sameOr(doc, cleanBody(doc)) : clean(doc);
      if (scrubbed === doc) continue;
      changed.push(String(_id));
      if (!apply) continue;
      const next = { ...scrubbed };
      // A card's lookup key follows its title, for its runner if it has one.
      if (table === 'pocketCards') next.key = cardKey(row.runnerId ? ({ owner: false, runnerId: row.runnerId } as Caller) : ({ owner: true } as Caller), next.title);
      // So a Mac watching only what changed (threadIndexSince) hears of it.
      if (table === 'threadIndex' || table === 'schedules') next.updatedMs = Date.now();
      await ctx.db.replace(_id as any, next as any);
      if (table === 'eventBodies' && row.runnerId) await countBodyBytes(ctx, row.runnerId, docBytes(next) - docBytes(doc));
      // The list's copy of a title, or it keeps showing the old one.
      if (table === 'projects') await syncHead(ctx, next as any);
    }
    return { scanned: page.page.length, changed, cursor: page.continueCursor, done: page.isDone, rulesVersion: SCRUB_RULES_VERSION };
  },
});
