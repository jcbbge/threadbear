// The phone's API (ios/, thread f5247e5b). Every function takes the phone
// token and throws ConvexError({ kind: "auth" }) for a bad or expired one.
// Queries read the mirror; mutations only ever add a row to `commands`,
// which the owning runner applies (step 3 of docs/convex-backend.md) and
// marks done or failed. Nothing here touches a runner directly.
import { ConvexError, v, type Infer } from 'convex/values';
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { messageButton, threadFields, views } from './schema';
import { checkPhoneToken, hasLiveKey, pageLimit, readRunnerOrder, runnerStatsRows, saveRunnerOrder, sha256, watchRunnersFor } from './lib';
import { API_VERSION } from './version';
import { pushOff } from './pushHealth';
import { imagesFrom, phoneImage, replyImagesFrom } from './share';
import { deleteIfUnused, endCommandFiles, eventBodyAnswer, finishedArgs, readEventBody, runnerName } from './sync';
import { docBytes } from './runnerAccess';
import { HEADS_MARK } from './projectHeads';
import { notesOf } from './projectNotes';

// A runner not heard from for this long is offline, and a command with no
// runnerId goes to the main one still online (mainRunner).
const ONLINE_MS = 3 * 60_000;
const DEN_LIMIT = 100;
const MAX_COMMAND_IMAGES = 6;
// What may wait for one runner (queue): a runner asleep for a night gets a
// few dozen; past these a phone's next one is refused until it takes some.
// Bytes too, as one command can be most of a megabyte, and the runner reads
// them all in one query (sync:pendingCommands).
const WAITING_PER_RUNNER = 200;
const WAITING_BYTES_PER_RUNNER = 8 * 1024 * 1024;
// phone:waiting reads at most this many of a thread's pending sends, and as many taken.
const WAITING_LIMIT = 50;

const row = v.object({ ...threadFields, view: v.union(...views.map((x) => v.literal(x))) });
const message = v.object({ seq: v.number(), role: v.union(v.literal('user'), v.literal('assistant')), text: v.string(), origin: v.optional(v.string()), at: v.string() });
const pageMessage = v.object({ seq: v.number(), role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool')), text: v.string(), origin: v.optional(v.string()), toolKind: v.optional(v.string()), summary: v.optional(v.boolean()), turn: v.optional(v.string()), wokeBy: v.optional(v.array(v.object({ kind: v.string(), description: v.string() }))), buttons: v.optional(v.array(messageButton)), at: v.string() });
// phone:thread's newest text messages for an old phone, and how far back it
// looks past tool rows for them.
const MESSAGES_SHOWN = 20;
const THREAD_SCAN = 400;
// phone:messages page sizes.
const PAGE_DEFAULT = 50;
// The website asks for more as you scroll back by raising limit, so one
// live query covers everything it shows.
const PAGE_MAX = 2000;
// Without tools: true, how many tool rows a page may look past for its text
// messages. Most rows are one-line tool rows, so a page stops at this many
// read whatever it found, and says there's more.
const TOOL_ROWS_SKIPPED = 4000;
const PAGE_BYTES = 8 * 1024 * 1024;

function strip<T extends { _id: unknown; _creationTime: unknown }>(doc: T): Omit<T, '_id' | '_creationTime'> {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
}

// A thread row as the phone sees it: only the fields `row` lists. The
// mirror keeps fields of its own on the row (pushedAt and pushHeldAt from
// push.ts, and whatever comes next), and returning one fails the query's
// validator, which broke every phone's inbox twice: once for pushedAt on
// 27 Oct, once for pushHeldAt on 29 Oct (a push held back while Mike was
// at the Mac). So the row is picked by the validator's own keys, not
// stripped of the ones known today.
const PHONE_THREAD_KEYS = new Set([...Object.keys(threadFields), 'view']);
type PhoneThread = Infer<typeof row>;
function stripThread(doc: Doc<'threads'>): PhoneThread {
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(doc)) if (PHONE_THREAD_KEYS.has(k) && value !== undefined) out[k] = value;
  // Out of its list for a runner key's cap (sync.ts upsertThreads): shown where it belongs.
  if (doc.view === 'overflow') out.view = doc.wantView ?? 'inbox';
  return out as PhoneThread;
}

// apiVersion is the backend's (version.ts), so the app can say "update
// Threadbear on your Mac" when it's talking to a backend older than it needs.
// pushOff: this backend can't send notifications (pushHealth.ts), so the
// phone's Settings says so. An older phone ignores it.
export const me = query({
  args: { token: v.string() },
  returns: v.object({ name: v.string(), expiresAt: v.string(), apiVersion: v.number(), pushOff: v.optional(v.boolean()) }),
  handler: async (ctx, { token }) => {
    const t = await checkPhoneToken(ctx, token);
    return { name: t.name, expiresAt: new Date(t.expiresAt).toISOString(), apiVersion: API_VERSION, ...(pushOff(process.env) ? { pushOff: true } : {}) };
  },
});

export const runners = query({
  args: { token: v.string() },
  // release to pressure since API 45, for the website's runner page. An older
  // phone ignores them. In Mike's order since API 56 (orderedRunners), with
  // `placed` on the ones he's put in it and `main` on the main Mac: only
  // those are ever a new thread's automatic choice.
  returns: v.array(v.object({ runnerId: v.string(), name: v.string(), version: v.string(), lastSeenAt: v.string(), draining: v.boolean(), release: v.optional(v.string()), startedAt: v.optional(v.string()), threadCount: v.optional(v.number()), pressure: v.optional(v.string()), placed: v.optional(v.boolean()), main: v.optional(v.boolean()) })),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    const saved = await readRunnerOrder(ctx);
    const runners = await orderedRunners(ctx);
    // `main`: the owner-key Mac a new thread waits for when none of the
    // placed ones is online, so the phone never falls back to just "the
    // first listed", which with no main Mac known is a runner key's.
    const main = await mainOwnerRunner(ctx, runners, false);
    return runners.map((r) => ({ runnerId: r.runnerId, name: r.name, version: r.version, lastSeenAt: new Date(r.lastSeenAt).toISOString(), draining: r.draining, ...(r.release ? { release: r.release } : {}), startedAt: r.startedAt, threadCount: r.threadCount, ...(r.pressure ? { pressure: r.pressure } : {}), ...(saved.includes(r.runnerId) ? { placed: true } : {}), ...(r.runnerId === main ? { main: true } : {}) }));
  },
});

// Mike's order for his runners (API 57), from the phone's Settings. The
// phone sends every runner it lists; ids it doesn't know of yet are kept as
// sent, and a runner left out goes after the ones in it.
export const setRunnerOrder = mutation({
  args: { token: v.string(), runnerIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { token, runnerIds }) => {
    await checkPhoneToken(ctx, token);
    await saveRunnerOrder(ctx, runnerIds);
    return null;
  },
});

// Every runner, in Mike's order: the ones he's placed as he placed them, then
// the rest with the main Mac first (isMain) and the others as they first
// heartbeated. Never by anything a runner says of itself, like its thread
// count, so a runner key can't push itself up the list.
async function orderedRunners(ctx: QueryCtx): Promise<Doc<'runners'>[]> {
  const all: Doc<'runners'>[] = [];
  for await (const r of ctx.db.query('runners')) all.push(r);
  const saved = await readRunnerOrder(ctx);
  const main = await mainOwnerRunner(ctx, all, false);
  const rank = (r: Doc<'runners'>) => {
    const i = saved.indexOf(r.runnerId);
    return i >= 0 ? i : saved.length + (r.runnerId === main ? 0 : 1);
  };
  // Array sort is stable, so ties keep the table's creation order.
  return all.sort((a, b) => rank(a) - rank(b));
}

// Newest activity first. The den is capped at DEN_LIMIT.
export const threads = query({
  args: { token: v.string(), view: v.union(...views.map((x) => v.literal(x))) },
  returns: v.array(row),
  handler: async (ctx, { token, view }) => {
    await checkPhoneToken(ctx, token);
    const q = ctx.db
      .query('threads')
      .withIndex('by_view_activity', (x) => x.eq('view', view))
      .order('desc');
    const rows = view === 'den' ? await q.take(DEN_LIMIT) : await q.collect();
    return rows.map(stripThread);
  },
});

// A list once, and the time to follow it from with threadsSince (API 43). The
// list re-read whole for every row written was most of the I/O of an open
// phone or browser: about 39 KB a time, hundreds of times an hour.
export const threadsAt = query({
  args: { token: v.string(), view: v.union(...views.map((x) => v.literal(x))) },
  returns: v.object({ rows: v.array(row), at: v.number() }),
  handler: async (ctx, { token, view }) => {
    await checkPhoneToken(ctx, token);
    const q = ctx.db.query('threads').withIndex('by_view_activity', (x) => x.eq('view', view)).order('desc');
    const rows = view === 'den' ? await q.take(DEN_LIMIT) : await q.collect();
    return { rows: rows.map(stripThread), at: Date.now() };
  },
});

const SINCE_CAP = 200;
// threadGone rows last a day (pruneOld, which runs every 6 hours), so asking
// from further back than this could miss one: load the list again instead.
const SINCE_OLDEST_MS = 12 * 60 * 60_000;

// Rows written at or after `since`, in any view, and threads gone or out of
// the lists since then. A client merges them into what it has and asks again
// from the newest it heard (less CHANGES_MARGIN_MS in its own code), so each
// run reads only what changed. `more`: too many to send, load the list again.
export const threadsSince = query({
  args: { token: v.string(), since: v.number() },
  returns: v.object({ rows: v.array(v.object({ ...row.fields, updatedMs: v.number() })), gone: v.array(v.string()), more: v.optional(v.boolean()) }),
  handler: async (ctx, { token, since }) => {
    await checkPhoneToken(ctx, token);
    if (since < Date.now() - SINCE_OLDEST_MS) return { rows: [], gone: [], more: true };
    const docs = await ctx.db.query('threads').withIndex('by_updated', (x) => x.gte('updatedMs', since)).take(SINCE_CAP + 1);
    const goneRows = await ctx.db.query('threadGone').withIndex('by_at', (x) => x.gte('at', since)).take(SINCE_CAP + 1);
    if (docs.length > SINCE_CAP || goneRows.length > SINCE_CAP) return { rows: [], gone: [], more: true };
    const rows = [];
    // An id that's back since it went has a row, which is what's true now.
    const here = new Set(docs.map((d) => d.threadId));
    const gone = goneRows.filter((g) => !here.has(g.threadId)).map((g) => g.threadId);
    for (const d of docs) {
      // Out of its list for a runner key's cap: threads doesn't show it either.
      if (d.view === 'overflow') gone.push(d.threadId);
      else rows.push({ ...stripThread(d), updatedMs: d.updatedMs ?? since });
    }
    return { rows, gone };
  },
});

// Archived threads whose title or last reply has these words (API 16): the
// phone has only the newest DEN_LIMIT of the den, and searches those itself,
// so this finds the older ones. Convex's full-text search matches whole
// words, the last one as a prefix, so "sett" finds "settings". Titles first.
const SEARCH_LIMIT = 30;
export const search = query({
  args: { token: v.string(), text: v.string() },
  returns: v.array(row),
  handler: async (ctx, { token, text }) => {
    await checkPhoneToken(ctx, token);
    const words = text.trim();
    if (!words) return [];
    const byTitle = await ctx.db
      .query('threads')
      .withSearchIndex('search_title', (q) => q.search('title', words).eq('view', 'den'))
      .take(SEARCH_LIMIT);
    const byPreview = await ctx.db
      .query('threads')
      .withSearchIndex('search_preview', (q) => q.search('preview', words).eq('view', 'den'))
      .take(SEARCH_LIMIT);
    const seen = new Set<string>();
    const out = [];
    for (const t of [...byTitle, ...byPreview]) {
      if (seen.has(t.threadId) || out.length >= SEARCH_LIMIT) continue;
      seen.add(t.threadId);
      out.push(stripThread(t));
    }
    return out;
  },
});

// How many threads are hibernating and archived (API 16), for the phone's
// folded headings: it loads those lists only while their section is open,
// so a count here is all it needs the rest of the time. Not capped like
// the den list, so it says the same number as the Mac.
export const counts = query({
  args: { token: v.string() },
  returns: v.object({ hibernating: v.number(), den: v.number() }),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    // API 30: a row per runner, kept by the thread writes, rather than
    // reading every hibernating and den thread on every re-run. Counted the
    // old way only until a runner has one.
    const rows = await ctx.db.query('viewCounts').collect();
    if (rows.length) return rows.reduce((a, r) => ({ hibernating: a.hibernating + r.hibernating, den: a.den + r.den }), { hibernating: 0, den: 0 });
    const count = async (view: 'hibernating' | 'den') => {
      let n = 0;
      for await (const _ of ctx.db.query('threads').withIndex('by_view_activity', (x) => x.eq('view', view))) n++;
      return n;
    };
    return { hibernating: await count('hibernating'), den: await count('den') };
  },
});

// The thread's row and, as API 1 had it, its newest MESSAGES_SHOWN text
// messages plus any an old phone paged in. Tool rows are never in it: an app
// built before API 2 can't decode them. Newer clients use phone:messages.
export const thread = query({
  args: { token: v.string(), threadId: v.string() },
  returns: v.object({ thread: row, messages: v.array(message) }),
  handler: async (ctx, { token, threadId }) => {
    await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    const bySeq = new Map<number, { seq: number; role: 'user' | 'assistant'; text: string; origin?: string; at: string }>();
    const add = (m: Doc<'messages'>) => {
      if (m.role === 'tool') return;
      bySeq.set(m.seq, { seq: m.seq, role: m.role, text: m.text, ...(m.origin ? { origin: m.origin } : {}), at: m.at });
    };
    // Tool rows sit between the text ones, so this reads back far enough to
    // find the newest text messages without reading the whole thread.
    let text = 0;
    let read = 0;
    for await (const m of ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).order('desc')) {
      if (++read > THREAD_SCAN) break;
      if (m.role === 'tool') continue;
      add(m);
      if (++text >= MESSAGES_SHOWN) break;
    }
    for await (const m of ctx.db.query('messages').withIndex('by_thread_pagedAt', (q) => q.eq('threadId', threadId).gt('pagedAt', 0))) add(m);
    const messages = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    return { thread: stripThread(t), messages };
  },
});

// Just the thread's row (API 37), for a client that reads messages with
// phone:messages. phone:thread re-reads up to THREAD_SCAN messages each time
// one arrives (about 28 KB), which such a client throws away.
export const threadRow = query({
  args: { token: v.string(), threadId: v.string() },
  returns: row,
  handler: async (ctx, { token, threadId }) => {
    await checkPhoneToken(ctx, token);
    return stripThread(await findThread(ctx, threadId));
  },
});

// One tool's output, input and diffs, when someone opens it (API 52), from a runner
// with full sync on: never a live query, and never on a shared page. Null: it's kept
// on the runner. Old phones never ask.
export const eventBody = query({
  args: { token: v.string(), threadId: v.string(), seq: v.number() },
  returns: eventBodyAnswer,
  handler: async (ctx, { token, threadId, seq }) => {
    await checkPhoneToken(ctx, token);
    return readEventBody(ctx, threadId, seq);
  },
});

// Asks the thread's runner to upload one picture a tool handed back, for a day
// (API 52). It checks the picture is that tool's, in that thread's media folder.
export const requestPicture = mutation({
  args: { token: v.string(), threadId: v.string(), seq: v.number(), index: v.number() },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, seq, index }) => {
    await checkPhoneToken(ctx, token);
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index) || seq < 0 || index < 0 || index > 100) throw new ConvexError({ kind: 'invalid', message: 'no such picture' });
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!t) throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
    return queue(ctx, t.runnerId, 'picture', threadId, { seq, index });
  },
});

// That picture, once it's up.
export const heldPicture = query({
  args: { token: v.string(), threadId: v.string(), seq: v.number(), index: v.number() },
  returns: v.union(v.null(), v.object({ url: v.string(), mediaType: v.string(), width: v.optional(v.number()), height: v.optional(v.number()) })),
  handler: async (ctx, { token, threadId, seq, index }) => {
    await checkPhoneToken(ctx, token);
    const img = await ctx.db.query('heldPictures').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).eq('seq', seq).eq('index', index)).first();
    const url = img ? await ctx.storage.getUrl(img.storageId) : null;
    if (!img || !url) return null;
    return { url, mediaType: img.mediaType, ...(img.width ? { width: img.width } : {}), ...(img.height ? { height: img.height } : {}) };
  },
});

// A page of a thread's messages, newest first in the reading but returned
// oldest first: the newest `limit` with no beforeSeq (live, so new messages
// arrive by themselves), or the `limit` before beforeSeq. Tool rows (one line
// each) only with tools: true. hasMore says whether there are older ones.
// Since API 2; reads Convex alone, so it works while the Mac is asleep.
export const messages = query({
  // noImages (API 37): for a client watching phone:images instead, so a new
  // message doesn't read every picture row again.
  args: { token: v.string(), threadId: v.string(), beforeSeq: v.optional(v.number()), limit: v.optional(v.number()), tools: v.optional(v.boolean()), noImages: v.optional(v.boolean()) },
  // images: from the page's first row on (share.ts), a shared thread's
  // uploaded pictures (API 8), so Mike's page shows what the shared one
  // does, and any thread's reply and pinned pictures (API 24).
  returns: v.object({ messages: v.array(pageMessage), hasMore: v.boolean(), images: v.optional(v.array(phoneImage)) }),
  handler: async (ctx, { token, threadId, beforeSeq, limit, tools, noImages }) => {
    await checkPhoneToken(ctx, token);
    const want = pageLimit(limit, PAGE_DEFAULT, PAGE_MAX);
    const out: { seq: number; role: 'user' | 'assistant' | 'tool'; text: string; origin?: string; toolKind?: string; summary?: boolean; turn?: string; buttons?: Doc<'messages'>['buttons']; at: string }[] = [];
    const q = ctx.db
      .query('messages')
      .withIndex('by_thread_seq', (x) => (beforeSeq === undefined ? x.eq('threadId', threadId) : x.eq('threadId', threadId).lt('seq', beforeSeq)))
      .order('desc');
    // Read as far as the page needs and no further, and never more than one row
    // past the page and the tool rows it may look past, whatever was asked.
    const most = want + 1 + (tools ? 0 : TOOL_ROWS_SKIPPED);
    let read = 0;
    let bytes = 0;
    let hasMore = false;
    for await (const m of q) {
      // And bytes: a page of big rows stops short, saying there's more, rather than going past what a query may read.
      if (++read > most || (bytes += docBytes(m)) > PAGE_BYTES) {
        hasMore = true;
        break;
      }
      if (m.role === 'tool' && !tools) continue;
      if (out.length >= want) {
        hasMore = true;
        break;
      }
      out.push({ seq: m.seq, role: m.role, text: m.text, ...(m.origin ? { origin: m.origin } : {}), ...(m.toolKind ? { toolKind: m.toolKind } : {}), ...(m.summary ? { summary: true } : {}), ...(m.turn ? { turn: m.turn } : {}), ...(m.wokeBy ? { wokeBy: m.wokeBy } : {}), ...(m.buttons?.length ? { buttons: m.buttons } : {}), at: m.at });
    }
    out.reverse();
    const from = hasMore || beforeSeq !== undefined ? out[0]?.seq ?? 0 : 0;
    // The page's pictures only: an older page's stop where the next page starts.
    const images = tools && !noImages && out.length ? [...(await imagesFrom(ctx, threadId, from, beforeSeq)), ...(await replyImagesFrom(ctx, threadId, from, beforeSeq))] : [];
    return { messages: out, hasMore, ...(images.length ? { images } : {}) };
  },
});

// A thread's pictures from a seq on (API 37), live, on their own: a picture can
// finish uploading after the row it belongs to has left a client's live tail,
// and this re-runs only when a picture row changes.
export const images = query({
  args: { token: v.string(), threadId: v.string(), from: v.number() },
  returns: v.array(phoneImage),
  handler: async (ctx, { token, threadId, from }) => {
    await checkPhoneToken(ctx, token);
    if (!Number.isFinite(from)) throw new ConvexError({ kind: 'invalid', message: 'from must be a number' });
    return [...(await imagesFrom(ctx, threadId, from)), ...(await replyImagesFrom(ctx, threadId, from))];
  },
});

export const command = query({
  args: { token: v.string(), commandId: v.id('commands') },
  returns: v.object({ state: v.union(v.literal('pending'), v.literal('taken'), v.literal('done'), v.literal('failed')), note: v.optional(v.string()), threadId: v.optional(v.string()) }),
  handler: async (ctx, { token, commandId }) => {
    await checkPhoneToken(ctx, token);
    const c = await ctx.db.get(commandId);
    if (!c) throw new ConvexError({ kind: 'notFound', message: 'no such command' });
    return { state: c.state, ...(c.note ? { note: c.note } : {}), ...(c.resultThreadId ? { threadId: c.resultThreadId } : {}) };
  },
});

// A project as the phone shows it. `icon` (API 5) is the Mac's ProjectIcon
// with the picture as a URL into file storage (sync.ts, project icons)
// instead of a path on the Mac; absent from a runner before API 5.
const projectRow = v.object({
  runnerId: v.string(),
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
  icon: v.optional(v.object({ symbol: v.optional(v.string()), url: v.optional(v.string()), by: v.string() })),
});

// A project's picture as a URL, in place of the name the runner gave it.
async function iconOf(ctx: QueryCtx, p: { runnerId: string; id: string; icon?: { symbol?: string; picture?: string; by: string } }) {
  if (!p.icon) return {};
  let url: string | undefined;
  if (p.icon.picture) {
    const stored = await ctx.db
      .query('projectIcons')
      .withIndex('by_runner_project', (q) => q.eq('runnerId', p.runnerId).eq('projectId', p.id))
      .unique();
    url = (stored && (await ctx.storage.getUrl(stored.storageId))) ?? undefined;
  }
  return { icon: { ...(p.icon.symbol ? { symbol: p.icon.symbol } : {}), ...(url ? { url } : {}), by: p.icon.by } };
}

// The list, from projectHeads (API 48): goals, state, notes and folders come
// back empty, and phone:project has them. The iPhone follows this all the time
// and has only ever read the id, title, archived and icon, so apps already out
// there get the saving too; reading `projects` cost about 200 KB a run for
// Mike's 79, nearly all of it notes.
export const projects = query({
  args: { token: v.string(), archived: v.optional(v.boolean()) },
  returns: v.array(projectRow),
  handler: async (ctx, { token, archived }) => {
    await checkPhoneToken(ctx, token);
    const out = [];
    // `projects` only until the first heartbeat on this backend has copied them.
    const ready = await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', HEADS_MARK)).first();
    for await (const p of ready ? ctx.db.query('projectHeads') : ctx.db.query('projects')) {
      if (p.archived && !archived) continue;
      const { runnerId, id, title, createdBy, createdAt, updatedAt, threadCount, lastActivityAt } = p;
      out.push({ runnerId, id, title, createdBy, archived: p.archived, createdAt, updatedAt, threadCount, ...(lastActivityAt !== undefined ? { lastActivityAt } : {}), folders: [], goals: '', state: '', notes: '', ...(await iconOf(ctx, p)) });
    }
    return out.sort((a, b) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt));
  },
});

// Which projects' goals or state have these words, for the website's search box
// (API 48). The list doesn't carry those, so this reads the big rows, and only
// while someone has typed something. Ids only: the list has the rest.
export const projectSearch = query({
  args: { token: v.string(), text: v.string() },
  returns: v.array(v.object({ runnerId: v.string(), id: v.string() })),
  handler: async (ctx, { token, text }) => {
    await checkPhoneToken(ctx, token);
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for await (const p of ctx.db.query('projects')) {
      if ([p.goals, p.state].some((x) => x.toLowerCase().includes(q))) out.push({ runnerId: p.runnerId, id: p.id });
    }
    return out;
  },
});

// One project whole, for its page (API 48). Reads only that project's row, so
// it re-runs only when that project changes.
export const project = query({
  args: { token: v.string(), runnerId: v.string(), id: v.string() },
  returns: v.union(projectRow, v.null()),
  handler: async (ctx, { token, runnerId, id }) => {
    await checkPhoneToken(ctx, token);
    const p = await ctx.db.query('projects').withIndex('by_runner_id', (q) => q.eq('runnerId', runnerId).eq('id', id)).unique();
    if (!p) return null;
    const { icon: _icon, ...rest } = strip(p);
    return { ...rest, notes: await notesOf(ctx, p), ...(await iconOf(ctx, p)) };
  },
});

// A project's threads, archived ones too (API 40), through projectThreads,
// so it reads only this project's rows rather than every thread. It takes
// the ones that joined the project last, then puts those in order of
// activity (links don't carry it; schema.ts). The website asks for more by
// raising limit, as phone:messages.
const PROJECT_THREADS_MAX = 1000;
export const projectThreads = query({
  args: { token: v.string(), projectId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(row),
  handler: async (ctx, { token, projectId, limit }) => {
    await checkPhoneToken(ctx, token);
    const n = pageLimit(limit, PAGE_DEFAULT, PROJECT_THREADS_MAX);
    const links = await ctx.db
      .query('projectThreads')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .order('desc')
      .take(n);
    const out = [];
    for (const l of links) {
      const t = await ctx.db
        .query('threads')
        .withIndex('by_threadId', (q) => q.eq('threadId', l.threadId))
        .unique();
      if (t) out.push(stripThread(t));
    }
    return out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  },
});

// The Pocket (API 19; schema.ts, pocketCards). A card's id is its key.
export const pocket = query({
  args: { token: v.string() },
  returns: v.array(v.object({ id: v.string(), title: v.string(), text: v.string(), place: v.optional(v.string()), icon: v.optional(v.string()), threadId: v.optional(v.string()), source: v.optional(v.string()), updatedAt: v.string() })),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    const rows = await ctx.db.query('pocketCards').collect();
    // A card a runner key filed says which Mac it's from, ahead of its
    // source, so a card from Bruce can't pass for one from the main Mac.
    const out = [];
    for (const { _id, _creationTime, key, runnerId, ...card } of rows) {
      const from = runnerId ? `From ${await runnerName(ctx, runnerId)}` : undefined;
      out.push({ id: key, ...card, ...(from ? { source: card.source ? `${from} · ${card.source}` : from } : {}) });
    }
    return out;
  },
});

// Straight to the table, not a command for a runner: the card's on the phone
// because Mike's out, and his Mac may well be asleep.
export const removePocketCard = mutation({
  args: { token: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, { token, id }) => {
    await checkPhoneToken(ctx, token);
    const had = await ctx.db.query('pocketCards').withIndex('by_key', (q) => q.eq('key', id)).first();
    if (had) await ctx.db.delete(had._id);
    return null;
  },
});

export const schedules = query({
  args: { token: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    const out = [];
    // `owned` and `claim` are the backend's own (API 9), not the phone's.
    for await (const s of ctx.db.query('schedules')) {
      const { owned, claim, updatedMs: _u, ...rest } = strip(s);
      out.push(rest);
    }
    return out;
  },
});

// What a sidebar needs of the schedules, all the time (API 45; schema.ts,
// scheduleWakes): a row per active one, without the claims and runs that make
// phone:schedules re-run.
export const wakes = query({
  args: { token: v.string() },
  returns: v.array(v.object({ scheduleId: v.string(), threadId: v.optional(v.string()), nextRunAt: v.optional(v.string()) })),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    const out = [];
    for await (const w of ctx.db.query('scheduleWakes')) out.push({ scheduleId: w.scheduleId, ...(w.threadId ? { threadId: w.threadId } : {}), ...(w.nextRunAt ? { nextRunAt: w.nextRunAt } : {}) });
    return out;
  },
});

// Each runner's machine figures (API 45), last reported while someone was
// watching: see watchRunners.
export const runnerStats = query({
  args: { token: v.string() },
  returns: v.array(v.object({ runnerId: v.string(), at: v.string(), cpuPercent: v.number(), cores: v.number(), memUsed: v.number(), memTotal: v.number(), diskFree: v.number(), diskTotal: v.number(), load1: v.optional(v.number()), uptimeSec: v.number(), machine: v.optional(v.string()), os: v.optional(v.string()) })),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    return runnerStatsRows(ctx);
  },
});

export const accounts = query({
  args: { token: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    const out = [];
    for await (const a of ctx.db.query('accounts')) out.push(strip(a));
    return out;
  },
});

// ------------------------------------------------------------ mutations

// The Runners view is open (API 45): runners report their figures until this
// lapses. The website calls it every 30 seconds while it's showing, so a closed
// tab stops them within RUNNER_WATCH_MS (lib.ts).
export const watchRunners = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    await watchRunnersFor(ctx);
    return null;
  },
});

// Pause, resume or run a schedule (API 45), on the runner it belongs to.
export const schedule = mutation({
  args: { token: v.string(), scheduleId: v.string(), action: v.union(v.literal('pause'), v.literal('resume'), v.literal('run')) },
  returns: v.id('commands'),
  handler: async (ctx, { token, scheduleId, action }) => {
    await checkPhoneToken(ctx, token);
    const s = await ctx.db.query('schedules').withIndex('by_scheduleId', (q) => q.eq('id', scheduleId)).unique();
    if (!s) throw new ConvexError({ kind: 'notFound', message: 'no such schedule' });
    return queue(ctx, s.runnerId, 'schedule', undefined, { scheduleId, action });
  },
});

// answers (API 14): the open card's asks the message answers, as the Mac
// app passes them to threads.send, so the transcript shows them as answers.
// images (API 18): photos put in file storage with imageUploadUrl.
export const send = mutation({
  args: { token: v.string(), threadId: v.string(), text: v.string(), answers: v.optional(v.array(v.object({ action: v.string(), answer: v.string() }))), images: v.optional(v.array(v.id('_storage'))) },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, text, answers, images }) => {
    const me = await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'send', threadId, { text, ...(answers?.length ? { answers } : {}), ...(await commandImages(ctx, me.id, images)) });
  },
});

// A thread's messages from the phone that its runner hasn't applied yet
// (API 57), oldest first: pending ones can still be cancelled, taken ones
// are on their way. The phone shows each as a dimmed message with its own
// Cancel, so several sent while the Mac is asleep don't look lost.
export const waiting = query({
  args: { token: v.string(), threadId: v.string() },
  returns: v.array(v.object({ commandId: v.id('commands'), state: v.union(v.literal('pending'), v.literal('taken')), text: v.string(), photos: v.number(), createdAt: v.number() })),
  handler: async (ctx, { token, threadId }) => {
    await checkPhoneToken(ctx, token);
    const out = [];
    for (const state of ['pending', 'taken'] as const) {
      // Bounded: a phone can't usefully show more, and each row can carry a long message.
      for (const c of await ctx.db.query('commands').withIndex('by_thread_state', (q) => q.eq('threadId', threadId).eq('state', state)).take(WAITING_LIMIT)) {
        // The main Mac's own sends to another runner's thread (relay.ts) aren't the phone's to list or take back.
        if (c.kind !== 'send' || c.args?.from === 'mac') continue;
        out.push({ commandId: c._id, state, text: typeof c.args?.text === 'string' ? c.args.text : '', photos: Array.isArray(c.args?.images) ? c.args.images.length : 0, createdAt: c.createdAt });
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  },
});

// Takes back a message the runner hasn't taken yet (API 57). false once it
// has: sync:takeCommand and this both check `pending` in one transaction, so
// only one of them wins. The photos go too, as nothing will fetch them now.
export const cancel = mutation({
  args: { token: v.string(), commandId: v.id('commands') },
  returns: v.boolean(),
  handler: async (ctx, { token, commandId }) => {
    await checkPhoneToken(ctx, token);
    const c = await ctx.db.get(commandId);
    if (!c || c.kind !== 'send' || c.args?.from === 'mac' || c.state !== 'pending') return false;
    await ctx.db.patch(commandId, { state: 'failed', note: 'Cancelled', doneAt: Date.now(), args: finishedArgs(c.args) });
    await endCommandFiles(ctx, commandId);
    for (const image of Array.isArray(c.args?.images) ? c.args.images : []) await deleteIfUnused(ctx, image.storageId);
    return true;
  },
});

// A reply button's press (API 59, docs/protocol.md "Reply buttons"): queued
// for the thread's runner, which calls buttons.press. A button already
// pressed comes back as it is there, so a second tap starts nothing.
export const press = mutation({
  args: { token: v.string(), threadId: v.string(), buttonId: v.string() },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, buttonId }) => {
    await checkPhoneToken(ctx, token);
    if (!/^[a-z0-9]{8}$/.test(buttonId)) throw new ConvexError({ kind: 'invalid', message: 'no such button' });
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'press', threadId, { buttonId });
  },
});

export const respond = mutation({
  args: { token: v.string(), threadId: v.string(), approvalId: v.string(), decision: v.union(v.literal('allow'), v.literal('allowAlways'), v.literal('deny')), message: v.optional(v.string()) },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, approvalId, decision, message }) => {
    await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'respond', threadId, { approvalId, decision, ...(message ? { message } : {}) });
  },
});

// A question's answers, one per question keyed by its text (what the
// runner's approvals.respond takes with decision "answered"); `message` is
// the chosen answers in one line for the transcript.
export const answer = mutation({
  args: { token: v.string(), threadId: v.string(), approvalId: v.string(), answers: v.record(v.string(), v.string()), message: v.optional(v.string()) },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, approvalId, answers, message }) => {
    await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'respond', threadId, { approvalId, decision: 'answered', answers, message: message ?? Object.values(answers).join('; ') });
  },
});

// An answer to a secret card (API 35, docs/protocol.md "Secrets"): sealed
// on the phone to the runner's key, so only that runner can open it.
// finishCommand drops `sealed` once the runner has taken it.
export const secret = mutation({
  args: {
    token: v.string(),
    threadId: v.string(),
    approvalId: v.string(),
    sealed: v.optional(v.object({ epk: v.string(), nonce: v.string(), box: v.string() })),
    decline: v.optional(v.boolean()),
  },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, approvalId, sealed, decline }) => {
    await checkPhoneToken(ctx, token);
    if (!decline && !sealed) throw new Error('sealed or decline is required');
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'respond', threadId, decline ? { approvalId, decision: 'deny', secret: true } : { approvalId, decision: 'answered', secret: true, sealed });
  },
});

export const update = mutation({
  args: {
    token: v.string(),
    threadId: v.string(),
    change: v.union(
      v.object({ snooze: v.object({ until: v.optional(v.string()), untilRestart: v.optional(v.boolean()) }) }),
      v.object({ wake: v.literal(true) }),
      // verdict (API 43): how it went, from the done card's Archive menu.
      v.object({ archive: v.literal(true), verdict: v.optional(v.union(v.literal('worked'), v.literal('didntWork'), v.literal('notNeeded'))) }),
      v.object({ unarchive: v.literal(true) }),
      v.object({ markSeen: v.literal(true) }),
      v.object({ title: v.string() }),
      v.object({ star: v.boolean() }),
    ),
  },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, change }) => {
    await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'update', threadId, change);
  },
});

// Shares the thread by link, stops sharing it, or gives it a new link
// (API 8; docs/website.md, "Sharing"), from the website. The runner
// applies it as the Mac app's share button does.
export const share = mutation({
  args: { token: v.string(), threadId: v.string(), access: v.union(v.literal('off'), v.literal('link')), newLink: v.optional(v.boolean()) },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, access, newLink }) => {
    await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'share', threadId, { access, ...(newLink ? { newLink: true } : {}) });
  },
});

// A new thread. With no runnerId, the first runner online in Mike's order
// takes it, else the main runner still online (or the first one back, as
// "any"): mainRunner.
export const create = mutation({
  args: { token: v.string(), text: v.string(), runnerId: v.optional(v.string()), cwd: v.optional(v.string()), accountId: v.optional(v.string()), model: v.optional(v.string()), effort: v.optional(v.string()), images: v.optional(v.array(v.id('_storage'))) },
  returns: v.id('commands'),
  handler: async (ctx, { token, text, runnerId, cwd, accountId, model, effort, images }) => {
    const me = await checkPhoneToken(ctx, token);
    const target = runnerId ? await knownRunner(ctx, runnerId) : await mainRunner(ctx);
    return queue(ctx, target, 'create', undefined, { text, ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(await commandImages(ctx, me.id, images)) });
  },
});

// Where the phone POSTs a photo before sending it (API 18). It's only in
// Convex on its way to the runner: sync:finishCommand deletes it. Since 7 Nov
// 2026 that's this deployment's own /phone/upload (convex/http.ts) with a
// one-use ticket, not Convex's upload URL, so each photo is recorded as this
// token's (phoneUploads) and counted against its allowances, and one never
// sent goes after a day (sync:pruneFiles). The phone POSTs to whatever URL
// it's given and reads { storageId } back, as before.
export const PHONE_UPLOADS = {
  perHour: 60,
  perDay: 300,
  bytesPerDay: 300 * 1024 * 1024,
  maxBytes: 10 * 1024 * 1024,
  ticketMs: 60 * 60_000,
} as const;
const DAY_MS = 24 * 60 * 60_000;

// This token's uploads in the last day: how many, how many in the last hour,
// and their bytes. At most perDay + 1 rows read, each a few hundred bytes.
async function uploadsOf(ctx: QueryCtx, tokenId: Id<'tokens'>, now: number, except?: Id<'phoneUploads'>) {
  const rows = await ctx.db.query('phoneUploads').withIndex('by_token_issued', (q) => q.eq('tokenId', tokenId).gt('issuedAt', now - DAY_MS)).take(PHONE_UPLOADS.perDay + 1);
  let day = 0;
  let hour = 0;
  let bytes = 0;
  for (const r of rows) {
    if (r._id === except) continue;
    day++;
    if (r.issuedAt > now - PHONE_UPLOADS.ticketMs) hour++;
    bytes += r.bytes ?? 0;
  }
  return { day, hour, bytes };
}

export const imageUploadUrl = mutation({
  args: { token: v.string() },
  returns: v.string(),
  handler: async (ctx, { token }) => {
    const me = await checkPhoneToken(ctx, token);
    const now = Date.now();
    const used = await uploadsOf(ctx, me.id, now);
    if (used.hour >= PHONE_UPLOADS.perHour || used.day >= PHONE_UPLOADS.perDay || used.bytes >= PHONE_UPLOADS.bytesPerDay) {
      throw new ConvexError({ kind: 'rateLimited', message: 'Too many photos for now: try again later.' });
    }
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new ConvexError({ kind: 'config', message: 'CONVEX_SITE_URL is not set' });
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await ctx.db.insert('phoneUploads', { ticketHash: await sha256(ticket), tokenId: me.id, issuedAt: now });
    return `${site.replace(/\/+$/, '')}/phone/upload?ticket=${ticket}`;
  },
});

// Unused, under an hour old, and its token still good: revoking a phone ends
// the uploads it had started.
async function livePhoneTicket(ctx: QueryCtx, ticket: string) {
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  const hash = await sha256(ticket);
  const row = await ctx.db.query('phoneUploads').withIndex('by_hash', (q) => q.eq('ticketHash', hash)).first();
  if (!row || row.usedAt || row.issuedAt <= Date.now() - PHONE_UPLOADS.ticketMs) return null;
  const t = await ctx.db.get(row.tokenId);
  return t && !t.revokedAt && t.expiresAt >= Date.now() ? row : null;
}

// For /phone/upload, before it stores anything.
export const phoneTicketOk = internalQuery({
  args: { ticket: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { ticket }) => (await livePhoneTicket(ctx, ticket)) !== null,
});

// The stored file is the ticket's token's. False (the route then deletes the
// file): a dead or used ticket, or a file over the size cap. "later": over
// the day's bytes, which time fixes (429).
export const redeemPhoneUpload = internalMutation({
  args: { ticket: v.string(), storageId: v.id('_storage'), bytes: v.number() },
  returns: v.union(v.boolean(), v.literal('later')),
  handler: async (ctx, { ticket, storageId, bytes }) => {
    const row = await livePhoneTicket(ctx, ticket);
    if (!row) return false;
    const now = Date.now();
    // Spent whatever happens: a refused ticket can't be tried again.
    await ctx.db.patch(row._id, { usedAt: now, bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0 });
    if (!(bytes >= 0) || bytes > PHONE_UPLOADS.maxBytes) return false;
    if ((await uploadsOf(ctx, row.tokenId, now, row._id)).bytes + bytes > PHONE_UPLOADS.bytesPerDay) return 'later';
    await ctx.db.patch(row._id, { storageId });
    return true;
  },
});

// A photo this phone uploaded and then never sent (API 25): it uploads as
// soon as one's picked, so taking one back out, or giving up on the message,
// has to take its copy back too. Only its own (phoneUploads), and only once
// nothing else names it (deleteIfUnused): any other file, or one already in a
// waiting message, is left alone, quietly, as the phone has nothing to do
// about it. Its unsent ones go after a day anyway (sync:pruneFiles).
export const discardImage = mutation({
  args: { token: v.string(), storageId: v.id('_storage') },
  returns: v.null(),
  handler: async (ctx, { token, storageId }) => {
    const me = await checkPhoneToken(ctx, token);
    const upload = await ctx.db.query('phoneUploads').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first();
    if (upload?.tokenId === me.id) await deleteIfUnused(ctx, storageId);
    return null;
  },
});

// A quick ask the phone has already answered out loud (API 10), kept as a
// thread so Mike can carry on in it. The runner writes the exchange with
// no turn run (docs/protocol.md, Sync, "quickAsk"); phone:command gives the
// new thread's id once it's done. Targets a runner as create does.
export const quickAsk = mutation({
  args: {
    token: v.string(),
    question: v.string(),
    answer: v.string(),
    sources: v.optional(v.array(v.object({ title: v.string(), url: v.string() }))),
    askedAt: v.number(),
    runnerId: v.optional(v.string()),
  },
  returns: v.id('commands'),
  handler: async (ctx, { token, question, answer, sources, askedAt, runnerId }) => {
    await checkPhoneToken(ctx, token);
    const q = question.trim();
    const a = answer.trim();
    if (!q || q.length > 2000) throw new ConvexError({ kind: 'invalid', message: 'question must be 1 to 2000 characters' });
    if (!a || a.length > 20000) throw new ConvexError({ kind: 'invalid', message: 'answer must be 1 to 20000 characters' });
    if ((sources?.length ?? 0) > 10) throw new ConvexError({ kind: 'invalid', message: 'at most 10 sources' });
    if (!Number.isFinite(askedAt)) throw new ConvexError({ kind: 'invalid', message: 'askedAt must be a time' });
    const target = runnerId ? await knownRunner(ctx, runnerId) : await mainRunner(ctx);
    return queue(ctx, target, 'quickAsk', undefined, { question: q, answer: a, sources: sources ?? [], askedAt });
  },
});

// Where a phone's new thread goes when the phone doesn't say: the first
// runner online in the order Mike set on the phone (API 56; a phone from
// before it never says). With no order, or none of its runners online, the
// online runner heartbeating with the owner key (byOwner, docs/protocol.md
// "Runner keys") with the most threads, which is the Mac Mike really works
// on, with his repos and printer. With none online it's "any", which only
// the owner key takes, so it waits for that Mac rather than going to one
// with a runner key: Mike's text is for his main Mac unless he picks
// another, by name or by putting it in his order.
// (Going by the latest heartbeat once sent half of them to Bruce; going by
// most threads alone let a runner key claim a million threads to get them.)
async function mainRunner(ctx: QueryCtx): Promise<string> {
  const all: Doc<'runners'>[] = [];
  for await (const r of ctx.db.query('runners')) all.push(r);
  const online = (r: Doc<'runners'>) => !r.draining && Date.now() - r.lastSeenAt <= ONLINE_MS;
  for (const id of await readRunnerOrder(ctx)) {
    const r = all.find((x) => x.runnerId === id);
    if (r && online(r)) return r.runnerId;
  }
  return (await mainOwnerRunner(ctx, all, true)) ?? 'any';
}

// The main Mac among these runners: heartbeating with the owner key, with
// no live key of its own (lib.ts hasLiveKey: whatever its last heartbeat
// said, a runner with a key isn't the main Mac), the most threads first.
// Only online ones when `onlineOnly`, as a new thread needs; the phone's
// list (orderedRunners) puts it first asleep too.
async function mainOwnerRunner(ctx: QueryCtx, runners: Doc<'runners'>[], onlineOnly: boolean): Promise<string | undefined> {
  let best: Doc<'runners'> | undefined;
  for (const r of runners) {
    if (!r.byOwner || (onlineOnly && (r.draining || Date.now() - r.lastSeenAt > ONLINE_MS)) || (await hasLiveKey(ctx, r.runnerId))) continue;
    if (!best || r.threadCount > best.threadCount || (r.threadCount === best.threadCount && r.lastSeenAt > best.lastSeenAt)) best = r;
  }
  return best?.runnerId;
}

// Older messages: the owning runner writes up to 50 text messages before
// `beforeSeq` as paged rows (phone:thread then returns them too; they go
// after a day). The row's `earliestSeq` says whether there are any.
export const loadEarlier = mutation({
  args: { token: v.string(), threadId: v.string(), beforeSeq: v.number() },
  returns: v.id('commands'),
  handler: async (ctx, { token, threadId, beforeSeq }) => {
    await checkPhoneToken(ctx, token);
    const t = await findThread(ctx, threadId);
    return queue(ctx, t.runnerId, 'page', threadId, { beforeSeq });
  },
});

// An APNs device token as the phone sends it: hex (32 bytes today; Apple
// says it can grow, so up to 100).
const APNS_TOKEN = /^[0-9a-fA-F]{16,200}$/;
export const MAX_DEVICES_PER_TOKEN = 5;

export const registerDevice = mutation({
  // pushKey (API 4): the phone's own key for what goes through the push
  // relay, base64 of 32 bytes. Kept from an earlier registration if left out.
  args: { token: v.string(), apnsToken: v.string(), environment: v.union(v.literal('sandbox'), v.literal('production')), pushKey: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { token, apnsToken, environment, pushKey }) => {
    if (pushKey !== undefined && !/^[A-Za-z0-9+/]{43}=$/.test(pushKey)) throw new ConvexError({ kind: 'invalid', message: 'pushKey must be base64 of 32 bytes' });
    if (!APNS_TOKEN.test(apnsToken)) throw new ConvexError({ kind: 'invalid', message: 'apnsToken must be the device token in hex' });
    const t = await checkPhoneToken(ctx, token);
    const existing = await ctx.db
      .query('devices')
      .withIndex('by_apnsToken', (q) => q.eq('apnsToken', apnsToken))
      .unique();
    const key = pushKey ?? existing?.pushKey;
    const row = { apnsToken, environment, tokenName: t.name, tokenId: t.id, updatedAt: Date.now(), ...(existing?.notify ? { notify: existing.notify } : {}), ...(key ? { pushKey: key } : {}) };
    // A phone token's oldest registrations give way to a new one (or one it
    // takes over from another token), so a token holds at most
    // MAX_DEVICES_PER_TOKEN rows: a phone reinstalled gets a new APNs token,
    // and its old row stops mattering. Without a cap one token could fill
    // the table that pushes and revoking read.
    if (existing?.tokenId !== t.id) {
      const mine = await ctx.db.query('devices').withIndex('by_tokenId', (q) => q.eq('tokenId', t.id)).take(MAX_DEVICES_PER_TOKEN + 20);
      const over = mine.length - MAX_DEVICES_PER_TOKEN + 1;
      if (over > 0) for (const old of mine.slice(0, over)) await ctx.db.delete(old._id);
    }
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert('devices', row);
    return null;
  },
});

// When this phone wants a push (API 3): "away" (the default) only while
// Mike isn't at the Mac, "always", or "off".
export const setNotifications = mutation({
  args: { token: v.string(), apnsToken: v.string(), notify: v.union(v.literal('away'), v.literal('always'), v.literal('off')) },
  returns: v.null(),
  handler: async (ctx, { token, apnsToken, notify }) => {
    await checkPhoneToken(ctx, token);
    const row = await ctx.db
      .query('devices')
      .withIndex('by_apnsToken', (q) => q.eq('apnsToken', apnsToken))
      .unique();
    if (!row) throw new ConvexError({ kind: 'notFound', message: 'this phone has not registered for notifications' });
    await ctx.db.patch(row._id, { notify });
    return null;
  },
});

async function findThread(ctx: QueryCtx, threadId: string) {
  const t = await ctx.db
    .query('threads')
    .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
    .unique();
  if (!t) throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
  return t;
}

// A command's photos as the runner fetches them. The URL is worked out here
// rather than taken from the phone, so a command can't send a runner off to
// fetch an address of the phone's choosing. Each must be a photo this token
// uploaded (phoneUploads), so a command can't name a runner's picture or
// project icon, which finishing it would then try to delete.
async function commandImages(ctx: QueryCtx, tokenId: Id<'tokens'>, images: Id<'_storage'>[] | undefined) {
  if (!images?.length) return {};
  if (images.length > MAX_COMMAND_IMAGES) throw new ConvexError({ kind: 'invalid', message: `at most ${MAX_COMMAND_IMAGES} photos` });
  const out = [];
  // Each in its place, repeats too: the text's [Picture N] markers count them in order.
  for (const storageId of images) {
    const upload = await ctx.db.query('phoneUploads').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first();
    const url = upload?.tokenId === tokenId ? await ctx.storage.getUrl(storageId) : null;
    if (!url) throw new ConvexError({ kind: 'notFound', message: 'that photo has gone' });
    out.push({ storageId, url });
  }
  return { images: out };
}

// A runner the phone named for a new thread: one that has heartbeated here
// (runners), or "any". Anything else would wait for ever, as nothing takes it.
async function knownRunner(ctx: QueryCtx, runnerId: string): Promise<string> {
  if (runnerId === 'any') return runnerId;
  if (runnerId.length > 100 || !(await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).first())) throw new ConvexError({ kind: 'notFound', message: 'no such runner' });
  return runnerId;
}

// Refused once WAITING_PER_RUNNER commands, or WAITING_BYTES_PER_RUNNER of
// them, wait for the runner: reads stop there, so this costs no more than
// what the runner's own pendingCommands reads. One that waits too long goes
// (sync:pruneFiles, COMMAND_KEEP_MS). Its photos are recorded in commandFiles
// so a delete elsewhere sees they're still on their way (sync.ts storageInUse).
async function queue(ctx: MutationCtx, runnerId: string, kind: 'send' | 'respond' | 'update' | 'create' | 'page' | 'share' | 'quickAsk' | 'schedule' | 'picture' | 'press', threadId: string | undefined, args: Record<string, unknown>) {
  let n = 0;
  let bytes = docBytes(args);
  for await (const c of ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', runnerId).eq('state', 'pending'))) {
    bytes += docBytes(c);
    if (++n >= WAITING_PER_RUNNER || bytes > WAITING_BYTES_PER_RUNNER) throw new ConvexError({ kind: 'tooMany', message: 'Too much is waiting for that runner: it takes it when it next comes online.' });
  }
  const commandId = await ctx.db.insert('commands', { runnerId, ...(threadId ? { threadId } : {}), kind, args, state: 'pending', createdAt: Date.now() });
  for (const image of Array.isArray(args.images) ? (args.images as { storageId: Id<'_storage'> }[]) : []) await ctx.db.insert('commandFiles', { storageId: image.storageId, commandId });
  return commandId;
}
