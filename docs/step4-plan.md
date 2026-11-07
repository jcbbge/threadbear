# Step 4: Codex, every account, usage and CLI updates

This is `docs/step4-plan.md`. It follows `docs/plan.md` ("Later steps") and `docs/dev-tools.md`.

Updated on 27 Oct with two things: the spike results (summed up in "Checked" near the end, and folded into each section), and what landed on main after the first version (`3aea55f`), described in "Starting point".

## Why

Mike still keeps T3 Code because Threadbear is missing four things:

- Codex threads;
- all of his logins;
- the usage numbers he checks before he picks an account;
- CLIs that stay up to date without him having to think about it.

Two of his complaints about T3 shape the details.

- **Codex's generated images never show up in T3.** The cause is in T3's Codex adapter (`CodexAdapterV2.ts`, inside `/Applications/T3 Code (Beta).app/.../binCli-BQvPfujE.mjs`).
  - Its `item/started` and `item/completed` handlers have no branch for `imageGeneration` or `imageView`, so it drops both.
  - Codex then tells the model "The generated image is already displayed to the user. There is no need to render it in the final response". So the reply doesn't link the image either, and the image is gone from the transcript.
  - Everything needed is on the wire. `item/completed` carries `savedPath` and the base64 `result`, and the two are byte-identical (checked by sha256 on a live run, and again in the 27 Oct captures).
  - T3 also ignores traffic from subagent threads, so images a subagent makes vanish the same way.
- **Images are half broken in general.** T3 passes MCP image results through as raw JSON with base64 inside. Its history import maps no image items.

Threadbear already handles images properly for Claude, with a media folder, inline thumbnails and Quick Look. This step puts Codex on the same path. Every image a Codex thread receives, looks at or makes becomes a file in the thread's media folder and shows inline. That includes images from its subagents.

**Correction to `docs/plan.md`.** One line in it is wrong: "`pathToClaudeCodeExecutable` = `~/.local/bin/claude` so the CLI keeps updating itself". SDK sessions never update the CLI. Only the terminal UI, `claude update` and `claude install` do.

**How the CLIs get updated today.** Token Stats keeps both CLIs current once a day. `cli-updates.log` shows `claude update` and `npm install -g @openai/codex@latest` every day since 19 Oct. T3 also has an "Update all" button.

**Why Codex needs its own copies.** Token Stats' daily npm install swaps the whole package tree even when the version hasn't changed. The log's last entry reads:

```
== 2026-10-26T08:10:28Z
-- codex: 0.164.0 -> 0.164.0 (exit 0)
changed 2 packages in 2s
```

The earlier days look the same. Those runs land in Mike's afternoon.

- A running Codex process survives the swap.
- The helpers it starts by path don't. These are the `apply_patch` and `codex-execve-wrapper` links in `~/.codex/tmp/arg0/`, which point into `.../@openai/codex/node_modules/.../bin/codex`. For 1 to 3 seconds they point at nothing, and after that they start the new version.

So Threadbear runs Codex from its own versioned copies, which nothing else touches, and updates them itself. Claude's native installer already keeps each version in its own file, so Claude keeps using the shared install.

This step adds hourly checks, shows the versions in the app, and makes updates safe for threads that are running.

## What it's like when it's done

- **Account menu.**
  - It lists the Claude and Codex logins, grouped by provider.
  - Each item shows how much room is left, for example "5h 89% · week 78%".
  - claude-2 also says "Convex work only".
  - Picking the Codex login switches the model menu to Codex's models, and the Effort section to that model's levels (up to Ultra).
- **Codex turns read like Claude turns.**
  - Text streams in.
  - Commands and edits fold into the work line, with diffs. An edit that touches three files lists all three.
  - "Ask before edits" cards appear when that mode is on, including for Codex's subagents.
  - The plan updates as the turn goes.
  - A message sent while a Codex turn runs goes into that turn, as it does for Claude.
  - A command still running when the turn ends shows as background work, and its output fills in when it finishes.
  - The turn footer shows how long the turn took and its tokens (Codex reports no dollar cost).
- **Images show inline.**
  - A generated image appears large under the work line. Clicking it opens Quick Look.
  - The same goes for images Codex looks at, screenshots that come back from MCP tools, and images made by Codex's subagents.
- **Sidebar rows.** Codex threads say "Codex". Claude rows look the same as today.
- **Usage button.**
  - "Usage" in the sidebar footer lists every account's limits.
  - Below that it shows the two CLI versions, with an Update button when one is behind.
  - If a Codex update has been held back, it says why.
- **CLI updates.**
  - When an update lands, running turns carry on and the next turn uses the new version.
  - The thread gets a one-line note saying so.
  - Nothing Token Stats or T3 does to their own Codex install can break a Threadbear turn.

## Starting point (main on 27 Oct)

Main is at `5a17e6d`. What changed since the first version of this plan (`3aea55f`), and what it means here:

- **`4e6c270` "Model picker: real names, a starred default and an effort level"** already built part of what Contracts and F were going to do. Extend it; don't redo it.
  - `Account` has `defaultModel` (settings.json's model, corrected by the first turn seen on a thread with no model) and `models: ModelChoice[]` (`{id, model, title, description?, effortLevels?}`).
  - The runner fills `models` once at startup through the optional `AgentAdapter.models?(account)`, one account at a time (`Runner.probeModels`). `AccountRegistry.learn()` keeps what it learns and `enrich()` adds it to the list.
  - The `accounts.updated { accounts }` notification exists. The runner sends it when `learn()` changes something, and the app replaces its list on it (`RPCClient` `.accountsUpdated`, `AppModel`).
  - Threads have `effort` (`EffortLevel`: low, medium, high, xhigh, max), `modelInUse` and `effortInUse`. `threads.create`, `threads.update`, `StartSessionOptions.effort`, `AgentSession.setEffort` (required, not optional), the `{kind: 'effort'}` output, `tb new --effort` and the MCP tools all take it. Claude uses it, so "effort is Codex only" no longer holds.
  - The composer's model chip reads "Fable 5.1 · High". Its menu lists `Account.models` by title with a star on the default, puts ids that aren't one word under "Older models", and ends with an Effort section (`ThreadSettings` in `ComposerControls.swift`; `ComposerChips.chipTitle`, `modelTitle`, `effortTitle`). Until the list arrives it shows the three Claude aliases.
  - The `composer-menu` automation command lists or clicks the model, account, permission and folder menus, so a scripted app can check them.

  So this plan drops its own `models.list` request, `ModelInfo` type and `models-cache.json`. Codex fills `Account.models` through the same `models()` call. Thread `effort`, `setEffort` and `accounts.updated` are no longer Contracts' work.
- **The app updates itself from main** (`25dfa8a`, `b28c3d3`). A few minutes after a change under `app/` reaches main, Mike's installed app builds it in the background and swaps it in when he isn't using it. So F reaches him as soon as it lands on main, possibly days before the runner is deployed. The new app must work against today's runner (see "Compatibility" in Contracts), and nobody needs to tell Mike to install it.
- **Dev tools** (`5e6ce54`). `dev-runner.sh` prints a `<dev home>/tb` and deletes its temp home when it stops (`--keep` keeps it). `check.sh` prints what failed before the log ends.
- **Steering, in progress.** On 27 Oct Mike's own threads had uncommitted changes in main's working tree that send a message typed during a turn into that turn, instead of queueing it:
  - `Runner.canSteer()` and `steer()` call `session.send()` while a turn runs, and emit the `user.message` under the running turn;
  - the runner's `Turn` keeps a list of `messages` and only completes when the CLI has answered them all;
  - `TurnResult` gains `answered?: string[]` (every message a CLI turn took, in order) and `queuedTurns?: number` (messages still in the CLI's own queue). With messages left and `queuedTurns === 0`, the runner notes "A message sent during this turn was dropped by the CLI. Send it again.";
  - Claude's `interrupt()` cancels queued messages too ("Stop means stop");
  - the send button's help reads "Send (into this turn)".

  It touches `docs/protocol.md` (`threads.send`, `turn.started`), `adapters/types.ts`, `runner.ts`, `claude/adapter.ts`, `claude/normalize.ts`, `threadbear-mcp.ts`, `ComposerControls.swift`, `test/helpers/fakes.ts` and the runner tests. Codex has to fit it: see "Messages during a turn" in A. Until it's committed, leave those hunks alone. Once it's on main, merge main into `step4` and build on it.

Other threads commit to main while this runs. Check `git log main` before each piece branches, and merge main into `step4` before C starts and again before landing.

## Shape

Seven pieces. Contracts goes first, on its own. The rest run in parallel. Each piece owns its files, and nobody else edits them until it has merged.

All of it happens on the integration branch `step4` (worktree `~/dev/me/threadbear-step4/integrate`). Each piece works in its own worktree under `~/dev/me/threadbear-step4/`, on a branch from `step4`, and merges back into `step4` in the order under "Build order". The Land step merges `step4` into main.

| Piece | Owns |
|---|---|
| 0. Contracts | `docs/protocol.md`, `docs/plan.md` (line fixes), `runner/src/protocol.ts`, `runner/src/adapters/types.ts`, new `runner/src/adapters/context.ts` (it moves `NormalizerContext` and `fileContext` out of `claude/normalize.ts` and leaves a re-export there), new fields in `runner/src/config.ts`, `runner/test/helpers/protocol-check.ts`, `app/Sources/ThreadbearCore/Protocol/Models.swift` and `Event.swift`, `app/Tools/mock-runner/server.mjs` (new fields only), `app/Tests/ThreadbearCoreTests/ModelsTests.swift` |
| A. Codex sessions | `runner/src/adapters/codex/appserver.ts`, `adapter.ts`, `approvals.ts`, `tools.ts`, `types.ts`, `surface.ts`, `runner/scripts/codex-schema-check.sh`, `runner/test/helpers/fake-app-server.ts`, `runner/test/unit/codex-appserver.test.ts`, `codex-adapter.test.ts`, `codex-approvals.test.ts`, `runner/test/e2e/codex.e2e.test.ts` |
| B. Codex events and images | `runner/src/adapters/codex/normalize.ts`, `runner/src/media.ts`, `runner/src/adapters/context.ts` (after Contracts creates it), `runner/scripts/sanitize-codex-recording.ts`, `runner/test/fixtures/codex/`, `runner/test/unit/codex-normalize.test.ts`, `media-files.test.ts` |
| C. Runner plumbing | `runner/src/runner.ts`, `main.ts`, `rpc.ts`, `store.ts`, `threadbear-mcp.ts`, `cli.ts`, `tb-dev.ts`, `runner/scripts/dev-runner.sh`, `runner/test/helpers/fakes.ts`, `runner/test/unit/runner.test.ts`, `rpc.test.ts`, `threadbear-tools.test.ts`, `tb.test.ts`, `check.sh` |
| D. Accounts and usage | `runner/src/accounts.ts` (extending `4e6c270`'s `defaultModel`, `learn()` and `enrich()`), new `runner/src/usage.ts`, the rate-limit parts of `runner/src/adapters/claude/normalize.ts` (the `rate_limit_event` case and the rate-limit `errorKind`), `runner/test/unit/accounts-usage.test.ts`, the existing `diff-media-accounts.test.ts`, `runner/test/fixtures/token-stats/` |
| E. CLI updates | new `runner/src/updates/` (`manager.ts`, `claude.ts`, `codex.ts`, `history.ts`), `runner/test/unit/updates.test.ts`, `runner/test/e2e/codex-install.e2e.test.ts` |
| F. App | `Views/ComposerControls.swift` (extending `ThreadSettings`' menus), `Views/SidebarView.swift`, new `Views/UsagePopover.swift`, `Transcript/RowRenderer.swift` (the turn footer), `Screenshots.swift` (new scenes), `Automation.swift` and `AppDump.swift` (where the new menus and popover need to be scriptable), `AppModel.swift`, `ThreadbearCore/RPC/RunnerAPI.swift`, `RPCClient.swift`, `ThreadbearCore/Threads/ComposerChips.swift`, `SidebarRow.swift`, new `ThreadbearCore/Threads/AccountUsageText.swift`, `ThreadbearCore/Transcript/TranscriptRow.swift`, `TranscriptReducer.swift`, `ToolPresentation.swift`, `WorkGroups.swift` (summary words and the Edited files card), `ThreadbearCore/Support/ImageLayout.swift`, the mock runner's demo threads and fixtures, and the app tests for all of these (including `ComposerChipsTests.swift`) |

**Who edits what:**

- C is the only piece that edits `runner.ts`, `main.ts` and `rpc.ts`.
- D and E deliver modules with the interfaces given below. They merge before C, and C wires them in. That keeps the busy files to one owner.
- B adds new media tests in its own `media-files.test.ts` and doesn't change how the existing media functions behave. That keeps `diff-media-accounts.test.ts` with D.
- Mike's steering change touches `runner.ts`, `types.ts`, `fakes.ts`, `claude/normalize.ts` and `ComposerControls.swift`. Whoever owns those files here rebases onto it, keeps its behaviour, and extends around it.

**Captures (done on 27 Oct).** The Codex captures were recorded again, and the spikes added their own:

- They live in `~/dev/me/threadbear-step4-prep/runner/.fixtures/codex-raw/`, gitignored. Its `README.md` lists every file, the line range of every turn and what the sanitiser has to drop. The spike captures are under `spikes/<spike>/`, each with its own notes or README. The recording scripts are in `scripts/` and `spikes/<spike>/scripts/`.
- Copy the folder into your worktree's `runner/.fixtures/codex-raw/` if you need it.
- Messages are complete this time: nothing is shortened, and base64 payloads are kept as they are.
- They still hold private data: Mike's ChatGPT account id (`accountId` and `workspaceRouting.chatgptAccountId`, in `probe.ndjson` lines 9 and 11 and `probe-images.ndjson` lines 7 and 9), credit balances, moderation metadata, `codexHome`, `/Users/m5-mike` paths, the Mac's hostname and `installationId`, and private hook text. They stay out of git until B's sanitiser has run over them.
- Don't copy any of Mike's real rollouts.

## 0. Contracts (protocol first)

Change `docs/protocol.md` first, then make `protocol.ts` and the Swift models match it. Both sides must keep ignoring unknown fields, event types, notifications and enum values.

### Types

```ts
type Provider = "claude" | "codex"

// "ultra" is Codex's multi-agent level (its ThreadSettings.multiAgentMode is
// deprecated in favour of it). Claude never offers it.
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

type Account = {
  id: string              // "claude-main", "claude-1", "codex-main", "codex-1", ...
  provider: Provider
  title: string           // Claude: the email when known, else the id. Codex: "Codex · <email>", so old apps can tell it from a Claude login with the same address
  configDir: string
  defaultModel?: string   // as today. Codex: config.toml's top-level model, else model/list's isDefault, corrected by the first turn
  models?: ModelChoice[]  // as today. Codex: model/list without hidden models
  defaultEffort?: EffortLevel // Codex: config.toml's model_reasoning_effort. Absent means each model's own level
  email?: string          // the bare address; new apps build their labels from this plus provider
  plan?: string           // "Max", "Team", "Pro Lite"
  note?: string           // Mike's own note for the account, from runner.json ("Convex work only")
  usage?: AccountUsage    // absent when nothing is known
}

type ModelChoice = {      // as today, plus defaultEffort
  id: string, model: string, title: string, description?: string,
  effortLevels?: EffortLevel[],
  defaultEffort?: EffortLevel // Codex: the model's defaultReasoningEffort
}

type UsageWindow = {
  kind: "five_hour" | "weekly" | "weekly_model" | "daily" | "monthly" | "allowance" | "other"
  title: string           // "5-hour", "Weekly", "Weekly Fable", "$250 allowance"
  remainingPercent: number // 0 to 100
  resetsAt?: string
  detail?: string         // "$132.79 left"
}

type AccountUsage = {
  windows: UsageWindow[]
  readAt: string          // when the newest reading in it was taken
  source: "tokenStats" | "live"
  stale?: boolean         // Token Stats hasn't written for 15 minutes and there's no live reading since
  blocked?: boolean       // the provider says this login is at its limit
  notice?: string         // Token Stats' own note, such as "64,390 credits · 2 limit resets available"
}
```

**`ThreadSummary` changes:**

- `provider` becomes `Provider`.
- New `contextWindow?: number`, the model's window when the CLI reports it (258,400 for gpt-6-luna, 475,000 for gpt-6.1-sol).
- `effort`, `modelInUse` and `effortInUse` already exist.

**`ToolKind`** gains `"image"`, for image generation.

**`edit.diff`** is documented as one event per path. A tool can have several. A repeated `path` on the same `itemId` replaces that path's earlier diff; a new path adds one.

**`turn.completed`:**

- `usage` is documented per provider:
  - Claude: `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`, as today.
  - Codex: `{inputTokens, cachedInputTokens, cacheWriteTokens?, outputTokens, reasoningTokens}`.
- Codex turns have no `costUsd`.
- New `errorKind?: "usageLimit" | "contextWindow" | "auth"`, so the app can offer the right fix without matching on message text.

### Requests

**`hello`:**

- `defaults` gains `models?: { claude?: string, codex?: string }` and `efforts?: { claude?: EffortLevel, codex?: EffortLevel }`.
- `defaults.model` stays and means Claude's model, so old apps keep working.
- The result gains `clis?: CliStatus[]`.

**`threads.create`** (it already takes `effort`):

- With no `model`, the thread gets `defaults.models[provider]`, or `defaults.model` for Claude, or else the account's own default.
- With no `effort`, `defaults.efforts[provider]` if set, or else the model's own level.
- The runner checks `model` and `effort` against the account's provider:
  - A model of the other provider is dropped and replaced by the provider's default, with a `system.note`. Example: "sonnet isn't a Codex model, so this thread uses GPT-6.1-Sol".
  - Same for a Codex id that isn't in the account's `models`, once they're known.
  - Claude ids are `opus`, `sonnet`, `haiku` and anything starting `claude-`. Codex ids are anything in a Codex account's `models`, or anything starting `gpt-` before the list is known.
  - An effort the chosen model doesn't list in `effortLevels` (when it's known) is dropped with a note. `ultra` on a Claude thread always is.
  - It doesn't answer `-32602` for any of these, because an old app can't recover from that. (A string that isn't an `EffortLevel` at all still gets `-32602` from `rpc.ts`, as today.)

**`threads.update`** (it already takes `effort`) checks `model` and `effort` the same way.

Picking an account of the other provider:

- switches `provider`;
- resets `model` and `effort` to that provider's defaults, unless the same call sets them;
- clears the thread's "Always allow" rules;
- starts the next turn as a new session with the handoff note.

A folder change on a Codex thread that stays on the same account carries on in the same Codex thread. The new folder applies from the next turn: no transcript copy, no handoff note, no new session (A, "Folder moves").

**CLI requests.** Each returns at once. Progress comes through `clis.updated`.

| Request | Returns | Notes |
|---|---|---|
| `clis.list {}` | `{ clis: CliStatus[] }` | |
| `clis.check { provider? }` | `{ clis }` | Starts a check. The result shows the state when the call arrived |
| `clis.update { provider, version?, force? }` | `{ clis }` | Starts an update with `update.state` `running` or `waiting`. `version` picks a kept Codex version: this is how "Go back" works. `force: true` installs past a hold |
| `clis.setPolicy { provider, policy }` | `{ clis }` | |

```ts
type CliStatus = {
  provider: Provider
  path: string                 // the binary new sessions start
  managedBy: "threadbear" | "cli" | "none" // Codex: Threadbear's copies; Claude: its own installer; "none" when codexPath is set by hand
  installedVersion?: string    // what new sessions start on
  latestVersion?: string
  status: "current" | "behind" | "held" | "unknown" | "missing"
  policy: "auto" | "notify" | "off"
  inUse: { version: string, threadIds: string[] }[]
  previousVersion?: string     // Codex: the kept version "Go back" returns to
  checkedAt?: string
  hold?: { version: string, reason: string, missing?: string[] } // auto-install refused, e.g. the app-server protocol lost methods we use
  update?: {
    state: "waiting" | "running" | "succeeded" | "unchanged" | "failed"
    targetVersion?: string, waitingFor?: string[], finishedAt?: string, message?: string
  }
}
```

`runner.status` gains `clis`.

### Notifications

**`accounts.updated { accounts: Account[] }`** already exists and stays level-triggered: the latest list wins. From this step it also goes out when:

- the account list changes (the 10-second rescan), which fixes a gap that exists today: new logins only appear after a reconnect;
- `limits.json` changes;
- a live reading moves a window by a point or more.

The first change goes out at once, and after that at most one every 5 seconds, always ending on the latest list.

**`clis.updated { clis: CliStatus[] }`** is new, and level-triggered too.

### Compatibility

- **An old app talking to a new runner:**
  - sees `provider: "codex"` as a plain string, and `ToolKind "image"` as `.other`;
  - shows an `ultra` effort as text, since the app keeps effort as a string;
  - can still send a Claude alias for a Codex thread, and the runner corrects it (see `threads.create`);
  - lists Codex models under "Older models", which works, since picking one sends its id.
- **A new app talking to an old runner** will be common for a while, because the app follows main by itself and the runner only changes when it's deployed:
  - `clis.*` answer `-32601`, so the Usage popover leaves out the CLI part;
  - accounts carry no `usage`, so the menu has no usage lines and the popover says the numbers need a newer runner;
  - no Codex accounts appear.

### Tools for agents

Codex threads get the same `threadbear` tools and environment variables as Claude threads. Section A says how. `list_accounts` gains the provider, the note and the room left. The `effort` enums in `create_thread` and `update_thread` come from `EFFORT_LEVELS`, so they take `ultra` too.

### Adapter seam (`adapters/types.ts`, `adapters/context.ts`)

**`NormalizerContext` and `fileContext`** move to `adapters/context.ts`, with two new optional members:

- `copyImage?(src, hint): ImageRef | null`;
- `saveDataUrl?(url, hint): ImageRef | null`.

B fills them in. D's rate-limit work in `claude/normalize.ts` never touches them.

**New and changed outputs:**

- `{ kind: 'context'; contextTokens; contextWindow? }`
- `{ kind: 'limits'; windows: UsageWindow[]; blocked?; email?; plan? }`
- `{ kind: 'cliVersion'; version }`, where `version` is the version of the process actually running the session.
- `TurnResult` gains `errorKind?`. (`answered` and `queuedTurns` come with Mike's steering change.)

**New error:** `export class SessionNotFoundError extends Error`. It means the session to resume doesn't exist, and the runner starts fresh once. It replaces the `/no conversation found/i` check, which stays as a fallback for Claude.

**Interface changes:**

- `StartSessionOptions` already has `effort`. For Codex, a `sessionId` with `resume: false` is ignored, because Codex assigns its own id (see section A).
- `AgentSession` gains optional `setCwd?(cwd): Promise<void>`: the new folder applies from the next turn, in the same session.
- `AgentAdapter` gains these optional members:
  - `movesFolders?: boolean`: a same-account folder change calls `setCwd` on a live session, or passes the folder on the next start or resume, instead of copying the transcript and adding a handoff;
  - `settingsApplyNextTurn?: boolean`: model, effort and permission changes take effect from the next turn only;
  - `wakesAfterTasks?: boolean`, default true: whether the CLI starts a turn of its own when background work ends. Codex sets false, so the runner skips its wake grace (C);
  - `archive?(account, nativeSessionId): Promise<void>`.
  - `models?(account)` already exists.

### Config (`config.ts`; each setting from `runner.json` or an env variable)

| Setting | Env | Default |
|---|---|---|
| `codexPath` | `THREADBEAR_CODEX_PATH` | Unset. Unset means Threadbear's own copy, `<home>/tools/codex/current` (section E). Until the first copy is installed, and whenever `cliUpdates` is off (tests, dev runners), it falls back to the `codex` next to the runner's own Node (`~/.nvm/versions/node/v24.22.1/bin/codex`, 0.164.0). Never `~/.local/bin/codex`: that's a standalone 0.147.0 that nothing updates, below T3's "broken under 0.149" line. When this is set by hand, Threadbear uses it as is and never updates it |
| `codexArgs` | (none) | Extra `app-server` args. The e2e uses them to switch features and MCP servers off |
| `codexMainDir` | `THREADBEAR_CODEX_MAIN_DIR` | `~/.codex` |
| `tokenStatsLimitsFile` | `THREADBEAR_TOKEN_STATS_LIMITS` | `~/Library/Application Support/Token Stats/limits.json` |
| `cliUpdates` | `THREADBEAR_CLI_UPDATES=off` | `{ claude: "auto", codex: "auto", checkMinutes: 60, keepCodexVersions: 2 }`. Off in tests and dev runners |
| `defaults.models`, `defaults.efforts` | (none) | Unset. A dev runner sets `codex: "gpt-6-luna"` and effort `low` |
| `accountNotes` | (none) | `{ "claude-2": "Convex work only" }`. A `runner.json` value replaces it. It lives in the code default so nobody has to edit Mike's real `runner.json` |

**Done when:**

- the protocol doc, the TS types and the Swift models agree;
- decoding tests pass for every new field, including `ultra` and `ModelChoice.defaultEffort`;
- a test shows unknown values still decode (`ToolKind "image"` on an old enum, an unknown notification);
- the mock runner accepts and returns the new fields;
- the Claude tests still pass after `NormalizerContext` moves.

## A. Codex sessions (`runner/src/adapters/codex/`)

The adapter drives `codex app-server` the way T3 does, with one app-server process per live thread. It adds what T3 lacks:

- images handled;
- subagent traffic routed to the parent thread;
- the Threadbear tools passed in-process;
- messages sent during a turn steered into it.

**Why one process per thread.** The first version of this plan shared one process per account, for one place to keep rate limits and versions, and because MCP servers might start once per process. Spikes 4, 5 and 10 showed otherwise:

- Every Codex thread starts its own copy of every MCP and plugin server: 7 stdio processes per thread with Mike's config, about 124 MB footprint.
- A loaded thread costs about 150 to 190 MB footprint (about 390 MB RSS) on top of the app-server's own 84 MB.
- `thread/unsubscribe` never unloads a thread. A released thread keeps its MCP servers and any running command until `thread/delete` or the process exits. There's no unload request, and no idle unload came within 6 minutes.
- The app-server doesn't give memory back: 168 MB with no threads left, against 84 MB at the start.

So a shared process would hold every thread it had ever opened, and would need recycling, cross-thread routing and shared-kill rules. One process per live session needs none of that. Releasing a session closes its stdin: the process exits in 13 to 21 ms, and its MCP children and running commands go with it. A crash only fails its own thread. A live Codex thread costs about 230 to 250 MB footprint with Mike's config, about what a Claude CLI with its MCP servers costs, so `maxLive` counts it the same. Rate limits are per account in D's `UsageStore` anyway, and version moves follow from each new process starting the current binary.

### The wire (verified on 0.164.0)

- **Format.** JSON-RPC over stdio, one JSON object per line: `{id, method, params}`, `{id, result | error}` or `{method, params}`. There is **no `"jsonrpc"` field**. Notifications also carry a top-level `emittedAtMs` next to `params`, which the reader ignores.
- **Ids.** The client's ids are its own. Codex's requests to the client use their own numeric ids, starting at 0 in each process.
- **Line size.** Lines can be several MB.
  - An `imageGeneration` `item/completed` was 1.34M characters, Mike's real ones reach about 2.4 MB, and an `mcpServerStatus/list` reply with his config is 2.5 MB.
  - The line reader has no small cap. Its only limit is a 256 MB guard.
  - A line over the guard is skipped up to the next newline and logged with its size. The process keeps running.
  - If the skipped line was an item's completion, that item is closed at the end of its turn as failed, with "Too large to show" (section B). Only that one item fails.
- **Handshake.**
  - Send `initialize { clientInfo: {name: "threadbear", title: "Threadbear", version}, capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated", "turn/moderationMetadata", "remoteControl/status/changed"] } }`, then the `initialized` notification. The opt-outs held in spike 2.
  - The reply came in 70 to 90 ms. `codexHome` names the home.
  - Its `userAgent` reads like `"threadbear-research/0.164.0 (Mac OS 26.6.2; arm64) unknown (threadbear-research; 0.0.1)"`. The Codex version is the part after the first `/`, up to the space. The process stores it as the version it runs.
  - `Thread.cliVersion` is "Version of the CLI that created the thread" (generated `v2/Thread.ts`), so it's never used as the running version.
- **Unknown requests from Codex** get a `-32601` error straight away, so Codex never waits on us. That covers `account/chatgptAuthTokens/refresh` and `attestation/generate`.
- **History.** `thread/read {includeTurns: true}` makes Codex send a thread-less `deprecationNotice` ("Full-history hydration is deprecated for paginated threads"). Nothing in this step reads history (resume uses `excludeTurns: true`); anything that does later pages with `thread/turns/list` and `thread/items/list`.
- **Schema.** The CLI generates its own protocol offline: `codex app-server generate-ts --experimental --out DIR`.
  - `types.ts` is a hand-picked subset of that output, pinned to 0.164.0.
  - `surface.ts` lists by name what the runner relies on: the notification methods, the client requests (including `turn/steer`, `thread/backgroundTerminals/list` and `terminate`), the server requests, the `ThreadItem` types (including `subAgentActivity`) and the item fields the normaliser reads (`savedPath`, `result`, `commandActions`, `aggregatedOutput`, `changes`, `agentThreadId`, `processId`, and so on). It also lists the item types we deliberately ignore. It exports `testedVersion = "0.164.0"` and `checkSurface(generatedDir): { missing: string[], added: string[] }`, which works by text match on the generated files.
  - `scripts/codex-schema-check.sh` and E's update gate both use `checkSurface`. After an update, a protocol change shows up as a failing check or a held update, never as a silent drop like T3's.

### `appserver.ts`: processes

**`AppServerProcess`** spawns the Codex binary and speaks the wire above.

- **Which binary.** The native binary behind the npm launcher. Skipping the launcher saves its ~50 MB Node process per thread (measured again: 49.5 to 49.8 MB).
  - Start from `codexPath` if it's set. Otherwise use `<home>/tools/codex/current`, or the fallback copy.
  - `realpath` of that ends in `@openai/codex/bin/codex.js`.
  - `createRequire(thatFile).resolve('@openai/codex-darwin-arm64/package.json')` finds the platform package, whether npm hoisted it or not. The binary is its `vendor/aarch64-apple-darwin/bin/codex`.
  - If any of that fails, spawn the launcher itself.
  - It resolves again on every spawn, so a new process picks up a new `current`. The process records the real binary path it started, so E knows which version folders are in use.
- **Environment.** Start from `process.env`. Drop the Claude session variables that `cliEnv` already drops, and any inherited Codex session variables. Then add:
  - `CODEX_HOME = account.configDir`, set explicitly for main too;
  - `CODEX_MANAGED_BY_NPM=1`, and `CODEX_MANAGED_PACKAGE_ROOT` set to the package folder being run. This is what the launcher sets.
  - `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Threadbear`, as T3 does, so the model catalogue refresh before `initialize` uses our name. Spike 8 saw it work: threads show originator `Threadbear`, source `vscode`.
  - `THREADBEAR_THREAD_ID`, `THREADBEAR_HOME`, `THREADBEAR_RUNNER_HOME`, `THREADBEAR_RUNNER_VERSION`, and `PATH` with the runner's `bin/` first.
- **Arguments.** `app-server` plus `codexArgs`.
- **Spawning.** Through `groupSpawner` (detached process group, `ProcessRegistry`, stderr tail), so the runner's exit stops it like any CLI.
- **Retries.** An `ENOENT`, or an exit before `initialize` answers, retries every second for 10 seconds. This covers the fallback copy, which Token Stats reinstalls daily: an npm reinstall leaves no binary for 1 to 3 seconds (measured 1.0 s warm, 2.3 s cold). Threadbear's own copies never have that gap.
- **Timeouts.** 30 seconds per request, 60 for `turn/start`.
- **Closing.** Closing stdin ends the process in 13 to 52 ms, with every MCP child and running command. If it hasn't exited 5 seconds later, kill its process group.

**Short-lived processes.** `models(account)` and `archive(account, id)` start a process for the account, make their call and close it. With no thread loaded it starts no MCP servers.

**Rate limits.** When a session's process starts, it calls `account/read` (login type, email, plan) and `account/rateLimits/read`. It merges each `account/rateLimits/updated` into that snapshot, because updates are partial and carry no `threadId`, and hands the merged snapshot to the normaliser, which turns it into `limits`. `account/updated {authMode, planType}` at startup also goes into `limits.plan`.

**Notifications with no thread.** `configWarning`, `deprecationNotice`, `account/updated` and `account/rateLimits/updated` carry no `threadId`, and `warning` and `mcpServer/startupStatus/updated` can carry `null` (spike 8 only saw thread ids on startup statuses, since MCP startup is per thread). They all belong to the process's one session.

- `configWarning` becomes a `runner.notice` warning, at most once per runner run for the same text, and a `system.note` in the thread.
- `deprecationNotice`, `warning` and a failed MCP start become `system.note`s, each text once per session.
- `account/updated` and `account/rateLimits/updated` go to the normaliser, which turns them into `limits` (B).
- That way a broken `config.toml`, which is reported at process start before any thread exists, still shows.

**Child threads (subagents)** run inside the parent's process, so their traffic arrives on the parent's connection under the child's `threadId` (spike 9).

- The process keeps a map from child thread ids to its root thread. The main source is the parent's `item/started` `subAgentActivity {kind: "started", agentThreadId}`, which arrives 1 ms before the child's first notification.
  - No `thread/started` for the child reached the parent's connection, and the only `collabAgentToolCall` was `wait`, with `receiverThreadIds: []`. Keep `thread/started.parentThreadId` and `receiverThreadIds` as harmless extra sources.
  - For a `threadId` the map doesn't know, match `turn/started.turn.rootTurnId` against the session's active Codex turn, or call `thread/read`, which returns `parentThreadId`.
- Child traffic reaches the normaliser marked with the child's id. The normaliser keeps only what section B lists for children.

**Never leave a request unanswered.** A Codex request that arrives when no session is attached (before it attaches, after it ends) is refused straight away, with a warning in the log:

- `cancel` for approvals;
- `{action: "decline", content: null}` for elicitations;
- a JSON-RPC error for anything else.

**Process death.** If the process dies, its session gets `exited(error)` and resumes on the next message.

### `adapter.ts`: one thread

`CodexAdapter` sets `provider = 'codex'`, `movesFolders = true`, `settingsApplyNextTurn = true` and `wakesAfterTasks = false`. It implements `models` and `archive`. `CodexSession` implements `AgentSession`, including `setCwd`.

**The session is a small state machine**: `starting`, `ready`, `turnPending`, `turnActive`, `closing` and `closed`. These rules exist because `Runner.deliver()` calls `start()` and then `send()` in the same tick, and so does the fresh-retry path in `onExited`:

- `send()` before `thread/start` or `thread/resume` has answered is held, then sent once there's a thread id.
- **The next `turn/start` waits until Codex's previous turn has sent `turn/completed`.**
  - A `turn/start` during an active turn would steer that turn instead of starting a new one. `TurnStartParams` documents fields as "Ignored when this request steers an already-active turn", and `CodexErrorInfo` has `activeTurnNotSteerable`.
  - So if the runner's `INTERRUPT_GRACE_MS` ended our turn before Codex finished, the next message waits.
  - While it waits, it sends `turn/interrupt` again every 10 seconds.
  - After 60 seconds the send fails with the error "Codex is still finishing the last turn".
- `interrupt()` depends on how far the turn has got:
  - The turn is still held behind `start`: drop it and report it interrupted.
  - `turn/start` was sent but hasn't replied: wait for the reply's turn id, then interrupt.
  - The turn is active: send `turn/interrupt` at once.
  - Either way, messages held for a later `turn/start` are dropped too. Stop means stop, as for Claude.
  - `interrupt()` only rejects if the process is gone, so the runner's fallback to `kill()` stays rare.

**Messages during a turn (steering).** With Mike's steering change, the runner calls `send()` while a turn runs and expects the message to be answered within that turn.

- During `turnActive`, `send()` calls `turn/steer {threadId, expectedTurnId: <the active Codex turn>, clientUserMessageId: id, input}`. The reply's `turnId` confirms it joined that turn.
- During `turnPending`, it waits for the `turn/start` reply's turn id, then steers.
- If Codex refuses (the turn just ended, the id doesn't match, or `activeTurnNotSteerable`), the message is held and starts the next `turn/start`, which runs as soon as `turn/completed` arrives. That's the same as Claude answering it "straight after its reply".
- The adapter shapes each `result` for the runner:
  - `answers`: the runner id that started that Codex turn;
  - `answered`: that id, then the ids steered into the same turn, in order;
  - `queuedTurns`: how many messages it still holds for its next `turn/start` (0 when none), so the runner's "dropped" note only appears when a message really went nowhere.
- `turn/steer` is in 0.164.0's schema (`TurnSteerParams` with a required `expectedTurnId`) but was not tried in a spike. The e2e checks it. If it fails there, `send()` during a turn uses the hold path only, which the runner treats the same way.
- If Mike's change hasn't landed when A builds, build this anyway: until it lands, the runner never calls `send()` mid-turn.

**`start(opts, sink)`**

1. Spawn the session's process (see `appserver.ts`) and wait for `initialize`.
2. Start or resume the thread.
   - **New** (`resume: false`): `thread/start {cwd, model?, approvalPolicy, approvalsReviewer, sandbox, config, dynamicTools}`.
   - **Resume** (`resume: true`): `thread/resume {threadId: opts.sessionId, excludeTurns: true, cwd, model?, approvalPolicy, approvalsReviewer, sandbox, config}`.
     - If the error says the session is archived, call `thread/unarchive` and retry once.
     - If it says "thread <id> is closing; retry thread/resume after the thread is closed", retry with backoff (250 ms, doubling, up to 10 seconds). Spike 10 couldn't trigger it on 0.164.0 in 12 tries, because `thread/resume` itself shuts down a stale copy and waits for it, and our resumes always run in a fresh process anyway. It's cheap defensive code. A `turn/start` that fails with "thread <id> is closing; retry after the thread is closed" is retried the same way.
     - If the thread isn't found, `exited(new SessionNotFoundError(...))`.
     - Codex writes the rollout lazily, at the first turn. A thread whose first turn never ran can't be resumed.
     - Measured: resume takes about 160 ms, replays nothing, and the context carries over (the next turn remembered "pineapple"). A `thread/tokenUsage/updated` with the restored total arrives before the first new turn.
3. `config` is the same for both, and is sent on every resume because the rollout doesn't store config overrides (spike 3):
   - `"shell_environment_policy.set.THREADBEAR_THREAD_ID": threadId`. Spike 3: this dotted key adds to `config.toml`'s own `[shell_environment_policy.set]` table instead of replacing it, at start and on resume, and the value sent on resume wins.
   - `"tools.update_plan.enabled": true`
   - `mcp_optional_startup_grace_ms: 10000`
   - `suppress_unstable_features_warning: true`. Without it, every thread gets the warning "Under-development features enabled: chronicle...", because Mike has `chronicle` on (spike 8).
4. Emit `session {nativeSessionId: thread.id, model: result.model}`, then `cliVersion {version}` with the process's version from `userAgent`, then `effort {level: result.reasoningEffort}` when it's a known level.
   - Codex assigns thread ids (UUIDv7), and `ThreadStartParams` has no id field. The runner's pre-assigned uuid is only a placeholder until this arrives.
   - Both results carry the resolved `model` and `reasoningEffort`. With no effort sent, `reasoningEffort` is `config.toml`'s `model_reasoning_effort` (`high` for Mike, even on luna). That's what really applies, so it's right for `effortInUse`, but it's never written into the thread's own `effort`.

**`send({id, text, images})`** when no turn is running:

- Send `turn/start` with:
  - `threadId` and `clientUserMessageId: id`;
  - `input`: the images first as `{type: "localImage", path}`, then `{type: "text", text, text_elements: []}`;
  - `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `cwd` (when it changed), `model?`, `effort?` and `summary: "detailed"`.
- Remember the Codex turn id from the reply against the runner's turn id.
- A `turn/started` that arrives while our `turn/start` is still pending counts as ours.
- Codex sends `thread/settings/updated` before every `turn/start` reply. Section B reads the model and effort from it.

**`setModel`, `setPermissionMode`, `setEffort`, `setCwd`** store the value and resolve.

- The value is applied on the next `turn/start`, and Codex keeps policies, model and folder set on a turn for later turns (verified; spike 10 for the folder).
- `turn/settings/update` can't change sandbox or approval mid-turn. Because of that, the adapter declares `settingsApplyNextTurn`, and C shows a note.

**`interrupt()`** (see the state machine) sends `turn/interrupt {threadId, turnId}`.

- It replied `{}`, and `turn/completed {status: "interrupted"}` came about 100 ms later.
- A running command never got `item/completed`, so the normaliser closes open items (section B).
- **`turn/interrupt` doesn't stop the command itself.** In spike 10 a `sleep 20` was still running 1 and 3 seconds after the interrupt. So after an interrupted turn with an open command, call `thread/backgroundTerminals/list` and `thread/backgroundTerminals/terminate {threadId, processId}` for each terminal whose `itemId` was open in that turn. If that doesn't report `terminated: true`, end the session once the turn is over (close stdin, `exited()`): the process exit kills the command, and the next message resumes. The e2e checks the `sleep` is gone within 5 seconds.
- The runner's existing `INTERRUPT_GRACE_MS` covers a missing `turn/completed`.

**`end({hard})`** closes stdin, waits for the process to exit (up to 5 seconds, then it kills the group), and calls `sink.exited()`.

- There's no `thread/unsubscribe`: across every spike it never unloaded a thread, never produced `thread/closed`, and never answered `notLoaded`. The process exit does what it was meant to.
- Closing stdin also stops background terminals (spike 5). The runner doesn't release a session that has `tasks` (C), so only a hard stop reaches that, and the runner already notes what a hard stop cut short.
- With `hard` and a turn still running, no `turn/completed` arrives. The runner's turn is closed by `exited()`, as it is for Claude.

**`kill()`** kills the process group straight away and calls `sink.exited()`.

**`thread/closed`, or `thread/status/changed {type: "notLoaded"}`, for the session's own thread** calls `exited()`, unless our own `thread/resume` is pending (a resume produces `notLoaded` then `idle` itself). The next send then resumes, instead of failing a `turn/start` on an unloaded thread. Spike 10 saw `notLoaded` when another request shut a thread down; `thread/closed` never arrived. Both stay cheap defensive code with one process per thread.

**`archive(account, id)`** calls `thread/archive` in a short-lived process. The runner calls it, best effort, when Mike archives or deletes a Codex thread.

- Without it, Threadbear's threads pile up in the Codex Desktop list (source `vscode`, originator Threadbear), as T3's 82 have. Mike is fine with them showing there as long as they're archived when he's done with them.
- Resume already unarchives.
- `thread/delete` on a parent also deletes its subagent threads (spike 9). Whether `thread/archive` covers them too is untested. Check it once with spike 9's script (`spikes/subagents-and-background/scripts/` in the captures; luna, no images, delete the threads afterwards). If it doesn't, `archive()` also archives the child ids the session saw (kept on the runtime).
- `thread/delete` took 0.7 to 3.3 seconds before `thread/deleted`, which matters for test clean-up timeouts.

### Folder moves

A same-account folder change on a Codex thread stays in the same Codex thread and passes the new `cwd` on the next `turn/start` (`setCwd` on a live session). On a released session, the next `thread/resume` passes it instead.

- Spike 10: `cwd` on `turn/start` alone reloads the instructions. The model followed the new folder's `AGENTS.md`, a later rejoin showed the new `instructionSources`, and `thread.cwd` stayed changed.
- Resume with a new `cwd` also works on a thread that isn't loaded, which with one process per thread is every resume. (On a thread the connection is still subscribed to, `thread/resume` ignores `cwd` without an error. That can't happen here.)
- Compare paths after `realpath`: the reply's `cwd` and `instructionSources` keep `/tmp/...` as given, while `thread.cwd` is `/private/tmp/...`.
- `instructionSources` always includes `~/.codex/AGENTS.md`, Mike's shared global instructions, next to the project's own. So Codex answers follow his "What I need from you" rule.

### Permission modes

| Threadbear | `thread/start`, `thread/resume` | every `turn/start` |
|---|---|---|
| `full` | `approvalPolicy: "never"`, `sandbox: "danger-full-access"`, `approvalsReviewer: "user"` | `approvalPolicy: "never"`, `sandboxPolicy: {type: "dangerFullAccess"}`, `approvalsReviewer: "user"` |
| `ask` | `approvalPolicy: "on-request"`, `sandbox: "read-only"`, `approvalsReviewer: "user"` | `approvalPolicy: "on-request"`, `sandboxPolicy: {type: "readOnly", networkAccess: false}`, `approvalsReviewer: "user"` |

- **`full`** matches T3's full access and Mike's own `config.toml` (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`). Commands run unsandboxed and Codex never asks.
- **`ask`** is confirmed on both models. Spike 2 on gpt-6.1-sol: it asked before every command that writes and every patch, never refused, and asked up front rather than trying in the sandbox first.
  - Read-only commands such as `ls` run inside the read-only sandbox without asking. So Codex's ask mode asks before writes, which is what the chip's "Ask before edits" says.
  - `networkAccess` is required by `SandboxPolicy`'s `readOnly` variant.
  - `approvalsReviewer: "user"` is sent explicitly. Mike's `config.toml` sets `approvals_reviewer = "user"`, but another account's could send approvals to Codex's auto-reviewer instead of the card.
  - The re-recording showed luna asking with T3's `untrusted` plus read-only too, so the earlier "luna refused" note was wrong. `on-request` stays, as tested on sol.
  - Luna's subagents can refuse in ask mode instead of asking, when the prompt doesn't spell out what to run (spike 9).

### Approvals and questions (`approvals.ts`)

`approvals.ts` owns the requests Codex sends to the runner:

- the pending map;
- the decision mapping;
- `serverRequest/resolved`;
- the "Always allow" rules.

Requests from a child thread go to the parent session's sink with no `itemId`. The protocol already allows that for Claude's subagents, so the card shows and nothing hangs. Only the child's own status gains `waitingOnApproval`, so the parent thread's "waiting" comes from the routed request, as it already does for Claude.

| Codex request | Threadbear | Reply |
|---|---|---|
| `item/commandExecution/requestApproval`, `kind: "command"` | `approval.requested`: name `shell`, title the inner command (`commandActions[0].command`), input `{command, cwd, reason}`, itemId the item. Sol fills `reason` with the model's own question ("Allow creating b.txt in the current directory?"), and F shows it under the card's title | allow: `accept`. allowAlways: `accept`, plus the runner's own rule (below). deny: `decline`, which works although `availableDecisions` never lists it (commands and patches end with status `declined`). expired: `cancel` |
| the same with `kind: "writeStdin"`, or with `networkApprovalContext` or `proposedNetworkPolicyAmendments` | `approval.requested` with the input or network target in the title. Offers allow and deny only | as above. Never matched by an "Always allow" rule |
| `item/fileChange/requestApproval` | `approval.requested`: name `apply_patch`. Its params are only `{threadId, turnId, itemId, startedAtMs, reason, grantRoot}` (both null in testing), with no `availableDecisions`. The diff is already shown, because `item/started` carries it before approval | allow: `accept`. allowAlways: `accept` and the runner's `codex:fileChange` rule. deny: `decline`. expired: `cancel` |
| `item/permissions/requestApproval` | `approval.requested`: name `permissions`, title from `reason`. None arrived in testing | allow: `{permissions: requested, scope: "turn"}`. allowAlways: `scope: "session"`. deny: nothing granted |
| `item/tool/requestUserInput` | `question.requested` with header, question and options. `options: null` means free text, through the card's existing text field. `isSecret` questions are declined with a note. `isBlocking: false` questions show as usual and expire when Codex resolves them itself | `{answers: {[questionId]: {answers: [label]}}}` |
| `mcpServer/elicitation/request` | form mode: a question. URL mode: declined, with a `system.note` | `{action: "accept", content}` or `{action: "decline", content: null}` |
| `item/tool/call` | runs a Threadbear tool (below) | `{contentItems: [{type: "inputText", text}], success}` |
| `applyPatchApproval`, `execCommandApproval` (legacy) | treated like the v2 requests | legacy decision names |
| `currentTime/read` | answered with the runner's clock | |
| anything else | nothing shown | `-32601` straight away |

**`serverRequest/resolved`** arrives for every request, including ones we answered, under 1 ms after our reply (spike 2). So `approvals.ts` drops the pending entry when it sends the reply, and only a request that's still unanswered resolves its card as `expired`. `codex-approvals.test.ts` covers that race.

**"Always allow" rules.** `availableDecisions` never offers `acceptForSession`: on luna, on sol and for a subagent it was `["accept", {acceptWithExecpolicyAmendment}, "cancel"]`, and file changes have no list at all. As T3's code comment says, every new command would ask again.

So the runner keeps its own per-thread rules in `rec.allowRules`, which outlast an idle release, and answers matching requests without asking:

- **`codex:fileChange`** allows any edit in this thread, the way Claude's `Edit` rule does.
- **`codex:command:<JSON {cwd, argv}>`** is the exact argv the card showed, in the folder it showed (since 6 Nov 2026; before, Codex's `proposedExecpolicyAmendment` became a prefix rule, which the card never showed and which allowed whatever came after it). A request matches only when all of these hold:
  - its `kind` is `command`, and it carries no network context;
  - the inner command, with the `/bin/zsh -lc '...'` wrapper stripped, parses as one plain argv;
  - it has no `;`, `&`, `|`, `>`, `<`, backticks, `$(` or newline outside quotes;
  - its argv and folder are the rule's exactly.

  So `touch b.txt; rm -rf ~` and `cat a | sh` always ask. allowAlways is only offered on cards where such a rule can be made.

Never send `acceptForSession` (nothing advertises it) or `acceptWithExecpolicyAmendment` (it saves rules that outlive the thread).

### Threadbear tools for Codex (`tools.ts`)

Codex can't take the in-process SDK MCP server, so the tools go in as **dynamic tools** (experimental). Spike 1 settled it: tools given at `thread/start` survive `thread/resume` in a new process, even though `thread/resume` has no `dynamicTools` parameter. They're stored in the rollout's first line (`session_meta.payload.dynamic_tools`). The alternative, an HTTP MCP endpoint on the runner, isn't built.

- `tools.ts` turns `buildThreadbearTools(control, threadId)` into a `DynamicToolSpec` namespace called `threadbear`, with JSON Schema from zod 4's `z.toJSONSchema`.
- It answers `item/tool/call` by running the same handler. `item/started` `dynamicToolCall` arrives just before the request, and the item id is the `callId` (`exec-<uuid>`).
- `delete_thread` calls `sink.requestApproval` first, every time, with `canAlwaysAllow: false`. Codex doesn't ask before client-side tools, so the runner does.
- Calls show as `mcp__threadbear__<tool>`, the same names as for Claude.

What spike 1 means for the code:

1. The tools that answer a call are built for the session's own thread, again on every start and resume, and looked up by `namespace` and `tool`. A call from a subagent acts for the parent thread.
2. A thread's tool list, descriptions and schemas are frozen at `thread/start`. Later runner versions must keep old tool names and argument shapes working, and answer a call for an unknown or removed tool with `success: false` and a sentence, not `-32601`. A new tool only reaches threads created after it ships. If that becomes a problem, the MCP endpoint can be added later through `config["mcp_servers.threadbear"]`, which is accepted on resume.
3. Never read tools back from `state_5.sqlite`'s `thread_dynamic_tools`: it has no rows for any thread.

### Models

- `model/list {includeHidden: false}` gives:
  - gpt-6.1-sol (`isDefault`), gpt-6-astra, gpt-6.1-terra, gpt-6-sol, gpt-6-luna ("Fast and affordable"), and gpt-5.6-sol, terra and luna;
  - hidden, and left out: gpt-reserve and codex-auto-review.
- Each model has `supportedReasoningEfforts` and a `defaultReasoningEffort` (low for gpt-6.1-sol and gpt-6.1-terra, medium for luna and astra). Most go from low to `ultra`; the luna models stop at `max`.
- `models(account)` turns each row into a `ModelChoice`: `id` and `model` from `id`, `title` from `displayName`, `description`, `effortLevels` from `supportedReasoningEfforts`, and `defaultEffort` from `defaultReasoningEffort`.
- The default is `config.toml`'s top-level `model` when set (`gpt-6.1-sol` for Mike), else the row with `isDefault`. D reads the former; the runner learns the latter from `models()`.
- Context windows: 258,400 for gpt-6-luna and 475,000 for gpt-6.1-sol.
- Service tiers are out of scope. Mike's `config.toml` sets a top-level `service_tier`; Threadbear never sends `serviceTier`, so his config's choice applies, as it does in Codex itself.

**Done when** the unit tests pass against a fake app-server (`test/helpers/fake-app-server.ts`, a small Node script that replays fixture lines and answers requests). They cover:

- big lines, and a line over the guard that fails one item only;
- the id spaces, `emittedAtMs`, and unknown Codex requests;
- the version taken from `userAgent`, including a resumed thread whose `cliVersion` differs from the process's version;
- the spawn retry, process death, and the short-lived processes for `models` and `archive`;
- the binaries in use, for E;
- child threads: the map filled from `subAgentActivity`, the `rootTurnId` fallback, a child approval reaching the parent's sink with no `itemId`, and a request with no session refused at once;
- notifications with no or a `null` `threadId`;
- the session state machine:
  - a send before start resolves;
  - an interrupt before the turn id is known;
  - an interrupt while the turn is still held, which also drops held messages;
  - a second `turn/start` held until `turn/completed`;
- steering: a send during a turn becomes `turn/steer` and shows in `answered`; a refused steer is held, reported in `queuedTurns`, and starts the next turn;
- `end()` closing stdin and calling `exited()` without waiting for `thread/closed`;
- the interrupted command terminated through `backgroundTerminals`, and the session ended when that fails;
- resume retrying on the exact "is closing" text;
- `notLoaded` for a live session, and not while our own resume is pending;
- the approval rules (`codex-approvals.test.ts`):
  - chained, piped and redirected commands ask again;
  - `writeStdin` and network requests never match a rule;
  - `serverRequest/resolved` straight after our own reply doesn't expire anything;
  - `acceptForSession` and `acceptWithExecpolicyAmendment` are never sent;
- a dynamic tool call for an unknown tool answered with `success: false`.

These unit tests merge before C. The e2e (Tests, below) is a second A change, merged after C.

### As built (A, unit tests; 27 Oct)

Where the build made a call the plan didn't, or differs from it:

- **The normaliser is B's `CodexNormalizer`** by default. `CodexAdapterDeps.normalizer` is optional (tests pass a spy that wraps it), so C builds `new CodexAdapter({codexBinary, codexArgs, registry, log, toolsFor})` with nothing more. The session calls `setThread`, `startingTurn`, `turnAccepted` and `steered` (`CodexNormalizerLike` in `codex/types.ts`). The context's `cwd` follows `setCwd`.
- **A owns turn ownership.** The adapter drops every `cliTurn` and `result` the normaliser emits. It emits its own `cliTurn` for a turn it didn't start, and builds each `result` from the normaliser's (outcome, duration, usage, error, `errorKind`), setting `own`, `answers`, `answered` and `queuedTurns` itself. B can always emit a `result` on `turn/completed` without knowing whose turn it was. If B emits none, A makes a plain one from `turn.status`.
- **What A feeds the normaliser besides Codex's own notifications:**
  - `account/read` becomes a `limits` reading through B's `limitsFromAccount` (email and plan);
  - the start-up `account/rateLimits/read` and every update go in as `account/rateLimits/updated` with the merged snapshot `{ordinaryUsageAllowed, rateLimits, rateLimitsByLimitId}` (updates are merged per `limitId`, and nulls keep what was known);
  - a line over the guard goes in as `threadbear/oversizedLine {bytes, method?, threadId?, turnId?, itemId?, itemType?}` (B's `OVERSIZED_LINE`), routed like a notification (with `from` for a child's), so B closes that item as "Too large to show";
  - `closeOpen("Interrupted")` on every exit, so a background terminal left open from an earlier turn gets closed too.
- **`configWarning`** also calls `CodexAdapterDeps.onNotice(text)`, at most once per adapter (runner run) per text. C wires it to a `runner.notice` warning.
- **Approval card titles** use the whole unwrapped command, not `commandActions[0].command`, so a chained command shows all of it.
- **"Always allow" rules** (tightened after review, 27 Oct, and again 6 Nov): `codex:command:<JSON {cwd, argv}>` matches exactly the command the card showed, in the folder it showed. There are no prefix rules any more: `codex:prefix:` rules and folderless `codex:command:<JSON argv>` ones from before are ignored. `codex:fileChange` covers edits, and a threadbear tool's full name covers that tool. A command matches only if it's made of literal words: anything zsh would run, expand or glob unquoted makes it ask (`; & | < >`, newline, backticks, `$`, `( ) { } * ? [ ] ! ~ # ^`, and `=` or `%` at the start of a word); inside double quotes, `$`, backticks, `!` and stray backslashes do too. A rule is made or matched only for a program whose words say what it does, from an allowlist (`PLAIN_PROGRAMS` in approvals.ts: `ls`, `cat`, `grep`, `wc`, `mkdir`, `touch`, `rm` and the like), whose name leads to the system's own file (`/bin`, `/usr/bin`, `/sbin`, `/usr/sbin`, links followed, on PATH or by its whole path; read each time a rule is made and matched, so one found first in a folder of the user's or the repo's doesn't count). Not `rg`, `sort` or `diff`, which each have an option that runs a program (`rg --pre` and `--hostname-bin`, `sort --compress-program`). Shells, interpreters and every package, build or test launcher (`npm test`, `make`, `cargo run`, `pytest`, `./gradlew`) never get one: the same words run whatever the repo says next time, and a hash of package.json or a Makefile wouldn't cover the code those run (Daybreak, 7 Nov 2026; until then this was a list of programs to refuse). Codex's extra-permission cards (`item/permissions/requestApproval`) never offer Always allow and grant one turn, never the session.
- **Threadbear tools in ask mode** ask first unless they only read or end the turn (`NEVER_ASK_TOOLS` in `threadbear-mcp.ts`, for Claude too), using the thread's mode at call time. A whole-tool "Always allow" rule skips that card, so a call that raises access also puts up a card of its own from the handler, with no "Always allow" (protocol.md, "Raising access"). `delete_thread` asks in every mode, with no "Always allow".
- **Blocked lifts:** the tracker lets an explicit null clear a field, and treats a main-bucket update with `rateLimitReachedType: null` as ending a start-up `ordinaryUsageAllowed: false`. B's `limitsFromRateLimits` always sets `blocked` to true or false, so D's store clears it.
- **No auto-accept in full access.** A request in a turn that started in ask mode still shows its card, because mode changes apply from the next turn.
- **`archive()`** also archives the subagent threads this runner saw the session start (kept in memory per Codex thread), best effort, after the parent. That covers both answers to the open question, so the spike-9 check wasn't run.
- **An interrupt whose command can't be terminated** emits the normaliser's outputs except the `result`, then ends the process. `exited()` closes the runner's turn as interrupted, and the next message resumes.
- **Effort or model set back to unset** in a session sends the account's `defaultEffort`, else the model's own (or the account's `defaultModel`), because Codex keeps the last value sent.
- **Resume** knows the thread id before `thread/resume`, so its own `notLoaded`/`idle` route while `resumePending` is set. Thread traffic before `thread/start` answers is held, then routed.
- **Rate limits, fixed after C's merge:** the start-up `account/rateLimits/read` reply could arrive after a newer `account/rateLimits/updated`, and the older reading overwrote it. `RateLimitTracker` now applies a read as of when it was requested (`mark()` before, `read(r, mark)` after), laying the updates received since back over it.
- **The e2e** (`test/e2e/codex.e2e.test.ts`) writes `codexArgs` and luna/low defaults into its temp `runner.json`, runs with `THREADBEAR_CLI_UPDATES=off` (so Codex runs from the npm copy next to Node), and after the runner stops deletes every Codex thread it made with `thread/delete` in a short-lived app-server of its own (unarchiving first if needed), removes their `generated_images` folders and logs anything left in `sessions` or `archived_sessions`. It covers the cases the coordinator listed, plus steering and archive. The background-command case is left out: whether luna yields with a command still running is up to the model. Prompts that need a tool name it: "use the apply_patch tool (not the shell)", and in ask mode "You must actually run the shell command `touch x` yourself; an approval prompt is expected and fine", because otherwise luna writes through the shell, or replies "done" without running anything.
- **For C and E:** `CodexAdapter.binariesInUse()` gives `codexBinariesInUse()`. `resolveCodexBinary(start)` returns `{command, args, native, packageRoot?}` (`native: true` when it found the binary behind the launcher), and `nativeBinaryFor(launcher)` and `fallbackCodexPath()` are exported too. `checkSurface(dir)` and `testedVersion` are in `surface.ts`, which takes its item and method lists from B's `MAPPED_*` and `IGNORED_*` exports, plus what the adapter reads itself and the 0.164.0 families nothing reads. `toolsFor` takes `buildThreadbearTools(...)`'s array as is (`ToolDefinition` in `tools.ts`).

## B. Codex events and images (`normalize.ts`, `media.ts`)

**`CodexNormalizer`.**

- It's pure apart from the file helpers, like `ClaudeNormalizer`.
- Its interface is `handle(method, params, from?: { childThreadId }): AdapterOutput[]`, plus `closeOpen(reason): AdapterOutput[]` for the end of a turn.
- It's tested by replaying recorded NDJSON.
- Pending server requests live in A's `approvals.ts`, not here. The `answered` and `queuedTurns` parts of a result come from A (steering).

### Notifications

Notifications for our own thread:

| Codex | Threadbear |
|---|---|
| `turn/started` for our turn | Nothing; the runner already emitted `turn.started` |
| `turn/started` for any other id (goals, work Codex starts itself) | `cliTurn` |
| `turn/completed` | See "Ending a turn" below |
| `thread/settings/updated` | Sent before every `turn/start` reply. `effort {level: threadSettings.effort}` when it's set and a known level, and `session {nativeSessionId, model: threadSettings.model}` when the model differs from the last one reported, so `modelInUse` and `effortInUse` follow a change |
| `error` with `willRetry: true` | `system.note` "Retrying: <message>", at most one per turn |
| `error` with `willRetry: false` | Kept for the turn's error |
| `warning`, `configWarning`, `deprecationNotice`, `guardianWarning`, `model/rerouted` | `system.note`, each text once per session. The thread-less ones arrive through the process (section A) |
| `mcpServer/startupStatus/updated` with `status: "failed"` | `system.note` "MCP server paper didn't start: <first clause of the error>", once per server per session. The error is a long Rust chain ("MCP client for `paper` failed to start: MCP startup failed: handshaking with MCP server failed: Send message error Transport [codex_rmcp_client::..."), so keep its first clause or two. Startup is per thread, so a server that's down notes it on every Codex thread; notes fold into the work line, so that stays quiet. Other states are ignored |
| `item/agentMessage/delta` | `assistant.text.delta`, itemId = item id |
| `item/completed` agentMessage | `assistant.text`. Commentary and final answers (`phase: "final_answer"`) are both shown |
| `item/started` reasoning | Nothing. It comes 1.5 to 4 s before any delta, and an item can complete with an empty summary. No placeholder |
| `item/reasoning/summaryTextDelta` | `reasoning.delta` |
| `item/reasoning/summaryPartAdded` | A blank line, only when `summaryIndex > 0`. Index 0's arrives just before the first delta |
| `item/completed` reasoning | `reasoning`: the summary parts joined by blank lines. Nothing if empty. Each part starts with a "**Heading**" line, which the app can use as the collapsed title. Raw `content` and `textDelta` are not used: sol sent `content: []` and no `textDelta` |
| `item/started` commandExecution | `tool.call`: <br>• name `shell` <br>• kind `read` if every `commandActions` entry is a read, `search` for search or listFiles, else `command` <br>• title the inner command (not `/bin/zsh -lc '...'`) <br>• input `{command, cwd}` |
| `item/commandExecution/outputDelta` | `tool.output.delta` |
| `item/completed` commandExecution | `tool.result`: <br>• ok when status is completed and `exitCode` is 0 <br>• text from `aggregatedOutput`, which can be `null` (treat it as ""), 64 KB with the rest to a blob <br>• declined: ok false, text "Declined" (status `declined`, `exitCode` null) <br>• failed: ok false <br>• `source` changes from `agent` to `unifiedExecStartup` between start and completion, and `processId` fills in, so nothing is keyed on either |
| `item/started` fileChange | `tool.call`: name `apply_patch`, kind `write` when every change is an add, else `edit`, title "Edit a.txt" or "Edit 3 files", input `{paths}`. Then **one `edit.diff` per path, all on the item's id**: <br>• update: parse the hunk-only diff (`"@@ -1 +1 @@\n-x\n+y\n"`) <br>• add: every content line as "+" <br>• delete: every line as "-" <br>• `move_path`: title "Rename a to b" |
| `item/fileChange/patchUpdated` | `edit.diff` again for the changed paths; the app replaces each path's earlier diff |
| `item/completed` fileChange | `tool.result`, ok when status is completed; declined: ok false, "Declined" |
| `item/started` mcpToolCall | `tool.call`: name `mcp__<server>__<tool>`, kind `mcp`, input the arguments |
| `item/mcpToolCall/progress` | `tool.output.delta` |
| `item/completed` mcpToolCall | `tool.result`: text blocks joined, image blocks saved (Images below) |
| dynamicToolCall | As mcpToolCall. The name is `mcp__<namespace>__<tool>` (`mcp__threadbear__list_threads`), or just `<tool>` when `namespace` is null. The result text comes from `contentItems`' `inputText` entries, and `success` sets ok |
| webSearch | `tool.call` kind `web`, title the query or URL; `tool.result` on completion |
| imageView, imageGeneration | Images below |
| `turn/plan/updated` | `plan.updated`: `step` becomes the text, `inProgress` becomes `in_progress`. A non-empty `explanation` that differs from the last one becomes a `system.note` |
| `item/started` subAgentActivity `kind: "started"` | `tool.call` kind `task`, titled from the last part of `agentPath` (`image_color`), with the child's model in the input. This is the only spawn signal in 0.164.0: the task text the parent gave the child is on no item |
| `item/started` or `item/completed` subAgentActivity `kind: "completed"` | `tool.result` on the started row, paired by `agentThreadId` (the item ids differ: this one is `subagent-completed-<childTurnId>`). Its text is the child's last `final_answer` agentMessage, which the normaliser keeps for this |
| collabAgentToolCall | `wait` is hidden. Any other tool: `tool.call` kind `task`, title the first line of its prompt when it has one; `tool.result` on completion |
| contextCompaction item, `thread/compacted` | `system.note` "Compacted the conversation", once per compaction |
| enteredReviewMode, exitedReviewMode | `system.note` "Review started" / "Review finished" |
| sleep | `tool.call` kind `other`, title "Wait"; `tool.result` |
| `thread/tokenUsage/updated` | `context {contextTokens: last.totalTokens, contextWindow: modelContextWindow}`. The total feeds the turn's usage |
| `account/rateLimits/updated` (merged by the process) | `limits` <br>• the `codex` limit id gives the main windows <br>• `windowDurationMins` 300 is `five_hour`, 10080 is `weekly`, anything else `other` <br>• the other buckets in `rateLimitsByLimitId` become extra windows titled from their limit name, shown smaller and never on the chip <br>• remaining = 100 minus `usedPercent` <br>• `resetsAt` is unix seconds, sent as ISO <br>• credits go in `detail` <br>• `ordinaryUsageAllowed: false` or a `rateLimitReachedType` sets `blocked` <br>• Pro Lite has only a weekly window (primary weekly, secondary null), so nothing may assume both |
| `account/updated` | `limits {windows: [], plan}` from `planType` ("prolite" becomes "Pro Lite") |
| `hook/started`, `hook/completed`, hookPrompt items | Ignored, logged at debug level. Mike's SessionStart hook runs at each thread's first turn and its `entries[].text` is private Agent Archive context, so it's never shown |
| userMessage, functionCallOutput, plan item, `item/plan/delta`, `item/commandExecution/terminalInteraction`, `item/autoApprovalReview/*`, `model/verification`, `model/safetyBuffering/updated` | Ignored, logged at debug level. A userMessage whose `clientId` isn't ours is logged at info. The userMessage for a sent image echoes `{type: "localImage", detail: null, path}` |
| `thread/started`, `thread/status/changed`, `thread/readState/changed`, `thread/name/updated`, `thread/deleted`, and the three opted-out methods | Ignored. A uses `thread/started` and `notLoaded` first |
| any other method | Ignored, logged once per method at debug level |

**Ending a turn (`turn/completed`).**

1. Deal with the open items:
   - With status `completed`, an open commandExecution is a **background terminal**: Codex yielded while the command runs on (spike 5). Don't close it. Emit `tasks` with one entry per open terminal, `{id: itemId, type: "shell", description: <inner command>}`.
   - Any other open item, or any open item when the status is `interrupted` or `failed`, gets `tool.result {ok: false, text: "Interrupted"}`, or "Too large to show" for one whose completion line went over the guard.
2. Then emit `result`:
   - outcome from `turn.status`;
   - `durationMs` from `turn.durationMs`;
   - `answers`: the runner turn id for ours, otherwise `own`;
   - `error` from `turn.error.message`, with the embedded API JSON's `error.message` pulled out. It arrives as a raw `{"type":"error","status":400,...}` string.
   - `errorKind` from `turn.error.codexErrorInfo`:
     - `usageLimitExceeded` and `rateLimitExceeded` give `usageLimit`;
     - `contextWindowExceeded` gives `contextWindow`;
     - `unauthorized` gives `auth`;
     - anything else gives nothing.
   - `usage` from the change in `thread/tokenUsage/updated` totals over the turn (`last` if the total drops), including `cacheWriteInputTokens` as `cacheWriteTokens`;
   - no cost.

**When a background terminal finishes.** Codex sends `item/commandExecution/outputDelta` and then `item/completed` for it after the turn has ended, carrying the old `turnId` (8 s after `turn/completed` for a 12 s command). Emit `tool.output.delta` and `tool.result` as usual, then `tasks` without it. The runner emits them with no turn, and the app fills in the earlier row by `itemId`. No new turn starts.

**Unknown item types.** An `item/started` or `item/completed` whose `type` is neither mapped nor on `surface.ts`'s ignore list becomes `tool.call {name: "codex_<type>", kind: "other", title: "Codex <type>"}`. A `tool.result` follows on completion, with any text fields joined. A new item type after a Codex update shows up as a plain row instead of vanishing.

**Child threads** (traffic A marks with `childThreadId`). All of a child's traffic reaches the parent's connection: `thread/status/changed`, `turn/started`, `turn/completed`, `item/*`, deltas and `thread/tokenUsage/updated` (spike 9). Of that, keep:

- `imageGeneration` and `imageView`, handled as below, with item ids prefixed `<childThreadId>/` so they stay unique, placed right after the parent's subagent row;
- the child's last `final_answer` agentMessage, held for the subagent row's result.

Everything else from a child is dropped. In particular a child's `turn/started` isn't a `cliTurn`, its `turn/completed` doesn't end the parent's turn, and its `thread/tokenUsage/updated` doesn't feed `context` or usage. Its approvals and questions come through A.

**Observed order in a normal turn, with Mike's real config** (spike 8):

1. `thread/settings/updated`, then the `turn/start` reply, `thread/status/changed` active and `turn/started`
2. `hook/started` and `hook/completed` (about 0.4 s later, first turn only)
3. userMessage
4. commandExecution and fileChange started and completed, with `thread/tokenUsage/updated` and `account/rateLimits/updated` after each model response
5. agentMessage started, then deltas, then completed
6. `thread/tokenUsage/updated`, `account/rateLimits/updated`, `thread/readState/changed`, status idle
7. `turn/completed`

The real config adds about 8.9k input tokens to every turn (24,177 for "ok" against 15,318 with everything off), and its 19 notification methods are all mapped or ignored above.

`turn.items` in `turn/completed` is a summary and must not be emitted again.

### Images (what T3 drops)

Every image ends up as an `ImageRef` pointing at a file in `threads/<id>/media/`, carried on `tool.result.images` or `user.message.images`.

The app already inserts an image row right after the tool row (`TranscriptReducer.swift`, around line 470). Its `isWork` never folds image rows into a work group, so the picture stays visible under a collapsed work line. That works today with no app change.

**Generated (`imageGeneration`).** Codex makes these with its own `image_gen.imagegen` tool, which calls `gpt-image-2`. Files land in `$CODEX_HOME/generated_images/<threadId>/<itemId>.png`. Never build that path yourself; use `savedPath`. Even asked for the smallest size, the image was 1254 x 1254 and about 1 MB.

- On `item/started`, emit `tool.call {name: "image_generation", kind: "image", title: "Generate image", input: {}}`.
  - The prompt isn't known yet: `revisedPrompt` is null at start, `result` is "", and there's no `savedPath`.
  - The row shows as running for the 10 to 120 seconds a generation takes.
- On `item/completed`:
  - If `failure` is set, or `status` isn't `"completed"`, emit `ok: false`. The text is "Image generation limit reached, resets <time>" for `usageLimitExceeded`, otherwise the status.
  - Otherwise, copy `savedPath` with `copyImageFileInto`.
  - If that fails, decode `result` with `saveImage`.
  - If that fails too and there's a `fileId`, use the text "The image is stored remotely (<fileId>)".
  - Emit `tool.result {ok: true, text: revisedPrompt, images: [ref]}`.
  - If the item has `inputImages`, add "Edited from photo.jpg, style.png" to the text.
- Never put `result` in an event, a log line or `tool.call.input`. The app-server client's debug logging cuts every string over 200 characters.
- Leave the original in `generated_images` alone. Codex tells the model it lives there.

**Viewed (`imageView`).** The item is `{id, path}`. The path came back plain and absolute from the app-server (for a child too), but rollouts write `file://` URLs, so strip `file://` either way.

- On `item/started`, emit `tool.call {name: "view_image", kind: "read", title: "View <path relative to cwd>", input: {path}}`.
- On `item/completed`, copy the file and emit `tool.result` with it. Copy at completion, because the file may change later.

**From tools:**

- MCP `result.content[]` entries `{type: "image", data, mimeType}` go to `saveImage(data, mimeType, server + "." + tool)`.
  - Computer-use screenshots are an example: they're `image/jpeg`, with `_meta.codex/imageDetail`.
  - Resource blocks with an `image/*` blob are handled the same way.
- Dynamic tool `inputImage` URLs:
  - `data:` URLs go to `saveDataUrl`;
  - absolute paths and `file://` URLs go to `copyImageFileInto`;
  - http(s) URLs are kept as a text link only.

**Sent in.** `send` passes each image as `localImage`, with the path the runner already copied into `media/`.

- Verified: the model answered "Red" for a red PNG.
- Codex reads the file itself and shows the model `<image name=[Image #1] path="...">`, so "edit this picture" works through `referenced_image_paths`.
- Don't add T3's "[Attached image ... saved at]" line.
- **No shrinking** (spike 6). Codex took a 9000 x 9000 PNG and a 9 MB 9000 x 6000 JPEG, and shrinks every image itself, in the same format, to a long side of at most 2048 and about 2.5 MP. So skip `prepareImageForModel` for Codex, and keep passing the original `media/` path, which the model sees and which stays valid for edits.
- Never set `detail`: `"original"` sent 3200 x 3200 and cost about four times the tokens (12k against 2.9k).
- Tall screenshots shrink a lot (1440 x 9000 became 328 x 2048), so small text in them is likely unreadable to the model. Tiling is out of scope.

**`media.ts` additions** (next to the existing `copyImageInto`, which the runner keeps using for inbox images):

- `copyImageFileInto(dir, src, hint): ImageRef | null`:
  - accepts regular files of 100 MB or less, and strips `file://`;
  - names the copy `<hint>-<sha1:10>.<ext>`, like `saveBase64Image`;
  - skips the write when the file already exists, so replays and reconnects never duplicate it;
  - converts HEIC, TIFF and BMP to PNG with `/usr/bin/sips`;
  - returns null on failure.
- `saveDataUrl(dir, url, hint)`.
- `fileContext` in `adapters/context.ts` wires both into `copyImage` and `saveDataUrl`.

### Fixtures

`runner/scripts/sanitize-codex-recording.ts` turns the captures into committed fixtures under `runner/test/fixtures/codex/`.

**Input formats.** It reads both capture formats:

- `{dir, t, msg}` lines (from `drive.mjs` and the spike scripts);
- the probe log's `{t, dir, method, params, imageCheck}`, `{t, dir, response, result}`, `{t, dir, serverRequest, id, params}` and `{t, historyItems}` records.

**What it does:**

- keeps the requests that matter and every incoming message;
- rewrites the temp folders (`/tmp/tb-step4-rec/run`, `/tmp/tb-step4-rec/probe`, the spikes' `/tmp/tb-*` folders, and their `/private/tmp` forms) to `/work/proj`;
- swaps every base64 `result` for a tiny real PNG (`test/helpers/png.ts`);
- drops or rewrites:
  - the `account/read` email (already redacted), `accountId` and `workspaceRouting`;
  - `userAgent`'s OS details, `codexHome`, `thread.path` (`~/.codex/sessions/...`), `instructionSources` (to `/work/proj/AGENTS.md` and `~/.codex/AGENTS.md`), and any other `/Users/m5-mike` path;
  - credit balances in rate-limit reads and updates;
  - moderation metadata (`turn/moderationMetadata`);
  - `hook/completed`'s `run.entries[].text`, `run.sourcePath` and `run.statusMessage`;
  - `remoteControl/status/changed`'s `serverName` (the Mac's hostname) and `installationId`;
  - the `paper` server's startup error text (a localhost port);
  - `mcpServerStatus/list` and `experimentalFeature/list` replies, entirely;
- **fails loudly** on anything it didn't expect to keep: a string that looks like an email, a `/Users/` path, an `accountId`, or a `...[N chars]` or `...<N chars>` truncation marker.
- Messages in the 27 Oct captures are complete, so fixtures can use the real diffs and command output. The big-line test is still generated: a ~2.5 MB `item/completed` line with a real PNG, plus a line over a test-sized guard.

**Fixtures to make** (paths under `runner/.fixtures/codex-raw/`; line ranges are 1-based and inclusive, from each capture's index or notes):

| Fixture | Source |
|---|---|
| `text`, `command-and-add` | `run.ndjson`, turns 1 (lines 7 to 23) and 2 (24 to 69) |
| `update-patch` | `run2.ndjson` turn 1 (7 to 31). Not `run.ndjson`, as the first version said |
| `multi-file-patch` | Hand-written: one fileChange item touching three paths, then a `patchUpdated` for one of them |
| `approvals` (command and patch declined, luna) | `run2.ndjson` turns 2 and 3 |
| `approvals-accepted` (sol) | `spikes/ask-mode-and-reasoning/spike2-ask.ndjson`: a command and a patch accepted, an `ls` with no approval, a command and a patch declined |
| `interrupt` | `run.ndjson` turn 5 (123 to 137): `sleep 30`, then `turn/interrupt` |
| `failure` | `fail.ndjson`, unknown model |
| `resume` | `resume1.ndjson` and `resume2.ndjson` |
| `image-in` | `run.ndjson` turn 3 (70 to 83) |
| `image-generation` | `probe-images.ndjson` lines 26 and 27 |
| `image-view` | `probe-images.ndjson` lines 21 and 22 |
| `rate-limits` | `probe.ndjson`'s read, plus the updates in `probe-images.ndjson` |
| `reasoning` | `spikes/ask-mode-and-reasoning/spike7-reasoning-longer.ndjson` turn 1 (lines 1 to about 124), plus the empty reasoning item in turn 2 of `spike7-reasoning.ndjson` |
| `dynamic-tools` | `spikes/tools-and-env/start.ndjson` and `resume.ndjson`: a tool call at start, and again after a resume in a new process |
| `subagent` | `spikes/subagents-and-background/subagent.ndjson` lines 7 to 62: `subAgentActivity` started and completed, the child's imageView and approval |
| `background-terminal` | `spikes/subagents-and-background/background-exit.ndjson` lines 7 to 38: an open command at `turn/completed`, then its late output and completion |
| `real-config` | `spikes/real-config-and-mcp/run1/wire.ndjson`, thread A, lines 1 to 49 |
| `close-and-resume` (optional) | `spikes/resume-and-big-image/spike10.ndjson` lines 24 to 37, 47 to 56 and 799 to 802 |

**Done when** each fixture replays to the expected outputs, including:

- one generated image as `{mediaType: "image/png", width, height}` inside the media folder;
- the fallback to `result` when `savedPath` is missing;
- a failed generation, with `errorKind` where Codex gives one;
- a `file://` imageView;
- an MCP image block;
- an interrupt closing the open command;
- a background terminal left open at the end of a completed turn, reported in `tasks`, then filled in and dropped from `tasks` when it finishes;
- three `edit.diff` events with three paths on one item;
- a subagent row titled from `agentPath`, its result from the child's final answer, and the child's image placed in the parent;
- reasoning that doesn't start with a blank line, and an empty reasoning item giving nothing;
- a declined command and a declined patch with ok false;
- a dynamic tool call named `mcp__threadbear__<tool>`;
- an unknown item type shown as a plain row;
- every notification method in `real-config` either mapped or listed as ignored.

### As built (B)

**What A calls on `CodexNormalizer`** (`new CodexNormalizer(ctx, {log})`, one per session):

- `setThread(threadId, model?)` after `thread/start` or `thread/resume`, with the model it reported in `session`, so a later `thread/settings/updated` with another model is reported again.
- `startingTurn(runnerTurnId)` when it sends `turn/start`, and `turnAccepted(codexTurnId)` with the reply. A `turn/started` in between counts as ours. `steered(runnerId)` for a message sent with `turn/steer`.
- `handle(method, params, from?)` for every notification of its thread, its process's thread-less ones, and its children's (with `from.childThreadId`). Server requests don't go here.
- `lineTooLarge(head)` when the line reader skips a line over its guard, with the line's first few KB, or `handle(OVERSIZED_LINE, {method?, itemId?})` (exported, `"threadbear/oversizedLine"`) when the reader has already picked those out; with `from` for a child. If it names an open item, that item closes as "Too large to show"; if not, the turn's other open items do.
- `closeOpen(reason)` when the session ends with rows still open (process death, hard stop). It closes background terminals too and sends `tasks: []`. It emits no `result`.
- `interruptedCommands()` after an interrupted or failed `turn/completed`: the command item ids it closed, for `backgroundTerminals/terminate`.
- `limitsFromRateLimits(snapshot)` takes `account/rateLimits/read`'s result or a merged update (`handle('account/rateLimits/updated', merged)` does the same), and `limitsFromAccount(result)` takes `account/read`'s.
- `innerCommand(command)` strips `/bin/zsh -lc '...'`, for approval titles and "Always allow" rules.
- `MAPPED_ITEM_TYPES`, `IGNORED_ITEM_TYPES`, `MAPPED_METHODS` and `IGNORED_METHODS` are exported for `surface.ts`, so its ignore list and the normaliser's can't drift.

**Differences from the plan above:**

- A subagent row still open when a turn completes is kept open like a background terminal (`tasks` with `kind: "agent"`), not closed as interrupted: the child is still running in the process. Its `subAgentActivity completed` closes it later.
- The credits detail ("1,234 credits") goes on the last of the `codex` bucket's windows (the weekly one when there are both).
- Committed fixtures are `{proc, dir, t, msg}` lines. `proc` tells the processes of a resume apart. Every fixture keeps its capture's handshake and `thread/start` lines, so a replay knows its thread.
- Extra fixtures: `models` (`probe.ndjson`'s `model/list`, for A), and the hand-written `mcp-image` (an MCP image block, an image resource, a dynamic tool's `data:` image), since no capture had MCP servers on. The optional `close-and-resume` isn't made.
- The sanitiser also fails on the values of the keys it drops (account ids, `installationId`, `serverName`) wherever else they appear, and on this Mac's user and host name. The hostname also appeared with a `.localdomain` suffix.
- `context.ts` gained `truncateResultText`, the 64 KB cut with a blob, for the Codex normaliser.

## C. Runner plumbing

All edits to `runner.ts`, `main.ts`, `rpc.ts`, `store.ts`, `threadbear-mcp.ts`, `cli.ts`, `tb-dev.ts` and `test/helpers/fakes.ts`. Merge main into your branch once Mike's steering change is on it, and build on its `canSteer()`, `steer()` and `Turn.messages`.

**Making a `ThreadRecord`.** Everywhere one is made, `provider` comes from the chosen account.

- That includes `create` and `rebuild()`.
- Both hardcode `provider: 'claude'` today. `rebuild()` also takes the last-used account, so once that's `codex-main`, a rebuilt thread would start the Claude adapter with `CLAUDE_CONFIG_DIR=~/.codex`.
- No other code path may assume `'claude'`.

**`create`**

- `provider = account.provider`.
- `model` defaults to `defaults.models[provider]`, falling back to `defaults.model` for Claude.
- `effort` defaults to `defaults.efforts[provider]` when set.
- `model` and `effort` are checked against the provider and the account's `models`, as described in Contracts.

**`update`** handles a change of provider (see Contracts):

- Claude-syntax `allowRules` are cleared.
- `carryTranscript` stays Claude-only.
- On a `movesFolders` adapter, a same-account folder change skips the copy and the handoff. A live session gets `setCwd`, and a released one gets the new folder on its next resume. The thread gets "Moved to X. The session carries on there."
- On a `settingsApplyNextTurn` adapter, a mode, model, effort or folder change during a running turn adds a `system.note`. Example: "Ask before edits applies from the next turn. This turn carries on as it started."

**Sessions**

- `onExited` treats `SessionNotFoundError`, or the old Claude message, as "start fresh once".
- When the thread has earlier turns, the fresh session's first message always starts with `handoffNote()`, worded "The earlier session couldn't be found, so here's where the thread got to". Today the note is only added when `rt.carried` is set.
  - For Claude, "no conversation found" only ever meant the CLI died before its first message.
  - For Codex, not-found also covers a thread deleted in Codex Desktop, a missing rollout, or a changed `CODEX_HOME`, in the middle of a conversation.
- Steering needs nothing Codex-specific in the runner: the Codex adapter takes `send()` during a turn and reports `answered` and `queuedTurns` (A). A unit test with a fake adapter that steers like Codex (a second message answered in a second CLI turn inside the same runner turn) keeps it that way.

**`onOutput`**

- `context` stores `contextWindow`.
- `limits` goes to D's `UsageStore`, with `rec.accountId`.
- `cliVersion` is stored on the runtime. When it differs from that thread's previous session, emit the `system.note` "Codex 0.165.0 from this turn on (was 0.164.0)".
- `tasks`: on an adapter with `wakesAfterTasks: false`, a shrinking list doesn't start the wake grace (`startWakeGrace`). Claude starts a turn to read a finished task's result; Codex doesn't, so the thread would only look busy for 15 seconds for nothing.

**Archive and delete** call `adapter.archive?.(account, nativeSessionId)` best effort, and log on failure.

**`hello`, models and `accounts.updated`**

- `hello` returns `defaults.models` and `defaults.efforts`, the accounts with D's usage, and E's `clis`.
- `probeModels()` already asks every account's adapter for its models at startup. Also ask it for an account that appears later (the rescan), and for every Codex account after a Codex update activates (E's `onChange`), since a new version can change the list.
- Call `accounts.list()` every 10 seconds so a new login is noticed without a client asking.
- `accounts.updated` goes out on a rescan change, a `learn()` change or a usage change, through one throttle: the first at once, then at most every 5 seconds, ending on the latest list.

**E's hooks**

- `restartPending(): boolean`.
- `releaseIdle(provider, keepVersion)`. It releases only sessions that have **none** of these:
  - a turn (starting, running or interrupting);
  - pending approvals or questions;
  - queued messages;
  - `rt.tasks`;
  - a `wakeTimer`;
  - `releaseWhenIdle` already set.

  Sessions already on `keepVersion` are left alone. It calls the existing soft `releaseSession` and never the hard path, so background work is never stopped by an update.
- **Version moves.** The runner remembers the wanted version per provider. When a turn ends on a session that's on another version and now meets the rules above, the session is released, and the next message resumes on the new version.
- `versionsInUse(provider)`, from each session's `cliVersion`.
- `codexBinariesInUse(): string[]`, from the Codex adapter's live processes, so E only deletes version folders nothing runs.
- Register `clis.*` in `rpc.ts`.

**`main.ts`**

- Build `CodexAdapter` with `{codexBinary: () => updates.codexBinary(), codexArgs, registry, log, toolsFor: (threadId) => buildThreadbearTools(runner, threadId)}` (`registry` is the `ProcessRegistry`, as for Claude), and set `adapters: { claude, codex }`.
- Build D's `UsageStore` and hand it to the `AccountRegistry`.
- A missing Codex binary is a startup `runner.notice` warning, like a missing `claude`.

**Live CLI cap.** `maxLive` counts every live session, Codex the same as Claude. With one process per thread, a live Codex thread costs about what a Claude CLI with its MCP servers does (A, "Why one process per thread"), and a released one costs nothing.

**`threadbear-mcp.ts`**

- `list_accounts` shows the provider, the note and the room left, using D's `usageLine`.
- `create_thread` and `move_thread` accept Codex accounts.
- The `effort` enums use `EFFORT_LEVELS` instead of a copied list.

**`tb` and the dev runner**

- `tb new --account codex-main --model gpt-6-luna --effort low` works.
- `tb accounts <account>` prints that account's `models` and default from `hello` (`tb models` is main's OpenRouter command).
- `tb self` and `formatSelf` (`tb-dev.ts`) show the provider.
- `dev-runner.sh` writes `defaults.models.codex: "gpt-6-luna"`, `defaults.efforts.codex: "low"` and `cliUpdates` off into a new data dir, next to today's claude-3 and `claude-haiku-5-5`. Dev runners use the fallback npm copy.

**`check.sh`.** `--e2e` runs the Codex e2e and E's install test after Claude's. `TB_E2E_SKIP_CODEX=1` skips both.

**Done when** the runner unit tests pass, all with fake adapters. They cover:

- create, rebuild and update across providers, including rebuild with `codex-main` as the default account;
- model and effort defaults, and `ultra` dropped from a Claude thread;
- an old-shape client (no effort, `sonnet` on a Codex account) getting the Codex default and a note;
- the fresh-session retry on `SessionNotFoundError`, where the resent text on a thread with history starts with the handoff;
- a folder move on a `movesFolders` adapter, live and released;
- the next-turn note on a `settingsApplyNextTurn` adapter;
- no wake grace on a `wakesAfterTasks: false` adapter;
- a Codex-style steer (above);
- `releaseIdle`: a live idle session with background tasks survives, and so do sessions with queued messages or pending approvals;
- the release after a turn on an old version;
- the models probe for a new account and after an update;
- the `accounts.updated` throttle;
- the `clis.*` wiring.

A dev runner must also hold a real Codex conversation.

### As built (C, 27 Oct)

A, D and E are wired in `main.ts`: `UsageStore` feeds `AccountRegistry(cfg, usage)`; `CliUpdates` gets lazy hooks into the runner and the Restarter, A's `resolveCodexBinary`, `checkSurface` and `testedVersion`, and a `notice`; `CodexAdapter` starts `updates.codexBinary()` with `buildThreadbearTools` as `toolsFor` and `onNotice` as a `runner.notice` warning. `updates.start()` runs once the runner listens, `stop()` with the rest. A missing Codex binary is a warning to every client after hello (like a missing claude), worded for a hand-set `codexPath`, Threadbear's own copy still on its way, or updates off.

Seams the runner uses:

- **E:** `runner.cliHooks(restartPending)` returns E's `hooks`; `runner.attachClis(updates)` (statuses in `hello` and `clis.updated`, Codex models asked again when Codex's `installedVersion` changes); `RpcServer`'s `clis` option serves `clis.*` (`-32601` without it); `main.ts` adds `clis` to `runner.status`. The runner only needs `list/check/update/setPolicy/onChange` (`CliControl` in `runner.ts`).
- **A:** the adapter flags and `archive` as in Contracts, `SessionNotFoundError` on a resume that can't find the thread, and an optional `binariesInUse(): string[]` on the adapter object (the real binary paths its live processes run), which `codexBinariesInUse()` passes to E. A's own `setCwd` must resolve; if it rejects, the runner falls back to releasing the session so it resumes in the new folder.

Calls made where the section didn't say, or said otherwise:

- **A provider with no adapter is refused.** `threads.create` and a `threads.update` to such an account answer `-32602` ("This runner can't run Codex threads yet, so codex-main can't be used."), and `pickAccount` only sees accounts the runner can run. Until A is wired, `codex-main` is listed but can't be used.
- **`defaults.keepAccount`** (new `runner.json` field): new threads start on `defaults.accountId` as it is, not the account with the most room. `dev-runner.sh` sets it so its threads stay on claude-3.
- **Version moves:** `releaseIdle(p, v)` marks every live session of that provider not reporting `v`, releases the idle ones now (soft only), and the rest when they next meet the rules (turn end, tasks finishing, wake grace ending). A new turn for a marked session restarts it on the new version first; a message sent during its running turn still steers into it. Claude now reports `cliVersion` from `init`'s `claude_code_version` (`claude/normalize.ts`), so `versionsInUse('claude')` works and a Claude update notes "Claude Code X from this turn on (was Y)".
- **"Failed to start twice":** the runner calls `sessionStarted(p, version, ok)` with ok on a session's first `cliVersion`, and not ok when it exits with an error before one (not a missing session to resume, not a release), with the version E reported as installed when it started. A Codex `thread/start` that fails after `initialize` counts as a failed start too; the runner corrects models, so that should be rare.
- **Re-asking Codex's models** happens when E's Codex `installedVersion` changes from a known one, or arrives where Codex was `missing`; E working out the installed version after it starts isn't an update (the first dev run probed twice before this).
- **No test runner installs a CLI:** `check.sh` exports `THREADBEAR_CLI_UPDATES=off`, and `main.test.ts`, both Claude e2e files and the deploy smoke test (`deploy.mjs`, which also gets temp `THREADBEAR_CODEX_MAIN_DIR` and `THREADBEAR_TOKEN_STATS_LIMITS`, so its model probe never starts a real codex) set it themselves.
- **Not found:** `SessionNotFoundError` retries fresh whatever the status; the old Claude text still needs `starting`. "Earlier turns" means `lastTurnCompletedSeq > 0`. The fresh-retry allowance resets once a session reports itself, so a later loss gets its own retry. Messages steered in before the loss are sent again in order.
- **Model check on Claude** only drops Codex ids (`gpt-`, or in a Codex account's list) the Claude account doesn't list; anything else is passed on as before. A dropped effort falls back to `defaults.efforts[provider]` when the model offers it, else the model's own level.
- **Notes:** `create`'s model and effort notes go under the first turn. A Codex folder move's "Moved to X. The session carries on there." comes at the next turn (as Claude's does), and a message sent during the turn after a move is queued, not steered into the old folder. The next-turn note lists everything in one sentence ("The move to X, GPT-6-Luna and Low effort apply from the next turn. This turn carries on as it started.").
- **Archive** runs only when a thread becomes archived (not on a repeat), after the session's release settles; delete after its hard stop.
- **`accounts.updated`** sends nothing when the list is the same as the last one sent; the 10 s rescan uses that to notice a change even without D's `onChange`.
- **A real Codex conversation on a dev runner** (27 Oct, luna at low effort, Mike's MCP servers and memories off through `codexArgs`): a text turn, `ls` plus a file written by the shell, an `apply_patch` touching two files (one tool row, two `edit.diff`s), a same-account folder move (the next answer followed the new folder's `AGENTS.md`, same process), a message steered in during `sleep 6` (one runner turn, one `turn.completed`), archive (released, rollout moved to `archived_sessions`), unarchive and resume (context kept, Codex unarchived it), and a `list_threads` dynamic tool call after the resume. Summaries had `modelInUse`, `effortInUse`, `contextTokens` and `contextWindow` 258,400; `thread.json` kept `cliVersion` 0.164.0. The thread was deleted with `thread/delete` afterwards.
- **`tb accounts`** shows the provider and note; **`tb accounts <account> [--json]`** is in `tb-dev.ts`'s `formatModels`. `check.sh --e2e` runs `codex*.e2e.test.ts` as its own step after Claude's.

## D. Accounts and usage (`accounts.ts`, `usage.ts`)

Token Stats stays the only program that does any of these:

- reads Keychain logins;
- renews them (it writes them back to the Keychain under Claude Code's lock);
- calls Anthropic's `api/oauth/usage` endpoint, which is prone to 429s.

Threadbear reads Token Stats' file as a baseline, and adds the readings it gets for free from its own turns. It never runs `token-stats limits`, which can renew logins and doesn't even update the file.

### Discovery

`accounts.ts` already discovers the Claude logins and works out `defaultModel` (`readSettingsModel`, `resolveDefaultModel`, `learn()`, `enrich()`). D adds Codex next to it.

| Id | Where | Counted when |
|---|---|---|
| `claude-main` | `~/.claude` | As today |
| `claude-N` | `Token Stats/Accounts/claude-N` | As today |
| `codex-main` | `codexMainDir` (`~/.codex`) | `auth.json` **exists** (`fs.existsSync`, never read), or `config.toml` sets `cli_auth_credentials_store` to `keyring` or `auto` |
| `codex-N` | `Token Stats/Accounts/codex-N`, which Token Stats' Add account makes | Same as `codex-main` |

Today that's four Claude logins and one Codex login (ChatGPT Pro Lite). Nothing creates `codex-N` yet.

**Codex defaults.** From `config.toml` read only the top-level keys `model`, `model_reasoning_effort` and `cli_auth_credentials_store`, with a small line reader that stops at the first `[table]` (no TOML dependency, and nothing else from the file). `model` gives `defaultModel` (`learn()` and the first turn correct it, as for Claude), and `model_reasoning_effort` gives `defaultEffort`. Mike's has both (gpt-6.1-sol and high).

**Notes.** `note` comes from `cfg.accountNotes`.

**Titles, email and plan** come from these sources, in order:

1. `limits.json`'s entry for that `configDir` (matched by realpath, with `~` expanded; the fallback is provider plus email);
2. the last `account/read` or `account/updated` reading, cached in `<data dir>/accounts-cache.json` (email and plan only);
3. `.claude.json`, for Claude;
4. the id.

`limits.json`'s email wins over `.claude.json`'s because it comes from the profile endpoint. `~/.claude.json` once held a stale gmail address for the cannstudios login.

`limits.json` names providers with capitals (`"Claude"`, `"Codex"`), writes `configDir` as `~/.codex` or a full path, and also lists Grok and Muse. Compare providers without case, and skip any provider Threadbear doesn't run.

Codex titles get the "Codex · " prefix (see Contracts). `codex-main` and `claude-1` are both `mike.cann@gmail.com` in `limits.json`, and an old app would otherwise show two identical entries.

**Wiring.** `AccountRegistry` takes the `UsageStore`, so `list()` carries each account's `usage`, and gains `onChange(fn)`, fired when a rescan finds a different list. C does the timing and the throttle.

### `UsageStore` (`usage.ts`)

```ts
class UsageStore {
  constructor(o: { limitsFile: string; dataDir: string; clock: Clock; log: Logger })
  start(): void
  stop(): void
  record(accountId: string, reading: { windows: UsageWindow[]; blocked?: boolean; email?: string; plan?: string }): void
  usageFor(account: Account): AccountUsage | undefined
  onChange(fn: (accountIds: string[]) => void): () => void
}
export function usageLine(u: AccountUsage | undefined): string // "5-hour 89% left, weekly 78% left, resets Thu 1 pm"
export function pickAccount(accounts: Account[], lastUsedId: string | undefined): string | undefined // see "Picking an account for a new thread"
```

**Reading the baseline**

- Watch the Token Stats folder for `limits.json`, which is replaced by rename. As a fallback, check its modification time every 60 seconds.
- Accept `version === 1` and ignore unknown fields. Today's file is `{version, generatedAt, complete, accounts: [{provider, plan, email, configDir, label, notice, usageReadAt, windows: [{kind, title, remainingPercent, resetsAt, detail}]}]}`. `remainingPercent` can be fractional (53.11612 on an allowance), and `notice` can be null.

**Merging**

- Merge per window kind. The newer reading wins (live time against `usageReadAt`).
- A window whose `resetsAt` has passed counts as 100% left, with a timer for the next reset.
- `generatedAt` older than 15 minutes, with no live reading since, sets `stale`.
- A reading with no windows (Codex's `account/updated`) only updates the plan.

**Persisting.** Write `<data dir>/usage.json` atomically, so a restart has numbers straight away.

**Claude live readings** (`claude/normalize.ts`, the rate-limit parts only). They used to be dropped.

- Prefer `rate_limit_info.unifiedWindows.five_hour` and `seven_day`. These are `utilization` fractions from 0 to 1, with `resetsAt` in seconds.
- Fall back to the documented single `rateLimitType` plus `utilization`.
- `status: "rejected"` sets `blocked`. A turn that fails on it gets `errorKind: "usageLimit"`.
- Verified on claude-3 through SDK 0.3.310, with reset times matching `limits.json` exactly.
- `unifiedWindows` isn't in `sdk.d.ts`, so the fallback stays.
- Don't use the SDK's `usage_EXPERIMENTAL...` call: it hits the same 429-prone endpoint.
- Mike's steering change also edits `claude/normalize.ts` (the result case). Keep D's edits to the rate-limit parts.

**Codex live readings** come through section B's `limits`.

**Done when:**

- unit tests pass with:
  - a `limits.json` fixture in today's real shape (capitalised providers, Grok and Muse entries, a `~/.codex` path, an allowance window), with the emails replaced;
  - the real `rate_limit_event` and `account/rateLimits/read` payloads (no secrets in either), including a non-`codex` bucket;
  - newer-wins merging;
  - a passed reset coming back to 100%;
  - path matching with and without a trailing slash, and with `~`;
  - Codex discovery from temp dirs with an empty `auth.json`;
  - Codex `defaultModel` and `defaultEffort` from a temp `config.toml`, ignoring the same keys inside a table;
  - the "Codex · " title and the claude-2 note;
- `diff-media-accounts.test.ts` still passes, updated by D where the account shape changed;
- no test reads a real `auth.json` or `config.toml`.

### As built (D, 27 Oct)

Calls made where this section didn't say, or said otherwise:

- **Codex windows are B's.** Turning `account/rateLimits/*` into `UsageWindow`s stays in B's `codex/normalize.ts`, as B's table says. D's test feeds the store a reading in the shape B makes from the real `account/rateLimits/read` (weekly only, plus a made-up second bucket as an `other` window, since no capture has one).
- **One file.** Email and plan from a live reading (`account/read`, `account/updated`) are kept in `usage.json` with the live windows, not in a separate `accounts-cache.json`.
- **Merge key.** `five_hour`, `weekly`, `daily` and `monthly` merge by kind. `weekly_model`, `allowance` and `other` merge by kind plus title, so Codex's extra buckets (all `other`) don't replace each other.
- **Stale** means `generatedAt` is over 15 minutes old and the account has had no live reading in the last 15 minutes. ("No live reading since" generatedAt would never go stale again after one turn.)
- **Blocked** comes from live readings only. Token Stats' 0% isn't a block: claude-2 (Team) shows 0% on its 5-hour window while it keeps working on extra usage. A block ends when the windows at under 1% in that reading reset, or when a later reading isn't blocked.
- **A passed reset** also drops the window's `detail` ("$132.79 left" is old once it resets).
- **`errorKind: "usageLimit"`** on a failed Claude turn: a `rejected` event earlier in the turn, or, for a CLI that sent none, the result text ("hit your limit", "usage limit reached", `rate_limit_error`).
- **`onChange`** of the store reports an account when a live reading moves a window by a point or more, and for anything at all on a new `limits.json`, a reset, a block ending or going stale (one timer for the next of those). An account no client has listed yet is reported on its first reading.
- **`pickAccount` gaps.** With no last-used account (or one that's gone), candidates are the first account's provider (Claude's come first). A tie between two accounts that aren't the last-used one goes to the first in the list. With nothing to pick and no last-used account, it returns `undefined` and the caller uses its own default. The cases are in `runner/test/fixtures/pick-account-cases.json`, in a shape F's Swift tests can read as is.
- **Interface additions:** `UsageStore.identityFor(account)` (email and plan for titles), `UsageStore.reload()`, `usageLine(u, now?)`, and exports `accountRoom`, `MIN_ROOM_PERCENT`, `resetTime`, `parseLimitsJson`, `samePathKey`, and `rateLimitReading` from `claude/normalize.ts`. `new AccountRegistry(cfg, usage?)`, where `codexMainDir` and `accountNotes` are optional in `cfg`; `onChange(fn(accounts))`. Claude accounts now carry `email` too.
- **`main.test.ts`** (nobody's file) now sets `THREADBEAR_CODEX_MAIN_DIR` and `THREADBEAR_TOKEN_STATS_LIMITS` to temp paths, so starting the real entry point never reads `~/.codex/config.toml` or the real `limits.json`.
- **For C:** `main.ts` already passes the full `Config`, so once D is in `step4`, `codex-main` shows up in the account list before C registers the Codex adapter.

## E. CLI updates (`runner/src/updates/`)

```ts
class CliUpdates {
  constructor(d: { cfg: Config; log: Logger; clock: Clock; hooks: {
    restartPending(): boolean
    releaseIdle(p: Provider, keepVersion: string): void
    versionsInUse(p: Provider): { version: string; threadIds: string[] }[]
    codexBinariesInUse(): string[]
  } })
  start(): void
  stop(): void
  codexBinary(): string                 // what the next Codex process should start
  list(): CliStatus[]
  check(p?: Provider): CliStatus[]      // starts a check, returns at once
  update(p: Provider, o?: { version?: string; force?: boolean }): CliStatus[] // starts, returns at once
  setPolicy(p: Provider, policy: 'auto' | 'notify' | 'off'): CliStatus[]
  onChange(fn: (clis: CliStatus[]) => void): () => void
}
```

The first version had a `retireCodex()` hook for the shared process. With one process per thread there's nothing to retire: every new process starts `codexBinary()`.

### Checking

- **When:** 60 seconds after start, then hourly with up to 5 minutes of random delay, and on `clis.check`.
- **Timeouts:** 5 seconds. The last known value is kept on failure.
- **Network:** no lookups when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

| | Installed | Latest |
|---|---|---|
| Claude | `readlink(claudePath)` gives `~/.local/share/claude/versions/<v>`. Fallback: `claude --version` (10 s) | `GET https://downloads.claude.ai/claude-code-releases/<channel>`. The channel is `autoUpdatesChannel` from `~/.claude/settings.json`, default `latest` (Mike chose `latest`: 2.1.311 today; `stable` is 2.1.308) |
| Codex | `<home>/tools/codex/current`'s version, or the fallback copy's `package.json` | `GET https://registry.npmjs.org/@openai/codex/latest` |

### Applying

- One update at a time per provider, and never while a runner restart is pending.
- Each run has a 5-minute timeout.
- Its output (up to 10 KB) goes to `updates.ndjson`, capped at 500 lines.
- State lives in `updates.json`, written atomically.
- Progress goes out through `onChange`, so `clis.update` never keeps the app's RPC waiting.

**Claude** is safe while turns run.

- Each version is its own file, the link is swapped atomically, and every running Claude locks its own version.
- Verified on the Mac at 06:51 on 26 Oct: a session started on 2.1.310 kept running it after T3 updated to 2.1.311.
- **Steps:**
  1. Run `<claudePath> update`, with `CLAUDE_CONFIG_DIR` removed and the runner's tmp dir as cwd. The binary is shared by all four logins.
  2. Verify by reading the link. `claude update` exits 0 without updating when another Claude holds the install lock ("Another Claude process (PID n) is currently running"). In that case the state is `waiting`; retry in 10 minutes, up to 3 times.
  3. Call `releaseIdle('claude', newVersion)`.
- Token Stats running the same command daily is harmless, because the installer has its own lock.

**Codex** runs from Threadbear's own copies, which nothing else installs into.

```
<home>/tools/codex/
  0.164.0/          an npm --prefix install of @openai/codex@0.164.0
  0.165.0/
  current -> 0.165.0
  state.json        { current, previous, hold?: {version, reason, missing}, installs: [...] }
  .lock             pid of the runner installing, so two runners on one home never overlap
```

1. **Install** into `<v>.partial`: `<node dir>/npm install --prefix <home>/tools/codex/<v>.partial --no-save --no-fund --no-audit @openai/codex@<v>`, with the runner's Node first on PATH.
2. **Verify** the new folder:
   - A's resolver finds the native binary;
   - `<binary> --version` prints `<v>`;
   - `<binary> app-server --help` exits 0 (T3's check).
3. **Gate.** Run `<binary> app-server generate-ts --experimental --out <tmp>`, which is offline and needs no login, then `checkSurface(tmp)`.
   - **Anything we use is missing:** don't activate. Set `hold {version, reason: "the app-server protocol changed", missing}` and `status: "held"`, and send `clis.updated`. The Update button with `force: true` installs it anyway.
   - **New names only:** activate, and record them in `updates.ndjson`. New item types show as plain rows (section B) until they're mapped.
4. **Activate.**
   - Rename `<v>.partial` to `<v>`.
   - Swap `current` by renaming a temp link over it, the same way runner releases do.
   - Call `releaseIdle('codex', v)`, and send `onChange` (C re-reads the Codex model lists on it).
   - Running turns finish on their old process, whose files never change. Every new session starts on `<v>`. Idle sessions move as their turns end (section C).
5. **Clean up.** Keep `current` and `previous`. Delete any other version only when:
   - `codexBinariesInUse()` doesn't name it;
   - and no process's arguments mention its folder (`ps -axo args=`, arguments only, never environments).

**Bootstrap.** On the first start with updates on and no `current`:

- install `latestVersion` if it passes the gate, otherwise `testedVersion`;
- until then, Codex runs from the fallback copy;
- when it lands, activate as above.

**Why not the shared npm copy:**

- Token Stats reinstalls it daily, even when nothing changed.
- T3's "Update all" can replace it at any time.
- Either swaps the tree under any running Codex that uses it.
- Threadbear's copies make the "Codex threads are quiet" wait, the npm process check and the foreign-process check unnecessary.

**Disk.** About 340 MB per version, so about 700 MB with two kept.

### Failure and rollback

- If two sessions in a row on a new version die before `init` (Claude) or `initialize` (Codex), send a `runner.notice` warning.
  - Claude: "Claude Code 2.1.312 failed to start twice. To go back: claude install 2.1.311".
  - Codex: "Codex 0.165.0 failed to start twice. Go back to 0.164.0 in Usage".
- "Go back" calls `clis.update {provider: "codex", version: previous}`. That swaps `current` to the kept folder with no download, then releases idle sessions as above.
- There's no automatic rollback in this step.

**Done when** the unit tests pass with:

- a fake native layout (`versions/` plus a link), and a fake `claude update` that exits 0 without changing the link;
- a fake Codex install (a stub npm that lays out a fake package with a stub binary), covering:
  - activation and `releaseIdle` on success;
  - a hold when the stub's generated schema lacks a method;
  - `force` past a hold;
  - "Go back" to `previous`;
  - an old version deleted only once nothing uses it;
  - `.partial` folders cleaned up after a failed install;
- `update()` and `check()` returning at once, with state reported through `onChange`;
- a running turn on the old process carrying on while the new version activates, and its session moving after the turn.

### As built (E)

**For C, wiring it in `main.ts`:**

- The constructor takes `{cfg, log, clock, hooks, codex: {resolve, checkSurface, testedVersion}, notice?}`. `codex` is A's: `resolve` is `resolveCodexBinary` (only `{command, native}` is read), `checkSurface` and `testedVersion` come from `surface.ts`. They're injected because A hadn't landed when E was built, and so the tests use stubs. `notice(level, message)` is a `runner.notice`.
- `codexBinary()` returns a start path for A's resolver, not the native binary: `codexPath`, else `<home>/tools/codex/current` (the install folder), else the fallback launcher next to the runner's Node.
- Two methods beyond the interface: `settled()` resolves once nothing is checking or installing (for tests and shutdown), and `sessionStarted(provider, version, ok)` is how the runner reports whether a session reached `init` or `initialize`, for the "failed to start twice" warning.
- Tests can also inject `exec`, `fetchText`, `env`, `execPath` (npm and the fallback codex sit next to it) and `random`.

**Choices the plan didn't cover:**

- The app's `clis.setPolicy` is kept in `<home>/updates.json`, not `runner.json`. `THREADBEAR_CLI_UPDATES=off`, or `off` in `runner.json`, can't be turned on from the app, and a `codexPath` set by hand always shows `off`.
- `off` stops the hourly checks. `clis.check` still looks the versions up.
- A held version is installed and kept (`<v>/`, never `current`), so "Update anyway" activates it without downloading again. A hold reports `status: "held"` with `update.state: "unchanged"`, since nothing failed.
- On a first start, a latest that fails to install or is held falls back to `testedVersion`, as it does for the gate.
- An update left `running` or `waiting` by a runner that stopped reads as `failed` after the restart.
- The commands and lookups are in `updates/exec.ts`, a fifth file next to the four planned.

The real npm path gets one integration test, `codex-install.e2e.test.ts`, run under `--e2e` because it needs the network. It uses a temp `THREADBEAR_HOME` and a temp `CODEX_HOME`, runs `app-server` only, and sends no prompts. It installs a version into a temp prefix with `npm install --prefix`, starts `app-server`, swaps in another version and checks the running process keeps working. Nothing touches the real installs: not the nvm global prefix, `~/.local/bin/codex`, `~/.local/bin/claude` or Claude's versions folder.

## F. App

Plain copy: no eyebrow or kicker labels, no em dashes. Build against the mock runner first (`dev-app.sh start --mock`), then against a dev runner. Mike's steering change edits `ComposerControls.swift` too (the send button's help); keep it.

**RPC (`RunnerAPI.swift`, `RPCClient.swift`)**

- `NewThreadRequest` and `ThreadUpdate` already carry `effort`, and `accountsUpdated` is already decoded.
- New calls: `clis.list`, `check`, `update` and `setPolicy`. They return at once and keep the default timeout. A `-32601` from an old runner means "no CLI info", not an error.
- `decodeNotification` handles `clis.updated`.

**Multi-file edits (`TranscriptRow.swift`, `TranscriptReducer.swift`, `WorkGroups.swift`)**

- `ToolItem.diff: EditDiff?` becomes `diffs: [EditDiff]`, keyed by path.
- An `edit.diff` replaces the diff with the same path and appends otherwise.
- The fallback built from a Claude tool's input still applies when `diffs` is empty.
- The Edited files card goes through every diff of every tool row, so "Edit 3 files" lists and counts three.
- Until Mike's app has updated itself (a few minutes after this lands on main), it keeps showing only the last file.

**A late tool result.** A background terminal's `tool.result` arrives after its turn, with no `turnId`. The reducer already fills an earlier row by `itemId`; check that the row stops looking busy and the turn's work line and footer don't move.

**Account names.** `AccountName` becomes provider-aware, built from `email` plus `provider` rather than `title`.

- claude-1 and codex-main are both `mike.cann@gmail.com` today, so the clash check runs within a provider only.
- A Codex account's short label is "Codex" when there's one Codex login, and "Codex mike.cann" when there are several.

**Sidebar rows.** These keep today's rule of showing the account label only when it isn't the main account. Every Codex row then says "Codex", and Claude rows don't change. There's no separate provider badge.

**Composer account menu** (`ThreadSettings.accountMenu()`, today one flat list of titles)

- One section per provider, Claude then Codex.
- Each item's title is the email.
- Its subtitle is the note, if any, then the room left: "Convex work only · 5h 89% · week 78%, resets 3:40 pm", or "Limit reached, resets 3:40 pm". Accounts at their limit stay selectable.
- At the bottom, a disabled line: "Usage from Token Stats at 7:15 am", or "Token Stats hasn't updated since 6:02 am".
- A new thread starts on the account `pickAccount` chooses (see "Picking an account for a new thread" under Decisions), until Mike picks one in this menu.

**Account chip.**

- It keeps the short name.
- When the tighter of the 5-hour and weekly windows is under 25%, it adds "· 12%" in orange.
- When the account is blocked, it shows "Limit reached" in red.
- The tooltip has the full sentence.

**Model menu** (`ThreadSettings.modelMenu()`). It already lists the account's `models` with a starred default and an Effort section. For Codex:

- Until the list arrives it shows only the default row, not the three Claude aliases it falls back to today.
- Every Codex model is a main row, in `model/list`'s order. Today's "Older models" rule (ids that aren't one word, unless they're the default or the current model) would put nearly all of them there.
- The Effort section lists the chosen model's `effortLevels`, `ultra` included ("Ultra"). Its Default row's subtitle names the level that applies: the account's `defaultEffort` ("The account's default, high"), else the model's `defaultEffort` ("The model's own level, medium"), else what the last turn ran at.
- The chip already shows the model's title and effort ("GPT-6.1-Sol · High"). `ComposerChips.model` learns `gpt-` ids ("gpt-6.1-sol" reads "GPT-6.1-Sol"), for when the list hasn't loaded.

**Turn footer** (`RowRenderer.swift`). A Codex turn has no cost, so the footer shows its duration only ("12s"). Its tokens (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens`) go in "Copy debug info". Claude's footer doesn't change (Mike, 27 Oct).

**Approval cards.** A Codex command approval's `input.reason` (the model's own question) shows under the card's title.

**Usage popover.** A "Usage" button sits in the sidebar footer next to Snoozed and Archive (`SidebarFooter` in `SidebarView.swift`, around line 469) and opens `UsagePopover`.

- **Accounts:** every account, grouped by provider, with bars for 5-hour and Weekly and their reset times, the plan, the note and Token Stats' notice ("64,390 credits · 2 limit resets available"). Extra windows (per-model, allowance, other Codex buckets) are shown smaller.
- **CLIs:**
  - "Claude Code 2.1.311, up to date", or "2.1.312 available" with an Update button;
  - for a hold: "Codex 0.165.0 is held back because the app-server protocol changed", with an "Update anyway" button;
  - "Go back to 0.164.0" when Codex has a previous version;
  - a choice of Automatic, Ask me or Off;
  - when it last checked.
- Against a runner without usage or `clis.*`, it says the numbers and versions need a newer runner.

The app never polls. It redraws relative times once a minute.

**Update messages.** These use the existing quiet line under the toolbar: "Updating Claude Code to 2.1.312", "Installing Codex 0.165.0". A failure stays until it's dismissed.

**Limit errors.** When a turn fails with `errorKind: "usageLimit"`, or the account is `blocked`, the error row gets a button like "Switch to gangbusters (78% left)".

- It calls `threads.update` with the account that has the most room, same provider first.
- `contextWindow` and `auth` get their own plain sentences, with no button.

**Images**

- `ToolKind.image` gets the "photo" symbol.
- `WorkSummary` says "made an image" or "made 2 images", and "viewed an image".
- Images from an `image` kind tool get a larger maximum size in `ImageLayout` than tool screenshots.

**`AppModel`** handles `clis.updated` and `defaults.models` and `defaults.efforts` (`accounts.updated` is already handled).

**Scriptable.** The `composer-menu` automation command already prints the account and model menus; check its output shows the provider sections, subtitles and Codex efforts. Add a way to open the Usage popover from a script, and put it in `dump`.

**Mock runner**

- A Codex demo thread with:
  - a command;
  - a three-file edit with diffs;
  - a plan;
  - a generated image (a real PNG fixture);
  - an imageView;
  - a subagent row with its result and its image;
  - a background command that finishes after the turn;
  - an interrupted command;
  - a footer with tokens.
- A `codex-main` account with Codex's models (efforts up to `ultra`), `defaultEffort` and a weekly-only usage.
- Accounts with usage, including one blocked account, a stale baseline, and claude-2's note.
- Two CLIs: Claude behind, and Codex held.
- A scene in `Screenshots.swift` for each (`screenshots.sh --only` picks one).

**Done when:**

- `swift test` covers:
  - the provider-aware `AccountName` (the gmail clash);
  - `AccountUsageText` formatting;
  - Codex model chip names and the Codex model menu rows;
  - the token footer text;
  - decoding of the new fields, unknown values and `clis.updated`;
  - the reducer with one `itemId` and three paths, plus a repeated path replacing its diff;
  - a late `tool.result` with no `turnId` filling its row;
  - the Edited files card counting three;
  - the `WorkSummary` image words;
- screenshots of the composer menus, the usage popover and the Codex demo thread look right in light and dark.

**As built (F, 27 Oct).** Where the build differs from the text above, and why:

- **The account menu is a popover** (`AccountPickerView` in `ComposerControls.swift`), like the model picker beside it, built from `AccountMenu` in `AccountUsageText.swift`. An `NSMenu` can't be captured by window id without popping up over Mike's work and taking his mouse, and its rows could only hold a title and one subtitle. The sections, titles, subtitles and the "Usage from Token Stats" line are as planned; `composer-menu {"menu": "account"}` lists and clicks it, `show` opens it.
- **The model picker had moved on** (`f542719`): it's a popover with a provider rail and no Default effort row (the level picked last is remembered). So "the Default row's subtitle" became the chip and picker showing the level that applies when none is chosen (`ModelPicker.impliedEffort`: the runner's default for a new thread, else the account's `defaultEffort`, else the model's). The last model and effort picked are now remembered per provider (`lastModel`/`lastEffort` for Claude, as before, plus `.codex`), so a Codex pick never becomes a Claude thread's model.
- **The limit fix is a line above the transcript**, not a button in the error row: "Codex has reached its limit." with "Switch to mike (78% left)" (`LimitBanner` in `DetailView.swift`, `AppModel.limitAdvice`). Transcript rows are drawn from cached renders that know nothing of accounts, so a name and a percentage there would go stale. It shows while the thread's account is `blocked` or its last turn failed with `usageLimit`. `contextWindow` and `auth` add a plain sentence under the error row's message (the error row learns the kind from the `turn.completed` after it). `switchTarget` skips accounts with a note or under 10%.
- **A picked account is for that draft only**: after a new thread starts, the composer goes back to `pickAccount`, which starts from the account just used.
- **`pickAccount`** runs D's 22 cases from `runner/test/fixtures/pick-account-cases.json`, copied to `app/Tests/Fixtures/`; a test fails if the two copies differ once both are in one tree.
- **Codex footer**: the duration only, as decided; "Copy debug info" (and `dump`) adds the tokens for either provider ("24,177 in (12,032 cached), 310 out, 120 reasoning").
- **Generated images** fit a 420 pt box (screenshots stay at 320 by 240), from a `generated` flag on the image row set when its tool is `kind: "image"`.
- **The Usage popover opens above its button** and has no footer hint. CLI update progress and failures use the quiet line under the toolbar, with Dismiss on a failure (a small edit to `DetailView.swift`, which no other piece touches).
- **After the dev-runner look (27 Oct)**: an expanded patch names each file over its lines; "Copy debug info" on a footer has the turn's tokens; the usage popover scrolls only the accounts (the CLIs stay pinned at the bottom), fits inside the window, and says a Token Stats notice several accounts share once at the bottom; a window's detail that the notice repeats (Codex's credits) shows once; the model and account pickers cap their lists to the window; `view_image` rows read "View orange.png" with the photo icon; a generated image's prompt is prose, not monospace. A Codex version Mike went back from is held with the runner's own reason, and "Go back" isn't offered to the held version (`mock.clis {wentBack: true}` shows it).
- **Mock runner**: `mock.accounts {accounts}` replaces the list and `{old: true}` plays a pre-step-4 runner (no usage, no Codex accounts, `clis.*` answer -32601). `clis.update` reports `running`, then `succeeded` 2.5 s later; on a held Codex it needs `force` or a `version`.

## Tests

**Unit (`./check.sh --quick`, no network):**

- A's fake app-server tests;
- B's fixture replays;
- C's runner tests with fake adapters;
- D's and E's module tests;
- the app's `swift test`.

Fixtures come only from the research probes and spikes (tiny prompts in temp folders), scrubbed by the sanitiser. They never come from Mike's real rollouts.

**Real-model e2e:** `runner/test/e2e/codex.e2e.test.ts`, run by `./check.sh --e2e`.

**Setup**

- A temp runner data dir on port 0, a temp working folder under `/tmp`, and `THREADBEAR_CLI_UPDATES=off`.
- Account `codex-main` (`TB_E2E_CODEX_ACCOUNT`), model `gpt-6-luna` (`TB_E2E_CODEX_MODEL`), effort low.
- It uses Mike's real `~/.codex`, since the login lives there. So `codexArgs` switches off everything that writes to that home or starts work on its own:
  - `--disable memories --disable chronicle --disable goals`;
  - his six MCP servers, with `-c mcp_servers.<name>.enabled=false`. The names are taken from `config.toml`'s table keys: openaiDeveloperDocs, node_repl, computer-use, paper, agent-archive, connectors.
  - Without this, a prompt like "remember pineapple" could end up in his real Codex memories (`memories = true` and `chronicle = true` in his `[features]`).
  - Spikes 5 and 9 saw `codex-code-mode-host` and `SkyComputerUseClient` start even with plugins and apps off. They exit with the app-server.

**Cases**

- A text turn.
- A command plus a new file, with `edit.diff`.
- An edit to two files, with two `edit.diff` paths on one item.
- Ask mode: one approval allowed and one denied.
- Interrupting `sleep 30`. The turn ends interrupted, the command's row is closed, and the `sleep` process is gone within 5 seconds (through `backgroundTerminals/terminate`, or the session ending; `turn/interrupt` alone leaves it running).
- A background command (`sleep 8; echo finished` run so Codex yields): the turn completes, the thread shows it in `tasks` and isn't released, and the late `tool.result` fills the row.
- A message sent during a turn (while a `sleep 5` runs) is answered inside the same runner turn. This is the only real check of `turn/steer`. Skip it with a note if Mike's steering change isn't on main yet.
- Resume after an idle release (`THREADBEAR_IDLE_MS` small) remembers a word.
- Release and resume straight away: nothing reaches the thread but the answer.
- A folder move: the next answer follows the new folder's `AGENTS.md` codeword, and the instruction sources (compared after `realpath`) name the new folder next to `~/.codex/AGENTS.md`.
- A red PNG sent in comes back as "red".
- A Threadbear tool call (`list_threads`) before and after a resume.
- Archive: archiving a thread archives it in Codex too.

**Image generation** is opt-in with `TB_E2E_CODEX_IMAGEGEN=1`, since `gpt-image-2` costs more. It checks that:

- `tool.result.images[0]` is a PNG in the thread's media folder;
- `events.ndjson` has no base64 in it.

**Cleanup, in `after` and on failure:**

- `thread/delete` for every Codex thread the test made (which also deletes their subagent threads), so nothing is left in Codex Desktop's list, `state_5.sqlite` or Agent Archive. Allow a few seconds per delete (0.7 to 3.3 s measured);
- remove `~/.codex/generated_images/<threadId>` for its own threads only.

**Cost** is about fourteen luna turns at low effort, similar to the research runs.

## Checked (spikes, 27 Oct)

Each spike ran on codex-cli 0.164.0, in temp folders, with tiny prompts, mostly on gpt-6-luna at low effort, and deleted every thread it made. Full notes: `~/dev/me/threadbear-notes/step4-spikes.md`. Captures: `runner/.fixtures/codex-raw/spikes/` in the prep worktree.

1. **Dynamic tools survive a resume in a new process.** They're stored in the rollout's `session_meta`. Build the dynamic-tools route; the MCP endpoint isn't needed (A, "Threadbear tools").
2. **Ask mode on gpt-6.1-sol** (`on-request` plus read-only) asks before every command that writes and every patch, never refuses, and runs read-only commands like `ls` in the sandbox without asking. Commands offer `[accept, acceptWithExecpolicyAmendment, cancel]`; patches offer no list. `decline` works for both. `serverRequest/resolved` follows every reply within 1 ms.
3. **The per-thread `THREADBEAR_THREAD_ID` override merges** with `config.toml`'s `[shell_environment_policy.set]` (its existing variable stayed set), at start and on resume. The resume value wins, and the rollout doesn't store overrides.
4. **Every thread starts its own MCP servers**: 7 stdio processes, about 124 MB footprint, plus 25 to 60 MB inside the app-server, so about 150 to 190 MB footprint (390 MB RSS) per loaded thread. An idle app-server is 84 MB. Only `thread/delete` or the process exiting frees a thread; the app-server doesn't give memory back. This is why A runs one process per thread.
5. **Background terminals outlive `thread/unsubscribe`.** A command still running when Codex yields stays an open item past `turn/completed`; `thread/backgroundTerminals/list` reports it (Codex's own `processId`; `osPid`, CPU and RSS are always null); its output and `item/completed` arrive later with the old `turnId`. Closing the app-server's stdin kills it. Detaching with `nohup ... &` doesn't escape either.
6. **A 9000 px `localImage` is accepted.** Codex shrinks every image itself (long side at most 2048, about 2.5 MP, same format), so the runner doesn't. `detail: "original"` costs about four times the tokens.
7. **Reasoning summary deltas arrive on sol at low effort**, but only on turns where it reasons enough to summarise (about 40 reasoning tokens and up); many low turns have none, and an item can complete empty. luna at low effort sent none.
8. **Mike's real config adds no new notification methods and no server requests.** It adds a chronicle `warning` per thread (suppressed by `suppress_unstable_features_warning`), the SessionStart hook at the first turn, and about 8.9k input tokens per turn. `multi_agent` is stable and on by default in 0.164.0 (`multi_agent_v2` is off); 64 of 182 features are on, and Mike differs from the defaults only on `memories` and `chronicle`.
9. **Subagents.** The spawn signal is the parent's `subAgentActivity` item (`kind: "started"`, with `agentThreadId` and `agentPath`); no child `thread/started` reaches the parent's connection. All of the child's traffic streams there under its own `threadId`, including its approvals (request id 0, `reason` set). Child threads are persistent, and deleting the parent deletes them.
10. **Close and resume.** `thread/unsubscribe` answers `unsubscribed` at once but never unloads the thread (watched for 6 minutes), and `thread/closed` never arrived in any spike. The next resume or delete shuts a stale thread down itself, so "is closing" couldn't be triggered in 12 tries; its texts come from the binary. `turn/interrupt` doesn't stop a running command. `cwd` on `turn/start` reloads the instructions; resume with a new `cwd` only does on a thread the connection isn't subscribed to.

Capture notes:

- The captures still hold Mike's ChatGPT account id, credit balances and home paths (see "Captures" in Shape).
- The image probe ran with the same features off as the driver, so it couldn't feed Mike's memories or run his hooks. Spike 8 is the real-config capture.
- The re-recording showed luna asking for approval with `untrusted` plus read-only (`run.ndjson` turn 4), not refusing.
- `thread/read {includeTurns: true}` sends a thread-less `deprecationNotice`.
- `update-patch` comes from `run2.ndjson` turn 1.
- Only one image was generated (1254 x 1254, about 1 MB).

## Build order

1. **Contracts.** One agent, on a branch from `step4`. It's small and merges into `step4` first.
2. **In parallel**, each in its own worktree on a branch from `step4` after Contracts:

   | Agent | Work |
   |---|---|
   | 1 | A's unit-tested code; after C, the Codex e2e |
   | 2 | B, then E |
   | 3 | D |
   | 4 | F, against the mock runner |
   | 5 | C, against fake adapters, after merging main once Mike's steering change is on it |

   With fewer agents, pair A with B, and D with E. The spikes are done, so A starts building straight away.
3. **Merge order into `step4`:**
   1. B
   2. A (unit tests)
   3. D
   4. E
   5. C, which wires A, D and E and gives the first real Codex thread on a dev runner
   6. A's e2e
   7. F

   D and E are self-contained modules with their own tests, so they can land before C wires them. Before C, and again before landing, merge main into `step4` and run `./check.sh --quick`.
4. **The app against a dev runner:** `runner/scripts/dev-runner.sh`, then `app/Tools/dev-app.sh start --home <dev home>`. Look at a real Codex thread with a generated image and a multi-file edit before calling it done.
5. **Land:**
   - Run `./check.sh --e2e`, get a review, and merge `step4` into main.
   - Mike's installed app picks up F from main by itself within minutes. It works against the old runner (Contracts, "Compatibility").
   - The runner reaches him through `runner/scripts/deploy-runner.sh` from main (`--dry-run` first). That restarts the live runner once no thread is busy, so it runs only when Mike says go. It's safe with either app: the runner corrects Claude aliases on Codex threads, and Codex titles are distinct.

**Worktrees.** `runner/node_modules` and `app/Tools/mock-runner/node_modules` can be symlinks to the main checkout's (the symlinks are gitignored). A piece that changes a `package.json` replaces the symlink with a real `npm ci` in its own worktree. No piece should need a new dependency: zod 4.6.7 has `toJSONSchema`, and the `config.toml` reader is a few lines.

## Out of scope for this step

- Codex's own message queue (`thread/queue/*`). Messages during a turn go through `turn/steer` (A).
- Plan mode (`collaborationMode`), goals (`thread/goal/*`), review commands, realtime and audio, and service tiers.
- Importing old Codex or T3 threads, and paging Codex history (`thread/items/list`).
- Subagent transcripts inside the parent thread. A subagent's row, result, approvals, questions and images do come through.
- Automatic rollback and version holds Mike sets himself. Compatibility checks beyond the schema gate and the start-failure warning.
- Creating a second Codex login. Discovery picks up `codex-N` if Token Stats makes one. Whether Codex's SQLite is safe through T3-style shadow-home symlinks is unverified.
- One Codex thread open in Threadbear and Codex Desktop at once (two app-servers writing one rollout).
- Tokens and cost per account. That needs Token Stats to read the `claude-N` and `codex-N` session folders and tag records by account.
- Grok and Muse, as providers or in the usage popover, though `limits.json` lists them.
- Starting Token Stats when it isn't running.
- Switching Mike's MCP servers or plugins off for Codex threads (see "Still open").
- Tiling tall screenshots so the model can read them.
- MCP elicitation in URL mode (declined, with a note).
- Better titles, Convex summaries, Quick Ask and Tinker Desk (later steps).

## Safety during the build

- Mike works in `~/dev/me/threadbear` through his own Threadbear threads, which edit main's working tree and commit to main. Never edit, build or test there (only the Land step merges there), and never stash, reset, check out over or discard anyone's uncommitted changes.
- Nothing touches the live runner: its LaunchAgent (`com.mikerosoft.threadbear.runner`), its process, port 8797, `~/Library/Application Support/Threadbear` or `~/Applications/Threadbear.app`. Never run `install-runner.sh`, `deploy-runner.sh` against the real home, or `tb restart` on it. Trials use `dev-runner.sh` and `dev-app.sh`, and screenshots `app/Tools/screenshots.sh`. Never run `app/install.sh`, `app/restart.sh`, `app/kill.sh`, `Tools/run-mock.sh` or `Tools/perf-run.sh`.
- Never touch Mike's real CLI installs: no npm install or update in the nvm global prefix, nothing in `~/.local/bin/claude`, `~/.local/bin/codex` or Claude's versions folder. CLI update code is tested only with temp prefixes and temp homes. Codex installs only ever go into a Threadbear home's `tools/codex/`, a temp one in tests and during the build.
- Never read or print `auth.json`, Keychain items, OAuth tokens or API keys. Existence checks and the named non-secret `config.toml` keys only.
- Real model runs:
  - Claude on claude-3 with `claude-haiku-5-5`;
  - Codex on gpt-6-luna at low effort, or gpt-6.1-sol only where a test needs it;
  - tiny prompts and temp folders;
  - at most 3 generated images in the whole job;
  - every Codex thread a test or check makes is deleted afterwards (`thread/delete`, or its rollout under `~/.codex/sessions` or `archived_sessions` and its `~/.codex/generated_images/<thread id>` folder), so it doesn't show in Codex Desktop or Agent Archive.
- Never kill a process you didn't start. T3 Code and the live runner run the same CLIs.
- Raw captures stay in gitignored `runner/.fixtures/`. Only sanitised fixtures go into git.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Only the Land step pushes.

## Decisions for Mike

**Decided on 27 Oct.** Mike answered the list again at 11:40, and those answers replace the earlier ones where they differ (3 and 4):

1. **Codex Desktop list.** Threadbear's Codex threads may show in Codex Desktop's list. Threadbear archives them in Codex when Mike archives or deletes them in Threadbear.
2. **Claude update channel:** `latest`.
3. **Codex turn footer: duration only.** Tokens go in "Copy debug info", not the footer (F, `RowRenderer.swift`). Claude's footer doesn't change.
4. **New threads start on the account with the most room**, not the last-used one. See "Picking an account for a new thread" below.
5. **`~/.local/bin/codex`** was deleted on 27 Oct at Mike's OK.
6. **claude-2** is labelled "Convex work only" in the account menu.
7. **Research leftovers** were deleted on 27 Oct: the probe's Codex thread and image, the Claude probe transcript and the `/tmp` scratch folders. Every spike thread was deleted too.
8. **Token Stats' daily Codex reinstall:** yes, change Token Stats to skip `npm install` when the installed version is already the latest. That's a separate job in the Token Stats repo, not part of this branch.

**Picking an account for a new thread** (decision 4). One rule, `pickAccount(accounts, lastUsedId)`, written once on each side: `runner/src/usage.ts` (D) and `ThreadbearCore/Threads/AccountUsageText.swift` (F), with the same tests.

- Room is the tighter of the 5-hour and weekly windows' `remainingPercent`; with only one window (Pro Lite), that one.
- Candidates are the accounts of the last-used account's provider, so a Claude habit stays on Claude and model and effort don't jump.
- Skip any account that's `blocked`, under 10% room, or has a note (today only claude-2, "Convex work only": it's for work and is never picked for him).
- Pick the most room. A tie, or an account with no usage known, goes to the last-used one. If every candidate is skipped, use the last-used one.
- The runner uses it for `threads.create` with no `accountId` (`tb new`, `create_thread`, schedules) and sends the result as `hello.defaults.accountId`, recomputed on each `accounts.updated` (C). The app uses its own copy for the composer's default when Mike hasn't picked one, so it follows `accounts.updated` without a round trip; the account chip still overrides it, and an explicit pick sticks for that draft only.

**Still open:**

1. **MCP servers in Codex threads.** With Mike's config, every open Codex thread starts all of his MCP and plugin servers: about 150 to 190 MB and 7 processes per thread, plus about 8.9k input tokens per turn. Claude threads load his MCP servers too, so the plan keeps them on. The alternatives: switch the heavy ones off per thread through `config` (for example `mcp_servers.agent-archive.enabled=false`, or plugin switches; untested), or a `codexArgs` setting he controls.

## Decisions

How the review's points and the spike results were handled, where this plan differs from what was suggested.

- **One app-server per live thread**, not one per account (spikes 4, 5 and 10). Sharing saved nothing on MCP servers, and released threads never unload, so a shared process would grow until recycled. Per-thread processes free everything on release, isolate crashes and need no retire step; the cost is the app-server's own 84 MB per live Codex thread.
- **`Account.models` instead of `models.list`.** `4e6c270` built the model list on accounts, pushed through `accounts.updated`. Codex uses the same `models()` call rather than a second mechanism with its own cache.
- **Messages during a Codex turn use `turn/steer`**, falling back to holding the message for the next `turn/start`. Both fit Mike's steering change without a Codex-specific rule in the runner.
- **`end()` closes stdin** instead of `thread/unsubscribe` and a wait for `thread/closed`, which never arrives.
- **Folder moves pass the new `cwd` on the next turn** (spike 10), instead of releasing and resuming.
- **Codex's own copies are the plan, not a question.** The review's other fix for Threadbear's own update flow is dropped:
  - holding starts during npm;
  - waiting for Codex threads to be quiet;
  - the foreign-process check;
  - the npm process-name check.

  With versioned folders that only Threadbear installs into, no install touches files a running process uses. `releaseIdle('codex')`, its rules and its tests stay, so sessions still move to the new version.
- **Codex `auto` updates stay on by default, behind the schema gate**, rather than defaulting to `notify`. The gate refuses any version that loses a method, item type or field we use. It also needs a separate install folder, which only the own-copies design gives.
- **"Always allow" for commands doesn't require "no unknown actions".** Codex classes every plain command as `unknown` (`touch b.txt` is one), so that rule would make "Always allow" useless. Instead a rule matches one plain argv with no shell operators, and never matches `writeStdin` or network requests.
- **Wrong-provider models are dropped with a note, not answered with `-32602`.** The installed app always sends a model on create and can't recover from an error.
- **Multi-file diffs use `diffs: [EditDiff]` per row**, not one synthetic row per file. Synthetic rows would split approvals from their rows. The cost is that an app that hasn't updated yet shows only the last file.
- **The 256 MB line guard drops the line and fails that one item** instead of treating the process as broken, so one oversized item never ends its thread's turn.
- **Corrections to the review:**
  - `js_repl` is `false` in Mike's `config.toml`, not on; `memories` and `chronicle` are on.
  - The "uncommitted edits" note was stale: main was clean at `4c9e00f` on 27 Oct.
