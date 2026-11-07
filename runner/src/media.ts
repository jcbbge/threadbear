import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ImageRef } from './protocol.ts';
import { convertImageSync } from './images.ts';

export type ImageInfo = { mediaType: string; width?: number; height?: number };

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function extForMediaType(mediaType: string): string {
  return EXT[mediaType] ?? 'bin';
}

// Reads the image type and pixel size from the file header, so the app can
// lay out thumbnails without decoding anything.
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mediaType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { mediaType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { mediaType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { mediaType: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      return {
        mediaType: 'image/webp',
        width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
        height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
      };
    }
    return { mediaType: 'image/webp' };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mediaType: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { mediaType: 'image/jpeg' };
  }
  return null;
}

// An MP4 or QuickTime file's type and picture size, which the phone lays out
// from as it does a picture's. The size is optional: a file can have it
// anywhere, or not in a way this finds, and the phone then gets it on loading.
export function sniffVideo(buf: Buffer): ImageInfo | null {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('ascii', 8, 12);
  // HEIC and AVIF photos are ISO boxes with a ftyp too.
  if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return null;
  return { mediaType: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4', ...videoSize(buf) };
}

// moov > trak > tkhd, of the first track with a picture (audio's are 0 x 0).
function videoSize(buf: Buffer): { width?: number; height?: number } {
  for (const [start, end] of boxes(buf, 0, buf.length, 'moov')) {
    for (const [trakStart, trakEnd] of boxes(buf, start, end, 'trak')) {
      for (const [at, tkhdEnd] of boxes(buf, trakStart, trakEnd, 'tkhd')) {
        // Version 1 has 8-byte times, which moves the rest along 12.
        const shift = buf[at] === 1 ? 12 : 0;
        if (at + 84 + shift > tkhdEnd) continue;
        const width = buf.readUInt32BE(at + 76 + shift) >>> 16;
        const height = buf.readUInt32BE(at + 80 + shift) >>> 16;
        if (!width || !height) continue;
        // A phone's upright clip is stored sideways, with a rotation here.
        return buf.readInt32BE(at + 40 + shift) === 0 ? { width: height, height: width } : { width, height };
      }
    }
  }
  return {};
}

// [start, end] of the contents of each box of a type between two offsets.
function* boxes(buf: Buffer, from: number, to: number, type: string): Generator<[number, number]> {
  let i = from;
  while (i + 8 <= to) {
    let size = buf.readUInt32BE(i);
    let header = 8;
    if (size === 1 && i + 16 <= to) {
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = to - i;
    if (size < header || i + size > to) return;
    if (buf.toString('ascii', i + 4, i + 8) === type) yield [i + header, i + size];
    i += size;
  }
}

// Biggest image file accepted from the app.
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

export function readImageInfo(file: string): ImageInfo | null {
  let fd: number | null = null;
  try {
    // Only regular files: opening a named pipe (or a device) would block
    // the runner until something writes to it.
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    fd = fs.openSync(file, 'r');
    // JPEG size markers can sit after big EXIF blocks, so read generously.
    const size = Math.min(fs.fstatSync(fd).size, 512 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return sniffImage(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// A video file's type and, when its header has it near the start, its
// picture size (sniffVideo). For design reviews' clips (reviews.ts).
export function readVideoInfo(file: string): ImageInfo | null {
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return sniffVideo(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function imageRefFor(file: string, fallbackType?: string): ImageRef {
  const info = readImageInfo(file);
  const ref: ImageRef = { path: file, mediaType: info?.mediaType ?? fallbackType ?? 'application/octet-stream' };
  if (info?.width) ref.width = info.width;
  if (info?.height) ref.height = info.height;
  return ref;
}

// Saves base64 image data (from a tool result) into a media folder.
export function saveBase64Image(dir: string, data: string, mediaType: string, hint: string): ImageRef {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(data, 'base64');
  const info = sniffImage(buf);
  const type = info?.mediaType ?? mediaType;
  const name = `${safeName(hint)}-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10)}.${extForMediaType(type)}`;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  const ref: ImageRef = { path: file, mediaType: type };
  if (info?.width) ref.width = info.width;
  if (info?.height) ref.height = info.height;
  return ref;
}

// Copies an image into a folder under a fresh name and returns its ref.
// Used by media.import (into inbox/) and when a message is sent (into the
// thread's media/ so the transcript keeps working if inbox/ is cleaned).
// HEIC (iPhone photos), TIFF and BMP are converted (images.ts) on the way in,
// since the app and the models only take the common web formats.
export function copyImageInto(dir: string, src: string): ImageRef {
  const info = readImageInfo(src);
  if (!info) {
    const why = unreadable(src);
    if (why) throw new Error(why);
    return convertImageInto(dir, src);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${extForMediaType(info.mediaType)}`);
  fs.copyFileSync(src, file);
  const ref: ImageRef = { path: file, mediaType: info.mediaType };
  if (info.width) ref.width = info.width;
  if (info.height) ref.height = info.height;
  return ref;
}

// Why a file can't be read at all, or undefined when it can, so a missing or
// locked file isn't reported as "Not a supported image". A screenshot's
// floating thumbnail hands over a temp file that macOS deletes as the drop
// ends (issue #2).
function unreadable(src: string): string | undefined {
  const name = path.basename(src);
  let fd: number | null = null;
  try {
    const st = fs.statSync(src);
    if (!st.isFile()) return `Not a file: ${name}`;
    if (st.size === 0) return `${name} is empty`;
    if (st.size > MAX_IMAGE_BYTES) return `${name} is too big to add (over 100 MB)`;
    // Open it rather than ask access(): macOS privacy settings can refuse
    // the open of a file that access() says is readable.
    fd = fs.openSync(src, 'r');
    return undefined;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `The file went away before it could be added: ${name}`;
    if (code === 'EACCES' || code === 'EPERM') return `Threadbear isn't allowed to read ${name}`;
    return `Couldn't read ${name}${code ? ` (${code})` : ''}`;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function convertImageInto(dir: string, src: string): ImageRef {
  const unsupported = new Error(`Not a supported image: ${path.basename(src)}`);
  const kind = convertibleKind(readHead(src));
  if (!kind) throw unsupported;
  fs.mkdirSync(dir, { recursive: true });
  // Photos go to JPEG: a 12 MP iPhone shot as PNG is tens of MB, and it's
  // stored twice (inbox, then the thread's media). TIFF and BMP are more
  // often screenshots or diagrams, so they stay lossless as PNG.
  const [format, ext] = kind === 'heic' ? (['jpeg', 'jpg'] as const) : (['png', 'png'] as const);
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  const tmp = `${file}.tmp.${ext}`;
  try {
    convertImageSync(src, tmp, { format, ...(format === 'jpeg' ? { quality: 90 } : {}) });
    fs.renameSync(tmp, file);
  } catch {
    throw unsupported;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const info = readImageInfo(file);
  if (!info) {
    fs.rmSync(file, { force: true });
    throw unsupported;
  }
  return refFrom(file, info);
}

// The first bytes of a regular file under the size cap, or an empty buffer.
function readHead(file: string): Buffer {
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return Buffer.alloc(0);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 64));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// The API rejects images over about 5 MB (base64) or 8000 px. Shrink big
// ones (images.ts: sips on macOS, ImageMagick on Linux) before sending.
// Returns the bytes and media type to send; the original file stays as it was for the transcript.
export function prepareImageForModel(ref: ImageRef, tmpDir: string): { data: Buffer; mediaType: string } {
  const data = fs.readFileSync(ref.path);
  const tooBig = data.length > 3_700_000 || (ref.width ?? 0) > 7900 || (ref.height ?? 0) > 7900;
  if (!tooBig) return { data, mediaType: ref.mediaType };
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const out = path.join(tmpDir, `${crypto.randomUUID()}.jpg`);
    convertImageSync(ref.path, out, { format: 'jpeg', quality: 80, maxPx: 2048 });
    const small = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return { data: small, mediaType: 'image/jpeg' };
  } catch {
    return { data, mediaType: ref.mediaType };
  }
}

// Copies an image file a CLI saved or looked at (Codex's generated images,
// a file it viewed) into a media folder, named like saveBase64Image's so the
// same image always lands on the same file: a replay or a reconnect never
// duplicates it. HEIC, TIFF and BMP become PNG (images.ts), since the app
// and the models only take the common web formats. Null when it isn't a
// readable image.
export function copyImageFileInto(dir: string, src: string, hint: string): ImageRef | null {
  try {
    const file = localPath(src);
    if (!file) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(file);
    const sha = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const info = sniffImage(buf);
    fs.mkdirSync(dir, { recursive: true });
    if (info) {
      const out = path.join(dir, `${safeName(hint)}-${sha}.${extForMediaType(info.mediaType)}`);
      if (!fs.existsSync(out)) fs.copyFileSync(file, out);
      return refFrom(out, info);
    }
    if (!convertibleKind(buf)) return null;
    const out = path.join(dir, `${safeName(hint)}-${sha}.png`);
    if (!fs.existsSync(out)) {
      // Converted next to the target first, so a failed conversion never
      // leaves a half-written file under the final name.
      const tmp = `${out}.${process.pid}.tmp.png`;
      try {
        convertImageSync(file, tmp, { format: 'png' });
        fs.renameSync(tmp, out);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const converted = readImageInfo(out);
    return converted ? refFrom(out, converted) : null;
  } catch {
    return null;
  }
}

// Saves a `data:<type>;base64,<data>` image into a media folder. Null when
// it isn't a base64 data URL of an image.
export function saveDataUrl(dir: string, url: string, hint: string): ImageRef | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?((?:;[\w-]+=[^;,]*)*);base64,/i.exec(url);
  if (!m) return null;
  const data = url.slice(m[0].length);
  if (!sniffImage(Buffer.from(data.slice(0, 64 * 1024), 'base64'))) return null;
  try {
    return saveBase64Image(dir, data, m[1] ?? 'image/png', hint);
  } catch {
    return null;
  }
}

// A plain path, or a file:// URL as Codex's rollouts write them.
function localPath(src: string): string | null {
  if (src.startsWith('file://')) {
    try {
      return fileURLToPath(src);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(src) ? src : null;
}

// HEIC/HEIF (an ISO box with a heic-family brand), TIFF and BMP.
function convertibleKind(buf: Buffer): 'heic' | 'tiff' | 'bmp' | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.toString('ascii', 8, 12))) return 'heic';
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a)) return 'tiff';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

function refFrom(file: string, info: ImageInfo): ImageRef {
  const ref: ImageRef = { path: file, mediaType: info.mediaType };
  if (info.width) ref.width = info.width;
  if (info.height) ref.height = info.height;
  return ref;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'image';
}
