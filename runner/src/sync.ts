// The Convex mirror (docs/convex-backend.md, shape A): the runner stays the
// source of truth and copies the phone's view of each thread, the last few
// text messages, its projects, schedules and accounts, plus its own
// heartbeat, to the Convex project the phone reads; and it applies what
// the phone asks for (the `commands` table) through the same methods the
// Mac app uses. Written on change and coalesced, never per token; best
// effort, so nothing the Mac app does waits on it, and a runner with no
// internet carries on and writes each changed row once when it's back.
//
// Off unless runner.json has a `sync.url` and secrets/convex-key holds the
// key the deployment's RUNNER_KEY was set to (`npx convex env set`).
// THREADBEAR_SYNC=off turns it off whatever runner.json says, which
// check.sh sets so no test runner ever writes to the real project.
import { START_CARD } from './cross-runner.ts';
import { asPushFailing, pushFailingText, type PushFailing } from './push-failing.ts';
import { wakeNote } from './wake-note.ts';
import type { PoolBackend } from './shared-pools.ts';
import type { SharedPool } from './pools.ts';
import type { SharedReading } from './usage.ts';
import { isSealed, type Sealed } from './secrets.ts';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConvexClient } from 'convex/browser';
import { phonePicture } from './project-icons.ts';
import { RunnerStats, type MachineStats } from './runner-stats.ts';
import { imagesInEvent, pastedImagesInEvent, readReplyImage, readShareImage, replyImagesInEvent, type ReplyImage, type ShareImage } from './share-images.ts';
import { extForMediaType, sniffImage } from './media.ts';
import { makeFunctionReference } from 'convex/server';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { agentsStillWorking, ARCHIVE_VERDICTS, ErrorCode, isEffortLevel, remoteCreateModeOf } from './protocol.ts';
import type { Account, ArchiveVerdict, ApprovalDecision, ApprovalOption, AskAnswer, EffortLevel, ImageRef, OpenAsk, PermissionMode, PersistedEvent, Project, Question, ReplyButton, Schedule, ThreadSummary } from './protocol.ts';
import { REMOTE_ALLOW_REFUSED, remoteCardShowsAll, summaryField } from './tools.ts';
import type { Notification } from './runner.ts';
import type { ScheduleBackend, StoredSchedule } from './schedules.ts';
import { followSchedules } from './schedule-follow.ts';
import { ThreadIndex, type RemoteThreads } from './thread-index.ts';
import { digest, dropSyncCache, loadSyncCache, saveSyncCache, SYNC_CACHE_MAX_AGE_MS } from './sync-cache.ts';
import { paths, readRunnerJson, writeRunnerJson } from './config.ts';
import { unplacedPictures } from './pictures.ts';
import { listFolderFor } from './files.ts';
import { Scrubber, type ScrubStatus } from './scrub.ts';
import { scrubEveryString } from './redaction.ts';
import { withholdReason } from './withhold.ts';
import { BodyCollector, prepareBody, type BodyDoc, type RawBody } from './full-sync.ts';
import { cutSafely } from './safe-cut.ts';
import { siteOf } from './convex-admin.ts';
import { credentialUrlProblem } from './secure-url.ts';
// How soon what the backend left out of a closed thread id goes again.
const CLOSED_RETRY_MS = 30_000;
// A `call` for files.list answers with at most this many entries (the backend keeps it a day).
const CALL_ENTRIES = 500;

// At most one write per thread this often while a turn runs: a running
// thread's preview and working line change many times a second.
export const SYNC_COALESCE_MS = 2000;
export const HEARTBEAT_MS = 60_000;
// How often other runners' usage readings are read (followSharedUsage).
export const SHARED_USAGE_POLL_MS = 5 * 60_000;
// Threads per upsert mutation, and messages per append.
export const SYNC_BATCH = 50;
export const MESSAGE_BATCH = 100;
// A message longer than this is cut on the phone; the Mac has it all.
export const MESSAGE_CHARS = 8000;
// Older messages per "Load earlier messages" on the phone.
export const PAGE_SIZE = 50;
// How many events are read back for a page or the first text message.
const PAGE_EVENTS = 2000;
// Events read at a time when backfilling a thread's history.
const BACKFILL_EVENTS = 5000;
// How often presence is checked. A push is decided with whatever the backend
// last heard, so this is how late "away" can be.
export const PRESENCE_MS = 15_000;
// A row whose only change is its preview line or unread dot waits this long
// after the row's last write. On Mike's M5 those were 73% of row changes (110
// and 42 of 208 in 20 minutes on 5 Nov; unread often flips straight back),
// and each write re-runs phone:threads for every open phone and browser
// (about 40 KB). The message itself still arrives at once, and anything that
// needs Mike changes more than these so goes straight away.
export const PREVIEW_HOLD_MS = 20_000;
// How often a project goes up only because its lastActivityAt moved. A turn
// moves it, and a project's row with long notes is tens of KB to read and write.
export const PROJECT_ACTIVITY_MS = 10 * 60_000;
// How often a login's row goes up with a reading copied from another runner.
// One reading used to ripple: each of three runners copied it to its own row,
// three writes and nine re-runs of every runner's sync:sharedUsage (about 70 MB
// a day). The runner that made the reading still writes it at once, which is
// what the others read; a copy on this row is only what a phone shows.
export const USAGE_COPY_MS = 10 * 60_000;
// How long a start with a saved record waits before comparing rows with it. A
// thread's patch links load a moment after the runner starts, so comparing at
// once sees every thread with links as changed (464 of Mike's 716, each start).
export const SETTLE_MS = 20_000;
// How often what's been sent is saved (sync-cache.ts), and on stopping.
const CACHE_SAVE_MS = 30_000;
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60_000;
const POST_TIMEOUT_MS = 15_000;
// How long pictures wait after a runner key's upload allowance said "later".
const PICTURES_PAUSE_MS = 10 * 60_000;
const ALL: ('inbox' | 'snoozed' | 'archived')[] = ['inbox', 'snoozed', 'archived'];

export type SyncConfig = {
  enabled: boolean;
  url?: string;
  site?: string;
  // Why runner.json's (or THREADBEAR_SYNC_URL's) url wasn't used (config.ts):
  // the off reason in place of "no sync.url".
  urlRefused?: string;
  name?: string;
  runnerId?: string;
  icon?: string;
  rpcUrl?: string;
  pastedPictures?: boolean;
  // Full sync (docs/full-convex.md step 4): tool output, input and diffs go up too.
  // Off unless it's asked for; off, nothing here writes eventBodies.
  full?: boolean;
};

// runner.status's `sync` (docs/protocol.md, "Sync").
// The backend API version this runner was built for (convex/version.ts; a unit
// test keeps them equal). sync:heartbeat answers with the backend's, and a
// lower one means its backend hasn't been deployed since this runner was:
// said in runner.status, tb status and the log rather than stopping, since
// the runner only adds to what it sends while the number stays the same.
export const BACKEND_API_VERSION = 60;
// From this one sync:sharedThreads lists a runner's rows shared by link, which
// it checks against its own threads on every start and every
// SHARE_RECONCILE_MS (reconcileShares).
export const SHARED_THREADS_API_VERSION = 60;
// How often the shared rows are checked again while the runner keeps running:
// a stop or a delete the mirror missed doesn't wait for the next start.
export const SHARE_RECONCILE_MS = 60 * 60_000;
// From this one a runner key's archived threads stay in the sidebar table, so
// those an older backend dropped go again, once (thread-index.ts resendArchived).
export const ARCHIVED_INDEX_API_VERSION = 54;
// From this one the main Mac reads and steers other runners' threads through
// the backend (convex/relay.ts): commands can be `interrupt` or `call`, and a
// pending approval carries its event's seq (docs/protocol.md, "Other
// runners' threads through the backend").
export const RELAY_API_VERSION = 44;
// From this one the Mac app's Runners panel can ask for every runner's machine
// figures (runners.stats): sync:watchRunnersFromMac and sync:runnerStatsList,
// on top of the website's runnerStats rows (API 45).
export const MAC_RUNNER_STATS_API_VERSION = 46;
// From this one an owned schedule can carry `poolId`, the pool that picks
// its threads' login. An older backend's validator would turn it down.
export const SCHEDULE_POOLS_API_VERSION = 36;
// From this one an owned schedule can carry `check` (experiment scheduleChecks).
export const SCHEDULE_CHECK_API_VERSION = 51;
// From this one it can carry `checkTimeoutSecs` too.
export const SCHEDULE_CHECK_TIMEOUT_API_VERSION = 55;
// Pools shared between runners: the pools table (shared-pools.ts).
export const SHARED_POOLS_API_VERSION = 38;
// Other runners' usage readings of the same logins (sync:sharedUsage).
export const SHARED_USAGE_API_VERSION = 39;
// From this one the backend scrubs secrets again before storing what a runner
// sends (convex/redaction.ts). A runner scrubs first either way.
// From this one the backend takes tool output (sync:appendBodies) and a `picture`
// command's upload. Older, a runner with sync.full on sends none of it.
export const BODIES_API_VERSION = 52;
// How much goes up in a mutation, and how much can wait for Convex in memory; past
// that the oldest are given up on, and those tools show as kept on the runner.
const BODY_BATCH_ROWS = 50;
const BODY_BATCH_BYTES = 512 * 1024;
const BODY_QUEUE_ROWS = 2000;
const BODY_QUEUE_BYTES = 64 * 1024 * 1024;
// What a start reads to catch up on tools that finished while it was away. A longer
// gap isn't worth reading: forward from there.
const BODY_CATCHUP_EVENTS = 20_000;
// Events looked through to find a tool's result for a tapped picture.
const PICTURE_SCAN_EVENTS = 2000;
export const SCRUB_API_VERSION = 47;
// From this one sync:sharedUsage takes this runner's id and doesn't read its
// rows, so it doesn't re-run for this runner's own writes.
export const SHARED_USAGE_OTHERS_API_VERSION = 48;
// From this one the scheduler follows only the schedules written since it last
// heard (sync:schedulesSince), rather than the whole table on every change.
export const SCHEDULES_FOLLOW_API_VERSION = 48;
export function sharedUsageArgs<K>(key: K, runnerId: string | undefined, backend: number): { key: K; runnerId?: string } {
  // An older backend's validator would turn the extra argument down.
  return runnerId && backend >= SHARED_USAGE_OTHERS_API_VERSION ? { key, runnerId } : { key };
}
// From this one a thread's row carries its open card of asks and a finished
// turn's next steps, and a message row can be `summary` (end_turn's
// bullets), so the phone shows end-of-turn cards. An older backend's
// validators would turn the write down, so it gets them without.
export const ASKS_API_VERSION = 14;
// From this backend version a project's picture goes up to file storage
// (sync:iconUploadUrl, sync:setProjectIcon); an older backend gets the
// project without it and the phone shows its symbol or first letter.
export const ICONS_API_VERSION = 5;
// From this one a thread's row carries `share` ("off" included) and a shared
// thread's pictures go to file storage (docs/website.md, "Sharing"). An
// older backend's validator would turn the whole write down, so it gets
// the row without it, and the link doesn't work until it's deployed.
export const SHARE_API_VERSION = 8;
// From this one schedules live in the backend (step 6; docs/protocol.md,
// Schedules, "Runners"): the scheduler is attached once a heartbeat says
// so, and from then on writes them there itself, so they aren't mirrored.
export const SCHEDULES_API_VERSION = 9;
// From this one the heartbeat carries the runner's icon (machine.ts); an
// older backend's validator would turn the heartbeat down.
export const RUNNER_ICON_API_VERSION = 11;
// From this one there's the sidebar table (thread-index.ts) and the
// heartbeat carries rpcUrl (step 6 part 2).
export const THREAD_INDEX_API_VERSION = 12;
// From this one a thread's row carries `woke` (back from hibernating, not
// opened yet), for the phone's "Woke up". An older backend's validator
// would turn the row down, so it goes without.
export const WOKE_API_VERSION = 13;
// From this one a thread's row carries what the phone's sections need to
// match the Mac's (app ThreadSections): `needs`, `pendingReviews` and
// `waitingForRoom`. An older backend's validator would turn the row down,
// so it goes without them.
export const SECTIONS_API_VERSION = 15;
// From this one a thread's row carries `waitingForNetwork`, so the phone's
// row says Waiting for connection rather than Failed.
export const NETWORK_WAIT_API_VERSION = 34;
// From this one an account's row carries its models (each with its effort
// levels) and its own effort, for the phone's new thread pickers. An older
// backend's validator would turn the list down, so it goes without.
export const MODELS_API_VERSION = 20;

// From this one a thread's row carries `startedBy`, for the phone's byline.
// An older backend's validator would turn the row down, so it goes without.
export const STARTED_BY_API_VERSION = 22;

// From this one a threadIndex row carries `startedBy` too, for the Mac's
// byline on another runner's threads.
export const INDEX_STARTED_BY_API_VERSION = 23;

// From this one the pictures in agents' replies and pinned pictures go to
// file storage for the phone, for every thread (sync:addReplyImage).
export const REPLY_IMAGES_API_VERSION = 24;
// From this one a message row says which turn it's from (`turn`), so the phone
// can tell a turn the CLI started itself, which no message marks, from the one
// before. An older backend's validator would turn the write down.
export const TURNS_API_VERSION = 26;
// From this one thread and threadIndex rows carry `starredAt` and phone:update
// takes `star`. An older backend's validator would turn the row down, so it
// goes without.
export const STARS_API_VERSION = 27;
// From this one a thread's row carries `links`, its patches' url actions, so
// the phone shows them as buttons that open there. An older backend's
// validator would turn the row down, so it goes without.
export const LINKS_API_VERSION = 28;
// The other runners' rows can be watched from where the last answer left off
// (sync:otherRunnersList and sync:threadIndexSince), rather than read whole
// on every change.
export const INDEX_SINCE_API_VERSION = 29;
// sync:runnerOrder and sync:setRunnerOrder, for the Mac's Settings > Runners.
export const RUNNER_ORDER_API_VERSION = 58;
// Only the projects that changed go up (sync:upsertProjects), after the
// whole list once per start.
export const PROJECTS_DIFF_API_VERSION = 30;
// From this one a project's notes go up only when they change (the backend
// keeps them in a row of their own), so a state update doesn't rewrite them.
export const NOTES_APART_API_VERSION = 50;
// Since this API: sync:upsertAccounts, one account's usage moving rewrites
// that account rather than all of them; a heartbeat says firstSeen.
export const ACCOUNTS_DIFF_API_VERSION = 37;
// From this one a thread's row carries `asked`, what Mike last said to it,
// for the phone's row. An older backend's validator would turn the row
// down, so it goes without.
export const ASKED_API_VERSION = 31;
// From this one a thread's row carries `wakeNote` (wake-note.ts), what a
// hibernating thread waits for. An older backend's validator would turn the
// row down, so it goes without.
export const WAKE_NOTE_API_VERSION = 49;
// From this one a threadIndex row carries `asked` too, for the Mac's
// "You: ..." under another runner's threads.
export const INDEX_ASKED_API_VERSION = 32;
// From this one the first message row of a turn the CLI started itself, as
// background work finished, carries `wokeBy`, what finished, for the
// phone's "6 min later · Mine the repo finished" divider. An older
// backend's validator would turn the row down, so it goes without.
export const WOKE_BY_API_VERSION = 33;
// From this one a message row whose text links button:<id> carries those
// buttons' state (docs/protocol.md, "Reply buttons"), sent again when one is
// pressed, and the phone can queue a `press` command. An older backend's
// validator would turn the row down, so it goes without.
export const BUTTONS_API_VERSION = 59;
// From this one a thread row's pendingApproval can be a secret (docs/protocol.md,
// "Secrets"), answered with phone:secret. An older backend's validator would
// turn the whole row down, so it goes without the card.
export const SECRETS_API_VERSION = 35;
// From this one a runner reports its machine's figures while someone's watching
// (runner-stats.ts), and its heartbeat carries `pressure`; an older backend's
// validator would turn the heartbeat down.
export const RUNNER_STATS_API_VERSION = 45;
// How far back a start looks for pictures, as new ones go up as they come.
// Reading a whole log for each thread is too much to do for all of them on
// every start, and it's the threads in use that Mike opens on the phone.
export const REPLY_IMAGES_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
// Logs read per flush, so a start with many threads doesn't hold the runner up.
export const REPLY_IMAGES_SCANS_PER_FLUSH = 3;

export type SyncStatus = {
  state: 'off' | 'ok' | 'error';
  reason?: string; // why it's off
  url?: string;
  site?: string; // the website: sync.site, else the .convex.site twin of url
  runnerId?: string;
  name?: string;
  threads?: number; // rows written since start
  messages?: number; // likewise
  lastSyncAt?: string;
  lastError?: string;
  pending?: number; // changes waiting to be written
  retryAt?: string;
  // Full sync, when it's on: tools' output sent since start, the bytes that took,
  // and what stayed on the runner. withheld: its command or file can hold secrets.
  // unsent: given up on (too big, over a key's budget, or the check failed).
  full?: { bodies: number; bytes: number; withheld: number; unsent: number; pending: number; backendTooOld?: boolean };
  // The phone's commands: whether the runner is listening for them, how
  // many it has applied since start, and the last one that failed.
  commands?: { state: 'off' | 'on' | 'error'; applied: number; failed: number; lastError?: string };
  // The backend's API version from the last heartbeat (0 for a backend from
  // before there was one), and the one this runner expects.
  backend?: { apiVersion: number; expected: number };
  // The backend says RUNNER_KEY_NEXT is still set (the owner key only hears
  // it): a rotation (tb runner rotate-owner) waiting for --finish.
  ownerKeyRotating?: boolean;
  // The backend can't send phone notifications at all (convex/pushHealth.ts
  // pushOff): a self-hosted backend, where the push relay doesn't reach.
  pushOff?: boolean;
  // Schedules a runner key couldn't put in the backend, so all of them stay
  // in this runner's schedules.json (schedules.ts heldLocal; the log says which).
  schedulesHeld?: number;
  // The backend turned this runner's key down ("bad runner key"): a main
  // key rotated out from under it, or a runner key revoked. lastError says
  // what to do.
  keyRejected?: boolean;
  // The backend's pushes to phones haven't got through lately (owner key
  // only; convex/pushHealth.ts): the latest "<status> <reason>", since
  // when, how many, and whether they went to Apple or the push relay.
  pushFailing?: PushFailing;
  // What this runner does about secrets (src/scrub.ts), and whether its
  // backend checks again.
  scrub?: ScrubStatus & { backendChecks?: boolean };
};

// The approval or question a thread is waiting on, as the phone sees it.
export type PendingApproval =
  // seq: the event's (API 44), for the main Mac's transcript of this thread.
  | { approvalId: string; kind: 'approval'; seq?: number; name: string; title: string; options: ApprovalOption[]; inputSummary?: string }
  | { approvalId: string; kind: 'question'; seq?: number; questions: Question[] }
  // docs/protocol.md, "Secrets": key is the runner's public key, which the
  // phone seals its answer to.
  | { approvalId: string; kind: 'secret'; seq?: number; label: string; reason: string; placeholder?: string; key: string };

// The phone's view of a thread: convex/schema.ts's threadFields plus view.
export type ThreadDoc = {
  threadId: string;
  runnerId: string;
  title: string;
  cwd: string;
  accountId: string;
  provider: string;
  model?: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
  preview: string;
  createdAt: string;
  lastActivityAt: string;
  lastActivityMs: number;
  snoozedUntil?: string;
  snoozedUntilRestart?: boolean;
  wakeNote?: string;
  woke?: { at: string; since?: string };
  startedBy?: { kind: string; label: string; icon?: string; why?: string };
  asked?: string;
  archivedAt?: string;
  starredAt?: string;
  costUsd?: number;
  projects?: { id: string; title: string }[];
  working?: string;
  pendingApproval?: PendingApproval;
  earliestSeq?: number;
  share?: { access: 'off' | 'link'; slug: string };
  asks?: PhoneAsk[];
  asksSeq?: number;
  next?: string[];
  needs?: 'you' | 'nothing';
  pendingReviews?: number;
  waitingForRoom?: { until: string; accountId?: string };
  waitingForNetwork?: { since: string };
  links?: { title: string; url: string; icon?: string }[];
  view: 'inbox' | 'hibernating' | 'den';
};

// An open ask as the phone sees it (convex/schema.ts): no `where`, which the
// paragraph already says, and only web links, as a file on the Mac can't
// be opened from the phone.
export type PhoneAsk = { action: string; why?: string; reply?: string; options?: string[]; suggested?: number; links?: { title: string; url: string }[]; ticked?: boolean };

// A text message, or one line for a tool call (role "tool", since backend
// API 2): what the phone and the website show of a thread.
export type WokeByDoc = { kind: string; description: string };
export type MessageDoc = { threadId: string; seq: number; role: 'user' | 'assistant' | 'tool'; text: string; origin?: string; toolKind?: string; summary?: true; turn?: string; wokeBy?: WokeByDoc[]; buttons?: MessageButton[]; at: string; pagedAt?: number };
// A reply button as a message row carries it (API 59): enough to draw it
// and say where it goes, never its brief or message, which stay on the Mac.
// target: the new thread's folder name, or the title of the thread it messages.
export type MessageButton = { id: string; title: string; kind: 'start' | 'send'; target?: string; pressedThreadId?: string; failed?: string };

// The button ids an assistant message links, as [title](button:<id>).
export function linkedButtonIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\]\(button:([a-z0-9]{8})\)/g)) ids.add(m[1]!);
  return [...ids];
}

export function messageButton(b: ReplyButton): MessageButton {
  const target = b.start ? path.basename(b.start.cwd) : b.send?.threadTitle;
  return {
    id: b.id,
    title: b.title,
    kind: b.start ? 'start' : 'send',
    ...(target ? { target } : {}),
    ...(b.pressed ? { pressedThreadId: b.pressed.threadId } : {}),
    ...(b.failed && !b.pressed ? { failed: b.failed.error } : {}),
  };
}

// What woke each turn the CLI started itself (turn.started's wokeBy), held
// until that turn's first message row takes it. Rows are what the phone
// has; turn.started isn't one. A turn that ends with no row lets it go.
export class WokeRows {
  private pending = new Map<string, WokeByDoc[]>();

  see(e: PersistedEvent): void {
    if (e.type === 'turn.started' && e.wokeBy?.length) {
      // A few short lines: a shell's description can be its whole command.
      this.pending.set(e.turnId, e.wokeBy.slice(0, 5).map((t) => ({ kind: t.kind, description: cutSafely(t.description, 200) })));
    } else if (e.type === 'turn.completed') {
      this.pending.delete(e.turnId);
    }
  }

  take(m: MessageDoc, e: PersistedEvent): MessageDoc {
    const by = e.turnId ? this.pending.get(e.turnId) : undefined;
    if (!by) return m;
    this.pending.delete(e.turnId!);
    return { ...m, wokeBy: by };
  }
}

// One call to the deployment's HTTP API; tests pass a fake.
// One runner's figures, as sync:runnerStatsList gives them (runner-stats.ts).
export type RunnerStatsRow = {
  runnerId: string;
  at: string;
  cpuPercent: number;
  cores: number;
  memUsed: number;
  memTotal: number;
  diskFree: number;
  diskTotal: number;
  load1?: number;
  uptimeSec: number;
  machine?: string;
  os?: string;
};
const STATS_WATCH_EVERY_MS = 20_000;
// Rows remembered for the buttons they link, and how far back a press looks
// for one it doesn't remember (a thread keeps its last 200 buttons).
const BUTTON_ROWS = 500;
const BUTTON_SCAN_EVENTS = 5000;

export type Post = (kind: 'mutation' | 'query', fn: string, args: Record<string, unknown>) => Promise<unknown>;

// A live query on the deployment (the commands the phone has queued):
// `onUpdate` is called with each new result, `onError` when the
// subscription fails. Returns the unsubscribe. Tests pass a fake.
export type Subscribe = (fn: string, args: Record<string, unknown>, onUpdate: (value: unknown) => void, onError: (error: Error) => void) => () => void;
export type Subscriber = { subscribe: Subscribe; close(): Promise<void> | void };
// Puts a picture's bytes at the upload URL the backend gave (file storage)
// and returns its storage id. Tests pass a fake.
export type Upload = (url: string, bytes: Uint8Array, mediaType: string) => Promise<string>;
export type Download = (url: string) => Promise<Uint8Array>;
const MAX_PHONE_IMAGE_BYTES = 25 * 1024 * 1024;

// A phone or browser that holds a phone token (docs/protocol.md "Devices"),
// as the backend lists them (convex/tokens.ts tokenInfo).
export const DEVICE_KINDS = ['phone', 'browser'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type Device = { id: string; kind: DeviceKind; name: string; createdAt: string; expiresAt: string; expired: boolean };

// A command the phone queued (convex/schema.ts `commands`).
export type Command = { commandId: string; kind: string; threadId?: string; args: Record<string, unknown>; createdAt: number };

type Host = {
  onNotification(fn: (n: Notification) => void): () => void;
  list(include: ('inbox' | 'snoozed' | 'archived')[]): ThreadSummary[];
  get(threadId: string): ThreadSummary;
  events(threadId: string, opts: { afterSeq?: number; beforeSeq?: number; limit?: number }): { events: PersistedEvent[] };
  // The seq ranges edits cut out of a thread (docs/protocol.md, "Editing a
  // message"), never sent up. Absent in small tests.
  cuts?: (threadId: string) => { from: number; to: number }[];
  // The lists mirrored beside the threads; absent in small tests.
  listProjects?: () => Project[];
  listSchedules?: () => Schedule[];
  listAccounts?: () => Account[];
  // The thread's reply buttons (buttons.list); absent in small tests, and
  // then no row carries any.
  buttons?: (threadId: string) => ReplyButton[];
};

// What the phone's commands are applied through: the runner's own
// methods, so a phone message or approval is the same as one from the
// Mac app (docs/protocol.md, "Sync").
// A thread's commands may go on to a draining runner (handover.ts's
// phoneCommands), so they can answer later; apply() waits for each.
export type CommandHost = {
  // origin: absent for a message Mike sent from the main Mac (a command `from: "mac"`).
  send(threadId: string, text: string, images: ImageRef[], opts: { origin?: 'phone'; answers?: AskAnswer[] }): unknown;
  respondApproval(p: { threadId: string; approvalId: string; decision: ApprovalDecision; message?: string; answers?: Record<string, string>; remote?: boolean }): unknown;
  answerSecret(p: { threadId: string; approvalId: string; secret?: string; decline?: boolean }): unknown;
  update(p: { threadId: string; title?: string; snoozedUntil?: string | null; archived?: boolean; verdict?: ArchiveVerdict; starred?: boolean }): unknown;
  // Seen up to the last event it has.
  markSeen(threadId: string): unknown;
  create(p: { text: string; images?: ImageRef[]; cwd?: string; accountId?: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; origin?: 'phone' }): { thread: ThreadSummary };
  // Stops the thread's turn (a command from the main Mac, API 44).
  interrupt?(threadId: string): unknown;
  share(threadId: string, p: { access: 'off' | 'link'; newLink?: boolean }): unknown;
  quickAsk(p: { question: string; answer: string; sources?: { title: string; url: string }[]; askedAt?: number }): { thread: ThreadSummary };
  // The website's Pause, Resume and Run now (API 45). Absent in small tests.
  schedule?: (p: { scheduleId: string; action: 'pause' | 'resume' | 'run' }) => unknown;
  // A reply button's press from the phone or website (API 59), buttons.press.
  pressButton?: (threadId: string, buttonId: string) => unknown;
};

export type SyncDeps = {
  config: SyncConfig;
  key?: string;
  // Whether Mike is at this Mac (presence.ts), checked every PRESENCE_MS and
  // sent to the backend when it changes, so his phone only buzzes while he's
  // away. Left out, presence isn't sent.
  presence?: () => boolean | Promise<boolean>;
  // Whether the Mac app is connected, so the other runners' threads are
  // watched only while something shows them (thread-index.ts).
  appConnected?: () => boolean;
  // Where the sync keeps what it has sent once and for all (the full history
  // backfill), per deployment. Tests leave it out and get a backfill each start.
  statePath?: string;
  // Where it keeps what the mirror already has between starts (sync-cache.ts).
  // Tests leave it out and get a full write each start.
  cachePath?: string;
  runner: Host;
  commands?: CommandHost;
  // The runner's key pair for secrets the phone answers (secrets.ts).
  // Absent in small tests: then a secret card isn't mirrored.
  secretBox?: { publicKey(): string; open(sealed: Sealed, approvalId: string): string };
  version: string;
  release?: string;
  startedAt: string;
  clock: Clock;
  log: Logger;
  post?: Post;
  subscriber?: Subscriber;
  upload?: Upload;
  download?: Download;
  // The scheduler (schedules.ts), given the backend's schedules table once
  // a heartbeat says it has one; while inBackend(), schedules.updated isn't
  // mirrored. Absent in small tests.
  schedules?: { attach(backend: ScheduleBackend): void | Promise<void>; inBackend(): boolean; heldLocal?(): { id: string; why: string }[] };
  // Follows the shared pools once the backend has them (API 38).
  pools?: { attach(backend: PoolBackend): void };
  // Takes the other runners' readings of the same logins (API 39).
  sharedUsage?: { setShared(rows: SharedReading[]): void };
  // This machine's figures (runner-stats.ts). Absent in tests, which report none.
  sample?: () => Promise<MachineStats>;
  // For the sidebar table (thread-index.ts): telling the app about other
  // runners' threads, and the data dir their tokens are copied into.
  publish?: (n: Notification) => void;
  home?: string;
  // When the backend turns this runner's key down: a notice for the app,
  // the key on disk now (readSyncKey, so a new one from tb runner add is
  // seen), and asking for a restart onto it. Absent in small tests.
  notice?: (level: 'warning' | 'error', message: string) => void;
  readKey?: () => string | undefined;
  restart?: (reason: string) => void;
  // What takes secrets out of everything sent (src/scrub.ts). Left out, the
  // shape rules alone: there's always a scrubber on the way up.
  scrubber?: Scrubber;
  // A thread finishing its turn on the release that handed over to this one
  // (handover.ts, peers.owns): not here yet, but not gone either, so its row
  // isn't taken out of the mirror for being missing; and all of those, for a
  // full write's prune. Absent in small tests.
  elsewhere?: (threadId: string) => boolean;
  elsewhereIds?: () => string[];
};

// How long a row whose thread isn't here (and that wasn't deleted here) waits
// before it's taken out of the mirror: a thread between two releases (a
// draining one whose connection dropped is let go of before its threads are
// taken in) isn't here for a few seconds, and removing its row takes its
// messages with it.
export const MISSING_GRACE_MS = 2 * 60_000;

// What tb status and the app say while the backend turns this runner's
// key down (keyRejected). Every minute's heartbeat is still tried, so it
// clears by itself if the old key comes back.
export const KEY_REJECTED =
  "The Convex backend turned down this runner's key (bad runner key), so nothing here reaches the phone or the other runners. The main key was probably rotated (tb runner rotate-owner) while this runner still had a copy, or its runner key was revoked. On the main Mac, give it its own: tb runner add <name> --ssh <this host> --id <this runner's id> --replace. It restarts onto the new key by itself.";

// "bad runner key" (convex/lib.ts runnerAuth): kind auth, in the error's
// data from a post, or as JSON in a subscription's message.
export function keyRejected(e: unknown): boolean {
  const kind = (e as { data?: { kind?: unknown } } | null)?.data?.kind;
  if (kind === 'auth') return true;
  return /"kind"\s*:\s*"auth"/.test(String((e as Error | null)?.message ?? e ?? ''));
}

// POST /api/mutation or /api/query on a Convex deployment, the plain HTTP
// API, so a write needs no client and a fake is one function.
//
// Every body has the runner key in it, so: only to an https URL, or plain
// http to this Mac (config.ts already turns sync off for any other, this
// is for any caller that didn't go through it), and never a redirect, as
// fetch sends a 307's or 308's body on to wherever it points. Convex's
// /api/mutation and /api/query answer without one.
export function convexPoster(url: string, fetchFn: typeof fetch = fetch): Post {
  const base = url.replace(/\/+$/, '');
  const problem = credentialUrlProblem(base);
  return async (kind, fn, args) => {
    if (problem) throw new Error(`The sync URL ${problem}.`);
    const res = await fetchFn(`${base}/api/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fn, args, format: 'json' }),
      redirect: 'error',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => undefined)) as { status?: string; value?: unknown; errorMessage?: string; errorData?: unknown } | undefined;
    if (!res.ok || !body || body.status !== 'success') {
      // A ConvexError's data (`{ kind, message }`), as the Convex client
      // keeps it, so forbiddenText can tell a runner key's refusal.
      throw Object.assign(new Error(body?.errorMessage ?? `HTTP ${res.status}`), body?.errorData !== undefined ? { data: body.errorData } : {});
    }
    return body.value;
  };
}

// A refusal that trying again won't change (convex/sync.ts caps and
// ownership checks), as opposed to an outage.
export function refusedForGood(e: unknown): boolean {
  const kind = (e as { data?: { kind?: unknown } } | null)?.data?.kind;
  if (kind === 'badArgs' || kind === 'tooMany' || kind === 'forbidden') return true;
  return /"kind"\s*:\s*"(badArgs|tooMany|forbidden)"/.test(String((e as Error | null)?.message ?? ''));
}

// A refusal for now (a runner key's upload allowance, or too many upload
// URLs this hour): the item waits and goes again later.
export function retryLater(e: unknown): boolean {
  const kind = (e as { data?: { kind?: unknown } } | null)?.data?.kind;
  if (kind === 'retryLater' || kind === 'rateLimited') return true;
  return /"kind"\s*:\s*"(retryLater|rateLimited)"/.test(String((e as Error | null)?.message ?? ''));
}

// What the backend said when this runner's key isn't allowed something
// (a runner key reaching past its own runner, docs/protocol.md "Runner
// keys"), or undefined for any other error. The feature that asked turns
// itself off and says this once, rather than trying again.
export function forbiddenText(e: unknown): string | undefined {
  const data = (e as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && (data as { kind?: unknown }).kind === 'forbidden') {
    const m = (data as { message?: unknown }).message;
    return typeof m === 'string' ? m : "This runner's key can't do that.";
  }
  // A subscription's error may only have the data as JSON in its message.
  const text = String((e as Error | null)?.message ?? e ?? '');
  const json = text.match(/\{[^{}]*"kind"\s*:\s*"forbidden"[^{}]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const m = (JSON.parse(json) as { message?: unknown }).message;
    return typeof m === 'string' ? m : "This runner's key can't do that.";
  } catch {
    return "This runner's key can't do that.";
  }
}

// File storage's upload URL takes a plain POST of the bytes and answers
// `{ storageId }`. The URL is the backend's, a one-use ticket with no key
// in it, but the bytes are a thread's pictures: the same rule as the
// poster's, https or this Mac, and no redirects.
export function convexUploader(fetchFn: typeof fetch = fetch): Upload {
  return async (url, bytes, mediaType) => {
    const problem = credentialUrlProblem(url);
    if (problem) throw new Error(`The upload URL ${problem}.`);
    const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': mediaType }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    const body = (await res.json().catch(() => undefined)) as { storageId?: unknown } | undefined;
    // The upload route refusing (403: a used or dead ticket, or over the
    // allowance; 413: too big) won't change on a retry: said as a refusal
    // for good, so that picture is left out rather than the flush retried.
    if (res.status === 403 || res.status === 413) throw Object.assign(new Error(`upload refused: HTTP ${res.status}`), { data: { kind: 'tooMany', message: `upload refused: HTTP ${res.status}` } });
    // 429: over an allowance for now (convex/http.ts): kept, and tried again later.
    if (res.status === 429) throw Object.assign(new Error('upload over the allowance for now'), { data: { kind: 'retryLater', message: 'upload over the allowance for now' } });
    if (!res.ok || typeof body?.storageId !== 'string') throw new Error(`icon upload failed: HTTP ${res.status}`);
    return body.storageId;
  };
}

// A photo the phone sent, from file storage. Capped so a bad upload can't
// fill the disk: the phone sends JPEGs of a few MB at most.
export function convexDownloader(fetchFn: typeof fetch = fetch): Download {
  return async (url) => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_PHONE_IMAGE_BYTES) throw new Error('too big');
    return bytes;
  };
}

// The Convex client's WebSocket subscription, for the phone's commands:
// it reconnects by itself and re-runs the query whenever a row changes.
export function convexSubscriber(url: string): Subscriber {
  let client: ConvexClient | undefined;
  return {
    subscribe: (fn, args, onUpdate, onError) => {
      client ??= new ConvexClient(url, { unsavedChangesWarning: false });
      return client.onUpdate(makeFunctionReference<'query'>(fn), args, onUpdate, onError);
    },
    close: async () => {
      const c = client;
      client = undefined;
      await c?.close();
    },
  };
}

// The id this runner writes under, made once and kept in runner.json so
// it survives restarts and releases (a data dir is one runner).
export function ensureRunnerId(home: string): string {
  const json = readRunnerJson(home);
  if (json.sync?.runnerId) return json.sync.runnerId;
  const id = crypto.randomBytes(6).toString('hex');
  writeRunnerJson(home, { ...json, sync: { ...json.sync, runnerId: id } });
  return id;
}

export function readSyncKey(home: string): string | undefined {
  try {
    const key = fs.readFileSync(path.join(paths.secrets(home), 'convex-key'), 'utf8').trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

// "M5" from "M5.local" or "m5.localdomain", unless runner.json names the
// runner.
export function defaultRunnerName(hostname = os.hostname()): string {
  return hostname.replace(/\.(local|localdomain|lan|home)$/i, '') || 'runner';
}

// Which of the phone's lists a thread's in. A starred one that's hibernating
// stays in the inbox list: the phone has Starred at the top of its inbox, and
// doesn't load Hibernating at all while that's folded.
function threadView(t: Pick<ThreadSummary, 'archivedAt' | 'snoozedUntil' | 'starredAt'>, now: number): ThreadDoc['view'] {
  if (t.archivedAt) return 'den';
  if (t.starredAt) return 'inbox';
  return t.snoozedUntil && Date.parse(t.snoozedUntil) > now ? 'hibernating' : 'inbox';
}

// `scrub`: the sync's scrubber, for what's made here from longer text and cut
// (the wake note), which is scrubbed whole before it's cut.
export function toThreadDoc(t: ThreadSummary, runnerId: string, now: number, pending?: PendingApproval, earliestSeq?: number, next?: string[], scrub?: (text: string) => string): ThreadDoc {
  const doc: ThreadDoc = {
    threadId: t.id,
    runnerId,
    title: t.title,
    cwd: t.cwd,
    accountId: t.accountId,
    provider: t.provider,
    status: t.status,
    needsYou: t.needsYou,
    unread: t.lastSeq > t.lastSeenSeq,
    preview: t.preview,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    lastActivityMs: Date.parse(t.lastActivityAt) || 0,
    view: threadView(t, now),
  };
  if (t.model) doc.model = t.model;
  if (t.snoozedUntil) doc.snoozedUntil = t.snoozedUntil;
  if (t.snoozedUntilRestart) doc.snoozedUntilRestart = true;
  // What it waits for, when it's more than a time (wake-note.ts): the row says it.
  const note = wakeNote(t, scrub);
  if (note) doc.wakeNote = note;
  if (t.woke) doc.woke = { ...t.woke };
  // Not the thread it came from: the phone's row has no tooltip to name it.
  if (t.startedBy) doc.startedBy = { kind: t.startedBy.kind, label: t.startedBy.label, ...(t.startedBy.icon ? { icon: t.startedBy.icon } : {}), ...(t.startedBy.why ? { why: t.startedBy.why } : {}) };
  if (t.asked) doc.asked = t.asked;
  if (t.archivedAt) doc.archivedAt = t.archivedAt;
  if (t.starredAt) doc.starredAt = t.starredAt;
  // To the cent: a running thread's cost moves every turn and the phone
  // doesn't need a write for the fourth decimal.
  if (t.costUsd !== undefined) doc.costUsd = Math.round(t.costUsd * 100) / 100;
  if (t.projects?.length) doc.projects = t.projects.map((p) => ({ id: p.id, title: p.title }));
  const working = t.background?.find((b) => !b.finished)?.description;
  if (working) doc.working = working;
  if (pending) doc.pendingApproval = pending;
  if (earliestSeq !== undefined) doc.earliestSeq = earliestSeq;
  // "off" goes up too, so Mike's own page for the link can offer Share again.
  if (t.share) doc.share = { access: t.share.access, slug: t.share.slug };
  if (t.asks?.length && t.asksSeq !== undefined) {
    doc.asks = t.asks.map(toPhoneAsk);
    doc.asksSeq = t.asksSeq;
  }
  if (next?.length) doc.next = next;
  // The phone files a thread whose turn said "you" in the inbox whatever's
  // running, and its working line can't tell a sub-agent from a shell job. So
  // it isn't told until the agents are done, which goes for phones already
  // out there too. The asks still go up: the card shows if he opens the thread.
  if (t.needs && !(t.needs === 'you' && agentsStillWorking(t.background))) doc.needs = t.needs;
  if (t.pendingReviews) doc.pendingReviews = t.pendingReviews;
  if (t.waitingForRoom) doc.waitingForRoom = { until: t.waitingForRoom.until, ...(t.waitingForRoom.accountId ? { accountId: t.waitingForRoom.accountId } : {}) };
  if (t.waitingForNetwork) doc.waitingForNetwork = { since: t.waitingForNetwork.since };
  // The patches' link buttons (url actions, already past their `when`), so
  // the phone can open them itself. Command and prompt chips stay on the Mac.
  // Only the SF Symbol goes: a picture icon is a file on the Mac.
  const links = (t.actions ?? []).filter((a) => a.kind === 'url' && a.url && /^https?:\/\//i.test(a.url));
  if (links.length) doc.links = links.map((a) => ({ title: a.title, url: a.url!, ...(a.icon ? { icon: a.icon } : {}) }));
  return doc;
}

// A row's digest without what's held back (PREVIEW_HOLD_MS).
function steadyDigest(row: ThreadDoc): string {
  const { preview: _preview, unread: _unread, ...rest } = row;
  return digest(JSON.stringify(rest));
}

export function toPhoneAsk(a: OpenAsk): PhoneAsk {
  const out: PhoneAsk = { action: a.action };
  if (a.why) out.why = a.why;
  if (a.reply) out.reply = a.reply;
  if (a.options?.length) {
    out.options = a.options;
    if (a.suggested !== undefined) out.suggested = a.suggested;
  }
  const links = a.links?.filter((l) => /^https?:\/\//i.test(l.url));
  if (links?.length) out.links = links.map((l) => ({ title: l.title, url: l.url }));
  if (a.ticked) out.ticked = true;
  return out;
}

// A phone send's `answers`, kept only when well formed.
// A send or create's words, which can be empty when it carries photos.
function commandText(a: Record<string, unknown>): string {
  const text = typeof a.text === 'string' ? a.text : '';
  if (!text.trim() && !(Array.isArray(a.images) && a.images.length)) throw new Error('nothing to send');
  return text;
}

function phoneAnswers(raw: unknown): AskAnswer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((x): x is AskAnswer => !!x && typeof x.action === 'string' && typeof x.answer === 'string').map((x) => ({ action: x.action, answer: x.answer }));
  return out.length ? out : undefined;
}

// The row as a backend of version v takes it: without the fields its
// validator doesn't know yet.
export function forBackend(d: ThreadDoc, v: number, now: number): ThreadDoc {
  const asks = d.asks !== undefined || d.asksSeq !== undefined || d.next !== undefined;
  const sections = d.needs !== undefined || d.pendingReviews !== undefined || d.waitingForRoom !== undefined;
  if ((v >= SHARE_API_VERSION || !d.share) && (v >= WOKE_API_VERSION || !d.woke) && (v >= ASKS_API_VERSION || !asks) && (v >= SECTIONS_API_VERSION || !sections) && (v >= STARTED_BY_API_VERSION || !d.startedBy) && (v >= STARS_API_VERSION || !d.starredAt) && (v >= LINKS_API_VERSION || !d.links) && (v >= ASKED_API_VERSION || !d.asked) && (v >= WAKE_NOTE_API_VERSION || !d.wakeNote) && (v >= NETWORK_WAIT_API_VERSION || !d.waitingForNetwork) && (v >= SECRETS_API_VERSION || d.pendingApproval?.kind !== 'secret') && (v >= RELAY_API_VERSION || d.pendingApproval?.seq === undefined)) return d;
  const out = { ...d };
  if (v < SECTIONS_API_VERSION) {
    delete out.needs;
    delete out.pendingReviews;
    delete out.waitingForRoom;
  }
  if (v < SHARE_API_VERSION) delete out.share;
  if (v < NETWORK_WAIT_API_VERSION) delete out.waitingForNetwork;
  if (v < SECRETS_API_VERSION && out.pendingApproval?.kind === 'secret') delete out.pendingApproval;
  if (v < RELAY_API_VERSION && out.pendingApproval?.seq !== undefined) {
    const { seq: _seq, ...rest } = out.pendingApproval;
    out.pendingApproval = rest as PendingApproval;
  }
  if (v < WOKE_API_VERSION) delete out.woke;
  if (v < STARTED_BY_API_VERSION) delete out.startedBy;
  if (v < LINKS_API_VERSION) delete out.links;
  if (v < ASKED_API_VERSION) delete out.asked;
  if (v < WAKE_NOTE_API_VERSION) delete out.wakeNote;
  if (v < STARS_API_VERSION && out.starredAt) {
    // That backend's phones have no Starred section to show it in.
    delete out.starredAt;
    out.view = threadView(out, now);
  }
  if (v < ASKS_API_VERSION) {
    delete out.asks;
    delete out.asksSeq;
    delete out.next;
  }
  return out;
}

// A body's size in memory and on the way, near enough.
function rawChars(b: RawBody): number {
  return (b.text?.length ?? 0) + (b.reasoning?.length ?? 0) + (b.input ? JSON.stringify(b.input).length : 0) + (b.diffs ? JSON.stringify(b.diffs).length : 0);
}

// A persisted user.message or assistant.text as a message row; anything
// else is undefined.
// Scrubbed before it's cut, the one place a value could be split in two and
// each half missed; everything is scrubbed again on the way up (this.post).
export function toMessageDoc(threadId: string, e: PersistedEvent, scrub: (text: string) => string = (t) => t): MessageDoc | undefined {
  // The start of the id tells a thread's turns apart, in a row sent for every
  // message.
  const turn = e.turnId ? { turn: e.turnId.slice(0, 8) } : {};
  if (e.type === 'tool.call') return { threadId, seq: e.seq, role: 'tool', text: toolLine(e, scrub), toolKind: e.kind, ...turn, at: e.ts };
  if (e.type !== 'user.message' && e.type !== 'assistant.text') return undefined;
  const clean = scrub(e.text);
  const cut = clean.length > MESSAGE_CHARS ? clean.slice(0, MESSAGE_CHARS) + '\n\n[cut: the rest is on the Mac]' : clean;
  // Mike's own pictures stay on the Mac, so the phone and website get a line saying
  // there were some; a photo sent with no words would be an empty bubble.
  // One a [Picture N] marker places shows as a chip there instead, so the
  // line counts only the rest (docs/protocol.md, "Pictures in a message").
  const pictures = e.type === 'user.message' ? unplacedPictures(e.text, e.images?.length ?? 0) : 0;
  const note = pictures === 1 ? '[1 picture]' : pictures ? `[${pictures} pictures]` : '';
  const text = note ? (cut ? `${cut}\n\n${note}` : note) : cut;
  const doc: MessageDoc = { threadId, seq: e.seq, role: e.type === 'user.message' ? 'user' : 'assistant', text, ...turn, at: e.ts };
  if (e.type === 'user.message' && e.origin) doc.origin = e.origin;
  if (e.type === 'assistant.text' && e.summary) doc.summary = true;
  return doc;
}

// A tool call in one line, for the phone and the website (the output stays
// on the Mac): the agent's own description of a command when it gave one
// ("Run the full check suite"), what was read, edited or searched, else the
// call's title. Never the whole input.
export function toolLine(e: { name: string; kind: string; title: string; input: Record<string, unknown> }, scrub: (text: string) => string = (t) => t): string {
  const oneLine = (text: string) => shortLine(scrub(text));
  const str = (k: string) => (typeof e.input[k] === 'string' && (e.input[k] as string).trim() ? oneLine(e.input[k] as string) : undefined);
  const file = str('file_path') ?? str('path') ?? str('notebook_path');
  const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
  switch (e.kind) {
    case 'command':
      return str('description') ?? `Ran ${oneLine(e.title || str('command') || e.name)}`;
    case 'read':
      return file ? `Read ${short(file)}` : oneLine(e.title || e.name);
    case 'edit':
      return file ? `Edited ${short(file)}` : oneLine(e.title || e.name);
    case 'write':
      return file ? `Wrote ${short(file)}` : oneLine(e.title || e.name);
    case 'search':
      return str('pattern') ? `Searched for ${str('pattern')}` : oneLine(e.title || e.name);
    case 'web':
      return str('url') ? `Fetched ${str('url')}` : str('query') ? `Searched the web for ${str('query')}` : oneLine(e.title || e.name);
    case 'task':
      return str('description') ?? oneLine(e.title || e.name);
    default:
      return oneLine(e.title || e.name);
  }
}

// One line of a tool's input for the approval card: the command, the
// path, or the first short string in it. Never the whole input.
export function inputSummary(input: Record<string, unknown>, scrub: (text: string) => string = (t) => t): string | undefined {
  const v = summaryField(input);
  return v === undefined ? undefined : shortLine(scrub(v));
}

function shortLine(s: string): string {
  const line = s.trim().split('\n')[0]!.trim();
  return line.length > 200 ? line.slice(0, 199) + '…' : line;
}

export function toProjectDoc(p: Project) {
  return {
    id: p.id,
    title: p.title,
    folders: p.folders,
    goals: p.goals,
    state: p.state,
    notes: p.notes,
    createdBy: p.createdBy,
    archived: Boolean(p.archived),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    threadCount: p.threadCount,
    ...(p.lastActivityAt ? { lastActivityAt: p.lastActivityAt } : {}),
    ...(p.icon ? { icon: { ...(p.icon.symbol ? { symbol: p.icon.symbol } : {}), ...(p.icon.image ? { picture: pictureName(p.icon.image.path) } : {}), by: p.icon.by } } : {}),
  };
}

// What a project's picture is called in the mirror: the runner's copy's
// file name without its extension (`<projectId>-<hash>`), so a changed
// picture is a new name and the same one is never sent twice.
export function pictureName(iconPath: string): string {
  const base = path.basename(iconPath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function toScheduleDoc(s: Schedule) {
  const out: Record<string, unknown> = {
    id: s.id,
    title: s.title,
    text: s.text,
    whenText: s.whenText,
    paused: s.paused,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    runs: s.runs,
  };
  for (const k of ['at', 'cron', 'timezone', 'threadId', 'cwd', 'accountId', 'model', 'nextRunAt', 'finishedAt'] as const) if (s[k] !== undefined) out[k] = s[k];
  if (s.lastRun) {
    out.lastRun = { at: s.lastRun.at, outcome: s.lastRun.outcome, ...(s.lastRun.threadId ? { threadId: s.lastRun.threadId } : {}), ...(s.lastRun.note ? { note: s.lastRun.note } : {}) };
  }
  return out;
}

// A schedule as sync:saveSchedule and sync:adoptSchedules take it: the
// validator's fields only.
export function toOwnedScheduleDoc(s: StoredSchedule, apiVersion = BACKEND_API_VERSION) {
  const out: Record<string, unknown> = {
    id: s.id,
    runnerId: s.runnerId,
    title: s.title,
    text: s.text,
    whenText: s.whenText,
    paused: s.paused,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    runs: s.runs,
  };
  for (const k of ['at', 'cron', 'timezone', 'threadId', 'cwd', 'accountId', 'model', 'effort', 'permissionMode', 'createdBy', 'nextRunAt', 'finishedAt', 'runRequestedAt'] as const) {
    if (s[k] !== undefined) out[k] = s[k];
  }
  // An older backend's validator would turn the whole schedule down.
  if (s.poolId !== undefined && apiVersion >= SCHEDULE_POOLS_API_VERSION) out.poolId = s.poolId;
  if (s.check !== undefined && apiVersion >= SCHEDULE_CHECK_API_VERSION) out.check = s.check;
  if (s.checkTimeoutSecs !== undefined && apiVersion >= SCHEDULE_CHECK_TIMEOUT_API_VERSION) out.checkTimeoutSecs = s.checkTimeoutSecs;
  if (s.lastRun) {
    out.lastRun = { at: s.lastRun.at, outcome: s.lastRun.outcome, ...(s.lastRun.threadId ? { threadId: s.lastRun.threadId } : {}), ...(s.lastRun.note ? { note: s.lastRun.note } : {}) };
  }
  return out;
}

export function toAccountDoc(a: Account, apiVersion = 0) {
  const out: Record<string, unknown> = { id: a.id, provider: a.provider, title: a.title };
  for (const k of ['note', 'email', 'plan', 'defaultModel'] as const) if (a[k] !== undefined) out[k] = a[k];
  if (apiVersion >= MODELS_API_VERSION) {
    // Just what a picker shows and sends: no descriptions or full ids.
    if (a.models) out.models = a.models.map((m) => ({ id: m.id, title: m.title, ...(m.effortLevels ? { effortLevels: m.effortLevels } : {}), ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}) }));
    if (a.defaultEffort) out.defaultEffort = a.defaultEffort;
  }
  if (a.usage) {
    const u = a.usage;
    out.usage = {
      windows: u.windows.map((w) => ({ kind: w.kind, title: w.title, remainingPercent: w.remainingPercent, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(w.detail ? { detail: w.detail } : {}) })),
      readAt: u.readAt,
      source: u.source,
      ...(u.stale ? { stale: true } : {}),
      ...(u.blocked ? { blocked: true } : {}),
      ...(u.notice ? { notice: u.notice } : {}),
    };
  }
  return out;
}

type ListName = 'projects' | 'schedules' | 'accounts';

export type PocketCardInput = { title: string; text: string; place?: string; icon?: string; threadId?: string; source?: string };
// filedBy: another Mac filed it through its runner key (its name); its text
// is that Mac's, to read, never to follow.
// A request for a thread on another runner (convex/relay.ts fileRequest).
export type RunnerRequestInput = { text: string; title?: string; cwd?: string; model?: string; effort?: string; permissionMode?: string; why?: string };
export type RunnerRequestRow = RunnerRequestInput & {
  docId: string;
  requestId: string;
  runnerId: string;
  runnerName: string;
  threadId: string;
  target: string;
  createdAt: number;
  state: 'pending' | 'claimed' | 'allowed' | 'denied' | 'closed';
  result?: { runnerId: string; runnerName: string; threadId: string };
  decidedAt?: number;
};
export type PocketCardSummary = { title: string; text: string; place?: string; icon?: string; threadId?: string; source?: string; updatedAt: string; filedBy?: string };

export class ConvexSync {
  private deps: SyncDeps;
  private post: Post;
  private upload: Upload;
  private subscriber?: Subscriber;
  private runnerId: string;
  private name: string;
  private off?: string; // why it isn't running
  private running = false;
  private unsub?: () => void;
  private dirty = new Map<string, ThreadDoc>();
  private removed = new Set<string>();
  private sent = new Map<string, string>(); // threadId -> digest of the doc last written
  // Rows whose only change is the preview or unread, until PREVIEW_HOLD_MS after the
  // row's last write; lastWrite says when that was and what the rest was.
  private held = new Map<string, { doc: ThreadDoc; due: number }>();
  private lastWrite = new Map<string, { at: number; steady: string }>();
  private heldTimer?: TimerHandle;
  // The newest message seq written per thread, so a start needn't ask.
  private heads = new Map<string, number>();
  private catchUpDue = false;
  // Removals on their way (flush took them from `removed`), for saving, and
  // ones from the file, which a thread turning up here after all cancels.
  private removing = new Set<string>();
  private removedFromFile = new Set<string>();
  private fullAt = 0;
  private cacheTimer?: TimerHandle;
  private cacheChanged = false;
  private backendHeard = false;
  private settling = false;
  private settleTimer?: TimerHandle;
  // Rows on their way, by digest: a row marked meanwhile is compared with what
  // it's about to be, not what it was. Otherwise X, then back to what `sent`
  // has while X is on its way, looks like nothing to do and leaves X there.
  // Each says which write it's for, and a write takes out only its own: a
  // flush that failed after letting go of the row writer (rowTurn) used to
  // clear them all, a share link writeRowNow had on its way among them, and
  // Stop sharing straight after looked like nothing new, so the link stayed
  // public (Daybreak, 6 Nov).
  private writing = new Map<string, { digest: string; by: symbol }>();
  private seeded = false;
  // The mirror's shared rows are checked against this runner's threads
  // (reconcileShares) on every start, cached or not, and every
  // SHARE_RECONCILE_MS: a stop or a delete it never got (written while sync
  // was off, or lost to a crash between the write landing and it being
  // remembered) leaves a link anyone with the slug can still read.
  private sharesDue = true;
  private sharesCheckedAt = -Infinity;
  // Rows whose thread isn't here, since when (dropRow), until MISSING_GRACE_MS says it's gone.
  private missing = new Map<string, number>();
  private missingTimer?: TimerHandle;
  private messages: MessageDoc[] = [];
  private woke = new WokeRows();
  // "<threadId> <buttonId>" -> the row that links it, as last sent, so a press
  // sends that row again with the new state (onButton). Newest kept.
  private buttonRows = new Map<string, MessageDoc>();
  private pending = new Map<string, PendingApproval>(); // threadId -> what it waits on
  // The row has room for one card, the newest. Subagents' can be open
  // together and for a long time, so the rest wait here for it to close.
  private cardsBehind = new Map<string, PendingApproval[]>();
  private earliest = new Map<string, number | null>(); // threadId -> seq of its first text message (null: none yet)
  private nexts = new Map<string, { lastSeq: number; next?: string[] }>(); // threadId -> its done card's next steps, as of lastSeq
  private lists: { projects?: Project[]; schedules?: Schedule[]; accounts?: Account[] } = {};
  private dirtyLists = new Set<ListName>();
  // Each project as the backend has it, id -> digest of its doc without
  // lastActivityAt or notes, that lastActivityAt, and a digest of its notes,
  // once the whole list has gone up (API 30). Undefined until then. An entry
  // cached before notes had their own digest has two, so its notes go once.
  private projectsSent?: Map<string, [string, string, string?]>;
  private projectActivityAt = -Infinity;
  private projectsTimer?: TimerHandle;
  // Each account as the backend has it, id -> digest without usage.readAt.
  private accountsSent?: Map<string, string>;
  private accountCopiedAt = new Map<string, number>();
  // Logins with a copied reading waiting. Its own reading after that goes even
  // if it matches what's up: otherwise the row's old time says the copy's newer.
  private accountCopyHeld = new Set<string>();
  private accountsTimer?: TimerHandle;
  // Project pictures (ICONS_API_VERSION): what the mirror has, projectId ->
  // picture name, read from it once; and whether the list has changed since
  // the pictures were last looked at.
  private pictures?: Map<string, string>;
  private picturesDue = true;
  // Shared threads' pictures (SHARE_API_VERSION): which threads are shared
  // as last marked; ones just shared, whose whole history is looked through;
  // ones no longer shared, whose pictures the mirror drops; pictures waiting
  // to go up; and what's up already, per thread, as "seq path".
  private sharedNow = new Map<string, boolean>();
  private imagesDue = new Set<string>();
  private imagesDrop = new Set<string>();
  private pendingImages: (ShareImage & { threadId: string })[] = [];
  private imagesUp = new Map<string, Set<string>>();
  // Reply pictures (REPLY_IMAGES_API_VERSION), for the phone: threads whose
  // log has been looked through since this runner started, ones waiting to
  // be, pictures waiting to go up, and what's up already per thread as
  // "seq path", read from the mirror the first time a thread needs it.
  private replyScanned = new Set<string>();
  private replyDue = new Set<string>();
  private pendingReplyImages: (ReplyImage & { threadId: string })[] = [];
  private replyUp = new Map<string, Set<string>>();
  private flushTimer?: TimerHandle;
  private heartbeatTimer?: TimerHandle;
  private stats?: RunnerStats;
  private presenceTimer?: TimerHandle;
  private sentAtMac?: boolean;
  private backendApiVersion?: number;
  private lastFlushAt = -Infinity;
  private flushing = false;
  // Threads rows are written one writer at a time (rowTurn): a flush's
  // batches, taken before a change, landing after writeRowNow had written
  // it, or two writeRowNows crossing, left the older row in Convex: a
  // stopped share's link public again.
  private rowQueue: Promise<void> = Promise.resolve();
  private full = true; // the first write after start covers everything, then prunes and backfills
  private backoffMs = 0;
  private retryAt?: number;
  private lastError?: string;
  private lastLogged?: string;
  private lastSyncAt?: number;
  private written = 0;
  private messagesWritten = 0;
  // Commands.
  private unsubCommands?: () => void;
  private inFlight = new Set<string>();
  private applied = 0;
  private failed = 0;
  private commandError?: string;
  private commandsState: 'off' | 'on' | 'error' = 'off';
  private index?: ThreadIndex;
  private heartbeatRefused?: string;
  private keyRejected = false;
  private restartAsked = false;
  private picturesPausedUntil?: number;
  private ownerKeyRotating = false;
  private pushOff = false;
  private pushFailing: PushFailing | undefined;
  private schedulesRefused = false;
  private scrubber: Scrubber;
  // Tool calls on a file of secrets that haven't finished.
  private secretCalls = new Map<string, string>();
  // Full sync: following events into bodies, and those waiting to go up.
  private bodyCollector = new BodyCollector();
  private bodies: RawBody[] = [];
  private bodyStats = { bodies: 0, bytes: 0, withheld: 0, unsent: 0 };
  private bodyQueueChars = 0;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.runnerId = deps.config.runnerId ?? 'runner';
    this.name = deps.config.name ?? defaultRunnerName();
    const { enabled, url } = deps.config;
    if (!enabled) this.off = 'sync.enabled is false';
    else if (!url) this.off = deps.config.urlRefused ?? 'no sync.url in runner.json';
    else if (!deps.key) this.off = 'no secrets/convex-key';
    this.scrubber = deps.scrubber ?? new Scrubber({ env: {}, folders: false });
    // The one way up: every mutation, the sidebar table's and the scheduler's
    // included, goes through here, so no field can be forgotten. Digests of what
    // was sent are of the row before this, so a rule or a value changing never
    // makes a row look new, and a start doesn't write everything again.
    const send = deps.post ?? (url ? convexPoster(url) : async () => undefined);
    this.post = async (kind, fn, args) => {
      if (kind !== 'mutation') return send(kind, fn, args);
      // A command for another runner, like one from the phone: that runner has
      // to get the words as typed, or an agent is handed "[REDACTED]" where the
      // user gave it a password. finishCommand scrubs the stored copy when it's done.
      if (fn === 'relay:queueCommand') return send(kind, fn, args);
      // Still reading .env files after this long: text waits and the flush tries
      // again, rather than go up missing values that would have been masked.
      // A heartbeat has no thread's words in it, and says the runner's alive.
      if (fn !== 'sync:heartbeat' && !(await this.scrubber.known.settled())) throw new Error('still reading what to take out of text before sending it');
      // Tool output: scrubbed and cut in one go, a body at a time. A check that
      // fails holds that body back whole, and input and diffs stay JSON.
      if (fn === 'sync:appendBodies') {
        const { bodies, ...rest } = args as { bodies: RawBody[] };
        return send(kind, fn, { ...rest, bodies: bodies.map((b) => this.safeBody(b)) });
      }
      // A call's answer is JSON text: scrub what it says, not the text, which a
      // match could leave unparseable. The backend does the same.
      if (fn === 'sync:finishCommand' && typeof args.result === 'string') {
        const { result, ...rest } = args;
        let safe: string | undefined;
        try {
          safe = JSON.stringify(scrubEveryString(JSON.parse(result as string), this.scrubber.safeText));
        } catch {
          safe = undefined;
        }
        return send(kind, fn, { ...this.scrubber.doc(rest), ...(safe !== undefined ? { result: safe } : {}) });
      }
      return send(kind, fn, this.scrubber.doc(args));
    };
    this.upload = deps.upload ?? convexUploader();
    if (!this.off) this.subscriber = deps.subscriber ?? (url ? convexSubscriber(url) : undefined);
    if (!this.off && deps.home) {
      const subscriber = this.subscriber;
      this.index = new ThreadIndex({
        post: (kind, fn, args) => this.post(kind, fn, args),
        subscribe: subscriber ? (fn, args, onUpdate, onError) => subscriber.subscribe(fn, args, onUpdate, onError) : undefined,
        key: deps.key,
        runnerId: this.runnerId,
        home: deps.home,
        host: deps.runner,
        publish: deps.publish,
        clock: deps.clock,
        log: deps.log,
        takesStartedBy: () => (this.backendApiVersion ?? 0) >= INDEX_STARTED_BY_API_VERSION,
        takesStars: () => (this.backendApiVersion ?? 0) >= STARS_API_VERSION,
        takesAsked: () => (this.backendApiVersion ?? 0) >= INDEX_ASKED_API_VERSION,
        takesSince: () => (this.backendApiVersion ?? 0) >= INDEX_SINCE_API_VERSION,
        takesOrder: () => (this.backendApiVersion ?? 0) >= RUNNER_ORDER_API_VERSION,
        seed: () => {
          const file = deps.cachePath;
          const url = deps.config.url;
          // Not after forgetSent: the file says what this deployment doesn't have.
          if (!file || !url || !this.seeded) return undefined;
          const at = loadSyncCache(file, { url, runnerId: this.runnerId, now: deps.clock.now() })?.index;
          return at && deps.clock.now() - at.at < SYNC_CACHE_MAX_AGE_MS ? at : undefined;
        },
        onSent: () => this.noteSent(),
        ...(deps.elsewhere ? { elsewhere: deps.elsewhere } : {}),
        ...(deps.appConnected ? { appConnected: deps.appConnected } : {}),
      });
    }
  }

  start(): void {
    if (this.off || !this.deps.config.full) this.forgetBodiesNote();
    if (this.off || this.running) return;
    this.running = true;
    this.projectsSent = undefined;
    this.accountsSent = undefined;
    this.full = true;
    this.sharesDue = true;
    this.seedFromCache();
    this.unsub = this.deps.runner.onNotification((n) => this.onNotification(n));
    if (this.seeded) {
      this.settling = true;
      this.settleTimer = this.deps.clock.setTimeout(() => this.settled(), SETTLE_MS);
    } else for (const t of this.deps.runner.list(ALL)) this.mark(t);
    this.lists = {
      projects: this.deps.runner.listProjects?.(),
      schedules: this.deps.schedules?.inBackend() ? undefined : this.deps.runner.listSchedules?.(),
      accounts: this.deps.runner.listAccounts?.(),
    };
    for (const name of ['projects', 'schedules', 'accounts'] as const) if (this.lists[name]) this.dirtyLists.add(name);
    this.scheduleFlush();
    this.heartbeat();
    void this.checkPresence();
    this.listenForCommands();
    this.deps.log.info('convex sync on', { url: this.deps.config.url, runnerId: this.runnerId, name: this.name, commands: Boolean(this.deps.commands) });
  }

  // A draining runner stops without a word: the new release writes
  // everything again under the same runnerId. A runner stopping for good
  // says bye, so the phone shows it offline now.
  async stop(opts: { bye?: boolean } = {}): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.unsub?.();
    this.unsubCommands?.();
    this.unsubCommands = undefined;
    this.commandsState = 'off';
    this.index?.stop();
    this.flushTimer?.cancel();
    this.heartbeatTimer?.cancel();
    this.sharedUsageTimer?.cancel();
    this.sharedUsageTimer = undefined;
    this.presenceTimer?.cancel();
    this.settleTimer?.cancel();
    this.settling = false;
    this.missingTimer?.cancel();
    this.missingTimer = undefined;
    this.heldTimer?.cancel();
    this.projectsTimer?.cancel();
    this.accountsTimer?.cancel();
    this.accountsTimer = undefined;
    this.cacheTimer?.cancel();
    this.saveCache();
    this.heldTimer = undefined;
    this.projectsTimer = undefined;
    this.cacheTimer = undefined;
    this.presenceTimer = undefined;
    this.flushTimer = undefined;
    this.heartbeatTimer = undefined;
    this.stats?.stop();
    await this.subscriber?.close();
    if (opts.bye) await this.post('mutation', 'sync:bye', { key: this.deps.key, runnerId: this.runnerId }).catch(() => {});
  }

  // Backends from before version.ts answer the heartbeat with null: version 0.
  private sawBackend(r: unknown): void {
    const v = typeof (r as { apiVersion?: unknown } | null)?.apiVersion === 'number' ? (r as { apiVersion: number }).apiVersion : 0;
    // This deployment has never heard of this runner, though the file says
    // it's all up: a wiped or restored deployment. Everything goes again.
    if ((r as { firstSeen?: unknown } | null)?.firstSeen === true && this.seeded) this.forgetSent();
    // Once a start has heard, as a version read from the cache hasn't been checked.
    if (v === this.backendApiVersion && this.backendHeard) return;
    this.backendHeard = true;
    this.backendApiVersion = v;
    if (v < BACKEND_API_VERSION) {
      this.deps.log.warn('the convex backend is older than this runner', { backend: v, expected: BACKEND_API_VERSION, url: this.deps.config.url });
    }
    if (v >= INDEX_STARTED_BY_API_VERSION) this.index?.refresh();
    // Only a runner key's were dropped; the owner's always stayed.
    if (v >= ARCHIVED_INDEX_API_VERSION && this.deps.key?.startsWith('tbr_')) this.index?.resendArchived();
    // Shared threads held back their share from an older backend (or
    // before the first heartbeat said which): they go again now.
    if (v >= SHARE_API_VERSION && this.running) {
      // A done thread may have next steps (nextSteps), which a row written
      // before the heartbeat left out too.
      const card = (t: ThreadSummary) => Boolean(t.asks?.length) || (t.needs === 'nothing' && t.status === 'idle' && !t.archivedAt);
      // Likewise needs, reviews and waiting for room, for the phone's sections.
      const sections = (t: ThreadSummary) => Boolean(t.needs || t.pendingReviews || t.waitingForRoom);
      for (const t of this.deps.runner.list(ALL)) if (t.share || (t.woke && v >= WOKE_API_VERSION) || (t.startedBy && v >= STARTED_BY_API_VERSION) || (t.starredAt && v >= STARS_API_VERSION) || (v >= LINKS_API_VERSION && t.actions?.some((a) => a.kind === 'url')) || (v >= ASKS_API_VERSION && card(t)) || (v >= SECTIONS_API_VERSION && sections(t)) || (v >= ASKED_API_VERSION && t.asked && !t.archivedAt) || (v >= NETWORK_WAIT_API_VERSION && t.waitingForNetwork) || (v >= WAKE_NOTE_API_VERSION && wakeNote(t))) this.mark(t);
      this.scheduleFlush();
    }
    // The pictures wait for the first heartbeat to say the backend takes them.
    if (v >= ICONS_API_VERSION && this.picturesDue) this.scheduleFlush();
    // Accounts went without their models before the heartbeat said this one takes them.
    if (v >= MODELS_API_VERSION && this.lists.accounts && this.running) {
      this.dirtyLists.add('accounts');
      this.scheduleFlush();
    }
  }

  status(): SyncStatus {
    if (this.off) return { state: 'off', reason: this.off };
    const s: SyncStatus = {
      state: this.lastError && this.retryAt !== undefined ? 'error' : 'ok',
      url: this.deps.config.url,
      ...(this.site() ? { site: this.site() } : {}),
      runnerId: this.runnerId,
      name: this.name,
      threads: this.written,
      messages: this.messagesWritten,
      pending: this.dirty.size + this.held.size + this.removed.size + this.messages.length + this.dirtyLists.size,
      commands: { state: this.commandsState, applied: this.applied, failed: this.failed, ...(this.commandError ? { lastError: this.commandError } : {}) },
    };
    if (this.lastSyncAt !== undefined) s.lastSyncAt = new Date(this.lastSyncAt).toISOString();
    if (this.lastError) s.lastError = this.lastError;
    if (this.retryAt !== undefined) s.retryAt = new Date(this.retryAt).toISOString();
    if (this.backendApiVersion !== undefined) s.backend = { apiVersion: this.backendApiVersion, expected: BACKEND_API_VERSION };
    if (this.ownerKeyRotating) s.ownerKeyRotating = true;
    if (this.pushOff) s.pushOff = true;
    if (this.pushFailing) s.pushFailing = this.pushFailing;
    if (this.keyRejected) {
      s.state = 'error';
      s.lastError = KEY_REJECTED;
      s.keyRejected = true;
    }
    const held = this.deps.schedules?.heldLocal?.().length ?? 0;
    if (held) s.schedulesHeld = held;
    if (this.deps.config.full) {
      s.full = { ...this.bodyStats, pending: this.bodies.length, ...((this.backendApiVersion ?? 0) < BODIES_API_VERSION && this.backendApiVersion !== undefined ? { backendTooOld: true } : {}) };
    }
    s.scrub = { ...this.scrubber.status(), ...(this.backendApiVersion !== undefined ? { backendChecks: this.backendApiVersion >= SCRUB_API_VERSION } : {}) };
    return s;
  }

  // ---- Devices (docs/protocol.md "Devices"): the phone tokens the Mac app
  // issues, lists and revokes through this runner. Each is one call to the
  // backend, outside the mirror's queue; nothing is kept here. The token
  // in issueToken's reply goes back to the caller and nowhere else: never
  // logged, never written.

  /** Why nothing can pair, or undefined while sync is on. */
  offReason(): string | undefined {
    return this.off;
  }

  /**
   * This runner's id and the public key a phone seals secrets to, for the
   * pairing link (devices.ts): the phone trusts only runner keys that came
   * from a Mac this way, never ones the mirror names (docs/protocol.md,
   * "Trusting the key"). Empty without a key.
   */
  pairingKeys(): { runnerId: string; key: string }[] {
    const box = this.deps.secretBox;
    if (!box) return [];
    try {
      return [{ runnerId: this.runnerId, key: box.publicKey() }];
    } catch (err) {
      this.deps.log.warn('no key for secrets from the phone', { error: String(err) });
      return [];
    }
  }

  /** The deployment's URL (`sync.url`), while sync is on. */
  url(): string | undefined {
    return this.off ? undefined : this.deps.config.url;
  }

  /** The website's address, while sync is on (src/convex-admin.ts, siteOf). */
  site(): string | undefined {
    return this.off ? undefined : siteOf(this.deps.config.url, this.deps.config.site);
  }

  async issueToken(args: { kind: DeviceKind; name: string; days?: number }): Promise<{ id: string; token: string; expiresAt: string }> {
    this.mustBeOn();
    const r = (await this.backend('mutation', 'sync:issueToken', { key: this.deps.key, ...args })) as { id?: unknown; token?: unknown; expiresAt?: unknown } | null;
    if (!r || typeof r.id !== 'string' || typeof r.token !== 'string' || typeof r.expiresAt !== 'string') throw new Error('The backend gave no token back.');
    return { id: r.id, token: r.token, expiresAt: r.expiresAt };
  }

  /** runners.setOrder: Mike's runner order, the one the phone sets too (API 58). */
  async setRunnerOrder(runnerIds: string[]): Promise<void> {
    this.mustBeOn();
    if ((this.backendApiVersion ?? 0) < RUNNER_ORDER_API_VERSION) throw new Error('The backend is too old for a runner order: it needs deploying.');
    await this.backend('mutation', 'sync:setRunnerOrder', { key: this.deps.key, runnerIds });
  }

  async listTokens(): Promise<Device[]> {
    this.mustBeOn();
    const r = await this.backend('query', 'sync:listTokens', { key: this.deps.key });
    return Array.isArray(r) ? (r as Device[]) : [];
  }

  /** False when the backend has no token with that id. */
  async revokeToken(id: string): Promise<boolean> {
    this.mustBeOn();
    return (await this.backend('mutation', 'sync:revokeToken', { key: this.deps.key, id })) === true;
  }

  // The `pocket` tool (threadbear-mcp.ts). Straight to the backend: the cards
  // live there, for the phone, and aren't kept on any runner.
  async savePocketCard(card: PocketCardInput): Promise<'added' | 'replaced'> {
    this.mustBeOn();
    return (await this.backend('mutation', 'sync:savePocketCard', { key: this.deps.key, card })) === 'replaced' ? 'replaced' : 'added';
  }

  async removePocketCard(title: string): Promise<boolean> {
    this.mustBeOn();
    return (await this.backend('mutation', 'sync:removePocketCard', { key: this.deps.key, title })) === true;
  }

  async pocketCards(): Promise<PocketCardSummary[]> {
    this.mustBeOn();
    const r = await this.backend('query', 'sync:pocketCards', { key: this.deps.key });
    return Array.isArray(r) ? (r as PocketCardSummary[]) : [];
  }

  // Asking another runner (docs/protocol.md, "Asking another runner";
  // elsewhere.ts). The owner key reads any request and answers it; a runner
  // key files and reads back its own.
  ownerKey(): boolean {
    return Boolean(this.deps.key) && !this.deps.key!.startsWith('tbr_');
  }

  async fileRequest(p: { requestId: string; threadId: string; target: string; request: RunnerRequestInput }): Promise<void> {
    this.mustBeOn();
    await this.backend('mutation', 'relay:fileRequest', { key: this.deps.key, ...p });
  }

  async runnerRequest(requestId: string): Promise<RunnerRequestRow | null> {
    this.mustBeOn();
    return ((await this.backend('query', 'relay:runnerRequest', { key: this.deps.key, requestId })) as RunnerRequestRow | null) ?? null;
  }

  async decideRequest(p: { requestId: string; docId: string; state: 'claimed' | 'allowed' | 'pending' | 'denied'; result?: { runnerId: string; runnerName: string; threadId: string } }): Promise<void> {
    this.mustBeOn();
    await this.backend('mutation', 'relay:decideRequest', { key: this.deps.key, ...p });
  }

  async closeRequest(requestId: string): Promise<void> {
    this.mustBeOn();
    await this.backend('mutation', 'relay:closeRequest', { key: this.deps.key, requestId });
  }

  private mustBeOn(): void {
    if (this.off) throw new Error(`Your threads aren't mirrored to Convex (${this.off}), so there's nothing for a phone or browser to read. Run ./threadbear setup.`);
  }

  // A backend from before API 5 has none of the token functions: the
  // Convex HTTP API says it can't find them. Said in words the Settings
  // window can show, rather than the API's line about `npx convex dev`.
  private async backend(kind: 'mutation' | 'query', fn: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.post(kind, fn, args);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (/could not find (public )?function/i.test(message)) {
        throw new Error('The Convex backend is older than this runner. It deploys with the runner\'s next update; try again in a few minutes.');
      }
      // A runner key asking for something only the main Mac's key can do
      // (pairing a phone, a schedule on another runner): the backend's own words.
      const refused = forbiddenText(e);
      if (refused) throw new Error(refused);
      throw e;
    }
  }

  // One write of rows. Refused for good (a runner key's caps or a row not its
  // own: kind badArgs, tooMany or forbidden), it's tried row by row and the
  // rows still refused are left out with a log line, so one can't stall the
  // whole mirror; anything else (an outage) throws, for the flush's retry.
  // Rows the backend left out itself (`skipped`) are said the same way.
  // ---- Full sync: tool output (docs/full-convex.md step 4). Nothing here runs with
  // sync.full off.

  private queueBodies(found: RawBody[]): void {
    if (!found.length) return;
    this.bodies.push(...found);
    for (const b of found) this.bodyQueueChars += rawChars(b);
    // Convex away for a long time: memory isn't for ever, and each is on the runner.
    while (this.bodies.length > BODY_QUEUE_ROWS || this.bodyQueueChars > BODY_QUEUE_BYTES) {
      this.bodyQueueChars -= rawChars(this.bodies.shift()!);
      this.bodyStats.unsent++;
    }
    this.cacheChanged = true;
    this.scheduleFlush();
  }

  private safeBody(raw: RawBody): BodyDoc {
    try {
      return prepareBody(raw, this.scrubber.strict);
    } catch {
      // The check itself failed: nothing of it goes, as it can't be known to be safe.
      return { threadId: raw.threadId, seq: raw.seq, withheld: true, reason: 'the secret check failed' };
    }
  }

  // After a failed write this is called again with what's still here, so a body
  // comes off the queue only once the backend has it. Up to one mutation's worth a
  // go, in order, and always behind what the mirror itself has to write.
  private async sendBodies(v: number): Promise<void> {
    if (!this.bodies.length) return;
    if (v < BODIES_API_VERSION) {
      this.bodyStats.unsent += this.bodies.length;
      this.bodies = [];
      this.bodyQueueChars = 0;
      return;
    }
    while (this.bodies.length) {
      const batch: RawBody[] = [];
      let size = 0;
      for (const b of this.bodies) {
        const len = rawChars(b);
        if (batch.length && (batch.length >= BODY_BATCH_ROWS || size + len > BODY_BATCH_BYTES)) break;
        batch.push(b);
        size += len;
      }
      const left = await this.writeRows('sync:appendBodies', 'bodies', batch, (b) => `${b.threadId}:${b.seq}`, { key: this.deps.key });
      // By which ones, not how many: the queue can have moved under the write.
      const sent = new Set(batch);
      this.bodies = this.bodies.filter((b) => !sent.has(b));
      this.bodyQueueChars = this.bodies.reduce((n, b) => n + rawChars(b), 0);
      for (const b of batch) {
        // Left out as its thread id is closed: goes again with the retry.
        if (left.has(`${b.threadId}:${b.seq}`) && this.closedIds.has(b.threadId)) this.closedBodies.push(b);
        else if (left.has(`${b.threadId}:${b.seq}`)) this.bodyStats.unsent++;
        else if (b.withheld) this.bodyStats.withheld++;
        else this.bodyStats.bodies++;
      }
      // What came up, near enough: what's sent has been scrubbed and cut since.
      this.bodyStats.bytes += batch.reduce((n, b) => n + rawChars(b), 0);
      this.noteSent();
    }
  }

  // Where each thread's tools have got to, for a start to catch up from: nothing
  // past this has to be read again, and a body still queued isn't past it.
  private bodyHeads(): Record<string, number> {
    const heads: Record<string, number> = {};
    for (const id of this.bodyCollector.threadIds()) {
      const h = this.bodyCollector.head(id);
      if (h !== undefined) heads[id] = h;
    }
    for (const b of [...this.bodies, ...this.closedBodies]) {
      const from = (b.from ?? b.seq) - 1;
      if (heads[b.threadId] !== undefined && heads[b.threadId]! > from) heads[b.threadId] = from;
    }
    return heads;
  }

  // A start, from what the last run noted. Only threads that moved while it was
  // away are read, from where it had got to; a thread with no note starts from now,
  // as full sync goes forward only. A body sent twice writes nothing.
  private catchUpBodies(saved: Record<string, number> | undefined): void {
    let budget = BODY_CATCHUP_EVENTS;
    for (const [id, head] of Object.entries(saved ?? {})) {
      // Not here: a thread the release before still has, whose note stands for when
      // it comes across (fillBodies), or one that's gone, which costs one number.
      this.bodyCollector.resume(id, head);
      let lastSeq: number;
      try {
        lastSeq = this.deps.runner.get(id).lastSeq;
      } catch {
        continue;
      }
      budget -= this.readBodies(id, head, lastSeq + 1, budget);
    }
  }

  // Turned off, or the mirror is: the note goes now, not at some later write, so
  // turning it back on can't send what happened in between.
  private forgetBodiesNote(): void {
    const file = this.deps.cachePath;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { bodies?: unknown };
      if (raw.bodies === undefined) return;
      delete raw.bodies;
      fs.writeFileSync(file, JSON.stringify(raw));
    } catch {
      // No file, or not one it can read, which is no note either.
    }
  }

  // Reads events (after, before) into bodies, at most `budget`. Past that, or if
  // they can't be read, it goes on from `before`: forward only.
  private readBodies(id: string, after: number, before: number, budget: number): number {
    let read = 0;
    let at = after;
    try {
      while (at < before - 1 && read < budget) {
        const { events } = this.deps.runner.events(id, { afterSeq: at, limit: Math.min(BACKFILL_EVENTS, budget - read) });
        const next = events.at(-1)?.seq ?? at;
        if (next <= at) break;
        read += events.length;
        for (const e of events) if (e.seq > at && e.seq < before) this.queueBodies(this.bodyCollector.see(id, e));
        at = next;
      }
    } catch {
      // Still on the release before, say. Those tools show as kept on the runner.
    }
    // Gave up short: what it was waiting for may be past here, so it can't hold the
    // head back, or every start reads the same events again.
    if (at < before - 1) this.bodyCollector.abandon(id);
    this.bodyCollector.resume(id, before - 1);
    return read;
  }

  // Seqs are contiguous, so a jump means events this runner never saw: a thread that
  // came across from the release before.
  private fillBodies(id: string, last: number, seq: number): void {
    this.readBodies(id, last, seq, BODY_CATCHUP_EVENTS);
  }

  // A `picture` command: one picture a tool handed back, uploaded because someone
  // tapped it, for a day. Only the picture that tool's result names, only from this
  // thread's media folder, and never a tool the withhold list holds back.
  private async sendHeldPicture(threadId: string, seq: number, index: number): Promise<void> {
    if (!this.deps.config.full) throw new Error('Full sync is off on this runner.');
    if ((this.backendApiVersion ?? 0) < BODIES_API_VERSION) throw new Error('The backend is too old for that.');
    if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index) || seq < 1 || index < 0) throw new Error('No such picture.');
    const { events } = this.deps.runner.events(threadId, { afterSeq: seq - 1, limit: PICTURE_SCAN_EVENTS });
    const call = events.find((e) => e.seq === seq);
    if (call?.type !== 'tool.call') throw new Error('No such tool.');
    if (withholdReason(call)) throw new Error('This one stays on the runner.');
    const result = events.find((e) => e.type === 'tool.result' && e.itemId === call.itemId);
    const image = result?.type === 'tool.result' ? result.images?.[index] : undefined;
    if (!image) throw new Error('No such picture.');
    const read = readShareImage(image.path, this.deps.home ? paths.media(this.deps.home, threadId) : undefined);
    if ('skip' in read) throw new Error(`That picture isn't available: ${read.skip}.`);
    const url = (await this.post('mutation', 'sync:iconUploadUrl', { key: this.deps.key })) as string;
    const storageId = await this.upload(url, read.bytes, read.mediaType);
    const { mediaType, width, height } = read;
    const r = await this.post('mutation', 'sync:addHeldPicture', { key: this.deps.key, threadId, seq, index, storageId, mediaType, ...(width ? { width } : {}), ...(height ? { height } : {}) });
    if ((r as { later?: unknown } | null)?.later === true) throw new Error('That thread is being moved: try again in a moment.');
  }

  private async writeRows<T>(fn: string, field: string, rows: T[], idOf: (row: T) => string, extra: Record<string, unknown>): Promise<Set<string>> {
    const left = new Set<string>();
    const once = async (some: T[]) => {
      for (const id of this.noteSkipped(fn, await this.post('mutation', fn, { ...extra, [field]: some }))) left.add(id);
    };
    try {
      await once(rows);
      return left;
    } catch (e) {
      if (!refusedForGood(e)) throw e;
      if (rows.length === 1) {
        this.leftOut(fn, idOf(rows[0]!), e);
        left.add(idOf(rows[0]!));
        return left;
      }
    }
    for (const row of rows) {
      try {
        await once([row]);
      } catch (e) {
        if (!refusedForGood(e)) throw e;
        this.leftOut(fn, idOf(row), e);
        left.add(idOf(row));
      }
    }
    return left;
  }

  // One picture's upload and record. Refused for good (the upload route's
  // 403 or 413, a runner key's hourly or stored allowance, a picture it may
  // not attach), it's left out with a log line and the rest go on: false.
  // For now ("later": an allowance), it stays queued and pictures pause
  // until PICTURES_PAUSE_MS has passed; the rest of the flush goes on.
  // An added picture's answer, for picture() above: later means it wasn't
  // kept, as its thread id's old rows are still going, so it stays queued.
  private pictureKept(r: unknown): void {
    if ((r as { later?: unknown } | null)?.later === true) throw Object.assign(new Error('its thread is still being cleared'), { data: { kind: 'retryLater' } });
  }

  private async picture(fn: string, what: string, send: () => Promise<void>): Promise<'sent' | 'dropped' | 'later'> {
    try {
      await send();
      return 'sent';
    } catch (e) {
      if (retryLater(e)) {
        if (!this.picturesPausedUntil) this.deps.log.info('pictures wait: over this runner key\'s upload allowance for now', { fn, row: what });
        this.picturesPausedUntil = this.deps.clock.now() + PICTURES_PAUSE_MS;
        this.deps.clock.setTimeout(() => this.scheduleFlush(), PICTURES_PAUSE_MS + 1_000);
        return 'later';
      }
      if (!refusedForGood(e)) throw e;
      this.leftOut(fn, what, e);
      return 'dropped';
    }
  }

  private picturesPaused(): boolean {
    if (this.picturesPausedUntil && this.deps.clock.now() < this.picturesPausedUntil) return true;
    this.picturesPausedUntil = undefined;
    return false;
  }

  // Thread ids the backend said are closed this flush: a removed or moving
  // thread's old rows are still going (convex/sync.ts clearThread), so what
  // it left out of them goes again shortly, whatever went after it.
  // What waits for the retry, held out of the ordinary flushes, which come
  // every couple of seconds while anything's waiting: rows by id (as the
  // thread is then, if it's still here), tool output (still holding back
  // bodyHeads), and threads whose history goes again.
  private closedIds = new Set<string>();
  private closedRows = new Set<string>();
  private closedBodies: RawBody[] = [];
  private closedHistories = new Set<string>();
  private closedTimerSet = false;
  private closedRetryDue = false;

  private retryClosedLater(): void {
    if (this.closedTimerSet) return;
    this.closedTimerSet = true;
    this.deps.clock.setTimeout(() => {
      this.closedTimerSet = false;
      if (!this.running) return;
      for (const id of this.closedRows) {
        try {
          this.mark(this.deps.runner.get(id), true);
        } catch {
          // Deleted meanwhile: nothing to write, and its removal is on its way.
        }
      }
      this.closedRows.clear();
      // Only a thread that's still here: writing one that's gone would bring its tool output back.
      const here = (b: RawBody) => {
        try {
          return Boolean(this.deps.runner.get(b.threadId));
        } catch {
          return false;
        }
      };
      this.bodies.push(...this.closedBodies.filter(here));
      this.closedBodies = [];
      this.bodyQueueChars = this.bodies.reduce((n, b) => n + rawChars(b), 0);
      this.closedHistories.clear();
      this.closedRetryDue = true;
      this.scheduleFlush();
    }, CLOSED_RETRY_MS);
  }

  private noteSkipped(fn: string, r: unknown): string[] {
    const closed = (r as { closed?: unknown } | null)?.closed;
    if (Array.isArray(closed)) {
      for (const id of closed) if (typeof id === 'string') this.closedIds.add(id);
      if (closed.length) this.retryClosedLater();
    }
    const skipped = (r as { skipped?: unknown } | null)?.skipped;
    if (!Array.isArray(skipped) || !skipped.length) return [];
    this.deps.log.warn('the backend left rows out, over what this runner\'s key may write', { fn, rows: skipped.slice(0, 20), count: skipped.length });
    return skipped.filter((x): x is string => typeof x === 'string');
  }

  private leftOut(fn: string, row: string, e: unknown): void {
    this.deps.log.warn('a row the backend refused for good was left out', { fn, row, error: String((e as { data?: { message?: unknown } })?.data?.message ?? (e as Error)?.message ?? e) });
  }

  // Writes whatever is waiting now, however recent the last write; tests
  // and a stop that wants the last state out use it.
  async flushNow(): Promise<void> {
    this.flushTimer?.cancel();
    this.flushTimer = undefined;
    this.lastFlushAt = -Infinity;
    this.retryAt = undefined;
    if (this.settling) this.settled();
    this.releaseHeld(true);
    await this.flush();
  }

  // ------------------------------------------------------------ changes

  private onNotification(n: Notification): void {
    switch (n.method) {
      case 'thread.updated':
        this.mark(n.params.thread);
        this.scheduleFlush();
        break;
      case 'thread.deleted': {
        const id = n.params.threadId;
        this.dirty.delete(id);
        this.sent.delete(id);
        this.held.delete(id);
        this.lastWrite.delete(id);
        this.heads.delete(id);
        this.noteSent();
        this.forgetCards(id);
        this.earliest.delete(id);
        this.nexts.delete(id);
        for (const k of [...this.buttonRows.keys()]) if (k.startsWith(`${id} `)) this.buttonRows.delete(k);
        this.replyDue.delete(id);
        this.replyUp.delete(id);
        this.pendingReplyImages = this.pendingReplyImages.filter((i) => i.threadId !== id);
        this.bodyCollector.forget(id);
        this.bodies = this.bodies.filter((b) => b.threadId !== id);
        this.closedBodies = this.closedBodies.filter((b) => b.threadId !== id);
        this.bodyQueueChars = this.bodies.reduce((n, b) => n + rawChars(b), 0);
        this.removed.add(id);
        this.scheduleFlush();
        break;
      }
      case 'thread.event':
        this.onEvent(n.params.threadId, n.params.event as PersistedEvent);
        break;
      case 'projects.updated':
        this.lists.projects = n.params.projects;
        this.dirtyLists.add('projects');
        this.picturesDue = true;
        this.scheduleFlush();
        break;
      case 'schedules.updated':
        // Ones that live in the backend are written there by the scheduler.
        if (this.deps.schedules?.inBackend() || this.schedulesRefused) break;
        this.lists.schedules = n.params.schedules;
        this.dirtyLists.add('schedules');
        this.scheduleFlush();
        break;
      case 'accounts.updated':
        this.lists.accounts = n.params.accounts;
        this.dirtyLists.add('accounts');
        this.scheduleFlush();
        break;
      default:
        break;
    }
  }

  // Text messages go up as they're persisted; an approval or question
  // the thread is waiting on goes on its row until it's resolved.
  private onEvent(threadId: string, e: PersistedEvent): void {
    if (typeof (e as { seq?: unknown }).seq !== 'number') return; // a delta
    // A shared thread's new pictures follow, unless its whole history is
    // about to be looked through anyway.
    if (this.sharedNow.get(threadId) && !this.imagesDue.has(threadId)) {
      const found = imagesInEvent(e);
      if (found.length) {
        this.pendingImages.push(...found.map((i) => ({ ...i, threadId })));
        this.scheduleFlush();
      }
    }
    // Only to a backend that takes them: an older one would leave them
    // queued, and a start looks through recent threads once it's new enough.
    if ((this.backendApiVersion ?? 0) >= REPLY_IMAGES_API_VERSION) {
      const found = [...replyImagesInEvent(e, this.cwdOf(threadId)), ...(this.deps.config.pastedPictures === false ? [] : pastedImagesInEvent(e))];
      if (found.length) {
        this.pendingReplyImages.push(...found.map((i) => ({ ...i, threadId })));
        this.scheduleFlush();
      }
    }
    this.woke.see(e);
    if (this.deps.config.full) {
      const last = this.bodyCollector.lastSeen(threadId);
      if (last !== undefined && e.seq > last + 1) this.fillBodies(threadId, last, e.seq);
      this.queueBodies(this.bodyCollector.see(threadId, e));
    }
    // A thread that's just touched a file of secrets may quote what's in it.
    // Looked at once it's done: a write hasn't happened yet when it's asked for.
    // Any reason, as `printenv > .env` is an environment command first.
    if (e.type === 'tool.call' && withholdReason(e)) {
      const file = typeof e.input.file_path === 'string' ? e.input.file_path : undefined;
      const dir = file && path.isAbsolute(file) ? path.dirname(file) : this.cwdOf(threadId);
      this.scrubber.known.lookSoon(dir);
      if (dir) this.secretCalls.set(`${threadId} ${e.itemId}`, dir);
    } else if (e.type === 'tool.result' && this.secretCalls.size) {
      const key = `${threadId} ${e.itemId}`;
      const dir = this.secretCalls.get(key);
      if (dir) {
        this.secretCalls.delete(key);
        this.scrubber.known.lookSoon(dir);
      }
    }
    if (e.type === 'button.updated') {
      this.onButton(threadId, e.button);
      return;
    }
    const m = toMessageDoc(threadId, e, this.scrubber.safeText);
    if (m) {
      this.messages.push(this.woke.take(m, e));
      this.scheduleFlush();
      return;
    }
    if (e.type === 'approval.requested' && e.name === START_CARD) {
      // A request for a thread on another runner (cross-runner.ts) is
      // answered only on the main Mac, whose runner starts it: the phone's
      // card has no buttons and says so, as one too big for the row does.
      this.addCard(threadId, { approvalId: e.approvalId, kind: 'approval', seq: e.seq, name: e.name, title: `${e.title} Answer it on the Mac.`, options: [] });
    } else if (e.type === 'approval.requested') {
      // One whose line can't show all it allows offers only Deny there,
      // and says why; the runner refuses an allow from there anyway
      // (Runner.respondApproval). An older phone draws the options it's given.
      const summary = inputSummary(e.input, this.scrubber.safeText);
      // Scrubbing can take out what a call does (`token="touch x"; eval
      // "$token"`), so what the line is made from must go up as it is (Codex review).
      const raw = summaryField(e.input);
      const shownAsIs = raw === undefined || this.scrubber.safeText(raw) === raw;
      const whole = shownAsIs && remoteCardShowsAll(e.name, e.input, this.threadCwd(threadId), e.title);
      this.addCard(threadId, {
        approvalId: e.approvalId, kind: 'approval', seq: e.seq, name: e.name,
        title: whole ? e.title : `${e.title}. ${REMOTE_ALLOW_REFUSED}`,
        options: whole ? e.options : e.options.filter((o) => o !== 'allow' && o !== 'allowAlways'),
        ...(summary ? { inputSummary: summary } : {}),
      });
    } else if (e.type === 'question.requested') {
      this.addCard(threadId, { approvalId: e.approvalId, kind: 'question', seq: e.seq, questions: e.questions });
    } else if (e.type === 'secret.requested') {
      // forBackend drops it for a backend older than SECRETS_API_VERSION.
      const box = this.deps.secretBox;
      if (!box) return;
      let key: string;
      try {
        key = box.publicKey();
      } catch (err) {
        this.deps.log.warn('no key for secrets from the phone', { error: String(err) });
        return;
      }
      this.addCard(threadId, { approvalId: e.approvalId, kind: 'secret', seq: e.seq, label: e.label, reason: e.reason, ...(e.placeholder ? { placeholder: e.placeholder } : {}), key });
    } else if (e.type === 'approval.resolved') {
      this.closeCard(threadId, e.approvalId);
    } else return;
    try {
      this.mark(this.deps.runner.get(threadId));
      this.scheduleFlush();
    } catch {
      // The thread went between the event and now; its row goes with it.
    }
  }

  private addCard(threadId: string, card: PendingApproval): void {
    const shown = this.pending.get(threadId);
    if (shown) this.cardsBehind.set(threadId, [...(this.cardsBehind.get(threadId) ?? []), shown]);
    this.pending.set(threadId, card);
  }

  private closeCard(threadId: string, approvalId: string): void {
    const behind = (this.cardsBehind.get(threadId) ?? []).filter((c) => c.approvalId !== approvalId);
    if (this.pending.get(threadId)?.approvalId === approvalId) {
      const next = behind.pop();
      if (next) this.pending.set(threadId, next);
      else this.pending.delete(threadId);
    }
    if (behind.length) this.cardsBehind.set(threadId, behind);
    else this.cardsBehind.delete(threadId);
  }

  private forgetCards(threadId: string): void {
    this.pending.delete(threadId);
    this.cardsBehind.delete(threadId);
  }

  // Only a change the phone would see makes a write.
  // The thread's folder, for whether a card's line shows all of it.
  private threadCwd(threadId: string): string | undefined {
    try {
      return this.deps.runner.get(threadId).cwd;
    } catch {
      return undefined;
    }
  }

  private mark(t: ThreadSummary, now_ = false): void {
    this.missing.delete(t.id);
    if (this.removedFromFile.delete(t.id)) {
      this.removed.delete(t.id);
      this.removing.delete(t.id);
    }
    // settled() looks at every thread, as they are by then. Not a new one: its
    // row has to go up before it needs Mike, or no push ever fires for it (a
    // push is needsYou going from false to true on a row that's there).
    if (this.settling && !now_ && this.sent.has(t.id)) return;
    // Its folder's .env files are what a thread's words are likely to quote.
    if (!t.archivedAt) this.scrubber.known.noteFolder(t.cwd);
    // A thread that isn't waiting any more lost its approval some other
    // way (the turn ended, the runner restarted); the row mustn't keep it.
    if (t.status === 'idle' || t.status === 'error' || t.status === 'stopped') this.forgetCards(t.id);
    this.noteShared(t);
    const doc = toThreadDoc(t, this.runnerId, this.deps.clock.now(), this.pending.get(t.id), this.earliestSeq(t), this.nextSteps(t), this.scrubber.safeText);
    const now = this.deps.clock.now();
    // Against the row as this backend took it: `sent` holds that, without
    // the fields an older one doesn't know, which would otherwise make every
    // summary of a thread with one look new.
    const row = forBackend(doc, this.backendApiVersion ?? 0, now);
    if ((this.writing.get(t.id)?.digest ?? this.sent.get(t.id)) === digest(JSON.stringify(row))) {
      this.dirty.delete(t.id);
      this.held.delete(t.id);
      return;
    }
    // An archived thread isn't saying anything new, but a row about to go up
    // for the first time can still quote what its folder holds.
    if (t.archivedAt) this.scrubber.known.noteFolder(t.cwd, true);
    const last = this.lastWrite.get(t.id);
    if (!this.dirty.has(t.id) && last && now - last.at < PREVIEW_HOLD_MS && last.steady === steadyDigest(row)) {
      this.held.set(t.id, { doc, due: last.at + PREVIEW_HOLD_MS });
      this.armHeld();
      return;
    }
    this.held.delete(t.id);
    this.dirty.set(t.id, doc);
  }

  private settled(): void {
    this.settleTimer?.cancel();
    this.settleTimer = undefined;
    this.settling = false;
    // A row the file says the mirror has, for a thread that isn't here (or
    // finishing on the release before): deleted while this runner wasn't
    // listening, as with sync turned off. A start from the file skips the
    // prune a full write does, so it goes now (Daybreak, 6 Nov: a shared
    // thread deleted with sync off stayed public).
    const here = new Set(this.deps.runner.list(ALL).map((t) => t.id));
    for (const id of [...this.sent.keys()]) if (!here.has(id) && !this.deps.elsewhere?.(id)) this.dropRow(id);
    for (const t of this.deps.runner.list(ALL)) this.mark(t);
    this.scheduleFlush();
  }

  // Takes a row out of the mirror that no thread here has, once it has been
  // missing for MISSING_GRACE_MS and still is: then removed with the next
  // flush (and kept in the file till it is), unless the thread turns up after
  // all (mark), when it's written again in full, history and all.
  private dropRow(threadId: string): void {
    if (!this.missing.has(threadId)) this.missing.set(threadId, this.deps.clock.now());
    this.armMissing();
  }

  private armMissing(): void {
    if (this.missingTimer || !this.missing.size || !this.running) return;
    const due = Math.min(...this.missing.values()) + MISSING_GRACE_MS;
    this.missingTimer = this.deps.clock.setTimeout(() => {
      this.missingTimer = undefined;
      this.confirmMissing();
      this.armMissing();
    }, Math.max(0, due - this.deps.clock.now()));
  }

  private confirmMissing(): void {
    const now = this.deps.clock.now();
    const here = new Set(this.deps.runner.list(ALL).map((t) => t.id));
    for (const [id, since] of [...this.missing]) {
      if (here.has(id) || this.deps.elsewhere?.(id)) {
        this.missing.delete(id);
        continue;
      }
      if (now - since < MISSING_GRACE_MS) continue;
      this.missing.delete(id);
      this.removed.add(id);
      this.removedFromFile.add(id);
      this.sent.delete(id);
      this.heads.delete(id);
      this.lastWrite.delete(id);
      this.noteSent();
    }
    this.scheduleFlush();
  }

  // The mirror's rows shared by link, against this runner's threads: one that
  // isn't here goes, and one here that isn't shared is written again, so
  // anyone with its slug stops being able to read it whatever went wrong
  // with the write that stopped it.
  private async reconcileShares(key: string | undefined): Promise<void> {
    const ids = await this.post('query', 'sync:sharedThreads', { key, runnerId: this.runnerId });
    this.sharesDue = false;
    this.sharesCheckedAt = this.deps.clock.now();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string' || this.deps.elsewhere?.(id)) continue;
      let t: ThreadSummary | undefined;
      try {
        t = this.deps.runner.get(id);
      } catch {
        t = undefined;
      }
      if (!t) {
        this.dropRow(id);
        continue;
      }
      if (t.share?.access === 'link') continue;
      this.sent.delete(id);
      this.lastWrite.delete(id);
      this.mark(t, true);
    }
  }

  private sharesCheckDue(): boolean {
    return this.sharesDue && !this.settling && (this.backendApiVersion ?? 0) >= SHARED_THREADS_API_VERSION;
  }

  private recordSent(row: ThreadDoc): void {
    this.sent.set(row.threadId, digest(JSON.stringify(row)));
    this.lastWrite.set(row.threadId, { at: this.deps.clock.now(), steady: steadyDigest(row) });
    this.noteSent();
  }

  private armHeld(): void {
    if (this.heldTimer || !this.held.size || !this.running) return;
    const due = Math.min(...[...this.held.values()].map((h) => h.due));
    this.heldTimer = this.deps.clock.setTimeout(() => {
      this.heldTimer = undefined;
      this.releaseHeld();
      this.scheduleFlush();
      this.armHeld();
    }, Math.max(0, due - this.deps.clock.now()));
  }

  private releaseHeld(all = false): void {
    const now = this.deps.clock.now();
    for (const [id, h] of this.held) {
      if (!all && h.due > now) continue;
      this.dirty.set(id, h.doc);
      this.held.delete(id);
    }
  }

  // ---- What the mirror already has, between starts (sync-cache.ts).

  private seedFromCache(): void {
    this.seeded = false;
    const file = this.deps.cachePath;
    const url = this.deps.config.url;
    if (!file || !url) return;
    const c = loadSyncCache(file, { url, runnerId: this.runnerId, now: this.deps.clock.now() });
    if (!c) return;
    this.sent = new Map(Object.entries(c.threads));
    this.heads = new Map(Object.entries(c.heads));
    // One that's here after all (handed back) isn't gone.
    const here = new Set(this.deps.runner.list(ALL).map((t) => t.id));
    for (const id of c.removed ?? []) {
      if (here.has(id)) continue;
      this.removed.add(id);
      this.removedFromFile.add(id);
    }
    if (c.projects) this.projectsSent = new Map(Object.entries(c.projects));
    if (c.accounts) this.accountsSent = new Map(Object.entries(c.accounts));
    if (c.apiVersion !== undefined) this.backendApiVersion = c.apiVersion;
    if (this.deps.config.full) this.catchUpBodies(c.bodies);
    this.fullAt = c.at;
    this.full = false;
    this.catchUpDue = true;
    this.seeded = true;
    this.deps.log.info('convex sync: comparing with what was sent last time', { threads: this.sent.size, index: Object.keys(c.index?.rows ?? {}).length });
  }

  private forgetSent(): void {
    this.deps.log.warn('this deployment has not seen this runner before: writing everything again', { url: this.deps.config.url });
    this.seeded = false;
    this.settleTimer?.cancel();
    this.settleTimer = undefined;
    this.settling = false;
    // Now, not at the next save: a restart before the full write finishes
    // would find the file valid and firstSeen no longer true, and the
    // deployment would stay empty.
    try {
      if (this.deps.cachePath) dropSyncCache(this.deps.cachePath);
    } catch (e) {
      this.deps.log.warn('could not drop what the mirror had', { error: String(e) });
    }
    this.cacheChanged = false;
    this.sent.clear();
    this.heads.clear();
    this.lastWrite.clear();
    this.projectsSent = undefined;
    this.accountsSent = undefined;
    this.full = true;
    this.catchUpDue = false;
    for (const t of this.deps.runner.list(ALL)) this.mark(t);
    for (const name of ['projects', 'accounts'] as const) if (this.lists[name]) this.dirtyLists.add(name);
    this.index?.forgetSent();
    this.scheduleFlush();
  }

  private noteSent(): void {
    if (!this.deps.cachePath || !this.running) return;
    this.cacheChanged = true;
    if (this.cacheTimer) return;
    this.cacheTimer = this.deps.clock.setTimeout(() => {
      this.cacheTimer = undefined;
      this.saveCache();
    }, CACHE_SAVE_MS);
  }

  // Only once a full write has finished: before that, what's been sent isn't
  // all of what the mirror should have.
  private saveCache(): void {
    const file = this.deps.cachePath;
    const url = this.deps.config.url;
    if (!file || !url || !this.cacheChanged || this.full) return;
    this.cacheChanged = false;
    try {
      const index = this.index?.snapshot();
      saveSyncCache(file, {
        v: 1,
        url,
        runnerId: this.runnerId,
        ...(this.backendApiVersion !== undefined ? { apiVersion: this.backendApiVersion } : {}),
        at: this.fullAt,
        threads: Object.fromEntries(this.sent),
        heads: Object.fromEntries(this.heads),
        ...(this.removed.size || this.removing.size ? { removed: [...new Set([...this.removed, ...this.removing])] } : {}),
        ...(this.projectsSent ? { projects: Object.fromEntries(this.projectsSent) } : {}),
        ...(this.accountsSent ? { accounts: Object.fromEntries(this.accountsSent) } : {}),
        ...(index ? { index } : {}),
        ...(this.deps.config.full ? { bodies: this.bodyHeads() } : {}),
      });
    } catch (e) {
      this.deps.log.warn('could not save what the mirror has', { error: String(e) });
    }
  }

  // A thread the phone made has its row written before its command
  // finishes: the phone opens the thread as soon as it has the id, and a
  // row still waiting for the next flush (SYNC_COALESCE_MS) reads to it as
  // a deleted thread. If this write fails, the next flush tries again.
  private async writeRowNow(threadId: string): Promise<void> {
    const me = Symbol('writeRowNow');
    let failed = false;
    const done = await this.rowTurn();
    try {
      this.mark(this.deps.runner.get(threadId), true);
      const doc = this.dirty.get(threadId);
      if (!doc) return;
      const row = forBackend(doc, this.backendApiVersion ?? 0, this.deps.clock.now());
      // As a flush's batch is: a change while it's on its way is weighed
      // against this row, not the one before, or one back to that (a share
      // stopped again at once) was dropped as nothing new.
      this.writing.set(threadId, { digest: digest(JSON.stringify(row)), by: me });
      await this.post('mutation', 'sync:upsertThreads', { key: this.deps.key, threads: [row] });
      this.recordSent(row);
      if (this.dirty.get(threadId) === doc) this.dirty.delete(threadId);
      this.written++;
    } catch (e) {
      // It may have landed all the same (an answer lost on the way back), so
      // what the mirror has is no longer known: the next mark writes, even a
      // change back to what was sent before (Stop sharing after a link).
      this.sent.delete(threadId);
      this.lastWrite.delete(threadId);
      failed = true;
      this.deps.log.debug('new thread row not written yet', { threadId, error: String(e) });
    } finally {
      this.doneWriting(threadId, me);
      done();
    }
    // A change marked while it was on its way was weighed against it and may
    // have been dropped as the same: the thread as it is now goes with the
    // next flush (Codex's review, 7 Nov: Stop sharing from the phone failing
    // while a progress update came in left the link up).
    if (failed) {
      try {
        this.mark(this.deps.runner.get(threadId), true);
      } catch {
        // Gone meanwhile: its removal is queued.
      }
      this.scheduleFlush();
    }
  }

  private doneWriting(threadId: string, by: symbol): void {
    if (this.writing.get(threadId)?.by === by) this.writing.delete(threadId);
  }

  /** Waits for the threads-row writer before this one; call what it returns when done (twice is fine). */
  private async rowTurn(): Promise<() => void> {
    const before = this.rowQueue;
    let done!: () => void;
    this.rowQueue = new Promise<void>((r) => (done = r));
    await before;
    return done;
  }

  // A thread just shared has its pictures looked for; one no longer shared
  // has them dropped. At start every shared thread is looked through (what's
  // up already is skipped), and one shared then stopped while the runner
  // was off has its pictures dropped.
  private noteShared(t: ThreadSummary): void {
    const shared = t.share?.access === 'link';
    const was = this.sharedNow.get(t.id);
    this.sharedNow.set(t.id, shared);
    if (shared && !was) {
      this.imagesDue.add(t.id);
      this.imagesDrop.delete(t.id);
    } else if (!shared && (was || (was === undefined && t.share))) {
      this.imagesDue.delete(t.id);
      this.imagesDrop.add(t.id);
      this.imagesUp.delete(t.id);
      this.pendingImages = this.pendingImages.filter((i) => i.threadId !== t.id);
    }
  }

  // A finished turn's suggested follow-ups (end_turn's `next`), for the
  // phone's done card: only while the thread is idle on a turn that said
  // it needs nothing, read from the end of its log once per lastSeq.
  private nextSteps(t: ThreadSummary): string[] | undefined {
    if (t.status !== 'idle' || t.needs !== 'nothing' || t.archivedAt) return undefined;
    const known = this.nexts.get(t.id);
    if (known && known.lastSeq === t.lastSeq) return known.next;
    let next: string[] | undefined;
    try {
      const { events } = this.deps.runner.events(t.id, { beforeSeq: t.lastSeq + 1, limit: 20 });
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (e.type === 'turn.completed') {
          if (e.next?.length) next = e.next;
          break;
        }
        // A message after the turn means it's no longer the last word.
        if (e.type === 'user.message' || e.type === 'turn.started') break;
      }
    } catch {
      return undefined;
    }
    this.nexts.set(t.id, { lastSeq: t.lastSeq, next });
    return next;
  }

  // The seq of the thread's first text message, read once from the start
  // of its log (a thread with no text yet is asked again next time).
  private earliestSeq(t: ThreadSummary): number | undefined {
    const known = this.earliest.get(t.id);
    if (typeof known === 'number') return known;
    if (known === null && t.lastSeq === 0) return undefined;
    let seq: number | undefined;
    try {
      const { events } = this.deps.runner.events(t.id, { afterSeq: 0, limit: 50 });
      seq = events.find((e) => e.type === 'user.message' || e.type === 'assistant.text')?.seq;
    } catch {
      return undefined;
    }
    this.earliest.set(t.id, seq ?? null);
    return seq;
  }

  // The whole list once per start (and always, to an older backend), then
  // only what changed: a turn moves its project's lastActivityAt, and
  // rewriting every project for that was most of the projects' reads.
  private async sendProjects(list: Project[], v: number): Promise<void> {
    const key = this.deps.key;
    const docs = list.map(toProjectDoc);
    const entry = (d: (typeof docs)[number]): [string, string, string] => {
      const { lastActivityAt, notes, ...rest } = d;
      return [digest(JSON.stringify(rest)), lastActivityAt ?? '', digest(notes)];
    };
    if (v < PROJECTS_DIFF_API_VERSION || !this.projectsSent) {
      await this.post('mutation', 'sync:setProjects', { key, runnerId: this.runnerId, projects: docs });
      this.projectsSent = v >= PROJECTS_DIFF_API_VERSION ? new Map(docs.map((d) => [d.id, entry(d)])) : undefined;
      this.noteSent();
      return;
    }
    const sent = this.projectsSent;
    const now = this.deps.clock.now();
    // A real change goes now; one that's only lastActivityAt moving goes at
    // most every PROJECT_ACTIVITY_MS, all together.
    const activityDue = now - this.projectActivityAt >= PROJECT_ACTIVITY_MS;
    let activityWaits = false;
    const changed = docs.filter((d) => {
      const [was, wasAt, wasNotes] = sent.get(d.id) ?? [];
      const [is, isAt, isNotes] = entry(d);
      if (was !== is || wasNotes !== isNotes) return true;
      if (wasAt === isAt) return false;
      if (activityDue) return true;
      activityWaits = true;
      return false;
    });
    const ids = new Set(docs.map((d) => d.id));
    const removed = [...sent.keys()].filter((id) => !ids.has(id));
    if (changed.length || removed.length) {
      // Notes the backend already has stay behind: they're most of a
      // project's bytes, and it would rewrite them.
      const apart = v >= NOTES_APART_API_VERSION;
      const projects = changed.map((d) => {
        if (!apart || sent.get(d.id)?.[2] !== entry(d)[2]) return d;
        const { notes: _n, ...rest } = d;
        return rest;
      });
      await this.post('mutation', 'sync:upsertProjects', { key, runnerId: this.runnerId, projects, removed });
      for (const d of changed) sent.set(d.id, entry(d));
      for (const id of removed) sent.delete(id);
      if (activityDue) this.projectActivityAt = now;
      this.noteSent();
    }
    if (activityWaits && !this.projectsTimer) {
      this.projectsTimer = this.deps.clock.setTimeout(() => {
        this.projectsTimer = undefined;
        this.dirtyLists.add('projects');
        this.scheduleFlush();
      }, Math.max(0, this.projectActivityAt + PROJECT_ACTIVITY_MS - now));
    }
  }

  // As projects: the whole list when the backend can't take less, or when
  // this is the first this runner knows of what it has; else what changed.
  // A reading's time isn't a change: Token Stats reads every few minutes
  // whether or not a window has moved, and nothing shows it from the mirror.
  // Nor is which source it came from, on its own.
  private async sendAccounts(list: Account[], v: number): Promise<void> {
    const key = this.deps.key;
    const docs = list.map((a) => toAccountDoc(a, v));
    const entry = (d: (typeof docs)[number]) => {
      const u = d.usage as Record<string, unknown> | undefined;
      if (!u) return digest(JSON.stringify(d));
      const { readAt: _readAt, source: _source, ...usage } = u;
      return digest(JSON.stringify({ ...d, usage }));
    };
    const sent = this.accountsSent;
    const now = this.deps.clock.now();
    let copyWaits = Infinity;
    const changed = sent
      ? docs.filter((d) => {
          const id = d.id as string;
          const u = d.usage as { source?: string; blocked?: boolean } | undefined;
          if (sent.get(id) === entry(d)) {
            const heldOwn = this.accountCopyHeld.has(id) && u?.source !== 'shared';
            this.accountCopyHeld.delete(id);
            return heldOwn;
          }
          // Blocked goes at once: that's what a phone's picker most needs to know.
          if (u?.source !== 'shared' || u.blocked) {
            this.accountCopyHeld.delete(id);
            return true;
          }
          const due = (this.accountCopiedAt.get(id) ?? -Infinity) + USAGE_COPY_MS;
          if (now >= due) {
            this.accountCopiedAt.set(id, now);
            this.accountCopyHeld.delete(id);
            return true;
          }
          this.accountCopyHeld.add(id);
          copyWaits = Math.min(copyWaits, due);
          return false;
        })
      : docs;
    if (copyWaits !== Infinity && !this.accountsTimer) {
      this.accountsTimer = this.deps.clock.setTimeout(() => {
        this.accountsTimer = undefined;
        this.dirtyLists.add('accounts');
        this.scheduleFlush();
      }, Math.max(0, copyWaits - now));
    }
    const ids = new Set(docs.map((d) => d.id as string));
    const removed = sent ? [...sent.keys()].filter((id) => !ids.has(id)) : [];
    if (sent && !changed.length && !removed.length) return;
    const went = new Set(changed.map((d) => d.id as string));
    if (sent && v >= ACCOUNTS_DIFF_API_VERSION) await this.post('mutation', 'sync:upsertAccounts', { key, runnerId: this.runnerId, accounts: changed, removed });
    else await this.post('mutation', 'sync:setAccounts', { key, runnerId: this.runnerId, accounts: docs });
    // A copy still waiting stays different from what's remembered, so it goes when due.
    this.accountsSent = new Map(docs.filter((d) => !sent || went.has(d.id as string) || sent.has(d.id as string)).map((d) => [d.id as string, !sent || went.has(d.id as string) ? entry(d) : (sent.get(d.id as string) ?? entry(d))]));
    this.noteSent();
  }

  private scheduleFlush(): void {
    if (!this.running || this.flushTimer) return;
    // Project pictures waiting (picturesDue) count too: one an upload
    // allowance held back goes once its pause is over, idle or not.
    const picturesWaiting = this.picturesDue && (this.backendApiVersion ?? 0) >= ICONS_API_VERSION && !this.picturesPaused();
    if (!picturesWaiting && !this.closedRetryDue && !this.bodies.length && !this.dirty.size && !this.removed.size && !this.messages.length && !this.dirtyLists.size && !this.full && !this.catchUpDue && !this.imagesDue.size && !this.imagesDrop.size && !this.pendingImages.length && !this.replyDue.size && !this.pendingReplyImages.length && !this.sharesCheckDue()) return;
    const now = this.deps.clock.now();
    let delay = Math.max(0, this.lastFlushAt + SYNC_COALESCE_MS - now);
    if (this.retryAt !== undefined) delay = Math.max(delay, this.retryAt - now);
    this.flushTimer = this.deps.clock.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.running) return;
    this.flushing = true;
    const me = Symbol('flush');
    // The rows of a batch on its way when it failed: they may have landed.
    let unsure: string[] = [];
    // Before taking the rows, so none is older than one writeRowNow wrote.
    const rowsDone = await this.rowTurn();
    this.lastFlushAt = this.deps.clock.now();
    this.closedRetryDue = false;
    this.closedIds.clear();
    const docs = [...this.dirty.values()];
    // Not while settling: a thread the file says went may yet come across.
    this.removing = new Set(this.settling ? [] : this.removed);
    let messages = this.messages.splice(0);
    const lists = [...this.dirtyLists];
    this.dirty.clear();
    if (!this.settling) this.removed.clear();
    this.dirtyLists.clear();
    const key = this.deps.key;
    const removedNow = new Set<string>();
    try {
      // What was written is what's remembered as sent, so a row whose
      // share or woke was held back from an older backend goes again once
      // it's new enough (sawBackend).
      const v = this.backendApiVersion ?? 0;
      for (let i = 0; i < docs.length; i += SYNC_BATCH) {
        const batch = docs.slice(i, i + SYNC_BATCH).map((d) => forBackend(d, v, this.deps.clock.now()));
        for (const d of batch) this.writing.set(d.threadId, { digest: digest(JSON.stringify(d)), by: me });
        unsure = batch.map((d) => d.threadId);
        const left = await this.writeRows('sync:upsertThreads', 'threads', batch, (d) => d.threadId, { key });
        unsure = [];
        // A row left out isn't remembered as sent (nor in the cache kept
        // across starts), so its next change, or the next start, tries it again.
        for (const d of batch) {
          this.doneWriting(d.threadId, me);
          if (!left.has(d.threadId)) this.recordSent(d);
          else {
            this.sent.delete(d.threadId);
            this.lastWrite.delete(d.threadId);
            // Its id's old rows still going: tried again shortly, not only on its next change.
            if (this.closedIds.has(d.threadId)) this.closedRows.add(d.threadId);
            this.noteSent();
          }
        }
        this.written += batch.length;
      }
      rowsDone();
      if (this.removing.size) {
        const removed = [...this.removing];
        await this.post('mutation', 'sync:removeThreads', { key, threadIds: removed });
        for (const id of removed) {
          removedNow.add(id);
          this.removing.delete(id);
          this.removedFromFile.delete(id);
          // Its messages went with it: one that turns up again gets its whole history.
          this.filledThreads().delete(id);
        }
        this.noteSent();
      }
      for (const name of lists) {
        const list = this.lists[name];
        if (!list) continue;
        if (name === 'schedules' && this.deps.schedules?.inBackend()) continue;
        if (name === 'projects') {
          await this.sendProjects(list as Project[], v);
          continue;
        }
        if (name === 'accounts') {
          await this.sendAccounts(list as Account[], v);
          continue;
        }
        const rows = (list as Schedule[]).map(toScheduleDoc);
        try {
          await this.post('mutation', `sync:set${name[0]!.toUpperCase()}${name.slice(1)}`, { key, runnerId: this.runnerId, [name]: rows });
        } catch (e) {
          // setSchedules (mirroring a pre-API 9 schedules.json) is the main
          // key's only: a runner key's runner stops mirroring them, quietly,
          // rather than retrying the whole write for ever. Its scheduler
          // puts them in the backend itself once a heartbeat says it can.
          if (name !== 'schedules' || !forbiddenText(e)) throw e;
          this.deps.log.info('not mirroring schedules.json: this runner has a runner key, and its scheduler keeps them in the backend', { error: forbiddenText(e) });
          this.lists.schedules = undefined;
          this.schedulesRefused = true;
        }
      }
      if (this.picturesDue && (this.backendApiVersion ?? 0) >= ICONS_API_VERSION) await this.sendPictures();
      if (this.full) {
        // And those finishing on the release before: their rows aren't stale.
        const keep = [...new Set([...this.deps.runner.list(ALL).map((t) => t.id), ...(this.deps.elsewhereIds?.() ?? [])])];
        await this.post('mutation', 'sync:prune', { key, runnerId: this.runnerId, keep });
        messages.unshift(...(await this.catchUp()));
        this.full = false;
        this.fullAt = this.deps.clock.now();
        this.noteSent();
      } else if (this.catchUpDue) {
        messages.unshift(...this.catchUpFromHeads());
        this.catchUpDue = false;
      }
      // What it finds is written with the next flush (scheduleFlush, below).
      if (this.sharesCheckDue()) await this.reconcileShares(key);
      const { docs: history, threadIds: filling } = this.histories();
      // A new thread's first messages are both live and its history: once each.
      const seen = new Set<string>();
      messages = [...history, ...messages].filter((m) => {
        const k = `${m.threadId}:${m.seq}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const notFilled = await this.appendMessages(messages);
      this.markFilled(filling.filter((id) => !notFilled.has(id)));
      // A message left out of a closed id: its whole history goes again once
      // it opens (histories()), as messages after it may have gone up, and
      // catching up from the newest would never fill the gap.
      this.markUnfilled([...notFilled].filter((id) => this.closedIds.has(id)));
      if (v >= SHARE_API_VERSION) await this.sendShareImages();
      if (v >= REPLY_IMAGES_API_VERSION) await this.sendReplyImages();
      await this.sendBodies(v);
      this.lastSyncAt = this.deps.clock.now();
      this.backoffMs = 0;
      this.retryAt = undefined;
      if (this.lastError) {
        this.deps.log.info('convex sync is back', { url: this.deps.config.url });
        this.lastError = undefined;
        this.lastLogged = undefined;
      }
    } catch (e) {
      // Put back what didn't get written, unless a newer version arrived
      // meanwhile, and try again later; one log line per distinct error.
      // Not written after all: what's due is the thread as it is now, which may
      // have moved on from what failed, or back to what the mirror has. A thread
      // not here any more keeps its row as it was, for the retry.
      // Only this flush's: another writer's may be on its way (above).
      for (const d of docs) this.doneWriting(d.threadId, me);
      // A batch whose write failed may have landed all the same, so what the
      // mirror has of those is no longer known: each is written again as it
      // is now, even if that's back to what was sent before.
      for (const id of unsure) {
        this.sent.delete(id);
        this.lastWrite.delete(id);
      }
      for (const d of docs) {
        try {
          this.mark(this.deps.runner.get(d.threadId), true);
        } catch {
          // Not one this flush took off the backend, or the retry would put it back.
          if (!removedNow.has(d.threadId) && !this.dirty.has(d.threadId) && this.sent.get(d.threadId) !== digest(JSON.stringify(forBackend(d, this.backendApiVersion ?? 0, this.deps.clock.now())))) this.dirty.set(d.threadId, d);
        }
      }
      for (const id of this.removing) this.removed.add(id);
      this.removing.clear();
      for (const name of lists) this.dirtyLists.add(name);
      this.messages.unshift(...messages.filter((m) => !this.messages.some((x) => x.threadId === m.threadId && x.seq === m.seq)));
      this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
      this.retryAt = this.deps.clock.now() + this.backoffMs;
      this.lastError = String((e as Error)?.message ?? e);
      if (this.lastError !== this.lastLogged) {
        this.lastLogged = this.lastError;
        this.deps.log.warn('convex sync failed; will retry', { error: this.lastError, pending: this.dirty.size + this.removed.size + this.messages.length, retryInMs: this.backoffMs });
      }
    } finally {
      this.flushing = false;
      rowsDone();
    }
    this.scheduleFlush();
  }

  // Each project's picture to file storage, once per picture: the mirror
  // says what it has (sync:projectIcons, read once), and only a project
  // whose picture is new or changed is uploaded. A picture that can't be
  // read or drawn is skipped with a warning (the phone shows the symbol or
  // a letter) and tried again when the projects next change; a failed
  // upload throws, so the flush retries with the others.
  private async sendPictures(): Promise<void> {
    const key = this.deps.key;
    if (!this.pictures) {
      const rows = (await this.post('query', 'sync:projectIcons', { key, runnerId: this.runnerId })) as { projectId: string; picture: string }[] | null;
      this.pictures = new Map((rows ?? []).map((r) => [r.projectId, r.picture]));
    }
    const projects = this.lists.projects ?? [];
    for (const p of projects) {
      const image = p.icon?.image;
      if (!image) {
        this.pictures.delete(p.id); // setProjects has dropped it from the mirror
        continue;
      }
      const picture = pictureName(image.path);
      if (this.pictures.get(p.id) === picture) continue;
      let file: { bytes: Uint8Array; mediaType: string } | undefined;
      try {
        file = await phonePicture(image.path, image.mediaType);
      } catch (e) {
        this.deps.log.warn('project picture not sent', { projectId: p.id, path: image.path, error: String((e as Error)?.message ?? e) });
        continue;
      }
      if (this.picturesPaused()) return; // picturesDue stays: they go when the pause is over
      const sent = await this.picture('sync:setProjectIcon', `project ${p.id}`, async () => {
        const url = (await this.post('mutation', 'sync:iconUploadUrl', { key })) as string;
        const storageId = await this.upload(url, file.bytes, file.mediaType);
        await this.post('mutation', 'sync:setProjectIcon', { key, runnerId: this.runnerId, projectId: p.id, picture, storageId, mediaType: file.mediaType });
      });
      if (sent === 'later') return;
      this.pictures.set(p.id, picture);
      if (sent === 'dropped') continue;
      this.deps.log.info('project picture sent', { projectId: p.id, picture, bytes: file.bytes.byteLength });
    }
    const keep = new Set(projects.map((p) => p.id));
    for (const id of [...this.pictures.keys()]) if (!keep.has(id)) this.pictures.delete(id);
    this.picturesDue = false;
  }

  // Shared threads' pictures: drops for threads no longer shared, a look
  // through the whole history of each one just shared, then the uploads.
  // Each step is forgotten only once done, so a failure is picked up by
  // the flush's retry. A file that's gone or too big is skipped with a line
  // in the log; the page shows that picture's alt text, or nothing.
  private async sendShareImages(): Promise<void> {
    const key = this.deps.key;
    for (const threadId of [...this.imagesDrop]) {
      await this.post('mutation', 'sync:dropShareImages', { key, threadId });
      this.imagesDrop.delete(threadId);
    }
    for (const threadId of [...this.imagesDue]) {
      let t: ThreadSummary;
      try {
        t = this.deps.runner.get(threadId);
      } catch {
        // Not here (yet): during a handover the draining runner's updates
        // come through for threads it still has. Forget it was seen, so
        // its update on coming across starts the look through again.
        this.imagesDue.delete(threadId);
        this.sharedNow.delete(threadId);
        continue;
      }
      const rows = (await this.post('query', 'sync:shareImages', { key, threadId })) as { seq: number; path: string }[] | null;
      this.imagesUp.set(threadId, new Set((rows ?? []).map((r) => `${r.seq} ${r.path}`)));
      this.pendingImages.push(...this.imagesOf(t).map((i) => ({ ...i, threadId })));
      this.imagesDue.delete(threadId);
    }
    while (this.pendingImages.length) {
      const img = this.pendingImages[0]!;
      const up = this.imagesUp.get(img.threadId) ?? new Set<string>();
      this.imagesUp.set(img.threadId, up);
      const id = `${img.seq} ${this.scrubber.safeText(img.path)}`;
      if (!up.has(id) && this.sharedNow.get(img.threadId)) {
        // Only real pictures from the thread's own places, typed by their
        // bytes: the page is public, and a path is only what the agent wrote.
        // Only from the thread's media folder: a path in Markdown is only
        // what the agent wrote (docs/protocol.md, "Sharing").
        const file = readShareImage(img.path, this.deps.home ? paths.media(this.deps.home, img.threadId) : undefined);
        if ('skip' in file) {
          this.deps.log.warn('shared picture not sent', { threadId: img.threadId, path: img.path, why: file.skip });
        } else {
          if (this.picturesPaused()) return;
          const sent = await this.picture('sync:addShareImage', `${img.threadId} ${img.path}`, async () => {
            const url = (await this.post('mutation', 'sync:iconUploadUrl', { key })) as string;
            const { mediaType } = file;
            const storageId = await this.upload(url, file.bytes, mediaType);
            const { threadId, seq, path: file_, src } = img;
            const width = file.width ?? img.width;
            const height = file.height ?? img.height;
            this.pictureKept(await this.post('mutation', 'sync:addShareImage', { key, threadId, seq, path: file_, ...(src ? { src } : {}), storageId, mediaType, ...(width ? { width } : {}), ...(height ? { height } : {}) }));
          });
          // Still queued (this one stays first), for after the pause.
          if (sent === 'later') return;
        }
        up.add(id);
      }
      this.pendingImages.shift();
    }
  }

  private cwdOf(threadId: string): string | undefined {
    try {
      return this.deps.runner.get(threadId).cwd;
    } catch {
      // A draining runner's thread that isn't here yet: only a relative
      // pin needs it, and the look through on coming across finds that.
      return undefined;
    }
  }

  // Threads in use that haven't been looked through since this runner
  // started. New pictures go up as they come; this catches ones from before
  // the backend took them and any lost in a restart. On every heartbeat, as
  // a handover brings threads across one at a time.
  private lookForReplyImages(): void {
    if ((this.backendApiVersion ?? 0) < REPLY_IMAGES_API_VERSION || !this.running) return;
    const since = this.deps.clock.now() - REPLY_IMAGES_LOOKBACK_MS;
    for (const t of this.deps.runner.list(ALL)) {
      if (this.replyScanned.has(t.id) || t.archivedAt || Date.parse(t.lastActivityAt) < since) continue;
      this.replyScanned.add(t.id);
      this.replyDue.add(t.id);
    }
    this.scheduleFlush();
  }

  // A few logs' worth of looking, then the uploads. Each picture goes once
  // per message. One that's gone, too big or not a picture is skipped with a
  // line in the log, and the phone says it's on the Mac; a failed upload
  // throws, so the flush retries from that picture.
  private async sendReplyImages(): Promise<void> {
    const key = this.deps.key;
    for (const threadId of [...this.replyDue].slice(0, REPLY_IMAGES_SCANS_PER_FLUSH)) {
      let found: ReplyImage[] = [];
      try {
        found = this.replyImagesOf(this.deps.runner.get(threadId));
      } catch {
        this.replyScanned.delete(threadId); // not here yet: a later heartbeat tries again
      }
      this.pendingReplyImages.push(...found.map((i) => ({ ...i, threadId })));
      this.replyDue.delete(threadId);
    }
    while (this.pendingReplyImages.length) {
      const { threadId, seq, path: file, src, pinned } = this.pendingReplyImages[0]!;
      let up = this.replyUp.get(threadId);
      if (!up) {
        const rows = (await this.post('query', 'sync:replyImages', { key, threadId })) as { seq: number; path: string }[] | null;
        up = new Set((rows ?? []).map((r) => `${r.seq} ${r.path}`));
        this.replyUp.set(threadId, up);
      }
      const id = `${seq} ${this.scrubber.safeText(file)}`;
      if (!up.has(id)) {
        const read = readReplyImage(file);
        if ('skip' in read) {
          this.deps.log.debug('reply picture not sent', { threadId, path: file, why: read.skip });
        } else {
          if (this.picturesPaused()) return;
          const sent = await this.picture('sync:addReplyImage', `${threadId} ${file}`, async () => {
            const url = (await this.post('mutation', 'sync:iconUploadUrl', { key })) as string;
            const storageId = await this.upload(url, read.bytes, read.mediaType);
            const { mediaType, width, height } = read;
            this.pictureKept(await this.post('mutation', 'sync:addReplyImage', { key, threadId, seq, path: file, ...(src ? { src } : {}), ...(pinned ? { pinned } : {}), storageId, mediaType, ...(width ? { width } : {}), ...(height ? { height } : {}) }));
          });
          if (sent === 'later') return;
        }
        up.add(id);
      }
      this.pendingReplyImages.shift();
    }
  }

  private replyImagesOf(t: ThreadSummary): ReplyImage[] {
    const out: ReplyImage[] = [];
    let after = 0;
    while (t.lastSeq > after) {
      const { events } = this.deps.runner.events(t.id, { afterSeq: after, limit: BACKFILL_EVENTS });
      const next = events.at(-1)?.seq ?? after;
      if (next <= after) break;
      for (const e of events) if (e.seq > after) out.push(...replyImagesInEvent(e, t.cwd));
      after = next;
    }
    return out;
  }

  // Every picture in a thread's history, read from its log a page at a time.
  private imagesOf(t: ThreadSummary): ShareImage[] {
    const out: ShareImage[] = [];
    let after = 0;
    while (t.lastSeq > after) {
      let events: PersistedEvent[];
      try {
        events = this.deps.runner.events(t.id, { afterSeq: after, limit: BACKFILL_EVENTS }).events;
      } catch {
        break;
      }
      const next = events.at(-1)?.seq ?? after;
      if (next <= after) break;
      for (const e of events) if (e.seq > after) out.push(...imagesInEvent(e));
      after = next;
    }
    return out;
  }

  // An assistant row with the buttons its text links, in the order it links
  // them. An id the thread has no button for is left off: the apps draw that
  // link as its title.
  private withButtons(m: MessageDoc): MessageDoc {
    if (m.role !== 'assistant' || !this.deps.runner.buttons || !m.text.includes('](button:')) return m;
    const ids = linkedButtonIds(m.text);
    if (!ids.length) return m;
    let all: ReplyButton[];
    try {
      all = this.deps.runner.buttons(m.threadId);
    } catch {
      return m;
    }
    const buttons = ids.map((id) => all.find((b) => b.id === id)).filter((b): b is ReplyButton => Boolean(b)).map(messageButton);
    const { buttons: _old, wokeBy: _w, pagedAt: _p, ...plain } = m;
    for (const b of buttons) this.rememberButtonRow(`${m.threadId} ${b.id}`, plain);
    return buttons.length ? { ...m, buttons } : m;
  }

  private rememberButtonRow(k: string, m: MessageDoc): void {
    this.buttonRows.delete(k);
    this.buttonRows.set(k, m);
    while (this.buttonRows.size > BUTTON_ROWS) this.buttonRows.delete(this.buttonRows.keys().next().value!);
  }

  // A button pressed (or failed): the row that links it goes up again with
  // its new state. Made, it has nothing to change, as the reply that links it
  // comes after. A row from before this start is looked for in the thread's
  // recent events, as a daily brief's buttons are pressed hours later.
  private onButton(threadId: string, b: ReplyButton): void {
    if (!b.pressed && !b.failed) return;
    if ((this.backendApiVersion ?? 0) < BUTTONS_API_VERSION) return;
    const k = `${threadId} ${b.id}`;
    let row = this.buttonRows.get(k);
    if (!row) {
      row = this.findButtonRow(threadId, b.id);
      if (!row) return;
    }
    this.messages.push(row);
    this.scheduleFlush();
  }

  private findButtonRow(threadId: string, buttonId: string): MessageDoc | undefined {
    const link = `](button:${buttonId})`;
    let before: number | undefined;
    let read = 0;
    const cuts = this.deps.runner.cuts?.(threadId) ?? [];
    while (read < BUTTON_SCAN_EVENTS) {
      let events: PersistedEvent[];
      try {
        events = this.deps.runner.events(threadId, { ...(before !== undefined ? { beforeSeq: before } : {}), limit: 500 }).events;
      } catch {
        return undefined;
      }
      if (!events.length) return undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!;
        if (e.type !== 'assistant.text' || !e.text.includes(link) || cuts.some((c) => e.seq >= c.from && e.seq <= c.to)) continue;
        return toMessageDoc(threadId, e, this.scrubber.safeText);
      }
      read += events.length;
      const first = events[0]!.seq;
      if (before !== undefined && first >= before) return undefined;
      before = first;
      if (first <= 1) return undefined;
    }
    return undefined;
  }

  // The threads with a message left out, so their history isn't counted as up.
  private async appendMessages(all: MessageDoc[]): Promise<Set<string>> {
    const notFilled = new Set<string>();
    // A backend from before API 2 can't take tool rows; it's deployed before
    // the runner, so this only matters when that deploy was skipped.
    const v = this.backendApiVersion;
    let messages = v !== undefined && v < 2 ? all.filter((m) => m.role !== 'tool') : all;
    // Before API 14 the validator has no `summary`; the bullets go as text.
    if (v === undefined || v < ASKS_API_VERSION) messages = messages.map((m) => (m.summary ? (({ summary, ...rest }) => rest)(m) : m));
    if (v === undefined || v < TURNS_API_VERSION) messages = messages.map((m) => (m.turn ? (({ turn, ...rest }) => rest)(m) : m));
    if (v === undefined || v < WOKE_BY_API_VERSION) messages = messages.map((m) => (m.wokeBy ? (({ wokeBy, ...rest }) => rest)(m) : m));
    // The buttons' state as it is now, not when the row was made: a press
    // while the row waited would otherwise go up stale.
    if (v !== undefined && v >= BUTTONS_API_VERSION) messages = messages.map((m) => this.withButtons(m));
    for (let i = 0; i < messages.length; i += MESSAGE_BATCH) {
      const batch = messages.slice(i, i + MESSAGE_BATCH);
      const left = await this.writeRows('sync:appendMessages', 'messages', batch, (m) => `${m.threadId}:${m.seq}`, { key: this.deps.key });
      this.messagesWritten += batch.length - left.size;
      // A message left out isn't sent: its thread's head stops before it, so
      // the next start sends it (and what follows) again.
      const stop = new Map<string, number>();
      for (const id of left) {
        const at = id.lastIndexOf(':');
        const threadId = id.slice(0, at);
        const seq = Number(id.slice(at + 1));
        stop.set(threadId, Math.min(stop.get(threadId) ?? Infinity, seq));
        notFilled.add(threadId);
      }
      for (const m of batch) if (m.seq < (stop.get(m.threadId) ?? Infinity) && m.seq > (this.heads.get(m.threadId) ?? 0)) this.heads.set(m.threadId, m.seq);
      this.noteSent();
    }
    return notFilled;
  }

  // At start, what's newer than the mirror's newest message, for threads
  // whose whole history is already up (the others are histories()' job).
  private async catchUp(): Promise<MessageDoc[]> {
    const filled = this.filledThreads();
    if (!filled.size) return [];
    const heads = (await this.post('query', 'sync:messageHeads', { key: this.deps.key, runnerId: this.runnerId })) as { threadId: string; lastSeq: number }[] | null;
    const have = new Map((heads ?? []).map((h) => [h.threadId, h.lastSeq]));
    for (const [id, seq] of have) if (seq > (this.heads.get(id) ?? 0)) this.heads.set(id, seq);
    const out: MessageDoc[] = [];
    for (const t of this.deps.runner.list(ALL)) {
      if (filled.has(t.id)) out.push(...this.messagesAfter(t, have.get(t.id) ?? 0));
    }
    return out;
  }

  // The same, from what the last start noted (sync-cache.ts), so a start
  // doesn't read a row and a message per thread to find it out.
  private catchUpFromHeads(): MessageDoc[] {
    const filled = this.filledThreads();
    const out: MessageDoc[] = [];
    for (const t of this.deps.runner.list(ALL)) {
      if (filled.has(t.id)) out.push(...this.messagesAfter(t, this.heads.get(t.id) ?? 0));
    }
    return out;
  }

  // Each thread's whole history goes up once per deployment (text and tool
  // rows; until backend API 2 only the newest 20 text messages did), and
  // statePath records which threads are done. Checked on every flush rather
  // than only at start: a restart hands threads over from the old runner one
  // at a time, and one that wasn't here yet at start (or whose log couldn't
  // be read) is caught on a later flush. Writing a message twice is harmless.
  private histories(): { docs: MessageDoc[]; threadIds: string[] } {
    const filled = this.filledThreads();
    const docs: MessageDoc[] = [];
    const threadIds: string[] = [];
    for (const t of this.deps.runner.list(ALL)) {
      if (filled.has(t.id) || this.closedHistories.has(t.id)) continue;
      const got = this.messagesAfter(t, 0, true);
      if (!got) continue;
      docs.push(...got);
      threadIds.push(t.id);
    }
    return { docs, threadIds };
  }

  // A thread's messages after a seq, read from its log a page at a time.
  // With strict, undefined when the log can't be read (so it isn't counted
  // as done); otherwise what could be read.
  private messagesAfter(t: ThreadSummary, after: number, strict: true): MessageDoc[] | undefined;
  private messagesAfter(t: ThreadSummary, after: number): MessageDoc[];
  private messagesAfter(t: ThreadSummary, after: number, strict = false): MessageDoc[] | undefined {
    // An archived thread's folder isn't watched, but its history still goes up.
    if (t.lastSeq > after) this.scrubber.known.noteFolder(t.cwd, true);
    const out: MessageDoc[] = [];
    const woke = new WokeRows();
    while (t.lastSeq > after) {
      let events: PersistedEvent[];
      try {
        events = this.deps.runner.events(t.id, { afterSeq: after, limit: BACKFILL_EVENTS }).events;
      } catch {
        return strict ? undefined : out;
      }
      // Stops if a page doesn't move forward, so a log that disagrees with
      // the summary's lastSeq can't loop forever.
      const next = events.at(-1)?.seq ?? after;
      if (next <= after) break;
      const cuts = this.deps.runner.cuts?.(t.id) ?? [];
      for (const e of events) {
        if (e.seq <= after || cuts.some((c) => e.seq >= c.from && e.seq <= c.to)) continue;
        woke.see(e);
        const m = toMessageDoc(t.id, e, this.scrubber.safeText);
        if (m) out.push(woke.take(m, e));
      }
      after = next;
    }
    return out;
  }

  // Which threads' whole history is up on this deployment, from statePath
  // ({ histories: { [url]: threadId[] } }); kept in memory once read.
  private filled?: Set<string>;

  private filledThreads(): Set<string> {
    if (this.filled) return this.filled;
    let ids: string[] = [];
    if (this.deps.statePath) {
      try {
        const state = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8')) as { histories?: Record<string, string[]> };
        ids = state.histories?.[this.deps.config.url ?? ''] ?? [];
      } catch {
        // none yet
      }
    }
    this.filled = new Set(ids);
    return this.filled;
  }

  // After the append that carried them went through.
  private markFilled(threadIds: string[]): void {
    if (!threadIds.length) return;
    const filled = this.filledThreads();
    for (const id of threadIds) filled.add(id);
    this.saveFilled();
  }

  private markUnfilled(threadIds: string[]): void {
    const filled = this.filledThreads();
    const had = threadIds.filter((id) => filled.delete(id));
    for (const id of threadIds) this.closedHistories.add(id);
    // The timer the closed answer set may have fired already, in a long flush.
    if (threadIds.length) this.retryClosedLater();
    if (had.length) this.saveFilled();
  }

  private saveFilled(): void {
    const filled = this.filledThreads();
    if (!this.deps.statePath) return;
    try {
      let state: { histories?: Record<string, string[]> } = {};
      try {
        state = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf8'));
      } catch {
        // first write
      }
      // Only threads that still exist, so the file doesn't grow for ever.
      const live = new Set(this.deps.runner.list(ALL).map((t) => t.id));
      const histories = { ...(state.histories ?? {}), [this.deps.config.url ?? '']: [...filled].filter((id) => live.has(id)) };
      fs.writeFileSync(this.deps.statePath, JSON.stringify({ histories }, null, 2) + '\n');
    } catch (e) {
      this.deps.log.warn('could not record which histories are up', { error: String(e) });
    }
  }

  // Sends presence when it changes (and once at start); a failed send is
  // tried again on the next check.
  private async checkPresence(): Promise<void> {
    if (!this.running || !this.deps.presence) return;
    let atMac: boolean;
    try {
      atMac = await this.deps.presence();
    } catch {
      atMac = false;
    }
    // Stopped while the check ran (ioreg can take seconds on a busy Mac).
    if (!this.running) return;
    if (atMac !== this.sentAtMac) {
      void this.post('mutation', 'sync:setPresence', { key: this.deps.key, runnerId: this.runnerId, atMac }).then(
        () => {
          this.sentAtMac = atMac;
        },
        (e) => this.deps.log.debug('convex presence failed', { error: String(e) }),
      );
    }
    this.presenceTimer = this.deps.clock.setTimeout(() => void this.checkPresence(), PRESENCE_MS);
  }

  private heartbeat(): void {
    if (!this.running) return;
    this.scrubber.known.refreshIfDue();
    const runner = {
      runnerId: this.runnerId,
      name: this.name,
      version: this.deps.version,
      ...(this.deps.release ? { release: this.deps.release } : {}),
      startedAt: this.deps.startedAt,
      draining: false,
      threadCount: this.deps.runner.list(ALL).length,
      ...(this.deps.config.icon && (this.backendApiVersion ?? 0) >= RUNNER_ICON_API_VERSION ? { icon: this.deps.config.icon } : {}),
      ...(this.deps.config.rpcUrl && (this.backendApiVersion ?? 0) >= THREAD_INDEX_API_VERSION ? { rpcUrl: this.deps.config.rpcUrl } : {}),
      ...(this.stats?.pressure && (this.backendApiVersion ?? 0) >= RUNNER_STATS_API_VERSION ? { pressure: this.stats.pressure } : {}),
    };
    void this.post('mutation', 'sync:heartbeat', { key: this.deps.key, runner }).then(
      (r) => {
        this.sawBackend(r);
        // A start whose first flush went before a heartbeat said the
        // backend can list the shared rows checks them now.
        if (this.sharesCheckDue()) this.scheduleFlush();
        this.keyRejected = false;
        this.ownerKeyRotating = (r as { ownerKeyRotating?: unknown } | null)?.ownerKeyRotating === true;
        this.pushOff = (r as { pushOff?: unknown } | null)?.pushOff === true;
        this.notePushFailing(asPushFailing((r as { pushFailing?: unknown } | null)?.pushFailing));
        this.lookForReplyImages();
        if ((this.backendApiVersion ?? 0) >= SCHEDULES_API_VERSION && this.running) void this.deps.schedules?.attach(this.scheduleBackend());
        if ((this.backendApiVersion ?? 0) >= SHARED_POOLS_API_VERSION && this.running) this.deps.pools?.attach(this.poolBackend());
        if ((this.backendApiVersion ?? 0) >= SHARED_USAGE_API_VERSION && this.running) this.followSharedUsage();
        if ((this.backendApiVersion ?? 0) >= THREAD_INDEX_API_VERSION && this.running) this.index?.start();
        if ((this.backendApiVersion ?? 0) >= RUNNER_STATS_API_VERSION && this.running) this.startStats();
      },
      (e) => {
        // A key that isn't this runner's (runner.json's sync.runnerId isn't
        // the one `tb runner add` made it for) fails every heartbeat: said
        // once, loudly, as nothing else here would show it.
        if (keyRejected(e)) this.onKeyRejected();
        const refused = forbiddenText(e);
        // Forbidden too: a runner moved onto its own key while the main key
        // still works has its main-key heartbeat refused that way.
        if (refused || this.keyRejected) this.restartIfNewKey();
        if (refused && refused !== this.heartbeatRefused) this.deps.log.warn('convex heartbeat refused: this runner key is for another runner', { error: refused, runnerId: this.runnerId });
        else if (!refused && !this.keyRejected) this.deps.log.debug('convex heartbeat failed', { error: String(e) });
        this.heartbeatRefused = refused;
        // The version from the file may be why: a heartbeat with a field an
        // older backend's validator refuses can never learn better. Going
        // back to assuming nothing is what a start without the file does.
        // Only that: while a network blip lasted, this would leave `turn` and
        // the like off message rows, and they're never written again.
        if (!this.backendHeard && /validat/i.test(String(e))) this.backendApiVersion = undefined;
      },
    );
    if (this.deps.clock.now() - this.sharesCheckedAt >= SHARE_RECONCILE_MS && !this.sharesDue) {
      this.sharesDue = true;
      this.scheduleFlush();
    }
    this.heartbeatTimer = this.deps.clock.setTimeout(() => this.heartbeat(), HEARTBEAT_MS);
  }

  // The backend turned the key down. Said once (an error in the log, which
  // reaches Sentry from a real install, and a notice for the app), not a
  // warning a minute. Then, as for a forbidden heartbeat: if
  // secrets/convex-key now holds another key (tb runner add wrote one over
  // ssh), restart onto it, as the key is read at start and nobody may be
  // at that Mac to restart it.
  private onKeyRejected(): void {
    if (!this.keyRejected) {
      this.keyRejected = true;
      this.deps.log.error('convex turned down this runner\'s key', { runnerId: this.runnerId });
      this.deps.notice?.('error', KEY_REJECTED);
    }
  }

  // Said once per failing run (a new `since`), as a warning in the log and
  // a notice for the app, not every minute's heartbeat; and once when it
  // clears.
  private notePushFailing(p: PushFailing | undefined): void {
    const was = this.pushFailing;
    this.pushFailing = p;
    if (p && p.since !== was?.since) {
      this.deps.log.warn('phone notifications are failing', { failure: p.failure, failed: p.failed, via: p.via });
      this.deps.notice?.('warning', pushFailingText(p));
    } else if (!p && was) this.deps.log.info('phone notifications are getting through again');
  }

  private restartIfNewKey(): void {
    let now: string | undefined;
    try {
      now = this.deps.readKey?.();
    } catch {
      return;
    }
    if (now && now !== this.deps.key && !this.restartAsked) {
      this.restartAsked = true;
      this.deps.log.info('restarting onto the new key in secrets/convex-key', { runnerId: this.runnerId });
      this.deps.restart?.('new convex key');
    }
  }

  /** Other runners' threads as last heard, for relay.ts. */
  remoteNow(): RemoteThreads {
    return this.index?.current() ?? { runners: [], threads: [] };
  }

  /**
   * What relay.ts reads and queues with: this runner's link to the backend,
   * with the owner key only (a runner key can't read other runners' threads).
   * Undefined with sync off or before the backend is at RELAY_API_VERSION.
   */
  relaySource(): { post: Post; subscribe?: Subscribe; key: string } | undefined {
    if (this.off || !this.deps.key || (this.backendApiVersion ?? 0) < RELAY_API_VERSION) return undefined;
    const subscriber = this.subscriber;
    return {
      post: (kind, fn, args) => this.post(kind, fn, args),
      ...(subscriber ? { subscribe: (fn: string, args: Record<string, unknown>, onUpdate: (v: unknown) => void, onError: (e: Error) => void) => subscriber.subscribe(fn, args, onUpdate, onError) } : {}),
      key: this.deps.key,
    };
  }

  private startStats(): void {
    const { sample, key } = this.deps;
    const subscriber = this.subscriber;
    if (!sample || !subscriber) return;
    this.stats ??= new RunnerStats({
      sample,
      key,
      runnerId: this.runnerId,
      post: (fn, args) => this.post('mutation', fn, args),
      subscribe: (fn, args, onUpdate, onError) => subscriber.subscribe(fn, args, onUpdate, onError),
      clock: this.deps.clock,
      log: this.deps.log,
    });
    this.stats.start();
  }

  // ------------------------------------------------------------ runner figures

  private statsWatchSentAt = 0;
  private statsForbidden = false;

  /**
   * runners.stats: each runner's latest CPU, memory and disk, for the Mac
   * app's Runners panel while a runner's details are open. Asking marks the
   * figures wanted, as the website's Runners view does (runner-stats.ts), so
   * every runner reports every few seconds until nobody asks for a while.
   * Empty with sync off, on an older backend, or on a runner key, which
   * can't see other runners.
   */
  async runnerStats(): Promise<RunnerStatsRow[]> {
    if (!this.running || this.statsForbidden || (this.backendApiVersion ?? 0) < MAC_RUNNER_STATS_API_VERSION) return [];
    const key = this.deps.key;
    const now = this.deps.clock.now();
    // The watch lasts 45 s in the backend; once every 20 s keeps it going
    // through a slow answer without a write on every ask.
    if (now - this.statsWatchSentAt >= STATS_WATCH_EVERY_MS) {
      this.statsWatchSentAt = now;
      void this.post('mutation', 'sync:watchRunnersFromMac', { key }).catch((e) => {
        this.statsWatchSentAt = 0;
        this.deps.log.debug('runner watch failed', { error: String(e) });
      });
    }
    try {
      const rows = await this.post('query', 'sync:runnerStatsList', { key });
      return Array.isArray(rows) ? (rows as RunnerStatsRow[]) : [];
    } catch (e) {
      if (forbiddenText(e)) {
        this.statsForbidden = true;
        return [];
      }
      throw e;
    }
  }

  /** Whether remoteThreads has heard from the backend (ThreadIndex.heard); true with sync off, as there's nothing to wait for. */
  remoteHeard(): boolean {
    return this.index?.heard() ?? true;
  }

  /** remoteThreads.list: other runners' threads, empty with sync off. */
  remoteThreads(): RemoteThreads {
    return this.index?.list() ?? { runners: [], threads: [] };
  }

  // ------------------------------------------------------------ schedules

  private schedulesTable?: ScheduleBackend;

  // The backend's schedules table for the scheduler (SCHEDULES_API_VERSION).
  // `holder` names this runner process, so a claim taken by the release
  // that's draining isn't this one's.
  scheduleBackend(): ScheduleBackend {
    if (this.schedulesTable) return this.schedulesTable;
    const key = this.deps.key;
    const runnerId = this.runnerId;
    const holder = `${runnerId}:${process.pid}:${this.deps.startedAt}`;
    const call = (kind: 'mutation' | 'query', fn: string, args: Record<string, unknown>) => this.backend(kind, fn, { key, ...args });
    this.schedulesTable = {
      subscribe: (onRows, onError) => {
        if (!this.subscriber) {
          onError(new Error('sync is off'));
          return () => {};
        }
        const subscriber = this.subscriber;
        if ((this.backendApiVersion ?? 0) >= SCHEDULES_FOLLOW_API_VERSION) {
          return followSchedules<StoredSchedule>((fn, args, onUpdate, fail) => subscriber.subscribe(fn, args, onUpdate, fail), key, onRows, onError);
        }
        return subscriber.subscribe('sync:schedules', { key }, (v) => onRows(Array.isArray(v) ? (v as StoredSchedule[]) : []), onError);
      },
      save: async (sc) => {
        await call('mutation', 'sync:saveSchedule', { schedule: toOwnedScheduleDoc(sc, this.backendApiVersion ?? 0) });
      },
      remove: async (scheduleId) => {
        await call('mutation', 'sync:deleteSchedule', { scheduleId });
      },
      adopt: async (rows) => (await call('mutation', 'sync:adoptSchedules', { runnerId, schedules: rows.map((r) => toOwnedScheduleDoc(r, this.backendApiVersion ?? 0)) })) as { held?: { id: string; why: string }[] } | null ?? undefined,
      claim: async (scheduleId, kind, expect) => (await call('mutation', 'sync:claimSchedule', { runnerId, scheduleId, holder, kind, expect })) === true,
      release: async (scheduleId) => {
        await call('mutation', 'sync:releaseSchedule', { scheduleId, holder });
      },
      ran: async (p) => {
        await call('mutation', 'sync:scheduleRan', { holder, ...p });
      },
      requestRun: async (scheduleId, at) => (await call('mutation', 'sync:requestScheduleRun', { scheduleId, at })) === true,
      runners: async () => {
        // Only the main key may list runners (docs/protocol.md, "Runner keys"), so
        // a runner key's asking only ever failed, 11 times in 25 minutes of prod
        // logs, and the callers treat this the same as being refused.
        if (this.deps.key?.startsWith('tbr_')) return [];
        const rows = await call('query', 'sync:runnersList', {});
        return Array.isArray(rows)
          ? (rows as { runnerId: string; name: string; lastSeenAt: number; icon?: string; version?: string; release?: string; startedAt?: string; draining?: boolean }[]).map((r) => ({
              id: r.runnerId,
              name: r.name,
              lastSeenAt: r.lastSeenAt,
              ...(r.icon ? { icon: r.icon } : {}),
              ...(r.version ? { version: r.version } : {}),
              ...(r.release ? { release: r.release } : {}),
              ...(r.startedAt ? { startedAt: r.startedAt } : {}),
              ...(r.draining ? { draining: true } : {}),
            }))
          : [];
      },
    };
    return this.schedulesTable;
  }

  // ------------------------------------------------------------ shared usage

  private sharedUsageTimer?: TimerHandle;
  private sharedUsageAsked?: string;

  // Every runner's readings, less this runner's own, to the usage store,
  // read every SHARED_USAGE_POLL_MS. Each reading's readAt keeps a copy of
  // a copy from winning over the reading it came from. Polled rather than
  // subscribed (6 Nov): a subscription re-ran on every login write from
  // every other runner, 78 runs in 20 minutes with four runners and the
  // biggest read cost left; a poll costs the same whatever they write. A
  // reading from another machine is at most a poll old, and a runner always
  // has its own at once.
  private followSharedUsage(): void {
    if (!this.deps.sharedUsage) return;
    // A heartbeat calls this each time: started once, and again only when
    // the backend has come to take the runner's id since.
    const args = sharedUsageArgs(this.deps.key, this.runnerId, this.backendApiVersion ?? 0);
    const asked = JSON.stringify(args);
    if (this.sharedUsageTimer && this.sharedUsageAsked === asked) return;
    this.sharedUsageTimer?.cancel();
    this.sharedUsageAsked = asked;
    const mine = this.runnerId;
    const poll = async (): Promise<void> => {
      if (!this.running || this.sharedUsageAsked !== asked) return;
      try {
        const v = await this.backend('query', 'sync:sharedUsage', args);
        this.deps.sharedUsage?.setShared((Array.isArray(v) ? (v as SharedReading[]) : []).filter((r) => r.runnerId !== mine));
      } catch (e) {
        this.deps.log.debug('shared usage read failed', { error: String(e) });
      }
      if (this.running && this.sharedUsageAsked === asked) this.sharedUsageTimer = this.deps.clock.setTimeout(() => void poll(), SHARED_USAGE_POLL_MS);
    };
    this.sharedUsageTimer = this.deps.clock.setTimeout(() => void poll(), 0);
  }

  // ------------------------------------------------------------ pools

  private poolsTable?: PoolBackend;

  // The backend's shared pools (SHARED_POOLS_API_VERSION) for shared-pools.ts.
  poolBackend(): PoolBackend {
    if (this.poolsTable) return this.poolsTable;
    const key = this.deps.key;
    const runnerId = this.runnerId;
    this.poolsTable = {
      subscribe: (onRows, onError) => {
        if (!this.subscriber) {
          onError(new Error('sync is off'));
          return () => {};
        }
        return this.subscriber.subscribe('sync:pools', { key }, (v) => onRows(Array.isArray(v) ? (v as SharedPool[]) : []), onError);
      },
      save: async (pools) => {
        await this.backend('mutation', 'sync:savePools', { key, runnerId, pools });
      },
      // adoptPools is the main key's (docs/protocol.md, "Runner keys"): on a
      // runner key it's "not taken", and this runner follows the main Mac's.
      adopt: async (pools) => {
        try {
          return (await this.backend('mutation', 'sync:adoptPools', { key, runnerId, pools })) === true;
        } catch (e) {
          if (/runner's key can't/.test(String((e as Error)?.message))) return false;
          throw e;
        }
      },
    };
    return this.poolsTable;
  }

  // ------------------------------------------------------------ commands

  private listenForCommands(): void {
    if (!this.deps.commands || !this.subscriber) return;
    try {
      this.unsubCommands = this.subscriber.subscribe(
        'sync:pendingCommands',
        { key: this.deps.key, runnerId: this.runnerId },
        (value) => {
          this.commandsState = 'on';
          void this.takeCommands(Array.isArray(value) ? (value as Command[]) : []);
        },
        (error) => {
          this.commandsState = 'error';
          this.commandError = String(error?.message ?? error);
          this.deps.log.warn('convex command subscription failed', { error: this.commandError });
        },
      );
      this.commandsState = 'on';
    } catch (e) {
      this.commandsState = 'error';
      this.commandError = String((e as Error)?.message ?? e);
      this.deps.log.warn('could not subscribe to convex commands', { error: this.commandError });
    }
  }

  // Each pending command once: takeCommand says no if another runner (or
  // an earlier update of the same list) already has it.
  private async takeCommands(commands: Command[]): Promise<void> {
    for (const c of commands) {
      if (!this.running || this.inFlight.has(c.commandId)) continue;
      this.inFlight.add(c.commandId);
      try {
        const taken = await this.post('mutation', 'sync:takeCommand', { key: this.deps.key, commandId: c.commandId });
        if (taken !== true) continue;
        let resultThreadId: string | undefined;
        let result: unknown;
        let note: string | undefined;
        let ok = true;
        try {
          ({ threadId: resultThreadId, result } = (await this.apply(c)) ?? {});
          this.applied++;
        } catch (e) {
          ok = false;
          note = String((e as Error)?.message ?? e);
          this.failed++;
          this.commandError = note;
          // The phone can still show a thread for a moment after it's
          // deleted: its command failing then is a race, not a problem.
          if ((e as { code?: unknown })?.code === ErrorCode.threadNotFound) this.deps.log.info('phone command for a thread that has gone', { kind: c.kind, threadId: c.threadId });
          else this.deps.log.warn('phone command failed', { kind: c.kind, threadId: c.threadId, error: note });
        }
        if (resultThreadId) await this.writeRowNow(resultThreadId);
        await this.post('mutation', 'sync:finishCommand', { key: this.deps.key, commandId: c.commandId, ok, ...(note ? { note } : {}), ...(resultThreadId ? { resultThreadId } : {}), ...(result !== undefined ? { result: JSON.stringify(result) } : {}) });
      } catch (e) {
        // Couldn't take or finish it: the next update of the list brings
        // it round again if it's still pending.
        this.deps.log.debug('phone command not taken', { commandId: c.commandId, error: String(e) });
      } finally {
        this.inFlight.delete(c.commandId);
      }
    }
  }

  // Fetches a command's photos into inbox/ for as long as the send takes:
  // the runner copies them into the thread's media folder as it takes the
  // message, and a draining runner does the same on this Mac.
  private async withPhoneImages<T>(raw: unknown, send: (images: ImageRef[]) => T | Promise<T>): Promise<T> {
    const wanted = Array.isArray(raw) ? (raw as { url?: unknown }[]) : [];
    if (!wanted.length) return send([]);
    const dir = paths.inbox(this.deps.home ?? os.tmpdir());
    const download = this.deps.download ?? convexDownloader();
    const images: ImageRef[] = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const { url } of wanted) {
        if (typeof url !== 'string') throw new Error('a photo has no address');
        const bytes = Buffer.from(await download(url));
        const info = sniffImage(bytes);
        if (!info) throw new Error('that photo is not an image');
        const file = path.join(dir, `phone-${crypto.randomUUID()}.${extForMediaType(info.mediaType)}`);
        fs.writeFileSync(file, bytes);
        images.push({ path: file, mediaType: info.mediaType });
      }
      return await send(images);
    } finally {
      for (const { path: file } of images) fs.rmSync(file, { force: true });
    }
  }

  // The phone saw a question as it was scrubbed, so its answer may name the
  // question, or pick an option, in scrubbed words. The CLI wants the real ones.
  private realAnswers(threadId: string, approvalId: unknown, answers: Record<string, string>): Record<string, string> {
    // The card it answers, which a newer one may have pushed off the row.
    const pending = [this.pending.get(threadId), ...(this.cardsBehind.get(threadId) ?? [])].find((c) => c?.approvalId === approvalId);
    if (pending?.kind !== 'question') return answers;
    const out = { ...answers };
    for (const q of pending.questions) {
      const seen = this.scrubber.safeText(q.question);
      if (seen !== q.question && out[seen] !== undefined && out[q.question] === undefined) {
        out[q.question] = out[seen]!;
        delete out[seen];
      }
      // Several picks arrive joined with ", ", and a label can hold a comma.
      const picked = out[q.question];
      if (picked === undefined) continue;
      let answer = picked;
      for (const o of q.options ?? []) {
        const seenLabel = this.scrubber.safeText(o.label);
        if (seenLabel !== o.label) answer = answer.split(seenLabel).join(o.label);
      }
      out[q.question] = answer;
    }
    return out;
  }

  // Applies one command through the runner; returns the new thread's id
  // for a create or a quickAsk. Throws with a readable message for the phone.
  private async apply(c: Command): Promise<{ threadId?: string; result?: unknown } | undefined> {
    const host = this.deps.commands!;
    const a = c.args ?? {};
    // Sent from the main Mac through the backend (convex/relay.ts): Mike at a
    // Mac, not the phone, so his message isn't marked as the phone's.
    const origin = a.from === 'mac' ? {} : { origin: 'phone' as const };
    const threadId = c.threadId;
    const needThread = (): string => {
      if (!threadId) throw new Error('no thread');
      return threadId;
    };
    switch (c.kind) {
      case 'send': {
        const text = commandText(a);
        await this.withPhoneImages(a.images, (images) => host.send(needThread(), text, images, { ...origin, ...(phoneAnswers(a.answers) ? { answers: phoneAnswers(a.answers) } : {}) }));
        return undefined;
      }
      case 'respond': {
        if (a.secret === true) {
          // docs/protocol.md, "Secrets": opened here, so the value never
          // touched the backend in the clear.
          const approvalId = String(a.approvalId);
          if (a.decision === 'deny') {
            await host.answerSecret({ threadId: needThread(), approvalId, decline: true });
            return undefined;
          }
          const box = this.deps.secretBox;
          if (!box || !isSealed(a.sealed)) throw new Error("The phone's answer couldn't be opened. Answer it on the Mac.");
          await host.answerSecret({ threadId: needThread(), approvalId, secret: box.open(a.sealed, approvalId) });
          return undefined;
        }
        const decision = a.decision as ApprovalDecision;
        if (!['allow', 'allowAlways', 'deny', 'answered'].includes(decision)) throw new Error(`bad decision ${String(a.decision)}`);
        // Only what the card that went up offered, whoever sends it. A
        // request for a thread elsewhere (START_CARD) goes up with no options
        // and is answered by the main Mac's runner, which checks it itself.
        const card = this.pending.get(needThread());
        if (card?.kind === 'approval' && card.approvalId === String(a.approvalId) && card.name !== START_CARD && !card.options.includes(decision as ApprovalOption)) {
          throw new Error(REMOTE_ALLOW_REFUSED);
        }
        await host.respondApproval({
          threadId: needThread(),
          approvalId: String(a.approvalId),
          decision,
          remote: true,
          ...(typeof a.message === 'string' ? { message: a.message } : {}),
          ...(a.answers && typeof a.answers === 'object' ? { answers: this.realAnswers(needThread(), a.approvalId, a.answers as Record<string, string>) } : {}),
        });
        return undefined;
      }
      case 'update': {
        const id = needThread();
        if (a.snooze && typeof a.snooze === 'object') {
          const s = a.snooze as { until?: string; untilRestart?: boolean };
          await host.update({ threadId: id, snoozedUntil: s.untilRestart ? 'restart' : s.until ?? null });
        } else if (a.wake) await host.update({ threadId: id, snoozedUntil: null });
        else if (a.archive) {
          // A verdict still rides along if sent (backend API 42), though no app sends one now.
          const verdict = ARCHIVE_VERDICTS.includes(a.verdict as ArchiveVerdict) ? { verdict: a.verdict as ArchiveVerdict } : {};
          // `by: "agent"`: an agent on the main Mac archived it (relay.ts).
          await host.update({ threadId: id, archived: true, ...verdict, ...(a.by === 'agent' ? { archivedBy: 'agent' as const } : {}) });
        }
        else if (a.unarchive) await host.update({ threadId: id, archived: false });
        else if (a.markSeen) await host.markSeen(id);
        else if (typeof a.star === 'boolean') await host.update({ threadId: id, starred: a.star });
        else if (typeof a.title === 'string') await host.update({ threadId: id, title: a.title });
        else throw new Error('nothing to change');
        return undefined;
      }
      case 'create': {
        const text = commandText(a);
        // Before anything is made: a mode it can't read refuses the
        // command rather than starting on full access.
        const mode = remoteCreateModeOf(a);
        const { thread } = await this.withPhoneImages(a.images, (images) => host.create({
          text,
          ...(images.length ? { images } : {}),
          ...(typeof a.cwd === 'string' ? { cwd: a.cwd } : {}),
          ...(typeof a.accountId === 'string' ? { accountId: a.accountId } : {}),
          ...(typeof a.model === 'string' ? { model: a.model } : {}),
          ...(isEffortLevel(a.effort) ? { effort: a.effort } : {}),
          ...(mode ? { permissionMode: mode } : {}),
          ...origin,
        }));
        return { threadId: thread.id };
      }
      case 'quickAsk': {
        // A quick ask the phone answered itself (API 9), kept as a thread.
        if (typeof a.question !== 'string' || !a.question.trim()) throw new Error('no question');
        if (typeof a.answer !== 'string' || !a.answer.trim()) throw new Error('no answer');
        const sources = Array.isArray(a.sources)
          ? (a.sources as unknown[])
              .filter((x): x is { title?: unknown; url: string } => typeof (x as { url?: unknown })?.url === 'string')
              .map((x) => ({ title: typeof x.title === 'string' ? x.title : x.url, url: x.url }))
          : [];
        const { thread } = host.quickAsk({
          question: a.question,
          answer: a.answer,
          sources,
          ...(typeof a.askedAt === 'number' ? { askedAt: a.askedAt } : {}),
        });
        return { threadId: thread.id };
      }
      case 'interrupt': {
        if (!host.interrupt) throw new Error("This runner can't stop a turn from another Mac.");
        await host.interrupt(needThread());
        return undefined;
      }
      case 'call': {
        // Only what relay.ts CALLS allows, checked again here: the backend
        // isn't trusted to have checked, and nothing here may answer with
        // file contents or tool output (step 4 brings those, scrubbed).
        if (a.method !== 'files.list') throw new Error(`${String(a.method)} can't be asked of this runner`);
        const params = a.params && typeof a.params === 'object' ? (a.params as Record<string, unknown>) : {};
        const list = listFolderFor({ path: params.path });
        return { result: { ...list, entries: list.entries.slice(0, CALL_ENTRIES), truncated: list.truncated || list.entries.length > CALL_ENTRIES } };
      }
      case 'picture':
        await this.sendHeldPicture(needThread(), Number(a.seq), Number(a.index));
        return undefined;
      case 'share': {
        // The website's Stop sharing, Share again and New link (API 8).
        if (a.access !== 'off' && a.access !== 'link') throw new Error('access is "off" or "link"');
        await host.share(needThread(), { access: a.access, ...(a.newLink === true ? { newLink: true } : {}) });
        // Its row now, not with the next batch: the Mac that asked through
        // the relay reads the link from it as soon as this is done.
        await this.writeRowNow(needThread());
        return undefined;
      }
      case 'page': {
        // An API 1 phone's "Load earlier messages": up to PAGE_SIZE text
        // messages before beforeSeq, marked as paged so its phone:thread
        // shows them for a day (the rows are all there already since API 2).
        const id = needThread();
        const before = Number(a.beforeSeq);
        if (!Number.isFinite(before) || before <= 1) throw new Error('nothing earlier');
        const { events } = this.deps.runner.events(id, { beforeSeq: before, limit: PAGE_EVENTS });
        const now = this.deps.clock.now();
        // Text only: it's for a phone from before API 2, which never shows tool rows.
        const cuts = this.deps.runner.cuts?.(id) ?? [];
        const page = events
          .filter((e) => !cuts.some((c) => e.seq >= c.from && e.seq <= c.to))
          .map((e) => toMessageDoc(id, e, this.scrubber.safeText))
          .filter((m): m is MessageDoc => Boolean(m) && m!.role !== 'tool')
          .slice(-PAGE_SIZE)
          .map((m) => ({ ...m, pagedAt: now }));
        await this.appendMessages(page);
        return undefined;
      }
      case 'press': {
        // A reply button (API 59). Pressing twice is harmless: a pressed
        // button comes back as it is (buttons.ts pressButton).
        if (!host.pressButton) throw new Error("This runner can't press a button from the phone.");
        if (typeof a.buttonId !== 'string' || !/^[a-z0-9]{8}$/.test(a.buttonId)) throw new Error('no button');
        const r = (await host.pressButton(needThread(), a.buttonId)) as { button?: ReplyButton } | undefined;
        // The thread it started or messaged, so the phone can open it once
        // the press is done (its row goes up first, as a create's does).
        const pressed = r?.button?.pressed?.threadId;
        return pressed ? { threadId: pressed } : undefined;
      }
      case 'schedule': {
        if (!host.schedule) throw new Error('this runner can\'t change schedules');
        if (typeof a.scheduleId !== 'string' || !a.scheduleId) throw new Error('no schedule');
        if (a.action !== 'pause' && a.action !== 'resume' && a.action !== 'run') throw new Error('action is "pause", "resume" or "run"');
        await host.schedule({ scheduleId: a.scheduleId, action: a.action });
        return undefined;
      }
      default:
        throw new Error(`unknown command ${c.kind}`);
    }
  }
}
