// A folder's Claude Code settings that run commands by themselves, or
// widen what the agent may do unasked (docs/protocol.md, "Trusting a
// folder's Claude Code hooks").
//
// The runner starts Claude with the folder's own settings
// (`.claude/settings.json` and `.claude/settings.local.json`), its
// `.mcp.json`, and its `.claude/agents`, `skills` and `commands`. In a
// terminal, Claude Code asks whether you trust a folder before any of that
// runs; the SDK never asks, so a cloned repo's SessionStart hook, status
// line, MCP server or a skill's own hooks would run as the thread's first
// turn started. This finds the parts that run a command, the env block
// (which can point Claude at another server), and, for a thread that asks
// before tools run, the parts that let tools run without asking; hashes
// them with the scripts they reach; and says what Claude should be started
// with while they aren't trusted: the folder's settings without any of it.
//
// Trust itself is kept with the patches' (patch-trust.ts), per folder,
// under the same folder key, so a worktree counts as its main checkout.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { followOptions } from './patch-trust.ts';
import type { PermissionMode } from './protocol.ts';
import { looksRunnable, reachOf, reachOfCommand, Reads } from './script-trust.ts';
import { allowCommand } from './shell-allowlist.ts';

// The id the folder's entry has in a thread's `patches`.
export const CLAUDE_PATCH_ID = 'claude-settings';

// Settings keys whose value is a command Claude Code runs by itself, from
// the SDK's Settings type (0.3.310). Left out: those Claude only reads
// from user or managed settings (processWrapper, policyHelper,
// sshHostCommands), and enabledPlugins, which only turns on plugins you
// installed yourself. extraKnownMarketplaces is in (a marketplace can be
// fetched by a command, or with a headersHelper), and so is its alias
// additionalMarketplaces.
export const COMMAND_KEYS = [
  'hooks',
  'statusLine',
  'subagentStatusLine',
  'fileSuggestion',
  'apiKeyHelper',
  'proxyAuthHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'extraKnownMarketplaces',
  'additionalMarketplaces',
] as const;

// Asked about with the commands, though nothing in it runs by itself:
// `env`, which Claude sets for the session and everything it starts. Any
// variable there can send Mike's prompts and login elsewhere
// (ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, HTTPS_PROXY,
// CLAUDE_CODE_USE_BEDROCK with its endpoint, OTEL_* exporters) or load
// code (NODE_OPTIONS, PATH), and new ones come with each release, so the
// whole block counts rather than a list of known ones.
export const ASK_KEYS = [...COMMAND_KEYS, 'env'] as const;

// What lets tools run without the approval card: `permissions` (allow
// rules, additionalDirectories, defaultMode and anything else in it but
// the rules that only narrow, below) and `sandbox` (turning it on lets
// sandboxed Bash run unasked, and its lists open the network and disk to
// it). They're asked about only for a thread that asks before tools run
// (Ask or Auto): in Full everything runs anyway, so a folder whose
// settings only grant asks nothing there (`grants` below). Claude applies
// allow rules before the runner's canUseTool, so from an untrusted repo
// they'd skip the card that Ask mode is for (Gautam's scan, 6 Nov: F2, F8,
// F15).
export const GRANT_KEYS = ['permissions', 'sandbox'] as const;

// The parts of `permissions` that only ever ask more or allow less, which
// count for nothing and stay in an untrusted folder's settings.
const NARROWING_PERMISSIONS = ['deny', 'ask', 'blockReadsOutsideWorkingDirectories', 'disableBypassPermissionsMode'];

// What an untrusted folder's settings may still set, as flag settings:
// only these keys come across, so a key that runs something or widens
// access (one added in a later CLI included) never does. Flag settings sit
// above project ones and Claude takes some keys from them that it ignores
// from a repo (processWrapper, autoMemoryDirectory, sandbox paths), which
// is why this is a list of what's kept rather than of what's dropped.
const UNTRUSTED_KEEP = [
  'model',
  'effortLevel',
  'alwaysThinkingEnabled',
  'outputStyle',
  'language',
  'attribution',
  'includeCoAuthoredBy',
  'includeGitInstructions',
  'respectGitignore',
  'cleanupPeriodDays',
  'enabledPlugins',
  'deniedMcpServers',
  'disabledMcpjsonServers',
  'claudeMdExcludes',
  'skillOverrides',
];

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

// Frontmatter keys of an agent, skill or command file (`.claude/agents`,
// `skills`, `commands`) that run something (hooks that fire while it's in
// use, an agent's own MCP servers), and ones that let tools run unasked
// (a skill's allowed-tools, an agent's permissionMode). By name with case,
// `-` and `_` left out, so every spelling counts.
const FRONTMATTER_RUNS = new Set(['hooks', 'mcpservers']);
const FRONTMATTER_GRANTS = new Set(['allowedtools', 'permissionmode']);

// Environment variables whose value is a file a shell or interpreter reads
// when it starts, wherever that is.
const STARTUP_VARS = new Set(['BASH_ENV', 'ENV', 'ZDOTDIR', 'PYTHONSTARTUP', 'NODE_REPL_EXTERNAL_MODULE']);

// At most this many files the parts reach are hashed; more can't be checked.
const MAX_NAMED = 300;
// At most this many folders are looked through for nested skills outside
// git; more can't be checked.
let MAX_WALK = 20_000;

// For tests, which can't make 20,000 folders quickly on a busy Mac.
export function setMaxWalkForTests(n: number): void {
  MAX_WALK = n;
}

export type ClaudeCommands = {
  // The files that have something that runs or grants (absolute), settings first.
  files: string[];
  // Files the commands reach, inside the repo (absolute), hashed too.
  named: string[];
  hash: string;
  // Each of those files by the hash of the bytes the hash was made from,
  // so an agent's edit can be matched to exactly what it wrote.
  read: Record<string, string>;
  // With `grants`: what they'd let run unasked, in words, for the prompt.
  grants?: string[];
  // Set when the hash can't cover what would run (a hook runs code it
  // can't follow): then no stored hash vouches for it, and it never loads.
  incomplete?: string;
};

export type ClaudeOptions = {
  // Whether the thread asks before tools run (Ask or Auto), so what lets
  // them run unasked counts too.
  grants?: boolean;
};

// A thread's options: grants count unless it's in Full. A thread switched
// out of Full gets a fresh CLI at its next message when its folder's
// grants aren't trusted (runner.deliver), as a mode change applies from
// the next turn.
export function claudeOptions(rec: { permissionMode: PermissionMode }): ClaudeOptions {
  return { grants: rec.permissionMode !== 'full' };
}

// What in `cwd`'s Claude Code settings runs a command (or, with `grants`,
// lets tools run unasked), or undefined when nothing does (no prompt,
// nothing changes). `home` bounds the search for `.mcp.json` and the
// `.claude` folders, which Claude reads from the folder and the ones above.
export function claudeCommands(cwd: string, home: string = os.homedir(), opts: ClaudeOptions = {}): ClaudeCommands | undefined {
  const dir = path.resolve(cwd);
  // In home, the folder's settings are Mike's own user settings.
  if (realpath(dir) === realpath(path.resolve(home))) return undefined;
  const grants = opts.grants === true;
  const parts: Record<string, unknown> = {};
  const files: string[] = [];
  const shas: Record<string, string> = {};
  const add = (file: string, found: Record<string, unknown> | undefined, sha: string) => {
    if (!found) return;
    parts[path.relative(dir, file)] = found;
    files.push(file);
    shas[file] = sha;
  };
  for (const rel of SETTINGS_FILES) {
    const file = path.join(dir, rel);
    const read = readJson(file);
    if (read === undefined) continue;
    // One Claude may read differently than JSON.parse (a comment, a stray
    // comma) is asked about whole: what it would run can't be told apart.
    add(file, read.ok ? commandParts(read.value, grants) : { unreadable: read.text }, read.sha256);
  }
  for (const file of mcpFiles(dir, home)) {
    const read = readJson(file);
    if (read === undefined) continue;
    add(file, read.ok ? mcpCommandParts(read.value) : { unreadable: read.text }, read.sha256);
  }
  let incomplete: string | undefined;
  const md = markdownFiles(dir, home);
  if (md.problem) incomplete = md.problem;
  for (const file of md.files) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    add(file, frontmatterParts(bytes.toString('utf8'), grants), sha256(bytes));
  }
  // Nothing found, unless the look for nested skills couldn't finish:
  // then what it missed can't be vouched for either.
  if (!files.length) return incomplete ? { files: [], named: [], hash: sha256(Buffer.from(incomplete)), read: {}, incomplete } : undefined;
  if (grants) incomplete ??= threadbearGrant(parts);
  const follow = reachedFiles(parts, dir, files);
  incomplete ??= follow.problem;
  // Relative to the folder, so a worktree and its main checkout agree.
  const real = realpath(dir);
  const lines = follow.files
    .map((f) => {
      const h = sha256(readOr(f));
      shas[shown(f, real, dir)] ??= h;
      // A path with a space, a newline, a quote or a backslash in it goes
      // in as JSON (starting with a quote, which a plain one can't), so
      // each line still reads only one way; plain ones as they always did.
      const rel = path.relative(real, f);
      return `${/^[^\s"\\]+$/.test(rel) ? rel : JSON.stringify(rel)} ${h}`;
    })
    .sort();
  // Joined with newlines, and still only one way to read it: stableJson
  // escapes every newline, and each line is a path with no space or
  // newline (or one as JSON), a space and 64 hex. (Patch trust's version 2
  // joined paths that could hold newlines, and was fooled: Gautam's scan,
  // 6 Nov. Moving this to its JSON form too would ask about every
  // folder's Claude settings again for nothing.)
  const hash = sha256(Buffer.from(['threadbear-claude-1', stableJson(parts), ...lines].join('\n')));
  const words = grants ? grantWords(parts) : [];
  return {
    files,
    named: follow.files.map((f) => shown(f, real, dir)),
    hash,
    read: shas,
    ...(words.length ? { grants: words } : {}),
    ...(incomplete ? { incomplete } : {}),
  };
}

// The folder's project and local settings merged, keeping only what can't
// run anything or widen access (UNTRUSTED_KEEP, and the narrowing parts of
// `permissions`): what Claude is given (as flag settings) while they
// aren't trusted, so deny rules, the model and the like still apply.
export function claudeSettingsWithoutCommands(cwd: string): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const rel of SETTINGS_FILES) {
    const read = readJson(path.join(path.resolve(cwd), rel));
    if (!read?.ok || !isObject(read.value)) continue;
    const rest: Record<string, unknown> = {};
    for (const k of UNTRUSTED_KEEP) if (Object.hasOwn(read.value, k)) rest[k] = read.value[k];
    const perms = read.value.permissions;
    if (isObject(perms)) {
      const kept: Record<string, unknown> = {};
      for (const k of NARROWING_PERMISSIONS) if (Object.hasOwn(perms, k)) kept[k] = perms[k];
      if (Object.keys(kept).length) rest.permissions = kept;
    }
    out = merge(out, rest);
  }
  return out;
}

// Whether `file` is one claudeCommands reads for `cwd`.
export function isClaudeSettingsFile(file: string, cwd: string, home: string = os.homedir()): boolean {
  const target = path.resolve(file);
  const dir = path.resolve(cwd);
  return SETTINGS_FILES.some((rel) => path.join(dir, rel) === target) || mcpFiles(dir, home).includes(target);
}

function commandParts(value: unknown, grants: boolean): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of ASK_KEYS) if (hasContent(value[k])) out[k] = value[k];
  if (grants) {
    const perms = value.permissions;
    if (isObject(perms)) {
      const wide = Object.fromEntries(Object.entries(perms).filter(([k]) => !NARROWING_PERMISSIONS.includes(k)));
      if (hasContent(wide)) out.permissions = wide;
    } else if (hasContent(perms)) out.permissions = perms;
    // Any sandbox setting, `enabled: false` included: turning off Mike's
    // own sandbox widens what his allow rules let run.
    if (value.sandbox !== undefined) out.sandbox = value.sandbox;
  }
  return Object.keys(out).length ? out : undefined;
}

// The servers in an .mcp.json that Claude starts as a local command, or
// fetches headers for with one.
function mcpCommandParts(value: unknown): Record<string, unknown> | undefined {
  const servers = isObject(value) && isObject(value.mcpServers) ? value.mcpServers : undefined;
  if (!servers) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    if (isObject(s) && (hasContent(s.command) || hasContent(s.headersHelper))) out[name] = s;
  }
  return Object.keys(out).length ? { mcpServers: out } : undefined;
}

// `.mcp.json` in the folder and each one above it, below home.
function mcpFiles(dir: string, home: string): string[] {
  return upToHome(dir, home)
    .map((d) => path.join(d, '.mcp.json'))
    .filter(isFile);
}

// The folder and each one above it, below home (or up to the root, for a
// folder outside home), as Claude looks for a project's files.
function upToHome(dir: string, home: string): string[] {
  const stop = path.resolve(home);
  const out: string[] = [];
  for (let d = dir; d !== stop && d !== path.dirname(d); d = path.dirname(d)) out.push(d);
  return out;
}

// The agent, skill and command files Claude loads for the folder: from
// `.claude/agents`, `skills` and `commands` in it and each folder above
// it below home (as the CLI does, 2.1.318), and from `.claude/skills` in
// any folder under it, which Claude picks up when the agent works on a
// file there. Under git, nested skills are what git lists (tracked or
// not ignored), as Claude skips ignored ones; elsewhere a walk, which
// can't vouch for a folder too big to walk.
function markdownFiles(dir: string, home: string): { files: string[]; problem?: string } {
  const out = new Set<string>();
  try {
    for (const d of upToHome(dir, home)) {
      for (const sub of ['agents', 'commands', 'skills']) {
        for (const f of sub === 'skills' ? skillFiles(path.join(d, '.claude', sub)) : walkMarkdown(path.join(d, '.claude', sub))) out.add(f);
      }
    }
  } catch (e) {
    if (!(e instanceof TooBig)) throw e;
    return { files: [...out].sort(), problem: `${e.message} has more than ${MAX_WALK} folders, too many to look through for agents, skills and commands Claude would load.` };
  }
  let nested: { files: string[]; problem?: string };
  try {
    nested = nestedSkills(dir);
  } catch (e) {
    if (!(e instanceof TooBig)) throw e;
    return { files: [...out].sort(), problem: `${e.message} has more than ${MAX_WALK} folders, too many to look through for skills Claude would load.` };
  }
  for (const f of nested.files) out.add(f);
  return { files: [...out].sort(), ...(nested.problem ? { problem: nested.problem } : {}) };
}

// Every .md file under `root`, bounded; nothing when it isn't a folder.
// More folders than the bound throws: what's past it can't be vouched for.
function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const queue = [root];
  for (let seen = 0; queue.length; seen++) {
    if (seen >= MAX_WALK) throw new TooBig(root);
    const d = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) queue.push(p);
      else if (e.name.toLowerCase().endsWith('.md') && isFile(p)) out.push(p);
    }
  }
  return out;
}

// Skill files under `dir` (not its own .claude, read above). Names are
// matched without case, as macOS finds `skill.md` for `SKILL.md`.
class TooBig extends Error {}

function nestedSkills(dir: string, depth = 0): { files: string[]; problem?: string } {
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  };
  const listed = git('ls-files', '-co', '--exclude-standard', '-z', '--', ':(glob,icase)**/.claude/skills/**/skill.md');
  if (listed !== undefined) {
    const files = listed.split('\0').filter(Boolean).map((f) => path.join(dir, f)).filter(isFile);
    // What git doesn't list inside: submodules, and repos of their own in
    // folders it doesn't track, which Claude still looks in.
    const inner = new Set<string>();
    // And links to folders, which Claude goes through and git doesn't.
    const links = new Set<string>();
    const staged = git('ls-files', '-s', '-z');
    const others = git('ls-files', '-o', '--exclude-standard', '-z');
    if (staged === undefined || others === undefined) return { files, problem: "git couldn't list the folder's files, so Threadbear can't tell which skills Claude would load." };
    for (const line of staged.split('\0')) {
      const m = /^(160000|120000) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(line);
      if (m) (m[1] === '160000' ? inner : links).add(path.join(dir, m[2]));
    }
    for (const f of others.split('\0')) {
      if (!f) continue;
      if (f.endsWith('/') && fs.existsSync(path.join(dir, f, '.git'))) inner.add(path.join(dir, f.slice(0, -1)));
      else if (isLink(path.join(dir, f))) links.add(path.join(dir, f));
    }
    for (const l of links) {
      if (!isLink(l) || !isDir(l)) continue;
      const sub = walkForSkills(l, true);
      files.push(...sub.files);
      if (sub.problem) return { files, problem: sub.problem };
    }
    for (const d of inner) {
      if (!isDir(d)) continue;
      if (depth >= 4 || inner.size > 200) return { files, problem: 'the folder has more nested repositories than Threadbear looks through for skills Claude would load.' };
      const sub = nestedSkills(d, depth + 1);
      files.push(...sub.files);
      if (sub.problem) return { files, problem: sub.problem };
      // A sub-repo's own top-level skills too, which the call above leaves to its caller.
      files.push(...skillFiles(path.join(d, '.claude', 'skills')));
    }
    return { files };
  }
  // Not a git checkout (or git failed): look through the folders.
  return walkForSkills(dir, false);
}

// The skill files in `.claude/skills` folders under `root` (its own too
// with `self`, or when it's a skills folder by a link), all but
// node_modules (left out, or every folder with packages in it would be too
// big to look through), following links to folders as Claude does.
function walkForSkills(root: string, self: boolean): { files: string[]; problem?: string } {
  const files: string[] = [];
  const base = path.basename(root).toLowerCase();
  if (self && base === 'skills' && path.basename(path.dirname(root)).toLowerCase() === '.claude') return { files: skillFiles(root) };
  if (self && base === '.claude') return { files: skillFiles(path.join(root, 'skills')) };
  const queue = [root];
  const seenDirs = new Set<string>();
  let seen = 0;
  while (queue.length) {
    if (++seen > MAX_WALK) return { files, problem: `the folder has more than ${MAX_WALK} folders, too many to look through for skills Claude would load.` };
    const d = queue.shift()!;
    const real = realpath(d);
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(p))) || e.name === '.git' || e.name === 'node_modules') continue;
      if (e.name.toLowerCase() === '.claude') {
        if (d !== root || self) files.push(...skillFiles(path.join(p, 'skills')));
      } else queue.push(p);
    }
  }
  return { files };
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function skillFiles(root: string): string[] {
  return walkMarkdown(root).filter((f) => path.basename(f).toLowerCase() === 'skill.md');
}

// The frontmatter keys of an agent, skill or command file that run
// something (always) or grant (with `grants`), each as its raw YAML: there
// is no YAML parser here, so a top-level key is a line at the left margin
// and its value the indented lines after it. Frontmatter in any other
// shape (a flow mapping, a quoted key, an anchor) can't be told apart and
// counts whole, as a settings file that isn't plain JSON does.
function frontmatterParts(text: string, grants: boolean): Record<string, unknown> | undefined {
  const yaml = frontmatter(text);
  if (yaml === undefined) return undefined;
  const blocks: [string, string][] = [];
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line) || /^[ \t]/.test(line)) {
      if (blocks.length) blocks[blocks.length - 1][1] += `\n${line}`;
      else if (line.trim() && !line.trim().startsWith('#')) return { unreadable: yaml };
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)[ \t]*:(?=[ \t]|$)/.exec(line);
    if (!m) return { unreadable: yaml };
    blocks.push([m[1], line]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, block] of blocks) {
    const name = key.toLowerCase().replace(/[-_]/g, '');
    if (FRONTMATTER_RUNS.has(name) || (grants && FRONTMATTER_GRANTS.has(name))) out[key] = out[key] === undefined ? block : `${out[key]}\n${block}`;
  }
  if (!Object.keys(out).length) return undefined;
  // An alias (`hooks: *x`) or a tag would take its value from elsewhere
  // in the frontmatter, past the block that's hashed: so it all counts.
  const property = (mark: string) => new RegExp(`(^[ \\t]*|:[ \\t]+|-[ \\t]+|[[{,][ \\t]*)[${mark}][^\\s[\\]{},]`, 'm');
  if (property('&*!').test(Object.values(out).join('\n')) || property('&').test(yaml)) return { unreadable: yaml };
  return { frontmatter: out };
}

// The text between a file's opening `---` and the next, or the rest of
// the file when there's no closing one. Leading blank lines and a BOM are
// let through: reading more as frontmatter than Claude does only asks more.
function frontmatter(text: string): string | undefined {
  const body = text.replace(/^\uFEFF/, '').trimStart();
  if (!/^---[ \t]*\r?\n/.test(body)) return undefined;
  const rest = body.replace(/^---[ \t]*\r?\n/, '');
  const end = /^---[ \t]*$/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

// The files the parts reach, hashed with them: every word in them that's
// a file in the repo, with or without a `/` (`node hook.mjs`, an MCP
// server's `"args": ["server.js"]`), and everything each command runs in
// turn, followed as patch trust follows a patch's commands
// (script-trust.ts). `problem` when one runs code that can't be followed
// (`python -m x`, a command in a variable), or names a folder in an
// environment variable (`PATH=./bin`): a stored hash can't vouch for what
// that would run.
function reachedFiles(parts: Record<string, unknown>, dir: string, sources: string[]): { files: string[]; problem?: string } {
  const reads = new Reads();
  const base = followOptions(dir, reads);
  // The repo's top bounds what's the repo's to change, and so hashed. An
  // .mcp.json or .claude folder above it (a thread in a submodule, the
  // outer repo's) is the outer repo's, and so is what it names.
  let top = base.top;
  for (const f of sources) {
    const theirs = followOptions(path.dirname(f)).top;
    if (isInside(top, theirs)) top = theirs;
  }
  let problem: string | undefined;
  // An import without its extension, or of a folder, that more than one
  // file could answer (helper.ts and helper.js, a folder's package.json
  // main and its index.js): the hash could cover a different one than
  // Node or Bun loads.
  const resolveImport = (from: string, spec: string) => {
    const want = path.resolve(from, spec.replace(/[?#].*$/, ''));
    if (/^\.{0,2}\//.test(spec) && !isFile(want)) {
      const could = [...['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.json', '.node'].map((e) => want + e), ...['.ts', '.js', '.mjs', '.cjs', '.json', '.node'].map((e) => path.join(want, `index${e}`)), path.join(want, 'package.json')].filter(isFile);
      if (could.length > 1 || could.some((f) => path.basename(f) === 'package.json')) problem ??= `${path.relative(base.folder, from) || '.'} imports ${spec}, which ${could.length} files could answer (${could.map((f) => path.basename(f)).join(', ')}), so Threadbear can't tell which one runs. Import it with its extension.`;
    }
    return base.resolveImport(from, spec);
  };
  const opts = { ...base, top, resolveImport, strict: true };
  const real = opts.folder;
  const out = new Set<string>();
  const vars = { CLAUDE_PROJECT_DIR: real };
  const take = (files: string[], why?: string, label?: string) => {
    for (const f of files) if (isInside(f, opts.top)) out.add(f);
    if (why) problem ??= `${label ? `${label} ` : ''}${why}`;
  };
  // Each held to the short list of shell (shell-allowlist.ts), as a live
  // patch command is, and followed by the pattern follower too for the
  // files it reaches: both must pass.
  const command = (cmd: string, label: string) => {
    const shown = `\`${cmd.length > 120 ? `${cmd.slice(0, 120)}...` : cmd}\``;
    const a = allowCommand(cmd, label, opts, vars);
    const r = reachOfCommand(cmd, label, opts, vars);
    const why = a.problem ?? r.problem;
    take([...a.files, ...r.files], why && (why.startsWith(label) ? `${label} (${shown})${why.slice(label.length)}` : `${label} (${shown}) ${why}`));
  };
  const word = (raw: string, inEnv: boolean) => {
    if (!raw || raw.startsWith('~')) return;
    const target = path.resolve(real, raw.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, real));
    // A file an env variable names (BASH_ENV, NODE_OPTIONS=--require) is
    // loaded by whatever reads the variable, from wherever that runs, with
    // its own relative paths from there: Threadbear can't follow it. So
    // one in the repo, or named by a relative path (it may be one from
    // another folder), can't be trusted. URLs and paths outside are fine.
    if (inEnv && !raw.includes('://')) {
      const pathish = /^\.{1,2}(\/|$)/.test(raw) || raw.includes('/');
      const mine = target === opts.top || isInside(target, opts.top);
      if ((pathish && !path.isAbsolute(raw) && !raw.startsWith('$')) || (mine && fs.existsSync(target))) {
        problem ??= `an environment variable names \`${raw}\`, a file or folder in the repo (or by a relative path), which whatever reads the variable loads from wherever it runs, so Threadbear can't follow it.`;
        if (mine && isFile(target)) out.add(realpath(target));
        return;
      }
    }
    if (isDir(target)) {
      // `.` counts: PYTHONPATH=. loads from the folder itself.
      if (target !== opts.top && !isInside(target, opts.top)) return;
      if (inEnv) problem ??= `an environment variable names the folder \`${raw}\`, and Threadbear can't hash everything a folder could load.`;
      return;
    }
    if (!isInside(target, opts.top) || !isFile(target)) return;
    const t = realpath(target);
    out.add(t);
    if (looksRunnable(t)) {
      // By the path as named, as a shell's $0 is (script-trust.ts).
      const r = reachOf(target, opts);
      take(r.files, r.problem, path.relative(real, t));
    }
  };
  const words = (s: string, inEnv: boolean) => {
    const text = s.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, real);
    // An env value is a path whole, spaces and all (BASH_ENV="./start up"),
    // or a list of them (PATH-like), as well as words. One that names
    // another variable (bash expands BASH_ENV's) can't be told.
    if (inEnv) {
      // Node told to keep symlinked paths loads other files than are hashed.
      if (/--preserve-symlinks/.test(text)) problem ??= `an environment variable sets --preserve-symlinks, which changes which files Node loads.`;
      if (/[$`]/.test(text.replace(/\$\{?PWD\}?/g, ''))) problem ??= `an environment variable's value uses a variable or command (\`${text.length > 80 ? `${text.slice(0, 80)}...` : text}\`), so Threadbear can't tell what it names.`;
      for (const p of [text, ...text.split(':')]) {
        const v = p.replace(/\$\{?PWD\}?/g, real);
        // As written (a name can end in a space) and trimmed.
        word(v, inEnv);
        word(v.trim(), inEnv);
      }
    }
    for (const raw of text.split(/[\s'"`;&|()<>=,:[\]{}]+/)) word(raw, inEnv);
  };

  for (const [rel, part] of Object.entries(parts)) {
    if (!isObject(part)) continue;
    // Every string, for the files it names.
    walkStrings(part, (s, keys) => {
      words(s, keys.includes('env'));
      // A shell's startup file, read relative to wherever the shell starts.
      const name = keys[keys.length - 1];
      if (keys.includes('env') && STARTUP_VARS.has(name) && !path.isAbsolute(s.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, real))) problem ??= `${rel} sets ${name} to \`${s}\`, a file a shell reads from wherever it starts, so Threadbear can't tell which one it is.`;
    });
    // Commands Claude runs by themselves, followed through what they run.
    walkStrings(part, (s, keys) => {
      const key = keys[keys.length - 1];
      const top = keys[0];
      if (key === 'command' && keys.includes('hooks')) command(s, `A hook in ${rel}`);
      else if (key === 'command' && (top === 'statusLine' || top === 'subagentStatusLine' || top === 'fileSuggestion')) command(s, `${top} in ${rel}`);
      else if (keys.length === 1 && COMMAND_KEYS.includes(top as (typeof COMMAND_KEYS)[number]) && top.match(/Helper|Export|Refresh/)) command(s, `${top} in ${rel}`);
      else if (key === 'headersHelper') command(s, `A headersHelper in ${rel}`);
    });
    if (isObject(part.mcpServers)) {
      for (const [name, s] of Object.entries(part.mcpServers)) {
        if (!isObject(s) || typeof s.command !== 'string') continue;
        const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [];
        // Its files are followed from the folder; one that starts somewhere
        // else would load others of the same names.
        if (s.cwd !== undefined) problem ??= `MCP server ${name} in ${rel} sets its own cwd, so Threadbear can't tell which files its command and args name.`;
        command([s.command, ...args].map(shellQuote).join(' '), `MCP server ${name} in ${rel}`);
      }
    }
    if (isObject(part.frontmatter)) {
      for (const [key, block] of Object.entries(part.frontmatter)) {
        const name = key.toLowerCase().replace(/[-_]/g, '');
        if (typeof block !== 'string' || !FRONTMATTER_RUNS.has(name)) continue;
        // An MCP server's command runs with its args, not through a shell.
        const cmds = name === 'mcpservers' ? yamlServers(block) : yamlCommands(block);
        if (name === 'mcpservers' && /^\s*cwd\s*:/m.test(block)) problem ??= `${rel} has an MCP server that sets its own cwd, so Threadbear can't tell which files its command and args name.`;
        if (!cmds) problem ??= `${rel} has ${key} whose commands Threadbear can't read: write each as \`command: ...\` on its own line${name === 'mcpservers' ? ', and its args as a plain list' : ''}.`;
        for (const c of cmds ?? []) command(c, `A ${key} command in ${rel}`);
        // An MCP server's env, as a settings file's.
        if (name === 'mcpservers') {
          for (const [k, v] of yamlEnvBlocks(block)) {
            words(v, true);
            if (STARTUP_VARS.has(k) && !path.isAbsolute(v.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, real))) problem ??= `${rel} sets ${k} to \`${v}\`, a file a shell reads from wherever it starts, so Threadbear can't tell which one it is.`;
          }
        }
      }
    }
    if (part.unreadable !== undefined) {
      words(String(part.unreadable), true);
      // A file that can't be read key by key: what it would run can't be
      // followed (and YAML can spell a key with escapes), so it can't be
      // trusted as it is.
      problem ??= rel.toLowerCase().endsWith('.md')
        ? `${rel} has frontmatter Threadbear can't read key by key (a flow mapping, a quoted key, an anchor or alias). Write it as plain YAML, one key to a line.`
        : `${rel} isn't plain JSON, so Threadbear can't tell what it would run.`;
    }
    if (out.size > MAX_NAMED) return { files: [...out], problem: `its commands reach more than ${MAX_NAMED} files, more than Threadbear hashes.` };
  }
  return { files: [...out].sort(), ...(problem ? { problem } : {}) };
}

// The `command:` values in a frontmatter block (hooks, or an agent's MCP
// servers), as YAML would read them: plain, quoted, or a `|`/`>` block.
// Undefined when the block names a command some other way (flow style, a
// quoted key), which can't be read here.
// Whether a frontmatter block is YAML in the one shape read here, where a
// line-by-line reading can't differ from a YAML parser's: block mappings
// and sequences, each nested deeper than its key (no indentless lists),
// and values that are plain one-line scalars or one-line lists of them.
// No quotes, escapes, block scalars, flow mappings, anchors, tags,
// comments or values carried onto the next line.
function plainYaml(block: string): boolean {
  // Quotes with nothing to unescape read as what's between them.
  const plain = (v: string) => /^"[^"\\]*"$|^'[^']*'$/.test(v) || (v !== '' && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v) && !/: |:$| #|\t/.test(v));
  const list = (v: string) => /^\[[^[\]{}]*\]$/.test(v) && v.slice(1, -1).split(',').every((x) => x.trim() === '' || plain(x.trim()));
  const lines = block.split(/\r?\n/);
  // The column the next line's content must be past (an opened key), or
  // not past (after a scalar).
  let opened: number | undefined;
  let closed: number | undefined;
  for (const l of lines) {
    if (l.trim() === '') continue;
    if (/\t/.test(l.slice(0, l.search(/\S/) + 1))) return false;
    const ind = l.search(/\S/);
    if (opened !== undefined && ind <= opened) return false;
    if (closed !== undefined && ind > closed) return false;
    const m = /^(\s*)(- +)?(?:([A-Za-z_][\w-]*):(?: +(.*))?|(.*))$/.exec(l)!;
    const dash = m[2] !== undefined;
    const keyCol = m[1].length + (m[2]?.length ?? 0);
    if (m[3] !== undefined) {
      const v = m[4];
      if (v === undefined || v === '') {
        opened = keyCol;
        closed = undefined;
      } else {
        if (!plain(v) && !list(v)) return false;
        opened = undefined;
        closed = keyCol;
      }
    } else {
      // A bare sequence item.
      if (!dash || !plain(m[5]!)) return false;
      opened = undefined;
      closed = m[1].length;
    }
  }
  return opened === undefined;
}

function yamlCommands(block: string): string[] | undefined {
  if (!plainYaml(block)) return undefined;
  // A quoted key (`"comm\u0061nd":` is `command:` to YAML) or an explicit
  // one (`? command`) can't be read line by line.
  if (/(^|[\s{,-])(["'][^"'\n]*["']|\?)[ \t]*:|(^|[\s{,-])\?[ \t]/m.test(block)) return undefined;
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)command[ \t]*:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    found++;
    // The lines after it that are indented past the key go with its value
    // (a block scalar's body, or a plain scalar carried on).
    const indent = m[1].length;
    const more: string[] = [];
    let end = i + 1;
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j++) if (lines[j].trim() !== '') end = j + 1;
    for (let j = i + 1; j < end; j++) more.push(lines[j].trim());
    let v = m[2].trim();
    if (v.startsWith('"')) {
      // On one line, as JSON reads it; YAML's own escapes or a line break
      // inside can't be read here.
      const q = /^"((?:[^"\\]|\\.)*)"/.exec(v);
      if (!q || more.some((l) => l !== '') || /[^ \t]/.test(v.slice(q[0].length).replace(/^[ \t]+#.*$/, ''))) return undefined;
      try {
        v = JSON.parse(q[0]);
      } catch {
        return undefined;
      }
    } else if (v.startsWith("'")) {
      const q = /^'((?:[^']|'')*)'/.exec(v);
      if (!q || more.some((l) => l !== '') || /[^ \t]/.test(v.slice(q[0].length).replace(/^[ \t]+#.*$/, ''))) return undefined;
      v = q[1].replace(/''/g, "'");
    } else {
      // A comment starts at a # after a space (found without a regex that
      // backtracks over a long run of spaces).
      const at = v.search(/[ \t]#/);
      if (at >= 0) v = v.slice(0, at).trim();
      if (/^[[{&*!]/.test(v)) return undefined;
      // Read only where YAML's folding can't differ from a plain join: a
      // `>` block or a plain scalar over lines all indented alike, with no
      // blank line (each of which keeps a line break, as a more indented
      // line does in `>`). A `|` block keeps its lines.
      const raw = lines.slice(i + 1, i + 1 + more.length);
      const alike = raw.every((l) => l.trim() !== '') && new Set(raw.map((l) => l.search(/\S/))).size <= 1;
      if (/^[|>][-+0-9]*$/.test(v)) {
        if (v.startsWith('>') && !alike) return undefined;
        // Each line less the block's indent, its trailing spaces kept (a
        // `\ ` at the end of a line isn't a line continuation).
        const cut = Math.min(...raw.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
        v = raw.map((l) => (l.trim() === '' ? '' : l.slice(cut))).join(v.startsWith('|') ? '\n' : ' ');
      } else if (more.some((l) => l !== '')) {
        if (!alike) return undefined;
        v = [v, ...more].join(' ');
      }
    }
    out.push(v);
  }
  // Any other mention of a command (`{command: x}`, `"command":`) can't
  // be read line by line.
  if ((block.match(/(^|[\s{,"'-])command["']?[ \t]*:/gm) ?? []).length !== found) return undefined;
  return out;
}

// The command lines of the MCP servers in a frontmatter block: each
// `command:` with the `args:` beside it (a one-line `[a, b]` list or `- a`
// lines), as a shell would be handed them. Undefined when either can't be
// read line by line.
function yamlServers(block: string): string[] | undefined {
  const cmds = yamlCommands(block);
  if (!cmds) return undefined;
  const lines = block.split(/\r?\n/);
  const indent = (l: string) => l.search(/\S/);
  const item = (l: string) => /^\s*-[ \t]+\S/.test(l);
  // Where a line's key starts: after a `- `, or its indent.
  const keyCol = (l: string) => {
    const m = /^(\s*-[ \t]+)/.exec(l);
    return m ? m[1].length : indent(l);
  };
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:-\s+)?command[ \t]*:/.test(lines[i])) continue;
    const col = keyCol(lines[i]);
    // The server's mapping: the keys at the same column around it.
    let first = i;
    if (!item(lines[i])) {
      for (let j = i - 1; j >= 0; j--) {
        const l = lines[j];
        if (l.trim() === '' || indent(l) > col) continue;
        if (keyCol(l) !== col) break;
        first = j;
        if (item(l)) break;
      }
    }
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || indent(l) > col) continue;
      if (keyCol(l) !== col || item(l)) break;
      last = j;
    }
    let args: string[] = [];
    for (let j = first; j <= last; j++) {
      if (keyCol(lines[j]) !== col) continue;
      const a = /^\s*(?:-\s+)?args[ \t]*:[ \t]*(.*)$/.exec(lines[j]);
      if (!a) continue;
      const v = a[1].replace(/[ \t]#.*$/, '').trim();
      if (v.startsWith('[')) {
        if (!/^\[[^[\]{}"'\\]*\]$/.test(v)) return undefined;
        args = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
      } else if (v === '') {
        args = [];
        for (let k = j + 1; k < lines.length && (lines[k].trim() === '' || indent(lines[k]) > col); k++) {
          if (lines[k].trim() === '') continue;
          const it = /^\s*-[ \t]+(.*)$/.exec(lines[k]);
          if (!it || /^["'\\[{&*!|>]/.test(it[1]) || /[ \t]#/.test(it[1])) return undefined;
          args.push(it[1].trim());
        }
      } else return undefined;
    }
    out.push([cmds[n++], ...args].map(shellQuote).join(' '));
  }
  return out;
}

// The `env:` entries under a frontmatter block's MCP servers, as name and value.
function yamlEnvBlocks(block: string): [string, string][] {
  const lines = block.split(/\r?\n/);
  const out: [string, string][] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)env[ \t]*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim()) out.push(['', m[2].trim()]);
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) {
      const kv = /^\s*([\w.-]+)[ \t]*:[ \t]*(.*)$/.exec(lines[j]);
      if (kv) out.push([kv[1], kv[2].trim().replace(/^"([^"\\]*)"$|^'([^']*)'$/, '$1$2')]);
      else if (lines[j].trim()) out.push(['', lines[j].trim()]);
    }
  }
  return out;
}

// An allow rule (or a skill's allowed-tools) that would cover Threadbear's
// own tools: a folder never gets to approve those (a repo allowing
// update_thread would let the agent switch its own thread to Full), so
// no stored hash can vouch for one.
function threadbearGrant(parts: Record<string, unknown>): string | undefined {
  const covers = (rule: string) => /^\s*(mcp__threadbear|mcp__threadbare|mcp__\*|\*)/i.test(rule);
  for (const [rel, part] of Object.entries(parts)) {
    if (!isObject(part)) continue;
    const allow = isObject(part.permissions) ? part.permissions.allow : undefined;
    const rule = Array.isArray(allow) ? allow.find((r) => typeof r === 'string' && covers(r)) : undefined;
    if (rule) return `${rel} allows ${rule}, and only Threadbear's own approvals can allow its tools. Take the rule out.`;
    // Bypassing permissions covers every tool, Threadbear's included.
    if (isObject(part.permissions) && part.permissions.defaultMode === 'bypassPermissions') return `${rel} starts Claude bypassing permissions, which would cover Threadbear's own tools, and only Threadbear's own approvals can allow those.`;
    if (isObject(part.frontmatter)) {
      for (const [key, block] of Object.entries(part.frontmatter)) {
        if (typeof block !== 'string' || !FRONTMATTER_GRANTS.has(key.toLowerCase().replace(/[-_]/g, ''))) continue;
        const value = block.replace(/^[^:]*:/, '');
        // YAML can spell a name with escapes (`\u0062`), which isn't read here.
        if (value.includes('\\')) return `${rel} has ${key} with an escape in it, which Threadbear can't read to check it doesn't cover its own tools. Write the tools out plainly.`;
        const tools = value.split(/[\s,[\]'"]+/).filter(Boolean);
        if (key.toLowerCase().replace(/[-_]/g, '') === 'permissionmode' && tools.some((t) => /bypass/i.test(t))) return `${rel} runs bypassing permissions, which would cover Threadbear's own tools, and only Threadbear's own approvals can allow those.`;
        if (tools.some((t) => covers(t))) return `${rel} lets ${key} cover Threadbear's own tools, and only Threadbear's own approvals can allow them. Take them out.`;
      }
    }
  }
  return undefined;
}

// What the grants in the parts would let run unasked, in words.
function grantWords(parts: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [rel, part] of Object.entries(parts)) {
    if (!isObject(part)) continue;
    const perms = part.permissions;
    if (isObject(perms)) {
      for (const [k, v] of Object.entries(perms)) {
        const list = Array.isArray(v) ? v.map(String) : [String(typeof v === 'object' ? JSON.stringify(v) : v)];
        if (k === 'allow') out.push(...list.map((r) => `Allows ${r} without asking (${rel})`));
        else if (k === 'additionalDirectories') out.push(...list.map((d) => `Opens ${d} to the agent (${rel})`));
        else if (k === 'defaultMode') out.push(`Starts in ${list[0]} mode (${rel})`);
        else out.push(`Sets permissions.${k} (${rel})`);
      }
    } else if (part.permissions !== undefined) out.push(`Sets permissions (${rel})`);
    if (part.sandbox !== undefined) out.push(`Changes the sandbox, which can let Bash run without asking (${rel})`);
    if (isObject(part.frontmatter)) {
      for (const [key, block] of Object.entries(part.frontmatter)) {
        const name = key.toLowerCase().replace(/[-_]/g, '');
        if (!FRONTMATTER_GRANTS.has(name) || typeof block !== 'string') continue;
        const value = block.replace(/^[^:]*:/, '').replace(/\s+/g, ' ').trim();
        out.push(name === 'permissionmode' ? `Runs in ${value} mode (${rel})` : `Allows ${value} without asking while it's in use (${rel})`);
      }
    }
  }
  return out;
}

// Calls `fn` with every string in `v` and the keys on the way to it.
function walkStrings(v: unknown, fn: (s: string, keys: string[]) => void, keys: string[] = []): void {
  if (typeof v === 'string') fn(v, keys);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn, keys));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) walkStrings(x, fn, [...keys, k]);
}

function shellQuote(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

// A real path as the folder spells it (relative to the folder's real path,
// put back on the folder as named), so paths agree with what an agent's
// edit reports.
function shown(file: string, real: string, dir: string): string {
  return path.resolve(dir, path.relative(real, file));
}

// Every path a Claude Code settings file's commands name (hooks, a status
// line, a key helper and the rest): absolute, from `~`, `$HOME`,
// `$CLAUDE_CONFIG_DIR` (`dir`) or `$CLAUDE_PROJECT_DIR` (`cwd`), or
// relative to `dir` and to `cwd`, the session's folder, where hooks run;
// there or not. They
// run unasked in every session on that login, so an edit of one outside
// Full access asks (code-writes.ts). A file that isn't plain JSON names
// nothing it can tell, so its own name (code-writes.ts) is what's guarded.
// Every string in a settings file's parts that run something: the
// commands, for code-writes to follow as a shell would (commandFiles).
export function settingsCommands(file: string): string[] {
  const read = readJson(file);
  if (!read?.ok) return [];
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  walk(commandParts(read.value, false));
  return strings.slice(0, MAX_NAMED);
}

export function settingsNamedPaths(file: string, dir: string, home: string = os.homedir(), cwd?: string): string[] {
  const read = readJson(file);
  if (!read?.ok) return [];
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  walk(commandParts(read.value, false));
  const out = new Set<string>();
  for (const s of strings) {
    let text = s.replace(/\$\{?CLAUDE_CONFIG_DIR\}?/g, dir).replace(/\$\{?HOME\}?/g, home);
    if (cwd) text = text.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, cwd);
    // Quotes out first: `"$CLAUDE_PROJECT_DIR"/x.sh` is one path.
    for (const raw of text.replace(/["'`]/g, '').split(/[\s;&|()<>=]+/)) {
      if (!raw.includes('/') || raw.includes('$')) continue;
      if (raw.startsWith('~/')) out.add(path.join(home, raw.slice(2)));
      else {
        out.add(path.resolve(dir, raw));
        // A hook runs in the session's folder, so `./x.sh` is there too.
        if (cwd && !path.isAbsolute(raw)) out.add(path.resolve(cwd, raw));
      }
      if (out.size >= MAX_NAMED) return [...out];
    }
  }
  return [...out];
}

function readJson(file: string): { ok: true; value: unknown; sha256: string } | { ok: false; text: string; sha256: string } | undefined {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  const text = bytes.toString('utf8');
  try {
    return { ok: true, value: JSON.parse(text), sha256: sha256(bytes) };
  } catch {
    return text.trim() ? { ok: false, text, sha256: sha256(bytes) } : undefined;
  }
}

// Objects merge key by key, lists join (Claude's own merge of permission
// rules across settings files), anything else the later wins.
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const was = out[k];
    if (isObject(was) && isObject(v)) out[k] = merge(was, v);
    else if (Array.isArray(was) && Array.isArray(v)) out[k] = [...was, ...v.filter((x) => !was.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
    else out[k] = v;
  }
  return out;
}

function hasContent(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === '') return false;
  if (Array.isArray(v)) return v.some(hasContent);
  if (isObject(v)) return Object.values(v).some(hasContent);
  return true;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Strictly inside: `..hook.sh` is a file in it, `../x` isn't.
function isInside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function readOr(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch {
    return Buffer.from('missing');
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
