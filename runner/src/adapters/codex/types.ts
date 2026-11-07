// A hand-picked subset of the Codex app-server protocol, pinned to codex-cli
// 0.164.0 (`codex app-server generate-ts --experimental`). Only what the
// adapter sends or reads is here, with the generated names, so a field can
// be looked up in the generated output by name. Everything is read
// defensively: a later Codex may add fields or variants, and surface.ts
// (checkSurface) is what notices one going missing.
import type { AdapterOutput } from '../types.ts';

// ---- JSON-RPC framing. No "jsonrpc" field on this wire.

export type RequestId = string | number;
export type RpcRequest = { id: RequestId; method: string; params?: unknown };
export type RpcNotification = { method: string; params?: unknown; emittedAtMs?: number };
export type RpcResponse = { id: RequestId; result?: unknown; error?: RpcErrorBody };
export type RpcErrorBody = { code: number; message: string; data?: unknown };

// ---- Handshake

export type InitializeParams = {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean; optOutNotificationMethods?: string[] | null } | null;
};
export type InitializeResponse = { userAgent: string; codexHome: string; platformFamily: string; platformOs: string };

// ---- Threads and turns

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPolicy = { type: 'dangerFullAccess' } | { type: 'readOnly'; networkAccess: boolean };
export type ReasoningEffort = string; // "low" ... "ultra"; Codex's own set can grow

export type ThreadStatus = { type: 'notLoaded' } | { type: 'idle' } | { type: 'systemError' } | { type: 'active'; activeFlags: string[] };

export type Thread = {
  id: string;
  parentThreadId: string | null;
  cwd: string;
  // The version of the CLI that *created* the thread. Never the version
  // running it: that comes from initialize's userAgent.
  cliVersion: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  status: ThreadStatus;
};

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type TurnError = { message: string; codexErrorInfo: unknown; additionalDetails: string | null };
export type Turn = {
  id: string;
  rootTurnId: string | null;
  status: TurnStatus;
  error: TurnError | null;
  durationMs: number | null;
};

export type UserInputItem =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string };

// skills/list (only the fields the runner reads).
export type SkillsListResponse = { data?: { cwd?: string; skills?: { name?: string; description?: string; shortDescription?: string; path?: string; scope?: string; enabled?: boolean }[] }[] };

export type DynamicToolFunctionSpec = { type: 'function'; name: string; description: string; inputSchema: unknown };
export type DynamicToolSpec = { type: 'namespace'; name: string; description: string; tools: DynamicToolFunctionSpec[] };

export type ThreadStartParams = {
  cwd: string;
  model?: string;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandbox: SandboxMode;
  config: Record<string, unknown>;
  dynamicTools?: DynamicToolSpec[];
};
export type ThreadResumeParams = Omit<ThreadStartParams, 'dynamicTools'> & { threadId: string; excludeTurns: true };
export type ThreadStartResponse = {
  thread: Thread;
  model: string;
  cwd: string;
  instructionSources: string[];
  reasoningEffort: ReasoningEffort | null;
  // thread/resume's: the mode the thread was left in (absent from older servers).
  collaborationMode?: CollaborationMode | null;
};

// Codex's collaboration mode (experimental): "plan" is its plan mode, which
// "Plan first" uses. Null developer_instructions means the mode's own.
export type CollaborationMode = {
  mode: 'plan' | 'default';
  settings: { model: string; reasoning_effort: ReasoningEffort | null; developer_instructions: string | null };
};

export type TurnStartParams = {
  threadId: string;
  clientUserMessageId?: string;
  input: UserInputItem[];
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  sandboxPolicy: SandboxPolicy;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  summary: 'detailed';
  collaborationMode?: CollaborationMode;
};
export type TurnStartResponse = { turn: Turn };
export type TurnSteerParams = { threadId: string; expectedTurnId: string; clientUserMessageId?: string; input: UserInputItem[] };
export type TurnSteerResponse = { turnId: string };
export type TurnInterruptParams = { threadId: string; turnId: string };

export type ThreadBackgroundTerminal = { itemId: string; processId: string; command: string; cwd: string };
export type ThreadBackgroundTerminalsListResponse = { data: ThreadBackgroundTerminal[]; nextCursor: string | null };
export type ThreadBackgroundTerminalsTerminateResponse = { terminated: boolean };

// ---- Notifications the adapter itself reads (the normaliser reads the rest)

export type TurnNotification = { threadId: string; turn: Turn };
export type ThreadStatusChangedNotification = { threadId: string; status: ThreadStatus };
export type ServerRequestResolvedNotification = { threadId: string; requestId: RequestId };
export type ItemNotification = { threadId: string; turnId: string; item: ThreadItemLike };
// Enough of a ThreadItem to route and to track open commands.
export type ThreadItemLike = {
  type: string;
  id: string;
  // subAgentActivity
  kind?: string;
  agentThreadId?: string;
  // collabAgentToolCall
  receiverThreadIds?: string[];
};

// ---- Models

export type Model = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
};
export type ModelListResponse = { data: Model[]; nextCursor: string | null };

// ---- Accounts and rate limits

export type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: unknown;
  planType: string | null;
  rateLimitReachedType: string | null;
  [k: string]: unknown;
};
export type GetAccountRateLimitsResponse = {
  ordinaryUsageAllowed: boolean | null;
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
};
export type GetAccountResponse = { account: { type: string; email?: string | null; planType?: string | null } | null };

// ---- Requests from Codex

export type CommandAction = { type: 'read' | 'listFiles' | 'search' | 'unknown'; command: string };
export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | 'decline'
  | 'cancel';
export type CommandExecutionRequestApprovalParams = {
  kind?: 'command' | 'writeStdin';
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  networkApprovalContext?: { host: string; protocol: string } | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  proposedExecpolicyAmendment?: string[] | null;
  proposedNetworkPolicyAmendments?: unknown[] | null;
  availableDecisions?: CommandExecutionApprovalDecision[] | null;
};
export type FileChangeRequestApprovalParams = { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null };
export type PermissionsRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: { network: unknown; fileSystem: unknown };
};
export type ToolRequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
};
export type ToolRequestUserInputParams = { threadId: string; turnId: string; itemId: string; questions: ToolRequestUserInputQuestion[]; isBlocking: boolean };
export type McpServerElicitationRequestParams = {
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode: string; // "form", "url", "openai/form", "openaiForm", "openai/userVerification"
  message?: string;
  requestedSchema?: { type?: string; properties?: Record<string, ElicitationProperty>; required?: string[] };
  url?: string;
};
export type ElicitationProperty = {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title?: string }[];
  default?: unknown;
};
export type DynamicToolCallParams = { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: unknown };
export type DynamicToolCallResponse = { contentItems: { type: 'inputText'; text: string }[]; success: boolean };
// Legacy (v1) approval requests.
export type ExecCommandApprovalParams = { conversationId: string; callId: string; command: string[]; cwd: string; reason: string | null };
export type ApplyPatchApprovalParams = { conversationId: string; callId: string; fileChanges: Record<string, unknown>; reason: string | null };

// ---- The normaliser (section B's CodexNormalizer in normalize.ts)

// What the session needs of a normaliser, so tests can wrap or replace it.
// `from` marks traffic from a subagent's thread, which arrives on the
// parent's connection. The adapter is the authority on which turns are its
// own: it drops any `cliTurn` the normaliser emits and emits its own for
// turns it didn't start, and it fills in `own`, `answers`, `answered` and
// `queuedTurns` on every `result`. The hooks tell the normaliser the same,
// so it keeps its own bookkeeping (usage per turn, userMessage echoes).
export interface CodexNormalizerLike {
  handle(method: string, params: any, from?: { childThreadId: string }): AdapterOutput[];
  // Closes items still open when the session ends without Codex closing
  // them (the process died or was stopped).
  closeOpen(reason: string): AdapterOutput[];
  setThread?(threadId: string, model?: string): void;
  startingTurn?(runnerId?: string): void;
  turnAccepted?(codexTurnId: string): void;
  steered?(runnerId: string): void;
}
