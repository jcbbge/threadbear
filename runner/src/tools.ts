import fs from 'node:fs';
import path from 'node:path';
import type { Hunk, PlanEntry, ToolKind } from './protocol.ts';
import { MAYBE_RUNS_AS_CODE, RUNS_AS_CODE } from './code-writes.ts';
import { LIMITS } from './protocol.ts';
import { applyReplace, diffLines } from './diff.ts';
import { firstLineSafely, safeEnd } from './safe-cut.ts';

const KINDS: Record<string, ToolKind> = {
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  PowerShell: 'command',
  Monitor: 'command',
  Read: 'read',
  NotebookRead: 'read',
  ReadMcpResourceTool: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Glob: 'search',
  Grep: 'search',
  LS: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'task',
  Task: 'task',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  return KINDS[name] ?? 'other';
}

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

// The folders a shell command works in: where its `cd`, `pushd` and
// `git -C` point, in order, so a later relative `cd` follows an earlier one.
// An agent in a catch-all folder like ~/dev/me/misc often does all its work
// this way (`cd ~/dev/me/app && ...`), which no Edit or Write call shows.
// A folder spelt with any other variable or a command substitution is
// skipped rather than guessed at.
export function commandFolders(command: string, cwd: string, home: string): string[] {
  const found: string[] = [];
  let at = cwd;
  const re = /(?:^|[\s;&|(])(?:(?:cd|pushd)\s+|git\s+-C\s+)("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
  for (const m of command.matchAll(re)) {
    let arg = m[1];
    const quote = arg[0] === "'" ? "'" : arg[0] === '"' ? '"' : '';
    if (quote) arg = arg.slice(1, -1);
    if (quote !== "'") arg = arg.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, '~');
    if (!arg || arg === '-' || arg.startsWith('-') || (quote !== "'" && /[$`]/.test(arg))) continue;
    if (!quote && /[*?\\]/.test(arg)) continue;
    const dir = arg === '~' ? home : arg.startsWith('~/') ? path.join(home, arg.slice(2)) : path.resolve(at, arg);
    found.push(dir);
    // `git -C` runs one command there; a `cd` stays.
    if (!/^[\s;&|(]?git/.test(m[0])) at = dir;
  }
  return [...new Set(found)];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function firstLine(s: string, max = 100): string {
  // Never through a secret: a title goes to Convex (safe-cut.ts).
  return firstLineSafely(s, max, '…');
}

const realpaths = new Map<string, string>();

function realCwd(cwd: string): string {
  let r = realpaths.get(cwd);
  if (r === undefined) {
    try {
      r = fs.realpathSync(cwd);
    } catch {
      r = cwd;
    }
    realpaths.set(cwd, r);
  }
  return r;
}

// Paths inside the thread's folder are shown relative to it. The CLI reports
// resolved paths (/private/tmp for /tmp), so the real path is tried too.
export function displayPath(p: string, cwd: string): string {
  if (!p) return '';
  if (!path.isAbsolute(p)) return p;
  for (const base of [cwd, realCwd(cwd)]) {
    const rel = path.relative(base, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return p;
}

// One line describing the call, e.g. "npm test" or "Edit src/a.ts".
export function toolTitle(name: string, input: Record<string, unknown>, cwd: string): string {
  const p = displayPath(str(input.file_path) || str(input.notebook_path) || str(input.path), cwd);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(str(input.command)) || str(input.description) || name;
    case 'Monitor':
      return firstLine(str(input.description) || str(input.command)) || name;
    case 'Read':
      return `Read ${p}`.trim();
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edit ${p}`.trim();
    case 'Write':
      return `Write ${p}`.trim();
    case 'Glob':
      return `Find ${str(input.pattern)}${p ? ` in ${p}` : ''}`;
    case 'Grep':
      return `Search for ${firstLine(str(input.pattern), 80)}${p ? ` in ${p}` : ''}`;
    case 'LS':
      return `List ${p}`.trim();
    case 'WebFetch':
      return `Fetch ${str(input.url)}`;
    case 'WebSearch':
      return `Search the web for ${firstLine(str(input.query), 80)}`;
    case 'Agent':
    case 'Task':
      return firstLine(str(input.description)) || 'Run an agent';
    case 'TodoWrite':
      return 'Update the plan';
    case 'TaskCreate':
      return `Add task: ${firstLine(str(input.subject), 80)}`;
    case 'TaskUpdate':
      return `Update task ${str(input.taskId)}${input.status ? ` to ${String(input.status).replace('_', ' ')}` : ''}`;
    case 'TaskList':
      return 'List tasks';
    case 'TaskGet':
      return `Read task ${str(input.taskId)}`;
    case 'Skill':
      return `Use skill ${str(input.skill) || str(input.name)}`.trim();
    case 'AskUserQuestion':
      return 'Ask a question';
    case 'ToolSearch':
      return `Find tools: ${firstLine(str(input.query), 80)}`;
    case 'ExitPlanMode':
      return 'Finish the plan';
    default:
      if (name.startsWith('mcp__threadbear__')) return threadbearTitle(name.slice('mcp__threadbear__'.length), input);
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return `${server}: ${rest.join('__')}`;
      }
      return name;
  }
}

// The threadbear tools (threadbear-mcp.ts) in plain words, for tool rows and
// approval cards.
function threadbearTitle(tool: string, input: Record<string, unknown>): string {
  const id = (str(input.threadId) || str(input.id)).slice(0, 8);
  switch (tool) {
    case 'show_options':
      return `Compare options: ${firstLine(str(input.title), 80)}`;
    case 'pin': {
      const what = str(input.title) || (str(input.path) ? path.basename(str(input.path)) : str(input.url));
      return `${input.show ? 'Show and pin' : 'Pin'} ${firstLine(what, 80)}`;
    }
    case 'unpin':
      return 'Unpin a highlight';
    case 'list_threads':
      return str(input.query) ? `Search threads: ${firstLine(str(input.query), 80)}` : 'List threads';
    case 'read_thread':
      return id ? `Read thread ${id}` : 'Read this thread';
    case 'list_accounts':
      return 'List accounts';
    case 'create_thread':
      return `Start a thread: ${firstLine(str(input.title) || str(input.text), 80)}`;
    case 'send_message':
      return `Message thread ${id}`;
    case 'update_thread':
      return id ? `Update thread ${id}` : 'Update this thread';
    case 'move_thread':
      return `Move ${id ? `thread ${id}` : 'this thread'} to ${str(input.folder)}`;
    case 'interrupt_thread':
      return `Stop thread ${id}`;
    case 'delete_thread':
      return `Delete thread ${id}`;
    default:
      return `threadbear: ${tool}`;
  }
}

// Large strings in tool input are cut to 16 KB so one giant Write can't bloat
// the event log. The full content is still in the CLI's own transcript.
export function truncateInput(input: unknown): Record<string, unknown> {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      return v.length > LIMITS.toolInputString ? v.slice(0, safeEnd(v, LIMITS.toolInputString)) + '\n[truncated]' : v;
    }
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  const r = walk(input ?? {}, 0);
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r };
}

// What an approval card shows of a call's input. The strings that decide
// what Mike is allowing (`decisive`: a command, or every string of a call
// that acts for the agent elsewhere) go whole, never cut: Allow on a card
// that shows the start of a command runs all of it (Daybreak, 7 Nov 2026).
// One longer than an event takes (LIMITS.toolInputString) is `tooLong`, and
// the caller refuses the call with no card. The rest are cut as
// truncateInput cuts them (a Write's content shows as a diff anyway).
export function cardInput(input: Record<string, unknown>, decisive: readonly string[] | 'all'): { input: Record<string, unknown>; tooLong?: string } {
  let tooLong: string | undefined;
  const whole = (v: unknown, where: string, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length > LIMITS.toolInputString) tooLong ??= where;
      return v;
    }
    if (v === null || typeof v !== 'object') return v;
    // Deeper than a card lays out: not something to allow unread either.
    if (depth > 8) {
      tooLong ??= where;
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => whole(x, `${where}[${i}]`, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, whole(x, `${where}.${k}`, depth + 1)]));
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    out[k] = decisive === 'all' || decisive.includes(k) ? whole(v, k, 1) : truncateInput({ v }).v;
  }
  return tooLong ? { input: out, tooLong } : { input: out };
}

// Whether the one line the phone and another Mac's view of this runner
// show of an approval (sync.ts, inputSummary) is all of what allowing it
// does, so it may be allowed from there. A command must fit that line
// whole, on a small phone too; a threadbear tool acting elsewhere, or
// Codex asking for more access, never does, as its words are more than one
// line. Those cards offer only Deny there, and an allow from there is
// refused (Runner.respondApproval). An edit shows its path, as before.
export const REMOTE_COMMAND_CHARS = 160;
// What such a card says there, and what an allow from there is told.
export const REMOTE_ALLOW_REFUSED = "It's too long to show in full here, so it can only be allowed in the Mac app connected straight to its runner.";
// `cwd` is the thread's folder: a command that runs anywhere else, or asks
// for the network, has more to it than its line (Codex review, 7 Nov 2026).
// An edit of a file that runs as code shows all it writes on the Mac, and
// only its path here (its title says it is one), so it counts too.
export function remoteCardShowsAll(name: string, input: Record<string, unknown>, cwd?: string, title = ''): boolean {
  if (name === 'permissions' || title.includes(RUNS_AS_CODE) || title.includes(MAYBE_RUNS_AS_CODE)) return false;
  const fits = (v: string) => v.trim().length <= REMOTE_COMMAND_CHARS && !/[\r\n]/.test(v.trim());
  // An MCP tool's arguments say what it does (a threadbear tool's own ask,
  // in Ask mode, or any other server's), a `command` among them or not:
  // whole only when its one string that isn't an id is the line shown, and short.
  if (name.startsWith('mcp__')) {
    // Only ours are known to be ids; another server's `id` can be what it acts on.
    const ids = name.startsWith('mcp__threadbear__') ? ID_KEYS : new Set<string>();
    const values = Object.entries(input).filter(([k, v]) => v !== undefined && v !== null && !ids.has(k));
    if (values.some(([, v]) => typeof v === 'object')) return false;
    const words = values.map(([, v]) => String(v)).filter((v) => v.trim());
    return words.length === 0 || (words.length === 1 && summaryField(input) === words[0] && fits(words[0]!));
  }
  if (typeof input.command === 'string') {
    if (input.network !== undefined || (typeof input.cwd === 'string' && input.cwd !== cwd)) return false;
    return fits(input.command);
  }
  return true;
}
const ID_KEYS = new Set(['threadId', 'id', 'scheduleId', 'project']);

// The string a remote card's one line is made from (sync.ts inputSummary):
// the command, the path, or the first string in the input.
export function summaryField(input: Record<string, unknown>): string | undefined {
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

// What the agent is told when a call is refused for that.
export function tooLongForCard(where: string): string {
  return `Not run: \`${where}\` is longer than an approval card shows in full (${Math.round(LIMITS.toolInputString / 1024)} KB), and the user can only allow what they can read. Split it into shorter steps.`;
}

// Diff for an Edit/MultiEdit/Write call computed from its input and the
// file as it is now. Used when asking for approval (the file hasn't changed
// yet) and as a fallback when the CLI's result carries no patch.
export function computeEditDiff(
  name: string,
  input: Record<string, unknown>,
  current: string | null,
): { path: string; hunks: Hunk[] } | null {
  const file = str(input.file_path);
  if (!file) return null;
  if (name === 'Write') {
    const content = str(input.content);
    return { path: file, hunks: diffLines(current ?? '', content) };
  }
  const edits: { old_string: string; new_string: string; replace_all?: boolean }[] =
    name === 'MultiEdit' && Array.isArray(input.edits)
      ? (input.edits as { old_string: string; new_string: string; replace_all?: boolean }[])
      : name === 'Edit'
        ? [{ old_string: str(input.old_string), new_string: str(input.new_string), replace_all: Boolean(input.replace_all) }]
        : [];
  if (edits.length === 0) return null;
  if (current !== null) {
    let after: string | null = current;
    for (const e of edits) {
      after = after === null ? null : applyReplace(after, str(e.old_string), str(e.new_string), Boolean(e.replace_all));
    }
    if (after !== null) return { path: file, hunks: diffLines(current, after) };
  }
  // The file isn't readable or the text has moved: show the replacement on
  // its own, without file line numbers.
  const hunks: Hunk[] = [];
  for (const e of edits) hunks.push(...diffLines(str(e.old_string), str(e.new_string)));
  return { path: file, hunks };
}

// Tracks the agent's plan across TodoWrite and the TaskCreate/TaskUpdate
// family, producing plan.updated entries.
export class PlanTracker {
  private tasks = new Map<string, PlanEntry>();
  private order: string[] = [];
  // TodoWrite sends the whole list each time; the Task tools edit one task.
  // A CLI uses one or the other, so switching starts a fresh list.
  private source: 'todo' | 'tasks' | null = null;

  private use(source: 'todo' | 'tasks'): void {
    if (this.source !== source) {
      this.tasks.clear();
      this.order = [];
      this.source = source;
    }
  }

  fromTodoWrite(input: Record<string, unknown>): PlanEntry[] | null {
    if (!Array.isArray(input.todos)) return null;
    this.use('todo');
    this.tasks.clear();
    this.order = [];
    const entries: PlanEntry[] = [];
    (input.todos as Record<string, unknown>[]).forEach((t, i) => {
      const e: PlanEntry = { text: str(t.content) || str(t.activeForm), status: normStatus(t.status) };
      this.tasks.set(String(i), e);
      this.order.push(String(i));
      entries.push(e);
    });
    return entries;
  }

  taskCreated(id: string, subject: string): PlanEntry[] {
    this.use('tasks');
    if (!this.tasks.has(id)) this.order.push(id);
    this.tasks.set(id, { text: subject, status: 'pending' });
    return this.entries();
  }

  taskUpdated(input: Record<string, unknown>): PlanEntry[] | null {
    const id = str(input.taskId);
    if (!id) return null;
    this.use('tasks');
    if (input.status === 'deleted') {
      if (!this.tasks.delete(id)) return null;
      this.order = this.order.filter((x) => x !== id);
      return this.entries();
    }
    const prev = this.tasks.get(id);
    if (!prev && !input.subject) return null;
    if (!prev) this.order.push(id);
    this.tasks.set(id, {
      text: str(input.subject) || prev?.text || '',
      status: input.status ? normStatus(input.status) : (prev?.status ?? 'pending'),
    });
    return this.entries();
  }

  taskList(tasks: unknown): PlanEntry[] | null {
    if (!Array.isArray(tasks)) return null;
    this.use('tasks');
    this.tasks.clear();
    this.order = [];
    for (const t of tasks as Record<string, unknown>[]) {
      const id = str(t.id);
      this.order.push(id);
      this.tasks.set(id, { text: str(t.subject), status: normStatus(t.status) });
    }
    return this.entries();
  }

  entries(): PlanEntry[] {
    return this.order.map((id) => this.tasks.get(id)!).filter(Boolean);
  }
}

function normStatus(s: unknown): PlanEntry['status'] {
  return s === 'in_progress' || s === 'completed' ? s : 'pending';
}
