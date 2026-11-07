// Which patch files the runner may load (docs/protocol.md, "Trusting a
// folder's patches").
//
// A patch file is code: the runner imports it, and its hooks, live
// functions and worktree setup run by themselves. Without a gate, opening a
// thread in a repo someone else wrote would run that repo's code before
// you'd sent a word. So a project's patch file only loads once you've
// trusted it, the way VS Code and Claude Code ask before running a
// folder's code.
//
// Trust is kept per folder (the one holding `.threadbear/`) as the hashes
// of the patch files you said yes to. A file whose content you haven't
// trusted waits: "new" when nothing in that folder has been trusted yet,
// "changed" when something has (a git pull brought a new version). A
// patch file a Full access thread's agent writes with Edit or Write in its
// own folder is trusted as it stands, as that agent could already run
// anything there, and asking about every button you ask for would be
// noise. Not in Ask or Auto, where it couldn't (code-writes.ts), and an
// Edit only when the file it started from was trusted: it vouches for
// what it changed, not for the rest of the file.
//
// A git worktree counts as its main checkout, so a thread's worktree of a
// trusted repo isn't asked about again. Only a worktree git itself made
// counts: the worktree's .git file and the repo's record of it must point
// at each other, so a folder can't claim to be a worktree of a trusted repo.
//
// Always trusted: ~/.threadbear/patches (yours, like ~/.zshrc) and
// Threadbear's own checkout (the code that's already running you).
//
// What's hashed is the patch file and every local file it imports, and
// theirs in turn (relative or absolute specifiers: `./lib/ask.ts`), so a
// pull that changes only a helper is asked about too. Files it names in a
// `./` or `../` path (the script its worktree setup or an action runs) are
// hashed as well, as they run by themselves too, and so is what those
// scripts run in turn (script-trust.ts), in an encoding no file name can
// fake (patchHash).
// Packages (`node:fs`, `zod`) aren't followed: they're the folder's
// dependencies, as `npm install` put them there, and hashing node_modules
// every 15 seconds would be slow and re-ask after every install. Files the
// repo commits under node_modules are its own code, though, and are hashed
// (tracked-packages.ts).
//
// The hash is only worth anything if it covers what will run. A patch that
// loads code by a name worked out when it runs (`import(name)`,
// `createRequire`), doesn't parse, or reaches more files than are followed,
// can't be checked, so it isn't loaded at all, trusted or not: its `error`
// says why (scanModule).
// Saying yes to it would trust whatever that name points at later. The
// same for a command it runs by itself (setup, hooks) that's anything but
// one hashed script and plain words (automaticCommand).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { atomicWriteFileSync } from './fsutil.ts';
import { claudeCommands, type ClaudeOptions } from './claude-trust.ts';
import { isBinary, looksRunnable, MAX_READ_BYTES, reachOf, reachOfCommand, Reads, type FollowOptions, type ScriptReach } from './script-trust.ts';
import { bareImport } from './tracked-packages.ts';
import { allowCommand } from './shell-allowlist.ts';

export type TrustVerdict =
  // `files`: the local files its hash covered, real paths. Absent when the
  // folder is trusted whatever it holds (home's, Threadbear's own), which
  // is how the loader knows not to hold its commands to automaticCommand.
  // `blocked`: scripts it names that run something patch trust can't
  // follow, with why; a command that runs by itself can't be one.
  // `hash` and `code` (the patch's import graph as the bytes that hash was
  // made from, by real path) when it's trusted by hash: the loader imports
  // those bytes, not the folder's files as they are by then.
  // `edges`: each of those files' local import specifiers to the file the
  // hash took them to.
  | { trusted: true; files?: string[]; blocked?: Record<string, string>; hash?: string; root?: string; code?: Map<string, Buffer>; edges?: Map<string, Map<string, string>> }
  | { trusted: false; reason: 'new' | 'changed'; hash: string; helpers?: string[] }
  // Nothing can trust it as it stands (see the top): `problem` says why.
  | { trusted: false; reason: 'unchecked'; problem: string };

// A folder's Claude Code settings that run commands (claude-trust.ts):
// trusted, or nothing in them runs anything, or waiting with what would.
// `grants`: with ClaudeOptions.grants, what they'd let run unasked, in
// words. 'unchecked': the hash can't cover what would run (`problem`), so
// nothing can trust it as it stands.
export type ClaudeVerdict =
  | { trusted: true }
  // `read`: each file the hash was made from, by the hash of the bytes read.
  | { trusted: false; reason: 'new' | 'changed'; hash: string; files: string[]; named: string[]; read: Record<string, string>; grants?: string[] }
  | { trusted: false; reason: 'unchecked'; problem: string; hash: string; files: string[]; named: string[]; read: Record<string, string>; grants?: string[] };

// Claude settings hashes go in the same per-folder list as patch files',
// with this in front, so a runner from before them keeps them when it
// saves (they're strings it never matches) and they can be told apart.
export const CLAUDE_PREFIX = 'claude:';
// A schedule's check, as approved (checkDigest), in that folder's list too:
// the same store, the same rules for a worktree, and only the runner's own
// file to write it in, never the backend's row.
export const CHECK_PREFIX = 'check:';
// A patch hash from a trust file before version 3, kept only to say the
// folder had something trusted: it never matches (see TrustFile).
const LEGACY_PREFIX = 'legacy:';

// Where a Claude settings file's approved bytes are kept, by kind of
// thread: apart from patch files', and a thread that asks first apart
// from a Full one.
function claudeScope(opts: ClaudeOptions): string {
  return opts.grants ? 'claude-grants\0' : 'claude\0';
}

// Hashes kept per folder: enough for a repo's patches across a few
// branches and versions, without the file growing for ever.
export const HASHES_KEPT = 200;

// Version 1 hashed patch files alone, and version 2 joined `<path> <sha>`
// lines with newlines, which a path holding a newline could fake (Gautam's
// scan, 6 Nov). Version 3's hash (HASH_TAG) is made a way no path can fake,
// so no earlier hash matches one now: every patch trusted before is asked
// about again ("changed"), once. Nothing is carried over from an old hash,
// as an old hash can't tell the file sets it was fooled by apart. (Version
// 2 had carried a version 1 patch's helpers over as trusted, which trusted
// whatever a pull had put there: Daybreak, 5 Nov.) Old hashes stay in the
// list until HASHES_KEPT pushes them out, matching nothing. A `legacy`
// list a runner from then wrote is ignored, and goes on the next save.
type TrustFile = { version: 1 | 2 | 3; folders: Record<string, string[]> };

// In front of every patch hash, the helper-less ones too, so no version's
// hash can match another's, nor one patch's text another's whole hash.
const HASH_TAG = 'threadbear-patch-3';
// Control characters (a newline, a NUL): no followed path may hold one.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

// At most this many local files are followed from one patch file; one that
// reaches more can't be checked.
export const MAX_HELPERS = 100;

export interface PatchGate {
  // Whether a project's patch file may load. `mtimeMs` keys the hash cache.
  check(file: string, mtimeMs: number): Promise<TrustVerdict>;
}

// What the runner keeps: the gate, and the ways in.
export interface PatchTrustStore extends PatchGate {
  readonly existed: boolean;
  trust(file: string, hash: string): boolean;
  // As they are now, unasked: the first start's seeding.
  trustCurrent(files: string[]): string[];
  // An agent's verified edit, in a Full access thread in `folder`, left
  // `file` as bytes hashing to `sha256` (an adapter's 'wrote'). `base`:
  // the hash of the file it edited, or null when it wrote all of it (a
  // Write, or an edit of a missing or empty file). Trusts the patch files
  // it's part of (itself, or ones importing or running it) only while it
  // still has those bytes and every other file in the patch's hash is
  // bytes trusted before or another such edit's: one edit doesn't vouch
  // for files it didn't write, nor an Edit for the rest of a file that
  // wasn't trusted before it. Only files inside `folder` count, only
  // patches in `folder`'s own `.threadbear/patches`, and only patches
  // already looked at are known as importing it.
  trustAgentWrite(file: string, sha256: string, base: string | null, folder: string): string[];
  // Whether `file` is part of a patch this has hashed (the patch file, a
  // helper, a script it names): an edit to it changes code that runs.
  covers(file: string): boolean;
  // Whether a patch folder's patches load whatever they hold, unhashed
  // (Threadbear's own checkout): code-writes looks at those itself.
  loadsUnhashed(dir: string): boolean;
  // Whether `file` hashes to `hash` now, read afresh (no cache): checked
  // just before a trusted hook or setup script runs.
  verify(file: string, hash: string): boolean;
  // The thread folder's Claude Code settings (claude-trust.ts), with
  // what lets tools run unasked counted too for a thread that asks first
  // (`grants`).
  checkClaude(cwd: string, opts?: ClaudeOptions): ClaudeVerdict;
  trustClaude(cwd: string, hash: string): boolean;
  // An agent's verified Edit or Write to `file` in a Full access thread in
  // `cwd`, which wrote bytes hashing to `sha256` from a file hashing to
  // `base` (null: it wrote all of it): the folder's settings are trusted
  // as they are only while the file still has those bytes, an Edit's
  // `base` was bytes trusted before, and every other file they're hashed
  // from is bytes trusted before or another such edit's. Only a file
  // inside `cwd`. True when they were.
  trustClaudeEdit(cwd: string, file: string, sha256: string, base: string | null): boolean;
  // A schedule's check, run in `cwd`: approve it as it is now (what it runs,
  // hashed), and whether that's what's there now, read afresh. `card`: it's
  // a card's approval, from a thread that asks first, which throws unless
  // that's what's there now and it can all be followed.
  approveCheck(command: string, cwd: string, card?: CheckCard): void;
  checkApproved(command: string, cwd: string): { approved: boolean; hash: string };
  save(): void;
}

// Lets every file through: tests that aren't about trust, and `tb land`
// reading the worktree check it was asked to run.
export const TRUST_ALL: PatchTrustStore = {
  existed: true,
  check: async () => ({ trusted: true }),
  trust: () => true,
  trustCurrent: (files) => files,
  trustAgentWrite: () => [],
  covers: () => false,
  loadsUnhashed: () => true,
  verify: () => true,
  checkClaude: () => ({ trusted: true }),
  trustClaude: () => true,
  trustClaudeEdit: () => false,
  approveCheck: () => {},
  checkApproved: () => ({ approved: true, hash: '' }),
  save: () => {},
};

export class PatchTrust implements PatchTrustStore {
  private file?: string;
  private folders = new Map<string, string[]>();
  private always: string[];
  // Bounds the .mcp.json search (claude-trust.ts); tests set it.
  private claudeHome?: string;
  // `trusted`: some version of this patch was trusted while this runner
  // has run, so an agent's edit to one of its helpers may carry it on.
  private hashes = new Map<string, HashEntry>();
  // Bytes, by real path and SHA-256, that were part of a trusted version
  // of a patch or of a folder's Claude settings while this runner has run,
  // or that an agent's verified edit wrote. An agent's edit trusts a patch
  // only when every file in it is one of these.
  private approved = new Map<string, Set<string>>();
  // Whether there was a trust file when this started. A runner from before
  // trust existed has none, and seeds it from what it was already running.
  readonly existed: boolean;

  // `file` undefined keeps it in memory (tests). `always` are folders whose
  // patches are trusted whatever they hold.
  constructor(opts: { file?: string; always?: string[]; claudeHome?: string } = {}) {
    this.file = opts.file;
    this.claudeHome = opts.claudeHome;
    this.always = (opts.always ?? []).map((d) => realpath(path.resolve(d)));
    this.existed = this.load() !== 'missing';
  }

  // Reads the file again when another runner (one finishing turns after a
  // handover) has written it since. A missing file is a first start; an
  // unreadable one trusts nothing, and isn't seeded over: a broken file
  // shouldn't quietly trust everything.
  private loadedMtime?: number;
  private load(): 'missing' | 'read' | 'same' | 'broken' {
    if (!this.file) return 'missing';
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      return 'missing';
    }
    if (mtimeMs === this.loadedMtime) return 'same';
    this.loadedMtime = mtimeMs;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<TrustFile>;
      // A file from before version 3: its patch hashes go under LEGACY, so
      // none can match a version 3 one. Moving the tag wasn't enough: an
      // old hash of a helper-less patch is its bytes' SHA-256, so an old
      // patch whose text was a version 3 hash's JSON had the same hash as
      // the patch it names (Codex's review, 6 Nov). They still say the
      // folder had something trusted ("changed").
      const legacy = typeof raw.version !== 'number' || raw.version < 3;
      this.folders.clear();
      for (const [key, list] of Object.entries(raw.folders ?? {})) {
        if (!Array.isArray(list)) continue;
        const hashes = list.filter((h): h is string => typeof h === 'string');
        this.folders.set(key, legacy ? hashes.map((h) => (h.startsWith(CLAUDE_PREFIX) || h.startsWith(LEGACY_PREFIX) ? h : LEGACY_PREFIX + h)) : hashes);
      }
      return 'read';
    } catch {
      return 'broken';
    }
  }

  async check(file: string, mtimeMs: number): Promise<TrustVerdict> {
    this.load();
    const key = folderKey(file);
    if (this.always.some((d) => isInside(key, d))) return { trusted: true };
    void mtimeMs;
    const entry = this.hashOf(file);
    const { hash, deps } = entry;
    // Before the hash: a stored yes can't vouch for code the hash didn't see.
    if (entry.incomplete) return { trusted: false, reason: 'unchecked', problem: entry.incomplete };
    const known = this.folders.get(key);
    if (known?.includes(hash)) {
      entry.trusted = true;
      this.approveEntry(entry);
      return { trusted: true, files: deps.map((d) => d.path), hash, root: entry.root, code: entry.code, edges: entry.edges, ...(entry.blocked ? { blocked: entry.blocked } : {}) };
    }
    const helpers = deps.map((d) => d.path);
    const before = known?.some((h) => !h.startsWith(CLAUDE_PREFIX) && !h.startsWith(CHECK_PREFIX));
    return { trusted: false, reason: before ? 'changed' : 'new', hash, ...(helpers.length ? { helpers } : {}) };
  }

  checkClaude(cwd: string, opts: ClaudeOptions = {}): ClaudeVerdict {
    this.load();
    const key = folderKeyOfDir(cwd);
    if (this.always.some((d) => isInside(key, d))) return { trusted: true };
    const found = claudeCommands(cwd, this.claudeHome, opts);
    if (!found) return { trusted: true };
    const known = (this.folders.get(key) ?? []).filter((h) => h.startsWith(CLAUDE_PREFIX));
    const base = { hash: found.hash, files: found.files, named: found.named, read: found.read, ...(found.grants ? { grants: found.grants } : {}) };
    // Before the stored hashes: a yes can't vouch for code the hash didn't see.
    if (found.incomplete) return { trusted: false, reason: 'unchecked', problem: found.incomplete, ...base };
    if (known.includes(CLAUDE_PREFIX + found.hash)) {
      // Kept apart by kind: bytes trusted for what they run (Full) haven't
      // been trusted for the permission rules in them, so an edit can't
      // carry those on (trustClaudeEdit).
      for (const [f, sha] of Object.entries(found.read)) this.approve(claudeScope(opts) + f, sha);
      return { trusted: true };
    }
    return { trusted: false, reason: known.length ? 'changed' : 'new', ...base };
  }

  // Trusting the version a thread that asks first was shown (grants and
  // all) trusts what it runs for a Full thread there too, as it covers it:
  // both hashes are made from this one look, and only when the one shown
  // is what's there now.
  trustClaude(cwd: string, hash: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false;
    const hashes = [CLAUDE_PREFIX + hash];
    const asking = claudeCommands(cwd, this.claudeHome, { grants: true });
    if (asking && !asking.incomplete && asking.hash === hash) {
      const full = claudeCommands(cwd, this.claudeHome);
      if (full && !full.incomplete && full.hash !== hash) hashes.push(CLAUDE_PREFIX + full.hash);
    }
    this.add(folderKeyOfDir(cwd), hashes);
    return true;
  }

  // As a thread that asks first sees them (which covers a Full thread's),
  // when every other file was trusted for that; else as a Full thread
  // does, which leaves the permission rules to be asked about.
  trustClaudeEdit(cwd: string, file: string, sha256: string, base: string | null): boolean {
    const target = path.resolve(cwd, file);
    if (!isInside(realpath(target), realpath(path.resolve(cwd)))) return false;
    for (const opts of [{ grants: true }, {}]) {
      // An Edit wrote only what it changed; the rest is the file it started
      // from, which counts only if it was trusted for this kind of thread (F21).
      if (base !== null && !this.isApproved(claudeScope(opts) + target, base)) continue;
      this.approve(claudeScope(opts) + target, sha256);
      const verdict = this.checkClaude(cwd, opts);
      if (verdict.trusted) return false;
      // Nothing can trust it for a thread that asks first; Full may still.
      if (verdict.reason === 'unchecked') {
        if (opts.grants) continue;
        return false;
      }
      // The hash was made from these bytes, so it vouches for the edit's
      // output and nothing written over it since; and every other file it
      // was made from must be bytes trusted (for this kind of thread) or
      // written by such an edit: a settings.local.json a command wrote
      // isn't the edit's to approve.
      if (verdict.read[target] !== sha256) return false;
      if (!Object.entries(verdict.read).every(([f, sha]) => this.isApproved(claudeScope(opts) + f, sha))) continue;
      if (opts.grants) return this.trustClaude(cwd, verdict.hash);
      this.add(folderKeyOfDir(cwd), [CLAUDE_PREFIX + verdict.hash]);
      return true;
    }
    return false;
  }

  approveCheck(command: string, cwd: string, card?: CheckCard): void {
    if (card) {
      const now = checkDigest(command, cwd);
      if (now.problem) throw new Error(`A schedule's check runs by itself, so what it runs must be something Threadbear can hash, and it can't follow this: ${now.problem} Nothing changed. Put it in a shell script or JavaScript it can follow.`);
      const same = card.hash === now.hash && card.folder !== undefined && folderKeyOfDir(card.folder) === folderKeyOfDir(cwd);
      if (!same) throw new Error('What the check runs, or the folder it runs in, changed while the approval card was up (or could not be read when it went up), so nothing changed. Look at it again and ask again.');
    }
    this.add(folderKeyOfDir(cwd), [CHECK_PREFIX + this.digestOf(command, cwd).hash]);
  }

  // A stored approval only ever comes from approveCheck, on this runner, so
  // a row the backend (or another runner) wrote finds nothing here.
  checkApproved(command: string, cwd: string): { approved: boolean; hash: string } {
    this.load();
    const { hash } = this.digestOf(command, cwd);
    return { approved: (this.folders.get(folderKeyOfDir(cwd)) ?? []).includes(CHECK_PREFIX + hash), hash };
  }

  // Threadbear's own checkout runs whatever it holds, so there only the
  // command is bound, not what it reaches, or every landing would ask.
  private digestOf(command: string, cwd: string): CheckDigest {
    return checkDigest(command, cwd, this.always.some((d) => isInside(folderKeyOfDir(cwd), d)));
  }

  // Trusts one version of a patch file, by the hash the app showed. False
  // when the file isn't a patch file.
  trust(file: string, hash: string): boolean {
    if (!isPatchFile(file) || !/^[0-9a-f]{64}$/.test(hash)) return false;
    this.add(folderKey(file), [hash]);
    return true;
  }

  // Trusts patch files as they are on disk now, unasked: the first
  // start's seeding. Files that can't be read are skipped.
  trustCurrent(files: string[]): string[] {
    return this.trustWhere(files, () => true);
  }

  trustAgentWrite(file: string, sha256: string, base: string | null, folder: string): string[] {
    const target = realpath(path.resolve(file));
    // The thread's own folder only: an agent working in one repo doesn't
    // vouch for another project's patches, or a tool patch's.
    const within = realpath(path.resolve(folder));
    if (!isInside(target, within)) return [];
    // An Edit wrote only what it changed; the rest of the file is what it
    // started from. Unless that was trusted bytes (a version of a trusted
    // patch, or another such edit's), a small edit to a cloned or pulled
    // file would trust all of it (Gautam's scan, F21).
    if (base !== null && !this.isApproved(target, base)) return [];
    this.approve(target, sha256);
    // And only the folder's own patches, from its own `.threadbear/`: in a
    // thread in a parent folder (~, ~/dev), every repo under it is inside,
    // but their patches aren't this thread's.
    // By where its patches folder is, not the file: a patch that's a link
    // to `src/p.ts` is still the folder's own.
    const own = (f: string) => path.dirname(path.dirname(realpath(path.dirname(path.resolve(f))))) === within;
    const files = isPatchFile(file) && own(file) ? [file] : [];
    for (const [f, h] of this.hashes) if (!files.includes(f) && own(f) && h.deps.some((d) => d.path === target)) files.push(f);
    // The edited file as the edit left it (the bytes hashed now are its),
    // and every other file trusted bytes or another verified edit's.
    return this.trustWhere(files, (entry) => {
      const parts = [{ path: entry.root, sha256: entry.own }, ...entry.deps];
      const mine = parts.find((d) => d.path === target);
      return mine?.sha256 === sha256 && parts.every((d) => d.sha256 === undefined || this.isApproved(d.path, d.sha256));
    });
  }

  loadsUnhashed(dir: string): boolean {
    const key = folderKeyOfDir(path.dirname(path.dirname(path.resolve(dir))));
    return this.always.some((d) => isInside(key, d));
  }

  // Without case, as macOS names a file either way: a wider match only asks more.
  covers(file: string): boolean {
    const target = realpath(path.resolve(file)).toLowerCase();
    const same = (p: string) => p.toLowerCase() === target;
    // `unnamed`: a script it names that isn't there yet, which a write makes.
    for (const h of this.hashes.values()) if (same(h.root) || h.deps.some((d) => same(d.path)) || h.unnamed.some(same)) return true;
    return false;
  }

  verify(file: string, hash: string): boolean {
    this.load();
    if (this.always.some((d) => isInside(folderKey(file), d))) return true;
    try {
      const fresh = patchHash(file);
      return !fresh.incomplete && fresh.hash === hash;
    } catch {
      return false;
    }
  }

  private approve(file: string, sha256: string): void {
    const set = this.approved.get(file) ?? new Set<string>();
    set.delete(sha256);
    set.add(sha256);
    // A few versions a file each: enough to carry an edit on.
    while (set.size > 50) set.delete(set.values().next().value!);
    this.approved.set(file, set);
  }

  private isApproved(file: string, sha256: string): boolean {
    return this.approved.get(file)?.has(sha256) ?? false;
  }

  private approveEntry(entry: HashEntry): void {
    this.approve(entry.root, entry.own);
    for (const d of entry.deps) if (d.sha256) this.approve(d.path, d.sha256);
  }

  private trustWhere(files: string[], accept: (entry: HashEntry) => boolean): string[] {
    const done: string[] = [];
    const byKey = new Map<string, string[]>();
    for (const file of files) {
      if (!isPatchFile(file)) continue;
      let hash: string;
      try {
        const entry = this.hashOf(file);
        // check() refuses it whatever's stored, so storing it would only
        // say it was trusted when it isn't.
        if (entry.incomplete || !accept(entry)) continue;
        entry.trusted = true;
        this.approveEntry(entry);
        hash = entry.hash;
      } catch {
        continue;
      }
      const key = folderKey(file);
      byKey.set(key, [...(byKey.get(key) ?? []), hash]);
      done.push(file);
    }
    for (const [key, hashes] of byKey) this.add(key, hashes, false);
    if (byKey.size) this.save();
    return done;
  }

  private add(key: string, hashes: string[], save = true): void {
    this.load();
    const list = (this.folders.get(key) ?? []).filter((h) => !hashes.includes(h));
    list.push(...hashes);
    this.folders.set(key, list.slice(-HASHES_KEPT));
    if (save) this.save();
  }

  // Writes the file; seeding writes it even when it found nothing, so the
  // next start doesn't seed again.
  save(): void {
    if (!this.file) return;
    const out: TrustFile = { version: 3, folders: Object.fromEntries(this.folders) };
    atomicWriteFileSync(this.file, JSON.stringify(out, null, 2) + '\n');
    this.loadedMtime = fs.statSync(this.file).mtimeMs;
  }

  // The patch's hash with its helpers'. Cached until anything it was made
  // from changes: a file's inode, size, mtime, ctime or mode (ctime can't
  // be set back, so a write that restores the mtime still shows), a
  // symlink on the way to one retargeted, or a missing one turning up (a
  // stat and a realpath each; patches are read every 15 seconds).
  private hashOf(file: string): HashEntry {
    const hit = this.hashes.get(file);
    if (hit && hit.looked.same()) return hit;
    const entry: HashEntry = { ...patchHash(file), trusted: hit?.trusted };
    this.hashes.set(file, entry);
    return entry;
  }
}

// `sha256`: the hash of the bytes the patch's hash was made from (none
// when it's missing).
type Dep = { path: string; sha256?: string };
type HashEntry = PatchHash & { trusted?: boolean };

// `deps` are the local files hashed with it; `unnamed`, paths it names that
// aren't there (so one turning up changes the hash); `incomplete`, why the
// hash can't cover everything it loads, when it can't.
// `blocked`, the named scripts that run something it can't follow, and why.
// `own`: the hash of the patch file's own bytes, as read for `hash`.
// `code`: the patch file and what it imports, by real path, as the bytes
// that were hashed: what's imported (patches.ts). `looked`: what Reads saw,
// to tell a cached hash still holds.
export type PatchHash = {
  hash: string;
  own: string;
  root: string; // the patch file's real path
  deps: Dep[];
  unnamed: string[];
  code: Map<string, Buffer>;
  // Each file of `code`'s local import specifiers (as written; a file: URL
  // as its path) to the real path the hash followed it to.
  edges: Map<string, Map<string, string>>;
  looked: Reads;
  incomplete?: string;
  blocked?: Record<string, string>;
};

// A patch file's hash: SHA-256 over the JSON of [HASH_TAG, its own text's
// hash, [path, hash] for each local file], the paths relative to the patch
// (so a worktree and its main checkout agree) and sorted. JSON quotes every
// string, so no two file sets read the same: joining `<path> <sha>` lines
// with newlines let a folder named "lib.sh <hex>\nz" stand in for two files
// (Gautam's scan, 6 Nov). A helper it imports that's missing counts as
// missing, so adding it later changes the hash.
export function patchHash(file: string): PatchHash {
  // Every file is read once, through `reads`: the bytes scanned are the
  // bytes hashed, and the patch's own code is imported from them
  // (patches.ts), never read from the folder again.
  const reads = new Reads();
  const root = reads.real(path.resolve(file)) ?? path.resolve(file);
  // A fifo named like a patch would hold the read (and the runner) for ever.
  const text = isFile(root) ? reads.read(root) : undefined;
  if (!text) throw new Error(`can't read ${file}`);
  const own = sha256(text);
  const resolve = (dir: string, spec: string) => resolveHelper(dir, spec, reads);
  // The folder holding `.threadbear/`: where its commands run (a thread's
  // folder, or the worktree's root for setup), so `./setup.sh` is there.
  const folder = path.dirname(path.dirname(path.dirname(root)));
  const seen = new Set([root]);
  const deps: Dep[] = [];
  // The patch's import graph: what Node loads, served from these bytes.
  const code = new Map<string, Buffer>([[root, text]]);
  const edges = new Map<string, Map<string, string>>();
  const unnamed = new Set<string>();
  let incomplete: string | undefined;
  const add = (dep: Dep): boolean => {
    if (deps.length >= MAX_HELPERS) {
      incomplete ??= `patch trust follows at most ${MAX_HELPERS} local files, and this patch reaches more.`;
      return false;
    }
    deps.push(dep);
    return true;
  };
  const named = new Set<string>();
  // Every string in the patch and its helpers: any could be a command it
  // runs (an action's `run`, `sh("node scripts/x.mjs")` in a live function).
  const commands = new Set<string>();
  const queue: { from: string; text: string; shipped?: boolean }[] = [{ from: root, text: text.toString('utf8') }];
  const top = repoTop(realpath(folder));
  scan: while (queue.length) {
    const { from, text: src, shipped } = queue.shift()!;
    const { specifiers, packages, strings, problem } = scanModule(src, from);
    // A package the repo ships is followed for what it loads, not read
    // for commands: those are the patch's own.
    if (!shipped) for (const s of strings) if (commands.size < 2000 && /\S/.test(s) && s.length < 2000) commands.add(s);
    // A bare import of a package inside the repo: every file the repo
    // commits under node_modules is hashed and followed like a helper
    // (tracked-packages.ts), so a pull that changes a committed
    // node_modules/zod asks again; an installed package isn't. One git
    // can't vouch for refuses the patch.
    for (const spec of packages) {
      const bare = bareImport(path.dirname(from), spec, top, reads);
      if (!bare) continue;
      if ('problem' in bare) {
        incomplete ??= `${from === root ? path.basename(root) : path.relative(path.dirname(root), from)} imports ${spec}, and ${bare.problem}`;
        continue;
      }
      for (const f of bare.files) {
        if (seen.has(f)) continue;
        seen.add(f);
        if (!add({ path: f })) break scan;
        const bytes = isFile(f) ? reads.read(f) : undefined;
        if (!bytes) continue;
        code.set(f, bytes);
        if (SCANNED.includes(path.extname(f))) queue.push({ from: f, text: bytes.toString('utf8'), shipped: true });
      }
    }
    if (problem && !incomplete) {
      const name = from === root ? path.basename(root) : path.relative(path.dirname(root), from);
      incomplete =
        problem.kind === 'parse'
          ? `patch trust can't read ${name} (${problem.code}, line ${problem.line}), so it can't check what it loads.`
          : `patch trust can't check what ${name} line ${problem.line} loads (\`${problem.code}\`). Import local files by a plain path, like './lib/x.ts', and it can.`;
    }
    for (const spec of specifiers) {
      const target = resolve(path.dirname(from), spec);
      if (!edges.has(from)) edges.set(from, new Map());
      edges.get(from)!.set(spec, target);
      if (seen.has(target)) continue;
      seen.add(target);
      if (!add({ path: target })) break scan;
      const bytes = isFile(target) ? reads.read(target) : undefined;
      if (!bytes) continue; // hashed as missing below
      code.set(target, bytes);
      if (SCANNED.includes(path.extname(target))) queue.push({ from: target, text: bytes.toString('utf8'), ...(shipped ? { shipped } : {}) });
    }
    if (shipped) continue;
    // Named files are hashed, and what a named script runs in turn is
    // followed below (script-trust.ts). From both places a path is read
    // from, each that's there: the first alone left the folder's own
    // `./setup.sh` out whenever the patch folder had one of the same name.
    // A command that `cd`s first isn't worked out here; automaticCommand
    // refuses one that runs by itself.
    // Only code (looksRunnable): a data file the patch names, like the
    // `./state.json` it writes, would change the hash every run.
    for (const spec of namedPaths(src)) {
      const tries = [path.resolve(path.dirname(from), spec), path.resolve(folder, spec)];
      for (const t of tries) {
        if (!looksRunnable(t)) continue;
        const target = isFile(t) ? reads.real(t) : undefined;
        if (!target) {
          reads.real(t);
          unnamed.add(t);
          continue;
        }
        named.add(target);
        if (seen.has(target)) continue;
        seen.add(target);
        if (!add({ path: target })) break scan;
      }
    }
  }
  // What each named script runs, reads and sources, followed through
  // shells, package scripts and imports: a trusted `./setup.sh` that runs
  // `./helper.sh` ran a changed helper unasked (Daybreak verify-fix,
  // 5 Nov). Its own bound, so a big script doesn't stop the patch loading.
  const opts = { folder: realpath(folder), top, scanJs: scriptScan, resolveImport: resolve, namedPaths, reads };
  let blocked: Record<string, string> | undefined;
  for (const script of named) {
    if (!isInside(script, top) || PICTURES.includes(path.extname(script).toLowerCase())) continue;
    const reach = reachOf(script, opts);
    for (const f of reach.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      deps.push({ path: f });
    }
    for (const m of reach.missing) unnamed.add(m);
    if (reach.problem) (blocked ??= {})[script] = reach.problem;
  }
  // Each string followed as a command from the folder, for the files it
  // names in any form (`node scripts/deploy.mjs` left deploy.mjs out when
  // only `./` paths counted: Daybreak verify-fix, 5 Nov). An action runs
  // only when pressed, so what can't be followed doesn't stop it; a
  // command worked out in code is checked as it loads (actionFiles).
  if (isInside(realpath(folder), top)) {
    for (const command of commands) {
      const reach = reachOfCommand(command, 'the command', opts);
      for (const f of reach.files) {
        if (seen.has(f) || PICTURES.includes(path.extname(f).toLowerCase())) continue;
        seen.add(f);
        deps.push({ path: f });
      }
      for (const m of reach.missing) if (unnamed.size < 2000) unnamed.add(m);
    }
  }
  const missing = [...unnamed];
  for (const m of missing) if (!reads.links.has(m)) reads.real(m);
  const dir = path.dirname(root);
  const pairs = deps
    .map((d): [string, string] => {
      const bytes = isFile(d.path) ? reads.read(d.path) : undefined;
      const h = bytes ? sha256(bytes) : 'missing';
      if (bytes) d.sha256 = h;
      return [path.relative(dir, d.path), h];
    })
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  // A path with a newline or another control character in it is refused,
  // not hashed: nothing real needs one, and it's how version 2's encoding
  // was fooled (below).
  const odd = pairs.find(([p]) => CONTROL.test(p));
  if (odd) incomplete ??= `patch trust won't follow ${JSON.stringify(odd[0])}: a path with a newline or another control character in it.`;
  // A file too big to read can't be hashed, so nothing that reaches it can
  // be trusted.
  const huge = [...reads.tooBig][0];
  if (huge) incomplete ??= `patch trust can't read ${path.relative(path.dirname(root), huge)}: it's over ${MAX_READ_BYTES / 1024 / 1024} MB.`;
  const extra = { ...(incomplete ? { incomplete } : {}), ...(blocked ? { blocked } : {}) };
  const hash = sha256(Buffer.from(JSON.stringify([HASH_TAG, own, pairs])));
  // Kept to tell whether a cached hash still holds; the bytes only for
  // the code that's imported.
  reads.bytes.clear();
  reads.texts.clear();
  reads.parsed.clear();
  return { hash, own, root, deps, unnamed: missing, code, edges, looked: reads, ...extra };
}

// scanModule for a script a patch's command runs: its problem as words.
function scriptScan(src: string, file: string): { specifiers: string[]; packages: string[]; strings: string[]; problem?: string } {
  const { specifiers, packages, strings, problem } = scanModule(src, file);
  if (!problem) return { specifiers, packages, strings };
  return {
    specifiers,
    packages,
    strings,
    problem: problem.kind === 'parse' ? `can't be read (${problem.code}, line ${problem.line}), so patch trust can't check what it loads.` : `line ${problem.line} loads code by a name worked out as it runs (\`${problem.code}\`), which patch trust can't follow.`,
  };
}

const SCANNED = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];

// What a module loads, read from its syntax by a real parser: the local
// specifiers it names with a plain string (static and dynamic imports,
// re-exports, require, `import x = require`), and the first load the scan
// can't follow (`problem`). Comments and strings are only words, so
// `import/*c*/(name)` can't slip past and `// import(x)` doesn't count;
// two regexes did both (Daybreak re-scan, 5 Nov). Parsed with oxc, as
// TypeScript 7 has no parser to call from JS and Node's own type
// stripping is experimental. A file that doesn't parse can't be checked.
//
// Covers how a module loads code by name: the module system and what hands
// it out (`createRequire`, `node:module`, `getBuiltinModule`), workers, vm
// and eval. Not shell commands or child processes: a patch's commands run
// anything by design, and the scripts they name are hashed (namedPaths).
// `strings`: every plain string in it, which a script's checks read for
// paths of files it may run (script-trust.ts).
// `packages`: the bare specifiers it imports (`zod`, `node:fs`), which are
// hashed only when the repo commits them (tracked-packages.ts).
//
// `data` and `worktree`: strings found only as fields of the default export
// that aren't commands (patchRoles), or only as its `worktree` setup and check
// (writeRunsAsCode). Never a reason to hash less: `strings` still has them.
export type ModuleScan = { specifiers: string[]; packages: string[]; strings: string[]; data?: string[]; worktree?: string[]; problem?: { kind: 'computed' | 'parse'; line: number; code: string } };

export function scanModule(src: string, file: string): ModuleScan {
  const ext = path.extname(file);
  const sourceType = ext === '.cjs' || ext === '.cts' ? 'commonjs' : ext === '.mjs' || ext === '.mts' ? 'module' : 'unambiguous';
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(file, src, { sourceType, preserveParens: false });
  } catch (e) {
    return { specifiers: [], packages: [], strings: [], problem: { kind: 'parse', line: 1, code: e instanceof Error ? e.message : String(e) } };
  }
  const lineAt = (at: number) => src.slice(0, at).split('\n').length;
  if (parsed.errors.length) {
    const err = parsed.errors[0];
    return { specifiers: [], packages: [], strings: [], problem: { kind: 'parse', line: lineAt(err.labels[0]?.start ?? 0), code: err.message } };
  }
  const specifiers = new Set<string>();
  const packages = new Set<string>();
  const strings = new Set<string>();
  // Each string by what it's for: one used as anything else even once is
  // kept out of `data` and `worktree`, as it might be a command.
  const roles = new Map<AstNode, 'data' | 'worktree'>();
  const seen = { data: new Set<string>(), worktree: new Set<string>(), other: new Set<string>() };
  const giveRole = (n: AstNode, role: 'data' | 'worktree') => {
    if (plainString(n) === undefined) return;
    roles.set(n, role);
    if (n.type === 'TemplateLiteral') roles.set(n.quasis[0], role);
  };
  let readsBack = false;
  let problem: { start: number; end: number } | undefined;
  const refuse = (n: AstNode) => {
    if (!problem || n.start < problem.start) problem = { start: n.start, end: n.end };
  };
  // A specifier written as one plain string: followed when it's a local
  // file, left alone when it's a package, refused when it hands out more.
  const named = (spec: AstNode | undefined, at: AstNode) => {
    const value = spec && plainString(spec);
    if (value === undefined) return refuse(at);
    if (/^\.{1,2}(\/|$)|^\//.test(value)) specifiers.add(value);
    else if (value.startsWith('file:')) {
      try {
        specifiers.add(fileURLToPath(value));
      } catch {
        refuse(at);
      }
    }
    // A data: module's own imports are in a string, and `#x` maps through
    // package.json to a local file this doesn't follow.
    else if (/^(data:|#)/.test(value) || LOADER_MODULES.includes(value)) refuse(at);
    // A package: hashed only when the repo commits it (tracked-packages.ts).
    else packages.add(value);
  };
  // Identifiers and members a load handled already, so they aren't
  // refused as bare references to `require`.
  const handled = new Set<AstNode>();
  const stack: { node: AstNode; parent?: AstNode; key?: string }[] = [{ node: parsed.program as unknown as AstNode }];
  while (stack.length) {
    const { node, parent, key } = stack.pop()!;
    if (TYPE_ONLY.has(node.type)) continue;
    const text = plainString(node);
    if (text !== undefined && strings.size < 5000) strings.add(text);
    // The fixed parts of `node ${x}`, which may name files too.
    if (node.type === 'TemplateElement' && typeof node.value?.cooked === 'string' && strings.size < 5000) strings.add(node.value.cooked);
    // `this` or a getter can read a literal back as something else (a hook's
    // `get run() { return this.title; }`), so nothing here has a role.
    if (node.type === 'ThisExpression' || (node.type === 'Property' && node.kind !== 'init')) readsBack = true;
    const said = text ?? (node.type === 'TemplateElement' && typeof node.value?.cooked === 'string' ? (node.value.cooked as string) : undefined);
    if (said !== undefined) seen[roles.get(node) ?? 'other'].add(said);
    switch (node.type) {
      case 'ExportDefaultDeclaration':
        if (node.declaration.type === 'ObjectExpression') patchRoles(node.declaration, giveRole);
        break;
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source) named(node.source, node);
        break;
      case 'ImportExpression':
        named(node.source, node);
        break;
      case 'TSImportEqualsDeclaration':
        if (node.moduleReference?.type === 'TSExternalModuleReference') named(node.moduleReference.expression, node);
        break;
      case 'CallExpression': {
        const callee = node.callee;
        const isRequire = (callee.type === 'Identifier' && callee.name === 'require') || (callee.type === 'MemberExpression' && propertyName(callee) === 'require');
        const isResolve = callee.type === 'MemberExpression' && callee.object.type === 'MetaProperty' && propertyName(callee) === 'resolve';
        if (isRequire || isResolve) {
          handled.add(callee);
          named(node.arguments[0], node);
        }
        break;
      }
      case 'Identifier':
        if (handled.has(node) || !isReference(parent, key)) break;
        if (LOADER_NAMES.includes(node.name)) refuse(node);
        break;
      case 'MemberExpression': {
        const name = propertyName(node);
        if (name === undefined) {
          // `process[k]`: any property, so any loader, by a name worked out later.
          const o = node.object;
          if (o.type === 'MetaProperty' || (o.type === 'Identifier' && RISKY_OBJECTS.includes(o.name))) refuse(node);
        } else if (!handled.has(node) && LOADER_PROPERTIES.includes(name)) refuse(node);
        break;
      }
    }
    for (const k of Object.keys(node)) {
      if (TYPE_KEYS.has(k)) continue;
      const v = node[k];
      for (const child of Array.isArray(v) ? v : [v]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') stack.push({ node: child as AstNode, parent: node, key: k });
      }
    }
  }
  return {
    specifiers: [...specifiers],
    packages: [...packages],
    strings: [...strings],
    data: readsBack ? [] : [...seen.data].filter((s) => !seen.other.has(s) && !seen.worktree.has(s)),
    worktree: readsBack ? [] : [...seen.worktree].filter((s) => !seen.other.has(s)),
    ...(problem ? { problem: { kind: 'computed' as const, line: lineAt(problem.start), code: src.slice(problem.start, problem.end).replace(/\s+/g, ' ').slice(0, 80) } } : {}),
  };
}

// oxc's ESTree nodes, loosely: the scan only reads a few fields.
type AstNode = { type: string; start: number; end: number; [field: string]: any };

// Names that load code, or hand out something that can, when used as values.
const LOADER_NAMES = ['require', 'eval', 'Function', 'createRequire', 'getBuiltinModule', 'dlopen'];
const LOADER_PROPERTIES = ['require', 'createRequire', 'getBuiltinModule', 'dlopen', '_load'];
// Modules that load code by a name or from a string.
const LOADER_MODULES = ['module', 'node:module', 'vm', 'node:vm', 'worker_threads', 'node:worker_threads'];
// Objects a computed `[k]` on could reach a loader through.
const RISKY_OBJECTS = ['globalThis', 'global', 'process', 'module', 'require', 'self', 'window'];
// TypeScript types: gone before the code runs, so nothing in them loads.
const TYPE_KEYS = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType', 'superTypeArguments', 'implements']);
const TYPE_ONLY = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction']);

function plainString(n: AstNode): string | undefined {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value?.cooked ?? undefined;
  return undefined;
}

// The literals of a patch's `export default { ... }` that aren't commands:
// shown, sent to an agent or matched, never handed to a shell
// (readPatchModule in patches.ts). Only there, written in place: that object
// has no name, so nothing else in the file can run what's in it, where
// `{ title: 'x' }` anywhere else might be read back as `run: o.title` (Codex's
// review). Anything less plain than this isn't given a role.
const PATCH_FIELDS = new Set(['icon', 'appliesTo']);
const ITEM_FIELDS = new Set(['title', 'note', 'icon', 'on', 'tell', 'prompt', 'url', 'edited']);
function patchRoles(patch: AstNode, give: (n: AstNode, role: 'data' | 'worktree') => void): void {
  const fields = (o: AstNode): [string, AstNode][] => o.properties.flatMap((p: AstNode) => {
    const name = p.type === 'Property' ? propertyKey(p) : undefined;
    return name === undefined ? [] : [[name, p.value] as [string, AstNode]];
  });
  const list = (v: AstNode): AstNode[] => (v.type === 'ArrayExpression' ? v.elements.filter(Boolean) : [v]);
  for (const [name, value] of fields(patch)) {
    if (PATCH_FIELDS.has(name)) list(value).forEach((v) => give(v, 'data'));
    else if (name === 'worktree' && value.type === 'ObjectExpression') {
      for (const [k, v] of fields(value)) {
        if (k === 'setup' || k === 'check') give(v, 'worktree');
        else if (k === 'keep') list(v).forEach((e) => give(e, 'data'));
      }
    } else if ((name === 'actions' || name === 'panels' || name === 'hooks') && value.type === 'ArrayExpression') {
      for (const item of list(value)) {
        if (item.type === 'ObjectExpression') for (const [k, v] of fields(item)) if (ITEM_FIELDS.has(k)) give(v, 'data');
      }
    }
  }
}

// The name of an object literal's `name: value`, unless it's worked out.
function propertyKey(n: AstNode): string | undefined {
  if (n.computed) return undefined;
  return n.key.type === 'Identifier' ? n.key.name : plainString(n.key);
}

// `a.b` and `a['b']` name `b`; `a[k]` names nothing the scan can know.
function propertyName(n: AstNode): string | undefined {
  if (!n.computed) return n.property.type === 'Identifier' ? n.property.name : undefined;
  return plainString(n.property);
}

// Whether an identifier is a value in code, not a property's name or a label.
function isReference(parent: AstNode | undefined, key: string | undefined): boolean {
  if (!parent) return true;
  if (key === 'property' && parent.type === 'MemberExpression') return !!parent.computed;
  if (key === 'key') return !!parent.computed;
  return key !== 'label' && parent.type !== 'MetaProperty';
}

// Paths a module names that start ./ or ../, anywhere: in a command
// (`setup: "./scripts/setup.sh --fast"`), an argument, a comment. Extra
// matches only add files to the hash. Pictures are left out: an icon is
// only ever shown, and redrawing one shouldn't ask about the patch again.
//
// Linear in the text: the match is one greedy run with nothing after it to
// backtrack into, and the trailing dots and colons (a sentence's full stop)
// come off by a loop. `/[.:]+$/` restarted at every dot of a long run of
// them, so `./` and a few MB of dots held the runner for minutes before
// anyone was asked anything (Gautam's scan, 6 Nov). A match longer than
// any path can be (PATH_MAX is 1024 on macOS, 4096 on Linux) is no file.
export const MAX_PATH = 4096;

export function namedPaths(src: string): string[] {
  const out = new Set<string>();
  const re = /(?<![\w./\\-])\.\.?\/[^\s'"`;&|()<>{}[\],*?!$=\\]+/g;
  for (let m; (m = re.exec(src)); ) {
    const found = m[0];
    if (found.length > MAX_PATH) continue;
    let end = found.length;
    while (end > 0 && (found[end - 1] === '.' || found[end - 1] === ':')) end--;
    const p = found.slice(0, end);
    if (p.length > 2 && !PICTURES.includes(path.extname(p).toLowerCase())) out.add(p);
  }
  return [...out];
}

// A command a patch makes Threadbear run by itself (a worktree's `setup`,
// a hook), held to what the hash can vouch for: one script, by a `./` or
// `../` path from the folder holding `.threadbear/`, that's a file inside
// the repo and among the files the hash covered (`files`), then plain
// words as arguments. Anything a shell would work out first (`cd x &&`,
// `VAR=1`, `$(...)`, pipes, `;`, quotes, globs, `sh -c`, `bash x.sh`,
// `npm run`) could run code the hash never saw, and was the hole: `cd
// scripts && ./setup.sh` kept its trust while setup.sh changed (Daybreak,
// 5 Nov). So those fail closed rather than being worked out.
//
// `run` is what to hand the shell: the script by its absolute path, every
// word single-quoted, so the file that runs is the one that was hashed
// whatever folder the command runs in (a thread in a subfolder, a worktree).
export type AutomaticCommand = { run: string } | { problem: string };

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function automaticCommand(command: string, folder: string, files: string[], blocked: Record<string, string> = {}): AutomaticCommand {
  const words = command.trim().split(/[ \t]+/);
  const fix = 'Put the steps in a script in the repo and name just that, like "./scripts/setup.sh --fast", so trusting the patch covers what runs.';
  if (!words.every((w) => PLAIN_WORD.test(w))) {
    return { problem: `\`${command}\` runs by itself, so it can only be a script and plain words: patch trust can't vouch for what a shell works out (cd, &&, pipes, variables, quotes). ${fix}` };
  }
  const [script, ...args] = words;
  if (!/^\.\.?\//.test(script)) {
    return { problem: `\`${command}\` runs by itself, so it has to start with a script path like "./setup.sh": ${script} is found on PATH or works out what to run itself, which patch trust can't vouch for. ${fix}` };
  }
  const target = path.resolve(folder, script);
  if (!isFile(target)) return { problem: `\`${command}\` runs ${script}, which isn't a file in ${folder}.` };
  const real = realpath(target);
  if (!isInside(real, repoTop(realpath(folder)))) return { problem: `\`${command}\` runs ${script}, which is outside the repo, so trusting the patch can't cover it.` };
  if (!files.includes(real)) {
    return { problem: `\`${command}\` runs ${script}, which patch trust didn't hash: write the path in the patch as plain text ("${script}"), not worked out in code.` };
  }
  const why = Object.hasOwn(blocked, real) ? blocked[real] : undefined;
  if (why) {
    return {
      problem: `\`${command}\` runs by itself, but patch trust can't follow everything ${script} runs, so trusting the patch couldn't cover it: ${why} Run other scripts by a plain path ("./scripts/x.sh") and package scripts by a plain name ("npm run build").`,
    };
  }
  const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
  // From the folder holding .threadbear/, which is where the follow
  // started: a hook in a thread in a subfolder ran from there, so the
  // script's own relative paths named files nothing had hashed.
  return { run: `cd ${quote(realpath(folder))} && ${[real, ...args].map(quote).join(' ')}` };
}

// Why a command a trusted-by-hash patch's action runs mustn't run, or
// undefined when it may: followed from `folder` as the hash followed it, it
// may reach only files the hash covered (one worked out in code: the hash
// only saw its pieces), no script patch trust can't follow (`blocked`), and
// nothing it can't follow itself. The follow stops at the first thing it
// can't read, so what comes after that wasn't seen, and an empty list of
// files it did see vouched for nothing: a repo put a malicious script after
// an `eval`, and a press ran it (Daybreak, 7 Nov). A problem is no answer,
// so it's a refusal. Pictures count too, as what's run isn't a picture
// whatever it's called (liveCommandProblem).
export function actionCommandProblem(command: string, folder: string, files: string[], blocked: Record<string, string> = {}): string | undefined {
  const real = realpath(folder);
  const reach = reachOfCommand(command, 'the action', { folder: real, top: repoTop(real), scanJs: scriptScan, resolveImport: resolveHelper, namedPaths });
  const missed = reach.files.find((f) => !files.includes(f));
  if (missed) return `runs ${path.relative(real, missed)}, which patch trust didn't hash: write the command in the patch as plain text, so trusting the patch covers what it runs.`;
  const stuck = reach.files.find((f) => Object.hasOwn(blocked, f) && blocked[f]);
  if (stuck) return `runs ${path.relative(real, stuck)}, and patch trust can't follow everything that runs: ${blocked[stuck]}`;
  if (reach.problem) return `can't be checked, so trusting the patch couldn't cover what it runs: ${reach.problem}`;
  return undefined;
}

// What a schedule's check runs, for binding its approval to (a card, or an
// owner's or Full thread's call): the command, and every file it reaches
// from `cwd` by its bytes. Its scripts outside the repo too, as a check is
// often one by its absolute path, each followed from its own folder and
// repo. A file a command names after something the follow can't read is
// hashed as well, since the follow stopped there (`problem`), though what
// that runs in turn isn't: a thread that asks first can't approve one
// (threadbear-mcp.ts). Programs on PATH and installed packages aren't
// followed, as for patches. `commandOnly`: nothing but the command counts.
export type CheckDigest = { hash: string; files: string[]; problem?: string };
// What a card was put up for (threadbear-mcp.ts, checkGuard): the digest and
// folder as it went up, neither when they couldn't be read here.
export type CheckCard = { hash?: string; folder?: string };
const CHECK_TAG = 'threadbear-check-1';

export function checkDigest(command: string, cwd: string, commandOnly = false): CheckDigest {
  if (commandOnly) return { hash: sha256(Buffer.from(JSON.stringify([CHECK_TAG, command, []]))), files: [] };
  const reads = new Reads();
  const start = followOptions(cwd, reads);
  const files = new Set<string>();
  const seen = new Set<string>();
  const queue: { file: string; dir: string }[] = [];
  let problem: string | undefined;
  const take = (reach: ScriptReach) => {
    for (const f of reach.files) files.add(f);
    for (const { file, dirs } of reach.outside ?? []) for (const dir of dirs) queue.push({ file, dir });
    problem ??= reach.problem;
  };
  take(reachOfCommand(command, 'the check', { ...start, outside: true }));
  while (queue.length) {
    const { file: script, dir } = queue.shift()!;
    const key = `${script}\0${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_HELPERS) {
      problem ??= `the check reaches more than ${MAX_HELPERS} scripts outside its repo, more than patch trust follows.`;
      break;
    }
    files.add(script);
    // The script's own repo bounds what's followed as part of it, from the
    // folder it runs in: its `./x` is there, not beside it.
    take(reachOf(script, { ...followOptions(path.dirname(script), reads), folder: dir, outside: true }));
  }
  if (problem) {
    for (const word of command.split(/[\s'"`;&|()<>=]+/)) {
      if (!word || word.length > MAX_PATH) continue;
      const p = path.resolve(start.folder, word.startsWith('~/') ? path.join(os.homedir(), word.slice(2)) : word);
      if (word.includes('/') && isFile(p) && !isBinary(p)) files.add(realpath(p));
    }
  }
  // From the folder inside its repo, so a worktree and its main checkout
  // agree; by the whole path outside it.
  const name = (f: string) => (isInside(f, start.top) ? path.relative(start.folder, f) : f);
  const pairs = [...files]
    .map((f): [string, string] => {
      const bytes = isFile(f) ? reads.read(f) : undefined;
      return [name(f), bytes ? sha256(bytes) : 'missing'];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const huge = [...reads.tooBig][0];
  if (huge) problem ??= `the check reaches ${huge}, over ${MAX_READ_BYTES / 1024 / 1024} MB, more than patch trust reads.`;
  // Whether it stopped, not its wording: the bytes say what changed, and a
  // reworded message shouldn't hold every such check.
  return { hash: sha256(Buffer.from(JSON.stringify([CHECK_TAG, command, pairs, Boolean(problem)]))), files: pairs.map(([f]) => f), ...(problem ? { problem } : {}) };
}

// The files a shell command run in `folder` reaches, as patch trust
// follows a patch's commands (script-trust.ts): the scripts it runs, what
// they import, run and source, there or not. For code-writes, which asks
// before an edit of any of them. `problem`: something it runs that can't
// be followed, a script that isn't there yet included, as the follow
// stops at the first: what came after it wasn't seen.
export function commandFiles(command: string, folder: string): { files: string[]; problem?: string } {
  const real = realpath(folder);
  const reach = reachOfCommand(command, 'the command', { folder: real, top: repoTop(real), scanJs: scriptScan, resolveImport: resolveHelper, namedPaths });
  return { files: [...reach.files, ...reach.missing], ...(reach.problem ? { problem: reach.problem } : {}) };
}

// Why a command a trusted-by-hash patch's live function (`when`, `badge`,
// `summary`, a list panel's `items`) hands `sh` mustn't run, or undefined
// when it may. Those run by themselves, every few seconds, so they're held
// as a hook's script is, short of the one-script rule (a live function's
// command is worked out in code by design): followed from `folder` (the
// one holding `.threadbear/`, where they run), it may reach only files the
// hash covered, no script patch trust can't follow (`blocked`), and
// nothing it can't follow itself. They ran in the thread's folder, so a
// relative script resolved to a file in a subfolder that nothing hashed,
// and a blocked script ran (Gautam's scan, 6 Nov).
//
// The command is held to the short list of shell (shell-allowlist.ts):
// anything outside it is refused, rather than looked over for tricks it
// knows (Mike's call, 7 Nov). The pattern follower still runs too, for the
// files it reaches and anything it refuses: both must pass.
export function liveCommandProblem(command: string, folder: string, files: string[], blocked: Record<string, string> = {}): string | undefined {
  const real = realpath(folder);
  const top = repoTop(real);
  const label = `\`${command.length > 80 ? command.slice(0, 80) + '...' : command}\``;
  const opts = { folder: real, top, scanJs: scriptScan, resolveImport: resolveHelper, namedPaths };
  const allowed = allowCommand(command, label, { ...opts, live: true });
  const reach = reachOfCommand(command, label, opts);
  const reached = [...allowed.files, ...reach.files];
  // A file named by a string may be a picture, but one that's run isn't,
  // whatever it's called (`node scripts/report.svg`; Muse's review, 7 Nov).
  const missed = allowed.ran.find((f) => !files.includes(f)) ?? reached.find((f) => !files.includes(f) && !PICTURES.includes(path.extname(f).toLowerCase()));
  if (missed) return `runs ${path.relative(real, missed)}, which patch trust didn't hash: write the command in the patch as plain text, so trusting the patch covers what it runs.`;
  const stuck = reached.find((f) => Object.hasOwn(blocked, f) && blocked[f]);
  if (stuck) return `runs ${path.relative(real, stuck)}, and patch trust can't follow everything that runs: ${blocked[stuck]}`;
  return allowed.problem ?? reach.problem;
}

// What script-trust needs to follow a command run from `folder` (a Claude
// Code hook, claude-trust.ts) the way it follows a patch's: the same
// module scan and import resolution, bounded by the repo's top.
export function followOptions(folder: string, reads?: Reads): FollowOptions {
  const real = realpath(folder);
  return { folder: real, top: repoTop(real), scanJs: scriptScan, resolveImport: (dir, spec) => resolveHelper(dir, spec, reads), namedPaths, ...(reads ? { reads } : {}) };
}

// The top of the git checkout (or worktree) `dir` is in, else `dir`.
function repoTop(dir: string): string {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

const PICTURES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.icns', '.pdf', '.heic'];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Where Node (or a bundler-ish habit) would find `spec`: as written, then
// with a script extension, then as a folder's index. As written when none
// is there, so it's hashed as missing.
function resolveHelper(dir: string, spec: string, reads?: Reads): string {
  const base = path.resolve(dir, spec.replace(/[?#].*$/, ''));
  const tries = [base, ...[...SCANNED, '.json'].map((e) => base + e), ...SCANNED.map((e) => path.join(base, 'index' + e))];
  for (const t of tries) {
    // Each try is noted, so one turning up (or a link retargeted) shows.
    if (isFile(t)) return reads ? (reads.real(t) ?? t) : realpath(t);
    reads?.real(t);
  }
  return base;
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// The hash of a file's bytes now, or undefined when it can't be read.
export function fileSha(file: string): string | undefined {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

// A file in some `.threadbear/patches/` folder with a patch's extension.
export function isPatchFile(file: string): boolean {
  const dir = path.dirname(path.resolve(file));
  return path.basename(dir) === 'patches' && path.basename(path.dirname(dir)) === '.threadbear' && ['.ts', '.js', '.mjs'].includes(path.extname(file));
}

function isInside(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The folder a patch file's trust is kept under: the one holding its
// `.threadbear/`, or, in a git worktree, the same place in the main checkout.
export function folderKey(file: string): string {
  return folderKeyOfDir(path.dirname(path.dirname(path.dirname(path.resolve(file)))));
}

// The same for a folder itself: where its Claude Code settings' trust is
// kept (claude-trust.ts).
export function folderKeyOfDir(dir: string): string {
  // Real paths: git writes them into a worktree's .git file, and /tmp or
  // a symlinked ~/dev would otherwise be two folders.
  const folder = realpath(path.resolve(dir));
  const top = worktreeTop(folder);
  if (!top) return folder;
  const main = mainCheckoutOf(top);
  return main ? path.join(realpath(main), path.relative(top, folder)) : folder;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// The nearest folder from `dir` up with a `.git`, when that `.git` is a
// file (a worktree's) rather than a folder. The entry itself, not what it
// points at: a `.git` that's a symlink (to a real worktree's .git file,
// say) is no worktree, as git never makes one, and following it let any
// folder from a zip pass as a worktree of Threadbear's own, always
// trusted checkout (Gautam's scan, 6 Nov).
function worktreeTop(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(path.join(d, '.git'));
    } catch {
      // none here
    }
    if (st) return st.isFile() ? d : undefined;
    if (path.dirname(d) === d) return undefined;
  }
}

// The worktree `dir` is in (its top folder) and that worktree's main
// checkout, both as real paths; undefined outside a worktree git made.
export function worktreeOf(dir: string): { top: string; main: string } | undefined {
  const top = worktreeTop(realpath(path.resolve(dir)));
  const main = top ? mainCheckoutOf(top) : undefined;
  return top && main ? { top, main: realpath(main) } : undefined;
}

// The main checkout a worktree belongs to, if git really made it: its .git
// file names `<repo>/.git/worktrees/<name>`, and that folder's `gitdir`
// names this worktree's .git back. `top`'s own .git entry must be a plain
// file (never a symlink, which would read some other worktree's), and the
// path named back must be that entry: `<top>/.git`, with only the folder
// part's symlinks resolved. Comparing the two entries' real paths took a
// symlinked .git as the worktree it points at (Gautam's scan, 6 Nov).
export function mainCheckoutOf(top: string): string | undefined {
  try {
    const realTop = fs.realpathSync(top);
    const dotGit = path.join(realTop, '.git');
    if (!fs.lstatSync(dotGit).isFile()) return undefined;
    const named = gitdirLine(readHead(dotGit));
    if (!named) return undefined;
    const gitdir = path.resolve(realTop, named);
    const back = path.resolve(gitdir, readHead(path.join(gitdir, 'gitdir')).trim());
    if (path.basename(back) !== '.git' || fs.realpathSync(path.dirname(back)) !== realTop) return undefined;
    const common = path.resolve(gitdir, readHead(path.join(gitdir, 'commondir')).trim());
    const name = path.relative(path.join(common, 'worktrees'), gitdir);
    if (path.basename(common) !== '.git' || !name || name.startsWith('..') || name.includes(path.sep)) return undefined;
    return path.dirname(common);
  } catch {
    return undefined;
  }
}

// The start of a small file git writes (a .git file, a worktree's gitdir
// or commondir): a path, so a few KB is plenty, and a huge one planted
// there isn't read whole. Only a plain file: the paths come from the
// folder's .git file, and opening a fifo there would wait for ever, so
// it's opened without waiting and refused.
function readHead(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} isn't a file`);
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// The path a .git file's `gitdir:` line names, read without a regex (a
// lazy match before `\s*$` was quadratic in a line of spaces).
function gitdirLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('gitdir:')) continue;
    const p = line.slice('gitdir:'.length).trim();
    return p || undefined;
  }
  return undefined;
}
