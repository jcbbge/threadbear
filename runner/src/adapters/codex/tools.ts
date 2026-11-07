// The threadbear tools for Codex threads. Codex can't take the in-process
// SDK MCP server Claude threads get, so the same tools go in as dynamic
// tools (experimental): a `threadbear` namespace given at thread/start, and
// item/tool/call requests answered by running the same handlers.
//
// Spike 1 (27 Oct): tools given at thread/start survive thread/resume in a
// new process (they're stored in the rollout's session_meta), although
// thread/resume takes no dynamicTools. So:
//  - the handlers are built for the session's own thread on every start and
//    resume, and looked up by namespace and tool name;
//  - a thread's tool list is frozen at thread/start, so a call for a tool
//    this runner doesn't have (renamed or removed since) gets success: false
//    and a sentence, never a JSON-RPC error, and a tool whose arguments have
//    changed takes the old ones too (formFor).
import { z } from 'zod';
import type { ToolApprovalAnswer, ToolApprovalRequest } from '../types.ts';
import type { PermissionMode } from '../../protocol.ts';
import { ALWAYS_ASK_TOOLS, FILING_PROJECTS, NEVER_ASK_TOOLS, guideLine, POCKET_LINE, SERVER_NAME, SHOWING_THE_USER } from '../../threadbear-mcp.ts';
import { userLine } from '../../user-name.ts';
import { CODEX_ONE_REPLY_DESCRIPTION, END_TURN_TOOL } from '../../needs.ts';
import { toolTitle, truncateInput } from '../../tools.ts';
import type { DynamicToolCallParams, DynamicToolCallResponse, DynamicToolSpec } from './types.ts';

// What the SDK's tool() makes (buildThreadbearTools' array), loosely typed
// so tools with different argument shapes fit in one list.
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // a zod raw shape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, extra: unknown) => Promise<{ content?: unknown[]; isError?: boolean }>;
  annotations?: { readOnlyHint?: boolean };
  // A tool whose arguments have changed shape: the version of it this call
  // was written for, as the thread's list may be older than this runner.
  formFor?: (args: unknown) => ToolDefinition;
};

export const NAMESPACE = SERVER_NAME;

// Codex rejects a namespace description over 1,024 characters (and with it
// the whole thread/start), so this stays a short summary. The longer
// guidance on when to use each tool goes in as developer instructions.
export const NAMESPACE_DESCRIPTION =
  "Tools that manage Threadbear, the app the user runs agent threads in, which this thread runs in: threads, schedules, projects, show_options, pin and show_panel for showing the user things, and end_turn to finish every turn.";
export const NAMESPACE_DESCRIPTION_MAX = 1024;

// Said as developer instructions at thread/start, next to the thread's
// projects brief: the same guidance Claude threads get in the MCP server's
// instructions.
const GUIDE = guideLine();
const GUIDANCE_HEAD =
  userLine() +
  (GUIDE ? `${GUIDE} ` : '') +
  "This thread's threadbear tools manage Threadbear itself: list and read threads, start new ones, message them, rename, snooze, archive, move and delete them, and schedule messages for later. " +
  'Use move_thread when the work belongs in another folder (for example a repo), so this thread runs there from the next turn. ' +
  `${SHOWING_THE_USER} ` +
  `${FILING_PROJECTS} `;
export const TOOL_GUIDANCE =
  GUIDANCE_HEAD +
  // Before, not after: Codex's final answer ends its turn (needs.ts).
  'End every turn by calling end_turn as your last tool call, just before your final answer, with a short summary of what you did (the user reads it first) and anything they have to do.';
// With one reply (needs.ts), the final answer after end_turn is the reply.
export const ONE_REPLY_TOOL_GUIDANCE =
  GUIDANCE_HEAD +
  'End every turn by calling end_turn as your last tool call, then writing your reply as your final answer: it is the only text the user sees from the turn.';

// Which guidance a thread's tools call for: one reply's end_turn has its
// own description.
export function toolGuidance(tools: ToolDefinition[]): string {
  const base = tools.some((t) => t.name === END_TURN_TOOL && t.description === CODEX_ONE_REPLY_DESCRIPTION) ? ONE_REPLY_TOOL_GUIDANCE : TOOL_GUIDANCE;
  // The pocket line only when the thread has the tool (sync on).
  return tools.some((t) => t.name === 'pocket') ? `${POCKET_LINE}\n\n${base}` : base;
}

// The tools as one dynamic-tool namespace, with JSON Schema from zod.
export function dynamicToolSpecs(tools: ToolDefinition[]): DynamicToolSpec[] {
  if (!tools.length) return [];
  return [
    {
      type: 'namespace',
      name: NAMESPACE,
      description: NAMESPACE_DESCRIPTION,
      tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: jsonSchema(t) })),
    },
  ];
}

function jsonSchema(t: ToolDefinition): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = z.toJSONSchema(z.object(t.inputSchema as any)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function text(t: string, success: boolean): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text: t }], success };
}

export type CodexToolsDeps = {
  // Codex never asks before a client-side tool, so the runner does: before
  // delete_thread always, and before any tool that changes something when
  // the thread's mode is ask.
  requestApproval(req: ToolApprovalRequest): Promise<ToolApprovalAnswer>;
  cwd(): string;
  // The thread's permission mode now (not the turn's).
  mode(): PermissionMode;
  // "Always allow" rules: a tool's full name, as for Claude.
  rules(): Iterable<string>;
  addRules(rules: string[]): void;
};

// Answers item/tool/call for one session's thread. A call from a subagent
// acts for the parent thread, like everything else the subagent does.
export class CodexTools {
  private byName = new Map<string, ToolDefinition>();
  private deps: CodexToolsDeps;

  constructor(tools: ToolDefinition[], deps: CodexToolsDeps) {
    for (const t of tools) this.byName.set(t.name, t);
    this.deps = deps;
  }

  async call(params: DynamicToolCallParams, o: { fromChild: boolean; signal: AbortSignal }): Promise<DynamicToolCallResponse> {
    const ns = params?.namespace ?? null;
    const name = typeof params?.tool === 'string' ? params.tool : '';
    const known = ns === NAMESPACE ? this.byName.get(name) : undefined;
    if (!known) {
      const shown = ns ? `${ns}.${name}` : name;
      return text(
        `Threadbear has no tool called ${shown || '(unnamed)'} any more. This thread's tool list was fixed when it started; the threadbear tools it has now are: ${[...this.byName.keys()].join(', ') || 'none'}.`,
        false,
      );
    }
    const raw = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = known.formFor?.(raw) ?? known;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = z.object(tool.inputSchema as any).safeParse(raw);
    if (!parsed.success) return text(`Those arguments don't fit ${name}: ${z.prettifyError(parsed.error)}`, false);
    const args = parsed.data as Record<string, unknown>;
    const fullName = `mcp__${NAMESPACE}__${name}`;
    const alwaysAsk = ALWAYS_ASK_TOOLS.has(fullName);
    const readOnly = NEVER_ASK_TOOLS.has(fullName) || tool.annotations?.readOnlyHint === true;
    const allowed = !alwaysAsk && [...this.deps.rules()].includes(fullName);
    if (alwaysAsk || (this.deps.mode() !== 'full' && !readOnly && !allowed)) {
      const ans = await this.deps.requestApproval({
        toolUseId: o.fromChild ? undefined : params.callId,
        name: fullName,
        title: toolTitle(fullName, args, this.deps.cwd()),
        input: truncateInput(args),
        canAlwaysAllow: !alwaysAsk,
        signal: o.signal,
      });
      if (ans.decision !== 'allow' && ans.decision !== 'allowAlways') {
        return text(ans.message || (ans.decision === 'expired' ? 'The request expired before the user answered.' : 'The user denied this. Ask them how to proceed.'), false);
      }
      if (ans.decision === 'allowAlways' && !alwaysAsk) this.deps.addRules([fullName]);
    }
    try {
      const result = await tool.handler(args, { signal: o.signal });
      const out = (result.content ?? [])
        .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
        .filter(Boolean)
        .join('\n');
      return text(out, !result.isError);
    } catch (e) {
      return text((e as Error)?.message ?? String(e), false);
    }
  }
}
