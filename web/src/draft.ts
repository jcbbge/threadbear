// A ```slack, ```email or ```draft block in a reply: text the agent has
// written for Mike to send somewhere else. It's shown the way it'll go out,
// every line where the agent put it (a reply's own Markdown joins lines up,
// which ran a Slack draft's "•" lines into one paragraph, 6 Nov), in a box
// with a Copy button. A ```slack one also draws Slack's own formatting:
// *bold*, _italic_, ~strike~, `code` and <url|label> links.
//
// Its twins are the Mac's app/Sources/ThreadbearCore/Markdown/DraftBlock.swift
// and the phone's ios/ThreadbearKit/Sources/ThreadbearKit/DraftBlock.swift:
// all three parse it the same way, so keep them together (and their tests,
// draft.test.ts here and DraftBlockTests on each of the others).

export type DraftKind = 'slack' | 'email' | 'draft';

export type Draft = { kind: DraftKind; source: string };

// A run of a line with one look. `link` is http(s) or mailto only.
export type Span = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: string };

// `quote`: a Slack "> " line, drawn with a bar.
export type Line = { spans: Span[]; quote: boolean };

const kinds: readonly string[] = ['slack', 'email', 'draft'];

// Past this a fence stays plain code: a draft that size isn't a message,
// and the box shouldn't be what makes a reply slow. Counted in code points
// (the Swift side counts Characters, which only differs for emoji and
// accents built from several).
export const maxSource = 20_000;

// The draft for a fence's info string (only the first word counts), or
// undefined for any other fence.
export function draftFrom(language: string | null | undefined, code: string): Draft | undefined {
  const word = language?.split(/[ \t{]/).find((w) => w !== '')?.toLowerCase();
  if (!word || !kinds.includes(word)) return undefined;
  const source = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!source.trim() || Array.from(source).length > maxSource) return undefined;
  return { kind: word as DraftKind, source };
}

// Whether the fenced code block written at source[start..<end] (the hast
// node's position in the exact text handed to Markdown) has its closing
// fence, the way the Mac's MarkdownRenderer isClosed checks it. The node
// starts at the fence itself, so what's before it on its line is the
// container. While a reply streams, an unclosed fence runs to the end of
// the text, and it stays plain code until it's done, as on the Mac and the
// phone.
export function fenceClosed(source: string, start: number, end: number): boolean {
  const openingStart = source.lastIndexOf('\n', start - 1) + 1;
  const closingStart = source.lastIndexOf('\n', end - 1) + 1;
  if (closingStart <= start) return false;
  const lineEnd = source.indexOf('\n', start);
  const opening = source.slice(start, lineEnd < 0 ? source.length : lineEnd);
  const mark = opening[0];
  if (mark !== '`' && mark !== '~') return false;
  const width = /^(`+|~+)/.exec(opening)![1]!.length;
  if (width < 3) return false;
  // The closing line has the same quote markers in front, then the fence
  // and only whitespace. How far it's indented isn't checked: a list's
  // indent is hard to read back from here, and the worst a wrong guess does
  // is show the box a line early.
  const quotes = source.slice(openingStart, start).split('>').length - 1;
  let closing = source.slice(closingStart, end);
  for (let q = 0; q < quotes; q++) {
    closing = closing.replace(/^[ \t]*/, '');
    if (!closing.startsWith('>')) return false;
    closing = closing.slice(1);
  }
  const fence = closing.trim();
  return fence.length >= width && [...fence].every((c) => c === mark);
}

// What the box's header calls it.
export function draftLabel(kind: DraftKind): string {
  return kind === 'slack' ? 'Slack draft' : kind === 'email' ? 'Email draft' : 'Draft';
}

// The draft's lines as they're shown. An email or plain draft is its text as
// it is; a Slack one has its formatting and <...> tokens worked out.
export function draftLines(draft: Draft): Line[] {
  return draft.source.split('\n').map((line) => {
    if (draft.kind !== 'slack') return { spans: [{ text: line }], quote: false };
    if (line.startsWith('> ') || line === '>' || line.startsWith('&gt; ')) {
      const rest = line.startsWith('&gt; ') ? line.slice(5) : line.slice(Math.min(2, line.length));
      return { spans: slackSpans(rest), quote: true };
    }
    return { spans: slackSpans(line), quote: false };
  });
}

// What Copy puts on the clipboard as plain text. A Slack draft keeps its
// *bold* and _italic_ (Slack's message box formats those as it sends) but
// its <url|label> links become "label (url)", which pasted as plain text
// would otherwise stay as typed.
export function draftPlainText(draft: Draft): string {
  if (draft.kind !== 'slack') return draft.source;
  return draft.source
    .split('\n')
    .map((line) => {
      const { marked: text, tokens } = marked(line);
      if (!tokens) return decode(line);
      const chars = Array.from(text);
      // A token in `code` is copied as typed, as it's shown.
      const code = codeSpans(chars);
      let out = '';
      chars.forEach((c, offset) => {
        const index = placeholderIndex(c);
        const found = index !== undefined && index < tokens.length ? tokens[index]! : undefined;
        if (!found) out += c;
        else if (code.some(([from, to]) => offset >= from && offset < to)) out += found.raw;
        else if (found.token.kind === 'mention') out += found.token.text;
        else out += found.token.label === found.token.url || found.token.label === '' ? found.token.url : `${found.token.label} (${found.token.url})`;
      });
      return decode(out);
    })
    .join('\n');
}

// The same as HTML, put on the clipboard beside the plain text, so pasting
// into Slack or Mail keeps the bold and the links.
export function draftHTML(draft: Draft): string {
  const body = draftLines(draft).map((line) => {
    let afterSpace = true;
    const inner = line.spans
      .map((span) => {
        const out = spanHTML(span, afterSpace);
        afterSpace = span.text.endsWith(' ');
        return out;
      })
      .join('');
    return line.quote ? `<blockquote>${inner}</blockquote>` : inner;
  });
  // Quotes are blocks of their own, so no <br> beside one.
  let out = '';
  body.forEach((part, index) => {
    out += part;
    if (index < body.length - 1 && !part.startsWith('<blockquote>') && !body[index + 1]!.startsWith('<blockquote>')) out += '<br>';
  });
  return `<meta charset="utf-8"><div>${out}</div>`;
}

function spanHTML(span: Span, afterSpace: boolean): string {
  let text = keepSpaces(escapeHTML(span.text), afterSpace);
  if (span.code) text = `<code>${text}</code>`;
  if (span.strike) text = `<s>${text}</s>`;
  if (span.italic) text = `<i>${text}</i>`;
  if (span.bold) text = `<b>${text}</b>`;
  if (span.link) text = `<a href="${escapeHTML(span.link)}">${text}</a>`;
  return text;
}

// HTML folds runs of spaces into one, so a line's indent and any spaces
// lined up in it would go in a paste: each space at the start of a line or
// after another is a no-break space.
function keepSpaces(text: string, afterSpace: boolean): string {
  let out = '';
  let previousSpace = afterSpace;
  for (const c of text) {
    if (c === ' ') {
      out += previousSpace ? '&nbsp;' : ' ';
      previousSpace = true;
    } else if (c === '\t') {
      out += '&nbsp;&nbsp;&nbsp;&nbsp;';
      previousSpace = true;
    } else {
      out += c;
      previousSpace = false;
    }
  }
  return out;
}

function escapeHTML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// An email or plain draft's text with its bare http(s) addresses as links,
// for drawing only (Copy sends the text as written). Punctuation that ends
// a sentence after an address isn't part of it.
export function bareLinks(text: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = m[0].replace(/[.,;:!?'")\]]+$/, '');
    if (!URL.canParse(url) || url.length <= m[0].indexOf('//') + 2) continue;
    if (m.index > at) spans.push({ text: text.slice(at, m.index) });
    spans.push({ text: url, link: url });
    at = m.index + url.length;
  }
  if (at < text.length) spans.push({ text: text.slice(at) });
  return spans;
}

// MARK: Slack's formatting

// <@U123>, <#C123|general>, <!here> are mentions, shown as their words.
type Token = { kind: 'link'; url: string; label: string } | { kind: 'mention'; text: string };

// A <...> token: a link to a web page or a mail address, or a mention.
// Anything else between angle brackets is left as written.
export function token(inside: string): Token | undefined {
  const bar = inside.indexOf('|');
  const target = bar < 0 ? inside : inside.slice(0, bar);
  const label = bar < 0 ? undefined : inside.slice(bar + 1);
  const first = target[0];
  if (first === '@' || first === '#' || first === '!') {
    const name = target.slice(1);
    if (!name || name.includes(' ')) return undefined;
    if (label) return { kind: 'mention', text: first === '#' && !label.startsWith('#') ? `#${label}` : label };
    if (first === '!') {
      // <!subteam^S123> and <!date^...> carry a label or nothing useful.
      return { kind: 'mention', text: `@${name.split('^').find((p) => p !== '') ?? name}` };
    }
    return { kind: 'mention', text: `${first}${name}` };
  }
  // The Swift side's URL(string:) check; the address is kept as written
  // (a URL object would add a "/" to "https://x.dev").
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  if (target.includes(' ') || !scheme || !['http', 'https', 'mailto'].includes(scheme) || !URL.canParse(target)) return undefined;
  const shown = label !== undefined ? decode(label) : scheme === 'mailto' ? target.slice('mailto:'.length) : target;
  return { kind: 'link', url: target, label: shown };
}

// `raw`: the <...> the token was written as.
type Piece = { kind: 'text'; text: string } | { kind: 'token'; token: Token; raw: string };

// Walks a line once, handing over its words and its <...> tokens in order.
// A "<" that doesn't start a token is a word like any other. The next ">"
// is looked for once and kept until it's passed, so a line of many "<" (or
// one with no ">") takes one pass, not one per "<" (cross-lab review, 6 Nov).
function scanTokens(line: string, visit: (piece: Piece) => void): void {
  const chars = Array.from(line);
  let plain = '';
  // -1: not looked for yet; null: there's no ">" after here.
  let close: number | null = -1;
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '<') {
      if (close !== null && close <= i) {
        const found = chars.indexOf('>', i + 1);
        close = found < 0 ? null : found;
      }
      if (close !== null) {
        // A token never holds a "<", so with another before the ">" this
        // one isn't a token, and what's between isn't read.
        let next = false;
        for (let j = i + 1; j < close; j++) {
          if (chars[j] === '<') {
            next = true;
            break;
          }
        }
        const found = next ? undefined : token(chars.slice(i + 1, close).join(''));
        if (found) {
          if (plain) {
            visit({ kind: 'text', text: plain });
            plain = '';
          }
          visit({ kind: 'token', token: found, raw: chars.slice(i, close + 1).join('') });
          i = close + 1;
          continue;
        }
      }
    }
    plain += chars[i];
    i += 1;
  }
  if (plain) visit({ kind: 'text', text: plain });
}

function decode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// Past this many characters a line is shown as written, so a huge line
// can't keep the formatting busy.
export const maxFormattedLine = 2_000;
// Where the placeholders for a line's tokens start (Unicode's private use
// area).
const placeholderBase = 0xe000;

type Marked = { marked: string; tokens?: { token: Token; raw: string }[] };

// The line with each <...> token as one placeholder character, and the
// tokens; no tokens for a line that's too long, or that has placeholder
// characters of its own, which is shown as written.
function marked(line: string): Marked {
  if (Array.from(line).length > maxFormattedLine || /[\u{E000}-\u{F8FF}]/u.test(line)) return { marked: line };
  let out = '';
  const tokens: { token: Token; raw: string }[] = [];
  scanTokens(line, (piece) => {
    if (piece.kind === 'text') {
      out += piece.text;
    } else {
      out += String.fromCodePoint(placeholderBase + tokens.length);
      tokens.push({ token: piece.token, raw: piece.raw });
    }
  });
  return { marked: out, tokens };
}

// The token number a placeholder character stands for (c is one code point).
function placeholderIndex(c: string): number | undefined {
  const index = c.codePointAt(0)! - placeholderBase;
  return index >= 0 && index <= 0xf8ff - 0xe000 ? index : undefined;
}

// Where a line's `code` is, as [from, to) code point offsets, found the way
// `emphasis` finds it.
function codeSpans(chars: string[]): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < chars.length) {
    const end = chars[i] === '`' && opens(chars, i) ? closing(chars, i, '`') : undefined;
    if (end !== undefined) {
      spans.push([i, end + 1]);
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return spans;
}

// A Slack line's spans: *bold*, _italic_, ~strike~, `code`, links and
// mentions. Each <...> token stands in the line as one placeholder character
// while the emphasis is worked out, so a link can be bold (*see <url|docs>*)
// and a token inside `code` stays as written.
export function slackSpans(line: string): Span[] {
  const { marked: text, tokens } = marked(line);
  if (!tokens) return [{ text: decode(line) }];
  const spans: Span[] = [];
  for (const span of emphasis(text)) {
    let words = '';
    const flush = () => {
      if (!words) return;
      spans.push({ ...span, text: words });
      words = '';
    };
    for (const c of span.text) {
      const index = placeholderIndex(c);
      const found = index !== undefined && index < tokens.length ? tokens[index]! : undefined;
      if (!found) {
        words += c;
        continue;
      }
      if (span.code) {
        // Code shows what was typed.
        words += found.raw;
        continue;
      }
      flush();
      if (found.token.kind === 'link') spans.push({ ...span, text: found.token.label || found.token.url, link: found.token.url });
      else spans.push({ ...span, text: found.token.text, bold: true });
    }
    flush();
  }
  return merge(spans);
}

const sameLook = (a: Span, b: Span) =>
  !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && a.link === b.link;

// Joins neighbouring spans that look the same (a "<" that wasn't a token
// leaves the words around it in pieces).
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = out[out.length - 1];
    if (last && sameLook(last, span)) out[out.length - 1] = { ...last, text: last.text + span.text };
    else out.push(span);
  }
  return out;
}

const wordy = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const space = (c: string | undefined) => c !== undefined && /\s/u.test(c);

// Slack's emphasis: a marker counts when it opens at the start or after a
// space or punctuation, is followed by a non-space, and closes on the same
// line before a space, punctuation or the end. So "2*3*4" and
// "snake_case_name" stay as written. Works on code points, as the Swift
// side works on Characters.
function emphasis(text: string, base: Omit<Span, 'text'> = {}): Span[] {
  const chars = Array.from(text);
  const spans: Span[] = [];
  let plain = '';
  const flush = () => {
    if (!plain) return;
    spans.push({ ...base, text: decode(plain) });
    plain = '';
  };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    const end = '*_~`'.includes(c) && opens(chars, i) ? closing(chars, i, c) : undefined;
    if (end !== undefined) {
      flush();
      const inner = chars.slice(i + 1, end).join('');
      if (c === '`') spans.push({ ...base, code: true, text: decode(inner) });
      else spans.push(...emphasis(inner, { ...base, ...(c === '*' ? { bold: true } : c === '_' ? { italic: true } : { strike: true }) }));
      i = end + 1;
      continue;
    }
    plain += c;
    i += 1;
  }
  flush();
  return spans;
}

function opens(chars: string[], i: number): boolean {
  if (i + 1 >= chars.length || space(chars[i + 1]) || chars[i + 1] === chars[i]) return false;
  return i === 0 || !wordy(chars[i - 1]);
}

function closing(chars: string[], start: number, marker: string): number | undefined {
  for (let j = start + 2; j < chars.length; j++) {
    if (chars[j] === marker && !space(chars[j - 1]) && (j + 1 === chars.length || !wordy(chars[j + 1]))) return j;
  }
  return undefined;
}
