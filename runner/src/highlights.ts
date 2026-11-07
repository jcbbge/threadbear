// Highlights (docs/protocol.md, "Highlights"): what a thread has made,
// shared and pinned for Mike, for the app's right-hand rail. Found in the
// thread's events with no model: files it wrote that he'd look at, things
// it `open`ed, links and files named in its replies, PRs it created and
// commits it made. Agents add pins with the `pin` tool.
//
// The state lives on the thread record and is brought up to date from the
// event log when a client asks (threads.highlights), from the seq it had
// got to, so a busy thread costs nothing until someone looks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersistedEvent } from './protocol.ts';
import { replaceLinks, trimEndOf } from './linear-text.ts';

export type HighlightKind = 'file' | 'link' | 'pr' | 'commit';
export type HighlightHow = 'pinned' | 'written' | 'opened' | 'mentioned' | 'created' | 'committed';

export type Highlight = {
  id: string;
  kind: HighlightKind;
  title: string;
  url?: string;
  path?: string;
  how: HighlightHow;
  note?: string;
  show?: true;
  sha?: string;
  branch?: string;
  pushed?: true;
  seq: number;
  lastSeq: number;
  at: string;
};

export type ThreadHighlights = {
  highlights: Highlight[];
  edited: string[];
  brief?: { text: string; at: string };
};

// Kept on the thread record.
export type HighlightState = {
  seq: number; // the last event looked at
  items: Highlight[];
  edited: string[];
  removed?: string[]; // ids Mike took off: never found again
  // Command calls whose result matters (git commit, git push, gh pr
  // create), by itemId, until their tool.result comes.
  pending?: Record<string, { command: string }>;
};

export const HIGHLIGHTS_KEPT = 80;
export const EDITED_KEPT = 200;
const REMOVED_KEPT = 200;

// What Mike would open to look at, rather than code.
export const REVIEW_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic', '.mp4', '.mov', '.m4v', '.webm', '.csv', '.txt']);

export function emptyHighlights(): HighlightState {
  return { seq: 0, items: [], edited: [] };
}

type Ctx = { cwd: string; home?: string; exists?: (p: string) => boolean };

// Reads events in order into the state. Returns whether anything changed.
export function observe(state: HighlightState, events: Iterable<PersistedEvent>, ctx: Ctx): boolean {
  let changed = false;
  const home = ctx.home ?? os.homedir();
  const isFile = ctx.exists ?? defaultIsFile;
  const add = (h: Omit<Highlight, 'lastSeq' | 'at'>, e: PersistedEvent) => {
    if (upsert(state, { ...h, lastSeq: e.seq, at: e.ts })) changed = true;
  };
  for (const e of events) {
    if (e.seq <= state.seq) continue;
    state.seq = e.seq;
    changed = true; // the seq moved; worth saving
    switch (e.type) {
      case 'assistant.text':
        for (const found of linksIn(e.text, { cwd: ctx.cwd, home, isFile })) add({ ...found, how: 'mentioned', seq: e.seq }, e);
        break;
      case 'edit.diff':
        noteEdited(state, absolute(e.path, ctx.cwd, home));
        break;
      case 'tool.call': {
        const input = e.input ?? {};
        if (e.kind === 'write' || e.name === 'Write') {
          const files = typeof input.file_path === 'string' ? [input.file_path] : Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string') : [];
          for (const f of files) {
            const abs = absolute(f, ctx.cwd, home);
            noteEdited(state, abs);
            if (REVIEW_EXTENSIONS.has(path.extname(abs).toLowerCase())) add({ id: `file:${abs}`, kind: 'file', title: path.basename(abs), path: abs, how: 'written', seq: e.seq }, e);
          }
        } else if (e.kind === 'edit' && typeof input.file_path === 'string') {
          noteEdited(state, absolute(input.file_path, ctx.cwd, home));
        }
        if (typeof input.command === 'string') {
          const cwd = typeof input.cwd === 'string' ? input.cwd : ctx.cwd;
          for (const target of openTargets(input.command)) {
            if (/^https?:\/\//i.test(target)) {
              if (target.length <= MAX_URL) add({ ...linkItem(target), how: 'opened', seq: e.seq }, e);
            }
            else {
              const abs = absolute(stripFileUrl(target), cwd, home);
              if (isFile(abs)) add({ id: `file:${abs}`, kind: 'file', title: path.basename(abs), path: abs, how: 'opened', seq: e.seq }, e);
            }
          }
          if (gitRuns(input.command, 'commit') || gitRuns(input.command, 'push') || /\bgh\s+pr\s+create\b/.test(input.command)) {
            (state.pending ??= {})[e.itemId] = { command: input.command };
          }
        }
        break;
      }
      case 'tool.result': {
        const call = state.pending?.[e.itemId];
        if (!call) break;
        delete state.pending![e.itemId];
        if (!Object.keys(state.pending!).length) delete state.pending;
        const text = e.text ?? '';
        if (/\bgh\s+pr\s+create\b/.test(call.command)) {
          for (const url of text.match(PR_URL_G) ?? []) add({ ...linkItem(url), how: 'created', seq: e.seq }, e);
        }
        const committing = gitRuns(call.command, 'commit');
        const commits: { branch?: string; sha: string; message: string }[] = commitsIn(text);
        // Agents mostly commit with -q, which prints nothing, then show it
        // with `git log --oneline -1`: the first line for each commit, as a
        // longer log shows ones from before.
        if (committing && !commits.length && /--oneline/.test(call.command)) commits.push(...onelineCommits(text).slice(0, committing));
        if (committing) {
          for (const c of commits) {
            const item: Omit<Highlight, 'lastSeq' | 'at'> = { id: `commit:${c.sha}`, kind: 'commit', title: c.message, sha: c.sha, how: 'committed', seq: e.seq };
            if (c.branch) item.branch = c.branch;
            add(item, e);
          }
        }
        if (gitRuns(call.command, 'push') && e.ok) {
          const branches = new Set([...pushedBranches(text), ...pushArgBranches(call.command)]);
          for (const item of state.items) {
            if (item.kind !== 'commit' || item.pushed) continue;
            // A push whose branch can't be told (`git push -q`) sends what
            // the thread has just committed, near enough.
            if (!branches.size || !item.branch || branches.has(item.branch)) {
              item.pushed = true;
              item.lastSeq = e.seq;
              changed = true;
            }
          }
        }
        break;
      }
    }
  }
  return changed;
}

// Adds or merges one. A found item keeps its first `how` and seq, and moves
// up to the latest mention; a pin wins over how it was found. Returns
// whether the list changed.
export function upsert(state: HighlightState, h: Highlight): boolean {
  if (state.removed?.includes(h.id)) return false;
  const old = state.items.find((x) => x.id === h.id);
  if (!old) {
    state.items.push(h);
    trim(state);
    return true;
  }
  old.lastSeq = Math.max(old.lastSeq, h.lastSeq);
  if (h.how === 'pinned') {
    old.how = 'pinned';
    if (h.note) old.note = h.note;
    if (h.show) old.show = true;
    // A pin names it as the agent wants it called.
    if (h.title) old.title = h.title;
    old.seq = h.seq;
    old.at = h.at;
  }
  // A plain link that turns out to be a created PR, say.
  if (old.how === 'mentioned' && h.how !== 'mentioned' && h.how !== 'pinned') old.how = h.how;
  if (h.pushed) old.pushed = true;
  return true;
}

// Pins first, newest pin first; the rest by their latest mention.
export function view(state: HighlightState, brief?: { text: string; at: string }): ThreadHighlights {
  const pins = state.items.filter((h) => h.how === 'pinned').sort((a, b) => b.seq - a.seq);
  const rest = state.items.filter((h) => h.how !== 'pinned').sort((a, b) => b.lastSeq - a.lastSeq);
  const out: ThreadHighlights = { highlights: [...pins, ...rest].map(({ ...h }) => h), edited: [...state.edited] };
  if (brief) out.brief = brief;
  return out;
}

export function remove(state: HighlightState, id: string): boolean {
  const i = state.items.findIndex((h) => h.id === id);
  if (i < 0) return false;
  state.items.splice(i, 1);
  state.removed = [...(state.removed ?? []).filter((x) => x !== id), id].slice(-REMOVED_KEPT);
  return true;
}

// Takes a pin off the list. Unlike remove, a later mention can bring it
// back as a found one. Returns whether there was such a pin.
export function unpin(state: HighlightState, id: string): boolean {
  const h = state.items.find((x) => x.id === id && x.how === 'pinned');
  if (!h) return false;
  state.items.splice(state.items.indexOf(h), 1);
  return true;
}

// The highlight an agent's pin makes, before it goes into the state.
export function pinItem(target: { path?: string; url?: string; title?: string; note?: string; show?: boolean }, seq: number, at: string): Highlight {
  const base = target.url ? linkItem(target.url) : { id: `file:${target.path}`, kind: 'file' as const, title: path.basename(target.path!), path: target.path! };
  const h: Highlight = { ...base, how: 'pinned', seq, lastSeq: seq, at };
  if (target.title?.trim()) h.title = target.title.trim().slice(0, 200);
  if (target.note?.trim()) h.note = target.note.trim().slice(0, 500);
  if (target.show) h.show = true;
  return h;
}

function trim(state: HighlightState): void {
  const found = state.items.filter((h) => h.how !== 'pinned');
  if (found.length <= HIGHLIGHTS_KEPT) return;
  const drop = new Set(found.sort((a, b) => a.lastSeq - b.lastSeq).slice(0, found.length - HIGHLIGHTS_KEPT).map((h) => h.id));
  state.items = state.items.filter((h) => !drop.has(h.id));
}

function noteEdited(state: HighlightState, file: string): void {
  state.edited = [file, ...state.edited.filter((f) => f !== file)].slice(0, EDITED_KEPT);
}

// ----------------------------------------------------------- finding them

// Longer than this isn't a link anyone will open, as reviews.ts has it.
export const MAX_URL = 2000;

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const PR_URL_G = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/gi;

export function linkItem(url: string): Pick<Highlight, 'id' | 'kind' | 'title' | 'url'> {
  // Trailing punctuation and Markdown emphasis ("**https://x.dev**") aren't
  // part of the address, and a bare origin's "/" would make
  // "localhost:5176" and "localhost:5176/" two rows. Trimmed from the end
  // by hand: `/[).,;:!?'"*_~]+$/` started again from every mark of a long
  // run and scanned to its end, and a model told to write a link then
  // 300,000 underscores held the runner for minutes (Gautam's scan, F30).
  const clean = trimEndOf(url, TRAILING_MARKS).replace(/^(https?:\/\/[^/?#]+)\/$/i, '$1');
  const pr = PR_URL.exec(clean);
  if (pr) {
    const prUrl = pr[0];
    return { id: `pr:${prUrl}`, kind: 'pr', title: `${pr[1]}/${pr[2]}#${pr[3]}`, url: prUrl };
  }
  return { id: `link:${clean}`, kind: 'link', title: linkTitle(clean), url: clean };
}

const TRAILING_MARKS = `).,;:!?'"*_~`;

// "github.com/mikecann/poddle/pull/19" without the scheme, cut down.
function linkTitle(url: string): string {
  const t = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

type Found = Pick<Highlight, 'id' | 'kind' | 'title' | 'url' | 'path'>;

// Links and file paths in an agent's reply: Markdown links (their text is
// the title), bare URLs, and absolute or ~/ paths of files that exist,
// in a link or in backticks. Code blocks are skipped: what's in them is
// output to read, not something handed over.
const MARKDOWN_LINK = { titleStopsAtNewline: true, titleMin: 0, titleMax: 300, targetStopsAtSpace: true, targetMin: 1 };

export function linksIn(text: string, ctx: { cwd: string; home: string; isFile: (p: string) => boolean }): Found[] {
  const out = new Map<string, Found>();
  const prose = text.replace(/```[\s\S]*?(```|$)/g, ' ');
  const seen = new Set<string>();
  const addUrl = (raw: string, title?: string) => {
    if (raw.length > MAX_URL) return;
    const item = linkItem(raw);
    if (seen.has(item.id) || !/^https?:\/\/[^\s/]+\.[^\s/]|^https?:\/\/(localhost|127\.0\.0\.1)/i.test(item.url!)) return;
    seen.add(item.id);
    if (title && item.kind === 'link' && title.trim() && title.trim() !== item.url) item.title = title.trim().slice(0, 200);
    out.set(item.id, item);
  };
  const addPath = (raw: string, title?: string) => {
    const p = stripFileUrl(raw.trim().replace(/:\d+(:\d+)?$/, '')); // file.ts:12 → file.ts
    if (!p.startsWith('/') && !p.startsWith('~/')) return;
    const abs = absolute(p, ctx.cwd, ctx.home);
    const id = `file:${abs}`;
    if (seen.has(id) || !ctx.isFile(abs)) return;
    seen.add(id);
    out.set(id, { id, kind: 'file', title: title?.trim() && !title.includes('/') ? title.trim().slice(0, 200) : path.basename(abs), path: abs });
  };
  // [text](target), as `/\[([^\]\n]{0,300})\]\(([^)\s]+)\)/g` finds them
  // but reading the text once: the regex was quadratic in a run of "[](".
  let rest = replaceLinks(prose, MARKDOWN_LINK, (title, target) => {
    if (/^https?:\/\//i.test(target)) addUrl(target, title.replace(/`/g, ''));
    else addPath(decodeURIComponentSafe(target), title.replace(/`/g, ''));
    return ' ';
  });
  // `path`
  rest = rest.replace(/`([^`\n]+)`/g, (whole, inner: string) => {
    if (/^(~\/|\/|file:\/\/)/.test(inner) && !/\s/.test(inner)) addPath(inner);
    else if (/^https?:\/\/\S+$/i.test(inner)) addUrl(inner);
    return ' ';
  });
  for (const m of rest.matchAll(/https?:\/\/[^\s<>()\[\]`"']+/gi)) addUrl(m[0]);
  return [...out.values()];
}

// The files and URLs a shell command passes to `open`. `-a App`, `-b id`
// and `--args ...` aren't targets.
export function openTargets(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = shellWords(segment.trim());
    if (words[0] !== 'open') continue;
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      if (w === '--args') break;
      if (w === '-a' || w === '-b' || w === '--env' || w === '--stdin' || w === '--stdout' || w === '--stderr') {
        i++;
        continue;
      }
      if (w.startsWith('-')) continue;
      out.push(w);
    }
  }
  return out;
}

// `[main 91aba3e] App: hold ⌘ to see the keys` from git commit.
export function commitsIn(text: string): { branch: string; sha: string; message: string }[] {
  const out: { branch: string; sha: string; message: string }[] = [];
  for (const m of text.matchAll(/^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm)) {
    out.push({ branch: m[1]!, sha: m[2]!.slice(0, 7), message: m[3]!.trim().slice(0, 200) });
  }
  return out;
}

// `456680b Find one episode` (or `456680b (HEAD -> main) Find…`) from
// `git log --oneline`.
export function onelineCommits(text: string): { branch?: string; sha: string; message: string }[] {
  const out: { branch?: string; sha: string; message: string }[] = [];
  for (const m of text.matchAll(/^([0-9a-f]{7,12})(?: \(([^)]*)\))? (.+)$/gm)) {
    const head = /HEAD -> ([^,)\s]+)/.exec(m[2] ?? '');
    const c: { branch?: string; sha: string; message: string } = { sha: m[1]!.slice(0, 7), message: m[3]!.trim().slice(0, 200) };
    if (head) c.branch = head[1]!;
    out.push(c);
  }
  return out;
}

// The branches a push command names: `git push -u origin feat` and
// `git push origin HEAD:feat`. Not `HEAD` alone, which says nothing.
export function pushArgBranches(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\bgit\b(?:\s+-C\s+\S+)?\s+push\b([^;&|\n]*)/g)) {
    const words = shellWords(m[1]!.trim()).filter((w) => !w.startsWith('-'));
    for (const w of words.slice(1)) {
      const branch = w.includes(':') ? w.split(':').pop()! : w;
      if (branch && branch !== 'HEAD') out.push(branch.replace(/^refs\/heads\//, ''));
    }
  }
  return out;
}

// Branches a git push sent: "   a1b2c3d..e4f5a6b  main -> main" and
// " * [new branch]      feature -> feature". The leading space is a line's
// own, and the + or * takes the space after it: `^\s*(?:[+*]?\s*)?` ran
// on across blank lines with two runs of spaces side by side, which was
// cubic in a push's output of newlines (64 KB of them is hours). No line
// break of any kind in that space, as `^` starts again after each one (a
// \r, U+2028 and U+2029 too), and each start would scan the rest of the run.
export function pushedBranches(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^[^\S\n\r\u2028\u2029]*(?:[+*][^\S\n\r\u2028\u2029]*)?(?:[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}|\[new branch\])\s+(\S+)\s+->\s+\S+/gm)) out.add(m[1]!);
  return [...out];
}

// How many times a command runs `git <sub>` (`git -C dir commit` too), as
// a command of its own rather than words in a message or a heredoc.
export function gitRuns(command: string, sub: string): number {
  let n = 0;
  for (const segment of command.split(/&&|\|\||;|\||\n|\(|\)/)) {
    const words = shellWords(segment.trim());
    if (words[0] !== 'git') continue;
    let i = 1;
    while (words[i] === '-C' || words[i] === '-c') i += 2;
    while (words[i]?.startsWith('-')) i++;
    if (words[i] === sub) n++;
  }
  return n;
}

// Splits a command into words, minding quotes. Good enough for `open`.
function shellWords(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'\\]|\\.)+)/g)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]!.replace(/\\(.)/g, '$1'));
  }
  return out;
}

export function absolute(p: string, cwd: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.resolve(cwd, p);
}

function stripFileUrl(p: string): string {
  if (!p.startsWith('file://')) return p;
  return decodeURIComponentSafe(p.slice('file://'.length));
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
