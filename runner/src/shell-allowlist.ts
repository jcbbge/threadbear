// The short list of shell a command that runs by itself may use: a live
// function's `sh(...)` (badges, `when`, summaries, list panels) and a
// folder's Claude Code hooks and settings commands (docs/protocol.md,
// "Commands that run by themselves", "Trusting a folder's Claude Code
// hooks").
//
// script-trust.ts follows a command by spotting the shell tricks it knows
// are dangerous, and every review round found more it didn't (here-docs,
// $'\142ash', `sh /dev/stdin`, env -S, a `}` zsh reads as the end of a
// group...). Mike picked an allowlist instead (7 Nov 2026): the command is
// parsed into a small, explicit grammar, and anything outside it is
// refused, so a corner nobody thought of fails closed rather than running.
//
// The grammar: simple commands of literal words, '...' and "..." strings,
// `$NAME`, `${NAME}` and a few special parameters ($?, $!, $#, $$, $0-$9,
// $@, $*), and `$(...)` whose commands are themselves on the list; pipes,
// `&&`, `||`, `;` and newlines; `{ ...; }` and `( ... )`; `!` before a
// pipeline; `>` and `>>` to /dev/null, `<` from a literal path (an fd
// digit before one too) and `N>&M`; `NAME=value` on its own (a lower-case shell variable); and,
// for a live command only, `&` (the runner ends the command's whole
// process group when its shell exits, so nothing outlives it). A script a
// command runs may also use `if`, `while`, `until`, `for ... in` and
// `case`, `set -e`-style options and comments. Nothing else: here-docs and
// here-strings, process substitution, backticks, `$((...))`, `[[`, `((`,
// globs, brace expansion, `~user`, zsh's `=cmd`, functions, aliases,
// `eval`, `exec`, `trap`, `export`, `VAR=x cmd`, and any builtin not named
// below are refused.
//
// Programs, compared in lower case by the name they run as (a path's last
// part, which must be what the path resolves to), so `GIT`, `/usr/bin/git`
// and `git` are held to the same; a builtin or reserved word in another
// case, or by a path, isn't the shell's own and is refused.
//
// A live command (built in code from what it read, run every few
// seconds) may run only what Mike's patches run (7 Nov 2026), each in the
// forms they use: LIVE, GIT, GH and CONVEX below, `node` with a file (the
// repo's is followed and must be hashed), and the builtins echo, true,
// exit, kill (`$!` only) and test -f. A file of the repo's run by its path
// is hashed and followed too, and what a script of the repo's runs is held
// to this same list. Every word is literal, but for grep's
// pattern, which must start with literal text. git and gh run only in a
// repo whose own config adds nothing git runs, and with liveCommandEnv's
// settings, which turn off what that config could still say.
//
// A Claude Code hook (or a script it runs) may also follow the repo's own
// scripts: a script or JavaScript file of the repo's is followed (and must
// be one the hash covered); shells, node, bun and tsx only with a file to
// run, npm/pnpm/yarn/bun only to run a package script by name (followed
// as a script), and env, nohup, nice and timeout only around a script of
// the repo's; other programs only from HOOK_PROGRAMS, which load nothing
// from the folder and write nothing, with literal words.
//
// Neither writes a file: output goes only to /dev/null. A file outside the
// repo may be run only if nobody but you or root could have written it
// (ownedPathProblem); sourcing one is refused.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kindOf,
  looksRunnable,
  MAX_CONFIG_BYTES,
  MAX_SCRIPT_FILES,
  npmKey,
  rcConfig,
  reachOf,
  readsInput,
  Reads,
  RISKY_ENV,
  shebangReadsElsewhere,
  type FollowOptions,
  type ScriptReach,
} from './script-trust.ts';
import { inNodeModules, trackedNodeModules } from './tracked-packages.ts';

export type AllowOptions = FollowOptions & {
  // A live function's command: held to the live list; the runner ends its
  // process group when its shell exits (patches.ts runCommand's
  // `killGroup`), so `&` is bounded; and it's built in code from what it
  // read, so it's held to the read-only rule (allowCommand). Otherwise a
  // Claude Code hook's, held to the hook list.
  live?: boolean;
};

// The most of a command this reads; a longer one fails closed.
export const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_NESTING = 16;
const MAX_DEPTH = 12;
const MAX_VISITS = 600;

const OFF = "which isn't on patch trust's short list of shell it can follow";

class Refused extends Error {}

// ---- the grammar ----

type Part =
  | { k: 'lit'; s: string; q: boolean }
  | { k: 'tilde' }
  | { k: 'var'; name: string; q: boolean }
  | { k: 'sub'; list: List; q: boolean };
type Word = { parts: Part[]; line: number };
type Redir = { fd?: number; op: '>' | '>>' | '<' | '>&' | '<&'; target: Word; line: number };
type Simple = { k: 'simple'; words: Word[]; redirs: Redir[]; line: number };
type Compound =
  | { k: 'group'; sub: boolean; body: List; redirs: Redir[]; line: number }
  | { k: 'if'; arms: { cond: List; body: List }[]; else?: List; redirs: Redir[]; line: number }
  | { k: 'loop'; cond: List; body: List; redirs: Redir[]; line: number }
  | { k: 'for'; name: string; words?: Word[]; body: List; redirs: Redir[]; line: number }
  | { k: 'case'; word: Word; arms: { patterns: Word[]; body: List }[]; redirs: Redir[]; line: number };
type Command = Simple | Compound;
type Pipeline = { neg: boolean; cmds: Command[]; line: number };
type AndOr = { first: Pipeline; rest: Pipeline[] };
type Item = { ao: AndOr; bg: boolean; line: number };
type List = Item[];

const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'in', 'case', 'esac']);
// Reserved words of bash or zsh that aren't on the list.
const REFUSED_WORDS: Record<string, string> = {
  function: 'a function',
  select: '`select`',
  coproc: 'a coprocess',
  time: '`time`',
  repeat: "zsh's `repeat`",
  foreach: "zsh's `foreach`",
  nocorrect: "zsh's `nocorrect`",
  noglob: "zsh's `noglob`",
};
const DELIM = ' \t\n;&|()<>';

class Parser {
  i = 0;
  line = 1;
  private nest = 0;
  private s: string;
  private script: boolean;
  constructor(s: string, script: boolean) {
    this.s = s;
    this.script = script;
  }

  refuse(what: string): never {
    throw new Refused(`${this.script || this.s.includes('\n') ? `line ${this.line} ` : ''}uses ${what}, ${OFF}.`);
  }

  program(): List {
    const l = this.list(new Set());
    this.blank();
    if (this.i < this.s.length) this.refuse(`\`${this.s[this.i]}\` where a command can't go`);
    return l;
  }

  // Spaces, tabs, `\` line ends and, in a script, comments.
  private blank(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t') this.i++;
      else if (c === '\\' && s[this.i + 1] === '\n') {
        this.i += 2;
        this.line++;
      } else if (c === '#') {
        if (!this.script) this.refuse('a comment');
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else break;
    }
  }

  private newlines(): void {
    for (;;) {
      this.blank();
      if (this.s[this.i] !== '\n') return;
      this.i++;
      this.line++;
    }
  }

  // The operator at `i` (not taken), '' at the end, or undefined before a
  // word or a redirect.
  private op(): string | undefined {
    this.blank();
    const s = this.s;
    if (this.i >= s.length) return '';
    const two = s.slice(this.i, this.i + 3);
    for (const [bad, what] of [
      ['<<', 'a here-doc or here-string (`<<`)'],
      ['<(', 'process substitution (`<(...)`)'],
      ['>(', 'process substitution (`>(...)`)'],
      ['<>', 'a read-write redirect (`<>`)'],
      ['>|', 'a clobbering redirect (`>|`)'],
      ['&>', 'a redirect of both outputs (`&>`)'],
      ['|&', 'a pipe of both outputs (`|&`)'],
      ['&|', "zsh's `&|`"],
      ['&!', "zsh's `&!`"],
      [';&', "case's `;&`"],
      [';;&', "case's `;;&`"],
    ] as const) {
      if (two.startsWith(bad)) this.refuse(what);
    }
    for (const o of ['&&', '||', ';;', ';', '&', '|', '(', ')', '\n']) if (s.startsWith(o, this.i)) return o;
    return undefined;
  }

  private take(o: string): void {
    this.i += o.length;
    if (o === '\n') this.line++;
  }

  // A reserved word at `i` (not taken): a bare one, followed by a delimiter.
  private keyword(): string | undefined {
    this.blank();
    const m = /^(?:[a-z]+|[{}!]|\[\[)/.exec(this.s.slice(this.i, this.i + 12));
    if (!m) return undefined;
    const after = this.s[this.i + m[0].length];
    if (after !== undefined && !DELIM.includes(after)) return undefined;
    return m[0];
  }

  private takeWord(w: string): void {
    this.blank();
    this.i += w.length;
  }

  private expectKeyword(w: string): void {
    this.newlines();
    if (this.keyword() !== w) this.refuse(`a \`${this.s.slice(this.i, this.i + 10).split(/\s/)[0] || 'end'}\` where \`${w}\` should be`);
    this.takeWord(w);
  }

  // Commands up to one of `stops` (reserved words, or `)` / `;;`), or the end.
  list(stops: Set<string>): List {
    const items: List = [];
    for (;;) {
      this.newlines();
      const o = this.op();
      if (o === '' || (o !== undefined && stops.has(o))) return items;
      const kw = this.keyword();
      if (kw && stops.has(kw)) return items;
      const line = this.line;
      const ao = this.andOr();
      const sep = this.op();
      let bg = false;
      if (sep === '&') {
        bg = true;
        this.take('&');
      } else if (sep === ';' || sep === '\n') this.take(sep);
      else if (!(sep === '' || (sep !== undefined && stops.has(sep)) || (this.keyword() && stops.has(this.keyword()!)))) {
        this.refuse(sep ? `\`${sep}\` there` : `\`${this.s.slice(this.i, this.i + 10).split(/\s/)[0]}\` after a command, where a \`;\` or a new line should be`);
      }
      items.push({ ao, bg, line });
    }
  }

  private andOr(): AndOr {
    const first = this.pipeline();
    const rest: Pipeline[] = [];
    for (;;) {
      const o = this.op();
      if (o !== '&&' && o !== '||') return { first, rest };
      this.take(o);
      this.newlines();
      rest.push(this.pipeline());
    }
  }

  private pipeline(): Pipeline {
    const line = this.line;
    let neg = false;
    if (this.keyword() === '!') {
      this.takeWord('!');
      neg = true;
    }
    const cmds = [this.command()];
    for (;;) {
      if (this.op() !== '|') return { neg, cmds, line };
      this.take('|');
      this.newlines();
      cmds.push(this.command());
    }
  }

  private nested<T>(fn: () => T): T {
    if (++this.nest > MAX_NESTING) this.refuse(`more than ${MAX_NESTING} levels of nesting`);
    try {
      return fn();
    } finally {
      this.nest--;
    }
  }

  private command(): Command {
    const line = this.line;
    const o = this.op();
    if (o === '(') {
      if (this.s[this.i + 1] === '(') this.refuse('`((`');
      this.take('(');
      const body = this.nested(() => this.list(new Set([')'])));
      if (this.op() !== ')') this.refuse('a `(` with no `)`');
      this.take(')');
      if (!body.length) this.refuse('an empty `( )`');
      return { k: 'group', sub: true, body, redirs: this.redirects(), line };
    }
    if (o !== undefined) this.refuse(o === '' ? 'nothing after an operator' : `\`${o === '\n' ? 'a new line' : o}\` where a command should be`);
    const kw = this.keyword();
    if (kw === '{') {
      this.takeWord('{');
      const body = this.nested(() => this.list(new Set(['}'])));
      this.expectKeyword('}');
      if (!body.length) this.refuse('an empty `{ }`');
      return { k: 'group', sub: false, body, redirs: this.redirects(), line };
    }
    if (kw === '[[') this.refuse('`[[`');
    if (kw && Object.hasOwn(REFUSED_WORDS, kw)) this.refuse(REFUSED_WORDS[kw]!);
    if (kw && KEYWORDS.has(kw)) {
      if (!this.script) this.refuse(`\`${kw}\` (a script can, a command can't)`);
      return this.nested(() => this.compound(kw, line));
    }
    if (kw === '}' || kw === '!') this.refuse(`a \`${kw}\` where a command should be`);
    return this.simple();
  }

  private compound(kw: string, line: number): Compound {
    this.takeWord(kw);
    if (kw === 'if') {
      const arms: { cond: List; body: List }[] = [];
      let els: List | undefined;
      for (let w = 'if'; ; ) {
        const cond = this.list(new Set(['then']));
        this.expectKeyword('then');
        const body = this.list(new Set(['elif', 'else', 'fi']));
        arms.push({ cond, body });
        this.newlines();
        w = this.keyword() ?? '';
        if (w === 'elif') {
          this.takeWord('elif');
          continue;
        }
        if (w === 'else') {
          this.takeWord('else');
          els = this.list(new Set(['fi']));
        }
        this.expectKeyword('fi');
        break;
      }
      return { k: 'if', arms, ...(els ? { else: els } : {}), redirs: this.redirects(), line };
    }
    if (kw === 'while' || kw === 'until') {
      const cond = this.list(new Set(['do']));
      this.expectKeyword('do');
      const body = this.list(new Set(['done']));
      this.expectKeyword('done');
      return { k: 'loop', cond, body, redirs: this.redirects(), line };
    }
    if (kw === 'for') {
      this.blank();
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 256));
      if (!m || (this.s[this.i + m[0].length] !== undefined && !DELIM.includes(this.s[this.i + m[0].length]!))) this.refuse('a `for` without a plain name');
      this.i += m[0].length;
      let words: Word[] | undefined;
      this.newlines();
      if (this.keyword() === 'in') {
        this.takeWord('in');
        words = [];
        for (;;) {
          const o = this.op();
          if (o !== undefined) break;
          words.push(this.word(false));
        }
      }
      const sep = this.op();
      if (sep === ';' || sep === '\n') this.take(sep);
      this.expectKeyword('do');
      const body = this.list(new Set(['done']));
      this.expectKeyword('done');
      return { k: 'for', name: m[0], ...(words ? { words } : {}), body, redirs: this.redirects(), line };
    }
    if (kw === 'case') {
      this.blank();
      const word = this.word(false);
      this.expectKeyword('in');
      const arms: { patterns: Word[]; body: List }[] = [];
      for (;;) {
        this.newlines();
        if (this.keyword() === 'esac') {
          this.takeWord('esac');
          break;
        }
        if (this.op() === '(') this.take('(');
        const patterns: Word[] = [];
        for (;;) {
          this.blank();
          patterns.push(this.word(true));
          const o = this.op();
          if (o === '|') {
            this.take('|');
            continue;
          }
          if (o !== ')') this.refuse("a case pattern without its `)`");
          this.take(')');
          break;
        }
        const body = this.list(new Set([';;', 'esac']));
        arms.push({ patterns, body });
        if (this.op() === ';;') this.take(';;');
      }
      return { k: 'case', word, arms, redirs: this.redirects(), line };
    }
    this.refuse(`\`${kw}\` where a command should be`);
  }

  private redirects(): Redir[] {
    const out: Redir[] = [];
    for (;;) {
      this.blank();
      const r = this.redirect();
      if (!r) return out;
      out.push(r);
    }
  }

  // A redirect at `i`, or undefined.
  private redirect(): Redir | undefined {
    const s = this.s;
    const m = /^(\d*)(>>|>&|<&|>|<)/.exec(s.slice(this.i, this.i + 8));
    if (!m) return undefined;
    if (m[1]!.length > 1) this.refuse('a redirect of a file descriptor above 9');
    const line = this.line;
    // `<<`, `<>`, `>|` and `&>` were refused by op() at the start; after a
    // digit they're here.
    const rest = s.slice(this.i + m[0].length, this.i + m[0].length + 1);
    const odd: Record<string, string> = { '<<': 'a here-doc or here-string (`<<`)', '<>': 'a read-write redirect (`<>`)', '<(': 'process substitution (`<(...)`)', '>|': 'a clobbering redirect (`>|`)', '>(': 'process substitution (`>(...)`)', '>!': "zsh's `>!`" };
    if (Object.hasOwn(odd, m[2] + rest)) this.refuse(odd[m[2] + rest]!);
    this.i += m[0].length;
    const op = m[2] as Redir['op'];
    this.blank();
    if (op === '>&' || op === '<&') {
      const t = /^(\d|-)(?=[ \t\n;&|()<>]|$)/.exec(s.slice(this.i, this.i + 2));
      if (!t) this.refuse(`\`${op}\` to something other than a file descriptor`);
      this.i += t[0].length;
      return { ...(m[1] ? { fd: Number(m[1]) } : {}), op, target: { parts: [{ k: 'lit', s: t[1]!, q: false }], line }, line };
    }
    if (this.i >= s.length || DELIM.includes(s[this.i]!)) this.refuse(`a \`${op}\` with nothing after it`);
    const target = this.word(false);
    return { ...(m[1] ? { fd: Number(m[1]) } : {}), op, target, line };
  }

  private simple(): Simple {
    const line = this.line;
    const words: Word[] = [];
    const redirs: Redir[] = [];
    for (;;) {
      this.blank();
      const r = this.redirect();
      if (r) {
        redirs.push(r);
        continue;
      }
      const o = this.op();
      if (o !== undefined) {
        if (o === '(') this.refuse(words.length ? 'a `(` after a word (a function, or a zsh pattern)' : 'a `(` where a command should be');
        break;
      }
      words.push(this.word(false));
    }
    if (!words.length) this.refuse(redirs.length ? 'a redirect with no command (zsh runs a pager for it)' : 'an empty command');
    return { k: 'simple', words, redirs, line };
  }

  // One word. `pattern`: a case pattern, where `*`, `?` and `[...]` match
  // text rather than files.
  word(pattern: boolean): Word {
    const s = this.s;
    const parts: Part[] = [];
    const line = this.line;
    const start = this.i;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (DELIM.includes(c)) break;
      const first = this.i === start;
      const next = s[this.i + 1];
      const alone = next === undefined || DELIM.includes(next);
      if (c === '\\') {
        if (next === '\n') {
          this.i += 2;
          this.line++;
          continue;
        }
        if (next === undefined) this.refuse('a `\\` at the end');
        lit(parts, next, true);
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) this.refuse("an unclosed `'`");
        const text = s.slice(this.i + 1, end);
        for (const ch of text) if (ch === '\n') this.line++;
        lit(parts, text, true);
        this.i = end + 1;
      } else if (c === '"') {
        this.i++;
        this.dquote(parts);
      } else if (c === '$') {
        const d = this.dollar(false);
        if (d.k === 'lit') lit(parts, d.s, d.q);
        else parts.push(d);
      } else if (c === '`') {
        this.refuse('backticks (`` `...` ``; `$(...)` is on the list)');
      } else if (c === '~' && first) {
        if (!(alone || next === '/')) this.refuse('`~user`');
        parts.push({ k: 'tilde' });
        this.i++;
      } else if ('*?[]'.includes(c)) {
        if (pattern) {
          lit(parts, c, false);
          this.i++;
        } else if ((c === '[' || c === ']') && first && alone) {
          // `[ -f x ]`: the test command and its closing bracket.
          lit(parts, c, false);
          this.i++;
        } else this.refuse(`a glob (\`${c}\`), which could pick up files patch trust didn't hash`);
      } else if (c === '{' || c === '}') {
        // A group's own `{` and `}` never reach here: command() and
        // expectKeyword() take them where a command starts or a list
        // ends. Anywhere else (a word, after a redirect, a redirect's
        // target, a `for` list or a case pattern) zsh reads a lone `}` as
        // the end of a group and bash as a word, so `{ echo } python3 -c
        // x; }` and `{ >/dev/null } python3 -c x; }` would run python3
        // there and not here.
        if (first && alone) this.refuse(`a lone \`${c}\` where it isn't a group's, which zsh and bash read differently`);
        this.refuse('brace expansion (`{...}`)');
      } else if (c === '=' && first) {
        this.refuse("a word starting `=` (zsh's `=cmd`)");
      } else if (c === '!' || c === '^' || c === '#' || c === '~') {
        if (c === '!' && first && alone) {
          lit(parts, c, false);
          this.i++;
        } else this.refuse(`an unquoted \`${c}\` (a glob or history character in zsh)`);
      } else if (c.charCodeAt(0) < 0x20 || c === '\u007f') {
        this.refuse('a control character');
      } else {
        lit(parts, c, false);
        this.i++;
      }
    }
    if (!parts.length) this.refuse('an empty word');
    return { parts, line };
  }

  private dquote(parts: Part[]): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === undefined) break;
        if (n === '\n') this.line++;
        else lit(parts, '$`"\\'.includes(n) ? n : '\\' + n, true);
        this.i += 2;
      } else if (c === '$') {
        const d = this.dollar(true);
        if (d.k === 'lit') lit(parts, d.s, d.q);
        else parts.push(d);
      } else if (c === '`') {
        this.refuse('backticks (`` `...` ``; `$(...)` is on the list)');
      } else {
        if (c === '\n') this.line++;
        lit(parts, c, true);
        this.i++;
      }
    }
    this.refuse('an unclosed `"`');
  }

  private dollar(q: boolean): Part {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      if (s[this.i + 2] === '(') this.refuse('arithmetic (`$((...))`)');
      this.i += 2;
      const list = this.nested(() => this.list(new Set([')'])));
      if (this.op() !== ')') this.refuse('a `$(` with no `)`');
      this.take(')');
      if (!list.length) this.refuse('an empty `$()`');
      return { k: 'sub', list, q };
    }
    let name: string;
    if (n === '{') {
      const end = s.indexOf('}', this.i + 2);
      const inner = end < 0 ? '' : s.slice(this.i + 2, end);
      if (inner === 'BASH_SOURCE[0]') name = 'BASH_SOURCE';
      else if (/^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[!?$#@*])$/.test(inner)) name = inner;
      else this.refuse(`\`\${${inner.slice(0, 20)}${inner.length > 20 ? '...' : ''}}\` (only a plain \${NAME} is)`);
      this.i = end + 1;
    } else {
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[!?$#@*])/.exec(s.slice(this.i + 1, this.i + 256));
      if (!m) {
        const after = s[this.i + 1];
        // A `$` on its own is a `$`.
        if (after === undefined || DELIM.includes(after) || (q && after === '"')) {
          this.i++;
          return { k: 'lit', s: '$', q };
        }
        this.refuse(`\`$${after}\``);
      }
      name = m[1]!;
      this.i += 1 + name.length;
      // zsh reads `$x[1]` as a subscript and `$x:h` as a modifier.
      if (s[this.i] === ':' && /[A-Za-z&]/.test(s[this.i + 1] ?? '')) this.refuse(`\`$${name}:${s[this.i + 1]}\` (a zsh modifier)`);
    }
    if (s[this.i] === '[') this.refuse(`\`$${name}[\` (a zsh subscript)`);
    return { k: 'var', name, q };
  }
}

// Adds literal text to a word, joined to the literal before it when it's
// quoted the same way, so `NAME=` reads as one piece.
function lit(parts: Part[], text: string, q: boolean): void {
  const last = parts.at(-1);
  if (last?.k === 'lit' && last.q === q) last.s += text;
  else parts.push({ k: 'lit', s: text, q });
}

// Parses `text` as a command (`script` false) or a script.
function parse(text: string, script: boolean): List {
  return new Parser(text, script).program();
}

// ---- following ----

// Builtins a Claude Code hook (or a script it runs) may use, and what's
// checked of their arguments below.
const ALLOWED_BUILTINS = new Set(['cd', 'echo', 'printf', 'true', 'false', ':', 'test', '[', 'exit', 'return', 'shift', 'break', 'continue', 'read', 'wait', 'kill', 'pwd', 'which', 'type', 'command', 'set', 'setopt', 'unsetopt', 'source', '.']);
// The builtins a live command may use: the ones Mike's patches use.
const LIVE_BUILTINS = new Set(['echo', 'true', 'exit', 'kill', 'test']);
// Builtins of bash or zsh that aren't on either list.
const SHELL_BUILTINS = new Set([
  'alias', 'unalias', 'autoload', 'bg', 'bind', 'bindkey', 'builtin', 'bye', 'caller', 'cap', 'chdir', 'clone', 'compadd', 'compcall', 'compctl', 'compdef', 'compdescribe', 'compfiles', 'compgen', 'compgroups', 'complete', 'compopt', 'compquote', 'comptags', 'comptry', 'compvalues',
  'coproc', 'declare', 'dirs', 'disable', 'disown', 'echotc', 'echoti', 'emulate', 'enable', 'eval', 'exec', 'export', 'fc', 'fg', 'float', 'functions', 'getcap', 'getln', 'getopts', 'hash', 'help', 'history', 'integer', 'jobs', 'let', 'limit', 'local', 'log', 'logout', 'mapfile',
  'noglob', 'nocorrect', 'popd', 'print', 'private', 'pushd', 'pushln', 'r', 'readarray', 'readonly', 'rehash', 'sched', 'setcap', 'shopt', 'stat', 'strftime', 'suspend', 'sysopen', 'sysread', 'sysseek', 'syswrite', 'times', 'trap', 'ttyctl', 'typeset', 'ulimit', 'umask', 'unfunction',
  'unhash', 'unlimit', 'unset', 'vared', 'whence', 'where', 'zcompile', 'zformat', 'zftp', 'zle', 'zmodload', 'zparseopts', 'zprof', 'zpty', 'zregexparse', 'zselect', 'zsocket', 'zstyle', 'zsystem', 'ztcp', 'zcurses', 'zgdbmpath', 'ztie', 'zuntie',
]);
// Names the shell itself reads, case and all: `CD` or `/usr/bin/cd` isn't
// the builtin (macOS has a /usr/bin/cd that changes nothing, so a tracked
// cd would be wrong), and `IF` isn't the keyword.
const SHELL_WORDS = new Set([...ALLOWED_BUILTINS, ...SHELL_BUILTINS, ...KEYWORDS, ...Object.keys(REFUSED_WORDS)]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Wrappers a hook may run around a script of the repo's, which is
// followed. `opts`: their flags that take a value.
const WRAPPERS: Record<string, { opts: string[]; flags: RegExp; lead?: number }> = {
  env: { opts: [], flags: /^$/ },
  nohup: { opts: [], flags: /^$/ },
  nice: { opts: ['-n'], flags: /^-\d+$/ },
  timeout: { opts: ['-s', '-k'], flags: /^--(foreground|preserve-status)$/, lead: 1 },
  gtimeout: { opts: ['-s', '-k'], flags: /^--(foreground|preserve-status)$/, lead: 1 },
};
// Programs a Claude Code hook (or a script it runs) may run: ones that
// load nothing from the folder, run nothing they're handed and write no
// file (INERT_PROGRAMS in script-trust.ts, less tee, cp, mv, rm, mkdir,
// touch, ln, chmod, mktemp, curl and wget). `say` and `uniq` can write a
// file, so they're held to forms that can't (hookProgram).
const HOOK_PROGRAMS = new Set(['cat', 'head', 'tail', 'ls', 'date', 'sleep', 'say', 'afplay', 'jq', 'grep', 'egrep', 'fgrep', 'tr', 'wc', 'cut', 'uniq', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'pbcopy', 'pbpaste', 'whoami', 'hostname', 'uname', 'tput', 'notify-send', 'logger']);
// What a live command that runs a file of the repo's may run beside it:
// nothing that changes a file, so it can't write that file first
// (`git ...; node scripts/x.mjs`, with the first built to change it).
const READ_ONLY = new Set(['echo', 'true', 'exit', 'kill', 'test', 'cat', 'grep', 'sleep', 'dns-sd']);
// zsh's own lower-case parameters, and its special arrays, which a plain
// `x=...` would set.
const ZSH_SPECIAL = new Set(['path', 'fpath', 'cdpath', 'manpath', 'mailpath', 'module_path', 'psvar', 'watch', 'histchars', 'prompt', 'signals', 'status', 'pipestatus', 'argv', 'aliases', 'builtins', 'commands', 'functions', 'options', 'parameters', 'history', 'jobtexts', 'modules', 'nameddirs', 'userdirs', 'dirstack', 'funcstack', 'reswords', 'saliases', 'galiases', 'dis_aliases', 'match', 'mbegin', 'mend', 'reply', 'precmd', 'preexec', 'chpwd', 'periodic', 'zshexit', 'cdablevars', 'fignore', 'keymaps', 'widgets', 'sysparams', 'errnos']);
// .npmrc keys that only say where packages come from and how they're laid
// out; any other (script-shell, node-options, git, onload-script, init-*,
// userconfig...) may run something, so npm and npx refuse to run beside it.
const NPMRC_KEYS = new Set(['registry', 'save-exact', 'save-prefix', 'save', 'engine-strict', 'legacy-peer-deps', 'strict-peer-deps', 'strict-peer-dependencies', 'auto-install-peers', 'fund', 'audit', 'audit-level', 'package-lock', 'package-lock-only', 'loglevel', 'progress', 'color', 'update-notifier', 'shamefully-hoist', 'public-hoist-pattern', 'hoist-pattern', 'node-linker', 'prefer-offline', 'prefer-online', 'offline', 'lockfile', 'link-workspace-packages', 'prefer-workspace-packages', 'ignore-scripts', 'fetch-retries', 'fetch-timeout', 'maxsockets', 'strict-ssl', 'always-auth', 'resolution-mode', 'dedupe-peer-dependents', 'enable-pre-post-scripts']);

// ---- the live list: what Mike's patches run (7 Nov 2026), as they run it ----

// A program's accepted form. Options may come in any order, each as
// written here (no bundling `-ac`, no abbreviating `--form`); `--x=v` and
// `--x v` are the same. Operands are matched in order. Every word must be
// literal (known as it's checked, not split), except a `data` operand: a
// quoted word that starts with literal text that isn't `-`, so it can't be
// read as an option (grep's pattern, `"adb-$s"`).
type Spec = {
  flags?: string[];
  opts?: Record<string, RegExp>;
  args?: (RegExp | 'data')[];
  // How many of the trailing `args` may be left out.
  optional?: number;
  // More operands after `args`.
  rest?: RegExp;
  // Options that must be there.
  need?: string[];
};

// A rev or ref name: letters, digits, `_`, `-`, `/` and single dots, as
// git's rev syntax has nothing in that set that does more than name one.
const R = '[A-Za-z0-9_](?:[A-Za-z0-9_/-]|\\.(?!\\.)){0,199}';
const REV = new RegExp(`^${R}$`);
const RANGE = new RegExp(`^${R}(?:\\.\\.${R})?$`);
const PATH = /^[^\n\0]{1,1024}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// `git branch --format`: the atoms cannvas's patch uses, and a tab.
// Others (%(signature) runs gpg, %(contents) reads more) aren't.
const BRANCH_FORMAT = /^(?:[^%\n\0]|%%|%09|%\((?:refname(?::short)?|committerdate(?::relative)?|subject|objectname(?::short)?)\))*$/;

const LIVE: Record<string, Spec> = {
  cat: { args: [PATH], rest: PATH },
  grep: { flags: ['-c'], args: ['data'] },
  sleep: { args: [/^\d{1,3}(\.\d{1,3})?$/] },
  'dns-sd': { opts: { '-B': /^_[A-Za-z0-9-]{1,63}\._(tcp|udp)$/ }, need: ['-B'], args: [/^[A-Za-z0-9.-]{1,253}$/] },
  // Only settings that make it give up sooner: none name a file or run
  // anything (no -F, -i, -E, -S, ProxyCommand, LocalCommand...). What
  // follows the host is what runs there, held to REMOTE (remoteCommand).
  // ssh reads options after the host too, so no word there may start `-`.
  ssh: { opts: { '-o': /^(ConnectTimeout=\d{1,3}|BatchMode=yes)$/i }, args: [/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/, /^[^\0]{1,8192}$/], rest: /^[^\0]{1,8192}$/ },
  tandem: { flags: ['--json'], args: [/^waiting$/], rest: PATH },
  stocks: { args: [/^(balance|positions)$/] },
};
// What an ssh of a live command may run on the other machine: bruce-ops's
// status line and cannvas's deployed version. Your other machines take
// whatever ssh sends, so it's a short list there too.
const REMOTE: Record<string, Spec> = {
  launchctl: { args: [/^list$/] },
  df: { flags: ['-h'], args: [PATH], rest: PATH },
  memory_pressure: { flags: ['-Q'] },
  tail: { flags: ['-1'] },
  readlink: { args: [PATH] },
};
// git's read-only subcommands cannvas's patch uses. Each also runs with
// liveCommandEnv's settings, and only in a repo whose own config keeps to
// LOCAL_GIT_KEYS (repoGitConfigProblem).
const GIT: Record<string, Spec> = {
  fetch: { flags: ['-q', '--quiet'], args: [/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, REV], optional: 1 },
  'merge-base': { flags: ['--is-ancestor'], need: ['--is-ancestor'], args: [REV, REV] },
  'rev-list': { flags: ['--count'], need: ['--count'], args: [RANGE] },
  // No operands: with one, `git branch` makes a branch.
  branch: { flags: ['-a'], opts: { '--no-merged': REV, '--sort': /^-?(committerdate|refname)$/, '--format': BRANCH_FORMAT } },
};
const GH: Record<string, Spec> = {
  'pr list': { opts: { '--state': /^(open|closed|merged|all)$/, '--limit': /^\d{1,4}$/, '--json': /^[A-Za-z]{1,40}(,[A-Za-z]{1,40}){0,20}$/ } },
};
// Scripts outside the repo a live command may run with node, from home,
// with the words each takes: the App Store status the Walkies and StashIt
// patches read from Poddle's checkout. Any other script of yours could do
// anything, and npm's own (node .../npm-cli.js exec x) runs what it's told.
// Each still has to be one only you could have written (ownedPathProblem).
const LIVE_OUTSIDE: Record<string, RegExp> = { 'dev/me/poddle/scripts/asc-status.mjs': /^\d{1,20}$/ };
// `npx convex ...`: reading a table and running a function by name.
const CONVEX: Record<string, Spec> = {
  data: { flags: ['--prod'], opts: { '--component': NAME, '--format': /^(jsonLines|jsonArray|pretty)$/, '--limit': /^\d{1,5}$/ }, args: [NAME] },
  // By name, as `convex run` can call any function, a mutation included:
  // the stats queries Poddle's and Walkies' patches read.
  run: { flags: ['--prod'], args: [/^(adminStats|stats):overview$/] },
};

type State = { cwd?: string; vars: Map<string, string | undefined>; lost?: string; pids: Set<string> };
type Ctx = {
  label: string;
  script: boolean;
  st: State;
  // In a branch (an `if` body, after `&&`, in a pipeline, a loop): what's
  // set or changed may or may not have happened, so it's unknown after.
  unsure: boolean;
  argv0?: string;
  depth: number;
  // node_modules/.bin folders on PATH (a package script).
  bin?: string[];
  // The command itself, not a script it runs: the read-only rule is its.
  top: boolean;
};

type Val = { v?: string; split: boolean; literal: boolean };

class Allow {
  files = new Set<string>();
  missing = new Set<string>();
  ranRepo?: string;
  others = new Set<string>();
  // Files run as code, which the caller holds to the hash whatever their
  // name: a picture's extension excuses a file only named, not one run.
  ran = new Set<string>();
  private visits = 0;
  // Scripts already followed from the same folder (each runs with fresh
  // variables, so once is enough), and how often each was sourced.
  private seen = new Set<string>();
  private sourced = new Map<string, number>();
  readonly reads: Reads;
  private home: string;
  private o: AllowOptions;
  constructor(o: AllowOptions) {
    this.o = o;
    this.reads = o.reads ?? new Reads();
    this.home = o.home ?? os.homedir();
  }

  private rel(f: string): string {
    const r = path.relative(this.o.top, f);
    return r && !r.startsWith('..') ? r : f;
  }

  refuse(ctx: Ctx, line: number | undefined, what: string): never {
    throw new Refused(`${ctx.script ? `${ctx.label} line ${line} ` : ''}${what}`);
  }

  inRepo(p: string): boolean {
    const inside = (q: string) => {
      const rel = path.relative(this.o.top, q);
      return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    };
    if (inside(p)) return true;
    try {
      return inside(fs.realpathSync(p));
    } catch {
      return inside(path.join(nearestReal(path.dirname(p)), path.basename(p)));
    }
  }

  // ---- values ----

  private value(w: Word, ctx: Ctx): Val {
    let v: string | undefined = '';
    let split = false;
    let literal = true;
    for (const p of w.parts) {
      if (p.k === 'lit') {
        if (v !== undefined) v += p.s;
        continue;
      }
      literal = false;
      if (p.k === 'tilde') {
        if (v !== undefined) v += this.home;
        continue;
      }
      const got = p.k === 'var' ? this.varValue(p.name, ctx) : this.subValue(p.list, ctx);
      // Unquoted, bash splits a value on spaces and globs it (zsh doesn't).
      if (!p.q && (got === undefined || got === '' || /[\s*?[]/.test(got))) split = true;
      v = v === undefined || got === undefined ? undefined : v + got;
    }
    return { ...(v !== undefined ? { v } : {}), split, literal };
  }

  private varValue(name: string, ctx: Ctx): string | undefined {
    // Not ${BASH_SOURCE[0]}: it's empty in zsh, which a `#!/bin/zsh` script
    // or `sh x` could be, so a `cd` built on it goes elsewhere there.
    if (name === '0') return ctx.argv0;
    if (name === 'HOME') return this.home;
    if (name === 'PWD') return ctx.st.cwd;
    return ctx.st.vars.get(name);
  }

  // What a `$(...)` gives, for the few a script uses to find its folder.
  private subValue(list: List, ctx: Ctx): string | undefined {
    const simples: Simple[] = [];
    for (const item of list) {
      if (item.bg) return undefined;
      for (const p of [item.ao.first, ...item.ao.rest]) {
        if (p.neg || p.cmds.length !== 1 || p.cmds[0]!.k !== 'simple') return undefined;
        simples.push(p.cmds[0] as Simple);
      }
    }
    const words = (c: Simple) => {
      const out: string[] = [];
      for (const w of c.words) {
        const x = this.value(w, ctx);
        if (x.v === undefined || x.split) return undefined;
        out.push(x.v);
      }
      return out;
    };
    const abs = (v: string) => (path.isAbsolute(v) ? path.normalize(v) : ctx.st.cwd === undefined ? undefined : path.resolve(ctx.st.cwd, v));
    if (simples.length === 1) {
      const w = words(simples[0]!);
      if (!w) return undefined;
      if (w[0] === 'dirname' && w.length === 2) return path.dirname(w[1]!);
      if (w[0] === 'basename' && w.length === 2) return path.basename(w[1]!);
      if ((w[0] === 'realpath' && w.length === 2) || (w[0] === 'readlink' && w[1] === '-f' && w.length === 3)) {
        const d = abs(w.at(-1)!);
        return d !== undefined && exists(d) ? realOr(d) : undefined;
      }
      if (w[0] === 'pwd' && w.length <= 2) return ctx.st.cwd;
      if (w.join(' ') === 'git rev-parse --show-toplevel') return this.o.top;
      return undefined;
    }
    if (simples.length === 2) {
      const a = words(simples[0]!);
      const b = words(simples[1]!);
      if (a && b && a[0] === 'cd' && b[0] === 'pwd' && b.length <= 2) {
        const t = a.slice(1).filter((x) => x !== '-P' && x !== '-L');
        const d = t.length === 1 ? abs(t[0]!) : undefined;
        return d !== undefined && enterable(d) && realOr(d) === d ? d : undefined;
      }
    }
    return undefined;
  }

  private abs(v: string, ctx: Ctx): string | undefined {
    if (path.isAbsolute(v)) return path.normalize(v);
    return ctx.st.cwd === undefined ? undefined : path.resolve(ctx.st.cwd, v);
  }

  // ---- walking ----

  list(l: List, ctx: Ctx): void {
    for (const item of l) {
      if (item.bg && !this.o.live) this.refuse(ctx, item.line, `runs a command in the background (\`&\`), ${OFF} for a command Threadbear can't end with its own.`);
      const unsure = ctx.unsure || item.bg;
      this.pipeline(item.ao.first, { ...ctx, unsure });
      for (const p of item.ao.rest) this.pipeline(p, { ...ctx, unsure: true });
    }
  }

  private pipeline(p: Pipeline, ctx: Ctx): void {
    const unsure = ctx.unsure || p.cmds.length > 1;
    for (const c of p.cmds) this.command(c, { ...ctx, unsure });
  }

  private sub(ctx: Ctx): Ctx {
    return { ...ctx, st: { ...ctx.st, vars: new Map(ctx.st.vars), pids: new Set(ctx.st.pids) } };
  }

  private command(c: Command, ctx: Ctx): void {
    if (++this.visits > MAX_VISITS * 20) this.refuse(ctx, c.line, 'is more than patch trust follows.');
    if (c.k === 'simple') return this.simple(c, ctx);
    this.redirs(c.redirs, ctx);
    if (c.k === 'group') return this.list(c.body, c.sub ? this.sub(ctx) : ctx);
    const inner = { ...ctx, unsure: true };
    if (c.k === 'if') {
      for (const a of c.arms) {
        this.list(a.cond, inner);
        this.list(a.body, inner);
      }
      if (c.else) this.list(c.else, inner);
    } else if (c.k === 'loop') {
      this.list(c.cond, inner);
      this.list(c.body, inner);
    } else if (c.k === 'for') {
      for (const w of c.words ?? []) this.wordSubs(w, ctx);
      this.assign(c.name, undefined, inner, c.line, false);
      this.list(c.body, inner);
    } else if (c.k === 'case') {
      this.wordSubs(c.word, ctx);
      for (const a of c.arms) {
        for (const w of a.patterns) this.wordSubs(w, ctx);
        this.list(a.body, inner);
      }
    }
  }

  // The `$(...)`s in a word run first, in a subshell: each on the list too.
  private wordSubs(w: Word, ctx: Ctx): void {
    for (const p of w.parts) if (p.k === 'sub') this.list(p.list, { ...this.sub(ctx), unsure: true });
  }

  // Output goes only to /dev/null or another descriptor: a command that
  // runs by itself writes no file, in the command or in any script it
  // runs. Input may come from a literal path.
  private redirs(rs: Redir[], ctx: Ctx): void {
    for (const r of rs) {
      if (r.op === '>&' || r.op === '<&') continue;
      if (r.target.parts.some((p) => p.k !== 'lit')) this.refuse(ctx, r.line, `redirects to a file worked out as it runs (\`${r.op}\`), ${OFF}.`);
      const v = this.value(r.target, ctx).v!;
      // A live command reads nothing that way: zsh's <1-10> is a glob.
      if (r.op === '<' && !this.o.live) continue;
      if (r.op === '<' && v !== '/dev/null') this.refuse(ctx, r.line, `reads from ${v} (\`<\`): a live command names a file to read, ${OFF}.`);
      if (v !== '/dev/null') this.refuse(ctx, r.line, `writes to ${v} (\`${r.op}\`): a command that runs by itself may send output only to /dev/null, ${OFF}.`);
    }
  }

  // `pid`: the value is `$!`, so `kill` may take the variable.
  private assign(name: string, value: string | undefined, ctx: Ctx, line: number, pid: boolean): void {
    // Lower-case, as environment variables aren't, and not one the shell
    // or Threadbear's environment already has: assigning one of those
    // changes what the commands after it get (PATH, NODE_OPTIONS, zsh's
    // `path`).
    if (!/^[a-z_][a-z0-9_]*$/.test(name) || Object.hasOwn(process.env, name) || ZSH_SPECIAL.has(name) || /_functions$|^(npm|yarn|pnpm|bun)_|proxy/.test(name)) {
      this.refuse(ctx, line, `sets ${name}, and a command may only set lower-case shell variables of its own, ${OFF}: environment and shell variables change what other commands load.`);
    }
    // In a branch, an earlier other value may still be what it holds:
    // `if x; then p=-1; else p=$!; fi; kill $p`.
    const stillOther = ctx.unsure && ctx.st.vars.has(name) && !ctx.st.pids.has(name);
    ctx.st.vars.set(name, ctx.unsure ? undefined : value);
    if (pid && !stillOther) ctx.st.pids.add(name);
    else ctx.st.pids.delete(name);
  }

  private simple(c: Simple, ctx: Ctx): void {
    const line = c.line;
    for (const w of c.words) this.wordSubs(w, ctx);
    for (const r of c.redirs) this.wordSubs(r.target, ctx);
    this.redirs(c.redirs, ctx);
    const words = c.words;
    let k = 0;
    const assigns: { name: string; value?: string; pid: boolean }[] = [];
    for (; k < words.length; k++) {
      const first = words[k]!.parts[0];
      if (!first || first.k !== 'lit' || first.q) break;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.s);
      if (!m) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(first.s)) this.refuse(ctx, line, `sets an array element, ${OFF}.`);
        break;
      }
      if (m[2]) this.refuse(ctx, line, `appends to ${m[1]} (\`+=\`), ${OFF}.`);
      const after = first.s.slice(m[0].length);
      if (after.startsWith('=')) this.refuse(ctx, line, "sets a value starting `=` (zsh's `=cmd`).");
      const rest: Word = { parts: [...(after ? [{ k: 'lit' as const, s: after, q: false }] : []), ...words[k]!.parts.slice(1)], line };
      const v = this.value(rest, ctx);
      const pid = rest.parts.length === 1 && rest.parts[0]!.k === 'var' && rest.parts[0]!.name === '!';
      assigns.push({ name: m[1]!, ...(v.v !== undefined ? { value: v.v } : {}), pid });
    }
    if (k < words.length && assigns.length) this.refuse(ctx, line, `sets ${assigns[0]!.name} for one command (\`${assigns[0]!.name}=... cmd\`), which puts it in that command's environment, ${OFF}.`);
    for (const a of assigns) this.assign(a.name, a.value, ctx, line, a.pid);
    if (k >= words.length) return;
    const head = this.value(words[0]!, ctx);
    const shown = shownWord(words[0]!);
    if (head.v === undefined || head.split) this.refuse(ctx, line, `runs a command worked out as it runs (\`${shown}\`), which patch trust can't follow.`);
    const name = head.v;
    if (!name || name.startsWith('-')) this.refuse(ctx, line, `runs \`${shown}\`, ${OFF}.`);
    const args = words.slice(1);
    // A file of the repo's an argument names is hashed if it's code.
    for (const w of args) {
      const x = this.value(w, ctx);
      if (x.v === undefined || !x.v || x.v.length > 1024 || x.v.includes('\n')) continue;
      const p = this.abs(x.v, ctx);
      if (p && this.inRepo(p) && isFile(p) && looksRunnable(p)) this.files.add(this.reads.real(p) ?? p);
    }
    this.run(name, args, ctx, line);
  }

  private strs(args: Word[], ctx: Ctx): Val[] {
    return args.map((w) => this.value(w, ctx));
  }

  // The values of words that must be known and not split; refuses otherwise.
  private known(args: Word[], ctx: Ctx, line: number, what: string): string[] {
    return this.strs(args, ctx).map((x, i) => {
      if (x.v === undefined || x.split) this.refuse(ctx, line, `runs ${what} with \`${shownWord(args[i]!)}\`, worked out as it runs: its words must be literal, ${OFF}.`);
      return x.v;
    });
  }

  private other(name: string, ctx: Ctx): void {
    if (ctx.top && !READ_ONLY.has(name)) this.others.add(name);
  }

  private run(name: string, args: Word[], ctx: Ctx, line: number): void {
    if (name.includes('/')) {
      const p = this.abs(name, ctx);
      if (p === undefined) this.refuse(ctx, line, `runs ${name} after a cd patch trust couldn't follow, so it can't tell which file that is.`);
      // The repo's own file: hashed and followed, and what it runs is held
      // to the same list (a live command's to the live list).
      if (this.inRepo(p)) return this.repoFile(p, name, args, ctx, line, undefined);
      if (readsInput(p)) this.refuse(ctx, line, `runs ${name}, which is a file it has open, so patch trust can't tell what runs.`);
      this.owned(name, p, ctx, line);
      // The program is what the path is, under the name it's run by: a
      // link named `cat` to /bin/sh is sh, and busybox picks by name.
      const base = path.basename(name);
      const real = path.basename(realOr(p));
      if (!sameProgram(real, base)) this.refuse(ctx, line, `runs ${name}, which is ${real} under another name, ${OFF}.`);
      return this.program(base, args, ctx, line, true);
    }
    // In a package script, npm puts node_modules/.bin first on PATH.
    for (const dir of ctx.bin ?? []) {
      const bin = path.join(dir, name);
      if (!exists(bin)) continue;
      const real = realOr(bin);
      if (this.inRepo(real) && (!underNodeModules(path.relative(this.o.top, real)) || this.tracked(real, ctx, line))) return this.repoFile(real, name, args, ctx, line, undefined);
      this.refuse(ctx, line, `runs ${name}, a package's program that may load code from the folder by its own rules, which a hash can't follow.`);
    }
    this.program(name, args, ctx, line, false);
  }

  // Whether git tracks `real` (a file under node_modules in the repo).
  private tracked(real: string, ctx: Ctx, line: number): boolean {
    const t = trackedNodeModules(this.o.top, this.reads);
    if ('problem' in t) this.refuse(ctx, line, `runs ${this.rel(real)}, and ${t.problem}`);
    return t.lower.has(process.platform === 'darwin' || process.platform === 'win32' ? real.toLowerCase() : real);
  }

  // A file outside the repo, run as a program or by an interpreter: only
  // one nobody but you (or root) could have written (ownedPathProblem).
  private owned(shown: string, p: string, ctx: Ctx, line: number): void {
    // A package's program runs what it's told (npm-cli.js exec x).
    if (p.split('/').includes('node_modules')) this.refuse(ctx, line, `runs ${shown}, a package's program outside the repo, which may run what it's told, ${OFF}.`);
    if (shown.split('/').some((c) => c === '.' || c === '..')) this.refuse(ctx, line, `runs ${shown}, a path outside the repo with \`.\` or \`..\` in it, which the shell and Node resolve differently, ${OFF}.`);
    const why = ownedPathProblem(p);
    if (why) this.refuse(ctx, line, `runs ${shown}, outside the repo, and ${why}, so it isn't a file only you could have written.`);
  }

  // A file of the repo's run as a command, or by a shell or Node (`as`).
  private repoFile(p: string, shown: string, args: Word[], ctx: Ctx, line: number, as: 'shell' | 'js' | undefined): void {
    this.known(args, ctx, line, shown);
    const real = this.reads.real(p);
    if (real === undefined || !isFile(real)) {
      if (this.missing.size < 500) this.missing.add(p);
      this.refuse(ctx, line, `runs ${shown}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
    }
    this.files.add(real);
    this.ran.add(real);
    if (this.files.size > MAX_SCRIPT_FILES) this.refuse(ctx, line, `reaches more than ${MAX_SCRIPT_FILES} files, more than patch trust follows.`);
    if (ctx.top) this.ranRepo ??= this.rel(real);
    if (ctx.depth + 1 > MAX_DEPTH) this.refuse(ctx, line, `runs scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    const key = `${as ?? ''}\0${real}\0${p}\0${ctx.st.cwd ?? ''}\0${(ctx.bin ?? []).join(':')}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= MAX_VISITS) this.refuse(ctx, line, 'runs more scripts than patch trust follows.');
    this.seen.add(key);
    const text = this.reads.text(real);
    if (text === undefined) this.refuse(ctx, line, `runs ${shown}, which patch trust can't read.`);
    const kind = as ?? kindOf(real, text, true);
    if (kind === 'js') return this.js(p, ctx, line);
    if (kind !== 'shell') this.refuse(ctx, line, `runs ${this.rel(real)}, which isn't a shell script or JavaScript, so patch trust can't follow what it loads.`);
    if (!as && !shebangOk(text)) this.refuse(ctx, line, `runs ${this.rel(real)}, whose #! line runs it some way patch trust doesn't follow.`);
    this.script(text, real, p, ctx, line, false);
  }

  // A shell script: on the list too, with its own variables; `source`d,
  // in the caller's shell.
  private script(text: string, real: string, named: string | undefined, ctx: Ctx, line: number, sourced: boolean): void {
    if (text.length > MAX_CONFIG_BYTES) this.refuse(ctx, line, `runs ${this.rel(real)}, a shell script over ${MAX_CONFIG_BYTES / 1024} KB, more than patch trust reads.`);
    const label = this.rel(real);
    let l: List;
    try {
      l = parse(text, true);
    } catch (e) {
      if (e instanceof Refused) throw new Refused(`${label} ${e.message}`);
      throw e;
    }
    const st: State = sourced ? ctx.st : { ...(ctx.st.cwd !== undefined ? { cwd: ctx.st.cwd } : {}), vars: new Map(), pids: new Set() };
    this.list(l, { label, script: true, st, unsure: sourced ? ctx.unsure : false, ...(named !== undefined ? { argv0: named } : {}), depth: ctx.depth + 1, top: false, ...(ctx.bin ? { bin: ctx.bin } : {}) });
  }

  // A JavaScript file of the repo's: followed as patch trust follows one
  // (its imports, what the repo commits under node_modules, the files its
  // strings name; for a Claude Code hook, no child processes).
  private js(p: string, ctx: Ctx, line: number): void {
    const r = reachOf(p, { ...this.o, reads: this.reads });
    for (const f of r.files) this.files.add(f);
    for (const m of r.missing) if (this.missing.size < 500) this.missing.add(m);
    if (r.problem) this.refuse(ctx, line, r.problem);
  }

  // ---- programs ----

  // `given`: the name as run (a path's last part); `byPath`: run by a path.
  private program(given: string, args: Word[], ctx: Ctx, line: number, byPath: boolean): void {
    // Programs are compared in lower case, as macOS finds `GIT` as git.
    const name = given.toLowerCase();
    if (SHELL_WORDS.has(name) && (name !== given || byPath)) {
      this.refuse(ctx, line, `runs ${byPath ? 'a path to ' : ''}\`${given}\`, which isn't the shell's \`${name}\`: the shell knows its own words only as written, so this runs something else, ${OFF}.`);
    }
    if (SHELL_BUILTINS.has(name)) this.refuse(ctx, line, `uses the shell's \`${name}\`, ${OFF}.`);
    if (this.o.live) return this.liveProgram(name, args, ctx, line);
    if (name === 'source' || name === '.') return this.source(args, ctx, line);
    if (ALLOWED_BUILTINS.has(name)) return this.builtin(name, args, ctx, line);
    if (SHELLS.has(name)) return this.shellRun(name, args, ctx, line);
    if (name === 'node' || name === 'bun' || name === 'tsx') return this.jsRun(name, args, ctx, line);
    if (name === 'npm' || name === 'pnpm' || name === 'yarn') return this.pkgRun(name, args, ctx, line);
    if (name === 'npx' || name === 'bunx') this.refuse(ctx, line, `runs a package by name (${name}), which runs whatever that name resolves to then, so a hash can't cover it.`);
    if (Object.hasOwn(WRAPPERS, name)) return this.wrapper(name, args, ctx, line);
    if (name === 'find') return this.find(args, ctx, line);
    if (name === 'awk' || name === 'gawk' || name === 'nawk' || name === 'mawk') return this.awk(args, ctx, line);
    if (HOOK_PROGRAMS.has(name)) return this.hookProgram(name, args, ctx, line);
    this.refuse(ctx, line, `runs ${name}, which isn't on the short list of programs a Claude Code hook may run: ones that load no code from the folder, run nothing they're handed and write no file (docs/protocol.md, "The short list of shell").`);
  }

  // A live command: only the programs on the live list, in their forms.
  private liveProgram(name: string, args: Word[], ctx: Ctx, line: number): void {
    // A hashed script's `set -e` and the like change nothing it runs.
    if (ctx.script && (name === 'set' || name === 'setopt' || name === 'unsetopt')) return this.builtin(name, args, ctx, line);
    if (LIVE_BUILTINS.has(name)) {
      this.liveBuiltin(name, args, ctx, line);
      this.other(name, ctx);
      return;
    }
    if (name === 'node') return this.liveNode(args, ctx, line);
    if (name === 'npx') return this.npx(args, ctx, line);
    if (name === 'git' || name === 'gh') {
      this.gitReady(name, ctx, line);
      const vals = this.known(args, ctx, line, name);
      const sub = name === 'git' ? (vals[0] ?? '') : vals.slice(0, 2).join(' ');
      const specs = name === 'git' ? GIT : GH;
      if (!Object.hasOwn(specs, sub)) this.refuse(ctx, line, `runs \`${name} ${sub}\`, which isn't one of the ${name} commands on the short list (${Object.keys(specs).join(', ')}, with nothing before them), ${OFF}.`);
      this.spec(`${name} ${sub}`, args.slice(sub.split(' ').length), ctx, line, specs[sub]!);
      this.other(name, ctx);
      return;
    }
    if (!Object.hasOwn(LIVE, name)) {
      this.refuse(ctx, line, `runs ${name}, which isn't on the short list of programs a live command may run (docs/protocol.md, "The short list of shell").`);
    }
    const operands = this.spec(name, args, ctx, line, LIVE[name]!);
    if (name === 'ssh') this.remoteCommand(operands.slice(1).join(' '), ctx, line);
    this.other(name, ctx);
  }

  // Holds a program's words to its Spec.
  private spec(what: string, args: Word[], ctx: Ctx, line: number, spec: Spec): (string | undefined)[] {
    const vals = this.strs(args, ctx);
    const seen = new Set<string>();
    const operands: number[] = [];
    const isKnown = (x: Val | undefined): x is Val & { v: string } => x !== undefined && x.v !== undefined && !x.split;
    for (let i = 0; i < vals.length; i++) {
      const x = vals[i]!;
      if (isKnown(x) && x.v.startsWith('-') && x.v !== '-') {
        const v = x.v;
        const eq = v.startsWith('--') ? v.indexOf('=') : -1;
        const key = eq > 0 ? v.slice(0, eq) : v;
        if (eq < 0 && spec.flags?.includes(v)) {
          seen.add(v);
          continue;
        }
        const re = spec.opts && Object.hasOwn(spec.opts, key) ? spec.opts[key] : undefined;
        if (!re) this.refuse(ctx, line, `runs \`${what} ${v.slice(0, 60)}\`, ${OFF}.`);
        const value = eq > 0 ? v.slice(eq + 1) : isKnown(vals[i + 1]) ? vals[++i]!.v : undefined;
        if (value === undefined || !re.test(value)) this.refuse(ctx, line, `runs \`${what} ${key}\` with ${value === undefined ? 'a value worked out as it runs' : `\`${value.slice(0, 60)}\``}, ${OFF}.`);
        seen.add(key);
        continue;
      }
      operands.push(i);
    }
    for (const n of spec.need ?? []) if (!seen.has(n)) this.refuse(ctx, line, `runs ${what} without ${n}, ${OFF}.`);
    const slots = spec.args ?? [];
    const min = slots.length - (spec.optional ?? 0);
    if (operands.length < min || (operands.length > slots.length && !spec.rest)) this.refuse(ctx, line, `runs ${what} with ${operands.length} word${operands.length === 1 ? '' : 's'} after its options, ${OFF}.`);
    operands.forEach((i, n) => {
      const slot = n < slots.length ? slots[n]! : spec.rest!;
      const x = vals[i]!;
      if (!isKnown(x)) {
        if (slot === 'data' && dataWord(args[i]!)) return;
        this.refuse(ctx, line, `runs ${what} with \`${shownWord(args[i]!)}\`, worked out as it runs: its words must be literal, ${OFF}.`);
      }
      if (slot !== 'data' && !slot.test(x.v)) this.refuse(ctx, line, `runs ${what} with \`${x.v.slice(0, 60)}\`, ${OFF}.`);
    });
    return operands.map((i) => vals[i]!.v);
  }

  // What an ssh runs on the other machine: ssh joins its words with spaces
  // and that shell reads them, so they're read here the same way and each
  // command held to REMOTE. Plain commands and pipes only, all literal.
  private remoteCommand(text: string, ctx: Ctx, line: number): void {
    let l: List;
    try {
      l = parse(text, false);
    } catch (e) {
      if (e instanceof Refused) this.refuse(ctx, line, `runs ssh with a command for the other machine that ${e.message}`);
      throw e;
    }
    const off = (what: string): never => this.refuse(ctx, line, `runs ssh with a command for the other machine that has ${what}, ${OFF}.`);
    for (const item of l) {
      if (item.bg) off('`&`');
      for (const p of [item.ao.first, ...item.ao.rest]) {
        if (p.neg) off('`!`');
        for (const c of p.cmds) {
          if (c.k !== 'simple') off('a group');
          const cmd = c as Simple;
          if (cmd.redirs.length) off('a redirect');
          if (cmd.words.some((w) => w.parts.some((x) => x.k !== 'lit'))) off('a word worked out as it runs');
          const name = (cmd.words[0]!.parts as { s: string }[]).map((x) => x.s).join('');
          if (name === 'echo') continue;
          if (!Object.hasOwn(REMOTE, name)) off(`\`${name.slice(0, 40)}\``);
          this.spec(`ssh's ${name}`, cmd.words.slice(1), ctx, line, REMOTE[name]!);
        }
      }
    }
  }

  private liveBuiltin(name: string, args: Word[], ctx: Ctx, line: number): void {
    const vals = this.strs(args, ctx);
    const lit = (i: number) => vals[i]?.v !== undefined && !vals[i]!.split;
    switch (name) {
      case 'true':
        if (args.length) this.refuse(ctx, line, `runs \`true\` with words, ${OFF}.`);
        return;
      case 'echo':
        this.known(args, ctx, line, 'echo');
        return;
      case 'exit':
        if (vals.length > 1 || (vals.length === 1 && !(lit(0) && /^\d{1,3}$/.test(vals[0]!.v!)))) this.refuse(ctx, line, `runs \`exit\` with something other than a plain number, ${OFF}.`);
        return;
      case 'test':
        if (!(vals.length === 2 && lit(0) && lit(1) && /^-[fde]$/.test(vals[0]!.v!) && !vals[1]!.v!.startsWith('-'))) this.refuse(ctx, line, `runs \`test\` other than as \`test -f <path>\`, ${OFF}.`);
        return;
      case 'kill':
        return this.pids('kill', args, ctx, line, false);
    }
  }

  // kill's (and wait's) words: a signal, then `$!` or a variable only ever
  // set from it, as `p=$!; ...; kill $p` does. Any other value could be
  // `-1` (everything of yours) once it's split. `literal`: a script's own
  // plain numbers and `%1` too.
  private pids(name: string, args: Word[], ctx: Ctx, line: number, literal: boolean): void {
    const vals = this.strs(args, ctx);
    let j = 0;
    if (name === 'kill' && vals[0]?.v !== undefined && !vals[0].split && /^-(TERM|KILL|INT|HUP|QUIT|USR[12]|[0-9]{1,2})$/.test(vals[0].v)) j = 1;
    if (name === 'kill' && j >= args.length) this.refuse(ctx, line, `runs \`kill\` without a process, ${OFF}.`);
    for (; j < args.length; j++) {
      const w = args[j]!;
      const p = w.parts.length === 1 ? w.parts[0]! : undefined;
      if (p?.k === 'var' && (p.name === '!' || ctx.st.pids.has(p.name))) continue;
      const v = vals[j]!;
      if (literal && v.literal && v.v !== undefined && /^([1-9]\d{0,9}|%\d{1,3})$/.test(v.v)) continue;
      this.refuse(ctx, line, `runs \`${name}\` with \`${shownWord(w)}\`, which isn't \`$!\` or a variable set only from it, ${OFF}.`);
    }
  }

  // `node <file> <words>`: the repo's file is followed (the hash covers
  // it); one outside the repo must be one only you could have written.
  private liveNode(args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, 'node');
    const file = vals[0];
    if (file === undefined || file.startsWith('-')) this.refuse(ctx, line, `runs \`node${file ? ` ${file}` : ''}\`: a live command runs node only as \`node <file> <words>\`, ${OFF}.`);
    const p = this.abs(file, ctx);
    if (p !== undefined && !this.inRepo(p)) {
      const rel = path.relative(this.home, p);
      if (!Object.hasOwn(LIVE_OUTSIDE, rel)) this.refuse(ctx, line, `runs node ${file}, a script outside the repo that isn't on the short list a live command may run, ${OFF}.`);
      const bad = vals.slice(1).find((v) => !LIVE_OUTSIDE[rel]!.test(v));
      if (bad !== undefined) this.refuse(ctx, line, `runs node ${file} with \`${bad.slice(0, 60)}\`, ${OFF}.`);
    }
    this.fileFor('node', file, args.slice(1), ctx, line, 'js');
  }

  private builtin(name: string, args: Word[], ctx: Ctx, line: number): void {
    const vals = this.strs(args, ctx);
    const lit = (i: number) => vals[i]?.v !== undefined && !vals[i]!.split;
    const int = (i: number) => lit(i) && /^-?\d+$/.test(vals[i]!.v!);
    this.other(name, ctx);
    switch (name) {
      case 'cd': {
        const rest = vals.filter((x) => x.v !== '-P' && x.v !== '-L');
        if (rest.length > 1) this.refuse(ctx, line, `runs \`cd\` with two words (zsh's substitution), ${OFF}.`);
        const target = rest.length ? rest[0]! : { v: this.home, split: false, literal: true };
        const to = target.v === undefined || target.split || target.v === '-' ? undefined : this.abs(target.v, ctx);
        // With CDPATH set, a bare name may go elsewhere.
        const viaCdpath = process.env.CDPATH && target.v && !/^\.{0,2}\//.test(target.v) && !path.isAbsolute(target.v);
        // A cd that fails leaves the shell where it was, so one followed as
        // if it worked would check a different file than runs:
        // `cd sub; cd nope; ../evil.sh` (Muse's review, 7 Nov).
        if (to !== undefined && !viaCdpath && !ctx.unsure && !enterable(to)) this.refuse(ctx, line, `runs \`cd\` to ${target.v}, which isn't a folder it can go into now, so patch trust can't tell where it'd be.`);
        // Through a link, `..` means different things to cd and to a path
        // the shell hands the system: the same goes for not knowing at all.
        if (to === undefined || viaCdpath || ctx.unsure || realOr(to) !== to) {
          delete ctx.st.cwd;
          ctx.st.lost ??= `line ${line}`;
        } else ctx.st.cwd = to;
        return;
      }
      case 'printf': {
        let i = 0;
        if (vals[0]?.v === '--') i++;
        if (vals[i]?.v?.startsWith('-')) this.refuse(ctx, line, `runs printf with \`${vals[i]!.v}\`, ${OFF}.`);
        if (!lit(i)) this.refuse(ctx, line, `runs printf with a format worked out as it runs, ${OFF}.`);
        // zsh's printf reads a number's argument as arithmetic, which can
        // run a command in a subscript.
        // Any conversion but %s, %b and %q counts (%ld, %hd and %1$d too).
        if (/%(?![-+ #0-9.]*[sbq])/.test(vals[i]!.v!.replaceAll('%%', ''))) {
          for (let j = i + 1; j < vals.length; j++) if (!lit(j) || !/^[-+]?\d+(\.\d+)?$/.test(vals[j]!.v!)) this.refuse(ctx, line, `runs printf with a number format and an argument that isn't a plain number, ${OFF}.`);
        }
        return;
      }
      case 'test':
      case '[': {
        if (name === '[' && vals.at(-1)?.v !== ']') this.refuse(ctx, line, 'runs `[` without its `]`.');
        for (let j = 0; j < vals.length; j++) {
          const v = vals[j]!.v;
          if (v === '-v' || v === '-R') this.refuse(ctx, line, `runs test \`${v}\`, ${OFF}.`);
          // Numbers are read as arithmetic, which can run a command in a subscript.
          if (v && /^-(eq|ne|lt|le|gt|ge)$/.test(v) && !(int(j - 1) && int(j + 1))) this.refuse(ctx, line, `compares numbers that aren't plain numbers (\`${v}\`), ${OFF}.`);
        }
        return;
      }
      case 'exit':
      case 'return':
      case 'shift':
      case 'break':
      case 'continue':
        if (vals.length > 1 || (vals.length === 1 && !int(0))) this.refuse(ctx, line, `runs \`${name}\` with something other than a plain number, ${OFF}.`);
        return;
      case 'read': {
        let j = 0;
        while (j < vals.length && /^-r+$/.test(vals[j]!.v ?? '')) j++;
        for (; j < vals.length; j++) {
          const v = vals[j]!.v;
          if (!lit(j) || !v || v.startsWith('-')) this.refuse(ctx, line, `runs \`read\` with \`${shownWord(args[j]!)}\`, ${OFF}.`);
          this.assign(v, undefined, ctx, line, false);
        }
        return;
      }
      case 'wait':
      case 'kill':
        return this.pids(name, args, ctx, line, true);
      case 'which':
      case 'type':
        for (let j = 0; j < vals.length; j++) if (!lit(j)) this.refuse(ctx, line, `runs \`${name}\` with a name worked out as it runs, ${OFF}.`);
        return;
      case 'command':
        if (!(vals.length === 2 && /^-[vV]$/.test(vals[0]!.v ?? '') && lit(1))) this.refuse(ctx, line, `runs \`command\` other than as \`command -v name\`, ${OFF}.`);
        return;
      case 'set':
      case 'setopt':
      case 'unsetopt': {
        if (!ctx.script) this.refuse(ctx, line, `uses \`${name}\` (a script can, a command can't), ${OFF}.`);
        const known = this.known(args, ctx, line, name);
        for (let j = 0; j < known.length; j++) {
          const v = known[j]!;
          if (name === 'set' && /^[-+][eux]+$/.test(v)) continue;
          if (name === 'set' && /^[-+][eux]*o$/.test(v) && /^(pipefail|errexit|nounset|xtrace)$/.test(known[j + 1] ?? '')) {
            j++;
            continue;
          }
          if (name !== 'set' && /^(no_?)?(pipe_?fail|err_?exit|unset|xtrace)$/i.test(v)) continue;
          this.refuse(ctx, line, `runs \`${name} ${v}\`, ${OFF}.`);
        }
        return;
      }
    }
  }

  private source(args: Word[], ctx: Ctx, line: number): void {
    const x = args[0] ? this.value(args[0], ctx) : undefined;
    if (!x || x.v === undefined || x.split) this.refuse(ctx, line, "sources a file worked out as it runs, which patch trust can't follow.");
    if (!x.v.includes('/')) this.refuse(ctx, line, `sources ${x.v}, a name the shell looks for on PATH, ${OFF}: write it as ./${x.v}.`);
    const p = this.abs(x.v, ctx);
    if (p === undefined) this.refuse(ctx, line, `sources ${x.v} after a cd patch trust couldn't follow.`);
    if (readsInput(p)) this.refuse(ctx, line, `sources ${x.v}, which reads what to run from its input.`);
    if (!this.inRepo(p)) this.refuse(ctx, line, `sources ${x.v}, outside the repo, which patch trust can't hash.`);
    this.known(args.slice(1), ctx, line, 'source');
    const real = this.reads.real(p);
    if (real === undefined || !isFile(real)) {
      if (this.missing.size < 500) this.missing.add(p);
      this.refuse(ctx, line, `sources ${x.v}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
    }
    this.files.add(real);
    this.ran.add(real);
    if (ctx.top) this.ranRepo ??= this.rel(real);
    if (ctx.depth + 1 > MAX_DEPTH) this.refuse(ctx, line, `sources scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    const times = (this.sourced.get(real) ?? 0) + 1;
    if (times > 4) this.refuse(ctx, line, `sources ${this.rel(real)} more often than patch trust follows.`);
    this.sourced.set(real, times);
    const text = this.reads.text(real);
    if (text === undefined) this.refuse(ctx, line, `sources ${x.v}, which patch trust can't read.`);
    // $0 in a sourced file is the caller's in bash and sh, the file in zsh.
    this.script(text, real, undefined, ctx, line, true);
  }

  // sh, bash, zsh with a script file (and a few harmless options).
  private shellRun(name: string, args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, name);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]!;
      if (/^[-+][euxf]+$/.test(v)) continue;
      if (/^[-+]o$/.test(v) && /^(pipefail|errexit|nounset|xtrace)$/.test(vals[i + 1] ?? '')) {
        i++;
        continue;
      }
      const at = v === '--' ? ++i : i;
      const file = vals[at];
      if (file === undefined) break;
      if (file.startsWith('-') || file.startsWith('+')) this.refuse(ctx, line, `runs \`${name} ${file}\`, ${OFF}: name a script for it to run.`);
      this.fileFor(name, file, args.slice(at + 1), ctx, line, 'shell');
      return;
    }
    this.refuse(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
  }

  // The file an interpreter runs, with `args` after it: the repo's is
  // followed (and must be hashed); one outside it must be one only you
  // could have written, and runs as it is.
  private fileFor(name: string, file: string, args: Word[], ctx: Ctx, line: number, as: 'shell' | 'js'): void {
    if (file === '-') this.refuse(ctx, line, `runs \`${name} -\`, which reads what to run from its input.`);
    const p = this.abs(file, ctx);
    if (p === undefined) this.refuse(ctx, line, `runs ${file} after a cd patch trust couldn't follow.`);
    if (readsInput(p)) this.refuse(ctx, line, `runs ${file}, which reads what to run from its input, which patch trust can't follow.`);
    if (this.inRepo(p)) return this.repoFile(p, file, args, ctx, line, as);
    this.known(args, ctx, line, `${name} ${file}`);
    if (!isFile(p)) this.refuse(ctx, line, `runs ${name} ${file}, which isn't a file there now.`);
    this.owned(file, p, ctx, line);
    this.other(name, ctx);
  }

  private jsRun(name: string, args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, name);
    let i = 0;
    const flag = (v: string) => name === 'node' && /^--(no-warnings|enable-source-maps|no-deprecation|experimental-strip-types|disable-warning=[A-Za-z0-9_-]+)$/.test(v);
    for (; i < vals.length; i++) {
      if (flag(vals[i]!)) continue;
      if (vals[i] === '--' && name === 'node') i++;
      break;
    }
    let file = vals[i];
    if (name === 'bun') {
      // bun's own commands come first: `bun test` is its test runner.
      if (file === 'run') file = vals[++i];
      else if (file !== undefined && BUN_COMMANDS.has(file)) this.refuse(ctx, line, `runs \`bun ${file}\`, which finds what to run by its own rules.`);
    }
    if (file === undefined) this.refuse(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
    if (file.startsWith('-')) this.refuse(ctx, line, `runs \`${name} ${file}\`, ${OFF}.`);
    if (name === 'bun' && !looksLikeFile(file, ctx.st.cwd)) return this.packageScript('bun', file, ctx, line);
    if (name !== 'node') this.jsConfig(name, ctx, line);
    this.fileFor(name, file, args.slice(i + 1), ctx, line, 'js');
  }

  // What bun and tsx read from the folder before the file: bun's
  // bunfig.toml (preloads) and .env files (NODE_OPTIONS for what it
  // spawns), and either's tsconfig `paths`, which send a bare import to a
  // file of the repo's.
  private jsConfig(name: string, ctx: Ctx, line: number): void {
    if (ctx.st.cwd === undefined) this.refuse(ctx, line, `runs ${name} after a cd patch trust couldn't follow.`);
    for (let d = ctx.st.cwd; this.inRepo(d); d = path.dirname(d)) {
      if (name === 'bun' && isFile(path.join(d, 'bunfig.toml'))) this.refuse(ctx, line, 'runs bun beside a bunfig.toml, whose preloads run first by their own rules.');
      for (const f of ['tsconfig.json', 'jsconfig.json']) {
        const t = isFile(path.join(d, f)) ? this.reads.text(this.reads.real(path.join(d, f)) ?? '') : undefined;
        if (t !== undefined) this.files.add(this.reads.real(path.join(d, f))!);
        if (t && /"(paths|baseUrl)"/.test(t)) this.refuse(ctx, line, `runs ${name} beside a ${f} with paths, which send imports to files patch trust doesn't follow.`);
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
    if (name === 'bun') {
      for (const f of ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']) {
        const p = path.join(ctx.st.cwd, f);
        if (!isFile(p)) continue;
        const text = this.reads.text(this.reads.real(p) ?? p) ?? '';
        for (const raw of text.split('\n')) {
          const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)?.[1];
          if (key && (RISKY_ENV.has(key) || /^(NODE_OPTIONS|BUN_OPTIONS|BUN_CONFIG_.*)$/.test(key))) this.refuse(ctx, line, `runs bun beside ${f}, which sets ${key}, so other code loads.`);
        }
      }
    }
  }

  // npm/pnpm/yarn: only to run a package script by name.
  private pkgRun(tool: string, args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, tool);
    let i = 0;
    const quiet = (v: string | undefined) => v === '-s' || v === '--silent';
    while (quiet(vals[i])) i++;
    const sub = vals[i];
    let script: string | undefined;
    if (sub === 'run' || sub === 'run-script') {
      i++;
      while (quiet(vals[i])) i++;
      script = vals[i];
    } else if (sub === 'test' || sub === 't') script = 'test';
    if (script === undefined || script.startsWith('-')) this.refuse(ctx, line, `runs \`${tool}${sub ? ` ${sub}` : ''}\`, ${OFF}: only \`${tool} run <script>\` is.`);
    this.packageScript(tool, script, ctx, line);
  }

  // A package script, from the nearest package.json, followed as a script
  // in the package's folder with its node_modules/.bin on PATH.
  private packageScript(tool: string, name: string, ctx: Ctx, line: number): void {
    if (ctx.st.cwd === undefined) this.refuse(ctx, line, `runs a package script after a cd patch trust couldn't follow, so it can't tell which package.json.`);
    let dir: string | undefined;
    for (let d = ctx.st.cwd; this.inRepo(d); d = path.dirname(d)) {
      if (isFile(path.join(d, 'package.json'))) {
        dir = d;
        break;
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
    if (!dir) this.refuse(ctx, line, `runs the package script ${name}, but there's no package.json in the repo there.`);
    this.packageConfig(tool, dir, ctx, line);
    const f = path.join(dir, 'package.json');
    const real = this.reads.real(f)!;
    this.files.add(real);
    let pkg: { scripts?: Record<string, unknown> };
    try {
      pkg = JSON.parse(this.reads.text(real) ?? '') as typeof pkg;
    } catch {
      this.refuse(ctx, line, `runs a package script, and ${this.rel(f)} can't be read.`);
    }
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    if (typeof scripts[name] !== 'string') this.refuse(ctx, line, `runs the package script ${name}, which isn't in ${this.rel(f)}, so what runs instead is worked out by ${tool}.`);
    if (ctx.top) this.ranRepo ??= `${this.rel(f)}'s "${name}" script`;
    if (ctx.depth + 1 > MAX_DEPTH) this.refuse(ctx, line, `runs scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    const bin: string[] = [];
    for (let d = dir; ; d = path.dirname(d)) {
      bin.push(path.join(d, 'node_modules', '.bin'));
      if (path.dirname(d) === d) break;
    }
    for (const n of [`pre${name}`, name, `post${name}`]) {
      const text = scripts[n];
      if (typeof text !== 'string') continue;
      const label = `${this.rel(f)}'s "${n}" script`;
      let l: List;
      try {
        l = parse(text, true);
      } catch (e) {
        if (e instanceof Refused) throw new Refused(`${label} ${e.message}`);
        throw e;
      }
      this.list(l, { label, script: true, st: { cwd: dir, vars: new Map(), pids: new Set() }, unsure: false, depth: ctx.depth + 1, top: false, bin });
    }
  }

  // What a package manager reads beside a package that can run code.
  private packageConfig(tool: string, from: string, ctx: Ctx, line: number): void {
    for (let d = from; this.inRepo(d); d = path.dirname(d)) {
      const npmrc = path.join(d, '.npmrc');
      if ((tool === 'npm' || tool === 'npx' || tool === 'pnpm') && isFile(npmrc)) {
        const real = this.reads.real(npmrc)!;
        this.files.add(real);
        const text = this.reads.text(real) ?? '';
        if (text.length > MAX_CONFIG_BYTES) this.refuse(ctx, line, `runs ${tool} beside ${this.rel(npmrc)}, over ${MAX_CONFIG_BYTES / 1024} KB.`);
        for (const raw of text.split('\n')) {
          const key = npmKey(raw.trimStart());
          if (!key || NPMRC_KEYS.has(key) || /^@[^:]+:registry$/.test(key) || key.startsWith('//')) continue;
          this.refuse(ctx, line, `runs ${tool} beside ${this.rel(npmrc)}, which sets ${key}, which isn't one patch trust knows runs nothing.`);
        }
      }
      if (tool === 'pnpm' && isFile(path.join(d, '.pnpmfile.cjs'))) this.refuse(ctx, line, 'runs pnpm beside a .pnpmfile.cjs, code pnpm loads by its own rules.');
      if (tool === 'bun' && isFile(path.join(d, 'bunfig.toml'))) this.refuse(ctx, line, `runs ${tool} beside a bunfig.toml, whose preloads run first by their own rules.`);
      if (tool === 'yarn') {
        for (const rc of ['.yarnrc.yml', '.yarnrc']) {
          const p = path.join(d, rc);
          if (!isFile(p)) continue;
          const real = this.reads.real(p)!;
          this.files.add(real);
          const c = rcConfig(rc, this.reads.text(real) ?? '');
          if (c.problem || c.paths.length) this.refuse(ctx, line, `runs yarn beside ${this.rel(p)}, which loads code (yarnPath or plugins) by its own rules.`);
        }
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
  }

  // A live command's npx: only `npx convex data|run ...` (CONVEX), with
  // convex already installed in node_modules/.bin (else npx fetches
  // whatever has that name now), and not beside an .npmrc that runs code.
  // One the repo commits is followed as its file.
  private npx(args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, 'npx');
    const name = vals[0] ?? '';
    if (name.toLowerCase() !== 'convex') this.refuse(ctx, line, `runs \`npx ${name}\`: only \`npx convex data\` and \`npx convex run\` are on the short list, ${OFF}.`);
    if (ctx.st.cwd === undefined) this.refuse(ctx, line, `runs npx after a cd patch trust couldn't follow.`);
    // npm's project folder: the nearest with a package.json or node_modules.
    let prefix: string | undefined;
    for (let d = ctx.st.cwd; ; d = path.dirname(d)) {
      if (exists(path.join(d, 'package.json')) || exists(path.join(d, 'node_modules'))) {
        prefix = d;
        break;
      }
      if (path.dirname(d) === d) break;
    }
    const bin = prefix && path.join(prefix, 'node_modules', '.bin', name);
    if (!bin || !exists(bin)) this.refuse(ctx, line, `runs \`npx ${name}\`, which isn't installed in node_modules/.bin, so npx would fetch whatever has that name now.`);
    this.packageConfig('npx', prefix!, ctx, line);
    const sub = vals[1] ?? '';
    if (!Object.hasOwn(CONVEX, sub)) this.refuse(ctx, line, `runs \`npx convex ${sub}\`: only \`npx convex data\` and \`npx convex run\` are on the short list, ${OFF}.`);
    this.spec(`npx convex ${sub}`, args.slice(2), ctx, line, CONVEX[sub]!);
    // The link must lead to the convex package, not wherever a committed or
    // planted link says (`ln -s /tmp/payload node_modules/.bin/convex`; Muse's
    // review). One you installed isn't hashed, as SECURITY.md says; outside
    // the repo (a worktree's linked node_modules) only you may have written it.
    const real = realOr(bin);
    // (pnpm's and yarn's shim is a plain file there, not a link.)
    if (!isFile(real) || !(real === bin || /\/node_modules\/convex\//.test(real))) this.refuse(ctx, line, `runs \`npx convex\`, whose node_modules/.bin/convex leads to ${real}, not the convex package.`);
    if (this.inRepo(real) && this.tracked(real, ctx, line)) return this.repoFile(real, name, args.slice(1), ctx, line, 'js');
    if (!this.inRepo(real)) {
      const why = ownedPathProblem(real);
      if (why) this.refuse(ctx, line, `runs \`npx convex\`, from outside the repo, and ${why}.`);
    }
    this.other('npx', ctx);
  }

  // env, nohup, nice, timeout: only around a script of the repo's.
  private wrapper(name: string, args: Word[], ctx: Ctx, line: number): void {
    const spec = WRAPPERS[name]!;
    const vals = this.known(args, ctx, line, name);
    let i = 0;
    for (; i < vals.length; i++) {
      const v = vals[i]!;
      if (spec.opts.includes(v)) {
        i++;
        continue;
      }
      if (v.startsWith('-') && spec.flags.test(v)) continue;
      if (v.startsWith('-') || (name === 'env' && v.includes('='))) this.refuse(ctx, line, `runs \`${name} ${v}\`, ${OFF}.`);
      break;
    }
    i += spec.lead ?? 0;
    const rest = args.slice(i);
    const first = vals[i];
    if (first === undefined || !first.includes('/')) this.refuse(ctx, line, `runs ${first ?? 'a command'} through ${name}, which patch trust only follows for a script of the repo's (./scripts/x.sh).`);
    const p = this.abs(first, ctx);
    if (p === undefined || !this.inRepo(p)) this.refuse(ctx, line, `runs ${first} through ${name}, which patch trust only follows for a script of the repo's.`);
    this.repoFile(p, first, rest.slice(1), ctx, line, undefined);
  }

  // find with literal words, and none of its actions that run or delete
  // something or write a file.
  private find(args: Word[], ctx: Ctx, line: number): void {
    for (const v of this.known(args, ctx, line, 'find')) {
      if (/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(v)) this.refuse(ctx, line, `runs find ${v}, which runs, deletes or writes something, ${OFF}.`);
    }
    this.other('find', ctx);
  }

  // A committed bare repo in a folder (HEAD, objects/, refs/, and a config
  // git reads) makes git, and gh through it, run that config's commands.
  private noBareRepo(name: string, ctx: Ctx, line: number): void {
    if (ctx.st.cwd === undefined) this.refuse(ctx, line, `runs ${name} after a cd patch trust couldn't follow.`);
    for (let d = ctx.st.cwd; this.inRepo(d) && d !== this.o.top; d = path.dirname(d)) {
      if (isFile(path.join(d, 'HEAD')) && isDir(path.join(d, 'objects')) && isDir(path.join(d, 'refs'))) this.refuse(ctx, line, `runs ${name} in ${this.rel(d)}, which looks like a git repository of its own, whose config git would read.`);
      if (path.dirname(d) === d) break;
    }
  }

  // git, and gh (which runs git): not in a nested repo, and only where the
  // repo's own config keeps to settings that add nothing git runs.
  private gitReady(name: string, ctx: Ctx, line: number): void {
    this.noBareRepo(name, ctx, line);
    const why = repoGitConfigProblem(ctx.st.cwd!);
    if (why) this.refuse(ctx, line, `runs ${name} in a repo ${why}, ${OFF}.`);
  }

  // awk with a literal program that runs nothing, reads nothing but its
  // input and files and writes nothing: no system, getline, pipes, `>` (an
  // output redirect; a comparison has to be written `<` the other way) or
  // @load. Options -F and -v only; every word literal.
  private awk(args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, 'awk');
    let i = 0;
    for (; i < vals.length; i++) {
      const v = vals[i]!;
      if (v === '-F' || v === '-v') {
        i++;
        continue;
      }
      if (/^-F./.test(v)) continue;
      if (v.startsWith('-')) this.refuse(ctx, line, `runs awk ${v}, ${OFF}.`);
      break;
    }
    const program = vals[i];
    if (program === undefined) this.refuse(ctx, line, `runs awk without a program, ${OFF}.`);
    if (/system|getline|\||@|ENVIRON|>/.test(program)) this.refuse(ctx, line, "runs an awk program that may run a command or write a file (system, getline, a pipe, `>` or @load), which patch trust doesn't follow.");
    this.other('awk', ctx);
  }

  // A hook's other programs: every word literal; say and uniq without the
  // forms that write a file (`say -o`, `uniq in out`).
  private hookProgram(name: string, args: Word[], ctx: Ctx, line: number): void {
    const vals = this.known(args, ctx, line, name);
    if (name === 'say') {
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i]!;
        if (v === '-v' || v === '-r') i++;
        else if (v.startsWith('-')) this.refuse(ctx, line, `runs say ${v.slice(0, 40)}, which may write a file or send what it says elsewhere, ${OFF}.`);
      }
    }
    if (name === 'uniq' && vals.filter((v) => !v.startsWith('-')).length > 1) this.refuse(ctx, line, `runs uniq with two files, which writes the second, ${OFF}.`);
    this.other(name, ctx);
  }
}

// bun's own commands, which `bun <word>` runs before any file or script.
const BUN_COMMANDS = new Set(['test', 'build', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'pm', 'x', 'create', 'init', 'upgrade', 'outdated', 'publish', 'patch', 'patch-commit', 'repl', 'help', 'completions', 'audit', 'info', 'why', 'exec', 'ci']);

// Whether `bun <word>` names a file rather than a package script.
function looksLikeFile(s: string, cwd: string | undefined): boolean {
  if (s.includes('/') || /\.(m?[jt]sx?|c[jt]s)$/.test(s)) return true;
  return cwd !== undefined && isFile(path.resolve(cwd, s));
}

// Whether a path named `base` that resolves to `real` is that program.
// Ubuntu's /bin/sh is dash and its awk mawk or gawk: each is held as what
// it's called, and they take the same words that matter.
function sameProgram(real: string, base: string): boolean {
  const a = real.toLowerCase();
  const b = base.toLowerCase();
  const awks = ['awk', 'gawk', 'mawk', 'nawk'];
  return a === b || (SHELLS.has(a) && SHELLS.has(b)) || (awks.includes(a) && awks.includes(b));
}

// A Spec's `data` operand: quoted, so it isn't split, and starting with
// literal text that isn't `-`, so whatever it holds can't be an option.
function dataWord(w: Word): boolean {
  const first = w.parts[0];
  if (!first || first.k !== 'lit' || !first.s || first.s.startsWith('-')) return false;
  // `"a$@"` is several words in bash, so the rest could be options.
  return w.parts.every((p) => p.k === 'lit' || (p.k !== 'tilde' && p.q && !(p.k === 'var' && (p.name === '@' || p.name === '*'))));
}

// Whether a script's #! line is a shell run plainly (`-e`, `-u`, `-x` at
// most), not one that reads its commands from elsewhere.
function shebangOk(text: string): boolean {
  if (shebangReadsElsewhere(text)) return false;
  const m = /^#![ \t]*(\S+)([^\n]*)/.exec(text);
  if (!m) return true;
  const words = m[2]!.trim().split(/[ \t]+/).filter(Boolean);
  if (path.basename(m[1]!) === 'env') return words.length === 1 && SHELLS.has(words[0]!);
  return SHELLS.has(path.basename(m[1]!)) && words.every((w) => /^[-+][euxf]+$/.test(w));
}

function shownWord(w: Word): string {
  return w.parts.map((p) => (p.k === 'lit' ? p.s : p.k === 'tilde' ? '~' : p.k === 'var' ? `$${p.name}` : '$(...)')).join('').slice(0, 80);
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

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Whether a shell's `cd` to `d` would work now.
function enterable(d: string): boolean {
  try {
    fs.accessSync(d, fs.constants.X_OK);
    return isDir(d);
  } catch {
    return false;
  }
}

function nearestReal(d: string): string {
  for (let x = d; ; x = path.dirname(x)) {
    try {
      return path.join(fs.realpathSync(x), path.relative(x, d));
    } catch {
      if (path.dirname(x) === x) return d;
    }
  }
}

function underNodeModules(rel: string): boolean {
  return inNodeModules(rel);
}

// ---- a file outside the repo ----

// Rights an ACL entry can grant that let someone change a file or what a
// folder holds.
const ACL_WRITES = /(^|,)(write|append|writeattr|writeextattr|writesecurity|chown|delete|delete_child|add_file|add_subdirectory)(,|$)/;
const ownedCache = new Map<string, string | undefined>();

// Why `p` (absolute, outside the repo) isn't a file only you or root
// could have written, or undefined if it is. Walks the path a part at a
// time as the system resolves it, links and all: each folder it passes
// through must be yours or root's and not writable by its group or anyone
// (a sticky one, like /tmp, aside: there only an entry's owner can rename
// it), each link yours or root's, and the file itself yours or root's,
// a plain file, and not writable by its group or anyone. The whole path
// must resolve. On macOS an ACL can give someone else write whatever the
// mode says, so `ls -led` must show no entry that allows anyone but you
// to write any of them. On Linux a POSIX ACL's mask is the group bits, so
// the mode check covers it. Elsewhere it's refused.
export function ownedPathProblem(p: string): string | undefined {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return "this system's permissions aren't ones patch trust checks";
  if (!path.isAbsolute(p)) return "its path isn't absolute";
  const me = process.getuid?.();
  if (me === undefined) return "patch trust can't tell who you are";
  const ok = (uid: number) => uid === me || uid === 0;
  const passed: string[] = ['/'];
  const sig: string[] = [];
  const dirOk = (st: fs.Stats) => ok(st.uid) && (!(st.mode & 0o022) || (st.mode & 0o1000) !== 0);
  try {
    const root = fs.lstatSync('/');
    sig.push(`${root.ino}:${root.ctimeMs}`);
    if (!dirOk(root)) return '/ is writable by others';
    let todo = p.split('/').filter(Boolean);
    let cur = '/';
    let hops = 0;
    while (todo.length) {
      const c = todo.shift()!;
      if (c === '.') continue;
      // `cur` is a real folder already checked, so its parent is too.
      if (c === '..') {
        cur = path.dirname(cur);
        continue;
      }
      const next = path.join(cur, c);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(next);
      } catch {
        return `${next} isn't there`;
      }
      passed.push(next);
      sig.push(`${st.ino}:${st.ctimeMs}:${st.mode}:${st.uid}`);
      if (st.isSymbolicLink()) {
        if (!ok(st.uid)) return `${next} is a link someone else made`;
        if (++hops > 40) return 'its path has too many links';
        const target = fs.readlinkSync(next);
        todo = [...target.split('/').filter(Boolean), ...todo];
        if (target.startsWith('/')) cur = '/';
        continue;
      }
      if (todo.length) {
        if (!st.isDirectory()) return `${next} isn't a folder`;
        if (!dirOk(st)) return `${next} is a folder someone else could change`;
        cur = next;
      } else {
        if (!st.isFile()) return `${next} isn't a plain file`;
        if (!ok(st.uid) || st.mode & 0o022) return `${next} is a file someone else could change`;
      }
    }
  } catch (e) {
    return `its path can't be read (${(e as Error).message})`;
  }
  if (process.platform !== 'darwin') return undefined;
  const key = `${passed.join('\0')}\u0001${sig.join(',')}`;
  if (ownedCache.has(key)) return ownedCache.get(key);
  const why = aclProblem(passed);
  if (ownedCache.size > 200) ownedCache.clear();
  ownedCache.set(key, why);
  return why;
}

function aclProblem(paths: string[]): string | undefined {
  let out: string;
  try {
    out = execFileSync('/bin/ls', ['-led', '--', ...paths], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 }).toString();
  } catch {
    return "its folders' access lists can't be read";
  }
  const mine = `user:${os.userInfo().username}`;
  for (const raw of out.split('\n')) {
    const m = /^\s*\d+: (\S+) (allow|deny) (\S+)/.exec(raw);
    if (!m || m[2] !== 'allow' || m[1] === mine) continue;
    if (ACL_WRITES.test(m[3]!)) return `an access list there lets ${m[1]} write (${m[3]})`;
  }
  return undefined;
}

// ---- git's own config ----

// Settings of a repo's own config (.git/config, a worktree's config, and
// what they include) that add nothing git runs for the subcommands on the
// live list. Any other (core.hooksPath, core.fsmonitor, core.sshCommand,
// core.pager, include.path, filter.*, diff.*, alias.*, protocol.*,
// url.*.insteadOf, remote.*.vcs, gpg.*...) and git isn't run there.
// Credential helpers are on it because liveCommandEnv turns every one off
// and puts back only yours.
const LOCAL_GIT_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|checkstat|trustctime)$/,
  /^remote\..+\.(url|pushurl|fetch|tagopt|prune|prunetags|gh-resolved|skipdefaultupdate|skipfetchall)$/,
  /^branch\..+\.[a-z0-9-]+$/,
  /^extensions\.(worktreeconfig|objectformat|refstorage)$/,
  /^user\.(name|email)$/,
  /^credential\..+$/,
  /^lfs\.repositoryformatversion$/,
  /^(pull\.(rebase|ff)|push\.(default|autosetupremote)|init\.defaultbranch|fetch\.prune|rerere\.enabled)$/,
];
// A remote's fetch refspec fills remote-tracking refs and tags, not your
// branches.
const REMOTE_FETCH = /^(\^.*|\+?[^:]*:refs\/(remotes|tags)\/[^:]*)$/;
// A remote that's reached over https or ssh: nothing else is allowed
// (liveCommandEnv's protocol.allow), and a local path would run git's
// upload-pack here with that repo's config.
const REMOTE_URL = /^(https:\/\/|ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/;

let gitVersion: { at: number; ok: boolean } | undefined;

// GIT_CONFIG_COUNT, which liveCommandEnv uses, came in git 2.31: older
// ones ignore it and would run the repo's hooks.
function gitNewEnough(): boolean {
  if (gitVersion && Date.now() - gitVersion.at < 10 * 60_000) return gitVersion.ok;
  let ok = false;
  try {
    const m = /git version (\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString());
    ok = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 31));
  } catch {
    ok = false;
  }
  gitVersion = { at: Date.now(), ok };
  return ok;
}

// git config --list --show-scope -z: scope, then key and value.
function gitConfig(cwd: string, env: Record<string, string | undefined> = process.env): { scope: string; key: string; value?: string }[] {
  const out = execFileSync('git', ['config', '--list', '--show-scope', '--includes', '-z'], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).toString();
  const items = out.split('\0');
  const list: { scope: string; key: string; value?: string }[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    const kv = items[i + 1]!;
    const nl = kv.indexOf('\n');
    list.push({ scope: items[i]!, key: nl < 0 ? kv : kv.slice(0, nl), ...(nl < 0 ? {} : { value: kv.slice(nl + 1) }) });
  }
  return list;
}

// Why git (or gh) shouldn't run in `cwd` for a live command, or undefined:
// git too old for liveCommandEnv, or the repo's own config sets something
// off LOCAL_GIT_KEYS.
export function repoGitConfigProblem(cwd: string): string | undefined {
  if (!gitNewEnough()) return "with git older than 2.31, which can't be told to leave the repo's hooks and fsmonitor off";
  let list;
  try {
    list = gitConfig(cwd);
  } catch {
    return "whose git config can't be read";
  }
  for (const { scope, key, value } of list) {
    if (scope !== 'local' && scope !== 'worktree') continue;
    if (!LOCAL_GIT_KEYS.some((re) => re.test(key))) return `whose own git config sets ${key.slice(0, 80)}, which isn't one of the settings patch trust knows add nothing git runs`;
    if (/^remote\..+\.(url|pushurl)$/.test(key) && !REMOTE_URL.test(value ?? '')) return `whose remote ${key.slice(7, key.lastIndexOf('.')).slice(0, 60)} isn't reached over https or ssh`;
    if (/^remote\..+\.fetch$/.test(key) && !REMOTE_FETCH.test(value ?? '')) return `whose remote ${key.slice(7, -6).slice(0, 60)} fetches into your own branches`;
  }
  return undefined;
}

let ownGit: { at: number; key: string; pairs: [string, string][] } | undefined;

// Your own git settings (system, global, and any already in the
// environment) that liveCommandEnv turns off for the repo's and puts
// back: credential helpers in order, and core.sshCommand. Read from `/`,
// so no repo's own config is among them, and kept for a minute.
function ownGitSettings(env: Record<string, string | undefined>): [string, string][] {
  const key = JSON.stringify(Object.entries(env).filter(([k]) => /^(HOME|XDG_CONFIG_HOME|GIT_CONFIG.*|PREFIX)$/.test(k)).sort());
  if (ownGit && ownGit.key === key && Date.now() - ownGit.at < 60_000) return ownGit.pairs;
  const helpers: [string, string][] = [];
  let ssh: string | undefined;
  try {
    for (const { scope, key, value } of gitConfig('/', env)) {
      if (scope === 'local' || scope === 'worktree') continue;
      if (/^credential\.(.+\.)?helper$/.test(key)) helpers.push([key, value ?? '']);
      if (key === 'core.sshcommand') ssh = value;
    }
  } catch {
    // No git, or none of yours: no helpers, plain ssh.
  }
  const pairs: [string, string][] = [['core.sshCommand', ssh ?? 'ssh'], ['credential.helper', ''], ...helpers];
  ownGit = { at: Date.now(), key, pairs };
  return pairs;
}

// The environment every live command runs with (runner/patches.ts
// runPatchCommand), on top of `env`: git settings at the command line's
// level, which beat the repo's own .git/config, so nothing it says makes
// git, or gh through it, run something. No hooks (core.hooksPath), no
// fsmonitor, no bare repo found by looking (safe.bareRepository), only
// https and ssh remotes (so no ext::, file:// or git://, which run
// commands or another repo's upload-pack), no submodule fetches (their
// config isn't checked), no cookies saved, no alternates command, your
// own ssh command and credential helpers only, and no askpass program or
// prompt. Filters and diff drivers aren't touched: none of the live
// list's git commands read the working tree or make a diff, and a repo
// that defines one is refused (LOCAL_GIT_KEYS).
export function liveCommandEnv(env: Record<string, string | undefined>): Record<string, string> {
  const pairs: [string, string][] = [
    ['core.fsmonitor', ''],
    ['core.hooksPath', '/dev/null'],
    ['safe.bareRepository', 'explicit'],
    // A protocol's own setting beats protocol.allow, so the repo's
    // protocol.ext.allow=always would win: each is set here too.
    ['protocol.allow', 'never'],
    ['protocol.ext.allow', 'never'],
    ['protocol.fd.allow', 'never'],
    ['protocol.file.allow', 'never'],
    ['protocol.git.allow', 'never'],
    ['protocol.http.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['protocol.ssh.allow', 'always'],
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['http.saveCookies', 'false'],
    ['core.alternateRefsCommand', 'true'],
    // No gc after a fetch: it would go off in a session of its own, which
    // ending the command's process group doesn't reach.
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ...ownGitSettings(env),
  ];
  const had = /^\d{1,3}$/.test(env.GIT_CONFIG_COUNT ?? '') ? Number(env.GIT_CONFIG_COUNT) : 0;
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(had + pairs.length), GIT_TERMINAL_PROMPT: '0' };
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${had + i}`] = k;
    out[`GIT_CONFIG_VALUE_${had + i}`] = v;
  });
  // An empty GIT_ASKPASS stops git asking a program (core.askPass included).
  if (env.GIT_ASKPASS === undefined) out.GIT_ASKPASS = '';
  return out;
}

// Whether `command`, run by a shell in `opts.folder`, keeps to the short
// list, and the files it runs, sources or loads (which the caller holds
// to the hash). `problem` says what it can't follow, the first thing.
// `vars`: what the shell already has set (a Claude Code hook's
// CLAUDE_PROJECT_DIR).
export function allowCommand(command: string, label: string, opts: AllowOptions, vars: Record<string, string> = {}): ScriptReach & { ran: string[] } {
  const a = new Allow(opts);
  const done = (problem?: string) => ({ files: [...a.files], missing: [...a.missing], ran: [...a.ran], ...(problem ? { problem } : {}) });
  if (command.length > MAX_COMMAND_BYTES) return done(`${label} is over ${MAX_COMMAND_BYTES / 1024} KB, more than patch trust reads of a command.`);
  try {
    const l = parse(command, false);
    a.list(l, { label, script: false, st: { cwd: opts.folder, vars: new Map(Object.entries(vars)), pids: new Set() }, unsure: false, depth: 0, top: true });
  } catch (e) {
    if (e instanceof Refused) return done(`${label} ${e.message}`);
    // A bug here mustn't let the command through: it fails closed.
    return done(`${label} couldn't be followed (${(e as Error).message}).`);
  }
  // A live command built in code from what it read could change the file
  // it runs first; its own text can't change, but its pieces can.
  if (opts.live && a.ranRepo && a.others.size) {
    return done(`${label} runs ${a.ranRepo} and also runs ${[...a.others][0]}, which could change it before it runs, ${OFF}: run the repo's file on its own, or put the steps in it.`);
  }
  return done();
}
