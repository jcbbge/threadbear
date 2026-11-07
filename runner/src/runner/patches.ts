// Patches: reading a folder's patch set, trusting it, running its hooks, actions and live commands, and rendering its panels (patches.ts has the files).
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { convexFolderFor, type ConvexKey, type ConvexDeployments, type ConvexLogin } from '../convex-keys.ts';
import type { EventBody } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import { Projects } from '../projects.ts';
import { threadEnv } from '../restart.ts';
import { paths } from '../config.ts';
import { isDirectory } from '../fsutil.ts';
import { commandFiles, isPatchFile, namedPaths, patchHash, scanModule, type ClaudeVerdict, type PatchHash } from '../patch-trust.ts';
import type { AgentWrite } from '../adapters/types.ts';
import { CLAUDE_PATCH_ID, claudeCommands, claudeOptions, settingsCommands, settingsNamedPaths, type ClaudeOptions } from '../claude-trust.ts';
import { canonicalPath, runsAsCodeByName, type CodeWrite } from '../code-writes.ts';
import type { PatchInfo } from '../protocol.ts';
import { actionRunProblem, automaticTrust, EMPTY_PATCH_SET, PATCH_EXTENSIONS, patchDirs, projectRoots, hookApplies, loadPatchSet, applyLive, hasLive, projectPanels, renderListPanel, renderPanel, runCommand, type CommandOutcome, type PanelRender, type PatchSet, type ProjectFolder, projectPatchFiles } from '../patches.ts';
import { liveCommandEnv } from '../shell-allowlist.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThreadState, Turn } from '../runner.ts';
import type { ThreadRecord } from '../store.ts';
import { FOLDER_CACHE_MS, HOOK_TELL_CHARS, HOOK_TELL_LIMIT, LIVE_POLL_MS, LIVE_SHARE_MS, PATCHES_TTL_MS } from '../runner.ts';
import { safeStart } from '../safe-cut.ts';

// What a patch that loads without a hash makes code, its commands run from
// `from` (writeRunsAsCode): every file it reaches, as canonical lower-case
// paths, and `all` when something it can run can't all be followed. Kept until
// anything its hash was made from changes, and for a few seconds at most, as
// what a command reaches from that folder isn't in that hash.
type CodeScan = { at: number; h: PatchHash; all: boolean; files: Set<string> };
const scans = new Map<string, CodeScan>();
// The files in a Claude login's folder that hold its user settings.
const LOGIN_SETTINGS = /^(settings(\..*)?\.json|\.claude\.json)$/i;
const SCAN_TTL_MS = 10_000;
// A web address held in a constant (`const PAGE = \`https://x/\${id}\``), so not
// in the default export where `url` would say so. Run as a command it's one
// file by that very name, which `files` has: only characters a shell neither
// splits at nor expands, so no `?`, `[`, `;` or `$`, and no `..` to leave the
// folder by (Codex's review).
const PLAIN_WEB_ADDRESS = /^https?:\/\/(?!.*\.\.)[\w.~/%:-]*$/i;
function codeOfUnhashedPatch(file: string, from: string, now: number): CodeScan {
  const key = `${file}\0${from}`;
  const hit = scans.get(key);
  if (hit && now - hit.at < SCAN_TTL_MS && hit.h.looked.same()) return hit;
  const h = patchHash(file);
  const files = new Set<string>();
  const add = (f: string) => files.add(canonicalPath(f).toLowerCase());
  // Code it can't follow: any edit might be what it runs.
  let all = Boolean(h.incomplete);
  for (const f of [file, h.root, ...h.deps.map((d) => d.path), ...h.unnamed]) add(f);
  const worktreeReach = new Set<string>();
  // The folder holding its `.threadbear/patches`, as a worktree's commands run from there.
  const patchFolder = path.dirname(path.dirname(path.dirname(file)));
  for (const [module, bytes] of h.code) {
    const text = bytes.toString('utf8');
    for (const n of namedPaths(text)) add(path.resolve(from, n));
    // Each string in it as a command run from where its commands run: what
    // that reaches, whatever it is. A problem means there may be more it
    // runs, unless the patch file's own default export has it as something
    // else (scanModule). A `worktree` setup and check don't count either. Setup
    // runs what's committed, in a new worktree, and worktree-setup.sh won't
    // install from an uncommitted package.json in the main checkout; the check
    // runs when a land is asked for. So neither runs what an agent just wrote
    // until it has got past a step that's asked about.
    const scan = scanModule(text, module);
    // Imported by anything it imports, its default export has a name after all.
    const rootPath = canonicalPath(h.root);
    const own = canonicalPath(module) === rootPath && ![...h.edges.values()].some((to) => [...to.values()].some((f) => canonicalPath(f) === rootPath));
    const data = new Set(own ? scan.data : []);
    const worktree = new Set(own ? scan.worktree : []);
    for (const command of scan.strings) {
      if (!/\S/.test(command) || command.length > 2000) continue;
      const reach = commandFiles(command, from);
      reach.files.forEach(add);
      if (worktree.has(command)) {
        for (const f of commandFiles(command, patchFolder).files) worktreeReach.add(canonicalPath(f).toLowerCase());
      } else if (PLAIN_WEB_ADDRESS.test(command)) add(path.resolve(from, command));
      else if (reach.problem && !data.has(command)) all = true;
    }
    // Absolute and `~/` paths, there yet or not.
    for (const word of text.split(/[\s'"`;&|()<>=,[\]{}]+/)) {
      if (word.startsWith('/') && word.length > 1) add(word);
      else if (word.startsWith('~/')) add(path.join(os.homedir(), word.slice(2)));
    }
  }
  // A script it names that runs something it can't follow, other than a
  // worktree's own (above). A hook or action that runs one is a problem as a
  // command too; this also catches what's named some other way.
  if (Object.keys(h.blocked ?? {}).some((s) => !worktreeReach.has(canonicalPath(s).toLowerCase()))) all = true;
  const scan = { at: now, h, all, files };
  scans.set(key, scan);
  if (scans.size > 200) scans.delete(scans.keys().next().value!);
  return scan;
}

export const patchesPart = {
  // What the thread's folder gives it (see Runtime.patches): the last set
  // read, with a fresh read started when it's stale.
  patchSet(this: Runner, st: ThreadState): PatchSet {
    const { rec, rt } = st;
    const now = this.clock.now();
    const folders = this.projects?.foldersFor(rec) ?? [];
    // A mode change can change what the folder's Claude settings wait on.
    const key = JSON.stringify([rec.cwd, folders, rec.provider === 'claude' && claudeOptions(rec).grants]);
    if (rt.patches && rt.patches.cwd === rec.cwd && rt.patches.key !== key) {
      // Same folder, different projects: keep showing what there is while
      // the new set loads, rather than flashing the panels away.
      rt.patches.key = key;
      rt.patches.at = -Infinity;
    }
    if (!rt.patches || rt.patches.cwd !== rec.cwd) {
      // A thread moved to another folder looks at it afresh, rather than
      // through what was read a few seconds ago (rare, unlike startup).
      if (rt.patches) this.forgetFolders();
      // The built-in panels straight away; the files follow.
      let panels: PatchSet['panels'] = [];
      try {
        panels = projectPanels(rec.cwd, this.panelsRoot, folders, this.folderCache);
      } catch (e) {
        this.log.warn('could not read the folder for panels', { threadId: rec.id, cwd: rec.cwd, error: String(e) });
      }
      const set = { ...EMPTY_PATCH_SET, panels };
      rt.patches = { cwd: rec.cwd, key, at: now, base: set, set, refreshing: false, loaded: false };
      void this.refreshPatches(st);
    } else if (!rt.patches.refreshing && now - rt.patches.at > PATCHES_TTL_MS) {
      void this.refreshPatches(st);
    }
    return rt.patches.set;
  },

  // Reads the folder's patches again; a change sends a new summary, and a
  // patch file that has appeared or broken since the last read is said in
  // the transcript (not on the first read, which would say it at startup).
  refreshPatches(this: Runner, st: ThreadState): Promise<void> {
    const read = this.readPatches(st);
    this.patchReads.add(read);
    void read.finally(() => this.patchReads.delete(read));
    return read;
  },

  // Resolves once no thread's patches are being read. For tests: the
  // reads go to the disk asynchronously, so a tick or two isn't enough.
  async patchesIdle(this: Runner): Promise<void> {
    while (this.patchReads.size) await Promise.allSettled([...this.patchReads]);
  },

  async readPatches(this: Runner, st: ThreadState): Promise<void> {
    const { rec, rt } = st;
    const entry = rt.patches;
    if (!entry || entry.refreshing) return;
    entry.refreshing = true;
    const cwd = rec.cwd;
    const key = entry.key;
    let base: PatchSet;
    let set: PatchSet;
    try {
      base = await this.loadSharedPatchSet(cwd, this.projects?.foldersFor(rec) ?? [], this.projects?.allFolders() ?? []);
      // Claude threads only: a Codex thread doesn't read them.
      const claude = rec.provider === 'claude' ? this.claudePatchInfo(cwd, claudeOptions(rec)) : undefined;
      if (claude) base = { ...base, patches: [...base.patches, claude] };
      set = await applyLive(base, { cwd, threadId: rec.id, run: (command, dir) => this.runLiveCommand(rec.id, command, dir), verify: (file, hash) => this.patchTrust.verify(file, hash) });
    } catch (e) {
      this.log.warn('could not read the folder for patches', { threadId: rec.id, cwd, error: String(e) });
      base = entry.base;
      set = entry.set;
    }
    entry.refreshing = false;
    entry.at = this.clock.now();
    // The folder moved on meanwhile: the next summary starts over.
    if (rt.patches !== entry || rec.cwd !== cwd || rt.deleted) return;
    // The projects changed meanwhile: read again.
    if (entry.key !== key) {
      entry.at = -Infinity;
      this.markDirty(st);
      return;
    }
    // What the files give is said in the transcript; live state (a chip
    // coming and going) only moves the summary.
    if (entry.loaded && JSON.stringify(entry.base) !== JSON.stringify(base)) this.notePatchChanges(st, entry.base, base);
    const changed = JSON.stringify(entry.set) !== JSON.stringify(set);
    entry.base = base;
    entry.set = set;
    entry.live = hasLive(base);
    entry.loaded = true;
    if (changed) this.markDirty(st);
    if (entry.live) this.armLivePoll();
  },

  // Threads in the same folder with the same projects get the same set, so
  // it's read once per FOLDER_CACHE_MS for all of them: a couple of hundred
  // threads share a few dozen folders, and each reading its own set again
  // every 15 seconds kept the runner busy for seconds on a loaded Mac.
  // Sets aren't changed once made (applyLive makes new ones), so sharing
  // one is safe, as sharing a patch file's module already was.
  loadSharedPatchSet(this: Runner, cwd: string, folders: ProjectFolder[], allFolders: string[]): Promise<PatchSet> {
    const key = JSON.stringify([cwd, folders, allFolders]);
    const now = this.clock.now();
    const hit = this.sharedPatchSets.get(key);
    if (hit && now - hit.at < FOLDER_CACHE_MS) return hit.set;
    const set = loadPatchSet(cwd, this.panelsRoot, this.patchCache, folders, allFolders, this.folderCache, this.patchTrust);
    const entry = { at: now, set };
    this.sharedPatchSets.set(key, entry);
    set.catch(() => {
      if (this.sharedPatchSets.get(key) === entry) this.sharedPatchSets.delete(key);
    });
    return set;
  },

  // Forgets what was read from the folders, after something that may have
  // changed them: the next patch reads go to the disk.
  forgetFolders(this: Runner): void {
    this.folderCache.clear();
    this.claudeChecks.clear();
    this.sharedPatchSets.clear();
    // A turn may have changed what they read (comments resolved, a handback).
    this.liveRuns.clear();
  },

  // A live state command (when, badge), shared by every thread that runs
  // the same one in the same folder: Tandem's patch runs tandem status and
  // tandem comments for each thread in a video folder every LIVE_POLL_MS.
  // On a loaded Mac each took longer than that, so they piled up, nine at a
  // time, and every spawn blocked the event loop for a second or so. Now
  // one run serves them all for LIVE_SHARE_MS, and a poll that comes round
  // while it's still going joins it. Live state is about the folder (what
  // a tool says about the files there), not about one thread.
  runLiveCommand(this: Runner, threadId: string, command: string, cwd: string): Promise<CommandOutcome> {
    const key = `${cwd}\u0000${command}`;
    const hit = this.liveRuns.get(key);
    if (hit && (hit.doneAt === undefined || this.clock.now() - hit.doneAt < LIVE_SHARE_MS)) return hit.out;
    const entry: { doneAt?: number; out: Promise<CommandOutcome> } = { out: this.runPatchCommand(threadId, command, cwd) };
    this.liveRuns.set(key, entry);
    void entry.out.then(
      () => (entry.doneAt = this.clock.now()),
      () => {
        if (this.liveRuns.get(key) === entry) this.liveRuns.delete(key);
      },
    );
    return entry.out;
  },

  // A command a patch's function runs (list panels, live state): in its
  // folder, with the thread's variables, like an action.
  // Each with liveCommandEnv's git settings, which turn off what a repo's
  // own .git/config could make git run (shell-allowlist.ts).
  runPatchCommand(this: Runner, threadId: string, command: string, cwd: string) {
    const env = { ...process.env, ...threadEnv(threadId, this.cfg.home) };
    return runCommand(command, { cwd, env: { ...env, ...liveCommandEnv(env) }, shell: this.actionShell, timeoutMs: this.actionTimeoutMs, killGroup: true });
  },

  // Reads live state again for the inbox's threads that have any, every
  // LIVE_POLL_MS while there are some. Hibernating and Den threads wait
  // until they're back (patchSet reads again on the next summary).
  armLivePoll(this: Runner): void {
    if (this.liveTimer || this.stopping) return;
    this.liveTimer = this.clock.setTimeout(() => {
      this.liveTimer = undefined;
      if (this.stopping) return;
      let any = false;
      for (const st of this.threads.values()) {
        if (!st.rt.patches?.live || st.rt.deleted || this.bucket(st.rec) !== 'inbox') continue;
        any = true;
        void this.refreshPatches(st);
      }
      if (any) this.armLivePoll();
    }, LIVE_POLL_MS);
  },

  notePatchChanges(this: Runner, st: ThreadState, before: PatchSet, after: PatchSet): void {
    const was = new Map(before.patches.map((p) => [p.id + '@' + p.source, p]));
    for (const p of after.patches) {
      // Claude's settings are said when a session starts without them
      // (noteClaudeSkipped), which is when it matters.
      if (p.source === 'builtin' || p.source === 'claude') continue;
      const old = was.get(p.id + '@' + p.source);
      if (p.error) {
        if (old?.error !== p.error) this.emit(st, { type: 'system.note', text: `Patch ${p.id} couldn't load: ${p.error}` });
        continue;
      }
      if (p.untrusted) {
        if (old?.untrusted !== p.untrusted || old?.hash !== p.hash) {
          const why = p.untrusted === 'changed' ? 'it changed since you trusted it' : 'nothing from its folder is trusted yet';
          this.emit(st, { type: 'system.note', text: `Patch ${p.id} isn't loaded: ${why}. Trust it in Patches to load it.` });
        }
        continue;
      }
      if (old && !old.error && !old.untrusted) continue;
      const gives: string[] = [];
      const actions = after.actions.filter((a) => a.patch === p.id).map((a) => a.title);
      const panels = after.panels.filter((x) => x.patch === p.id).map((x) => x.title);
      const hooks = after.hooks.filter((x) => x.patch === p.id).map((x) => x.title);
      if (actions.length) gives.push(`${actions.length === 1 ? 'action' : 'actions'} ${actions.join(', ')}`);
      if (panels.length) gives.push(`${panels.length === 1 ? 'panel' : 'panels'} ${panels.join(', ')}`);
      if (hooks.length) gives.push(`${hooks.length === 1 ? 'hook' : 'hooks'} ${hooks.join(', ')}`);
      this.emit(st, { type: 'system.note', text: `Patch ${p.id} ${old ? 'loads again' : 'added'}: ${gives.join(', ') || 'nothing yet'}.` });
    }
  },

  // patches.trust: trusts the versions of a thread's untrusted patch files
  // that the app showed (by hash), then reads every thread's patches again.
  // Only files the thread lists as untrusted: this isn't a way to trust
  // any path.
  async trustPatches(this: Runner, threadId: string, files: { file: string; hash: string }[]): Promise<{ trusted: string[] }> {
    const st = this.mustGet(threadId);
    const waiting = this.patchSet(st).patches.filter((p) => p.untrusted && p.file);
    for (const { file, hash } of files) {
      const p = waiting.find((w) => w.file === file);
      if (!p) throw new RpcError(ErrorCode.badParams, `${file} isn't one of this thread's patches waiting to be trusted`);
      if (p.hash !== hash) throw new RpcError(ErrorCode.badParams, `${path.basename(file)} has changed since it was shown; look again`);
    }
    const trusted = files
      .filter(({ file, hash }) => (waiting.find((w) => w.file === file)?.source === 'claude' ? this.patchTrust.trustClaude(st.rec.cwd, hash) : this.patchTrust.trust(file, hash)))
      .map((f) => f.file);
    this.log.info('patches trusted', { threadId, files: trusted });
    this.rereadAllPatches();
    await this.patchesIdle();
    return { trusted };
  },

  // Trusts patch files a Full access thread's verified edit wrote (an
  // adapter's 'wrote' on 'full', never a preview: the caller checks), as
  // that edit left them: each only while it still hashes to `sha256`,
  // checked in the same read the trust hash is made from, only inside
  // `folder` (the thread's), only an Edit of trusted bytes or a whole
  // Write, and only when every other file in the patch is bytes trusted
  // before or another verified edit's (patch-trust.ts). A helper the agent
  // edited carries on the patches importing it the same way. With
  // `claude`, the folder's Claude Code settings and the scripts they name
  // count too (claude-trust.ts).
  trustAgentPatches(this: Runner, files: AgentWrite[], folder: string, claude = false): void {
    const done: string[] = [];
    for (const { path: file, sha256, base } of files) {
      done.push(...this.patchTrust.trustAgentWrite(file, sha256, base, folder));
      if (claude && !isPatchFile(file) && this.patchTrust.trustClaudeEdit(folder, file, sha256, base)) done.push(file);
    }
    if (done.length) this.rereadAllPatches();
  },

  // Whether an edit of `file` (absolute) by the thread `rec` changes code
  // the runner or Claude runs by itself, beyond what code-writes.ts knows
  // by name. Outside Full access such an edit always asks. Fails closed:
  // anything it can't read or follow asks.
  //
  // - What a patch the runner has hashed covers (covers()).
  // - The runner's own data dir: patch-trust.json is the trust itself,
  //   runner.json names the CLIs it runs.
  // - Every Claude login's user settings (by their own name and what a link
  //   to them points at) and the paths their commands name, there yet or
  //   not, from the login's folder, the thread's or absolute: they run in
  //   every session on that login. The same for the thread folder's
  //   settings.
  // - Patches that load without a hash (home's, Threadbear's own
  //   checkout's): what one is a link to, imports and names, a missing
  //   one included, absolute or `~/` paths in it, and its `./` paths from
  //   where its commands run: the thread's folder, or for a patch from a
  //   project's folder, that folder. One that can run something it can't
  //   follow asks for every edit (Codex review), and answers 'unsure', so
  //   the card doesn't say this file runs. What such a hook runs by name
  //   (`npm test`, a tool on PATH) is the folder's own code, run as its
  //   owner set it up, and isn't followed.
  writeRunsAsCode(this: Runner, rec: ThreadRecord, file: string): CodeWrite {
    const cwd = rec.cwd;
    const home = this.panelsRoot ?? os.homedir();
    const real = canonicalPath(file).toLowerCase();
    const same = (f: string) => canonicalPath(f).toLowerCase() === real;
    if (runsAsCodeByName(file, home) || this.patchTrust.covers(canonicalPath(file))) return true;
    try {
      const data = canonicalPath(this.cfg.home).toLowerCase();
      const rel = path.relative(data, real);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
      if (same(path.join(os.homedir(), '.claude.json'))) return true;
      const logins = new Set([path.join(os.homedir(), '.claude'), ...this.accounts.list().filter((a) => a.provider === 'claude' && a.configDir).map((a) => a.configDir!)]);
      // A settings file straight in a login's folder by its name, there yet
      // or not: writing a new one adds hooks as surely as changing one
      // (Daybreak, 7 Nov 2026: a Token Stats login with no settings.json
      // yet, outside the data dir and not named .claude, lost this when
      // the list below became the files that exist).
      if (LOGIN_SETTINGS.test(path.basename(real)) && [...logins].some((dir) => canonicalPath(dir).toLowerCase() === path.dirname(real))) return true;
      const settings: { file: string; dir: string }[] = [];
      for (const dir of logins) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) if (LOGIN_SETTINGS.test(f)) settings.push({ file: path.join(dir, f), dir });
      }
      for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) settings.push({ file: path.join(cwd, rel), dir: cwd });
      for (const s of settings) {
        if (same(s.file)) return true;
        if (settingsNamedPaths(s.file, s.dir, os.homedir(), cwd).some(same)) return true;
        // Each command as a shell runs it, from where hooks run (the
        // thread's folder) and the login's: the script it names, quoted
        // names with spaces too, and what that imports or runs in turn.
        // What it can't follow doesn't make every edit ask, unlike an
        // unhashed patch's: these are the user's own hooks, and on 6 Nov
        // eight of Mike's thirty didn't follow all the way (a decision
        // for him, in the fix's report).
        for (const command of settingsCommands(s.file)) {
          const text = command.replace(/\$\{?CLAUDE_CONFIG_DIR\}?/g, s.dir).replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, cwd);
          for (const from of new Set([cwd, s.dir])) if (commandFiles(text, from).files.some(same)) return true;
        }
      }
      const found = claudeCommands(cwd, home);
      if (found && [...found.files, ...found.named].some(same)) return true;
      // Every patch folder the thread reads, as loadPatchSet does, its
      // projects' too, as their hooks run at the end of its turns: the ones
      // that load without a hash.
      const dirs = new Map<string, { source: 'home' | 'project'; from: string }>();
      for (const d of patchDirs(cwd, home)) dirs.set(d.dir, { source: d.source, from: cwd });
      for (const root of projectRoots(cwd, this.projects?.foldersFor(rec) ?? [])) {
        for (const d of patchDirs(root.folder, home)) if (!dirs.has(d.dir)) dirs.set(d.dir, { source: d.source, from: root.folder });
      }
      // Files one is sure of win over another's "can't tell", for the card.
      let unsure = false;
      for (const [dir, { source, from }] of dirs) {
        if (source === 'project' && !this.patchTrust.loadsUnhashed(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          if (!PATCH_EXTENSIONS.includes(path.extname(name)) || name.endsWith('.d.ts') || name.startsWith('.')) continue;
          const p = path.join(dir, name);
          if (same(p)) return true;
          let scan: CodeScan;
          try {
            scan = codeOfUnhashedPatch(p, from, this.clock.now());
          } catch {
            continue; // can't be read, so can't be loaded either
          }
          if (scan.files.has(real)) return true;
          if (scan.all) unsure = true;
        }
      }
      return unsure ? 'unsure' : false;
    } catch {
      return 'unsure';
    }
  },

  // The thread folder's Claude Code settings, as an entry in its patch
  // list while they run commands that aren't trusted, so Patches shows
  // them with a Trust button as it does a waiting patch file.
  // A thread that asks before tools run also waits on what would let them
  // run unasked (`grants`, listed for the app to show), so the check is
  // kept per folder and kind of thread. One that can't be checked shows
  // why, with nothing to trust.
  claudePatchInfo(this: Runner, cwd: string, opts: ClaudeOptions = {}): PatchInfo | undefined {
    const now = this.clock.now();
    const key = `${opts.grants ? 'grants' : 'full'}\0${cwd}`;
    let hit = this.claudeChecks.get(key);
    if (!hit || now - hit.at >= FOLDER_CACHE_MS) {
      hit = { at: now, verdict: this.patchTrust.checkClaude(cwd, opts) };
      this.claudeChecks.set(key, hit);
    }
    const v = hit.verdict;
    if (v.trusted) return undefined;
    if (v.reason === 'unchecked') return { id: CLAUDE_PATCH_ID, source: 'claude', ...(v.files.length ? { file: v.files[0] } : {}), error: `Skipped, and can't be trusted as they are: ${v.problem}` };
    const helpers = [...v.files.slice(1), ...v.named];
    return { id: CLAUDE_PATCH_ID, source: 'claude', file: v.files[0], untrusted: v.reason, hash: v.hash, ...(helpers.length ? { helpers } : {}), ...(v.grants?.length ? { grants: v.grants } : {}) };
  },

  // Says in the thread, once per version, that the CLI started without the
  // folder's Claude Code settings and how to have them.
  noteClaudeSkipped(this: Runner, st: ThreadState, v: Extract<ClaudeVerdict, { trusted: false }>): void {
    const { rt } = st;
    if (rt.claudeNoted === v.hash) return;
    rt.claudeNoted = v.hash;
    const what = v.files.map((f) => path.relative(st.rec.cwd, f)).join(' and ') || 'its .claude folders';
    if (v.reason === 'unchecked') {
      this.emit(st, { type: 'system.note', text: `Skipped this folder's Claude Code hooks, commands, permissions and environment settings (${what}): ${v.problem} Its other settings and CLAUDE.md still apply.` }, rt.turn?.turnId);
      return;
    }
    const why = v.reason === 'changed' ? 'they changed since you trusted them' : "you haven't trusted them yet";
    this.emit(st, { type: 'system.note', text: `Skipped this folder's Claude Code hooks, commands, permissions and environment settings (${what}): ${why}. Its other settings and CLAUDE.md still apply. Trust them in Patches to run them from your next message.` }, rt.turn?.turnId);
  },

  // Every thread whose patches have been read reads them again now: a
  // trusted file can matter to threads in other folders (a project's).
  rereadAllPatches(this: Runner): void {
    this.forgetFolders();
    for (const st of this.threads.values()) {
      if (!st.rt.patches || st.rt.deleted) continue;
      st.rt.patches.at = -Infinity;
      void this.refreshPatches(st);
    }
  },

  // A first start with patch trust (no patch-trust.json yet): the patch
  // files of every thread's folder and every project's are trusted as they
  // are, since this runner was already running them. Anything new after
  // this asks.
  seedPatchTrust(this: Runner, threadFolders: string[]): void {
    if (this.patchTrust.existed) return;
    const home = this.panelsRoot ?? os.homedir();
    const folders = new Set<string>(threadFolders);
    for (const f of Projects.savedFolders(this.cfg.home)) folders.add(f);
    const files = new Set<string>();
    for (const folder of folders) {
      try {
        for (const f of projectPatchFiles(folder, home)) files.add(f);
      } catch {
        // a folder that's gone
      }
    }
    const done = this.patchTrust.trustCurrent([...files]);
    this.patchTrust.save();
    this.log.info('patch trust seeded', { files: done.length });
  },

  // Draws an image panel (the Simulator's screenshot) for `panels.render`.
  async renderPanel(this: Runner, threadId: string, panelId: string): Promise<PanelRender> {
    const st = this.mustGet(threadId);
    const panel = this.patchSet(st).panels.find((p) => p.id === panelId);
    if (!panel) throw new RpcError(ErrorCode.badParams, `This thread has no panel called ${panelId}`);
    if (panel.kind === 'list') {
      return renderListPanel(panel, this.patchSet(st), {
        cwd: st.rec.cwd,
        threadId,
        run: (command, cwd) => this.runPatchCommand(threadId, command, cwd),
        verify: (file, hash) => this.patchTrust.verify(file, hash),
      });
    }
    return renderPanel(panel, paths.panels(this.cfg.home, threadId), this.screenshot);
  },

  // Cloud deployments in the Convex panel's project, through its CLI.
  async convexPanelDeployments(this: Runner, threadId: string, panelId: string, refresh = false): Promise<ConvexDeployments> {
    const { convex, folder } = this.convexPanelContext(threadId, panelId);
    return this.convexKeys.deployments(folder, convex, refresh);
  },

  // A deploy key for the embedded dashboard. Other choices must resolve in
  // this panel's project before they can get a key.
  async convexPanelKey(this: Runner, threadId: string, panelId: string, renew = false, selected?: string): Promise<ConvexKey> {
    const { convex, folder } = this.convexPanelContext(threadId, panelId);
    let target = convex;
    if (selected && selected !== convex.deployment) {
      const choices = await this.convexKeys.deployments(folder, convex);
      const choice = choices.deployments.find(d => d.deployment === selected);
      if (!choice) throw new RpcError(ErrorCode.badParams, `This project's panel has no deployment called ${selected}`);
      target = choice;
    }
    const { deployment, deploymentUrl } = target;
    const team = deployment === convex.deployment ? convex.team : undefined;
    return { deployment, deploymentUrl, adminKey: await this.convexKeys.key(deployment, folder, renew, { deploymentUrl, team }) };
  },

  // Signs this runner's Convex CLI in, for a panel that said it's signed
  // out (or can't reach its deployment, with `force`). `check` only says
  // how the sign-in going is getting on.
  async convexPanelLogin(this: Runner, threadId: string, panelId: string, check = false, force = false): Promise<ConvexLogin> {
    this.convexPanelContext(threadId, panelId);
    return this.convexKeys.login(check, force);
  },

  convexPanelContext(this: Runner, threadId: string, panelId: string) {
    const st = this.mustGet(threadId);
    const panel = this.patchSet(st).panels.find((p) => p.id === panelId);
    if (!panel) throw new RpcError(ErrorCode.badParams, `This thread has no panel called ${panelId}`);
    if (!panel.convex) throw new RpcError(ErrorCode.badParams, `${panelId} isn't a Convex cloud deployment's panel`);
    const { deployment } = panel.convex;
    const starts = [st.rec.cwd, ...(this.projects?.foldersFor(st.rec) ?? []).map((f) => f.folder)];
    const folder = convexFolderFor(deployment, starts, this.panelsRoot ?? os.homedir());
    if (!folder) throw new RpcError(ErrorCode.badParams, `Couldn't find the Convex project for ${deployment}`);
    return { convex: panel.convex, folder };
  },

  // Runs the folder's turn.end hooks for a turn that just completed: each
  // command's output goes into the transcript as an action.run, and when
  // the hook's `tell` says so (failures by default), to the agent as a
  // message from the runner, which starts a turn. A hook whose turn fails
  // the same way again is told HOOK_TELL_LIMIT times, then only posted.
  async runHooks(this: Runner, st: ThreadState, turn: Turn): Promise<void> {
    const hooks = this.patchSet(st).hooks.filter((h) => h.on === 'turn.end' && hookApplies(h, turn.edited, st.rec.cwd));
    if (!hooks.length) return;
    st.rt.hooksRunning = (st.rt.hooksRunning ?? 0) + 1;
    try {
      await this.runHookList(st, hooks);
    } finally {
      st.rt.hooksRunning--;
      // Before the handover check, which then waits for what this starts.
      // Not while stopping: the next runner picks it up (cleanupOwed), and
      // two cleanups shouldn't run side by side.
      if (!this.stopping) this.archiveWhenGone(st);
      if (this.draining) this.queueHandoverCheck();
      // A restart waiting for this hook hears through thread.updated.
      this.markDirty(st);
    }
  },

  // The threads a turn-end hook is running for, which a restart waits for.
  threadsWithHooksRunning(this: Runner): string[] {
    return [...this.threads.values()].filter((st) => st.rt.hooksRunning && !st.rt.deleted).map((st) => st.rec.id);
  },

  async runHookList(this: Runner, st: ThreadState, hooks: PatchSet['hooks']): Promise<void> {
    for (const hook of hooks) {
      if (st.rt.deleted || this.stopping) return;
      // A hook bound to a hashed script runs from the folder, so the patch
      // must still hash to the version that approved it, read afresh now:
      // a script changed since the last look isn't run.
      if (hook.exec) {
        const by = automaticTrust(hook.exec);
        if (!by || !this.patchTrust.verify(by.file, by.hash)) {
          this.emit(st, { type: 'system.note', text: `Didn't run the hook "${hook.title}": its patch or a script it runs changed since it was trusted.` });
          this.rereadAllPatches();
          continue;
        }
      }
      const cwd = hook.folder ?? st.rec.cwd;
      const outcome = await runCommand(hook.exec ?? hook.command, {
        cwd,
        env: { ...process.env, ...threadEnv(st.rec.id, this.cfg.home) },
        shell: this.actionShell,
        timeoutMs: this.actionTimeoutMs,
        background: this.backgroundJobs,
        // An archive's cleanup and a handover wait for this, so it has to
        // end: SIGKILL for one that ignores SIGTERM, and nothing it left
        // running can hold the pipes open.
        killGroup: true,
      });
      if (st.rt.deleted || this.stopping) return;
      // An archive waits for its hooks, but a folder can go other ways (by
      // hand, say). What ran then failed on missing files, not on the code,
      // so it isn't a result to act on.
      if (!isDirectory(cwd)) {
        this.emit(st, { type: 'system.note', text: `The hook "${hook.title}" had its folder ${cwd} removed while it ran, so its result says nothing about the code.` }, st.rt.turn?.turnId);
        this.markDirty(st);
        continue;
      }
      const body: EventBody = {
        type: 'action.run',
        actionId: hook.id,
        patch: hook.patch,
        title: hook.title,
        command: hook.command,
        ok: outcome.ok,
        text: outcome.text,
        truncated: outcome.truncated,
        durationMs: outcome.durationMs,
        trigger: 'turn.end',
      };
      if (outcome.exitCode !== undefined) body.exitCode = outcome.exitCode;
      this.emit(st, body, st.rt.turn?.turnId);
      this.markDirty(st);
      const tell = hook.tell === 'always' || (hook.tell === 'failures' && !outcome.ok);
      if (!tell) continue;
      // Telling starts a turn, which brings an archived thread back: worth
      // it for a failure, not for "passed, nothing to do".
      if (outcome.ok && st.rec.archivedAt) continue;
      const counts = (st.rt.hookTurns ??= new Map());
      const sofar = counts.get(hook.id) ?? 0;
      if (sofar >= HOOK_TELL_LIMIT) {
        this.log.info('hook result not told again', { threadId: st.rec.id, hook: hook.id, times: sofar });
        continue;
      }
      counts.set(hook.id, sofar + 1);
      // Its last part, begun where no secret is cut in two (safe-cut.ts): it goes to Convex as a message.
      const shown = outcome.text.length > HOOK_TELL_CHARS ? outcome.text.slice(safeStart(outcome.text, outcome.text.length - HOOK_TELL_CHARS)) : outcome.text;
      const verdict = outcome.ok ? 'passed' : `failed${outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode})` : ''}`;
      const text =
        `[Threadbear hook] ${hook.title} (patch ${hook.patch}) ran after your turn and ${verdict}:\n\n` +
        '```\n' + (shown.trim() || '(no output)') + '\n```\n\n' +
        (outcome.ok ? 'Nothing to do unless something above surprises you.' : 'If this is from your change, fix it; if not, say so and carry on.');
      try {
        this.sendTo(st, text, [], { origin: 'runner' });
      } catch (e) {
        this.log.warn('could not tell the agent a hook result', { threadId: st.rec.id, hook: hook.id, error: String(e) });
      }
    }
  },

  // Runs an action for `actions.run`: a prompt action is a message to the
  // thread; a command action runs in its folder, and what it printed goes
  // into the transcript as an action.run event. One run of an action at a
  // time per thread.
  async runAction(this: Runner, threadId: string, actionId: string): Promise<{ turnId?: string; ok?: boolean; exitCode?: number; durationMs?: number; seq?: number }> {
    const st = this.mustGet(threadId);
    const set = this.patchSet(st);
    const action = this.actionsOf(st, set).find((a) => a.id === actionId);
    if (!action) throw new RpcError(ErrorCode.badParams, `This thread has no action called ${actionId}`);
    if (action.kind === 'prompt') return this.send(threadId, action.prompt ?? '');
    if (action.kind === 'url') {
      // Apps that know url actions open the page themselves, on the device
      // it was pressed on, and never call this. An older Mac app reads the
      // unknown kind as a command and asks here, so open it on this Mac,
      // with nothing in the transcript, which is where that app is.
      const started = Date.now();
      await this.openUrl(action.url ?? '');
      return { ok: true, durationMs: Date.now() - started };
    }
    const running = (st.rt.runningActions ??= new Set());
    if (running.has(actionId)) throw new RpcError(ErrorCode.busy, `${action.title} is already running.`);
    // It runs from the folder, so what the patch's hash covered must still
    // be what's there as it starts, read afresh, however long ago the patch
    // was last looked at; what changed then asks in Patches.
    const refused = actionRunProblem(action, set.patches.find((p) => p.id === action.patch), (file, hash) => this.patchTrust.verify(file, hash), (dir) => this.patchTrust.loadsUnhashed(dir));
    if (refused) {
      this.rereadAllPatches();
      throw new RpcError(ErrorCode.other, `Didn't run ${action.title}: ${refused}`);
    }
    running.add(actionId);
    try {
      const outcome = await runCommand(action.command ?? '', {
        cwd: action.folder ?? st.rec.cwd,
        env: { ...process.env, ...threadEnv(threadId, this.cfg.home) },
        shell: this.actionShell,
        // Landing waits for the repo lock as well as the remote check
        // queue. The ordinary ten-minute action limit can kill it before
        // validation has even started.
        timeoutMs: action.id === 'worktree.land' && action.patch === 'worktree' ? 60 * 60_000 : this.actionTimeoutMs,
      });
      if (st.rt.deleted) return { ok: outcome.ok, exitCode: outcome.exitCode, durationMs: outcome.durationMs };
      const body: EventBody = {
        type: 'action.run',
        actionId,
        patch: action.patch,
        title: action.title,
        command: action.command ?? '',
        ok: outcome.ok,
        text: outcome.text,
        truncated: outcome.truncated,
        durationMs: outcome.durationMs,
      };
      if (outcome.exitCode !== undefined) body.exitCode = outcome.exitCode;
      const event = this.emit(st, body, st.rt.turn?.turnId);
      st.rec.lastActivityAt = this.isoNow();
      this.markDirty(st);
      // Land (or any command) may have moved the branch or the files.
      this.recheckLooseEnds(st);
      return { ok: outcome.ok, exitCode: outcome.exitCode, durationMs: outcome.durationMs, seq: event.seq };
    } finally {
      running.delete(actionId);
    }
  },
};

export type PatchesPart = RunnerPart<typeof patchesPart>;
