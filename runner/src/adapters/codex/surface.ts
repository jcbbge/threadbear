// What Threadbear relies on in the Codex app-server protocol, by name, so a
// Codex update that drops or renames any of it is caught before it's used
// (E's update gate holds the version back; scripts/codex-schema-check.sh
// says what changed). T3's adapter silently drops what it doesn't know;
// this is the opposite.
//
// checkSurface works by text match on the output of
// `codex app-server generate-ts --experimental --out DIR`, which is offline
// and needs no login.
import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_ITEM_TYPES, IGNORED_METHODS, MAPPED_ITEM_TYPES, MAPPED_METHODS } from './normalize.ts';

// The version these lists were checked against.
export const testedVersion = '0.164.0';

// Notifications the normaliser maps (its MAPPED_METHODS), plus the ones the
// adapter itself reads although the normaliser ignores them.
const ADAPTER_READS = ['thread/started', 'thread/status/changed', 'thread/closed', 'serverRequest/resolved'];
export const USED_NOTIFICATIONS: string[] = [...new Set<string>([...MAPPED_METHODS, ...ADAPTER_READS])];

// Notifications 0.164.0 has that Threadbear deliberately ignores: the
// normaliser's IGNORED_METHODS, and the families nothing here touches
// (realtime, goals, queues, fuzzy search, Windows). Anything in neither
// list after an update is reported as `added`.
const NOTHING_HERE_READS = [
  'thread/reverted',
  'thread/attachment/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/prediction/updated',
  'thread/queue/changed',
  'thread/project/updated',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'project/changed',
  'skills/changed',
  'autoApprovalReview/strictReviewRequired',
  'rawResponseItem/completed',
  'rawResponse/completed',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'mcpServer/oauthLogin/completed',
  'mcpServer/event/stream/notification',
  'account/gatewayOAuth/changed',
  'account/login/completed',
  'app/list/updated',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fs/changed',
  'modelProvider/authRecoveryStarted',
  'modelProvider/authRecoveryCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/item/completed',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
];
export const IGNORED_NOTIFICATIONS: string[] = [...new Set<string>([...IGNORED_METHODS, ...NOTHING_HERE_READS])].filter((m) => !USED_NOTIFICATIONS.includes(m));

// Requests the runner sends.
export const CLIENT_REQUESTS = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/archive',
  'thread/unarchive',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'account/read',
  'account/rateLimits/read',
];

export const CLIENT_NOTIFICATIONS = ['initialized'];

// Requests Codex sends that the runner answers (approvals.ts).
export const SERVER_REQUESTS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'item/tool/call',
  'mcpServer/elicitation/request',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
];

// Requests Codex can send that the runner refuses with -32601 on purpose.
export const REFUSED_SERVER_REQUESTS = ['account/chatgptAuthTokens/refresh', 'attestation/generate'];

// The fields the normaliser reads from each item type it maps.
const FIELDS: Record<string, string[]> = {
  agentMessage: ['text', 'phase'],
  reasoning: ['summary'],
  plan: ['text'],
  commandExecution: ['command', 'cwd', 'processId', 'source', 'status', 'commandActions', 'aggregatedOutput', 'exitCode', 'durationMs'],
  fileChange: ['changes', 'status'],
  mcpToolCall: ['server', 'tool', 'status', 'arguments', 'result', 'error'],
  dynamicToolCall: ['namespace', 'tool', 'arguments', 'status', 'contentItems', 'success'],
  collabAgentToolCall: ['tool', 'status', 'receiverThreadIds', 'prompt'],
  subAgentActivity: ['kind', 'agentThreadId', 'agentPath', 'model'],
  webSearch: ['query'],
  imageView: ['path'],
  imageGeneration: ['status', 'revisedPrompt', 'failure', 'savedPath', 'result', 'inputImages'],
  sleep: ['durationMs'],
  enteredReviewMode: ['review'],
  exitedReviewMode: ['review'],
};

// ThreadItem types the normaliser maps (MAPPED_ITEM_TYPES), with their fields.
export const ITEM_FIELDS: Record<string, string[]> = Object.fromEntries(MAPPED_ITEM_TYPES.map((t) => [t, FIELDS[t] ?? []]));

// ThreadItem types deliberately not shown (the normaliser's IGNORED_ITEM_TYPES).
export const IGNORED_ITEMS: string[] = [...IGNORED_ITEM_TYPES];

// Fields of other generated types (file name without .ts) that the runner
// sends or reads.
export const TYPE_FIELDS: Record<string, string[]> = {
  InitializeResponse: ['userAgent'],
  InitializeCapabilities: ['experimentalApi', 'optOutNotificationMethods'],
  ThreadStartParams: ['cwd', 'model', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'config', 'dynamicTools'],
  ThreadResumeParams: ['threadId', 'cwd', 'excludeTurns', 'config'],
  ThreadStartResponse: ['thread', 'model', 'reasoningEffort'],
  TurnStartParams: ['threadId', 'clientUserMessageId', 'input', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'model', 'effort', 'summary', 'collaborationMode'],
  TurnSteerParams: ['threadId', 'expectedTurnId', 'clientUserMessageId', 'input'],
  TurnSteerResponse: ['turnId'],
  TurnInterruptParams: ['threadId', 'turnId'],
  Turn: ['rootTurnId', 'status', 'error', 'durationMs'],
  TurnError: ['message', 'codexErrorInfo'],
  Thread: ['parentThreadId', 'cliVersion', 'cwd'],
  ThreadBackgroundTerminal: ['itemId', 'processId', 'command'],
  ThreadBackgroundTerminalsTerminateParams: ['threadId', 'processId'],
  ThreadBackgroundTerminalsTerminateResponse: ['terminated'],
  CommandExecutionRequestApprovalParams: ['kind', 'itemId', 'command', 'cwd', 'reason', 'commandActions', 'proposedExecpolicyAmendment', 'networkApprovalContext', 'availableDecisions'],
  FileChangeRequestApprovalParams: ['itemId', 'reason'],
  ToolRequestUserInputParams: ['questions', 'isBlocking'],
  ToolRequestUserInputQuestion: ['id', 'header', 'question', 'isSecret', 'options'],
  DynamicToolCallParams: ['callId', 'namespace', 'tool', 'arguments'],
  DynamicToolCallResponse: ['contentItems', 'success'],
  DynamicToolFunctionSpec: ['name', 'description', 'inputSchema'],
  DynamicToolNamespaceSpec: ['name', 'description', 'tools'],
  ServerRequestResolvedNotification: ['threadId', 'requestId'],
  Model: ['displayName', 'hidden', 'supportedReasoningEfforts', 'defaultReasoningEffort', 'isDefault'],
  GetAccountRateLimitsResponse: ['rateLimits', 'rateLimitsByLimitId', 'ordinaryUsageAllowed'],
  RateLimitSnapshot: ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'planType', 'rateLimitReachedType'],
  RateLimitWindow: ['usedPercent', 'windowDurationMins', 'resetsAt'],
  FileUpdateChange: ['path', 'kind', 'diff'],
  ThreadTokenUsageUpdatedNotification: ['threadId', 'tokenUsage'],
};

export type SurfaceCheck = { missing: string[]; added: string[] };

// Compares the generated protocol in `generatedDir` with the lists above.
// `missing` names what Threadbear uses and the new version lacks (an update
// is held for any); `added` names notifications, server requests and item
// types the lists don't mention (shown as plain rows until mapped).
export function checkSurface(generatedDir: string): SurfaceCheck {
  const files = indexFiles(generatedDir);
  const read = (name: string): string => {
    const f = files.get(name);
    if (!f) return '';
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const missing: string[] = [];
  const added: string[] = [];

  const notifications = methods(read('ServerNotification'));
  const clientRequests = methods(read('ClientRequest'));
  const clientNotifications = methods(read('ClientNotification'));
  const serverRequests = methods(read('ServerRequest'));

  for (const m of USED_NOTIFICATIONS) if (!notifications.has(m)) missing.push(`notification ${m}`);
  for (const m of CLIENT_REQUESTS) if (!clientRequests.has(m)) missing.push(`request ${m}`);
  for (const m of CLIENT_NOTIFICATIONS) if (!clientNotifications.has(m)) missing.push(`client notification ${m}`);
  for (const m of SERVER_REQUESTS) if (!serverRequests.has(m)) missing.push(`server request ${m}`);

  const known = new Set([...USED_NOTIFICATIONS, ...IGNORED_NOTIFICATIONS]);
  for (const m of notifications) if (!known.has(m)) added.push(`notification ${m}`);
  const knownRequests = new Set([...SERVER_REQUESTS, ...REFUSED_SERVER_REQUESTS]);
  for (const m of serverRequests) if (!knownRequests.has(m)) added.push(`server request ${m}`);

  const items = read('ThreadItem');
  const itemTypes = new Set([...items.matchAll(/"type":\s*"([^"]+)"/g)].map((m) => m[1]));
  for (const [type, fields] of Object.entries(ITEM_FIELDS)) {
    if (!itemTypes.has(type)) {
      missing.push(`item ${type}`);
      continue;
    }
    const text = itemText(items, type, read);
    for (const f of fields) if (!hasField(text, f)) missing.push(`field ${type}.${f}`);
  }
  const knownItems = new Set([...Object.keys(ITEM_FIELDS), ...IGNORED_ITEMS]);
  for (const t of itemTypes) if (!knownItems.has(t)) added.push(`item ${t}`);

  for (const [type, fields] of Object.entries(TYPE_FIELDS)) {
    const text = read(type);
    if (!text) {
      missing.push(`type ${type}`);
      continue;
    }
    for (const f of fields) if (!hasField(text, f)) missing.push(`field ${type}.${f}`);
  }
  return { missing, added };
}

// Generated file name (without .ts) -> path, from the root and v2/. The v2
// file wins when both have one (v1 keeps a few legacy shapes).
function indexFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const sub of ['', 'v2']) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(dir, sub));
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith('.ts')) out.set(n.slice(0, -3), path.join(dir, sub, n));
  }
  return out;
}

function methods(text: string): Set<string> {
  return new Set([...text.matchAll(/"method":\s*"([^"]+)"/g)].map((m) => m[1]));
}

// The ThreadItem union member for `type`, plus the file of any type it's
// joined with (`{ "type": "webSearch" } & WebSearchItem`).
function itemText(items: string, type: string, read: (name: string) => string): string {
  const start = items.indexOf(`"type": "${type}"`);
  if (start < 0) return '';
  const next = items.indexOf('"type": "', start + 1);
  let text = items.slice(start, next < 0 ? undefined : next);
  for (const m of text.matchAll(/&\s*([A-Z]\w+)/g)) text += '\n' + read(m[1]);
  return text;
}

function hasField(text: string, field: string): boolean {
  return new RegExp(`(^|[\\s{,("])${field.replace(/[$]/g, '\\$')}\\??\\s*:`, 'm').test(text);
}
