// The thread manager: owns threads, turns, the event log, approvals, idle
// release and snoozes. Providers plug in through AgentAdapter; the WebSocket
// server in rpc.ts is a thin layer over the public methods here.
import { RELEASE } from './release.ts';
import type { UserInput } from './adapters/types.ts';
import { INSTRUCTIONS_CLEARED, INSTRUCTIONS_REWOUND } from './instructions.ts';
import { reachable, type Reachable } from './net-probe.ts';
import type { UpstreamStatus } from './upstream.ts';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { SAMPLE_THREADS, WELCOME_PATCH } from './samples.ts';
import { reviewInput, reviewDraft, reviewReply, sameDraft, type ReviewInput } from './reviews.ts';
import path from 'node:path';
import { ConvexKeys, convexFolderFor, type ConvexKey, type ConvexDeployments, type ConvexKeysOptions, type ConvexLogin } from './convex-keys.ts';
import crypto from 'node:crypto';
import type {
  Panel,
  Account,
  Action,
  AnyEvent,
  ApprovalDecision,
  BackgroundTask as ProtocolBackgroundTask,
  CliPolicy,
  CliStatus,
  DeltaBody,
  DeltaType,
  DesignReview,
  ReplyButton,
  ReviewDraft,
  EffortLevel,
  EventBody,
  ImageRef,
  InProgressItem,
  AskAnswer,
  MessageOrigin,
  ModelChoice,
  PanelPlace,
  PanelRequest,
  ShareAccess,
  PermissionMode,
  PersistedEvent,
  Pool,
  Provider,
  Question,
  RewoundFiles,
  RunnerDefaults,
  Subagent,
  ThreadStartedBy,
  ThreadStatus,
  ThreadSummary,
  TurnOutcome,
} from './protocol.ts';
import { agentsStillWorking, ErrorCode, LIMITS, PROTOCOL_VERSION, RpcError, sentByAgent } from './protocol.ts';
import type { ArchivedBy, ArchiveVerdict, LibrarianStatus, Project, Schedule } from './protocol.ts';
import { Projects } from './projects.ts';
import type { Settings } from './settings.ts';
import type {
  AgentAdapter,
  AgentSession,
  AdapterOutput,
  BackgroundTask,
  QuestionAnswer,
  QuestionRequest,
  SessionSink,
  SubagentUpdate,
  ToolApprovalAnswer,
  ToolApprovalRequest,
  TurnResult,
} from './adapters/types.ts';
import { SessionNotFoundError } from './adapters/types.ts';
import type { RewindResult } from './adapters/types.ts';
import type { ThreadRecord, ThreadStore, QueuedSend, SubagentRecord } from './store.ts';
import { cutOut } from './store.ts';
import { appliedChanges, undoChanges } from './undo-edits.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import { BIN_DIR, threadEnv } from './restart.ts';
import { cleanUpWorktree, makeWorktree, sameSubfolder, worktreeInstructions } from './worktrees.ts';
import { stripModelSuffix, type AccountRegistry, type LearnedAccountInfo } from './accounts.ts';
import { pickAccount as pickByRoom, resetTime, type UsageReading } from './usage.ts';
import { DEFAULT_POOL_FOLDERS, RUNNER_VERSION, expandHome, paths, readRunnerJson, writeRunnerJson, type Config } from './config.ts';
import { experimentsOn } from './experiments.ts';
import { WAIT_SLACK_MS, blockedUntil, limitWhy, loginOk, nextLogin, pickInPool, poolAccounts, poolForFolder, poolProviders, readPools, roomWait, validatePools } from './pools.ts';
import { copyImageInto, imageRefFor } from './media.ts';
import { isDirectory } from './fsutil.ts';
import { commandFolders } from './tools.ts';
import { copySessionTranscript, subagentTranscriptPath } from './transcripts.ts';
import { historyItems, selectHistory } from './handoff-history.ts';
import { readSubagentTranscript } from './adapters/claude/subagents.ts';
import { fileContext } from './adapters/claude/normalize.ts';
import { ASK_CODEX_MODEL, HAIKU, type Models } from './models/index.ts';
import { EXPLAIN_SYSTEM, RECENT_CHARS, RECENT_MESSAGES, explainPrompt } from './explain.ts';
import type { ExplainTurn } from './explain.ts';
import { SAID_MAX, WAKE_SYSTEM, awayFor, hibernateNote, localWhen, readWakeAnswer, wakePrompt } from './wake-when.ts';
import { parseWhen } from './when.ts';
import { emptyHighlights, observe as observeHighlights, pinItem, remove as removeHighlight, unpin as unpinHighlight, upsert as upsertHighlight, view as highlightsView, absolute, type ThreadHighlights } from './highlights.ts';
import { SERVER_NAME, approvalTitle } from './threadbear-mcp.ts';
import { PANEL_ACK_WAIT_MS, PANEL_PLACES, resolvePanel } from './panel-requests.ts';
import { archiveFromTool, bylineFromTool, END_TURN_TOOL, endTurnAccepted, endTurnAddedArchive, endTurnAddedSnooze, snoozeFromTool, waitForFromTool, endTurnAsksForMessage, endTurnIsOneReply, endTurnOwesReply, endTurnRefusedRepeat, endTurnTaken, endTurnWantsReply, needsFromText, needsFromTool, replyWithoutRepeat, splitReplySection, summaryFromTool, summaryMarkdown, WakeRead } from './needs.ts';
import type { Needs } from './needs.ts';
import { asksForAppRestart } from './app-restarts.ts';
import type { ConnectorsStatus } from './connectors.ts';
import { isPatchFile, PatchTrust, type ClaudeVerdict, type PatchTrustStore } from './patch-trust.ts';
import { claudeOptions, claudeSettingsWithoutCommands } from './claude-trust.ts';
import {
  EMPTY_PATCH_SET,
  findWorktreePatch,
  hookApplies,
  isInside,
  loadPatchSet,
  applyLive,
  hasLive,
  projectPanels,
  renderListPanel,
  renderPanel,
  runCommand,
  simctlScreenshot,
  type CommandOutcome,
  type PanelRender,
  type PatchCache,
  type PatchSet,
  type ProjectFolder,
  type Screenshot,
  worktreePatchFiles,
  projectPatchFiles,
  webPage,
} from './patches.ts';
import { cutSafely, firstLineSafely, isSafeSlice } from './safe-cut.ts';
import { FolderCache } from './folder-cache.ts';
import { worktreesPart, type WorktreesPart } from './runner/worktrees.ts';
import { networkPart, type NetworkPart } from './runner/network.ts';
import { poolsPart, type PoolsPart } from './runner/pools.ts';
import { handoversPart, type HandoversPart } from './runner/handovers.ts';
import { stoppedWorkPart, type StoppedWorkPart } from './runner/stopped-work.ts';
import { projectsHostPart, type ProjectsHostPart } from './runner/projects-host.ts';
import { approvalsPart, settleDeclined, type ApprovalsPart, type SecretAnswer } from './runner/approvals.ts';
import type { RequestAnswer } from './cross-runner.ts';
import { SecretStore } from './secrets.ts';
import { reviewsPart, type ReviewsPart } from './runner/reviews.ts';
import { buttonsPart, MAX_BUTTONS, type ButtonsPart } from './runner/buttons.ts';
import { clisPart, type ClisPart } from './runner/clis.ts';
import { editingPart, type EditingPart } from './runner/editing.ts';
import { patchesPart, type PatchesPart } from './runner/patches.ts';
import { highlightsPart, type HighlightsPart } from './runner/highlights.ts';
import { titlesPart, type TitlesPart } from './runner/titles.ts';
import { commandsPart, type CommandsPart } from './runner/commands.ts';
import type { SlashCommand } from './slash-commands.ts';
import { hibernationPart, type HibernationPart } from './runner/hibernation.ts';
import { newThreadsPart, type NewThreadsPart } from './runner/new-threads.ts';
import { labReviewPart, type LabReviewPart } from './runner/lab-review.ts';
import { looseEndsPart, type LooseEndsPart } from './runner/loose-ends.ts';
import { CONFINED_NO_SANDBOX, sandboxFor } from './sandbox.ts';

export type Notification =
  | { method: 'thread.updated'; params: { thread: ThreadSummary } }
  | { method: 'thread.event'; params: { threadId: string; event: AnyEvent } }
  | { method: 'thread.deleted'; params: { threadId: string } }
  | { method: 'accounts.updated'; params: { accounts: Account[] } }
  | { method: 'pools.updated'; params: { pools: Pool[] } }
  | { method: 'runner.notice'; params: { level: 'info' | 'warning' | 'error'; message: string } }
  | { method: 'schedules.updated'; params: { schedules: Schedule[] } }
  // Other runners' threads, from the backend (thread-index.ts, step 6 part 2).
  | { method: 'remoteThreads.updated'; params: import('./thread-index.ts').RemoteThreads }
  | { method: 'clis.updated'; params: { clis: CliStatus[] } }
  | { method: 'settings.updated'; params: { settings: Settings } }
  | { method: 'instructions.updated'; params: { instructions: import('./instructions.ts').StandingInstructions } }
  | { method: 'runner.updates'; params: { updates: RunnerUpdates } }
  | { method: 'projects.updated'; params: { projects: Project[] } }
  | { method: 'librarian.updated'; params: { librarian: LibrarianStatus } }
  | { method: 'connectors.updated'; params: { connectors: ConnectorsStatus } }
  // Only from a draining runner, to the primary (handover.ts).
  | { method: 'drain.handedOver'; params: { threadId: string } }
  | { method: 'drain.usage'; params: { accountId: string; reading: UsageReading } };

// hello's `updates` and runner.updates (docs/protocol.md, "Runner updates").
export type RunnerUpdates = {
  state: 'off' | 'idle' | 'checking' | 'building' | 'waiting' | 'failed';
  commit?: string;
  subject?: string;
  reason?: string;
  oldRunners: { version: string; threads: string[] }[];
  launcherChanged?: true;
  launcherReason?: string;
  // Mike's releases, for a fork (upstream.ts); left out while off.
  upstream?: UpstreamStatus;
};

// What the librarian (librarian.ts) hears about threads: a turn that ended,
// and a folder move.
export type ThreadActivity =
  | { kind: 'turn.start'; threadId: string }
  // Any completed turn (its CLI's own too) in a thread another is waiting
  // on for something in particular, for the librarian to judge (met).
  | { kind: 'waited-on'; threadId: string }
  | { kind: 'turn.end'; threadId: string; outcome: TurnOutcome; edited: string[]; workedIn?: string[] }
  | { kind: 'moved'; threadId: string; from: string; to: string };

// The seams to D's and E's modules (usage.ts, updates/), as far as the
// runner uses them. They're structural so tests can pass small fakes.

// D's UsageStore, as the runner uses it: a session's `limits` output goes
// to record().
export type UsageSink = {
  record(accountId: string, reading: UsageReading): void;
  // Fired when what it knows changes enough to tell clients (UsageStore's
  // onChange). The runner then sends accounts.updated through its throttle.
  onChange?(fn: (accountIds: string[]) => void): () => void;
};

// E's CliUpdates, as the runner and rpc.ts use it.
export type CliControl = {
  list(): CliStatus[];
  check(p?: Provider): CliStatus[];
  update(p: Provider, o?: { version?: string; force?: boolean }): CliStatus[];
  setPolicy(p: Provider, policy: CliPolicy): CliStatus[];
  onChange(fn: (clis: CliStatus[]) => void): () => void;
  // Whether a session on `version` got going (its CLI reported a version)
  // or died before it did, for the "failed to start twice" warning.
  sessionStarted?(p: Provider, version: string | undefined, ok: boolean): void;
};

// What E's CliUpdates calls back into (its constructor's `hooks`).
export type CliHooks = {
  restartPending(): boolean;
  releaseIdle(p: Provider, keepVersion: string): void;
  versionsInUse(p: Provider): { version: string; threadIds: string[] }[];
  codexBinariesInUse(): string[];
};

// usage.ts's pickAccount: the account a thread made without one starts on.
export type AccountPicker = (accounts: Account[], lastUsedId: string | undefined) => string | undefined;

// AccountRegistry, plus the onChange D adds (fired when a rescan finds a
// different list).
export type AccountSource = Pick<AccountRegistry, 'list' | 'get' | 'learn'> & { onChange?(fn: () => void): () => void };

// The Codex adapter reports the binaries its live processes run, so E only
// deletes version folders nothing uses. Not on AgentAdapter, since only
// Codex has it.
export type BinaryReporter = { binariesInUse?(): string[] };

// main: the card is for the agent's own tool call, so its CLI waits on it
// and reads nothing else until it's answered. A background subagent's card
// (no tool call of the agent's to point at) holds up only that subagent.
export type PendingApproval =
  // plan: the "Plan first" plan (its itemId) this approval is Claude's ExitPlanMode for.
  // macOnly: its whole input doesn't fit what the phone or another Mac's
  // view shows (tools.ts, remoteCardShowsAll), so only an allow from a
  // client that shows it all counts.
  // title: what it's asking, for telling the agent about a subagent's.
  | { approvalId: string; kind: 'tool'; main: boolean; title?: string; plan?: string; macOnly?: boolean; resolve: (a: ToolApprovalAnswer) => void }
  | { approvalId: string; kind: 'question'; main: boolean; title?: string; questions: Question[]; resolve: (a: QuestionAnswer) => void }
  // An agent's ask_secret (docs/protocol.md, "Secrets"). The value never
  // passes through here: secrets.answer writes the file and hands this the
  // paths.
  | { approvalId: string; kind: 'secret'; main: boolean; resolve: (a: SecretAnswer) => void }
  // create_thread asking for a thread on another runner (cross-runner.ts).
  // check reads the backend's answer, which is the only one it believes.
  | { approvalId: string; kind: 'request'; main: boolean; check: () => Promise<RequestAnswer>; resolve: (a: RequestAnswer) => void };

export type Turn = {
  turnId: string;
  startedAt: number;
  interruptRequested: boolean;
  // A slash command the runner answered itself (runner/commands.ts): no
  // CLI turn, and settings it changed apply from the next one.
  local?: boolean;
  // Started by a slash command the CLI runs. Its output (/cost's table,
  // /model's usage line) isn't a reply asking anything: without an
  // end_turn the turn leaves no card.
  command?: boolean;
  // A compaction, review or clear: the CLI can't take words into it, so
  // they wait for the next turn. A skill's turn is an ordinary one.
  noSteer?: boolean;
  // Opened by the runner for work the CLI started itself (a background
  // shell or async subagent finished, or a background subagent asked for
  // approval). There's no user.message.
  auto?: boolean;
  cliStarted?: boolean; // the CLI is running a turn for it (not just an approval)
  interruptTimer?: TimerHandle;
  // Ids of the messages the CLI has yet to answer for this turn: the one
  // that started it (none for a turn the CLI started itself), then any
  // sent while it ran, which go straight into the CLI. The turn ends when
  // the CLI has answered them all.
  messages: string[];
  // The most access the CLI has had in this turn (accessOf): a Codex turn
  // keeps the mode it started with when the thread is lowered mid-turn.
  access?: PermissionMode;
  // Files the turn edited, wrote or proposed to (edit.diff paths, Write
  // and Edit calls, denied ones too), for hooks that run only after a
  // change to certain files. Never trusted from: see 'wrote'.
  edited: Set<string>;
  // Folders its shell commands worked in (commandFolders), so the
  // librarian knows the repo a thread in a catch-all folder works on.
  workedIn?: Set<string>;
  // The agent's own end_turn input and last text, for what the turn needs
  // from Mike (needs.ts). Never a sub-agent's.
  endTurn?: Record<string, unknown>;
  // What endTurn was before the latest call, until that call's result says
  // whether it replaced it (a repeat doesn't).
  endTurnBefore?: Record<string, unknown>;
  // An end_turn of either form was taken (endTurnTaken): ended is only the
  // one-reply form's, and Codex's bullets form says "Noted. Now write".
  tookEndTurn?: boolean;
  lastText?: string;
  // The agent's latest end_turn call, and whether one was accepted since
  // Mike last wrote. Text after that is dropped: end_turn has already told
  // it to stop, yet an agent repeated its last line under it as a second
  // message (28 Oct 2026).
  endTurnCall?: string;
  // Its end_turn's summary is in the events as the turn's reply.
  summarized?: boolean;
  ended?: boolean;
  // The itemId of the agent's latest text when that was only a summary
  // (assistant.text with narration: a Claude narration block). The first
  // text after an accepted end_turn is then the real message, which
  // end_turn asked for (needs.ts, NARRATION_ONLY): it's kept, not dropped,
  // and takes the summary's itemId so it replaces it.
  narrationItem?: string;
  // The accepted end_turn brought bullets with no message since the last
  // step, and asked whether they stand for one not yet written (needs.ts,
  // BULLETS_ONLY): the first own text after it is that message, kept
  // rather than dropped (30 Oct 2026, thread 2a0a9c2c), when it says more
  // than the bullets, as the app takes it as the reply only then
  // (TranscriptReducer, reply(of:)): a "Done." under them is still a
  // repeat. The bullets' length, while it's owed.
  owedReply?: number;
  // One reply (docs/protocol.md, "One reply"): the accepted end_turn said
  // the reply comes next, so the agent's text after it is kept, streamed
  // and marked `final`, the turn's reply. headline: end_turn gave one, and
  // it's the preview. replyNeeds: the reply ended in a "What I need from
  // you" section, which came off it and stands in for an end_turn with no
  // asks or follow-ups (needs.ts, splitReplySection).
  replyAfter?: boolean;
  headline?: boolean;
  replyNeeds?: Needs;
  // The Stop hook sent this turn back to call end_turn, so what it already
  // wrote is the reply (threadbear-mcp.ts, needs.ts oneReplyAlreadyWritten).
  endTurnNudged?: boolean;
  // Whether the agent has read a background task's notification that came
  // into the turn (needs.ts, WakeRead).
  wake?: WakeRead;
};

type Runtime = {
  session?: AgentSession;
  generation: number;
  closing?: Promise<void>;
  releasedGen?: number; // generation of the session being released on purpose
  resumed: boolean; // the live session was started with resume
  retriedFresh: boolean;
  // News of the standing instructions went out in this turn (settleInstructionsNews).
  instructionsNewsSent?: boolean;
  // Where the live session's transcript was carried from, if it moved
  // folder; used only if resuming the copy fails.
  carried?: ThreadRecord['handoff'];
  deleted?: boolean; // anything the old CLI still reports is dropped
  turn?: Turn;
  // When the live CLI last said anything, and whether it looks frozen
  // (frozen-cli.ts): the check's clock, and what an interrupt has to know.
  lastOutputAt?: number;
  frozen?: boolean;
  tasks: BackgroundTask[]; // background work the live CLI is running
  // The version of the CLI running the live session, from its cliVersion
  // output (Codex reports it; Claude doesn't yet).
  cliVersion?: string;
  // A CLI update came in while this session ran on the old version: it's
  // released the next time it's idle (no turn, approval, queued message,
  // background work or wake grace), and the next message resumes on the
  // new one. Background work is never stopped for it.
  versionMove?: boolean;
  // The live Claude session started without the folder's own Claude Code
  // settings, as they run commands that aren't trusted: the hash it
  // skipped (claude-trust.ts). `claudeNoted` is the last one said in the
  // thread, so a session restart doesn't say it again.
  claudeSkipped?: string;
  // Started in Full with the folder's settings, which hold permission
  // rules not trusted for a thread that asks first (StartSessionOptions.heldGrants).
  claudeHeldGrants?: boolean;
  claudeNoted?: string;
  // The installed version when the live session was started (what E says
  // new sessions start on), and whether it has got going since.
  startVersion?: string;
  started?: boolean;
  // Archived here while its CLI was live: archived in the CLI's own app
  // once that CLI has exited, so a second process never touches the thread
  // while the live one still has it loaded.
  archivePending?: boolean;
  // The archived thread's worktree cleanup while it runs: a handover waits
  // for it before saving the record, or its result is lost (THREADBEAR-16).
  cleaning?: Promise<void>;
  // Background work that ended and whose result the CLI hasn't started a
  // turn to read yet. Shown as `finished` in the summary's background list
  // while wakeTimer runs; cleared when that turn starts or the grace ends.
  finished: BackgroundTask[];
  // Set when background work finished with no turn running: the CLI is
  // about to start a turn of its own to look at the result, and until it
  // does (or WAKE_GRACE_MS passes) the thread isn't idle.
  wakeTimer?: TimerHandle;
  // Background work finished while a turn was running. If the model was
  // already writing its last message, the CLI holds the notification and
  // starts a turn of its own after the result, so the wake grace starts
  // when the turn ends.
  taskEndedInTurn?: boolean;
  activeAt: number; // last turn start or end, for picking which CLI to release
  approvals: Map<string, PendingApproval>;
  idleTimer?: TimerHandle;
  releaseWhenIdle: boolean;
  inProgress: Map<string, InProgressItem>;
  pendingDeltas: Map<string, { type: DeltaType; text: string }>;
  deltaTimer?: TimerHandle;
  // What the folder's patches give the thread (patches.ts). Read again in
  // the background when the folder changes or PATCHES_TTL_MS has passed,
  // and a new summary goes out if anything differs, so a `convex dev` that
  // has just written .env.local, or a patch file the agent has just
  // written, shows up within seconds. Until the first read finishes the
  // built-in panels stand in.
  // `base` is the set as the files give it; `set` is that with live state
  // applied (applyLive), which is what the app sees. `live`: base has any.
  patches?: { cwd: string; key: string; at: number; base: PatchSet; set: PatchSet; refreshing: boolean; loaded: boolean; live?: boolean };
  runningActions?: Set<string>;
  // Turns in a row that a hook's message started, per hook. A hook that
  // keeps failing stops being told to the agent after HOOK_TELL_LIMIT, so
  // two can't go round for ever; a message from anyone else resets it.
  hookTurns?: Map<string, number>;
  // Turn-end hooks still running; a draining runner waits for them, since
  // one may tell the agent something and start a turn.
  hooksRunning?: number;
  // A show_panel call waiting to hear the app has shown its request
  // (threads.panelShown), for at most PANEL_ACK_WAIT_MS.
  panelWaiter?: { id: string; resolve: (shown: boolean) => void; timer: TimerHandle };
  // An edit of an earlier message is under way (editMessage): nothing
  // starts a turn until it has, and messages sent meanwhile wait.
  editing?: boolean;
  // Called when the running turn ends (endTurn), for an edit waiting on it.
  turnEndWaiters?: (() => void)[];
  // The done card's loose-ends check (runner/loose-ends.ts): which run is
  // the latest, so an older one finishing late is dropped, and when it began.
  looseEndsRun?: number;
  looseEndsAt?: number;
};

export type ThreadState = { rec: ThreadRecord; rt: Runtime };

export type Drain = {
  keep: Set<string>;
  going: Set<string>; // being let go
  gone: Set<string>; // let go: the new runner's now (mustGet)
  onHandedOver: (threadId: string) => void;
  since: number;
  backgroundMs: number;
  agentMs: number;
  checkMs: number;
  checkQueued: boolean;
  ready: () => boolean;
  timer?: TimerHandle;
};

// How often a draining runner looks again at threads it keeps for
// background work, since that work's limit passes without an event.
export const DRAIN_CHECK_MS = 5000;
// How long background shells and monitors hold a kept thread after its last
// turn. Most are waits that end by themselves, and the runner updates after
// every landing: at 30 minutes, nearly every long wait was cut off (1 Nov:
// a scan's wait, 4.5 hours of silence). A dev server does sit out the limit,
// but that costs one old runner process, and only one per thread that has
// work going, since a kept thread doesn't get kept again.
export const DRAIN_BACKGROUND_MS = 4 * 60 * 60_000;
// A thread in use never reaches that limit, and would stay on the old release
// for as long as its dev server ran. Past this long there, it goes across
// after a much shorter quiet spell.
export const DRAIN_MAX_OLD_MS = 12 * 60 * 60_000;
export const DRAIN_SETTLE_MS = 30 * 60_000;
// How long subagents hold a kept thread after its last turn. Long, since
// they end by themselves; only a stuck one should ever reach it.
export const DRAIN_AGENT_MS = 4 * 60 * 60_000;

export type RunnerDeps = {
  // The release it runs, when not this code's own (tests).
  release?: string;
  config: Config;
  store: ThreadStore;
  adapters: Record<string, AgentAdapter>;
  accounts: AccountSource;
  // D's UsageStore: live readings go to it, and its changes reach clients.
  usage?: UsageSink;
  // Which account a thread made without one starts on; usage.ts's
  // pickAccount (the most room) unless a test swaps it.
  pickAccount?: AccountPicker;
  clock: Clock;
  log: Logger;
  // Coalesces summary saves and thread.updated; tests pass a synchronous one.
  defer?: (fn: () => void) => void;
  // Copies a Claude session's transcript to another folder (transcripts.ts);
  // tests swap it out.
  copyTranscript?: typeof copySessionTranscript;
  // Where a sub-agent's transcript is (transcripts.ts); tests point it at a fixture.
  subagentTranscript?: typeof subagentTranscriptPath;
  // Takes the Simulator panel's screenshot (patches.ts); tests pass a fake.
  screenshot?: Screenshot;
  // Where patches stop being looked for up the folder tree (the home folder).
  panelsRoot?: string;
  // Which project patch files may load (patch-trust.ts). Defaults to
  // patch-trust.json in the data dir; tests not about trust pass TRUST_ALL.
  patchTrust?: PatchTrustStore;
  // The shell command actions run through, and how long they may take;
  // tests pass /bin/sh -c and a short limit.
  actionShell?: string[];
  actionTimeoutMs?: number;
  // A worktree's setup and turn hooks run at background priority
  // (background.ts) unless this is false. Tests not about priority turn it
  // off, as a background shell can wait seconds for a core on a busy Mac.
  backgroundJobs?: boolean;
  // Opens a url action's page, for an app too old to open it itself
  // (runAction); tests pass a fake rather than starting a browser.
  openUrl?: (url: string) => Promise<void>;
  // Runs the Convex CLI for the Convex panel's deploy keys (convex-keys.ts);
  // tests pass a fake that writes the key file the CLI would.
  convexKeyRun?: (command: string, cwd: string) => Promise<CommandOutcome>;
  convexKeyOptions?: ConvexKeysOptions; // the CLI's login file, sign-in command and key check, for tests
  // The runner's own small-model calls (models/index.ts), for titles.
  // Absent in most tests, which then keep the first-line title.
  models?: Pick<Models, 'generate'>;
  // Projects (projects.ts): their folders' patches, the brief a session
  // starts with, and the summary's `projects`. Started by start().
  projects?: Projects;
  /** Mike's standing instructions for every session (instructions.ts); '' for none. */
  standingInstructions?: () => string;
  // A completed turn asked Mike to Restart to Update, by end_turn or in its
  // closing "What I need from you" (app-restarts.ts signs the thread up).
  appRestartAsked?: (threadId: string) => void;
  // Whether Mike is at this Mac, as presence last found it (presence.ts);
  // undefined when it hasn't been checked. Only read for phone messages.
  atMac?: () => boolean | undefined;
  // Whether a provider's API can be reached (net-probe.ts), for threads
  // whose turn failed because it couldn't be; tests pass a fake.
  reachable?: Reachable;
};

// The note Mike's pick from the done card's Archive menu leaves in the
// thread (threads.update's verdict).
const ARCHIVE_NOTES: Record<ArchiveVerdict, string> = {
  worked: 'Archived by you: it worked.',
  didntWork: "Archived by you: it didn't work.",
  notNeeded: 'Archived by you: not needed any more.',
};

const DELTA_INTERVAL_MS = 33; // at most ~30 delta flushes a second per thread
// An interrupted turn that the CLI hasn't ended by then is ended anyway, so
// a CLI that never answers can't leave a thread stuck as running.
const INTERRUPT_GRACE_MS = 10_000;
// How long notices from startup are shown to clients that connect later.
const STARTUP_NOTICE_MS = 10 * 60_000;
// How long a finished background task keeps the thread counted as busy
// while the CLI gets round to its own turn (usually well under a second).
const WAKE_GRACE_MS = 15_000;
// How long a thread's patches are kept before the folder is read again.
export const PATCHES_TTL_MS = 15_000;
// How long a folder listing (and a patch file's time, a .env) read for one
// thread's patches serves every other thread in the same folders
// (folder-cache.ts). A turn ending forgets them, as it may have added one.
export const FOLDER_CACHE_MS = 10_000;
// How often a thread whose patches have live state (when, badge) has it
// read again by itself, while it's in the inbox: comments Mike leaves in
// Tandem turn into a "Your turn" chip within this long.
export const LIVE_POLL_MS = 20_000;
// How long a live state command's output serves every thread in the same
// folder (runLiveCommand): well inside one poll, so each poll runs it again.
export const LIVE_SHARE_MS = 10_000;
// How often the account list is read again, so a new login is noticed
// (and its models asked for) without a client asking.
const ACCOUNT_RESCAN_MS = 10_000;
// accounts.updated: the first change goes out at once, then at most one
// this often, always ending on the latest list.
const ACCOUNTS_THROTTLE_MS = 5_000;
// How many turns in a row one hook may start with its result.
export const HOOK_TELL_LIMIT = 2;
// How much of a hook's output goes to the agent (the transcript has it all).
export const HOOK_TELL_CHARS = 8000;
// snoozedUntil for a thread hibernating until the runner next starts: far
// enough off that everything reading snoozedUntil (the lists, the resume
// after a restart, a client older than snoozedUntilRestart) sees it as
// snoozed, and start() wakes it long before.
export const UNTIL_RESTART = '9999-12-31T00:00:00.000Z';
// snoozedUntil for a thread waiting on a topic alone (wake-when.ts), or
// while its time is worked out: the same far-off time, without the flag.
export const NO_WAKE_TIME = UNTIL_RESTART;

// Parts of the Runner that live in runner/ (see each file's top).
export interface Runner extends LooseEndsPart, LabReviewPart, NewThreadsPart, HibernationPart, TitlesPart, HighlightsPart, PatchesPart, EditingPart, ClisPart, ReviewsPart, ButtonsPart, ApprovalsPart, ProjectsHostPart, StoppedWorkPart, HandoversPart, PoolsPart, NetworkPart, WorktreesPart, CommandsPart {}
export class Runner {
  // While main.ts is still starting up: waking a thread for its waits
  // (reconcileWaits) would start a CLI whose tools aren't ready, so they
  // wait for main.ts's own reconcileWaits once it's listening.
  holdWaits = false;
  // The schedules that send to a thread (main.ts sets it from the
  // Scheduler), for the done card's loose ends.
  schedulesFor?: (threadId: string) => Schedule[];
  // The release this runner runs (none from a source checkout), for
  // threads hibernating until a new one (snoozedUntil "release"). Tests set it.
  release: string | undefined = RELEASE.release;
  cfg: Config;
  store: ThreadStore;
  adapters: Record<string, AgentAdapter>;
  accounts: AccountSource;
  usage?: UsageSink;
  // Each login and folder's slash commands, for the picker (runner/commands.ts).
  commandCache = new Map<string, { at: number; commands: SlashCommand[] }>();
  pickAccount: AccountPicker;
  clis?: CliControl;
  clock: Clock;
  log: Logger;
  defer: (fn: () => void) => void;
  copyTranscript: typeof copySessionTranscript;
  subagentTranscript: typeof subagentTranscriptPath;
  screenshot: Screenshot;
  panelsRoot?: string;
  actionShell?: string[];
  actionTimeoutMs?: number;
  backgroundJobs: boolean;
  openUrl: (url: string) => Promise<void>;
  convexKeys: ConvexKeys;
  // Where answers to ask_secret go, and the key the phone seals them to.
  secrets: SecretStore;
  models?: Pick<Models, 'generate'>;
  projects?: Projects;
  standingInstructions?: () => string;
  activity = new Set<(a: ThreadActivity) => void>();
  patchCache: PatchCache = new Map();
  patchTrust: PatchTrustStore;
  folderCache: FolderCache;
  sharedPatchSets = new Map<string, { at: number; set: Promise<PatchSet> }>();
  patchReads = new Set<Promise<void>>();
  liveRuns = new Map<string, { doneAt?: number; out: Promise<CommandOutcome> }>();
  // Each folder's Claude settings verdict for its patch list, read again
  // as often as the folders are (claudePatchInfo).
  claudeChecks = new Map<string, { at: number; verdict: ClaudeVerdict }>();
  threads = new Map<string, ThreadState>();
  listeners = new Set<(n: Notification) => void>();
  dirty = new Set<string>();
  flushScheduled = false;
  snoozeTimer?: TimerHandle;
  stopping = false;
  // Set while this runner drains after a handover (docs/protocol.md,
  // "Handovers"): the threads it still keeps, and who hears when one goes.
  draining?: Drain;
  refusing?: string;
  startedAt = 0;
  startupNotices: { level: 'info' | 'warning' | 'error'; message: string }[] = [];
  // Accounts whose CLI has been asked for its models (or is being asked).
  probed = new Set<string>();
  rescanTimer?: TimerHandle;
  liveTimer?: TimerHandle;
  accountsTimer?: TimerHandle;
  accountsSentAt = -Infinity;
  accountsShown?: string; // the last list clients were sent (or got in hello's time)
  // E's last Codex status, to notice an update activating (or a first
  // copy arriving where there was none) as against E working out what's
  // installed when it starts.
  codexVersion?: string;
  codexMissing = false;
  // The version E last asked sessions to move to, per provider.
  wantedVersion: Partial<Record<Provider, string>> = {};
  unsubs: (() => void)[] = [];
  // Pools (docs/protocol.md, "Pools"): the timer for threads waiting for
  // room, the list clients were last sent, and logins a turn found at
  // their limit, blocked here until the time given even when the usage
  // readings haven't caught up.
  roomTimer?: TimerHandle;
  armingRoom = false;
  poolsShown?: string;
  // Pools shared through the backend (shared-pools.ts); main.ts sets it
  // when sync is on. Without it, or until it has a list, the pools are
  // runner.json's or the built-in ones.
  sharedPools?: import('./shared-pools.ts').SharedPools;
  ranDry = new Map<string, number>();
  // Threads waiting for the API to be reachable again (waitingForNetwork):
  // one timer probes for all of them, backing off from NET_PROBE_FIRST_MS.
  netTimer?: TimerHandle;
  netProbes = 0;
  probing = false;
  reachable: Reachable;
  appRestartAsked?: (threadId: string) => void;
  atMac?: () => boolean | undefined;

  constructor(deps: RunnerDeps) {
    if ('release' in deps) this.release = deps.release;
    this.cfg = deps.config;
    this.store = deps.store;
    this.copyTranscript = deps.copyTranscript ?? copySessionTranscript;
    this.subagentTranscript = deps.subagentTranscript ?? subagentTranscriptPath;
    this.screenshot = deps.screenshot ?? simctlScreenshot;
    this.panelsRoot = deps.panelsRoot;
    this.patchTrust = deps.patchTrust ?? new PatchTrust({ file: path.join(deps.config.home, 'patch-trust.json') });
    this.actionShell = deps.actionShell;
    this.actionTimeoutMs = deps.actionTimeoutMs;
    this.backgroundJobs = deps.backgroundJobs ?? true;
    this.openUrl = deps.openUrl ?? openInBrowser;
    this.convexKeys = new ConvexKeys(
      path.join(paths.secrets(deps.config.home), 'convex-panels'),
      deps.convexKeyRun ?? ((command, cwd) => runCommand(command, { cwd, env: { ...process.env }, shell: this.actionShell, timeoutMs: 120_000 })),
      undefined,
      deps.convexKeyOptions,
    );
    this.secrets = new SecretStore(paths.secrets(deps.config.home), () => this.clock.now());
    this.models = deps.models;
    this.projects = deps.projects;
    this.standingInstructions = deps.standingInstructions;
    this.appRestartAsked = deps.appRestartAsked;
    this.atMac = deps.atMac;
    this.adapters = deps.adapters;
    this.accounts = deps.accounts;
    this.usage = deps.usage;
    this.pickAccount = deps.pickAccount ?? pickByRoom;
    this.clock = deps.clock;
    this.folderCache = new FolderCache(FOLDER_CACHE_MS, () => this.clock.now());
    this.log = deps.log;
    this.defer = deps.defer ?? ((fn) => setImmediate(fn));
    this.reachable = deps.reachable ?? reachable;
  }

  // ---------------------------------------------------------------- startup

  // Loads threads from disk. Threads that were mid-turn when the runner
  // stopped become `stopped`; approvals they were waiting on expire.
  //
  // `skip` are threads a draining runner still has (a handover): they stay
  // on disk untouched until it hands them over and adopt() loads them.
  start(opts: { skip?: ReadonlySet<string> } = {}): void {
    this.startedAt = this.clock.now();
    const { records, broken } = this.store.loadAll();
    for (const id of broken) {
      if (opts.skip?.has(id)) continue;
      const rec = this.rebuild(id);
      if (rec) records.push(rec);
    }
    let stopped = 0;
    for (const rec of records) {
      if (opts.skip?.has(rec.id)) continue;
      // thread.json is saved a moment after the event it follows; the log
      // is the truth for seq.
      rec.lastSeq = this.store.log(rec.id).lastSeq;
      const st: ThreadState = { rec, rt: newRuntime(Date.parse(rec.lastActivityAt) || 0) };
      this.threads.set(rec.id, st);
      if (rec.asked === undefined && !rec.archivedAt) this.backfillAsked(rec);
      this.recoverReviews(st);
      if (this.recover(st)) stopped++;
    }
    // carryOnStopped (main.ts, once listening) carries most of them on and
    // says so; this notice is for a runner that never gets that far.
    if (stopped) this.startupNotice('info', `${stopped === 1 ? 'A thread was' : `${stopped} threads were`} mid-turn when the runner stopped.`);
    // Hibernating until the runner restarts: this is the restart. Before
    // the restart's resume (main.ts), so a thread put away while its own
    // restart waited still gets carried on.
    // A wake-when still being worked out lost its answer with the old
    // runner, so it comes back too.
    for (const st of this.threads.values()) if (this.wakesOnStart(st.rec)) this.wake(st, 'restart');
    // Before anything reads a thread's patches. Every thread on disk,
    // including ones a draining runner still has.
    this.seedPatchTrust(records.map((r) => r.cwd));
    this.flush();
    void this.settleLostCleanups();
    for (const st of this.threads.values()) if (st.rec.queue.some(q => q.reviewId) && this.bucket(st.rec) === 'inbox') this.kickQueue(st);
    this.armSnoozeTimer();
    // Waits for room are in thread.json, so they outlive a restart.
    this.armRoomTimer();
    // So are waits for the network.
    this.armNetTimer(true);
    this.log.info('runner loaded threads', { count: this.threads.size });
    this.accountsShown = accountsKey(this.safeAccounts());
    this.poolsShown = JSON.stringify(this.pools());
    void this.probeModels();
    // Usage readings and a rescan that finds another list both reach
    // clients through the same throttle as what the probes learn.
    if (this.usage?.onChange) this.unsubs.push(this.usage.onChange(() => this.accountsChanged()));
    if (this.accounts.onChange) this.unsubs.push(this.accounts.onChange(() => this.accountsChanged()));
    this.armRescan();
  }

  // Asks each account's CLI for its model list, one account at a time so
  // startup doesn't spawn three CLIs at once. Clients hear through
  // accounts.updated; a failure just leaves the list unknown. `only` picks
  // some accounts: a login that has just appeared, or every Codex account
  // after a Codex update (a new version can change the list).
  async probeModels(only?: (a: Account) => boolean): Promise<void> {
    const targets = this.safeAccounts().filter((a) => !only || only(a));
    for (const a of targets) this.probed.add(a.id);
    for (const account of targets) {
      if (this.stopping) return;
      const adapter = this.adapters[account.provider];
      if (!adapter?.models) continue;
      try {
        const models = await adapter.models(account);
        this.learnAccount(account.id, { models });
      } catch (e) {
        this.log.warn('could not read the model list', { accountId: account.id, error: String(e) });
      }
    }
  }

  learnAccount(accountId: string, info: LearnedAccountInfo): void {
    if (!this.accounts.learn(accountId, info)) return;
    this.accountsChanged();
  }

  safeAccounts(): Account[] {
    try {
      return this.accounts.list();
    } catch (e) {
      this.log.warn('could not list the accounts', { error: String(e) });
      return [];
    }
  }

  // Reads the account list again every ACCOUNT_RESCAN_MS, so a login added
  // in Token Stats shows up in the app (and gets its models asked for)
  // without a reconnect.
  armRescan(): void {
    this.rescanTimer?.cancel();
    this.rescanTimer = this.clock.setTimeout(() => {
      this.rescanTimer = undefined;
      if (this.stopping) return;
      this.rescanAccounts();
      this.armRescan();
    }, ACCOUNT_RESCAN_MS);
  }

  rescanAccounts(): void {
    const list = this.safeAccounts();
    const fresh = new Set(list.filter((a) => !this.probed.has(a.id)).map((a) => a.id));
    if (fresh.size) void this.probeModels((a) => fresh.has(a.id));
    if (accountsKey(list) !== this.accountsShown) this.accountsChanged();
  }

  // accounts.updated, level-triggered: the first change goes out at once,
  // then at most one every ACCOUNTS_THROTTLE_MS, read when it goes so it's
  // always the latest list.
  accountsChanged(): void {
    if (this.accountsTimer || this.stopping) return;
    const wait = this.accountsSentAt + ACCOUNTS_THROTTLE_MS - this.clock.now();
    if (wait <= 0) {
      this.sendAccounts();
      return;
    }
    this.accountsTimer = this.clock.setTimeout(() => {
      this.accountsTimer = undefined;
      if (!this.stopping) this.sendAccounts();
    }, wait);
  }

  sendAccounts(): void {
    const accounts = this.safeAccounts();
    // The built-in pools follow the login list.
    const pools = this.pools(accounts);
    const poolsKey = JSON.stringify(pools);
    if (poolsKey !== this.poolsShown) {
      this.poolsShown = poolsKey;
      this.notify({ method: 'pools.updated', params: { pools } });
    }
    const key = accountsKey(accounts);
    // A change that went back to what clients already have isn't news.
    if (key === this.accountsShown) return;
    this.accountsShown = key;
    this.accountsSentAt = this.clock.now();
    this.notify({ method: 'accounts.updated', params: { accounts } });
  }

  // A thread folder whose thread.json can't be read: rebuild what can be
  // read from its events, rather than have it disappear. Settings that live
  // only in thread.json (folder, account, session) fall back to defaults,
  // and the next message starts a new session with a handoff note.
  rebuild(id: string): ThreadRecord | undefined {
    const log = this.store.log(id);
    if (log.lastSeq === 0) return undefined;
    const events = log.read(1, log.lastSeq);
    const first = events[0];
    const last = events[events.length - 1];
    const firstMsg = events.find((e) => e.type === 'user.message');
    const lastText = [...events].reverse().find((e) => e.type === 'assistant.text');
    const lastStarted = [...events].reverse().find((e) => e.type === 'turn.started');
    const open = lastStarted && !events.some((e) => e.type === 'turn.completed' && e.turnId === lastStarted.turnId);
    const lastCompleted = [...events].reverse().find((e) => e.type === 'turn.completed');
    const rewinds = events.flatMap((e) => (e.type === 'thread.rewound' ? [{ from: e.fromSeq, to: e.toSeq }] : []));
    const accountId = this.defaultAccountId();
    const rec: ThreadRecord = {
      id,
      title: firstMsg && firstMsg.type === 'user.message' ? titleFrom(firstMsg.text) : 'Untitled',
      cwd: this.cfg.defaults.cwd,
      accountId,
      // The account's own, so a Codex default never starts the Claude CLI
      // with CLAUDE_CONFIG_DIR=~/.codex.
      provider: this.accounts.get(accountId)?.provider ?? 'claude',
      // Unknown, so the safer one.
      permissionMode: 'ask',
      status: open ? 'running' : 'idle',
      createdAt: first.ts,
      updatedAt: last.ts,
      lastActivityAt: last.ts,
      preview: lastText && lastText.type === 'assistant.text' ? oneLine(lastText.text, LIMITS.previewChars) : '',
      lastSeq: log.lastSeq,
      lastSeenSeq: log.lastSeq,
      nativeSessionId: crypto.randomUUID(),
      sessionUsed: false,
      lastTurnCompletedSeq: lastCompleted?.seq ?? 0,
      queue: [],
      pendingApprovals: [],
      handoff: { fromCwd: this.cfg.defaults.cwd, fromAccountId: accountId, rebuilt: true },
    };
    const reviews = new Map<string, DesignReview>();
    for (const event of events) if (event.type === 'review.updated') reviews.set(event.review.id, event.review);
    if (reviews.size) rec.reviews = [...reviews.values()];
    const buttons = new Map<string, ReplyButton>();
    for (const event of events) if (event.type === 'button.updated') buttons.set(event.button.id, event.button);
    if (buttons.size) rec.buttons = [...buttons.values()].slice(-MAX_BUTTONS);
    if (rewinds.length) rec.rewinds = rewinds;
    if (open && lastStarted) rec.turnId = lastStarted.turnId;
    this.log.warn('thread.json was unreadable; rebuilt it from the event log', { threadId: id });
    this.store.setAside(id);
    try {
      this.store.save(rec);
    } catch (e) {
      this.log.error('could not save a rebuilt thread', { threadId: id, error: String(e) });
    }
    const st: ThreadState = { rec, rt: newRuntime(0) };
    this.emit(st, {
      type: 'system.note',
      text: `This thread's settings couldn't be read, so its folder, account and permission mode were reset to ${rec.cwd}, ${accountId} and ask. The next message starts a new session.`,
    });
    return rec;
  }

  // Returns true if the thread was mid-turn.
  recover(st: ThreadState): boolean {
    const { rec } = st;
    // A sub-agent can't outlive the runner that started its CLI.
    this.stopSubagents(st);
    // Waiting with no turn is only a subagent's card, and that subagent is
    // gone: there's no turn to pick up again.
    const onlyCards = rec.status === 'waiting' && !rec.turnId;
    if (onlyCards) rec.status = 'idle';
    const midTurn = rec.status === 'starting' || rec.status === 'running' || rec.status === 'waiting';
    if (!midTurn && rec.pendingApprovals.length === 0 && rec.queue.length === 0) return false;
    // The turn may have ended on disk just before a crash stopped
    // thread.json being saved; then it only needs its status back.
    const ended = midTurn && rec.turnId ? this.findTurnCompleted(rec.id, rec.turnId) : undefined;
    // thread.json can be behind the log (a crash before it was saved): a card
    // may have been answered there, and a later "expired" would replace the
    // answer. A turn that ended there closed its own cards, but a subagent's
    // outlives its turn, so go by what the log says (Codex review).
    const resolved = new Set<string>();
    if (rec.pendingApprovals.length) {
      const log = this.store.log(rec.id);
      for (const e of log.read(1, log.lastSeq)) if (e.type === 'approval.resolved') resolved.add(e.approvalId);
    }
    for (const approvalId of rec.pendingApprovals) {
      if (resolved.has(approvalId)) continue;
      this.emit(st, { type: 'approval.resolved', approvalId, decision: 'expired', message: 'The runner restarted.' }, ended ? undefined : rec.turnId);
    }
    rec.pendingApprovals = [];
    if (midTurn && ended) {
      rec.lastTurnCompletedSeq = Math.max(rec.lastTurnCompletedSeq, ended.seq);
      rec.status = ended.type === 'turn.completed' && ended.outcome === 'failed' ? 'error' : 'idle';
      rec.turnId = undefined;
    } else if (midTurn) {
      if (rec.turnId) {
        const ev = this.emit(
          st,
          { type: 'turn.completed', turnId: rec.turnId, outcome: 'interrupted', durationMs: 0, error: 'The runner stopped during this turn.' },
          rec.turnId,
        );
        rec.lastTurnCompletedSeq = ev.seq;
        // When it was last doing something: a crash or a power cut leaves
        // no time of its own.
        rec.stoppedMidTurn = { turnId: rec.turnId, at: rec.lastActivityAt };
      }
      rec.turnId = undefined;
      rec.status = 'stopped';
    }
    // A snoozed or archived thread holds its queue until it comes back, and
    // nothing sends it before then anyway, so a restart (planned or not)
    // leaves it for the wake-up to send. That includes a snooze that ended
    // while the runner was down: start() wakes it straight after loading.
    // Anything else queued was cut off.
    if (rec.queue.length && !midTurn && (rec.snoozedUntil !== undefined || rec.archivedAt !== undefined)) {
      this.markDirty(st);
      return false;
    }
    const reviewQueue = rec.queue.filter(q => q.reviewId);
    rec.queue = rec.queue.filter(q => !q.reviewId);
    if (rec.queue.length) {
      const texts = rec.queue.map((q) => q.text).filter(Boolean);
      this.emit(st, {
        type: 'system.note',
        text: `The runner restarted before ${rec.queue.length === 1 ? 'a queued message was' : `${rec.queue.length} queued messages were`} sent:\n\n${texts.join('\n\n')}`,
      });
      rec.queue = [];
    }
    rec.queue.push(...reviewQueue);
    this.markDirty(st);
    return midTurn && !ended;
  }

  findTurnCompleted(threadId: string, turnId: string): PersistedEvent | undefined {
    const log = this.store.log(threadId);
    return log
      .read(Math.max(1, log.lastSeq - 200), log.lastSeq)
      .reverse()
      .find((e) => e.type === 'turn.completed' && e.turnId === turnId);
  }

  // Called before the CLIs are killed. Turns in flight end the way startup
  // recovery would end them, rather than as failures when their CLI dies.
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.snoozeTimer?.cancel();
    this.roomTimer?.cancel();
    this.netTimer?.cancel();
    this.rescanTimer?.cancel();
    this.accountsTimer?.cancel();
    this.liveTimer?.cancel();
    for (const off of this.unsubs.splice(0)) off();
    for (const st of this.threads.values()) {
      const { rt } = st;
      rt.idleTimer?.cancel();
      rt.deltaTimer?.cancel();
      rt.wakeTimer?.cancel();
      this.flushDeltas(st);
      // Output and exits from CLIs that are about to be killed no longer count.
      rt.generation++;
      if (rt.turn) this.stopTurn(st);
      // Killing the CLIs kills their background shells and subagents too.
      // Say so in the thread, as releaseSession does, or it would wait for
      // a result that never comes with nothing to say why.
      rt.finished = [];
      this.stopSubagents(st);
      if (rt.tasks.length) {
        const what = rt.tasks.map((t) => t.description || t.type).join('; ');
        this.rememberStoppedWork(st);
        rt.tasks = [];
        try {
          this.emit(st, { type: 'system.note', text: `Stopped background work when the runner stopped: ${what}` });
        } catch (e) {
          this.log.error('could not save a note', { threadId: st.rec.id, error: String(e) });
        }
      }
    }
    this.flush();
  }

  // ------------------------------------------------------------- handovers
  // docs/protocol.md, "Handovers".

  // ---------------------------------------------------- stopped background work
  // docs/protocol.md, "Stopped background work". A handover or restart stops
  // work the thread is counting on, usually a wait it promised to report
  // back from (1 Nov: Mike asked "Is this still going?" 4.5 hours later).
  // The note alone wakes nobody, so the next runner tells the thread.

  // From the moment a restart begins until the runner exits, a new turn
  // would only be cut off straight away, so sends and new threads are
  // refused with a message saying to send again in a moment.
  refuseNewTurns(message: string): void {
    this.refusing = message;
  }

  checkAccepting(): void {
    if (this.refusing) throw new RpcError(ErrorCode.busy, this.refusing);
  }

  stopTurn(st: ThreadState): void {
    const { rec, rt } = st;
    const turn = rt.turn!;
    this.persistInProgress(st, turn.turnId);
    this.expireApprovals(st, 'The runner stopped.');
    const ev = this.emit(
      st,
      {
        type: 'turn.completed',
        turnId: turn.turnId,
        outcome: 'interrupted',
        durationMs: Math.max(0, this.clock.now() - turn.startedAt),
        error: 'The runner stopped during this turn.',
      },
      turn.turnId,
    );
    turn.interruptTimer?.cancel();
    rt.turn = undefined;
    rec.turnId = undefined;
    rec.lastTurnCompletedSeq = ev.seq;
    rec.status = 'stopped';
    rec.stoppedMidTurn = { turnId: turn.turnId, at: this.isoNow() };
    rec.lastActivityAt = this.isoNow();
    this.markDirty(st);
  }

  // Text that streamed but never got its complete frame is kept as what the
  // user saw.
  persistInProgress(st: ThreadState, turnId: string): void {
    const { rt } = st;
    this.flushDeltas(st);
    for (const item of rt.inProgress.values()) {
      if (!item.text) continue;
      this.emit(
        st,
        item.type === 'assistant.text'
          ? { type: 'assistant.text', itemId: item.itemId, text: item.text }
          : { type: 'reasoning', itemId: item.itemId, text: item.text },
        turnId,
      );
    }
    rt.inProgress.clear();
  }

  // ------------------------------------------------------------- listeners

  onNotification(fn: (n: Notification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // For the runner's neighbours (schedules.ts) to tell every client.
  publish(n: Notification): void {
    this.notify(n);
  }

  // Turn ends and folder moves, for the librarian.
  onThreadActivity(fn: (a: ThreadActivity) => void): () => void {
    this.activity.add(fn);
    return () => this.activity.delete(fn);
  }

  tellActivity(a: ThreadActivity): void {
    for (const fn of this.activity) {
      try {
        fn(a);
      } catch (e) {
        this.log.error('activity listener failed', { error: String(e) });
      }
    }
  }

  // ---------------------------------------------------- for projects.ts

  notify(n: Notification): void {
    // A kept thread's summary changing can be it becoming free to go.
    if (this.draining && n.method === 'thread.updated') this.queueHandoverCheck();
    for (const fn of this.listeners) {
      try {
        fn(n);
      } catch (e) {
        this.log.error('listener failed', { error: String(e) });
      }
    }
  }

  notice(level: 'info' | 'warning' | 'error', message: string): void {
    this.notify({ method: 'runner.notice', params: { level, message } });
  }

  // A notice about startup, also sent to clients that connect in the next
  // few minutes (the app is rarely connected while the runner starts).
  startupNotice(level: 'info' | 'warning' | 'error', message: string): void {
    this.startupNotices.push({ level, message });
    this.notice(level, message);
  }

  // Sent to each client after its hello.
  noticesForNewClient(): { level: 'info' | 'warning' | 'error'; message: string }[] {
    const out = this.clock.now() - this.startedAt < STARTUP_NOTICE_MS ? [...this.startupNotices] : [];
    if (!fs.existsSync(this.cfg.claudePath)) {
      out.push({ level: 'error', message: `The claude CLI isn't at ${this.cfg.claudePath}, so no turn can start. Install Claude Code, or set claudePath in runner.json.` });
    }
    return out;
  }

  // --------------------------------------------------------------- queries

  hello(): { runnerVersion: string; protocol: number; accounts: Account[]; pools: Pool[]; defaults: RunnerDefaults; clis?: CliStatus[]; experiments?: string[] } {
    const accounts = this.accounts.list();
    const pools = this.pools(accounts);
    const defaults: RunnerDefaults = { cwd: this.cfg.defaults.cwd, accountId: this.defaultAccountId(accounts) };
    const poolId = this.defaultPoolId(pools, this.usable(accounts), defaults.accountId);
    if (poolId) defaults.poolId = poolId;
    // `model` is Claude's, for apps that predate `models`.
    const claudeModel = this.defaultModelFor('claude');
    if (claudeModel) defaults.model = claudeModel;
    if (this.cfg.defaults.models) defaults.models = { ...this.cfg.defaults.models };
    if (this.cfg.defaults.efforts) defaults.efforts = { ...this.cfg.defaults.efforts };
    // Experiments on here, for the ones that live in the app (Voice mode).
    const out: ReturnType<Runner['hello']> = { runnerVersion: RUNNER_VERSION, protocol: PROTOCOL_VERSION, accounts, pools, defaults, experiments: experimentsOn(this.cfg.home) };
    const clis = this.cliList();
    if (clis) out.clis = clis;
    return out;
  }

  // The account a thread made without one starts on (tb new, create_thread,
  // schedules) and hello's defaults.accountId: the one with the most room
  // among the last-used account's provider (usage.ts, pickAccount), worked
  // out again each time so it follows usage. Without usage it's the last
  // one used.
  defaultAccountId(all = this.accounts.list()): string {
    // Only accounts this runner can start a CLI for.
    const accounts = all.filter((a) => this.adapters[a.provider]);
    const json = readRunnerJson(this.cfg.home).defaults;
    const saved = json?.accountId ?? this.cfg.defaults.accountId;
    const last = saved && accounts.some((a) => a.id === saved) ? saved : (accounts.find((a) => a.id === 'claude-main')?.id ?? accounts[0]?.id);
    if (json?.keepAccount && last) return last;
    let picked: string | undefined;
    try {
      picked = this.pickAccount(accounts, last);
    } catch (e) {
      this.log.warn('could not pick an account', { error: String(e) });
    }
    if (picked && accounts.some((a) => a.id === picked)) return picked;
    return last ?? 'claude-main';
  }

  // What a thread on this provider gets when it names no model: the
  // runner's default for that provider, or for Claude the older single
  // default. Undefined means the account's own.
  defaultModelFor(provider: Provider): string | undefined {
    return this.cfg.defaults.models?.[provider] ?? (provider === 'claude' ? this.cfg.defaults.model : undefined);
  }

  defaultEffortFor(provider: Provider): EffortLevel | undefined {
    return this.cfg.defaults.efforts?.[provider];
  }

  // ------------------------------------------------------------------ pools
  // docs/protocol.md, "Pools". The rules are in pools.ts; this is where
  // they meet threads.

  // With ids, only those threads (threads.list's ids): a draining runner
  // looking one up mustn't be sent all 900 (docs/protocol.md, "Handovers").
  list(include: ('inbox' | 'snoozed' | 'archived')[] = ['inbox'], ids?: string[]): ThreadSummary[] {
    const want = new Set(include);
    const out: ThreadSummary[] = [];
    const states = ids ? [...new Set(ids)].flatMap((id) => this.threads.get(id) ?? []) : this.threads.values();
    for (const st of states) {
      if (want.has(this.bucket(st.rec))) out.push(this.summary(st));
    }
    return sortByActivity(out);
  }

  bucket(rec: ThreadRecord): 'inbox' | 'snoozed' | 'archived' {
    if (rec.archivedAt) return 'archived';
    if (rec.snoozedUntil && Date.parse(rec.snoozedUntil) > this.clock.now()) return 'snoozed';
    return 'inbox';
  }

  search(query: string, limit = 50): ThreadSummary[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: ThreadSummary[] = [];
    for (const st of this.threads.values()) {
      const hay = `${st.rec.title}\n${st.rec.preview}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(this.summary(st));
    }
    return sortByActivity(out).slice(0, Math.max(0, Math.floor(limit)));
  }

  // For end_turn's handler: whether the Stop hook sent the running turn back
  // to call it.
  endTurnNudged(threadId: string): boolean {
    return this.threads.get(threadId)?.rt.turn?.endTurnNudged === true;
  }

  get(threadId: string): ThreadSummary {
    return this.summary(this.mustGet(threadId));
  }

  // What a sub-agent has done so far, from the CLI's transcript of it.
  subagent(threadId: string, subagentId: string): { subagent?: Subagent; events: PersistedEvent[] } {
    const { rec } = this.mustGet(threadId);
    const known = rec.subagents?.find((a) => a.id === subagentId);
    const cwd = known?.cwd ?? rec.cwd;
    const account = this.accounts.get(known?.accountId ?? rec.accountId);
    const sessionId = known?.sessionId ?? rec.nativeSessionId;
    const file = account && sessionId ? this.subagentTranscript(account.configDir, cwd, sessionId, subagentId) : null;
    if (!file) throw new RpcError(ErrorCode.subagentNotFound, `There's no record of sub-agent ${subagentId} in this thread`);
    const ctx = fileContext(cwd, this.store.mediaDir(rec.id), path.join(this.store.blobsDir(rec.id), 'subagents'));
    let read: ReturnType<typeof readSubagentTranscript>;
    try {
      read = readSubagentTranscript(file, ctx);
    } catch (e) {
      throw new RpcError(ErrorCode.subagentNotFound, `Couldn't read sub-agent ${subagentId}'s transcript: ${String(e)}`);
    }
    const now = this.isoNow();
    const events = read.map((e, i) => ({ seq: i + 1, ts: e.ts ?? now, threadId, ...e.body }) as PersistedEvent);
    return known ? { subagent: publicSubagent(known), events } : { events };
  }

  events(threadId: string, opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}) {
    const st = this.mustGet(threadId);
    const log = this.store.log(threadId);
    const last = log.lastSeq;
    const limit = Math.min(Math.max(1, opts.limit ?? LIMITS.defaultEventsLimit), 10_000);
    let from: number;
    let to: number;
    if (opts.afterSeq !== undefined) {
      from = opts.afterSeq + 1;
      to = Math.min(last, opts.beforeSeq !== undefined ? opts.beforeSeq - 1 : last, from + limit - 1);
    } else if (opts.beforeSeq !== undefined) {
      to = Math.min(last, opts.beforeSeq - 1);
      from = Math.max(1, to - limit + 1);
    } else {
      to = last;
      from = Math.max(1, last - limit + 1);
    }
    const events = log.read(from, to);
    // Flush first so inProgress holds exactly what subscribers have seen.
    this.flushDeltas(st);
    return {
      events,
      firstSeq: events.length ? events[0].seq : 0,
      lastSeq: events.length ? events[events.length - 1].seq : last,
      inProgress: [...st.rt.inProgress.values()].filter((i) => i.text),
    };
  }

  // Backlog for a subscriber, read in the same tick it starts listening so
  // nothing falls between the replay and the live stream.
  backlog(threadId: string, afterSeq = 0): { events: PersistedEvent[]; inProgress: InProgressItem[] } {
    const st = this.mustGet(threadId);
    this.flushDeltas(st);
    const log = this.store.log(threadId);
    return {
      events: log.read(afterSeq + 1, log.lastSeq),
      inProgress: [...st.rt.inProgress.values()].filter((i) => i.text),
    };
  }

  // ------------------------------------------------------------- mutations

  // The first user.message's text and the first assistant.text after it,
  // read a page at a time from the start: both are nearly always within
  // the first few events, and a long thread's log is large.
  opening(id: string, rec?: Pick<ThreadRecord, 'rewinds'>): { text?: string; images?: number; reply?: string } {
    const log = this.store.log(id);
    let text: string | undefined;
    let images = 0;
    for (let from = 1; from <= Math.min(log.lastSeq, 500); from += 50) {
      for (const e of log.read(from, from + 49)) {
        if (rec && cutOut(rec, e.seq)) continue;
        if (text === undefined && e.type === 'user.message') {
          text = e.text;
          images = e.images?.length ?? 0;
        } else if (text !== undefined && e.type === 'assistant.text' && e.text.trim()) return { text, images, reply: e.text };
      }
    }
    return { text, images };
  }

  // origin "runner" marks a message the runner sends by itself (restart.ts),
  // "schedule" one a schedule sent (schedules.ts). `queue` keeps it out of a
  // running turn: it waits and starts its own.
  send(threadId: string, text: string, images: ImageRef[] = [], opts: SendOptions = {}): { turnId: string } {
    const st = this.mustGet(threadId);
    this.checkAccepting();
    // A thread a draining runner is letting go of is about to be the new
    // runner's; a message queued here now would be lost on the way. The Mac
    // app sends it again on the new runner by these words
    // (AppModel.turnedAwayByRestart), so keep them.
    if (this.draining && !this.draining.keep.has(threadId)) throw new RpcError(ErrorCode.busy, 'The runner is handing over to a new one; send again in a moment.');
    if (!text && images.length === 0) throw new RpcError(ErrorCode.badParams, 'text or images required');
    // Its turn was made up; a real agent picking it up would only be lost.
    if (st.rec.sample) throw new RpcError(ErrorCode.badParams, "This is one of the tour's sample threads, so nothing can be sent to it. Start a new thread to try it for real.");
    checkImages(images);
    return { turnId: this.sendTo(st, text, images, opts) };
  }

  sendTo(st: ThreadState, text: string, images: ImageRef[], opts: SendOptions = {}): string {
    const { rec, rt } = st;
    if (opts.origin !== 'runner') {
      rt.hookTurns = undefined;
      delete rec.stoppedWorkWakes;
      // A new ask from Mike: its change can be reviewed afresh.
      delete rec.labReviews;
    }
    // Copy images into the thread's own media folder now, so a queued
    // message still works if inbox/ is cleaned before it's sent.
    const media = this.store.mediaDir(rec.id);
    const refs = images.map((img) => {
      if (!img?.path || !fs.existsSync(img.path)) throw new RpcError(ErrorCode.badParams, `Image not found: ${img?.path}`);
      if (path.dirname(img.path) === media) return imageRefFor(img.path, img.mediaType);
      try {
        return copyImageInto(media, img.path);
      } catch (e) {
        throw new RpcError(ErrorCode.badParams, (e as Error).message);
      }
    });
    // New work: its last finish no longer says it's done, for threads
    // waiting on it (runner/hibernation.ts).
    delete rec.finished;
    // Sending to a snoozed or archived thread brings it back. A schedule's
    // message notes it came out of the archive, so the run can put it back
    // if it ends with nothing for Mike (the end of the turn, below).
    if (rec.archivedAt && opts.origin === 'schedule') rec.unarchivedBySchedule = { by: rec.archivedBy };
    if (fromMike(text, opts)) delete rec.unarchivedBySchedule;
    if (rec.snoozedUntil || rec.archivedAt) {
      delete rec.snoozedUntil;
      delete rec.snoozedUntilRestart;
      delete rec.untilRelease;
      delete rec.wakeWhen;
      delete rec.waitingOn;
      delete rec.archivedAt;
      rt.releaseWhenIdle = false;
    }
    // Answering it from his phone without opening it counts as having seen it woke.
    if (fromMike(text, opts)) delete rec.woke;
    this.supersedeReviews(st, text, opts);
    // He has seen the reply a waiting panel went with.
    if (rec.panelRequest && fromMike(text, opts)) {
      delete rec.panelRequest;
      this.endPanelWait(st, false);
      this.markDirty(st);
    }
    const turnId = crypto.randomUUID();
    const msg: QueuedSend = { turnId, text, images: refs };
    if (opts.origin) msg.origin = opts.origin;
    if (opts.scheduleId) msg.scheduleId = opts.scheduleId;
    if (opts.answers?.length) msg.answers = opts.answers;
    if (opts.editOf) msg.editOf = opts.editOf;
    rec.lastActivityAt = this.isoNow();
    if (rt.turn && !opts.queue && fromMike(text, opts) && this.switchWaiting(st)) {
      // He picked another login (another provider, usually) during this
      // turn, then wrote: the message is for the new one, now, as in T3
      // Code. This turn stops and the message starts the next one there,
      // with the handoff. Steering it into the old CLI would answer it on
      // the model he just moved away from.
      rec.queue.push(msg);
      this.emit(st, { type: 'system.note', text: `Stopped here so ${this.modelLabel(rec)} can take over.` }, rt.turn.turnId);
      this.markDirty(st);
      this.interrupt(rec.id);
      return turnId;
    }
    // A message from Mike while a plan waits (and isn't Claude's approval,
    // which the card-declining below sends back): he's answering it in
    // words, so it goes back for another go.
    if (rec.openPlan && fromMike(text, opts) && ![...rt.approvals.values()].some((p) => p.kind === 'tool' && p.plan === rec.openPlan)) {
      this.emit(st, { type: 'plan.resolved', itemId: rec.openPlan, decision: 'revise' }, rt.turn?.turnId);
      delete rec.openPlan;
      this.markDirty(st);
    }
    if (rt.turn && rt.approvals.size && fromMike(text, opts)) {
      // He wrote instead of using the card. The CLI is parked on the card's
      // answer and won't read anything else until it has one, so a message
      // steered or queued now would sit unread behind it for good. Declining
      // the card lets the CLI move on and take the message next.
      for (const [approvalId, pending] of [...rt.approvals]) {
        if (!pending.main) continue;
        this.resolveApproval(st, approvalId, 'deny', WROTE_INSTEAD);
        settleDeclined(pending, 'deny', WROTE_INSTEAD);
      }
    }
    // A slash command waits for the turn to end rather than going into it:
    // a CLI runs one only as a message of its own, and the runner's own
    // change settings for the next turn.
    if (rt.turn && !opts.queue && this.canSteer(st) && !this.commandPlan(st, text)) {
      // Sent while a turn runs: it goes into that turn now, as typing into
      // the CLI would. The CLI takes it at its next step, or straight after
      // its reply if that was already finishing; either way the thread's
      // turn goes on until it's answered, so the caller gets that turn's id.
      this.steer(st, msg);
      return rt.turn.turnId;
    }
    if (rt.turn || rec.queue.length || this.draining || rt.editing) {
      // Behind a running turn, or behind messages that couldn't start
      // earlier: they go first. On a draining runner a thread with no turn
      // is usually about to move across, and the message goes with it
      // (kickQueue starts it here if background work is holding the thread).
      rec.queue.push(msg);
      this.markDirty(st);
      this.kickQueue(st);
      return turnId;
    }
    this.startTurn(st, msg);
    return turnId;
  }

  // A message sent during a turn can go into it only while the CLI is
  // there to take it and nothing is set to change under it: not while a
  // CLI is still starting or leaving, not behind messages already waiting,
  // not once a move or a fresh CLI is due on the next turn (the message is
  // meant for that), not after Stop was pressed (the CLI would cancel it
  // with the rest), and not into a turn opened only for a card, where
  // there's no CLI turn to join.
  canSteer(st: ThreadState): boolean {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn || !rt.session || rt.closing || this.stopping || rt.editing) return false;
    if (rec.queue.length || rec.handoff || rec.moved || rt.releaseWhenIdle || turn.interruptRequested) return false;
    // Nor into a compaction or review (a skill's turn takes them).
    if (turn.noSteer || turn.local) return false;
    return !turn.auto || Boolean(turn.cliStarted);
  }

  // A move to another login is waiting for the next turn while this one
  // runs on the old login's CLI.
  switchWaiting(st: ThreadState): boolean {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn || !rt.session || turn.interruptRequested || (turn.auto && !turn.cliStarted) || rt.editing) return false;
    return Boolean(rec.handoff && rec.handoff.fromAccountId !== rec.accountId);
  }

  // "Opus 5.5", or the login's name when there's no model to name.
  modelLabel(rec: ThreadRecord): string {
    const account = this.accounts.get(rec.accountId);
    if (!account) return rec.accountId;
    const model = rec.model ?? account.defaultModel;
    return model ? modelTitle(account, model) : account.title;
  }

  // Shows the message in the running turn and hands it to the CLI. If the
  // event can't be written the message isn't sent, and the caller gets the
  // error (the app puts the draft back).
  steer(st: ThreadState, msg: QueuedSend): void {
    const { rt } = st;
    const turn = rt.turn!;
    this.emit(st, userMessage(msg), turn.turnId);
    turn.messages.push(msg.turnId);
    // He wrote again, so the turn owes him another reply.
    turn.ended = false;
    turn.owedReply = undefined;
    // ...and an archive it asked for before reading this is off: "wait, one
    // more thing" shouldn't send the thread away. It can ask again.
    if (turn.endTurn?.archive) turn.endTurn = { ...turn.endTurn, archive: false };
    this.markDirty(st);
    // A change reaches a running turn too, or a clear could wait out as many
    // messages as were sent into it (Codex review).
    this.sendWithInstructionsNews(st, { id: msg.turnId, text: this.forAgent(msg), images: msg.images });
  }

  // A turn that had its end_turn, opened again once the agent has read a
  // background task's notification (7 Nov 2026, thread 46de9389). Unlike a
  // message (steer) nothing new is owed to Mike, but the work after it is the
  // turn's latest: its text is kept and becomes the preview, and the card
  // that was taken stands only until the next end_turn. A "What I need from
  // you" the reply had (replyNeeds) stands until then too, as the agent may
  // stop without another. A one-reply turn's text stays its reply (replyAfter,
  // marked final), so a report written after the wake shows even without a
  // new end_turn (TranscriptReducer, reply(of:), picks among them).
  seeWake(turn: Turn, ev: { type: string; itemId?: string; wake?: true }): void {
    turn.wake ??= new WakeRead();
    if (!turn.wake.see(ev) || !(turn.ended || turn.tookEndTurn)) return;
    turn.ended = false;
    turn.owedReply = undefined;
    turn.headline = false;
    turn.summarized = false;
    turn.narrationItem = undefined;
  }

  // The text the agent gets for a message. One from the phone says so, and
  // whether he's still at the Mac, so the agent doesn't hand him a Mac-only
  // step while he's out and keeps the reply short. It goes on every phone
  // message rather than once, as he moves between the two. The transcript
  // keeps what he typed.
  forAgent(msg: { text: string; origin?: MessageOrigin }): string {
    if (msg.origin !== 'phone') return msg.text;
    const atMac = this.atMac?.();
    const where = atMac === true ? ', at the Mac' : atMac === false ? ', away from the Mac' : '';
    return `[Sent from the iPhone app${where}]\n${msg.text}`;
  }

  // Writes the turn's first events before changing any state, so if the
  // disk refuses (full, permissions) the thread is left as it was rather
  // than stuck on a turn that never started.
  startTurn(st: ThreadState, msg: QueuedSend): void {
    const { rec, rt } = st;
    // New work (a review's answer comes this way without sendTo).
    delete rec.finished;
    // A review can be replayed after a failed turn.started append. Its
    // stable message ID keeps the original user row rather than duplicating it.
    const hasReviewMessage = msg.reviewId && this.store.log(rec.id).read(1, rec.lastSeq).some(e => e.type === 'user.message' && e.reviewId === msg.reviewId && e.turnId === msg.turnId);
    if (!hasReviewMessage) this.emit(st, userMessage(msg), msg.turnId);
    try {
      this.emit(st, { type: 'turn.started', turnId: msg.turnId }, msg.turnId);
    } catch (e) {
      this.markDirty(st);
      throw e;
    }
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    rt.turn = { turnId: msg.turnId, startedAt: this.clock.now(), interruptRequested: false, messages: [msg.turnId], edited: new Set(), access: rec.permissionMode };
    rt.activeAt = this.clock.now();
    rec.turnId = msg.turnId;
    rec.lastActivityAt = this.isoNow();
    // Any turn ends a wait for room: a message from Mike goes through the
    // same check as the runner's own carry-on would.
    if (rec.waitingForRoom) {
      delete rec.waitingForRoom;
      this.armRoomTimer();
    }
    // Likewise a wait for the network: a message from Mike goes now, and
    // if the line's still down it fails and the wait starts over. A turn
    // that isn't the runner's carry-on ends that outage's count.
    delete rec.waitingForNetwork;
    if (rec.netCarryOn && rec.netCarryOn.turnId !== msg.turnId) delete rec.netCarryOn;
    this.beforeTurn(st);
    // A subagent's card can still be open (docs/protocol.md, "A subagent's card").
    rec.status = rt.session && !rt.closing ? (rt.approvals.size ? 'waiting' : 'running') : 'starting';
    this.markDirty(st);
    // A message to the thread (not a turn the CLI opened by itself), so the
    // librarian can file a new thread before its first turn is over.
    if (!this.stopping) this.tellActivity({ kind: 'turn.start', threadId: rec.id });
    this.deliver(st, msg).catch((e: unknown) => {
      this.log.error('could not start turn', { threadId: rec.id, error: String(e) });
      this.failTurn(st, e instanceof Error ? e.message : String(e));
    });
  }

  async deliver(st: ThreadState, msg: QueuedSend): Promise<void> {
    const { rec, rt } = st;
    // A folder, account or settings change asked for a fresh CLI, or a CLI
    // update came in since this one started.
    if (rt.session && (rt.releaseWhenIdle || rec.handoff || (rt.versionMove && rt.tasks.length === 0))) this.releaseSession(st);
    // The folder's Claude Code hooks were trusted since the CLI started
    // without them, or new ones came that aren't (a pull): a fresh CLI
    // reads the folder's settings again.
    else if (rt.session && rec.provider === 'claude' && Boolean(rt.claudeSkipped) === this.patchTrust.checkClaude(rec.cwd, claudeOptions(rec)).trusted) this.releaseSession(st);
    // Never two live CLIs on one session: wait for a releasing one to exit.
    while (rt.closing) await rt.closing;
    // An archive's worktree cleanup still running: where this turn starts
    // depends on whether it removed the folder (leaveRemovedWorktree), and
    // a CLI started there meanwhile would have the folder taken from under it.
    while (rt.cleaning) await rt.cleaning;
    if (rt.turn?.turnId !== msg.turnId) return; // interrupted while waiting
    const local = this.runLocalCommand(st, msg);
    if (local === true || (local !== false && (await local))) return;
    // A slash command reaches the CLI as typed: anything put in front of it
    // (the phone's line, project news) would make it words to the model.
    const command = this.commandPlan(st, msg.text);
    if (command && rt.turn) {
      rt.turn.command = true;
      if (/^\/(compact|review|clear)\b/i.test(msg.text.trim())) rt.turn.noSteer = true;
    }
    let text = command ? msg.text : this.forAgent(msg);
    // Claude's CLI starts a new session for /clear, which the runner follows
    // (its next init), but says nothing.
    if (command && rec.provider === 'claude' && /^\/clear\b/i.test(msg.text.trim())) {
      this.emit(st, { type: 'system.note', text: 'Cleared the conversation. The agent starts fresh from your next message; the transcript above stays here for you.' }, msg.turnId);
      // The same CLI goes on with the system prompt it started with, and
      // whatever a message told it has gone (Codex review).
      if (rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
    }
    if (!rt.session && rec.worktreePending) {
      await this.prepareWorktree(st, msg.turnId);
      if (rt.turn?.turnId !== msg.turnId) return; // interrupted during setup
    }
    if (!rt.session) {
      const left = this.leaveRemovedWorktree(st, msg.turnId);
      if (left) text = `${left}\n\n${text}`;
    }
    if (!rt.session) {
      const account = this.accounts.get(rec.accountId);
      if (!account) throw new Error(`Account ${rec.accountId} isn't available on this Mac.`);
      // Said in the thread as the turn's failure, so it says how to carry on.
      if (!isDirectory(rec.cwd)) throw new Error(`Folder not found: ${rec.cwd}. Pick another folder for this thread from the + menu by the message box, then send again.`);
      if (rec.handoff && this.carryTranscript(st, account)) {
        // A new folder, or another Claude login: the whole conversation
        // came along.
        const from = rec.handoff;
        const text =
          from.fromAccountId === rec.accountId
            ? `Moved to ${rec.cwd}. The session carries on there.`
            : from.fromCwd === rec.cwd
              ? `Resumed the session on ${account.title}, with the whole conversation.`
              : `Moved to ${rec.cwd} on ${account.title}. The session carries on there, with the whole conversation.`;
        this.emit(st, { type: 'system.note', text }, msg.turnId);
        rt.carried = rec.handoff;
        delete rec.handoff;
      } else if (rec.handoff) {
        text = this.handoffNote(st, account) + text;
        // A quick ask's thread never had a session, so nothing to say.
        if (!rec.handoff.quickAsk) this.emit(st, { type: 'system.note', text: `Started a new session in ${rec.cwd} on ${account.title}.` }, msg.turnId);
        rec.nativeSessionId = crypto.randomUUID();
        rec.sessionUsed = false;
        rec.sessionCostTotal = 0;
        delete rec.handoff;
      } else if (rec.sessionUsed && !rec.moved) {
        this.emit(st, { type: 'system.note', text: 'Resumed session' }, msg.turnId);
      }
      this.makeRoomForCli(st);
      this.startSession(st, account);
    }
    // Projects the session hasn't been told about: one it was put in while
    // live, or since it last ran. A fresh session got them as instructions.
    // Kept for the next message when this one is a command.
    const news = command ? undefined : this.projectNews(rec);
    if (news) text = `${news}\n\n${text}`;
    if (rec.moved) {
      // A CLI that moves folders itself: the live session got setCwd, or a
      // released one resumes in the new folder (startSession passes it).
      this.emit(st, { type: 'system.note', text: `Moved to ${rec.cwd}. The session carries on there.` }, msg.turnId);
      delete rec.moved;
    }
    // Kept for the next message when this one is a command, as the news is.
    if (command) rt.session!.send({ id: msg.turnId, text, images: msg.images });
    else this.sendWithInstructionsNews(st, { id: msg.turnId, text, images: msg.images });
    if (msg.reviewId && !rec.reviewDeliveries?.includes(msg.reviewId)) {
      (rec.reviewDeliveries ??= []).push(msg.reviewId);
      // A persisted transcript row is not proof of dispatch: both initial
      // events are written before session.send. Mark receipt only afterwards.
      try { this.store.save(rec); } catch (e) {
        this.log.error('could not save review delivery', {threadId: rec.id, reviewId: msg.reviewId, error: String(e)});
      }
      this.markDirty(st);
    }
  }

  // Keeps the number of live CLIs at cfg.maxLive by releasing the one idle
  // the longest. CLIs with a turn, an approval, queued messages or
  // background work are never picked; if every other one is busy the cap
  // is passed rather than stopping work.
  // A folder move, or a move from one Claude login to another (a pool
  // move or a pick by hand), copies the session's transcript to the new
  // folder and config dir so it resumes with everything, rather than a
  // short note. Anything else (another provider, a rebuilt record, a
  // transcript that can't be found) gets the handoff note, as does a
  // resume that then fails (onExited).
  carryTranscript(st: ThreadState, account: Account): boolean {
    const { rec } = st;
    const from = rec.handoff;
    // Claude only: it copies Claude's own transcript files. Codex moves
    // folders in the same session (movesFolders) and never gets here.
    if (rec.provider !== 'claude') return false;
    if (!from || from.rebuilt) return false;
    const sameLogin = from.fromAccountId === rec.accountId;
    if (sameLogin && from.fromCwd === rec.cwd) return false;
    const fromAccount = sameLogin ? account : this.accounts.get(from.fromAccountId);
    if (fromAccount?.provider !== 'claude') return false;
    if (!rec.sessionUsed || !rec.nativeSessionId) return false;
    const ok = this.copyTranscript(fromAccount.configDir, account.configDir, from.fromCwd, rec.cwd, rec.nativeSessionId);
    if (!ok) this.log.info('could not carry the transcript across; using a handoff note', { threadId: rec.id, from: from.fromAccountId, to: rec.accountId });
    return ok;
  }

  // Threads working now: a turn, a background job or a sub-agent going,
  // for keeping the Mac awake (keep-awake.ts).
  workingThreads(): number {
    let n = 0;
    for (const { rec, rt } of this.threads.values()) {
      if (rt.deleted) continue;
      if (rt.turn || rt.tasks.length || rec.subagents?.some((a) => a.status === 'running')) n++;
    }
    return n;
  }

  makeRoomForCli(starting: ThreadState): void {
    const live = [...this.threads.values()].filter((t) => t !== starting && t.rt.session && !t.rt.closing);
    if (live.length < this.cfg.maxLive) return;
    const idle = live
      .filter((t) => !t.rt.turn && t.rt.approvals.size === 0 && t.rec.queue.length === 0 && t.rt.tasks.length === 0)
      .sort((a, b) => a.rt.activeAt - b.rt.activeAt);
    for (const t of idle.slice(0, live.length - this.cfg.maxLive + 1)) {
      this.log.info('releasing the longest-idle CLI to stay under the cap', { threadId: t.rec.id, maxLive: this.cfg.maxLive });
      this.releaseSession(t);
    }
  }

  startSession(st: ThreadState, account: Account): void {
    const { rec, rt } = st;
    const adapter = this.adapters[rec.provider];
    if (!adapter) throw new Error(`This runner can't run ${providerName(rec.provider)} threads.`);
    if (!rec.nativeSessionId) rec.nativeSessionId = crypto.randomUUID();
    const gen = ++rt.generation;
    const resume = Boolean(rec.sessionUsed);
    const sink: SessionSink = {
      output: (o) => {
        if (rt.generation !== gen) return;
        rt.lastOutputAt = this.clock.now();
        try {
          this.onOutput(st, o);
        } catch (e) {
          // Most likely the disk (full, permissions). The CLI carries on;
          // say so rather than let the error look like a CLI crash.
          this.log.error('could not handle CLI output', { threadId: rec.id, kind: o.kind, error: String(e) });
          this.notice('error', `Couldn't save part of "${rec.title}": ${(e as Error).message}`);
        }
      },
      requestApproval: (req) => this.requestApproval(st, gen, req),
      requestQuestion: (req) => this.requestQuestion(st, gen, req),
      exited: (err) => this.onExited(st, gen, err),
    };
    rt.resumed = resume;
    rt.cliVersion = undefined;
    rt.versionMove = false;
    rt.started = false;
    rt.startVersion = this.cliList()?.find((c) => c.provider === rec.provider)?.installedVersion;
    // Read now, not from the patch list's cache: a pull just before this
    // message may have brought hooks.
    // A thread shut in a sandbox starts in one or not at all (the adapters
    // check too); one that starts in one is shut in it from now on.
    const inSandbox = rec.provider === 'claude' && this.sandboxed(rec.cwd);
    if (rec.confined && !inSandbox) throw new Error(rec.provider === 'claude' ? CONFINED_NO_SANDBOX(rec.cwd) : "This thread runs in a sandbox, and Codex can't, so it wasn't started. Move it to a Claude login.");
    if (inSandbox) rec.confined = true;
    const claude = rec.provider === 'claude' ? this.patchTrust.checkClaude(rec.cwd, claudeOptions(rec)) : undefined;
    rt.claudeSkipped = claude && !claude.trusted ? claude.hash : undefined;
    rt.claudeHeldGrants = Boolean(claude?.trusted && rec.permissionMode === 'full' && !this.patchTrust.checkClaude(rec.cwd, { grants: true }).trusted);
    rt.session = adapter.start(
      {
        threadId: rec.id,
        cwd: rec.cwd,
        account,
        model: rec.model,
        effort: rec.effort,
        permissionMode: rec.permissionMode,
        ...(rec.confined ? { confined: true } : {}),
        sessionId: rec.nativeSessionId,
        resume,
        ...(resume && rec.resumeAt ? { resumeAt: rec.resumeAt } : {}),
        mediaDir: this.store.mediaDir(rec.id),
        blobsDir: this.store.blobsDir(rec.id),
        tmpDir: path.join(paths.run(this.cfg.home), 'tmp'),
        allowRules: rec.allowRules ?? [],
        env: threadEnv(rec.id, this.cfg.home),
        ...this.briefFor(rec, resume),
        ...(rt.claudeSkipped ? { untrustedProjectSettings: claudeSettingsWithoutCommands(rec.cwd) } : {}),
        // Read at each call, from the thread's folder then.
        runsAsCode: (file) => this.writeRunsAsCode(rec, file),
        ...(rt.claudeHeldGrants ? { heldGrants: true } : {}),
      },
      sink,
    );
    if (claude && !claude.trusted) this.noteClaudeSkipped(st, claude);
    this.log.info('session started', { threadId: rec.id, resume, accountId: account.id, ...(rec.resumeAt ? { resumeAt: rec.resumeAt } : {}) });
    this.markDirty(st);
  }

  onOutput(st: ThreadState, o: AdapterOutput): void {
    const { rec, rt } = st;
    switch (o.kind) {
      case 'event': {
        let ev = o.event;
        if (rt.turn) this.seeWake(rt.turn, ev);
        // Text after an accepted end_turn (see Turn.ended), dropped before
        // it can become the preview or a second message. Unless the reply
        // was a narration block's summary: then this is the reply, in the
        // summary's place. Thinking after it is dropped too: Opus mused
        // "I'd already wrapped up" under its summary (29 Oct 2026).
        if (rt.turn?.replyAfter && (ev.type === 'assistant.text' || ev.type === 'reasoning') && !ev.itemId.includes('/')) {
          // One reply: this is the reply (or the thinking before it, which
          // folds into the work), not text to drop. A "What I need from
          // you" section comes off it when end_turn brought no card of its
          // own, and becomes the card (needs.ts, splitReplySection). When
          // end_turn did bring asks, one repeating them just comes off
          // (replyWithoutRepeat).
          if (ev.type === 'assistant.text') {
            const tool = rt.turn.endTurn ? needsFromTool(rt.turn.endTurn) : undefined;
            const split = !tool?.asks?.length && !tool?.next?.length ? splitReplySection(ev.text) : undefined;
            if (split?.needs) {
              rt.turn.replyNeeds = split.needs;
              this.log.info('took the card from the reply', { threadId: rec.id, needs: split.needs.needs, asks: split.needs.asks?.length ?? 0 });
            }
            const text = split?.needs ? split.reply : tool?.asks?.length ? replyWithoutRepeat(ev.text, tool) : ev.text;
            ev = { type: 'assistant.text', itemId: ev.itemId, text, final: true, ...(ev.narration ? { narration: true as const } : {}) };
          }
        } else if (ev.type === 'assistant.text' && rt.turn?.ended && !ev.itemId.includes('/') && rt.turn.narrationItem && !rt.turn.summarized && ev.text.trim()) {
          rt.inProgress.delete(ev.itemId);
          this.log.info('replaced a summary with the text after end_turn', { threadId: rec.id, chars: ev.text.length });
          ev = { type: 'assistant.text', itemId: rt.turn.narrationItem, text: ev.text };
          rt.turn.narrationItem = undefined;
        } else if (ev.type === 'assistant.text' && rt.turn?.ended && rt.turn.owedReply !== undefined && !ev.itemId.includes('/') && ev.text.trim().length > rt.turn.owedReply) {
          this.log.info('kept the message after end_turn its bullets stood for', { threadId: rec.id, chars: ev.text.length });
          rt.turn.owedReply = undefined;
        } else if ((ev.type === 'assistant.text' || ev.type === 'reasoning') && rt.turn?.ended && !ev.itemId.includes('/')) {
          rt.inProgress.delete(ev.itemId);
          this.log.info('dropped text after end_turn', { threadId: rec.id, chars: ev.text.length });
          break;
        }
        if (ev.type === 'assistant.text' || ev.type === 'reasoning') {
          this.flushDeltas(st);
          rt.inProgress.delete(ev.itemId);
          rt.pendingDeltas.delete(ev.itemId);
        }
        // Once the turn has its summary, that is the reply: Codex's final
        // answer after it folds away in the app and isn't the preview.
        if (ev.type === 'assistant.text' && !rt.turn?.summarized && !rt.turn?.headline && ev.text.trim()) rec.preview = oneLine(ev.text, LIMITS.previewChars);
        if (rt.turn) {
          // A Codex child's items carry its prefix (<child>/<id>); Claude's
          // sub-agents never reach the thread's events.
          const own = !('itemId' in ev && ev.itemId?.includes('/'));
          if (ev.type === 'assistant.text' && own && !rt.turn.summarized) {
            rt.turn.lastText = ev.text;
            rt.turn.narrationItem = ev.narration ? ev.itemId : undefined;
          }
          if (ev.type === 'tool.call' && own && ev.name === `mcp__${SERVER_NAME}__${END_TURN_TOOL}`) {
            rt.turn.endTurnBefore = rt.turn.endTurn;
            rt.turn.endTurn = ev.input;
            rt.turn.endTurnCall = ev.itemId;
          }
          // A refused repeat changes nothing: its archive once took effect
          // under a result saying it hadn't, and its card replaced the one
          // Mike was told about. One that adds archive adds only that.
          if (ev.type === 'tool.result' && ev.itemId === rt.turn.endTurnCall) {
            // Any refusal after one it took, not just ALREADY_ENDED: a bad
            // snooze or waitFor on a repeat once turned an ask into Done.
            if (endTurnRefusedRepeat(ev) || (!ev.ok && (rt.turn.ended || rt.turn.tookEndTurn))) rt.turn.endTurn = rt.turn.endTurnBefore;
            else if (endTurnTaken(ev)) rt.turn.tookEndTurn = true;
            else if (endTurnAddedArchive(ev)) rt.turn.endTurn = { ...rt.turn.endTurnBefore, archive: true };
            else if (endTurnAddedSnooze(ev)) rt.turn.endTurn = { ...rt.turn.endTurnBefore, snooze: rt.turn.endTurn?.snooze };
          }
          if (ev.type === 'tool.result' && ev.itemId === rt.turn.endTurnCall && endTurnAccepted(ev)) {
            rt.turn.ended = true;
            if (endTurnWantsReply(ev)) rt.turn.replyAfter = true;
            const headline = typeof rt.turn.endTurn?.headline === 'string' ? rt.turn.endTurn.headline.trim() : '';
            if (headline) {
              rt.turn.headline = true;
              rec.preview = oneLine(headline, LIMITS.previewChars);
            }
            // A "What I need from you" taken from a reply before a wake
            // stands until now (reopenForWake).
            rt.turn.replyNeeds = undefined;
            const bullets = endTurnIsOneReply(ev) ? undefined : summaryFromTool(rt.turn.endTurn);
            rt.turn.owedReply = !bullets ? undefined : endTurnAsksForMessage(ev) ? 0 : endTurnOwesReply(ev) ? summaryMarkdown(bullets).length : undefined;
          }
          // For hooks and the librarian only, never trust: these include
          // previews (an edit.diff before approval) and edits that were
          // then denied or failed. Trust comes from 'wrote' alone.
          if (ev.type === 'edit.diff') rt.turn.edited.add(ev.path);
          else if (ev.type === 'tool.call' && (ev.kind === 'edit' || ev.kind === 'write')) {
            const file = ev.input.file_path ?? ev.input.path ?? ev.input.notebook_path;
            if (typeof file === 'string') rt.turn.edited.add(file);
          } else if (ev.type === 'tool.call' && own && ev.kind === 'command') {
            const cmd = Array.isArray(ev.input.command) ? ev.input.command.join(' ') : ev.input.command;
            if (typeof cmd === 'string') {
              rt.turn.workedIn ??= new Set();
              for (const dir of commandFolders(cmd, rec.cwd, this.panelsRoot ?? os.homedir())) rt.turn.workedIn.add(dir);
            }
          }
        }
        this.emit(st, ev, rt.turn?.turnId);
        // end_turn's summary, written as the turn's reply straight after
        // the call it came in (docs/protocol.md, "The summary").
        if (ev.type === 'tool.result' && rt.turn && ev.itemId === rt.turn.endTurnCall && endTurnTaken(ev)) {
          const bullets = endTurnIsOneReply(ev) ? undefined : summaryFromTool(rt.turn.endTurn);
          if (bullets) {
            const text = summaryMarkdown(bullets);
            rt.turn.summarized = true;
            rt.turn.lastText = text;
            rec.preview = oneLine(text, LIMITS.previewChars);
            this.emit(st, { type: 'assistant.text', itemId: `${ev.itemId}.summary`, text, summary: true, ...(this.cfg.bulletReplies ? {} : { givesWay: true as const }) }, rt.turn.turnId);
          }
        }
        break;
      }
      case 'delta':
        // Streamed text after an accepted end_turn, dropped like its frame
        // above, so it doesn't flash up and vanish.
        // That includes the message an owed reply keeps (owedReply): it
        // lands whole, as a sign-off line it drops would leave a row behind.
        if (rt.turn && (o.delta.type === 'assistant.text.delta' || o.delta.type === 'reasoning.delta')) this.seeWake(rt.turn, { type: 'assistant.text', itemId: o.delta.itemId });
        if (rt.turn?.ended && !rt.turn.replyAfter && (o.delta.type === 'assistant.text.delta' || o.delta.type === 'reasoning.delta') && !o.delta.itemId.includes('/')) break;
        this.addDelta(st, o.delta);
        break;
      case 'session':
        rec.nativeSessionId = o.nativeSessionId;
        rec.sessionUsed = true;
        // This session is there, so a later one that can't be found gets
        // its own fresh start.
        rt.retriedFresh = false;
        if (rec.status === 'starting') rec.status = rt.approvals.size ? 'waiting' : 'running';
        if (o.model) {
          rec.modelInUse = o.model;
          // A thread with no model of its own shows what the account's
          // default really is, which the settings alone can only guess.
          if (!rec.model) this.learnAccount(rec.accountId, { defaultModel: o.model });
        }
        this.markDirty(st);
        break;
      case 'effort':
        if (rec.effortInUse !== o.level) {
          rec.effortInUse = o.level;
          this.markDirty(st);
        }
        break;
      case 'context':
        rec.contextTokens = o.contextTokens;
        if (o.contextWindow !== undefined) rec.contextWindow = o.contextWindow;
        this.markDirty(st);
        break;
      case 'limits':
        // The account's usage lives in D's UsageStore, which tells clients
        // through accounts.updated when it matters.
        try {
          this.usage?.record(rec.accountId, {
            windows: o.windows,
            ...(o.blocked !== undefined ? { blocked: o.blocked } : {}),
            ...(o.email ? { email: o.email } : {}),
            ...(o.plan ? { plan: o.plan } : {}),
          });
        } catch (e) {
          this.log.warn('could not record a usage reading', { accountId: rec.accountId, error: String(e) });
        }
        break;
      case 'cliVersion': {
        rt.cliVersion = o.version;
        if (!rt.started) {
          rt.started = true;
          this.tellStarted(rec.provider, o.version, true);
        }
        if (rec.cliVersion && rec.cliVersion !== o.version) {
          this.emit(st, { type: 'system.note', text: `${cliName(rec.provider)} ${o.version} from this turn on (was ${rec.cliVersion})` }, rt.turn?.turnId);
        }
        if (rec.cliVersion !== o.version) {
          rec.cliVersion = o.version;
          this.markDirty(st);
        }
        // Started on the version an update wants: nothing to move.
        if (this.wantedVersion[rec.provider] === o.version) rt.versionMove = false;
        break;
      }
      case 'cliTurn':
        // The CLI started a turn of its own. Give it a turn in the thread so
        // its output isn't loose, the status says running, and the app
        // flags it when it ends. A message the runner already sent waits
        // in the CLI's queue; its turn takes this output too.
        if (!rt.turn) this.openCliTurn(st);
        rt.turn!.cliStarted = true;
        if (o.note) this.emit(st, { type: 'system.note', text: o.note }, rt.turn!.turnId);
        break;
      case 'endTurnNudge':
        if (rt.turn) rt.turn.endTurnNudged = true;
        break;
      case 'tasks': {
        const endedTasks = rt.tasks.filter((t) => !o.tasks.some((n) => n.id === t.id));
        // Claude starts a turn of its own to read a finished task's result;
        // Codex doesn't (wakesAfterTasks: false), so there it would only
        // look busy for WAKE_GRACE_MS for nothing.
        const wakes = this.adapters[rec.provider]?.wakesAfterTasks !== false;
        const ended = endedTasks.length > 0 && wakes;
        rt.tasks = o.tasks;
        if (wakes) rt.finished.push(...endedTasks);
        // The CLI reports the list shrinking a moment before it starts the
        // turn that reads the result. A restart in between would lose that
        // turn, so the thread stays busy until it starts.
        if (ended && !rt.turn) this.startWakeGrace(st);
        else if (ended) rt.taskEndedInTurn = true;
        // The summary's background list changed: the app shows it, and a
        // pending restart waits on background work and re-checks on
        // thread.updated.
        this.markDirty(st);
        // Background work keeps the CLI live; once it's done the idle
        // countdown starts again.
        if (o.tasks.length) {
          rt.idleTimer?.cancel();
          rt.idleTimer = undefined;
        } else if (!rt.turn) this.scheduleIdle(st);
        break;
      }
      case 'subagent':
        this.updateSubagent(st, o.update);
        break;
      case 'wrote':
        // Patch files, and helpers a trusted patch may import, an edit the
        // CLI says it made: trusted as that edit left them, and only while
        // the file still has those bytes (patch-trust.ts). Only one made on
        // Full access, by the mode recorded with the call: in Ask and Auto
        // permission to edit a file isn't permission to run it, so what it
        // wrote waits for Mike in Patches (code-writes.ts, Gautam's scan
        // F1 and F4). Only inside the thread's own folder.
        // A sandboxed thread's are its container's, not this machine's: the
        // runner and the Mac app would run them outside it.
        if (o.mode !== 'full' || rec.confined) break;
        this.trustAgentPatches(
          o.files.map((f) => ({ ...f, path: path.resolve(rec.cwd, f.path) })),
          rec.cwd,
          true,
        );
        break;
      case 'planProposed':
        // A newer plan replaces one still waiting (Codex can propose
        // again in plan mode); the old card just stops offering Go ahead.
        if (rec.openPlan && rec.openPlan !== o.itemId) this.emit(st, { type: 'plan.resolved', itemId: rec.openPlan, decision: 'revise' }, rt.turn?.turnId);
        rec.openPlan = o.itemId;
        this.emit(st, { type: 'plan.proposed', itemId: o.itemId, text: o.text }, rt.turn?.turnId);
        this.markDirty(st);
        break;
      case 'allowRules': {
        const rules = new Set(rec.allowRules ?? []);
        for (const r of o.rules) rules.add(r);
        rec.allowRules = [...rules];
        this.markDirty(st);
        break;
      }
      case 'result': {
        const r = o.result;
        const turn = rt.turn;
        if (!turn) break;
        // Which of this turn's messages the CLI's turn answered. The CLI
        // lists them in sending order, so everything up to the last one
        // named went with it. A CLI without lifecycle frames can only say
        // whether the turn was its own; if not, it answered the one at the
        // front.
        const named = r.answered ?? (r.answers !== undefined ? [r.answers] : r.own ? [] : turn.messages.slice(0, 1));
        const last = Math.max(-1, ...named.map((id) => turn.messages.indexOf(id)));
        if (last >= 0) turn.messages.splice(0, last + 1);
        if (turn.messages.length && r.queuedTurns === 0) {
          // The CLI has nothing left to run, so a message sent during the
          // turn went nowhere (an error ended its queue). Say so rather than
          // wait for an answer that won't come.
          turn.messages = [];
          this.emit(st, { type: 'system.note', text: 'A message sent during this turn was dropped by the CLI. Send it again.' }, turn.turnId);
        }
        // Still something to answer: a turn the CLI ran by itself while
        // this thread's message waited in its queue, or a message sent
        // during the turn that the CLI runs next. The thread's turn goes on
        // until the CLI has answered everything, unless Stop cancelled the
        // rest. A failure in between is shown where it happened.
        if (turn.messages.length && !turn.interruptRequested) {
          this.flushDeltas(st);
          rt.inProgress.clear();
          if (r.outcome === 'failed' && r.error) this.emit(st, { type: 'error', message: r.error }, turn.turnId);
          break;
        }
        this.completeTurn(st, r);
        break;
      }
    }
  }

  startWakeGrace(st: ThreadState): void {
    const { rt } = st;
    rt.wakeTimer?.cancel();
    rt.wakeTimer = this.clock.setTimeout(() => {
      rt.wakeTimer = undefined;
      rt.finished = [];
      this.markDirty(st);
      // A version move was waiting for the grace to end.
      if (rt.versionMove && !rt.turn) this.scheduleIdle(st);
    }, WAKE_GRACE_MS);
  }

  openCliTurn(st: ThreadState): void {
    const { rec, rt } = st;
    rt.wakeTimer?.cancel();
    rt.wakeTimer = undefined;
    // What finished and woke the CLI, so the transcript can mark the wait
    // between this turn and the last one with what ended it (Mike, 3 Nov:
    // "still waiting" and "it's back" read as one breath).
    const wokeBy = rt.finished.map((t) => ({ kind: t.kind, description: t.description }));
    rt.finished = [];
    // Working again, so not finished for threads waiting on it.
    delete rec.finished;
    const turnId = crypto.randomUUID();
    this.emit(st, wokeBy.length ? { type: 'turn.started', turnId, wokeBy } : { type: 'turn.started', turnId }, turnId);
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    rt.turn = { turnId, startedAt: this.clock.now(), interruptRequested: false, auto: true, messages: [], edited: new Set(), access: rec.permissionMode };
    rt.activeAt = this.clock.now();
    rec.turnId = turnId;
    rec.status = rt.approvals.size ? 'waiting' : 'running';
    rec.lastActivityAt = this.isoNow();
    this.markDirty(st);
  }

  completeTurn(st: ThreadState, r: TurnResult): void {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn) return;
    this.settleInstructionsNews(st, r.outcome === 'completed' && !turn.interruptRequested);
    this.flushDeltas(st);
    rt.inProgress.clear();
    // Not a subagent's card: it's waiting on Mike, not on this turn, and the
    // subagent carries on after it. Expiring them here killed two subagents
    // when their parent's next turn ended, while Mike was away, and the CLI
    // told the parent he had stopped them (7 Nov 2026, thread 7a98a6fd).
    this.expireApprovals(st, 'The turn ended.', { mainOnly: true });
    let turnCost: number | undefined;
    if (r.totalCostUsd !== undefined) {
      // total_cost_usd is a running total for the native session (resume
      // carries it on); a drop means the CLI started counting again.
      const prev = rec.sessionCostTotal ?? 0;
      turnCost = r.totalCostUsd >= prev ? r.totalCostUsd - prev : r.totalCostUsd;
      rec.sessionCostTotal = r.totalCostUsd;
      rec.costUsd = round6((rec.costUsd ?? 0) + turnCost);
      turnCost = round6(turnCost);
    }
    const outcome = turn.interruptRequested && r.outcome !== 'completed' ? 'interrupted' : r.outcome;
    // The CLI resumed at the cut an edit asked for and has written a turn
    // after it, which is the conversation's end from now on. Kept until
    // then, so a CLI that died first cuts again on the next start.
    // Not a command the runner answered: no CLI resumed for it.
    if (rec.resumeAt && rt.resumed && !turn.local) delete rec.resumeAt;
    if (outcome === 'failed' && r.error) this.emit(st, { type: 'error', message: r.error }, turn.turnId);
    const body: EventBody = {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome,
      durationMs: Math.max(0, this.clock.now() - turn.startedAt),
    };
    if (turnCost !== undefined) body.costUsd = turnCost;
    if (r.usage) body.usage = r.usage;
    if (outcome === 'failed' && r.error) body.error = r.error;
    // Why it failed (a limit, a full context, the login), so the app can
    // offer the fix without reading the message.
    if (outcome === 'failed' && r.errorKind) body.errorKind = r.errorKind;
    // What it needs from Mike: its end_turn call, else its closing "What I
    // need from you". Only a turn it finished; a stopped one says nothing.
    const said = outcome === 'completed' ? turnNeeds(turn) : undefined;
    if (said) {
      body.needs = said.needs;
      if (said.asks) body.asks = said.asks;
      if (said.next) body.next = said.next;
      body.needsFrom = said.from;
    }
    // Here rather than only in end_turn's handler: a refused end_turn
    // leaves the asks in the reply's text, and that thread never heard
    // Mike had restarted (29 Oct 2026).
    if (said?.needs === 'you' && asksForAppRestart(said.asks)) this.appRestartAsked?.(rec.id);
    const ev = this.emit(st, body, turn.turnId);
    // Any completed turn replaces the last one's card; one that said
    // neither leaves no card, and counts as before.
    if (outcome === 'completed') {
      if (said) rec.needs = { seq: ev.seq, needs: said.needs, ...(said.asks ? { asks: said.asks } : {}) };
      else delete rec.needs;
      // How it came out replaces why it was started, on the row of a thread
      // Mike didn't start. His own threads have no byline, so it's dropped.
      const byline = bylineFromTool(turn.endTurn);
      if (byline && rec.startedBy) rec.startedBy.why = byline;
    }
    // A pool thread whose login ran dry moves and carries on (afterTurn).
    const limitHit = outcome === 'failed' && r.errorKind === 'usageLimit' ? turn.turnId : undefined;
    // One that couldn't reach the API carries on once it's back (afterTurn).
    const netLost = outcome === 'failed' && r.errorKind === 'network' ? turn.turnId : undefined;
    // A turn the CLI opened by itself during a wait (a background job
    // ended) that got through ends the wait: the agent has carried on.
    if (!netLost && rec.waitingForNetwork) delete rec.waitingForNetwork;
    // The agent asked for its own thread to be archived (end_turn's
    // archive, which Mike asked it for). It can't archive itself mid-turn,
    // as that stops the CLI, so it happens here, once the turn is over, and
    // not if a message is already waiting for the next one.
    const away = outcome === 'completed' && !turn.auto && said?.needs === 'nothing' && !rec.queue.length;
    const archive = away && archiveFromTool(turn.endTurn);
    // Hibernating likewise (end_turn's snooze). Archive wins if it asked for both.
    const snooze = away && !archive ? snoozeFromTool(turn.endTurn) : undefined;
    // Waiting on other threads (end_turn's waitFor), with snooze as the
    // latest it wakes.
    const waitFor = away && !archive ? waitForFromTool(turn.endTurn) : undefined;
    // Done, with nothing left running: any thread waiting on this one hears.
    // Not if it put itself away to wait too, as it hasn't finished. An auto
    // turn counts (the one after a sub-agent or background job ends is
    // often where the report is), so this reads end_turn itself, not `away`.
    // Judged before endTurn, which starts any queued message.
    const finished = outcome === 'completed' && said?.needs === 'nothing' && !rec.queue.length && !archive &&
      !snoozeFromTool(turn.endTurn) && !waitForFromTool(turn.endTurn) &&
      !rec.subagents?.some((a) => a.status === 'running') && !rt.tasks.length && !rt.approvals.size &&
      // A job that ended mid-turn: the CLI's turn reading its result is next.
      !rt.taskEndedInTurn && !rt.finished.length;
    this.endTurn(st, ev.seq, outcome === 'failed' ? 'error' : 'idle', outcome, limitHit, netLost);
    // The done card's loose ends (experiment looseEnds), unless it's going
    // away now; and the card of the thread that started this one, which
    // lists this one while it's working.
    if (outcome === 'completed' && said?.needs === 'nothing' && !archive) void this.checkLooseEnds(st);
    this.recheckStarter(st);
    // A code change gets another lab's review before it counts as done
    // (experiment labReview, runner/lab-review.ts): the thread waits on
    // the review, so anything waiting on it hears once it's been fixed.
    // One the last runner owed (a handover) is settled by the next turn to
    // complete: a finish gives this turn's change if it made one worth it,
    // else that earlier one; a turn that needs Mike, or waits, drops it,
    // as it would have stopped that review from starting too. Not a slash
    // command the runner answered itself (/model): that's no agent turn.
    const owed = outcome === 'completed' && !turn.local ? rec.labReviewOwed : undefined;
    if (owed) {
      delete rec.labReviewOwed;
      this.markDirty(st);
    }
    let review = finished && !rt.turn ? this.startLabReview(st, turn.turnId, turn.lastText) : undefined;
    if (!review && owed && finished && !rt.turn && !rec.labReviewOwed) review = this.startLabReview(st, owed.turnId, owed.reply, owed.seq);
    if (review) this.waitOnReview(st, review);
    // Owed to the next runner (a handover): finished once it's reviewed.
    else if (finished && !rec.labReviewOwed) this.markFinished(st, turn.lastText);
    if (outcome === 'completed' && this.waitedOnFor(rec.id).length) this.tellActivity({ kind: 'waited-on', threadId: rec.id });
    // A schedule's message brought this thread out of the archive (sendTo).
    // A run that finishes with nothing for Mike puts it back, so a watcher he
    // archived doesn't land in his inbox each time it looks and finds
    // nothing (7 Nov 2026, a twice-daily Pebble check). One that needs him,
    // fails or is stopped stays out. One still going (a background job, a
    // sub-agent, a lab review, owed or started, a wait, a pool move or a lost
    // network) keeps the mark, so the turn that really ends the run decides;
    // a queued message decides at the end of its own turn.
    // A run that ends for good drops the mark even with another message
    // queued (endTurn may have started it already), so a later run that
    // finds nothing can't archive a question this one left for Mike.
    if (rec.unarchivedBySchedule) {
      const by = rec.unarchivedBySchedule.by;
      const goingOn = !!limitHit || !!netLost || (outcome === 'completed' && said?.needs === 'nothing');
      if (!goingOn || rec.archivedAt) delete rec.unarchivedBySchedule;
      else if (!rec.queue.length && !rt.turn && finished && !review && !rec.labReviewOwed && !this.stopping) {
        delete rec.unarchivedBySchedule;
        this.emit(st, { type: 'system.note', text: 'Back in the archive: the scheduled run ended with nothing for you.' });
        this.update({ threadId: rec.id, archived: true, archivedBy: by ?? 'threadbear' });
      }
      this.markDirty(st);
    }
    if (archive && !rt.turn && !rec.archivedAt && !this.stopping) {
      this.emit(st, { type: 'system.note', text: 'Archived, as the agent was asked to once it had finished.' });
      this.update({ threadId: rec.id, archived: true, archivedBy: 'agent' });
    }
    if (waitFor && !rt.turn && !rec.archivedAt && !this.stopping) this.waitOn(st, waitFor, snooze);
    else if (snooze && !rt.turn && !rec.archivedAt && !this.stopping) this.snoozeAfterTurn(st, snooze);
  }

  // end_turn's snooze, once the turn is over: a time as update_thread
  // reads it, or else words, read as Hibernate in words reads Mike's.
  snoozeAfterTurn(st: ThreadState, when: string): void {
    const { rec } = st;
    let until: string | undefined;
    if (when.toLowerCase() === 'restart' || when.toLowerCase() === 'release') until = when.toLowerCase();
    else {
      try {
        until = parseWhen(when, this.clock.now());
      } catch {
        until = undefined;
      }
    }
    if (until === undefined) {
      // A failure puts the thread back in the inbox (hibernateWhen), so
      // Mike sees it, with a note saying why.
      this.hibernateWhen({ threadId: rec.id, said: when }).catch((e: unknown) => {
        if (st.rt.deleted) return;
        this.emit(st, { type: 'system.note', text: `Not hibernated, as the agent was asked to: ${e instanceof Error ? e.message : String(e)}` });
      });
      return;
    }
    if (until !== 'restart' && until !== 'release' && Date.parse(until) <= this.clock.now()) {
      this.emit(st, { type: 'system.note', text: `Not hibernated: the agent asked to wake at ${when}, which has passed.` });
      return;
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const text = until === 'restart' ? 'Hibernating until the runner next starts, as the agent was asked to.'
      : until === 'release' ? 'Hibernating until the runner starts on a new release, as the agent was asked to.' : `Hibernating until ${localWhen(Date.parse(until), timeZone)}, as the agent was asked to.`;
    this.emit(st, { type: 'system.note', text });
    this.update({ threadId: rec.id, snoozedUntil: until });
  }

  endTurn(st: ThreadState, completedSeq: number, status: ThreadStatus, outcome?: TurnOutcome, limitHit?: string, netLost?: string): void {
    const { rec, rt } = st;
    const finished = rt.turn;
    rt.turn?.interruptTimer?.cancel();
    rt.turn = undefined;
    // The turn may have added a patch file or a convex/ folder.
    this.forgetFolders();
    // The folder's turn.end hooks, after a turn the agent finished itself
    // (not one the runner opened for a background task's approval).
    if (outcome === 'completed' && finished && !finished.auto && !this.stopping) void this.runHooks(st, finished);
    // The turn may have changed what live state reads (comments resolved,
    // a handback): read it now rather than at the next poll.
    if (rt.patches?.live && !this.stopping) void this.refreshPatches(st);
    if (outcome && finished && !finished.auto && !this.stopping) {
      this.tellActivity({ kind: 'turn.end', threadId: rec.id, outcome, edited: [...finished.edited].map((p) => path.resolve(rec.cwd, p)), workedIn: [...(finished.workedIn ?? [])] });
    }
    if (rt.taskEndedInTurn) {
      rt.taskEndedInTurn = false;
      // Only while the CLI is there to start that turn.
      if (rt.session && !rt.closing && !this.stopping) this.startWakeGrace(st);
    }
    rt.activeAt = this.clock.now();
    rec.turnId = undefined;
    rec.lastTurnCompletedSeq = completedSeq;
    // A subagent's card outlives the turn (completeTurn), so the thread is
    // still waiting on Mike.
    rec.status = rt.approvals.size ? 'waiting' : status;
    rec.lastActivityAt = this.isoNow();
    this.markDirty(st);
    const waiters = rt.turnEndWaiters ?? [];
    rt.turnEndWaiters = undefined;
    for (const w of waiters) w();
    this.afterTurn(st, limitHit, netLost);
  }

  // A turn that ended without a result from the CLI (spawn failure, crash).
  failTurn(st: ThreadState, message: string): void {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn) return;
    this.settleInstructionsNews(st, false);
    this.persistInProgress(st, turn.turnId);
    this.expireApprovals(st, 'The turn ended.');
    // A crash or a Stop ends a scheduled run for good: it stays in the
    // inbox, and a later run can't put it back in the archive (the end of
    // a turn, above).
    if (rec.unarchivedBySchedule) delete rec.unarchivedBySchedule;
    const interrupted = turn.interruptRequested;
    if (!interrupted) this.emit(st, { type: 'error', message }, turn.turnId);
    const body: EventBody = {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome: interrupted ? 'interrupted' : 'failed',
      durationMs: Math.max(0, this.clock.now() - turn.startedAt),
    };
    if (!interrupted) body.error = message;
    const ev = this.emit(st, body, turn.turnId);
    this.endTurn(st, ev.seq, interrupted ? 'idle' : 'error');
  }

  afterTurn(st: ThreadState, limitHit?: string, netLost?: string): void {
    if (this.stopping) return;
    if (limitHit) {
      try {
        this.onUsageLimit(st, limitHit);
      } catch (e) {
        this.log.error('could not move a thread off a login at its limit', { threadId: st.rec.id, error: String(e) });
      }
    }
    if (netLost) this.onNetworkLost(st, netLost);
    // A snoozed or archived thread keeps its queue until it comes back.
    if (this.bucket(st.rec) === 'inbox' && this.kickQueue(st)) return;
    this.scheduleIdle(st);
  }

  // ------------------------------------------------------- pools: moving

  // Before a pool thread's turn starts: if its login isn't OK (blocked or
  // under the minimum room) or isn't in its pool any more, it moves first
  // (docs/protocol.md, "Pools"). With nowhere better, the turn starts
  // where it is. A pinned thread (no poolId) never moves.
  beforeTurn(st: ThreadState): void {
    const { rec } = st;
    const pool = this.poolById(rec.poolId);
    if (!pool) return;
    const accounts = this.usableAccounts();
    const current = accounts.find((a) => a.id === rec.accountId);
    const inPool = pool.accountIds.includes(rec.accountId);
    if (current && inPool && loginOk(current)) return;
    const now = this.clock.now();
    const next = nextLogin(pool, accounts, rec, now);
    if ('waitUntil' in next) return;
    const why = !current ? `${rec.accountId} isn't on this Mac` : inPool ? `${current.title} ${limitWhy(current, now)}` : `${current.title} isn't in ${pool.title}`;
    this.moveLogin(st, accounts.find((a) => a.id === next.accountId)!, why);
  }

  // ------------------------------------------------- the network dropping

  onExited(st: ThreadState, gen: number, err?: Error): void {
    const { rec, rt } = st;
    if (rt.generation !== gen) return;
    // A CLI that died before it got going, other than one asked to stop or
    // one whose session to resume was missing (the CLI itself was fine).
    const missing = err && (err instanceof SessionNotFoundError || err.name === 'SessionNotFoundError' || /no conversation found/i.test(err.message));
    if (err && !rt.started && !missing && rt.releasedGen !== gen) this.tellStarted(rec.provider, rt.startVersion, false);
    rt.session = undefined;
    rt.frozen = false;
    // Nothing's left to answer them: a subagent's card can be open with no
    // turn running, and no turn ending would close it.
    this.expireApprovals(st, 'The CLI stopped.');
    rt.tasks = [];
    rt.finished = [];
    rt.taskEndedInTurn = false;
    // Its sub-agents went with it.
    this.stopSubagents(st);
    rt.wakeTimer?.cancel();
    rt.wakeTimer = undefined;
    rt.idleTimer?.cancel();
    rt.idleTimer = undefined;
    this.log.info('session ended', { threadId: rec.id, error: err?.message });
    if (rt.releasedGen === gen) {
      // A CLI we asked to stop. A turn that is waiting for it to go starts
      // the next CLI once it has. A turn it had started by itself while
      // shutting down ends with it.
      rt.releasedGen = undefined;
      if (rt.turn?.auto) {
        rt.turn.interruptRequested = true;
        this.failTurn(st, 'The session was released.');
      }
      this.markDirty(st);
      return;
    }
    if (rt.turn) {
      // The session to resume doesn't exist. For Claude that only ever
      // meant the CLI died before its first message (it never wrote the
      // transcript); for Codex it also covers a thread deleted in Codex's
      // own app, a missing rollout or a moved CODEX_HOME, part way through
      // a conversation. Start a fresh session once.
      const notFound = err && (err instanceof SessionNotFoundError || err.name === 'SessionNotFoundError' || (/no conversation found/i.test(err.message) && rec.status === 'starting'));
      // The other way round: a session started fresh whose id the CLI
      // already has. Its first turn was cut off (a restart) after the CLI
      // wrote the transcript but before its init reached the runner, so
      // sessionUsed never got set. Resume it instead, once (4 Nov 2026).
      const inUse = Boolean(err && !rt.resumed && /Session ID \S+ is already in use/i.test(err.message));
      if (((notFound && rt.resumed) || inUse) && !rt.retriedFresh) {
        rt.retriedFresh = true;
        if (inUse) {
          rec.sessionUsed = true;
          // The old session goes on, not the fresh one the brief was for.
          if (rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
        } else {
          rec.sessionUsed = false;
          rec.nativeSessionId = crypto.randomUUID();
          rec.sessionCostTotal = 0;
          delete rec.cliVersion;
        }
        const account = this.accounts.get(rec.accountId);
        if (account && rt.turn) {
          if (!inUse) this.emit(st, { type: 'system.note', text: "Couldn't resume the earlier session, so this is a new one." }, rt.turn.turnId);
          const turn = rt.turn;
          const log = this.store.log(rec.id);
          const msgs = log.read(Math.max(1, log.lastSeq - 200), log.lastSeq).filter((e) => e.type === 'user.message' && e.turnId === turn.turnId);
          const first = msgs[0];
          if (first && first.type === 'user.message') {
            // The fresh session starts knowing where the thread got to: a
            // transcript carried to a new folder that wouldn't resume gets
            // the move's note, any other thread with earlier turns the
            // not-found one.
            let text = this.forAgent(first);
            const earlier = rec.lastTurnCompletedSeq > 0;
            if (!inUse && (rt.carried || earlier)) {
              rec.handoff = rt.carried ?? { fromCwd: rec.cwd, fromAccountId: rec.accountId, lost: true };
              text = this.handoffNote(st, account) + text;
              delete rec.handoff;
            }
            rt.carried = undefined;
            this.startSession(st, account);
            rt.session!.send({ id: turn.turnId, text, images: first.images });
            // Messages sent into the turn before the CLI went go again, in
            // order, matched to their ids when the counts agree.
            if (msgs.length === turn.messages.length) {
              msgs.slice(1).forEach((m, i) => {
                if (m.type === 'user.message') rt.session!.send({ id: turn.messages[i + 1], text: this.forAgent(m), images: m.images });
              });
            }
            return;
          }
        }
      }
      this.failTurn(st, err?.message || 'The CLI stopped unexpectedly.');
    } else {
      this.markDirty(st);
    }
    // A CLI that exited by itself (not released) may have been all an
    // archive was waiting for.
    this.archiveWhenGone(st);
  }

  // byMike: his Stop, in the app or on the phone. Everything else that stops
  // a turn (an agent's interrupt_thread, an archive, a move) mustn't reach
  // the agent as his decision (docs/protocol.md, "Who stopped it").
  interrupt(threadId: string, opts: { byMike?: boolean } = {}): Record<string, never> {
    const st = this.mustGet(threadId);
    const { rt } = st;
    const turn = rt.turn;
    const closing = { stopped: opts.byMike === true };
    // Stop with only a subagent's card open: that card is what's waiting.
    if (!turn) {
      this.expireApprovals(st, 'Interrupted.', closing);
      return {};
    }
    turn.interruptRequested = true;
    this.expireApprovals(st, 'Interrupted.', closing);
    const session = rt.session;
    // Nothing is running in the CLI for a turn that was only opened for a
    // background subagent's approval, so nothing would end it.
    if (!session || rt.closing || (turn.auto && !turn.cliStarted)) {
      this.failTurn(st, 'Interrupted.');
      return {};
    }
    turn.interruptTimer ??= this.clock.setTimeout(() => {
      if (rt.turn !== turn) return;
      this.log.warn('the CLI did not end an interrupted turn; ending it', { threadId });
      this.failTurn(st, 'Interrupted.');
      // It'd never read the next message either.
      if (rt.frozen) session.kill();
    }, INTERRUPT_GRACE_MS);
    session.interrupt().catch((e: unknown) => {
      // Before the CLI has initialised there's nothing to interrupt; stop it.
      this.log.warn('interrupt failed, stopping the CLI', { threadId, error: String(e) });
      session.kill();
    });
    return {};
  }

  update(params: {
    threadId: string;
    title?: string;
    // Who the title is from. Mike's (the default: the app, tb) sticks: an
    // agent can't rename it after, unless it says Mike asked it to and
    // passes 'mike' itself.
    titleBy?: 'mike' | 'agent';
    cwd?: string;
    accountId?: string;
    // null pins the thread to its current login; a pool id puts it in that
    // pool (and onto one of its logins if its current one isn't in it).
    // accountId pins it to that login, poolId or not.
    poolId?: string | null;
    model?: string | null;
    effort?: EffortLevel | null;
    permissionMode?: PermissionMode;
    snoozedUntil?: string | null; // an ISO time, 'restart' for until the runner next starts, or 'release' for until it starts on a new release
    archived?: boolean;
    // Who's archiving it: Mike (the default: the app, the phone, tb), an
    // agent (update_thread, end_turn's archive) or Threadbear itself. With
    // Mike's verdict from the done card's Archive menu, so whoever reads
    // the thread later knows it was put away on purpose, and how it went.
    archivedBy?: ArchivedBy;
    verdict?: ArchiveVerdict;
    starred?: boolean;
    // A move Mike made (the app, tb) or allowed on a card: a thread shut in
    // a sandbox may leave it. Without it, a move or login change that would
    // take it out is refused (ThreadRecord.confined).
    unconfine?: boolean;
  }): { thread: ThreadSummary } {
    const st = this.mustGet(params.threadId);
    const { rec, rt } = st;
    // Checked before anything changes, so a refused rename changes nothing else either.
    if (params.title !== undefined && params.titleBy === 'agent' && rec.titleByMike && params.title.trim() !== rec.title) {
      throw new RpcError(ErrorCode.badParams, `The user named this thread "${rec.title}" themselves, so it keeps that title. Only rename it if they ask you to.`);
    }
    let release = false;
    let stop = false;
    const pool = typeof params.poolId === 'string' && params.accountId === undefined ? this.poolById(params.poolId) : undefined;
    if (typeof params.poolId === 'string' && params.accountId === undefined && !pool) {
      throw new RpcError(ErrorCode.badParams, `No pool called ${params.poolId}. Pools: ${this.pools().map((p) => p.id).join(', ') || 'none'}`);
    }
    // The login to move to: the one named (which pins), or one of the new
    // pool's when the current one isn't in it.
    let toAccountId = params.accountId;
    if (pool && !pool.accountIds.includes(rec.accountId)) {
      const accounts = this.usableAccounts();
      let id = pickInPool(pool, accounts, { provider: rec.provider });
      if (!id) {
        const next = nextLogin(pool, accounts, rec, this.clock.now());
        if (!('waitUntil' in next)) id = next.accountId;
      }
      toAccountId = id ?? poolAccounts(pool, accounts)[0]?.id;
    }
    if (params.title !== undefined) {
      rec.title = cutSafely(params.title.trim(), 200) || rec.title;
      rec.titleSet = true;
      if (params.titleBy !== 'agent') rec.titleByMike = true;
    }
    if (params.cwd !== undefined && !params.cwd.trim()) throw new RpcError(ErrorCode.badParams, 'cwd must not be blank');
    const newCwd = params.cwd !== undefined ? path.resolve(expandHome(params.cwd.trim())) : undefined;
    if (newCwd !== undefined && !isDirectory(newCwd)) throw new RpcError(ErrorCode.badParams, `Folder not found: ${newCwd}`);
    const newAccount = toAccountId !== undefined ? this.accounts.get(toAccountId) : undefined;
    if (toAccountId !== undefined && !newAccount) {
      throw new RpcError(ErrorCode.accountNotFound, `No account called ${toAccountId}`);
    }
    if (newAccount && toAccountId !== rec.accountId) this.checkProvider(newAccount);
    // Checked before anything changes: where it would run after this.
    const stillIn = (newAccount?.provider ?? rec.provider) === 'claude' && this.sandboxed(newCwd ?? rec.cwd);
    if (rec.confined && (newCwd !== undefined || toAccountId !== undefined) && !stillIn && !params.unconfine) {
      throw new RpcError(ErrorCode.badParams, `"${rec.title}" runs in a sandbox, and this would take it out of it (a folder that isn't in one, or a Codex login). Only the user can do that.`);
    }
    // Pinned (an account named, or poolId null), or into a pool.
    if (params.accountId !== undefined || params.poolId === null) {
      delete rec.poolId;
      delete rec.waitingForRoom;
    } else if (pool) rec.poolId = pool.id;
    const cwdChanged = newCwd !== undefined && newCwd !== rec.cwd;
    const fromCwd = rec.cwd;
    const accountChanged = toAccountId !== undefined && toAccountId !== rec.accountId;
    const providerChanged = accountChanged && newAccount!.provider !== rec.provider;
    const adapter = this.adapters[rec.provider];
    // Changes a CLI that applies settings from its next turn only (Codex)
    // can't take into a turn that's running; the thread says so.
    const nextTurn: string[] = [];
    const sayNextTurn = () => Boolean(rt.turn) && !rt.turn?.local && Boolean(adapter?.settingsApplyNextTurn) && !release;
    if (cwdChanged && !accountChanged && !rec.handoff && adapter?.movesFolders) {
      // Same account on a CLI that moves folders itself: the same session
      // carries on in the new folder from its next turn, with no
      // transcript copy and no handoff. A live session is told now; a
      // released one gets the folder when it resumes.
      if (rec.sessionUsed || rt.session) rec.moved ??= { fromCwd: rec.cwd };
      rec.cwd = newCwd!;
      if (rec.moved?.fromCwd === rec.cwd) delete rec.moved;
      const session = rt.session;
      if (session && !rt.closing) {
        const fallback = () => {
          // Couldn't move the live session: a fresh CLI resumes there.
          rt.releaseWhenIdle = true;
          if (!rt.turn) this.releaseSession(st);
        };
        if (session.setCwd) session.setCwd(rec.cwd).catch(fallback);
        else fallback();
      }
      if (sayNextTurn()) nextTurn.push(`The move to ${rec.cwd}`);
    } else if (cwdChanged || accountChanged) {
      // Takes effect on the next turn as a new native session.
      if (rec.sessionUsed || rt.session) rec.handoff ??= { fromCwd: rec.moved?.fromCwd ?? rec.cwd, fromAccountId: rec.accountId };
      delete rec.moved;
      if (newCwd !== undefined) rec.cwd = newCwd;
      if (toAccountId !== undefined) {
        rec.accountId = toAccountId;
        if (params.accountId !== undefined) this.rememberAccount(toAccountId);
      }
      release = true;
    }
    if (cwdChanged) this.tellActivity({ kind: 'moved', threadId: rec.id, from: fromCwd, to: rec.cwd });
    // Out of the sandbox, as allowed; into one, shut in it from now.
    if (cwdChanged || accountChanged) {
      if (stillIn) rec.confined = true;
      else delete rec.confined;
    }
    // The account the settings are checked against, after any change.
    const account = newAccount ?? this.accounts.get(rec.accountId);
    let model = rec.model;
    let effort = rec.effort;
    let touched = false;
    if (providerChanged) {
      // Another provider's CLI: its own defaults (unless this call sets
      // them), and none of the old CLI's "Always allow" rules, which are in
      // its own syntax.
      rec.provider = newAccount!.provider;
      delete rec.allowRules;
      delete rec.cliVersion;
      model = this.defaultModelFor(rec.provider);
      effort = this.defaultEffortFor(rec.provider);
      touched = true;
    }
    if (params.model !== undefined) {
      model = params.model || undefined;
      touched = true;
    }
    if (params.effort !== undefined) {
      effort = params.effort || undefined;
      touched = true;
    }
    if (touched && account) {
      const checked = this.checkSettings(account, model, effort);
      model = checked.model;
      effort = checked.effort;
      for (const text of checked.notes) this.emit(st, { type: 'system.note', text }, rt.turn?.turnId);
    }
    if (model !== rec.model) {
      if (model) rec.model = model;
      else delete rec.model;
      if (rt.session && !release) {
        rt.session.setModel(model).catch(() => {
          rt.releaseWhenIdle = true;
        });
        if (sayNextTurn()) nextTurn.push(model ? (account ? modelTitle(account, model) : model) : 'The default model');
      }
    }
    if (effort !== rec.effort) {
      if (effort) rec.effort = effort;
      else delete rec.effort;
      if (rt.session && !release) {
        rt.session.setEffort(effort).catch(() => {
          rt.releaseWhenIdle = true;
        });
        if (sayNextTurn()) nextTurn.push(effort ? `${effortTitle(effort)} effort` : "The model's own effort level");
      }
    }
    if (params.permissionMode !== undefined && params.permissionMode !== rec.permissionMode) {
      // What approving a plan goes back to.
      if (params.permissionMode === 'plan') rec.modeBeforePlan = rec.permissionMode;
      else delete rec.modeBeforePlan;
      rec.permissionMode = params.permissionMode;
      // The turn counts as having had the most access it was given: a
      // Claude CLI takes a raise now, and a lowered Codex turn carries on
      // as it started.
      if (rt.turn) rt.turn.access = moreAccess(rt.turn.access, params.permissionMode);
      // Out of Full with the folder's untrusted permission rules loaded:
      // they stop applying now, even to a turn the CLI starts by itself,
      // and the next message gets a CLI without them.
      if (rt.session && rt.claudeHeldGrants && params.permissionMode !== 'full') {
        rt.session.askBeforeEveryTool?.();
        rt.releaseWhenIdle = true;
      }
      if (rt.session && !release) {
        rt.session.setPermissionMode(params.permissionMode).catch(() => {
          rt.releaseWhenIdle = true;
          if (!rt.turn) this.releaseSession(st);
        });
        if (sayNextTurn()) nextTurn.push(params.permissionMode === 'ask' ? 'Ask before edits' : params.permissionMode === 'auto' ? 'Auto' : params.permissionMode === 'plan' ? 'Plan first' : 'Full access');
      }
    }
    if (nextTurn.length) {
      this.emit(
        st,
        { type: 'system.note', text: `${joinWords(nextTurn)} ${nextTurn.length === 1 ? 'applies' : 'apply'} from the next turn. This turn carries on as it started.` },
        rt.turn?.turnId,
      );
    }
    if (params.snoozedUntil !== undefined) {
      // Kept through a change of wake time, so the note on waking counts
      // from when it first went away.
      if (params.snoozedUntil !== null && this.bucket(rec) !== 'snoozed') rec.snoozedAt = this.isoNow();
      delete rec.woke;
      delete rec.snoozedUntilRestart;
      delete rec.untilRelease;
      delete rec.wakeWhen;
      delete rec.waitingOn;
      if (params.snoozedUntil === null) delete rec.snoozedUntil;
      else if (params.snoozedUntil === 'restart' || params.snoozedUntil === 'release') {
        rec.snoozedUntil = UNTIL_RESTART;
        rec.snoozedUntilRestart = true;
        // Until a start on another release than this one. From a source
        // checkout there's no release to tell apart, so any start does.
        if (params.snoozedUntil === 'release' && this.release) rec.untilRelease = this.release;
        stop = true;
      } else {
        const t = Date.parse(params.snoozedUntil);
        if (Number.isNaN(t)) throw new RpcError(ErrorCode.badParams, 'snoozedUntil must be an ISO time, "restart" or "release"');
        rec.snoozedUntil = new Date(t).toISOString();
        stop = true;
      }
      this.armSnoozeTimer();
    }
    let archiving = false;
    if (params.archived !== undefined) {
      // Mike (or an agent) archived or unarchived it himself: that settles
      // where it lives, not the schedule run that brought it back.
      delete rec.unarchivedBySchedule;
      if (params.archived) {
        archiving = !rec.archivedAt;
        const by = params.archivedBy ?? 'mike';
        const verdict = by === 'mike' ? params.verdict : undefined;
        // Said in the thread, for the agent or a sweeper reading it later.
        if (verdict && (archiving || verdict !== rec.archiveVerdict)) this.emit(st, { type: 'system.note', text: ARCHIVE_NOTES[verdict] });
        rec.archivedAt = this.isoNow();
        rec.archivedBy = by;
        if (verdict) rec.archiveVerdict = verdict;
        else delete rec.archiveVerdict;
        stop = true;
      } else delete rec.archivedAt;
    }
    if (archiving) {
      this.reconcileWaits();
      this.recheckStarter(st);
    }
    if (params.starred === true) rec.starredAt ??= this.isoNow();
    else if (params.starred === false) delete rec.starredAt;
    if (accountChanged && rt.turn && rt.session && !stop) {
      // The turn carries on where it started; say so, or the picker reads
      // as if the new model were already doing the work.
      this.emit(st, { type: 'system.note', text: `${this.modelLabel(rec)} takes over from your next message, which stops this turn.` }, rt.turn.turnId);
    }
    if (!stop && this.bucket(rec) === 'inbox') this.kickQueue(st);
    if (stop) {
      // Snoozing or archiving stops the CLI: end any turn, then release.
      rt.releaseWhenIdle = true;
      if (rt.turn) this.interrupt(rec.id);
      else this.releaseSession(st);
    } else if (release) {
      rt.releaseWhenIdle = true;
      if (!rt.turn) this.releaseSession(st);
    }
    // Archived here, archived in the CLI's own app too (Codex Desktop's
    // list), once the session has let go of it: a turn is interrupted
    // first, then released, so that can take a moment. Resuming unarchives.
    if (archiving) {
      rt.archivePending = true;
      if (rec.worktree && !rec.worktree.removedAt) rec.worktree.cleanupOwed = true;
      this.archiveWhenGone(st);
    }
    rec.updatedAt = this.isoNow();
    this.markDirty(st);
    return { thread: this.summary(st) };
  }

  // Stops the thread's CLI, moves its folder to trash/ in the data dir (so
  // a mistake can be undone by hand) and forgets it.
  delete(threadId: string): Record<string, never> {
    const st = this.mustGet(threadId);
    const { rec, rt } = st;
    rt.deleted = true;
    this.threads.delete(threadId);
    this.waitedOnDeleted(threadId);
    this.dirty.delete(threadId);
    rt.idleTimer?.cancel();
    rt.deltaTimer?.cancel();
    rt.wakeTimer?.cancel();
    rt.turn?.interruptTimer?.cancel();
    // Bumping the generation makes everything the old CLI still reports
    // (output, approvals, its exit) go nowhere.
    rt.generation++;
    for (const [, p] of rt.approvals) {
      settleDeclined(p, 'expired', 'The thread was deleted.');
    }
    rt.approvals.clear();
    const session = rt.session;
    rt.session = undefined;
    const ended = session?.end({ hard: true }).catch((e: unknown) => this.log.warn('stopping a deleted thread failed', { threadId, error: String(e) }));
    this.archiveNative(st, ended ?? rt.closing);
    // Its worktree goes once the CLI has let go of the folder, and after an
    // archive's cleanup still running, rather than beside it (that one may
    // already have removed it).
    if (rec.worktree && !rec.worktree.removedAt) {
      const cleaning = rt.cleaning;
      void Promise.resolve(ended ?? rt.closing)
        .catch(() => undefined)
        .then(() => cleaning)
        .then(() => this.cleanUpWorktree(st, true))
        .catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId, error: String(e) }));
    }
    this.store.trash(threadId, this.clock.now());
    this.log.info('thread deleted', { threadId, title: rec.title });
    this.armSnoozeTimer();
    this.notify({ method: 'thread.deleted', params: { threadId } });
    return {};
  }

  // Ticks one of the open card's asks. Nothing goes to the agent: ticks are
  // Mike's own list, and a reply is his to write.
  tickAsk(threadId: string, asksSeq: number, index: number, ticked: boolean): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    const { rec } = st;
    const card = rec.needs;
    if (!card?.asks || card.seq !== asksSeq || card.seq !== rec.lastTurnCompletedSeq) throw new RpcError(ErrorCode.badParams, "That isn't the thread's open card of asks.");
    if (!Number.isInteger(index) || index < 0 || index >= card.asks.length) throw new RpcError(ErrorCode.badParams, 'No such ask.');
    const set = new Set(card.ticked);
    if (ticked) set.add(index);
    else set.delete(index);
    card.ticked = [...set].sort((a, b) => a - b);
    // Ticking means Mike is looking at it, so the tick doesn't make the
    // thread unread.
    const caughtUp = rec.lastSeenSeq >= rec.lastSeq;
    const ev = this.emit(st, { type: 'asks.ticked', asksSeq, ticked: card.ticked });
    if (caughtUp) rec.lastSeenSeq = ev.seq;
    this.markDirty(st);
    return { thread: this.summary(st) };
  }

  saidNothing(rec: ThreadRecord): boolean {
    return rec.needs?.needs === 'nothing' && rec.needs.seq === rec.lastTurnCompletedSeq;
  }

  markSeen(threadId: string, seq: number): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    const { rec } = st;
    const last = Math.max(rec.lastSeq, this.store.log(threadId).lastSeq);
    rec.lastSeenSeq = Math.max(rec.lastSeenSeq, Math.min(Math.floor(seq), last));
    rec.forceUnread = false;
    delete rec.woke;
    this.markDirty(st);
    return { thread: this.summary(st) };
  }

  importMedia(p: string): { image: ImageRef } {
    const src = path.resolve(expandHome(p));
    if (!fs.existsSync(src)) throw new RpcError(ErrorCode.badParams, `File not found: ${src}`);
    try {
      return { image: copyImageInto(paths.inbox(this.cfg.home), src) };
    } catch (e) {
      throw new RpcError(ErrorCode.badParams, (e as Error).message);
    }
  }

  // ------------------------------------------------------------- approvals

  // ---------------------------------------------------------- idle release

  // ------------------------------------------------------------ CLI updates

  // Runs a pending archive once no CLI has the session: none live and none
  // closing. Skipped if the thread came back meanwhile. A turn-end hook still
  // running holds it too (runHooks comes back here): it's working in the
  // folder the cleanup would remove or hand on, and on 7 Nov a typecheck
  // lost its files that way, "failed", and woke the thread just archived.
  // Waiting also means a real failure finds the worktree still there, as
  // sendTo brings the thread back before the cleanup looks.
  archiveWhenGone(st: ThreadState): void {
    const { rec, rt } = st;
    if (!rt.archivePending || rt.session || rt.closing || rt.deleted || rt.hooksRunning) return;
    rt.archivePending = false;
    if (rec.archivedAt) {
      this.archiveNative(st);
      if (rec.worktree && !rec.worktree.removedAt && !rt.cleaning) {
        const cleaning = this.cleanUpWorktree(st)
          .catch((e: unknown) => this.log.error('worktree cleanup failed', { threadId: rec.id, error: String(e) }))
          .finally(() => {
            if (rt.cleaning === cleaning) rt.cleaning = undefined;
          });
        rt.cleaning = cleaning;
      }
    }
  }

  // Archives the native session in the CLI's own app (Codex Desktop) when
  // the thread is archived or deleted here, once `after` (the session
  // letting go) has settled. Best effort.
  archiveNative(st: ThreadState, after?: Promise<unknown>): void {
    const { rec } = st;
    const adapter = this.adapters[rec.provider];
    if (!adapter?.archive || !rec.sessionUsed || !rec.nativeSessionId) return;
    const account = this.accounts.get(rec.accountId);
    if (!account) return;
    const nativeId = rec.nativeSessionId;
    const threadId = rec.id;
    void Promise.resolve(after)
      .catch(() => undefined)
      .then(() => adapter.archive!(account, nativeId))
      .catch((e: unknown) => this.log.warn('could not archive the session in the CLI', { threadId, nativeSessionId: nativeId, error: String(e) }));
  }

  // ----------------------------------------------------------------- snooze

  // Starts the next queued message if nothing is running. Returns true if
  // one started. One that can't be written (disk full) stays at the front.
  kickQueue(st: ThreadState): boolean {
    if (st.rt.turn || st.rec.queue.length === 0 || this.stopping || st.rt.editing) return false;
    // A draining runner hands a thread over with its queue rather than
    // start another turn on the old release; the primary starts it. Not if
    // background work is holding the thread here: that can be half an hour
    // for a shell and hours for a subagent, with the message sitting unread
    // and its card still open (Mike's "Done" on 1 Nov waited behind a
    // 20-minute watcher). Its CLI is alive, so it answers now, and the
    // thread moves across once the turn and the work are over.
    const d = this.draining;
    if (d && (st.rt.tasks.length === 0 || d.going.has(st.rec.id))) {
      this.queueHandoverCheck();
      return false;
    }
    const next = st.rec.queue.shift()!;
    this.markDirty(st);
    try {
      this.startTurn(st, next);
      return true;
    } catch (e) {
      st.rec.queue.unshift(next);
      this.log.error('could not start a queued message', { threadId: st.rec.id, error: String(e) });
      this.notice('error', `Couldn't start a message in "${st.rec.title}": ${(e as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------ editing a message

  // ---------------------------------------------------------- design reviews

  // ---------------------------------------------------------------- events

  emit(st: ThreadState, body: EventBody, turnId?: string): PersistedEvent {
    if (st.rt.deleted) throw new Error('The thread was deleted.');
    this.flushDeltas(st);
    const log = this.store.log(st.rec.id);
    const event = { seq: log.lastSeq + 1, ts: this.isoNow(), threadId: st.rec.id, ...(turnId ? { turnId } : {}), ...body } as PersistedEvent;
    log.append(event);
    st.rec.lastSeq = event.seq;
    st.rec.updatedAt = event.ts;
    if (body.type === 'user.message') {
      const asked = askedLine(body, st.rec.reviews);
      if (asked) st.rec.asked = asked;
    }
    this.markDirty(st);
    this.notify({ method: 'thread.event', params: { threadId: st.rec.id, event } });
    return event;
  }

  addDelta(st: ThreadState, d: DeltaBody): void {
    const { rt } = st;
    if (d.type !== 'tool.output.delta') {
      const type = d.type === 'assistant.text.delta' ? 'assistant.text' : 'reasoning';
      const item = rt.inProgress.get(d.itemId) ?? { itemId: d.itemId, type, text: '' };
      item.text += d.text;
      rt.inProgress.set(d.itemId, item);
    }
    const pending = rt.pendingDeltas.get(d.itemId);
    if (pending) pending.text += d.text;
    else rt.pendingDeltas.set(d.itemId, { type: d.type, text: d.text });
    rt.deltaTimer ??= this.clock.setTimeout(() => {
      rt.deltaTimer = undefined;
      this.flushDeltas(st);
    }, DELTA_INTERVAL_MS);
  }

  // Sends coalesced deltas. Transient events carry the seq of the last
  // persisted event and don't consume a number.
  flushDeltas(st: ThreadState): void {
    const { rt, rec } = st;
    rt.deltaTimer?.cancel();
    rt.deltaTimer = undefined;
    if (rt.pendingDeltas.size === 0) return;
    const seq = this.store.log(rec.id).lastSeq;
    const ts = this.isoNow();
    for (const [itemId, d] of rt.pendingDeltas) {
      const event = { seq, ts, threadId: rec.id, ...(rt.turn ? { turnId: rt.turn.turnId } : {}), type: d.type, itemId, text: d.text } as AnyEvent;
      this.notify({ method: 'thread.event', params: { threadId: rec.id, event } });
    }
    rt.pendingDeltas.clear();
  }

  // --------------------------------------------------------------- helpers

  // A sub-agent started or changed (AdapterOutput 'subagent').
  updateSubagent(st: ThreadState, u: SubagentUpdate): void {
    const { rec } = st;
    const list = (rec.subagents ??= []);
    let a = list.find((x) => x.id === u.id);
    if (!a) {
      // An update for one the list doesn't have (a resumed CLI reporting a
      // sub-agent from before) still gets a row.
      a = { id: u.id, description: '', status: 'running', background: false, startedAt: this.isoNow(), accountId: rec.accountId, cwd: rec.cwd };
      if (rec.nativeSessionId) a.sessionId = rec.nativeSessionId;
      list.push(a);
      // Keep the newest SUBAGENTS_KEPT, dropping finished ones first.
      while (list.length > SUBAGENTS_KEPT) {
        const i = list.findIndex((x) => x.status !== 'running');
        list.splice(i >= 0 ? i : 0, 1);
      }
    }
    if (u.itemId) a.itemId = u.itemId;
    if (u.parentId) a.parentId = u.parentId;
    if (u.description) a.description = u.description;
    if (u.agentType) a.agentType = u.agentType;
    if (u.background) a.background = true;
    if (u.toolUses !== undefined) a.toolUses = u.toolUses;
    if (u.summary) a.summary = u.summary;
    if (u.status) {
      if (u.status !== 'running' && a.status === 'running') a.endedAt = this.isoNow();
      a.status = u.status;
    }
    if (a.status !== 'running') delete a.activity;
    else if (u.activity) a.activity = u.activity;
    this.markDirty(st);
  }

  // Marks the thread's running sub-agents stopped once the CLI running them
  // has gone.
  stopSubagents(st: ThreadState): void {
    let any = false;
    for (const a of st.rec.subagents ?? []) {
      if (a.status !== 'running') continue;
      a.status = 'stopped';
      a.endedAt = this.isoNow();
      delete a.activity;
      any = true;
    }
    if (any) this.markDirty(st);
  }

  markDirty(st: ThreadState): void {
    if (st.rt.deleted) return;
    this.dirty.add(st.rec.id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.defer(() => this.flush());
  }

  // Saves changed thread.json files and sends thread.updated for them.
  flush(): void {
    this.flushScheduled = false;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const st = this.threads.get(id);
      if (!st) continue;
      try {
        this.store.save(st.rec);
      } catch (e) {
        this.log.error('could not save thread', { threadId: id, error: String(e) });
      }
      this.notify({ method: 'thread.updated', params: { thread: this.summary(st) } });
    }
  }

  summary(st: ThreadState): ThreadSummary {
    const { rec, rt } = st;
    const running = rec.status === 'running' || rec.status === 'starting';
    const background = this.background(st);
    // Not finished yet, as far as Mike's concerned: no dot, notification or
    // phone push until they're done and the agent has had its say on them.
    const unfinished = running || agentsStillWorking(background);
    const s: ThreadSummary = {
      id: rec.id,
      title: rec.title,
      cwd: rec.cwd,
      accountId: rec.accountId,
      provider: rec.provider,
      permissionMode: rec.permissionMode,
      status: rec.status,
      live: Boolean(rt.session),
      // A finished turn that said it needs nothing isn't waiting on Mike
      // (docs/protocol.md, "Needs you"). A pending design review only
      // counts once the turn ends: show_options doesn't block, and Mike
      // didn't want a "Needs you" (or a phone push) mid-turn.
      needsYou: (!unfinished && Boolean(rec.reviews?.some(r => r.status === 'pending'))) || rec.status === 'waiting' || Boolean(rec.forceUnread) || (!unfinished && rec.lastTurnCompletedSeq > rec.lastSeenSeq && !this.saidNothing(rec)),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      lastActivityAt: rec.lastActivityAt,
      preview: rec.preview,
      lastSeq: rec.lastSeq,
      lastSeenSeq: rec.lastSeenSeq,
    };
    if (rec.poolId) s.poolId = rec.poolId;
    if (rec.waitingForRoom) s.waitingForRoom = { ...rec.waitingForRoom };
    if (rec.waitingForNetwork) s.waitingForNetwork = { since: rec.waitingForNetwork.since };
    if (rec.needs && rec.needs.seq === rec.lastTurnCompletedSeq) {
      s.needs = rec.needs.needs;
      if (rec.needs.asks) {
        const ticked = new Set(rec.needs.ticked);
        s.asks = rec.needs.asks.map((a, i) => (ticked.has(i) ? { ...a, ticked: true as const } : a));
        s.asksSeq = rec.needs.seq;
      }
    }
    const pendingReviews = rec.reviews?.filter(r => r.status === 'pending').length;
    if (pendingReviews) s.pendingReviews = pendingReviews;
    if (rec.model) s.model = rec.model;
    if (rec.effort) s.effort = rec.effort;
    if (rec.modelInUse) s.modelInUse = rec.modelInUse;
    if (rec.effortInUse) s.effortInUse = rec.effortInUse;
    if (rec.snoozedUntil) s.snoozedUntil = rec.snoozedUntil;
    if (rec.snoozedUntilRestart) s.snoozedUntilRestart = true;
    if (rec.snoozedUntilRestart && rec.untilRelease) s.snoozedUntilRelease = true;
    if (rec.wakeWhen && rec.snoozedUntil) s.wakeWhen = { ...rec.wakeWhen };
    if (rec.waitingOn && rec.snoozedUntil) s.waitingOn = rec.waitingOn.map((w) => ({ threadId: w.threadId, title: w.title, ...(w.until ? { until: w.until } : {}), ...(w.done ? { done: true as const } : {}) }));
    if (rec.woke && rec.forceUnread) s.woke = { ...rec.woke };
    if (rec.archivedAt) {
      s.archivedAt = rec.archivedAt;
      // Archived before who did it was kept: nobody can say.
      if (rec.archivedBy) s.archivedBy = rec.archivedBy;
      if (rec.archiveVerdict) s.archiveVerdict = rec.archiveVerdict;
    }
    if (rec.starredAt) s.starredAt = rec.starredAt;
    if (rec.nativeSessionId && rec.sessionUsed) s.nativeSessionId = rec.nativeSessionId;
    if (rec.contextTokens !== undefined) s.contextTokens = rec.contextTokens;
    if (rec.sample) s.sample = true;
    if (rec.contextWindow !== undefined) s.contextWindow = rec.contextWindow;
    if (rec.costUsd !== undefined) s.costUsd = rec.costUsd;
    const set = this.patchSet(st);
    const actions = this.actionsOf(st, set);
    const patches = this.worktreeAction(rec) ? [...set.patches, { id: 'worktree', source: 'builtin' as const }] : set.patches;
    if (set.panels.length) s.panels = set.panels;
    if (actions.length) s.actions = actions;
    if (set.hooks.length) s.hooks = set.hooks;
    if (patches.length) s.patches = patches;
    if (background.length) s.background = background;
    if (rec.subagents?.length) s.subagents = rec.subagents.map(publicSubagent);
    const projects = this.projects?.threadProjects(rec);
    if (projects) s.projects = projects;
    if (rec.highlightsAt) s.highlightsAt = rec.highlightsAt;
    if (rec.worktree && !rec.worktree.removedAt) {
      s.worktree = { branch: rec.worktree.branch, mainCheckout: rec.worktree.mainCheckout, path: rec.worktree.path };
    }
    if (rec.schedule) s.schedule = { ...rec.schedule };
    if (rec.startedBy) s.startedBy = { ...rec.startedBy };
    if (rec.asked) s.asked = rec.asked;
    if (rec.panelRequest) s.panelRequest = { ...rec.panelRequest };
    // A record from 28 Oct may say "people" (sharing with specific people,
    // since dropped): that's not shared.
    if (rec.share) s.share = { access: rec.share.access === 'link' ? 'link' : 'off', slug: rec.share.slug, updatedAt: rec.share.updatedAt };
    // Only for the card it was checked for: a new turn's card waits for its own.
    if (rec.looseEnds && this.looseEndsCard(st) === rec.looseEnds.seq) s.looseEnds = { seq: rec.looseEnds.seq, ends: rec.looseEnds.ends.map((e) => ({ ...e })), at: rec.looseEnds.at };
    return s;
  }

  // ------------------------------------------------------------ highlights

  // ------------------------------------------------------- showing panels

  // Whether anyone with the link can read the thread on the website
  // (docs/protocol.md, "Sharing"). The mirror carries it to Convex, which
  // serves the link. The slug stays when sharing goes off, so sharing
  // again brings the same link back, as a doc's sharing does; newLink
  // makes a fresh one, which stops the old link for good.
  share(threadId: string, args: { access: ShareAccess; newLink?: boolean }): { thread: ThreadSummary } {
    const st = this.mustGet(threadId);
    if (args.access !== 'off' && args.access !== 'link') throw new RpcError(ErrorCode.badParams, 'access is "off" or "link"');
    const slug = !st.rec.share || args.newLink ? crypto.randomBytes(16).toString('base64url') : st.rec.share.slug;
    st.rec.share = { access: args.access, slug, updatedAt: this.isoNow() };
    this.markDirty(st);
    return { thread: this.summary(st) };
  }


  // A thread by full id or unique prefix, for titles; undefined if unclear.
  findThread(q: string): ThreadSummary | undefined {
    const exact = this.threads.get(q);
    if (exact) return this.summary(exact);
    const hits = [...this.threads.values()].filter((t) => t.rec.id.startsWith(q));
    return hits.length === 1 ? this.summary(hits[0]) : undefined;
  }

  // The most access a thread's agent has now: its mode, or more while a
  // turn that started with (or was raised to) more is still running.
  // threadbear-mcp.ts, "Raising access", goes by it for messages.
  accessOf(threadId: string): PermissionMode {
    const { rec, rt } = this.mustGet(threadId);
    return moreAccess(rt.turn?.access, rec.permissionMode);
  }

  // Whether a thread's CLI is shut in a sandbox (ThreadRecord.confined).
  confinedOf(threadId: string): boolean {
    return Boolean(this.mustGet(threadId).rec.confined);
  }

  // Whether a Claude thread in `cwd` would run in a sandbox (sandbox.ts),
  // by where the folder really is.
  sandboxed(cwd: string): boolean {
    return Boolean(sandboxFor(this.cfg.sandbox, cwd));
  }

  mustGet(threadId: string): ThreadState {
    const st = typeof threadId === 'string' ? this.threads.get(threadId) : undefined;
    if (!st) {
      // Let go by this draining runner, which still answers on the runner's
      // port until its drain port is up (main.ts handOver), a few seconds:
      // the new runner has it in a moment. The Mac app tries again there on
      // these words (AppModel.turnedAwayByRestart); Mike saw "Thread not
      // found" picking an effort in that gap (7 Nov).
      if (this.draining?.gone.has(threadId)) throw new RpcError(ErrorCode.busy, 'The runner is handing over to a new one; try again in a moment.');
      throw new RpcError(ErrorCode.threadNotFound, `Thread not found: ${threadId}`);
    }
    return st;
  }

  // What a starting session is told about the thread's projects. Only a
  // fresh session: Claude Code keeps a resumed session's system prompt and
  // ignores an appended one, so a resume hears through projectNews.
  briefFor(rec: ThreadRecord, resume: boolean): { instructions?: string } {
    if (resume) return {};
    const parts: string[] = [];
    // Mike's own standing instructions first: they're for everything.
    const standing = this.standingInstructions?.().trim() ?? '';
    if (standing) {
      rec.instructionsTold = instructionsHash(standing);
      parts.push(standingText(standing));
    } else if (rec.instructionsTold !== undefined) {
      // Not forgotten: a session id already in use goes back to the session
      // that held them (below, inUse). With none ever, nothing's written.
      rec.instructionsTold = INSTRUCTIONS_CLEARED;
    }
    if (this.projects) {
      rec.projectsTold = this.projects.briefIds(rec);
      const brief = this.projects.brief(rec);
      if (brief) parts.push(brief);
    }
    // Where its worktree is and how its work gets to main.
    if (rec.worktree && !rec.worktree.removedAt) parts.push(worktreeInstructions(rec.worktree));
    return parts.length ? { instructions: parts.join('\n\n') } : {};
  }

  // Mike's standing instructions, when they've changed since the session
  // last heard them (or it never has): a resumed Claude session keeps its
  // first system prompt, so the change comes before his next message.
  instructionsNews(rec: ThreadRecord): string | undefined {
    if (!this.standingInstructions) return undefined;
    const standing = this.standingInstructions().trim();
    const before = rec.instructionsTold;
    if (!standing) {
      // Nothing written while it never held any: with the experiment off a
      // thread record doesn't change at all.
      if (before === undefined || before === INSTRUCTIONS_CLEARED) return undefined;
      rec.instructionsTold = INSTRUCTIONS_CLEARED;
      return 'Note from Threadbear: the user cleared their standing instructions; earlier ones no longer apply.';
    }
    const hash = instructionsHash(standing);
    if (before === hash) return undefined;
    rec.instructionsTold = hash;
    return `Note from Threadbear: the user's standing instructions${before === undefined || before === INSTRUCTIONS_CLEARED ? '' : ' have changed, and replace any earlier ones'}.\n\n${standingText(standing)}`;
  }

  // Sends a message with any change to the standing instructions in front.
  // They count as told only once the CLI has taken it: a send that throws
  // (a picture gone from the queue) would otherwise use up a clear that never
  // arrived (Codex review). In the transcript too, as a change anything made
  // reaches every thread, so it shouldn't only be something agents can see.
  sendWithInstructionsNews(st: ThreadState, message: UserInput): void {
    const { rec, rt } = st;
    const before = rec.instructionsTold;
    const standing = this.instructionsNews(rec);
    try {
      rt.session!.send(standing ? { ...message, text: `${standing}\n\n${message.text}` } : message);
    } catch (e) {
      if (before === undefined) delete rec.instructionsTold;
      else rec.instructionsTold = before;
      throw e;
    }
    if (!standing) return;
    // A turn that ends any other way may have dropped it (a message Codex was
    // still holding when Stop came), so the turn's end looks at this.
    rt.instructionsNewsSent = true;
    // Only a note: failing here would report a message the CLI has as lost.
    try {
      this.emit(st, { type: 'system.note', text: "Told this thread's agent about a change to your standing instructions." }, message.id);
    } catch (e) {
      this.log.warn('could not note the standing instructions change', { threadId: rec.id, error: String(e) });
    }
  }

  // At a turn's end: news sent in a turn that didn't complete may never have
  // arrived, so the next message says what's current.
  settleInstructionsNews(st: ThreadState, completed: boolean): void {
    const { rec, rt } = st;
    if (rt.instructionsNewsSent && !completed && rec.instructionsTold !== undefined) rec.instructionsTold = INSTRUCTIONS_REWOUND;
    rt.instructionsNewsSent = false;
  }

  // The thread's projects its session hasn't been told about, as lines to
  // put before its next message, or undefined. A thread whose session
  // predates projects (never told anything) gets the whole brief.
  projectNews(rec: ThreadRecord): string | undefined {
    if (!this.projects) return undefined;
    const ids = this.projects.briefIds(rec);
    const told = rec.projectsTold;
    const fresh = ids.filter((id) => !told?.includes(id));
    rec.projectsTold = ids;
    if (!fresh.length) return undefined;
    return told === undefined ? this.projects.brief(rec) : this.projects.joinedLines(fresh);
  }

  isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }

  // Test and CLI helpers.
  threadIds(): string[] {
    return [...this.threads.keys()];
  }

  isLive(threadId: string): boolean {
    return Boolean(this.threads.get(threadId)?.rt.session);
  }

  hasIdleTimer(threadId: string): boolean {
    return Boolean(this.threads.get(threadId)?.rt.idleTimer);
  }

  status(threadId: string): ThreadStatus | undefined {
    return this.threads.get(threadId)?.rec.status;
  }

  // Threads from before `asked` (3 Nov 2026) learn it from the end of
  // their log, once. Only the inbox's and hibernating ones: an archived
  // thread's row doesn't show it, and there can be thousands of those.
  backfillAsked(rec: ThreadRecord): void {
    const log = this.store.log(rec.id);
    const events = log.read(Math.max(1, log.lastSeq - 300), log.lastSeq);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const asked = e.type === 'user.message' ? askedLine(e, rec.reviews) : undefined;
      if (asked) {
        rec.asked = asked;
        return;
      }
    }
  }

  // A note outside any turn (restart.ts: "Runner restarted: ...").
  note(threadId: string, text: string): void {
    this.emit(this.mustGet(threadId), { type: 'system.note', text });
  }

  // Something about this Mac rather than any thread's work (mac-screen.ts):
  // a note in a thread of its own, in Needs you, so it reaches the other
  // Macs and the phone. No turn: nothing here needs a model. One that's been
  // archived has been dealt with, so that gets a new one.
  noticeOnMac(threadId: string | undefined, title: string, text: string): string {
    let st = threadId ? this.threads.get(threadId) : undefined;
    if (!st || st.rt.deleted || st.rec.archivedAt) st = this.makeThread({ text, title, worktree: false, origin: 'runner', startedBy: { kind: 'runner', label: 'Threadbear' } }).st;
    st.rec.forceUnread = true;
    st.rec.preview = oneLine(text, LIMITS.previewChars);
    this.emit(st, { type: 'system.note', text });
    this.markDirty(st);
    return st.rec.id;
  }

  noticeOverOnMac(threadId: string, text: string, archive: boolean): void {
    const st = this.mustGet(threadId);
    // Without archive something in the thread is still to do (a dialog
    // still up, or the access still missing), so it stays in Needs you.
    if (archive) st.rec.forceUnread = false;
    this.emit(st, { type: 'system.note', text });
    this.markDirty(st);
    if (archive && !st.rt.turn && !st.rec.archivedAt && this.opening(threadId).text === undefined) this.update({ threadId, archived: true, archivedBy: 'threadbear' });
  }
}

// The Runner's other methods live in parts under runner/, one area each;
// they go onto its prototype here, as the class's own methods would be.
for (const part of [looseEndsPart, labReviewPart, newThreadsPart, hibernationPart, titlesPart, highlightsPart, patchesPart, editingPart, clisPart, reviewsPart, buttonsPart, approvalsPart, projectsHostPart, stoppedWorkPart, handoversPart, poolsPart, networkPart, worktreesPart, commandsPart]) {
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
    Object.defineProperty(Runner.prototype, key, { ...d, enumerable: false });
  }
}

// answers: the asks the message answers (AskAnswer), for the app to show.
// A wait started again can be stopped again by the next landing, so this
// many wakes in a row at most, reset by anyone else writing to the thread.
export const STOPPED_WORK_WAKES = 3;
// A runner that was away this long (a Mac left off for days) shouldn't wake
// every thread that had something going when it went.
export const STOPPED_WORK_WAKE_MAX_AGE_MS = 24 * 60 * 60_000;

export function stoppedWorkMessage(what: string[], last: boolean): string {
  const one = what.length === 1;
  const lines = what.map((w) => `- ${cutSafely(w, 203, '...')}`);
  return [
    `Threadbear stopped ${one ? 'this background job' : 'these background jobs'} of yours when the runner restarted onto a new release, so nothing more will come from ${one ? 'it' : 'them'}:`,
    '',
    ...lines,
    '',
    `If you said you'd report back or carry on after ${one ? 'it' : 'them'}, check how far ${one ? 'it' : 'they'} got and do that now; work running elsewhere may have finished by itself. Start ${one ? 'it' : 'them'} again only if that's still needed. An update only holds background work for about 4 hours past your last turn, so for a longer wait use schedule_message to come back and check. If it no longer matters, say so in a line.`,
    ...(last ? ['', "Threadbear won't wake this thread for this again, so if the user needs to step in, ask them in end_turn."] : []),
  ].join('\n');
}

export type SendOptions = { origin?: MessageOrigin; scheduleId?: string; queue?: boolean; answers?: AskAnswer[]; editOf?: number };

// Typed by Mike, at the Mac or on his phone: not the runner's, a
// schedule's or an agent's (another thread's, or this one's own `then`
// from move_thread, which once stopped the turn that sent it on a move to
// another login).
export function fromMike(text: string, opts: SendOptions): boolean {
  if (opts.origin && opts.origin !== 'phone') return false;
  return !sentByAgent(text);
}

// What the agent is told when Mike writes a message while its question or
// approval card is still open (sendTo).
export const WROTE_INSTEAD = "The user didn't answer this; they wrote you a message instead, which comes next. Read it before asking again.";

// What a pool thread is told when it carries on by itself after its login
// ran dry (docs/protocol.md, "Pools").
export const CARRY_ON_MOVED = 'Your last login hit its usage limit partway through that turn, so this thread has moved to another one. Carry on from where you left off.';
export const CARRY_ON_RESTART = 'The runner stopped partway through that turn (Threadbear or the Mac restarted) and is back now. Carry on from where you left off.';
// Past this, a cut-off turn is left for Mike: the Mac was off for a while,
// and he may have moved on.
export const STOPPED_CARRY_ON_MAX_AGE_MS = 12 * 3_600_000;
export const CARRY_ON_NETWORK = "The connection to the API dropped partway through that turn and is back now. Carry on from where you left off.";
// How a thread waits for the network: probes 5s, 10s, 20s... apart, at
// most a minute; a carry-on that can't get through either counts as a
// try; after five, or six hours from the first failure, it's left to Mike.
export const NET_PROBE_FIRST_MS = 5_000;
export const NET_PROBE_MAX_MS = 60_000;
export const NET_CARRY_ON_MAX = 5;
export const NET_WAIT_MAX_MS = 6 * 3_600_000;
export const CARRY_ON_BACK = 'Your login hit its usage limit partway through that turn and has room again now. Carry on from where you left off.';

// How many sub-agents a thread keeps in its summary.
const SUBAGENTS_KEPT = 20;

function publicSubagent(a: SubagentRecord): Subagent {
  const { sessionId: _s, cwd: _c, accountId: _a, ...rest } = a;
  return rest;
}

export function userMessage(msg: QueuedSend): EventBody {
  return {
    type: 'user.message',
    text: msg.text,
    images: msg.images,
    ...(msg.origin ? { origin: msg.origin } : {}),
    ...(msg.scheduleId ? { scheduleId: msg.scheduleId } : {}),
    ...(msg.reviewId ? { reviewId: msg.reviewId, reviewResponse: msg.reviewResponse } : {}),
    ...(msg.answers?.length ? { answers: msg.answers } : {}),
    ...(msg.editOf ? { editOf: msg.editOf } : {}),
  };
}

export function checkImages(images: ImageRef[]): void {
  for (const img of images) {
    if (!img || typeof img.path !== 'string' || !fs.existsSync(img.path)) {
      throw new RpcError(ErrorCode.badParams, `Image not found: ${img?.path}`);
    }
  }
}

export function newRuntime(activeAt: number): Runtime {
  return {
    generation: 0,
    resumed: false,
    retriedFresh: false,
    tasks: [],
    finished: [],
    activeAt,
    approvals: new Map(),
    releaseWhenIdle: false,
    inProgress: new Map(),
    pendingDeltas: new Map(),
  };
}

function sortByActivity(list: ThreadSummary[]): ThreadSummary[] {
  return list.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
}

export function titleFrom(text: string): string {
  if (!(text ?? '').trim()) return 'Image';
  return firstLineSafely(text, LIMITS.titleChars);
}

// What the runner asks a small model for a thread's title. The examples
// do more than the rules: without them Haiku drifts into Title Case and
// sometimes describes the naming job itself.
export const TITLE_PROMPT = [
  'You name threads in Threadbear, an app for running AI agents, mostly for coding.',
  'Reply with the title only: 2 to 6 words saying what the thread is about.',
  'Sentence case: a capital for the first word and for names only. No quotes, no full stop, no dashes, no emoji.',
  'Never mention titles, threads or the person asking.',
  '',
  'Message: can you look at why the upload test keeps failing on CI',
  'Title: Fix the flaky upload test on CI',
  '',
  'Message: Hey, does the runner keep running even if we restart the UI?',
  'Title: Does the runner outlive the app',
  '',
  'Message: hello there',
  'Title: Hello',
].join('\n');

// A model's title, tidied: first line, no wrapping quotes or full stop,
// nothing after a dash. One that runs long (rambling, or cut off by the
// token limit) is no title at all, so the first line stays.
export function cleanTitle(text: string): string {
  let t = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t.replace(/^(title:\s*)/i, '').split(/\s[—–-]\s/)[0];
  t = t.replace(/^\*+|\*+$/g, '').trim();
  // Quotes only when they wrap the whole title; ones inside it stay.
  if (/^(["'`]).*\1$/.test(t)) t = t.slice(1, -1);
  t = t.replace(/\.$/, '').trim();
  if (t.length > LIMITS.titleChars || t.split(/\s+/).length > 10) return '';
  // Each tidy-up (its first line, before a dash, without quotes or a full
  // stop) is a cut of the model's text: one through a secret is no title
  // (safe-cut.ts), and the thread keeps the one titleFrom made.
  const at = (text ?? '').indexOf(t);
  if (t && (at < 0 || !isSafeSlice(text, at, at + t.length))) return '';
  return t;
}

// What a completed turn needs from Mike: its end_turn call, then its last
// text's "What I need from you" section, else nothing said.
function turnNeeds(turn: Turn): (Needs & { from: 'tool' | 'text' }) | undefined {
  const tool = turn.endTurn && needsFromTool(turn.endTurn);
  if (turn.replyNeeds) return { ...turn.replyNeeds, from: 'text' };
  if (tool) return { ...tool, from: 'tool' };
  if (turn.command) return undefined;
  const text = turn.lastText && needsFromText(turn.lastText);
  return text ? { ...text, from: 'text' } : undefined;
}

// The sidebar's "You: ..." line: what Mike last said to a thread, in one
// line. Not the runner's, a schedule's or another agent's messages, which
// he didn't write. A design review's reply is his words (reply, then
// notes), or which ones he picked, without the "Review: <title> (<id>)" heading.
export function askedLine(m: { text: string; origin?: MessageOrigin; reviewId?: string; reviewResponse?: ReviewDraft }, reviews?: DesignReview[]): string | undefined {
  if (!fromMike(m.text, m)) return undefined;
  let text = m.text;
  if (m.reviewId && m.reviewResponse) {
    const r = m.reviewResponse;
    const words = [r.reply, ...Object.values(r.notes)].filter(Boolean);
    const options = reviews?.find(v => v.id === m.reviewId)?.options ?? [];
    const picked = (r.pickedIds ?? (r.pickedId ? [r.pickedId] : [])).map(id => options.find(o => o.id === id)?.title).filter(Boolean);
    text = words.length ? words.join(' ') : picked.length ? `Picked ${picked.join(' + ')}` : r.none ? 'None of them' : '';
  }
  return oneLine(text, LIMITS.previewChars) || undefined;
}

export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  // Never through a secret: these lines go to Convex (safe-cut.ts).
  return cutSafely(s, max, '…');
}

// A provider's name in notes.
export function providerName(p: Provider): string {
  return p === 'codex' ? 'Codex' : 'Claude';
}

function cliName(p: Provider): string {
  return p === 'codex' ? 'Codex' : 'Claude Code';
}

// Claude's own ids: its aliases, and anything starting claude- (with or
// without a [1m] suffix).
export function isClaudeModel(id: string): boolean {
  const bare = stripModelSuffix(id).toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'default', 'opusplan'].includes(bare) || bare.startsWith('claude-');
}

// The account's row for a model id, matched by picker id or full id.
export function modelRow(account: Account, model: string | undefined): ModelChoice | undefined {
  if (!model) return undefined;
  return account.models?.find((m) => m.id === model || m.model === model);
}

export function modelTitle(account: Account, model: string): string {
  return modelRow(account, model)?.title ?? model;
}

const EFFORT_TITLES: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

export function effortTitle(e: EffortLevel): string {
  return EFFORT_TITLES[e] ?? e;
}

// "A", "A and B", "A, B and C".
function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// What clients were last told about the accounts, to tell a real change
// from a rescan that found the same list.
function accountsKey(accounts: Account[]): string {
  return JSON.stringify(accounts);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Maps answers keyed by question text, header or index to question text,
// which is what the CLI's AskUserQuestion expects.
export function matchAnswers(questions: Question[], answers: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const v = answers[q.question] ?? (q.header ? answers[q.header] : undefined) ?? answers[String(i)];
    if (typeof v === 'string') out[q.question] = v;
  });
  if (questions.length && Object.keys(out).length === 0) return null;
  return out;
}

// Opens a url action's page in the default browser. No shell: the url goes
// to `open` as one argument, so nothing in it can be read as a command, and
// it's checked again here as only a web page.
function openInBrowser(url: string): Promise<void> {
  const page = webPage(url);
  if (!page) return Promise.reject(new RpcError(ErrorCode.badParams, `Not a web page: ${url}`));
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [page], (err) => (err ? reject(new RpcError(ErrorCode.other, `Couldn't open ${page}: ${err.message}`)) : resolve()));
  });
}

const ACCESS_ORDER: PermissionMode[] = ['ask', 'auto', 'full'];
function moreAccess(a: PermissionMode | undefined, b: PermissionMode): PermissionMode {
  return a && ACCESS_ORDER.indexOf(a) > ACCESS_ORDER.indexOf(b) ? a : b;
}

// Mike's standing instructions as an agent is given them.
function standingText(text: string): string {
  return `The user's standing instructions (set in Threadbear, Settings > General, the only place they can change: writing the file does nothing). Keep them in mind in everything you do for them:\n\n${text}`;
}

function instructionsHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
