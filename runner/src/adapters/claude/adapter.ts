import crypto from 'node:crypto';
import { CONFINED_NO_SANDBOX, sandboxSpawner, type SandboxConfig } from '../../sandbox.ts';
import os from 'node:os';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { HookInput, McpServerConfig, ModelInfo, Options, PermissionResult, Query, SDKUserMessage, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { Account, EffortLevel, ModelChoice, PermissionMode, Question } from '../../protocol.ts';
import { isEffortLevel } from '../../protocol.ts';
import fs from 'node:fs';
import type { AgentAdapter, AgentSession, RewindRequest, RewindResult, SessionSink, StartSessionOptions, UserInput } from '../types.ts';
import { RewindRefusedError } from '../types.ts';
import type { SlashCommand } from '../../slash-commands.ts';
import { cutPointBefore, sessionTranscriptPath } from '../../transcripts.ts';
import type { Logger } from '../../log.ts';
import { ClaudeNormalizer, fileContext } from './normalize.ts';
import { groupSpawner, type ProcessRegistry } from '../../proc.ts';
import { prepareImageForModel } from '../../media.ts';
import { placePictures } from '../../pictures.ts';
import { EDIT_TOOLS, cardInput, toolTitle, tooLongForCard } from '../../tools.ts';
import { codeWriteNote, codeWriteReason, runsAsCodeByName, type CodeWrite } from '../../code-writes.ts';
import path from 'node:path';
import { RUNNER_VERSION } from '../../config.ts';
import { stripModelSuffix } from '../../accounts.ts';
import { END_TURN_FULL_NAME, END_TURN_NUDGE, endTurnMessageStands, endTurnWantsReply, ONE_REPLY_END_TURN_NUDGE, ONE_REPLY_WRITE_NUDGE, owedReplyAfterCompact, WakeRead } from '../../needs.ts';

// Variables a parent Claude Code session sets for its own children. If the
// runner was started from inside one (tests, a terminal in T3), they would
// make the CLI think it's nested, so they're dropped.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'AI_AGENT',
];

export function cliEnv(account: Account, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  if (account.id === 'claude-main') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account.configDir;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `threadbear-runner/${RUNNER_VERSION}`;
  return env;
}

// The MCP tools whose successful result ends a turn, for the CLI's
// CLAUDE_CODE_TERMINAL_MCP_TOOLS (2.1.312; older CLIs ignore it). Without
// it, a model that stops after a tool result with no text (end_turn is the
// last thing in every turn, and the model obeys "no more text") is nudged
// with "[Your previous response had no visible output. Please continue and
// produce a user-visible response.]" and writes a throwaway "I've marked
// this thread as done" under the real answer: 47 of the 52 such nudges in
// Mike's local CLI transcripts followed an end_turn (28 Oct 2026). Named
// there, end_turn's result lets the empty reply end the turn quietly. Any
// names already in the variable stay.
// With one reply, end_turn isn't the turn's end: the reply comes after
// it, so it stays off the list, and a turn that stops with no words after
// it is sent back for them (onStop).
export function terminalMcpTools(base: string | undefined, oneReply = false): string {
  const names = (base ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!oneReply && !names.includes(END_TURN_FULL_NAME)) names.push(END_TURN_FULL_NAME);
  return names.join(',');
}

export function sdkPermissionMode(mode: PermissionMode): 'bypassPermissions' | 'default' | 'auto' | 'plan' {
  if (mode === 'auto' || mode === 'plan') return mode;
  return mode === 'full' ? 'bypassPermissions' : 'default';
}

// Streaming input for query(): the runner pushes one user message per turn
// and ends it to let the CLI exit.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(m: SDKUserMessage): void {
    if (this.ended) throw new Error('input already ended');
    this.items.push(m);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export type ClaudeAdapterDeps = {
  claudePath: string;
  registry: ProcessRegistry;
  log: Logger;
  queryFn?: typeof sdkQuery;
  // In-process MCP servers for a thread's session (the threadbear tools).
  mcpServersFor?: (threadId: string) => Record<string, McpServerConfig>;
  // Tools that ask Mike even in a thread with full access.
  alwaysAsk?: Set<string>;
  // Tools that never ask, whatever the mode (NEVER_ASK_TOOLS).
  neverAsk?: Set<string>;
  // One reply (needs.ts), read when a session starts, as its end_turn is.
  oneReply?: () => boolean;
  // The container a thread in this folder runs its CLI in, if any
  // (sandbox.ts). Only a thread's own session; the model and command
  // probes run as before.
  sandboxFor?: (cwd: string) => SandboxConfig | undefined;
};

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude';
  private deps: ClaudeAdapterDeps;

  constructor(deps: ClaudeAdapterDeps) {
    this.deps = deps;
  }

  start(opts: StartSessionOptions, sink: SessionSink): AgentSession {
    // A thread shut in a sandbox never starts outside one, even if its
    // folder has stopped being in one since (a link put in its place).
    if (opts.confined && !this.deps.sandboxFor?.(opts.cwd)) throw new Error(CONFINED_NO_SANDBOX(opts.cwd));
    const s = new ClaudeSession(opts, sink, this.deps);
    s.start();
    return s;
  }

  // Asks the account's CLI what its model picker offers. Starting the CLI
  // with no prompt is enough: it answers initialize without a turn (under
  // a second, no tokens), and is closed straight after.
  async models(account: Account): Promise<ModelChoice[]> {
    const { deps } = this;
    const never = { async *[Symbol.asyncIterator]() { await new Promise<never>(() => {}); } } as AsyncIterable<SDKUserMessage>;
    const abort = new AbortController();
    const options: Options = {
      cwd: os.homedir(),
      pathToClaudeCodeExecutable: deps.claudePath,
      env: cliEnv(account),
      settingSources: ['user', 'project', 'local'],
      tools: [],
      abortController: abort,
      spawnClaudeCodeProcess: groupSpawner(deps.registry, deps.log, () => {}, `models:${account.id}`),
    };
    const queryFn = deps.queryFn ?? sdkQuery;
    const q = queryFn({ prompt: never, options });
    try {
      const init = await q.initializationResult();
      return modelChoices(init.models ?? []);
    } finally {
      try {
        q.close();
      } catch {
        // already closed
      }
      abort.abort();
    }
  }

  // The slash commands the CLI offers in a folder (its built-in ones, the
  // folder's and Mike's commands and skills), for the picker. Like
  // models(): a CLI with no prompt answers initialize without a turn.
  // untrusted: as for a session (StartSessionOptions), so listing never
  // runs what a folder's settings would that Mike hasn't trusted.
  async commands(account: Account, cwd: string, untrusted?: Record<string, unknown>): Promise<SlashCommand[]> {
    const { deps } = this;
    const never = { async *[Symbol.asyncIterator]() { await new Promise<never>(() => {}); } } as AsyncIterable<SDKUserMessage>;
    const abort = new AbortController();
    const options: Options = {
      cwd,
      pathToClaudeCodeExecutable: deps.claudePath,
      env: { ...cliEnv(account), ...(untrusted || isHome(cwd) ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {}) },
      ...(untrusted ? untrustedSettings(cwd, untrusted) : trustedSettings(cwd)),
      tools: [],
      abortController: abort,
      spawnClaudeCodeProcess: groupSpawner(deps.registry, deps.log, () => {}, `commands:${account.id}`),
    };
    const queryFn = deps.queryFn ?? sdkQuery;
    const q = queryFn({ prompt: never, options });
    try {
      return claudeCommands(await q.supportedCommands(), { cwd, configDir: account.configDir });
    } finally {
      try {
        q.close();
      } catch {
        // already closed
      }
      abort.abort();
    }
  }

  // An edit of an earlier message (docs/protocol.md, "Editing a message").
  // The conversation is cut by the next start (resumeAt); here the
  // transcript says where, and a CLI started on the session with no turn
  // rewinds the files its checkpoints cover to how they were when the
  // message arrived. The SDK keys checkpoints by the message's uuid, which
  // is the runner's id for it.
  async rewind(req: RewindRequest): Promise<RewindResult> {
    const file = sessionTranscriptPath(req.account.configDir, req.cwd, req.sessionId);
    const cut = file ? cutPointBefore(fs.readFileSync(file, 'utf8'), req.messageId) : null;
    if (!cut) throw new RewindRefusedError("This message isn't in the thread's current session (it has moved to another login or folder since), so it can't be edited.");
    const files = await this.rewindFiles(req);
    return { ...(cut.first ? { fresh: true } : { resumeAt: cut.resumeAt }), ...(files ? { files } : {}) };
  }

  private async rewindFiles(req: RewindRequest): Promise<RewindResult['files']> {
    const { deps } = this;
    const never = { async *[Symbol.asyncIterator]() { await new Promise<never>(() => {}); } } as AsyncIterable<SDKUserMessage>;
    const abort = new AbortController();
    const options: Options = {
      cwd: req.cwd,
      pathToClaudeCodeExecutable: deps.claudePath,
      env: cliEnv(req.account),
      // No settings: nothing runs but the rewind, hooks included.
      settingSources: [],
      tools: [],
      resume: req.sessionId,
      enableFileCheckpointing: true,
      abortController: abort,
      spawnClaudeCodeProcess: groupSpawner(deps.registry, deps.log, () => {}, `rewind:${req.threadId}`),
    };
    const q = (deps.queryFn ?? sdkQuery)({ prompt: never, options });
    try {
      await q.initializationResult();
      // The dry run lists what will change; the real one doesn't.
      const plan = await q.rewindFiles(req.messageId, { dryRun: true });
      if (!plan.canRewind) {
        // No checkpoint for it: a session from before checkpoints were on.
        deps.log.info('no file checkpoint to rewind to', { threadId: req.threadId, error: plan.error });
        return undefined;
      }
      const done = await q.rewindFiles(req.messageId);
      if (!done.canRewind) return { undone: [], failed: (plan.filesChanged ?? []).map((p) => ({ path: p, reason: done.error || "Couldn't put it back." })) };
      const failed = done.skippedLinks ? [{ path: `${done.skippedLinks} linked file${done.skippedLinks === 1 ? '' : 's'}`, reason: 'Left alone, as it is a link.' }] : [];
      return { undone: plan.filesChanged ?? [], failed };
    } catch (e) {
      deps.log.warn('could not rewind files', { threadId: req.threadId, error: String(e) });
      return undefined;
    } finally {
      try {
        q.close();
      } catch {
        // already closed
      }
      abort.abort();
    }
  }
}

// How a session starts in a folder whose Claude Code settings run commands
// that aren't trusted (claude-trust.ts). Leaving out the project source is
// the only way the SDK has to skip a folder's hooks, .mcp.json servers and
// status line while keeping Mike's own hooks (disableAllHooks would stop
// those too), but it also drops the folder's CLAUDE.md. Naming the folder
// as an extra directory, with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
// (set by the caller), brings CLAUDE.md back without its settings (tried
// on CLI 2.1.318, 5 Nov 2026), and the rest of the settings come in as flag
// settings, which sit above user settings as project ones do.
export function untrustedSettings(cwd: string, settings: Record<string, unknown>): Pick<Options, 'settingSources' | 'settings' | 'additionalDirectories'> {
  return { settingSources: ['user'], additionalDirectories: [cwd], ...(Object.keys(settings).length ? { settings } : {}) };
}

// A trusted folder's: all its settings. Except home, whose project
// settings are Mike's own user ones already, but where the project source
// would also have Claude pick up the .claude/skills of any folder under
// home (a cloned repo's, hooks and all) as the agent works on a file
// there, which folder trust can't look through all of home for
// (claude-trust.ts). Its CLAUDE.md comes back as an extra directory's,
// with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD (set by the caller).
export function trustedSettings(cwd: string, home: string = os.homedir()): Pick<Options, 'settingSources' | 'additionalDirectories'> {
  return isHome(cwd, home) ? { settingSources: ['user', 'local'], additionalDirectories: [cwd] } : { settingSources: ['user', 'project', 'local'] };
}

function isHome(cwd: string, home: string = os.homedir()): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(cwd) === real(home);
}

// The CLI's rows as the protocol's ModelChoice. The "default" row stands
// for whatever the CLI would pick, which the account's settings can
// override, so it's left out: the runner works the default out itself.
export function modelChoices(rows: ModelInfo[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const row of rows) {
    if (!row || typeof row.value !== 'string' || !row.value || row.value === 'default') continue;
    const choice: ModelChoice = {
      id: row.value,
      model: typeof row.resolvedModel === 'string' && row.resolvedModel ? row.resolvedModel : stripModelSuffix(row.value),
      title: typeof row.displayName === 'string' && row.displayName ? row.displayName : row.value,
    };
    if (typeof row.description === 'string' && row.description) choice.description = row.description;
    if (row.supportsEffort && Array.isArray(row.supportedEffortLevels)) {
      const levels = row.supportedEffortLevels.filter(isEffortLevel);
      if (levels.length) choice.effortLevels = levels;
    }
    out.push(choice);
  }
  return out;
}

// What an agent is told when its permission request closes without an
// answer from anyone. In its result, so it reads it at the call it made.
export function cardClosedMessage(why: string | undefined): string {
  return `Threadbear closed this permission request before anyone answered it${why ? ` (${why.replace(/\.$/, '')})` : ''}. The user did not decline it, so don't tell them they did. The tool didn't run.`;
}

class ClaudeSession implements AgentSession {
  private opts: StartSessionOptions;
  private sink: SessionSink;
  private deps: ClaudeAdapterDeps;
  private input = new InputQueue();
  private q!: Query;
  private abort = new AbortController();
  private normalizer: ClaudeNormalizer;
  private mode: PermissionMode;
  // The permission mode each Edit and Write call went through on, by tool
  // use id, from its PreToolUse hook (and lowered by its approval card):
  // 'full' only when the runner and the CLI were both on Full access then.
  // Sent with the call's 'wrote', so a switch to Full access after an
  // edit was let through in Ask or Auto doesn't make it trusted.
  private writeModes = new Map<string, PermissionMode>();
  // Edit and Write calls outside Full access to a file that runs as code,
  // which the hook made ask (code-writes.ts).
  private codeWrites = new Set<string>();
  private exited = false;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private stderrTail: string[] = [];
  private seenTools = new Set<string>();
  private toolWaiters = new Map<string, (() => void)[]>();
  // Whether this session has the threadbear server's end_turn, and whether
  // the turn now ending called it (a taken call, from the PostToolUse hook).
  private hasEndTurn = false;
  private endTurnTaken = false;
  // askBeforeEveryTool was called.
  private askEvery = false;
  // One reply: whether this session's end_turn is that kind, and whether
  // the agent has written words since the turn's end_turn.
  private oneReply = false;
  private wroteAfterEnd = false;
  // end_turn answered that the message before it is the reply, so asking
  // for one would get a second that takes its place (needs.ts).
  private messageStands = false;
  private pastEndTurn = false;
  private endTurnCall?: string;
  // Whether the agent has read a background task's notification that came
  // into the turn: from then its end_turn is behind it, so the Stop hook
  // asks for another (needs.ts, WakeRead).
  private wake = new WakeRead();
  // Each end_turn call's card questions, by item id, until its result.
  private endTurnAsks = new Map<string, string[]>();
  // A reply owed after an accepted one-reply end_turn, with its card's
  // questions, for a compaction to be reminded of (onCompact). Its own
  // state, not pastEndTurn's: a Stop that sends the turn back for its reply
  // clears that, and a compaction can still come before the reply. A reply,
  // a new message from the user (the agent goes on to that) or the turn's
  // result ends it.
  private owedReply?: string[];

  constructor(opts: StartSessionOptions, sink: SessionSink, deps: ClaudeAdapterDeps) {
    this.opts = opts;
    this.sink = sink;
    this.deps = deps;
    this.mode = opts.permissionMode;
    this.normalizer = new ClaudeNormalizer(fileContext(opts.cwd, opts.mediaDir, opts.blobsDir));
    this.exitPromise = new Promise((r) => (this.resolveExit = r));
  }

  start(): void {
    const { opts, deps } = this;
    const env = cliEnv(opts.account);
    this.oneReply = deps.oneReply?.() === true;
    const untrusted = opts.untrustedProjectSettings;
    const options: Options = {
      cwd: opts.cwd,
      pathToClaudeCodeExecutable: deps.claudePath,
      env: {
        ...env,
        CLAUDE_CODE_TERMINAL_MCP_TOOLS: terminalMcpTools(env.CLAUDE_CODE_TERMINAL_MCP_TOOLS, this.oneReply),
        ...opts.env,
        ...(untrusted || isHome(opts.cwd) ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {}),
      },
      ...(untrusted ? untrustedSettings(opts.cwd, untrusted) : trustedSettings(opts.cwd)),
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(opts.instructions ? { append: opts.instructions } : {}) },
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      // Backups of the files the session's tools change, so an edit of an
      // earlier message can put them back (rewind below).
      enableFileCheckpointing: true,
      permissionMode: sdkPermissionMode(opts.permissionMode),
      // Always allowed so "Ask before edits" can be switched off mid-session.
      allowDangerouslySkipPermissions: true,
      canUseTool: (name, input, o) => this.canUseTool(name, input, o),
      // The CLI says which effort level a turn ran at (after its own
      // defaults and any downgrade) only through hooks; Stop fires once a
      // turn, and is the cheapest place to read it. It's also where a turn
      // that never called end_turn is sent back to call it (onStop).
      // PostToolUse is awaited before the CLI goes on, so a taken end_turn
      // is always noted before the Stop that follows it.
      hooks: {
        Stop: [{ hooks: [(input) => this.onStop(input)] }],
        PostToolUse: [{ matcher: END_TURN_FULL_NAME, hooks: [async (input) => this.onEndTurn(input)] }],
        // Every Edit and Write, in every mode, a sub-agent's too: where the
        // mode it ran on is recorded, and where one that writes code is
        // made to ask outside Full access (onEditCall).
        PreToolUse: [
          { matcher: [...EDIT_TOOLS].join('|'), hooks: [async (input) => this.onEditCall(input)] },
          // A hook's ask comes before allow rules, so it's how a folder's
          // untrusted ones stop applying once the thread leaves Full
          // (askBeforeEveryTool). Only on a session that may need it.
          ...(opts.heldGrants ? [{ hooks: [async () => (this.askEvery ? { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'ask' as const, permissionDecisionReason: "The folder's permission rules aren't trusted for this thread." } } : {})] }] : []),
        ],
        SessionStart: [{ hooks: [async (input) => this.onCompact(input)] }],
      },
      abortController: this.abort,
      spawnClaudeCodeProcess: ((spawn, sb) => (sb ? sandboxSpawner(spawn, sb, opts.threadId) : opts.confined ? () => { throw new Error(CONFINED_NO_SANDBOX(opts.cwd)); } : spawn))(
        groupSpawner(deps.registry, deps.log, (line) => this.stderr(line), opts.threadId),
        deps.sandboxFor?.(opts.cwd),
      ),
    };
    const servers = deps.mcpServersFor?.(opts.threadId);
    if (servers && Object.keys(servers).length) options.mcpServers = servers;
    this.hasEndTurn = Object.keys(servers ?? {}).some((k) => END_TURN_FULL_NAME.startsWith(`mcp__${k}__`));
    if (opts.model) options.model = opts.model;
    const effort = claudeEffort(opts.effort);
    if (effort) options.effort = effort;
    // The never-ask tools go in as allow rules too, so the CLI lets them
    // through before its own checks (Auto's classifier included) rather
    // than relying on canUseTool being reached. They're not the thread's
    // rules, so they're never saved with them.
    const allowed = [...(opts.allowRules ?? []), ...[...(deps.neverAsk ?? [])].filter((n) => !deps.alwaysAsk?.has(n))];
    if (allowed.length) options.allowedTools = [...new Set(allowed)];
    if (opts.resume) {
      options.resume = opts.sessionId;
      if (opts.resumeAt) options.resumeSessionAt = opts.resumeAt;
    } else options.sessionId = opts.sessionId;
    const queryFn = deps.queryFn ?? sdkQuery;
    this.q = queryFn({ prompt: this.input, options });
    void this.pump();
  }

  private async onStop(input: HookInput): Promise<{ decision?: 'block'; reason?: string }> {
    const level = (input as { effort?: { level?: unknown } }).effort?.level;
    if (isEffortLevel(level)) this.sink.output({ kind: 'effort', level });
    const stop = input as { stop_hook_active?: boolean; background_tasks?: unknown[] };
    const ended = this.endTurnTaken;
    const wrote = this.wroteAfterEnd || this.messageStands;
    this.forgetEndTurn();
    // A turn that ended in plain text leaves the runner reading the card
    // from the prose (needs.ts, needsFromText), which drops what end_turn
    // would have carried: on 30 Oct 2026 an agent skipped it for three
    // turns running and its follow-ups never reached the done card (thread
    // 13096d04). So send it back, once: stop_hook_active says this stop
    // already follows a nudge. Not while background work it started is
    // still going, as the turn that work wakes will end it. Sub-agents
    // stop through SubagentStop, never here.
    if (!this.hasEndTurn || stop.stop_hook_active || stop.background_tasks?.length) return {};
    // One reply: end_turn without words after it leaves no reply, so the
    // agent is asked for it, once (the hook's own guard, stop_hook_active).
    if (ended) return this.oneReply && !wrote ? { decision: 'block', reason: ONE_REPLY_WRITE_NUDGE } : {};
    this.sink.output({ kind: 'endTurnNudge' });
    return { decision: 'block', reason: this.oneReply ? ONE_REPLY_END_TURN_NUDGE : END_TURN_NUDGE };
  }

  // A compaction between an accepted end_turn and its reply. On 5 Nov 2026
  // (thread 1b770c6a) the context filled up just as one-reply end_turn
  // answered "Now write your reply"; the summary that replaced the
  // conversation didn't say a reply was owed, so the agent went back to
  // work and never wrote the launcher plan its card asked about. Nor did
  // the Stop hook ask, as status lines written while working counted as
  // words after end_turn. SessionStart runs with source "compact" right
  // after a compaction, and what it adds is the first thing the agent reads.
  private onCompact(input: HookInput): { hookSpecificOutput?: { hookEventName: 'SessionStart'; additionalContext: string } } {
    if ((input as { source?: string }).source !== 'compact') return {};
    if (!this.oneReply || !this.owedReply) return {};
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: owedReplyAfterCompact(this.owedReply) } };
  }

  private forgetEndTurn(): void {
    this.endTurnTaken = false;
    this.wroteAfterEnd = false;
    this.messageStands = false;
    this.pastEndTurn = false;
    this.endTurnCall = undefined;
  }

  private onEndTurn(input: HookInput): Record<string, never> {
    // A sub-agent's call never reaches the thread (threadbear-mcp.ts).
    if (!(input as { agent_id?: string }).agent_id) this.endTurnTaken = true;
    return {};
  }

  // Before the CLI decides on an Edit or Write's permission. A hook's
  // "ask" goes to canUseTool whatever allow rule ("Always allow", the
  // user's settings) or auto classifier would have let it through, so an
  // edit of a file that runs as code gets a card in Ask and Auto.
  private onEditCall(input: HookInput): { hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'ask'; permissionDecisionReason: string } } {
    const call = input as { tool_name?: string; tool_use_id?: string; tool_input?: unknown; permission_mode?: string };
    if (typeof call.tool_name !== 'string' || !EDIT_TOOLS.has(call.tool_name) || typeof call.tool_use_id !== 'string') return {};
    const id = call.tool_use_id;
    // Both sides on Full access: the runner's mode, and the CLI's own for
    // this call (it says, from this CLI on; one that doesn't is taken as
    // not, so nothing it writes is trusted unasked).
    const full = this.mode === 'full' && call.permission_mode === 'bypassPermissions';
    this.noteWriteMode(id, full ? 'full' : this.mode === 'full' ? 'ask' : this.mode);
    if (this.mode === 'full') return {};
    const file = this.editTarget(call.tool_input);
    const kind = file ? this.runsAsCode(file) : false;
    if (!kind) return {};
    this.codeWrites.add(id);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: codeWriteReason(kind) } };
  }

  // Keeps the strictest mode a call was seen on.
  private noteWriteMode(id: string, mode: PermissionMode): void {
    const was = this.writeModes.get(id);
    this.writeModes.set(id, was && was !== 'full' ? was : mode);
    // Calls whose result never came (a turn stopped mid-call) aren't kept
    // for ever.
    while (this.writeModes.size > 500) this.writeModes.delete(this.writeModes.keys().next().value!);
    while (this.codeWrites.size > 500) this.codeWrites.delete(this.codeWrites.values().next().value!);
  }

  private editTarget(input: unknown): string | undefined {
    const file = (input as { file_path?: unknown } | undefined)?.file_path;
    return typeof file === 'string' && file ? path.resolve(this.opts.cwd, file) : undefined;
  }

  private runsAsCode(file: string): CodeWrite {
    return runsAsCodeByName(file) || (this.opts.runsAsCode?.(file) ?? false);
  }

  private stderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 20) this.stderrTail.shift();
    this.deps.log.debug('cli stderr', { threadId: this.opts.threadId, line: line.slice(0, 500) });
  }

  private async pump(): Promise<void> {
    let error: Error | undefined;
    try {
      for await (const msg of this.q) {
        // A turn stopped by hand reports its result with no Stop hook, and
        // its end_turn mustn't count for the next one. Not done on send():
        // a message sent during a turn lands before the Stop that turn still
        // has coming, and that sent a turn which had called end_turn back
        // to call it (1 Nov 2026, thread cdfccbc3).
        if ((msg as { type?: string }).type === 'result') {
          this.forgetEndTurn();
          this.wake.reset();
          this.owedReply = undefined;
          this.endTurnAsks.clear();
        }
        for (let out of this.normalizer.handle(msg as Record<string, unknown>)) {
          // The mode the call went through on, recorded at the call.
          if (out.kind === 'wrote') {
            const mode = this.writeModes.get(out.itemId);
            out = { ...out, ...(mode ? { mode } : {}) };
          } else if (out.kind === 'event' && out.event.type === 'tool.result') {
            this.writeModes.delete(out.event.itemId);
            this.codeWrites.delete(out.event.itemId);
          }
          this.sink.output(out);
          // Words after end_turn's result, by the events' own order: the
          // hook that sets endTurnTaken can run before the text written
          // ahead of the call comes through.
          if (out.kind === 'event') {
            const ev = out.event;
            if (this.wake.see(ev)) this.forgetEndTurn();
            if (ev.type === 'tool.call' && ev.name === END_TURN_FULL_NAME) {
              this.endTurnCall = ev.itemId;
              const asks = Array.isArray(ev.input.asks) ? (ev.input.asks as { question?: unknown; action?: unknown }[]) : [];
              this.endTurnAsks.set(ev.itemId, asks.map((a) => String(a?.question ?? a?.action ?? '')).filter(Boolean));
            }
            else if (ev.type === 'tool.result' && ev.itemId === this.endTurnCall && ev.ok) {
              this.pastEndTurn = true;
              this.messageStands = endTurnMessageStands(ev);
              // Only an accepted call's own card: a refused repeat's result
              // isn't ok, and its questions never showed.
              if (endTurnWantsReply(ev)) this.owedReply = this.endTurnAsks.get(ev.itemId) ?? [];
            }
            else if (ev.type === 'assistant.text' && !ev.itemId.includes('/') && ev.text.trim()) {
              if (this.pastEndTurn) this.wroteAfterEnd = true;
              this.owedReply = undefined;
            }
          }
          if (out.kind === 'event' && out.event.type === 'tool.call') this.markToolSeen(out.event.itemId);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      const tail = this.stderrTail.filter((l) => !/enterprise policy/i.test(l)).slice(-5).join('\n');
      if (tail && !error.message.includes(tail)) error = new Error(`${error.message}\n${tail}`);
    } finally {
      this.exited = true;
      for (const ws of this.toolWaiters.values()) ws.forEach((w) => w());
      this.toolWaiters.clear();
      this.resolveExit();
      this.sink.exited(error);
    }
  }

  private markToolSeen(id: string): void {
    this.seenTools.add(id);
    const ws = this.toolWaiters.get(id);
    if (ws) {
      this.toolWaiters.delete(id);
      ws.forEach((w) => w());
    }
  }

  // The SDK can call canUseTool before the assistant frame carrying the
  // tool_use has come out of the message iterator. Waiting for it keeps the
  // event order tool.call -> edit.diff -> approval.requested.
  private waitForTool(id: string | undefined, ms: number): Promise<void> {
    if (!id || this.seenTools.has(id) || this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const list = this.toolWaiters.get(id) ?? [];
      list.push(() => {
        clearTimeout(t);
        resolve();
      });
      this.toolWaiters.set(id, list);
    });
  }

  private async canUseTool(
    name: string,
    input: Record<string, unknown>,
    o: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID: string; title?: string; suppressAlwaysAllowRule?: boolean; agentID?: string },
  ): Promise<PermissionResult> {
    // A subagent's tool calls stay inside its Agent call (the normaliser
    // drops them), so there's no tool.call to wait for or point at.
    const sub = Boolean(o.agentID);
    const itemId = sub ? undefined : o.toolUseID;
    if (!sub) await this.waitForTool(o.toolUseID, 2000);
    if (name === 'AskUserQuestion') {
      const questions = normaliseQuestions(input.questions);
      const ans = await this.sink.requestQuestion({ toolUseId: itemId, questions, signal: o.signal });
      if (ans.answers) return { behavior: 'allow', updatedInput: { ...input, answers: ans.answers }, toolUseID: o.toolUseID };
      // Stop stops whoever's asking, as with a tool's card below.
      if (ans.stopped) return { behavior: 'deny', message: ans.message || 'Interrupted.', interrupt: true, toolUseID: o.toolUseID };
      return { behavior: 'deny', message: ans.message || 'The user dismissed the question without answering.', toolUseID: o.toolUseID };
    }
    if (this.deps.neverAsk?.has(name) && !this.deps.alwaysAsk?.has(name)) return { behavior: 'allow', updatedInput: input, toolUseID: o.toolUseID };
    if (this.mode === 'full' && !this.deps.alwaysAsk?.has(name)) return { behavior: 'allow', updatedInput: input, toolUseID: o.toolUseID };
    // "Plan first": the plan goes to Mike as a plan card, and this call
    // waits on it like any approval. Approving it answers with the mode to
    // leave plan mode for (setMode below), as the CLI's own prompt does.
    const plan = name === 'ExitPlanMode' && this.mode === 'plan' && !sub;
    if (plan) this.sink.output({ kind: 'planProposed', itemId: o.toolUseID, text: typeof input.plan === 'string' ? input.plan : '' });
    // Approved outside Full access, whatever the hook saw.
    if (EDIT_TOOLS.has(name)) this.noteWriteMode(o.toolUseID, this.mode);
    // An edit that writes code Threadbear runs: asked about every time, and
    // the card says why (code-writes.ts).
    const target = EDIT_TOOLS.has(name) ? this.editTarget(input) : undefined;
    const code: CodeWrite = (target !== undefined && this.runsAsCode(target)) || this.codeWrites.has(o.toolUseID);
    // The card shows the whole command, or every argument of an MCP tool
    // (what it does elsewhere is in them); one too long for that is refused
    // rather than allowed from its start (tools.ts, cardInput).
    // An edit of a file that runs as code shows all it writes, too (Codex review).
    const card = cardInput(input, name.startsWith('mcp__') || code ? 'all' : ['command']);
    if (card.tooLong) return { behavior: 'deny', message: tooLongForCard(card.tooLong), toolUseID: o.toolUseID };
    if (!sub) for (const out of this.normalizer.beforeApproval(o.toolUseID, name, input)) this.sink.output(out);
    const title = toolTitle(name, input, this.opts.cwd);
    const ans = await this.sink.requestApproval({
      toolUseId: itemId,
      name,
      title: code ? `${title} (${codeWriteNote(code)})` : title,
      input: card.input,
      // "Always allow" would defeat a tool that's meant to ask every time.
      canAlwaysAllow: !plan && !code && !o.suppressAlwaysAllowRule && !this.deps.alwaysAsk?.has(name),
      signal: o.signal,
    });
    // A client that offers it anyway gets this once, never a rule.
    const decision = code && ans.decision === 'allowAlways' ? 'allow' : ans.decision;
    switch (decision) {
      case 'allow':
        if (plan && ans.mode) {
          this.mode = ans.mode;
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: [{ type: 'setMode', mode: sdkPermissionMode(ans.mode), destination: 'session' }],
            toolUseID: o.toolUseID,
            decisionClassification: 'user_temporary',
          };
        }
        return { behavior: 'allow', updatedInput: input, toolUseID: o.toolUseID, decisionClassification: 'user_temporary' };
      case 'allowAlways': {
        const { updates, rules } = alwaysAllow(name, o.suggestions);
        this.sink.output({ kind: 'allowRules', rules });
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: updates,
          toolUseID: o.toolUseID,
          decisionClassification: 'user_permanent',
        };
      }
      case 'expired':
        // `interrupt` makes the CLI say "The user doesn't want to proceed"
        // and "stopped by user", whatever message goes with it, and kill a
        // subagent. So it's only for Stop: anything else closing a card isn't
        // Mike's decision, and agents repeat those words to him as if it were.
        if (ans.stopped) return { behavior: 'deny', message: ans.message || 'Interrupted.', interrupt: true, toolUseID: o.toolUseID };
        return { behavior: 'deny', message: cardClosedMessage(ans.message), toolUseID: o.toolUseID };
      default:
        return {
          behavior: 'deny',
          message: ans.message || 'The user denied this. Ask them how to proceed.',
          toolUseID: o.toolUseID,
          decisionClassification: 'user_reject',
        };
    }
  }

  send(input: UserInput): void {
    this.normalizer.sent();
    // A new message takes over from a reply owed to the last one (onCompact).
    this.owedReply = undefined;
    // Each picture where its [Picture N] marker is in the words, or before
    // them when nothing places it (pictures.ts).
    const content: Record<string, unknown>[] = placePictures(input.text, input.images).map((part) => {
      if ('text' in part) return { type: 'text', text: part.text };
      const { data, mediaType } = prepareImageForModel(part.image, this.opts.tmpDir);
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } };
    });
    if (content.length === 0) content.push({ type: 'text', text: input.text });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: content.length === 1 && content[0].type === 'text' ? input.text : (content as never) },
      parent_tool_use_id: null,
      // The SDK treats a message with no origin as unattributed; this one
      // is Mike typing in the app, so say so.
      origin: { kind: 'human' },
      // With a uuid the CLI reports command_lifecycle frames for the
      // message, which is how its own turns are told apart from this one.
      uuid: input.id ?? crypto.randomUUID(),
    } as SDKUserMessage);
  }

  // Stop means stop: a message pushed in while the turn ran and still
  // waiting in the CLI's queue is cancelled too, or the CLI would answer
  // it as a turn of its own straight after. (The SDK's types don't name
  // the option yet; the CLI advertises it as interrupt_cancel_queued_v1.)
  async interrupt(): Promise<void> {
    if (this.exited) return;
    await (this.q.interrupt as (opts?: { cancelQueued?: boolean }) => Promise<unknown>)({ cancelQueued: true });
  }

  async commands(): Promise<SlashCommand[]> {
    if (this.exited) return [];
    return claudeCommands(await this.q.supportedCommands(), { cwd: this.opts.cwd, configDir: this.opts.account.configDir });
  }

  async setModel(model: string | undefined): Promise<void> {
    if (this.exited) return;
    await this.q.setModel(model);
  }

  // Flag settings sit above the settings files for this session only, so
  // null puts the level back to the model's own without touching Mike's
  // settings.json.
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    if (this.exited) return;
    await this.q.applyFlagSettings({ effortLevel: claudeEffort(effort) ?? null });
  }

  // Leaving Full access counts at once and coming to it only once the CLI
  // has, so between the two the stricter mode is the one in force here.
  // Only the newest switch's ending sets it: a switch to Full finishing
  // after a later one away from it would bring Full back (Codex review).
  private modeSwitch = 0;
  askBeforeEveryTool(): void {
    this.askEvery = true;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.exited) return;
    const n = ++this.modeSwitch;
    if (mode !== 'full') this.mode = mode;
    await this.q.setPermissionMode(sdkPermissionMode(mode));
    if (n === this.modeSwitch) this.mode = mode;
  }

  async end(opts: { hard?: boolean } = {}): Promise<void> {
    if (opts.hard && !this.exited) {
      this.kill();
      await this.exitPromise;
      return;
    }
    if (!this.input.isEnded) this.input.end();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000).unref());
    if ((await Promise.race([this.exitPromise, timeout])) === 'timeout') {
      this.deps.log.warn('CLI did not exit after its input ended; killing it', { threadId: this.opts.threadId });
      this.kill();
      await this.exitPromise;
    }
  }

  kill(): void {
    try {
      this.q.close();
    } catch {
      // already closed
    }
    this.abort.abort();
  }
}

// The SDK's list, as the picker's. Claude Code's own are marked builtin;
// the rest are Mike's or the folder's commands and skills. Rows can share
// a name, and a builtin one is what /name runs, so that one is kept.
export function claudeCommands(
  list: { name: string; description?: string; argumentHint?: string; builtin?: boolean; aliases?: string[] }[],
  where?: { cwd: string; configDir: string },
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const c of list) {
    if (typeof c?.name !== 'string' || !c.name) continue;
    const name = c.name.replace(/^\//, '');
    if (byName.get(name)?.source === 'cli') continue;
    const out: SlashCommand = { name, source: c.builtin ? 'cli' : 'skill' };
    const { text, scope, plugin } = c.builtin ? { text: c.description, scope: 'system', plugin: undefined } : commandScope(c.description);
    if (text) out.description = text;
    if (c.argumentHint) out.argumentHint = c.argumentHint;
    const aliases = (c.aliases ?? []).filter((a) => typeof a === 'string' && a && a !== name);
    if (aliases.length) out.aliases = aliases;
    if (scope) out.scope = scope;
    if (plugin) out.plugin = plugin;
    const file = where && (scope === 'user' || scope === 'project') ? commandFile(name, scope === 'user' ? where.configDir : path.join(where.cwd, '.claude')) : undefined;
    if (file) out.path = file;
    byName.set(name, out);
  }
  return [...byName.values()];
}

// The CLI says where a command came from only as a tag at the end of its
// description: "(user)", "(project)", "(claude.ai sync)", or a plugin's
// name. The tag comes off the description, as the palette says it itself.
export function commandScope(description: string | undefined): { text?: string; scope?: string; plugin?: string } {
  const m = description ? /^([\s\S]*?)\s*\(([^()]+)\)\s*$/.exec(description) : null;
  if (!m) return { text: description };
  const tag = m[2].trim();
  const text = m[1] || undefined;
  if (tag === 'user' || tag === 'project') return { text, scope: tag };
  if (/^claude\.ai/.test(tag)) return { text, scope: 'claude.ai' };
  // A plugin's commands are tagged with its name, which never has a space;
  // words in brackets that end a sentence ("(see below)") stay put.
  if (/^[\w.@-]+(:[\w.@-]+)?$/.test(tag)) return { text, scope: 'plugin', plugin: tag.replace(/^plugin:/, '') };
  return { text: description };
}

// A user or project command's file: its skill, else its command (a ":"
// in the name is a folder, as the CLI reads them).
export function commandFile(name: string, base: string): string | undefined {
  const tries = [path.join(base, 'skills', name, 'SKILL.md'), path.join(base, 'commands', ...name.split(':')) + '.md'];
  return tries.find((f) => fs.existsSync(f));
}

// "Always allow" keeps the CLI's suggested allow rules for this thread
// only. Suggestions can also switch the session's permission mode (to
// acceptEdits, say) or save rules in the project's .claude folder, which
// would change more than the user agreed to and outlive the thread, so
// those are dropped and every rule is session-scoped. The runner keeps the
// rules on the thread and passes them back as allowedTools after a resume.
export function alwaysAllow(name: string, suggestions: PermissionUpdate[] | undefined): { updates: PermissionUpdate[]; rules: string[] } {
  const updates: PermissionUpdate[] = [];
  const rules: string[] = [];
  for (const s of suggestions ?? []) {
    if (s.type === 'addRules' && s.behavior === 'allow' && s.rules.length) {
      updates.push({ ...s, destination: 'session' });
      rules.push(...s.rules.map(ruleString));
    } else if (s.type === 'addDirectories') {
      updates.push({ ...s, destination: 'session' });
    }
  }
  if (rules.length === 0) {
    updates.push({ type: 'addRules', rules: [{ toolName: name }], behavior: 'allow', destination: 'session' });
    rules.push(name);
  }
  return { updates, rules };
}

function ruleString(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
}

function normaliseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((q) => {
    const out: Question = {
      question: String(q.question ?? ''),
      multiSelect: Boolean(q.multiSelect),
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[]).map((o) => {
            const opt: { label: string; description?: string } = { label: String(o.label ?? '') };
            if (typeof o.description === 'string') opt.description = o.description;
            return opt;
          })
        : [],
    };
    if (typeof q.header === 'string') out.header = q.header;
    return out;
  });
}

// Codex's 'ultra' has no Claude equivalent. The runner drops it from Claude
// threads with a note before it gets here; this keeps the SDK from seeing it
// if one slips through.
function claudeEffort(effort: EffortLevel | undefined): Exclude<EffortLevel, 'ultra'> | undefined {
  return effort === 'ultra' ? undefined : effort;
}
