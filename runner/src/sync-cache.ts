// What the mirror already has, kept on disk between runner starts.
//
// Each start used to write every thread row and sidebar row again, and read
// them all back to prune and to find message heads: about 9 MB of Convex
// database I/O for Mike's 710 threads, and following main means 12 to 15
// starts a day, so over half of everything the deployment used
// (docs/convex-backend.md, "Usage and the free plan"). With this a start
// compares against what it sent last time and writes only what changed.
//
// Hashes, not the rows: nothing here is a thread's words. It's safe to lose:
// no file, or an old one, is a full write as before. A row written but not
// noted yet is at worst written twice. MAX_AGE_MS is the backstop for the
// mirror having drifted some way nobody thought of, as a full write puts
// anything right; a deployment that's been wiped says so sooner (heartbeat's
// firstSeen).
import crypto from 'node:crypto';
import fs from 'node:fs';

export const SYNC_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export type SyncCacheFile = {
  v: 1;
  url: string;
  runnerId: string;
  apiVersion?: number;
  at: number; // when the last full write finished
  threads: Record<string, string>;
  heads: Record<string, number>;
  // Thread removals not confirmed yet: nothing else would retry them.
  removed?: string[];
  projects?: Record<string, [string, string, string?]>;
  accounts?: Record<string, string>;
  index?: { at: number; rows: Record<string, string>; removed?: string[]; archived?: boolean };
  // Full sync: where each thread's tool output had got to (sync.ts catchUpBodies).
  bodies?: Record<string, number>;
};

export function digest(s: string): string {
  return crypto.createHash('sha1').update(s).digest('base64').slice(0, 16);
}

export function loadSyncCache(file: string, want: { url: string; runnerId: string; now: number }): SyncCacheFile | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as SyncCacheFile;
    if (c.v !== 1 || c.url !== want.url || c.runnerId !== want.runnerId) return undefined;
    if (typeof c.at !== 'number' || !(want.now - c.at < SYNC_CACHE_MAX_AGE_MS) || c.at > want.now) return undefined;
    if (!c.threads || !c.heads) return undefined;
    return c;
  } catch {
    return undefined;
  }
}

export function dropSyncCache(file: string): void {
  fs.rmSync(file, { force: true });
}

// Through a temp file, so a crash mid-write can't leave half a file.
export function saveSyncCache(file: string, c: SyncCacheFile): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, file);
}
