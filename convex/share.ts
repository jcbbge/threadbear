// A shared thread on the website (docs/website.md, "Sharing"): /s/<slug>,
// read-only and live. share:view is the only function that takes no phone
// token. Anyone may ask; it answers only while the thread's `share` (as
// the runner mirrored it) is "link".
//
// Readers get the thread's title, when it started, which model ran it, its
// messages (with what the page needs to fold each turn's work the way the
// apps do: origin, summary, turn), one line per tool call and the pictures
// the runner uploaded for it (sync:addShareImage), and nothing else: no
// folder, account, cost, approvals or composer.
//
// Mike's own phone or browser token also reads it while it isn't shared,
// and gets `manage` so the page can offer Stop sharing and Share again
// (phone:share, a command the runner applies).
import { v, type Infer } from 'convex/values';
import { internalQuery, query, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { checkPhoneToken, pageLimit } from './lib';
import { docBytes } from './runnerAccess';

const PAGE_DEFAULT = 80;
const PAGE_MAX = 2000;
const PAGE_BYTES = 8 * 1024 * 1024;

const message = v.object({
  seq: v.number(),
  role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool')),
  text: v.string(),
  origin: v.optional(v.string()),
  toolKind: v.optional(v.string()),
  summary: v.optional(v.boolean()),
  turn: v.optional(v.string()),
  at: v.string(),
});

// A picture in a shared thread. `src` is set for one the agent put in its
// text as Markdown, which the page swaps for `url`; without it the picture
// goes after the row with the greatest seq at or before its own (an
// attachment on Mike's message, or what a tool handed back).
export const shareImage = v.object({
  seq: v.number(),
  src: v.optional(v.string()),
  url: v.string(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});

// A link is one thread's (sync.ts slugFree). Two rows with one slug, from
// before that was checked, show neither rather than guess which is meant.
async function threadBySlug(ctx: QueryCtx, slug: string): Promise<Doc<'threads'> | null> {
  if (!slug || slug.length > 100) return null;
  const rows = await ctx.db
    .query('threads')
    .withIndex('by_share_slug', (q) => q.eq('share.slug', slug))
    .take(2);
  return rows.length === 1 ? rows[0]! : null;
}

async function isMike(ctx: QueryCtx, token?: string): Promise<boolean> {
  if (!token) return false;
  try {
    await checkPhoneToken(ctx, token);
    return true;
  } catch {
    return false;
  }
}

// At most this many pictures in one answer, whatever a page asks: each row is
// a few KB (sync.ts checkPicture), so this keeps a page's pictures to about a
// MB. The newest, as that's what's on screen; a thread with more than this
// many from its oldest shown row shows the newest of them.
export const IMAGES_MAX = 300;

// A thread's uploaded pictures from seq `from` on (before `before`, when it's a
// page with newer ones after it), with their URLs.
export async function imagesFrom(ctx: QueryCtx, threadId: string, from: number, before?: number) {
  const out: { seq: number; src?: string; url: string; width?: number; height?: number }[] = [];
  const rows = await ctx.db.query('shareImages').withIndex('by_thread_seq', (q) => (before === undefined ? q.eq('threadId', threadId).gte('seq', from) : q.eq('threadId', threadId).gte('seq', from).lt('seq', before))).order('desc').take(IMAGES_MAX);
  rows.reverse();
  for (const img of rows) {
    const url = await ctx.storage.getUrl(img.storageId);
    if (!url) continue;
    out.push({ seq: img.seq, ...(img.src ? { src: img.src } : {}), url, ...(img.width ? { width: img.width } : {}), ...(img.height ? { height: img.height } : {}) });
  }
  return out;
}

// A thread's pictures for Mike's own phone (replyImages, API 24), never for
// share:view: a shared page gets only what was uploaded for it. A file both
// pinned and shown in a reply goes once, in the reply, and one pinned twice
// goes at the first pin.
export const phoneImage = v.object({
  seq: v.number(),
  src: v.optional(v.string()),
  pinned: v.optional(v.boolean()),
  url: v.string(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});

export async function replyImagesFrom(ctx: QueryCtx, threadId: string, from: number, before?: number) {
  const rows = await ctx.db.query('replyImages').withIndex('by_thread_seq', (q) => (before === undefined ? q.eq('threadId', threadId).gte('seq', from) : q.eq('threadId', threadId).gte('seq', from).lt('seq', before))).order('desc').take(IMAGES_MAX);
  rows.reverse();
  const inReplies = new Set(rows.filter((r) => r.src).map((r) => r.path));
  const out: { seq: number; src?: string; pinned?: boolean; url: string; width?: number; height?: number }[] = [];
  for (const img of rows) {
    if (img.pinned) {
      if (inReplies.has(img.path)) continue;
      inReplies.add(img.path);
    }
    const url = await ctx.storage.getUrl(img.storageId);
    if (!url) continue;
    out.push({ seq: img.seq, ...(img.src ? { src: img.src } : {}), ...(img.pinned ? { pinned: true } : {}), url, ...(img.width ? { width: img.width } : {}), ...(img.height ? { height: img.height } : {}) });
  }
  return out;
}

export const view = query({
  args: { slug: v.string(), token: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.union(
    v.object({ state: v.literal('gone') }),
    v.object({
      state: v.literal('ok'),
      title: v.string(),
      createdAt: v.optional(v.string()),
      // The CLI and the model id ("claude", "claude-opus-5-5"), for the
      // page's byline.
      provider: v.optional(v.string()),
      model: v.optional(v.string()),
      running: v.boolean(),
      working: v.optional(v.string()),
      lastActivityAt: v.string(),
      messages: v.array(message),
      images: v.array(shareImage),
      hasMore: v.boolean(),
      // Only for Mike: whether it's shared now, for the page's controls.
      manage: v.optional(v.object({ threadId: v.string(), shared: v.boolean() })),
    }),
  ),
  handler: async (ctx, { slug, token, limit }) => {
    const t = await threadBySlug(ctx, slug);
    if (!t?.share) return { state: 'gone' as const };
    const shared = t.share.access === 'link';
    const mike = await isMike(ctx, token);
    if (!shared && !mike) return { state: 'gone' as const };
    const want = pageLimit(limit, PAGE_DEFAULT, PAGE_MAX);
    const out: Infer<typeof message>[] = [];
    // At most one more than the page, and PAGE_BYTES of it: a page of big
    // rows stops short, saying there's more, rather than going past what a
    // query may read.
    let hasMore = false;
    let bytes = 0;
    for await (const m of ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', t.threadId)).order('desc')) {
      if (out.length >= want || (bytes += docBytes(m)) > PAGE_BYTES) {
        hasMore = true;
        break;
      }
      out.push({
        seq: m.seq,
        role: m.role,
        text: m.text,
        ...(m.origin ? { origin: m.origin } : {}),
        ...(m.toolKind ? { toolKind: m.toolKind } : {}),
        ...(m.summary ? { summary: true } : {}),
        ...(m.turn ? { turn: m.turn } : {}),
        at: m.at,
      });
    }
    out.reverse();
    return {
      state: 'ok' as const,
      title: t.title,
      createdAt: t.createdAt,
      provider: t.provider,
      ...(t.model ? { model: t.model } : {}),
      running: t.status === 'running' || t.status === 'starting',
      ...(t.working ? { working: t.working } : {}),
      lastActivityAt: t.lastActivityAt,
      messages: out,
      images: await imagesFrom(ctx, t.threadId, hasMore ? (out[0]?.seq ?? 0) : 0),
      hasMore,
      ...(mike ? { manage: { threadId: t.threadId, shared } } : {}),
    };
  },
});

// What a link to a shared thread unfurls as in Slack, X or iMessage (the
// /s/ route in http.ts puts it in the page's meta tags): its title, the
// start of its last reply, and its first picture. Null for a link that
// isn't shared, which then unfurls as plain Threadbear.
export const preview = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.null(), v.object({ title: v.string(), description: v.string(), image: v.optional(v.string()) })),
  handler: async (ctx, { slug }) => {
    const t = await threadBySlug(ctx, slug);
    if (t?.share?.access !== 'link') return null;
    let description = '';
    let read = 0;
    for await (const m of ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', t.threadId)).order('desc')) {
      if (++read > 200) break;
      if (m.role === 'assistant' && m.text.trim()) {
        description = plainText(m.text);
        break;
      }
    }
    const first = await ctx.db
      .query('shareImages')
      .withIndex('by_thread_seq', (q) => q.eq('threadId', t.threadId))
      .first();
    const image = first ? await ctx.storage.getUrl(first.storageId) : null;
    return { title: t.title || 'Untitled', description, ...(image ? { image } : {}) };
  },
});

// Markdown as one line of plain text, cut at a word near 200 characters.
// Each line or list item ends in a full stop, so bullets don't run
// together. web/src/format.ts has the same for the page's own preview.
export function plainText(md: string): string {
  const lines = md
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const flat = lines.map((l, i) => (i < lines.length - 1 && !/[.!?:…]$/.test(l) ? `${l}.` : l)).join(' ');
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 200);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 150))}…`;
}
