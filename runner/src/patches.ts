// Patches: what a thread's folder gives the app beyond the transcript
// (docs/threadbear-design/README.md): panels beside it and actions above
// the composer. Two kinds:
//
// - Built in, worked out from the folder alone: a `convex/` folder gives
//   the dashboard, an Xcode project the Simulator.
// - Patch files, `.threadbear/patches/*.ts` (or .js, .mjs) in the project
//   and in `~/.threadbear/patches/` for every project. Each is a module
//   whose default export says what it adds:
//
//     export default {
//       actions: [
//         { title: "Reseed dev DB", run: "npx convex run seed:reset" },
//         { title: "Explain the schema", prompt: "Read convex/schema.ts and explain it." },
//       ],
//       panels: [{ title: "Storybook", url: "http://localhost:6006" }],
//       hooks: [{ title: "Typecheck", on: "turn.end", run: "npx tsc --noEmit", edited: "**/*.ts" }],
//     }
//
//   The runner imports the file (Node runs TypeScript as it is) and reads
//   that object; a file that can't be loaded is listed with its error and
//   gives nothing. A project's file is only imported once it's trusted
//   (patch-trust.ts): until then it's listed as `untrusted` and gives
//   nothing, so opening a thread in someone else's repo runs none of it.
//
// Patches are found by walking up from the thread's folder to the home
// folder, so a thread started in a package of a monorepo still gets the
// project's; a parent folder's patches apply to every project under it.
//
// A thread in projects (projects.ts) also gets the patches of every folder
// of those projects, found the same way from each. Those are tagged with
// the folder and project, and their commands run in that folder rather
// than the thread's: a thread in ~/dev/me/misc that's about Poddle gets
// Poddle's dashboard and chips, and Poddle's Reseed runs in Poddle.
//
// Tool patches: a patch with `appliesTo` (globs of names, like
// "*.tandem") belongs to a tool rather than a place. It applies to a
// thread wherever a folder from the thread's own up holds a matching
// name, and only there, and runs in that folder. They're found in every
// project's folders, not just the thread's projects', so Tandem's patch
// lives in Tandem's repo and a video folder with a .tandem file gets it
// without being in the Tandem project.
//
// Live state: an action or panel can have `when` (hide it unless this
// says true) and `badge` (a count drawn on its chip or rail button),
// functions given the same context as a list panel's `items`. The runner
// calls them when it reads the patches (applyLive) and every little while
// for a thread that has any, so "Your turn" turns up once Mike has left
// comments, without a turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { loginShell } from './system-tools.ts';
import type { Action, Hook, ImageRef, Panel, PanelItem, PatchInfo } from './protocol.ts';
import { LIMITS } from './protocol.ts';
import { imageRefFor } from './media.ts';
import { FolderCache } from './folder-cache.ts';
import { hasLineBreak, stripEnvComment } from './linear-text.ts';
import { actionCommandProblem, automaticCommand, liveCommandProblem, TRUST_ALL, worktreeOf, type PatchGate } from './patch-trust.ts';
import { verifiedUrl } from './verified-imports.ts';
import { inBackground } from './background.ts';
import { CUT_LOOKAHEAD, dropPartialEnd, safeEnd } from './safe-cut.ts';
import { groupAlive, killGroup } from './proc.ts';

export const CONVEX_DASHBOARD = 'https://dashboard.convex.dev';
// `npx convex dev` on an anonymous (no account) deployment serves the
// dashboard itself, from this port unless it's taken.
export const CONVEX_LOCAL_DASHBOARD = 'http://127.0.0.1:6790';
export const PATCH_DIR = path.join('.threadbear', 'patches');
export const PATCH_EXTENSIONS = ['.ts', '.js', '.mjs'];

// Everything the folder's patches give a thread.
export type PatchSet = { panels: Panel[]; actions: Action[]; hooks: Hook[]; patches: PatchInfo[] };
export const EMPTY_PATCH_SET: PatchSet = { panels: [], actions: [], hooks: [], patches: [] };

// Loaded patch files by path, so a summary refresh doesn't import a file
// whose mtime hasn't moved. One per runner.
// `key`: the trust hash a project patch was loaded at (its mtime for one
// trusted whatever it holds), so a new version loads again.
export type PatchCache = Map<string, { key: string; loaded: LoadedPatch }>;
type LoadedPatch = { info: PatchInfo; panels: Panel[]; actions: Action[]; hooks: Hook[]; worktree?: WorktreeConfig; appliesTo?: string[] };

// A patch's `worktree`: the repo gives each new thread a git worktree of
// its own (docs/thread-worktrees.md, worktrees.ts). Not part of PatchSet:
// only the thread's own folder chain counts, which findWorktreePatch reads.
// `keep` lists build caches (folders inside the repo) that make a
// worktree worth reusing: SwiftPM's .build only helps in the folder it was
// built in, so a fresh worktree builds from cold. With `keep`, an archived
// thread's worktree is set aside, those folders and all, for the next
// thread rather than removed (worktrees.ts, "spares").
// `setupRun` is `setup` as it runs, for a patch trusted by its hash
// (bindAutomatic); absent, `setup` runs as written.
export type WorktreeConfig = { setup?: string; check?: string; keep?: string[]; setupRun?: string };

// A folder of one of the thread's projects.
export type ProjectFolder = { folder: string; projectId: string };

// `toolFolders` are the folders of every project, where tool patches are
// looked for (see the top of the file).
export async function loadPatchSet(
  cwd: string,
  home: string = os.homedir(),
  cache: PatchCache = new Map(),
  projectFolders: ProjectFolder[] = [],
  toolFolders: string[] = [],
  dirs: FolderCache = new FolderCache(),
  gate: PatchGate = TRUST_ALL,
): Promise<PatchSet> {
  const set: PatchSet = { panels: [], actions: [], hooks: [], patches: [] };
  const roots = projectRoots(cwd, projectFolders);
  // Everything below reads the disk through dirs, synchronously; this
  // reads it first without blocking, so those reads are all hits.
  await warmPatchReads(dirs, cwd, home, roots, toolFolders);
  // Built in first, so their panels come first: the thread's own, then
  // its projects'.
  for (const b of builtins(cwd, home, roots, dirs)) addPatch(set, b);
  // Then the files: the thread's own chain (home's folder first), then
  // each project folder's chain, then the other projects' tool patches,
  // each patch folder once. A tool patch goes wherever its name is found,
  // whichever folder it came from.
  const seen = new Set<string>();
  const add = (loaded: LoadedPatch, root?: ProjectFolder) => {
    if (!loaded.appliesTo) return addPatch(set, inFolder(loaded, root));
    const placed = placeTool(loaded, cwd, home, roots, dirs);
    if (placed) addPatch(set, placed);
  };
  for (const { dir, source } of patchDirs(cwd, home, dirs)) {
    seen.add(dir);
    for (const file of patchFiles(dir, dirs)) add(await loadPatchFile(file, source, cache, dirs, gate));
  }
  for (const root of roots) {
    for (const { dir, source } of patchDirs(root.folder, home, dirs)) {
      if (seen.has(dir) || source === 'home') continue;
      seen.add(dir);
      for (const file of patchFiles(dir, dirs)) add(await loadPatchFile(file, source, cache, dirs, gate), root);
    }
  }
  for (const folder of toolFolders) {
    const dir = path.join(path.resolve(folder), PATCH_DIR);
    if (seen.has(dir) || !dirs.isDir(dir)) continue;
    seen.add(dir);
    for (const file of patchFiles(dir, dirs)) {
      const loaded = await loadPatchFile(file, 'project', cache, dirs, gate);
      // Only the tools: the rest of another project's patches are for
      // threads in that project. One not trusted yet can't say whether
      // it's a tool, so it's asked about in that project's threads only.
      if (loaded.appliesTo) add(loaded);
    }
  }
  nameClashingPanels(set, cwd);
  return set;
}

// Reads, off the event loop, what loadPatchSet's walk will ask dirs for:
// each folder from the thread's own (and its projects') up to home, the
// tool patches' project folders, their .threadbear/patches, the patch
// files' times and the Convex projects' .env files.
async function warmPatchReads(dirs: FolderCache, cwd: string, home: string, roots: ProjectFolder[], toolFolders: string[]): Promise<void> {
  const chain = new Set<string>([path.resolve(home)]);
  for (const start of [cwd, ...roots.map((r) => r.folder)]) {
    findUp(start, home, (d) => {
      chain.add(d);
      return false;
    });
  }
  const folders = [...chain, ...toolFolders.map((f) => path.resolve(f))];
  await dirs.warmFolders(folders);
  const dotDirs = folders.map((d) => path.join(d, path.dirname(PATCH_DIR))).filter((d) => dirs.isDir(d));
  await dirs.warmFolders(dotDirs);
  const patchFolders = dotDirs.map((d) => path.join(d, path.basename(PATCH_DIR))).filter((d) => dirs.isDir(d));
  await dirs.warmFolders(patchFolders);
  await Promise.all([
    dirs.warmMtimes(patchFolders.flatMap((d) => patchFiles(d, dirs))),
    dirs.warmTexts([...chain].filter((d) => isConvexProject(d, dirs)).flatMap((d) => ENV_FILES.map((f) => path.join(d, f)))),
  ]);
}

// Where a tool patch applies for a thread: the first folder from the
// thread's own up to home holding a name its globs match, else the same
// from each of its projects' folders. Undefined when there's none, and the
// patch isn't the thread's at all.
function placeTool(loaded: LoadedPatch, cwd: string, home: string, roots: ProjectFolder[], dirs: FolderCache): LoadedPatch | undefined {
  const globs = loaded.appliesTo!;
  const matching = (dir: string): string[] => {
    return dirs.names(dir).filter((n) => !n.startsWith('.') && globs.some((g) => path.matchesGlob(n, g))).sort();
  };
  for (const start of [{ folder: cwd } as { folder: string; projectId?: string }, ...roots]) {
    let names: string[] = [];
    const dir = findUp(start.folder, home, (d) => (names = matching(d)).length > 0);
    if (!dir) continue;
    const tag = start.projectId ? { projectId: start.projectId } : {};
    return {
      info: { ...loaded.info, folder: dir, matched: names.map((n) => path.join(dir, n)), ...tag },
      panels: loaded.panels.map((p) => ({ ...p, ...tag })),
      actions: loaded.actions.map((a) => ({ ...a, folder: dir, ...tag })),
      hooks: loaded.hooks.map((h) => ({ ...h, folder: dir, ...tag })),
    };
  }
  return undefined;
}

// The project folders that add anything: not the thread's own folder or
// one it's inside (its own chain already covers those), each once. For a
// thread in a worktree, a project folder in that repo's main checkout is
// read from the worktree's copy: the main checkout is the same repo on
// another branch, and loading both showed every chip twice (30 Oct).
export function projectRoots(cwd: string, projectFolders: ProjectFolder[]): ProjectFolder[] {
  const own = path.resolve(cwd);
  const worktree = projectFolders.length > 0 ? worktreeOf(own) : undefined;
  const out: ProjectFolder[] = [];
  for (const pf of projectFolders) {
    const folder = worktree ? inWorktree(path.resolve(pf.folder), worktree, own) : path.resolve(pf.folder);
    if (isInside(own, folder) || out.some((r) => r.folder === folder)) continue;
    out.push({ folder, projectId: pf.projectId });
  }
  return out;
}

// `folder`'s place in the thread's worktree when it's in the worktree's
// main checkout and the worktree has it too, else `folder`. Written from
// the thread's own folder as given, not its real path, so it walks up to
// home the way `own` does (/tmp and /private/tmp are one folder to git).
function inWorktree(folder: string, worktree: { top: string; main: string }, own: string): string {
  let real: string;
  try {
    real = fs.realpathSync(folder);
  } catch {
    return folder;
  }
  if (!isInside(real, worktree.main)) return folder;
  let ownReal: string;
  try {
    ownReal = fs.realpathSync(own);
  } catch {
    return folder;
  }
  const top = path.resolve(own, path.relative(ownReal, worktree.top));
  const twin = path.join(top, path.relative(worktree.main, real));
  return fs.existsSync(twin) ? twin : folder;
}

// The built-in patches: the thread's folder's, then each project folder's
// that isn't the same project as one already found.
function builtins(cwd: string, home: string, roots: ProjectFolder[], dirs: FolderCache): LoadedPatch[] {
  const out: LoadedPatch[] = [];
  const found = new Set<string>();
  const add = (start: string, root?: ProjectFolder) => {
    const convexDir = findUp(start, home, (d) => isConvexProject(d, dirs));
    if (convexDir && !found.has('convex@' + convexDir)) {
      found.add('convex@' + convexDir);
      out.push(inFolder({ info: { id: 'convex', source: 'builtin' }, panels: [convexPanel(convexDir, dirs)], actions: [], hooks: [] }, root, convexDir));
    }
    const xcodeDir = findUp(start, home, (d) => hasXcodeProject(d, dirs));
    if (xcodeDir && !found.has('xcode@' + xcodeDir)) {
      found.add('xcode@' + xcodeDir);
      out.push(inFolder({ info: { id: 'xcode', source: 'builtin' }, panels: [simulatorPanel(xcodeDir)], actions: [], hooks: [] }, root, xcodeDir));
    }
  };
  add(cwd);
  for (const root of roots) add(root.folder, root);
  return out;
}

// Tags a patch from a project folder with where it came from and where
// its commands run. The thread's own patches are left as they were.
function inFolder(loaded: LoadedPatch, root: ProjectFolder | undefined, infoFolder?: string): LoadedPatch {
  if (!root) return loaded;
  const tag = { projectId: root.projectId };
  return {
    info: { ...loaded.info, folder: infoFolder ?? root.folder, ...tag },
    panels: loaded.panels.map((p) => ({ ...p, ...tag })),
    actions: loaded.actions.map((a) => ({ ...a, folder: a.folder ?? root.folder, ...tag })),
    hooks: loaded.hooks.map((h) => ({ ...h, folder: root.folder, ...tag })),
  };
}

// Adds a patch to the set; one whose name is already taken gets its
// folder's name in front ("web:convex"), and so do its items' ids.
function addPatch(set: PatchSet, loaded: LoadedPatch): void {
  let patch = loaded;
  if (set.patches.some((p) => p.id === loaded.info.id)) {
    const folder = loaded.info.folder ?? (loaded.info.file ? path.dirname(path.dirname(path.dirname(loaded.info.file))) : undefined);
    const prefix = folder ? path.basename(folder) : 'other';
    let id = `${prefix}:${loaded.info.id}`;
    for (let n = 2; set.patches.some((p) => p.id === id); n++) id = `${prefix}:${loaded.info.id}-${n}`;
    patch = renamePatch(loaded, id);
  }
  set.patches.push(patch.info);
  set.panels.push(...patch.panels);
  set.actions.push(...patch.actions);
  set.hooks.push(...patch.hooks);
}

// Panels that would share a title, like the Convex dashboards of two of a
// project's folders, get their folder's name after it ("Convex · web"), so
// the tabs and rail buttons say which is which. A thread's own built-in
// patches have no folder of their own and count as the thread's.
function nameClashingPanels(set: PatchSet, cwd: string): void {
  const folderOf = (panel: Panel): string => {
    const info = set.patches.find((p) => p.id === panel.patch);
    return info?.folder ?? (info?.file ? path.dirname(path.dirname(path.dirname(info.file))) : cwd);
  };
  const byTitle = new Map<string, Panel[]>();
  for (const panel of set.panels) byTitle.set(panel.title, [...(byTitle.get(panel.title) ?? []), panel]);
  for (const [title, panels] of byTitle) {
    if (panels.length < 2) continue;
    const folders = panels.map(folderOf);
    // Two folders with the same name (a repo and its worktree, say) take
    // their parent's name too.
    const names = folders.map((f) => path.basename(f));
    const label = (f: string, i: number) =>
      names.filter((n) => n === names[i]).length > 1 ? `${path.basename(path.dirname(f))}/${names[i]}` : names[i];
    // New objects: a patch file's panels are the cached module's own.
    panels.forEach((panel, i) => {
      set.panels[set.panels.indexOf(panel)] = { ...panel, title: `${title} · ${label(folders[i], i)}` };
    });
  }
}

function renamePatch(loaded: LoadedPatch, id: string): LoadedPatch {
  const from = loaded.info.id;
  const item = <T extends { id: string; patch: string }>(x: T): T => ({ ...x, id: id + x.id.slice(from.length), patch: id });
  return {
    info: { ...loaded.info, id },
    panels: loaded.panels.map(item),
    actions: loaded.actions.map(item),
    hooks: loaded.hooks.map(item),
  };
}

// Whether `dir` is `parent` or somewhere under it.
export function isInside(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The patch folders that apply to `cwd`: the home one, then each folder
// from the top down to `cwd` itself (a deeper file wins a clash of ids, as
// the later one in the list).
export function patchDirs(cwd: string, home: string, dirs: FolderCache = new FolderCache()): { dir: string; source: 'home' | 'project' }[] {
  const out: { dir: string; source: 'home' | 'project' }[] = [];
  const homeDir = path.join(path.resolve(home), PATCH_DIR);
  if (dirs.isDir(homeDir)) out.push({ dir: homeDir, source: 'home' });
  const chain: string[] = [];
  findUp(cwd, home, (dir) => {
    chain.unshift(dir);
    return false;
  });
  for (const dir of chain) {
    const patchDir = path.join(dir, PATCH_DIR);
    if (patchDir !== homeDir && dirs.isDir(patchDir)) out.push({ dir: patchDir, source: 'project' });
  }
  return out;
}

// Every project patch file a thread in `cwd` would read from its own
// folder chain (not home's): what a first start trusts as already running.
export function projectPatchFiles(cwd: string, home: string = os.homedir()): string[] {
  const dirs = new FolderCache();
  return patchDirs(cwd, home, dirs)
    .filter((d) => d.source === 'project')
    .flatMap((d) => patchFiles(d.dir, dirs));
}

function patchFiles(dir: string, dirs: FolderCache): string[] {
  return dirs
    .names(dir)
    .filter((n) => PATCH_EXTENSIONS.includes(path.extname(n)) && !n.endsWith('.d.ts') && !n.startsWith('.'))
    .sort()
    .map((n) => path.join(dir, n));
}

async function loadPatchFile(file: string, source: 'home' | 'project', cache: PatchCache, dirs: FolderCache = new FolderCache(), gate: PatchGate = TRUST_ALL): Promise<LoadedPatch> {
  const id = path.basename(file, path.extname(file));
  const mtimeMs = dirs.mtimeMs(file);
  if (mtimeMs === undefined) return { info: { id, source, file, error: `can't read ${file}` }, panels: [], actions: [], hooks: [] };
  // Before the cache: a file imported once and then changed by a pull is
  // asked about again, whatever's cached for it.
  let files: string[] | undefined;
  let blocked: Record<string, string> | undefined;
  let verified: { hash: string; root: string; code: Map<string, Buffer>; edges: Map<string, Map<string, string>> } | undefined;
  if (source === 'project') {
    let verdict;
    try {
      verdict = await gate.check(file, mtimeMs);
    } catch (e) {
      return { info: { id, source, file, error: firstLine(e) }, panels: [], actions: [], hooks: [] };
    }
    // One trust can't check is an error, not a question: there's no
    // version of it to say yes to (patch-trust.ts).
    if (!verdict.trusted && verdict.reason === 'unchecked') return { info: { id, source, file, error: `Not run: ${verdict.problem}` }, panels: [], actions: [], hooks: [] };
    if (!verdict.trusted) return { info: { id, source, file, untrusted: verdict.reason, hash: verdict.hash, ...(verdict.helpers ? { helpers: verdict.helpers } : {}) }, panels: [], actions: [], hooks: [] };
    files = verdict.files;
    blocked = verdict.blocked;
    if (verdict.hash && verdict.root && verdict.code && verdict.edges) verified = { hash: verdict.hash, root: verdict.root, code: verdict.code, edges: verdict.edges };
    // Trusted by hash, it's imported from the bytes that hash was made
    // from (verified-imports.ts); one without them can't be.
    else if (files) return { info: { id, source, file, error: "Not run: patch trust didn't keep the code it checked." }, panels: [], actions: [], hooks: [] };
  }
  const key = verified ? `v:${verified.hash}` : `m:${mtimeMs}`;
  const hit = cache.get(file);
  if (!files) liveBindings.delete(file);
  if (hit && hit.key === key) return files ? bindAutomatic(hit.loaded, file, files, blocked, verified?.hash) : hit.loaded;
  let loaded: LoadedPatch;
  try {
    // The query makes Node load the file again after an edit: a module URL
    // is loaded once per process.
    const url = verified ? verifiedUrl(verified.root, verified.hash, verified.code, verified.edges) : `${pathToFileURL(file).href}?mtime=${mtimeMs}`;
    const mod = (await import(url)) as { default?: unknown };
    loaded = readPatchModule(id, source, file, mod.default);
  } catch (e) {
    loaded = { info: { id, source, file, error: firstLine(e) }, panels: [], actions: [], hooks: [] };
  }
  cache.set(file, { key, loaded });
  return files ? bindAutomatic(loaded, file, files, blocked, verified?.hash) : loaded;
}

// The patch version each bound automatic command (a hook's `exec`, a
// setup's `setupRun`) was approved by, so the runner can check the patch
// still hashes to it just before running it: a script runs from the
// folder, not from the bytes that were hashed.
const boundBy = new Map<string, { file: string; hash: string }>();
export function automaticTrust(run: string): { file: string; hash: string } | undefined {
  return boundBy.get(run);
}

// What a trusted-by-hash patch's live functions' `sh` commands are held to
// (liveCommandProblem), by patch file: the folder holding `.threadbear/`
// (where its commands were followed from for the hash, and where they
// run, except a tool patch's, which runs in the folder it applies in),
// the files the hash covered, the scripts it can't follow, and the hash,
// checked again before they run. A patch trusted whatever it holds (home's,
// Threadbear's own) has none.
type LiveBinding = { folder: string; files: string[]; blocked?: Record<string, string>; hash: string; tool: boolean };
const liveBindings = new Map<string, LiveBinding>();

// The patch version a trusted-by-hash patch's command action was approved
// by. On the action itself, as an action outlives its patch's next look (a
// thread's patch set is cached), and that look can drop what's kept by file.
// A symbol, as this is the runner's and not the protocol's: copying an
// action keeps it (`{...a}`), and JSON leaves it out. runAction refuses a
// project patch's command without one (actionRunProblem).
const ACTION_TRUST = Symbol('actionTrust');
type BoundAction = Action & { [ACTION_TRUST]?: { file: string; hash: string } };

// Why an action of a trusted-by-hash patch mustn't run now, or undefined
// when it may: what the hash covered may have changed since the patch was
// last looked at, and an action runs from the folder, not from the bytes
// that were hashed, so the patch is hashed afresh as the action starts, as
// for a hook (Daybreak, 7 Nov). `loadsUnhashed`: whether this patch runs
// whatever it holds (home's, Threadbear's own), which has no hash to check.
export function actionRunProblem(action: Action, info: PatchInfo | undefined, verify: (file: string, hash: string) => boolean, loadsUnhashed: (patchesDir: string) => boolean): string | undefined {
  if (action.kind !== 'command') return undefined;
  const by = (action as BoundAction)[ACTION_TRUST];
  if (!by) {
    const open = !info?.file || info.source !== 'project' || loadsUnhashed(path.dirname(info.file));
    return open ? undefined : "patch trust has no version of its patch to check it against.";
  }
  const bound = liveBindings.get(by.file);
  if (!bound || bound.hash !== by.hash || !verify(by.file, by.hash)) return 'its patch, or a file it runs, changed since it was trusted.';
  // A tool patch runs in the folder it applies in, and is checked from both,
  // as a live command is (liveSh).
  const command = action.command ?? '';
  for (const dir of new Set([action.folder ?? bound.folder, bound.folder])) {
    const problem = actionCommandProblem(command, dir, bound.files, bound.blocked);
    if (problem) return problem;
  }
  return undefined;
}

// A trusted-by-hash patch's commands that run by themselves (its hooks and
// worktree setup) as they'll run: each must be one hashed script and plain
// words (automaticCommand), or the whole patch is refused with why, as a
// patch whose code can't all be checked is. A copy, as `loaded` is cached.
// Actions aren't held to it, as one runs only when it's pressed, but what
// each runs must be followable and hashed (actionCommandProblem), checked
// again when it's pressed (actionRunProblem).
function bindAutomatic(loaded: LoadedPatch, file: string, files: string[], blocked?: Record<string, string>, hash?: string): LoadedPatch {
  liveBindings.delete(file);
  if (loaded.info.error) return loaded;
  const note = (run: string) => {
    if (hash) boundBy.set(run, { file, hash });
    return run;
  };
  const folder = path.dirname(path.dirname(path.dirname(file)));
  // Without a hash there's nothing to check a command against, so a live
  // function's sh refuses everything (liveSh).
  liveBindings.set(file, { folder: fs.realpathSync(folder), files: [file, fs.realpathSync(file), ...files], ...(blocked ? { blocked } : {}), hash: hash ?? '', tool: loaded.appliesTo !== undefined });
  const refuse = (what: string, problem: string): LoadedPatch => ({ info: { ...loaded.info, error: `Not run: its ${what} ${problem}` }, panels: [], actions: [], hooks: [] });
  const hooks: Hook[] = [];
  for (const hook of loaded.hooks) {
    const bound = automaticCommand(hook.command, folder, files, blocked);
    if ('problem' in bound) return refuse(`hook "${hook.title}"`, bound.problem);
    hooks.push({ ...hook, exec: note(bound.run) });
  }
  // Actions run from the folder holding .threadbear/, where their commands
  // were followed for the hash from. One whose command reaches a file the
  // hash didn't cover (it's worked out in code), or that can't be followed
  // all the way, can't be vouched for, so it refuses the patch as a hook does.
  const actions: BoundAction[] = [];
  for (const action of loaded.actions) {
    if (action.kind === 'command' && action.command) {
      const problem = actionCommandProblem(action.command, folder, [file, fs.realpathSync(file), ...files], blocked);
      if (problem) return refuse(`action "${action.title}"`, problem);
      actions.push({ ...action, folder: action.folder ?? fs.realpathSync(folder), ...(hash ? { [ACTION_TRUST]: { file, hash } } : {}) });
    } else actions.push(action);
  }
  let worktree = loaded.worktree;
  if (worktree?.setup) {
    const bound = automaticCommand(worktree.setup, folder, files, blocked);
    if ('problem' in bound) return refuse('worktree setup', bound.problem);
    worktree = { ...worktree, setupRun: note(bound.run) };
  }
  return { ...loaded, actions, hooks, ...(worktree ? { worktree } : {}) };
}

// Turns a patch module's default export into actions and panels, with ids
// from the patch's name and each title. Anything malformed is an error
// for the whole file: a half-loaded patch would be confusing.
export function readPatchModule(id: string, source: 'home' | 'project', file: string, value: unknown): LoadedPatch {
  const info: PatchInfo = { id, source, file };
  const problem = (text: string): LoadedPatch => ({ info: { ...info, error: text }, panels: [], actions: [], hooks: [] });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return problem('The default export should be an object with actions and/or panels.');
  }
  const v = value as { actions?: unknown; panels?: unknown; hooks?: unknown; worktree?: unknown; appliesTo?: unknown; icon?: unknown };
  // The patch's own icon goes on each of its chips, so a row of chips from
  // several patches says which one each came from (an action can have its own).
  // It can also be a picture: the tool's own icon, so its chips and rail
  // button are recognisable at a glance (see readIcon).
  const patchIcon = readIcon(v.icon, file);
  if (typeof patchIcon === 'string') return problem(`icon ${patchIcon}`);
  if (patchIcon) Object.assign(info, patchIcon);
  let appliesTo: string[] | undefined;
  if (v.appliesTo !== undefined) {
    const list = typeof v.appliesTo === 'string' ? [v.appliesTo] : v.appliesTo;
    if (!Array.isArray(list) || !list.length || list.some((g) => typeof g !== 'string' || !g.trim() || g.includes('/'))) {
      return problem('appliesTo should be a name glob like "*.tandem", or a list of them (names in a folder, no slashes).');
    }
    appliesTo = list.map((g: string) => g.trim());
  }
  // The when, badge and summary functions of the file's actions and panels,
  // kept aside (see liveFunctions) once the whole file has passed. Only
  // panels have a summary.
  const live: [string, LiveFunctions][] = [];
  const liveOf = (kind: string, i: number, title: string, raw: { when?: unknown; badge?: unknown; summary?: unknown }, itemId: string): string | undefined => {
    const fns: LiveFunctions = {};
    for (const key of kind === 'panels' ? (['when', 'badge', 'summary'] as const) : (['when', 'badge'] as const)) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== 'function') return `${kind}[${i}] ("${title}") has a ${key} that isn't a function.`;
      fns[key] = raw[key] as LiveFunction;
    }
    if (fns.when || fns.badge || fns.summary) live.push([itemId.slice(id.length), fns]);
    return undefined;
  };
  let worktree: WorktreeConfig | undefined;
  if (v.worktree !== undefined) {
    const w = v.worktree as { setup?: unknown; check?: unknown; keep?: unknown };
    if (!w || typeof w !== 'object' || Array.isArray(w)) return problem('worktree should be an object with setup and/or check.');
    worktree = {};
    for (const key of ['setup', 'check'] as const) {
      if (w[key] === undefined) continue;
      if (typeof w[key] !== 'string' || !w[key].trim()) return problem(`worktree.${key} should be a command.`);
      worktree[key] = w[key];
    }
    if (w.keep !== undefined) {
      const keep = w.keep;
      const relative = (p: unknown) => typeof p === 'string' && p.trim() !== '' && !path.isAbsolute(p) && !p.split('/').includes('..');
      if (!Array.isArray(keep) || !keep.length || !keep.every(relative)) {
        return problem('worktree.keep should be a list of folders inside the repo, like "app/.build".');
      }
      worktree.keep = keep as string[];
    }
  }
  const actions: Action[] = [];
  const panels: Panel[] = [];
  const hooks: Hook[] = [];
  if (v.actions !== undefined) {
    if (!Array.isArray(v.actions)) return problem('actions should be an array.');
    for (const [i, raw] of v.actions.entries()) {
      const a = raw as { title?: unknown; run?: unknown; prompt?: unknown; url?: unknown; note?: unknown; icon?: unknown; when?: unknown; badge?: unknown };
      if (!a || typeof a !== 'object' || typeof a.title !== 'string' || !a.title.trim()) return problem(`actions[${i}] needs a title.`);
      const run = typeof a.run === 'string' && a.run.trim() ? a.run : undefined;
      const prompt = typeof a.prompt === 'string' && a.prompt.trim() ? a.prompt : undefined;
      const url = a.url === undefined ? undefined : webPage(a.url);
      if (url === null) return problem(`actions[${i}] ("${a.title}") has a url that isn't an http or https page.`);
      const given = [run, prompt, url].filter(Boolean).length;
      if (!given) return problem(`actions[${i}] ("${a.title}") needs run (a command), prompt (a message) or url (a page to open).`);
      if (given > 1) return problem(`actions[${i}] ("${a.title}") should have one of run, prompt or url, not more.`);
      const action: Action = { id: `${id}.${slug(a.title)}`, title: a.title.trim(), kind: run ? 'command' : prompt ? 'prompt' : 'url', patch: id };
      if (run) action.command = run;
      if (prompt) action.prompt = prompt;
      if (url) action.url = url;
      if (typeof a.note === 'string' && a.note.trim()) action.note = a.note.trim();
      const own = readIcon(a.icon, file);
      if (typeof own === 'string') return problem(`actions[${i}] ("${a.title}"): icon ${own}`);
      Object.assign(action, own ?? patchIcon);
      const liveProblem = liveOf('actions', i, action.title, a, action.id);
      if (liveProblem) return problem(liveProblem);
      actions.push(action);
    }
  }
  if (v.panels !== undefined) {
    if (!Array.isArray(v.panels)) return problem('panels should be an array.');
    for (const [i, raw] of v.panels.entries()) {
      const p = raw as { title?: unknown; url?: unknown; note?: unknown; icon?: unknown; items?: unknown; when?: unknown; badge?: unknown; summary?: unknown };
      if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim()) return problem(`panels[${i}] needs a title.`);
      const ownIcon = readIcon(p.icon, file);
      if (typeof ownIcon === 'string') return problem(`panels[${i}] ("${p.title}"): icon ${ownIcon}`);
      const panelId = `${id}.${slug(p.title)}`;
      let panel: Panel;
      if (typeof p.items === 'function') {
        // A list panel: rows drawn by the app, from the function, called
        // when the app asks (panels.render).
        if (p.url !== undefined) return problem(`panels[${i}] ("${p.title}") should have url or items, not both.`);
        panel = { id: panelId, title: p.title.trim(), kind: 'list', patch: id };
        listFunctions.set(listKey(file, panelId.slice(id.length)), p.items as ItemsFunction);
      } else {
        // A page the web view can open: a scheme with //, or a data: page.
        if (typeof p.url !== 'string' || !/^([a-z][a-z0-9+.-]*:\/\/\S|data:)/i.test(p.url.trim())) return problem(`panels[${i}] ("${p.title}") needs a url, or an items function.`);
        panel = { id: panelId, title: p.title.trim(), kind: 'url', url: p.url.trim(), patch: id };
      }
      // Its own icon, else the patch's: a tool's picture on its rail button.
      Object.assign(panel, ownIcon ?? patchIcon);
      if (typeof p.note === 'string' && p.note.trim()) panel.note = p.note.trim();
      const liveProblem = liveOf('panels', i, panel.title, p, panel.id);
      if (liveProblem) return problem(liveProblem);
      panels.push(panel);
    }
  }
  if (v.hooks !== undefined) {
    if (!Array.isArray(v.hooks)) return problem('hooks should be an array.');
    for (const [i, raw] of v.hooks.entries()) {
      const h = raw as { title?: unknown; on?: unknown; run?: unknown; edited?: unknown; tell?: unknown; note?: unknown };
      if (!h || typeof h !== 'object' || typeof h.title !== 'string' || !h.title.trim()) return problem(`hooks[${i}] needs a title.`);
      if (h.on !== 'turn.end') return problem(`hooks[${i}] ("${h.title}") needs on: "turn.end" (the one trigger so far).`);
      if (typeof h.run !== 'string' || !h.run.trim()) return problem(`hooks[${i}] ("${h.title}") needs run (a command).`);
      if (h.tell !== undefined && h.tell !== 'failures' && h.tell !== 'always' && h.tell !== 'never') {
        return problem(`hooks[${i}] ("${h.title}") has tell "${String(h.tell)}"; it's "failures" (the default), "always" or "never".`);
      }
      if (h.edited !== undefined && (typeof h.edited !== 'string' || !h.edited.trim())) return problem(`hooks[${i}] ("${h.title}") has an edited that isn't a glob.`);
      const hook: Hook = { id: `${id}.${slug(h.title)}`, title: h.title.trim(), on: 'turn.end', command: h.run, tell: (h.tell as Hook['tell']) ?? 'failures', patch: id };
      if (typeof h.edited === 'string') hook.edited = h.edited.trim();
      if (typeof h.note === 'string' && h.note.trim()) hook.note = h.note.trim();
      hooks.push(hook);
    }
  }
  const ids = new Set<string>();
  for (const x of [...actions, ...panels, ...hooks]) {
    if (ids.has(x.id)) return problem(`Two entries would both be called ${x.id}; give them different titles.`);
    ids.add(x.id);
  }
  for (const key of [...liveFunctions.keys()]) if (key.startsWith(file + '\u0000')) liveFunctions.delete(key);
  for (const [suffix, fns] of live) liveFunctions.set(listKey(file, suffix), fns);
  const loaded: LoadedPatch = { info, panels, actions, hooks };
  if (worktree) loaded.worktree = worktree;
  if (appliesTo) loaded.appliesTo = appliesTo;
  return loaded;
}

// An action's url, normalised, if it's an http or https page; null if not.
// Only web pages: a url chip opens in the browser of whatever device it was
// pressed on, and the runner hands it to `open` for older apps, so a file:
// or app scheme here would be a way to run things.
export function webPage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

// The patch that gives a thread in `cwd` its own worktree: the first patch
// file with a `worktree`, from `cwd` up (the nearest folder first). Home's
// ~/.threadbear/patches never counts, and nor do project folders:
// worktrees are a repo's own choice. `folder` holds the `.threadbear/`.
export type WorktreePatch = WorktreeConfig & { patch: string; file: string; folder: string };

export async function findWorktreePatch(
  cwd: string,
  home: string = os.homedir(),
  cache: PatchCache = new Map(),
  dirs: FolderCache = new FolderCache(),
  gate: PatchGate = TRUST_ALL,
  strict = false,
): Promise<WorktreePatch | undefined> {
  for (const file of worktreePatchFiles(cwd, home, dirs)) {
    const found = await readWorktreePatch(file, cache, dirs, gate);
    if (strict && found && 'error' in found) throw new Error(`${file}: ${found.error}`);
    if (found && !('error' in found)) return found;
  }
  return undefined;
}

// One patch file's `worktree`, if it loads and has one; `error` when it
// doesn't load (untrusted, or refused), for saying why setup didn't run.
export async function readWorktreePatch(
  file: string,
  cache: PatchCache = new Map(),
  dirs: FolderCache = new FolderCache(),
  gate: PatchGate = TRUST_ALL,
): Promise<WorktreePatch | { error: string } | undefined> {
  const loaded = await loadPatchFile(file, 'project', cache, dirs, gate);
  if (loaded.info.error) return { error: loaded.info.error };
  if (loaded.info.untrusted) return { error: "it isn't a version you've trusted." };
  if (!loaded.worktree) return undefined;
  return { ...loaded.worktree, patch: loaded.info.id, file, folder: path.dirname(path.dirname(path.dirname(file))) };
}

// The patch files findWorktreePatch would read, nearest folder first.
// Synchronous, so a thread with none can start without waiting.
export function worktreePatchFiles(cwd: string, home: string = os.homedir(), dirs: FolderCache = new FolderCache()): string[] {
  return patchDirs(cwd, home, dirs)
    .filter((d) => d.source === 'project')
    .reverse()
    .flatMap((d) => patchFiles(d.dir, dirs));
}

// Whether a turn's edits make a hook run: no filter, or one of the edited
// paths (relative to the thread's folder) matches its glob. A hook from a
// project folder only sees edits inside that folder, and needs one.
export function hookApplies(hook: Hook, editedPaths: Iterable<string>, cwd: string): boolean {
  if (!hook.edited && !hook.folder) return true;
  const base = hook.folder ?? cwd;
  for (const p of editedPaths) {
    const rel = path.relative(base, path.resolve(cwd, p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!hook.edited || path.matchesGlob(rel, hook.edited)) return true;
  }
  return false;
}

// An `icon` in a patch file: an SF Symbol name ("film"), or a picture,
// which is a path (relative to the patch file, or from ~) to an image the
// app can open (png, svg, icns, pdf, jpg) or to a .app, whose icon it
// shows. Gives { icon } or { iconFile } (the absolute path), undefined for
// none, or a string saying what's wrong (after "icon ").
const ICON_EXTENSIONS = ['.png', '.svg', '.icns', '.pdf', '.jpg', '.jpeg', '.app'];
export function readIcon(raw: unknown, patchFile: string): { icon: string } | { iconFile: string } | undefined | string {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) return 'should be an SF Symbol name like "film", or a path to a picture or an app.';
  const value = raw.trim();
  const isPath = /^(\.{1,2}\/|\/|~\/)/.test(value) || ICON_EXTENSIONS.includes(path.extname(value).toLowerCase());
  if (!isPath) return { icon: value };
  if (!ICON_EXTENSIONS.includes(path.extname(value).toLowerCase())) return `"${value}" should be a ${ICON_EXTENSIONS.join(', ')} file.`;
  const full = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(path.dirname(patchFile), value);
  if (!fs.existsSync(full)) return `"${value}" isn't there (looked for ${full}).`;
  return { iconFile: full };
}

export function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function firstLine(e: unknown): string {
  const text = String((e as Error)?.message ?? e);
  return text.split('\n').find((l) => l.trim()) ?? 'Unknown error';
}

// The built-in set alone, synchronous: what the first summary of a thread
// shows before its patch files have been read.
export function projectPanels(cwd: string, home: string = os.homedir(), projectFolders: ProjectFolder[] = [], dirs: FolderCache = new FolderCache()): Panel[] {
  const set: PatchSet = { panels: [], actions: [], hooks: [], patches: [] };
  for (const b of builtins(cwd, home, projectRoots(cwd, projectFolders), dirs)) addPatch(set, b);
  nameClashingPanels(set, cwd);
  return set.panels;
}

// The Convex dashboard for the project's deployment. `.env.local` (what
// `convex dev` writes) wins over `.env`.
function convexPanel(dir: string, dirs: FolderCache): Panel {
  const deployment = readEnvValue(dir, 'CONVEX_DEPLOYMENT', dirs);
  const { url, note } = convexDashboardUrl(deployment);
  const panel: Panel = { id: 'convex.dashboard', title: 'Convex', kind: 'url', url, icon: 'cylinder.split.1x2', patch: 'convex' };
  if (note) panel.note = note;
  const embed = convexEmbed(deployment, readEnvWhere(dir, (name) => /(^|_)CONVEX_URL$/.test(name), dirs));
  if (embed) panel.convex = { ...embed, ...convexProjectOf(dir, dirs) };
  return panel;
}

// The team and project `convex dev` notes after CONVEX_DEPLOYMENT
// ("dev:happy-otter-123 # team: mike, project: walkies"), so the panel can
// say which project a deployment belongs to: its name alone doesn't.
export function convexProjectOf(dir: string, dirs: FolderCache = new FolderCache()): { team?: string; project?: string } {
  for (const file of ENV_FILES) {
    const text = dirs.text(path.join(dir, file));
    if (text === undefined) continue;
    const line = text.split(/\r?\n/).find((l) => /^\s*(?:export\s+)?CONVEX_DEPLOYMENT\s*=/.test(l));
    if (!line) continue;
    const m = /#\s*team:\s*([\w-]+)\s*,\s*project:\s*([\w-]+)/.exec(line);
    return m ? { team: m[1], project: m[2] } : {};
  }
  return {};
}

// What the Mac app needs to show Convex's embedded dashboard, which takes a
// deploy key instead of a login (docs/protocol.md, "The Convex panel"). Only
// a cloud deployment: the embedded dashboard is https, and a local one's
// http://127.0.0.1 address would be blocked there as mixed content.
export function convexEmbed(deployment: string | undefined, deploymentUrl: string | undefined): Panel['convex'] {
  const name = convexDeploymentName(deployment);
  if (!name || deployment!.startsWith('anonymous:') || !deploymentUrl) return undefined;
  const url = convexCloudUrl(name, deploymentUrl);
  return url ? { deployment: name, deploymentUrl: url } : undefined;
}

// The deployment's own Convex cloud address (`<name>.convex.cloud`, or with
// a region, `<name>.eu-west-1.convex.cloud`), or nothing. The panel hands
// this URL a deploy key, and the URL comes from a project's env file, which
// a cloned repo writes: one naming your deployment but someone else's
// server would otherwise get your key sent there. A custom domain gets no
// embedded dashboard, just the link to Convex's.
export function convexCloudUrl(deployment: string, url: string): string | undefined {
  try {
    const u = new URL(url);
    const own = u.protocol === 'https:' && !u.username && !u.password && !u.port
      && new RegExp(`^${deployment}(\\.[a-z0-9-]+)?\\.convex\\.cloud$`).test(u.hostname);
    return own ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

// The name in a CONVEX_DEPLOYMENT ("dev:happy-otter-123"), if it looks like
// one. It ends up in a command line and a file name, so nothing else passes.
export function convexDeploymentName(deployment: string | undefined): string | undefined {
  const name = deployment?.slice(deployment.indexOf(':') + 1);
  return name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? name : undefined;
}

// Mirrors the CLI's own `convex dashboard`: every deployment type is a
// page on dashboard.convex.dev, except an anonymous local one, which the
// CLI serves itself while `convex dev` runs.
export function convexDashboardUrl(deployment: string | undefined): { url: string; note?: string } {
  if (!deployment) return { url: CONVEX_DASHBOARD, note: 'No deployment in .env.local yet' };
  const colon = deployment.indexOf(':');
  const type = colon >= 0 ? deployment.slice(0, colon) : '';
  const name = colon >= 0 ? deployment.slice(colon + 1) : deployment;
  if (!name) return { url: CONVEX_DASHBOARD };
  if (type === 'anonymous') return { url: CONVEX_LOCAL_DASHBOARD, note: `${name}, local; the dashboard is up while convex dev runs` };
  return { url: `${CONVEX_DASHBOARD}/d/${encodeURIComponent(name)}`, note: type ? `${name} (${type})` : name };
}

// A folder with its functions in convex/ and a package.json or convex.json
// beside them. A bare folder called convex isn't enough: ~/dev/convex is a
// folder of repos, and every thread under ~/dev got a dashboard panel.
export function isConvexProject(dir: string, dirs: FolderCache = new FolderCache()): boolean {
  if (!dirs.isDir(path.join(dir, 'convex'))) return false;
  return dirs.exists(path.join(dir, 'package.json')) || dirs.exists(path.join(dir, 'convex.json'));
}

function simulatorPanel(dir: string): Panel {
  return { id: 'xcode.simulator', title: 'Simulator', kind: 'image', icon: 'iphone', patch: 'xcode', note: path.basename(dir) };
}

function hasXcodeProject(dir: string, dirs: FolderCache): boolean {
  return dirs.names(dir).some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
}

// The first folder from `start` up to and including `home` (or the root)
// that passes `test`. Folders above home are never a project of Mike's.
export function findUp(start: string, home: string, test: (dir: string) => boolean): string | undefined {
  let dir = path.resolve(start);
  const stopAt = path.resolve(home);
  for (;;) {
    if (test(dir)) return dir;
    if (dir === stopAt) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// A dotenv value by name, unquoted; `.env.local` then `.env`. Only the one
// line is returned, never the file: the rest may hold secrets (a runner's
// FolderCache keeps the text in memory for a few seconds, nowhere else).
const ENV_FILES = ['.env.local', '.env'];

export function readEnvValue(dir: string, name: string, dirs: FolderCache = new FolderCache()): string | undefined {
  return readEnvWhere(dir, (n) => n === name, dirs);
}

// The first value whose name passes `test`: CONVEX_URL is VITE_CONVEX_URL,
// NEXT_PUBLIC_CONVEX_URL and so on, depending on the framework.
export function readEnvWhere(dir: string, test: (name: string) => boolean, dirs: FolderCache = new FolderCache()): string | undefined {
  for (const file of ENV_FILES) {
    const text = dirs.text(path.join(dir, file));
    if (text === undefined) continue;
    const value = parseEnvWhere(text, test);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseEnvValue(text: string, name: string): string | undefined {
  return parseEnvWhere(text, (n) => n === name);
}

// The file is a cloned repo's, so nothing here may take longer than the
// text is long (linear-text.ts): `/\s+#.*$/` on a value of a few MB of
// spaces froze the runner (Gautam's scan, F9).
function parseEnvWhere(text: string, test: (name: string) => boolean): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !test(m[1])) continue;
    // What `\s*(.*)$` took: a line break left in the value (a lone \r)
    // was no match.
    const rest = line.slice(m[0].length).trimStart();
    if (hasLineBreak(rest)) continue;
    let value = rest.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at a comment.
      value = stripEnvComment(value).trim();
    }
    return value;
  }
  return undefined;
}

// ------------------------------------------------------------- rendering

export type PanelRender = { image?: ImageRef; items?: PanelItem[]; note?: string };

// ------------------------------------------------------------ list panels

// What list panels and live state run their functions' commands with.
// `verify` hashes a trusted-by-hash patch afresh (PatchTrust.verify): its
// sh commands run only while it's still the version that was trusted.
export type LiveContext = {
  cwd: string;
  threadId: string;
  run: (command: string, cwd: string) => Promise<CommandOutcome>;
  verify?: (file: string, hash: string) => boolean;
  timeoutMs?: number;
};

// `key`: what a command's output is shared under in one read; a bound
// patch's checks are its own, so its refusals don't reach another's.
// `close`: the function's call is over (it returned, threw or timed
// out); a command it starts after that isn't run.
type LiveSh = { dir: string; key: string; run: (command: string) => Promise<CommandOutcome>; close: () => void };

// How a patch's live function runs a command. A trusted-by-hash patch's
// (liveBindings) run from the folder holding its `.threadbear/` (a tool
// patch's from the folder it applies in), only while the patch still
// hashes to the trusted version, checked afresh before each command (a
// function can wait between two), only what liveCommandProblem allows,
// and only while the function's call is still going; anything else is
// refused as a failed command, never run. Others run in `cwd`, as written.
function liveSh(file: string | undefined, cwd: string, ctx: LiveContext): LiveSh {
  const bound = file ? liveBindings.get(file) : undefined;
  let closed = false;
  const refuse = (why: string): CommandOutcome => ({ ok: false, text: `Not run: ${why}`, truncated: false, durationMs: 0 });
  const close = () => {
    closed = true;
  };
  if (!bound) return { dir: cwd, key: cwd, run: (command) => ctx.run(command, cwd), close };
  const dir = bound.tool ? cwd : bound.folder;
  return {
    dir,
    key: `${dir}\u0000${file}`,
    close,
    run: async (command) => {
      if (closed) return refuse('its function had already finished or timed out.');
      if (!bound.hash || !(ctx.verify?.(file!, bound.hash) ?? false)) return refuse('its patch, or a file it runs, changed since it was trusted.');
      // A tool patch runs in the folder it applies in, but its own repo's
      // files are bound by the hash too: checked from both, so an absolute
      // path to a script of the tool's that the hash didn't cover is refused.
      const problem = liveCommandProblem(command, dir, bound.files, bound.blocked) ?? (bound.tool ? liveCommandProblem(command, bound.folder, bound.files, bound.blocked) : undefined);
      if (problem) return refuse(problem);
      return ctx.run(command, dir);
    },
  };
}

// Calls a live function, closing its sh the moment it returns: at once
// for a plain value, so a microtask it queued can't start a command after
// it (Codex's review, 6 Nov), and when its promise settles for an async
// one. Every command is still checked and verified as it starts.
function callThenClose(call: () => unknown, shIn: LiveSh): unknown {
  let out: unknown;
  try {
    out = call();
  } catch (e) {
    shIn.close();
    throw e;
  }
  if (out && typeof (out as Promise<unknown>).then === 'function') return Promise.resolve(out).finally(() => shIn.close());
  shIn.close();
  return out;
}

// What a list panel's `items` gets: where it applies, and `sh` to run a
// command there (resolves with what it printed, rejects on failure); for
// a patch trusted by its hash, from the folder holding its `.threadbear/`
// and only what trusting it covers (liveSh).
// `matched` is what made a tool patch apply: the paths its appliesTo
// found (two .tandem files in a folder are two), and empty otherwise.
export type ItemsContext = { cwd: string; threadId: string; matched: string[]; sh: (command: string) => Promise<string> };
type ItemsFunction = (ctx: ItemsContext) => unknown;

// The `items` functions of loaded patch files, by file and the panel's id
// without the patch's name (".worktrees"), which stays the same when
// addPatch puts a folder's name in front of the patch's. Kept out of the
// Panel itself, which goes over the wire. A file that loads again
// replaces its entries.
const listFunctions = new Map<string, ItemsFunction>();
const listKey = (file: string, suffix: string) => `${file}\u0000${suffix}`;

export const LIST_ITEMS_KEPT = 200;
export const LIST_TIMEOUT_MS = 20_000;

// Fills a list panel by calling its patch's function. A throw, a timeout
// or something that isn't a list of rows is a note instead.
export async function renderListPanel(
  panel: Panel,
  set: PatchSet,
  ctx: LiveContext,
): Promise<PanelRender> {
  const info = set.patches.find((p) => p.id === panel.patch);
  const fn = info?.file ? listFunctions.get(listKey(info.file, panel.id.slice(panel.patch.length))) : undefined;
  if (!fn) return { note: 'This panel has nothing to show.' };
  // A project folder's patch runs in that folder, as its actions do.
  const cwd = info?.folder ?? ctx.cwd;
  const shIn = liveSh(info?.file, cwd, ctx);
  const sh = async (command: string) => {
    const out = await shIn.run(command);
    if (!out.ok) throw new Error(`${command} failed${out.exitCode !== undefined ? ` (exit ${out.exitCode})` : ''}: ${out.text.trim().split('\n').pop() ?? ''}`);
    return out.text;
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => callThenClose(() => fn({ cwd, threadId: ctx.threadId, matched: info?.matched ?? [], sh }), shIn)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`took over ${Math.round((ctx.timeoutMs ?? LIST_TIMEOUT_MS) / 1000)} seconds`)), ctx.timeoutMs ?? LIST_TIMEOUT_MS);
      }),
    ]);
    if (!Array.isArray(value)) return { note: "The panel's items function didn't return a list." };
    return { items: value.slice(0, LIST_ITEMS_KEPT).map(panelItem).filter((x): x is PanelItem => x !== undefined) };
  } catch (e) {
    return { note: `Couldn't fill this panel: ${firstLine(e)}` };
  } finally {
    clearTimeout(timer);
    shIn.close();
  }
}

// ------------------------------------------------------------ live state

type LiveFunction = (ctx: ItemsContext) => unknown;
type LiveFunctions = { when?: LiveFunction; badge?: LiveFunction; summary?: LiveFunction };

// The when and badge functions of loaded patch files' actions and panels,
// keyed like listFunctions. Kept off the items, which go over the wire.
const liveFunctions = new Map<string, LiveFunctions>();

export const LIVE_TIMEOUT_MS = 10_000;

function liveFor(set: PatchSet, item: { id: string; patch: string }): LiveFunctions | undefined {
  const file = set.patches.find((p) => p.id === item.patch)?.file;
  return file ? liveFunctions.get(listKey(file, item.id.slice(item.patch.length))) : undefined;
}

// Whether anything in the set has a when or badge, so is worth reading
// again every little while.
export function hasLive(set: PatchSet): boolean {
  return [...set.actions, ...set.panels].some((x) => liveFor(set, x) !== undefined);
}

// The set as it stands now: each action and panel whose `when` isn't
// true left out, and `badge` set from its function (a whole number above
// zero, else none). All at once, each in its patch's folder; a command
// two of them run (both asking `tandem status`) runs once. A function
// that throws or takes too long hides its item (a when) or gives no badge,
// and the patch shows the first such problem as `liveError`.
export async function applyLive(set: PatchSet, ctx: LiveContext): Promise<PatchSet> {
  if (!hasLive(set)) return set;
  const timeoutMs = ctx.timeoutMs ?? LIVE_TIMEOUT_MS;
  const ran = new Map<string, Promise<string>>();
  const errors = new Map<string, string>();
  const call = async (patch: string, fn: LiveFunction): Promise<unknown> => {
    const info = set.patches.find((p) => p.id === patch);
    const cwd = info?.folder ?? ctx.cwd;
    const shIn = liveSh(info?.file, cwd, ctx);
    const sh = (command: string) => {
      const key = `${shIn.key}\u0000${command}`;
      let out = ran.get(key);
      if (!out) {
        out = shIn.run(command).then((o) => {
          if (!o.ok) throw new Error(`${command} failed${o.exitCode !== undefined ? ` (exit ${o.exitCode})` : ''}: ${o.text.trim().split('\n').pop() ?? ''}`);
          return o.text;
        });
        ran.set(key, out);
      }
      return out;
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => callThenClose(() => fn({ cwd, threadId: ctx.threadId, matched: info?.matched ?? [], sh }), shIn)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`took over ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (!errors.has(patch)) errors.set(patch, firstLine(e));
      throw e;
    } finally {
      clearTimeout(timer);
      shIn.close();
    }
  };
  const settle = async <T extends { id: string; patch: string; badge?: number; summary?: string }>(item: T): Promise<T | undefined> => {
    const fns = liveFor(set, item);
    if (!fns) return item;
    const [shown, badge, summary] = await Promise.all([
      fns.when ? call(item.patch, fns.when).then((v) => Boolean(v), () => false) : true,
      fns.badge ? call(item.patch, fns.badge).then(badgeCount, () => undefined) : undefined,
      fns.summary ? call(item.patch, fns.summary).then(summaryText, () => undefined) : undefined,
    ]);
    if (!shown) return undefined;
    const out = { ...item };
    delete out.badge;
    delete out.summary;
    if (badge !== undefined) out.badge = badge;
    if (summary !== undefined) out.summary = summary;
    return out;
  };
  const [actions, panels] = await Promise.all([Promise.all(set.actions.map(settle)), Promise.all(set.panels.map(settle))]);
  return {
    ...set,
    actions: actions.filter((a): a is Action => a !== undefined),
    panels: panels.filter((p): p is Panel => p !== undefined),
    patches: set.patches.map((p) => (errors.has(p.id) ? { ...p, liveError: errors.get(p.id) } : p)),
  };
}

// A summary function's answer as the card's text: a string, or a list of
// lines (empty ones dropped), at most SUMMARY_LINES lines of 120 characters.
export const SUMMARY_LINES = 4;
function summaryText(v: unknown): string | undefined {
  const lines = (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [])
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, SUMMARY_LINES);
  return lines.length ? lines.join('\n') : undefined;
}

// A badge function's answer as a count: a number, a numeric string or a
// list (its length), rounded down; nothing for zero or less.
function badgeCount(v: unknown): number | undefined {
  const n = Array.isArray(v) ? v.length : typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(Math.floor(n), 9999);
}

function panelItem(raw: unknown): PanelItem | undefined {
  if (typeof raw === 'string') return raw.trim() ? { title: raw.trim().slice(0, 300) } : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) return undefined;
  const item: PanelItem = { title: r.title.trim().slice(0, 300) };
  for (const k of ['detail', 'url', 'path', 'icon'] as const) if (typeof r[k] === 'string' && (r[k] as string).trim()) item[k] = (r[k] as string).trim().slice(0, 2000);
  if (r.tone === 'attention' || r.tone === 'failed' || r.tone === 'done') item.tone = r.tone;
  if (typeof r.section === 'string' && r.section.trim()) item.section = r.section.trim().slice(0, 80);
  if (typeof r.trailing === 'string' && r.trailing.trim()) item.trailing = r.trailing.trim().slice(0, 24);
  return item;
}

// Takes a screenshot of the booted simulator into `file` (PNG). The real
// one runs simctl; tests pass their own.
export type Screenshot = (file: string) => Promise<void>;

export const simctlScreenshot: Screenshot = (file) =>
  new Promise((resolve, reject) => {
    execFile('xcrun', ['simctl', 'io', 'booted', 'screenshot', '--type=png', file], { timeout: 15_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve();
    });
  });

// An image panel's picture, drawn fresh each time it's asked for. The
// Simulator panel is the last screenshot of the booted device; with none
// booted there's only a note. The file is the same each time (one per
// thread and panel, under `dir`), so a thread never collects screenshots.
export async function renderPanel(panel: Panel, dir: string, screenshot: Screenshot = simctlScreenshot): Promise<PanelRender> {
  if (panel.kind !== 'image') return { note: 'This panel has nothing to render.' };
  if (panel.patch !== 'xcode') return { note: `No renderer for ${panel.patch} panels.` };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${panel.id}.png`);
  const tmp = `${file}.tmp`;
  try {
    await screenshot(tmp);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const message = String((e as Error)?.message ?? e);
    // simctl's wording when nothing is running.
    if (/no devices are booted|Unable to lookup in current state|booted/i.test(message)) {
      return { note: 'No simulator is booted. Build and run, or open Simulator.' };
    }
    return { note: `Couldn't take a screenshot: ${message.split('\n')[0]}` };
  }
  return { image: imageRefFor(file, 'image/png') };
}

// --------------------------------------------------------------- actions

export type CommandOutcome = { ok: boolean; exitCode?: number; text: string; truncated: boolean; durationMs: number };

// How long a command action may run. Long enough for a test suite, short
// enough that a dev server started by mistake doesn't hold on for ever.
export const ACTION_TIMEOUT_MS = 10 * 60_000;
// How long what a live command left running gets after SIGTERM before
// SIGKILL (runCommand's `killGroup`).
export const KILL_GRACE_MS = 2000;

// Runs a command action's command in the thread's folder through a login
// shell (so Mike's PATH, nvm and the like apply, as in a terminal), with the
// thread's own variables, and collects what it printed. Tests pass a plain
// shell and a short timeout.
export function runCommand(
  command: string,
  // `background`: builds and tests (a worktree's setup, turn hooks) run at
  // background priority (background.ts). Buttons Mike presses don't.
  // `killGroup`: when the shell exits (or times out), end what it left
  // running too: SIGTERM to its whole process group, then SIGKILL to
  // whatever's still there after `killGraceMs`, so a live command's `&`
  // can't outlive it (shell-allowlist.ts). A program that leaves the group
  // (setsid, setpgid, a daemon that forks away) isn't reached; none on the
  // live list does.
  opts: { cwd: string; env: Record<string, string | undefined>; shell?: string[]; timeoutMs?: number; background?: boolean; killGroup?: boolean; killGraceMs?: number },
): Promise<CommandOutcome> {
  const started = Date.now();
  const [shellBin, ...shellArgs] = opts.shell ?? loginShell();
  const [bin, args] = opts.background ? inBackground(shellBin, [...shellArgs, command]) : [shellBin, [...shellArgs, command]];
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    // A little past the limit is read, so the cut back to it can be placed
    // where no secret is split (safe-cut.ts): what's kept goes to Convex in a
    // hook's message.
    const limit = LIMITS.toolResultText + CUT_LOOKAHEAD;
    const take = (chunk: Buffer) => {
      if (size >= limit) {
        truncated = true;
        return;
      }
      const room = limit - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        truncated = true;
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    };
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ ok: false, text: String((e as Error).message ?? e), truncated: false, durationMs: Date.now() - started });
      return;
    }
    const timeoutMs = opts.timeoutMs ?? ACTION_TIMEOUT_MS;
    let timedOut = false;
    let ending = false;
    // SIGTERM to the group, then SIGKILL once the grace is up if any of it
    // is still there (checked as it goes, so a group that's gone isn't
    // signalled again).
    const endGroup = () => {
      if (ending) return;
      ending = true;
      const pgid = child.pid!;
      // A program that left the group can hold our pipes open for as long
      // as it lives, and the command's answer would wait on it.
      const letGo = () => {
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, 500).unref();
      };
      if (!killGroup(pgid, 'SIGTERM')) return letGo();
      const deadline = Date.now() + (opts.killGraceMs ?? KILL_GRACE_MS);
      const tick = setInterval(() => {
        const alive = groupAlive(pgid);
        if (alive && Date.now() < deadline) return;
        clearInterval(tick);
        if (alive) killGroup(pgid, 'SIGKILL');
        letGo();
      }, 50);
      tick.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (opts.killGroup) return endGroup();
      // The whole process group: a shell's children too.
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (code: number | null, error?: string) => {
      clearTimeout(timer);
      let text = Buffer.concat(chunks).toString('utf8');
      // Stopped reading part way: what was cut there was never seen whole.
      if (truncated) text = dropPartialEnd(text);
      if (Buffer.byteLength(text, 'utf8') > LIMITS.toolResultText) {
        truncated = true;
        const kept = Buffer.from(text, 'utf8').subarray(0, LIMITS.toolResultText).toString('utf8').replace(/\uFFFD$/, '');
        text = text.slice(0, safeEnd(text, kept.length));
      }
      if (error) text = text ? `${text}\n${error}` : error;
      if (timedOut) {
        const seconds = timeoutMs >= 10_000 ? String(Math.round(timeoutMs / 1000)) : String(timeoutMs / 1000);
        text = text.replace(/\n$/, '');
        text = `${text}${text ? '\n' : ''}Stopped after ${seconds} s.`;
      }
      resolve({
        ok: code === 0 && !timedOut && !error,
        exitCode: code ?? undefined,
        text,
        truncated,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (e) => finish(null, e.message));
    if (opts.killGroup) child.on('exit', endGroup);
    child.on('close', (code) => finish(code));
  });
}
