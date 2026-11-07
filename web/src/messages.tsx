// How a thread's messages and tool lines are drawn, on Mike's own thread
// page (App.tsx) and on a shared one (share.tsx).

import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { go } from './route';
import { escapeDestinations, findStep, readLink } from './thread-links';
import { pictureNumber, remarkPictureChips } from './picture-chips';
import * as Icon from './icons';
import { workedTitle, type TurnMessage } from './turns';
import { diffFiles, inputLines, keptWords, pictureCount } from './tool-body';
import { useConvex, useMutation } from 'convex/react';
import { useLiveQuery } from './live';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { useState, type ReactNode } from 'react';
import { bareLinks, draftFrom, fenceClosed, draftHTML, draftLabel, draftLines, draftPlainText, type Draft, type Span } from './draft';

// A message or tool line, from phone:messages or share:view.
export type PageMessage = TurnMessage;

function stepId(seq: number): string {
  return `step-${seq}`;
}

// Where a work: link goes: its step, out of any fold and lit up for a moment.
function showStep(seq: number) {
  const el = document.getElementById(stepId(seq));
  if (!el) return;
  // Out of every fold it's in: a tool run inside a turn's work.
  for (let fold = el.closest('details'); fold; fold = fold.parentElement?.closest('details') ?? null) fold.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('lit');
  setTimeout(() => el.classList.remove('lit'), 2500);
}

type Body = FunctionReturnType<typeof api.phone.eventBody>;

// One picture a tool handed back: on the runner until it's asked for, then here for a day.
function HeldPicture({ token, threadId, seq, index }: { token: string; threadId: string; seq: number; index: number }) {
  const request = useMutation(api.phone.requestPicture);
  const [asked, setAsked] = useState(false);
  const [failed, setFailed] = useState(false);
  const picture = useLiveQuery(api.phone.heldPicture, asked ? { token, threadId, seq, index } : 'skip');
  if (picture) return <img className="tool-picture" src={picture.url} alt={`Picture ${index + 1} from this tool`} />;
  if (failed) return <span className="muted">Couldn't ask for that picture.</span>;
  return (
    <button
      className="link"
      disabled={asked}
      title="Asks the runner to upload this picture. It's kept here for a day."
      onClick={() => {
        setAsked(true);
        request({ token, threadId, seq, index }).catch(() => setFailed(true));
      }}
    >
      {asked ? 'Asking the runner…' : `Show picture ${index + 1}`}
    </button>
  );
}

// What's under a tool line once it's open, fetched once.
function ToolBody({ token, threadId, seq, body }: { token: string; threadId: string; seq: number; body: Body }) {
  if (!body || body.state !== 'text') return <div className="tool-body muted">{keptWords(body?.state ?? null)}</div>;
  const input = inputLines(body.input);
  const files = diffFiles(body.diffs);
  return (
    <div className="tool-body">
      {body.reasoning ? <p className="tool-thought">{body.reasoning}</p> : null}
      {input.length ? <pre>{input.join('\n')}</pre> : null}
      {files.map((f) => (
        <div key={f.path}>
          <div className="muted">{f.path}</div>
          <pre>{f.hunks.flatMap((h) => h.lines ?? []).join('\n')}</pre>
        </div>
      ))}
      {body.text ? <pre className={body.ok === false ? 'failed' : undefined}>{body.text}</pre> : null}
      {body.truncated || body.cut ? <div className="muted">Output shortened. All of it is on the runner.</div> : null}
      {Array.from({ length: pictureCount(body.images) }, (_, index) => (
        <HeldPicture key={index} token={token} threadId={threadId} seq={seq} index={index} />
      ))}
    </div>
  );
}

function ToolLine({ m, source }: { m: PageMessage; source: { token: string; threadId: string } }) {
  const convex = useConvex();
  const [open, setOpen] = useState(false);
  // undefined: not asked yet. One query, not a subscription: tool output doesn't change.
  const [body, setBody] = useState<Body | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const toggle = () => {
    setOpen(!open);
    // Only an answer that won't change is kept: nothing yet can mean it's still on its
    // way up, and no `ok` that the tool hasn't answered (it's running in the background).
    if (open || (body && (body.state !== 'text' || body.ok !== undefined))) return;
    setFailed(false);
    setBody(undefined);
    convex.query(api.phone.eventBody, { ...source, seq: m.seq }).then(setBody, () => setFailed(true));
  };
  return (
    <li id={stepId(m.seq)} title={new Date(m.at).toLocaleString()} className="tool-open">
      <button className="tool-line" aria-expanded={open} title="Show what this tool did" onClick={toggle}>
        <span className="tool-glyph" aria-hidden="true">
          {toolGlyph(m.toolKind)}
        </span>
        <span>{m.text}</span>
      </button>
      {open ? failed ? <div className="tool-body muted">Couldn't load that.</div> : body === undefined ? <div className="tool-body muted">Loading…</div> : <ToolBody {...source} seq={m.seq} body={body} /> : null}
    </li>
  );
}

// A run of tool calls: up to three shown as lines, more folded into "12 tool
// calls" that opens to the lines. With a `source` (Mike's own page, never a shared
// one) each line opens to what the tool did, from a runner with full sync on.
export function ToolRun({ items, open, source }: { items: PageMessage[]; open?: boolean; source?: { token: string; threadId: string } }) {
  const lines = (
    <ul className="tools">
      {items.map((m) =>
        source ? (
          <ToolLine key={m.seq} m={m} source={source} />
        ) : (
          <li key={m.seq} id={stepId(m.seq)} title={new Date(m.at).toLocaleString()}>
            <span className="tool-glyph" aria-hidden="true">
              {toolGlyph(m.toolKind)}
            </span>
            <span>{m.text}</span>
          </li>
        ),
      )}
    </ul>
  );
  // Inside an opened "Worked for" fold they're already behind a click.
  if (open || items.length <= 3) return <div className="tool-run">{lines}</div>;
  return (
    <details className="tool-run">
      <summary>{items.length} tool calls</summary>
      {lines}
    </details>
  );
}

function toolGlyph(kind?: string): string {
  switch (kind) {
    case 'command':
      return '›';
    case 'read':
      return '◦';
    case 'edit':
    case 'write':
      return '✎';
    case 'search':
    case 'web':
      return '⌕';
    default:
      return '·';
  }
}

// A finished turn's work, folded into one line as on the Mac: "Worked for
// 4m 12s". Open, it shows the tool lines and what the agent said on the way.
export function Worked({ ms, children }: { ms?: number; children: ReactNode }) {
  return (
    <details className="worked">
      <summary>
        {workedTitle(ms)}
        <span className="chev">›</span>
      </summary>
      <div className="worked-body">{children}</div>
    </details>
  );
}

// A shared thread's picture (share:view): `src` for one written in a
// message's Markdown, otherwise it goes after its row.
export type Picture = { seq: number; src?: string; url: string; width?: number; height?: number };

// A message's text as Markdown, its links opening in a new tab. A picture
// written as a path on Mike's Mac shows from `pictures` (src to URL) when
// it was uploaded for a shared thread, and as its alt text otherwise,
// rather than a broken image. A link into the thread goes to its step, or
// `threadPath` for another thread (Mike's own page only: whoever a thread's
// shared with can't open the others). With nowhere to go it's just its words.
export function MessageText({
  text,
  pictures,
  seq,
  rows,
  threadPath,
  pictureChips,
  pasted,
  button,
}: {
  text: string;
  pictures?: Map<string, string>;
  seq?: number;
  rows?: PageMessage[];
  threadPath?: (id: string) => string;
  pictureChips?: boolean;
  // This message's pasted pictures that went up, by number (picture-chips.ts).
  pasted?: Map<number, string>;
  // Draws a [title](button:<id>) link as its button. Left out (a shared
  // page, whose readers mustn't press Mike's buttons), it's the title as text.
  button?: (id: string, title: ReactNode) => ReactNode;
}) {
  // The exact text Markdown reads, so a block's position can be looked up in it.
  const markdown = escapeDestinations(text);
  return (
    <div className="md" id={seq === undefined ? undefined : stepId(seq)}>
      <Markdown
        remarkPlugins={pictureChips ? [remarkGfm, remarkPictureChips] : [remarkGfm]}
        // The default keeps links safe (no javascript: and the like). A
        // file:// picture is let through only to be looked up in
        // `pictures`; it's never used as an address itself.
        // work:, thread: and review: are never used as addresses either: the
        // `a` below reads them and makes its own.
        urlTransform={(url, key) => ((key === 'src' && url.startsWith('file://')) || (key === 'href' && (readLink(url) || pictureNumber(url) !== undefined)) ? url : defaultUrlTransform(url))}
        components={{
          // A ```slack, ```email or ```draft fence is a draft to send
          // elsewhere (draft.ts); any other <pre> is drawn as before.
          // Only a closed one: while a reply streams, an unclosed fence
          // runs to the end of the text and stays code until it's done.
          pre: ({ node, children, ...p }) => {
            const fence = fenceOf(node);
            const at = node?.position;
            const closed = at?.start.offset !== undefined && at.end.offset !== undefined && fenceClosed(markdown, at.start.offset, at.end.offset);
            const draft = fence && closed && draftFrom(fence.language, fence.code);
            return draft ? <DraftBox draft={draft} /> : <pre {...p}>{children}</pre>;
          },
          a: ({ node: _, href, children, ...p }) => {
            const picture = href ? pictureNumber(href) : undefined;
            if (picture !== undefined) {
              const url = pasted?.get(picture);
              if (url) {
                return (
                  <a className="pasted" href={url} target="_blank" rel="noreferrer" title={`Picture ${picture}, click to open it`}>
                    <img src={url} alt={`Picture ${picture}`} loading="lazy" />
                  </a>
                );
              }
              return (
                <span className="picture-chip" title="This picture is only on your Mac: it was pasted before pictures went up, is over 10 MB, or pictures are turned off on that runner">
                  <Icon.Photo />
                  Picture {picture}
                </span>
              );
            }
            const link = href ? readLink(href) : undefined;
            // A relative link (`[plan](shorts-plan/candidates.md)`) is a
            // file in the thread's folder on the Mac; as an address here
            // it's a page on this site that isn't there.
            // `/` and `//` ones are this site's own pages and web addresses.
            if (!link && href && !/^[#/]/.test(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
              return <span title="This file is on the Mac">{children}</span>;
            }
            if (!link) {
              return (
                <a {...p} href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            }
            if (link.kind === 'step' && seq !== undefined && rows) {
              const step = findStep(link.quote, seq, rows);
              if (step !== undefined) {
                return (
                  <a
                    href={`#${stepId(step)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      showStep(step);
                    }}
                  >
                    {children}
                  </a>
                );
              }
            }
            if (link.kind === 'button') return button ? button(link.id, children) : <>{children}</>;
            if (link.kind === 'thread' && threadPath) {
              const path = threadPath(link.id);
              return (
                <a
                  href={path}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) return;
                    e.preventDefault();
                    go(path);
                  }}
                >
                  {children}
                </a>
              );
            }
            return <>{children}</>;
          },
          img: ({ src, alt }) => {
            const s = typeof src === 'string' ? src : '';
            const url = pictures?.get(s) ?? (/^https?:\/\//.test(s) ? s : undefined);
            if (!url) return <span className="muted">[{alt || 'image'}]</span>;
            return (
              <a href={url} target="_blank" rel="noreferrer">
                <img className="picture" src={url} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
              </a>
            );
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

// The language and text of a <pre> that's a fenced code block, read from
// the HTML tree react-markdown hands over (`<pre><code
// class="language-slack">`), or undefined for any other <pre>.
type HastNode = { type?: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };
function fenceOf(node: unknown): { language?: string; code: string } | undefined {
  const kids = (node as HastNode | undefined)?.children?.filter((k) => !(k.type === 'text' && !k.value?.trim()));
  const code = kids?.length === 1 && kids[0]!.tagName === 'code' ? kids[0]! : undefined;
  if (!code) return undefined;
  const classes = Array.isArray(code.properties?.className) ? (code.properties.className as unknown[]) : [];
  const language = classes.map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length);
  const text = (n: HastNode): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(text).join(''));
  return { language, code: text(code) };
}

// A draft for Mike to send elsewhere: every line where the agent put it,
// with a Slack one's formatting drawn, and a Copy that keeps the links.
function DraftBox({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const plain = draftPlainText(draft);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([draftHTML(draft)], { type: 'text/html' }),
        }),
      ]);
    } catch {
      // No ClipboardItem (an older browser) or no rich clipboard: the text alone.
      await navigator.clipboard.writeText(plain);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="draft">
      <div className="draft-head">
        <span>{draftLabel(draft.kind)}</span>
        <button className={copied ? 'btn plain copied' : 'btn plain'} onClick={() => void copy()} title="Copy the draft, with its links and formatting">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div className="draft-body">
        {draftLines(draft).map((line, i) => (
          <div key={i} className={line.quote ? 'draft-quote' : undefined}>
            {line.spans.some((s) => s.text) ? (
              // An email or plain draft's bare addresses are links here, as on the Mac.
              (draft.kind === 'slack' ? line.spans : line.spans.flatMap((s) => bareLinks(s.text))).map((s, j) => <DraftSpan key={j} span={s} />)
            ) : (
              <br />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DraftSpan({ span }: { span: Span }) {
  let out: ReactNode = span.text;
  if (span.code) out = <code>{out}</code>;
  if (span.strike) out = <s>{out}</s>;
  if (span.italic) out = <em>{out}</em>;
  if (span.bold) out = <strong>{out}</strong>;
  // draft.ts only makes http(s) and mailto links.
  if (span.link) {
    out = (
      <a href={span.link} target="_blank" rel="noreferrer">
        {out}
      </a>
    );
  }
  return <>{out}</>;
}

// Pictures that go after a row: an attachment, or what a tool handed back.
export function Pictures({ items }: { items: Picture[] }) {
  if (!items.length) return null;
  return (
    <div className="pictures">
      {items.map((p) => (
        <a key={p.url} href={p.url} target="_blank" rel="noreferrer">
          <img className="picture" src={p.url} alt="" loading="lazy" width={p.width} height={p.height} />
        </a>
      ))}
    </div>
  );
}

// Which row each picture without a src goes after: the one with the
// greatest seq at or before its own (rows are oldest first).
export function picturesByRow(rows: { seq: number }[], pictures: Picture[]): Map<number, Picture[]> {
  const out = new Map<number, Picture[]>();
  for (const p of pictures) {
    if (p.src) continue;
    let at: number | undefined;
    for (const r of rows) {
      if (r.seq > p.seq) break;
      at = r.seq;
    }
    if (at === undefined) continue;
    out.set(at, [...(out.get(at) ?? []), p]);
  }
  return out;
}
