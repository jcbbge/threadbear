// Who a runner key is, and what it may do (docs/protocol.md, "Runner keys").
// Plain TypeScript with no Convex imports, so the runner's unit tests can
// check every rule without a deployment; lib.ts runnerAuth looks the key up
// and the functions in sync.ts ask these.
//
// Two kinds of key. The owner key is the deployment's RUNNER_KEY, held by
// the main runner only, and may do everything, as every key could before
// 5 Nov 2026. A runner key (the runnerKeys table, made by the owner with
// `tb runner add`) is one runner's, and acts as that runnerId alone: a
// second Mac's key can't write the main Mac's threads, read its commands,
// queue work for it or pair a phone. A deployment with one runner has only
// the owner key, and nothing changes for it.

// keyId: the runnerKeys row, so what a key starts (an upload URL) dies with it.
export type Caller = { owner: true } | { owner: false; runnerId: string; keyId?: string };
export type RunnerKeyRow = { _id?: string; runnerId: string; revokedAt?: number };

// Compared without stopping at the first difference, so the time a wrong
// key takes says nothing about how much of it was right.
export function sameKey(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// The owner keys: RUNNER_KEY, and while it's being rotated RUNNER_KEY_NEXT
// too, so the main Mac can move to the new one with no gap (set NEXT, give
// the main runner the new key and restart it, then make it RUNNER_KEY).
export function isOwnerKey(key: string, ownerKeys: (string | undefined)[]): boolean {
  return Boolean(key) && ownerKeys.some((k) => Boolean(k) && sameKey(key, k!));
}

// `row` is the runnerKeys row whose hash matches the key, if any. Null: not
// a key this deployment knows (or a revoked one).
export function callerFrom(key: string, ownerKeys: string | undefined | (string | undefined)[], row: RunnerKeyRow | null | undefined): Caller | null {
  if (!key) return null;
  if (isOwnerKey(key, Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys])) return { owner: true };
  if (row && !row.revokedAt) return { owner: false, runnerId: row.runnerId, ...(row._id ? { keyId: row._id } : {}) };
  return null;
}

// A runner id as runner.json's sync.runnerId has it (ensureRunnerId makes 12
// hex characters). Checked as it arrives, never trimmed or folded: " m5 "
// must not turn into "m5" after something compared it as different.
// "any" is the phone's "whichever runner" (phone.ts mainRunner), nobody's id.
export const RUNNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function validRunnerId(id: string): boolean {
  return RUNNER_ID.test(id) && id !== 'any';
}

/** Acting as `runnerId`: its heartbeat, its lists, its pending commands. */
export function actsAs(c: Caller, runnerId: string): boolean {
  return c.owner || c.runnerId === runnerId;
}

/**
 * Writing a row that names a runner (a thread, a schedule): it must be the
 * caller's, and so must the row it replaces. So a runner key can't take
 * another runner's thread or schedule by writing it under its own id, nor
 * put one on another runner (a schedule there is that Mac running what it
 * says, with the permissions it says).
 */
export function mayWrite(c: Caller, incomingRunnerId: string, existingRunnerId: string | undefined): boolean {
  if (c.owner) return true;
  return incomingRunnerId === c.runnerId && (existingRunnerId === undefined || existingRunnerId === c.runnerId);
}

/**
 * Something keyed by a thread or schedule id (its messages, pictures,
 * claims): the row must be there and be the caller's. With no row there's
 * nothing a runner key may add to or take from: what it wrote under an id
 * nobody has yet would show once the owner made that thread, and what's
 * left under a gone one may be anyone's.
 */
export function mayTouch(c: Caller, existingRunnerId: string | undefined): boolean {
  return c.owner || (existingRunnerId !== undefined && existingRunnerId === c.runnerId);
}

/**
 * Making a row under a thread id nobody has a row for. `claimedBy` is every
 * runner that has had the id (a deleted thread's tombstone, a sidebar row);
 * `leftovers` whether anything is still stored under it (messages,
 * pictures). A runner key may only take an id that's had nothing but its
 * own runner, so it can't pick up a pruned thread's messages or put rows
 * where another runner's thread is listed.
 */
export function mayClaim(c: Caller, id: { claimedBy: string[]; leftovers: boolean }): boolean {
  if (c.owner) return true;
  return !id.leftovers && id.claimedBy.every((r) => r === c.runnerId);
}

/**
 * Attaching a stored file to a row, or deleting one. `uploader` is the
 * runner whose runner key uploaded it (storageOwners), undefined for the
 * owner's or the phone's uploads. A runner key may only use its own, so it
 * can't attach the owner's picture or a phone's photo to a thread of its
 * own, or delete one: a file no row names yet is still nobody's to take.
 */
export function mayUseStorage(c: Caller, uploader: string | undefined): boolean {
  return c.owner || (uploader !== undefined && uploader === c.runnerId);
}

/**
 * A phone's command. A runner key takes only those for its own runner:
 * "any" (a new thread from the phone with no runner online that the
 * owner's Mac would take, phone.ts mainRunner) waits for the owner key, as
 * its text is whatever Mike said.
 */
export function mayTake(c: Caller, cmd: { runnerId: string }): boolean {
  if (c.owner) return true;
  // Said outright, not left to "no key is for any" (one made before that check would be).
  return cmd.runnerId !== 'any' && cmd.runnerId === c.runnerId;
}

export function mayFinish(c: Caller, cmd: { runnerId: string }): boolean {
  return mayTake(c, cmd);
}

/**
 * Pocket cards are one deck for the phone, but a runner key sees and
 * changes only the cards its own runner filed: the deck holds what Mike
 * takes out with him (addresses, booking codes). A card with no runnerId
 * was filed with the owner key, or before runner keys.
 */
export function ownsCard(c: Caller, card: { runnerId?: string }): boolean {
  return c.owner || card.runnerId === c.runnerId;
}

// Every runner-facing function (sync.ts and relay.ts) and who may call it. A unit test
// checks this names exactly the functions sync.ts exports, so a new one
// can't go in without being sorted, and docs/protocol.md's table follows it.
//   owner:  the owner key only.
//   own:    any key, for its own runnerId and its own threads, schedules,
//           commands and cards (the owner for anyone's).
//   shared: any key; nothing in it is another runner's to protect.
export type Access = 'owner' | 'own' | 'shared';
export const ACCESS: Record<string, Access> = {
  upsertThreads: 'own',
  setPresence: 'own',
  removeThreads: 'own',
  replyImages: 'own',
  addReplyImage: 'own',
  shareImages: 'own',
  addShareImage: 'own',
  dropShareImages: 'own',
  prune: 'own',
  heartbeat: 'own',
  bye: 'own',
  threadsOf: 'own',
  // Every runner's id and name: what a tampered Mac would need to pose as
  // another. A runner key's scheduler lists only its own runner.
  runnersList: 'owner',
  issueToken: 'owner',
  listTokens: 'owner',
  revokeToken: 'owner',
  appendMessages: 'own',
  messageHeads: 'own',
  setProjects: 'own',
  upsertProjects: 'own',
  projectIcons: 'own',
  iconUploadUrl: 'shared',
  setProjectIcon: 'own',
  // Pre-API 9 compatibility, for a runner still on its own schedules.json:
  // no runner on a runner key needs it, and it can shadow other ids.
  setSchedules: 'owner',
  schedules: 'own',
  schedulesSince: 'own',
  saveSchedule: 'own',
  deleteSchedule: 'own',
  adoptSchedules: 'own',
  claimSchedule: 'own',
  releaseSchedule: 'own',
  scheduleRan: 'own',
  requestScheduleRun: 'own',
  // Someone has the website's Runners view open, which says nothing about any
  // runner; the figures are only ever its own (API 45).
  runnerWatch: 'shared',
  setRunnerStats: 'own',
  // Every runner's figures, and waking them all to report: the main Mac's.
  watchRunnersFromMac: 'owner',
  runnerStatsList: 'owner',
  setAccounts: 'own',
  upsertAccounts: 'own',
  // Usage readings of logins its own runner has, from any Mac.
  sharedUsage: 'own',
  // Pools are every runner's (which logins and folders each pool has, the
  // main Mac's included): a runner key reads them to follow them, but
  // changing them is the main key's.
  pools: 'shared',
  savePools: 'owner',
  adoptPools: 'owner',
  savePocketCard: 'own',
  removePocketCard: 'own',
  pocketCards: 'own',
  pendingCommands: 'own',
  takeCommand: 'own',
  finishCommand: 'own',
  setThreadIndex: 'own',
  otherRunnersList: 'owner',
  threadIndexSince: 'owner',
  otherRunnersThreads: 'owner',
  addRunnerKey: 'owner',
  listRunnerKeys: 'owner',
  revokeRunnerKey: 'owner',
  audit: 'owner',
  scrubStoredBatch: 'owner',
  auditRemove: 'owner',
  purgeRunner: 'owner',
  // relay.ts (API 44): other runners' threads read and steered from the main
  // Mac. Reading another runner's messages and queueing work for it is the
  // owner's alone.
  remoteTail: 'owner',
  remoteMessages: 'owner',
  remoteThread: 'owner',
  queueCommand: 'owner',
  imageUploadUrl: 'owner',
  commandState: 'owner',
  remoteAccounts: 'owner',
};

// A runner name as lists show it, for a runner key's heartbeat: folded to
// printable ASCII, not stripped (NFKD without marks, curly quotes and
// dashes to plain ones, so "Mike’s" is "Mike's" and "Ｍ5" is "M5"), with
// zero-width and control characters gone, spaces collapsed and at most
// NAME_CHARS. Empty: nothing usable (the runner then goes by its id).
export const NAME_CHARS = 40;
const PUNCT: [RegExp, string][] = [
  [/[\u2018\u2019\u201a\u201b\u2032\u02bc]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' '],
];
function fold(name: string): string {
  let s = name.normalize('NFKD').replace(/\p{M}/gu, '');
  for (const [re, to] of PUNCT) s = s.replace(re, to);
  return s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
}
export function normalName(name: string): string {
  return fold(name).slice(0, NAME_CHARS).trim();
}
// What two names look like side by side in a list, for telling look-alikes
// apart: "rn5" and "m5", "B0b" and "Bob", "1" and "l" compare the same. Of
// the whole name, never cut, so a suffix that tells two apart counts.
export function nameSkeleton(name: string): string {
  return fold(name).toLowerCase().replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i|]/g, 'l').replace(/[^a-z0-9]/g, '');
}

// Sizes are UTF-8 bytes, as Convex counts them.
const encoder = new TextEncoder();
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}
export function docBytes(doc: unknown): number {
  return utf8Bytes(JSON.stringify(doc));
}
// A string cut to at most `max` UTF-8 bytes, never mid-character.
export function cutBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}
// A runner key's schedule ids are what the runner makes (crypto.randomUUID),
// so none can carry text a terminal would run when an audit lists it.
export const SCHEDULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The gate at the top of every function. One not in ACCESS is owner-only. */
export function mayCall(c: Caller, fn: string): boolean {
  return c.owner || ACCESS[fn] === 'own' || ACCESS[fn] === 'shared';
}

// What a runner key gets back from something that isn't its own. The kind
// is what the runner looks for (runner/src/sync.ts forbiddenText) to turn
// the feature off quietly rather than retrying. Never names another
// runner's id, thread or card: a refusal mustn't tell a key what it can't see.
export const FORBIDDEN = 'forbidden';
export function forbiddenMessage(what: string): string {
  return `This runner's key can't ${what}.`;
}
