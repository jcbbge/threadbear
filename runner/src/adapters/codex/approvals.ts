// The requests Codex sends to the runner: approvals, questions, MCP
// elicitations, Threadbear tool calls and the clock. This owns the pending
// map, the decision mapping, serverRequest/resolved and the "Always allow"
// rules. Every request gets an answer: a card, a rule, or a refusal at once.
import fs from 'node:fs';
import path from 'node:path';
import { codeWriteNote, type CodeWrite } from '../../code-writes.ts';
import type { Question } from '../../protocol.ts';
import type { Logger } from '../../log.ts';
import { cardInput, displayPath, tooLongForCard } from '../../tools.ts';
import type { QuestionAnswer, QuestionRequest, ToolApprovalAnswer, ToolApprovalRequest } from '../types.ts';
import type {
  ApplyPatchApprovalParams,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ElicitationProperty,
  ExecCommandApprovalParams,
  FileChangeRequestApprovalParams,
  McpServerElicitationRequestParams,
  PermissionsRequestApprovalParams,
  RequestId,
  ToolRequestUserInputParams,
} from './types.ts';
import { firstLineSafely } from '../../safe-cut.ts';

// ---- Refusals, for a request no session is there to answer

export type Reply = { result: unknown } | { error: { code: number; message: string } };

export function refusal(method: string): Reply {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'cancel' } };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'abort' } };
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } };
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } };
    default:
      return { error: { code: -32601, message: `Threadbear doesn't handle ${method} here.` } };
  }
}

// ---- "Always allow" rules

// Codex offers no acceptForSession (on luna, on sol, for subagents: always
// ["accept", {acceptWithExecpolicyAmendment}, "cancel"]), and
// acceptWithExecpolicyAmendment saves a rule that outlives the thread. So
// the runner keeps its own rules in the thread's allowRules and answers
// matching requests itself:
//   codex:fileChange                       any edit in this thread
//   codex:command:<JSON {cwd, argv}>       exactly this command in this
//                                          folder, as the card showed it
// "Always allow" never makes a rule wider than the card. Until 6 Nov 2026 it
// saved Codex's proposedExecpolicyAmendment as a prefix (codex:prefix:), so
// ["npm","exec"] from a card for `npm exec -- prettier` went on to allow
// `npm exec --package=evil`; the card never showed the prefix, and no list
// of programs that run code can be complete. Those rules, and the older
// codex:command:<JSON argv> ones with no folder, are no longer honoured:
// such a command asks again.
export const FILE_CHANGE_RULE = 'codex:fileChange';
const COMMAND_RULE = 'codex:command:';

export function commandRule(argv: string[], cwd: string): string {
  return COMMAND_RULE + JSON.stringify({ cwd, argv });
}

function ruleCommand(rule: string): { cwd: string; argv: string[] } | null {
  if (!rule.startsWith(COMMAND_RULE)) return null;
  try {
    const v = JSON.parse(rule.slice(COMMAND_RULE.length)) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const { cwd, argv } = v as { cwd?: unknown; argv?: unknown };
    if (typeof cwd !== 'string' || !cwd) return null;
    if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === 'string')) return null;
    return { cwd, argv };
  } catch {
    return null;
  }
}

// The programs an exact "Always allow" can cover: ones whose effect is in
// their words, reading files only as data. Anything else (a shell, an
// interpreter, a package or build launcher like `npm test`, `make` or
// `cargo run`, a test runner, a program by a path in the repo) runs code a
// repo can change after the card, so the same words run something else
// next time: the card offers no Always allow and no rule matches it.
// An allowlist, as no list of programs that run code can be complete
// (Daybreak, 7 Nov 2026: npm, pnpm, yarn and cargo were missing from the
// list this replaced). Binding a rule to a hash of package.json or a
// Makefile wouldn't cover the tests and sources those run.
//
// Not ripgrep, sort or diff: each has an option that runs a program
// (`rg --pre` and `--hostname-bin`, `sort --compress-program`, GNU diff's
// helpers), and a list of such options is the same incomplete list again
// (Codex review, 7 Nov 2026, found `rg --hostname-bin`).
const PLAIN_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'pwd', 'echo', 'printf', 'date', 'which',
  'whoami', 'id', 'uname', 'stat', 'file', 'du', 'df', 'tree', 'cmp', 'comm', 'uniq', 'cut',
  'tr', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'mkdir', 'touch', 'rm', 'rmdir', 'shasum',
  'sha256sum', 'sha1sum', 'md5', 'md5sum', 'cksum', 'base64', 'xxd', 'hexdump', 'od', 'strings', 'true',
  'false', 'sw_vers', 'uptime', 'ps', 'column', 'fold', 'rev', 'tac', 'seq', 'paste', 'sleep',
]);
// Where the file that really runs must be: folders only the system writes
// to. Not Homebrew's or /usr/local: the user's account (so an edit Mike once
// allowed) can change what's in those, and a link there can lead into a repo.
const SYSTEM_DIRS = ['/bin', '/usr/bin', '/sbin', '/usr/sbin'];
const inSystemDir = (file: string): boolean => SYSTEM_DIRS.some((d) => file.startsWith(`${d}/`));

// The file a program name runs, links followed, as a shell would find it
// on PATH, or undefined when that isn't certain (a relative PATH entry
// before it, which depends on the folder). The shell Codex runs commands in
// is a login shell, so its PATH can differ from the runner's: one that puts
// a folder of the user's first is theirs to have set up.
function programFile(program: string, searchPath: string): string | undefined {
  const real = (p: string): string | undefined => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile() ? fs.realpathSync(p) : undefined;
    } catch {
      return undefined;
    }
  };
  if (program.includes('/')) return path.isAbsolute(program) ? real(program) : undefined;
  for (const dir of searchPath.split(':')) {
    if (!path.isAbsolute(dir)) return undefined;
    const hit = real(path.join(dir, program));
    if (hit) return hit;
  }
  return undefined;
}

// Whether an exact rule may cover this argv: a program on PLAIN_PROGRAMS
// (lower-cased, as macOS finds /bin/LS for ls) whose name leads to the
// system's own file. Read each time a rule is made and matched, so a name
// that leads elsewhere later stops matching (Codex review, 7 Nov 2026: a
// `grep` or `/usr/local/bin/ls` that's a link into the repo).
export function ruleMayCover(argv: string[], searchPath: string = process.env.PATH ?? ''): boolean {
  const program = argv[0] ?? '';
  const name = (program.split('/').pop() ?? '').toLowerCase();
  if (!PLAIN_PROGRAMS.has(name)) return false;
  const named = program.includes('/') ? `${program.slice(0, program.lastIndexOf('/'))}/${name}` : name;
  if (program.includes('/') && !inSystemDir(named)) return false;
  const file = programFile(named, searchPath);
  return file !== undefined && inSystemDir(file);
}

// Codex wraps every command as `/bin/zsh -lc '<command>'`. Returns the inner
// command, or the string as it is when it isn't wrapped.
export function unwrapShell(command: string): string {
  // Only the system's shell by its whole path: a bare `bash` is whichever
  // PATH finds, which can be the repo's (Codex review, 7 Nov 2026).
  const m = /^\s*\/(?:usr\/)?bin\/(?:zsh|bash|sh)\s+-l?c\s+([\s\S]+)$/.exec(command);
  if (!m) return command;
  const words = shellWords(m[1]);
  return words && words.length === 1 ? words[0] : command;
}

// Characters zsh does something with outside quotes: run other commands
// (; & | < > newline, backticks, $(...), =(...), <(...)), expand ($var,
// ${...}, ~user, =cmd, !history), or glob (* ? [ ] and qualifiers in
// parentheses, # ^ ~ with extendedglob), or group ({ } ( )). = and %
// count at the start of a word (=cmd, =(...), job specs), where zsh expands
// them. A command with any of them unquoted never matches a rule: when in
// doubt, ask.
const UNQUOTED_SPECIAL = new Set([...';&|<>\n`$(){}*?[]!~#^']);
const WORD_START_SPECIAL = new Set(['=', '%']);

// Splits a command into words the way a shell would, or returns null if it
// isn't one plain command made only of literal words (see UNQUOTED_SPECIAL).
// Inside double quotes $, ` and ! still expand, so they count too; inside
// single quotes nothing does.
export function shellWords(s: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '`' || d === '$' || d === '!') return null;
        if (d === '\\' && i + 1 < s.length && '"\\'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        if (d === '\\') return null; // \$, \` and the like: refuse rather than reason about it
        cur += d;
        i++;
      }
      if (!closed) return null;
      inWord = true;
      continue;
    }
    if (c === '\\') {
      // An escaped ordinary character is fine; anything else, ask.
      if (i + 1 >= s.length || !/[A-Za-z0-9 ._\/:,+@-]/.test(s[i + 1])) return null;
      cur += s[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (UNQUOTED_SPECIAL.has(c) || (!inWord && WORD_START_SPECIAL.has(c))) return null;
    if (c === ' ' || c === '\t') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      i++;
      continue;
    }
    if (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) return null;
    cur += c;
    inWord = true;
    i++;
  }
  if (inWord) words.push(cur);
  return words;
}

// The plain argv of a command approval, or null when no rule may cover it:
// not a plain command, stdin to a running command, network access, or a
// program whose words don't say what it runs (ruleMayCover).
export function plainArgv(p: CommandExecutionRequestApprovalParams): string[] | null {
  if ((p.kind ?? 'command') !== 'command') return null;
  if (p.networkApprovalContext || (Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length)) return null;
  if (typeof p.command !== 'string') return null;
  const argv = shellWords(unwrapShell(p.command));
  if (!argv || !argv.length || !ruleMayCover(argv)) return null;
  return argv;
}

// The rule "Always allow" makes for a command: exactly the command the card
// showed, in the folder it showed. Codex's proposedExecpolicyAmendment is
// never used, as it can be shorter than the command (see above).
// `cwd` is the folder the card shows when the request names none.
export function ruleFor(p: CommandExecutionRequestApprovalParams, cwd: string): string | null {
  const argv = plainArgv(p);
  if (!argv) return null;
  return commandRule(argv, p.cwd || cwd);
}

export function commandAllowed(p: CommandExecutionRequestApprovalParams, rules: Iterable<string>, cwd: string): boolean {
  const argv = plainArgv(p);
  if (!argv) return false;
  const where = p.cwd || cwd;
  for (const r of rules) {
    const rule = ruleCommand(r);
    if (rule && rule.cwd === where && rule.argv.length === argv.length && rule.argv.every((w, i) => argv[i] === w)) return true;
  }
  return false;
}

// ---- Handling requests

export type ApprovalsDeps = {
  log: Logger;
  label: string; // the thread id, for log lines
  reply(id: RequestId, result: unknown): void;
  replyError(id: RequestId, code: number, message: string): void;
  requestApproval(req: ToolApprovalRequest): Promise<ToolApprovalAnswer>;
  requestQuestion(req: QuestionRequest): Promise<QuestionAnswer>;
  rules(): Iterable<string>;
  addRules(rules: string[]): void; // kept for the thread (an allowRules output)
  note(text: string): void; // a system.note in the thread
  cwd(): string;
  // What the session saw of an item on item/started: the paths a fileChange
  // touches, for the card's title.
  itemPaths(itemId: string): string[] | undefined;
  // Whether a file (absolute) is one Threadbear runs as code
  // (code-writes.ts): a patch that changes one always asks.
  runsAsCode(file: string): CodeWrite;
  callTool(params: DynamicToolCallParams, o: { fromChild: boolean; signal: AbortSignal }): Promise<DynamicToolCallResponse>;
  now(): number;
};

type Pending = { method: string; abort: AbortController };

export class CodexApprovals {
  private deps: ApprovalsDeps;
  private pending = new Map<string, Pending>();

  constructor(deps: ApprovalsDeps) {
    this.deps = deps;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  // Codex reports a patch's paths as written, maybe relative to the folder.
  private runsAsCode(paths: string[]): CodeWrite {
    const kinds = paths.map((f) => this.deps.runsAsCode(path.resolve(this.deps.cwd(), f)));
    return kinds.includes(true) || (kinds.includes('unsure') ? 'unsure' : false);
  }

  // `fromChild`: the request came from a subagent's thread. Its card goes to
  // this session with no itemId (there's no tool row for it here).
  handle(id: RequestId, method: string, params: unknown, o: { fromChild: boolean }): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.command(id, p as CommandExecutionRequestApprovalParams, o.fromChild);
      case 'item/fileChange/requestApproval':
        return this.fileChange(id, p as FileChangeRequestApprovalParams, o.fromChild);
      case 'item/permissions/requestApproval':
        return this.permissions(id, p as PermissionsRequestApprovalParams, o.fromChild);
      case 'item/tool/requestUserInput':
        return this.userInput(id, p as ToolRequestUserInputParams, o.fromChild);
      case 'mcpServer/elicitation/request':
        return this.elicitation(id, p as McpServerElicitationRequestParams);
      case 'item/tool/call':
        return this.toolCall(id, p as DynamicToolCallParams, o.fromChild);
      case 'execCommandApproval':
        return this.legacyCommand(id, p as ExecCommandApprovalParams, o.fromChild);
      case 'applyPatchApproval':
        return this.legacyPatch(id, p as ApplyPatchApprovalParams, o.fromChild);
      case 'currentTime/read':
        return this.deps.reply(id, { currentTimeAt: Math.floor(this.deps.now() / 1000) });
      default:
        this.deps.log.info('refused an unknown codex request', { threadId: this.deps.label, method });
        return this.deps.replyError(id, -32601, `Threadbear doesn't handle ${method}.`);
    }
  }

  // serverRequest/resolved arrives for every request, including the ones
  // we've just answered (under 1 ms after our reply). The pending entry is
  // dropped when we reply, so only a request still waiting on Mike is
  // expired here: Codex settled it itself (an interrupt, a non-blocking
  // question that timed out).
  resolved(requestId: RequestId): void {
    const key = String(requestId);
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    p.abort.abort();
  }

  // The session is ending: every open card expires and nothing is replied.
  cancelAll(): void {
    for (const p of this.pending.values()) p.abort.abort();
    this.pending.clear();
  }

  private open(id: RequestId, method: string): Pending {
    const p = { method, abort: new AbortController() };
    this.pending.set(String(id), p);
    return p;
  }

  // Sends the reply unless Codex has already resolved the request itself.
  private settle(id: RequestId, result: unknown): void {
    const key = String(id);
    if (!this.pending.has(key)) return;
    this.pending.delete(key);
    this.deps.reply(id, result);
  }

  private ask(id: RequestId, method: string, req: Omit<ToolApprovalRequest, 'signal'>, answer: (a: ToolApprovalAnswer) => unknown): void {
    const p = this.open(id, method);
    this.deps
      .requestApproval({ ...req, signal: p.abort.signal })
      .catch((e: unknown): ToolApprovalAnswer => {
        this.deps.log.warn('approval request failed', { threadId: this.deps.label, method, error: String(e) });
        return { decision: 'expired' };
      })
      .then((a) => this.settle(id, answer(a)));
  }

  // A request whose card couldn't show all of what it allows (cardInput):
  // refused at once, and the thread says why.
  private tooLong(id: RequestId, where: string, refusal: unknown): void {
    this.deps.note(tooLongForCard(where));
    this.deps.reply(id, refusal);
  }

  private command(id: RequestId, p: CommandExecutionRequestApprovalParams, fromChild: boolean): void {
    const raw = typeof p.command === 'string' ? p.command : '';
    const inner = raw ? unwrapShell(raw) : (p.commandActions?.[0]?.command ?? '');
    const network = p.networkApprovalContext;
    const stdin = (p.kind ?? 'command') === 'writeStdin';
    const cwd = p.cwd || this.deps.cwd();
    const rule = stdin || network ? null : ruleFor(p, cwd);
    if (commandAllowed(p, this.deps.rules(), cwd)) {
      this.deps.reply(id, { decision: 'accept' });
      return;
    }
    let title = firstLine(inner) || 'Run a command';
    if (stdin) title = `Send input to a running command${inner ? `: ${firstLine(inner)}` : ''}`;
    else if (network) title = `Allow network access to ${network.host}${inner ? ` for ${firstLine(inner)}` : ''}`;
    const input: Record<string, unknown> = { command: inner, cwd };
    if (p.reason) input.reason = p.reason;
    if (network) input.network = network;
    const card = cardInput(input, ['command', 'cwd', 'network']);
    if (card.tooLong) return this.tooLong(id, card.tooLong, { decision: 'decline' });
    this.ask(
      id,
      'item/commandExecution/requestApproval',
      { toolUseId: fromChild ? undefined : p.itemId, name: 'shell', title, input: card.input, canAlwaysAllow: Boolean(rule) },
      (a) => {
        if (a.decision === 'allowAlways' && rule) this.deps.addRules([rule]);
        return { decision: commandDecision(a) };
      },
    );
  }

  private fileChange(id: RequestId, p: FileChangeRequestApprovalParams, fromChild: boolean): void {
    const known = p.itemId ? this.deps.itemPaths(p.itemId) : undefined;
    const paths = known ?? [];
    // A patch to a file that runs as code asks every time, past an "Always
    // allow", as does one whose files weren't seen (code-writes.ts).
    const code = this.runsAsCode(paths);
    if (!code && known && hasRule(this.deps.rules(), FILE_CHANGE_RULE)) {
      this.deps.reply(id, { decision: 'accept' });
      return;
    }
    const input: Record<string, unknown> = { paths };
    if (p.reason) input.reason = p.reason;
    if (p.grantRoot) input.grantRoot = p.grantRoot;
    const title = editTitle(paths, this.deps.cwd());
    this.ask(
      id,
      'item/fileChange/requestApproval',
      { toolUseId: fromChild ? undefined : p.itemId, name: 'apply_patch', title: code ? `${title} (${codeWriteNote(code)})` : title, input, canAlwaysAllow: !code },
      (a) => {
        if (a.decision === 'allowAlways' && !code) this.deps.addRules([FILE_CHANGE_RULE]);
        return { decision: commandDecision(a) };
      },
    );
  }

  private permissions(id: RequestId, p: PermissionsRequestApprovalParams, fromChild: boolean): void {
    const requested: Record<string, unknown> = {};
    if (p.permissions?.network) requested.network = p.permissions.network;
    if (p.permissions?.fileSystem) requested.fileSystem = p.permissions.fileSystem;
    const card = cardInput({ permissions: requested, cwd: p.cwd, reason: p.reason }, ['permissions', 'cwd']);
    if (card.tooLong) return this.tooLong(id, card.tooLong, { permissions: {}, scope: 'turn' });
    this.ask(
      id,
      'item/permissions/requestApproval',
      {
        toolUseId: fromChild ? undefined : p.itemId,
        name: 'permissions',
        title: firstLine(p.reason ?? '') || 'Allow extra permissions',
        input: card.input,
        // More filesystem or network access than the thread's sandbox gives
        // is raising access, which outside Full is one call's OK (SECURITY.md):
        // never "Always allow", and never the session scope that would hand
        // it to every later command in the thread (Daybreak, 7 Nov 2026).
        // A client that sends allowAlways anyway gets the one turn.
        canAlwaysAllow: false,
      },
      (a) => (a.decision === 'allow' || a.decision === 'allowAlways' ? { permissions: requested, scope: 'turn' } : { permissions: {}, scope: 'turn' }),
    );
  }

  private userInput(id: RequestId, p: ToolRequestUserInputParams, fromChild: boolean): void {
    const all = Array.isArray(p.questions) ? p.questions : [];
    const secret = all.filter((q) => q?.isSecret);
    for (const q of secret) this.deps.note(`Codex asked for something secret (${q.header || q.question}). It was declined, as the answer would go to Codex itself; the agent's ask_secret keeps it in a private file instead.`);
    const asked = all.filter((q) => q && !q.isSecret);
    if (!asked.length) {
      this.deps.reply(id, { answers: {} });
      return;
    }
    const questions: Question[] = asked.map((q) => {
      const out: Question = {
        question: q.question || q.header || 'Codex has a question',
        multiSelect: false,
        options: (q.options ?? []).map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
      };
      if (q.header) out.header = q.header;
      return out;
    });
    const pending = this.open(id, 'item/tool/requestUserInput');
    this.deps
      .requestQuestion({ toolUseId: fromChild ? undefined : p.itemId, questions, signal: pending.abort.signal })
      .catch((): QuestionAnswer => ({ answers: null }))
      .then((a) => {
        const answers: Record<string, { answers: string[] }> = {};
        if (a.answers) {
          asked.forEach((q, i) => {
            const v = a.answers![questions[i].question];
            if (typeof v === 'string' && v) answers[q.id] = { answers: [v] };
          });
        }
        this.settle(id, { answers });
      });
  }

  private elicitation(id: RequestId, p: McpServerElicitationRequestParams): void {
    const server = p.serverName || 'An MCP server';
    if (p.mode !== 'form') {
      const what = p.mode === 'url' && p.url ? `to open ${p.url}` : `for input Threadbear can't show (${p.mode})`;
      this.deps.note(`${server} asked ${what}${p.message ? `: ${firstLine(p.message)}` : ''}. Threadbear declined it.`);
      this.deps.reply(id, { action: 'decline', content: null, _meta: null });
      return;
    }
    const props = Object.entries(p.requestedSchema?.properties ?? {});
    const message = p.message || `${server} needs an answer`;
    const fields = props.map(([key, prop]) => ({ key, prop, choices: choicesFor(prop) }));
    const questions: Question[] = fields.length
      ? fields.map(({ key, prop, choices }, i) => {
          const label = prop.title || key;
          const detail = prop.description && prop.description !== label ? `${label}: ${prop.description}` : label;
          return {
            question: i === 0 ? `${message}\n\n${detail}` : detail,
            header: label.slice(0, 30),
            multiSelect: false,
            options: choices.map((c) => ({ label: c.label })),
          };
        })
      : [{ question: message, header: server.slice(0, 30), multiSelect: false, options: [{ label: 'Accept' }, { label: 'Decline' }] }];
    const pending = this.open(id, 'mcpServer/elicitation/request');
    this.deps
      .requestQuestion({ questions, signal: pending.abort.signal })
      .catch((): QuestionAnswer => ({ answers: null }))
      .then((a) => {
        if (!a.answers) return this.settle(id, { action: 'decline', content: null, _meta: null });
        if (!fields.length) {
          const accept = a.answers[questions[0].question] === 'Accept';
          return this.settle(id, accept ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null });
        }
        const content: Record<string, unknown> = {};
        fields.forEach(({ key, prop, choices }, i) => {
          const v = a.answers![questions[i].question];
          if (typeof v !== 'string' || v === '') return;
          content[key] = elicitedValue(v, prop, choices);
        });
        this.settle(id, { action: 'accept', content, _meta: null });
      });
  }

  private toolCall(id: RequestId, p: DynamicToolCallParams, fromChild: boolean): void {
    const pending = this.open(id, 'item/tool/call');
    this.deps
      .callTool(p, { fromChild, signal: pending.abort.signal })
      .catch((e: unknown): DynamicToolCallResponse => ({ contentItems: [{ type: 'inputText', text: (e as Error)?.message ?? String(e) }], success: false }))
      .then((r) => this.settle(id, r));
  }

  private legacyCommand(id: RequestId, p: ExecCommandApprovalParams, fromChild: boolean): void {
    // Treated like the v2 request, with the legacy decision names.
    const argv = Array.isArray(p.command) ? p.command.filter((x) => typeof x === 'string') : [];
    const asV2: CommandExecutionRequestApprovalParams = {
      kind: 'command',
      threadId: p.conversationId,
      turnId: '',
      itemId: p.callId,
      // Only the system's shell comes off, as unwrapShell has it: a repo's own
      // `bin/bash`, or a bare `bash` PATH might find there, is the program
      // being run (Codex review, 7 Nov 2026).
      command: argv.length === 3 && /^\/(?:usr\/)?bin\/(?:zsh|bash|sh)$/.test(argv[0]) && /^-l?c$/.test(argv[1]) ? argv[2] : argv.map(quoteWord).join(' '),
      cwd: p.cwd,
      reason: p.reason,
    };
    const cwd = p.cwd || this.deps.cwd();
    if (commandAllowed(asV2, this.deps.rules(), cwd)) {
      this.deps.reply(id, { decision: 'approved' });
      return;
    }
    const rule = ruleFor(asV2, cwd);
    const input: Record<string, unknown> = { command: asV2.command, cwd };
    if (p.reason) input.reason = p.reason;
    const card = cardInput(input, ['command', 'cwd']);
    if (card.tooLong) return this.tooLong(id, card.tooLong, { decision: 'abort' });
    this.ask(
      id,
      'execCommandApproval',
      { toolUseId: fromChild ? undefined : p.callId, name: 'shell', title: firstLine(asV2.command ?? '') || 'Run a command', input: card.input, canAlwaysAllow: Boolean(rule) },
      (a) => {
        if (a.decision === 'allowAlways' && rule) this.deps.addRules([rule]);
        return { decision: legacyDecision(a) };
      },
    );
  }

  private legacyPatch(id: RequestId, p: ApplyPatchApprovalParams, fromChild: boolean): void {
    // Each file and, for a rename, where it goes (`move_path`).
    const changes = Object.entries(p.fileChanges ?? {});
    const paths = changes.map(([f]) => f);
    const moves = changes.flatMap(([, c]) => [(c as { move_path?: unknown })?.move_path, (c as { kind?: { move_path?: unknown } })?.kind?.move_path]).filter((x): x is string => typeof x === 'string' && x !== '');
    const code = this.runsAsCode([...paths, ...moves]);
    if (!code && hasRule(this.deps.rules(), FILE_CHANGE_RULE)) {
      this.deps.reply(id, { decision: 'approved' });
      return;
    }
    const input: Record<string, unknown> = { paths };
    if (p.reason) input.reason = p.reason;
    const title = editTitle(paths, this.deps.cwd());
    this.ask(
      id,
      'applyPatchApproval',
      { toolUseId: fromChild ? undefined : p.callId, name: 'apply_patch', title: code ? `${title} (${codeWriteNote(code)})` : title, input, canAlwaysAllow: !code },
      (a) => {
        if (a.decision === 'allowAlways' && !code) this.deps.addRules([FILE_CHANGE_RULE]);
        return { decision: legacyDecision(a) };
      },
    );
  }
}

// Never acceptForSession (nothing advertises it) or
// acceptWithExecpolicyAmendment (it saves a rule that outlives the thread).
// decline works although availableDecisions never lists it.
function commandDecision(a: ToolApprovalAnswer): 'accept' | 'decline' | 'cancel' {
  if (a.decision === 'allow' || a.decision === 'allowAlways') return 'accept';
  if (a.decision === 'expired') return 'cancel';
  return 'decline';
}

function legacyDecision(a: ToolApprovalAnswer): unknown {
  if (a.decision === 'allow' || a.decision === 'allowAlways') return 'approved';
  if (a.decision === 'expired') return 'abort';
  return { denied: { rejection: a.message || 'The user denied this.' } };
}

function hasRule(rules: Iterable<string>, rule: string): boolean {
  for (const r of rules) if (r === rule) return true;
  return false;
}

function editTitle(paths: string[], cwd: string): string {
  if (paths.length === 1) return `Edit ${displayPath(paths[0], cwd)}`;
  if (paths.length > 1) return `Edit ${paths.length} files`;
  return 'Edit files';
}

function firstLine(s: string, max = 200): string {
  return firstLineSafely(s, max, '…');
}

function quoteWord(w: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

type Choice = { label: string; value: unknown };

function choicesFor(prop: ElicitationProperty): Choice[] {
  if (Array.isArray(prop.oneOf) && prop.oneOf.length) return prop.oneOf.map((o) => ({ label: o.title || String(o.const), value: o.const }));
  if (Array.isArray(prop.enum) && prop.enum.length) return prop.enum.map((v, i) => ({ label: prop.enumNames?.[i] || String(v), value: v }));
  if (prop.type === 'boolean') return [{ label: 'Yes', value: true }, { label: 'No', value: false }];
  return [];
}

function elicitedValue(answer: string, prop: ElicitationProperty, choices: Choice[]): unknown {
  const choice = choices.find((c) => c.label === answer);
  if (choice) return choice.value;
  if (prop.type === 'number' || prop.type === 'integer') {
    const n = Number(answer);
    return Number.isFinite(n) ? (prop.type === 'integer' ? Math.trunc(n) : n) : answer;
  }
  if (prop.type === 'boolean') return /^(y|yes|true|1)$/i.test(answer.trim());
  return answer;
}
