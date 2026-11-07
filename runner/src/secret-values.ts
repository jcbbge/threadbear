// Secrets the runner can actually know, masked wherever they turn up: its own
// (secrets/, answers to ask_secret, secret-named variables in its environment)
// and what's in the .env files of the folders its threads work in. The rules
// in redaction.ts go by shape, so they miss a value with no telling prefix;
// these go by the value itself, however it was mangled, a line at a time.
//
// In memory only. Nothing here logs a value, writes one down or sends one
// anywhere, and errors name the file at most. Files are looked at when a
// folder first turns up and then at most every REFRESH_MS, read again only if
// their size or time changed.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nameHoldsSecret } from './redaction.ts';
import { hasLineBreak, hasUrlCredentials, isSpace, lastLineBreakIn, stripEnvComment } from './linear-text.ts';

export const REFRESH_MS = 5 * 60_000;
// A value shorter than this is too likely to be an ordinary word, and masking
// it would shred text. An answer to ask_secret was a secret for certain, so it
// can be a little shorter.
const MIN_ENV_VALUE = 12;
const MIN_ASKED_VALUE = 8;
// A line of a multi-line value, such as a key's base64.
const MIN_LINE = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CHILD_FOLDERS = 100;
// No limit on how many .env files a look reads, though a repo decides how
// many it has. One that stopped at a count (tried for Gautam's scan, F25)
// let a repo's 500 junk .env.<x> files push your own .env.qa.local out of
// the mask while the mirror carried on (Codex's review, 6 Nov 2026). Each
// file is at most MAX_FILE_BYTES, parses in time linear in its length and
// is read with an await between, so many of them take longer to read but
// never hold the event loop for more than one file's parse.
const SKIP_FOLDERS = new Set(['node_modules', 'dist', 'build', 'vendor', 'Pods', 'DerivedData']);

// How much of a value has to be there for its cut-off start to be recognised,
// and what can follow one: the marks the runner's cuts leave.
const MIN_CUT_OFF = 12;
// How long one folder gets before it's left for the next look.
const FOLDER_MS = 5000;
const CUT_ENDING = /(?:…|\.\.\.|\n\n\[cut: [^\]\n]*\](?:\n\n\[\d+ pictures?\])?)?\s*$/;

// Examples and templates hold placeholders, not values.
const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist|defaults?)$/i;
// Names that hold an address, a place or a label. Worth saying what they are,
// as masking `CONVEX_URL` would blank a deployment's address out of every row.
const PLAIN_NAME = /(?:^|_)(?:URL|URI|HOST|HOSTNAME|DOMAIN|ENDPOINT|DEPLOYMENT|REGION|PATH|DIR|FILE|PORT|MODE|ENV|VERSION|NAME|TEAM|PROJECT|ORG|BUCKET|ID|EMAIL|USER|USERNAME|SITE)$/i;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

// Could this value be a credential whatever its name says?
export function looksRandom(value: string): boolean {
  if (value.length < 20 || /\s/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !hasUrlCredentials(value)) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  return entropy(value) >= 3.5 && /\d/.test(value) && /[A-Za-z]/.test(value);
}

function linesOf(value: string): string[] {
  return value
    .split(/\r?\n|(?:\\r)?\\n/)
    .map((l) => l.trim().replace(/^['"]|['"]$/g, ''))
    .filter((l) => l.length >= MIN_LINE && !l.startsWith('-----'));
}

// What to mask of one variable: the whole value, and each line of a multi-line
// one, since `sed`, `cut` and `sort` leave the lines of a key on their own.
export function valuesOfVariable(name: string, value: string): string[] {
  const v = value.trim();
  if (v.length < MIN_ENV_VALUE) return [];
  const named = nameHoldsSecret(name);
  if (!named && (PLAIN_NAME.test(name) || /public/i.test(name)) && !hasUrlCredentials(v)) return [];
  const pieces = linesOf(v);
  if (!named && !looksRandom(v) && !pieces.some(looksRandom)) return [];
  return [...new Set([v, ...pieces])];
}

// KEY=value lines, `export` or not, with quoted values that may run over
// several lines. Not a full dotenv: a line it can't read is left out.
//
// A repo writes these files, so this takes time in proportion to the file
// however it's laid out: no regex here can backtrack over a long run of
// spaces (`/\s+#.*$/` could, for minutes: Gautam's scan, F25), and a
// quote that never closes looks for its end once, not again from every
// line after it.
export function parseEnvFile(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const lines = text.split(/\r?\n/);
  // Per quote mark, the next line it closes on, from the last look. Asked
  // with i only ever growing, so each line is looked at once per mark.
  const closes = new Map<string, number>();
  const nextClose = (quote: string, after: number): number => {
    const known = closes.get(quote);
    if (known !== undefined && known > after) return known;
    let j = after + 1;
    while (j < lines.length && closeOn(lines[j]!, quote) < 0) j++;
    closes.set(quote, j);
    return j;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/.exec(line);
    if (!m) continue;
    // What `\s*(.*)$` took: a line break left in the value (a lone \r)
    // was no match.
    let value = line.slice(m[0].length).trimStart();
    if (hasLineBreak(value)) continue;
    const name = m[1]!;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // Where the quote closes on this line: what follows it can only be
      // a comment. Not closed here, it runs on.
      const rest = value.slice(1);
      const here = closeOn(rest, quote);
      if (here >= 0) {
        value = rest.slice(0, here);
      } else {
        const j = nextClose(quote, i);
        if (j < lines.length) {
          value = [rest, ...lines.slice(i + 1, j), lines[j]!.slice(0, closeOn(lines[j]!, quote))].join('\n');
          i = j;
        } else value = rest; // never closed: take the one line
      }
    } else {
      // An unquoted value ends at a comment.
      value = stripEnvComment(value);
    }
    out.push({ name, value });
  }
  return out;
}

// Where `quote` closes in `s`, ignoring an escaped one in double quotes: the
// first one followed only by whitespace, or by whitespace and a comment.
// What `/^\s*(#.*)?$/` said of the rest, with no regex run again from
// each quote mark.
function closeOn(s: string, quote: string): number {
  const lastBreak = lastLineBreakIn(s);
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && quote === '"') k++;
    else if (s[k] === quote) {
      let j = k + 1;
      while (j < s.length && isSpace(s[j])) j++;
      // A comment runs to the end, so no line break after its #.
      if (j === s.length || (s[j] === '#' && lastBreak < j)) return k;
    }
  }
  return -1;
}

// A file under secrets/: the variables of a .env-style file, the string values
// of a JSON one (a kept deploy key), else its whole content and each line.
export function valuesOfSecretFile(file: string, text: string): string[] {
  const base = path.basename(file);
  if (base.endsWith('.env')) return parseEnvFile(text).flatMap((v) => valuesOfVariable(v.name, v.value));
  const trimmed = text.trim();
  if (base.endsWith('.json')) {
    try {
      const found: string[] = [];
      const walk = (v: unknown, name = ''): void => {
        if (typeof v === 'string') found.push(...valuesOfVariable(name, v));
        else if (Array.isArray(v)) v.forEach((x) => walk(x, name));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
      };
      walk(JSON.parse(trimmed));
      return found;
    } catch {
      // Not JSON after all: the rest of the way, as text.
    }
  }
  if (trimmed.length < MIN_ASKED_VALUE) return [];
  return [...new Set([trimmed, ...linesOf(trimmed)])];
}

type Source = { stamp: string; values: string[]; owner: string };

export class KnownValues {
  private secretsDir?: string;
  private env: NodeJS.ProcessEnv;
  private home: string;
  private now: () => number;
  private onError: (what: string) => void;
  // Per file. A folder's file that goes away takes its values with it.
  private sources = new Map<string, Source>();
  // Kept for this process's life even once the file's gone: answers to
  // ask_secret are swept after 24 hours, and a thread may still quote one.
  private sticky = new Set<string>();
  private folders = new Map<string, number>(); // folder -> when it was last looked at
  // Looked at once, then left: an archived thread's folder, for its history.
  private onceOnly = new Set<string>();
  private pattern?: RegExp | null;
  private starts = new Map<string, string[]>();
  private longest = 0;
  private refreshing?: Promise<void>;
  private lastRefresh = -Infinity;
  // What the look in progress has found, and which root it's looking through.
  private seen = new Set<string>();
  private owner = '';
  private unreadFolders = new Set<string>();
  private lookInFolders: boolean;
  private folderMs: number;

  constructor(opts: { secretsDir?: string; env?: NodeJS.ProcessEnv; home?: string; now?: () => number; onError?: (what: string) => void; folders?: boolean; folderMs?: number } = {}) {
    this.secretsDir = opts.secretsDir;
    // Tests that check what's read, not how fast, give it longer: a busy
    // check host took over 5 s on 600 small files (7 Nov).
    this.folderMs = opts.folderMs ?? FOLDER_MS;
    this.lookInFolders = opts.folders !== false;
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? os.homedir();
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
    for (const [name, value] of Object.entries(this.env)) {
      // Only ones named as secrets: the rest of the environment is paths.
      if (value && nameHoldsSecret(name)) for (const v of valuesOfVariable(name, value)) this.sticky.add(v);
    }
  }

  get count(): number {
    return new Set([...this.sticky, ...[...this.sources.values()].flatMap((s) => s.values)]).size;
  }

  // A value just learned for certain: an answer to ask_secret, the moment it's
  // given, since the agent may quote it straight away.
  add(value: string): void {
    const v = value.trim();
    if (v.length < MIN_ASKED_VALUE) return;
    this.sticky.add(v);
    for (const line of linesOf(v)) this.sticky.add(line);
    this.pattern = undefined;
  }

  // Something in this folder may have changed: a thread just wrote or read a
  // file with secrets in it. Sooner than the usual look, and once a thread
  // reads a .env somewhere else, that folder too.
  lookSoon(dir: string | undefined): void {
    if (!this.lookInFolders || !dir) return;
    if (!this.folders.has(dir)) {
      this.noteFolder(dir);
      return;
    }
    this.folders.set(dir, -Infinity);
    void this.refresh();
  }

  // A folder a thread works in. Looked at soon, and mask() is right for it
  // once settled() has answered.
  noteFolder(dir: string | undefined, once = false): void {
    if (!this.lookInFolders || !dir) return;
    if (this.folders.has(dir)) {
      if (!once) this.onceOnly.delete(dir);
      return;
    }
    if (!path.isAbsolute(dir) || dir.startsWith('/Volumes/') || dir === this.home || dir === '/') return;
    if (once) this.onceOnly.add(dir);
    this.folders.set(dir, -Infinity);
    void this.refresh();
  }

  // The looks in progress, up to a limit: a stuck disk shouldn't stop the
  // mirror, and the shape rules still run.
  // True once there's nothing left to look at. False means it ran out of time,
  // so what's masked may be missing something: the caller holds its text back
  // and tries again rather than sending it. A folder that doesn't answer can't
  // keep this false for ever, as look() gives up on it after FOLDER_MS.
  async settled(ms = 60_000): Promise<boolean> {
    const end = Date.now() + ms;
    // A folder that turned up meanwhile starts another look as this one ends.
    while (this.refreshing) {
      const left = end - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.refreshing, new Promise<void>((r) => (timer = setTimeout(r, left)))]);
      clearTimeout(timer);
    }
    return true;
  }

  // Folders that didn't answer in time on the last look: stuck disks, say. Only
  // the shape rules cover what's in those, and `tb status` says so.
  get unread(): number {
    return this.unreadFolders.size;
  }

  // At most every REFRESH_MS, or sooner for a new folder (noteFolder).
  refreshIfDue(): void {
    if ((this.secretsDir || this.folders.size) && this.now() - this.lastRefresh >= REFRESH_MS) void this.refresh();
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.look().finally(() => {
      this.refreshing = undefined;
      // A folder that turned up during this look. Started here, before anyone
      // waiting on this one runs, so settled() sees there's more to wait for.
      if ([...this.folders.values()].some((at) => at === -Infinity)) void this.refresh();
    });
    return this.refreshing;
  }

  private async look(): Promise<void> {
    const started = this.now();
    this.lastRefresh = started;
    this.seen = new Set();
    const lookedIn = new Set<string>();
    if (this.secretsDir) {
      this.owner = this.secretsDir;
      lookedIn.add(this.owner);
      await this.lookInSecrets(this.secretsDir, 0);
    }
    const due = [...this.folders.entries()].filter(([d, at]) => at === -Infinity || (started - at >= REFRESH_MS && !this.onceOnly.has(d))).map(([d]) => d);
    for (const dir of due) {
      // Set first: one marked due again during its look gets looked at again.
      this.folders.set(dir, started);
      this.owner = dir;
      let timer: NodeJS.Timeout | undefined;
      const answered = await Promise.race([
        this.lookInFolder(dir).then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.folderMs))),
      ]);
      clearTimeout(timer);
      // Not counted as looked through: what's known from it stays.
      if (answered) {
        lookedIn.add(dir);
        this.unreadFolders.delete(dir);
      } else this.unreadFolders.add(dir);
    }
    // A file that's gone takes its values with it. An answer to ask_secret
    // doesn't, as those are kept in `sticky`.
    for (const [file, source] of this.sources) {
      if (lookedIn.has(source.owner) && !this.seen.has(file)) {
        this.sources.delete(file);
        this.pattern = undefined;
      }
    }
  }

  private async lookInSecrets(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) await this.lookInSecrets(file, depth + 1);
      } else if (e.isFile() && !e.name.endsWith('.host') && !e.name.endsWith('.askpass') && !e.name.endsWith('.pub')) {
        // Answers to ask_secret outlive their file.
        const sticky = path.basename(dir) === 'asked';
        await this.readSource(file, (text) => valuesOfSecretFile(file, text), sticky);
      }
    }
  }

  // The folder, up to its repo's root, and one level down (web/.env.local).
  private async lookInFolder(dir: string): Promise<void> {
    const seen = new Set<string>();
    const lookFor = async (d: string) => {
      if (seen.has(d)) return;
      seen.add(d);
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      const names = new Set<string>();
      for (const e of entries) {
        names.add(e.name);
        if ((e.isFile() || e.isSymbolicLink()) && ENV_FILE.test(e.name) && !ENV_EXAMPLE.test(e.name)) {
          const file = path.join(d, e.name);
          await this.readSource(file, (text) => parseEnvFile(text).flatMap((v) => valuesOfVariable(v.name, v.value)), false);
        }
      }
      return { entries, names };
    };
    const here = await lookFor(dir);
    if (here) {
      let children = 0;
      for (const e of here.entries) {
        if (children >= MAX_CHILD_FOLDERS) break;
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_FOLDERS.has(e.name)) continue;
        children++;
        await lookFor(path.join(dir, e.name));
      }
    }
    let d = dir;
    for (let up = 0; up < 4; up++) {
      const atRoot = await fsp.stat(path.join(d, '.git')).then(() => true, () => false);
      if (atRoot) break;
      const parent = path.dirname(d);
      if (parent === d || parent === this.home || !parent.startsWith(this.home + path.sep)) break;
      d = parent;
      await lookFor(d);
    }
  }

  private async readSource(file: string, values: (text: string) => string[], sticky: boolean): Promise<void> {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
      // A link that leads to an external drive, which is never looked through.
      if ((await fsp.realpath(file)).startsWith('/Volumes/')) return;
      this.seen.add(file);
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (this.sources.get(file)?.stamp === stamp) return;
      const found = values(await fsp.readFile(file, 'utf8'));
      if (sticky) for (const v of found) this.sticky.add(v);
      this.sources.set(file, { stamp, values: found, owner: this.owner });
      this.pattern = undefined;
    } catch (e) {
      // Gone, or not ours to read. The code alone: nothing else to go on is
      // worth a chance of a value turning up in a log.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(`${path.basename(file)}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
    }
  }

  // Longest first, so a whole value goes before a line of it. With how it reads
  // inside JSON text too, where a quote or a newline in it is escaped. Whitespace
  // in one matches any whitespace, as a preview's line has its runs closed up.
  // A short one only as a whole word: an eight-letter password shouldn't take a
  // piece out of every longer word it happens to be in.
  private compiled(): RegExp | null {
    if (this.pattern !== undefined) return this.pattern;
    const all = new Set(this.sticky);
    for (const s of this.sources.values()) for (const v of s.values) all.add(v);
    for (const v of [...all]) {
      all.add(JSON.stringify(v).slice(1, -1));
      // As a preview has it, cut off or whole, with its runs of whitespace closed up.
      if (/\s/.test(v)) all.add(v.replace(/\s+/g, ' '));
    }
    this.starts = new Map();
    this.longest = 0;
    for (const v of all) {
      this.longest = Math.max(this.longest, v.length);
      if (v.length <= MIN_CUT_OFF) continue;
      const start = v.slice(0, MIN_CUT_OFF);
      const list = this.starts.get(start);
      if (list) list.push(v);
      else this.starts.set(start, [v]);
    }
    const list = [...all]
      .sort((a, b) => b.length - a.length)
      .map((v) => {
        const lit = v.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&').replace(/\s+/g, '\\s+');
        return v.length < 16 && /^[A-Za-z0-9]/.test(v) && /[A-Za-z0-9]$/.test(v) ? `(?<![A-Za-z0-9])${lit}(?![A-Za-z0-9])` : lit;
      });
    this.pattern = list.length ? new RegExp(list.join('|'), 'g') : null;
    return this.pattern;
  }

  mask(text: string): string {
    const re = this.compiled();
    return re ? this.maskCutOff(text.replace(re, '[REDACTED]')) : text;
  }

  // A value cut off at the end of the text: a title, a tool line or a message
  // cut short before this runner knew the value. All but the last few
  // characters would otherwise go up, and no whole-value match can see it. By
  // each value's first few characters in a table, so this costs the same however
  // many values there are.
  private maskCutOff(text: string): string {
    if (text.length < MIN_CUT_OFF || !this.starts.size) return text;
    const from = Math.max(0, text.length - this.longest - 64);
    const tail = text.slice(from);
    const ending = CUT_ENDING.exec(tail.slice(-200));
    const end = ending ? Math.max(0, tail.length - 200) + ending.index : tail.length;
    const head = tail.slice(0, end);
    for (let at = 0; at + MIN_CUT_OFF <= head.length; at++) {
      const candidates = this.starts.get(head.slice(at, at + MIN_CUT_OFF));
      if (!candidates) continue;
      const rest = head.slice(at);
      if (candidates.some((v) => rest.length < v.length && v.startsWith(rest))) return `${text.slice(0, from + at)}[REDACTED]${tail.slice(end)}`;
    }
    return text;
  }
}
