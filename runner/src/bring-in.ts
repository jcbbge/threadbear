// Starting a thread that brings Mike's releases into someone's fork
// (docs/setup-and-updates.md section 2.3, "Bringing them in by itself").
//
// Mike, 6 Nov 2026: rather than a banner or a nag, a fork's runner starts a
// thread every so often (every 5 days unless runner.json's
// `releases.bringIn` says otherwise) when there's a release main doesn't
// have. The thread does the merge in its own worktree and runs the checks
// (docs/bringing-in-updates.md), so it reaches the inbox with one question:
// land it? Asking before landing stays the rule.
//
// What keeps it from being annoying:
// - only when a release is waiting, so a quiet week starts nothing;
// - never more than one: while the last one is still open (not archived),
//   a newer release goes to that thread as a message, on the same timer,
//   rather than starting another;
// - a release with a commit Mike marked `Important:` doesn't wait for the
//   timer (unless it's off).
//
// The timer starts the first time this runs, so turning it on (or bringing
// in the release that has it) doesn't start a thread straight away.
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { UpstreamRelease, UpstreamStatus } from './upstream.ts';

export const DEFAULT_BRING_IN_DAYS = 5;
const DAY_MS = 24 * 60 * 60_000;

// runner.json `releases.bringIn`: every so many days, only for important
// releases, or never.
export type BringInSetting = number | 'important' | 'off';

export function parseBringIn(v: unknown): BringInSetting | undefined {
  if (v === 'important' || v === 'off') return v;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365) return v;
  return undefined;
}

type State = {
  // When the clock last started: a thread started or messaged, or this
  // first ran.
  since: string;
  threadId?: string;
  // The release that thread was last asked to bring in.
  tag?: string;
  // Important commits already acted on, so each starts at most one thread.
  important?: string[];
};

export type BringInDeps = {
  home: string;
  clock: Clock;
  log: Logger;
  setting: () => BringInSetting;
  // Starts the thread; returns its id.
  start: (r: { text: string; title: string; why: string }) => string;
  // Whether a thread is still there and not archived.
  open: (threadId: string) => boolean;
  // Queues a message to it.
  send: (threadId: string, text: string) => void;
  // A Bring Them In or Let's Discuss thread someone started themselves
  // that's still open, so the timer doesn't start a second one beside it.
  openByHand?: () => string | undefined;
};

export class BringIn {
  private readonly deps: BringInDeps;

  constructor(deps: BringInDeps) {
    this.deps = deps;
  }

  private file(): string {
    return path.join(this.deps.home, 'runner', 'bring-in.json');
  }

  private read(): State | undefined {
    try {
      const s = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as State;
      return typeof s.since === 'string' ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private write(s: State): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(s, null, 2) + '\n');
  }

  // After each release check (upstream.ts onChecked). Returns what it did,
  // for the tests and the log.
  consider(up: UpstreamStatus): 'off' | 'nothing' | 'waiting' | 'started' | 'sent' {
    const setting = this.deps.setting();
    if (setting === 'off') return 'off';
    const now = this.deps.clock.now();
    let s = this.read();
    if (!s) {
      // The first time: the timer starts now. An important release that's
      // already waiting still goes ahead below.
      s = { since: new Date(now).toISOString() };
      this.write(s);
    }
    const r = up.state === 'available' ? up.release : undefined;
    if (!r || r.changes <= 0) return 'nothing';
    const seen = new Set(s.important ?? []);
    const fresh = (r.important ?? []).filter((i) => !seen.has(i.commit));
    const due = fresh.length > 0 || (typeof setting === 'number' && now - Date.parse(s.since) >= setting * DAY_MS);
    if (!due) return 'waiting';

    const important = [...seen, ...fresh.map((i) => i.commit)];
    if (!(s.threadId && this.deps.open(s.threadId))) {
      const byHand = this.deps.openByHand?.();
      if (byHand) s = { ...s, threadId: byHand, tag: undefined };
    }
    if (s.threadId && this.deps.open(s.threadId)) {
      // Already asked about this release: nothing new to say.
      if (s.tag === r.tag && !fresh.length) return 'waiting';
      this.deps.send(s.threadId, followUp(r, fresh));
      this.write({ since: new Date(now).toISOString(), threadId: s.threadId, tag: r.tag, important });
      this.deps.log.info('told the bring-in thread about a newer release', { threadId: s.threadId, tag: r.tag });
      return 'sent';
    }
    const threadId = this.deps.start({ text: firstMessage(r, fresh, setting), title: title(r, fresh), why: fresh.length ? "an important release from Mike" : "Mike's new releases" });
    this.write({ since: new Date(now).toISOString(), threadId, tag: r.tag, important });
    this.deps.log.info('started a thread to bring in a release', { threadId, tag: r.tag, important: fresh.length });
    return 'started';
  }
}

// "release/2026-11-06" as "6 Nov".
export function releaseDay(tag: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})$/.exec(tag);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${Number(m[3])} ${months[Number(m[2]) - 1]}` : tag;
}

function title(r: UpstreamRelease, fresh: { why: string }[]): string {
  return fresh.length ? `Important update from Mike (${releaseDay(r.tag)})` : `Bring in Mike's release of ${releaseDay(r.tag)}`;
}

function importantLines(fresh: { why: string }[]): string {
  return fresh.map((i) => `- ${i.why}`).join('\n');
}

function changes(r: UpstreamRelease): string {
  return `${r.changes} change${r.changes === 1 ? '' : 's'}`;
}

function firstMessage(r: UpstreamRelease, fresh: { why: string }[], setting: BringInSetting): string {
  const why = fresh.length
    ? `Mike marked part of it important, so this didn't wait for the usual timer:\n${importantLines(fresh)}\n\n`
    : '';
  const how = setting === 'important'
    ? 'This runner only starts these for releases Mike marks important'
    : `This runner starts one of these every ${setting} day${setting === 1 ? '' : 's'} when there's a release waiting`;
  return `Mike's release ${r.tag} has ${changes(r)} this copy doesn't have yet. ${why}Bring it in: follow docs/bringing-in-updates.md, merge its commit ${r.commit} (the one its signature was checked for) in this thread's worktree and run the checks, then tell me in a few lines what it brings, anything of mine you had to rework, and ask before landing. If it clashes in a way you can't settle, ask me which I'd rather have.

${how} (runner.json \`releases.bringIn\`, or Settings › General › Updates from Mike). If I say I don't want these, change that setting for me.`;
}

function followUp(r: UpstreamRelease, fresh: { why: string }[]): string {
  const why = fresh.length ? ` Mike marked part of it important:\n${importantLines(fresh)}\n` : '';
  return `Mike has a newer release, ${r.tag} (${changes(r)} this copy doesn't have).${why} It includes everything in the one this thread started with. Bring in this one instead, the same way (docs/bringing-in-updates.md): merge its commit ${r.commit}, and ask before landing.`;
}
