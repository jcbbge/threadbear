// Turns `codex app-server` notifications into protocol events. Pure apart
// from the injected file helpers (NormalizerContext), so it can be tested by
// replaying recorded wire traffic through it, like ClaudeNormalizer.
//
// The adapter (adapter.ts) owns the process, the requests and the server
// requests (approvals.ts). It feeds this every notification for its thread,
// the thread-less ones its process gets, and its subagents' traffic marked
// with `from.childThreadId`; and it says which Codex turn answers which of
// the runner's messages (startingTurn, turnAccepted). See "B. Codex events
// and images" in docs/step4-plan.md.
import path from 'node:path';
import type { EventBody, Hunk, ImageRef, PlanEntry, ToolKind, UsageWindow } from '../../protocol.ts';
import { isEffortLevel } from '../../protocol.ts';
import type { AdapterOutput, BackgroundTask, TurnResult } from '../types.ts';
import { truncateResultText, type NormalizerContext } from '../context.ts';
import { displayPath, toolTitle, truncateInput } from '../../tools.ts';
import type { Logger } from '../../log.ts';
import { isSpace } from '../../linear-text.ts';
import { cutSafely, firstLineSafely } from '../../safe-cut.ts';

type AnyMsg = Record<string, any>;

// Item types this maps to rows, and the ones it skips on purpose. Anything
// else becomes a plain "Codex <type>" row, so a new item type after an
// update shows up instead of vanishing. surface.ts checks these names
// against each new version's generated schema.
export const MAPPED_ITEM_TYPES = [
  'agentMessage',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
  'sleep',
  'plan',
] as const;
export const IGNORED_ITEM_TYPES = ['userMessage', 'hookPrompt', 'functionCallOutput'] as const;

// Notification methods this handles, and the ones it ignores on purpose.
// Any other method is ignored too, logged once at debug level.
export const MAPPED_METHODS = [
  'turn/started',
  'turn/completed',
  'thread/settings/updated',
  'error',
  'warning',
  'configWarning',
  'deprecationNotice',
  'guardianWarning',
  'model/rerouted',
  'mcpServer/startupStatus/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'turn/plan/updated',
  'thread/compacted',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'account/updated',
] as const;
export const IGNORED_METHODS = [
  'hook/started',
  'hook/completed',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/fileChange/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'model/verification',
  'model/safetyBuffering/updated',
  'serverRequest/resolved',
  'thread/started',
  'thread/status/changed',
  'thread/readState/changed',
  'thread/name/updated',
  'thread/deleted',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  // Opted out of at initialize; listed so a capture without the opt-outs
  // still checks clean.
  'turn/diff/updated',
  'turn/moderationMetadata',
  'remoteControl/status/changed',
] as const;

// What the adapter's line reader sends through handle() for a line over its
// size guard: {method?, itemId?} from the start of the skipped line.
export const OVERSIZED_LINE = 'threadbear/oversizedLine';

const MAPPED_ITEMS = new Set<string>(MAPPED_ITEM_TYPES);
const IGNORED_ITEMS = new Set<string>(IGNORED_ITEM_TYPES);
const KNOWN_METHODS = new Set<string>([...MAPPED_METHODS, ...IGNORED_METHODS]);

// A row this has opened with a tool.call and not yet closed.
type OpenTool = {
  itemId: string; // as emitted (child items carry the child's prefix)
  type: string;
  description: string;
  tooLarge?: boolean; // its completion line was over the reader's guard
};

// Streamed text with no completed item yet.
type OpenText = { type: 'assistant.text' | 'reasoning'; text: string; parts: number };

type Totals = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexNormalizerOptions = { log?: Logger };

export class CodexNormalizer {
  private ctx: NormalizerContext;
  private log?: Logger;
  private threadId?: string;
  private model?: string;
  private effort?: string;
  // Our turns: a turn/start that hasn't got its turn id yet (a turn/started
  // in that window is ours), and Codex turn id -> the runner's turn id.
  private pending: { runnerId?: string } | null = null;
  private ours = new Map<string, string | undefined>();
  private clientIds = new Set<string>();
  private turnId?: string; // the Codex turn running now, ours or its own
  private open = new Map<string, OpenTool>();
  private texts = new Map<string, OpenText>();
  // Commands still running after the turn that started them completed
  // (Codex yielded with them going), and subagents likewise.
  private background = new Map<string, OpenTool>();
  private hidden = new Set<string>(); // items with no row (collab `wait`)
  private subagents = new Map<string, string>(); // child thread id -> its row's item id
  private childAnswers = new Map<string, string>(); // child thread id -> its last final answer
  private notes = new Set<string>();
  private failedServers = new Set<string>();
  private retriedThisTurn = false;
  private compactedThisTurn = false;
  private turnError?: string;
  private lastExplanation?: string;
  private total?: Totals;
  private baseline?: Totals;
  private last?: Totals;
  private unknownSkipped = false;
  private interrupted: string[] = [];
  private loggedMethods = new Set<string>();

  constructor(ctx: NormalizerContext, opts: CodexNormalizerOptions = {}) {
    this.ctx = ctx;
    this.log = opts.log;
  }

  // The session's own Codex thread, and the model the adapter reported for
  // it in `session`, so a later settings change of model is reported again.
  setThread(threadId: string, model?: string): void {
    this.threadId = threadId;
    if (model) this.model = model;
  }

  // The adapter sent turn/start for the runner's message `runnerId`.
  startingTurn(runnerId?: string): void {
    this.pending = { runnerId };
    if (runnerId) this.clientIds.add(runnerId);
  }

  // turn/start's reply named the Codex turn.
  turnAccepted(codexTurnId: string): void {
    if (this.ours.has(codexTurnId)) {
      this.pending = null;
      return;
    }
    if (!this.pending) return;
    this.ours.set(codexTurnId, this.pending.runnerId);
    this.pending = null;
  }

  // A message the adapter steered into the running turn (turn/steer), so
  // its userMessage echo isn't logged as someone else's.
  steered(runnerId: string): void {
    this.clientIds.add(runnerId);
  }

  // The command rows an interrupted or failed turn closed, so the adapter
  // can stop the processes behind them (turn/interrupt leaves them running).
  interruptedCommands(): string[] {
    return [...this.interrupted];
  }

  // The adapter's line reader skipped a line over its size guard. `head` is
  // the start of it. If it was an item's completion, that item is closed as
  // "Too large to show" when the turn ends instead of as interrupted.
  lineTooLarge(head: string): void {
    const method = /"method"\s*:\s*"([^"]+)"/.exec(head)?.[1];
    const at = head.indexOf('"item"');
    const id = at >= 0 ? /"id"\s*:\s*"([^"]+)"/.exec(head.slice(at))?.[1] : undefined;
    this.tooLarge(method, id);
  }

  private tooLarge(method: string | undefined, id: string | undefined): void {
    if (method && method !== 'item/completed') return;
    const item = id ? [...this.open.values()].find((o) => o.itemId === id || o.itemId.endsWith(`/${id}`)) : undefined;
    if (item) item.tooLarge = true;
    else this.unknownSkipped = true;
  }

  // Closes every row still open, background ones included: the session is
  // ending without Codex closing them (the process died, or a hard stop).
  closeOpen(reason: string): AdapterOutput[] {
    const out: AdapterOutput[] = [];
    this.flushTexts(out);
    const hadBackground = this.background.size > 0;
    for (const item of [...this.open.values(), ...this.background.values()]) {
      out.push(result(item.itemId, false, item.tooLarge ? 'Too large to show' : reason));
    }
    this.open.clear();
    this.background.clear();
    if (hadBackground) out.push({ kind: 'tasks', tasks: [] });
    this.turnId = undefined;
    return out;
  }

  handle(method: string, params: AnyMsg | null | undefined, from?: { childThreadId: string }): AdapterOutput[] {
    const out: AdapterOutput[] = [];
    const p = params ?? {};
    if (method === OVERSIZED_LINE) {
      // The same as lineTooLarge, from a reader that has already picked the
      // method and item id out of the skipped line's start.
      const id = typeof p.itemId === 'string' ? (from?.childThreadId ? `${from.childThreadId}/${p.itemId}` : p.itemId) : undefined;
      this.tooLarge(typeof p.method === 'string' ? p.method : undefined, id);
      return out;
    }
    if (from?.childThreadId) {
      this.child(method, p, from.childThreadId, out);
      return out;
    }
    switch (method) {
      case 'turn/started':
        this.turnStarted(p, out);
        break;
      case 'turn/completed':
        this.turnCompleted(p, out);
        break;
      case 'thread/settings/updated':
        this.settings(p.threadSettings ?? {}, typeof p.threadId === 'string' ? p.threadId : undefined, out);
        break;
      case 'error':
        if (p.willRetry) {
          if (!this.retriedThisTurn) {
            this.retriedThisTurn = true;
            this.note(out, `Retrying: ${errorText(p.error?.message) || 'the request failed'}`, false);
          }
        } else if (p.error?.message) this.turnError = errorText(p.error.message);
        break;
      case 'warning':
      case 'guardianWarning':
        if (typeof p.message === 'string') this.note(out, p.message);
        break;
      case 'configWarning':
      case 'deprecationNotice':
        if (typeof p.summary === 'string') this.note(out, p.details ? `${p.summary} ${p.details}` : p.summary);
        break;
      case 'model/rerouted':
        this.note(out, `Codex switched this turn from ${p.fromModel} to ${p.toModel}${p.reason ? ` (${p.reason})` : ''}`);
        break;
      case 'mcpServer/startupStatus/updated':
        if (p.status === 'failed' && typeof p.name === 'string' && !this.failedServers.has(p.name)) {
          this.failedServers.add(p.name);
          const why = mcpStartError(p.name, p.error);
          out.push(noteOut(`MCP server ${p.name} didn't start${why ? `: ${why}` : ''}`));
        }
        break;
      case 'item/started':
        if (p.item) this.itemStarted(p.item, out, '');
        break;
      case 'item/completed':
        if (p.item) this.itemCompleted(p.item, out, '');
        break;
      case 'item/agentMessage/delta':
        this.delta(out, 'assistant.text', String(p.itemId), p.delta);
        break;
      case 'item/reasoning/summaryTextDelta':
        this.delta(out, 'reasoning', String(p.itemId), p.delta);
        break;
      case 'item/reasoning/summaryPartAdded': {
        // Index 0's arrives just before the first delta; later parts are
        // separated by a blank line, as the completed item joins them.
        const t = this.texts.get(String(p.itemId));
        if (typeof p.summaryIndex === 'number' && p.summaryIndex > 0 && t?.text) this.delta(out, 'reasoning', String(p.itemId), '\n\n');
        break;
      }
      case 'item/commandExecution/outputDelta':
        if (typeof p.delta === 'string' && p.delta) out.push({ kind: 'delta', delta: { type: 'tool.output.delta', itemId: String(p.itemId), text: p.delta } });
        break;
      case 'item/mcpToolCall/progress':
        if (typeof p.message === 'string' && p.message) out.push({ kind: 'delta', delta: { type: 'tool.output.delta', itemId: String(p.itemId), text: p.message + '\n' } });
        break;
      case 'item/fileChange/patchUpdated':
        if (Array.isArray(p.changes)) out.push(...diffEvents(String(p.itemId), p.changes));
        break;
      case 'turn/plan/updated':
        this.plan(p, out);
        break;
      case 'thread/compacted':
        this.compacted(out);
        break;
      case 'thread/tokenUsage/updated':
        this.tokens(p.tokenUsage, out);
        break;
      case 'account/rateLimits/updated': {
        const l = limitsFromRateLimits(p);
        if (l) out.push(l);
        break;
      }
      case 'account/updated': {
        const plan = planTitle(p.planType);
        if (plan) out.push({ kind: 'limits', windows: [], plan });
        break;
      }
      default:
        if (!KNOWN_METHODS.has(method) && !this.loggedMethods.has(method)) {
          this.loggedMethods.add(method);
          this.log?.debug('codex: ignored notification', { method });
        }
        break;
    }
    return out;
  }

  // A subagent's traffic. Its images go into the parent thread, and its
  // last final answer becomes its row's result; the rest is dropped (its
  // turns aren't the parent's, and its tokens aren't the parent's context).
  private child(method: string, p: AnyMsg, childId: string, out: AdapterOutput[]): void {
    const item = p.item as AnyMsg | undefined;
    if (!item || (method !== 'item/started' && method !== 'item/completed')) return;
    if (item.type === 'imageGeneration' || item.type === 'imageView') {
      if (method === 'item/started') this.itemStarted(item, out, `${childId}/`);
      else this.itemCompleted(item, out, `${childId}/`);
    } else if (method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string') {
      this.childAnswers.set(childId, item.text);
    }
  }

  private turnStarted(p: AnyMsg, out: AdapterOutput[]): void {
    const id = typeof p.turn?.id === 'string' ? p.turn.id : undefined;
    if (!id) return;
    if (!this.ours.has(id)) {
      if (this.pending) {
        this.ours.set(id, this.pending.runnerId);
        this.pending = null;
      } else out.push({ kind: 'cliTurn' });
    }
    this.turnId = id;
    this.baseline = this.total;
    this.retriedThisTurn = false;
    this.compactedThisTurn = false;
    this.turnError = undefined;
    this.unknownSkipped = false;
  }

  private turnCompleted(p: AnyMsg, out: AdapterOutput[]): void {
    const turn = (p.turn ?? {}) as AnyMsg;
    const status = String(turn.status ?? 'completed');
    this.flushTexts(out);
    this.interrupted = [];
    // With the turn completed, an open command is a background terminal:
    // Codex yielded while it runs on, and sends its output and completion
    // later. Anything else open, or anything at all after an interrupt or
    // a failure, is closed here.
    let tasksChanged = false;
    for (const item of this.open.values()) {
      if (status === 'completed' && (item.type === 'commandExecution' || item.type === 'subAgentActivity') && !item.tooLarge) {
        this.background.set(item.itemId, item);
        tasksChanged = true;
        continue;
      }
      if (item.type === 'commandExecution') this.interrupted.push(item.itemId);
      const text = item.tooLarge || (this.unknownSkipped && item.type !== 'commandExecution') ? 'Too large to show' : 'Interrupted';
      out.push(result(item.itemId, false, text));
    }
    this.open.clear();
    if (tasksChanged) out.push(this.tasks());

    const id = typeof turn.id === 'string' ? turn.id : this.turnId;
    const own = !id || !this.ours.has(id);
    const r: TurnResult = {
      outcome: status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed',
      durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : 0,
    };
    if (own) r.own = true;
    else {
      const runnerId = this.ours.get(id!);
      if (runnerId) r.answers = runnerId;
      this.ours.delete(id!);
    }
    const usage = this.turnUsage();
    if (usage) r.usage = usage;
    if (r.outcome === 'failed') {
      r.error = errorText(turn.error?.message) || this.turnError || 'The turn failed.';
      const kind = errorKind(turn.error?.codexErrorInfo);
      if (kind) r.errorKind = kind;
    }
    out.push({ kind: 'result', result: r });
    if (id === this.turnId) this.turnId = undefined;
    this.baseline = this.total;
  }

  private turnUsage(): Record<string, unknown> | undefined {
    if (!this.total) return undefined;
    const base = this.baseline;
    // A total that went down (a compaction, a restored thread) can't give a
    // difference; the last request alone is the best there is.
    const d = base && this.total.totalTokens >= base.totalTokens ? diffTotals(this.total, base) : base ? this.last : this.total;
    if (!d || d.totalTokens === 0) return undefined;
    return {
      inputTokens: d.inputTokens,
      cachedInputTokens: d.cachedInputTokens,
      cacheWriteTokens: d.cacheWriteInputTokens,
      outputTokens: d.outputTokens,
      reasoningTokens: d.reasoningOutputTokens,
    };
  }

  private settings(s: AnyMsg, threadId: string | undefined, out: AdapterOutput[]): void {
    if (isEffortLevel(s.effort) && s.effort !== this.effort) {
      this.effort = s.effort;
      out.push({ kind: 'effort', level: s.effort });
    }
    const nativeSessionId = this.threadId ?? threadId;
    if (typeof s.model === 'string' && s.model && s.model !== this.model && nativeSessionId) {
      this.model = s.model;
      out.push({ kind: 'session', nativeSessionId, model: s.model });
    }
  }

  private tokens(u: AnyMsg | undefined, out: AdapterOutput[]): void {
    const total = totals(u?.total);
    const last = totals(u?.last);
    if (total) this.total = total;
    if (last) this.last = last;
    if (last) {
      const o: AdapterOutput = { kind: 'context', contextTokens: last.totalTokens };
      if (typeof u?.modelContextWindow === 'number') o.contextWindow = u.modelContextWindow;
      out.push(o);
    }
  }

  private plan(p: AnyMsg, out: AdapterOutput[]): void {
    if (!Array.isArray(p.plan)) return;
    const entries: PlanEntry[] = (p.plan as AnyMsg[])
      .filter((s) => typeof s.step === 'string')
      .map((s) => ({ text: s.step, status: s.status === 'completed' ? 'completed' : s.status === 'inProgress' ? 'in_progress' : 'pending' }));
    out.push(ev({ type: 'plan.updated', entries }));
    const expl = typeof p.explanation === 'string' ? p.explanation.trim() : '';
    if (expl && expl !== this.lastExplanation) {
      this.lastExplanation = expl;
      out.push(noteOut(expl));
    }
  }

  private compacted(out: AdapterOutput[]): void {
    if (this.compactedThisTurn) return;
    this.compactedThisTurn = true;
    out.push(noteOut('Compacted the conversation'));
  }

  private delta(out: AdapterOutput[], type: OpenText['type'], itemId: string, text: unknown): void {
    if (typeof text !== 'string' || !text) return;
    const t = this.texts.get(itemId) ?? { type, text: '', parts: 0 };
    t.text += text;
    this.texts.set(itemId, t);
    out.push({ kind: 'delta', delta: { type: type === 'assistant.text' ? 'assistant.text.delta' : 'reasoning.delta', itemId, text } });
  }

  // Streamed text whose item never completed (an interrupt) stays as what
  // was shown.
  private flushTexts(out: AdapterOutput[]): void {
    for (const [itemId, t] of this.texts) {
      if (!t.text.trim()) continue;
      out.push(ev(t.type === 'assistant.text' ? { type: 'assistant.text', itemId, text: t.text } : { type: 'reasoning', itemId, text: t.text }));
    }
    this.texts.clear();
  }

  private itemStarted(item: AnyMsg, out: AdapterOutput[], prefix: string): void {
    const type = String(item.type ?? '');
    const id = prefix + String(item.id ?? '');
    if (this.open.has(id) || this.background.has(id)) return;
    const call = (name: string, kind: ToolKind, title: string, input: Record<string, unknown>, description = title) => {
      this.open.set(id, { itemId: id, type, description });
      out.push(ev({ type: 'tool.call', itemId: id, name, kind, title, input: truncateInput(input) }));
    };
    switch (type) {
      case 'agentMessage':
      case 'reasoning':
        // Text comes through deltas and the completed item. Reasoning shows
        // nothing until it has words: an item can start seconds before its
        // first delta, and complete with an empty summary.
        break;
      case 'commandExecution': {
        const command = innerCommand(String(item.command ?? ''));
        call('shell', commandKind(item.commandActions), firstLine(command) || 'Run a command', { command, cwd: item.cwd }, command);
        break;
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? (item.changes as AnyMsg[]) : [];
        const paths = changes.map((c) => String(c.path ?? ''));
        const kind: ToolKind = changes.length > 0 && changes.every((c) => c.kind?.type === 'add') ? 'write' : 'edit';
        call('apply_patch', kind, this.patchTitle(changes), { paths });
        out.push(...diffEvents(id, changes));
        break;
      }
      case 'mcpToolCall': {
        const name = `mcp__${item.server}__${item.tool}`;
        const input = objectInput(item.arguments);
        call(name, 'mcp', toolTitle(name, input, this.ctx.cwd), input);
        break;
      }
      case 'dynamicToolCall': {
        const name = item.namespace ? `mcp__${item.namespace}__${item.tool}` : String(item.tool ?? 'tool');
        const input = objectInput(item.arguments);
        call(name, item.namespace ? 'mcp' : 'other', toolTitle(name, input, this.ctx.cwd), input);
        break;
      }
      case 'webSearch': {
        const url = item.action?.url;
        const query = item.query || item.action?.query || (Array.isArray(item.action?.queries) ? item.action.queries.join(', ') : '');
        const title = query ? `Search the web for ${firstLine(query, 80)}` : url ? `Open ${url}` : 'Search the web';
        call('web_search', 'web', title, { query: query || undefined, url: url || undefined });
        break;
      }
      case 'imageGeneration':
        // The prompt isn't known yet (revisedPrompt is null and result
        // empty at the start), and never put `result` anywhere.
        call('image_generation', 'image', 'Generate image', {});
        break;
      case 'imageView': {
        const p = stripFileUrl(String(item.path ?? ''));
        call('view_image', 'read', `View ${displayPath(p, this.ctx.cwd)}`, { path: p });
        break;
      }
      case 'subAgentActivity':
        this.subAgent(item, out, id);
        break;
      case 'collabAgentToolCall': {
        if (item.tool === 'wait') {
          this.hidden.add(id);
          break;
        }
        const prompt = typeof item.prompt === 'string' ? item.prompt : '';
        call(`codex_${item.tool}`, 'task', firstLine(prompt) || `Codex ${item.tool}`, { tool: item.tool, prompt: prompt || undefined, model: item.model ?? undefined });
        break;
      }
      case 'sleep':
        call('sleep', 'other', 'Wait', typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {});
        break;
      case 'contextCompaction':
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        break;
      default:
        if (IGNORED_ITEMS.has(type)) {
          this.ignoredItem(item);
          break;
        }
        if (!MAPPED_ITEMS.has(type)) call(`codex_${type}`, 'other', `Codex ${type}`, {});
        break;
    }
  }

  private itemCompleted(item: AnyMsg, out: AdapterOutput[], prefix: string): void {
    const type = String(item.type ?? '');
    const id = prefix + String(item.id ?? '');
    switch (type) {
      case 'agentMessage': {
        this.texts.delete(id);
        const text = typeof item.text === 'string' ? stripLeakedToolCall(item.text) : '';
        if (text) out.push(ev({ type: 'assistant.text', itemId: id, text }));
        return;
      }
      case 'reasoning': {
        this.texts.delete(id);
        const parts = Array.isArray(item.summary) ? (item.summary as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
        if (parts.length) out.push(ev({ type: 'reasoning', itemId: id, text: parts.join('\n\n') }));
        return;
      }
      case 'contextCompaction':
        this.compacted(out);
        return;
      // Plan mode's proposed plan ("Plan first"), a card for Mike to approve.
      // A subagent's plan isn't his to approve.
      case 'plan': {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text && !prefix) out.push({ kind: 'planProposed', itemId: id, text });
        return;
      }
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        if (!this.hidden.has(id)) {
          this.hidden.add(id);
          out.push(noteOut(type === 'enteredReviewMode' ? 'Review started' : 'Review finished'));
        }
        return;
      case 'subAgentActivity':
        this.subAgent(item, out, id);
        return;
      default:
        break;
    }
    if (IGNORED_ITEMS.has(type)) return;
    if (this.hidden.has(id)) {
      this.hidden.delete(id);
      return;
    }
    // A completion with no start seen (it came before we attached, or the
    // start line was too large): open the row now so the result has one.
    if (!this.open.has(id) && !this.background.has(id)) {
      this.itemStarted(item, out, prefix);
      if (this.hidden.delete(id)) return;
    }
    const wasBackground = this.background.delete(id);
    this.open.delete(id);
    // No 'wrote' for a patch, applied or not: its result doesn't say what
    // bytes it wrote, and hashing the file when the result arrives trusted
    // whatever a command had put there first (Codex review, 5 Nov). A patch
    // file Codex writes waits for Mike (docs/protocol.md).
    out.push(this.completedResult(type, id, item));
    if (wasBackground) out.push(this.tasks());
  }

  private completedResult(type: string, id: string, item: AnyMsg): AdapterOutput {
    switch (type) {
      case 'commandExecution': {
        if (item.status === 'declined') return result(id, false, 'Declined');
        const ok = item.status === 'completed' && item.exitCode === 0;
        return { kind: 'event', event: { type: 'tool.result', itemId: id, ok, ...truncateResultText(String(item.aggregatedOutput ?? ''), id, this.ctx), images: [] } };
      }
      case 'fileChange':
        if (item.status === 'declined') return result(id, false, 'Declined');
        return result(id, item.status === 'completed', item.status === 'completed' ? '' : 'The edit failed');
      case 'mcpToolCall':
        return this.mcpResult(id, item);
      case 'dynamicToolCall':
        return this.dynamicResult(id, item);
      case 'imageGeneration':
        return this.generatedImage(id, item);
      case 'imageView': {
        const p = stripFileUrl(String(item.path ?? ''));
        const ref = this.ctx.copyImage?.(p, 'view') ?? null;
        return ref ? { kind: 'event', event: { type: 'tool.result', itemId: id, ok: true, text: '', truncated: false, images: [ref] } } : result(id, false, `Couldn't read ${displayPath(p, this.ctx.cwd)}`);
      }
      case 'webSearch':
        return result(id, true, webResults(item.results));
      case 'collabAgentToolCall':
        return result(id, item.status === 'completed', item.status === 'completed' ? '' : String(item.status ?? ''));
      case 'sleep':
        return result(id, true, '');
      default:
        return result(id, item.status === undefined || item.status === 'completed', joinedText(item));
    }
  }

  private mcpResult(id: string, item: AnyMsg): AdapterOutput {
    if (item.error?.message) return result(id, false, String(item.error.message));
    const texts: string[] = [];
    const images: ImageRef[] = [];
    const hint = `${item.server}.${item.tool}`;
    for (const c of (Array.isArray(item.result?.content) ? item.result.content : []) as AnyMsg[]) {
      if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
      else if (c?.type === 'image' && typeof c.data === 'string') this.saveB64(c.data, c.mimeType, hint, images, texts);
      else if (c?.type === 'resource' && c.resource) {
        const r = c.resource as AnyMsg;
        if (typeof r.blob === 'string' && String(r.mimeType ?? '').startsWith('image/')) this.saveB64(r.blob, r.mimeType, hint, images, texts);
        else if (typeof r.text === 'string') texts.push(r.text);
        else if (r.uri) texts.push(String(r.uri));
      } else if (c?.type === 'resource_link' && c.uri) texts.push(String(c.uri));
    }
    const ok = item.status === 'completed' && item.result?.isError !== true;
    return { kind: 'event', event: { type: 'tool.result', itemId: id, ok, ...truncateResultText(texts.join('\n'), id, this.ctx), images } };
  }

  private dynamicResult(id: string, item: AnyMsg): AdapterOutput {
    const texts: string[] = [];
    const images: ImageRef[] = [];
    const hint = item.namespace ? `${item.namespace}.${item.tool}` : String(item.tool ?? 'tool');
    for (const c of (Array.isArray(item.contentItems) ? item.contentItems : []) as AnyMsg[]) {
      if (c?.type === 'inputText' && typeof c.text === 'string') texts.push(c.text);
      else if (c?.type === 'inputImage' && typeof c.imageUrl === 'string') {
        const url = c.imageUrl as string;
        if (/^https?:/i.test(url)) texts.push(url);
        else {
          const ref = url.startsWith('data:') ? (this.ctx.saveDataUrl?.(url, hint) ?? null) : this.ctx.copyImage?.(url, hint) ?? null;
          if (ref) images.push(ref);
          else texts.push('[image could not be saved]');
        }
      }
    }
    const ok = item.success === true || (item.success == null && item.status === 'completed');
    return { kind: 'event', event: { type: 'tool.result', itemId: id, ok, ...truncateResultText(texts.join('\n'), id, this.ctx), images } };
  }

  // Codex has already saved the picture (savedPath); the base64 `result`
  // holds the same bytes and is only the fallback. Neither ever goes into an
  // event or a log line.
  private generatedImage(id: string, item: AnyMsg): AdapterOutput {
    if (item.failure || item.status !== 'completed') {
      const f = item.failure as AnyMsg | null | undefined;
      if (f?.type === 'usageLimitExceeded') {
        const when = typeof f.resetsAt === 'number' ? resetTime(f.resetsAt) : '';
        return result(id, false, `Image generation limit reached${when ? `, resets ${when}` : ''}`);
      }
      return result(id, false, `Image generation ${f?.type ?? item.status ?? 'failed'}`);
    }
    let ref: ImageRef | null = null;
    if (typeof item.savedPath === 'string' && item.savedPath) ref = this.ctx.copyImage?.(item.savedPath, 'generated') ?? null;
    if (!ref && typeof item.result === 'string' && item.result) {
      try {
        ref = this.ctx.saveImage(item.result, 'image/png', 'generated');
      } catch {
        ref = null;
      }
    }
    let text = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : '';
    if (Array.isArray(item.inputImages) && item.inputImages.length) {
      const names = (item.inputImages as AnyMsg[]).map((i) => path.basename(String(i.path ?? ''))).filter(Boolean);
      if (names.length) text = `${text}${text ? '\n' : ''}Edited from ${names.join(', ')}`;
    }
    if (!ref) {
      if (typeof item.fileId === 'string' && item.fileId) return result(id, true, `${text}${text ? '\n' : ''}The image is stored remotely (${item.fileId})`);
      return result(id, false, "The image couldn't be saved");
    }
    return { kind: 'event', event: { type: 'tool.result', itemId: id, ok: true, text, truncated: false, images: [ref] } };
  }

  private saveB64(data: string, mimeType: unknown, hint: string, images: ImageRef[], texts: string[]): void {
    try {
      images.push(this.ctx.saveImage(data, typeof mimeType === 'string' ? mimeType : 'image/png', hint));
    } catch {
      texts.push('[image could not be saved]');
    }
  }

  // The only spawn signal in 0.164.0 is the parent's subAgentActivity item
  // (`started`, with the child's thread id and path); a `completed` one,
  // with a different item id, ends the row.
  private subAgent(item: AnyMsg, out: AdapterOutput[], id: string): void {
    const child = String(item.agentThreadId ?? '');
    if (item.kind === 'started') {
      if (this.subagents.has(child)) return;
      this.subagents.set(child, id);
      const name = String(item.agentPath ?? '').split('/').filter(Boolean).pop() || 'subagent';
      this.open.set(id, { itemId: id, type: 'subAgentActivity', description: name });
      out.push(ev({ type: 'tool.call', itemId: id, name: 'spawn_agent', kind: 'task', title: name, input: truncateInput({ agentPath: item.agentPath, model: item.model ?? undefined, reasoningEffort: item.reasoningEffort ?? undefined }) }));
    } else if (item.kind === 'completed' || item.kind === 'interrupted') {
      const row = this.subagents.get(child);
      if (!row) return;
      this.subagents.delete(child);
      const wasBackground = this.background.delete(row);
      this.open.delete(row);
      const ok = item.kind === 'completed';
      out.push(result(row, ok, ok ? (this.childAnswers.get(child) ?? 'Finished') : 'Interrupted'));
      this.childAnswers.delete(child);
      if (wasBackground) out.push(this.tasks());
    }
  }

  private ignoredItem(item: AnyMsg): void {
    if (item.type === 'userMessage' && item.clientId !== null && item.clientId !== undefined && !this.clientIds.has(String(item.clientId))) {
      this.log?.info('codex: a message this runner did not send', { clientId: String(item.clientId) });
    }
  }

  private patchTitle(changes: AnyMsg[]): string {
    if (changes.length === 1) {
      const c = changes[0];
      const p = displayPath(String(c.path ?? ''), this.ctx.cwd);
      if (c.kind?.type === 'update' && c.kind.move_path) return `Rename ${p} to ${displayPath(String(c.kind.move_path), this.ctx.cwd)}`;
      return `Edit ${p}`;
    }
    return `Edit ${changes.length} files`;
  }

  private tasks(): AdapterOutput {
    const tasks: BackgroundTask[] = [...this.background.values()].map((b) =>
      b.type === 'subAgentActivity' ? { id: b.itemId, type: 'subagent', kind: 'agent', description: b.description } : { id: b.itemId, type: 'shell', kind: 'shell', description: b.description },
    );
    return { kind: 'tasks', tasks };
  }

  private note(out: AdapterOutput[], text: string, once = true): void {
    const t = text.trim();
    if (!t) return;
    if (once) {
      if (this.notes.has(t)) return;
      this.notes.add(t);
    }
    out.push(noteOut(t));
  }
}

// Rate limits, from `account/rateLimits/read`'s result or a (merged)
// `account/rateLimits/updated`: the `codex` bucket's windows, then any other
// bucket as extra windows that never reach the chip.
export function limitsFromRateLimits(snapshot: AnyMsg | null | undefined): Extract<AdapterOutput, { kind: 'limits' }> | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const main = (snapshot.rateLimits ?? snapshot.rateLimitsByLimitId?.codex) as AnyMsg | undefined;
  if (!main) return null;
  const windows: UsageWindow[] = [];
  for (const w of [main.primary, main.secondary]) {
    if (!w || typeof w.usedPercent !== 'number') continue;
    const kind = w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'weekly' : 'other';
    windows.push(usageWindow(kind, kind === 'five_hour' ? '5-hour' : kind === 'weekly' ? 'Weekly' : durationTitle(w.windowDurationMins), w));
  }
  const credits = creditsDetail(main.credits);
  if (credits && windows.length) windows[windows.length - 1].detail = credits;
  const byId = (snapshot.rateLimitsByLimitId ?? {}) as Record<string, AnyMsg>;
  for (const [limitId, bucket] of Object.entries(byId)) {
    if (limitId === (main.limitId ?? 'codex') || !bucket) continue;
    const name = String(bucket.limitName || bucket.normalModelSlug || limitId);
    const ws = [bucket.primary, bucket.secondary].filter((w) => w && typeof w.usedPercent === 'number');
    for (const w of ws) {
      const suffix = ws.length > 1 ? ` ${w.windowDurationMins === 300 ? '5-hour' : w.windowDurationMins === 10080 ? 'weekly' : durationTitle(w.windowDurationMins).toLowerCase()}` : '';
      windows.push(usageWindow('other', name + suffix, w));
    }
  }
  const out: Extract<AdapterOutput, { kind: 'limits' }> = { kind: 'limits', windows };
  // Always true or false, never left out: the usage store only lifts a block
  // when a reading says false.
  out.blocked = snapshot.ordinaryUsageAllowed === false || Boolean(main.rateLimitReachedType);
  const plan = planTitle(main.planType);
  if (plan) out.plan = plan;
  return out;
}

// `account/read`'s result: the login's email and plan.
export function limitsFromAccount(result: AnyMsg | null | undefined): Extract<AdapterOutput, { kind: 'limits' }> | null {
  const a = result?.account as AnyMsg | undefined;
  if (!a) return null;
  const out: Extract<AdapterOutput, { kind: 'limits' }> = { kind: 'limits', windows: [] };
  if (typeof a.email === 'string' && a.email.includes('@')) out.email = a.email;
  const plan = planTitle(a.planType);
  if (plan) out.plan = plan;
  return out.email || out.plan ? out : null;
}

// "prolite" -> "Pro Lite".
export function planTitle(plan: unknown): string | undefined {
  if (typeof plan !== 'string' || !plan) return undefined;
  const known: Record<string, string> = { prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', free: 'Free', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', go: 'Go' };
  return known[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

// The command inside Codex's `/bin/zsh -lc '...'` wrapper, as the user
// would have typed it. Anything else comes back as it was.
//
// The model writes the command, so this takes time in proportion to it: a
// lazy `([\s\S]+?)\s*$` here tried `\s*$` again from every space of a long
// run, and `printf '%s' '<300k spaces>x'` held the runner for minutes
// (Gautam's scan, F27). The shell is the first word ("zsh", "/bin/bash");
// the argument is the rest after "-c" or "-lc", without its trailing
// whitespace.
export function innerCommand(command: string): string {
  const m = /^\s*(\S+)\s+-l?c\s+/.exec(command);
  if (!m || !/^(?:.*\/)?(?:ba|z)?sh$/.test(m[1])) return command;
  // Nothing after the -c but whitespace: the old pattern took one space of
  // it as the argument, which isn't a command either.
  const arg = command.slice(m[0].length).trimEnd();
  if (!arg) return command;
  if (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) {
    // zsh quotes a single quote inside one as '\''.
    const body = arg.slice(1, -1);
    if (!body.replace(/'\\''/g, '').includes("'")) return body.replace(/'\\''/g, "'");
    return command;
  }
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) return arg.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return /\s/.test(arg) ? command : arg;
}

// A unified diff's hunks. Codex sends update diffs as hunks only
// ("@@ -1 +1 @@\n-x\n+y\n").
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      cur = { oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]), lines: [] };
      hunks.push(cur);
    } else if (cur && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) cur.lines.push(line);
  }
  return hunks;
}

function diffEvents(itemId: string, changes: AnyMsg[]): AdapterOutput[] {
  const out: AdapterOutput[] = [];
  for (const c of changes) {
    const p = String(c?.path ?? '');
    if (!p) continue;
    const diff = typeof c.diff === 'string' ? c.diff : '';
    let hunks: Hunk[];
    if (c.kind?.type === 'add' || c.kind?.type === 'delete') {
      // An add's diff is the new file's text, a delete's the old one's.
      const lines = splitText(diff);
      const sign = c.kind.type === 'add' ? '+' : '-';
      hunks = lines.length
        ? [{ oldStart: c.kind.type === 'add' ? 0 : 1, oldLines: c.kind.type === 'add' ? 0 : lines.length, newStart: c.kind.type === 'add' ? 1 : 0, newLines: c.kind.type === 'add' ? lines.length : 0, lines: lines.map((l) => sign + l) }]
        : [];
    } else hunks = parseHunks(diff);
    out.push(ev({ type: 'edit.diff', itemId, path: p, hunks }));
  }
  return out;
}

// A tool call the model wrote into its message instead of making it, from
// its first routing token (` to=functions.exec`, with whatever word it
// glued on in front) to the end: GPT-6.1-Sol put its end_turn call, a made-up
// result and stray tokens in other scripts in a final answer, and Mike read
// them all (28 Oct 2026). Never in backticks, so a message about such a
// token keeps it.
//
// The token counts at the start of a line, or after spaces (not a line
// break) with the word before them, which can't hold a backtick or a
// space. That was one regex, `(?:[^\S\n]*[^\s`]*[^\S\n]+|^)to=...`, whose
// overlapping runs of spaces made it cubic in a run of spaces: a model
// told to end its answer with 10,000 of them held the runner's event loop
// for good (Gautam's scan, F24). Now the token is found first and the
// word before it read backwards, once.
const ROUTING_TOKEN = /to=(?:functions|multi_tool_use|tools)\.\w/g;
const isRunSpace = (c: string | undefined) => c !== '\n' && isSpace(c);

export function stripLeakedToolCall(text: string): string {
  for (const m of text.matchAll(ROUTING_TOKEN)) {
    const at = m.index;
    if (at === 0 || text[at - 1] === '\n') return text.slice(0, at).trimEnd();
    if (!isRunSpace(text[at - 1])) continue;
    // The spaces, the word before them and any spaces before that: all of
    // it goes, and trimEnd takes the spaces anyway.
    let start = at - 1;
    while (start > 0 && isRunSpace(text[start - 1])) start--;
    while (start > 0 && text[start - 1] !== '`' && !isSpace(text[start - 1])) start--;
    return text.slice(0, start).trimEnd();
  }
  return text;
}

function splitText(s: string): string[] {
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function commandKind(actions: unknown): ToolKind {
  if (!Array.isArray(actions) || actions.length === 0) return 'command';
  const types = (actions as AnyMsg[]).map((a) => a?.type);
  if (types.every((t) => t === 'read')) return 'read';
  if (types.every((t) => t === 'search' || t === 'listFiles')) return 'search';
  return 'command';
}

function objectInput(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return v === undefined || v === null ? {} : { value: v };
}

function stripFileUrl(p: string): string {
  if (!p.startsWith('file://')) return p;
  try {
    return decodeURIComponent(p.slice('file://'.length));
  } catch {
    return p.slice('file://'.length);
  }
}

function webResults(results: unknown): string {
  if (!Array.isArray(results)) return '';
  return (results as AnyMsg[])
    .map((r) => (r && typeof r === 'object' ? [r.title, r.url].filter((x) => typeof x === 'string' && x).join(' ') : ''))
    .filter(Boolean)
    .join('\n');
}

// The text fields of an item this doesn't know, for its plain row.
function joinedText(item: AnyMsg): string {
  return Object.entries(item)
    .filter(([k, v]) => k !== 'id' && k !== 'type' && k !== 'status' && typeof v === 'string' && v)
    .map(([, v]) => v as string)
    .join('\n');
}

// Codex passes API errors through as raw JSON
// ({"type":"error","status":400,"error":{"message":...}}): the inner
// message is the sentence worth showing.
function errorText(message: unknown): string {
  if (typeof message !== 'string') return '';
  const at = message.indexOf('{');
  if (at >= 0) {
    try {
      const j = JSON.parse(message.slice(at));
      const inner = j?.error?.message ?? j?.message;
      if (typeof inner === 'string' && inner) return (at > 0 ? message.slice(0, at).trim() + ' ' : '') + inner;
    } catch {
      // Not JSON after all; show it as it came.
    }
  }
  return message;
}

function errorKind(info: unknown): TurnResult['errorKind'] {
  const name = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  if (name === 'usageLimitExceeded' || name === 'rateLimitExceeded') return 'usageLimit';
  if (name === 'contextWindowExceeded') return 'contextWindow';
  if (name === 'unauthorized') return 'auth';
  // The connection failed or dropped without the server answering; one
  // with an httpStatusCode got an answer, so it isn't the network's fault.
  if (name === 'httpConnectionFailed' || name === 'responseStreamConnectionFailed' || name === 'responseStreamDisconnected') {
    const detail = info && typeof info === 'object' ? (info as Record<string, unknown>)[name] : undefined;
    const status = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).httpStatusCode : undefined;
    return typeof status === 'number' ? undefined : 'network';
  }
  return undefined;
}

// "MCP client for `paper` failed to start: MCP startup failed: handshaking
// with MCP server failed: Send message error Transport [codex_rmcp_client..."
// is a Rust error chain; its first clause or two say enough.
function mcpStartError(name: string, error: unknown): string {
  if (typeof error !== 'string') return '';
  let s = error.replace(new RegExp(`^MCP client for \`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\` failed to start:\\s*`), '');
  const clauses = s.split(/:\s+/).filter((c) => c && !/^(Send message error|Transport \[|\[)/.test(c));
  s = clauses.slice(0, 2).join(': ');
  return cutSafely(s, 160, '…');
}

function usageWindow(kind: UsageWindow['kind'], title: string, w: AnyMsg): UsageWindow {
  const out: UsageWindow = { kind, title, remainingPercent: Math.max(0, Math.min(100, 100 - Number(w.usedPercent))) };
  if (typeof w.resetsAt === 'number') out.resetsAt = new Date(w.resetsAt * 1000).toISOString();
  return out;
}

function durationTitle(mins: unknown): string {
  if (typeof mins !== 'number' || mins <= 0) return 'Other';
  if (mins % 1440 === 0) return mins === 1440 ? 'Daily' : `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-minute`;
}

function creditsDetail(c: AnyMsg | null | undefined): string | undefined {
  if (!c || !c.hasCredits || c.unlimited) return undefined;
  const n = Number(c.balance);
  if (!Number.isFinite(n)) return undefined;
  return `${Math.floor(n).toLocaleString('en-US')} credits`;
}

function resetTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(unixSeconds * 1000));
}

function totals(t: AnyMsg | undefined): Totals | undefined {
  if (!t || typeof t.totalTokens !== 'number') return undefined;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    totalTokens: n(t.totalTokens),
    inputTokens: n(t.inputTokens),
    cachedInputTokens: n(t.cachedInputTokens),
    cacheWriteInputTokens: n(t.cacheWriteInputTokens),
    outputTokens: n(t.outputTokens),
    reasoningOutputTokens: n(t.reasoningOutputTokens),
  };
}

function diffTotals(a: Totals, b: Totals): Totals {
  return {
    totalTokens: a.totalTokens - b.totalTokens,
    inputTokens: a.inputTokens - b.inputTokens,
    cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
  };
}

function firstLine(s: string, max = 100): string {
  return firstLineSafely(s, max, '…');
}

function ev(event: EventBody): AdapterOutput {
  return { kind: 'event', event };
}

function noteOut(text: string): AdapterOutput {
  return ev({ type: 'system.note', text });
}

function result(itemId: string, ok: boolean, text: string): AdapterOutput {
  return ev({ type: 'tool.result', itemId, ok, text, truncated: false, images: [] });
}
