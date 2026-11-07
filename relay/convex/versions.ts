// Plain TypeScript with no Convex imports, so the runner's unit tests can
// check it (runner/test/unit/relay-versions.test.ts).
//
// An install's version is whatever its backend says (`api-52` from
// convex/push.ts), from an unauthenticated /register body or a /send
// header, and relay:stats counts installs by it as the keys of a record.
// A Convex field name can't start with "$" or hold anything but printable
// ASCII, and a plain object's "toString" or "constructor" is already a
// function, so one install saying "$x", "é" or "toString" broke the stats
// for good (Gautam's 6 Nov convex scan, F2). Kept to this when stored, and
// counted in a Map whatever was stored before.
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const UNKNOWN = 'unknown';

/** What's stored for a version an install sent: itself, or "unknown". */
export function storedVersion(given: unknown): string {
  return typeof given === 'string' && VERSION.test(given) ? given : UNKNOWN;
}

/** Installs by version, for relay:stats. One stored before the rule that breaks it counts as "other". */
export function countVersions(versions: (string | undefined)[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of versions) {
    const key = v === undefined ? UNKNOWN : VERSION.test(v) ? v : 'other';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}
