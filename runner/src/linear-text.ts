// Small text scans that take time in proportion to their input, for text a
// repo or a model writes. The regexes these replace (`/\s+#.*$/`,
// `/[.,]+$/`, a lazy capture before `\s*$`) start again at every position
// of a long run of spaces or punctuation and scan to its end each time, so
// a few hundred KB of spaces held the runner's one event loop for minutes
// (Gautam's security scan, 6 Nov 2026: F9, F24 to F27, F29, F30). Each one
// here gives what the regex it replaced gave; test/unit/redos.test.ts
// holds them to that.

// What `\s` matches, for one UTF-16 unit. String.prototype.trim strips the
// same set.
export function isSpace(c: string | undefined): boolean {
  if (c === undefined) return false;
  const n = c.charCodeAt(0);
  if (n === 0x20 || (n >= 0x09 && n <= 0x0d)) return true;
  if (n < 0xa0) return false;
  return n === 0xa0 || n === 0x1680 || (n >= 0x2000 && n <= 0x200a) || n === 0x2028 || n === 0x2029 || n === 0x202f || n === 0x205f || n === 0x3000 || n === 0xfeff;
}

// What `.` doesn't match: a regex's `.*$` fails on text with one of these
// after it, which is what turned `/\s+#.*$/` from a miss into a long one.
export function isLineBreak(c: string | undefined): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

export function hasLineBreak(s: string): boolean {
  return /[\n\r\u2028\u2029]/.test(s);
}

export function lastLineBreakIn(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) if (isLineBreak(s[i])) return i;
  return -1;
}

// `s.replace(/[<chars>]+$/, '')`: the run of these characters at the end
// goes.
export function trimEndOf(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return end === s.length ? s : s.slice(0, end);
}

// `s.replace(/^[<chars>]+/, '')`.
export function trimStartOf(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start]!)) start++;
  return start ? s.slice(start) : s;
}

// `s.replace(/[<chars>\s]+$/, '')`: these characters and whitespace.
export function trimEndOfOrSpace(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && (chars.includes(s[end - 1]!) || isSpace(s[end - 1]))) end--;
  return end === s.length ? s : s.slice(0, end);
}

// An unquoted .env value without its comment: `value.replace(/\s+#.*$/,
// '')`. The comment is the first `#` with whitespace before it, and the
// whitespace goes with it. As with the regex, a `#` with a line break
// anywhere after it (a lone \r) isn't one, since `.*$` can't reach the end
// across it.
export function stripEnvComment(value: string): string {
  const from = lastLineBreakIn(value) + 1;
  for (let i = Math.max(from, 1); i < value.length; i++) {
    if (value[i] !== '#' || !isSpace(value[i - 1])) continue;
    let start = i - 1;
    while (start > 0 && isSpace(value[start - 1])) start--;
    return value.slice(0, start);
  }
  return value;
}

// `/:\/\/[^/@\s]+:[^/@\s]+@/.test(s)`: an address with a user and a
// password in it ("postgres://me:pw@host"). After each "://", the run up to
// the next "/", "@" or whitespace has to end at an "@" and have a ":" with
// something either side of it. The runs never overlap, as each "://" has a
// "/" that ends the run before it.
export function hasUrlCredentials(s: string): boolean {
  for (let p = s.indexOf('://'); p >= 0; p = s.indexOf('://', p + 1)) {
    let end = p + 3;
    while (end < s.length && s[end] !== '/' && s[end] !== '@' && !isSpace(s[end])) end++;
    if (s[end] !== '@') continue;
    for (let c = p + 4; c < end - 1; c++) if (s[c] === ':') return true;
  }
  return false;
}

// `s.replace(/[?#].*$/, '')`: from the first `?` or `#` with no line break
// after it.
export function cutQueryAndHash(s: string): string {
  for (let i = lastLineBreakIn(s) + 1; i < s.length; i++) if (s[i] === '?' || s[i] === '#') return s.slice(0, i);
  return s;
}

// `/\{[\s\S]*\}/.exec(text)?.[0]`: from the first `{` to the last `}`.
export function outermostBraces(text: string): string | undefined {
  const open = text.indexOf('{');
  if (open < 0) return undefined;
  const close = text.lastIndexOf('}');
  return close > open ? text.slice(open, close + 1) : undefined;
}

// `[title](target)` links, left to right and not overlapping, as
// `/\[([^\]<title stops>]{min,max})\]\(([^)<target stops>]{min,})\)/g`
// finds them, each replaced by what `replace` returns. The regex starts at
// every `[` and scans ahead for the `]` and the `)`, so a run of "[" or of
// "[](" with neither cost the square of its length; here each search
// picks up where the last one for that `[` or `](` stopped.
export type LinkShape = {
  // Besides "]": a newline, or nothing.
  titleStopsAtNewline: boolean;
  titleMin: number;
  titleMax: number;
  // Besides ")": whitespace, or nothing.
  targetStopsAtSpace: boolean;
  targetMin: number;
};

export function replaceLinks(text: string, shape: LinkShape, replace: (title: string, target: string) => string): string {
  const titleEnd = seeker(text, (c) => c === ']' || (shape.titleStopsAtNewline && c === '\n'));
  const targetEnd = seeker(text, (c) => c === ')' || (shape.targetStopsAtSpace && isSpace(c)));
  let out = '';
  let copied = 0;
  for (let p = text.indexOf('['); p >= 0; ) {
    const q = titleEnd(p + 1);
    if (q < 0) break; // no "]" after this "[", nor after any later one
    const titleLen = q - p - 1;
    const r = text[q] === ']' && text[q + 1] === '(' && titleLen >= shape.titleMin && titleLen <= shape.titleMax ? targetEnd(q + 2) : -1;
    if (r >= 0 && text[r] === ')' && r - q - 2 >= shape.targetMin) {
      out += text.slice(copied, p) + replace(text.slice(p + 1, q), text.slice(q + 2, r));
      copied = r + 1;
      p = text.indexOf('[', r + 1);
    } else p = text.indexOf('[', p + 1);
  }
  return copied ? out + text.slice(copied) : text;
}

// The first index at or after `from` whose character passes `stop`, or -1.
// Asked with `from` never going back, it remembers the last answer, so the
// text is read once however often it's asked.
export function seeker(text: string, stop: (c: string) => boolean): (from: number) => number {
  let lo = 0;
  let at = -2; // nothing known yet
  return (from) => {
    if (at !== -2 && from >= lo && (at === -1 || from <= at)) return at;
    let i = from;
    while (i < text.length && !stop(text[i]!)) i++;
    lo = from;
    at = i < text.length ? i : -1;
    return at;
  };
}

// The captures of `/url\(\s*["']?([^"')]+)["']?\s*\)/gi`, in order, as
// matchAll gave them (a review page's stylesheet references, review-media.ts).
// As a regex, `url(` and a long run of spaces with no `)` made it try every
// split of the run between its `\s*` and the capture, at every `url(`
// (Daybreak, 7 Nov 2026). Here each `url(` is settled by a few forward-only
// searches (seeker), the cases the regex's backtracking reaches:
// - after the spaces, a quote: the value runs from after it to the next
//   quote or `)`; then `)`, or a quote, spaces and `)`;
// - failing that (or a `)` straight after the spaces), the last space alone
//   is the value, if a quote, spaces and `)` or a `)` follow it;
// - after the spaces, anything else: the value runs from there to the next
//   quote or `)`, closed the same way.
// A match goes on after its `)`, a miss at the next `url(`.
export function cssUrlCaptures(text: string): string[] {
  const n = text.length;
  const isStop = (c: string) => c === '"' || c === "'" || c === ')';
  const isQuote = (c: string | undefined) => c === '"' || c === "'";
  // One seeker per place a search starts, so each one's `from` only moves forward.
  const notSpaceAfterOpen = seeker(text, (c) => !isSpace(c));
  const stopAfterQuote = seeker(text, isStop);
  const stopAfterSpaces = seeker(text, isStop);
  const closeAfterQuoted = seeker(text, (c) => !isSpace(c));
  const closeAfterBare = seeker(text, (c) => !isSpace(c));
  const closeAfterSpace = seeker(text, (c) => !isSpace(c));
  // Where the `)` is when the value ends at `e` (the next quote or `)`), or -1.
  const close = (e: number, after: (from: number) => number): number => {
    if (e < 0) return -1;
    if (text[e] === ')') return e;
    const r = after(e + 1);
    return r >= 0 && text[r] === ')' ? r : -1;
  };
  const out: string[] = [];
  const open = /url\(/gi;
  let resume = 0;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    if (m.index < resume) continue;
    const s = m.index + 4;
    const w = notSpaceAfterOpen(s);
    if (w < 0) continue;
    let found: [number, number, number] | undefined; // value start, end, the `)`
    if (isQuote(text[w])) {
      const b = w + 1;
      if (b < n && !isStop(text[b]!)) {
        const e = stopAfterQuote(b);
        const r = close(e, closeAfterQuoted);
        if (r >= 0) found = [b, e, r];
      }
    } else if (text[w] !== ')') {
      const e = stopAfterSpaces(w);
      const r = close(e, closeAfterBare);
      if (r >= 0) found = [w, e, r];
    }
    // The last space as the value, then the quote or `)` at w.
    if (!found && w > s && (isQuote(text[w]) || text[w] === ')')) {
      const r = close(w, closeAfterSpace);
      if (r >= 0) found = [w - 1, w, r];
    }
    if (!found) continue;
    out.push(text.slice(found[0], found[1]));
    resume = found[2] + 1;
    open.lastIndex = resume;
  }
  return out;
}
