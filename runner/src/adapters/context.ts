// What a normaliser may do with files: read the files a tool touched (for
// diffs), and save images and big output into the thread's folder. Shared by
// the Claude and Codex normalisers; pure apart from these helpers, each can
// be tested by feeding recorded CLI output through it.
import fs from 'node:fs';
import path from 'node:path';
import type { ImageRef } from '../protocol.ts';
import { LIMITS } from '../protocol.ts';
import { copyImageFileInto, saveBase64Image, saveDataUrl } from '../media.ts';
import { safeEnd } from '../safe-cut.ts';

export type NormalizerContext = {
  cwd: string;
  readFile(p: string): string | null;
  saveImage(data: string, mediaType: string, hint: string): ImageRef;
  saveBlob(itemId: string, text: string): string;
  // Copies a file the CLI saved big output to into the thread, so it
  // outlives the CLI's own cleanup. Returns the copy's path.
  copyBlob(itemId: string, src: string): string | null;
  // Copies an image file the CLI saved or looked at (a generated image, a
  // local image it viewed) into the thread's media folder. Null when it
  // can't be read as an image.
  copyImage?(src: string, hint: string): ImageRef | null;
  // Saves a data: URL image into the media folder. Null when it isn't one.
  saveDataUrl?(url: string, hint: string): ImageRef | null;
};

// Biggest CLI output file copied into blobs/.
const MAX_BLOB_COPY = 64 * 1024 * 1024;

export function fileContext(cwd: string, mediaDir: string, blobsDir: string): NormalizerContext {
  return {
    cwd,
    readFile(p) {
      try {
        const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
    saveImage: (data, mediaType, hint) => saveBase64Image(mediaDir, data, mediaType, hint),
    copyImage: (src, hint) => copyImageFileInto(mediaDir, src, hint),
    saveDataUrl: (url, hint) => saveDataUrl(mediaDir, url, hint),
    saveBlob(itemId, text) {
      fs.mkdirSync(blobsDir, { recursive: true });
      const file = path.join(blobsDir, `${itemId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`);
      fs.writeFileSync(file, text);
      return file;
    },
    copyBlob(itemId, src) {
      try {
        const st = fs.statSync(src);
        if (!st.isFile() || st.size > MAX_BLOB_COPY) return null;
        fs.mkdirSync(blobsDir, { recursive: true });
        const file = path.join(blobsDir, `${itemId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`);
        fs.copyFileSync(src, file);
        return file;
      } catch {
        return null;
      }
    },
  };
}

// A tool result's text cut to the protocol's 64 KB, with the whole of it
// saved to a blob when it's longer.
export function truncateResultText(text: string, itemId: string, ctx: NormalizerContext): { text: string; truncated: boolean; blobPath?: string } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= LIMITS.toolResultText) return { text, truncated: false };
  let blobPath: string | undefined;
  try {
    blobPath = ctx.saveBlob(itemId, text);
  } catch {
    blobPath = undefined;
  }
  // Back up over UTF-8 continuation bytes so the cut never splits a character.
  let end = LIMITS.toolResultText;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const bytesCut = buf.subarray(0, end).toString('utf8');
  const cut = bytesCut.slice(0, safeEnd(text, bytesCut.length));
  return blobPath ? { text: cut, truncated: true, blobPath } : { text: cut, truncated: true };
}
