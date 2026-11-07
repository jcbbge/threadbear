import fs from 'node:fs';
import path from 'node:path';
import { paths, readRunnerJson } from './config.ts';
import type { Logger } from './log.ts';

// Keeps the data dir and logs from growing forever (Mike, 29 Oct: after a
// few days of use the runner log, the update log and thread screenshots
// were the things with no limit). Nothing here touches a thread's events,
// so every transcript stays readable; only pictures and leftovers go.

const DAY = 86_400_000;
export const LOG_CAP_BYTES = 20 * 1024 * 1024; // the same cap Agent Archive's logs have
// Pasted images are copied into the thread when the message is sent
// (runner.ts sendTo), so the inbox copy only matters for a draft.
const INBOX_KEEP_MS = 7 * DAY;
// Deleted threads wait in trash/ to be put back by hand (store.ts trash).
const TRASH_KEEP_MS = 30 * DAY;
// Archived threads' pictures (pasted ones and agents' screenshots) are
// most of a thread's size, but they're the user's, so they're only cleared
// when runner.json's archivedMediaDays says after how long. Mike's runners
// set 30, as Agent Archive keeps its own copy; anyone else's keep them
// (Mike, 6 Nov: "for now we don't want to have users' data deleted", until
// archiving to their own storage is worked out).
const EVERY_MS = 6 * 3_600_000;

export type LogToCap = { file: string; inPlace?: boolean };

// A log over `maxBytes` is kept once as `<file>.1`, replacing an older one.
// `inPlace` is for a file other processes hold open (launchd's stdout and
// stderr, the runner's own fd): it's copied and then emptied, which works
// because every writer appends. Otherwise it's renamed, and its writer
// makes a new one.
export function capLog(file: string, maxBytes: number, opts: { inPlace?: boolean } = {}): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  if (opts.inPlace) {
    fs.copyFileSync(file, `${file}.1`);
    fs.truncateSync(file, 0);
  } else {
    fs.renameSync(file, `${file}.1`);
  }
  return true;
}

function olderThan(file: string, ms: number, now: number): boolean {
  try {
    return now - fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

function entries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

export function tidy(opts: { home: string; logs: LogToCap[]; now: number; log?: Logger }): {
  logs: number;
  inbox: number;
  trash: number;
  media: number;
} {
  const { home, now, log } = opts;
  const done = { logs: 0, inbox: 0, trash: 0, media: 0 };
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log?.warn(`housekeeping: couldn't tidy ${what}`, { error: String(e) });
    }
  };

  for (const l of opts.logs) attempt(l.file, () => {
    if (capLog(l.file, LOG_CAP_BYTES, { inPlace: l.inPlace })) done.logs++;
  });

  const inbox = paths.inbox(home);
  for (const name of entries(inbox)) {
    const file = path.join(inbox, name);
    if (olderThan(file, INBOX_KEEP_MS, now)) attempt(file, () => {
      fs.rmSync(file, { recursive: true, force: true });
      done.inbox++;
    });
  }

  const bin = path.join(home, 'trash');
  for (const name of entries(bin)) {
    const dir = path.join(bin, name);
    if (olderThan(dir, TRASH_KEEP_MS, now)) attempt(dir, () => {
      fs.rmSync(dir, { recursive: true, force: true });
      done.trash++;
    });
  }

  // Read each time, so a change to runner.json counts without a restart.
  const days = readRunnerJson(home).archivedMediaDays;
  const keepMs = typeof days === 'number' && days > 0 ? days * DAY : undefined;
  for (const id of keepMs === undefined ? [] : entries(paths.threads(home))) {
    attempt(`thread ${id}`, () => {
      const rec = JSON.parse(fs.readFileSync(path.join(paths.thread(home, id), 'thread.json'), 'utf8')) as { archivedAt?: string };
      if (!rec.archivedAt || now - Date.parse(rec.archivedAt) <= keepMs!) return;
      const media = paths.media(home, id);
      if (!entries(media).length) return;
      fs.rmSync(media, { recursive: true, force: true });
      fs.mkdirSync(media, { recursive: true });
      done.media++;
    });
  }
  return done;
}

// Runs tidy a minute after start, then every six hours. Only the primary
// runner calls this; a draining one leaves the data dir to it.
export function startHousekeeping(opts: { home: string; logs: LogToCap[]; log: Logger }): () => void {
  const run = () => {
    const done = tidy({ ...opts, now: Date.now() });
    if (done.logs || done.inbox || done.trash || done.media) opts.log.info('housekeeping', done);
  };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, EVERY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
