// The live mirror the phone reads (docs/convex-backend.md, shape A). Every
// row is "the current state of X" as the owning runner last wrote it; the
// runner stays the source of truth and this is never read back by it.
// Only what a phone needs: no transcripts or tool output, and the only images
// are what an agent showed Mike on purpose or he pasted (replyImages), or a shared thread's.
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// A thread's sharing, as the runner mirrors it (ThreadShare in
// docs/protocol.md): "link" is readable by anyone with /s/<slug>; "off"
// (since API 8) only by Mike, so his page can offer Share again. A thread
// never shared has none. "people" and `people` came from API 7 runners
// (sharing with specific people, dropped 29 Oct) and read as off.
export const shareField = v.object({
  access: v.union(v.literal('off'), v.literal('link'), v.literal('people')),
  slug: v.string(),
  people: v.optional(v.array(v.string())),
});

// The phone's view of a thread, named as in docs/protocol.md's
// ThreadSummary. Written on change, coalesced, never per token.
// A reply button as a message row carries it (API 59, docs/protocol.md
// "Reply buttons"): what the phone and website need to draw it, never the
// brief or message behind it, which stay on the runner. target is the new
// thread's folder name or the title of the thread it messages.
export const messageButton = v.object({
  id: v.string(),
  title: v.string(),
  kind: v.union(v.literal('start'), v.literal('send')),
  target: v.optional(v.string()),
  pressedThreadId: v.optional(v.string()),
  failed: v.optional(v.string()),
});

export const threadFields = {
  threadId: v.string(),
  runnerId: v.string(),
  title: v.string(),
  cwd: v.string(),
  accountId: v.string(),
  provider: v.string(),
  model: v.optional(v.string()),
  status: v.string(),
  needsYou: v.boolean(),
  unread: v.boolean(), // lastSeq > lastSeenSeq
  preview: v.string(),
  createdAt: v.string(),
  lastActivityAt: v.string(),
  lastActivityMs: v.number(), // lastActivityAt as a number, for the index
  snoozedUntil: v.optional(v.string()),
  snoozedUntilRestart: v.optional(v.boolean()),
  // What a hibernating thread waits for when it's more than a time ("\"Convex I/O\" finishes",
  // "the runner updates"), for the row (runner/src/wake-note.ts).
  wakeNote: v.optional(v.string()),
  // Back from hibernating by itself and not opened yet: the row says
  // "Woke up" (docs/protocol.md, ThreadSummary.woke).
  woke: v.optional(v.object({ at: v.string(), since: v.optional(v.string()) })),
  // Who started it, when that wasn't Mike: the row's byline
  // (docs/protocol.md, "Who started a thread"). Since API 22.
  startedBy: v.optional(v.object({ kind: v.string(), label: v.string(), icon: v.optional(v.string()), why: v.optional(v.string()) })),
  // What Mike last said to it, one line: the row's "You: ..."
  // (docs/protocol.md, "What Mike last asked"). Since API 31.
  asked: v.optional(v.string()),
  archivedAt: v.optional(v.string()),
  // Mike starred it: the phone's Starred section. Since API 27.
  starredAt: v.optional(v.string()),
  costUsd: v.optional(v.number()),
  projects: v.optional(v.array(v.object({ id: v.string(), title: v.string() }))),
  working: v.optional(v.string()), // the working line: what the CLI is doing in the background
  earliestSeq: v.optional(v.number()), // seq of the thread's first text message, for "Load earlier messages"
  // Whether anyone with the /s/<slug> link can read it (docs/website.md,
  // "Sharing"). Absent: never shared.
  share: v.optional(shareField),
  // The open card of asks from the agent's end_turn (docs/protocol.md,
  // "Needs you"), since API 14: what Mike has to do, which the phone shows
  // under the reply with its options as buttons. asksSeq says which card a
  // picked answer belongs to. Only web links: the phone can't open a file
  // on the Mac.
  asks: v.optional(
    v.array(
      v.object({
        action: v.string(),
        why: v.optional(v.string()),
        reply: v.optional(v.string()),
        options: v.optional(v.array(v.string())),
        suggested: v.optional(v.number()),
        links: v.optional(v.array(v.object({ title: v.string(), url: v.string() }))),
        ticked: v.optional(v.boolean()),
      }),
    ),
  ),
  asksSeq: v.optional(v.number()),
  // A finished turn's suggested follow-ups (end_turn's `next`), since API 14.
  next: v.optional(v.array(v.string())),
  // The thread's patch link buttons (url actions, docs/protocol.md
  // "Patches"), since API 28: the phone shows them and opens them itself.
  // icon is an SF Symbol.
  links: v.optional(v.array(v.object({ title: v.string(), url: v.string(), icon: v.optional(v.string()) }))),
  // What the phone's sections need to match the Mac's (app ThreadSections),
  // since API 15: what the last turn said it needs, the design reviews
  // waiting on Mike, and whether it's waiting for a login with room.
  needs: v.optional(v.union(v.literal('you'), v.literal('nothing'))),
  pendingReviews: v.optional(v.number()),
  waitingForRoom: v.optional(v.object({ until: v.string(), accountId: v.optional(v.string()) })),
  // Its last turn couldn't reach the API (the internet went), and it
  // carries on by itself once the runner can, since API 34: the phone's
  // row says "Waiting for connection" rather than Failed.
  waitingForNetwork: v.optional(v.object({ since: v.string() })),
  // The approval or question the thread is waiting on, if any (step 2).
  pendingApproval: v.optional(
    v.union(
      v.object({
        approvalId: v.string(),
        kind: v.literal('approval'),
        // The approval.requested event's seq (API 44), so the main Mac's
        // runner can place the card in another runner's transcript.
        seq: v.optional(v.number()),
        name: v.string(),
        title: v.string(),
        options: v.array(v.string()),
        inputSummary: v.optional(v.string()),
      }),
      v.object({
        approvalId: v.string(),
        kind: v.literal('question'),
        seq: v.optional(v.number()),
        questions: v.array(
          v.object({
            question: v.string(),
            header: v.optional(v.string()),
            multiSelect: v.boolean(),
            options: v.array(v.object({ label: v.string(), description: v.optional(v.string()) })),
          }),
        ),
      }),
      // An agent asking for a secret (API 35, docs/protocol.md "Secrets"):
      // `key` is the runner's X25519 public key, which the phone seals its
      // answer to, so the value never reaches this deployment in the clear.
      v.object({
        approvalId: v.string(),
        kind: v.literal('secret'),
        seq: v.optional(v.number()),
        label: v.string(),
        reason: v.string(),
        placeholder: v.optional(v.string()),
        key: v.string(),
      }),
    ),
  ),
};

// Which list a thread is in on the phone, worked out by the runner so the
// phone and the Mac app agree: "inbox", "hibernating" (snoozed) or "den"
// (archived). A starred thread that's snoozed stays in "inbox", as Starred
// is at the top of the phone's inbox.
export const views = ['inbox', 'hibernating', 'den'] as const;

export default defineSchema({
  // One row per runner (the Mac, Tinker Desk later), written every minute.
  // A phone treats one not seen for 3 minutes as offline.
  runners: defineTable({
    runnerId: v.string(),
    name: v.string(),
    version: v.string(),
    release: v.optional(v.string()),
    lastSeenAt: v.number(),
    startedAt: v.string(),
    draining: v.boolean(),
    threadCount: v.number(),
    // Whether Mike is at this Mac (the Mac app connected and the keyboard or
    // mouse used in the last two minutes), from sync:setPresence (API 3).
    // Only believed while lastSeenAt is recent: a sleeping Mac counts as away.
    atMac: v.optional(v.boolean()),
    atMacAt: v.optional(v.number()),
    // An SF Symbol for the runner's Mac ("laptopcomputer", "macmini"), so
    // lists can tell runners apart at a glance (API 10).
    icon: v.optional(v.string()),
    // "memory" or "disk" while one's running low (API 45), for the website's
    // runner tiles. On this row since it rarely changes; the figures have a
    // row of their own (runnerStats), read only by the Runners view.
    pressure: v.optional(v.string()),
    // Its active schedules have been copied to scheduleWakes (API 45), once.
    wakesSeeded: v.optional(v.boolean()),
    // How a Mac app reaches this runner to open one of its threads (API 12):
    // wss://<MagicDNS name>:<port>/rpc, only on the tailnet (sync.rpcUrl).
    rpcUrl: v.optional(v.string()),
    // Its last heartbeat came with the owner key (docs/protocol.md, "Runner
    // keys"), so it's the main Mac: a phone's new thread goes there first.
    byOwner: v.optional(v.boolean()),
  }).index('by_runnerId', ['runnerId']),

  // Runner keys (docs/protocol.md, "Runner keys"): each authenticates as its
  // runnerId alone, where the owner key (RUNNER_KEY) can do everything. Only
  // the SHA-256 of a key is kept; the plain key goes back once, to the owner
  // that made it (sync:addRunnerKey). Making another for the same runner
  // revokes the one before.
  runnerKeys: defineTable({
    runnerId: v.string(),
    keyHash: v.string(),
    name: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index('by_hash', ['keyHash'])
    .index('by_runnerId', ['runnerId'])
    .index('by_revokedAt', ['revokedAt']),

  // The logins each runner key's runner shares with the main Mac, by
  // provider and email (lowercase), written by the owner key alone
  // (sync:setRunnerLogins, `tb runner logins`). sync:sharedUsage goes by
  // these, never by the accounts rows a runner key writes for itself, which
  // say whatever that key likes (docs/protocol.md, "Runner keys").
  runnerLogins: defineTable({
    runnerId: v.string(),
    provider: v.string(),
    email: v.string(),
    at: v.number(),
  }).index('by_runnerId', ['runnerId']),

  // Runner ids the main key has named as its own (sync:addRunnerKey's
  // ownerRunnerId), so the audit can flag a runner key made for one.
  ownerRunnerIds: defineTable({
    runnerId: v.string(),
    at: v.number(),
  }).index('by_runnerId', ['runnerId']),

  // One small row per thread, just what a sidebar row shows (API 12), so a
  // Mac app can list other runners' threads without the busy fields of
  // `threads`: a runner writes a row only when one of these changes, apart
  // from preview and lastActivityAt, which ride along but never cause a
  // write (docs/step6-plan.md, part 2).
  threadIndex: defineTable({
    runnerId: v.string(),
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
    starredAt: v.optional(v.string()), // since API 27
    // Who started it, when that wasn't Mike: the row's byline. Since API 23.
    startedBy: v.optional(v.object({ kind: v.string(), label: v.string(), icon: v.optional(v.string()), threadTitle: v.optional(v.string()), why: v.optional(v.string()) })),
    // What Mike last said to it, one line: the Mac row's "You: ...". Since API 32.
    asked: v.optional(v.string()),
    // Since API 29: when the backend last wrote the row, so a watching
    // runner reads only rows changed since its last answer
    // (sync:threadIndexSince), and `deleted` marks a thread that's gone,
    // kept for a day so watchers hear of it (pruneOld drops it then).
    updatedMs: v.optional(v.number()),
    deleted: v.optional(v.boolean()),
  })
    .index('by_runnerId', ['runnerId'])
    .index('by_runner_thread', ['runnerId', 'threadId'])
    .index('by_runner_updated', ['runnerId', 'updatedMs'])
    .index('by_deleted_updated', ['deleted', 'updatedMs'])
    // Whether another runner already lists a thread id (sync.ts claimable).
    .index('by_threadId', ['threadId'])
    // A runner key's live rows, for its cap (sync.ts setThreadIndex).
    .index('by_runner_deleted', ['runnerId', 'deleted']),

  // Every thread row ever deleted (removeThreads, prune), so a runner key
  // can't later make a row under that id and so read or show what was
  // left under it (docs/protocol.md, "Runner keys"). One small row per
  // deleted thread, kept for good; the owner key may reuse any id.
  // A row with `slug` is a share link that thread had (deleted, or replaced
  // by Share again with a new link): no runner key may take it up.
  threadTombstones: defineTable({
    threadId: v.string(),
    runnerId: v.string(),
    at: v.number(),
    slug: v.optional(v.string()),
  })
    .index('by_threadId', ['threadId'])
    .index('by_slug', ['slug'])
    // pruneOld: thread tombstones (no slug) go after TOMBSTONE_DAYS.
    .index('by_slug_at', ['slug', 'at']),

  // Upload URLs handed to a runner key (sync:iconUploadUrl): one use each,
  // redeemed by convex/http.ts /runner/upload, which records the file in
  // storageOwners. Counted for the hourly limit; pruneOld drops old ones.
  uploadTickets: defineTable({
    ticketHash: v.string(),
    runnerId: v.string(),
    // The runnerKeys row that asked: a ticket dies with its key.
    keyId: v.optional(v.id('runnerKeys')),
    issuedAt: v.number(),
    usedAt: v.optional(v.number()),
    // What was uploaded with it: the hour's allowance counts these, which
    // stay a day whatever happens to the file.
    bytes: v.optional(v.number()),
  })
    .index('by_hash', ['ticketHash'])
    .index('by_runner_issued', ['runnerId', 'issuedAt'])
    .index('by_issued', ['issuedAt']),

  // All a runner key's runner keeps in file storage, against its cap
  // (sync:redeemUpload), less what's been deleted.
  // Also its message count (CAP.messages) and its pushes this minute.
  runnerStorage: defineTable({
    runnerId: v.string(),
    bytes: v.number(),
    messages: v.optional(v.number()),
    // Its messages' bytes, against its budget (sync.ts appendMessages).
    messageBytes: v.optional(v.number()),
    // Its tool output's bytes (eventBodies), against CAP.bodyBytes.
    bodyBytes: v.optional(v.number()),
    pushMinute: v.optional(v.number()),
    pushes: v.optional(v.number()),
  }).index('by_runnerId', ['runnerId']),

  // Which runner key's runner uploaded a stored file: such a key attaches
  // or deletes only files of its own. Files with no row here (the owner's,
  // the phone's) are no runner key's. `attachedAt`: first named in a row;
  // one never attached goes after a day (pruneOld).
  storageOwners: defineTable({
    storageId: v.id('_storage'),
    runnerId: v.string(),
    at: v.number(),
    bytes: v.optional(v.number()),
    attachedAt: v.optional(v.number()),
  })
    .index('by_storageId', ['storageId'])
    // A runner's bytes uploaded in the last hour (sync:redeemUpload's cap).
    .index('by_runner_at', ['runnerId', 'at'])
    .index('by_unattached', ['attachedAt', 'at']),

  // A phone's photo uploads (phone:imageUploadUrl, convex/http.ts
  // /phone/upload): the one-use ticket, and once it's used the file it
  // stored, so the photo is that phone token's. A command takes only its own
  // token's photos, phone:discardImage deletes only those, and one never sent
  // goes after a day (sync:pruneFiles). The rows stay a day whatever happens
  // to the file, as the allowances count them (phone.ts PHONE_UPLOADS).
  phoneUploads: defineTable({
    ticketHash: v.string(),
    tokenId: v.id('tokens'),
    issuedAt: v.number(),
    usedAt: v.optional(v.number()),
    storageId: v.optional(v.id('_storage')),
    bytes: v.optional(v.number()),
  })
    .index('by_hash', ['ticketHash'])
    .index('by_token_issued', ['tokenId', 'issuedAt'])
    .index('by_storageId', ['storageId'])
    .index('by_issued', ['issuedAt']),

  // The stored files a command names (its args.images), so whether a file is
  // still on its way to a runner is one index read (sync.ts storageInUse)
  // rather than a look through every waiting command. Written with the
  // command (phone.ts queue); a finished command's go when it does (pruneOld).
  // A thread id whose old rows are more than one mutation may read (a thread
  // removed, or one the owner is taking over): they go in runs (sync.ts
  // dropThreadRows), and nothing is written under the id meanwhile. A
  // takeover (`moving`) goes through on the owner's next write once `done`.
  threadClears: defineTable({
    threadId: v.string(),
    runnerId: v.string(),
    moving: v.optional(v.boolean()),
    done: v.optional(v.boolean()),
  }).index('by_threadId', ['threadId']),

  commandFiles: defineTable({
    storageId: v.id('_storage'),
    commandId: v.id('commands'),
  })
    .index('by_storageId', ['storageId'])
    .index('by_commandId', ['commandId']),

  // pushedAt is the mirror's own: when a push last went out for the thread
  // (push.ts), kept across the runner's writes.
  // pushHeldAt: a push to "when I'm away" phones held back because Mike was
  // at the Mac; it goes out if he leaves while the thread still needs him.
  // view "overflow": a runner key's thread past its view's cap (sync.ts
  // upsertThreads): out of the lists the phone reads whole, everything
  // else kept; wantView is the view it's really in, which reads by id show.
  threads: defineTable({ ...threadFields, view: v.union(...[...views, 'overflow' as const].map((x) => v.literal(x))), wantView: v.optional(v.union(...views.map((x) => v.literal(x)))), pushedAt: v.optional(v.number()), pushHeldAt: v.optional(v.number()), updatedMs: v.optional(v.number()) })
    // phone:threadsSince (API 43): the rows written since a client last heard.
    // updatedMs moves with what a list shows, not with the mirror's own push
    // marks, so those re-run nothing.
    .index('by_updated', ['updatedMs'])
    // The overflowed thread to bring back first when its list has room (sync.ts refill).
    .index('by_runner_want', ['runnerId', 'wantView', 'lastActivityMs'])
    .index('by_threadId', ['threadId'])
    .index('by_share_slug', ['share.slug'])
    .index('by_runnerId', ['runnerId'])
    // sync:sharedThreads: a runner's rows anyone with the link can read, which
    // it checks against its own threads on every start and every hour.
    .index('by_runner_share', ['runnerId', 'share.access'])
    // How many of a runner key's threads are in a view the phone reads whole (its cap).
    .index('by_runner_view', ['runnerId', 'view', 'lastActivityMs'])
    // setPresence finds held pushes with this, rather than reading every
    // thread the runner has ever had each time Mike leaves the Mac.
    .index('by_runner_pushHeld', ['runnerId', 'pushHeldAt'])
    .index('by_view_activity', ['view', 'lastActivityMs'])
    // phone:search, for archived threads older than the phone's den list.
    .searchIndex('search_title', { searchField: 'title', filterFields: ['view'] })
    .searchIndex('search_preview', { searchField: 'preview', filterFields: ['view'] }),

  // Every text message of every thread, and one line per tool call (role
  // "tool", since API 2; docs/setup-and-updates.md step 2). Tool output and
  // diffs stay on the Mac; pictures are in replyImages and shareImages. pagedAt marks rows an old phone asked
  // for with loadEarlier, so phone:thread still shows them to it for a day.
  messages: defineTable({
    threadId: v.string(),
    seq: v.number(),
    role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool')),
    text: v.string(),
    origin: v.optional(v.string()),
    toolKind: v.optional(v.string()), // the protocol's ToolKind, for a tool row
    summary: v.optional(v.boolean()), // end_turn's bullets, the turn's reply (since API 14)
    turn: v.optional(v.string()), // the start of its turn's id (since API 26)
    wokeBy: v.optional(v.array(v.object({ kind: v.string(), description: v.string() }))), // what finished and woke this turn, on its first row (since API 33)
    buttons: v.optional(v.array(messageButton)), // the reply buttons its text links, as they are now (since API 59)
    at: v.string(),
    pagedAt: v.optional(v.number()),
    // The runner key's runner that wrote it, so past its message budget its
    // oldest anywhere give way (sync.ts appendMessages). Absent: the main key's.
    runnerId: v.optional(v.string()),
  })
    .index('by_thread_seq', ['threadId', 'seq'])
    .index('by_thread_pagedAt', ['threadId', 'pagedAt'])
    .index('by_pagedAt', ['pagedAt'])
    .index('by_runnerId', ['runnerId']),

  // What the phone asks a runner to do (step 3). The owning runner takes
  // pending ones for its runnerId (or "any"), applies them through the
  // same code the Mac app uses, and marks them done or failed.
  commands: defineTable({
    runnerId: v.string(), // or "any"
    threadId: v.optional(v.string()),
    // interrupt and call (API 44) come only from the main Mac's runner (relay.ts queueCommand).
    kind: v.union(v.literal('send'), v.literal('respond'), v.literal('update'), v.literal('create'), v.literal('page'), v.literal('share'), v.literal('quickAsk'), v.literal('interrupt'), v.literal('call'), v.literal('schedule'), v.literal('picture'), v.literal('press')),
    args: v.any(),
    state: v.union(v.literal('pending'), v.literal('taken'), v.literal('done'), v.literal('failed')),
    note: v.optional(v.string()),
    createdAt: v.number(),
    takenAt: v.optional(v.number()),
    doneAt: v.optional(v.number()),
    resultThreadId: v.optional(v.string()), // for create, once it lands
    result: v.optional(v.string()), // a call's answer as JSON text (API 44), from an allow-listed method (relay.ts CALLS)
  })
    .index('by_runner_state', ['runnerId', 'state'])
    .index('by_state', ['state'])
    // phone:waiting (API 57): a thread's messages its runner hasn't taken yet.
    .index('by_thread_state', ['threadId', 'state'])
    // pruneOld: finished ones by when they finished.
    .index('by_state_done', ['state', 'doneAt'])
    // pruneOld: ones no runner took in COMMAND_KEEP_MS, by when they were made.
    .index('by_state_created', ['state', 'createdAt']),

  // A runner on a runner key asking for a new thread on another runner
  // (docs/protocol.md, "Asking another runner"). It can't queue work there
  // itself, so it files the whole request here, where nothing can change it
  // after, and the main Mac shows Mike exactly this before its runner (the
  // owner key) starts it. requestId is the card's approvalId.
  runnerRequests: defineTable({
    requestId: v.string(),
    runnerId: v.string(), // who asked, from its key, never from the request
    threadId: v.string(), // its thread that asked (one of its own)
    target: v.string(), // the runner asked for, as the agent named it ("main", a name or an id)
    text: v.string(),
    title: v.optional(v.string()),
    cwd: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    permissionMode: v.optional(v.string()),
    why: v.optional(v.string()),
    createdAt: v.number(),
    // claimed: the main Mac's runner is starting it (so a retry can't start
    // a second); closed: the asking runner gave up on it (its card expired,
    // or was declined there), so it no longer counts against its cap.
    state: v.union(v.literal('pending'), v.literal('claimed'), v.literal('allowed'), v.literal('denied'), v.literal('closed')),
    // Once allowed: where it was started.
    result: v.optional(v.object({ runnerId: v.string(), runnerName: v.string(), threadId: v.string() })),
    decidedAt: v.optional(v.number()),
  })
    .index('by_requestId', ['requestId'])
    .index('by_runnerId', ['runnerId'])
    .index('by_runner_state', ['runnerId', 'state']),

  // Full sync (API 52, docs/full-convex.md step 4; sync.full in runner.json).
  // One row per tool call, under the seq of its one-line `messages` row, with
  // its output, input, diffs and the reasoning before it. Convex charges a read
  // for the whole document, so these are never in a list read: each is fetched
  // once, by seq, when someone opens that tool (sync:remoteBody, phone:eventBody).
  // `withheld`: its command or file can hold secrets (runner/src/withhold.ts), so
  // nothing of it came up. input and diffs are JSON text. Kept 30 days (pruneBodies).
  eventBodies: defineTable({
    threadId: v.string(),
    seq: v.number(),
    runnerId: v.optional(v.string()), // a runner key's, for its budget (CAP.bodyBytes)
    at: v.number(), // when it was stored
    withheld: v.optional(v.boolean()),
    reason: v.optional(v.string()),
    text: v.optional(v.string()),
    ok: v.optional(v.boolean()),
    truncated: v.optional(v.boolean()),
    input: v.optional(v.string()),
    diffs: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    images: v.optional(v.number()), // how many pictures the tool handed back (see heldPictures)
    cut: v.optional(v.boolean()), // shortened to fit (docs/full-convex.md)
  })
    .index('by_thread_seq', ['threadId', 'seq'])
    .index('by_at', ['at'])
    .index('by_runner_at', ['runnerId', 'at']),

  // A tool's picture someone tapped to see (API 52): the runner uploads that
  // one for a day, on a `picture` command. Screenshots otherwise stay on it.
  heldPictures: defineTable({
    threadId: v.string(),
    seq: v.number(),
    index: v.number(),
    storageId: v.id('_storage'),
    mediaType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    at: v.number(),
  })
    .index('by_thread_seq', ['threadId', 'seq', 'index'])
    .index('by_at', ['at'])
    .index('by_storageId', ['storageId']),

  // Phone tokens: only the hash is kept. Issued from the Mac app through
  // the runner (sync:issueToken) or by hand with
  // `npx convex run tokens:issue '{"name":"iphone","days":90}'`. `kind`
  // says whether a phone or a browser holds it (rows from before 28 Oct
  // have none: tokens.ts works it out from the name).
  tokens: defineTable({
    hash: v.string(),
    name: v.string(),
    kind: v.optional(v.union(v.literal('phone'), v.literal('browser'))),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    // Since runner keys: which key issued it ("owner", the only one that
    // may), and the first 8 hex of that key's SHA-256, so after a rotation
    // `tb runner audit` can tell tokens the old shared key made.
    issuedBy: v.optional(v.string()),
    ownerKeyPrint: v.optional(v.string()),
  })
    .index('by_hash', ['hash'])
    // The audit's live tokens, without reading revoked ones.
    .index('by_revokedAt', ['revokedAt']),

  // The runner's projects, schedules and accounts (docs/protocol.md), one
  // row each, replaced as a whole when the runner's list changes.
  projects: defineTable({
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
    // The project's icon (docs/protocol.md, "Icons"), since API 5: its SF
    // Symbol, and `picture` naming the copy of its picture the runner has
    // put in projectIcons (the file's hash is in the name, so a changed
    // picture is a new name).
    icon: v.optional(v.object({ symbol: v.optional(v.string()), picture: v.optional(v.string()), by: v.string() })),
  })
    .index('by_runnerId', ['runnerId'])
    // sync:upsertProjects (API 30) finds the one project it changes.
    .index('by_runner_id', ['runnerId', 'id']),

  // A project's notes, apart from its row (API 50, projectNotes.ts). Notes
  // are most of a project's bytes (16 KB of the Threadbear project's 17.7),
  // and Convex charges a write for the whole document, so with them in
  // `projects` every state update or new thread count rewrote them, about
  // 50 KB a time. `projects.notes` is '' for a row written since; an older
  // row's notes move here the first time it's written.
  projectNotes: defineTable({
    runnerId: v.string(),
    id: v.string(),
    notes: v.string(),
  })
    .index('by_runnerId', ['runnerId'])
    .index('by_runner_id', ['runnerId', 'id']),

  // One small row per project, what a list shows (API 48, projectHeads.ts):
  // the phone follows the list all the time, and a read costs the whole
  // document, so reading `projects` for it cost every project's notes. Goals,
  // state, notes and folders stay in `projects`, read for one project by
  // phone:project. Only written when one of these fields changes.
  // Marks that a one-off copy of old rows has been done for the whole
  // deployment, so readers know the new table is complete.
  backendMarks: defineTable({ name: v.string() }).index('by_name', ['name']),

  projectHeads: defineTable({
    runnerId: v.string(),
    id: v.string(),
    title: v.string(),
    createdBy: v.string(),
    archived: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.string(),
    threadCount: v.number(),
    lastActivityAt: v.optional(v.string()),
    icon: v.optional(v.object({ symbol: v.optional(v.string()), picture: v.optional(v.string()), by: v.string() })),
  })
    .index('by_runnerId', ['runnerId'])
    .index('by_runner_id', ['runnerId', 'id']),

  // How many of a runner's threads are in each of the phone's tucked-away
  // views (API 30), kept by the writes that move a thread between views, so
  // phone:counts reads a row per runner rather than every thread. A runner's
  // prune (each start) counts them again from scratch.
  // Since runner keys also its inbox and overflow threads and all of them,
  // which a runner key's caps are checked against without reading its rows.
  viewCounts: defineTable({
    runnerId: v.string(),
    hibernating: v.number(),
    den: v.number(),
    // Set once linkProjects has been run over every thread the runner had
    // when projectThreads arrived (API 40); later writes keep links current.
    projectsLinked: v.optional(v.boolean()),
    inbox: v.optional(v.number()),
    overflow: v.optional(v.number()),
    total: v.optional(v.number()),
  }).index('by_runnerId', ['runnerId']),

  // Which threads are in which project (API 40), one row per pair, kept by
  // the writes to `threads`. A thread's projects are an array on its row,
  // which Convex can't index, so without this a project's page would have
  // to read every thread to find its own, archived ones included.
  projectThreads: defineTable({
    runnerId: v.string(),
    projectId: v.string(),
    threadId: v.string(),
    // Written by the first links only (5 Nov): keeping it current cost a
    // patch per turn, so nothing reads or writes it now.
    lastActivityMs: v.optional(v.number()),
  })
    // Newest joined first, by _creationTime, which every index ends with.
    .index('by_project', ['projectId'])
    .index('by_threadId', ['threadId']),

  // A thread row gone in the last day, so a client following phone:threadsSince
  // hears of it. One away for longer loads the whole list when it's back anyway.
  threadGone: defineTable({ threadId: v.string(), at: v.number() }).index('by_at', ['at']),

  // The phone's Pocket: short cards agents file for when Mike's out
  // (API 19, the `pocket` tool). They live here rather than on a runner, so
  // both runners share one deck and the phone can remove one while the Mac
  // sleeps. `key` is the title in lower case: filing the same title again
  // replaces the card, whichever thread does it.
  pocketCards: defineTable({
    key: v.string(),
    title: v.string(),
    text: v.string(),
    place: v.optional(v.string()), // what to search the map for, to mark the card "here"
    icon: v.optional(v.string()), // since API 21: its picture and colour on the phone (runner/src/pocket-icons.ts)
    threadId: v.optional(v.string()),
    source: v.optional(v.string()), // the project or thread it came from, as it was then
    updatedAt: v.string(),
    // The runner whose runner key filed it: such a key sees and changes only
    // its own cards. Absent: filed with the owner key (or before keys).
    runnerId: v.optional(v.string()),
  })
    .index('by_key', ['key'])
    // How many a runner key has filed (its cap), and a takeover's cleanup.
    .index('by_runnerId', ['runnerId']),

  // A project's picture, in file storage, as the phone shows it: PNG at
  // most 256 px (an SVG is drawn to PNG by the runner, since the phone
  // can't draw SVG). One row per project; the runner replaces it when the
  // picture changes and setProjects drops it with the project.
  projectIcons: defineTable({
    runnerId: v.string(),
    projectId: v.string(),
    picture: v.string(), // the projects row's icon.picture this is
    storageId: v.id('_storage'),
    mediaType: v.string(),
    updatedAt: v.number(),
  })
    .index('by_runner_project', ['runnerId', 'projectId'])
    // Who else uses a stored file, before one is attached or deleted (sync.ts storageUsers).
    .index('by_storageId', ['storageId']),

  schedules: defineTable({
    runnerId: v.string(),
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
    // Since API 9 a row can be the schedule itself rather than a runner's
    // mirror of its own file (docs/protocol.md, Schedules, "Runners"):
    // `owned` marks those, which only the sync:*Schedule functions write
    // and setSchedules never touches. They also keep what the mirror left
    // out, a run being sent (`claim`, which lapses at `until`), and a
    // schedules.run made on another runner (`runRequestedAt`).
    owned: v.optional(v.boolean()),
    effort: v.optional(v.string()),
    permissionMode: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    // Since API 36: the pool that picks its threads' login, instead of
    // accountId.
    poolId: v.optional(v.string()),
    // Since API 51: a shell command its runner runs before each run; a run
    // whose check prints nothing is skipped (docs/protocol.md, Schedules).
    check: v.optional(v.string()),
    // Since API 55: how long that check may take, in seconds.
    checkTimeoutSecs: v.optional(v.number()),
    claim: v.optional(v.object({ holder: v.string(), until: v.number() })),
    runRequestedAt: v.optional(v.string()),
    // When what a runner reads last changed (API 48), for sync:schedulesSince.
    // A claim doesn't move it: runners aren't told about claims, so a claim
    // re-runs nobody. Rows from before have none until they're next written,
    // and are read when a runner first reads the whole table.
    updatedMs: v.optional(v.number()),
  })
    .index('by_runnerId', ['runnerId'])
    .index('by_scheduleId', ['id'])
    .index('by_updated', ['updatedMs'])
    .index('by_runner_updated', ['runnerId', 'updatedMs']),

  // A schedule gone or moved off a runner in the last day, so a runner
  // following sync:schedulesSince hears of it. One away for longer reads the
  // whole table when it's back anyway.
  scheduleGone: defineTable({ id: v.string(), runnerId: v.string(), at: v.number() })
    .index('by_at', ['at'])
    // A gone id stays its runner's while this lasts (scheduleIdTaken).
    .index('by_scheduleId', ['id'])
    .index('by_runner_at', ['runnerId', 'at']),

  // Pools shared by every runner (API 38, docs/protocol.md, "Pools"): one
  // row per pool, in `order`. Members are logins by provider and email, as
  // login ids are each runner's own; one with no email is named by the
  // runner that has it and its id there.
  pools: defineTable({
    id: v.string(),
    title: v.string(),
    members: v.array(v.object({ provider: v.string(), email: v.optional(v.string()), runnerId: v.optional(v.string()), accountId: v.optional(v.string()) })),
    folders: v.optional(v.array(v.string())),
    icon: v.optional(v.string()),
    order: v.number(),
    updatedAt: v.string(),
    updatedBy: v.string(),
  }).index('by_poolId', ['id']),

  // What a client needs to know about schedules all the time, one small row
  // per active one (API 45): the website's sidebar uses them to put threads
  // waiting on a schedule under Hibernating and to count them. A live read of
  // `schedules` costs about 150 KB and re-runs on every claim and run, as each
  // writes the row with its whole message. Kept by the sync:*Schedule
  // functions, and only written when one of these fields changes.
  scheduleWakes: defineTable({
    scheduleId: v.string(),
    runnerId: v.string(),
    threadId: v.optional(v.string()),
    nextRunAt: v.optional(v.string()),
  }).index('by_scheduleId', ['scheduleId']),

  // A machine's figures for the website's Runners view (API 45,
  // runner/src/runner-stats.ts), written only while runnerWatch is fresh.
  runnerStats: defineTable({
    runnerId: v.string(),
    at: v.number(),
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
  }).index('by_runnerId', ['runnerId']),

  // One row: until when someone has the Runners view open. Runners subscribe,
  // and report only while it's in the future.
  runnerWatch: defineTable({ until: v.number() }),

  // One row: the order Mike put his runners in on the phone (API 56). A new
  // thread from the phone starts on the first of them that's online, and so
  // does one that names no runner (phone.ts mainRunner). Only a phone token
  // sets it, so a runner key can never move itself up.
  runnerOrder: defineTable({ runnerIds: v.array(v.string()) }),

  accounts: defineTable({
    runnerId: v.string(),
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
  })
    .index('by_runnerId', ['runnerId'])
    // sync:upsertAccounts (API 37) finds the one account it changes.
    .index('by_runner_id', ['runnerId', 'id']),

  // APNs tokens for push (step 4), one row per phone install.
  devices: defineTable({
    apnsToken: v.string(),
    environment: v.union(v.literal('sandbox'), v.literal('production')),
    tokenName: v.string(),
    // The phone token it registered with, so revoking that token stops its
    // pushes (tokens.ts, devices:targets). Rows from before 5 Nov 2026 only
    // have tokenName and get no pushes (pushTargets.ts).
    tokenId: v.optional(v.id('tokens')),
    updatedAt: v.number(),
    // When this phone wants a push (phone:setNotifications, API 3):
    // "away" (the default) only while Mike isn't at the Mac, "always", or "off".
    notify: v.optional(v.union(v.literal('away'), v.literal('always'), v.literal('off'))),
    // The phone's own key for encrypting what goes through the push relay
    // (API 4): base64 of 32 bytes, made on the phone and sent only here.
    pushKey: v.optional(v.string()),
  })
    .index('by_apnsToken', ['apnsToken'])
    // A token's phones: at most MAX_DEVICES_PER_TOKEN (phone:registerDevice),
    // deleted a batch at a time once it's revoked (tokens.ts dropDevices).
    .index('by_tokenId', ['tokenId', 'updatedAt'])
    // Rows from before tokenId, by name (tokens.ts dropDevices).
    .index('by_tokenName', ['tokenName', 'tokenId']),

  // The pictures of a shared thread (API 8), in file storage, uploaded by
  // the runner while the thread is shared and dropped when it stops
  // (sync:addShareImage, sync:dropShareImages). `path` is the file on the
  // Mac it came from, so the runner sends each once; `src` is set for one
  // the agent wrote into its text as Markdown, the address the page swaps.
  shareImages: defineTable({
    threadId: v.string(),
    seq: v.number(),
    path: v.string(),
    src: v.optional(v.string()),
    storageId: v.id('_storage'),
    mediaType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  })
    .index('by_thread_seq', ['threadId', 'seq'])
    .index('by_storageId', ['storageId']),

  // Pictures an agent showed Mike, for the phone (API 24), from any thread:
  // ones in its replies (`src`, the address it wrote, which the phone swaps)
  // and image files it pinned (`pinned`). In file storage, uploaded by the
  // runner, and gone with the thread (sync:removeThreads). Apart from
  // shareImages, as stopping sharing drops those and readers of a shared
  // page must only ever get what was uploaded for it.
  replyImages: defineTable({
    threadId: v.string(),
    seq: v.number(),
    path: v.string(),
    src: v.optional(v.string()),
    pinned: v.optional(v.boolean()),
    storageId: v.id('_storage'),
    mediaType: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  })
    .index('by_thread_seq', ['threadId', 'seq'])
    .index('by_storageId', ['storageId']),

  // This backend's registration with the push relay (docs/push-relay.md),
  // made the first time a push goes that way. One row.
  relayInstall: defineTable({
    installId: v.string(),
    installKey: v.string(),
    url: v.string(),
    createdAt: v.number(),
  }),

  // Whether pushes are getting through (pushHealth.ts): one row, written
  // by push.ts after each send, read by the owner runner's heartbeat.
  pushHealth: defineTable({
    lastOkAt: v.optional(v.number()),
    failingSince: v.optional(v.number()),
    lastFailAt: v.optional(v.number()),
    failed: v.optional(v.number()),
    lastFailure: v.optional(v.string()),
    via: v.optional(v.union(v.literal('apple'), v.literal('relay'))),
  }),

  // A registration with the push relay in progress (push.ts relayInstall):
  // the nonce sent with it, which the relay posts back to /relay/verify
  // (http.ts) to check the request came from this deployment. Used once,
  // and gone within minutes either way.
  relayChecks: defineTable({
    nonce: v.string(),
    createdAt: v.number(),
  }).index('by_nonce', ['nonce']),
});
