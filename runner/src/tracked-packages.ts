// Files under node_modules that a repo commits, which patch trust hashes
// like the rest of the repo (docs/protocol.md, "Committed node_modules").
//
// A package `npm install` put in node_modules is the folder's dependency,
// and isn't hashed: that would re-ask after every install. But a repo can
// commit its own `node_modules/zod` (git add -f gets past .gitignore), and
// a bare `import 'zod'` from a trusted patch then loaded whatever a later
// pull put there, unasked (Mike's call, 7 Nov, after Gautam's scan). So
// files git tracks under any node_modules folder of the repo, submodules
// included, are the repo's own: once a patch, or a script one of its
// commands runs, has any bare import of a package, every one of them is
// hashed and followed for its own imports, as a helper is. Not only the
// package the import names: Node finds one in more places than a folder of
// that name (`node_modules/payload.js` for require('payload'), a parent
// folder, a package that isn't there yet but a pull adds), and a package
// npm installed may import one the repo committed. Installed (untracked)
// packages stay as they are. When git can't say what it tracks (it fails,
// or the folder isn't a git checkout but has a node_modules), patch trust
// can't tell an installed package from a shipped one, so it fails closed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import type { Reads } from './script-trust.ts';

// What git tracks under node_modules in one repo: `files`, by path (links
// too), `lower` the same compared as the filesystem does, `links`, the
// tracked symlinks, and `indexes`, what's watched for a change: the index
// files that say so, and each submodule's .git, there or not (one turning
// up is a submodule checked out since); or `problem` when git couldn't say.
export type TrackedNodeModules = { files: Set<string>; links: Set<string>; indexes: string[]; lower: Set<string> } | { problem: string };

// Whether a path's folder names include node_modules. Without case on a
// Mac or Windows, where Node's `node_modules` finds a committed
// `NODE_MODULES` (Codex's review, 7 Nov).
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
export function inNodeModules(rel: string): boolean {
  return rel.split(/[\\/]/).some((s) => (FOLD ? s.toLowerCase() : s) === 'node_modules');
}
const fold = (p: string) => (FOLD ? p.toLowerCase() : p);

// At most this many tracked files under node_modules are followed, and
// submodules this deep; a repo that commits more can't be checked.
export const MAX_TRACKED_PACKAGE_FILES = 100;
const MAX_SUBMODULE_DEPTH = 8;
const MAX_SUBMODULES = 50;

type Listing = { files: Set<string>; links: Set<string>; indexes: string[]; lower: Set<string> };
const cache = new Map<string, { key: string; out: Listing }>();

// git, without anything a repo's own config could make it run: a folder
// from a zip can carry a .git/config with core.fsmonitor set, which `git
// ls-files` would start.
function git(dir: string, args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
}

// What the index files look like now: a cached listing holds while this is
// the same. A pull that starts tracking node_modules/zod over an installed
// copy writes the files and the index, but none of the files a hash read.
function indexKey(indexes: string[]): string {
  return indexes
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${f}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      } catch {
        return `${f}:none`;
      }
    })
    .join('\n');
}

// One repo's tracked entries, and its populated submodules', by git's own
// listing in each (not `--recurse-submodules`, which skips a submodule its
// config calls inactive though its files are on disk).
function list(top: string, dir: string, depth: number, out: Listing): string | undefined {
  try {
    out.indexes.push(path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'index']).trim()));
  } catch {
    return `git couldn't list what ${dir} tracks`;
  }
  let listed: string;
  try {
    listed = git(dir, ['ls-files', '-z', '-s']);
  } catch {
    return `git couldn't list what ${dir} tracks`;
  }
  for (const line of listed.split('\0')) {
    const m = /^(\d{6}) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(line);
    if (!m) continue;
    const p = path.join(dir, m[2]!);
    if (m[1] === '160000') {
      // A submodule: what's in it is tracked too, if it's there at all.
      // Its .git is watched either way, so checking it out later (which
      // changes no index this has read) shows (Codex's review, 7 Nov).
      out.indexes.push(path.join(p, '.git'));
      if (!fs.existsSync(path.join(p, '.git'))) continue;
      if (depth >= MAX_SUBMODULE_DEPTH || out.indexes.length >= MAX_SUBMODULES) return `the repo nests more submodules than patch trust follows`;
      const why = list(top, p, depth + 1, out);
      if (why) return why;
      continue;
    }
    if (!inNodeModules(path.relative(top, p))) continue;
    if (m[1] === '120000') out.links.add(p);
    out.files.add(p);
    out.lower.add(fold(p));
  }
  return undefined;
}

// What git tracks under node_modules in the repo at `top` (a real path),
// its submodules included. Listed again only when an index changes, and
// every index watched by `reads`, so a cached hash looks again then too.
export function trackedNodeModules(top: string, reads?: Reads): TrackedNodeModules {
  if (!fs.existsSync(path.join(top, '.git'))) {
    return { problem: `${top} isn't a git checkout, so patch trust can't tell a package npm installed from one the folder ships in node_modules.` };
  }
  const hit = cache.get(top);
  if (hit && indexKey(hit.out.indexes) === hit.key) {
    for (const f of hit.out.indexes) reads?.watch(f);
    return hit.out;
  }
  const out: Listing = { files: new Set(), links: new Set(), indexes: [], lower: new Set() };
  const why = list(top, top, 0, out);
  for (const f of out.indexes) reads?.watch(f);
  if (why) return { problem: `${why}, so patch trust can't tell a package npm installed from one the repo ships in node_modules.` };
  cache.set(top, { key: indexKey(out.indexes), out });
  return out;
}

// What a bare import from a file in `fromDir` means for the repo at `top`
// (a real path): `undefined` for a builtin, or a folder with no
// node_modules inside it; otherwise `files`, every file git tracks under
// node_modules in the repo, which the caller hashes and follows (none when
// it tracks none: every package there was installed), or `problem` when
// that can't be told or followed.
export function bareImport(fromDir: string, spec: string, top: string, reads?: Reads): { files: string[] } | { problem: string } | undefined {
  if (isBuiltin(spec) || spec.startsWith('node:')) return undefined;
  if (!fs.existsSync(path.join(top, '.git'))) {
    // Not a checkout: fine only while there's no node_modules on the way
    // up inside it (each looked at is noted, so one turning up shows).
    let any = false;
    for (let d = fromDir; inside(d, top); d = path.dirname(d)) {
      const nm = path.join(d, 'node_modules');
      if (reads ? reads.real(nm) !== undefined : fs.existsSync(nm)) any = true;
      if (d === top || path.dirname(d) === d) break;
    }
    return any ? { problem: `${top} isn't a git checkout, so patch trust can't tell a package npm installed from one the folder ships in node_modules.` } : undefined;
  }
  const tracked = trackedNodeModules(top, reads);
  if ('problem' in tracked) return tracked;
  if (tracked.files.size > MAX_TRACKED_PACKAGE_FILES) return { problem: `the repo commits ${tracked.files.size} files under node_modules, more than the ${MAX_TRACKED_PACKAGE_FILES} patch trust follows.` };
  for (const f of tracked.files) {
    // A link sends Node somewhere the repo chose, which isn't followed.
    if (tracked.links.has(f)) return { problem: `${path.relative(top, f)} is a link the repo commits under node_modules, which patch trust doesn't follow.` };
    if (f.endsWith('.node')) return { problem: `${path.relative(top, f)} is a native addon the repo commits, which patch trust can't read.` };
  }
  return { files: [...tracked.files].sort() };
}

// The packages in the node_modules folders from `fromDir` up, inside the
// repo at `top`, that are links to something of the repo's outside any
// node_modules: workspace and `file:` packages. Node follows the link and
// loads the repo's own files, which aren't tracked under node_modules, so
// bareImport doesn't count them. Not a package npm installed (real files in
// node_modules, or pnpm's links into its store there), nor one outside the
// repo (a worktree's node_modules linked to the main checkout's). Each folder
// is watched, so a link turning up shows in a cached hash.
export function linkedPackages(fromDir: string, top: string, reads?: Reads): string[] {
  const out = new Set<string>();
  const take = (p: string) => {
    let real: string | undefined;
    try {
      real = reads ? reads.real(p) : fs.realpathSync(p);
    } catch {
      return;
    }
    if (real !== undefined && inside(real, top) && !inNodeModules(path.relative(top, real))) out.add(real);
  };
  const links = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (let d = fromDir; inside(d, top); d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    reads?.watch(nm);
    for (const e of links(nm)) {
      if (e.isSymbolicLink()) take(path.join(nm, e.name));
      else if (e.isDirectory() && e.name.startsWith('@')) {
        reads?.watch(path.join(nm, e.name));
        for (const s of links(path.join(nm, e.name))) if (s.isSymbolicLink()) take(path.join(nm, e.name, s.name));
      }
    }
    if (d === top || path.dirname(d) === d) break;
  }
  return [...out].sort();
}

// Every file of a package the repo links into node_modules, bar its own
// node_modules and .git. All of them, as its package.json's `exports` and
// `main` decide which one an import loads, by rules this doesn't repeat.
// `problem` past `limit`: what's over can't be vouched for.
export function packageFiles(root: string, limit: number): { files: string[] } | { problem: string } {
  try {
    if (fs.statSync(root).isFile()) return { files: [root] };
  } catch {
    return { files: [] };
  }
  const files: string[] = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) queue.push(p);
      else if (e.isFile()) files.push(p);
      else if (e.isSymbolicLink()) {
        // A link to a folder could lead anywhere or back, and one to a file
        // makes a `.js` name stand for what isn't (Codex's review, 7 Nov).
        // As for links a repo commits under node_modules: not followed.
        return { problem: `${path.relative(root, p)} in it is a link, which patch trust doesn't follow.` };
      }
      if (e.name.endsWith('.node')) return { problem: `${path.relative(root, p)} in it is a native addon, which patch trust can't read.` };
      if (files.length > limit) return { problem: `it has more than ${limit} files, more than patch trust follows.` };
    }
  }
  return { files };
}

// For the module hooks (verified-imports.ts): why a file a trusted patch's
// bare import resolved to mustn't load from disk, or undefined when it may:
// one git tracks under node_modules in the patch's repo (`top`) that
// `served` (the hashed files) hasn't got, or one inside a repo git can't
// list. The hash covers every committed file once the patch has a bare
// import, so this only catches one it couldn't have seen (an import a
// pull's data turns on before the hash is read again).
export function unhashedPackageFile(file: string, top: string, served: (file: string) => boolean): string | undefined {
  if (!inside(file, top)) return undefined;
  const tracked = trackedNodeModules(top);
  if ('problem' in tracked) return inNodeModules(path.relative(top, file)) ? tracked.problem : undefined;
  if (tracked.lower.has(fold(file)) && !served(file)) return `${file} is a file the repo commits under node_modules that patch trust didn't hash`;
  return undefined;
}

// The checkout a patch file is in, as patch trust finds it: the nearest
// folder up with a .git, else its own folder.
export function repoTopOf(file: string): string {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return path.dirname(file);
  }
}

function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
