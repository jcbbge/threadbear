// Cutting text short without cutting a secret in two. Titles, previews, the
// wake note, ask lines, tool titles and quoted replies are all cut before they
// go to Convex, where they're scrubbed (scrub.ts, redaction.ts). A rule that
// needs the end of a secret to know it (the "@" after a connection URL's
// password, the closing quote of `"password": "..."`, a token's length) no
// longer matches half of one, so a cut through a secret sent the half the
// rules had stopped seeing (Daybreak, 6 Nov: a wake note cut through
// postgres://alice:password@host kept the password).
//
// So a cut never lands inside anything the scrub would take out: it moves back
// to before it. The text itself isn't changed (the runner's own copy of a
// thread never is, scrub.ts), only cut a little shorter when a secret is where
// the cut would be; on the way up the whole secret, or none of it, is there for
// the scrub to see. Callers that build text from cut parts (the wake note out
// of titles and conditions) get whole secrets in each part too.
import { scrubText } from './redaction.ts';

// How much either side of a cut is looked at: far more than any real secret
// (an 8192-bit RSA key's PEM is about 6.5 KB), and a cut in a huge text (a
// tool's output) stays cheap. A run without spaces is looked at whole (around).
const WINDOW = 32 * 1024;
// How much to read past a limit (a command's output) so the cut back to it can
// be placed by safeEnd.
export const CUT_LOOKAHEAD = WINDOW;
// Ends the text looked at, so the rules for a key cut off at the very end
// (CUT_SHORT, KnownValues' cut-off values) don't count as having seen it whole:
// a part that's mid-string once it's put in a longer text has no end there.
// A semicolon, as it ends a bare value in the rules (`password=...;`) rather
// than becoming part of one.
const STOP = ';';
// How many places back a cut is tried before falling back to before the
// first thing the scrub changed.
const TRIES = 24;

let scrub: (text: string) => string = scrubText;

// The runner's own scrubber, with the values it knows (main.ts), so a cut
// doesn't split one of those either. Until then, the shape rules.
export function useScrubForCuts(fn: (text: string) => string): void {
  scrub = fn;
}

// The furthest place at or before `end` to cut `text` without leaving part of
// a secret before it.
export function safeEnd(text: string, end: number): number {
  if (end >= text.length) return text.length;
  if (end <= 0) return 0;
  const [from, to, before] = around(text, end);
  if (before !== undefined) return before;
  const win = text.slice(from, to);
  let whole: string;
  try {
    whole = scrub(win);
  } catch {
    // Can't tell where anything is: cut before all of it.
    return from;
  }
  if (whole === win) return end;
  let at = end - from;
  try {
    for (let i = 0; i < TRIES && at > 0; i++) {
      const head = scrub(win.slice(0, at) + STOP);
      if (head.endsWith(STOP) && whole.startsWith(head.slice(0, -1))) return from + at;
      at = breakBefore(win, at);
    }
  } catch {
    return from;
  }
  return from + Math.min(at, firstDifference(win, whole));
}

// The nearest place at or after `start` to begin a tail of `text` (what keeps
// the last part, as a check's output does) without part of a secret after it.
export function safeStart(text: string, start: number): number {
  if (start <= 0) return 0;
  if (start >= text.length) return text.length;
  const [from, to, before] = around(text, start);
  if (before !== undefined) return nextSpace(text, start);
  const win = text.slice(from, to);
  let whole: string;
  try {
    whole = scrub(win);
  } catch {
    return to;
  }
  if (whole === win) return start;
  let at = start - from;
  try {
    for (let i = 0; i < TRIES && at < win.length; i++) {
      const tail = scrub(STOP + win.slice(at));
      if (tail.startsWith(STOP) && whole.endsWith(tail.slice(1))) return from + at;
      at = breakAfter(win, at);
    }
  } catch {
    return to;
  }
  return from + Math.max(at, win.length - lastDifference(win, whole));
}

// `text` cut to at most `max` characters at a safe place, with `mark` after
// what's left when anything was cut (and `max` counting it).
export function cutSafely(text: string, max: number, mark = ''): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - mark.length);
  const end = safeEnd(text, room);
  if (end > 0 || room === 0) return text.slice(0, end).trimEnd() + mark;
  // A secret right at the start (a title that's a pasted key): nothing would
  // be left, so it's the scrubbed text that's cut, to leave something to show.
  let clean: string;
  try {
    clean = scrub(text);
  } catch {
    return mark;
  }
  if (clean === text) return mark;
  return clean.length <= max ? clean : clean.slice(0, safeEnd(clean, room)).trimEnd() + mark;
}

// The last `max` characters of `text` at a safe place, with `mark` before them.
export function tailSafely(text: string, max: number, mark = ''): string {
  if (text.length <= max) return text;
  return mark + text.slice(safeStart(text, text.length - Math.max(0, max - mark.length)));
}

// Text read only up to a limit (a command's output) ends wherever the limit
// fell, perhaps in a secret whose end was never read: its last run of
// non-space characters goes, and a tail kept from the end of a longer output
// loses its first run likewise (dropPartialStart).
export function dropPartialEnd(text: string): string {
  const at = lastSpace(text, text.length, Infinity);
  return at < 0 ? '' : text.slice(0, at + 1);
}

export function dropPartialStart(text: string): string {
  const at = nextSpace(text, 0);
  return at >= text.length ? '' : text.slice(at);
}

// Whether text.slice(start, end), a part taken out of `text` some other way
// (a model's title tidied, punctuation taken off the end), has no secret cut
// at either end.
export function isSafeSlice(text: string, start: number, end: number): boolean {
  return safeEnd(text, end) === end && safeStart(text, start) === start;
}

// The first line with anything on it, trimmed and cut to `max`. A line's end
// is a cut too: a value that goes on to the next line (a key in two lines, a
// multi-line secret the runner knows) isn't cut at it, and a line that starts
// inside one is taken from the scrubbed text instead.
export function firstLineSafely(text: string, max: number, mark = ''): string {
  let start = 0;
  while (start <= text.length) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = text.length;
    if (text.slice(start, nl).trim()) {
      const end = nl < text.length ? safeEnd(text, nl) : nl;
      const line = text.slice(start, Math.max(start, end)).trim();
      if (line) return cutSafely(line, max, mark);
      let clean: string;
      try {
        clean = scrub(text);
      } catch {
        return mark;
      }
      return cutSafely((clean.split('\n').find((l) => l.trim()) ?? '').trim(), max, mark);
    }
    start = nl + 1;
  }
  return '';
}

// What's looked at around a cut at `at`: WINDOW either side, and all of the
// run of non-space characters the cut is in, so a long token or a URL's
// password has its start and end in sight (Codex's review, 7 Nov: a 40 KB
// password ran past a fixed window). A run longer than RUN_MAX is no secret
// anyone has (a minified file, a base64 blob), and looking at all of it on the
// event loop costs too much, so a cut in one goes before it (`before`). Longer
// secrets with spaces in them (a PEM key over 32 KB) are the one shape a window
// this size can't see whole.
const RUN_MAX = 256 * 1024;

function around(text: string, at: number): [number, number, number?] {
  let from = Math.max(0, at - WINDOW);
  let to = Math.min(text.length, at + WINDOW);
  if (at <= 0 || at >= text.length || !/\S/.test(text[at - 1]!) || !/\S/.test(text[at]!)) return [from, to];
  const runEnd = nextSpace(text, at);
  const runStart = lastSpace(text, at) + 1;
  if (runEnd - runStart > RUN_MAX) return [from, to, lastSpace(text, at, Infinity) + 1];
  from = Math.min(from, Math.max(0, runStart - 256));
  to = Math.max(to, Math.min(text.length, runEnd + 256));
  return [from, to];
}

// The first whitespace at or after `at` (or the end), and the last before `at` (or -1).
function nextSpace(text: string, at: number): number {
  const re = /\s/g;
  re.lastIndex = at;
  return re.exec(text)?.index ?? text.length;
}

// Looks back at most `max` + 1 characters (RUN_MAX: further is a run too long
// anyway), and says -1 or the place it stopped when there's none.
function lastSpace(text: string, at: number, max = RUN_MAX): number {
  const stop = Math.max(0, at - max - 1);
  for (let i = at - 1; i >= stop; i--) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && /\s/.test(text[i]!))) return i;
  }
  return stop > 0 ? stop - 1 : -1;
}

// The start of the run of non-space characters before `at`, or of the space
// before that run; always further back.
function breakBefore(s: string, at: number): number {
  let i = at - 1;
  while (i > 0 && /\s/.test(s[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(s[i - 1]!)) i--;
  return Math.max(0, Math.min(i, at - 1));
}

function breakAfter(s: string, at: number): number {
  let i = at + 1;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  while (i < s.length && !/\s/.test(s[i]!)) i++;
  return Math.min(s.length, Math.max(i, at + 1));
}

// How many characters at the end the two have the same.
function lastDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
