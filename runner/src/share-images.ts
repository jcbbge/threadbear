// The pictures in a shared thread's events (docs/website.md, "Sharing"),
// which the mirror uploads to file storage so the shared page can show
// them. What Mike pasted and what agents showed him go up for his own website
// and phone too, below; the rest of an unshared thread's stay on the Mac.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersistedEvent } from './protocol.ts';
import { absolute } from './highlights.ts';
import { sniffImage, sniffVideo } from './media.ts';
import { isSpace, seeker } from './linear-text.ts';

// A picture bigger than this stays on the Mac.
export const SHARE_IMAGE_BYTES = 10 * 1024 * 1024;

export type ShareImage = {
  seq: number;
  path: string; // the file on this Mac
  src?: string; // as the agent wrote it in Markdown, for the page to swap
  mediaType: string;
  width?: number;
  height?: number;
};

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// The media type a browser can show for a file name, or undefined.
export function imageType(file: string): string | undefined {
  const ext = file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? TYPES[ext] : undefined;
}

// What the phone can play as well as show (reply pictures only: a shared
// page draws its pictures with <img>).
function replyMediaType(file: string): string | undefined {
  return imageType(file) ?? (/\.(mp4|m4v|mov)$/i.test(file) ? 'video/mp4' : undefined);
}

// A Markdown image's address as a file on this Mac: an absolute path, a
// file:// URL or a ~ path. Undefined for a web address or anything else.
export function localImagePath(src: string, home = os.homedir(), typeOf = imageType): string | undefined {
  let p = src.trim();
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return undefined;
    }
  } else if (p.startsWith('~/')) p = home + p.slice(1);
  if (!p.startsWith('/') || p.includes('\0')) return undefined;
  return typeOf(p) ? p : undefined;
}

// ![alt](src) and ![alt](<src> "title"), as CommonMark writes them.
export function markdownImages(text: string, home = os.homedir(), typeOf = imageType): { src: string; path: string }[] {
  const out: { src: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const src of markdownImageSources(text)) {
    // Each src looked up once: a reply can name the same one thousands of times.
    if (seen.has(src)) continue;
    seen.add(src);
    const p = localImagePath(src, home, typeOf);
    if (p) out.push({ src, path: p });
  }
  return out;
}

// The src of each image, as
// `/!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g` finds
// them, in time linear in the text. That regex started again at every "!["
// and scanned ahead from it, so a model's reply of "![" over and over took
// the square of its length; here every scan ahead is remembered (seeker)
// and every "]" tried once, as all that follows an image's "]" depends on
// where that "]" is.
export function markdownImageSources(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  const skipSpace = (i: number) => {
    while (i < n && isSpace(text[i])) i++;
    return i;
  };
  const closeBracket = seeker(text, (c) => c === ']');
  const angleEnd = seeker(text, (c) => c === '>' || c === '\n');
  const bareEnd = seeker(text, (c) => c === ')' || isSpace(c));
  // What may follow a src, which ends just before `at`: a "title" after
  // some whitespace, then ")". Where the image ends, or -1. One per kind of
  // src, so each one's scans only ever move forward, and several "!["
  // whose src ends at the same place ask once.
  const after = () => {
    const quoteEnd = seeker(text, (c) => c === '"');
    let lastAt = -1;
    let lastEnd = -1;
    return (at: number): number => {
      if (at === lastAt) return lastEnd;
      lastAt = at;
      return (lastEnd = imageEnd(at));
    };
    function imageEnd(at: number): number {
      const w = skipSpace(at);
      if (w > at && text[w] === '"') {
        const q = quoteEnd(w + 1);
        const c = q < 0 ? -1 : skipSpace(q + 1);
        if (c >= 0 && text[c] === ')') return c + 1;
      }
      return text[w] === ')' ? w + 1 : -1;
    }
  };
  const afterAngle = after();
  const afterBare = after();
  let failedAt = -1;
  for (let p = text.indexOf('!['); p >= 0; ) {
    const q = closeBracket(p + 2);
    if (q < 0) break; // no "]" after this "![", nor after any later one
    let end = -1;
    let src = '';
    if (q !== failedAt && text[q + 1] === '(') {
      const j = skipSpace(q + 2);
      if (text[j] === '<') {
        const g = angleEnd(j + 1);
        if (g > j + 1 && text[g] === '>') {
          end = afterAngle(g + 1);
          src = text.slice(j + 1, g);
        }
      }
      if (end < 0) {
        const e = bareEnd(j);
        const stop = e < 0 ? n : e;
        if (stop > j) {
          end = afterBare(stop);
          src = text.slice(j, stop);
        }
      }
    }
    if (end < 0) {
      failedAt = q;
      p = text.indexOf('![', p + 1);
    } else {
      out.push(src);
      p = text.indexOf('![', end);
    }
  }
  return out;
}

// What one event shows: a message's attachments, what a tool handed back
// (a screenshot, an image it read or made), and pictures the agent put in
// its text by path.
export function imagesInEvent(e: PersistedEvent, home = os.homedir()): ShareImage[] {
  if (e.type === 'user.message' || e.type === 'tool.result') {
    return (e.images ?? []).map((i) => ({
      seq: e.seq,
      path: i.path,
      mediaType: i.mediaType,
      ...(i.width ? { width: i.width } : {}),
      ...(i.height ? { height: i.height } : {}),
    }));
  }
  if (e.type === 'assistant.text') {
    return markdownImages(e.text, home).map(({ src, path }) => ({ seq: e.seq, path, src, mediaType: imageType(path)! }));
  }
  return [];
}

// A file's bytes, at most SHARE_IMAGE_BYTES, or why not.
function readCapped(file: string): { bytes: Uint8Array } | { skip: string } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { skip: 'the file is gone' };
  }
  if (size > SHARE_IMAGE_BYTES) return { skip: `it's ${Math.round(size / 1024 / 1024)} MB` };
  return { bytes: new Uint8Array(fs.readFileSync(file)) };
}

// A shared thread's pictures come only from its media folder in the data
// dir (`threads/<id>/media`): its attachments and the pictures tools handed
// back are copied there, and an agent that wants a picture on the page
// copies it there on purpose (THREADBEAR_MEDIA_DIR). A path in assistant
// Markdown is only text the agent wrote, maybe at a repo's or a web page's
// say, so it gives no authority to publish a file from anywhere else: not
// the thread's folder, however new the file (pictures made there since the
// thread started went, and that was still Markdown publishing a local
// file: Daybreak verify-fix, 5 Nov), and not the temp folders, which hold
// every app's screenshots. Anything else shows its caption.
function under(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const OUTSIDE = "it isn't in the thread's media folder";

// The bytes of a shared thread's picture and what they really are, or why
// not. It goes to a public page, so: a file in `mediaDir` (by its real path
// too, so a folder link can't lead out), not itself a link, and really a
// picture whatever its name says. The type comes from the bytes. Read
// through one descriptor opened without following a link, and checked to
// be the file at the real path, so nothing can be swapped in between.
export function readShareImage(file: string, mediaDir: string | undefined): { bytes: Uint8Array; mediaType: string; width?: number; height?: number } | { skip: string } {
  if (!mediaDir) return { skip: OUTSIDE };
  const abs = path.resolve(file);
  if (!under(abs, mediaDir) && !under(abs, realOr(mediaDir))) return { skip: OUTSIDE };
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { skip: 'the file is gone' };
  }
  if (st.isSymbolicLink()) return { skip: "it's a link" };
  if (!st.isFile()) return { skip: "it can't be read" };
  const real = realOr(abs);
  if (!under(real, realOr(mediaDir))) return { skip: OUTSIDE };
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return { skip: (e as NodeJS.ErrnoException).code === 'ELOOP' ? "it's a link" : "it can't be read" };
  }
  try {
    const open = fs.fstatSync(fd);
    let atReal: fs.Stats;
    try {
      atReal = fs.statSync(real);
    } catch {
      return { skip: 'the file is gone' };
    }
    // Against what was looked at first too: a folder on the way swapped for a link
    // after that would otherwise agree with itself.
    if (!open.isFile() || open.ino !== atReal.ino || open.dev !== atReal.dev || open.ino !== st.ino || open.dev !== st.dev) return { skip: "it can't be read" };
    if (open.size > SHARE_IMAGE_BYTES) return { skip: `it's ${Math.round(open.size / 1024 / 1024)} MB` };
    const bytes = Buffer.alloc(open.size);
    let got = 0;
    while (got < bytes.length) {
      const n = fs.readSync(fd, bytes, got, bytes.length - got, got);
      if (n === 0) break;
      got += n;
    }
    // Pictures only: the page draws them with <img>.
    const info = sniffImage(bytes.subarray(0, got));
    if (!info) return { skip: "it isn't a picture" };
    return { bytes: new Uint8Array(bytes.subarray(0, got)), mediaType: info.mediaType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) };
  } catch {
    return { skip: "it can't be read" };
  } finally {
    fs.closeSync(fd);
  }
}

// What the phone shows of any thread, shared or not (backend API 24,
// docs/convex-backend.md): what the agent put in front of Mike on purpose,
// a picture or video in its reply, or one it pinned. Attachments and what
// tools hand back stay on the Mac, as they're many and big. The file goes as
// it is, so a GIF keeps its frames; the phone shrinks only what it draws.
export type ReplyImage = {
  seq: number;
  path: string; // the file on this Mac
  src?: string; // as the agent wrote it in Markdown, for the phone to swap
  pinned?: true; // the `pin` tool's, which goes under the turn's reply
};

export const PIN_TOOL = 'mcp__threadbear__pin';

export function replyImagesInEvent(e: PersistedEvent, cwd: string | undefined, home = os.homedir()): ReplyImage[] {
  if (e.type === 'assistant.text') return markdownImages(e.text, home, replyMediaType).map(({ src, path }) => ({ seq: e.seq, path, src }));
  if (e.type !== 'tool.call' || e.name !== PIN_TOOL || typeof e.input.path !== 'string') return [];
  // The pin tool takes a path relative to the thread's folder.
  const raw = e.input.path.trim();
  if (!raw || (!raw.startsWith('/') && !raw.startsWith('~') && !cwd)) return [];
  const file = absolute(raw, cwd ?? '/', home);
  return replyMediaType(file) ? [{ seq: e.seq, path: file, pinned: true }] : [];
}

// The pictures Mike pasted into a message, for his own website (`sync.pastedPictures`
// in runner.json, on by default; docs/on-your-mac.md). `src` is picture:N, for
// the [Picture N] that stands for it (docs/protocol.md, "Pictures in a message"):
// the phone only swaps a src it finds in Markdown, so it goes on showing its
// chip. Only as they're sent, never by looking back through the logs: nobody
// asked for what they'd already pasted to go up, and backfills are what cost.
export function pastedImagesInEvent(e: PersistedEvent): ReplyImage[] {
  if (e.type !== 'user.message') return [];
  return (e.images ?? []).map((image, i) => ({ seq: e.seq, path: image.path, src: `picture:${i + 1}` }));
}

// The bytes to upload and what they really are, or why not. An agent can
// write any path with a .png on the end, so the file has to be a picture or
// a video.
export function readReplyImage(file: string): { bytes: Uint8Array; mediaType: string; width?: number; height?: number } | { skip: string } {
  let read: ReturnType<typeof readCapped>;
  try {
    read = readCapped(file);
  } catch {
    return { skip: "it can't be read" };
  }
  if ('skip' in read) return read;
  const buf = Buffer.from(read.bytes);
  const info = sniffImage(buf) ?? sniffVideo(buf);
  if (!info) return { skip: "it isn't a picture" };
  return { bytes: read.bytes, mediaType: info.mediaType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) };
}
