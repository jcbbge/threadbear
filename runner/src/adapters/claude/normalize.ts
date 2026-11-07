// Turns Claude Agent SDK messages into protocol events. Pure apart from the
// injected file helpers, so it can be tested by feeding recorded SDK message
// sequences through it.
import crypto from 'node:crypto';
import type { BackgroundKind, EventBody, Hunk, ImageRef, SubagentStatus, UsageWindow } from '../../protocol.ts';
import { LIMITS } from '../../protocol.ts';
import type { AdapterOutput, AgentWrite, SubagentUpdate, TurnResult } from '../types.ts';
import type { NormalizerContext } from '../context.ts';
import { EDIT_TOOLS, PlanTracker, computeEditDiff, toolKind, toolTitle, truncateInput } from '../../tools.ts';
import { diffLines } from '../../diff.ts';
import { safeEnd } from '../../safe-cut.ts';

// The file helpers moved to ../context.ts so the Codex normaliser shares
// them; re-exported for the callers and tests that import them from here.
export { fileContext, type NormalizerContext } from '../context.ts';

type AnyMsg = Record<string, any>;

// Opus 5.5 with summarised thinking at times sends what it says to Mike
// as a thinking block, not a text block: the block's signature (a
// protobuf, base64) names its kind "narration" where a real one says
// "thinking". It sits in the text block's slot (thinking, narration, tool
// call; never a text block after it) and reads as the reply. Shown as
// reasoning, those replies were folded away and end_turn refused the turn
// for having none (29 Oct 2026). The CLI itself doesn't tell them apart.
// Its text is the API's summary of what the agent wrote, not the words
// (summarised thinking), so the event says so: `narration` (needs.ts,
// turnReply, and the runner's onOutput).
export function isNarration(signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature) return false;
  // The kind is in the first few dozen bytes; 64 characters is 48 of them.
  return Buffer.from(signature.slice(0, 64), 'base64').includes('narration');
}

type OpenItem = { type: 'assistant.text' | 'reasoning'; text: string; narration?: true };

export class ClaudeNormalizer {
  private ctx: NormalizerContext;
  private curMsgId = '';
  private blockCount = new Map<string, number>(); // assistant frames seen per message id
  private blockTypes = new Map<string, string>(); // `${msgId}:${index}` -> block type from the stream
  private open = new Map<string, OpenItem>(); // streamed items with no complete frame yet
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private diffed = new Set<string>();
  private plan = new PlanTracker();
  // Which turn the CLI is in. 'user' answers a message the runner sent;
  // 'own' is one the CLI started itself, after a background shell or an
  // async subagent finished. command_lifecycle frames (CLI 2.1.310+) say
  // which; without them, messages sent but not yet answered are counted.
  private turn: 'none' | 'user' | 'own' = 'none';
  private lifecycle = false;
  private command?: string; // uuid of the message the CLI's current turn answers
  private unanswered = 0;
  private pendingNote?: string; // a finished background task, shown with the turn it starts
  private limitRejected = false; // a rate_limit_event this turn said the login is at its limit
  private authFailed = false; // this turn's login was refused (signed out, or its session ran out)
  private afterCompact = false;
  private agentTasks = new Set<string>(); // task ids that are sub-agents
  private model?: string; // the session's model, from init
  private contextNow?: number; // tokens in the context at the last model call

  constructor(ctx: NormalizerContext) {
    this.ctx = ctx;
  }

  // The runner sent a user message.
  sent(): void {
    this.unanswered++;
  }

  handle(msg: AnyMsg): AdapterOutput[] {
    const out: AdapterOutput[] = [];
    // Subagent traffic stays inside its Agent tool call for now.
    if (msg.parent_tool_use_id) return out;
    switch (msg.type) {
      case 'command_lifecycle':
        this.lifecycle = true;
        if (msg.state === 'started') {
          this.turn = 'user';
          if (typeof msg.command_uuid === 'string') this.command = msg.command_uuid;
          this.flushNote(out);
        }
        break;
      case 'system':
        this.system(msg, out);
        break;
      case 'stream_event':
        this.stream(msg, out);
        break;
      case 'assistant':
        this.assistant(msg, out);
        break;
      case 'user':
        this.user(msg, out);
        break;
      case 'result':
        this.result(msg, out);
        break;
      case 'rate_limit_event':
        this.rateLimit(msg, out);
        break;
      default:
        break;
    }
    return out;
  }

  // Called from canUseTool before an approval card is shown. In ask mode the
  // edit hasn't happened yet, so the diff is computed from the file as it is.
  beforeApproval(toolUseId: string | undefined, name: string, input: Record<string, unknown>): AdapterOutput[] {
    if (!toolUseId || !EDIT_TOOLS.has(name) || this.diffed.has(toolUseId)) return [];
    const file = typeof input.file_path === 'string' ? input.file_path : '';
    const d = computeEditDiff(name, input, file ? this.ctx.readFile(file) : null);
    if (!d || d.hunks.length === 0) return [];
    this.diffed.add(toolUseId);
    return [{ kind: 'event', event: { type: 'edit.diff', itemId: toolUseId, path: d.path, hunks: d.hunks } }];
  }

  // The CLI sends system/init at the start of every turn. One that isn't
  // answering a message the runner sent is a turn the CLI started itself.
  private turnStarting(out: AdapterOutput[]): void {
    if (this.turn !== 'none') return;
    const own = this.lifecycle || this.unanswered === 0;
    this.turn = own ? 'own' : 'user';
    if (own) {
      const note = this.pendingNote;
      this.pendingNote = undefined;
      out.push(note ? { kind: 'cliTurn', note } : { kind: 'cliTurn' });
    } else this.flushNote(out);
  }

  private flushNote(out: AdapterOutput[]): void {
    if (!this.pendingNote) return;
    out.push({ kind: 'event', event: { type: 'system.note', text: this.pendingNote } });
    this.pendingNote = undefined;
  }

  private system(msg: AnyMsg, out: AdapterOutput[]): void {
    if (typeof msg.subtype === 'string' && msg.subtype.startsWith('task_')) this.subagentTask(msg, out);
    if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
      out.push({ kind: 'session', nativeSessionId: msg.session_id, model: msg.model });
      if (typeof msg.model === 'string') this.model = msg.model;
      // The version of the CLI running this session, so CLI updates know
      // which versions are in use (the runner notes a change).
      if (typeof msg.claude_code_version === 'string' && msg.claude_code_version) out.push({ kind: 'cliVersion', version: msg.claude_code_version });
      this.turnStarting(out);
    } else if (msg.subtype === 'compact_boundary') {
      this.afterCompact = true;
      out.push({ kind: 'event', event: { type: 'system.note', text: 'Compacted the conversation' } });
    } else if (msg.subtype === 'task_notification' && !msg.ambient && !msg.skip_transcript) {
      // A background shell or async subagent finished. Mid-turn the CLI
      // folds it into that turn; otherwise it starts a turn of its own,
      // and the note says why.
      const text = typeof msg.summary === 'string' && msg.summary.trim() ? oneLineNote(msg.summary) : 'A background task finished.';
      if (this.turn === 'none') this.pendingNote = this.pendingNote ? `${this.pendingNote}\n${text}` : text;
      else out.push({ kind: 'event', event: { type: 'system.note', text, wake: true } });
    } else if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
      const tasks = (msg.tasks as AnyMsg[])
        .filter((t) => !t.ambient && typeof t.task_id === 'string')
        .map((t) => {
          const type = String(t.task_type ?? 'task');
          return { id: String(t.task_id), type, kind: backgroundKind(type), description: String(t.description ?? '') };
        });
      out.push({ kind: 'tasks', tasks });
    } else if (msg.subtype === 'informational' && msg.level === 'warning' && typeof msg.content === 'string') {
      out.push({ kind: 'event', event: { type: 'system.note', text: msg.content } });
    }
  }

  // The CLI's task events for a sub-agent (task_type local_agent), as
  // changes to the thread's list of them. Shells and monitors are tasks too,
  // and only show up in the background list.
  private subagentTask(msg: AnyMsg, out: AdapterOutput[]): void {
    const id = typeof msg.task_id === 'string' ? msg.task_id : '';
    if (!id) return;
    if (msg.subtype === 'task_started') {
      if (msg.task_type !== 'local_agent' && msg.task_type !== 'remote_agent' && !msg.subagent_type) return;
      if (msg.ambient || msg.skip_transcript) return;
      this.agentTasks.add(id);
      const update: SubagentUpdate = { id, started: true, status: 'running', background: msg.is_backgrounded === true };
      if (typeof msg.tool_use_id === 'string') update.itemId = msg.tool_use_id;
      if (typeof msg.parent_task_id === 'string') update.parentId = msg.parent_task_id;
      if (typeof msg.description === 'string') update.description = msg.description;
      if (typeof msg.subagent_type === 'string') update.agentType = msg.subagent_type;
      out.push({ kind: 'subagent', update });
      return;
    }
    // A CLI that was resumed can report a sub-agent it didn't start this
    // time; subagent_type says it's one.
    if (!this.agentTasks.has(id)) {
      if (msg.subtype !== 'task_progress' || typeof msg.subagent_type !== 'string') return;
      this.agentTasks.add(id);
    }
    if (msg.subtype === 'task_progress') {
      // description here is the CLI's running line ("Running npm test");
      // summary, when the CLI makes one, says it better.
      const update: SubagentUpdate = { id };
      const activity = typeof msg.summary === 'string' && msg.summary.trim() ? msg.summary : msg.description;
      if (typeof activity === 'string' && activity.trim()) update.activity = oneLineNote(activity);
      if (typeof msg.usage?.tool_uses === 'number') update.toolUses = msg.usage.tool_uses;
      out.push({ kind: 'subagent', update });
    } else if (msg.subtype === 'task_updated') {
      const p = (msg.patch ?? {}) as AnyMsg;
      const update: SubagentUpdate = { id };
      const status = subagentStatus(p.status);
      if (status) update.status = status;
      if (p.is_backgrounded === true) update.background = true;
      if (typeof p.description === 'string' && p.description) update.description = p.description;
      if (status === 'failed' && typeof p.error === 'string' && p.error) update.summary = oneLineNote(p.error);
      if (update.status || update.background || update.description) out.push({ kind: 'subagent', update });
    } else if (msg.subtype === 'task_notification') {
      const update: SubagentUpdate = { id, status: subagentStatus(msg.status) ?? 'completed' };
      if (typeof msg.summary === 'string' && msg.summary.trim()) update.summary = oneLineNote(msg.summary);
      if (typeof msg.usage?.tool_uses === 'number') update.toolUses = msg.usage.tool_uses;
      out.push({ kind: 'subagent', update });
    }
  }

  private stream(msg: AnyMsg, out: AdapterOutput[]): void {
    const ev = msg.event as AnyMsg | undefined;
    if (!ev) return;
    if (ev.type === 'message_start') this.turnStarting(out);
    if (typeof msg.api_message_id === 'string') this.curMsgId = msg.api_message_id;
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.id) this.curMsgId = ev.message.id;
        break;
      case 'content_block_start': {
        const block = ev.content_block as AnyMsg;
        const itemId = `${this.curMsgId}:${ev.index}`;
        this.blockTypes.set(itemId, block?.type);
        if (block?.type === 'text' && block.text) this.delta(out, 'assistant.text', itemId, block.text);
        if (block?.type === 'thinking' && block.thinking) this.delta(out, 'reasoning', itemId, block.thinking);
        break;
      }
      case 'content_block_delta': {
        const d = ev.delta as AnyMsg;
        const itemId = `${this.curMsgId}:${ev.index}`;
        if (d?.type === 'text_delta' && d.text) this.delta(out, 'assistant.text', itemId, d.text);
        else if (d?.type === 'thinking_delta' && d.thinking) this.delta(out, 'reasoning', itemId, d.thinking);
        else if (d?.type === 'signature_delta' && isNarration(d.signature)) {
          // Its deltas went out as reasoning; the complete frame says text.
          // This keeps one cut off before that frame as text too.
          const item = this.open.get(itemId);
          if (item) Object.assign(item, { type: 'assistant.text', narration: true });
        }
        break;
      }
      case 'message_delta': {
        const tokens = contextTokens(ev.usage);
        if (tokens !== undefined) {
          this.contextNow = tokens;
          out.push({ kind: 'context', contextTokens: tokens });
        }
        break;
      }
      default:
        break;
    }
  }

  private delta(out: AdapterOutput[], type: OpenItem['type'], itemId: string, text: string): void {
    // A complete frame already landed for this item (frames can beat the
    // last deltas); late deltas would only duplicate text.
    const done = this.blockCount.get(itemId.slice(0, itemId.lastIndexOf(':'))) ?? 0;
    if (Number(itemId.slice(itemId.lastIndexOf(':') + 1)) < done) return;
    const item = this.open.get(itemId) ?? { type, text: '' };
    item.text += text;
    this.open.set(itemId, item);
    out.push({
      kind: 'delta',
      delta: { type: type === 'assistant.text' ? 'assistant.text.delta' : 'reasoning.delta', itemId, text },
    });
  }

  private assistant(msg: AnyMsg, out: AdapterOutput[]): void {
    const m = msg.message as AnyMsg | undefined;
    if (!m || !Array.isArray(m.content)) return;
    // After a compaction the CLI re-sends the output of earlier local
    // commands (/cost, /context) that it kept; they're already shown.
    if (this.afterCompact && msg.local_command_source) return;
    this.turnStarting(out);
    // A refused login: the CLI makes up an assistant message saying so
    // (model <synthetic>, error authentication_failed), then says it again
    // as the turn's result. Only the result is shown, as the error row, so
    // the same sentence doesn't appear twice; errorKind auth gets it a Sign
    // in button.
    if (msg.error === 'authentication_failed') {
      this.authFailed = true;
      return;
    }
    const msgId = typeof m.id === 'string' ? m.id : `msg-${msg.uuid ?? Math.random().toString(36).slice(2)}`;
    for (const block of m.content as AnyMsg[]) {
      // The CLI sends one frame per completed content block, in order, so
      // the Nth block seen for a message id is stream index N.
      const idx = this.blockCount.get(msgId) ?? 0;
      this.blockCount.set(msgId, idx + 1);
      const itemId = `${msgId}:${idx}`;
      this.open.delete(itemId);
      switch (block.type) {
        case 'text':
          if (block.text) out.push({ kind: 'event', event: { type: 'assistant.text', itemId, text: block.text } });
          break;
        case 'thinking':
          if (block.thinking) {
            const text = block.thinking;
            out.push({ kind: 'event', event: isNarration(block.signature) ? { type: 'assistant.text', itemId, text, narration: true } : { type: 'reasoning', itemId, text } });
          }
          break;
        case 'tool_use':
        case 'server_tool_use':
        case 'mcp_tool_use':
          this.toolCall(block, out);
          break;
        case 'web_search_tool_result':
        case 'web_fetch_tool_result':
          if (block.tool_use_id) {
            out.push({
              kind: 'event',
              event: {
                type: 'tool.result',
                itemId: block.tool_use_id,
                ok: !(block.content && block.content.type?.endsWith('error')),
                ...truncateText(summariseServerResult(block.content), block.tool_use_id, this.ctx),
                images: [],
              },
            });
          }
          break;
        default:
          break;
      }
    }
  }

  private toolCall(block: AnyMsg, out: AdapterOutput[]): void {
    const name = String(block.name ?? 'tool');
    const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
    const id = String(block.id);
    this.tools.set(id, { name, input });
    out.push({
      kind: 'event',
      event: {
        type: 'tool.call',
        itemId: id,
        name,
        kind: toolKind(name),
        title: toolTitle(name, input, this.ctx.cwd),
        input: truncateInput(input),
      },
    });
    if (name === 'TodoWrite') {
      const entries = this.plan.fromTodoWrite(input);
      if (entries) out.push({ kind: 'event', event: { type: 'plan.updated', entries } });
    }
  }

  private user(msg: AnyMsg, out: AdapterOutput[]): void {
    if (msg.isReplay) return;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as AnyMsg[]) {
      if (block.type !== 'tool_result') continue;
      const id = String(block.tool_use_id);
      const call = this.tools.get(id);
      const images: ImageRef[] = [];
      const texts: string[] = [];
      if (typeof block.content === 'string') texts.push(block.content);
      else if (Array.isArray(block.content)) {
        for (const c of block.content as AnyMsg[]) {
          if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
          else if (c.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string') {
            try {
              images.push(this.ctx.saveImage(c.source.data, c.source.media_type ?? 'image/png', call?.name ?? 'tool'));
            } catch {
              texts.push('[image could not be saved]');
            }
          }
        }
      }
      const tur = msg.tool_use_result as AnyMsg | undefined;
      if (call && EDIT_TOOLS.has(call.name) && !this.diffed.has(id) && !block.is_error) {
        const d = this.diffFromResult(call.name, call.input, tur);
        if (d && d.hunks.length) {
          this.diffed.add(id);
          out.push({ kind: 'event', event: { type: 'edit.diff', itemId: id, path: d.path, hunks: d.hunks } });
        }
      }
      // What a successful Edit or Write left, for patch trust: never from
      // beforeApproval's preview, which a denied edit also gets.
      if (call && EDIT_TOOLS.has(call.name) && !block.is_error) {
        const w = wroteFromResult(call.name, call.input, tur);
        if (w) out.push({ kind: 'wrote', itemId: id, files: [w] });
      }
      const text = texts.join('\n');
      const spilled = this.persistedOutput(id, text, tur);
      out.push({
        kind: 'event',
        event: {
          type: 'tool.result',
          itemId: id,
          ok: !block.is_error,
          ...(spilled ?? truncateText(text, id, this.ctx)),
          images,
        },
      });
      if (call && !block.is_error) this.planFromResult(call.name, call.input, tur, out);
    }
  }

  // Big output (Bash over about 30 KB) is saved by the CLI to a file in the
  // account's folder, and the result only holds a preview. Keep a copy of
  // the full output in the thread and point at it.
  private persistedOutput(id: string, text: string, tur: AnyMsg | undefined): { text: string; truncated: boolean; blobPath?: string } | null {
    let src = typeof tur?.persistedOutputPath === 'string' ? (tur.persistedOutputPath as string) : '';
    if (!src && text.startsWith('<persisted-output>')) src = /Full output saved to: (.+)/.exec(text)?.[1]?.trim() ?? '';
    if (!src) return null;
    const blobPath = this.ctx.copyBlob(id, src);
    const r = truncateText(text, id, this.ctx);
    return blobPath ? { text: r.text, truncated: true, blobPath } : r;
  }

  private diffFromResult(
    name: string,
    input: Record<string, unknown>,
    tur: AnyMsg | undefined,
  ): { path: string; hunks: Hunk[] } | null {
    const file = (typeof tur?.filePath === 'string' && tur.filePath) || (typeof input.file_path === 'string' ? input.file_path : '');
    if (tur && Array.isArray(tur.structuredPatch) && tur.structuredPatch.length > 0) {
      return { path: file, hunks: cleanHunks(tur.structuredPatch as Hunk[]) };
    }
    // No patch from the CLI (a new file, or an older CLI): rebuild it from
    // the original text the result carries, or from the input alone.
    const original = typeof tur?.originalFile === 'string' ? (tur.originalFile as string) : null;
    if (name === 'Write') {
      const content = typeof tur?.content === 'string' ? (tur.content as string) : String(input.content ?? '');
      return { path: file, hunks: diffLines(original ?? '', content) };
    }
    const d = computeEditDiff(name, input, original);
    return d ? { path: file || d.path, hunks: d.hunks } : null;
  }

  private planFromResult(name: string, input: Record<string, unknown>, tur: AnyMsg | undefined, out: AdapterOutput[]): void {
    let entries = null;
    if (name === 'TaskCreate' && tur?.task?.id) entries = this.plan.taskCreated(String(tur.task.id), String(tur.task.subject ?? input.subject ?? ''));
    else if (name === 'TaskUpdate' && tur?.success !== false) entries = this.plan.taskUpdated(input);
    else if (name === 'TaskList' && tur?.tasks) entries = this.plan.taskList(tur.tasks);
    if (entries) out.push({ kind: 'event', event: { type: 'plan.updated', entries } });
  }

  // The account's room left, which the CLI reports with every model call.
  // It goes to the UsageStore; status "rejected" means the login is at its
  // limit, and a turn that then fails failed on it.
  private rateLimit(msg: AnyMsg, out: AdapterOutput[]): void {
    const reading = rateLimitReading(msg.rate_limit_info);
    if (!reading) return;
    if (reading.blocked) this.limitRejected = true;
    out.push({ kind: 'limits', ...reading });
  }

  private result(msg: AnyMsg, out: AdapterOutput[]): void {
    // Text that streamed but never got a complete frame (an interrupt cut it
    // off) is kept as what the user saw.
    for (const [itemId, item] of this.open) {
      if (item.text) {
        const event: EventBody =
          item.type === 'assistant.text' ? { type: 'assistant.text', itemId, text: item.text, ...(item.narration ? { narration: true as const } : {}) } : { type: 'reasoning', itemId, text: item.text };
        out.push({ kind: 'event', event });
      }
    }
    this.open.clear();
    this.blockTypes.clear();
    this.afterCompact = false;
    const own = this.turn === 'own';
    const answers = this.turn === 'user' ? this.command : undefined;
    // Which of the runner's messages this turn took: a batch sent close
    // together, plus any folded in while it ran.
    const answered = this.turn === 'user' && Array.isArray(msg.user_message_uuids) ? (msg.user_message_uuids as unknown[]).filter((u): u is string => typeof u === 'string') : undefined;
    if (this.turn === 'user' || (!this.lifecycle && !own)) this.unanswered = Math.max(0, this.unanswered - (answered?.length || 1));
    this.turn = 'none';
    this.command = undefined;
    const aborted = msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools';
    const ok = msg.subtype === 'success' && !msg.is_error;
    const result: TurnResult = {
      outcome: ok ? 'completed' : aborted ? 'interrupted' : 'failed',
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
    };
    if (own) result.own = true;
    if (answers) result.answers = answers;
    if (answered?.length) result.answered = answered;
    if (typeof msg.queued_turn_count === 'number') result.queuedTurns = msg.queued_turn_count;
    if (typeof msg.total_cost_usd === 'number') result.totalCostUsd = msg.total_cost_usd;
    if (msg.usage) {
      result.usage = {
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      };
    }
    if (result.outcome === 'failed') {
      const errors = Array.isArray(msg.errors) ? (msg.errors as string[]).filter((e) => !e.startsWith('[ede_diagnostic]')) : [];
      result.error = (typeof msg.result === 'string' && msg.result) || errors.join('\n') || `Turn ended: ${msg.subtype}`;
      if (this.limitRejected || USAGE_LIMIT_TEXT.test(result.error)) result.errorKind = 'usageLimit';
      else if (this.authFailed || AUTH_TEXT.test(result.error)) result.errorKind = 'auth';
      else if (NETWORK_TEXT.test(result.error)) result.errorKind = 'network';
    }
    this.limitRejected = false;
    this.authFailed = false;
    // Only the result says how big the model's window is (modelUsage), so
    // a client can show how full the context is.
    const window = contextWindowOf(msg.modelUsage, this.model);
    if (window !== undefined && this.contextNow !== undefined) out.push({ kind: 'context', contextTokens: this.contextNow, contextWindow: window });
    out.push({ kind: 'result', result });
  }
}

// What a failed turn says when the login ran out, for CLIs whose
// rate_limit_event didn't come first.
// A login the CLI couldn't use, when the made-up assistant message saying
// so didn't come first: "Failed to authenticate: OAuth session expired and
// could not be refreshed", "Invalid API key · Please run /login".
export const AUTH_TEXT = /failed to authenticate|oauth (session|token) (has )?expired|authentication_error|invalid api key|please run \/login|not logged in/i;

// What a failed turn says when the API couldn't be reached at all, after
// the CLI's own retries: its connection-error messages ("API Error: Can't
// reach the API server — check your internet or DNS (ENOTFOUND)", "No
// internet route", "Connection dropped", "Connection refused", "Unable to
// connect to API", "Request timed out"). An error the API itself sent back
// (a 500, overloaded) isn't one: those are real answers, not a lost line.
export const NETWORK_TEXT = /^API Error: (Can't reach the API server|No internet route|Connection dropped|Connection refused|Unable to connect to API|Connection error|Request timed out)/i;

export const USAGE_LIMIT_TEXT = /hit your (usage )?limit|usage limit reached|rate_limit_error/i;

// Claude's single-window rateLimitType names, as protocol windows.
const RATE_LIMIT_WINDOWS: Record<string, { kind: UsageWindow['kind']; title: string }> = {
  five_hour: { kind: 'five_hour', title: '5-hour' },
  seven_day: { kind: 'weekly', title: 'Weekly' },
  seven_day_opus: { kind: 'weekly_model', title: 'Weekly Opus' },
  seven_day_sonnet: { kind: 'weekly_model', title: 'Weekly Sonnet' },
  // Fable's own week. The CLI calls it the "overage-included" window and
  // names it "Fable limit" (Claude Code 2.1.318); titled as Token Stats
  // titles it, so the two readings merge into one window.
  seven_day_overage_included: { kind: 'weekly_model', title: 'Weekly Fable' },
};

function usageWindow(type: string, utilization: unknown, resetsAt: unknown): UsageWindow | undefined {
  const shape = RATE_LIMIT_WINDOWS[type];
  if (!shape || typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  // utilization is a fraction used; two decimals keeps 1 - 0.62 at 38.
  const left = Math.round(Math.max(0, Math.min(1, 1 - utilization)) * 10_000) / 100;
  const w: UsageWindow = { ...shape, remainingPercent: left };
  if (typeof resetsAt === 'number' && resetsAt > 0) w.resetsAt = new Date(resetsAt * 1000).toISOString();
  return w;
}

// A rate_limit_event's rate_limit_info as a reading. The CLI sends
// unifiedWindows (five_hour, seven_day and, for logins that have it,
// seven_day_overage_included) though sdk.d.ts doesn't list
// it; without it, the documented single rateLimitType and utilization.
export function rateLimitReading(info: AnyMsg | undefined): { windows: UsageWindow[]; blocked: boolean } | undefined {
  if (!info || typeof info !== 'object') return undefined;
  const windows: UsageWindow[] = [];
  const unified = info.unifiedWindows;
  if (unified && typeof unified === 'object') {
    for (const [type, w] of Object.entries(unified as AnyMsg)) {
      const win = w && typeof w === 'object' ? usageWindow(type, (w as AnyMsg).utilization, (w as AnyMsg).resetsAt) : undefined;
      if (win) windows.push(win);
    }
  }
  if (!windows.length && typeof info.rateLimitType === 'string') {
    const win = usageWindow(info.rateLimitType, info.utilization, info.resetsAt);
    if (win) windows.push(win);
  }
  const blocked = info.status === 'rejected';
  if (!windows.length && typeof info.status !== 'string') return undefined;
  return { windows, blocked };
}

// The session model's window from a result's modelUsage, keyed by model
// name. Other models the turn used (a sub-agent, a title) have entries
// too, so it's the session model's entry, matched without a "[1m]"-style
// suffix on either side, or the only entry there is.
function contextWindowOf(modelUsage: unknown, model: string | undefined): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const entries = Object.entries(modelUsage as Record<string, AnyMsg>).filter(([, u]) => typeof u?.contextWindow === 'number' && u.contextWindow > 0);
  const bare = (name: string) => name.replace(/\[.*\]$/, '');
  const own = model ? entries.find(([k]) => k === model) ?? entries.find(([k]) => bare(k) === bare(model)) : undefined;
  if (own) return own[1].contextWindow as number;
  return entries.length === 1 ? (entries[0][1].contextWindow as number) : undefined;
}

function contextTokens(usage: AnyMsg | undefined): number | undefined {
  if (!usage || typeof usage.input_tokens !== 'number') return undefined;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

function truncateText(text: string, itemId: string, ctx: NormalizerContext): { text: string; truncated: boolean; blobPath?: string } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= LIMITS.toolResultText) return { text, truncated: false };
  let blobPath: string | undefined;
  try {
    blobPath = ctx.saveBlob(itemId, text);
  } catch {
    blobPath = undefined;
  }
  const bytesCut = cutUtf8(text, LIMITS.toolResultText);
  const cut = bytesCut.slice(0, safeEnd(text, bytesCut.length));
  return blobPath ? { text: cut, truncated: true, blobPath } : { text: cut, truncated: true };
}

// The first `max` bytes of text, cut back to a character boundary so the
// result never grows past max with a replacement character.
export function cutUtf8(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let end = max;
  // Step back over continuation bytes (10xxxxxx) to the start of the
  // character the cut would split.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

// The file a successful Edit, MultiEdit or Write left and the hash of the
// bytes it wrote, rebuilt from what the result says it did: a Write's
// content, an edit applied to the result's originalFile as the CLI applies
// it. So patch trust takes only what the edit produced, not whatever is in
// the file by the time the runner looks (a command run straight after may
// have changed it). Undefined when it can't be rebuilt (no originalFile,
// text that has moved): then nothing is trusted, and a patch waits for
// Mike as one written any other way does. `base`: an edit's originalFile's
// hash, as the rest of the file is that and not the agent's (F21); null
// for a Write, or an edit of a file that was missing or empty.
export function wroteFromResult(name: string, input: Record<string, unknown>, tur: AnyMsg | undefined): AgentWrite | undefined {
  const file = (typeof tur?.filePath === 'string' && tur.filePath) || (typeof input.file_path === 'string' ? input.file_path : '');
  if (!file) return undefined;
  let after: string | null = null;
  let base: string | null = null;
  if (name === 'Write') {
    after = typeof tur?.content === 'string' ? tur.content : typeof input.content === 'string' ? input.content : null;
  } else {
    let text: string | null = typeof tur?.originalFile === 'string' ? tur.originalFile : tur?.originalFile === null ? '' : null;
    if (text) base = sha256Of(text);
    const edits =
      name === 'MultiEdit'
        ? Array.isArray(input.edits)
          ? (input.edits as AnyMsg[])
          : []
        : [{ old_string: tur?.oldString ?? input.old_string, new_string: tur?.newString ?? input.new_string, replace_all: tur?.replaceAll ?? input.replace_all }];
    if (!edits.length) return undefined;
    for (const e of edits) {
      if (text === null || typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return undefined;
      text = cliReplace(text, e.old_string, e.new_string, Boolean(e.replace_all));
    }
    after = text;
  }
  if (after === null) return undefined;
  return { path: file, sha256: sha256Of(after), base };
}

function sha256Of(text: string): string {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// One edit as Claude Code's Edit applies it: an empty old_string makes a
// new (or empty) file, and deleting text that doesn't end in a newline
// takes the newline after it too.
function cliReplace(content: string, oldString: string, newString: string, replaceAll: boolean): string | null {
  if (oldString === '') return content === '' ? newString : null;
  const search = newString === '' && !oldString.endsWith('\n') && content.includes(oldString + '\n') ? oldString + '\n' : oldString;
  const at = content.indexOf(search);
  if (at < 0) return null;
  if (replaceAll) return content.split(search).join(newString);
  return content.slice(0, at) + newString + content.slice(at + search.length);
}

// jsdiff-style patches mark a missing final newline with a "\ No newline
// at end of file" line. The protocol only has " ", "-" and "+" lines, and
// the marker isn't counted in oldLines/newLines, so it's dropped.
function cleanHunks(hunks: Hunk[]): Hunk[] {
  return hunks.map((h) => ({ ...h, lines: h.lines.filter((l) => typeof l === 'string' && !l.startsWith('\\')) }));
}

// The protocol's name for one of the CLI's task types. The CLI's names
// (its binary lists local_bash, local_agent, remote_agent,
// in_process_teammate, monitor, workflow, local_workflow, dream) aren't a
// contract, so anything new is "other" and the description says what it is.
export function backgroundKind(type: string): BackgroundKind {
  if (type === 'local_bash') return 'shell';
  if (type === 'local_agent' || type === 'remote_agent' || type === 'in_process_teammate') return 'agent';
  if (type === 'monitor') return 'monitor';
  return 'other';
}

function subagentStatus(s: unknown): SubagentStatus | undefined {
  if (s === 'running' || s === 'pending') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'killed' || s === 'stopped') return 'stopped';
  return undefined;
}

function oneLineNote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 199).trimEnd() + '…' : t;
}

function summariseServerResult(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return (content as AnyMsg[])
    .map((r) => [r.title, r.url].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}
