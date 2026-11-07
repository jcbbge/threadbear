// Imports a trusted project patch from the bytes its trust hash was made
// from, never from the folder as it is by then (docs/protocol.md,
// "Trusting a folder's patches"). Checking a patch's hash and then
// importing its path left a gap: a command that rewrote the patch, or a
// helper it imports, between the two ran unhashed code under the earlier
// yes (Codex review, 5 Nov).
//
// So the loader gets the patch's import graph as the bytes patchHash read
// (patch-trust.ts, `code`) and where each local import led (`edges`), and
// Node's module hooks serve exactly that. What an import from one of those
// files may load is decided by how it's written, not where it resolves to
// now:
//   - a local one (`./x`, `../x`, `/x`, `file:`) loads the very file the
//     hash followed it to, from the hashed bytes, without resolving it
//     again: a symlink retargeted since, even into node_modules, changes
//     nothing (Codex's second review, 5 Nov). One the hash didn't follow
//     refuses the patch.
//   - a bare one (a package, `node:fs`) resolves as Node resolves it,
//     and must land in a builtin or in that package's own folder in a
//     node_modules (`node_modules/zod/...`):
//     packages aren't hashed, by design, as `npm install` put them there.
//     One the repo commits is its own code, though: every file git tracks
//     under the repo's node_modules is hashed with the patch and served
//     from those bytes like a helper (tracked-packages.ts, patchHash).
//     Anything else is a file of the folder's that nothing hashed, so it
//     refuses the patch. Node resolves a bare name through the nearest
//     package.json's own `name` and `exports` before it looks in
//     node_modules, so a pull that renamed the repo's package to `zod`
//     sent `import 'zod'` to a script of the repo's, unasked (Gautam's
//     scan, 6 Nov); a workspace package (node_modules links to
//     packages/x, which Node follows) is one of the repo's files too.
// The files keep their own paths, so `import.meta.url` means what it did.
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cutQueryAndHash } from './linear-text.ts';
import { repoTopOf, unhashedPackageFile } from './tracked-packages.ts';

// Module URL (the patch file's with its ?v= query, a helper's plain) to
// the bytes to serve for it.
const sources = new Map<string, Buffer>();
// A served module's plain URL to its local specifiers' targets (URLs).
const edges = new Map<string, Map<string, string>>();
// A served module's plain URL to its patch's repo top.
const tops = new Map<string, string>();
let installed = false;

const plain = (url: string) => cutQueryAndHash(url);

// The URL to import a trusted patch at, after noting its code. `root` is
// the patch file's real path, `hash` its trust hash (so a new version is
// a new module), `code` its import graph by real path, `links` each of
// those files' local specifiers to the real path the hash followed.
export function verifiedUrl(root: string, hash: string, code: Map<string, Buffer>, links: Map<string, Map<string, string>>): string {
  install();
  const url = `${pathToFileURL(root).href}?v=${hash}`;
  const top = repoTopOf(root);
  for (const [file, bytes] of code) {
    // A helper is a module once per process (as before): the first
    // verified version noted is the one Node loads.
    sources.set(file === root ? url : pathToFileURL(file).href, bytes);
    if (!tops.has(pathToFileURL(file).href)) tops.set(pathToFileURL(file).href, top);
  }
  // The patch file's plain URL too, so a helper importing it back is
  // served the hashed bytes.
  if (!sources.has(pathToFileURL(root).href)) sources.set(pathToFileURL(root).href, code.get(root)!);
  for (const [from, specs] of links) {
    const to = new Map([...specs].map(([spec, target]) => [spec, pathToFileURL(target).href]));
    edges.set(pathToFileURL(from).href, to);
  }
  return url;
}

function served(url: string): Buffer | undefined {
  return sources.get(url) ?? sources.get(plain(url));
}

// How a specifier is written: local (a path or file: URL) or bare.
export function isLocalSpecifier(specifier: string): boolean {
  return /^\.{1,2}(\/|$)|^\//.test(specifier) || specifier.startsWith('file:');
}

// Where a bare import may lead from a served file: a builtin, or a file of
// that package's in a node_modules folder, `node_modules/<its name>/...`
// (its real path, as Node gives it; pnpm's store ends the same way). Not
// just any path with a node_modules in it: a self-reference's `exports`
// could name `./lib/node_modules/x.mjs`.
export function isPackageUrl(url: string, specifier: string): boolean {
  if (url.startsWith('node:')) return true;
  if (!url.startsWith('file:')) return false;
  let file: string;
  try {
    file = fileURLToPath(plain(url));
  } catch {
    return false;
  }
  const name = packageName(specifier).split('/');
  if (!name.every(Boolean)) return false;
  const segs = file.split(path.sep);
  for (let i = segs.indexOf('node_modules'); i >= 0; i = segs.indexOf('node_modules', i + 1)) {
    if (name.every((n, k) => segs[i + 1 + k] === n)) return true;
  }
  return false;
}

// A bare specifier's package: `zod` of `zod/v4`, `@ws/lib` of `@ws/lib/x`.
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

// The `name` of the package a served file is in, as Node finds it for a
// self-reference: the nearest package.json up from it, not past a
// node_modules folder. Refused by name whatever its `exports` say, so a
// folder extracted under some node_modules/zod can't pass either (Codex's
// review, 6 Nov). Only a plain file is read (a fifo would hold the hook).
function ownPackage(file: string): string | undefined {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (path.basename(d) === 'node_modules') return undefined;
    const pkg = path.join(d, 'package.json');
    try {
      if (fs.statSync(pkg).isFile()) {
        const name = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        return typeof name === 'string' ? name : undefined;
      }
    } catch {
      // none here, or not JSON: Node wouldn't self-resolve through it
      if (fs.existsSync(pkg)) return undefined;
    }
    if (path.dirname(d) === d) return undefined;
  }
}

function describe(url: string): string {
  try {
    return url.startsWith('file:') ? fileURLToPath(plain(url)) : url;
  } catch {
    return url;
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (!parent || !served(parent)) return nextResolve(specifier, context);
      if (!isLocalSpecifier(specifier)) {
        const own = ownPackage(fileURLToPath(plain(parent)));
        if (own !== undefined && own === packageName(specifier)) throw new Error(`${fileURLToPath(plain(parent))} imports ${specifier}, its own package by name, which resolves through package.json to a file patch trust didn't hash: not loaded.`);
        const out = nextResolve(specifier, context);
        if (!isPackageUrl(out.url, specifier)) throw new Error(`${fileURLToPath(plain(parent))} imports ${specifier}, which resolves to ${describe(out.url)}, not a package in node_modules, and patch trust didn't hash it: not loaded.`);
        // One the repo commits loads only from hashed bytes (patchHash
        // hashes them all once a patch has a bare import).
        const top = tops.get(plain(parent));
        if (top && out.url.startsWith('file:')) {
          const why = unhashedPackageFile(fileURLToPath(plain(out.url)), top, (f) => !!served(pathToFileURL(f).href));
          if (why) throw new Error(`${fileURLToPath(plain(parent))} imports ${specifier}, and ${why}: not loaded.`);
        }
        return out;
      }
      const key = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
      const target = edges.get(plain(parent))?.get(key);
      const from = fileURLToPath(plain(parent));
      if (!target || !served(target)) throw new Error(`${from} imports ${specifier}, which patch trust didn't hash: not loaded.`);
      return { url: target, format: undefined, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      const bytes = url.startsWith('file:') ? served(url) : undefined;
      if (!bytes) return nextLoad(url, context);
      // The format as Node would take it (from the extension and the
      // package.json); the source is the hashed bytes, whatever the
      // file holds now. Only a plain file is read for that (a fifo put
      // there would hang).
      if (!fs.statSync(fileURLToPath(plain(url))).isFile()) throw new Error(`${fileURLToPath(plain(url))} isn't a file now: not loaded.`);
      const out = nextLoad(url, context);
      return { ...out, source: bytes, shortCircuit: true };
    },
  });
}
