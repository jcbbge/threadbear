// Videos and HTML pages in design reviews (show_options): the copy the
// thread keeps, and a still of each. The still is the shot's `image`, which
// the window's thumbnails and side-by-side cells show and which a client
// from before videos and pages shows in their place; `media` is what the
// window plays or shows on the stage (docs/protocol.md, "Design reviews").
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { cssUrlCaptures, cutQueryAndHash } from './linear-text.ts';
import { copyImageInto, readImageInfo, readVideoInfo } from './media.ts';
import type { ImageRef } from './protocol.ts';

const MAC = process.platform === 'darwin';
// Longest side of a still, about what the window's stage shows.
const STILL_PX = 1600;
// What a page may bring with it from its own folder.
const maxPageAssets = 100;
const maxPageAssetBytes = 50 * 1024 * 1024;

export function copyReviewMedia(dir: string, src: string, kind: 'video' | 'page'): { image: ImageRef; media: ImageRef } {
  const media = kind === 'video' ? copyVideo(dir, src) : copyPage(dir, src);
  return { image: stillOf(dir, media.path, kind), media };
}

function copyVideo(dir: string, src: string): ImageRef {
  const info = readVideoInfo(src);
  if (!info) throw new Error(`Not a video: ${path.basename(src)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${info.mediaType === 'video/quicktime' ? 'mov' : 'mp4'}`);
  fs.copyFileSync(src, file);
  return { path: file, mediaType: info.mediaType, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) };
}

// The page goes in a folder of its own under its own name, with the files
// beside it that it names (pictures, styles, scripts, fonts), so a mockup
// split into a few files still looks right. Only from its own folder down:
// a page naming ../../.ssh/id_rsa doesn't get a copy of it.
function copyPage(dir: string, src: string): ImageRef {
  const root = path.dirname(src);
  const into = path.join(dir, crypto.randomUUID());
  fs.mkdirSync(into, { recursive: true });
  const page = path.join(into, path.basename(src));
  fs.writeFileSync(page, withCharset(fs.readFileSync(src)));
  const queue = [...namedFiles(fs.readFileSync(src, 'utf8'), root, root)];
  const seen = new Set<string>();
  const realRoot = fs.realpathSync(root);
  let bytes = 0;
  // By index, not shift(): a page naming one file a million times would
  // move the rest of the queue up once for each.
  for (let next = 0; next < queue.length && seen.size < maxPageAssets; ) {
    const file = queue[next++]!;
    if (seen.has(file)) continue;
    seen.add(file);
    let st: fs.Stats;
    try {
      // A link beside the page to somewhere else counts as somewhere else.
      if (!inside(fs.realpathSync(file), realRoot)) continue;
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || bytes + st.size > maxPageAssetBytes) continue;
    bytes += st.size;
    const out = path.join(into, path.relative(root, file));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(file, out);
    // A stylesheet names its own pictures and fonts.
    if (/\.css$/i.test(file)) for (const named of namedFiles(fs.readFileSync(file, 'utf8'), path.dirname(file), root)) queue.push(named);
  }
  return { path: page, mediaType: 'text/html' };
}

// A page with no charset of its own is read as Latin-1, by WebKit and by
// Quick Look making its still, so an agent's UTF-8 mockup showed ✓ as "âœ“"
// (Mike, 7 Nov). Agents write UTF-8 and rarely declare it, so a page that
// is valid UTF-8 and doesn't say otherwise gets the declaration added in
// its copy: after the doctype, which must come first or the page drops
// into quirks mode.
export function withCharset(bytes: Buffer): Buffer {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes; // a BOM says it already
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes; // some other encoding: leave it to the page
  }
  // Browsers look for the declaration in the first 1024 bytes.
  if (/<meta[^>]+charset/i.test(text.slice(0, 1024))) return bytes;
  const meta = '<meta charset="utf-8">';
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  return Buffer.from(doctype ? doctype[0] + meta + text.slice(doctype[0].length) : meta + text, 'utf8');
}

// Local files named in markup or CSS, resolved from `base`, kept only when
// they're inside `root`. Links to other pages aren't followed.
export function namedFiles(text: string, base: string, root: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(/\b(?:src|href|poster|data)\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  // Loops, not push(...): a page of millions of names overflowed the stack.
  for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const s of m[1].split(',')) refs.push(s.trim().split(/\s+/)[0]);
  // `url(...)` and a query or hash cut off are read in one pass each
  // (linear-text.ts): as regexes, a page of `url(` and spaces, or a name
  // of `?` after `?`, took time in the square of its length, on the
  // runner's one event loop (Daybreak, 7 Nov 2026).
  for (const ref of cssUrlCaptures(text)) refs.push(ref);
  for (const m of text.matchAll(/@import\s+["']([^"']+)["']/gi)) refs.push(m[1]);
  const files: string[] = [];
  for (const raw of refs) {
    const ref = cutQueryAndHash(raw.trim());
    // An address with a scheme (https:, data:, mailto:) or from the root isn't a file beside the page.
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/') || /\.html?$/i.test(ref)) continue;
    let name: string;
    try {
      name = decodeURIComponent(ref);
    } catch {
      name = ref;
    }
    const file = path.resolve(base, name);
    if (inside(file, root)) files.push(file);
  }
  return files;
}

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// A still of the video or page, copied in as a picture. Quick Look on a
// Mac (a frame of a video, the top of a page); ffmpeg for a video
// elsewhere; a plain dark card when neither can, so the review still opens.
function stillOf(dir: string, file: string, kind: 'video' | 'page'): ImageRef {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, '.still-'));
  try {
    const made = (MAC ? stills.quickLook(file, tmp) : undefined) ?? (kind === 'video' ? stills.ffmpegFrame(file, tmp) : undefined);
    if (made) return copyImageInto(dir, made);
    const card = path.join(tmp, 'card.png');
    fs.writeFileSync(card, solidPng(16, 9, [24, 24, 27]));
    return copyImageInto(dir, card);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The makers of stills, an object so a test can stand in for them.
export const stills = { quickLook, ffmpegFrame };

function quickLook(file: string, out: string): string | undefined {
  try {
    // A real clip or page takes about 0.1 s; a broken clip hangs Quick
    // Look for good, and this blocks the runner, so it's cut short.
    execFileSync('/usr/bin/qlmanage', ['-t', '-s', String(STILL_PX), '-o', out, file], { stdio: 'ignore', timeout: 8_000 });
  } catch {
    return undefined;
  }
  const made = path.join(out, path.basename(file) + '.png');
  return readImageInfo(made)?.width ? made : undefined;
}

function ffmpegFrame(file: string, out: string): string | undefined {
  const made = path.join(out, 'frame.png');
  // A second in, past a fade from black, or the first frame of a shorter clip.
  for (const at of ['1', '0']) {
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', at, '-i', file, '-frames:v', '1', made], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      continue;
    }
    if (readImageInfo(made)?.width) return made;
  }
  return undefined;
}

// A PNG of one colour, for the card in place of a still.
export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
