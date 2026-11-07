// Types for the runner protocol. docs/protocol.md is the contract; keep this
// file in step with it. Both sides ignore unknown fields, so extra internal
// fields never leak out: summaries are built explicitly by toSummary().

export const PROTOCOL_VERSION = 1;

export type Provider = 'claude' | 'codex';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex'];

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

// auto is Claude Code's auto mode: a separate classifier model approves or
// blocks each action, and asks only when it can't decide. Codex has no such
// thing, so there it behaves like ask. plan is "Plan first": the agent
// reads and plans but changes nothing until Mike approves its plan
// (docs/protocol.md, "Plan first").
export type PermissionMode = 'full' | 'ask' | 'auto' | 'plan';
export const PERMISSION_MODES: readonly PermissionMode[] = ['full', 'ask', 'auto', 'plan'];

// Every place a mode crosses from one process to another checks it with
// this, so a mode added later can't be dropped by one hop's own list and
// leave the thread on the full-access default (Daybreak, 7 Nov 2026: Plan
// first sent to another Mac arrived as Full access).
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

// A new thread's mode in a `create` command another runner takes through
// the backend (docs/protocol.md, "Other runners' threads through the
// backend"). Plan first goes as Ask with `plan: true`: a runner or backend
// from before it knew Plan first drops the flag and starts the thread on
// Ask, never on the full access a missing mode means. Unknown modes are
// refused, not dropped.
export function remoteCreateMode(mode: unknown): Record<string, unknown> {
  if (mode === undefined || mode === null) return {};
  if (!isPermissionMode(mode)) throw new RpcError(ErrorCode.badParams, `permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
  return mode === 'plan' ? { permissionMode: 'ask', plan: true } : { permissionMode: mode };
}

// What the runner taking a `create` command starts the thread on: undefined
// (the default) only when the command names no mode at all.
export function remoteCreateModeOf(a: { permissionMode?: unknown; plan?: unknown }): PermissionMode | undefined {
  if (a.plan === true) return 'plan';
  if (a.permissionMode === undefined || a.permissionMode === null) return undefined;
  if (!isPermissionMode(a.permissionMode)) throw new Error(`Unknown permission mode ${JSON.stringify(a.permissionMode)}: the thread wasn't started.`);
  return a.permissionMode;
}
// 'ultra' is Codex's multi-agent level; Claude never offers it.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

// One row of a CLI's model picker: `id` is what to send as a thread's model,
// `model` the full id it runs as.
export type ModelChoice = {
  id: string;
  model: string;
  title: string;
  description?: string;
  effortLevels?: EffortLevel[];
  defaultEffort?: EffortLevel; // the model's own level, when the CLI says (Codex)
};

export type UsageWindowKind = 'five_hour' | 'weekly' | 'weekly_model' | 'daily' | 'monthly' | 'allowance' | 'other';

export type UsageWindow = {
  kind: UsageWindowKind;
  title: string; // "5-hour", "Weekly", "Weekly Fable", "$250 allowance"
  remainingPercent: number; // 0 to 100, may be fractional
  resetsAt?: string;
  detail?: string; // "$132.79 left"
};

export type AccountUsage = {
  windows: UsageWindow[];
  readAt: string; // when the newest reading in it was taken
  // 'shared': another runner's reading of the same login (by email) was the
  // newest (docs/protocol.md, Accounts, "Shared readings").
  source: 'tokenStats' | 'live' | 'shared';
  stale?: boolean; // Token Stats has gone quiet and there's no live reading since
  blocked?: boolean; // the provider says this login is at its limit
  notice?: string; // Token Stats' own note
};

export type Account = {
  id: string;
  provider: Provider;
  // Codex titles start "Codex · " so an app that only shows title can tell
  // codex-main from a Claude login with the same email.
  title: string;
  configDir: string;
  // The full id a thread with no model runs on, once known (the account's
  // settings, corrected by the first turn seen); and the CLI's model list.
  defaultModel?: string;
  models?: ModelChoice[];
  defaultEffort?: EffortLevel; // the account's own level; absent: each model's
  email?: string;
  plan?: string;
  note?: string; // from runner.json's accountNotes ("Convex work only")
  usage?: AccountUsage;
};

export type CliPolicy = 'auto' | 'notify' | 'off';
export const CLI_POLICIES: readonly CliPolicy[] = ['auto', 'notify', 'off'];

export type CliUpdateState = 'waiting' | 'running' | 'succeeded' | 'unchanged' | 'failed';

export type CliStatus = {
  provider: Provider;
  path: string; // the binary new sessions start
  // Codex: Threadbear's own copies; Claude: its own installer; 'none' when
  // codexPath is set by hand and never updated.
  managedBy: 'threadbear' | 'cli' | 'none';
  installedVersion?: string;
  latestVersion?: string;
  status: 'current' | 'behind' | 'held' | 'unknown' | 'missing';
  policy: CliPolicy;
  inUse: { version: string; threadIds: string[] }[];
  previousVersion?: string; // Codex: the kept version "Go back" returns to
  checkedAt?: string;
  hold?: { version: string; reason: string; missing?: string[] };
  update?: {
    state: CliUpdateState;
    targetVersion?: string;
    waitingFor?: string[];
    finishedAt?: string;
    message?: string;
  };
};

// A named, ordered list of logins of any provider (docs/protocol.md,
// "Pools"). A thread in a pool runs each turn on whichever of its logins
// has room; the order of accountIds only decides which provider comes
// first.
export type Pool = {
  id: string; // "claude", "codex", "convex", or a slug Mike made
  title: string; // "Claude"
  accountIds: string[]; // in order; may mix providers
  folders?: string[]; // ~ allowed; a new thread under one starts here
  icon?: string; // an SF Symbol name Mike picked ("leaf"); the app has a fallback
  builtIn?: boolean; // from the code default, not runner.json
};

// Set on a pool thread while every login in its pool is out of room; it
// carries on by itself at `until`. accountId is the login it's waiting on.
export type WaitingForRoom = { until: string; accountId?: string };

// hello's `defaults`. `model` is Claude's, kept for apps that predate
// `models`.
export type RunnerDefaults = {
  cwd: string;
  accountId: string;
  // The pool a new thread with nothing named starts on (folder-blind: the
  // app applies a pool's folders itself).
  poolId?: string;
  model?: string;
  models?: Partial<Record<Provider, string>>;
  efforts?: Partial<Record<Provider, EffortLevel>>;
};

export type ThreadStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'error' | 'stopped';

// Who archived a thread, and how Mike said it went (Who archived a thread).
export type ArchivedBy = 'mike' | 'agent' | 'threadbear';
export type ArchiveVerdict = 'worked' | 'didntWork' | 'notNeeded';
export const ARCHIVE_VERDICTS: readonly ArchiveVerdict[] = ['worked', 'didntWork', 'notNeeded'];

export type ThreadSummary = {
  id: string;
  title: string;
  cwd: string;
  accountId: string;
  poolId?: string; // absent: pinned to accountId
  waitingForRoom?: WaitingForRoom;
  // Its last turn couldn't reach the API; it carries on by itself once
  // the runner reaches it again (Runner.onNetworkLost).
  waitingForNetwork?: { since: string };
  provider: Provider;
  model?: string;
  effort?: EffortLevel;
  modelInUse?: string;
  effortInUse?: EffortLevel;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  live: boolean;
  needsYou: boolean;
  // What the last completed turn said it needs from Mike, and its open
  // asks (docs/protocol.md, "Needs you").
  needs?: NeedsWho;
  asks?: OpenAsk[];
  asksSeq?: number;
  pendingReviews?: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  snoozedUntil?: string;
  snoozedUntilRestart?: boolean; // hibernating until the runner next starts
  snoozedUntilRelease?: true; // with snoozedUntilRestart: until it starts on a new release
  // Hibernated in Mike's words ("Hibernate in words"): what he said, the
  // topic it waits for, and pending while the time is worked out.
  wakeWhen?: { said: string; topic?: string; pending?: true };
  waitingOn?: { threadId: string; title: string; until?: string; done?: true }[]; // hibernating until these finish (or do `until`)
  woke?: { at: string; since?: string }; // woke from hibernating by itself, not looked at yet
  onOldRunner?: boolean; // finishing a turn on a runner that handed over (Handovers)
  archivedAt?: string;
  // Who archived it and, from the done card's Archive menu, the user's word
  // on how it went; only while archivedAt is set (Who archived a thread).
  archivedBy?: ArchivedBy;
  archiveVerdict?: ArchiveVerdict;
  starredAt?: string; // in the Starred section above the Inbox, unless archived
  preview: string;
  lastSeq: number;
  lastSeenSeq: number;
  nativeSessionId?: string;
  contextTokens?: number;
  contextWindow?: number; // the model's window, when the CLI reports it
  costUsd?: number;
  panels?: Panel[]; // absent when the folder has none
  actions?: Action[]; // likewise
  hooks?: Hook[]; // likewise
  patches?: PatchInfo[]; // the patches that apply to the folder, built in and the project's; absent when none
  // Background sub-agents and shell jobs the live CLI is still running
  // (and ones just finished whose result it's about to read). Absent when
  // there's none.
  background?: BackgroundTask[];
  // The sub-agents the agent has started, newest 20, oldest first. Absent
  // when it has started none.
  subagents?: Subagent[];
  // The projects the thread is in, oldest first. Absent when none.
  projects?: ThreadProject[];
  // When its highlights last changed other than by a new event (a pin, a
  // removal, the librarian's brief): a client fetches threads.highlights
  // again when this or lastSeq moves.
  highlightsAt?: string;
  // Its own git worktree (docs/thread-worktrees.md). Absent when it has
  // none, or once that was removed.
  worktree?: ThreadWorktree;
  // The schedule that started it (docs/protocol.md, "Schedules"). Absent
  // for a thread a person or an agent started.
  schedule?: ThreadSchedule;
  // Who started it, when that wasn't Mike (docs/protocol.md, "Who started
  // a thread"). Absent for his own threads.
  startedBy?: ThreadStartedBy;
  // Mike's last message to it, one line, for the sidebar's "You: ..."
  // (docs/protocol.md, "What Mike last asked"). Absent until he's sent one.
  asked?: string;
  // A panel the agent asked to show Mike (show_panel), waiting for him to
  // look at the thread (docs/protocol.md, "Showing panels").
  panelRequest?: PanelRequest;
  // Whether anyone with its link can read it on the website
  // (docs/protocol.md, "Sharing"). Absent until it's first shared; "off"
  // keeps the link for when it's shared again.
  share?: ThreadShare;
  sample?: true; // one of the tour's sample threads (threads.samples): made up, never sent to
  // What's still open on the done card of its last turn (experiment
  // looseEnds; docs/protocol.md, "Loose ends"): seq is that card's
  // turn.completed. ends empty: checked, and nothing's left. Absent: not
  // checked (the experiment's off, the last turn needs Mike, or it's
  // still being checked).
  looseEnds?: { seq: number; ends: LooseEnd[]; at: string };
};

// unlanded: commits on its branch that main lacks. uncommitted: files in
// its worktree. thread: one it started, still working or waiting on Mike.
// scheduled: a schedule that will message it again (at: when), which
// doesn't stop an archive. Clients show any other kind as its text.
export type LooseEndKind = 'unlanded' | 'uncommitted' | 'thread' | 'scheduled';
export type LooseEnd = { kind: LooseEndKind; text: string; threadId?: string; at?: string };

export type ShareAccess = 'off' | 'link';

export type ThreadShare = {
  access: ShareAccess;
  slug: string; // the link is <website>/s/<slug>
  updatedAt: string;
};

// Where show_panel opens a panel that's closed; absent is its usual place.
export type PanelPlace = 'tab' | 'left' | 'right' | 'top' | 'bottom' | 'window';

export type PanelRequest = {
  id: string;
  panel: string; // "highlights", "patches", "usage", "updates", "connectors", or one of the thread's panels' ids
  title: string; // "Highlights", "Convex"
  where?: PanelPlace;
  at: string;
};

export type ThreadWorktree = { branch: string; mainCheckout: string; path: string };

// The schedule's title as it was when it started the thread.
export type ThreadSchedule = { id: string; title: string };
export type ThreadStartedByKind = 'tool' | 'thread' | 'schedule' | 'librarian' | 'runner';
export type ThreadStartedBy = {
  kind: ThreadStartedByKind;
  label: string; // "Sentry", "Agent", "Schedule"
  icon?: string; // an SF Symbol a tool asked for (tool only)
  threadId?: string; // the thread that started it (thread, librarian)
  threadTitle?: string; // that thread's title then
  why?: string; // a few words: why it exists, then how it came out
};

// Projects (docs/protocol.md, "Projects"): a grouping above folders that
// carries goals, state and notes forward, made by the librarian, agents or
// Mike.
export type ProjectMaker = 'mike' | 'agent' | 'librarian';

export type ThreadProject = {
  id: string;
  title: string;
  by: ProjectMaker;
  pinned?: boolean; // the librarian won't take it out
  at: string;
  // Why it's there, in a short line: the librarian's reason, or an
  // agent's. Highlights shows it behind the project's ⓘ, so a wrong guess
  // can be seen and undone.
  why?: string;
};

export type Project = {
  id: string;
  title: string;
  folders: string[];
  goals: string;
  state: string;
  notes: string;
  links: ProjectLink[];
  createdBy: ProjectMaker;
  createdByThread?: string;
  // Who last named it. The librarian renames one whose name has gone out of
  // date, never one Mike named. Absent on older projects: createdBy.
  titleBy?: ProjectMaker;
  createdAt: string;
  updatedAt: string;
  stateUpdatedAt?: string;
  archived?: boolean;
  icon?: ProjectIcon;
  // A Notion page (or database) with the project's task board on it, and
  // the board as last read (see "Project tasks").
  notion?: string;
  tasks?: ProjectTasks;
  threadCount: number;
  lastActivityAt?: string;
};

// A project's task board, read from the Notion database on its page.
// Notion is where it's changed; Threadbear only shows it.
export type ProjectTasks = {
  url: string; // the database (or page) to open in Notion
  columns: TaskColumn[]; // the Status options, in Notion's order
  items: ProjectTask[];
  fetchedAt?: string; // absent while the first read is going
  loading?: boolean; // the first read hasn't come back yet
  error?: string; // the last read failed; columns and items are the last good ones
  more?: boolean; // more than 100 rows: only the first 100 are here
};

// A Status option. kind is Notion's group for it: To do, In progress
// or Complete.
export type TaskColumn = { name: string; kind: 'todo' | 'doing' | 'done'; color?: string };

export type ProjectTask = {
  id: string; // the Notion page id
  title: string;
  url: string;
  status: string; // a column's name, or empty
  who: string[];
  due?: string; // ISO date
  dueEnd?: string;
  thread?: string; // a Threadbear thread id (or prefix) working on it
};

// A place Mike goes for a project: its live site, admin page, dashboard,
// store listing or repo. Shown at the top of its threads' Highlights.
export type ProjectLink = { title: string; url: string };

// What a project shows as its icon: a picture found in its folders (or
// chosen), else an SF Symbol. Absent until the librarian has found one.
export type ProjectIcon = {
  image?: ImageRef; // a copy in the runner's data dir, at most 256 px
  symbol?: string; // an SF Symbol name, when there's no picture
  from?: string; // the file the picture was copied from
  // librarian: found by itself and kept up to date; mike or agent: chosen,
  // and left alone until set back to automatic.
  by: ProjectMaker;
  updatedAt: string;
};

// 'notes': a project's notes got long and were tidied; the entry is the
// project's, with an empty threadId.
export type LibrarianReason = 'first-message' | 'first-turn' | 'new-folder' | 'moved' | 'catch-up' | 'asked' | 'notes' | 'waited-on';

export type LibrarianJob = {
  threadId: string;
  threadTitle: string;
  reason: LibrarianReason;
  why: string;
  dueAt: string;
};

export type LibrarianOutcome = 'joined' | 'created' | 'updated' | 'left' | 'nothing' | 'skipped' | 'failed';

export type LibrarianEntry = {
  id: string;
  at: string;
  threadId: string;
  threadTitle: string;
  reason: LibrarianReason;
  outcome: LibrarianOutcome;
  text: string;
  projectIds?: string[];
  costUsd?: number;
};

export type LibrarianStatus = {
  state: 'idle' | 'working' | 'paused' | 'off';
  reason?: string;
  paused: boolean;
  current?: LibrarianJob & { startedAt: string };
  queue: LibrarianJob[];
  recent: LibrarianEntry[];
  looksToday: number;
  spentTodayUsd: number;
  skippedToday?: number;
  tokensToday?: number;
  notionalTodayUsd?: number;
};

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped';

// A sub-agent the thread's agent started, followed from the CLI's task
// events. threads.subagent reads what it did from the CLI's own record.
export type Subagent = {
  id: string; // the CLI's task id, which also names its transcript
  itemId?: string; // the tool.call that started it
  parentId?: string; // the sub-agent that started this one
  description: string;
  agentType?: string;
  status: SubagentStatus;
  background: boolean;
  activity?: string; // while running: what it's doing now
  summary?: string; // once finished: what it reported, one line
  toolUses?: number;
  startedAt: string;
  endedAt?: string;
};

// An action a patch gives a thread: a chip above the composer that runs a
// command in the thread's folder (its output goes into the transcript as an
// action.run event), sends a canned prompt, or opens a web page on the
// device it was pressed on (no RPC, nothing in the transcript).
export type ActionKind = 'command' | 'prompt' | 'url';
export type Action = {
  id: string; // "<patch>.<slug of the title>"
  title: string;
  kind: ActionKind;
  command?: string; // kind "command"
  prompt?: string; // kind "prompt"
  url?: string; // kind "url": an http or https page
  patch: string;
  folder?: string; // where the command runs (a project patch's: the folder holding its .threadbear/); absent: the thread's folder
  projectId?: string; // the project whose folder gave it
  note?: string;
  icon?: string; // an SF Symbol for the chip: the action's own, else its patch's
  iconFile?: string; // or a picture for it instead (absolute path: an image or a .app)
  badge?: number; // a count on the chip, from the patch's badge function
};

// A hook a patch gives a thread: a command the runner runs by itself when
// something happens (for now, when a turn completes), posted into the
// transcript like an action, and told to the agent as a new message when
// `tell` says so.
export type HookTrigger = 'turn.end';
export type HookTell = 'failures' | 'always' | 'never';
export type Hook = {
  id: string; // "<patch>.<slug of the title>"
  title: string;
  on: HookTrigger;
  command: string;
  // What the runner hands the shell instead, for a patch trusted by its hash:
  // `command`'s script by its absolute path, every word quoted (patch-trust.ts,
  // automaticCommand). Clients show `command`.
  exec?: string;
  edited?: string; // only after a turn that edited a file matching this glob (relative to the folder)
  tell: HookTell; // when the result goes to the agent as a message
  patch: string;
  folder?: string; // as Action's; only edits inside it count
  projectId?: string;
  note?: string;
};

// A patch that applies to a thread's folder and where it came from.
// 'claude': the thread folder's Claude Code settings, listed while they run
// commands that aren't trusted (claude-trust.ts).
export type PatchSource = 'builtin' | 'home' | 'project' | 'claude';
export type PatchInfo = {
  id: string;
  source: PatchSource;
  file?: string; // the module, for home and project patches
  folder?: string; // the folder it applies from
  projectId?: string; // set when it came from a project's folder
  error?: string; // set when the file couldn't be loaded; it then gives nothing
  matched?: string[]; // a tool patch (appliesTo): the paths that made it apply
  liveError?: string; // a when or badge function that threw or took too long
  // A project's patch file that isn't trusted yet, so wasn't loaded and
  // gives nothing (docs/protocol.md, "Trusting a folder's patches"): "new"
  // when nothing from its folder is trusted, "changed" when an earlier
  // version was. `hash` is the version patches.trust would trust.
  untrusted?: 'new' | 'changed';
  hash?: string;
  helpers?: string[]; // with untrusted: the local files it imports, which the hash covers too
  grants?: string[]; // with untrusted, a folder's Claude settings in a thread that asks first: what they'd let run without asking, in words
  icon?: string; // the patch file's icon, an SF Symbol
  iconFile?: string; // or its picture (absolute path: an image or a .app)
};

// A panel a patch gives a thread (docs/protocol.md, "Panels"). The runner
// works them out from the thread's folder; nothing is persisted.
export type PanelKind = 'url' | 'image' | 'list';
export type Panel = {
  id: string; // unique within the thread, e.g. "convex.dashboard"
  title: string; // the tab's label
  kind: PanelKind;
  url?: string; // kind "url": what the panel shows and what Open in browser opens
  icon?: string; // an SF Symbol name for its button on the app's right-hand rail: its own, else its patch's
  iconFile?: string; // or a picture instead (absolute path: an image or a .app), the tool's own icon
  patch: string; // the patch it came from: "convex", "xcode"
  projectId?: string;
  note?: string; // one line about it: the deployment name, the booted device
  badge?: number; // a count on its rail button, from the patch's badge function
  summary?: string; // a line or few for its card in Highlights, from the patch's summary function
  convex?: { deployment: string; deploymentUrl: string; team?: string; project?: string }; // the Convex panel's cloud deployment, for panels.convexKey
};

// One row of a `list` panel, as its patch's `items` function returns it.
export type PanelItem = {
  title: string;
  detail?: string;
  url?: string;
  path?: string;
  icon?: string;
  tone?: 'attention' | 'failed' | 'done';
  // A heading drawn over the row where it differs from the row before's.
  section?: string;
  // Short, faint, at the end of the title's line: a date or a count.
  trailing?: string;
};

export type BackgroundKind = 'agent' | 'shell' | 'monitor' | 'other';

export type BackgroundTask = {
  kind: BackgroundKind;
  description: string;
  finished?: boolean;
};

// Agents are still working for this thread: sub-agents, or a workflow's
// (kind "other"), including ones just finished whose result is still to be
// read. What they find can change what the thread's agent asks Mike, so a
// card it left open isn't his to answer yet (docs/protocol.md, "Needs you";
// Mike, 2 Nov). Shells and monitors don't count: one is often a watcher
// waiting for Mike to do what he was asked, as with the SD card on 1 Nov.
export function agentsStillWorking(tasks: BackgroundTask[] | undefined): boolean {
  return Boolean(tasks?.some((t) => t.kind === 'agent' || t.kind === 'other'));
}

// "2 sub-agents, 1 shell job in the background" for tb list's flags; '' with none.
export function backgroundFlag(tasks: BackgroundTask[] | undefined): string {
  if (!tasks?.length) return '';
  const running = tasks.filter((t) => !t.finished);
  const count = (kind: string, one: string, many: string): string => {
    const n = running.filter((t) => t.kind === kind).length;
    return n === 0 ? '' : n === 1 ? `1 ${one}` : `${n} ${many}`;
  };
  const parts = [count('agent', 'sub-agent', 'sub-agents'), count('shell', 'shell job', 'shell jobs'), count('monitor', 'monitor', 'monitors'), count('other', 'background task', 'background tasks')].filter(Boolean);
  const finished = tasks.length - running.length;
  if (finished) parts.push(`${finished} just finished`);
  return parts.join(', ') + (running.length ? ' in the background' : '');
}


export type ImageRef = {
  path: string;
  mediaType: string;
  width?: number;
  height?: number;
};

// 'image' is image generation.
export type ToolKind = 'command' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'mcp' | 'task' | 'todo' | 'image' | 'other';

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type PlanEntry = { text: string; status: 'pending' | 'in_progress' | 'completed' };

export type ApprovalOption = 'allow' | 'allowAlways' | 'deny';
export type ApprovalDecision = 'allow' | 'allowAlways' | 'deny' | 'answered' | 'expired';

export type Question = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
};

export type TurnOutcome = 'completed' | 'interrupted' | 'failed';

// Why a failed turn failed, when it's known, so a client can offer the fix
// (another account, a new thread, signing in) without reading `error`.
// network: the API couldn't be reached (DNS, no route, a dropped or refused
// connection), so the runner carries the turn on once it's back.
export type TurnErrorKind = 'usageLimit' | 'contextWindow' | 'auth' | 'network';

// turn.completed's `usage`, per provider.
export type ClaudeTurnUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type CodexTurnUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
};

// pickedIds: every option picked, in the review's order, with pickedId the
// first of them for clients from before several could be picked (4 Nov).
// reply: Mike's own words on the whole review. none: none of them will do.
export type ReviewDraft = { pickedId?: string; pickedIds?: string[]; notes: Record<string, string>; reply?: string; none?: true };

// One picture of an option: its first, or another screen or state of it.
// media: a video (video/mp4, video/quicktime) or page (text/html) the
// window plays or shows in place of image, which is then its still.
export type ReviewShot = { title?: string; image: ImageRef; media?: ImageRef };

export type DesignReview = {
  id: string;
  title: string;
  note?: string;
  // The option id the agent would pick, marked "my pick" in the window.
  recommended?: string;
  // image is the option's first shot, kept for clients that only show one.
  // shots, when given, is every shot in order, image included. url: the
  // option running live, to open beside the pictures.
  options: { id: string; title: string; note?: string; reference?: boolean; image: ImageRef; shots?: ReviewShot[]; url?: string }[];
  status: 'pending' | 'answered' | 'cancelled' | 'superseded';
  revision: number;
  createdAt: string;
  updatedAt: string;
  draft: ReviewDraft;
  response?: ReviewDraft;
  replyTurnId?: string;
};

// A button an agent put in its reply (docs/protocol.md, "Reply buttons"):
// pressing it starts a thread with the brief, or sends a message to a
// thread. Exactly one of start and send.
export type ReplyButtonStart = {
  text: string;
  title?: string;
  cwd: string;
  accountId?: string;
  poolId?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  why?: string;
};
export type ReplyButtonSend = { threadId: string; threadTitle: string; text: string };
export type ReplyButton = {
  id: string;
  title: string;
  createdAt: string;
  turnId?: string;
  start?: ReplyButtonStart;
  send?: ReplyButtonSend;
  pressed?: { at: string; threadId: string };
  failed?: { at: string; error: string };
};

// Persisted event bodies, without the envelope.
export type EventBody =
  | { type: 'review.updated'; review: DesignReview }
  | { type: 'button.updated'; button: ReplyButton }
  // origin is set only on messages the runner sent by itself (the resume
  // after a restart).
  | { type: 'user.message'; text: string; images: ImageRef[]; origin?: MessageOrigin; scheduleId?: string; reviewId?: string; reviewResponse?: ReviewDraft; answers?: AskAnswer[]; editOf?: number }
  // summary: the turn's summary, written by the runner from end_turn
  // givesWay: the turn's summary, with bullet replies off: any message of
  // the turn is the reply over it, however short
  // narration: the provider sent only a summary of what the agent wrote
  // (Claude's narration blocks, normalize.ts); a later event with the
  // same itemId replaces it (docs/protocol.md, Transient events).
  | { type: 'assistant.text'; itemId: string; text: string; summary?: true; givesWay?: true; narration?: true; final?: true }
  | { type: 'reasoning'; itemId: string; text: string }
  | { type: 'tool.call'; itemId: string; name: string; kind: ToolKind; title: string; input: Record<string, unknown> }
  | {
      type: 'tool.result';
      itemId: string;
      ok: boolean;
      text: string;
      truncated: boolean;
      blobPath?: string;
      images: ImageRef[];
    }
  // One per file: a repeated path on the same itemId replaces that file's
  // diff, a new path adds one.
  | { type: 'edit.diff'; itemId: string; path: string; hunks: Hunk[] }
  | {
      type: 'approval.requested';
      approvalId: string;
      itemId?: string;
      name: string;
      title: string;
      input: Record<string, unknown>;
      options: ApprovalOption[];
    }
  | { type: 'question.requested'; approvalId: string; itemId?: string; questions: Question[] }
  // An agent's ask_secret (docs/protocol.md, "Secrets"): never the value.
  | { type: 'secret.requested'; approvalId: string; itemId?: string; label: string; reason: string; placeholder?: string }
  | { type: 'approval.resolved'; approvalId: string; decision: ApprovalDecision; message?: string }
  | { type: 'plan.updated'; entries: PlanEntry[] }
  // "Plan first" (docs/protocol.md): the agent's plan, waiting for Mike,
  // and what became of it.
  | { type: 'plan.proposed'; itemId: string; text: string }
  | { type: 'plan.resolved'; itemId: string; decision: 'go' | 'revise' }
  // wokeBy: the background work that finished and started this turn (docs/protocol.md)
  | { type: 'turn.started'; turnId: string; wokeBy?: { kind: BackgroundKind; description: string }[] }
  | {
      type: 'turn.completed';
      turnId: string;
      outcome: TurnOutcome;
      durationMs: number;
      costUsd?: number; // Codex turns have none
      usage?: ClaudeTurnUsage | CodexTurnUsage | Record<string, unknown>;
      error?: string;
      errorKind?: TurnErrorKind;
      needs?: NeedsWho;
      asks?: Ask[];
      // With needs "nothing": end_turn's suggested follow-ups.
      next?: string[];
      needsFrom?: 'tool' | 'text';
    }
  // The ticks on a card of asks, the whole set each time. Outside any turn.
  | { type: 'asks.ticked'; asksSeq: number; ticked: number[] }
  // wake: a background task's notification that went into the running
  // turn, which opens a turn that's had its end_turn again (needs.ts,
  // takenEndTurn).
  | { type: 'system.note'; text: string; wake?: true }
  | { type: 'error'; message: string }
  // A command action that ran (patches.ts): its output, truncated like a
  // tool result. Outside any turn.
  | {
      type: 'action.run';
      actionId: string;
      patch: string;
      title: string;
      command: string;
      ok: boolean;
      exitCode?: number;
      text: string;
      truncated: boolean;
      durationMs: number;
      trigger?: HookTrigger | 'worktree.setup'; // set when a hook or a new worktree's setup ran it, absent for a chip or tb run
    }
  // Mike edited the message at fromSeq (docs/protocol.md, "Editing a
  // message"): fromSeq..toSeq are gone from the conversation. Outside any turn.
  | { type: 'thread.rewound'; fromSeq: number; toSeq: number; files: RewoundFiles };

// What an edit did to the files the agent had changed since the message.
// how: "checkpoint" when Claude's own file checkpoints put them back,
// "diffs" when the runner reversed the thread's edit.diff events, "none"
// when there was nothing to undo.
export type RewoundFiles = { undone: string[]; failed: { path: string; reason: string }[]; how: 'checkpoint' | 'diffs' | 'none' };

export type DeltaType = 'assistant.text.delta' | 'reasoning.delta' | 'tool.output.delta';
export type DeltaBody = { type: DeltaType; itemId: string; text: string };

export type Envelope = {
  seq: number;
  ts: string;
  threadId: string;
  turnId?: string;
};

// What a finished turn needs from Mike (docs/protocol.md, "Needs you").
export type NeedsWho = 'you' | 'nothing';
// One thing a turn needs from Mike (docs/protocol.md, "Needs you"). With
// options it's a decision the app steps him through, the agent's pick
// (suggested, an index into options) marked; he can always write his own.
// optionNotes: with one reply, what each option does if Mike picks it, in
// the options' order ("" for none); the card draws them under the labels.
export type Ask = { action: string; where?: string; reply?: string; why?: string; options?: string[]; optionNotes?: string[]; suggested?: number; links?: AskLink[] };
// Somewhere to go to do or judge an ask: a web page, or a file or folder
// on this Mac (an absolute or ~ path). The app shows each as a button.
export type AskLink = { title: string; url: string };
// Which of the open card's asks a message answers, and how, so the app
// can show the answers as answers rather than as text Mike wrote. The
// agent only ever sees the message's text.
export type AskAnswer = { action: string; answer: string };
export type OpenAsk = Ask & { ticked?: true };

export type PersistedEvent = Envelope & EventBody;
export type TransientEvent = Envelope & DeltaBody;
export type AnyEvent = PersistedEvent | TransientEvent;

export const PERSISTED_TYPES = new Set<string>([
  'review.updated',
  'button.updated',
  'user.message',
  'assistant.text',
  'reasoning',
  'tool.call',
  'tool.result',
  'edit.diff',
  'approval.requested',
  'question.requested',
  'secret.requested',
  'approval.resolved',
  'plan.updated',
  'plan.proposed',
  'plan.resolved',
  'turn.started',
  'turn.completed',
  'asks.ticked',
  'system.note',
  'error',
  'action.run',
  'thread.rewound',
]);

export const TRANSIENT_TYPES = new Set<string>(['assistant.text.delta', 'reasoning.delta', 'tool.output.delta']);

export type InProgressItem = { itemId: string; type: 'assistant.text' | 'reasoning'; text: string };

// JSON-RPC error codes from docs/protocol.md.
// A message sent at a set time, once (at) or over and over (cron). See
// "Schedules" in docs/protocol.md.
export type Schedule = {
  id: string;
  title: string;
  text: string;
  at?: string;
  cron?: string;
  timezone?: string;
  whenText: string;
  threadId?: string;
  cwd?: string;
  accountId?: string;
  // A pool picks its login each run instead (docs/protocol.md, Pools).
  // Never set with accountId.
  poolId?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  // A shell command run first, in its folder; a run whose check prints
  // nothing is skipped (experiment scheduleChecks, schedule-check.ts).
  check?: string;
  // How long the check may take, in seconds (at most 300); absent, 60.
  checkTimeoutSecs?: number;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  nextRunAt?: string;
  finishedAt?: string;
  runs: number;
  lastRun?: { at: string; outcome: 'sent' | 'skipped' | 'failed'; threadId?: string; note?: string };
  // Where it runs, once schedules live in the backend (Schedules, "Runners").
  runnerId?: string;
  runnerName?: string;
  runnerIcon?: string; // its SF Symbol (RunnerInfo.icon)
  runRequestedAt?: string;
};

// Who sent a message when it wasn't a person or a client: the runner by
// itself (the resume after a restart), or a schedule (schedules.ts).
// How a message one thread's agent sends another starts (threadbear-mcp.ts).
// The app parses it into a card; the runner knows it isn't from Mike.
export const AGENT_MESSAGE_PREFIX = '[Sent by the agent in the thread ';
// How the `then` of a thread's own move_thread starts: the agent's note to
// itself for after the move, which the app also draws as a card.
export const MOVE_MESSAGE_PREFIX = '[Sent by the agent before moving to ';

// Written by an agent (another thread's, or this one's before a move), not
// typed by Mike, though the runner sends it with no origin.
export function sentByAgent(text: string): boolean {
  return text.startsWith(AGENT_MESSAGE_PREFIX) || text.startsWith(MOVE_MESSAGE_PREFIX);
}

export type MessageOrigin = 'runner' | 'schedule' | 'phone';

export const ErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  badParams: -32602,
  threadNotFound: -32004,
  scheduleNotFound: -32005,
  subagentNotFound: -32006,
  projectNotFound: -32007,
  accountNotFound: -32010,
  busy: -32020,
  moved: -32030, // a draining runner has handed the thread over (Handovers)
  convexSignedOut: -32040, // the runner's Convex CLI isn't signed in ("The Convex panel")
  convexNoAccess: -32041, // its Convex login can't reach the deployment
  backgroundRunning: -32050, // threads.edit without stopBackground while background work runs
  other: -32000,
} as const;

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const LIMITS = {
  toolInputString: 16 * 1024,
  toolResultText: 64 * 1024,
  previewChars: 140,
  titleChars: 60,
  defaultEventsLimit: 500,
};
