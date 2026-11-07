// Links from a message back into the thread (docs/protocol.md, "Links into the
// thread"), as the Mac's WorkLinks and the phone's ThreadLinks read them:
// `work:<words>` quotes a step in the turn's working, `thread:<id>` is another
// thread and `review:<id>` a design review, which only the Mac can open.
// `button:<id>` is a reply button (docs/protocol.md, "Reply buttons").

export type LinkTarget = { kind: 'step'; quote: string } | { kind: 'thread'; id: string } | { kind: 'review' } | { kind: 'button'; id: string };
type Row = { seq: number; role: 'user' | 'assistant' | 'tool'; text: string; summary?: boolean };

// The markdown with work: and thread: destinations escaped, as agents write
// `[tests pass](work:npm test)` and a destination with a space isn't a link to
// the parser: the page showed the whole thing as raw text. Code stays as
// written, as it's only being talked about.
export function escapeDestinations(markdown: string): string {
  if (!markdown.includes('](work:') && !markdown.includes('](thread:')) return markdown;
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.startsWith(fence)) fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return escapeLine(line);
    })
    .join('\n');
}

function escapeLine(line: string): string {
  const spans = [...line.matchAll(/`+[^`]*`+/g)].map((m) => [m.index, m.index + m[0].length] as const);
  // One level of brackets inside, for `work:npm test (unit)`.
  return line.replace(/\]\((work|thread):((?:[^()]|\([^()]*\))*)\)/g, (whole, scheme: string, body: string, at: number) => {
    if (spans.some(([from, to]) => at < to && from < at + whole.length)) return whole;
    return `](${scheme}:${encodeURIComponent(decoded(body))})`;
  });
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // "100% done" isn't escaped, just a percent sign.
  }
}

// What a link means, or undefined for anywhere else (a web page).
export function readLink(href: string): LinkTarget | undefined {
  const match = /^(work|thread|review|button):(.*)$/is.exec(href);
  if (!match) return undefined;
  const words = decoded(match[2]!).trim();
  switch (match[1]!.toLowerCase()) {
    case 'work':
      return words ? { kind: 'step', quote: words } : undefined;
    case 'thread':
      return words ? { kind: 'thread', id: words } : undefined;
    case 'button':
      return words ? { kind: 'button', id: words } : undefined;
    default:
      return { kind: 'review' };
  }
}

// The step a work: link in message `seq` means: the latest in that message's
// turn with the words in it, as the Mac picks it. Undefined when none has,
// which a step's one line makes likelier than on the Mac (a command with a
// description comes as only the description).
export function findStep(quote: string, seq: number, rows: Row[]): number | undefined {
  const q = normal(quote);
  if (!q) return undefined;
  for (let i = rows.findIndex((r) => r.seq === seq) - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.role === 'user') return undefined;
    if (row.role === 'tool' ? normal(row.text).includes(q) : mentions(row, q)) return row.seq;
  }
  return undefined;
}

// A line that links to a step isn't the step, nor is the summary.
function mentions(row: Row, q: string): boolean {
  return !row.summary && normal(row.text.replace(/\]\(work:[^)\n]*\)/g, ']')).includes(q);
}

// Lowercase, one space, and home as the runner's step lines write it, so
// `/Users/mike/a.md` finds "Edited ~/a.md".
function normal(text: string): string {
  return text
    .replace(/\/Users\/[^/\s]+/g, '~')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
