// Files an agent's Edit or Write turns into code that runs by itself
// (docs/protocol.md, "Agent writes that run as code").
//
// A patch file is imported into the runner, and its hooks and setup run
// unasked; a folder's Claude Code settings start hooks and MCP servers. So
// in a thread that isn't on Full access, writing one is running code, and
// the permission to edit a file mustn't stand in for permission to run it
// (Gautam's scan, 6 Nov: F1, F4). In Ask and Auto, an edit of one of these
// always asks, with no "Always allow", whatever the thread's rules or the
// auto classifier would say, and what it writes isn't trusted: Mike trusts
// it in Patches. On Full access nothing changes, as the agent could run
// anything there already.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Said on the approval card, after the edit's own title.
export const RUNS_AS_CODE = 'Threadbear runs this file as code';

// Said instead when this file isn't known to run, but a patch that loads
// without a hash does something Threadbear can't follow, so any edit might be
// what it runs. The card asks the same; it just doesn't claim more than that.
export const MAYBE_RUNS_AS_CODE = "Threadbear can't tell whether this file runs as code";

// Whether a write runs as code, or might: 'unsure' is the catch-all above.
export type CodeWrite = boolean | 'unsure';

// What the approval card says for a write that asks.
export const codeWriteNote = (kind: CodeWrite): string => (kind === 'unsure' ? MAYBE_RUNS_AS_CODE : RUNS_AS_CODE);

// What a PreToolUse hook tells the CLI when it makes such an edit ask.
export const codeWriteReason = (kind: CodeWrite): string => `${codeWriteNote(kind)}, so it always asks outside Full access.`;

// By name alone, wherever it is: a patch file (a project's or
// ~/.threadbear/patches, which is trusted whatever it holds), anything else
// under ~/.threadbear (what home patches import), Claude Code settings
// (`.claude/settings.json`, `settings.local.json` and the like, home's
// included) and an `.mcp.json`. The runner adds the files a patch it has
// hashed covers, and the scripts the thread folder's Claude settings name.
export function runsAsCodeByName(file: string, home: string = os.homedir()): boolean {
  // By the name as written and as the disk has it, without case: on macOS
  // `.Threadbear/Patches/x.ts` is the same file as `.threadbear/patches/x.ts`;
  // a symlink to a patch writes the patch, and a patch that is a symlink
  // (`~/.threadbear/patches/x.ts` to `~/src/x.ts`) runs what its name says.
  // The runner adds what such a link points at (writeRunsAsCode).
  const homeDir = path.join(path.resolve(home), '.threadbear');
  const homes = [homeDir.toLowerCase(), canonicalPath(homeDir).toLowerCase()];
  return [path.resolve(file), canonicalPath(file)].some((p) => {
    const abs = p.toLowerCase();
    const dir = path.dirname(abs);
    if (path.basename(dir) === 'patches' && path.basename(path.dirname(dir)) === '.threadbear' && ['.ts', '.js', '.mjs'].includes(path.extname(abs))) return true;
    if (homes.some((h) => isInside(abs, h))) return true;
    const name = path.basename(abs);
    if (name === '.mcp.json') return true;
    return path.basename(dir) === '.claude' && /^settings(\..*)?\.json$/.test(name);
  });
}

// `file` with the symlinks on its way resolved and each name as the disk
// spells it, as far as it exists; the rest as given. A link to something
// not there yet is followed too: a Write through it makes its target, so
// `notes.txt -> ~/.threadbear/patches/p.ts` is a patch (Codex review).
export function canonicalPath(file: string, depth = 0): string {
  const abs = path.resolve(file);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // missing, or a link to something missing
  }
  const up = path.dirname(abs);
  if (up === abs || depth > 40) return abs;
  const parent = canonicalPath(up, depth + 1);
  const here = path.join(parent, path.basename(abs));
  try {
    if (fs.lstatSync(here).isSymbolicLink()) return canonicalPath(path.resolve(parent, fs.readlinkSync(here)), depth + 1);
  } catch {
    // not there at all
  }
  return here;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
