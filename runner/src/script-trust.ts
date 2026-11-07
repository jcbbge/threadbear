// What a script a patch names runs in turn, so patch trust can hash it
// (docs/protocol.md, "Trusting a folder's patches").
//
// Hashing only the script a patch names left a hole: a trusted
// `./setup.sh` that runs `./helper.sh` ran a changed helper with nobody
// asked (Daybreak verify-fix, 5 Nov). So from each script a patch names,
// this follows every local file it can run or read, the way a shell, Node
// and npm would find them, and hands back the lot to hash. When a script
// runs something it can't follow (eval, `sh -c "$x"`, `curl | sh`, a
// command in a variable), it says so in `problem`, and a command that runs
// by itself refuses that script (automaticCommand): the hash can't vouch
// for what it'd run.
//
// Followed:
//   - shell scripts (by extension or #!): every command they run, read with
//     a small shell lexer. A path to a file (`./helper.sh`,
//     `"$(dirname "$0")/x.sh"`, `${0%/*}/x`), `source`/`.`, `sh`/`bash`/`zsh`
//     with a file or a literal `-c`, `node`/`bun`/`deno`/`tsx` with a file,
//     `npm`/`pnpm`/`yarn`/`bun` scripts by a literal name (package.json and
//     the script's own command), installs (their lifecycle scripts), `npx`
//     (package.json), `make` (the Makefile's recipes), and what `env`,
//     `exec`, `nice`, `xargs`, `find -exec` and the like run. A `cd` to a
//     path it can work out is followed, so relative paths after it resolve.
//   - JavaScript and TypeScript: imports (scanModule), and any string in
//     them that's the path of a file in the repo.
//   - Any file a script names (an argument, `$(cat x)`, a `./` path in its
//     text) is hashed if it's code (looksRunnable), and followed if it's a
//     script. A data file it only names or reads isn't: trusting the
//     script trusts what it does with its data.
//
// Not followed: programs on PATH and packages, as installed. What one of
// those loads from the repo by its own rules (a test runner's tests, a
// build's config) is past this, as node_modules is for patch files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { bareImport, inNodeModules, linkedPackages, packageFiles } from './tracked-packages.ts';

// `outside`: with FollowOptions.outside, the scripts it runs or loads that
// aren't the repo's, which a schedule's check binds too (patch-trust.ts).
// Each with the folders it runs from, as its own relative paths are those.
export type ScriptReach = { files: string[]; missing: string[]; problem?: string; outside?: { file: string; dirs: string[] }[] };

// The most of one file patch trust reads (a patch, a helper, a script, a
// config file); it reads one bigger than this not at all, and fails closed.
export const MAX_READ_BYTES = 32 * 1024 * 1024;

// One look at the files a hash is made from: each read once, the bytes
// kept, so what was scanned for what it runs is what's hashed (and, for a
// patch's own code, what's imported). `prints` is each file's stat taken
// before its read, and `links` each path as it was named with the real
// path it led to then, so a cached hash can tell a file was changed (a
// write moves ctime, which can't be set back; a replace moves the inode)
// or a symlink on the way to it retargeted.
export class Reads {
  readonly prints = new Map<string, string>();
  readonly bytes = new Map<string, Buffer>();
  readonly links = new Map<string, string>();
  // What a config file (an .npmrc, a Makefile) was read as, by kind and
  // real path: every one of a patch's up to 2000 strings is followed as a
  // command, each by a Reach of its own, and each read them again.
  readonly parsed = new Map<string, unknown>();

  // `p`'s real path, recorded; undefined when it isn't there.
  real(p: string): string | undefined {
    let r: string | undefined;
    try {
      r = fs.realpathSync(p);
    } catch {
      r = undefined;
    }
    this.links.set(p, r ?? '');
    return r;
  }

  // A file's bytes as text, decoded once: each of a patch's commands is
  // followed by a Reach of its own, and each read the same files again.
  readonly texts = new Map<string, string>();
  text(real: string): string | undefined {
    const hit = this.texts.get(real);
    if (hit !== undefined) return hit;
    const b = this.read(real);
    if (!b) return undefined;
    const t = b.toString('utf8');
    this.texts.set(real, t);
    return t;
  }

  // A file the hash depends on without reading it (git's index, which says
  // what the repo tracks under node_modules: tracked-packages.ts), so a
  // cached hash looks again once it changes.
  watch(p: string): void {
    try {
      this.prints.set(p, fingerprint(p));
    } catch {
      this.links.set(p, '');
    }
  }

  // Files over MAX_READ_BYTES, not read: a hash that needed one can't
  // be made (patchHash), so nothing that reaches one can be trusted.
  readonly tooBig = new Set<string>();

  // A file's bytes (by real path), read once.
  read(real: string): Buffer | undefined {
    const hit = this.bytes.get(real);
    if (hit) return hit;
    let print: string;
    let b: Buffer;
    try {
      print = fingerprint(real);
      if (fs.statSync(real).size > MAX_READ_BYTES) {
        this.tooBig.add(real);
        return undefined;
      }
      b = fs.readFileSync(real);
    } catch {
      return undefined;
    }
    this.prints.set(real, print);
    this.bytes.set(real, b);
    return b;
  }

  // Whether everything looked at is as it was: no file changed, no link
  // retargeted, nothing that was missing turned up.
  same(): boolean {
    for (const [p, print] of this.prints) {
      try {
        if (fingerprint(p) !== print) return false;
      } catch {
        return false;
      }
    }
    for (const [p, real] of this.links) {
      let now = '';
      try {
        now = fs.realpathSync(p);
      } catch {
        // missing
      }
      if (now !== real) return false;
    }
    return true;
  }
}

// What changes when a file's content can have: its inode (a replace), size,
// mtime, and ctime, which every write and chmod moves and nothing can set
// back (utimes moves it too).
export function fingerprint(p: string): string {
  const st = fs.statSync(p);
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
}

export type FollowOptions = {
  folder: string; // where the command starts: the folder holding .threadbear/
  top: string; // the repo's top; only files inside it are the repo's to change
  home?: string;
  // From patch-trust.ts, passed in so the two don't import each other.
  // `packages`: its bare imports, followed when the repo commits them
  // (tracked-packages.ts).
  scanJs: (src: string, file: string) => { specifiers: string[]; packages?: string[]; strings: string[]; problem?: string };
  resolveImport: (dir: string, spec: string) => string;
  namedPaths: (src: string) => string[];
  // Shared with the caller's hash, so it hashes the bytes followed here.
  reads?: Reads;
  // For a Claude Code hook, which runs by itself (claude-trust.ts): what
  // patch trust lets through as installed code is a problem instead. A
  // package run by name (`npx x`, `pnpm dlx x`: whatever the name resolves
  // to then, the registry's latest or a bin of the repo's own), a test
  // runner finding its own tests (`node --test`, `bun test`), and, as the
  // command itself, a program on PATH that isn't one known to load nothing
  // from the folder (a formatter, a test runner or a build tool loads its
  // config and plugins from there by its own rules).
  strict?: boolean;
  // Note the scripts it reaches outside the repo (ScriptReach.outside),
  // which are nobody's to change but yours and otherwise aren't looked at:
  // a schedule's check runs them unattended, by a path as often as not.
  outside?: boolean;
};

// Bounds: a script reaching more than this can't be checked.
export const MAX_SCRIPT_FILES = 300;
const MAX_DEPTH = 12;
const MAX_VISITS = 600;

const SHELL_EXT = ['.sh', '.bash', '.zsh', '.ksh', '.command'];
const JS_EXT = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];
const JS_RUNNERS = ['node', 'tsx', 'ts-node', 'bun', 'deno'];
// Languages whose loads this can't follow: running a file or code in one
// fails closed.
const OTHER_LANGS = /^(python[0-9.]*|ruby|perl|php|lua|osascript|pwsh|powershell|fish|csh|tcsh|Rscript|expect|tclsh|uv|uvx|poetry|pipenv|rake|bundle|parallel)$/;
// Shell words that run their argument as code, or change what a command
// name means, which can't be followed.
const UNFOLLOWABLE: Record<string, string> = {
  eval: 'runs text worked out as it runs (`eval`)',
  alias: 'defines an alias, which changes what a command name runs',
  autoload: 'autoloads functions from other files',
  enable: 'loads builtins from a file (`enable`)',
  coproc: 'starts a coprocess',
  fc: 'runs commands from history (`fc`)',
};
// Environment that makes a shell, Node or the loader run other code.
export const RISKY_ENV = new Set([
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT',
  'PERL5LIB', 'PROMPT_COMMAND', 'npm_config_script_shell', 'NPM_CONFIG_SCRIPT_SHELL', 'npm_config_node_options',
  'NPM_CONFIG_NODE_OPTIONS', 'BUN_OPTIONS', 'GIT_EXEC_PATH', 'SHELLOPTS', 'BASHOPTS', 'FPATH', 'fpath',
]);

// Programs a Claude Code hook (and what it runs) may run with nothing more
// to follow (FollowOptions.strict): ones that neither load code from the
// folder nor run a command they're handed, and shell builtins. Not git (an
// alias or core.hooksPath runs anything), open (an app in the repo), sed
// (its `e`), sort (--compress-program) or terminal-notifier (-execute).
const INERT_PROGRAMS = new Set([
  'echo', 'printf', 'true', 'false', 'test', '[', ':', 'cat', 'head', 'tail', 'ls', 'pwd', 'date', 'sleep', 'say', 'afplay',
  'jq', 'grep', 'egrep', 'fgrep', 'tr', 'wc', 'cut', 'uniq', 'tee', 'mkdir', 'touch', 'rm', 'rmdir', 'cp', 'mv', 'ln',
  'chmod', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'pbcopy', 'pbpaste', 'curl', 'wget', 'which', 'whoami',
  'hostname', 'uname', 'tput', 'notify-send', 'logger', 'mktemp',
  'cd', 'export', 'set', 'unset', 'shift', 'exit', 'return', 'read', 'local', 'declare', 'typeset', 'wait', 'umask',
  'break', 'continue', 'pushd', 'popd', 'type', 'hash', 'let', 'shopt', 'ulimit',
]);

const LOADING_FLAG = /(^|\s)(-r|-e|-p|--require|--import|--loader|--experimental-loader|--preload|--eval|--print|--preserve-symlinks|--preserve-symlinks-main)(\s|=|$)/;
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish', 'dependencies'];
const PATH_SENTINEL = '\u0000PATH';

// Extensions of files that run as code: a shell's, Node's, or a language
// this can't follow (which fails closed when one runs).
export const RUNNABLE_EXT = [...SHELL_EXT, ...JS_EXT, '.py', '.rb', '.pl'];

// Whether a file a patch or script only names (a string, an argument) is
// code, and so goes in the hash: a runnable extension, the executable bit
// or a `#!` line. Anything else (state.json, notes.txt, a folder) is data:
// a patch that writes its own state file would otherwise change its hash
// every run and be asked about again. A file something runs, sources or
// imports is hashed whatever it looks like (follow's other `how`s). A
// missing file counts only with a runnable extension.
export function looksRunnable(file: string): boolean {
  if (RUNNABLE_EXT.includes(path.extname(file).toLowerCase())) return true;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (st.mode & 0o111) return true;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// ---- a shell lexer: enough of POSIX sh, bash and zsh to see what runs ----

type Part = { k: 'lit'; s: string; q: boolean } | { k: 'var'; name: string; op: string } | { k: 'sub'; src: string; line: number } | { k: 'arith' };
type Word = { parts: Part[]; line: number };
type Tok = { t: 'word'; w: Word } | { t: 'op'; op: string; line: number } | { t: 'redir'; op: string; target?: Word; line: number };

const OPS = ['<(', '>(', ';;&', ';;', ';&', '&&', '||', '|&', '<<<', '<<-', '<<', '&>>', '&>', '>>', '<>', '>|', '>&', '<&', ';', '&', '|', '(', ')', '<', '>'];
const REDIRS = new Set(['<<<', '<<-', '<<', '&>>', '&>', '>>', '<>', '>|', '>&', '<&', '<', '>']);

class Lexer {
  i = 0;
  line: number;
  toks: Tok[] = [];
  // Command substitutions outside any command's words (in a here-doc, a
  // ${x:-$(cmd)}): they run too.
  extra: { src: string; line: number }[] = [];
  private heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
  private s: string;
  constructor(s: string, line = 1) {
    this.s = s;
    this.line = line;
  }

  run(): this {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++;
      } else if (c === '\\' && s[this.i + 1] === '\n') {
        this.i += 2;
        this.line++;
      } else if (c === '\n') {
        this.toks.push({ t: 'op', op: '\n', line: this.line });
        this.i++;
        this.line++;
        this.readHeredocs();
      } else if (c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (!this.op()) {
        const w = this.word();
        // `2>&1`: the 2 is the redirect's, not a word.
        if (/^\d+$/.test(litOf(w) ?? '') && (s[this.i] === '<' || s[this.i] === '>')) continue;
        if (!w.parts.length) throw new Error(`can't read line ${this.line}`);
        this.toks.push({ t: 'word', w });
      }
    }
    if (this.heredocs.length) this.readHeredocs();
    return this;
  }

  private op(): boolean {
    const s = this.s;
    const op = OPS.find((o) => s.startsWith(o, this.i));
    if (!op) return false;
    const line = this.line;
    if (op === '<(' || op === '>(') {
      const src = this.balanced(this.i + 1);
      this.toks.push({ t: 'word', w: { parts: [{ k: 'sub', src, line }], line } });
      return true;
    }
    this.i += op.length;
    if (!REDIRS.has(op)) {
      this.toks.push({ t: 'op', op, line });
      return true;
    }
    while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
    let target: Word | undefined;
    if (this.i < s.length && !' \t\r\n;&|()<>'.includes(s[this.i]!)) target = this.word();
    if ((op === '<<' || op === '<<-') && target) {
      const quoted = target.parts.some((p) => p.k === 'lit' && p.q);
      const delim = target.parts.map((p) => (p.k === 'lit' ? p.s : '')).join('');
      this.heredocs.push({ delim, strip: op === '<<-', quoted });
    }
    this.toks.push({ t: 'redir', op, ...(target ? { target } : {}), line });
    return true;
  }

  private readHeredocs(): void {
    const s = this.s;
    for (const h of this.heredocs) {
      let body = '';
      const line = this.line;
      while (this.i < s.length) {
        const end = s.indexOf('\n', this.i);
        const text = s.slice(this.i, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
        this.line++;
        if ((h.strip ? text.replace(/^\t+/, '') : text) === h.delim) break;
        body += text + '\n';
      }
      // An unquoted here-doc's $(...) runs as it's read.
      if (!h.quoted) this.collectSubs(body, line);
    }
    this.heredocs = [];
  }

  // The substitutions in text a shell expands as it would a "..." string.
  collectSubs(text: string, line: number): void {
    const l = new Lexer(text, line);
    while (l.i < text.length) {
      const c = text[l.i];
      if (c === '\\') l.i += 2;
      else if (c === '$' || c === '`') {
        const p = c === '$' ? l.dollar() : l.backtick();
        if (p?.k === 'sub') this.extra.push({ src: p.src, line: p.line });
        if (!p) l.i++;
      } else {
        if (c === '\n') l.line++;
        l.i++;
      }
    }
    this.extra.push(...l.extra);
  }

  word(): Word {
    const s = this.s;
    const parts: Part[] = [];
    const line = this.line;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (' \t\r\n;&|()<>'.includes(c)) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') {
          this.i += 2;
          this.line++;
          continue;
        }
        parts.push({ k: 'lit', s: s[this.i + 1] ?? '', q: true });
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new Error(`an unclosed ' on line ${this.line}`);
        const text = s.slice(this.i + 1, end);
        this.line += countLines(text);
        parts.push({ k: 'lit', s: text, q: true });
        this.i = end + 1;
      } else if (c === '$' && s[this.i + 1] === "'") {
        let j = this.i + 2;
        while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
        if (j >= s.length) throw new Error(`an unclosed $' on line ${this.line}`);
        const text = s.slice(this.i + 2, j);
        this.line += countLines(text);
        // With an escape in it (`$'\142ash'` is bash), what it says isn't
        // the text: taken as worked out as it runs, so a command or file
        // named by one fails closed (Codex's review, 6 Nov).
        parts.push(text.includes('\\') ? { k: 'var', name: '', op: "$'" } : { k: 'lit', s: text, q: true });
        this.i = j + 1;
      } else if (c === '"') {
        this.i++;
        this.dquote(parts);
      } else if (c === '$') {
        const p = this.dollar();
        if (p) parts.push(p);
        else {
          parts.push({ k: 'lit', s: '$', q: false });
          this.i++;
        }
      } else if (c === '`') {
        parts.push(this.backtick());
      } else {
        parts.push({ k: 'lit', s: c, q: false });
        this.i++;
      }
    }
    return { parts, line };
  }

  // Inside "...", from just after the opening quote to just after the close.
  dquote(parts: Part[]): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === '\\') {
        const n = s[this.i + 1] ?? '';
        if (n === '\n') this.line++;
        else parts.push({ k: 'lit', s: '$`"\\'.includes(n) ? n : '\\' + n, q: true });
        this.i += 2;
      } else if (c === '$') {
        const p = this.dollar();
        if (p) parts.push(p);
        else {
          parts.push({ k: 'lit', s: '$', q: true });
          this.i++;
        }
      } else if (c === '`') {
        parts.push(this.backtick());
      } else {
        if (c === '\n') this.line++;
        parts.push({ k: 'lit', s: c, q: true });
        this.i++;
      }
    }
    throw new Error(`an unclosed " on line ${this.line}`);
  }

  private dollar(): Part | undefined {
    const s = this.s;
    const line = this.line;
    const n = s[this.i + 1];
    if (n === '(' && s[this.i + 2] === '(') {
      const inner = this.balanced(this.i + 1);
      this.collectSubs(inner, line);
      return { k: 'arith' };
    }
    if (n === '(') return { k: 'sub', src: this.balanced(this.i + 1), line };
    if (n === '{') {
      let depth = 0;
      let j = this.i + 1;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '\\') j++;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
        else if (c === '\n') this.line++;
      }
      if (j >= s.length) throw new Error(`an unclosed \${ on line ${line}`);
      const inner = s.slice(this.i + 2, j);
      this.i = j + 1;
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(\[[^\]]*\])?/.exec(inner);
      const name = m ? m[1]! + (m[2] ?? '') : '';
      const op = m ? inner.slice(m[0].length) : inner;
      if (/[`$]/.test(op)) this.collectSubs(op, line);
      return { k: 'var', name, op };
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(s.slice(this.i + 1, this.i + 64));
    if (!m) return undefined;
    this.i += 1 + m[1]!.length;
    return { k: 'var', name: m[1]!, op: '' };
  }

  private backtick(): Part {
    const s = this.s;
    const line = this.line;
    let j = this.i + 1;
    let src = '';
    for (; j < s.length && s[j] !== '`'; j++) {
      if (s[j] === '\\' && (s[j + 1] === '`' || s[j + 1] === '\\' || s[j + 1] === '$')) src += s[++j];
      else src += s[j];
    }
    if (j >= s.length) throw new Error(`an unclosed \` on line ${line}`);
    this.line += countLines(src);
    this.i = j + 1;
    return { k: 'sub', src, line };
  }

  // The text inside the ( at `open` and its ), skipping quotes; moves past it.
  private balanced(open: number): string {
    const s = this.s;
    let depth = 0;
    let j = open;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === "'") {
        const end = s.indexOf("'", j + 1);
        if (end < 0) break;
        j = end;
      } else if (c === '"') {
        for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (j >= s.length) throw new Error(`an unclosed ( on line ${this.line}`);
    const inner = s.slice(open + 1, j);
    this.line += countLines(inner);
    this.i = j + 1;
    return inner;
  }
}

function countLines(t: string): number {
  let n = 0;
  for (const c of t) if (c === '\n') n++;
  return n;
}

// A word that's only literal text, or undefined.
function litOf(w: Word): string | undefined {
  return w.parts.every((p) => p.k === 'lit') ? w.parts.map((p) => (p as { s: string }).s).join('') : undefined;
}

// Unquoted, plain: how reserved words and assignments are told apart.
function bareOf(w: Word): string | undefined {
  return w.parts.every((p) => p.k === 'lit' && !p.q) ? w.parts.map((p) => (p as { s: string }).s).join('') : undefined;
}

type Simple = { words: Word[]; redirs: { op: string; target?: Word }[]; line: number; arrays: Word[] };

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'time', '}}', '{{']);

// Simple commands from tokens, with `case` patterns, `[[ ]]` and `x=(...)`
// kept from looking like commands of their own.
function simpleCommands(toks: Tok[]): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], redirs: [], line: 0, arrays: [] };
  const end = () => {
    if (cur.words.length || cur.redirs.length || cur.arrays.length) out.push(cur);
    cur = { words: [], redirs: [], line: 0, arrays: [] };
    leadAt = -1;
    leadIsCase = false;
  };
  const cases: ('pat' | 'body')[] = [];
  let inTest = false;
  // The first of cur's words that isn't a reserved word, kept as words are
  // added: finding it afresh each time was quadratic in `if if if ...`
  // (Codex's review, 6 Nov).
  let leadAt = -1;
  let leadIsCase = false;
  const lead = () => leadAt;
  const push = (w: Word) => {
    cur.words.push(w);
    if (leadAt < 0 && !RESERVED.has(bareOf(w) ?? '')) {
      leadAt = cur.words.length - 1;
      leadIsCase = bareOf(w) === 'case';
    }
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (cases.at(-1) === 'pat') {
      if (t.t === 'word' && bareOf(t.w) === 'esac') cases.pop();
      else if (t.t === 'op' && t.op === ')') cases[cases.length - 1] = 'body';
      // A pattern is expanded, so what's in it runs: kept as `:`'s words.
      else if (t.t === 'word') out.push({ words: [{ parts: [{ k: 'lit', s: ':', q: false }], line: t.w.line }, t.w], redirs: [], line: t.w.line, arrays: [] });
      continue;
    }
    if (t.t === 'op') {
      if (inTest && t.op !== '\n' && t.op !== ';') continue;
      if (t.op === '(' && cur.words.length && /=$/.test(bareOf(cur.words.at(-1)!) ?? '')) {
        for (k++; k < toks.length; k++) {
          const v = toks[k]!;
          if (v.t === 'op' && v.op === ')') break;
          if (v.t === 'word') cur.arrays.push(v.w);
        }
        continue;
      }
      end();
      if ((t.op === ';;' || t.op === ';&' || t.op === ';;&') && cases.at(-1) === 'body') cases[cases.length - 1] = 'pat';
      continue;
    }
    if (t.t === 'redir') {
      if (inTest) {
        if (t.target) push(t.target);
        continue;
      }
      cur.redirs.push({ op: t.op, ...(t.target ? { target: t.target } : {}) });
      if (!cur.line) cur.line = t.line;
      continue;
    }
    const bare = bareOf(t.w);
    if (!cur.line) cur.line = t.w.line;
    const at = lead();
    if (at < 0 && bare === 'esac' && cases.length) {
      cases.pop();
      end();
      continue;
    }
    if (at < 0 && bare === '[[') inTest = true;
    if (inTest && bare === ']]') inTest = false;
    push(t.w);
    const first = lead();
    if (first >= 0 && leadIsCase && cur.words.length === first + 3 && bare === 'in') {
      end();
      cases.push('pat');
    }
  }
  end();
  return out;
}

// ---- following ----

type Ctx = {
  label: string; // for messages: a path from the repo's top, or a package script
  file: string; // the script's own file (BASH_SOURCE)
  argv0: string[]; // what $0 can be
  dirs: Set<string>; // the folders it can be in
  lost?: string; // set once a cd goes somewhere this can't work out
  vars: Map<string, string[] | undefined>;
  depth: number;
  inSub?: boolean;
};

class Reach {
  files = new Set<string>();
  missing = new Set<string>();
  outside = new Map<string, Set<string>>();
  problem?: string;
  // The package folders whose node_modules/.bin a package script has first
  // on PATH, while one is being followed.
  private binDirs: string[] = [];
  private visits = new Set<string>();
  private wraps = 0;
  // Each function a script defines, by the line it's defined on.
  private functions = new Map<string, number>();
  private home: string;
  private o: FollowOptions;
  readonly reads: Reads;
  constructor(o: FollowOptions) {
    this.o = o;
    this.home = o.home ?? os.homedir();
    this.reads = o.reads ?? new Reads();
  }

  private text(file: string): string | undefined {
    const real = this.reads.real(file);
    return real === undefined ? undefined : this.reads.text(real);
  }

  private rel(file: string): string {
    const r = path.relative(this.o.top, file);
    return r && !r.startsWith('..') ? r : file;
  }

  private fail(ctx: Ctx | undefined, line: number | undefined, what: string): void {
    if (this.problem) return;
    this.problem = ctx ? `${ctx.label}${line ? ` line ${line}` : ''} ${what}` : what;
  }

  // By the path as written, else by its real one: /tmp/R is /private/tmp/R
  // on macOS, and a path the lexical test put outside the repo ran a repo
  // file unfollowed (Codex's review, 6 Nov). A path that isn't there yet
  // goes by its nearest folder that is.
  private inRepo(p: string): boolean {
    const inside = (q: string) => {
      const rel = path.relative(this.o.top, q);
      return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    };
    return inside(p) || inside(realOrNearest(p));
  }

  // Hashes a file of the repo's and follows it by its kind. `how`: it runs
  // (its own process), it's sourced into `ctx`'s shell, it's loaded as
  // code or config (an import, a package.json a package script runs from),
  // or it's only named (an argument, a string): then it's hashed only if
  // it's code (looksRunnable), and only a script is followed.
  follow(file: string, how: 'run' | 'source' | 'load' | 'named', ctx: Ctx | undefined, line?: number): void {
    if (this.problem) return;
    const abs = path.resolve(file);
    if (!this.inRepo(abs)) return this.noteOutside(abs, how, ctx, line);
    if (how === 'named' && !looksRunnable(abs)) return;
    const passive = how === 'named' || how === 'load';
    const found = this.reads.real(abs);
    if (found === undefined) {
      if (this.missing.size < 500) this.missing.add(abs);
      if (!passive) this.fail(ctx, line, `runs ${this.rel(abs)}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
      return;
    }
    const real = found;
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    this.files.add(real);
    if (this.files.size > MAX_SCRIPT_FILES) return this.fail(undefined, undefined, `what it runs reaches more than ${MAX_SCRIPT_FILES} files, more than patch trust follows.`);
    const depth = (ctx?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) return this.fail(ctx, line, `runs scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    const dirs = ctx && !ctx.lost ? [...ctx.dirs].sort().join('\n') : this.o.folder;
    // By the path as named too: a shell script's $0 and BASH_SOURCE are
    // that, not where a link leads, so its `$(dirname "$0")/x.sh` is beside
    // the link.
    const key = `${how} ${real} ${abs} ${dirs}`;
    if (this.visits.has(key)) return;
    if (this.visits.size >= MAX_VISITS) return this.fail(undefined, undefined, `what it runs is more than patch trust follows.`);
    this.visits.add(key);
    const text = this.reads.text(real);
    if (text === undefined) {
      if (this.reads.tooBig.has(real)) this.fail(ctx, line, `reaches ${this.rel(real)}, over ${MAX_READ_BYTES / 1024 / 1024} MB, more than patch trust reads.`);
      return;
    }
    const kind = kindOf(real, text, !passive);
    const label = this.rel(real);
    if (kind === 'binary') {
      if (!passive) this.fail(ctx, line, `runs ${label}, a program patch trust can't read.`);
      return;
    }
    if (kind === 'other') {
      if (!passive) this.fail(ctx, line, `runs ${label}, which isn't a shell script or JavaScript, so patch trust can't follow what it loads.`);
      return;
    }
    const startDirs = ctx && !ctx.lost ? new Set(ctx.dirs) : new Set([this.o.folder]);
    if (passive) startDirs.add(path.dirname(real));
    if (kind === 'js') {
      const shebang = /^#!(.*)/.exec(text)?.[1] ?? '';
      if (LOADING_FLAG.test(shebang.replace(/^\S+/, ''))) return this.fail(undefined, undefined, `${label}'s #! line loads other code by a flag (${shebang.trim()}), which patch trust doesn't follow.`);
      return this.js(real, text, startDirs, depth);
    }
    // A #! that makes the shell read its commands from elsewhere (`-s`
    // reads its input, `-c` its arguments, `-i` rc files), or env -S.
    if (!passive && shebangReadsElsewhere(text)) return this.fail(ctx, line, `runs ${label}, whose #! line makes the shell read its commands from somewhere else, which patch trust can't follow.`);
    // A shell script is lexed whole, again for each command that reaches
    // it: one too big for a script fails closed.
    if (text.length > MAX_CONFIG_BYTES) return this.fail(ctx, line, `runs ${label}, a shell script over ${MAX_CONFIG_BYTES / 1024} KB, more than patch trust reads.`);
    if (how === 'source' && ctx) {
      return this.shell(text, { ...ctx, label, file: abs, argv0: [...ctx.argv0, abs], depth });
    }
    this.shell(text, { label, file: abs, argv0: [abs], dirs: startDirs, vars: new Map(), depth });
  }

  // A script outside the repo this reaches (FollowOptions.outside). A
  // program (/usr/bin/git, a brew binary) isn't one: its bytes change with
  // every upgrade, and programs aren't followed anyway.
  private noteOutside(abs: string, how: 'run' | 'source' | 'load' | 'named', ctx: Ctx | undefined, line: number | undefined): void {
    if (!this.o.outside || this.outside.size >= MAX_SCRIPT_FILES) return;
    if (how === 'named' && !looksRunnable(abs)) return;
    const real = this.reads.real(abs);
    if (real === undefined || !isFile(real) || isBinary(real)) return;
    // It keeps the folder it was run from, so its `. ./helper.sh` is there,
    // not beside it (Codex's review, 7 Nov).
    if (ctx?.lost) return this.fail(ctx, line, `runs ${abs} after a cd patch trust couldn't follow (${ctx.lost}), so it can't tell what that script's relative paths are.`);
    const dirs = this.outside.get(real) ?? new Set<string>();
    for (const d of ctx ? ctx.dirs : [this.o.folder]) dirs.add(d);
    this.outside.set(real, dirs);
    // It's followed as a process of its own, later, but a sourced one can
    // change this shell's folder and variables, so what's run after it here
    // can't be told (hashed all the same, above).
    if (how === 'source') this.fail(ctx, line, `sources ${abs}, outside the repo, whose changes to this shell patch trust can't follow.`);
  }

  // Bare imports and `node --import x`: what the repo commits under
  // node_modules (tracked-packages.ts), and a package that's a link to a
  // folder of the repo's. A workspace or `file:` package is what npm links
  // like that, and Node follows the link, so its files are the repo's to
  // change, though nothing under node_modules is (Daybreak, 7 Nov). A
  // package npm installed is neither, and isn't hashed (Mike's call, 7 Nov).
  private barePackage(fromDir: string, spec: string, ctx: Ctx, label: string): void {
    if (isBuiltin(spec) || spec.startsWith('node:')) return;
    // Node's self-reference needs neither git nor a node_modules.
    const own = this.ownPackage(fromDir, spec);
    if (own) return this.fail(undefined, undefined, `${label} imports ${spec}, its own package by name, which ${own}'s \`exports\` send to a file by rules patch trust doesn't follow. Import the file by a plain path.`);
    const bare = bareImport(fromDir, spec, this.o.top, this.reads);
    if (bare && 'problem' in bare) return this.fail(undefined, undefined, `${label} imports ${spec}, and ${bare.problem}`);
    for (const f of bare?.files ?? []) this.follow(f, 'load', ctx);
    if (this.problem) return;
    // All of them, not only the one it names, as an installed package may
    // import one too (Codex's review, 7 Nov), as for what's committed.
    const links = linkedPackages(fromDir, this.o.top, this.reads);
    for (const linked of links) {
      const code = packageFiles(linked, MAX_SCRIPT_FILES);
      if ('problem' in code) return this.fail(undefined, undefined, `${label} imports ${spec}, and ${this.rel(linked)}, a package the repo links into node_modules: ${code.problem}`);
      // Whatever they look like, as its manifest can export any of them.
      for (const f of code.files) this.follow(f, 'load', ctx);
      if (this.problem) return;
    }
    // What decides which of those files runs as code: a file Node would run
    // that the follower reads as data was hashed, but what it loads wasn't.
    const manifests = [...links, ...(bare?.files ?? []).filter((f) => path.basename(f) === 'package.json').map((f) => path.dirname(f))];
    for (const dir of manifests) {
      const odd = this.exportedOddly(dir);
      if (odd) return this.fail(undefined, undefined, `${label} imports ${spec}, and ${this.rel(dir)}'s package.json points at ${odd}, which isn't JavaScript patch trust can follow, though Node would run it.`);
    }
    const sub = this.oddSubpath(fromDir, spec);
    if (sub) this.fail(undefined, undefined, `${label} imports ${spec}, ${this.rel(sub)}, which isn't JavaScript patch trust can follow, though Node would run it.`);
  }

  // The file a bare import names directly in a node_modules (`wsp/payload`,
  // or `payload` for a file there of that name), when it's the repo's and
  // not JavaScript: require() runs any file it's given by its exact name as
  // CommonJS.
  private oddSubpath(fromDir: string, spec: string): string | undefined {
    for (let d = fromDir; this.inRepo(d); d = path.dirname(d)) {
      const real = this.reads.real(path.join(d, 'node_modules', spec));
      if (real !== undefined && isFile(real) && this.inRepo(real)) {
        if (path.extname(real) === '.json' || JS_EXT.includes(path.extname(real))) return undefined;
        // Installed packages stay as they are: only the repo's own.
        const t = bareImport(fromDir, spec, this.o.top, this.reads);
        const committed = t && !('problem' in t) && t.files.includes(real);
        return committed || !inNodeModules(path.relative(this.o.top, real)) ? real : undefined;
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
    return undefined;
  }

  // The package.json a bare import is its own package's by name, when Node
  // would resolve it through that: the nearest one up has this `name` and an
  // `exports` (Node's self-reference), so it loads a file of the repo's no
  // lookup in node_modules finds, as a pull renaming a package can arrange
  // (patches' own imports are refused the same way, verified-imports.ts).
  // Read and noticed, not hashed: an install writes package.json too.
  private ownPackage(fromDir: string, spec: string): string | undefined {
    if (inNodeModules(path.relative(this.o.top, fromDir))) return undefined;
    const parts = spec.split('/');
    const name = (spec.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
    for (let d = fromDir; this.inRepo(d); d = path.dirname(d)) {
      const real = this.reads.real(path.join(d, 'package.json'));
      if (real !== undefined && isFile(real)) {
        try {
          const pkg = JSON.parse(this.reads.text(real) ?? '') as { name?: unknown; exports?: unknown };
          return pkg?.name === name && pkg.exports !== undefined && pkg.exports !== null ? this.rel(real) : undefined;
        } catch {
          return undefined;
        }
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
    return undefined;
  }

  // A file a linked package's manifest names as what loads (`exports`,
  // `main`, `module`, `bin`) that isn't one the follower reads as
  // JavaScript: a CommonJS file with no extension runs all the same.
  private exportedOddly(pkgDir: string): string | undefined {
    const real = this.reads.real(path.join(pkgDir, 'package.json'));
    if (real === undefined || !isFile(real)) return undefined;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(this.reads.text(real) ?? '') as Record<string, unknown>;
    } catch {
      return this.rel(real);
    }
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const k of ['exports', 'main', 'module', 'bin']) walk(pkg?.[k]);
    for (const v of out) {
      // A pattern: only one that says it ends in JavaScript can be told apart.
      if (v.includes('*')) {
        if (!JS_EXT.includes(path.extname(v)) && path.extname(v) !== '.json') return v;
        continue;
      }
      const p = path.resolve(pkgDir, v);
      if (isFile(p) && !JS_EXT.includes(path.extname(p)) && path.extname(p) !== '.json') return v;
    }
    return undefined;
  }

  // Everything the repo commits under node_modules, once a package manager
  // runs: its scripts' programs come from node_modules/.bin, an install runs
  // the lifecycle scripts of what's there, and `npx x` what x's bin says, so
  // a committed package's bytes run without any import naming them.
  private committedPackages(fromDir: string, ctx: Ctx, line: number): void {
    const bare = bareImport(fromDir, ANY_PACKAGE, this.o.top, this.reads);
    if (!bare) return;
    if ('problem' in bare) {
      // git can't say, which only matters with a node_modules on the way up
      // for a package manager to use: an import has to be refused anyway.
      for (let d = fromDir; this.inRepo(d); d = path.dirname(d)) {
        if (this.reads.real(path.join(d, 'node_modules')) !== undefined) return this.fail(ctx, line, `runs a package manager, and ${bare.problem}`);
        if (d === this.o.top || path.dirname(d) === d) break;
      }
      return;
    }
    // Those a shell would run by name are what they'd be run as: a committed
    // .bin file with no #! runs as a shell script, though it reads as data.
    for (const f of bare.files) this.follow(f, path.basename(path.dirname(f)) === '.bin' ? 'run' : 'load', ctx, line);
  }

  // What the repo commits under node_modules, with a lifecycle script of its
  // own: `npm rebuild` or an install runs those from that package's folder,
  // and one may run a file of the repo's that isn't under node_modules at all.
  private committedLifecycle(fromDir: string, ctx: Ctx, line: number): void {
    const bare = bareImport(fromDir, ANY_PACKAGE, this.o.top, this.reads);
    if (!bare || 'problem' in bare) return;
    for (const f of bare.files) {
      if (path.basename(f) !== 'package.json') continue;
      try {
        this.runScripts(path.dirname(f), JSON.parse(this.text(f) ?? '') as Record<string, any>, LIFECYCLE, ctx);
      } catch {
        this.fail(ctx, line, `installs ${this.rel(f)}, which can't be read, so patch trust can't tell what it runs.`);
      }
      if (this.problem) return;
    }
  }

  // The file a program name is in a package's node_modules/.bin, when it's
  // a link to a file of the repo's outside node_modules (a workspace
  // package's bin). A committed one is hashed with the rest
  // (committedPackages), and an installed one isn't, by design.
  private repoBin(name: string, dirs: Iterable<string>): string | undefined {
    if (!/^[\w@.+-]+$/.test(name)) return undefined;
    for (const dir of dirs) {
      for (let d = dir; this.inRepo(d); d = path.dirname(d)) {
        const real = this.reads.real(path.join(d, 'node_modules', '.bin', name));
        if (real !== undefined) return this.inRepo(real) && !inNodeModules(path.relative(this.o.top, real)) ? real : undefined;
        if (d === this.o.top || path.dirname(d) === d) break;
      }
    }
    return undefined;
  }

  private js(file: string, text: string, dirs: Set<string>, depth: number): void {
    const scan = this.o.scanJs(text, file);
    const label = this.rel(file);
    if (scan.problem) return this.fail(undefined, undefined, `${label}: ${scan.problem}`);
    // Commands it runs itself aren't followed from JavaScript, which a
    // Claude Code hook (FollowOptions.strict) can't leave out.
    // The parsed strings too, which a `\u0070` in a name has been decoded in.
    // An escape (`B\u0075n`, "child_\x70rocess") can spell any of those.
    if (this.o.strict && (/child_process|\bBun\b|\bDeno\b|\bprocess\s*\.\s*(binding|dlopen)\b|\\(u[0-9a-fA-F{]|x[0-9a-fA-F]{2}|[0-7])/.test(text) || scan.strings.some((x) => /child_process|worker_threads|^(node:)?(vm|module|cluster|inspector)$/.test(x)))) {
      return this.fail(undefined, undefined, `${label} runs other commands or native code itself, which a hash can't follow. Run them from a shell script instead.`);
    }
    const ctx: Ctx = { label, file, argv0: [file], dirs, vars: new Map(), depth };
    for (const spec of scan.specifiers) {
      const target = this.o.resolveImport(path.dirname(file), spec);
      // require() runs a file it's given by its exact name as CommonJS,
      // whatever it's called, but read as data what it loads isn't followed.
      const ext = path.extname(target);
      if (this.inRepo(target) && isFile(target) && !JS_EXT.includes(ext) && ext !== '.json') return this.fail(undefined, undefined, `${label} loads ${this.rel(target)}, which isn't JavaScript patch trust can follow, though Node would run it.`);
      this.follow(target, 'load', ctx);
    }
    // A package inside the repo: what the repo commits under node_modules
    // is its own code, hashed and followed; an installed one isn't.
    for (const spec of scan.packages ?? []) {
      this.barePackage(path.dirname(file), spec, ctx, label);
      if (this.problem) return;
    }
    this.namedIn(text, file, ctx);
    // A string naming a file of the repo's (`spawnSync('bash', ['scripts/x.sh'])`).
    for (const s of scan.strings) {
      if (s.length > 300 || !/[./]/.test(s) || /[\s\0]/.test(s) || /^[a-z]+:/i.test(s)) continue;
      const bases = path.isAbsolute(s) ? [''] : [path.dirname(file), ...dirs, this.o.top];
      for (const b of bases) {
        const p = path.resolve(b, s);
        if (isFile(p)) this.follow(p, 'named', ctx);
        else if (s.includes('/') && [...SHELL_EXT, ...JS_EXT].includes(path.extname(s)) && this.missing.size < 500 && this.inRepo(p)) this.missing.add(p);
      }
    }
  }

  // `./` and `../` paths anywhere in a file's text, from its folder and the
  // folders it runs in: extra matches only add files to the hash.
  private namedIn(text: string, file: string, ctx: Ctx): void {
    for (const spec of this.o.namedPaths(text)) {
      for (const b of new Set([path.dirname(file), ...(ctx.lost ? [] : ctx.dirs)])) {
        const p = path.resolve(b, spec);
        if (isFile(p)) this.follow(p, 'named', ctx);
      }
    }
  }

  shell(text: string, ctx: Ctx, lineBase = 1): void {
    if (this.problem) return;
    let lexed: Lexer;
    try {
      lexed = new Lexer(text, lineBase).run();
    } catch (e) {
      return this.fail(ctx, undefined, `can't be read as a shell script (${(e as Error).message}), so patch trust can't follow what it runs.`);
    }
    // The functions a script defines are its own words, not programs on
    // PATH (FollowOptions.strict): `name ()` and `function name`, as the
    // lexer reads them, so a comment or a here-doc doesn't define one.
    // Only at a command's start, and only for this script's own commands:
    // a shell it starts (`sh -c`) doesn't have them.
    const outer = this.functions;
    if (this.o.strict) {
      // A command substitution is the same shell's, so it has them too.
      this.functions = ctx.inSub ? new Map(outer) : new Map();
      const t = lexed.toks;
      // A function defined in a subshell `( ... )` is gone after it.
      let depth = 0;
      for (let i = 0; i < t.length; i++) {
        const a = t[i];
        const before = t[i - 1];
        if (a.t === 'op' && a.op === '(' && !(before?.t === 'word' && t[i + 1]?.t === 'op' && (t[i + 1] as { op: string }).op === ')')) depth++;
        else if (a.t === 'op' && a.op === ')' && !(t[i - 1]?.t === 'op' && (t[i - 1] as { op: string }).op === '(' && t[i - 2]?.t === 'word')) depth = Math.max(0, depth - 1);
        if (depth > 0) continue;
        if (a.t !== 'word' || (before && !(before.t === 'op' && [';', '\n', '&&', '||', '&', '{', '(', ')', '|'].includes(before.op)))) continue;
        const name = bareOf(a.w);
        if (!name) continue;
        const b = t[i + 1];
        const c = t[i + 2];
        if (b?.t === 'op' && b.op === '(' && c?.t === 'op' && c.op === ')' && !this.functions.has(name)) this.functions.set(name, a.w.line);
        if (name === 'function' && b?.t === 'word') {
          const f = bareOf(b.w);
          if (f && !this.functions.has(f)) this.functions.set(f, a.w.line);
        }
      }
    }
    try {
      this.shellBody(text, lexed, ctx);
    } finally {
      this.functions = outer;
    }
  }

  private shellBody(text: string, lexed: Lexer, ctx: Ctx): void {
    this.namedIn(text, ctx.file, ctx);
    for (const x of lexed.extra) this.shell(x.src, { ...ctx, inSub: true }, x.line);
    for (const cmd of simpleCommands(lexed.toks)) {
      if (this.problem) return;
      this.command(cmd, ctx);
    }
  }

  // The values a word can have, or undefined when it's worked out as it runs.
  private values(w: Word, ctx: Ctx): string[] | undefined {
    let outs = [''];
    for (const [n, p] of w.parts.entries()) {
      let vals: string[] | undefined;
      if (p.k === 'lit') {
        // ~ at the start, alone or before a /, is home.
        const next = w.parts[1];
        const tilde = n === 0 && !p.q && p.s === '~' && (!next || (next.k === 'lit' && next.s.startsWith('/')));
        vals = [tilde ? this.home : p.s];
      } else if (p.k === 'var') vals = this.varValues(p.name, p.op, ctx);
      else if (p.k === 'sub') vals = this.subValues(p.src, ctx, p.line);
      if (!vals) return undefined;
      outs = outs.flatMap((o) => vals!.map((v) => o + v)).slice(0, 16);
    }
    return outs;
  }

  private varValues(name: string, op: string, ctx: Ctx): string[] | undefined {
    let vals: string[] | undefined;
    if (name === '' && /^\(%\):-%[xN]$/.test(op)) return [ctx.file];
    if (name === '0') vals = ctx.argv0.length ? ctx.argv0 : undefined;
    else if (name === 'BASH_SOURCE' || name === 'BASH_SOURCE[0]') vals = [ctx.file];
    else if (name === 'HOME') vals = [this.home];
    else if (name === 'PWD') vals = ctx.lost ? undefined : [...ctx.dirs];
    else if (name === 'PATH' && !ctx.vars.has('PATH')) vals = [PATH_SENTINEL];
    else vals = ctx.vars.get(name);
    if (op === '') return vals;
    if (op.startsWith(':-') || op.startsWith('-')) return vals;
    if (!vals) return undefined;
    if (op === '%/*' || op === ':h') return vals.map((v) => path.dirname(v));
    if (op === ':A' || op === ':a') return vals.map((v) => path.resolve(v));
    if (op === ':A:h' || op === ':a:h') return vals.map((v) => path.dirname(path.resolve(v)));
    return undefined;
  }

  // What a $(...) gives, for the few a script uses to find its own folder.
  private subValues(src: string, ctx: Ctx, line: number): string[] | undefined {
    let cmds: Simple[];
    try {
      cmds = simpleCommands(new Lexer(src, line).run().toks);
    } catch {
      return undefined;
    }
    // Each word's values; the last word's can be several (a sourced
    // script's $0 is its caller's or its own).
    const words = (c: Simple) => {
      if (!c.words.length) return undefined;
      const v = c.words.map((w) => this.values(w, ctx));
      return v.every(Boolean) ? (v as string[][]) : undefined;
    };
    const fixed = (v: string[][]) => v.slice(0, -1).every((x) => x.length === 1);
    const absAll = (vs: string[]) => {
      const out = vs.map((x) => this.abs(x, ctx));
      return out.every(Boolean) ? out.flat() as string[] : undefined;
    };
    if (cmds.length === 1) {
      const w = words(cmds[0]!);
      if (!w || !fixed(w)) return undefined;
      const name = w[0]![0];
      const last = w.at(-1)!;
      if (name === 'dirname' && w.length === 2) return last.map((x) => path.dirname(x));
      if ((name === 'realpath' || name === 'grealpath') && w.length === 2) return absAll(last);
      if (name === 'readlink' && w[1]![0] === '-f' && w.length === 3) return absAll(last);
      if (name === 'pwd') return ctx.lost ? undefined : [...ctx.dirs];
      if (w.map((x) => x[0]).join(' ') === 'git rev-parse --show-toplevel') return [this.o.top];
      return undefined;
    }
    if (cmds.length === 2) {
      const a = words(cmds[0]!);
      const b = words(cmds[1]!);
      if (a && b && fixed(a) && a[0]![0] === 'cd' && b[0]![0] === 'pwd') {
        const target = a.slice(1).filter((x) => !x[0]!.startsWith('-'));
        if (target.length === 1) return absAll(target[0]!);
      }
    }
    return undefined;
  }

  private abs(v: string, ctx: Ctx): string[] | undefined {
    if (path.isAbsolute(v)) return [path.normalize(v)];
    if (ctx.lost) return undefined;
    return [...ctx.dirs].map((d) => path.resolve(d, v));
  }

  // Hashes every file of the repo's a word names.
  private named(w: Word, ctx: Ctx): void {
    const vals = this.values(w, ctx);
    for (const v of vals ?? []) {
      if (!v || v.length > 1024 || v.includes('\n') || v === PATH_SENTINEL) continue;
      for (const p of (path.isAbsolute(v) ? [v] : ctx.lost ? [] : [...ctx.dirs].map((d) => path.resolve(d, v)))) {
        if (isFile(p)) this.follow(p, 'named', ctx);
      }
    }
  }

  private subsOf(w: Word, ctx: Ctx): void {
    for (const p of w.parts) if (p.k === 'sub') this.shell(p.src, { ...ctx, inSub: true }, p.line);
  }

  private assign(name: string, value: Word | undefined, append: boolean, ctx: Ctx, line: number): void {
    const vals = value ? this.values(value, ctx) : [''];
    if (RISKY_ENV.has(name)) return this.fail(ctx, line, `sets ${name}, which makes other code load, so patch trust can't follow what runs.`);
    if (name === 'NODE_OPTIONS' && (!vals || vals.some((v) => LOADING_FLAG.test(v)))) return this.fail(ctx, line, 'sets NODE_OPTIONS to load other code, which patch trust can\'t follow.');
    if (name === 'PATH' || name === 'path') {
      // An empty entry is the current folder (a leading or trailing `:`, or
      // `::`), so it's left in to be refused, as `.` is (Codex's review, 7 Nov).
      const entries = vals?.flatMap((v) => (name === 'PATH' ? v.split(':') : v.split(' ')));
      const ok = entries?.every((e) => e === PATH_SENTINEL || /\/node_modules\/\.bin\/?$/.test(e) || (path.isAbsolute(e) && !this.inRepo(e)));
      if (!ok || append) return this.fail(ctx, line, "puts a folder on PATH that patch trust can't vouch for, so it can't tell what a command name runs.");
      // A package's bin folder, as a package script has first on PATH:
      // a name after this may be a program of the repo's, committed or a
      // workspace's, not an installed one (Codex's review, 7 Nov).
      for (const e of entries ?? []) {
        if (e === PATH_SENTINEL || !/\/node_modules\/\.bin\/?$/.test(e)) continue;
        const bins = this.abs(e, ctx);
        if (!bins) return this.fail(ctx, line, "puts a package's bin folder on PATH after a cd patch trust couldn't follow, so it can't tell what a command name runs.");
        for (const bin of bins) {
          if (!this.inRepo(bin)) continue;
          const pkg = path.dirname(path.dirname(bin));
          this.committedPackages(pkg, ctx, line);
          if (this.problem) return;
          this.binDirs = [...this.binDirs, pkg];
        }
      }
    }
    ctx.vars.set(name, append ? undefined : vals);
  }

  // Splits `NAME=value` off a word, or undefined.
  private assignment(w: Word): { name: string; append: boolean; value: Word } | undefined {
    const first = w.parts[0];
    if (!first || first.k !== 'lit' || first.q) return undefined;
    // The name and = may be split over parts when the lexer reads char by char.
    // Each part is looked at once: the whole text so far was tested again
    // at every part, and the lexer makes a part of each character, so a
    // long word took seconds per 20 KB (Gautam's scan, 6 Nov). Only the
    // part that brings the first `=` can complete an assignment (before
    // it, every character must be a name's, a subscript's or a final +).
    let text = '';
    let plus = false;
    for (let k = 0; k < w.parts.length; k++) {
      const p = w.parts[k]!;
      if (p.k !== 'lit' || p.q) break;
      text += p.s;
      if (p.s.includes('=')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/.exec(text);
        if (!m) return undefined;
        const rest = text.slice(m[0].length);
        const parts: Part[] = [...(rest ? [{ k: 'lit' as const, s: rest, q: false }] : []), ...w.parts.slice(k + 1)];
        return { name: m[1]!, append: m[3] === '+', value: { parts, line: w.line } };
      }
      if ((plus && p.s) || !/^[A-Za-z0-9_[\]]*\+?$/.test(p.s)) return undefined;
      plus = p.s.endsWith('+');
    }
    return undefined;
  }

  // The program a simple command's words run, by its base name, past
  // reserved words and assignments; undefined when it can't be told.
  private programOf(words: Word[], ctx: Ctx): string | undefined {
    for (const w of words) {
      if (RESERVED.has(bareOf(w) ?? '') || this.assignment(w)) continue;
      const v = this.str(w, ctx);
      return v === undefined ? undefined : path.basename(v);
    }
    return undefined;
  }

  private command(cmd: Simple, ctx: Ctx): void {
    const line = cmd.line;
    for (const w of [...cmd.words, ...cmd.arrays]) this.subsOf(w, ctx);
    // A file redirected into a shell may be what it runs (a flag that
    // makes it read commands from its input, missed below), so it's hashed
    // whatever it looks like, not only if it looks like code. Not one into
    // Node: with a script, its input is the script's data, and without one
    // it's refused below.
    const into = this.programOf(cmd.words, ctx);
    const loads = (into !== undefined && (into === '.' || into === 'source')) || cmd.words.some((w) => {
      // Past a wrapper too (`env bash`, `command bash`, `nice sh`).
      const v = litOf(w);
      return v !== undefined && SHELLS.includes(path.basename(v));
    });
    for (const r of cmd.redirs) {
      if (!r.target) continue;
      this.subsOf(r.target, ctx);
      if (r.op === '<' || r.op === '<>') {
        const v = this.values(r.target, ctx);
        if (!v && ctx.inSub) return this.fail(ctx, line, 'reads a file it works out as it runs (`$(< ...)`), which patch trust can\'t follow.');
        if (loads) for (const p of (v ?? []).flatMap((x) => this.abs(x, ctx) ?? [])) this.follow(p, 'load', ctx, line);
        else this.named(r.target, ctx);
      }
    }
    // Past reserved words (`then`, `do`, `!`, `{`) and `function name`.
    let words = cmd.words;
    const skip = () => {
      const i = words.findIndex((w) => !RESERVED.has(bareOf(w) ?? ''));
      words = i < 0 ? [] : words.slice(i);
    };
    skip();
    if (words.length && bareOf(words[0]!) === 'function') {
      words = words.slice(2);
      skip();
    }
    // Assignments before the command (or alone).
    // By index: dropping one word at a time copied the rest each time, so
    // a long run of `a=1` was quadratic (Codex's review, 6 Nov).
    let k = 0;
    for (; k < words.length; k++) {
      const a = this.assignment(words[k]!);
      if (!a) break;
      this.assign(a.name, a.value, a.append, ctx, line);
      if (this.problem) return;
    }
    words = words.slice(k);
    for (const w of cmd.arrays) this.named(w, ctx);
    if (!words.length) return;
    this.run(words, ctx, line, false);
  }

  // A command's words, from its name. `extra`: xargs adds arguments this
  // can't see.
  // `wrappedIn`: run by a wrapper whose own run named these words already.
  private run(words: Word[], ctx: Ctx, line: number, extra: boolean, wrappedIn = false): void {
    if (this.problem || !words.length) return;
    const head = words[0]!;
    const headVals = this.values(head, ctx);
    const shown = head.parts.map((p) => (p.k === 'lit' ? p.s : p.k === 'var' ? `$${p.name}` : '$(...)')).join('');
    if (!headVals || headVals.length !== 1) return this.fail(ctx, line, `runs a command worked out as it runs (\`${shown}\`), which patch trust can't follow.`);
    const name = headVals[0]!;
    if (name !== '[' && name !== '[[' && head.parts.some((p) => p.k === 'lit' && !p.q && /[*?[{]/.test(p.s))) return this.fail(ctx, line, `runs a command named by a pattern (\`${shown}\`), which patch trust can't follow.`);
    const args = words.slice(1);
    if (!wrappedIn) for (const w of args) this.named(w, ctx);
    if (this.problem) return;
    // A path: the repo's file runs (followed), or a program outside it,
    // treated by its name (/bin/sh is sh).
    if (name.includes('/')) {
      const targets = this.abs(name, ctx);
      if (!targets) return this.fail(ctx, line, `runs ${name} after a cd patch trust couldn't follow (${ctx.lost}), so it can't tell which file that is.`);
      const inRepo = targets.filter((t) => this.inRepo(t));
      if (inRepo.length) {
        const found = inRepo.filter(isFile);
        // A missing one that could turn up as a program: a runnable
        // extension, or none. Not a data file's name: every string a patch
        // has is followed as a command, so `'.cache/state.json'` lands here.
        for (const t of inRepo) if (!isFile(t) && mayRun(t) && this.missing.size < 500) this.missing.add(t);
        if (!found.length) return this.fail(ctx, line, `runs ${name}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
        // A file that isn't code can't run as a command (it has no
        // executable bit): not hashed, and anything that runs by itself
        // refuses it, as before.
        const code = found.filter(looksRunnable);
        if (!code.length) return this.fail(ctx, line, `runs ${name}, which isn't a shell script or JavaScript, so patch trust can't follow what it loads.`);
        for (const t of code) this.follow(t, 'run', ctx, line);
        return;
      }
      // /dev/fd/3 after `exec 3< ./x.sh` is x.sh.
      if (targets.some(readsInput)) return this.fail(ctx, line, `runs ${name}, which is a file it has open, so patch trust can't tell what runs.`);
      for (const t of targets) this.noteOutside(t, 'run', ctx, line);
      return this.program(path.basename(name), args, ctx, line, extra);
    }
    // In a package script, node_modules/.bin comes first on PATH.
    // (A hook's are refused below, or by the short list: nothing more to add.)
    if (!this.o.strict && this.binDirs.length) {
      const bin = this.repoBin(name, this.binDirs);
      if (bin) return this.follow(bin, 'run', ctx, line);
    }
    this.program(name, args, ctx, line, extra);
  }

  private str(w: Word | undefined, ctx: Ctx): string | undefined {
    if (!w) return undefined;
    const v = this.values(w, ctx);
    return v && v.length === 1 ? v[0] : undefined;
  }

  private program(name: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    const a = (i: number) => this.str(args[i], ctx);
    if (Object.hasOwn(UNFOLLOWABLE, name)) return this.fail(ctx, line, `${UNFOLLOWABLE[name]}, which patch trust can't follow.`);
    if (name === 'hash' && args.some((w) => /^-\w*p/.test(this.str(w, ctx) ?? ''))) return this.fail(ctx, line, 'maps a command name to a file (`hash -p`), which patch trust can\'t follow.');
    if (name === 'cd' || name === 'pushd') return this.cd(args, ctx, line);
    if (name === 'source' || name === '.') {
      const target = a(0);
      if (target === undefined) return this.fail(ctx, line, `sources a file worked out as it runs, which patch trust can't follow.`);
      const tries = this.abs(target, ctx);
      if (!tries) return this.fail(ctx, line, `sources ${target} after a cd patch trust couldn't follow (${ctx.lost}).`);
      // In the repo too: a committed link to /dev/stdin is the input.
      if (tries.some(readsInput)) return this.fail(ctx, line, `sources ${target}, which reads what to run from its input, which patch trust can't follow.`);
      for (const t of tries) {
        if (isFile(t)) this.follow(t, 'source', ctx, line);
        else if (this.inRepo(t) && this.missing.size < 500) this.missing.add(t);
      }
      return;
    }
    if (name === 'export' || name === 'local' || name === 'declare' || name === 'typeset' || name === 'readonly' || name === 'integer') {
      for (const w of args) {
        const as = this.assignment(w);
        if (as) this.assign(as.name, as.value, as.append, ctx, line);
      }
      return;
    }
    if (name === 'trap') {
      const code = args[0];
      if (!code) return;
      const text = litOf(code);
      if (text === undefined) return this.fail(ctx, line, 'sets a trap worked out as it runs, which patch trust can\'t follow.');
      if (text !== '-' && !/^-[lp]$/.test(text)) this.shell(text, ctx, line);
      return;
    }
    if (name === 'for' || name === 'select') {
      const v = a(0);
      if (v) ctx.vars.set(v, undefined);
      return;
    }
    if (name === 'read' || name === 'getopts' || name === 'mapfile' || name === 'readarray') {
      for (const w of args) {
        const v = this.str(w, ctx);
        if (v && /^[A-Za-z_]\w*$/.test(v)) ctx.vars.set(v, undefined);
      }
      if (name === 'getopts' && args[1]) ctx.vars.set(this.str(args[1], ctx) ?? '', undefined);
      return;
    }
    if (name === 'function') return;
    if (ctx.inSub && name === 'cat') {
      if (args.some((w) => !this.values(w, ctx))) return this.fail(ctx, line, 'reads a file it works out as it runs (`$(cat ...)`), which patch trust can\'t follow.');
      return;
    }
    // Wrappers: what they run is checked the same way.
    const wrapped = this.unwrap(name, args, ctx, line);
    if (wrapped) {
      if (!wrapped.words.length) return;
      // A few deep at most: each one looked at every word after it again,
      // so `env env env ...` was quadratic (Codex's review, 6 Nov).
      if (this.wraps >= 8) return this.fail(ctx, line, "runs a command through more wrappers (env, nice...) than patch trust follows.");
      this.wraps++;
      try {
        return this.run(wrapped.words, ctx, line, extra || wrapped.extra, true);
      } finally {
        this.wraps--;
      }
    }
    if (this.problem) return;
    if (name === 'find') {
      for (let i = 0; i < args.length; i++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(a(i) ?? '')) continue;
        const end = args.findIndex((w, j) => j > i && /^[;+]$/.test(litOf(w) ?? ''));
        this.run(args.slice(i + 1, end < 0 ? args.length : end), ctx, line, false);
      }
      return;
    }
    if (SHELLS.includes(name)) return this.shellRun(name, args, ctx, line, extra);
    if (JS_RUNNERS.includes(name)) return this.jsRun(name, args, ctx, line, extra);
    if (['npm', 'pnpm', 'yarn'].includes(name)) return this.pkgRun(name, args, ctx, line);
    if (['npx', 'bunx', 'pnpx'].includes(name)) return this.npx(args, ctx, line);
    if (name === 'make' || name === 'gmake') return this.make(args, ctx, line);
    if (name === 'awk' || name === 'gawk' || name === 'nawk' || name === 'mawk') return this.awk(args, ctx, line);
    if (OTHER_LANGS.test(name)) return this.fail(ctx, line, `runs ${name}, whose loads patch trust can't follow.`);
    // Anything else: a program on PATH, a builtin or a function in the
    // script (whose body was read with the rest).
    // A function only once it's defined (by line: a call before it runs the program).
    const defined = this.functions.get(name);
    if (this.o.strict && !INERT_PROGRAMS.has(name) && !(defined !== undefined && defined <= line)) {
      return this.fail(ctx, line, `runs ${name}, a program that may load code from the folder by its own rules (its config, plugins or tests), which a hash can't follow. Run a script in the repo instead.`);
    }
  }

  private cd(args: Word[], ctx: Ctx, line: number): void {
    const words = args.filter((w) => !/^-[LPe@]+$/.test(litOf(w) ?? ''));
    if (!words.length) {
      ctx.dirs.add(this.home);
      return;
    }
    const v = this.str(words[0], ctx);
    if (v === undefined || v === '-') {
      ctx.lost ??= `line ${line}`;
      return;
    }
    const to = this.abs(v, ctx);
    if (!to) return;
    for (const d of to) ctx.dirs.add(d);
  }

  // The command a wrapper (env, exec, nice, xargs...) runs, or undefined
  // when `name` isn't one.
  private unwrap(name: string, args: Word[], ctx: Ctx, line: number): { words: Word[]; extra: boolean } | undefined {
    const val = (opts: string[], flagsOk = true) => {
      let i = 0;
      for (; i < args.length; i++) {
        const s = this.str(args[i], ctx);
        if (s === undefined) break;
        if (s === '--') return i + 1;
        if (!s.startsWith('-') || s === '-') break;
        if (opts.includes(s)) i++;
        else if (!flagsOk) break;
      }
      return i;
    };
    switch (name) {
      case 'exec':
        return { words: args.slice(val(['-a'])), extra: false };
      case 'command': {
        if (args.some((w) => /^-[vV]$/.test(litOf(w) ?? ''))) return { words: [], extra: false };
        return { words: args.slice(val([])), extra: false };
      }
      case 'builtin':
      case 'nohup':
      case 'chronic':
      case 'unbuffer':
      case 'noglob':
      case 'nocorrect':
        return { words: args.slice(name === 'builtin' ? 0 : val([])), extra: false };
      case 'time':
        return { words: args.slice(val([])), extra: false };
      case 'nice':
        return { words: args.slice(val(['-n'])), extra: false };
      case 'ionice':
        return { words: args.slice(val(['-c', '-n', '-p'])), extra: false };
      case 'caffeinate':
        return { words: args.slice(val(['-t', '-w'])), extra: false };
      case 'taskpolicy':
        return { words: args.slice(val(['-c', '-d', '-g', '-t', '-l', '-p'])), extra: false };
      case 'stdbuf':
        return { words: args.slice(val(['-i', '-o', '-e'])), extra: false };
      case 'doas':
        return { words: args.slice(val(['-u', '-C'])), extra: false };
      case 'arch':
        return { words: args.slice(val(['-arch', '-e'])), extra: false };
      case 'flock': {
        const i = val(['-w', '-E', '--timeout', '--conflict-exit-code']);
        if (args.slice(i).some((w) => /^(-c|--command)$/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, 'runs a command string through flock, which patch trust doesn\'t follow.');
          return { words: [], extra: false };
        }
        return { words: args.slice(i + 1), extra: false };
      }
      case 'timeout':
      case 'gtimeout': {
        const i = val(['-s', '-k', '--signal', '--kill-after']);
        return { words: args.slice(i + 1), extra: false };
      }
      case 'sudo': {
        if (args.some((w) => /^-\w*[si]\w*$|^--(shell|login)$/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, "runs a shell through sudo, which patch trust can't follow.");
          return { words: [], extra: false };
        }
        return { words: args.slice(val(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'])), extra: false };
      }
      case 'env': {
        let i = 0;
        for (; i < args.length; i++) {
          const s = this.str(args[i], ctx);
          if (s === undefined) break;
          if (/^(-S|--split-string|-C|--chdir)/.test(s)) {
            this.fail(ctx, line, `runs \`env ${s}\`, which patch trust doesn't follow.`);
            return { words: [], extra: false };
          }
          if (s === '-u' || s === '--unset') {
            i++;
            continue;
          }
          if (s.startsWith('-')) continue;
          const as = this.assignment(args[i]!);
          if (!as) break;
          this.assign(as.name, as.value, as.append, { ...ctx, vars: new Map(ctx.vars) }, line);
          if (this.problem) return { words: [], extra: false };
        }
        return { words: args.slice(i), extra: false };
      }
      case 'xargs': {
        const i = val(['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-J', '-R', '-S']);
        if (args.slice(0, i).some((w) => /^-a$|^--arg-file/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, "runs xargs with arguments from a file, which patch trust doesn't follow.");
          return { words: [], extra: false };
        }
        return { words: args.slice(i), extra: true };
      }
      case 'watch':
        return { words: args.slice(val(['-n', '--interval'])), extra: false };
    }
    return undefined;
  }

  private shellRun(name: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, `runs ${name} with a script worked out as it runs, which patch trust can't follow.`);
      if (s === '--') {
        const file = this.str(args[i + 1], ctx);
        return file === undefined ? this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`) : this.runFile(file, ctx, line);
      }
      if (/^[-+][a-zA-Z]*o$/.test(s) || s === '-O' || s === '+O') {
        i++;
        continue;
      }
      // bash's options that take a file: it's sourced, not the script
      // (taking it for the script missed a `-s` after it: Codex's review).
      if (s === '--rcfile' || s === '--init-file') {
        const rc = this.str(args[++i], ctx);
        if (rc === undefined) return this.fail(ctx, line, `runs ${name} with an rc file worked out as it runs, which patch trust can't follow.`);
        const rcs = this.abs(rc, ctx) ?? [];
        if (rc === '-' || rcs.some(readsInput)) return this.fail(ctx, line, `runs ${name} with an rc file that reads from its input or another open file, which patch trust can't follow.`);
        for (const t of rcs) if (isFile(t)) this.follow(t, 'source', ctx, line);
        continue;
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(s)) {
        const code = args[i + 1] ? litOf(args[i + 1]!) : undefined;
        if (code === undefined) return this.fail(ctx, line, `runs \`${name} -c\` with code worked out as it runs, which patch trust can't follow.`);
        return this.shell(code, { ...ctx, argv0: [], vars: new Map(), dirs: new Set(ctx.dirs) }, line);
      }
      if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(s)) return this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
      if (s.startsWith('-') || s.startsWith('+')) continue;
      return this.runFile(s, ctx, line);
    }
    this.fail(ctx, line, `runs ${name} reading what to run from its input${extra ? ' (from xargs)' : ' (a pipe or a here-doc)'}, which patch trust can't follow.`);
  }

  private runFile(file: string, ctx: Ctx, line: number): void {
    // `-` as the file (`node -- -`, `sh -- -`) is the input, whatever file
    // is called that.
    if (file === '-') return this.fail(ctx, line, `runs \`-\`, which reads what to run from its input, which patch trust can't follow.`);
    const tries = this.abs(file, ctx);
    if (!tries) return this.fail(ctx, line, `runs ${file} after a cd patch trust couldn't follow (${ctx.lost}).`);
    // `sh /dev/stdin < ./steps.txt` runs steps.txt, which a hash of the
    // script doesn't cover: refused, as `sh < ./steps.txt` is (Gautam's
    // scan, 6 Nov).
    if (tries.some(readsInput)) return this.fail(ctx, line, `runs ${file}, which reads what to run from its input, which patch trust can't follow.`);
    const inRepo = tries.filter((t) => this.inRepo(t));
    if (!inRepo.length) return; // a program outside the repo
    const found = inRepo.filter(isFile);
    for (const t of inRepo) if (!isFile(t) && this.missing.size < 500) this.missing.add(t);
    if (!found.length) return this.fail(ctx, line, `runs ${file}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
    for (const t of found) this.follow(t, 'run', ctx, line);
  }

  private jsRun(name: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    let i = 0;
    // bun and deno have subcommands; `bun x`/`bun run x`/`bun x.ts`.
    if (name === 'bun' || name === 'deno') {
      while (i < args.length && (this.str(args[i], ctx) ?? '').startsWith('-')) i++;
      const sub = this.str(args[i], ctx);
      if (sub === undefined) return args[i] ? this.fail(ctx, line, `runs ${name} with a subcommand worked out as it runs, which patch trust can't follow.`) : this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
      if (name === 'deno') {
        if (sub === 'task' || sub === 'eval') return this.fail(ctx, line, `runs \`deno ${sub}\`, which patch trust doesn't follow.`);
        if (sub !== 'run') {
          if (this.isScriptPath(sub, ctx)) return this.runFile(sub, ctx, line);
          return this.o.strict ? this.fail(ctx, line, `runs \`deno ${sub}\`, which finds what to run by its own rules.`) : undefined;
        }
        i++;
      } else {
        if (['install', 'i', 'add', 'a', 'update', 'link', 'pm'].includes(sub)) return this.lifecycle(ctx, line);
        if (sub === 'x') return this.npx(args.slice(i + 1), ctx, line);
        if (['test', 'build', 'create', 'init', 'upgrade', 'outdated', 'publish', 'patch', 'remove', 'rm', 'repl', 'help', 'completions', 'audit', 'info', 'why'].includes(sub)) {
          if (this.o.strict && ['test', 'build', 'create', 'init', 'upgrade', 'publish', 'patch', 'repl'].includes(sub)) return this.fail(ctx, line, `runs \`bun ${sub}\`, which finds what to run by its own rules.`);
          return;
        }
        if (sub === 'run') i++;
        while (i < args.length && (this.str(args[i], ctx) ?? '').startsWith('-')) i++;
        const target = this.str(args[i], ctx);
        if (target === undefined) return args[i] ? this.fail(ctx, line, `runs bun with a target worked out as it runs, which patch trust can't follow.`) : undefined;
        if (this.isScriptPath(target, ctx)) {
          // Bun loads bunfig.toml (its preloads) before the script.
          if (this.o.strict && [...ctx.dirs].some((d) => { for (let x = d; this.inRepo(x); x = path.dirname(x)) { if (isFile(path.join(x, 'bunfig.toml'))) return true; if (x === this.o.top) break; } return false; })) return this.fail(ctx, line, 'runs bun beside a bunfig.toml, whose preloads run first by their own rules.');
          return this.runFile(target, ctx, line);
        }
        return this.packageScript(target, ctx, line);
      }
    }
    for (; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, `runs ${name} with a file worked out as it runs, which patch trust can't follow.`);
      if (s === '--') {
        i++;
        break;
      }
      // An env file can set NODE_OPTIONS to load other code.
      if (/^--env-file(-if-exists)?(=|$)/.test(s)) return this.fail(ctx, line, `runs ${name} with an env file, which can make it load code patch trust can't follow.`);
      // `node -` reads its program from its input, whatever follows.
      if (s === '-') return this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
      if (/^(-e|--eval|-p|--print)$/.test(s) || /^--(eval|print)=/.test(s)) return this.fail(ctx, line, `runs ${name} with code on its command line, which patch trust doesn't follow.`);
      const load = /^(-r|--require|--import|--loader|--experimental-loader|--preload)(?:=(.*))?$/.exec(s);
      if (load) {
        const v = load[2] ?? this.str(args[++i], ctx);
        if (v === undefined) return this.fail(ctx, line, `runs ${name} loading a module worked out as it runs, which patch trust can't follow.`);
        if (/^\.{0,2}\//.test(v) || v.startsWith('file:')) this.runFile(v.replace(/^file:\/\//, ''), ctx, line);
        // As a module's own import of them is refused (scanModule): a `#`
        // maps through package.json to a file this doesn't follow, and a
        // URL's code isn't a file at all.
        else if (v.startsWith('#') || (/^[a-z]+:/i.test(v) && !v.startsWith('node:'))) return this.fail(ctx, line, `runs ${name} loading ${v.slice(0, 40)}, which a hash can't follow.`);
        // A package, loaded before the script: as a bare import is.
        else {
          for (const d of ctx.lost ? [] : ctx.dirs) this.barePackage(d, v, ctx, ctx.label);
          if (this.problem) return;
        }
        continue;
      }
      // Symlinks kept as named change which files a module's imports are.
      if (this.o.strict && /^--preserve-symlinks(-main)?$/.test(s)) return this.fail(ctx, line, `runs ${name} keeping symlinked paths, which changes which files it loads.`);
      // An env file can set NODE_OPTIONS, which loads more code.
      if (this.o.strict && /^--env-file(-if-exists)?(=|$)/.test(s)) return this.fail(ctx, line, `runs ${name} with an env file, which can load code by its own rules.`);
      if (/^(--env-file|--env-file-if-exists|--conditions|-C|--input-type|--title|--test-reporter|--test-name-pattern|--watch-path|--cpu-prof-dir|--heap-prof-dir|--diagnostic-dir|--redirect-warnings|--tsconfig|--project|-P)$/.test(s)) {
        i++;
        continue;
      }
      if (s.startsWith('-')) continue;
      break;
    }
    const file = this.str(args[i], ctx);
    if (file === undefined) {
      if (args.some((w) => litOf(w) === '--test')) {
        // node's test runner finding tests
        if (this.o.strict) return this.fail(ctx, line, `runs ${name}'s test runner, which finds its own tests to run, so a hash can't cover them.`);
        return;
      }
      return this.fail(ctx, line, `runs ${name} reading what to run from its input${extra ? ' (from xargs)' : ''}, which patch trust can't follow.`);
    }
    this.runFile(file, ctx, line);
  }

  private isScriptPath(s: string, ctx: Ctx): boolean {
    if (/^\.{0,2}\//.test(s) || JS_EXT.includes(path.extname(s)) || SHELL_EXT.includes(path.extname(s))) return true;
    return (this.abs(s, ctx) ?? []).some(isFile);
  }

  // The package.json a package manager in `ctx`'s folders would use, and
  // the config next to it that can load code (.npmrc, bunfig.toml...).
  private packages(ctx: Ctx, line: number): { dir: string; pkg: Record<string, any> }[] | undefined {
    if (ctx.lost) {
      this.fail(ctx, line, `runs a package script after a cd patch trust couldn't follow (${ctx.lost}), so it can't tell which package.json.`);
      return undefined;
    }
    const out: { dir: string; pkg: Record<string, any> }[] = [];
    for (const start of ctx.dirs) {
      this.committedPackages(start, ctx, line);
      if (this.problem) return undefined;
      for (let d = start; this.inRepo(d); d = path.dirname(d)) {
        for (const rc of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.pnpmfile.cjs', 'pnpm-workspace.yaml']) {
          const f = path.join(d, rc);
          if (!isFile(f)) continue;
          this.follow(f, 'load', ctx);
          this.rcLoads(f, ctx);
        }
        const f = path.join(d, 'package.json');
        if (isFile(f)) {
          this.follow(f, 'load', ctx);
          try {
            out.push({ dir: d, pkg: JSON.parse(this.text(f) ?? '') as Record<string, any> });
          } catch {
            this.fail(ctx, line, `runs a package script, and ${this.rel(f)} can't be read, so patch trust can't tell what it runs.`);
            return undefined;
          }
          break;
        }
        if (this.missing.size < 500) this.missing.add(f);
        if (d === this.o.top || path.dirname(d) === d) break;
      }
    }
    return out;
  }

  // Code a package manager's config loads: yarn's yarnPath and plugins,
  // bun's preload, pnpm's .pnpmfile.cjs (followed as it is).
  //
  // Read a line at a time, each tested from its own start: `/^\s*x/m` over
  // the whole file restarted at every newline and ran on through all the
  // blank lines after it, so an .npmrc of a few MB of newlines held the
  // runner for minutes, before anyone was asked anything (Gautam's scan,
  // 6 Nov). Once per file per hash (Reads.parsed), and one too big for a
  // config file fails closed.
  private rcLoads(file: string, ctx: Ctx): void {
    const base = path.basename(file);
    if (base === '.pnpmfile.cjs') return;
    const rc = this.config(file, 'rc', (text) => rcConfig(base, text));
    if (!rc) return;
    if ('problem' in rc && rc.problem) return this.fail(undefined, undefined, `${this.rel(file)} ${rc.problem}`);
    if (!('paths' in rc)) return;
    for (const s of rc.paths) {
      const p = path.resolve(path.dirname(file), s);
      if (isFile(p)) this.follow(p, 'load', ctx);
    }
  }

  // A config file's text read once by `parse`, kept on the shared Reads;
  // undefined when it can't be read. One over MAX_CONFIG_BYTES isn't
  // parsed: `problem` says so.
  private config<T extends object>(file: string, kind: string, parse: (text: string) => T): T | { problem: string } | undefined {
    const real = this.reads.real(file);
    if (real === undefined) return undefined;
    const key = `${kind}\u0000${real}`;
    if (this.reads.parsed.has(key)) return this.reads.parsed.get(key) as T | { problem: string };
    const bytes = this.reads.read(real);
    if (!bytes) return undefined;
    const out = bytes.length > MAX_CONFIG_BYTES ? { problem: `is over ${MAX_CONFIG_BYTES / 1024} KB, more than patch trust reads of a config file.` } : parse(this.reads.text(real) ?? '');
    this.reads.parsed.set(key, out);
    return out;
  }

  private scriptsOf(pkg: Record<string, any>): Record<string, string> {
    const s = pkg.scripts;
    return s && typeof s === 'object' ? (s as Record<string, string>) : {};
  }

  private runScripts(dir: string, pkg: Record<string, any>, names: string[], ctx: Ctx): void {
    const scripts = this.scriptsOf(pkg);
    if (ctx.depth + 1 > MAX_DEPTH) return this.fail(ctx, undefined, `runs scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    for (const n of names) {
      const text = scripts[n];
      const key = `script ${dir} ${n}`;
      if (typeof text !== 'string' || this.visits.has(key)) continue;
      this.visits.add(key);
      // A package script runs through sh in the package's folder, with its
      // node_modules/.bin (and those of the folders above) first on PATH.
      const outer = this.binDirs;
      this.binDirs = [dir];
      try {
        this.shell(text, { label: `${this.rel(path.join(dir, 'package.json'))}'s "${n}" script`, file: path.join(dir, 'package.json'), argv0: [], dirs: new Set([dir]), vars: new Map(), depth: ctx.depth + 1 });
      } finally {
        this.binDirs = outer;
      }
    }
  }

  // `npm run x`, `yarn x`, `bun x`: the script by that name, and what runs
  // before and after it. Without one, it's a package's bin: installed, as
  // the package.json's versions pin, or one of the repo's (repoBin).
  private packageScript(name: string, ctx: Ctx, line: number): void {
    const pkgs = this.packages(ctx, line);
    if (!pkgs) return;
    // One that isn't there runs something by default (npm start runs
    // server.js; pnpm and yarn a package's bin of that name).
    if (this.o.strict && !pkgs.some(({ pkg }) => typeof pkg?.scripts?.[name] === 'string')) {
      return this.fail(ctx, line, `runs the package script ${name}, which isn't in package.json, so what runs instead is worked out by the package manager.`);
    }
    if (!pkgs.some(({ pkg }) => typeof pkg?.scripts?.[name] === 'string')) {
      const bin = this.repoBin(name, ctx.dirs);
      if (bin) return this.follow(bin, 'run', ctx, line);
    }
    for (const { dir, pkg } of pkgs) this.runScripts(dir, pkg, [`pre${name}`, name, `post${name}`], ctx);
  }

  // An install runs the package's own lifecycle scripts, and its
  // workspaces' and local (file:) dependencies'.
  private lifecycle(ctx: Ctx, line: number): void {
    const pkgs = this.packages(ctx, line);
    if (!pkgs) return;
    for (const { dir, pkg } of pkgs) {
      this.runScripts(dir, pkg, LIFECYCLE, ctx);
      this.committedLifecycle(dir, ctx, line);
      for (const sub of this.localPackages(dir, pkg)) {
        const f = path.join(sub, 'package.json');
        if (!isFile(f) || !this.inRepo(f)) continue;
        this.follow(f, 'load', ctx);
        try {
          this.runScripts(sub, JSON.parse(this.text(f) ?? '') as Record<string, any>, LIFECYCLE, ctx);
        } catch {
          this.fail(ctx, line, `installs ${this.rel(f)}, which can't be read, so patch trust can't tell what it runs.`);
        }
      }
    }
  }

  private localPackages(dir: string, pkg: Record<string, any>): string[] {
    const out = new Set<string>();
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : [];
    const yaml = path.join(dir, 'pnpm-workspace.yaml');
    if (isFile(yaml)) {
      // A line at a time, as rcLoads reads; too big a file is refused there
      // (packages() follows it first), and gives nothing here.
      const listed = this.config(yaml, 'pnpm-workspace', (text) => ({ items: yamlListItems(text) }));
      ws.push(...(listed && 'items' in listed ? listed.items : []));
    }
    for (const pattern of ws) {
      if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
      try {
        for (const m of fs.globSync(pattern, { cwd: dir })) out.add(path.resolve(dir, m));
      } catch {
        // an odd pattern: nothing found
      }
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const v of Object.values((pkg[field] ?? {}) as Record<string, unknown>)) {
        const m = typeof v === 'string' ? /^(?:file|link|portal):(.+)$/.exec(v) : null;
        if (m) out.add(path.resolve(dir, m[1]!));
      }
    }
    return [...out].slice(0, 50);
  }

  private pkgRun(tool: string, args: Word[], ctx: Ctx, line: number): void {
    let i = 0;
    let local = ctx;
    for (; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, `runs ${tool} with words worked out as it runs, which patch trust can't follow.`);
      if (/^(-w|--workspace|-ws|--workspaces|--filter|-F|-r|--recursive)(=|$)/.test(s)) return this.fail(ctx, line, `runs ${tool} across workspaces (${s}), which patch trust doesn't follow.`);
      const dirOpt = /^(--prefix|-C|--dir|--cwd)(?:=(.*))?$/.exec(s);
      if (dirOpt) {
        const v = dirOpt[2] ?? this.str(args[++i], ctx);
        const to = v === undefined ? undefined : this.abs(v, ctx);
        if (!to) return this.fail(ctx, line, `runs ${tool} in a folder worked out as it runs, which patch trust can't follow.`);
        local = { ...ctx, dirs: new Set(to) };
        continue;
      }
      if (!s.startsWith('-')) break;
    }
    const sub = this.str(args[i], ctx);
    const rest = args.slice(i + 1);
    const nameAfter = () => {
      for (const w of rest) {
        const s = this.str(w, local);
        if (s === undefined) return undefined;
        if (!s.startsWith('-')) return s;
      }
      return '';
    };
    if (sub === undefined) {
      if (tool === 'yarn' && !args[i]) return this.lifecycle(local, line);
      return;
    }
    if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
      const n = nameAfter();
      if (n === undefined) return this.fail(ctx, line, `runs \`${tool} run\` with a script name worked out as it runs, which patch trust can't follow.`);
      if (!n) return;
      return this.packageScript(n, local, line);
    }
    if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(sub)) return this.packageScript(sub === 't' || sub === 'tst' ? 'test' : sub, local, line);
    if (['install', 'i', 'ci', 'add', 'isntall', 'in', 'install-test', 'it', 'update', 'up', 'upgrade', 'rebuild', 'rb', 'pack', 'publish', 'install-ci-test', 'cit'].includes(sub)) {
      this.lifecycle(local, line);
      if (['install-test', 'it', 'install-ci-test', 'cit'].includes(sub)) this.packageScript('test', local, line);
      return;
    }
    if (['exec', 'x', 'dlx'].includes(sub)) return this.npx(rest, local, line);
    if (tool === 'npm') return; // npm's own commands
    // pnpm and yarn run a script by its bare name, else a package's bin.
    this.packageScript(sub, local, line);
  }

  private npx(args: Word[], ctx: Ctx, line: number): void {
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, "runs a package worked out as it runs, which patch trust can't follow.");
      // However npm reads it: it takes a shortened name, and `=`.
      const call = /^(-c|--(?:c|ca|cal|call))(=|$)/.exec(s);
      if (call) {
        const whole = litOf(args[i]!);
        const code = call[2] === '=' ? whole?.slice(call[1]!.length + 1) : args[i + 1] ? litOf(args[i + 1]!) : undefined;
        if (code === undefined) return this.fail(ctx, line, "runs `npx -c` with code worked out as it runs, which patch trust can't follow.");
        // Run as a package script is: with what the repo commits hashed,
        // and its node_modules/.bin first on PATH.
        this.packages(ctx, line);
        if (this.problem) return;
        const outer = this.binDirs;
        this.binDirs = [...outer, ...ctx.dirs];
        try {
          return this.shell(code, { ...ctx, argv0: [], vars: new Map(), dirs: new Set(ctx.dirs) }, line);
        } finally {
          this.binDirs = outer;
        }
      }
      if (s === '-p' || s === '--package') {
        i++;
        continue;
      }
      if (s.startsWith('-')) continue;
      if (/^\.{0,2}\//.test(s)) return this.runFile(s, ctx, line);
      if (this.o.strict) return this.fail(ctx, line, `runs the package ${s} by name (npx or the like), which runs whatever that name resolves to then, so a hash can't cover it.`);
      // A package: its version is the package.json's, what the repo commits
      // is hashed (packages), and a bin of the repo's own runs as a script.
      this.packages(ctx, line);
      if (this.problem || ctx.lost) return;
      const bin = this.repoBin(s, ctx.dirs);
      if (bin) this.follow(bin, 'run', ctx, line);
      return;
    }
  }

  private make(args: Word[], ctx: Ctx, line: number): void {
    let dirs = ctx.lost ? undefined : [...ctx.dirs];
    // Every -f: make reads them all (only the last was followed: Codex's review).
    const files: string[] = [];
    const incDirs: string[] = [];
    // `-C dir`, `-f file`, as their own word, after `=` or run on (`-fx.mk`,
    // `-f-`), or last in a bunch of flags (`-sf x.mk`), as getopt reads
    // them; any other of make's flags that takes a value ends the bunch.
    const opt = (s: string): { flag: 'C' | 'f' | 'I'; value?: string } | undefined => {
      const long = /^--(directory|file|makefile|include-dir)(?:=(.*))?$/.exec(s);
      if (long) return { flag: long[1] === 'directory' ? 'C' : long[1] === 'include-dir' ? 'I' : 'f', ...(long[2] !== undefined ? { value: long[2] } : {}) };
      if (!/^-[^-]/.test(s)) return undefined;
      for (let k = 1; k < s.length; k++) {
        const c = s[k]!;
        if (c === 'C' || c === 'f') return { flag: c, ...(k + 1 < s.length ? { value: s.slice(k + 1) } : {}) };
        if (c === 'I') return { flag: 'I', ...(k + 1 < s.length ? { value: s.slice(k + 1) } : {}) };
        if ('oWjlO'.includes(c)) return undefined;
      }
      return undefined;
    };
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, "runs make with words worked out as it runs, which patch trust can't follow.");
      const v = opt(s);
      if (v) {
        const val = v.value ?? this.str(args[++i], ctx);
        if (val === undefined) return this.fail(ctx, line, "runs make with a folder or file worked out as it runs, which patch trust can't follow.");
        // Each -C from the one before (`-C sub -C nested` is sub/nested).
        if (v.flag === 'C') dirs = dirs && (path.isAbsolute(val) ? [path.normalize(val)] : dirs.map((d) => path.resolve(d, val)));
        // `-f -` reads the Makefile from make's input, as `sh < file` does.
        // -I: the folders an include is looked for in, after the Makefile's.
        else if (v.flag === 'I') incDirs.push(val);
        else if (val === '-') return this.fail(ctx, line, "runs make reading its Makefile from its input, which patch trust can't follow.");
        else files.push(val);
      }
    }
    if (!dirs) return this.fail(ctx, line, `runs make after a cd patch trust couldn't follow (${ctx.lost}).`);
    for (const d of dirs) {
      if (files.length) {
        for (const f of files) {
          const t = path.resolve(d, f);
          if (readsInput(t)) return this.fail(ctx, line, `runs make with ${f}, which reads what to run from its input or another open file, which patch trust can't follow.`);
          if (isFile(t)) this.makefile(t, d, ctx, line, incDirs);
          else if (this.inRepo(t)) return this.fail(ctx, line, `runs make with ${f}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
        }
        continue;
      }
      const tries = ['GNUmakefile', 'makefile', 'Makefile'].map((n) => path.join(d, n));
      // A Makefile that's a link to the input reads the redirected file.
      if (tries.some(readsInput)) return this.fail(ctx, line, "runs make with a Makefile that reads from its input or another open file, which patch trust can't follow.");
      const found = tries.find(isFile);
      for (const t of tries) if (!isFile(t) && this.inRepo(t) && this.missing.size < 500) this.missing.add(t);
      if (found) this.makefile(found, d, ctx, line, incDirs);
    }
  }

  // A Makefile's recipes are shell commands with make's $(VAR)s in them.
  private makefile(file: string, dir: string, ctx: Ctx, line: number, incDirs: string[] = []): void {
    if (!this.inRepo(file)) return;
    const real = this.reads.real(file);
    if (real === undefined) return;
    this.files.add(real);
    const key = `make ${file}`;
    if (this.visits.has(key)) return;
    this.visits.add(key);
    const label = this.rel(file);
    const mctx: Ctx = { label, file, argv0: [], dirs: new Set([dir]), vars: new Map(), depth: ctx.depth + 1 };
    // Its lines, once per file per hash, each tested on its own: a
    // multiline `/^\s*SHELL=/m` over the whole text was quadratic in a run
    // of blank lines (Gautam's scan, 6 Nov).
    const mk = this.config(file, 'make', (text): { lines: string[]; text: string } | { problem: string } => {
      const lines = text.split('\n');
      return lines.some(setsMakeShell) ? { problem: "runs commands a way patch trust can't follow ($(shell ...), `!=`, or its own SHELL)." } : { lines, text };
    });
    if (!mk) return;
    if (!('lines' in mk)) return this.fail(mctx, undefined, mk.problem);
    const { lines, text } = mk;
    if (this.o.strict && /\.RECIPEPREFIX/.test(text)) return this.fail(mctx, undefined, 'sets .RECIPEPREFIX, so its recipes are lines this doesn\'t read as recipes.');
    let recipe = '';
    for (const [n, raw] of lines.entries()) {
      const inc = /^\s*-?(?:include|sinclude)\s+(.+)$/.exec(raw);
      if (inc) {
        for (const f of inc[1]!.trim().split(/\s+/)) {
          if (/[$*?]/.test(f)) return this.fail(mctx, n + 1, "includes a makefile worked out as it runs, which patch trust can't follow.");
          // Where make looks: the folder, then each -I folder in turn.
          const where = path.isAbsolute(f) ? [f] : [dir, ...incDirs.map((i) => path.resolve(dir, i))].map((b) => path.resolve(b, f));
          if (f === '-' || where.some(readsInput)) return this.fail(mctx, n + 1, "includes a makefile that reads from its input or another open file, which patch trust can't follow.");
          const p = where.find(isFile);
          if (p) this.makefile(p, dir, ctx, line, incDirs);
          else for (const w of where) if (this.missing.size < 500) this.missing.add(w);
        }
        continue;
      }
      if (!raw.startsWith('\t')) {
        // A rule's recipe can follow a `;` on its own line (`all: ; ./x.sh`).
        const inline = inlineRecipe(raw);
        if (inline !== undefined) {
          this.shell(makeRecipeToShell(inline.replace(/^[ \t]*[@+-]*/, '')), mctx, n + 1);
          if (this.problem) return;
        }
        continue;
      }
      recipe = raw.slice(1).replace(/^[@+-]+/, '');
      this.shell(makeRecipeToShell(recipe), mctx, n + 1);
      if (this.problem) return;
    }
    this.namedIn(text, file, mctx);
  }

  private awk(args: Word[], ctx: Ctx, line: number): void {
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === '-f' || s?.startsWith('--file')) return this.fail(ctx, line, "runs an awk program from a file, which patch trust doesn't follow.");
      if (s === '-F' || s === '-v') {
        i++;
        continue;
      }
      if (s?.startsWith('-')) continue;
      const prog = args[i] ? litOf(args[i]!) : undefined;
      if (prog === undefined) return this.fail(ctx, line, "runs an awk program worked out as it runs, which patch trust can't follow.");
      if (/\bsystem\s*\(|\|\s*getline|\|\s*&/.test(prog) || awkPrintsToCommand(prog)) return this.fail(ctx, line, "runs an awk program that runs commands, which patch trust doesn't follow.");
      return;
    }
  }
}

// The most of a package manager's config, a pnpm-workspace.yaml or a
// Makefile that patch trust reads; a bigger one fails closed.
export const MAX_CONFIG_BYTES = 1024 * 1024;

// .npmrc keys that make npm run a shell or load code.
const NPM_LOADERS = new Set(['script-shell', 'node-options', 'onload-script']);

// What an rc file loads: the paths of files it may run (yarn's yarnPath and
// plugins, bun's preload: every quoted string, and a `yarnPath:` or `path:`
// value, on its line or, YAML-style, the next), or `problem` for an .npmrc
// that sets npm's shell or code. A line at a time, and each test anchored
// to that line's own start, so the work is linear in the text.
export function rcConfig(base: string, text: string): { paths: string[]; problem?: string } {
  const paths: string[] = [];
  const odd = (what: string) => ({ paths, problem: `has ${what}, which patch trust doesn't read, so it can't tell what it loads.` });
  let pending = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (base === '.npmrc' && NPM_LOADERS.has(npmKey(line))) return { paths, problem: "sets a shell or code for npm to load, which patch trust can't follow." };
    for (const m of line.matchAll(/["']([^"'\n]+)["']/g)) {
      // An escape (YAML's and TOML's `"\u002e/x.cjs"` is `./x.cjs`) is
      // read as JSON reads one; one it can't read fails closed.
      // As written too: a single-quoted YAML string keeps its backslashes.
      paths.push(m[1]!);
      if (!m[1]!.includes('\\')) continue;
      try {
        paths.push(JSON.parse(`"${m[1]!.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`) as string);
      } catch {
        return odd(`an escaped string (${m[0].slice(0, 60)})`);
      }
    }
    // A list item's key too: yarn's `plugins:` are `- path: .yarn/plugins/x.cjs`.
    const keyed = line.startsWith('- ') ? line.slice(2).trimStart() : line;
    if (pending && keyed && !keyed.startsWith('#')) {
      if (/^[!&*|>{[]/.test(keyed)) return odd(`a YAML value it can't read (${keyed.slice(0, 40)})`);
      const v = /^["']?([^"'\s#]+)/.exec(keyed);
      if (v) paths.push(v[1]!);
      pending = false;
    }
    // Yarn Classic's .yarnrc: `yarn-path ./x.cjs`, a space for the colon.
    const y = /^(["']?)(?:yarnPath|path|yarn-path)\1(?:[ \t]*:|[ \t]+)(.*)$/.exec(keyed);
    // A path key inside a flow value (`plugins: [{path: x}]`) isn't read.
    if (!y && /[{[]/.test(keyed) && /path/i.test(keyed)) return odd(`a YAML flow value it can't read (${keyed.slice(0, 40)})`);
    if (y) {
      const rest = y[2]!.trimStart();
      // A tag, anchor, alias, block or flow value: not a plain path.
      if (/^[!&*|>{[]/.test(rest)) return odd(`a YAML value it can't read (${rest.slice(0, 40)})`);
      const v = /^["']?([^"'\s#]+)/.exec(rest);
      if (v) paths.push(v[1]!);
      else pending = true;
    }
  }
  return { paths };
}

// An .npmrc line's key as npm's ini reader takes it (quotes off), in one
// spelling (lower case, `-` for `_`), or '' for a comment.
export function npmKey(line: string): string {
  if (line.startsWith('#') || line.startsWith(';')) return '';
  const eq = line.indexOf('=');
  let key = (eq < 0 ? line : line.slice(0, eq)).trim();
  if (key.length > 1 && (key[0] === '"' || key[0] === "'") && key.at(-1) === key[0]) key = key.slice(1, -1);
  return key.toLowerCase().replaceAll('_', '-');
}

// The `- item` entries of a YAML list (pnpm-workspace.yaml's packages),
// unquoted, a comment after one dropped. No regex: a lazy match before
// `\s*$` was quadratic in a line of spaces.
export function yamlListItems(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (!line.startsWith('-')) continue;
    let item = line.slice(1);
    const hash = item.indexOf('#');
    if (hash >= 0) item = item.slice(0, hash);
    item = item.trim();
    if (item.length > 1 && (item[0] === '"' || item[0] === "'") && item.at(-1) === item[0]) item = item.slice(1, -1);
    if (item) out.push(item);
  }
  return out;
}

// Whether a Makefile line sets the shell make runs recipes with (SHELL or
// .SHELLFLAGS, after `export` or `override`, or for a target: `t: SHELL =
// x`), or runs a command as make reads it (`$(shell ...)`). A recipe line's
// own `SHELL=` is the shell's business. Scanned by hand, so it's linear.
export function setsMakeShell(raw: string): boolean {
  if (raw.startsWith('\t')) return /\$[({]shell(\s|$)/.test(raw);
  const line = withoutMakeComment(raw);
  if (/\$[({]shell(\s|$)/.test(line)) return true;
  // `X != cmd` runs cmd as make reads the line (GNU make 4).
  if (line.includes('!=')) return true;
  // .RECIPEPREFIX changes what starts a recipe line, so recipes would be
  // read as something else: refused with the shell's own settings.
  for (const name of ['SHELL', '.SHELLFLAGS', '.RECIPEPREFIX']) {
    for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1)) {
      if (i > 0 && !' \t\r:;'.includes(line[i - 1]!)) continue;
      let j = i + name.length;
      while (line[j] === ' ' || line[j] === '\t') j++;
      let ops = 0;
      while (ops < 3 && j < line.length && ':+?!'.includes(line[j]!)) {
        j++;
        ops++;
      }
      if (line[j] === '=') return true;
    }
  }
  return false;
}

// A Makefile line before its comment (an unescaped #).
function withoutMakeComment(line: string): string {
  for (let i = line.indexOf('#'); i >= 0; i = line.indexOf('#', i + 1)) {
    if (line[i - 1] !== '\\') return line.slice(0, i);
  }
  return line;
}

// The recipe after a rule's `;` (`all: deps ; cmd`), or undefined when the
// line isn't a rule with one. Not an assignment (`x := a; b`).
export function inlineRecipe(raw: string): string | undefined {
  const line = withoutMakeComment(raw);
  const colon = line.indexOf(':');
  if (colon < 0 || line[colon + 1] === '=' || line.slice(0, colon).includes('=')) return undefined;
  const semi = line.indexOf(';', colon);
  return semi < 0 ? undefined : raw.slice(semi + 1);
}

// A recipe line as shell: `$$` is a `$`, `$(MAKE)` is make, and any other
// make variable or function (`$(X)`, `${X}`, `$@`) a variable the shell
// can't know. One pass, each `$(` finding its `)` from a pointer that only
// moves on: a regex that scanned to the line's end from every unclosed
// `$(` was quadratic.
export function makeRecipeToShell(recipe: string): string {
  let out = '';
  let close = 0; // the next ) or } at or after where it was last needed
  for (let i = 0; i < recipe.length; ) {
    const c = recipe[i]!;
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    const n = recipe[i + 1];
    if (n === '$') {
      out += '$';
      i += 2;
    } else if (n === '(' || n === '{') {
      if (close < i + 2) close = i + 2;
      while (close < recipe.length && recipe[close] !== ')' && recipe[close] !== '}') close++;
      if (close >= recipe.length) {
        out += '$';
        i++;
        continue;
      }
      out += recipe.slice(i + 2, close) === 'MAKE' ? 'make' : '$__make_variable';
      i = close + 1;
    } else if (n !== undefined && /[A-Za-z@<^?*%+|]/.test(n)) {
      out += '$__make_variable';
      i += 2;
    } else {
      out += '$';
      i++;
    }
  }
  return out;
}

// `p`'s real path, or, when it isn't there, its nearest folder that is,
// real, with the rest after it.
function realOrNearest(p: string): string {
  let rest = '';
  for (let d = p; ; d = path.dirname(d)) {
    try {
      return path.join(fs.realpathSync(d), rest);
    } catch {
      // not there: one up
    }
    if (path.dirname(d) === d) return p;
    rest = rest ? path.join(path.basename(d), rest) : path.basename(d);
  }
}

// Paths that are a process's input or another file it has open: a shell
// or Node given one reads its program from whatever was redirected there
// (`sh /dev/stdin < ./steps.txt`), which isn't the path it was given.
const INPUT_PATH = /^\/(dev\/(stdin|tty|fd\/\d+)|proc\/(self|thread-self|\d+)\/fd\/\d+)$/;

// Whether running or sourcing `p` reads what to run from the process's
// input: one of those paths, or anything there that isn't a plain file
// (a link to one, in the repo or not, a fifo, a device).
export function readsInput(p: string): boolean {
  if (INPUT_PATH.test(path.normalize(p))) return true;
  try {
    if (INPUT_PATH.test(fs.realpathSync(p))) return true;
  } catch {
    // not there, or a link to nowhere
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return false; // not there: a program that isn't installed
  }
  return !st.isFile() && !st.isDirectory();
}

// Whether a shell script's #! passes the shell a flag that has it read
// commands from somewhere other than the script.
export function shebangReadsElsewhere(text: string): boolean {
  const m = /^#![ \t]*(\S+)([^\n]*)/.exec(text);
  if (!m) return false;
  const words = m[2]!.trim().split(/[ \t]+/).filter(Boolean);
  if (path.basename(m[1]!) === 'env' && words.some((w) => /^(-[a-zA-Z]*S|--split-string)/.test(w))) return true;
  return words.some((w) => /^[-+][a-zA-Z]*[sci]/.test(w));
}

// Whether an awk program pipes a print into a command (`print x | "sh"`):
// a `|` (not `||`) after a print in the same statement. Statement by
// statement, so it's linear: `print[^;}]*\|` scanned on from every print.
function awkPrintsToCommand(prog: string): boolean {
  for (const st of prog.split(/[;}\n]/)) {
    const at = st.indexOf('print');
    if (at < 0) continue;
    const rest = st.slice(at);
    for (let i = rest.indexOf('|'); i >= 0; i = rest.indexOf('|', i + 1)) {
      if (rest[i + 1] === '|' || rest[i - 1] === '|') continue;
      return true;
    }
  }
  return false;
}

// A missing path in a command's place that could turn up as a program.
function mayRun(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return !ext || RUNNABLE_EXT.includes(ext);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// A name no package has, for "any bare import" (bareImport's answer doesn't
// depend on which, only that it isn't a builtin).
const ANY_PACKAGE = 'any-package';

// Whether a file's start has a NUL: a program, not a script.
export function isBinary(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const buf = Buffer.alloc(512);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 512, 0)).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// How a file runs: by its #! line, else its extension. A file run with no
// #! goes to sh, so it's a shell script then.
export function kindOf(file: string, text: string, running: boolean): 'shell' | 'js' | 'binary' | 'other' {
  if (text.slice(0, 512).includes('\0')) return 'binary';
  const shebang = /^#!\s*(\S+)(?:\s+(.*))?/.exec(text);
  if (shebang) {
    const prog = path.basename(shebang[1]!);
    const words = prog === 'env' ? (shebang[2] ?? '').split(/\s+/).filter((w) => !w.startsWith('-') && !w.includes('=')) : [prog];
    const p = words[0] ?? '';
    if (SHELLS.includes(p)) return 'shell';
    if (JS_RUNNERS.includes(p)) return 'js';
    return 'other';
  }
  const ext = path.extname(file).toLowerCase();
  if (SHELL_EXT.includes(ext)) return 'shell';
  if (JS_EXT.includes(ext)) return 'js';
  return running && !ext ? 'shell' : 'other';
}

// Everything `file` (a script a patch names) can run or read in the repo.
export function reachOf(file: string, opts: FollowOptions): ScriptReach {
  const r = new Reach(opts);
  try {
    r.follow(file, 'run', undefined);
  } catch (e) {
    // A bug here mustn't let the script through: it fails closed.
    r.problem ??= `couldn't be followed (${(e as Error).message}).`;
  }
  return { files: [...r.files], missing: [...r.missing], ...(r.problem ? { problem: r.problem } : {}), ...outsideOf(r) };
}

// The same for a command a patch writes (an action's `run`, a live
// function's `sh(...)`), run by a shell in `opts.folder`. `label` names it
// in a problem. A string that isn't a command only names files to hash.
// `vars`: what the shell it runs in already has set (a Claude Code hook's
// CLAUDE_PROJECT_DIR).
export function reachOfCommand(command: string, label: string, opts: FollowOptions, vars: Record<string, string> = {}): ScriptReach {
  const r = new Reach(opts);
  try {
    r.shell(command, { label, file: opts.folder, argv0: [], dirs: new Set([opts.folder]), vars: new Map(Object.entries(vars).map(([k, v]) => [k, [v]])), depth: 0 });
  } catch (e) {
    r.problem ??= `couldn't be followed (${(e as Error).message}).`;
  }
  return { files: [...r.files], missing: [...r.missing], ...(r.problem ? { problem: r.problem } : {}), ...outsideOf(r) };
}

function outsideOf(r: Reach): { outside?: { file: string; dirs: string[] }[] } {
  return r.outside.size ? { outside: [...r.outside].map(([file, dirs]) => ({ file, dirs: [...dirs] })) } : {};
}
