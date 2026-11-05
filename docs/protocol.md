# Runner protocol (v1)

The app and the runner talk JSON-RPC 2.0 over a WebSocket at
`ws://127.0.0.1:8797/rpc`. One JSON object per WebSocket text message.
Both sides must ignore unknown fields and unknown event types so either can be
upgraded first. Times are ISO 8601 strings in UTC. Ids are strings.

## Auth

The token is the contents of
`~/Library/Application Support/Threadbear/secrets/runner-token` (another
Mac's: the copy in `secrets/runners/<id>.token`, see Other runners). It
never travels: the client proves it has it, and the runner proves the same
back, so the client knows it reached the real runner before it trusts
anything it's told. Whoever holds the port while the runner is down (another
account on the Mac can bind 127.0.0.1:8797 then) learns nothing it can use.

1. The client connects with no `Authorization` header. The runner's first
   message is
   `{"jsonrpc":"2.0","method":"auth.challenge","params":{"version":1,"nonce":"<64 hex>","port":8797}}`:
   32 fresh random bytes for this connection, and the TCP port it listens on.
2. The client picks its own 32 random bytes and sends, as its first message,
   `{"jsonrpc":"2.0","id":1,"method":"auth.prove","params":{"nonce":"<client's 64 hex>","proof":"<64 hex>"}}`,
   where `proof` is HMAC-SHA256, keyed with the token's UTF-8 bytes, of
   `"threadbear-rpc-auth-v1 client\n" + runnerNonce + "\n" + clientNonce + "\n" + server + " " + port`
   (lowercase hex throughout). `server` is `primary` for the runner's main
   server, the one on its port that every client talks to, and `drain` for
   a draining runner's own (Handovers), which only a primary taking over
   from it means to reach. `port` is the one the client dialed when it
   dialed a loopback address, and the challenge's `port` otherwise (another
   Mac behind `tailscale serve`, where the dialed port is the proxy's).
3. The runner answers `{"result":{"proof":"<64 hex>"}}`: the same HMAC of
   `"threadbear-rpc-auth-v1 runner\n" + runnerNonce + "\n" + clientNonce + "\n" + server + " " + port`,
   with its own kind of server and its own listening port.
   The client checks it (constant time) before it sends or reads anything
   else, and closes the socket when it's wrong or missing.

The two strings differ so neither side's proof can be played back as the
other's, and each side's fresh nonce means an old proof is no good on a new
connection. A client never sends the token or a bearer header, not even to a
server that doesn't send a challenge: it closes instead and says the runner
didn't prove itself (an impostor could just as well pretend to be an old
runner).

The last line binds the proofs to the connection. Something holding the
runner's port while it's down could pass a challenge on from a real runner
on another port (a draining one, say) and pass the client's answer back;
without it, that would leave it holding a connection the runner had let in.
With it, the client's proof is for the port it dialed (or, on another Mac,
for a `primary`), and the runner on the other port, or a draining runner,
works out a different one and closes the socket. Nothing protects the
messages after auth beyond that (no encryption on loopback); the binding is
what keeps a relay from getting that far.

**Before the challenge (old clients).** A runner still takes the two ways
clients used to authenticate, so an app or `tb` older than the challenge
keeps working while it updates: `Authorization: Bearer <token>` on the
upgrade request (no challenge is then sent), or a first message
`{"jsonrpc":"2.0","id":1,"method":"auth","params":{"token":"..."}}`. Both
send the token itself, which is what the challenge is for; accepting them
leaks nothing by itself. They can go once nothing older than 5 Nov 2026
connects: Mike's Mac app restarted onto a build with the challenge, and
every release a runner might still hand over from (bruce's and the cloud
runner's included) newer than that. One exception in this release relies on
them: a new runner taking over from a draining runner whose `drain-<pid>.json`
has no `"auth": "challenge"` (one that predates it) connects to it with the
header, because that runner can't answer a challenge and the file, in the
runner's own data dir, says so; no server can talk a client into it. Even
then the header only goes over a connection whose other end, as `lsof`
sees it, is an open file of that pid, a process of the same user: the
draining runner closes its server before its drain file goes, so its port
can be someone else's while its pid lives on. Anything else counts as the
draining runner gone.

**Limits before auth.** Until a connection has authenticated, a frame is at
most 64 KiB (more closes it with 1009), there are 3 seconds to finish, and
anything but `auth.prove` or `auth` (a binary frame, bad JSON, a wrong
proof) closes it with 4401, cut off a second later if it doesn't answer the
close; a frame over the limit, or any other protocol error, is cut off at
once. At most 16 connections may be waiting to authenticate at once,
refused ones counting until they've gone; the next upgrade is turned away
with HTTP 503. An
upgrade with an `Authorization` header that's wrong is turned away with HTTP
401 before it becomes a WebSocket. Once authenticated, a frame can be up to
64 MiB (what the runner accepts; what it sends, like a big
`threads.events` page, has no such limit).

## Types

```ts
type Provider = "claude" | "codex"

type Account = {
  id: string            // "claude-main", "claude-1", "codex-main", "codex-1", ...
  provider: Provider
  title: string         // Claude: the email when known, else the id. Codex:
                        // "Codex · <email>", so an app that only reads title
                        // can tell it from a Claude login with the same address
  configDir: string
  defaultModel?: string // full id of the model a thread with no model runs on
                        // ("claude-fable-5-1"): the account's own setting
                        // (Codex: config.toml's model, else the model list's
                        // default), corrected by the first turn the runner
                        // sees. Absent until the runner knows
  models?: ModelChoice[] // what the account's CLI offers, in its own order,
                        // once the runner has asked it (a few seconds after
                        // it starts). Codex: its model list without hidden models
  defaultEffort?: EffortLevel // the account's own level (Codex: config.toml's
                        // model_reasoning_effort). Absent: each model's own
  email?: string        // the bare address, when known
  plan?: string         // "Max", "Team", "Pro Lite"
  note?: string         // Mike's own note for the account ("Convex work only")
  usage?: AccountUsage  // absent when nothing is known (and from older runners)
}

// "ultra" is Codex's multi-agent level. Claude never offers it.
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

type ModelChoice = {
  id: string            // what to send as `model` ("opus", "claude-fable-5-1[1m]", "gpt-6-luna")
  model: string         // the full id it runs as ("claude-opus-5-5")
  title: string         // "Opus 5.5"
  description?: string
  effortLevels?: EffortLevel[] // absent when the model takes no effort level
  defaultEffort?: EffortLevel  // the model's own level, when the CLI says (Codex)
}

type UsageWindow = {
  kind: "five_hour" | "weekly" | "weekly_model" | "daily" | "monthly" | "allowance" | "other"
  title: string         // "5-hour", "Weekly", "Weekly Fable", "$250 allowance"
  remainingPercent: number // 0 to 100, may be fractional
  resetsAt?: string
  detail?: string       // "$132.79 left"
}

type AccountUsage = {
  windows: UsageWindow[]
  readAt: string        // when the newest reading in it was taken
  source: "tokenStats" | "live" // where the newest reading came from: Token
                        // Stats' limits.json, or the account's own turns
  stale?: boolean       // Token Stats hasn't written for 15 minutes and
                        // there's no live reading since
  blocked?: boolean     // the provider says this login is at its limit
  notice?: string       // Token Stats' own note ("64,390 credits · 2 limit resets available")
}

type CliStatus = {
  provider: Provider
  path: string          // the binary new sessions start
  managedBy: "threadbear" | "cli" | "none" // Codex: Threadbear's own copies;
                        // Claude: its own installer; "none": codexPath set by
                        // hand, never updated
  installedVersion?: string // what new sessions start on
  latestVersion?: string
  status: "current" | "behind" | "held" | "unknown" | "missing"
  policy: "auto" | "notify" | "off"
  inUse: { version: string, threadIds: string[] }[] // versions live sessions run
  previousVersion?: string  // Codex: the kept version "Go back" returns to
  checkedAt?: string
  hold?: { version: string, reason: string, missing?: string[] } // why an
                        // update wasn't installed by itself ("the app-server
                        // protocol changed", with what it lost)
  update?: {            // the latest update, while it runs and after
    state: "waiting" | "running" | "succeeded" | "unchanged" | "failed"
    targetVersion?: string
    waitingFor?: string[]
    finishedAt?: string
    message?: string
  }
}

// A named, ordered list of logins (see Pools).
type Pool = {
  id: string            // "claude", "codex", "convex", or a slug Mike made
  title: string         // "Claude"
  accountIds: string[]  // in order; may mix providers
  folders?: string[]    // ~ allowed; a new thread under one starts on this pool
  icon?: string         // an SF Symbol name Mike picked ("leaf"); absent, the app picks one
  builtIn?: boolean     // from the code default, not runner.json
}

type ThreadStatus =
  | "idle"              // no turn running (CLI may or may not be live)
  | "starting"          // CLI spawning or resuming
  | "running"           // a turn is in progress
  | "waiting"           // blocked on an approval or a question
  | "error"             // last turn failed; can still send
  | "stopped"           // runner restarted mid-turn

type ThreadSummary = {
  id: string
  title: string
  cwd: string
  accountId: string     // the login it runs on now (a pool thread's can change; see Pools)
  poolId?: string       // the pool that picks its login. Absent: pinned to accountId
  waitingForRoom?: { until: string, accountId?: string } // every login in its
                        // pool is out of room; it carries on by itself at
                        // `until`. accountId: the login it's waiting on
  waitingForNetwork?: { since: string } // its last turn couldn't reach the
                        // API; it carries on by itself once the runner
                        // reaches it again (Pools, "A turn that lost the
                        // network"). since: when the line first went
  provider: Provider    // always the account's provider
  model?: string        // undefined means the account's default
  effort?: EffortLevel  // undefined means the model's own level
  modelInUse?: string   // full id the CLI ran the last turn on, once one has run
  effortInUse?: EffortLevel // the level the CLI reported for the last turn
  permissionMode: "full" | "ask"
  status: ThreadStatus
  live: boolean         // a CLI process is attached right now
  needsYou: boolean     // waiting, or a turn finished after lastSeenSeq
                        // that didn't end with needs "nothing", with no
                        // sub-agents still working (Needs you)
  needs?: "you" | "nothing" // what the last completed turn said; absent
                        // when it said neither (see Needs you)
  asks?: OpenAsk[]      // that turn's asks, when needs is "you"
  asksSeq?: number      // seq of the turn.completed they came with
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  snoozedUntil?: string
  snoozedUntilRestart?: true // hibernating until the runner next starts;
                        // snoozedUntil is then 9999-12-31T00:00:00.000Z
  wakeWhen?: { said: string, topic?: string, pending?: true }
                        // hibernated in Mike's words (Hibernate in words);
                        // only while snoozedUntil is set
  waitingOn?: { threadId, title, until?, done?: true }[] // hibernating until these
                        // threads finish (end_turn's waitFor); only
                        // while snoozedUntil is set
  startedBy?: { kind, label, icon?, threadId?, threadTitle?, why? } // who
                        // started it when Mike didn't (Who started a thread)
  asked?: string        // Mike's last message to it, one line, <= 140 chars
                        // (What Mike last asked)
  woke?: { at: string, since?: string } // came back from hibernating by
                        // itself (its time, a restart, a topic) at `at`,
                        // put away at `since` when known; only until Mike
                        // looks (threads.markSeen) or sends to it. The wake
                        // also adds a system.note ("Woke up after
                        // hibernating for a day.") Mirrored to the phone's
                        // row from backend API 13
  archivedAt?: string
  archivedBy?: "mike" | "agent" | "threadbear" // who archived it; only
                        // while archivedAt is set (Who archived a thread)
  archiveVerdict?: "worked" | "didntWork" | "notNeeded" // how it went, Mike's
                        // pick from the done card's Archive menu
  starredAt?: string    // Mike starred it, at this time: it stays in the
                        // Starred section above the Inbox, hibernating or
                        // not, oldest star first. Kept while archived, when
                        // it's under Archived, so bringing it back stars it
  onOldRunner?: true    // finishing a turn on the runner that handed over
                        // (Handovers); moves across when the turn ends
  preview: string       // last assistant text, one line, <= 140 chars
  lastSeq: number       // seq of the newest persisted event
  lastSeenSeq: number
  nativeSessionId?: string
  contextTokens?: number
  contextWindow?: number // the model's context window, when the CLI reports it
  costUsd?: number      // total for the thread so far, if known (Codex reports none)
  panels?: Panel[]      // from the folder's patches (see Patches); absent when there are none
  actions?: Action[]    // likewise
  hooks?: Hook[]        // likewise
  patches?: PatchInfo[] // the patches that apply to the folder; absent when there are none
  background?: BackgroundTask[] // what the live CLI is still running in
                        // the background: sub-agents and shell jobs
                        // started with run_in_background, Monitor and the
                        // like, and ones just finished whose result the
                        // agent hasn't read yet. Absent when there's none.
                        // Set during a turn too; between turns it's the
                        // sign the thread is still being worked on
  subagents?: Subagent[] // the sub-agents the agent has started, foreground
                        // and background: the newest 20, oldest first.
                        // Absent when it has started none
  projects?: ThreadProject[] // the projects the thread is in (see Projects),
                        // oldest first. Absent when it's in none
  highlightsAt?: string // when its highlights last changed other than by a
                        // new event: a pin, a removal, the librarian's
                        // brief (see Highlights). A client fetches
                        // threads.highlights again when this or lastSeq moves
  sample?: true         // one of the tour's sample threads (threads.samples):
                        // made up, and threads.send refuses it
  worktree?: ThreadWorktree // the thread has a git worktree of its own
                        // (see Worktrees). Absent when it doesn't, or once
                        // it was removed
  schedule?: { id: string, title: string } // the schedule that started the
                        // thread (see Schedules), with its title as it was
                        // then. Absent for one a person or agent started
  panelRequest?: PanelRequest // a panel the agent asked to show Mike,
                        // waiting for him to look at the thread (see
                        // Showing panels). Absent when there's none
  share?: ThreadShare   // who else can read it on the website (see
                        // Sharing). Absent until it's first shared
}

// A thread's own worktree, as its summary shows it (see Worktrees).
type ThreadWorktree = {
  branch: string        // "thread/ab12cd34"
  mainCheckout: string  // the checkout with main checked out, where it lands
  path: string          // the worktree's root folder
}

// A project a thread is in, as its summary shows it.
type ThreadProject = {
  id: string
  title: string
  by: "mike" | "agent" | "librarian" // who put it there
  pinned?: boolean      // Mike put it there (or an agent was told to): the
                        // librarian won't take it out
  at: string            // when it was put there
  why?: string          // why it's there, a short line: the librarian's
                        // reason ("Shortlists photos for the calendar
                        // entry"), newest look's wins. Highlights shows it
                        // behind the project's ⓘ
}

type Action = {
  id: string            // "<patch>.<slug of the title>": "reseed.reseed-dev-db"
  title: string
  kind: "command" | "prompt" | "url"
  command?: string      // kind "command": run by `actions.run`, in `folder`
  prompt?: string       // kind "prompt": sent to the thread as a message by `actions.run`
  url?: string          // kind "url": an http or https page (normalised). The
                        // client opens it itself, on the device it was pressed
                        // on: no RPC, nothing in the transcript. The phone
                        // gets these through Sync (`links`) An older
                        // client reads the unknown kind as a command and
                        // calls `actions.run`, which opens it on the runner's
                        // Mac and answers `{ ok: true, durationMs }`
  patch: string
  folder?: string       // where the command runs: the project folder the
                        // patch came from. Absent: the thread's own folder
  projectId?: string    // the project whose folder gave it (see Projects)
  note?: string
  icon?: string         // an SF Symbol for the chip: the action's own `icon`,
                        // else its patch file's; absent: the client's default
  badge?: number        // see Patches, "Live state"
}

type Hook = {
  id: string            // "<patch>.<slug of the title>"
  title: string
  on: "turn.end"        // when it runs: after a turn the agent completed (not one it was interrupted in, or failed)
  command: string       // run in `folder`, as an action's command is
  exec?: string         // for a patch trusted by its hash: what the runner
                        // really runs, `command`'s script by absolute path
                        // (see "Trusting a folder's patches"); show `command`
  edited?: string       // only after a turn that edited a file matching this glob, relative to `folder` ("**/*.ts")
  tell: "failures" | "always" | "never"  // when its result is sent to the agent as a message (see Patches)
  patch: string
  folder?: string       // as Action's; a hook from a project folder only
                        // sees edits inside that folder
  projectId?: string
  note?: string
}

type PatchInfo = {
  id: string            // "convex", "xcode", or a patch file's name without its extension
  source: "builtin" | "home" | "project" | "claude" // claude: the thread
                        // folder's Claude Code settings, listed only while
                        // they're waiting (see "Trusting a folder's Claude
                        // Code hooks"); a client that doesn't know it shows
                        // it as a project's
  file?: string         // the module, for home and project patches
  folder?: string       // set (with projectId) when it came from one of
                        // the thread's projects' folders rather than its
                        // own: the folder holding `.threadbear/`, or a
                        // built-in's project folder
  projectId?: string
  error?: string        // the file couldn't be loaded, and gives nothing until it's fixed
  untrusted?: "new" | "changed" // a project's patch file that isn't trusted yet, so
                        // wasn't loaded and gives nothing: "new" when nothing
                        // from its folder is trusted, "changed" when an earlier
                        // version was (see "Trusting a folder's patches")
  hash?: string         // with untrusted: the version patches.trust would trust
  helpers?: string[]    // with untrusted: the local files it imports or names
                        // (absolute), whose text the hash covers too
}

type Panel = {
  id: string            // unique within the thread: "convex.dashboard", "xcode.simulator"
  title: string         // the tab's label
  kind: "url" | "image" | "list" // a page in a web view, a picture the runner
                        // draws on request, or rows the runner gets from the
                        // patch on request (see Patches)
  url?: string          // kind "url": the page; also what Open in browser opens
  icon?: string         // an SF Symbol name for its button on the right-hand
                        // rail; absent: the client picks one by kind
  patch: string         // the patch it came from: "convex", "xcode"
  projectId?: string    // as Action's
  note?: string         // one line about it: the deployment, the project
  convex?: {            // the built-in Convex panel for a cloud deployment:
    deployment: string  // its name, "happy-otter-123"
    deploymentUrl: string // "https://happy-otter-123.convex.cloud": only
                        // ever the deployment's own <name>[.<region>].convex.cloud,
                        // as it's handed a deploy key and comes from an env
                        // file a cloned repo writes; any other URL, a custom
                        // domain included, gets no `convex`
    team?: string       // "mike" and "walkies": what `convex dev` notes
    project?: string    // after CONVEX_DEPLOYMENT in .env.local, if it did
  }                     // a client that knows it shows Convex's embedded
                        // dashboard with panels.convexKey (see "The Convex
                        // panel"); one that doesn't shows `url`
}

// One row of a `list` panel (panels.render).
type PanelItem = {
  title: string
  detail?: string       // grey, under the title, up to two lines
  url?: string          // a click opens it in the browser, or the panel if Mike set "Default"
  path?: string         // a click previews the file in the pane
  icon?: string         // an SF Symbol name
  tone?: "attention" | "failed" | "done" // orange, red or a tick; absent: plain
  section?: string      // a heading over this row and the ones after it with the same
                        // section, drawn where it changes ("Waiting · 1"); at most 80 characters
  trailing?: string     // short and faint at the end of the title's line, like a date
                        // ("5d"); at most 24 characters
}

// A grouping above folders that carries goals, state and notes forward
// (see Projects).
type Project = {
  id: string            // "p_" and 8 hex characters
  title: string
  folders: string[]     // absolute paths, in the order patches load from them
  goals: string         // a few lines: what it's for, what done looks like
  state: string         // a few lines: where it's up to, what's next
  notes: string         // markdown: decisions, gotchas, commands, links
  links: ProjectLink[]  // the places Mike goes for it, at most 8 (see
                        // Projects, "Links"); [] from a runner before them
  createdBy: "mike" | "agent" | "librarian"
  createdByThread?: string // the thread whose agent or look made it
  titleBy?: "mike" | "agent" | "librarian" // who last named it; absent
                        // on older projects, where createdBy stands in
  createdAt: string
  updatedAt: string
  stateUpdatedAt?: string
  archived?: boolean
  icon?: ProjectIcon    // absent until the librarian has found or picked one
  threadCount: number   // threads in it, put away ones included
  lastActivityAt?: string // its newest thread's lastActivityAt
}

// A place Mike keeps going back to for a project: its live site, admin
// page, dashboard, store listing or repo.
type ProjectLink = {
  title: string         // short: "Live site", "Admin"; the host when not given
  url: string           // http or https
}

// A project's icon: a picture, else an SF Symbol (see Projects, "Icons").
// A client that can't draw either shows the title's first letter.
type ProjectIcon = {
  image?: ImageRef      // a copy in the runner's data dir (project-icons/),
                        // PNG at most 256 px, or SVG ("image/svg+xml")
  symbol?: string       // an SF Symbol name, when there's no picture
  from?: string         // the file the picture was copied from
  by: "mike" | "agent" | "librarian" // librarian: found by itself and kept
                        // up to date; mike or agent: chosen, and left alone
                        // until set back to automatic
  updatedAt: string
}

// What the librarian (see Projects) is doing, has done and will do next.
type LibrarianStatus = {
  state: "idle" | "working" | "paused" | "off"
  reason?: string       // state "off": why ("Needs a Claude pool to run
                        // on", "Every login in Claude is out of room",
                        // "Model calls are off")
  paused: boolean       // Mike paused it; looks wait in the queue
  current?: LibrarianJob & { startedAt: string } // the look under way
  queue: LibrarianJob[] // what it will look at next, soonest first
  recent: LibrarianEntry[] // what it did, newest first, the last 50
  looksToday: number
  spentTodayUsd: number // always 0 (it runs on the pool); kept for older apps
  skippedToday?: number // quiet catch-ups skipped without a model call
  tokensToday?: number  // tokens in and out, every look and icon pick
  notionalTodayUsd?: number // what the pool's calls would have cost on
                        // the API; they use logins' room, not money
}

type LibrarianReason =
  | "first-message"     // a new thread's first message came in
  | "first-turn"        // a thread's first turn ended
  | "new-folder"        // a turn edited files outside the thread's projects' folders
  | "moved"             // the thread changed folder
  | "catch-up"          // more turns since its last look (at most hourly)
  | "asked"             // librarian.run, or a backfill
  | "notes"             // a project's notes went past 12,000 characters and
                        // were rewritten shorter (an entry only: threadId is
                        // "", projectIds has the project; the old notes are
                        // kept in <data dir>/project-notes, the last 5 each)

type LibrarianJob = {
  threadId: string
  threadTitle: string
  reason: LibrarianReason
  why: string           // the reason in words: "Edited files in ~/dev/me/poddle"
  dueAt: string
}

type LibrarianEntry = {
  id: string
  at: string
  threadId: string
  threadTitle: string
  reason: LibrarianReason
  outcome: "joined" | "created" | "updated" | "left" | "nothing" | "skipped" | "failed"
  text: string          // "Put it in Threadbear", "Made Poddle and put it there",
                        // "Threadbear's state", "No key", the model's error
  projectIds?: string[]
  costUsd?: number
}


// A sub-agent the thread's agent started (Claude's Agent tool). The runner
// follows it from the CLI's task events, so it changes while it runs: each
// change sends thread.updated. `threads.subagent` reads what it did.
type Subagent = {
  id: string            // the CLI's id for it (its task id)
  itemId?: string       // the tool.call that started it, in the thread
  parentId?: string     // the sub-agent that started this one, when it was
                        // started by a sub-agent rather than the thread's agent
  description: string   // its brief's title: "Review the runner changes"
  agentType?: string    // "general-purpose", "Explore", "fork"
  status: "running" | "completed" | "failed" | "stopped"
                        // clients treat a status they don't know as stopped
  background: boolean   // the agent carried on while it ran
  activity?: string     // while running, what it's doing in the CLI's own
                        // words ("Running npm test")
  summary?: string      // once finished, what it reported, one line, <= 200 chars
  toolUses?: number     // tool calls so far
  startedAt: string
  endedAt?: string      // set once it's no longer running
}

type BackgroundTask = {
  kind: "agent" | "shell" | "monitor" | "other" // a sub-agent, a shell
                        // command, a Monitor, or anything else the CLI
                        // runs in the background (a workflow). Clients
                        // treat a kind they don't know as "other"
  description: string   // the CLI's own words: the sub-agent's brief, the
                        // command. May be empty
  finished?: boolean    // true once it has finished and the agent is about
                        // to start a turn of its own to read its result
                        // (the runner counts it for up to 15 s, until that
                        // turn starts)
}

type ImageRef = {
  path: string          // absolute path on this Mac
  mediaType: string     // "image/png", "image/jpeg", "image/gif", "image/webp"
  width?: number
  height?: number
}

type Schedule = {
  id: string
  title: string         // for lists; default the first line of text
  text: string          // the message it sends each time
  at?: string           // a one-off: when it runs
  cron?: string         // or repeating: a 5-field cron ("0 9 * * 1-5"), or
                        // @hourly, @daily, @weekly, @monthly, @yearly
  timezone?: string     // IANA zone the cron is read in; absent means the
                        // Mac's own zone, whatever it is at the time
  whenText: string      // "Weekdays at 9:00", "Once, Tue 28 Oct at 15:30":
                        // the runner's words for at/cron, for every client
  threadId?: string     // sends to this thread. Absent: starts a new thread
                        // each time, with the settings below
  cwd?: string          // new-thread settings, as in threads.create
  accountId?: string    // pins each thread to this login
  poolId?: string       // or this pool picks the login each run (see
                        // Pools); never both. Neither: the folder's pool,
                        // as threads.create picks it
  model?: string
  effort?: EffortLevel
  permissionMode?: "full" | "ask"
  paused: boolean
  createdAt: string
  updatedAt: string
  createdBy?: string    // the thread whose agent made it; absent for a person
  nextRunAt?: string    // absent while paused, or once a one-off has run
  finishedAt?: string   // a one-off that has run (kept for 7 days, then dropped)
  runs: number          // how many times it has sent its message
  lastRun?: {
    at: string
    outcome: "sent" | "skipped" | "failed"
    threadId?: string   // the thread it sent to or started
    note?: string       // why it was skipped or failed
  }
  runnerId?: string     // the runner it runs on (see Schedules, "Runners").
                        // Absent from a runner whose schedules are its own
                        // file: then it's that runner
  runnerName?: string   // that runner's name, as runners.list has it
  runnerIcon?: string   // and its icon (RunnerInfo.icon)
  runRequestedAt?: string // a schedules.run for it waits for its runner
}

// A runner Threadbear knows of, from the backend (runners.list).
type RunnerInfo = {
  id: string
  name: string          // "m5", "bruce": the Mac's hostname by default
  icon?: string         // an SF Symbol for its Mac: "laptopcomputer",
                        // "macmini", "macstudio", "macpro.gen3" or
                        // "desktopcomputer", from the model macOS names
                        // (runner/src/machine.ts), or sync.icon in
                        // runner.json. Absent from a runner before icons;
                        // a client draws a symbol it lacks as the desktop
  online: boolean       // heard from in the last 3 minutes
  lastSeenAt?: string
  self: boolean         // the runner answering
  // What its last heartbeat said, for the app's Runners panel. Absent from
  // an older runner.
  version?: string      // RUNNER_VERSION
  release?: string      // the release it runs (release.ts), when it runs one
  startedAt?: string    // when that runner process started
  draining?: boolean    // an old release finishing its threads in a handover
}

// The runner's settings, as the Settings window shows them. Everything here
// is kept in runner.json except the key, which only the runner ever reads.
type Settings = {
  defaultCwd: string    // where a new thread starts when it names no folder
  idleMinutes: number   // a CLI with no turn for this long is released
  maxLiveCLIs: number   // most CLIs kept live at once
  followMain: boolean   // build and restart onto main by itself; a change
                        // takes effect when the runner next restarts
  bulletReplies: boolean // a turn's reply is end_turn's bullets; false: the
                        // agent's own message (see "The summary")
  oneReply: boolean     // end_turn first, then the agent's message as the
                        // reply (see "Needs you", One reply); on by default
  models: {
    pool: string | null      // the pool whose Claude logins answer small
                             // jobs; "claude" by default, null: none, so
                             // no titles or librarian
    privateFolders: string[] // folders (and everything under them) whose
                             // text is never sent; "~/" paths as written
  }
}
```

## Events

### Design reviews

`show_options` gives the calling thread a durable image review. It returns
promptly, with the review's id and the `review:<id>` link that opens it
from an ask or a message (see Needs you); the agent may finish its turn
while Mike reviews the options.
The app shows a compact card outside work groups. Opening it opens a
resizable, modeless window that steps through every shot of every option,
then shows the options side by side, with the options to tick, one reply
box and Send down the right; arrival never steals focus.

An option can have several shots (its overview, a state mid-interaction, a
detail) and a live `url`. Agents used to pass extra shots as options of
their own (A2, A3) that couldn't be picked; Mike also picked more than one
or none, and answered most reviews in the thread in his own words (4 Nov
2026), hence several picks, `none` and `reply`.

```ts
// pickedIds lists every pick in the review's option order, only when there
// are two or more; pickedId is always the first pick, for older clients.
// Clients send pickedIds (it wins over pickedId); a client that sends only
// pickedId still works. none: none of them will do, never with picks.
type ReviewDraft = { pickedId?: string, pickedIds?: string[], notes: Record<string, string>, reply?: string, none?: true }
type ReviewShot = { title?: string, image: ImageRef }
type DesignReview = {
  id: string
  title: string
  note?: string
  options: {
    id: string          // stable within this review
    title: string
    note?: string
    reference?: boolean // can have notes, cannot be picked
    image: ImageRef     // the first shot: a copy owned by the thread, never the source path
    shots?: ReviewShot[] // every shot in order, image first; only when more than one or the one has a title
    url?: string        // http(s): where it runs live
  }[]
  status: "pending" | "answered" | "cancelled" | "superseded"
  revision: number     // optimistic concurrency for saves and submission
  createdAt: string
  updatedAt: string
  draft: ReviewDraft
  response?: ReviewDraft
  replyTurnId?: string
}
```

The following RPCs take full thread/review IDs. Unknown IDs are errors.

| method | params | result |
|---|---|---|
| `reviews.create` | `{ threadId, title, note?, options: { id, title, path?, shots?: { path, title? }[], url?, note?, reference? }[] }` | `{ review: DesignReview }` |
| `reviews.get` | `{ threadId, reviewId }` | `{ review: DesignReview }` |
| `reviews.list` | `{ threadId }` | `{ reviews: DesignReview[] }` pending reviews only, oldest first |
| `reviews.save` | `{ threadId, reviewId, revision, draft: ReviewDraft }` | `{ review: DesignReview }` |
| `reviews.respond` | `{ threadId, reviewId, revision, draft: ReviewDraft }` | `{ review: DesignReview, turnId?: string }` |
| `reviews.cancel` | `{ threadId, reviewId, revision }` | `{ review: DesignReview }` |

Creation validates the whole request and imports supported image files
before publishing the card. Paths can be absolute, home-relative or
relative to the thread's folder. An option's shots are `path` then
`shots`, or `shots` alone; it needs at least one. Limit: 12 options, 8
shots each and 40 in all, each image at most 25 MB, nonempty unique option
IDs and titles, title/note at most 200/4000 characters, `url` http or https.
Draft notes are at most 4000 characters per option and the reply 8000;
unknown option IDs, picks of reference options and `none` with picks are
invalid. A response needs a pick, `none`, a reply or a nonblank note.
Saving an empty draft is allowed. The agent's message reads `Picked A.
<title>.` or `Picked A + D. <title> + <title>.`, or `Picked none of them.`,
then the reply as written, then any notes; the Mac and phone read that
wording back for Mike's bubble (`ReviewAnswer`), so change them with it.

Every change persists a `review.updated` event with `{ review: DesignReview }`.
Its stable card ID is the review ID; later snapshots update that card in
place even when the original event is outside the loaded transcript page.
`ThreadSummary.pendingReviews?: number` counts pending reviews and makes
`needsYou` true even after mark-read, turn-end and runner restart. It does
not hold a CLI open or prevent an update. Cancelling closes the request
without sending an agent message. A message from Mike in the thread
(from the app or the phone, not one sent by the runner, a schedule or
another thread's agent) supersedes every pending review there: he often
answers in the thread instead of the window. Each becomes `superseded`,
read-only like a cancelled one, with no agent message. Closing a window only keeps the draft.
The thread header can open pending reviews from `reviews.list`, including
requests older than the transcript's loaded event page; Mike does not need
to scroll back through earlier turns to find what still needs an answer.

Save and submit reject a stale revision with `-32602`; the client reloads
and preserves its unsaved text for retry. Answered/cancelled reviews are
read-only. Retrying an identical response to an answered review returns
the original result and never sends twice; a different response is an
error. The runner durably queues the submitted reply with its review ID
and structured response, alongside readable text naming the review and
each option. An idle agent resumes; a busy one receives it after its turn.
The queue survives restart. The response and queue are persisted together
before acknowledging submission. `user.message` may include `reviewId`
and `reviewResponse: ReviewDraft`; these identify the review that prompted
the reply. The same fields accompany queued replies on disk.

An internal delivery marker is saved after the CLI's `session.send` accepts
the reply. A crash between that call and the marker may replay the reply
after restart (at-least-once dispatch). Repeated `reviews.respond` requests
with the same response never add another reply.

Both Claude and Codex receive `threadbear.show_options` through the shared
MCP tool definitions, bound to the calling thread. Its schema matches
`reviews.create` without `threadId`; it returns the review ID and explains
that the choice/notes will arrive as a later message. The existing URL
patch panels are independent of these review windows. Reviews take
images, with a live `url` per option opened in the browser; HTML previews
and overlays are deferred.

Every persisted event has an envelope:

```ts
type Event = {
  seq: number           // 1, 2, 3 ... per thread, no gaps among persisted events
  ts: string
  threadId: string
  turnId?: string
  type: string
  // ...type-specific fields below
}
```

Persisted event types (stored in `events.ndjson`, returned by `threads.events`):

| type | fields |
|---|---|
| `user.message` | `text`, `images: ImageRef[]`, `answers?: AskAnswer[]` (the open card's asks it answers, as `threads.send` gave them: for showing, the agent only gets `text`), `origin?: "runner" \| "schedule" \| "phone"` (`runner` when the runner sent the message by itself, such as the resume after a restart; `schedule` when a schedule sent it, with `scheduleId`; `phone` when it came from the phone through the Convex mirror (Sync), and the agent then gets it after a line saying so and whether the user is at the Mac, though `text` keeps what was typed; absent for anything a person or client sent), `scheduleId?`, `editOf?: number` (the seq of the message this one replaced, see Editing a message) |
| `assistant.text` | `itemId`, `text` (complete markdown for that block), `summary?: true` (the turn's summary, written by the runner from `end_turn`; see "Needs you"), `givesWay?: true` (on a summary, with bullet replies off: see "The summary"), `narration?: true` (Claude sent this as a narration block, whose text reaches the runner only as a short summary of what the agent wrote, not its words: see Transient events), `final?: true` (with one reply, the agent's message after `end_turn`, the turn's reply: see "Needs you", One reply). A later `assistant.text` with the same `itemId` replaces the earlier one where it stands |
| `reasoning` | `itemId`, `text` (summary) |
| `tool.call` | `itemId`, `name` (raw tool name), `kind` (`command` \| `read` \| `edit` \| `write` \| `search` \| `web` \| `mcp` \| `task` \| `todo` \| `image` \| `other`; `image` is image generation), `title` (one line, e.g. "npm test" or "Edit src/a.ts"), `input` (object, large strings truncated to 16 KB) |
| `tool.result` | `itemId` (matches the call), `ok`, `text` (truncated to 64 KB), `truncated`, `blobPath?`, `images: ImageRef[]` |
| `edit.diff` | `itemId`, `path`, `hunks: {oldStart, oldLines, newStart, newLines, lines: string[]}[]` (lines start with " ", "-" or "+"); sent after `tool.call` for Edit/MultiEdit/Write when the runner can compute it. One event per file: a tool that changes several files (a Codex patch) has one per path. A later `edit.diff` with the same `itemId` and `path` replaces that file's diff; a new path adds one |
| `approval.requested` | `approvalId`, `itemId?` (absent for a subagent's tools, which have no `tool.call`), `name`, `title`, `input`, `options: ("allow" \| "allowAlways" \| "deny")[]` |
| `question.requested` | `approvalId`, `questions: {question, header?, multiSelect, options: {label, description?}[]}[]` |
| `secret.requested` | `approvalId`, `itemId?`, `label`, `reason`, `placeholder?`: an agent's `ask_secret` (Secrets). Answered with `secrets.answer`, never `approvals.respond` |
| `approval.resolved` | `approvalId`, `decision` (`allow` \| `allowAlways` \| `deny` \| `answered` \| `expired`), `message?` |
| `plan.updated` | `entries: {text, status: "pending" \| "in_progress" \| "completed"}[]` |
| `turn.started` | `turnId`, `wokeBy?: {kind, description}[]`. A turn the agent starts by itself (a background task finished, or a background subagent needs an approval) has no `user.message` before it. `wokeBy` is on such a turn when background work finishing started it: each task that had finished since the last turn, `kind` as in `BackgroundTask` (`agent` \| `shell` \| `monitor` \| `other`), its `description` possibly empty. Clients mark the time between that turn and the one before it in the transcript (a "6 min later" divider, Mike 3 Nov). A `user.message` after `turn.started` was sent while the turn ran and went into it |
| `turn.completed` | `turnId`, `outcome` (`completed` \| `interrupted` \| `failed`), `durationMs`, `costUsd?` (Codex turns have none), `usage?` (Claude: `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`; Codex: `{inputTokens, cachedInputTokens, cacheWriteTokens?, outputTokens, reasoningTokens}`), `error?`, `errorKind?` (`usageLimit` \| `contextWindow` \| `auth` \| `network`, when a failed turn's cause is known, so a client can offer the fix without reading `error`), `needs?` (`you` \| `nothing`), `asks?: Ask[]`, `next?: string[]` (with `nothing`: suggested follow-ups), `needsFrom?` (`tool` \| `text`): what a completed turn said it needs from Mike (Needs you) |
| `asks.ticked` | `asksSeq`, `ticked: number[]` (indexes into that turn's `asks`, the whole set now ticked). Outside any turn. The latest one for an `asksSeq` is that card's ticks |
| `system.note` | `text` (e.g. "Resumed session", "Compacted the conversation", "Patch reseed added: action Reseed dev DB.") |
| `error` | `message` |
| `action.run` | `actionId`, `patch`, `title`, `command`, `ok`, `exitCode?`, `text` (what it printed, truncated to 64 KB), `truncated`, `durationMs`, `trigger?` (`"turn.end"` when a hook ran it, `"worktree.setup"` for a new worktree's `setup` (see Worktrees); absent for a chip or `tb run`). A command that `actions.run` or a hook ran; outside any turn unless one was running, in which case it carries that `turnId` |
| `thread.rewound` | `fromSeq`, `toSeq`, `files: { undone: string[], failed: { path, reason }[], how: "checkpoint" \| "diffs" \| "none" }`. Mike edited the message at `fromSeq` (see Editing a message): every event from `fromSeq` to `toSeq` (inclusive, always this event's `seq` - 1) is gone from the conversation, and clients hide them. Outside any turn. The edited message comes next, as a `user.message` with `editOf: fromSeq` |

Transient events are only sent to subscribers, never persisted, and carry
`seq` of the last persisted event (they don't consume a number):

| type | fields |
|---|---|
| `assistant.text.delta` | `itemId`, `text` (append) |
| `reasoning.delta` | `itemId`, `text` (append) |
| `tool.output.delta` | `itemId`, `text` (append, for long-running commands if available) |

When an item completes, its persisted event (`assistant.text`, `reasoning`)
replaces whatever the deltas built up. That can be of the other kind: Claude
at times sends its reply as a thinking block signed as narration, which
streams as `reasoning.delta` and lands as `assistant.text` with the same
`itemId` (it is the reply, so end_turn counts it). A client lets the text
take the streaming reasoning row's place.

A narration block's text is not the agent's words: with summarised
thinking (the only kind the CLI offers besides none) the API sends a
short summary of it, in the agent's voice ("I've laid out the full
setup steps..."), and the words themselves never reach the runner. On
29 Oct 2026 a numbered walkthrough reached Mike as one such paragraph,
twice (thread 66935d23). So that event carries `narration: true`. An
`end_turn` with no summary bullets, whose turn replied only in
narration, is accepted, and its
result asks for the whole message again as ordinary text with nothing
after it (a text block followed by no tool call is never narration);
the runner keeps that text, which it otherwise drops after an accepted
`end_turn`, and persists it with the summary's `itemId` and no
`narration`, so it takes the summary's place. Readers that list a
thread's messages keep only the last `assistant.text` of an `itemId`.
The Convex mirror keys messages by seq, so the phone and website show
the summary and then the reply.

## Requests (app to runner)

| method | params | result |
|---|---|---|
| `hello` | `{ client: string, version: string, build?: { commit, short, tree } }` (`build`: the Mac app's own build, see App restarts) | `{ runnerVersion, protocol: 1, accounts: Account[], pools?: Pool[], defaults: { cwd, accountId, poolId?, model?, models?: { claude?, codex? }, efforts?: { claude?: EffortLevel, codex?: EffortLevel } }, clis?: CliStatus[], updates?: RunnerUpdates }`. `updates` is under Runner updates; `pools` and `defaults.poolId` under Pools. `defaults.accountId` is the account a `threads.create` with no `accountId` uses: the one with the most room among the last-used account's provider (skipping blocked ones, ones under 10% and ones with a note), worked out again as usage changes; a client keeps its own copy of the rule rather than asking again. `defaults.models[provider]` is the model a new thread on that provider gets when it names none (`runner.json`'s `defaults.models`; a dev runner sets the cheapest); `defaults.model` is the same for Claude, kept for older apps. Absent means the account's own default (`accounts[].defaultModel` names it, when known). `defaults.efforts[provider]` likewise for effort; absent means the model's own level. `runnerVersion` is `<package version>+<release id>` when the runner runs from a release, else `<package version>+source` |
| `threads.list` | `{ include?: ("inbox" \| "snoozed" \| "archived")[] }` (default `["inbox"]`) | `{ threads: ThreadSummary[] }` newest activity first |
| `threads.search` | `{ query: string, limit?: number }` | `{ threads: ThreadSummary[] }` matches title and preview across all threads, archived included |
| `threads.create` | `{ text: string, images?: ImageRef[], cwd?: string, accountId?: string, poolId?: string, model?: string, effort?: EffortLevel, permissionMode?: "full" \| "ask", title?: string, worktree?: boolean, startedBy?: { kind, label, icon?, threadId?, why? } }` | `{ thread: ThreadSummary }` (the first turn starts straight away). In a repo that asks for worktrees (see Worktrees) the thread gets one of its own before its first turn; `worktree: false` starts it in the folder as it is. The thread's `provider` is its account's. With no `model`, the thread gets `defaults.models[provider]` from `hello`, or `defaults.model` for Claude, or else the account's own default. With no `effort`, `defaults.efforts[provider]`, or else the model's own level. See "Models and effort across providers" |
| `threads.samples` | `{ cwd: string, remove?: boolean }` | `{ threads: ThreadSummary[] }`. The app's first-run tour's sample threads (`runner/src/samples.ts`): made up exchanges written as finished turns with no CLI, in `cwd` (the app's `~/ThreadbearThreads/Welcome`, where it writes an example patch), with `sample: true`; the first needs you, with a card of asks, and one is left unread. Asking again deletes any there are and makes them afresh (writing the patch again if it's gone, and trusting it as written). `remove: true` deletes them all, archived and hibernating ones too, and returns none. `threads.send` to a sample is `-32602` |
| `threads.send` | `{ threadId, text, images?: ImageRef[], answers?: AskAnswer[], origin?: "phone" }` | `{ turnId }`. `text` can place the `images` among its words with `[Picture N]` markers (Pictures in a message). `origin: "phone"` is only for a phone command the primary passes on to a draining runner (Sync, "Commands"), so the message keeps its origin there; any other `origin` is `-32602`. If a turn is running and its CLI is live, the message goes into that turn straight away (a `user.message` under the running `turnId`, which is returned): the agent takes it at its next step, or right after its reply if that was already finishing, and the turn doesn't complete until it has been answered. If the thread was moved to another login (usually another provider) during the running turn, a message from Mike (or the phone) doesn't steer into the old CLI: the turn is stopped (`system.note` "Stopped here so <model> can take over.") and the message starts the next turn on the new login, with the handoff, as T3 Code does. If the agent is waiting on a card for its own tool call (an approval or a question, with an `itemId`), a message from Mike declines that card first (`approval.resolved` with `deny` and a `message` telling the agent he wrote instead), as the CLI reads nothing else until the card is answered; a background subagent's card is left open. Otherwise (the CLI is still starting or leaving, messages are already waiting, a move or fresh CLI is due on the next turn, Stop has been pressed, or the turn is only an approval for a background subagent) the message is queued and starts its own turn when the running one ends |
| `threads.interrupt` | `{ threadId }` | `{}` |
| `threads.edit` | `{ threadId, seq, text, images?: ImageRef[], stopBackground?: boolean }` | `{ turnId, rewound: { seq, fromSeq, toSeq, files } }`. Replaces the message at `seq` and carries on from there (see Editing a message): stops any turn, cuts the conversation back to just before it, undoes the agent's file changes since, and sends `text` as a new turn. Answers once the new turn has started, which can take a few seconds. `-32602` with the reason when the message can't be edited; `-32020` while another edit of the thread is under way or the runner is handing over; `-32050` while the thread has background work running and `stopBackground` isn't `true` (see Editing a message) |
| `threads.update` | `{ threadId, title?, titleBy?: "mike" \| "agent", cwd?, accountId?, poolId?: string \| null, model?: string \| null, effort?: EffortLevel \| null, permissionMode?, snoozedUntil?: string \| null, archived?: boolean, archivedBy?: "mike" \| "agent" \| "threadbear", verdict?: "worked" \| "didntWork" \| "notNeeded", starred?: boolean }` | `{ thread: ThreadSummary }`. `archivedBy` and `verdict` go with `archived: true`; see "Who archived a thread". `starred` sets or clears `starredAt`; starring a thread that's already starred keeps its place, and neither stops a turn. A `title` is Mike's unless `titleBy` is `"agent"` (the `update_thread` tool, unless the agent says Mike asked for it). Once Mike has named a thread, an agent's different title is `-32602` and nothing in the call changes, and no model title replaces it. `snoozedUntil` is an ISO time, or `"restart"` for until the runner next starts (any start: a planned restart, a crash, a reboot), when the thread wakes before the restart's resume is sent, so a thread put away while its own restart waited is still carried on. Snoozing or archiving releases the CLI (and archives a Codex thread in Codex too). Changing account or cwd takes effect on the next turn; an account change during a turn says so in a `system.note` ("<model> takes over from your next message, which stops this turn."), see `threads.send`. A model or effort change reaches a live Claude CLI straight away (`null` goes back to the default); on Codex it applies from the next turn, with a `system.note` if a turn is running. A folder change on the same Claude account copies the native session's transcript to the new folder and resumes it; on the same Codex account the session carries on in the new folder from the next turn. Otherwise (or if that fails) it starts a new native session with a handoff note: the thread so far under a 16,000-character budget (runner/src/handoff-history.ts, after T3 Code's): messages, tool calls with a little of their output, edited files and errors; the last user message, the last reply and the first message first, then newest to oldest, with gaps marked and a pointer to `read_thread` for the rest. An account of the other provider switches `provider`, resets `model` and `effort` to that provider's defaults unless the same call sets them, and clears the thread's "Always allow" rules. `model` and `effort` are checked as in "Models and effort across providers". `accountId` pins the thread to that login (clearing `poolId`). `poolId: null` pins it to its current login; a pool id puts it in that pool, and moves it onto one of the pool's logins at once (from the next turn) if its current one isn't in it; an unknown one is `-32602`. A move from one Claude login to another copies the session's transcript into the new login's config folder and resumes it there, as a folder move does |
| `threads.retitle` | `{ dryRun?: boolean, threadIds?: string[] }` | `{ threads: { threadId, from: string, to?: string, reason?: string }[] }`. Gives a model title to every thread, archived and snoozed included, whose title is still its first message's first line and that nobody has named (`titleSet`); see "Titles" under "Settings and models". One entry per such thread: `to` when it was renamed, `reason` when it wasn't (no key, private folder, over budget, renamed meanwhile). With `threadIds`, those threads whatever their title (a poor model title can be asked for again), still never one named by hand. The model also gets the start of the thread's first reply. `dryRun` lists them without asking the model (`tb retitle`) |
| `threads.delete` | `{ threadId }` | `{}`. Stops the thread's CLI and moves its folder to `trash/` in the data dir (a Codex thread is archived in Codex too). Every client gets `thread.deleted` |
| `threads.events` | `{ threadId, afterSeq?: number, beforeSeq?: number, limit?: number }` (default: the newest 500) | `{ events: Event[], firstSeq, lastSeq, inProgress: { itemId, type: "assistant.text" \| "reasoning", text }[] }` |
| `threads.subscribe` | `{ threadId, afterSeq?: number }` | `{ events: Event[], inProgress: { itemId, type, text }[] }` (everything after `afterSeq`, and the text streamed so far for items still streaming), then pushes `thread.event` notifications. Deltas pushed after the reply carry on from `inProgress` |
| `threads.unsubscribe` | `{ threadId }` | `{}` |
| `threads.subagent` | `{ threadId, subagentId }` | `{ subagent?: Subagent, events: Event[] }`: what the sub-agent has done so far, read from the CLI's own record of it, as events (`user.message` for its brief, then `assistant.text`, `reasoning`, `tool.call`, `tool.result`, `edit.diff`) numbered from 1, with no `turnId`. Read again for more while it runs: thread.updated says when it has done something. `subagent` is absent once the thread's list has dropped it. `-32006` when there's no record of it (an older thread, or the CLI cleaned it up) |
| `threads.markSeen` | `{ threadId, seq }` | `{ thread: ThreadSummary }` |
| `threads.tickAsk` | `{ threadId, asksSeq, index, ticked: boolean }` | `{ thread: ThreadSummary }`. Ticks or unticks one of the open card's asks (Needs you), with an `asks.ticked` event. Sends nothing to the agent. `-32602` when `asksSeq` isn't the open card's or `index` is out of range |
| `threads.share` | `{ threadId, access: "off" \| "link", newLink?: boolean }` | `{ thread: ThreadSummary }`. Whether anyone with the link can read the thread on the website (see Sharing). `newLink` makes a fresh slug, which stops the old link. Another access is `-32602` |
| `approvals.respond` | `{ threadId, approvalId, decision: "allow" \| "allowAlways" \| "deny" \| "answered", message?: string, answers?: Record<string, string> }` | `{}`. `allowAlways` allows matching requests for the rest of this thread only; it never changes the thread's permission mode or saves anything in the project. With `answered`, the app sends the chosen answers in one line as `message` too: the runner keeps it in `approval.resolved` (only `answers` goes to the CLI), so the transcript can show what was chosen |
| `secrets.answer` | `{ threadId, approvalId, secret?: string, decline?: true }` | `{}`. Answers a `secret.requested` card (Secrets). The runner never logs, emits or mirrors `secret` |
| `media.import` | `{ path: string }` | `{ image: ImageRef }` copies a file into `inbox/` and reads its size; HEIC becomes JPEG and TIFF or BMP becomes PNG |
| `patches.trust` | `{ threadId, files: { file, hash }[] }` | `{ trusted: string[] }`. Trusts those versions of the thread's waiting patch files (each a `file` its `patches` lists with `untrusted`, and the `hash` given there), then every thread's patches are read again, so the answer comes once they have been. The `claude` entry's file trusts the folder's Claude Code settings the same way. `-32602` for a file the thread isn't waiting on, or one whose hash has moved on since (look again). See "Trusting a folder's patches" |
| `actions.run` | `{ threadId, actionId }` | For a prompt action, `{ turnId }`: its prompt was sent as a message (as `threads.send`). For a url action (only an older client calls it for one), `{ ok: true, durationMs }` once the page is opened on the runner's Mac, with nothing in the transcript. For a command action, `{ ok, exitCode?, durationMs, seq }` once the command has finished, with its output in the transcript as the `action.run` event at `seq`. The command runs in the thread's folder through a login shell with the thread's variables (`THREADBEAR_THREAD_ID` and the rest) and is stopped after 10 minutes. `-32602` for an action the thread doesn't have, `-32020` while the same action is still running |
| `panels.render` | `{ threadId, panelId }` | `{ image?: ImageRef, items?: PanelItem[], note?: string }` draws an `image` panel or fills a `list` panel now. For `xcode.simulator`, a screenshot of the booted simulator (`xcrun simctl io booted screenshot`), written to the same file each time under the thread's `panels/`; with no device booted (or another failure) there's only `note`. For a `list` panel, the rows its patch's `items` function returned (at most 200), or `note` with the error when it threw or took over 20 seconds. Slow: it waits for the screenshot or the function. `-32602` for a panel the thread doesn't have |
| `panels.convexDeployments` | `{ threadId, panelId, refresh?: boolean }` | `{ deployments: { deployment, deploymentUrl, label }[], note?: string }`. The configured cloud deployment and the project's Development and Production deployments, resolved through the runner's own Convex CLI, run in the project's folder, with read-only queries of `process.env.CONVEX_CLOUD_URL`. Duplicate names are combined; `note` explains unavailable choices. Cached for one minute; `refresh` bypasses the cache. Makes no deploy keys and changes no project settings. `-32602` for a missing or non-cloud panel |
| `panels.convexKey` | `{ threadId, panelId, deployment?: string, renew?: boolean }` | `{ deployment, deploymentUrl, adminKey }`, a deploy key for a panel with `convex`, for Convex's embedded dashboard. `deployment` defaults to the panel's configured deployment; any other name must be one returned by `panels.convexDeployments` for this panel's project. The runner makes it the first time (`convex deployment token create` in the project's folder, with the runner's own Convex CLI, so an older `convex` package in the project doesn't matter, on Mike's Convex CLI login) and keeps it in `secrets/convex-panels/<deployment>.json`; `renew` deletes that one from Convex and makes a fresh one. A kept key is first checked with the deployment's `/api/check_admin_key` (only at its own `<name>[.<region>].convex.cloud` address), and one Convex says no to (revoked) is replaced the same way; an unclear answer keeps it. Slow the first time. `-32602` for a panel the thread doesn't have or one without `convex`; `-32040` when the runner's Convex CLI isn't signed in (or its login expired), `-32041` when its login can't reach the deployment, otherwise `-32000` with the CLI's message, each in plain words |
| `panels.convexLogin` | `{ threadId, panelId, check?: boolean, force?: boolean }` | `{ state: "idle" \| "waiting" \| "done" \| "failed", url?, code?, message? }`. Signs the runner's Convex CLI in (`convex login --no-open --login-flow poll`), for a panel that got `-32040` (or `-32041`, with `force`, to switch accounts). Answers once the CLI prints its device page: `url` to open in the browser on the Mac the person is at (any browser can approve it, so a remote runner's sign-in works from here), `code` what that page shows. A call while one is waiting joins it. `check` only reports: poll it until `done` (then the deployment list is fetched afresh) or `failed` (`message` says why, or that it wasn't approved within the code's five minutes) |
| `threads.highlights` | `{ threadId }` | `ThreadHighlights` (see Highlights): what the thread has made, shared and pinned, read from its events since the last call and kept with the thread |
| `threads.explain` | `{ threadId, selection: string, message?: string, question?: string, earlier?: { question?: string, answer: string }[] }` | `{ answer: string, model: string }`. Explains words Mike selected in the transcript, on the small model (see Explain). `message` is the whole message they came from, as the app shows it; `earlier` and `question` are a follow-up. Writes nothing to the thread. `-32000` with the reason when no model answers |
| `threads.hibernateWhen` | `{ threadId, said: string }` (at most 300 characters) | `{ thread: ThreadSummary, until?: string, topic?: string, why: string }`. Hibernates the thread until when Mike said, in his own words (see Hibernate in words). It's away at once, with `wakeWhen.pending`, and the answer comes once the model has worked out when. `-32000` with the reason when it can't say, and the thread is back in the inbox |
| `threads.removeHighlight` | `{ threadId, highlightId }` | `{ thread: ThreadSummary }` takes one off the list for good (a pin or a found one); a later mention doesn't bring it back. `-32602` for an id the thread doesn't have |
| `threads.panelShown` | `{ threadId, requestId }` | `{ thread: ThreadSummary }`. The app has shown the thread's `panelRequest` (see Showing panels), which clears it. Another id (a newer request replaced it, or it's gone already) changes nothing |
| `threads.showPanel` | `{ threadId, panel }` | `{ available, request?, shown? }`. Queues the same request as `show_panel` when the Mac app is connected. Otherwise returns `available: false` without queuing anything. Used by `tb show-panel` and BrowserBear handoff |
| `schedules.list` | `{ threadId?: string }` | `{ schedules: Schedule[] }`, soonest `nextRunAt` first, then the paused and finished ones. With `threadId`, only the ones that send to that thread or were made by it |
| `schedules.create` | `{ text: string, title?: string, at?: string, cron?: string, timezone?: string, threadId?: string, cwd?, accountId?, poolId?, model?, effort?, permissionMode?, paused?: boolean, createdBy?: string, runnerId?: string }` | `{ schedule: Schedule }`. Exactly one of `at` and `cron`. `accountId` and `poolId` together, or a `poolId` this runner doesn't have, is `-32602`. An `at` in the past runs straight away. With `threadId` it sends there, otherwise it starts a new thread each time (`cwd` defaults like `threads.create`'s, checked now). A bad cron or zone is `-32602` with a message saying what's wrong. `runnerId` (an id or a name from `runners.list`) puts a new-thread schedule on another runner: its folder and account are checked there when it runs, and an absent `cwd` means that runner's default. Absent, it's this runner. Needs schedules in the backend (see Schedules, "Runners"); otherwise `-32602` |
| `schedules.update` | `{ scheduleId, title?, text?, at?: string, cron?: string, timezone?: string \| null, paused?: boolean, cwd?, accountId?, poolId?: string \| null, model?: string \| null, effort?: EffortLevel \| null, permissionMode? }` | `{ schedule: Schedule }`. Setting `at` drops `cron` and the other way round; setting `accountId` drops `poolId` and the other way round (`poolId: null` leaves neither). The folder, login and model are only for one that starts a new thread: on one that sends to a thread they're `-32602`. A new time works out `nextRunAt` again; so does unpausing. Setting `at` on a finished one-off makes it run again then. The target thread can't be changed (make a new schedule) |
| `schedules.delete` | `{ scheduleId }` | `{}` |
| `schedules.run` | `{ scheduleId }` | `{ schedule: Schedule, threadId?: string, turnId?: string, queued?: boolean }` runs it now, as if it were due, even when paused. A repeating schedule keeps its `nextRunAt`; a one-off is finished. For a schedule on another runner it answers at once with `queued: true` and no thread: that runner runs it when it next hears (`runRequestedAt` is set until then) |
| `runners.list` | `{}` | `{ runners: RunnerInfo[] }`, this runner first, then the rest by name. Without a backend, just this runner |
| `runners.stats` | `{}` | `{ stats: RunnerMachineStats[] }`: each runner's latest machine figures, `{ runnerId, at, cpuPercent, cores, memUsed, memTotal, diskFree, diskTotal, load1?, uptimeSec, machine?, os? }` (bytes; `uptimeSec` is the machine's). Asking marks them wanted (`sync:watchRunnersFromMac`, at most every 20 s), so every runner reports every 10 s until nobody has asked for 45 s. The Mac app asks only while a runner's details are open in the Runners panel and its window can be seen. Empty with sync off, on an older backend, or on a runner key. A runner older than this answers `-32601` |
| `remoteThreads.list` | `{}` | `RemoteThreads`: other runners' threads for the sidebar (see "Other runners' threads"). Empty with sync off, or before the backend (API 12) has answered. A runner older than this answers `-32601` |
| `files.read` | `{ path: string, maxBytes?: number, known?: { size, modifiedAt } }` | `{ path, size, modifiedAt, mediaType, data, truncated }` (`data` base64, at most `maxBytes`, default 16 MB, never over 48 MB; `truncated` when the file is longer), or `{ path, unchanged: true, size, modifiedAt }` when `known` matches the file. A file on this runner's Mac, for a Mac app showing one of its threads from another Mac (see "Other runners' threads"). `-32602` for a relative path, a missing file or a folder |
| `files.list` | `{ path: string }` | `{ path, entries: [{ name, isFolder, hidden, size?, modifiedAt? }], truncated }` (`size` for a file only; `isFolder` follows a symlink; `hidden` is a dotfile; at most 5000 entries, in no set order, `truncated` when the folder has more). A folder on this runner's Mac, for the side pane's folder browser on another Mac (see "Other runners' threads"). `-32602` for a relative path, a missing folder or a file |
| `schedules.preview` | `{ cron?: string, at?: string, timezone?: string, count?: number }` | `{ whenText: string, runs: string[] }`, the next `count` (default 5, at most 20) times it would run, for an editor to show as someone types. `-32602` with the reason for a cron or zone it can't read |
| `projects.list` | `{ archived?: boolean }` | `{ projects: Project[] }`, newest `lastActivityAt` first. Archived ones only with `archived: true` (then all of them) |
| `projects.get` | `{ projectId }` | `{ project: Project, threadIds: string[] }`, its threads newest activity first, put away ones included |
| `projects.create` | `{ title: string, folders?: string[], goals?, state?, notes?, links?: { title?, url }[], threadIds?: string[] }` | `{ project: Project }`, made by Mike (`createdBy: "mike"`). `threadIds` are put in it, pinned. Folders must exist (`-32602` otherwise) |
| `projects.update` | `{ projectId, title?, folders?: string[], goals?, state?, notes?, links?: { title?, url }[], notion?: string, archived?: boolean }` | `{ project: Project }`. Replaces what's given. A new title is Mike's (`titleBy: "mike"`), so the librarian never renames it. A link that isn't http(s), or more than 8, is `-32602`. A change of folders reloads its threads' patches. `notion` is a Notion page or database address (notion.so, notion.site, notion.com, or a `collection://` data source), read straight away (see Project tasks); empty takes it off; anything else is `-32602` |
| `projects.refreshTasks` | `{ projectId, force?: boolean }` | `{ project: Project }` once its Notion board has been read again, unless it was read in the last minute (`force` reads it anyway). The project page asks when it opens. `-32602` for a project with no `notion` |
| `projects.setIcon` | `{ projectId, path?: string, symbol?: string }` | `{ project: Project }`. Mike's choice: `path` a picture on this Mac (PNG, JPEG, WebP, SVG, ICNS or ICO, copied in), or `symbol` an SF Symbol name; neither puts it back to automatic, and the librarian finds one again within seconds. `-32602` for a missing file or a name that isn't a symbol's |
| `projects.merge` | `{ projectId, intoId }` | `{ project: Project }` (the one kept). Folders and threads move over, notes are joined, and `projectId` is deleted |
| `projects.delete` | `{ projectId }` | `{}`. Its threads leave it; nothing else is touched |
| `threads.setProjects` | `{ threadId, add?: string[], remove?: string[] }` | `{ thread: ThreadSummary }`. What Mike does by hand: an added project is pinned (adding one the thread is already in pins it, which is how "keep it here" works), a removed one is remembered so the librarian never puts the thread back in it |
| `librarian.status` | `{}` | `{ librarian: LibrarianStatus }` |
| `connectors.status` | `{ refresh?: boolean }` | `{ connectors: ConnectorsStatus }` (see Connectors). `refresh` asks the gateway's `/health` first, unless it did in the last 10 seconds; the app passes it when the Connectors panel opens. A runner from before Connectors answers `-32601` and the app leaves the panel out |
| `librarian.run` | `{ threadId?: string }` | `{ librarian: LibrarianStatus }`. Queues a look at the thread now (reason `asked`), or with no `threadId`, at every thread it has never looked at (a backfill, newest first) |
| `librarian.update` | `{ paused?: boolean }` | `{ librarian: LibrarianStatus }` |
| `pools.list` | `{}` | `{ pools: Pool[] }` (see Pools) |
| `pools.save` | `{ pools: Pool[] }` | `{ pools: Pool[] }`. Replaces the whole list in `runner.json` (`builtIn` is dropped; an empty list goes back to the built-in ones). `-32602` for a duplicate id, a blank id or title, an empty `accountIds`, or an account id the runner doesn't know. A blank or non-string `icon` is dropped. Every client gets `pools.updated` |
| `settings.get` | `{}` | `{ settings: Settings }` |
| `settings.update` | `{ defaultCwd?, idleMinutes?, maxLiveCLIs?, followMain?, bulletReplies?, oneReply?, models?: { pool?: string \| null, privateFolders? } }` | `{ settings: Settings }`. Saves what's given to `runner.json` and applies it straight away, except `followMain` (next restart). `defaultCwd` must be an existing folder, `idleMinutes` at least 1, `maxLiveCLIs` 1 to 20, `pool` a pool id or `null`; otherwise `-32602` saying which. Every client gets `settings.updated` |
| `devices.list` | `{}` | `{ devices: Device[], site?: string, reason?: string }` (see Devices). `site` is the website's root while sync is on; `reason` says why nothing can pair when it's off |
| `devices.pair` | `{ kind: "phone" \| "browser", name?: string, days?: number }` | `{ device: Device, pairingLink?: string, signInLink?: string }`. Issues a phone token for a new phone or browser (see Devices) and returns the link that carries it: a `threadbear://pair?url=…&token=…&key=<runnerId>:<key>` link for a phone, for the app to draw as a QR code (the `key` item is this runner's secret-box public key, see Secrets, "Trusting the key"; absent when the runner has none), or the website's sign-in link (`<site>/#token=…`) for a browser, for the app to open. `days` is 1 to 365 (default 90). `-32000` while sync is off, or while the backend is older than this |
| `devices.revoke` | `{ deviceId }` | `{ devices: Device[] }`. The phone or browser is signed out at its next request. `-32602` for an id that isn't there |
| `models.run` | `{ job: "classify" \| "extract" \| "summarize" \| "generate", text: string, labels?: string[], fields?: Record<string, string>, maxWords?: number, system?: string, cwd?: string, maxTokens?: number }` | `{ ok: true, value, model }` or `{ ok: false, reason: "no-pool" \| "off" \| "private" \| "no-room" \| "timeout" \| "provider", message }`. One model call by hand (`tb models try`), on the pool like any other, with `feature: "tb"`. `maxTokens` (generate only, 1 to 8000, default 500) caps the answer, reasoning included; `classify` needs 2 or more `labels` and answers one of them; `extract` needs `fields` (name to a plain description) and answers an object of them, `null` where the text doesn't say |
| `runner.status` | `{}` | `{ version, release?, branch?, pid, startedAt, home, logFile, liveClis, running: string[], background: { threadId, tasks: string[] }[], pendingRestart?: { when, reason?, release?, resumeThreadId?, requestedAt, backgroundUntil?, waitingFor: string[] }, rolledBack?: { from, at }, draining?: { pid, version, release?, since, threads: string[] }[], update?: { state, checkout?, reason?, checkedAt?, commit?, release?, logFile?, launcherChanged?, launcherReason? }, macScreen?: { fullDiskAccess?, dialogs, dialogsSince? }, clis?: CliStatus[] }`. `running` lists the threads that are starting, running or waiting on an approval or a question; `background` the threads whose CLI is still running background shells or subagents (`tasks` describes each). A restart waits for both. `branch` is the branch the release was built from. `rolledBack` is set when this release is running because `launch.mjs` went back to it from `from`, which kept crashing at startup (and nobody has activated it on purpose since). `update` is the runner following main by itself (docs/dev-tools.md): `state` is `off` (`reason` says why), `idle`, `checking`, `building`, `waiting` (`release` is built and starts on the pending restart) or `failed` (`reason` is the error; `logFile` has the build's output); `commit` is main's tip at the last check (`checkedAt`) |
| `runner.restart` | `{ when?: "idle" \| "now", resume?: { threadId, text }, reason?: string, release?: string, backgroundWaitMs?: number, cancel?: boolean }` | `{ scheduled: boolean, waitingFor: string[], background?: { threadId, tasks: string[] }[], note?: string, noResume?: string, handover?: { keeps: string[] } }`. See Restarts below; `handover` under Handovers. `scheduled` is true once the restart is saved; an empty `waitingFor` means it is happening now. `background` is the background work among `waitingFor`. `release` is the release the restart should come back on (the deploy script sets it). `backgroundWaitMs` limits how long background shells and subagents hold the restart. `cancel: true` withdraws a pending restart that hasn't begun and returns `scheduled: false` (`-32020` once it has begun), with a `note` when it also put `current` back. `noResume` says why the `resume` won't be sent as things stand (the thread has already been resumed 3 times in the last hour), so whoever asked can say so rather than wait for it. A runner older than this answers `-32601` |
| `clis.list` | `{}` | `{ clis: CliStatus[] }` |
| `clis.check` | `{ provider?: Provider }` | `{ clis: CliStatus[] }`. Starts a version check (both CLIs when `provider` is absent) and returns at once, with the state as it was when the call arrived; the result comes through `clis.updated` |
| `clis.update` | `{ provider: Provider, version?: string, force?: boolean }` | `{ clis: CliStatus[] }`. Starts an update and returns at once, with `update.state` `running` or `waiting`; progress comes through `clis.updated`. `version` picks a kept Codex version (how "Go back" works). `force: true` installs a held version anyway |
| `clis.setPolicy` | `{ provider: Provider, policy: "auto" \| "notify" \| "off" }` | `{ clis: CliStatus[] }` |
| `usage.stats` | `{ days?: number }` | `UsageStats` (see Usage history): each login's tokens by the hour and its limit readings over time, for the Usage panel's charts. `days` is 1 to 14 (default 8). A runner older than this answers `-32601` |

Errors use JSON-RPC error objects: `-32602` bad params, `-32004` thread not
found, `-32005` schedule not found, `-32006` sub-agent not found, `-32007` project not found, `-32010` account not found, `-32020` busy (e.g. two sends racing), `-32030` a draining runner no longer holds that thread (Handovers), `-32050` background work would be stopped (`threads.edit`),
`-32601` a method this runner doesn't have (`clis.*` on a runner older than
them), `-32000` anything else with a readable `message`.

### Models and effort across providers

The runner checks `model` and `effort` in `threads.create` and
`threads.update` against the thread's provider, and corrects them rather than
answering `-32602`, because an older app always sends a model and can't
recover from an error. (An `effort` that isn't an `EffortLevel` at all is
still `-32602`.)

- Claude models are `opus`, `sonnet`, `haiku` and anything starting
  `claude-`. Codex models are those in a Codex account's `models`, or
  anything starting `gpt-` before the list is known.
- A model of the other provider, or a Codex id that isn't in the account's
  `models` once they're known, is replaced by the provider's default, with a
  `system.note` ("sonnet isn't a Codex model, so this thread uses
  GPT-6.1-Sol").
- An effort the model doesn't list in `effortLevels` (when known) is dropped
  with a note. `ultra` on a Claude thread always is.

## Notifications (runner to app)

| method | params |
|---|---|
| `thread.updated` | `{ thread: ThreadSummary }` sent to every connected client whenever a summary changes, `background` included: a sub-agent or shell job starting or finishing sends one even when nothing else changed |
| `thread.event` | `{ threadId, event: Event }` only for subscribed threads, persisted and transient |
| `thread.deleted` | `{ threadId }` sent to every connected client when a thread is deleted |
| `accounts.updated` | `{ accounts: Account[] }` sent to every connected client when the account list or what the runner knows about an account changes: a login appears or goes (checked every 10 seconds), its `models` once the CLI has been asked, its `defaultModel` once a turn has shown it, or its `usage` (Token Stats' `limits.json` changed, or a live reading moved a window by a point or more). The first change goes out at once, then at most one every 5 seconds, always ending on the latest list. Replaces the list from `hello` |
| `pools.updated` | `{ pools: Pool[] }` sent to every connected client after `pools.save`, and when a change in the login list changes the built-in pools. Replaces the list from `hello` |
| `clis.updated` | `{ clis: CliStatus[] }` sent to every connected client when a CLI's status changes (a check finished, an update started, moved on or ended). The latest list wins |
| `schedules.updated` | `{ schedules: Schedule[] }` sent to every connected client whenever any schedule changes (made, edited, run, deleted, or its thread deleted). The whole list, in `schedules.list` order |
| `remoteThreads.updated` | `RemoteThreads` sent to every connected client whenever another runner's threads, or what's known of that runner, change. The whole list, as `remoteThreads.list` |
| `projects.updated` | `{ projects: Project[] }` sent to every connected client when any project changes, as `projects.list` with `archived: true` would answer. Thread membership changes come as `thread.updated` |
| `librarian.updated` | `{ librarian: LibrarianStatus }` sent to every connected client when the librarian's status changes |
| `connectors.updated` | `{ connectors: ConnectorsStatus }` sent to every connected client when what the Connectors panel would show changes (a service signs out or back in, the gateway stops or starts answering); not when only `checkedAt` moves |
| `settings.updated` | `{ settings: Settings }` sent to every connected client when a setting or the key changes, and at most once a minute while model calls are adding to the spend |
| `runner.notice` | `{ level: "info" \| "warning" \| "error", message }`. Also sent straight after the `hello` result for things the client missed (startup problems, a missing `claude` binary) |
| `runner.updates` | `{ updates: RunnerUpdates }` sent to every connected client when the runner's own update state changes (below). Replaces the one from `hello` |

## Runner updates

`hello` carries `updates?: RunnerUpdates`, and `runner.updates` sends it
again whenever it changes, so a client can show that the runner is
updating itself (docs/dev-tools.md, "The runner updating itself").

```ts
type RunnerUpdates = {
  // The runner following main (runner.status's update.state).
  state: "off" | "idle" | "checking" | "building" | "waiting" | "failed"
  commit?: string       // main's short commit it last saw or is building
  subject?: string      // that commit's subject line
  reason?: string       // off: why; failed: what went wrong
  // Runners that handed over and are still finishing turns (Handovers).
  oldRunners: { version: string; threads: string[] }[]
  // The LaunchAgent is behind main in a way only install-runner.sh fixes:
  // launch.mjs on main differs from the installed one, the plist still
  // runs node rather than Threadbear Runner.app, or the app was built
  // from older runner/launcher/ sources than main's.
  launcherChanged?: true
  // Which of those, in a sentence (for tb status and the Updates panel).
  launcherReason?: string
  // Mike's releases, for a fork (below). Left out while off, except on
  // Mike's own runner once it has tagged one.
  upstream?: UpstreamStatus
}
```

### Mike's releases

A copy of Threadbear that's someone's fork follows Mike's releases
(`runner/src/upstream.ts`, docs/setup-and-updates.md section 2.3). Every six
hours, and a couple of minutes after the release is marked good, the runner
fetches `upstream`'s `release/*` tags into `refs/threadbear/upstream/*` in
its checkout, and takes the newest that is signed with the key pinned in
`<home>/upstream-signers` and names itself as the ref it came in as. It
never changes main: bringing a release in is a thread (docs/bringing-in-updates.md).

```ts
type UpstreamStatus = {
  // off: no upstream remote, upstream is the same repo as origin, or no
  // pinned key; idle: main has the newest release; available: it doesn't.
  state: "off" | "idle" | "checking" | "available" | "failed"
  reason?: string          // off and failed: why; idle: "no signed releases yet"
  checkout?: string        // the repo it looks at (the release's checkout)
  checkedAt?: string
  release?: {              // the newest signed release, kept through a failed check
    tag: string            // "release/2026-10-30"
    commit: string
    date?: string          // the tag's, ISO
    changes: number        // commits in it main doesn't have, merges left out
    subjects: string[]     // their subject lines, newest first, at most 50
  }
  // Mike's runner (runner.json releases.publish): the last tag it made.
  published?: { tag: string; at: string }
}
```

`upstream.status` returns `{ upstream: UpstreamStatus }`, and
`upstream.check` fetches first and then returns the same (`tb updates
[check]`). `runner.status` carries it as `upstream`.

Mike's runner makes the tags when runner.json has `"releases": { "publish":
true, "signingKey": "~/.ssh/<key>" }`: once an hour it looks, and tags
main's tip as `release/<local date>` (SSH-signed, its message the subjects
since the last release) and pushes it to origin, when there's no tag for
today, main has moved since the last one, main's tip is an hour old, and the
runner it's running is main's runner/, marked good and up for an hour.

"Pending" for a client means `building`, `waiting`, any `oldRunners`, or
`launcherChanged`; `failed` is worth a look too. `waiting` is brief once
handovers are on: the release is built and the switch starts as soon as
the restart is asked for.

## Restarts

`runner.restart` restarts the runner without cutting a turn short.

- `when: "idle"` (the default) waits until no thread is starting, running or
  waiting on an approval or a question, and no CLI is still running
  background shells or subagents (stopping the runner stops those too).
  Then it shuts down the way it does on SIGTERM and exits 0, and launchd
  starts it again. `waitingFor` names the threads it is waiting for. A
  message sent meanwhile still starts a turn, and the restart waits for
  that turn too. Background work can go on for ever (a dev server, a
  watcher), so `backgroundWaitMs` puts a limit on it: from then on only
  turns hold the restart, and the background work it stops gets the note
  below. A thread deleted meanwhile stops holding it. Turns are never cut
  short by an idle restart. When background
  work ends while a turn is running, the thread stays busy for up to 15 s
  after that turn, since the CLI may start a turn of its own to read the
  result. Once the shutdown has begun, `threads.send` and
  `threads.create` answer `-32020` ("The runner is restarting; send again
  in a moment.").
- `when: "now"` shuts down straight away. Turns in flight end as `stopped`.
  Whenever the runner stops with background work still going, each thread
  that had some gets a `system.note` saying what was stopped.
- While a restart is pending, every client gets a `runner.notice` ("The
  runner will restart when 2 threads finish."), and clients that say hello
  get it again. Threads waiting on an approval or a question won't finish
  until someone answers, so they're counted apart: "The runner will restart
  when 1 thread finishes and you answer 2.", or "when you answer 1 thread."
  The Mac app reads these sentences (the numbers after "when" add up to the
  threads waited for), so they change together. `runner.status` shows it as `pendingRestart`. When it
  starts, the notice is "The runner is restarting now."
- The request is saved in `restart.json` in the data dir, so a crash
  before the runner is idle doesn't lose it: the next start counts as the
  restart. If the runner stops some other way while it waits (launchctl,
  a reboot), that stop counts as the restart. Asking again while one is
  pending merges the two: `now` wins, the earliest background limit
  wins, and each thread's latest `resume` is kept.
- `cancel: true` withdraws it. If it was a deploy's restart onto a release
  that `current` names and this runner isn't running, the runner points
  `current` back at its own release, so the withdrawn release doesn't
  start on the next restart of any kind; `note` says so (or, when it
  can't, that the release is still current).
- `resume` carries a thread on afterwards. On the next start the runner
  adds a `system.note` "Runner restarted: <old version> to <new version>"
  to that thread (with " (from branch X)" for a release not built on main,
  and the rollback notice below as a second paragraph if the new release
  kept crashing), then sends `text` as a new turn whose `user.message` has
  `origin: "runner"`. The text is only sent if the old runner stopped less
  than 15 minutes ago (after a crash, if that thread asked less than 15
  minutes ago), the thread isn't snoozed or archived, nobody has sent it a
  message since it asked, and the runner hasn't already resumed it 3 times
  in the last hour; otherwise there's only the note, saying why. A
  resume sent again after a crash rollback (below) replaces the one the
  crashed release sent, so it doesn't count twice.
- If the request named a `release` and the runner came back on another one
  (it kept crashing, or a later deploy replaced it), the note says so and
  the text sent starts with "Note from the runner: ..." saying which
  release is running, so the agent doesn't take the old code for its own.
- The handled request is kept as `restart.done.json` until the new runner
  has stayed up 60 seconds or stops cleanly. If it crashes before then,
  the same release starting again leaves the file alone (launch.mjs gives
  a broken release a second start), and when launch.mjs then goes back to
  the last good release, that runner resumes the same threads once more,
  with the rollback in the note and the message.
- A runner that had to go back to an earlier release because the new one
  kept crashing at startup says so with a `warning` notice at startup and
  after every `hello` ("Release X kept crashing at startup, so the runner
  went back to Y.").

### App restarts

An agent that changed the Mac app lands it; the app restarts onto the new
build by itself once Mike leaves it idle, or sooner if he picks Restart to
Update. The agent wants to know when it has, to check the change in the
running app. The app's `hello` carries its `build` (`commit`, `short`, and
`tree`, the app/ and dock/ trees as `BuildInfo.appTree`; a dev build sends
none, and only `client: "threadbear-mac"` counts). The runner keeps the
last build it saw and the threads waiting, in `app-restart.json` in the
data dir, so both outlast its own restarts.

- `wait_for_app_restart` (`{ text? }`) puts the calling thread on the list,
  remembering the build running then. Asking again replaces its request.
- An `end_turn` with `needs: "you"` whose asks mention "Restart to Update"
  (in `action`, `why` or `where`) does the same, unless the thread is already on
  the list, and its reply says so. So does a completed turn whose
  closing "What I need from you" says it, for when end_turn was refused
  and the asks ended up in the reply's text.
- When the app says `hello` with a `tree` other than the one a thread
  remembered, that thread gets a `system.note` "Threadbear app restarted:
  <old short> to <new short>" and a message with `origin: "runner"`: "The
  Threadbear app has restarted onto <short> (<commit>), as you asked to
  hear." and its `text`, or "Check your change in the running app.". Then
  it's off the list. The same build again (the app reconnecting to a
  restarted runner) changes nothing.
- An archived thread, or a request more than a day old, gets only the
  note, saying why.
- A thread still finishing a turn on a draining runner (Handovers) stays
  on the list until it comes across, and then hears about the build the
  app came back on. One that has been deleted just drops off the list.

### Handovers

A runner started by `launch.mjs` as a supervised child
(`THREADBEAR_SUPERVISED=1`, docs/dev-tools.md) doesn't make an idle
restart wait for busy threads. It hands over instead:

- If no thread is busy, it restarts as above.
- Otherwise the busy threads (the ones an idle restart would wait for,
  background work included) are *kept*, and `launch.mjs` starts the new
  release beside this one. `runner.restart` answers at once with
  `waitingFor: []` and `handover: { keeps: string[] }`.
- The old runner is now *draining*. It stops listening on the runner's
  port, lets go of every thread it doesn't keep (their idle CLIs exit and
  resume by session id on the new runner), stops its schedules, updates
  and CLI installs, and listens on a port of its own on 127.0.0.1, written
  to `run/drain-<pid>.json` as `{ pid, port, version, release?, since,
  threads: string[], auth: "challenge" }`. Same token, and the same
  challenge (see Auth; `auth` is absent from a runner older than it).
- The new runner (the *primary*) reads those files at startup, connects to
  each, and doesn't load the kept threads itself. Clients only ever talk to
  the primary: a request about a kept thread (`threads.send`,
  `threads.events`, `threads.subscribe`, `approvals.respond` and the rest)
  goes to the draining runner and its answer comes back unchanged, and the
  draining runner's `thread.updated`, `thread.event`, `thread.deleted` and
  `runner.notice` come through the primary. `threads.list`,
  `threads.search` and `hello` include kept threads.
- A kept thread moves across once nothing would be cut short: no turn,
  approval or question, background work or wake grace. Background shells
  and monitors hold it for 4 hours after its last turn at most (a dev
  server never ends), and are then stopped with the usual note, and the
  thread is told when it comes across (Stopped background work). A thread
  in use could stay on the old release for as long as its work runs, so
  once it has been there 12 hours, 30 minutes without a turn is enough.
  The stuck-job check (Stuck background jobs) goes on running on the
  draining runner, for the threads it keeps. Subagents
  hold it until they finish, up to 4 hours: they end by themselves, and
  stopping one throws its work away. Messages queued for it at that moment move with it
  and the primary starts them, so a message sent during the turn runs on
  the new release. The exception is a thread that background work is
  holding: a message to it, or one still queued when its turn ends, starts
  a turn on the draining runner straight away rather than wait out the
  work, and the hold counts from the end of that turn. The draining runner saves the thread, then sends the
  primary `drain.handedOver { threadId }`; the primary loads it and carries
  on (the same seqs; a client's subscription keeps going). Once it keeps
  nothing, the draining runner exits.
- A request for a thread the draining runner has already let go answers
  `-32030` ("moved"), and the primary handles it itself.
- The threadbear tools in a kept thread's session reach the primary over
  the runner's port for anything about other threads, its schedules and
  its projects.
- Projects belong to the primary, which owns `projects.json`. A kept
  thread's project tools read and change them there with
  `drain.projects { op, args }`: `op` is the `Projects` call the tool
  would have made on its own runner (`list`, `get`, `find`, `create`,
  `update`, `appendNote`, `addLinks`, `removeLinks`, `changeMembership`,
  `chooseIcon`), with the same `args` and the agent as the maker, and the
  answer is `{ result }`. A primary older than this answers `-32601`.
  Joining or leaving changes the thread itself, so for a thread the
  draining runner keeps (`create` with `threadIds` included) that part
  happens on the draining runner, against the primary's copy of the
  project, and moves across with the thread. Until the draining runner
  knows the primary's port, a change is refused with a "try again in a
  few seconds" error.
- A `resume` for a kept thread is sent when the thread moves across,
  rather than when the new runner starts, and the 15-minute limit counts
  from then.
- If a draining runner dies, the primary takes its threads as after a
  crash (a turn in flight ends as `stopped`) and stops the process groups
  it left (`run/children-<pid>.json`).
- `runner.status` on the primary lists draining runners as `draining: {
  pid, version, release?, since, threads: string[] }[]`.
- `when: "now"` restarts the primary straight away and tells each draining
  runner to stop too (`drain.stop`).
- Another handover while one is draining makes the primary a draining
  runner as well; draining runners don't hand over again, and close their
  own connections to older ones, which the new primary connects to.

- The primary's summaries of kept threads carry `onOldRunner: true`, so a
  client can say a thread is finishing on the old release. The flag goes
  when the thread comes across.
- Usage readings from kept threads' turns go to the primary
  (`drain.usage { accountId, reading }`), which owns `usage.json`.
- The runner's notice when it hands over starts "The runner is restarting
  onto a new release", which clients already read as a restart under way.

The methods between runners (`drain.hello`, `drain.stop`) and
`drain.handedOver`, `drain.usage` and `drain.projects` are for runners only.

### Stopped background work

A handover's limit (above) or a runner stopping ends a thread's background
shells, monitors and sub-agents. The `system.note` saying so wakes nobody,
so a thread that promised to report back would just go quiet. So the runner
saves what it stopped on the thread (`stoppedWork` in thread.json), and the
next one tells the thread: when it comes across from a draining runner, or
once a restarted runner is listening. That's a new turn whose `user.message`
has `origin: "runner"`, naming the jobs and saying to check on them, report
back if it said it would, and use `schedule_message` for a long wait.

- Only those two kinds of stop count. Snoozing, archiving, moving or changing
  a thread stops its work because someone asked, and the note is enough.
- A thread archived or snoozed by the time it would be told is left alone.
- A runner away for more than a day, or a thread woken 3 times for this since
  a message came from anyone but the runner, gets a `system.note` "Not waking
  this thread about its stopped background work: <why>." instead. The third
  wake says it's the last.
- A crash stops the work without saying what it was, so nothing is told then.

### Stuck background jobs

A thread whose turn has ended stays in Running while its CLI still has
background shells or sub-agents going, so a job that can never finish
(a wait loop whose `pgrep -f` matches its own shell, say) keeps it there
for good. Every 5 minutes the runner (stuck-jobs.ts) looks at idle Claude
threads with background work. A shell or sub-agent counts as stuck when
its output file under `/tmp/claude-<uid>/<project>/<session>/tasks/` (a
sub-agent's links to its transcript) was made more than 30 minutes ago
and hasn't been written for 30 minutes, and, for a shell, it and
everything under it used under 2 seconds of CPU between two looks. The
shells are found under the thread's CLI (the process whose arguments
carry `--resume=<session>` or `--session-id=<session>`) and matched to
their jobs by the output file on their stdout. Monitors are left alone;
they sit quiet by design. So is a shell running a command that waits on
Mike: a `browserbear handoff … --wait` (or `--until-url`,
`--until-text`) process under it, read from ps's full command lines the
way browserbear reads its flags. A shell whose own text only mentions
one doesn't count. It's left alone until its own `--timeout` (20 minutes
when not given) plus 5 minutes has passed since that process started
(ps's etime), and judged as usual after that, as it should have exited
by itself by then. The first wait the check sees sets that deadline for
the job, so a loop that keeps starting new handoffs can't put it off. Codex's background terminals leave no files,
so Codex threads aren't looked at.

The thread gets one message from the runner (origin `runner`) listing
its stuck jobs, how long each has run and what's running in it, asking
the agent to stop any that are stuck and to ask Mike if it can't tell.
Jobs it has been told about are kept in `stuck-jobs.json` in the data
dir for a day, so a runner restart doesn't tell it again.

### Frozen CLIs

A CLI can freeze on something only a person can answer: on 31 Oct 2026 a
phone thread on Bruce sat for 11 minutes with its main thread in `open(2)`,
behind a macOS privacy dialog nobody was at the Mac to click. The agent
can't say so, as it isn't running. So every 30 seconds the runner
(frozen-cli.ts) looks for Claude turns whose CLI has said nothing for a
minute, leaving out any waiting on an approval, and runs macOS's `sample`
for a second on the CLI (the process whose arguments carry its session id),
in a sandbox that keeps it away from what macOS would ask about.
A turn that seems fine is looked at less and less, up to every 5 minutes.
Commands aren't sampled: the CLI moves one that blocks to the background
after 2 minutes and tells the agent, which can say so.

Stuck means the main thread spent at least 90% of the sample in one file
system call (`open`, `stat`, `getattrlist`, `getdirentries` and so on), at
two looks in a row. A CLI waiting on the model or a command sits in
`kevent`, and doesn't count.

The thread then gets a `system.note` saying what's stuck, on which Mac, and
what to do, and goes in Needs you (`forceUnread`). If the CLI says anything
after that, a second note says it's moving again and it leaves Needs you. A
CLI still stuck 5 minutes after the note has its turn failed with an `error`
saying why, and is stopped; the next message resumes the session in a new
CLI. Interrupting a turn whose CLI is known to be frozen stops the
CLI too, as it would never read the next message. Codex threads aren't
looked at.

The prompt itself is about the runner: macOS blames the LaunchAgent's
program, `Threadbear Runner.app`, for everything under it, CLI included, so
answering once holds across CLI updates. Full Disk Access for that app stops
the folder prompts altogether, which a Mac nobody sits at needs.

### A dialog on a Mac's screen

Frozen CLIs only sees a CLI stuck in its own turn. A prompt isn't always that.
On 31 Oct 2026 two were waiting on Bruce's locked screen: Downloads, from an
agent's `find ~/Downloads` at 11:06, whose CLI was stopped at 11:20, and
removable volumes, which fits a release build at 21:54. Those builds run the
unit tests, and that build's new test of `sample` sent `sample` hunting for
debug symbols into a folder deep in the external drive. A prompt stays up after
what asked has gone, and until it's answered it can hold up other apps' access
to that folder or drive, whatever they've been granted. From 22:00 to 06:43
Sammy Cam and two backups were stuck on Bruce's drive, with no turn running and
nothing saying so.
So `sample` now runs in a sandbox that refuses those paths (`sampleSandbox`).
Agents' own commands still set prompts off, on a Mac without Full Disk Access.

So the installed runner (mac-screen.ts, a dev runner only with
`THREADBEAR_MAC_SCREEN=on`, and `off` stops it) does two things, on every
start and every 2 minutes:

- Counts UserNotificationCenter's dialog windows with `osascript`. That's who
  draws these prompts. It works on a locked screen and needs no permission.
  It can't read what a dialog says, so it counts any left waiting, which is
  worth knowing about on a Mac nobody's at too. Dialogs up for 5 minutes get
  a `system.note` in a thread of their own, "<machine> needs someone at its
  screen", in Needs you (`forceUnread`), with no turn and no model call. A
  later note says when they've gone, and archives the thread, unless someone
  has written in it or it's still asking for Full Disk Access (below), when it
  just leaves Needs you. The next dialog then gets a new thread.
- Checks for Full Disk Access by opening macOS's permissions database,
  `~/Library/Application Support/com.apple.TCC/TCC.db`, and closing it. It's
  never read. Without the access macOS refuses at once, with no prompt. A Mac
  without it and without `Threadbear.app` gets one note in the same thread:
  that's the Mac nobody sits at, and granting it is the actual fix. Once
  the access is there, a later note says so and archives the thread, on the
  same terms as a dialog going, and unless a dialog it told of is still up
  (that one's own note archives it when it goes). Losing it again is told
  again.

What it knows goes in `runner.status` as `macScreen: { fullDiskAccess?,
dialogs, dialogsSince? }`, and `tb status` says so. What's been said is kept in
`mac-screen.json` in the data dir, so a restart neither says it again nor starts
the 5 minutes over. macOS has no way for a program to grant this itself, so
it's a person's click in System Settings.

## Settings and models

The runner makes small model calls of its own (classify, extract,
summarise, generate) for features like titles, the librarian and "wake
when" (`src/models/`). Features ask for a job, not a model: `ROUTES` says
which model answers it, Haiku for everything but `decide`, which is Opus.
Every call runs on the official `claude` CLI on one of the Claude logins
in the pool `models.pool` names: the same CLI and logins as threads, so
it needs no key and costs nothing beyond the login's usage.

There used to be OpenRouter as well, with a key, a daily budget and a
spend to show. It went on 29 Oct 2026: every feature is Haiku or Opus,
which the pool runs anyway, and a key was one more thing to set up. An
older runner's `openRouterKey`, `dailyBudgetUsd`, `spentTodayUsd` and
`spentMonthUsd` in `Settings.models` are ignored by clients, and
`secrets/openrouter-key`, if there is one, is no longer read.

- **Consent.** A call sends thread text to Anthropic on Mike's own login,
  as the thread itself does.
- **The pool.** `models.pool` in `runner.json` is a pool id, `"claude"`
  when it isn't set, or `null` for none, which turns titles and the
  librarian off. Only its Claude logins are used. A call runs on the one
  it ran on last while that's OK to run on (see Pools), else the one with
  the most room. The CLI runs as `claude -p` at low effort in an empty
  folder (`models/cli` in the data dir), with no tools, MCP servers,
  settings, hooks, CLAUDE.md, skills or saved session (`--tools ""
  --strict-mcp-config --setting-sources "" --disable-slash-commands
  --no-session-persistence`), the job's own system prompt, and
  `--json-schema` for classify and extract. A login that answers that
  it's out of room counts as run dry, as it does for a turn, and the next
  one is tried. At most 2 calls run at once, and each times out after 60
  seconds.
- **Private folders.** `models.privateFolders` in `runner.json` lists
  folders whose threads are never sent anywhere, for client work and the
  like. A call for a thread in one of them, or anywhere under one,
  doesn't go out.
- **Usage.** Each call that goes out adds a line to `models/usage.ndjson`
  in the data dir: `{ ts, feature, job, model, ok, ms, inputTokens?,
  outputTokens?, accountId?, notionalUsd?, error? }`. `notionalUsd` is
  what the CLI says it would have cost on the API, which isn't spent. No
  text from the call is kept.
- **Titles.** A new thread's title is the first line of its first
  message, as before; a few seconds later a small model's title replaces
  it, unless someone has set one meanwhile. Threads from before any
  model could be reached keep their first line until `threads.retitle`
  names them too. Later, the librarian renames a thread whose title no
  longer says what it's about (see Projects).
- **Failures.** A call never throws: it says why it didn't answer
  (`no-pool`: no pool, or none of its logins is a Claude one; `no-room`:
  every login is out of room; `off`: this runner makes no model calls;
  private folder, timed out, error), and the feature falls back to what
  it did before there was a model to ask.

## Explain

Mike can select words in a thread's transcript and pick Explain from the
little bar that shows above them. The explanation opens in the pane beside
the transcript, with a box under it for a follow-up question. It's a mini
fork of the thread for that one thing: `threads.explain` sends the
selection, the message it came from, the thread's first message and
its last 8 messages to the small model (job `generate`, feature `explain`,
so Haiku on the pool first), and the answer goes back to the app alone.
Nothing goes into the thread's events, so the agent never sees it and its
context doesn't grow. The side conversation lives in the app (one per
thread, gone on quit); each follow-up sends the earlier answers again as
`earlier`. Private folders, the pool and the budget apply as for any
model call.

## Hibernate in words

Besides the presets and a picked time, Mike can say when a thread should
come back in his own words: "at the weekend", "in a few weeks", "next
time I talk about woodworking". `threads.hibernateWhen` hibernates it
straight away (`snoozedUntil` 9999-12-31, `wakeWhen: { said, pending:
true }`), then asks Opus (job `decide`: Opus on the pool; feature
`wake-when`) with the local time and time zone, the
thread's title, first message and brief, and his words. It answers with a
time, a topic, or both:

- **A time** becomes `snoozedUntil`, and the thread wakes as any snooze
  does.
- **A topic** ("woodworking") waits for the librarian. While any thread is
  waiting on one, every look lists them, and its answer's `wake` names the
  ones Mike's own messages in the looked-at thread are about. Each wakes,
  unread, with a `system.note` saying where ("Woke up: you talked about
  woodworking in "Router table jig"."). A topic with no time has the far-off
  `snoozedUntil`; with one, whichever comes first wakes it.

The thread gets a `system.note` saying what was worked out ("Hibernating
until Saturday 31 October, 9 am. You said "at the weekend"."). A model
that can't say (no pool room, an answer that isn't a time or a topic)
puts the thread back and fails the call. A private folder's thread is
asked about with his words alone. Any other snooze, a wake or a message
clears `wakeWhen`, and a runner that restarts while one is pending wakes
the thread, as the answer is lost.

## Usage history

The Usage panel shows more than what's left: how many tokens each login
has spent today, how fast, and how its limits have gone down over the
week. `usage.stats` answers with what the runner has kept:

```ts
type UsageStats = {
  generatedAt: string
  // Whether the first read of the CLIs' transcripts has finished. Until it
  // has, `tokens` is partial and the app says so.
  ready: boolean
  // Per login, the hours it spent anything in, oldest first. Each hour is
  // [startMs, input, output, cacheRead, cacheWrite]: startMs is the start
  // of the hour (UTC, so the app buckets days in its own time zone).
  // Claude's input excludes cache reads and writes; Codex's input excludes
  // its cached input (counted as cacheRead).
  tokens: { accountId: string, hours: [number, number, number, number, number][] }[]
  // Per login, readings of its 5-hour and weekly windows over time, oldest
  // first: [atMs, remainingPercent]. A sample is kept when a window moves
  // by half a point or more, at a reset, and at least every 30 minutes
  // while readings keep coming, so a flat line still has points.
  limits: { accountId: string, kind: "five_hour" | "weekly", samples: [number, number][] }[]
}
```

- **Tokens** come from the CLIs' own transcripts, not just Threadbear's
  threads, so turns run in a terminal or another app count too: Claude's
  `<configDir>/projects/**/*.jsonl` (assistant lines, each message id
  counted once at its biggest, as Claude Code writes a message several
  times while it streams), and Codex's `<configDir>/sessions` and
  `archived_sessions` (`token_count` events, the difference between one
  total and the last). The runner reads only what's new since its last
  look, once a minute, and keeps the hourly totals and where it got to in
  each file in `<data dir>/token-tally.json`, so a restart doesn't read
  everything again. The first read goes back 14 days and takes a while
  (`ready: false` until it's done). Hours older than 15 days are dropped.
  `THREADBEAR_TOKEN_TALLY=off` turns the reading off (dev runners and the
  e2e tests set it): `tokens` stays empty and `ready` false.
- **Limit readings** are whatever `accounts.updated` would show, sampled
  as above into `<data dir>/usage-history.json`, kept for 8 days.
- A draining runner (Handovers) keeps neither file: both are the new
  runner's to write.

## Pools

A pool is a named, ordered list of logins, of any provider. Mike picks a
pool and a model; the runner picks which login runs each turn, and moves a
thread to another login when the one it's on runs out of room.

- **The list.** Built in, worked out from the logins the runner finds: one
  pool per provider (`claude`, `codex`) holding every login of that
  provider without a note, and one per noted login, titled from its note's
  first word (`convex` for claude-2's "Convex work only", with folders
  `["~/dev/convex"]` from the code). `runner.json`'s `pools` replaces the
  whole list; `pools.save` writes it. A pool's `accountIds` order only
  decides which provider comes first; within one provider the runner goes
  by room.
- **Shared between runners** (backend API 38). With a backend, the list
  lives in its `pools` table and every runner follows it, so a pool is the
  same on each machine. A shared pool names its logins by provider and
  email (`members: [{ provider, email }]`), since login ids are each
  runner's own (`claude-main` is a different login on each machine); a
  login with no email known is named by `{ provider, runnerId, accountId }`
  and only counts on that runner. Each runner turns the list into its own
  `Pool[]`, with `accountIds` its logins that match, in member order, and
  leaves out a pool none of its logins are in. `pools.list`, `hello` and
  `pools.updated` carry that, so clients see no difference. `pools.save`
  on any runner writes the shared list: the pools it was given, in that
  order, each keeping the members this runner has no login for, then the
  pools it couldn't see, unchanged. The first runner to meet API 38 with
  `pools` in its `runner.json` puts them in the table if it's empty
  (`sync:adoptPools`, first one wins); until the table has pools, each
  runner keeps its own as before. The runner keeps the last list it saw in
  `shared-pools.json` in its data folder, so it starts with it while the
  backend can't be reached. `runner.json`'s `pools` is left as it was, and
  is used again only with sync off. `defaults.poolId` stays each runner's.
- **Shared readings** (backend API 39). A subscription is one limit
  wherever it's signed in, so each runner also follows the other runners'
  latest usage readings (`sync:sharedUsage`, from their `accounts` rows)
  and counts one of the same provider and email as a third source beside
  Token Stats and its own turns: the newest reading wins, window by
  window, and `usage.source` is `"shared"` when another runner's was the
  newest. A shared reading Token Stats called stale is left out, and one
  that says `blocked`, taken after this runner last read the login,
  blocks it here too until a window at its limit resets.
- **New threads.** A `threads.create` without `accountId` picks the pool:
  `poolId` if given, else the pool whose `folders` holds `cwd` (the
  longest match), else `defaults.poolId` (`runner.json`'s, the pool last
  named in a `threads.create`; failing that, the pool holding
  `defaults.accountId`). Then, if a `model` is named whose provider has no
  login in that pool (and no `poolId` was given), the first pool that has
  one. The thread's provider is its model's, or the pool's first provider;
  its login is the pool's pick of that provider (below, "Which login"). A dev
  runner's `keepAccount` pins new threads to its account instead.
  `defaults.poolId` in `hello` is folder-blind: the app applies folders
  itself (`poolForFolder`, with the shared cases in
  `runner/test/fixtures/pool-folder-cases.json`).
- **Which login.** Of the pool's logins of a provider that are OK to run
  on, the one whose weekly window resets soonest, since whatever is left
  in it then is lost; the most room breaks a tie. Logins with no weekly
  reset known (or one already past) come after those with one, and a
  login with room unknown after those with room known.
- **OK to run on.** A login is OK when it isn't blocked and its room (the
  tighter of the 5-hour and weekly windows) is at least 10%, or its usage
  isn't known.
- **Before a turn** (a send, a queued message, a schedule): if the thread's
  login isn't OK, or isn't in its pool any more, it moves first. A thread
  stays on one login as long as it can, since every move costs a cold
  prompt cache.
- **Where it moves.** The pool's pick of the thread's provider (Which
  login), leaving out the one it's on. If none has room, the first other provider in pool order that
  has a login with room: a cross-provider move, a handoff like any
  provider change, onto that provider's default model
  (`defaults.models[provider]`, else the account's own) and effort. A
  thread that spilled over stays there; it doesn't move back by itself. If
  nothing in the pool has room before a turn, the turn starts where it is.
- **A turn that hits the limit.** A pool thread's turn that ends `failed`
  with `errorKind: "usageLimit"` marks its login blocked (until the window
  at its limit resets, or 30 minutes if no reset is known), moves, and
  sends a runner-origin message: "Your last login hit its usage limit
  partway through that turn, so this thread has moved to another one.
  Carry on from where you left off." Only once per turn: if that carry-on
  turn hits the limit too, the thread waits rather than move again.
- **Waiting.** When nothing in the pool has room the thread gets
  `waitingForRoom: { until, accountId? }`: the earliest time one of the
  pool's logins is back, plus a minute (30 minutes from now if no reset
  time is known). At `until` it looks again: if a login has room it moves
  there if need be and carries on by itself; if not, it waits again. Any
  message that starts a turn ends the wait (and goes through the before-a-
  turn check). The wait is kept in `thread.json`, so it survives a restart.
- **A turn that lost the network.** Not only pool threads: any turn
  that ends `failed` with `errorKind: "network"` (the CLI couldn't reach
  the API at all, after its own retries: DNS, no route, a dropped or
  refused connection) waits, with a `system.note` ("Lost the connection
  to the API partway through that turn. This thread carries on by itself
  once it's back."). The runner probes the provider's API host (a TCP
  connection to api.anthropic.com or chatgpt.com on 443, or a CONNECT
  through `HTTPS_PROXY`) 5, 10, 20, 40 seconds apart and then every
  minute, and once it answers sends a runner-origin message: "The
  connection to the API dropped partway through that turn and is back
  now. Carry on from where you left off." A carry-on that can't get
  through either waits again, with no new note; after five carry-ons, or
  six hours from the first failure, it stops with a note saying to send
  a message. A message already queued goes instead of a carry-on, and
  any turn ends the wait. The thread's summary has
  `waitingForNetwork: { since }` while it waits, kept in `thread.json`
  so it survives a restart. Other failures never
  retry by themselves.
- **Moves in the transcript.** Each move and wait is a `system.note`:
  "Moved to mike@gangbusters.io: mike.cann@gmail.com hit its 5-hour limit,
  back at 6:10 pm." or "Every login in Claude is out of room. Carrying on
  at 5:00 am when mike@cannstudios.com is back."
- **Claude to Claude.** A move between two Claude logins copies the
  session's transcript from the old login's `projects/` folder to the new
  one's and resumes it there, so nothing is lost (a real e2e checks the
  CLI resumes another login's transcript). If the copy or the resume
  fails, the new session starts with a short handoff note instead.
- **Pinning.** A thread with no `poolId` is pinned to its `accountId` and
  never moves. Threads from before pools stay pinned. A pool's logins
  include noted ones only when it lists them, so a "Convex work only"
  login only runs threads in a pool that names it.

## Pictures in a message

A message's words can say where its pictures go. `[Picture N]` in the
`text` of `threads.send`, `threads.create` or `threads.edit` (and so in
the `user.message`) stands for `images[N-1]`, so Mike can point at two
or more pictures in one message ("this [Picture 1] should look like this
[Picture 2]"). He asked for it on 1 Nov 2026, from T3 Code, which puts a
chip in the text where a picture was pasted. The Mac app's composer does
the same: each picture pasted, dropped or added with + gets a marker
where the cursor is (where it was dropped, for a drop), drawn as a chip
with the picture's thumbnail, and his bubble draws the markers as chips
too. The pictures still show over the text, as before. The iPhone
app's composer does the same with photos pasted, taken or chosen, and
its bubbles draw any `[Picture N]` as a chip with the photo symbol, as
the phone isn't given a message's pictures. The runner sends pictures pasted
into a message to the backend as they're sent, unless `sync.pastedPictures` is
false in `runner.json`, each with `src` `picture:N`; the website draws them in
place of the marker, and a chip where one didn't go up. An ask's
Something else box on the Mac takes pictures as chips too (Needs you).

The runner hands the agent the words and pictures in that order: each
picture straight after the first marker that names it (Claude: an image
block between text blocks; Codex: a `localImage` item between text
items). The marker stays in the words, so the agent can say "picture 2"
and mean the one Mike does. A picture no marker names goes before the
words, as every picture did before (an older app's or phone's). A marker naming no picture, or one already placed, is just
words. Text left with nothing but spaces between two pictures is left
out, as the Claude API turns down a text block of only whitespace. A
message of pictures and no words sends `text: ""`, the pictures in their
order.

An older runner hands the agent the markers as words, with every picture
before them; an older app shows them as words.

## Editing a message

Mike can go back to one of his own messages, change it and carry on from
there, as in Codex: the agent forgets everything from that message on,
the files it changed since are put back, and the edited text is sent as
if the rest had never happened (Mike, 28 Oct 2026, picked undoing files
too).

`threads.edit { threadId, seq, text, images? }`, in order:

1. **Checks.** `seq` must be a `user.message` that Mike sent (no `origin`,
   or `"phone"`; not a message from the runner, a schedule or an agent),
   that started its own turn (it comes before the `turn.started` with its
   `turnId`; one sent into a running turn went into that turn, and can't
   be cut out of it alone), and that isn't already hidden by a
   `thread.rewound`. Otherwise `-32602` saying why.
2. **Stops the thread.** A running turn is interrupted and the edit waits
   for it to end. Messages queued behind it are dropped (they came after
   the edited one); one sent while the edit is under way waits and goes
   after the edited message. The CLI is released, background work and all.
   As going back needs a fresh CLI, background shells and sub-agents
   can't survive it, even ones started turns before the edited message
   (an upload Mike lost that way, 4 Nov 2026). So while the thread has
   any (`background` in its summary), the edit is `-32050`, before
   anything is stopped or cut, with what's running in `message` and
   `data.background`; the client asks Mike and sends it again with
   `stopBackground: true` to go ahead, which stops them with a
   `system.note` saying what.
3. **Cuts the conversation.** The message's `turnId` is the id the agent
   got it under. Claude: the runner finds that id in the session's
   transcript and the next start resumes at the entry before it (the Agent
   SDK's `resumeSessionAt`), so the CLI writes the rest of the
   conversation as a new branch. Codex: `thread/revert` with
   `beforeTurnId`, the Codex turn that message started (the runner sends
   its id as `clientUserMessageId`, which Codex keeps on the turn's user
   message). A message the current native session doesn't have (the
   thread moved to another login or provider since) is `-32602`. Editing the
   session's first message starts a fresh session, with a handoff note
   when the thread has messages before it.
4. **Undoes files.** Claude sessions keep file checkpoints
   (`enableFileCheckpointing`), and the runner rewinds them to that
   message (`rewindFiles`): every file the session's Edit and Write tools
   (sub-agents' too) changed since goes back, and files they made are
   deleted (`how: "checkpoint"`). When there are no checkpoints for it (a
   session from before this, and every Codex thread), the runner reverses
   the `edit.diff` events after the message itself, newest first
   (`how: "diffs"`); a file that has changed since in a way the diff
   doesn't fit is left alone and listed in `failed` with the reason.
   Changes made by shell commands are never undone.
5. **Records it.** A `thread.rewound` event (`fromSeq` = `seq`, `toSeq`
   its own seq - 1, `files`), then the edited text starts a new turn as a
   `user.message` with `editOf: seq`. The thread's open asks, pending
   reviews and panel request from the cut range go.

Everything that reads the thread afterwards leaves the cut events out:
the app's transcript, `read_thread`, handoff notes, Highlights (its pins
stay), the librarian, and what the phone mirror sends from then on
(messages it had already sent stay on the phone for now). `threads.events` still returns them, so
a client can show what was cut if it wants to. A later edit can cut back
further, across an earlier `thread.rewound`.

## Who started a thread

A thread that turns up without Mike having started it leaves him with no
idea why it exists. `ThreadSummary.startedBy` says who did; his own threads
(the app, the phone) don't have one.

| `kind` | `label` | From |
| --- | --- | --- |
| `tool` | what the tool calls itself ("Sentry") | `tb new --from NAME [--why WORDS] [--icon SYMBOL]`; `icon` is an SF Symbol |
| `thread` | "Agent" | `create_thread`, or `tb new` from inside a thread; `threadId` and `threadTitle` name it |
| `schedule` | "Schedule" | a schedule; `ThreadSummary.schedule` has the details |
| `librarian` | "Librarian" | the librarian's fix threads, which it no longer starts (see No fix threads); older threads keep it. `threadId` and `threadTitle` name the thread Mike said it in |
| `runner` | "Threadbear" | a notice from the runner itself, such as a dialog left on a Mac's screen |

The row marks such a thread with the kind's symbol (the tool's `icon`) before
its project or folder, which every row names, and the symbol's tooltip says
who started it and `why` ("Started by Sentry (network blip, sorted)"); on the
phone that's its VoiceOver label. Until 4 Nov the line itself read "label ·
why"; Mike wanted the project back. `why` is a few words: why it was started,
from the starter, until an `end_turn` with `byline` replaces it with how it
came out. A `byline` in a thread with no `startedBy` is dropped. Threads from before
this have none, and `tb new` outside a thread with no flags could be Mike at
a terminal, so it has none either. Mirrored to the phone's row from backend
API 22, and to another runner's sidebar row on a Mac from API 23.

## Who archived a thread

A thread archived on purpose looks the same as one cleared out of the way
unless something says so, and a sweep (the nightly retro, an agent tidying
up) can't tell a thread Mike confirmed from one an agent or Threadbear put
away. So every archive records who did it, as `archivedBy`:

| `archivedBy` | From |
| --- | --- |
| `mike` | the default: the Mac app (the done card, ⌘E, a row's box, a swipe), the phone, the website, `tb archive` at a terminal |
| `agent` | `update_thread`, `end_turn`'s `archive`, `tb archive` from inside a thread |
| `threadbear` | the runner itself, such as a dialog notice archiving itself once it's gone |

The done card's Archive, on the Mac, the phone and the website, opens a
menu: Worked, Didn't work, Not needed. Only a pick archives (Mike chose a
forced choice from mockups, 5 Nov), and it goes as `verdict` (`worked`,
`didntWork`, `notNeeded`), kept as `archiveVerdict` and said in the thread as
a `system.note` ("Archived by you: it worked."). ⌘E, a swipe and a row's box
archive straight away with no verdict. A verdict from anyone but Mike is
dropped. Both fields are set afresh by each archive and only reported while
`archivedAt` is set, so bringing a thread back needn't clear them; threads
archived before 5 Nov have neither. `read_thread` and `list_threads` say
them ("archived by the user: it worked"). The phone and website send
`verdict` only to a backend of API 42 or later.

## What Mike last asked

A thread's summary carries `asked`: the last message Mike sent it, at the
Mac or from his phone, as one line of at most 140 characters. Messages he
didn't write leave it as it was: the runner's own (`origin: "runner"`), a
schedule's, and another agent's (`sentByAgent`). A design review's reply
is his notes, joined, or "Picked <option title>" when he left none. It's
absent until he's sent something. A thread from a runner before it learns
it from the last 300 events of its log when the runner starts, unless it's
archived. The Mac app's sidebar shows it as the tooltip of the line under a
thread's title ("You: ..."). That line names the thread's projects or
folder: Mike tried `asked` there (3 Nov), then the thread's `preview`, and
went back to the project on 4 Nov. A thread's row in the backend carries
`asked` too, from API 31, and so does a `threadIndex` row, from API 32, so
a Mac's tooltip has it for another runner's threads. The phone doesn't
show it.

## Needs you

A turn the agent finished can say whether Mike has to do anything, so
"Needs you" only holds threads that are really waiting on him.

A turn that left sub-agents or a workflow going (`background` entries of
kind `agent` or `other`, finished ones included until they're read) isn't
waiting on him yet, whatever it said: what they find can change what the
agent asks (Mike, 2 Nov 2026). `needsYou` stays false, the sections keep it
under Running, and the phone's thread document leaves `needs` out until
they're done. `needs` and `asks` stay on the summary, so the card shows if
he opens the thread and he can answer early. A question or approval the
agent is stuck on (`status` "waiting") still counts straight away, and shell
jobs and monitors don't hold anything back: one is often watching for Mike
to do what he was asked. The stuck-job check (Stuck background jobs) wakes
the thread if a sub-agent stalls, so an ask can't stay hidden for good.

- **The tool.** Every thread's own agent (not its sub-agents) has
  `end_turn` in the `threadbear` tools: `{ needs?: "you" | "nothing",
  summary?: string[], asks?: { action, reply?, why?, options?,
  suggested?, links? }[], next?: string[], archive?: boolean,
  byline?: string }`. `byline` is under "Who started a thread".
  The asks are the agent's "What I need from you" list, written there
  instead of in its message: each is one paragraph, `action` its first
  sentence (one concrete thing to do, or a question) and `why` the rest
  (what it's about and what the agent wants back, so it makes sense to
  Mike when he has forgotten everything; the tool's schema requires it,
  the runner still takes an ask without one). `reply` is the words the
  agent wants back ("done"). `where?` (the app, site, file or person) is
  no longer in the tool's schema, as the paragraph says it, but the
  runner still takes it from sessions that kept the old tool,
  `options` up to six likely answers and `suggested` the index of the
  agent's own pick (dropped unless it points at an option). `links` (up
  to three) are where to go to do it or judge it, `{ title, url }`: a web
  page (`http(s)://`), a file or folder on Mike's Mac (`file://`, an
  absolute or `~` path), or `review:<id>`, one of the thread's design
  reviews (the id `show_options` returned, letters, digits and dashes);
  anything else is dropped. The app shows a
  picture, PDF, text file or page in the pane, opens a review's window as
  its card does, and opens anything else (a
  folder, a `.tandem` project) in its own app. A review link has no
  hover peek and isn't sent to the phone (only `http(s)` links are). Mike,
  30 Oct 2026: a card's buttons opened three videos, but nothing on it
  opened the stills the agent had put up to compare. The agent calls it last, after its final
  message. The tool's description says when, so a resumed session that
  kept its old system prompt still hears it.
- **One reply.** `Settings.oneReply: true` (1 Nov 2026,
  docs/reply-card-design; on by default and out of Settings since 2 Nov,
  when Mike found it struck the right balance). Mike found the card
  repeating the message above it (thread 6fb15afc), and in other turns
  carrying all the context because the bullets had replaced a message
  that came only as narration (77e7a0a6, and an explanation he asked for
  that never showed). The agent was told to write the context three
  times, each standing alone, and couldn't know which one he'd see; in
  1,507 real turns 70% of whys repeated a message that showed, and in
  38% of turns with bullets the agent's own words never arrived. With
  one reply, `end_turn` comes first and the reply after it: `{ headline?,
  needs?, asks?: { question, options?: { label, does? }[], suggested?,
  links? }[], next?, archive? }`, then the agent's message, which is the
  turn's reply. A message with no tool call after it is never narration,
  and models write their answer there anyway; in 32 eval sessions none
  lost its reply and 2 wrote it twice (inside `end_turn` instead: 9),
  with a quarter fewer output tokens than bullets
  (`~/dev/me/misc/end-turn-eval/v3`). Nothing is refused for want of a
  reply, as it comes next: the accepted result says "Now write your
  reply" (`ONE_REPLY_NEXT`), and the runner, seeing it, keeps the turn's
  text after it, streams it, and writes it with `final: true`; thinking
  before it is kept too and folds into the work. Claude's result also says
  the user never sees its thinking, so what the asks are about (a draft to
  approve, the options weighed) goes in the reply in full, and when the
  turn has words since its last step (`turnReply`), that they folded away
  too and are to be written again in full (`WROTE_FIRST`): on 5 Nov 2026
  Opus twice wrote a Slack draft or three designs as narration before
  `end_turn`, then replied "Nothing has been sent yet." under a card
  asking about them (thread 1d9689e6). The app shows the final
  text as the turn's reply whatever else the turn wrote. An ask's
  `question` is its `action` (no why), and its answers' labels are
  `options`, their `does` notes `optionNotes` in the same order ("" for
  none); the card draws an ask with notes as rows, a circle, the label,
  "my pick" on the suggested one and the note under it, in a box. The
  preview is `headline`, else the reply's first line. A reply that ends
  in a "What I need from you" section (a heading, bold or bare) or a
  "Nothing needed from you" line, under an `end_turn` with no asks or
  next of its own, loses it, and the card comes from it instead
  (`splitReplySection`): Sonnet wrote one there in a quarter of its eval
  sessions. Under an `end_turn` that has asks, a "What I need from you"
  section loses its place too, and the card stays `end_turn`'s, so a reply
  can't say what the card under it says (`replyWithoutRepeat`; Mike took
  thread 7ac017b7's repeats on 3 Nov 2026 for it not having used the card).
  A section listing more asks than the card is left in, as it says
  something the card doesn't, and so is any prose after its list. Claude's session doesn't name `end_turn` in
  `CLAUDE_CODE_TERMINAL_MCP_TOOLS`, and its Stop hook asks once for the
  reply when the turn took `end_turn` and wrote nothing after it, or for
  `end_turn` alone (the message already written being the reply) when it
  never called it. That second nudge is the adapter's `endTurnNudge`
  output, and the `end_turn` it brings answers "Stop here" rather than "Now
  write your reply", if the turn has words of its own since its last step
  (`oneReplyAlreadyWritten`): told to write one anyway, agents wrote a second
  message that took the first's place, in 13 of 84 turns on 1 Nov 2026, one
  trading 2,359 characters for 96. Text after it is dropped, as with
  any "Stop here". Codex calls it before its final answer as before, and
  its final answer is the reply. The setting is read when a CLI starts;
  Bullet replies doesn't apply to a one-reply session. Neither provider's
  agent is sure to be shown today's form of `end_turn`. A Codex thread's
  tool list is fixed at `thread/start`, restarts included. A Claude
  session keeps each tool's definition from when it first loaded it,
  through every resume, whatever the server lists by then; `ToolSearch`
  shows that one too, and `tools/list_changed` changes nothing, even live
  (tried on CLI 2.1.316; thread 1b770c6a was refused with a bare zod error
  on 1 Nov 2026, and could only find the shape in this file). So the
  runner goes by the form a call was written in (`endTurnForm`:
  `asks[].question` or `headline` is one reply; `asks[].action` or `why`,
  or `summary`, is bullets; neither follows the setting), and only
  threads started since get today's form. Codex's handler answers in that
  form. Claude's CLI ends the turn at an accepted `end_turn` only with
  bullets, so today's form answers, reading either form's asks: under one
  reply, a call in the older form is told "Stop here" if its message is
  already written (`oneReplyAlreadyWritten`, so the Stop hook doesn't ask
  for another and its bullets don't replace it) and to write its reply if
  not. With One reply off, a one-reply call is refused until it has
  written a message (`NO_REPLY`). Claude's server lists today's form but
  lets any arguments through its own validation, so the handler does the
  checking: what fits neither form hears today's shape and order in words
  (`endTurnMisfit`).
- **Trying a step first.** Every form's description tells the agent to try
  a step with its own tools before giving it to the user, and to hand it over
  only when it really needs them or after a real attempt, saying what it
  tried (`TRY_IT_FIRST`). A card with an answer like "Can you do it?"
  (`offersToTakeItBack`, by its label) is refused once a turn, with an error
  result that starts `Not ended: this card offers`, asking for a try if there
  hasn't been one. Called again, it's taken as it is, button included. Nothing
  reaches the app. It can't tell whether the turn tried, as turns are busy with
  other work, so it asks; and it can't see a hand-over written as plain prose
  or with no such answer on the card.
- **Bullet replies off.** `Settings.bulletReplies: false` (runner.json
  only since 2 Nov; Mike, 30 Oct 2026: he liked the folded working but not always
  the bullets in place of the agent's message). `end_turn`'s description
  has the agent write a normal message and treats the summary as the short
  version; a session reads that when its CLI starts. For a live one, the
  handler refuses bullets with no message (`NO_REPLY`), and when the
  message reached Mike only as narration asks for it again (`NARRATION_ONLY`),
  keeping what follows at any length. Codex's handler asks for its whole
  final answer. The runner marks the summary event `givesWay: true`, and
  the app then shows any of the turn's messages as the reply, however short.
  So it's per turn: earlier turns stay as they were. Previews, notifications,
  the phone and `read_thread` still use the bullets.
- **The summary.** `end_turn` also takes `summary?: string[]`: two to
  five short markdown bullets of what the turn did and found, which Mike
  reads first (29 Oct 2026, after Codex desktop: the least context to
  load, then what's next). When an accepted `end_turn` has one, the runner
  writes it into the thread straight after the call's `tool.result`, as
  an `assistant.text` with `summary: true` (`itemId` the call's plus
  `.summary`, `text` the bullets as a markdown list). So it is the turn's
  reply everywhere: the preview, notifications, the phone, the website,
  `read_thread`. The Mac app folds the turn's other `assistant.text`
  into its working, so the turn reads as one line of work, the bullets,
  then the Needs you card. Once any turn is over (`turn.completed`), the
  app shows it as Mike's messages, one "Worked for 2m 13s" line holding
  everything else, its reply, errors, a review still waiting, pictures
  the agent made, the changes card, the footer and the card (Mike, 29
  Oct: like Codex desktop). The reply is the turn's messages after its
  last step and before its taken `end_turn`, when they're longer than
  the summary; else the summary; else its last `assistant.text`. A
  `narration: true` text never beats the summary, as it's only the API's
  paraphrase of what the agent wrote (30 Oct 2026: one about a list of
  names showed instead of the bullets). A step is a tool call outside the `threadbear` tools and `ToolSearch`,
  counted from its `tool.result` too (a message written while it ran
  isn't after it); a `user.message` sent into the turn counts as one, and only an
  `end_turn` after it ends the answer (30 Oct 2026: the runner's "app
  restarted" landed between an `end_turn` and the message it asked
  for). Words beat a narration paraphrase with no summary too.
  Text after `end_turn` never counts. The line of work goes above the
  reply, and holds the summary when the message won. On 29 Oct 2026 the
  bullets alone hid two answers: a turn that only explained something
  showed "Explained the choice above" over the folded explanation, and a
  Sentry triage report folded away under bullets that never said what
  was broken. A sign-off line is shorter than the bullets, so they still
  win over it. While it runs, its work shows as it always has.
  A turn started by a `user.message` with `origin: "runner"` (the app
  restarted, a hook ran, a resume, a carry-on) joins the turns before it
  back to the last message that started a turn of its own (Mike's, a
  schedule's, another agent's): one line of work holding all of them and
  the notes between (their earlier summaries and the runner's messages
  too), one reply (the last summary, plus the last `assistant.text` of
  any later turn, each picked as above), one changes card and one footer with their time and
  cost added up. A note from an edit (`thread.rewound`) stays out.
  A wake-up, a turn the CLI started itself as a background job ended, joins
  the same way, but its summary doesn't take the last one's place: it
  gets a reply of its own under the one before, as nothing tells it to cover the
  stretch. On 1 Nov 2026 a wait that timed out woke an agent after its answer,
  and "still waiting on you" replaced that answer on the phone (thread
  9bc89060). A wake-up keeps the Stop hook's `end_turn` nudge, as it can
  change what Mike needs. The phone tells a wake-up from the turn before by
  its rows' `turn` (backend API 26); rows from before that read as one turn. From
  backend API 33 the first row of a wake-up carries `wokeBy` (its
  `turn.started`'s), and the phone draws the same "6 min later · Mine the repo
  finished" divider as the Mac, timed from the rows either side. The
  `end_turn` description tells the agent that in such a turn its summary
  takes the place of the last one, so it covers everything since Mike's
  message, and its work links can quote steps from those turns (Mike,
  29 Oct: an app-restart check left two summaries with notes between
  them). Text after the call is dropped as before
  (Claude), with one exception: when the turn has no message since its
  last step, so the bullets are all Mike has, the accepted result says
  only "Stop here, with no more text: the user has your bullets", words
  the runner knows it by. It used to ask the agent to write whatever the
  bullets stood for but it hadn't written, and every agent took that as
  "write a message": all 14 such turns in the next four hours wrote a
  prose repeat of their bullets, which showed in place of them. On 30 Oct 2026
  Opus called `end_turn` with "Put together the details you'll need
  for the Qantas call", wrote the details after it, and the runner
  dropped them, twice (thread 2a0a9c2c). The runner keeps the first own
  `assistant.text` after such a result when it is longer than the
  bullets (unstreamed, so a shorter sign-off it drops never flashes up),
  and the app takes text after `end_turn` as the reply, by the rule
  above, in a turn with no other words. No wording in the bullets tells
  reliably whether they point at more, so the message is kept when it
  comes, not asked for. Codex's final answer, which still follows its `end_turn`,
  folds away like the rest and doesn't take over the preview. Up to 8
  bullets of up to 400 characters are kept; a leading `-`, `*` or `•` is
  taken off. Why not just ask for bullets in the final message: in 36
  test sessions Opus 5.5 wrote a prose paragraph every time, as it
  often sends its last reply as a narration block, and in `end_turn`
  every one came back as bullets (docs/end-turn-design).
- **Links into the thread.** A summary bullet (or any message, or an
  ask's markdown) can link `work:<words>`, a step in this turn's working,
  `thread:<id>`, another thread by id or id prefix, and `review:<id>`,
  one of this thread's design reviews by id or a prefix that fits only
  one (its window opens). Spaces are fine
  inside the parentheses. The app opens the turn's work group, scrolls to
  the step and lights it up: the last step whose command (or one of its
  `&&` parts) starts with the words, else the last whose command,
  description, file path, pattern, input title or text mentions them,
  else the last whose output does, else the last thought that does. The
  input title is a Codex computer-use step's name ("Reconnect to Chrome
  desktop"), as its row only says "cua_repl: js"; without it, links to
  those steps beeped. Thoughts come last, and words inside a message's
  own `work:` links don't count, as Opus drafts its summary, links and
  all, in its thinking (at times a message too) just before `end_turn`:
  as the latest mention, that took the links from their steps (29 Oct
  2026). The agent can't see its tool calls' ids, so it quotes the step:
  models quoted the command, the command's description and their own
  lines while working, and every quote landed in the tests. The phone
  opens the turn's working in a sheet instead, and picks the step the same
  way from what it has, a step's one line: a command with a description
  comes as only the description, so a quote of the command finds nothing
  and the sheet opens with no step lit. A `review:` link says it opens on
  the Mac. The website has the same one-line steps on the page: a work:
  link scrolls to its step, and is only its words if it finds none; so is
  a `review:` link, and a `thread:` link on a shared page, as whoever it's
  shared with can't open the others.
- **Needs from the asks.** `needs` may be left out: asks mean `you`,
  none mean `nothing`. Agents filling in a summary forgot it 2 times in
  9.
- **Once a turn, or once a message.** A second `end_turn` after an accepted
  one in the same turn is refused ("Already ended") and changes nothing; Opus
  once sent its card four times. A `user.message` since then opens the turn
  again, as it's owed an answer of its own (a message sent during a call that
  came back accepted counts, since the agent can't have read it), so that
  message's `end_turn` is taken and its card replaces the last. A repeat with
  no new message that adds `archive: true`, where neither call has `needs:
  "you"`, is taken too, and adds only that; the first card stands.
- **A reply first.** `end_turn` is refused (an error result) until the
  turn has replied to Mike: a `summary` in the call itself, or an own `assistant.text` after the turn's last
  `tool.result` from a tool outside the `threadbear` server, and after
  its last `user.message`. The thread's own tools (`pin`,
  `update_project`, a refused `end_turn`) and `ToolSearch` (which loads
  a deferred tool's schema, often `end_turn`'s own) say nothing he has
  to read, so a message, then `pin`, then `end_turn` is fine; a progress
  line, then more work, then `end_turn` is not. An agent that drafted its answer in
  thinking and went straight to `end_turn` left Mike a folded work group
  and a card, twice in one thread (28 Oct 2026). A reply Claude sent as
  a thinking block signed as narration is an `assistant.text` (see
  Transient events), so it counts; a thinking block signed as thinking
  doesn't. When the only reply was such a block (`narration: true`,
  whose text is only a summary of it), or the last was and no words
  came after the last tool call of any kind (a status line, then
  `read_thread`, then the answer as narration, 29 Oct 2026), and there
  are no summary bullets,
  the accepted result asks for the message again in full, and the
  text after it replaces the summary. The SDK runs a tool as
  soon as it reads the call, at times a few frames ahead of the runner's
  log, so the handler waits up to a second for its own call to land
  before judging; one that never lands (a sub-agent's, which the events
  never see) is acknowledged. The refusal asks for the complete answer
  and any supporting evidence in ordinary text. Keep that reminder about
  the result Mike needs, without asking the model to reproduce internal
  reasoning.
- **Codex calls it before its answer.** Codex's final answer ends its
  turn, so nothing can be called after it. Told to call `end_turn` after
  its final message, Codex never once did, and GPT-6.1-Sol wrote the call
  into its answer instead, raw tool-call tokens and all (28 Oct 2026). So
  a Codex thread's `end_turn` (`buildThreadbearTools`' `provider:
  "codex"`) asks for it as the last tool call, just before the final
  answer. It is never refused for want of a reply, as the reply comes
  next, and its result doesn't start like an accepted one, so the runner
  keeps the answer written after it. Codex threads started before then
  keep the old description, which was fixed at `thread/start`; for them,
  the Codex normalizer cuts a tool call written into a message (from its
  first ` to=functions.` token to the end) off the text.
- **Ending on the tool.** Claude Code nudges a model whose reply after a
  tool result has no text ("[Your previous response had no visible
  output. Please continue and produce a user-visible response.]"), and
  `end_turn` is that tool result in every turn, so every Claude turn
  ended with the nudge and a throwaway "I've marked this thread as done"
  under the real answer. The runner names `end_turn` in the CLI's
  `CLAUDE_CODE_TERMINAL_MCP_TOOLS`: a successful result from a tool named
  there lets the model's empty reply end the turn quietly (CLI 2.1.312;
  older CLIs ignore it and nudge as before). A refused `end_turn` is an
  error result, which doesn't count.
- **Next steps.** With `needs: "nothing"` (said or worked out),
  `end_turn` also takes `next?: string[]`: follow-ups in this thread
  worth doing, each the message Mike would send to start it. The runner
  keeps up to three distinct strings of up to 120 characters on the
  `turn.completed` (`next`), and drops them with `needs: "you"`, as a
  card of asks has buttons of its own. The Mac app's done card shows
  them as buttons before Archive; one puts its words in the composer
  (after anything already typed) rather than sending, so a stray click
  never starts a turn. The description asks only for ones that really
  came up, never made-up work (Mike, 30 Oct 2026: a follow-up in the
  closing prose, over a card that only offered Archive, got forgotten).
- **Archiving itself.** `end_turn` also takes `archive?: true`. With
  `needs: "nothing"`, a turn that completes archives its own thread once
  it's over, with a `system.note` saying why; the thread can't archive
  itself mid-turn, as that stops the CLI. It's ignored with `needs: "you"`,
  on an interrupted or failed turn, and when a message is already queued.
  A message sent into the turn after that call cancels it, until an `end_turn`
  asks again, so a thread doesn't go while Mike is still talking to it.
  The description tells agents to use it only when Mike asks, so a thread
  he hadn't finished with doesn't vanish from his inbox.
- **Hibernating itself.** `end_turn` also takes `snooze?: string`: when
  to wake, as `update_thread`'s `snooze` takes it (`30m`, `2h`, `1d`,
  `tomorrow`, an ISO time, `restart`), or else words (`"when the phone
  arrives"`), which go to `threads.hibernateWhen` as if Mike had typed
  them into Wake when…. It applies on the same terms as `archive`: once a
  completed turn with `needs: "nothing"` is over, with no message queued,
  and a `system.note` says until when. `archive` wins if both are given.
  A time that has passed, or words the model can't read, leave the
  thread in the inbox with a note saying why. `"off"` and words over 300
  characters are refused, so the agent can say it again. A repeat
  `end_turn` that adds `snooze` gets through as one adding `archive`
  does. On 2 Nov 2026 "let's hibernate this thread until it arrives" could
  only be met by a helper thread, as `update_thread` and `tb snooze`
  refuse to snooze the thread they run in. The description also has an
  agent hibernate when what's left waits on another thread or a job that
  will message it back (a message wakes it, see `threads.send`), with a
  time by which that should have happened. On 5 Nov 2026 a thread
  waiting on another thread's report ended as done in Mike's inbox,
  as the description then allowed it only when he asked.
- **Waiting on threads.** `end_turn` also takes `waitFor?: string[]`, up
  to 5 thread ids (or unique prefixes) on this runner, with `needs:
  "nothing"`. Once the turn is over it hibernates on the same terms as
  `snooze`, with `waitingOn` on its summary and a `system.note`
  ("Hibernating until "X" finishes, or <time> at the latest."). `snooze`
  is then the latest it wakes, as a time (words aren't read here); left
  out, a day. A named thread is done once it has finished a turn (its own
  or one its CLI opened after a job ended) with `needs: "nothing"`,
  nothing queued, no sub-agent or background job running and no `snooze`
  or `waitFor` of its own, nor a job that ended mid-turn whose result
  turn is still to come, with no new work since; or has been archived
  or deleted. The runner keeps each thread's last finish and its reply on
  the thread (`finished` in thread.json) and drops it at any new work (a
  message, a review's answer, going back to an earlier message, any turn
  starting, including one its CLI opens), so no clocks are compared: waiting on an
  idle thread that has finished wakes at once with that reply, and one set
  going in the waiting turn counts only when it finishes that. The waits
  are checked whenever one could have come true: a finish, an archive, a
  delete (on a draining runner too), a new wait, a thread coming across
  from a draining runner (after its own carry-ons there), and once a
  starting runner is listening, not before (`holdWaits`: a woken thread's
  tools aren't ready). A thread named in `waitFor` that's on another
  runner of this Mac (found in the threads folder) is waited on all the
  same, and checked when either comes across. Once
  every one is done the thread wakes (a "Woke up … finished." note) and
  gets a `user.message` with `origin: "runner"` naming each with up to
  2,000 characters of the reply it finished with. A message, a wake or
  another snooze first clears `waitingOn`, so a thread that sends its
  report wakes it as before and its finishing later does nothing. An
  entry can be `{ thread, until }` instead of an id: `until` (up to 200
  characters, read on after "until": "it reports the I/O saving") is what
  it waits for that thread to have done. Such a wait ignores finishes and
  is done when a librarian look at that thread says it's `met` (see the
  librarian's `waited-on` look), or the thread is archived or deleted;
  the wake-up message quotes `until` and the librarian's reason. The
  handler refuses its own id, an archived thread, an unknown id and
  `needs: "you"`; one gone by the time the turn ends is left out with a
  note, and if none are left the thread stays in the inbox. Any refused
  `end_turn` after one it took (either form) leaves the first one's card,
  not just `ALREADY_ENDED`. Before 5 Nov 2026 a thread waiting on another
  thread could only end as done in Mike's inbox and hope to be messaged.
- **The fallback.** A completed turn with no `end_turn` call is read for
  the "What I need from you" section Mike's own instructions ask for: the
  last line near the end that is just that heading in bold, then its
  numbered or bulleted items, one ask each. An item's quoted reply words
  (`reply "done"`) are its `reply`; a list of them (`Reply with "Land
  it", "Website, then land it", or…`) is its `options`, one each. A
  heading with no list whose text says nothing is needed counts as
  `nothing`. So does a closing "Nothing needed from you right now" with
  no heading. Either way, a list after the "nothing" (with at most a line
  of lead-in, like "Two follow-ups are worth doing:") is the turn's
  `next`, each item's first sentence, three at most. `needsFrom` says which
  it was. Neither found: no `needs`, and the turn counts as today.
- **Ending without it.** The Claude adapter's Stop hook sends a thread's
  own turn back once when it ends with no `end_turn` taken, asking for the
  call alone, as its message is already the reply. Not while background
  work it started is still running (the turn that work wakes ends it),
  nor a second time (`stop_hook_active`). Codex's final answer ends its
  turn, so it gets no such check.
- **What decides `needsYou`**, in order: an approval or question waiting;
  a thread marked unread; then a finished turn after `lastSeenSeq`,
  unless that turn said `nothing`.
- **Only completed turns.** An interrupted or failed turn says nothing.
  A sub-agent's `end_turn` (Claude's are never in the thread's events;
  Codex's carry the child's prefix, `<child>/<id>`) is ignored.
- **The open card.** The last turn that said `you` has the open card:
  the summary's `asks` (each with `ticked?: true`) and `asksSeq`. Any
  later turn closes it (a completed one that says `you` opens the next),
  and older cards keep the ticks their last `asks.ticked` gave them.
  Ticking never sends anything: a reply is Mike's to write, and one reply
  often answers several asks.
- **Answering.** The app shows the open card's asks under the agent's
  last message, each as one paragraph of message text (`action`, a full
  stop if it has none, then `why`; numbered like a list when there are
  several), then its links as buttons and its options (or its `reply`),
  and Something else. A `where` goes on a quiet line under the paragraph.
  Mike found a bold title over a small grey reason backwards (28 Oct):
  the reason is part of the ask, in the agent's own words, at full size.
  The action's line breaks go, as it's a sentence, but the why keeps
  its own, so a list of questions in it draws as a list (29 Oct: four
  questions run together in one line were hard to read).
  The paragraph is markdown, and the tool's description asks for the
  words that name a link's target to link to the same place (29 Oct), so
  Mike can open it from the sentence as well as the button. Resting the
  pointer on any link in transcript text, or on a link button, shows a
  card of where it goes (a file's thumbnail, a page's address). Picking one puts it in
  the composer as a chip. Something else opens a box under that ask, with
  the cursor in it: what he writes there, and any pictures he pastes,
  drops or adds with its picture button, is that ask's answer. Any number
  of asks can have one (30 Oct 2026: with the composer as the only box, a
  second Something else took the first one's place, so he could only
  answer one ask in his own words; of the five designs he picked a box
  per ask, and asked for pictures in them). Return in a box sends, as in
  the composer. The composer is for anything else, and a message with no
  picks is just a message. Send makes one ordinary message, each picked
  ask's question then its answer, numbered in the card's order, then
  whatever he wrote in the composer, and passes the picks as `answers` so
  the app can show them as answers. The boxes' pictures go first in the
  message's `images`, in the card's order, then the composer's. A box
  takes pictures as chips where the cursor is, as the composer does, so
  each is a `[Picture N]` marker in its answer, numbered across the card
  (Pictures in a message), and the agent gets it right there; one with
  no chip goes at the end of its answer. Until 1 Nov 2026 an answer
  ended "See picture 1." instead. A box he closes again keeps
  what's in it until the card is answered, but sends none of it. Words
  or pictures in a box hold up the app's restart onto a new build, as a
  draft does. The runner
  keeps `answers` on the `user.message` and otherwise treats it as a
  normal `threads.send`; the next turn closes the card as usual.

```ts
type Ask = { action: string; where?: string; reply?: string; why?: string; options?: string[]; optionNotes?: string[]; suggested?: number; links?: AskLink[] }
type AskLink = { title: string; url: string }
type AskAnswer = { action: string; answer: string } // an ask's action and the answer he picked
type OpenAsk = Ask & { ticked?: true }
```

## Secrets

Added 4 Nov 2026, after T3 Code's `request_secret` (its "Asking for a
secret" card). Before this an agent that needed a password, an API key or
a token had to stop and ask in its reply, and whatever Mike typed back
went into the transcript, the phone's mirror and Agent Archive. Codex's
own secret questions were declined (Codex approvals). Now:

- **The tool.** `ask_secret` (a threadbear tool, Claude and Codex alike)
  takes `label` (the card's title, "Mac administrator password"),
  `reason` (what it's for and where to find it), `placeholder?` and
  `timeoutMinutes?` (default 10, at most 60). It puts a card up and
  waits. The agent never gets the value: it gets a file path, an owner-only
  file under `<home>/secrets/asked/` (0600 in a 0700 folder), plus an
  askpass helper beside it (`<file>.askpass`, 0700, a two-line script that
  prints the file), so `SUDO_ASKPASS=<helper> sudo -A ...`, `SSH_ASKPASS`
  and `GIT_ASKPASS` work without the value ever being in a command line.
  Otherwise the agent reads the file inside its command
  (`TOKEN="$(cat <file>)" wrangler whoami`). The tool's text tells it
  never to print it. Declined, timed out, or the turn stopped: it says so,
  and the agent can ask again.
- **What the card promises.** The value is kept out of the chat, not out
  of the agent's reach: its commands can read the file, and a command
  that prints it puts it in the transcript. The card says so ("Kept out
  of chat, in a private file this agent's commands can read for 24
  hours"), as T3's does for its file delivery.
- **The event.** `secret.requested` (persisted): `approvalId`, `itemId?`
  (the tool call's), `label`, `reason`, `placeholder?`. It's a pending
  approval like any other (the thread is `waiting`, it's in Needs you, a
  message from Mike declines it first, Stop or a restart expires it),
  closed by `approval.resolved` with `answered`, `deny` or `expired`, never
  with a `message`. No event, log line, summary, mirror row or error ever
  carries the value.
- **Answering on a Mac.** `secrets.answer { threadId, approvalId, secret?:
  string, decline?: true }` → `{}`, over the same connection as
  everything else (loopback, or another runner's `wss://` on the
  tailnet). One of the two is required; an empty or whitespace-only secret
  is `-32602`. The runner writes the file before it resolves the card, so
  a failed write leaves the card open with the error.
- **Answering on the phone.** The Convex mirror never sees the value. The
  runner has an X25519 key pair (`secrets/secret-box.key`, 0600, made on
  first use). The thread row's `pendingApproval` for a secret is `{
  approvalId, kind: "secret", label, reason, placeholder?, key }`, `key`
  the runner's public key (raw, base64). The phone seals the value to it
  and calls `phone:secret { token, threadId, approvalId, sealed?: { epk,
  nonce, box }, decline?: true }` (backend API 35), which queues a
  `respond` command with `{ approvalId, decision: "answered" | "deny",
  sealed? }`. The runner opens it; `sync:finishCommand` drops `sealed`
  from the row whether or not that worked. A runner only puts a secret on
  the row for a backend of 35 or later (an older one's schema would refuse
  the write). A phone from before API 35 draws a card it doesn't know as
  Allow/Deny: its Deny declines the secret, and its Allow is refused with
  a note to update the app or answer on the Mac.
- **The seal.** The phone makes an ephemeral X25519 key (`epk`), agrees a
  shared secret with `key`, and derives a 32-byte key with HKDF-SHA256
  (salt `epk ‖ key`, info `threadbear secret v1 <approvalId>`), then
  AES-256-GCM with a random 12-byte `nonce`; `box` is ciphertext then
  the 16-byte tag. All base64. Binding the approval id into the key means
  a sealed answer can't be replayed onto another card.
- **Trusting the key.** A card's `runnerId` and `key` both come from the
  mirror, which the owner key can write for any runner (and, before
  runner keys, any runner's key could; see Runner keys), so the phone
  takes neither on trust. It seals only to a runner whose key it already
  keeps (keychain, by `runnerId`, per deployment), and it keeps keys only
  from the pairing link: `devices.pair` adds a `key=<runnerId>:<key>`
  item for the runner that drew the code (its `secret-box.key`, raw
  X25519, standard base64), and pairing keeps each, replacing any kept
  before for that runner. A card for a runner with no kept key is refused
  ("The phone doesn't know this Mac yet, so it won't send it secrets.
  Answer it on the Mac, or pair the phone again.") and nothing is kept
  from it. A different key from the kept one is refused with "This Mac's
  key changed. Answer it on the Mac." Keys kept before this rule (when
  the first key a card carried was kept) still count, so a phone that
  already answered a Mac's secrets goes on doing so. A pairing link from
  before keys still pairs, but its phone can't answer secrets until it's
  paired with a new code. A second Mac (one whose threads reach the phone
  through the same deployment) is trusted only on a phone that kept its
  key before, or once that Mac draws the pairing code. Every pairing
  link is asked about first, as any web page can open one: from the
  Camera, the pair screen's scanner or the clipboard, paired or not (an
  expired token leaves the phone unpaired, and that once let a link in
  unasked). The question names the server and says whether the Macs it
  may send secrets to change ("Pair with <host>?"); Cancel keeps the
  saved pairing and kept keys as they were. The phone also keeps
  the runner it first saw each thread on (keychain, by `threadId`),
  pinned when the thread first shows in a list or on a trusted secret
  card. A card on a thread whose `runnerId` differs from its pin is
  refused ("This thread's Mac changed, so the phone won't send it
  secrets. Answer it on the Mac."), since runners never take over each
  other's threads (a handover keeps the runner id). Deleting
  `secret-box.key` on purpose, or changing a runner's `sync.runnerId`,
  means pairing the phone again from that Mac.
- **Keeping.** Files and helpers go 24 hours after they're written: the
  runner sweeps the folder when it starts and hourly. Nothing else keeps
  the value: the runner holds it in memory only long enough to write it.

## Patches

A thread's folder can give it panels (shown beside the transcript) and
actions (chips above the composer); see docs/threadbear-design/README.md.
The runner works them out from the folder (`src/patches.ts`), nothing is
stored, and they come in the summary's `panels`, `actions` and `patches`,
so a client learns of them like any other change. The runner reads the
folder again in the background when the folder changes and otherwise
every 15 seconds at most (on the next summary it sends), and sends a new
summary if anything differs, so a `.env.local` that `convex dev` has just
written, or a patch file the agent has just saved, shows up within
seconds. A patch file that appears, loads again, breaks or is waiting
to be trusted after the first read is said in the transcript as a
`system.note`.

Patches are found by walking up from the thread's folder to the home
folder (so a thread in a package of a monorepo gets the project's), plus
`~/.threadbear/patches/` for every folder, plus every folder of every
project the thread is in (see Projects). Two kinds:

**Patch files**: `.threadbear/patches/<name>.ts` (or `.js`, `.mjs`). The
runner imports the module (Node runs TypeScript as it is; a changed mtime
loads it again) and reads its default export:

```ts
// .threadbear/patches/reseed.ts
export default {
  actions: [
    { title: "Reseed dev DB", run: "npx convex run seed:reset && npx convex import --replace fixtures/dev.zip" },
    { title: "Explain the schema", prompt: "Read convex/schema.ts and explain it to me." },
    { title: "App Store Connect", url: "https://appstoreconnect.apple.com/apps" },
  ],
  panels: [{ title: "Storybook", url: "http://localhost:6006", note: "while npm run storybook is up" }],
}
```

A patch file can have an `icon` at the top, an SF Symbol name that goes
on each of its chips (`icon: "pawprint"`), so a row of chips from several
patches shows which came from where; an action's own `icon` wins.
Panels without an icon of their own get it too. Instead of a symbol it
can be a picture: a path, relative to the patch file or from `~/`, to a
`.png`, `.svg`, `.icns`, `.pdf` or `.jpg`, or to a `.app` (its icon), sent
as `iconFile` (absolute) on the patch, its actions and its panels, and
drawn in full colour. A tool patch uses its tool's own icon this way
(`icon: "../../icons/tandem.png"`), so its rail button and chips are
recognisable at a glance. Chips
are grouped by patch, and a chip's tooltip names its patch.

`run` is a command for `actions.run` to run in the thread's folder,
`prompt` a message it sends instead, and `url` a web page (http or https
only) the app opens in the browser when the chip is pressed, with
nothing added to the transcript; exactly one of the three. Use `url`,
not `run: "open https://..."`, for a link: that leaves an `action.run` in
the transcript on every press. A panel needs a
`url` with a scheme, or an `items` function, which makes it a `list`
panel: rows drawn natively, with no page to serve.

```ts
  panels: [{
    title: "Worktrees", icon: "arrow.triangle.branch",
    // Called by panels.render, in the folder the patch applies from.
    items: async ({ cwd, threadId, sh }) =>
      (await sh("git worktree list")).split("\n").filter(Boolean)
        .map((line) => ({ title: line.split(/\s+/)[0], detail: line })),
  }],
```

`items` gets `{ cwd, threadId, sh }`, where `sh(command)` runs a command
in `cwd` through a login shell and resolves with what it printed (it
rejects on a non-zero exit). It returns `PanelItem`s (or a promise of
them). Give rows a `section` to group them under headings (rows of one
section next to each other, in the order you want the groups), and a
`trailing` for a date or count at the end of the line. A panel can have an `icon`, an SF Symbol name for its button on
the rail. A hook is a command the runner runs by itself, so in a
project's patch it's one script in the repo and plain words (see
"Trusting a folder's patches"):

```ts
  hooks: [
    { title: "Typecheck", on: "turn.end", run: "./scripts/typecheck.sh", edited: "**/*.{ts,tsx}" },
  ],
```

**Live state.** An action or panel can also have `when` and `badge`,
functions that get the same `{ cwd, threadId, matched, sh }` as `items`.
`when` hides it unless it returns something true (a chip that only turns
up when there's something to do); `badge` returns a count (a number, a
numeric string or a list, whose length counts), sent as the item's
`badge` when it's 1 or more and drawn on the chip or rail button. The
runner calls them each time it reads the patches, after every turn, and
every 20 seconds for an inbox thread that has any. Commands that two of
them run in the same folder run once per read, and the output is shared
with every other thread that runs the same command in the same folder
for 10 seconds (a run still going is joined, not started again), so live
state should be about the folder, not the thread. One that throws or takes
over 10 seconds hides its item (a `when`) or gives no badge, and its
patch's `liveError` says why. A panel can also have `summary`, which
returns a line or a list of lines (at most four, 120 characters each),
sent as the panel's `summary`: a tool patch's panels get a card at the
top of Highlights with the tool's icon, the panel's title and that
summary (or its `note`), which opens the panel, so a tool's state is in
the pane that's open by default rather than only on the rail.

```ts
  actions: [{
    title: "Your turn",
    prompt: "Do my comments in Tandem, then hand back.",
    when: async ({ sh }) => JSON.parse(await sh("tandem comments --json")).comments.length > 0,
    badge: async ({ sh }) => JSON.parse(await sh("tandem comments --json")).comments,
  }],
```

**Tool patches.** A patch with `appliesTo` (a name glob, or a list of
them, like `"*.tandem"`) belongs to a tool, not a place. It applies to a
thread only where a folder from the thread's own up to home (else from
one of its projects' folders) holds a matching name, and runs in that
folder, whichever folder the patch file came from. Besides the usual
places, the runner looks for tool patches in the `.threadbear/patches/`
of every project's folders, so a tool's repo can carry its patch: Tandem's
lives in Tandem's repo, and any video folder with a `.tandem` file gets
it. The patch's `matched` lists the paths that made it apply, and
functions get them as `matched` (a folder with two `.tandem` projects
has two).

`on: "turn.end"` (the one trigger so far) runs it after each turn the
agent completed, in the thread's folder like an action, and its output
goes into the transcript as an `action.run` with `trigger`. With
`edited`, only after a turn that edited or wrote a file matching that
glob (from `edit.diff` paths and Edit and Write calls). `tell` says when
the result also goes to the agent, as a `user.message` from the runner
(`origin: "runner"`) that starts a turn: `"failures"` (the default) when
the command failed, `"always"`, or `"never"`. The message names the hook
and the patch, carries the last 8 KB of output in a code block, and asks
the agent to fix it if it's theirs. One hook is told at most twice in a
row (a hook that keeps failing is then only posted) and a message from
anyone else starts the count again, so a hook and an agent can't go round
for ever.

Ids are the file's name plus a slug of the title
(`reseed.reseed-dev-db`), and two entries in one file can't share one.
Panels from different places that would share a title, like the Convex
dashboards of two of a project's folders, each get their folder's name
after it (`Convex · web`, or `Convex · apps/web` when the folder names are
the same too), so their tabs and rail buttons say which is which. A
file whose export doesn't fit is listed in `patches` with an `error` and
gives nothing. A project's file only loads once it's trusted (below).

### Trusting a folder's patches

A patch file is code. Importing it runs it, and its hooks, live state
functions and worktree `setup` then run by themselves, so without a gate
opening a thread in a repo someone else wrote would run that repo's code
before you'd said a word. The runner only imports a project's patch file
(`src/patch-trust.ts`) once that version of it is trusted, the way VS
Code and Claude Code ask before running a folder's code. Until then it's
in `patches` with `untrusted` and `hash`, and gives nothing: no actions,
panels or hooks, no live functions, and no worktree for new threads.

- Trust is kept per folder (the one holding `.threadbear/`) as the
  SHA-256 hashes of the patch files trusted there, in `patch-trust.json`
  in the data dir. `untrusted` is `"new"` when nothing from that folder
  is trusted and `"changed"` when an earlier version was: a pull brought
  a new one, and it's asked about again.
- A git worktree counts as its main checkout, so a thread's worktree of
  a trusted repo isn't asked about. Only one git made: its `.git` file and
  the repo's record of it must name each other, so a folder can't claim
  to be a worktree of a trusted repo.
- A patch file a Claude thread's agent writes with an Edit or Write call
  is trusted as that edit left it: the agent can run anything in the
  folder already. Only an edit the CLI says it made counts, when its
  successful result comes in, never the diff shown to approve one, so a
  denied or failed edit trusts nothing. And only the bytes it wrote: the
  hash of the file rebuilt from the result (a Write's content, an Edit
  applied to the original text it reports), which the file must still
  have, in the same read the trust hash is made from. A file written
  over after that (a command run straight after the edit) isn't
  covered, and one the result can't be rebuilt for waits. Nor does one
  edit vouch for files it didn't write: the patch is trusted only when
  every other file its hash covers (its helpers, the scripts it names)
  is bytes that were part of a version trusted while the runner has run,
  or another such edit's. A patch Codex writes waits for Mike: its
  result doesn't say what bytes it wrote, so a command could have
  replaced the file before the runner read it. One written another way,
  like a shell heredoc or a `git pull`, waits.
- Always trusted: `~/.threadbear/patches` and Threadbear's own checkout
  (the release's `checkout`, else the one the runner runs from).
- `patches.trust` trusts what the app showed, by hash. Clients show a
  waiting patch with a way to read its file and trust it.
- A runner's first start with this (no `patch-trust.json` yet) trusts
  the patch files of every thread's folder and every project's as they
  are, since it was already running them.

The hash covers the patch file and the local files it imports, and
theirs in turn (specifiers starting `./`, `../` or `/`), so a pull that
changes only a helper is asked about too, and `helpers` lists them so the
app can say what else would run. It also covers any existing file the
patch or a helper names in a path starting `./` or `../`, anywhere in its
text, from the patch's own folder or the folder holding `.threadbear/`
(where commands run), each place that has it: the script a worktree
`setup`, `check`, hook or action `run` calls, so a pull that changes only
that script asks again. What a named script runs in turn is followed
and hashed too (below, "What a script runs"), and a named file that
isn't there yet changes the hash when it turns up. A patch with no
local files hashes as its own text alone.

**Only code is hashed.** A file the patch, a helper or a script merely
names (a string, an argument, `$(cat VERSION)`, `< data.txt`) goes in
the hash only if it looks runnable: an extension of `.sh`, `.bash`,
`.zsh`, `.ksh`, `.command`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`,
`.cts`, `.tsx`, `.jsx`, `.py`, `.rb` or `.pl`, the executable bit, or a
`#!` first line; a missing one counts only with one of those
extensions, or with no extension in a command's place (`./bin/tool`).
Anything else (`./state.json`, `.cache/state.json` by the repo's
absolute path, notes, pictures, folders) is data and isn't, so a patch
that writes its own state file isn't asked about again after every
run. What something runs, sources or loads is hashed whatever it looks
like: an import, a file `sh`, `bash`, `node` or `bun` is given
(`sh ./x.json`), a `source`d file, the `package.json`, `.npmrc` and
the like a package script runs from, a Makefile. The limit: a hashed
script's behaviour can still depend on the data files it reads, which
can change without asking. Trusting a script trusts what it does with
its data, so a script that runs what a data file says (`sh -c "$(cat
cmd.txt)"`) still fails closed, as below. A command that runs by itself
(a `setup` or hook) must still be one hashed script, so naming a data
file there refuses the patch as before. Packages (`node:fs`, anything
from `node_modules`) aren't followed: they're the folder's dependencies.

A patch whose code can't all be seen isn't loaded at all, trusted or not,
and has `error` (not `untrusted`) saying why, as a stored hash can't vouch
for code it didn't cover: one that loads code by a name worked out as it
runs (`import(name)`, `` import(`./${x}`) ``, `require('./a' + b)`, any
`createRequire`, `node:module`, `node:vm`, `node:worker_threads`, `eval`,
a `data:` or `#` specifier), in the patch file or a helper, one the runner
can't parse, or one that reaches more than 100 local files. Loads are read
from the parsed syntax (oxc), so comments and strings don't count either way. `patches.trust` can't trust it; changing it to plain
imports can. An agent's Edit or Write to a helper carries on the trusted
patches that import it, as it does for the patch file (only with the
helper as that edit left it); it doesn't trust a patch that's still
waiting. A trust file from before helpers counted
(`version: 1`) is read as it is: a patch with no helpers is still trusted,
and one with helpers is asked about again (`"changed"`), as version 1 never
saw them. A changed helper is only imported again when the runner restarts
(Node loads a module once per process); the patch file itself loads again
when it changes.

What's imported is what was hashed. The hash is made from one read of
each file, and a trusted patch and its helpers are imported from those
bytes (`src/verified-imports.ts`, Node's module hooks), never read from
the folder again, so a command that rewrites one between the check and
the import changes nothing that runs. Imports are told apart by how
they're written: a local one (`./`, `../`, `/`, `file:`) loads the very
file the hash followed it to, from the hashed bytes, whatever a symlink
points at by then (into `node_modules` too), and one the hash didn't
follow refuses the patch; a bare one (a package, a workspace package
under `packages/`, `node:fs`) resolves as Node resolves it, unhashed, as
packages are the folder's dependencies. A cached hash holds only while every file it was
made from has the same inode, size, mode, mtime and ctime (a write
can't put ctime back), every path to one still leads to the same real
file, and nothing that was missing has turned up. A hook or `setup`
runs its script from the folder, so the patch is hashed afresh just
before it runs, and it's skipped with a `system.note` if that isn't the
version that was trusted.

So trust covers the bytes of the patch and the code it names, checked
right before they run. What a trusted script does as it runs (the files
it reads, copies or generates, like `cp ./payload.txt ./stage.sh && sh
./stage.sh`) is trusted with it, and a change another process makes
while it runs isn't caught: the same as running a shell script you've
reviewed.

A new thread's worktree `setup` runs only when the worktree's own copy of
the patch, with the files it names as they are there, is a trusted
version, and it's that copy's `setup` that runs: the worktree is main's
commit, which can differ from the main checkout that was trusted.
Otherwise the setup is skipped with a `system.note` saying why, and the
thread starts in the worktree anyway.

**Commands that run by themselves.** A project patch's worktree `setup`
and its hooks run without anyone pressing anything, so the hash has to
cover what they run, and it can only see a path written in the patch.
So each must be one script and plain words: a `./` or `../` path from
the folder holding `.threadbear/`, to an existing file inside the repo
(the git toplevel) that the hash covered, then arguments made only of
letters, digits and `_ @ % + = : , . / -`. Anything a shell would work
out first (`cd scripts && ./setup.sh`, `FOO=1 ./x`, `sh -c`, `bash x.sh`,
`npm run x`, `npx tsc`, pipes, `;`, `$(...)`, quotes, globs, a path
worked out in code) could run a file the hash never saw, so the patch
isn't loaded at all, trusted or not: its `error` starts `Not run:`,
names the command and says to put the steps in a script. The runner then
runs the script by its absolute path (a hook's `exec`), every word
quoted, from the folder holding `.threadbear/` (`cd '<folder>' &&
'<script>' ...`), so it's the hashed file that runs, and the folder its
own relative paths were followed from: a hook in a thread in a subfolder
runs the patch folder's `./scripts/x.sh` from the patch folder, not the
subfolder's. Home's patches and Threadbear's own checkout are trusted
whatever they hold, so their commands run as written.

**What a script runs.** A trusted `./setup.sh` that runs `./helper.sh`
must not run a changed helper unasked, so from every script a patch
names, the runner follows what it can run or read in the repo and hashes
it with the patch (`runner/src/script-trust.ts`), up to 300 files and 12
scripts deep:

- Shell scripts (by `#!` or `.sh`/`.bash`/`.zsh`), read with a small
  shell lexer: a command that's a path (`./helper.sh`,
  `"$(dirname "$0")/x.sh"`, `${0%/*}/x`, `"$DIR/x"` after
  `DIR="$(cd "$(dirname "$0")" && pwd)"` or `$(git rev-parse
  --show-toplevel)`), `source`/`.`, `sh`/`bash`/`zsh` with a file or a
  literal `-c`, `node`/`bun`/`deno`/`tsx` with a file, what `env`,
  `exec`, `nice`, `nohup`, `timeout`, `taskpolicy`, `xargs`,
  `find -exec` and the like run, `trap` with literal code, and the
  `$(...)`s in words, assignments and unquoted here-docs. A `cd` to a
  path it can work out is followed, so later relative paths resolve.
- Package scripts by a literal name: `npm run x`, `npm test`,
  `yarn x`, `pnpm x`, `bun run x` hash the nearest `package.json` and
  follow that script (and its `pre`/`post`) as shell from the package's
  folder; `npm ci`/`install` (any package manager) follows the
  lifecycle scripts (`preinstall`, `postinstall`, `prepare`...) of the
  package, its workspaces and its `file:` dependencies; `npx x`/`bunx x`
  hash `package.json`. `.npmrc`, `.yarnrc(.yml)`, `bunfig.toml`,
  `.pnpmfile.cjs` and `pnpm-workspace.yaml` beside it are hashed, and
  code they load followed.
- `make`: the Makefile (and literal `include`s) is hashed and every
  recipe line followed as shell, `$(MAKE)` as `make`.
- JavaScript and TypeScript: imports, as for patch files, and every
  plain string that's the path of a file of the repo's that looks
  runnable (`spawnSync('bash', ['scripts/x.sh'])`).
- Any other file of the repo's a script names (an argument, `< file`,
  a `./` path anywhere in its text) is hashed if it looks runnable
  (above, "Only code is hashed").

What it can't follow, it doesn't guess at: `eval`, `alias`, `bash -c` or
`trap` with code worked out as it runs, `$(cat "$f")` or `$(< "$f")`, a
shell, `node` or `bun` reading its program from a pipe or a here-doc
(`curl ... | sh`), a command in a variable or a pattern (`$CMD`,
`"$f"` in a loop, `./s/*.sh`), `source "$1"`, relative paths after a
`cd` to somewhere worked out as it runs, `npm run "$x"`, `npx "$x"`,
workspace-wide runs (`-w`, `--filter`, `-r`), `node -e`, `--require`
of a module worked out as it runs, a file that isn't there yet
(`./build/out.sh`), another language (`python3 x.py`, a `#!` that isn't a
shell or Node), an awk program that runs commands, `$(shell ...)` or
`SHELL` in a Makefile, and setting `PATH` to a folder in the repo,
`BASH_ENV`, `NODE_OPTIONS` that loads code and the like. A worktree
`setup` or hook that names such a script fails closed: the patch isn't
loaded, trusted or not, and its `error` starts `Not run:` with the file,
line and what it couldn't follow. An action naming one still loads, as
an action runs only when pressed.

Programs on PATH and packages aren't followed, as installed: what one
loads from the repo by its own rules (a test runner's tests, a linter's
config, `npx bddgen`'s config) is the folder's to change, as
`node_modules` is for patch files. So a script should run only tools
it's fine to run on the repo as it is then.

**Commands a patch writes.** An action's `run` isn't held to the
one-script rule: it runs only when someone presses its chip, which shows
the command. But what it runs is hashed however it names it, not only
past a `./` path: every string in the patch and its helpers (an
action's `run`, `sh("node scripts/stats.mjs")` in a live function, the
fixed parts of a template) is followed as a shell command from the
folder holding `.threadbear/`, as above, and every file of the repo's it
runs or loads goes in the hash (a data file it only names doesn't), so `node scripts/deploy.mjs` asks again when
only `scripts/deploy.mjs` or one of its imports changes (Daybreak
verify-fix, 5 Nov). A command that can't be followed (`eval`, say)
still loads; what it names is hashed. A trusted-by-hash patch's command
actions run from the folder holding `.threadbear/` (the action's
`folder`), where they were followed from, and one whose command is
worked out in code (`'node ' + f`) and reaches a file the hash didn't
cover refuses the whole patch: its `error` starts `Not run: its action`,
names the file and says to write the command as plain text. Nor is
`check` held to the one-script rule, which runs when `tb land` does (the
Land chip, or an agent that could run anything anyway); it's followed
the same way. A live function (`items`, `when`, `badge`, `summary`) is
the patch's own code, hashed with it, and `sh` runs what that code says.

### Trusting a folder's Claude Code hooks

The runner starts Claude in a thread's folder with that folder's own
settings, `.claude/settings.json` and `.claude/settings.local.json`, and
its `.mcp.json` (the folder's, and those of the folders above it, up to
home). Some of what they hold is a command Claude runs by itself: `hooks`
(a SessionStart hook runs as the CLI starts), `statusLine`,
`subagentStatusLine`, `fileSuggestion`, `apiKeyHelper`,
`proxyAuthHelper`, `awsCredentialExport`, `awsAuthRefresh`,
`gcpAuthRefresh`, `otelHeadersHelper` and `extraKnownMarketplaces`, and
an MCP server with a `command` or a `headersHelper`. The settings' `env`
counts too, as a whole: nothing in it runs, but any variable can send
Claude's traffic and the user's login elsewhere (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY`, `HTTPS_PROXY`, `CLAUDE_CODE_USE_BEDROCK` and its
endpoint, `OTEL_*` exporters) or load code (`NODE_OPTIONS`, `PATH`).
Claude Code in a terminal asks before trusting a folder; the SDK never
does, so the runner asks instead (`src/claude-trust.ts`), with patch
trust's store and rules.

- A folder whose settings have none of those (permissions, a model,
  plugins switched on) asks nothing, and nothing changes. Nor does home,
  whose `.claude/settings.json` is the user's own.
- Otherwise the hash covers those parts, by file, and the files inside
  the folder that their commands or variables name
  (`bun .claude/hooks/start.mjs`, `"$CLAUDE_PROJECT_DIR"/scripts/x.sh`, a
  server's args, `NODE_OPTIONS=--require ./x.js`), hashed and not
  followed. Settings with commands and no `env` hash as they did before
  `env` counted, so trusting them holds. A settings file that isn't plain JSON counts whole. It's kept
  in `patch-trust.json` in the folder's list, as `claude:<hash>`, under
  the same folder key, so a worktree counts as its main checkout and
  Threadbear's own checkout is always trusted.
- While that version isn't trusted, a Claude thread's `patches` has
  `{ id: "claude-settings", source: "claude", file, untrusted, hash,
  helpers? }`: `file` is the first file with something that runs,
  `helpers` the other files and the scripts. Codex threads don't get it.
- A Claude session starts without the folder's project and local
  settings (`settingSources: ["user"]`), and gets them back without the
  parts that run and without `env`, merged as Claude merges them, as flag
  settings (the SDK's `settings`), so permission rules and the rest still
  apply. Flag settings can set what Claude ignores from a repo's own, so
  those are left out of the copy too: `autoMemoryDirectory`,
  `modelPicker`, `footerLinksRegexes`, `spellcheck`, and `sandbox`'s
  `ripgrep`, `filesystem.disabled`, `network.strictAllowlist` and
  `credentials` `allowPlaintextInject`, `awsPairs` and `sigv4`. The
  folder is named as an extra directory with
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, which brings its
  CLAUDE.md back without its settings. What doesn't come: the folder's
  `.claude/skills`, `agents` and `commands`, CLAUDE.md files above the
  folder, and `.mcp.json` servers. The thread gets a `system.note` saying
  so, once per version.
- `patches.trust` with that `file` and `hash` trusts it. A session that
  started without them is replaced by a fresh one (resuming the same
  conversation) at the next message, as is one that started with them
  when a new version arrives that isn't trusted. A CLI's own turns
  between messages keep what it started with.
- An agent's Edit or Write to one of the settings files trusts them as it
  leaves them; to a script they name, only when an earlier version was
  trusted, as with a patch's helpers. Either only with the file as that
  edit left it, and every other file the settings' hash covers bytes
  trusted before or another such edit's, as for patch files.

**Built in**, from the folder alone:

| patch | when | panel |
|---|---|---|
| `convex` | a folder with `convex/` and a `package.json` or `convex.json` beside it (a bare folder called `convex` isn't enough) | `convex.dashboard`, a `url` panel: `https://dashboard.convex.dev/d/<name>` for the `CONVEX_DEPLOYMENT` in `.env.local` (then `.env`), `http://127.0.0.1:6790` for an anonymous local deployment, the dashboard's front page with no deployment yet. A cloud deployment's panel also has `convex`, with the deployment's URL from the `.env.local` (then `.env`) line ending `CONVEX_URL` (`CONVEX_URL`, `VITE_CONVEX_URL`, ...). Only those lines of the file are read |
| `xcode` | a folder with an `.xcodeproj` or `.xcworkspace` | `xcode.simulator`, an `image` panel drawn by `panels.render` |
| `worktree` | a thread with a worktree of its own (see Worktrees) | no panel: the action `worktree.land`, "Land", which runs `tb land` |

A client shows what it can: a `url` panel in a web view, an `image` panel
by asking `panels.render` now and then while it's on screen, a `list`
panel the same way (when it's shown and every 15 seconds while it is),
and an unknown `kind` as a page if it has a `url`.

### The Convex panel

Convex's own dashboard wants Mike's Convex login, a browser session the
panel's web view doesn't have. So a client that can shows Convex's
[embedded dashboard](https://docs.convex.dev/platform-apis/embedded-dashboard)
instead, `https://dashboard-embedded.convex.dev`, which takes a deployment
and a deploy key rather than a login: the deployment's pages (data,
functions, files, schedules, logs, history, settings), without the team's.
The client gets the key with `panels.convexKey` and answers the page's
`dashboard-credentials-request` message with `{ type:
"dashboard-credentials", adminKey, deploymentUrl, deploymentName }`. The
Mac app does it from a script in that web view alone, which only answers
on that origin, with a website data store that isn't saved to disk. Open
in browser opens the selected deployment's full dashboard.

The Mac panel's deployment menu lists the configured deployment plus
Development and Production from `panels.convexDeployments`, showing both
the label and deployment name, after the Convex project's name when the
panel has one. It remembers the choice on this Mac by
the configured deployment, so threads in the same project share it.
Switching changes only the panel; `.env.local` and the runner's mirror
settings stay as they are. Older runners without the listing method
keep showing the configured deployment.

A deploy key is admin of its one deployment, so it never goes into a
thread's events, the summary, the log or the Convex mirror: only
`panels.convexKey`'s answer, on the local connection. The runner makes
one per deployment, named `threadbear-panel-<host>-<6 hex>` (names are unique on a deployment), and Mike can revoke
it in the deployment's settings on the Convex dashboard (the runner notices
the next time the panel opens and makes another; the panel's "New deploy
key" button does it at once).

The runner's Convex CLI is signed in once by setup, but a login can be
missing (a fresh Mac, another runner) or expire. Then `panels.convexKey`
fails with `-32040` and the Mac panel offers Sign in to Convex instead of
the CLI's error: it calls `panels.convexLogin`, opens the `url` it answers
with, shows the `code`, and polls with `check` until it's done, then loads
the dashboard. `-32041` (the login can't reach the deployment) gets Sign in
as someone else, the same with `force`. No terminal either way.

## Highlights

The Mac app's right-hand rail (like VS Code's secondary side bar) has a
button per panel, Patches at its foot, and Highlights at its head: what a
thread has made, shared and pinned for Mike, so it doesn't scroll away
with the transcript.

```ts
type HighlightKind = "file" | "link" | "pr" | "commit"
type Highlight = {
  id: string            // "<kind>:<path, url or sha>"
  kind: HighlightKind
  title: string         // the file's name, a link's text (else host and
                        // path), "owner/repo#12", a commit's first line
  url?: string          // link, pr
  path?: string         // file: absolute
  how: "pinned" | "written" | "opened" | "mentioned" | "created" | "committed"
  note?: string         // a pin's reason, in the agent's words
  show?: true           // a pin the agent asked to have shown straight away
  sha?: string          // commit: short sha
  branch?: string       // commit
  pushed?: true         // commit: a later git push in the thread sent its branch
  seq: number           // the event it was first seen in (a pin: lastSeq then)
  lastSeq: number       // the latest event that mentioned it
  at: string            // when it was first seen
}
type ThreadHighlights = {
  highlights: Highlight[] // pins first, then the rest newest first: at
                        // most 80 (pins are always kept)
  edited: string[]      // files the thread edited, absolute, newest first,
                        // at most 200
  brief?: { text: string; at: string } // the librarian's line on where
                        // the thread is up to (see Projects)
}
```

The runner finds them in the thread's events, with no model, the first
time a client asks and then from where it got to:

- **Files written**: a `Write` (or Codex file change) of something Mike
  would look at rather than code: `.md`, `.html`, `.pdf`, images, video,
  `.csv`, `.txt`. Code goes in `edited`.
- **Opened**: each file or URL a command passed to `open` (`open -a App`
  skips the app). A relative path is taken from the thread's folder and
  must exist.
- **Mentioned**: links in an `assistant.text` (Markdown links and bare
  URLs) and absolute or `~/` paths of files that exist (in a link or in
  backticks). A GitHub pull request's URL is a `pr`.
- **PRs created**: pull request URLs in the output of a command that ran
  `gh pr create`.
- **Commits**: the `[branch sha] message` line `git commit` prints. A
  later `git push` that prints `a..b branch -> branch` (or `[new branch]`)
  marks that branch's commits `pushed`.

**Pins.** An agent pins with the `pin` tool: `{ path? | url?, title?,
note?, show? }` (a path relative to its folder is fine; it must exist).
A pin of something already found is the same item, now pinned. `show`
asks the app to open it in the pane now, so an agent shows Mike a
mockup there instead of running `open`. `unpin { id }` takes one off
again. The tools' descriptions say when to use them.

**The brief.** The librarian's look (see Projects) also answers with a
line or two on where the thread itself is up to, kept on the thread and
sent as `brief`. No extra model call: it's the same look.

### Worktrees

A repo can ask for each new thread to get a git worktree of its own
(docs/thread-worktrees.md has the why and the details). A patch file's
default export says so, beside its actions:

```ts
export default {
  worktree: {
    setup: "./scripts/setup.sh",    // run in the new worktree before the first turn; optional
                                    // (one script and plain words: see "Trusting a folder's patches")
    check: "./check.sh --quick",    // run by `tb land` before main moves; optional
  },
}
```

The first patch in the thread's own folder chain with a `worktree` wins;
`~/.threadbear/patches/` and project folders never count. The repo is the
git toplevel of the folder holding `.threadbear/`, and its main checkout
is the one with `main` checked out. A malformed `worktree` (not an object,
or a `setup` or `check` that isn't a command) is the file's `error`.

A new thread in such a repo (from `threads.create`, `create_thread` or a
schedule, unless `worktree: false`) gets, before its first turn starts:
`git worktree add -b thread/<id8> <parent>/<repo>-threads/<id8> main` from
the main checkout (`<id8>` is the thread id's first 8 characters), a `cwd`
in the same subfolder of it, `setup` run in its root (an `action.run` with
`trigger: "worktree.setup"`, under the first turn; a failure is shown and
the turn goes on), and a few lines in the agent's appended system prompt
saying where it is and that `tb land` puts it on main. If the worktree
can't be made (a leftover folder or branch of that name, no checkout on
`main`), a `system.note` says why and the thread starts in the folder
asked for. The summary carries `worktree` from then on.

`tb land`, in the worktree, refuses with uncommitted changes, rebases on
main (a conflict aborts and names the files), runs `check`, then
`git merge --ff-only` in the main checkout (refused, and nothing changed,
if main's own uncommitted changes are in the way) and prints what landed.
It never pushes. `--dry-run` stops before main moves.

When the thread is archived or deleted, a worktree whose branch is on main
(or has nothing of its own) is removed with its branch; otherwise both stay,
with a `system.note` saying how to land or drop them. A thread whose
worktree was removed carries on in the main checkout, with a note.

## Showing panels

An agent puts one of the app's panels in front of Mike with the
`show_panel` tool, `{ panel, where? }`, when what he should look at is a
panel rather than a file or a link (those are `pin` with `show`). It opens
the panel, or brings it to the front wherever Mike put it. It never moves
or resizes a panel that's open: Mike's layout is his.

`panel` is `highlights`, `browser` (`threadbear.browser`) or `patches` (the thread's own; Patches only when
it has patches), one of the thread's `panels` by id or title (any case),
or `usage`, `updates` or `connectors` (the app's Usage, Updates and
Connectors panels). `where`
says where a closed one opens: `tab` (a tab beside the thread, which
closes again when the main panel moves on, as a review's does), `left`,
`right`, `top` or `bottom` (along that side of the window), or `window`
(a window of its own). Without it, a closed panel opens where the app
would put it: a thread's panels beside its other open ones, else down
the right; Usage, Updates and Connectors under the threads list. An open panel
ignores `where`.

```ts
type PanelRequest = {
  id: string            // the request's own id
  panel: string         // "highlights", "patches", "usage", "updates", "connectors", or one of the thread's panels' ids
  title: string         // the panel's name: "Highlights", "Convex"
  where?: "tab" | "left" | "right" | "top" | "bottom" | "window"
  at: string            // when the agent asked
}
```

The runner checks the name (an unknown one is the tool's error, listing
what the thread has), keeps the request on the thread as `panelRequest`,
replacing an older one, and sends the summary. The app shows it once Mike
is looking at the thread: the app is in front and the thread is the one
in the main panel (a thread open in a panel of its own doesn't count, as
the side panels follow the main one). That's straight away if he already
is, or else when he next opens the thread or comes back to the app. Then
the app calls `threads.panelShown`, which clears it. A message from Mike
(typed, or from his phone; not a runner, schedule or agent message)
clears it too: he has seen the reply it went with. The tool waits up to 2
seconds for `threads.panelShown`, so its answer says whether Mike has the
panel in front of him now or will when he next looks.

During a handover the request stays with the thread on the runner that
has it, and the primary passes `threads.panelShown` on as it does any
thread's request.

`tb show-panel <threadId> <panel> --json` exposes this to local tools through
the authenticated `threads.showPanel` RPC. The primary checks the Mac app's
connection before forwarding to a draining runner. An unavailable app leaves
no request. An accepted request can be pending without changing the selected
thread, and its `shown` field says whether the app already acknowledged it.
The Mac app advertises `browserPanel: true` in `hello`; a Browser request
returns unavailable for older apps that cannot promise this handoff path.

BrowserBear uses this only for `handoff`, after checking that the exact Chrome
tab/profile can be displayed. It marks the tab Your turn and keeps it in the
Browser panel, including when the panel wasn't previously open. Without a
connected Mac app or a displayable profile, it uses Chrome's native window.
The Mac app also opens Browser when its selected thread has a tab marked Your
turn. That waiting tab survives the one-shot request being cleared by a message,
so a later return to the thread still shows the handoff. A new handoff selects
its tab once; reopening preserves any tab the user picked afterwards.

### The Browser panel

The Mac app's Browser panel uses BrowserBear's existing private Unix socket
(`~/Library/Application Support/BrowserBear/browserbear.sock`). Its
`panelState` command reports connected Chrome profiles and pages associated
with threads by ordinary BrowserBear commands. Profile names and emails stay
visible in the panel; choosing one opens a new tab in that exact profile.
The page keeps its existing Chrome session. No cookies, passwords, OAuth
tokens, or browser profile files are imported.

A persistent socket begins with `{id,cmd:"panelAttach",thread,args:{tab,profile}}`.
BrowserBear verifies the thread owns that tab and, on reconnection, that its
CDP target identity still matches. `panelCdp` carries the page's input and
display commands; `panelWindow` pauses the panel for Chrome's native window.
Replies use `{id,ok,result|error}`. Events use `{method,params}`: page frames,
dialogs and `panelError`. The tab and its exact profile instance identify the page. `panelResume` is an
explicit return/reconnect action, and `panelShowChrome` opens its native window
even when capture failed. Only one panel can control a given tab. Closing the
connection stops capture and removes the panel's viewport and focus overrides.
Chrome detaching the debugger stops the panel without reattaching it.

Frames are captured sequentially through the existing extension, with socket
backpressure; they aren't stored or mirrored to Convex. BrowserBear stores
thread/tab/profile/target associations and cached page titles in `panel-tabs.json` (0600) so a
service restart can reconnect a page without trusting a reused tab number.
Viewport changes and captures are serialized so resizing cannot race a frame;
input and dialog answers bypass that render queue. Existing profiles render at
least 360 CSS pixels wide, scaling the picture and input into narrower panels.
Native-window and debugger Stop states persist across remounts and require an
explicit return/reconnect. A user-owned tab requires an explicit Show this tab
here action before the panel changes its viewport. With BrowserBear extension 0.3.6 or newer, popups are associated only by
Chrome's exact opener tab identity in the same profile. Older extensions keep
using the panel for ordinary pages, with new windows opening in Chrome.
Dialogs already open at attach are replayed, and a heartbeat keeps a displayed
JavaScript dialog attached until it is answered.
The separate `--profile agent` Chrome retains its existing direct CDP path.

## Connectors

Mike's agents get MCP services from his Connectors gateway on Bruce
(~/dev/me/connectors) and from claude.ai's connectors on each login.
Either can need signing in again. The runner watches the gateway so the
app can show what's signed in, and turns a sign-in error in a thread into
an ask (below).

**Where the gateway is.** runner.json's `connectors.url` (any URL on it;
the base is used), else the `connectors` MCP server's `url` in the main
login's `~/.claude.json` (only that field is read). `connectors.url: ""`
or `connectors.enabled: false` turns it off, as does
`THREADBEAR_CONNECTORS_URL=off` (tests); `THREADBEAR_CONNECTORS_URL`
set to a URL wins over both.

**Status.** The runner asks the gateway's open `GET <base>/health` every
3 minutes, and when the app passes `refresh` to `connectors.status`
(the panel opening, or its refresh button). One ask at a time, 5
seconds at most. The app never calls the gateway itself.

```ts
type ConnectorsStatus = {
  // off: no gateway set up. checking: no answer yet. unreachable: the
  // last ask failed, and error says how in a few words.
  state: "ok" | "unreachable" | "off" | "checking"
  url?: string          // the gateway's base, https://host:port
  checkedAt?: string    // when the last ask finished
  error?: string
  version?: string      // the gateway's, from /health
  release?: string
  services: ConnectorService[]   // empty unless ok
}

type ConnectorService = {
  id: string            // "notion"
  title: string         // "Notion"; from the id when the gateway sends none
  // unknown: a state word the runner doesn't know (message says more).
  state: "connected" | "signed_out" | "connecting" | "error" | "disabled" | "unknown"
  message?: string
  connectUrl?: string   // where Mike signs it in; set on anything not connected or disabled
}
```

`/health` is read leniently: `upstreams` may be a map of id to state
word (the first gateway: `ready`, `needs_sign_in`, `idle`, `connecting`,
`error`, `disabled`) or a list of `{ id, title?, state, message?,
connectUrl? }`, and unknown fields are ignored. A service with no
`connectUrl` of its own gets `<base>/admin/connect/<id>`. A relative one
is made absolute against the base; anything but http(s) is dropped.

The app's Connectors panel lists the services with their state and a
Connect button (Reconnect for one in `error`) that opens `connectUrl` in
the browser. Its icon in the activity bar gets the accent dot while a
service is `signed_out` (only Mike can fix that), and a grey dot while the
gateway is unreachable or a service is connecting or in error (those
usually sort themselves out).

**Sign-in errors in a thread.** A sign-in problem comes from where a tool
result came from and whether the call failed, never from what the result
says: what a connector reads (an email, a Notion page) is anyone's words,
and an email saying "Gmail needs signing in again" made an ask until 5
Nov. So (`connectors.ts`, `signInSignal`):

- claude.ai's: a failed call to one of that server's own tools
  (`mcp__claude_ai_Gmail__*`) whose result starts with the CLI's auth
  error, `MCP server "claude.ai Gmail" needs you to sign in again`
  (optionally after `Error:`). The service is the name without
  `claude.ai`; the page is `https://claude.ai/settings/connectors`,
  signed in as the thread's login. A result that worked never counts.
- the gateway's: a call to a signed-out service's stub tool
  `mcp__connectors__<prefix>__sign_in`, or a failed call to any of a
  service's tools (`mcp__connectors__<prefix>__*`, not the gateway's own
  `connectors__*`). That only names candidates: the prefix, and the id in
  any `/admin/connect/<id>` link in the result (a prefix can differ from
  its id, `cf` for `cloudflare`). The runner then asks the gateway's
  `/health` afresh, and only a candidate it lists as `signed_out` is a
  problem, with `/health`'s title for it and its connect page. No gateway
  set up, or no answer from `/health`: no problem, and the agent's own
  reply is all Mike sees.

When the thread's agent calls `end_turn` and the turn so far has a
sign-in problem that no ask covers (an ask covers it when one of its
links is the page, or its action or why names the service), `end_turn`
is refused once that turn, with an error result that starts `Not ended
yet: this turn ran into`, names each service and its page, and asks for
an ask with that page as a link if the work needs it. Called again, it's
taken as it is. Nothing new reaches the app: the ask is an ordinary one.

## Projects

A project groups threads above folders: it can have several folders, a
thread can be in several projects, and it keeps `goals`, `state` and
`notes` that carry forward from thread to thread. Nobody has to make one:
the librarian and the agents do. Kept in `projects.json` in the data dir;
which projects a thread is in is kept with the thread.

**Patches.** A thread loads patches from, in this order: `~/.threadbear/`,
each folder of each of its projects (the built-in ones and the patch
files found walking up from it, each folder once), then its own folder
as before. Anything from a project folder has `folder` and `projectId`
set and runs in that folder; a hook from one only runs after a turn that
edited a file inside it, matched against its `edited` glob relative to
it. Two items that would share an id get the folder's name in front, the
later one only (`poddle:convex.dashboard`). A thread in a git worktree
reads a project folder in that repo's main checkout from the worktree's
copy of it instead, and skips it when its own folder already covers it:
the main checkout is the same repo on another branch, so loading both
gave every chip twice.

**The brief.** A session is told about its thread's projects once each.
A fresh session (a new thread, a move or account change that starts a new
native session) gets the brief as instructions: each project's title,
folders, goals and state, at most about 2,000 characters in all, and that
`read_project` has the notes. Claude gets it appended to the system
prompt, Codex as developer instructions. A live or resumed session (Claude
Code ignores new instructions on a resume) hears about a project it hasn't
been told about at the start of its next message, in a line beginning
`[Threadbear project]`; a session from before projects existed gets the
whole brief that way. An agent that joined a project itself isn't told.

**The librarian** is the runner's own background job that keeps projects
up to date, on the small model (`models.*`, feature `projects`, inside the
daily budget, never for private folders). It looks at a thread when:

- its first message comes in (`first-message`), 5 seconds later, so a
  thread is filed while a long first turn is still going; that look
  never changes a project's state;
- its first turn ends (`first-turn`), 10 seconds later;
- a turn edits files outside its folder and its projects' folders
  (`new-folder`), 10 seconds later;
- it moves folder (`moved`);
- it has had turns since the last look, 20 minutes after that look at
  the soonest (`catch-up`). A catch-up is skipped, with no model call, when
  those turns edited no files, ran no commands in a repo outside its
  folder and its projects' folders, gave no link and said fewer than 400
  characters between Mike and the agent; it counts in `skippedToday`, and
  what they said still counts towards the next one;
- someone asks (`librarian.run`, `asked`);
- another thread is hibernating until it has done something (end_turn's
  `waitFor` with `until`): after any completed turn, its CLI's own too,
  10 seconds later (`waited-on`, never skipped as quiet). The look lists
  those threads and their `until`, and its answer's `met` (`{ "<id>":
  "what shows it has" }`) marks each wait done (`waitMet`), with this
  thread's latest reply; the waiter wakes once all its waits are done. A
  private folder's thread gets no looks, so a wait on one only ends at
  its time.

Those come from the runner's events, and a turn that ends in an older
runner draining after a handover is only heard there. So on start and
every 5 minutes the librarian also queues any thread active in the last
two days with a finished turn it hasn't looked at since (`first-turn` or
`catch-up`).

A thread its own agent or Mike has put in a project (`by` other than
`"librarian"`) is theirs to file: its looks still keep its line and the
state of its projects, but never add or take out a project. Every
thread's agent is told, in the Threadbear tools' instructions, to
`join_project` early and keep the state current with `update_project`.

One look at a time, the soonest due first. A look sends the model the
project list (title, folders, goals, one line of state) and the thread's
title, folder, first message, last few messages and the folders it edited
in, and gets back the projects the thread belongs in with a short reason
for each, a new project when none fits, and a new `state` for a project
the thread moved on. What it decides takes effect straight away: the
thread gets `projects` (`by: "librarian"`, `why` the reason, replaced by a
later look's) and a `system.note` saying so ("Put in Threadbear"), and
Mike can take it out (`threads.setProjects`), after which it's never put
back. It never takes out a pinned project or one an agent added.
A project the thread isn't in yet needs a reason that says it fits: an
id with no reason, or one like "Not that; ignore", is dropped and
logged, and a thread nothing clearly fits stays unfiled.

Leaving a project out of its answer doesn't take the thread out of it, so
it doesn't flap from turn to turn. A look takes the thread out of one of
its own guesses when its answer says to (`leave`, with why: "Took it out
of Convex components directory: not a components thread"), on any look,
and also when a move or an ask leaves it out. That isn't remembered as a
no the way Mike's is: a later look can put it back. Looks are listed in
`LibrarianStatus.recent`.

Looks (and icon picks) run on the Claude pool, like every small job.
Without a pool with a Claude login (`models.pool` null, or a pool with
none), or while every login in it is out of room, the queue waits
(`state: "off"`) and tries again later.

**Titles.** A look also says whether the thread's title still fits, and
gives a new one when the work has moved on or the title is only its first
message's opening words. It takes effect straight away, tidied like any
model title, and the look's entry says so ("Renamed it ..."). Never on a
`first-message` look (the title model has only just named it), never over
a title Mike or an agent set (`titleSet`), and not if the title changed
while the model was answering. A librarian title doesn't set `titleSet`,
so a later look can rename it again. No extra model call: it's the same
look.

The same look renames a project the thread is in whose name has gone out
of date: the thing it's about was renamed ("Chrome browser control" after
Paws became BrowserBear), or the work got a name of its own. The entry
says "Renamed <old> to <new>", and the project's `titleBy` becomes
`librarian`. Never on a `first-message` look, and never a project Mike
named (`titleBy`, else `createdBy`, is `mike`): one he made or renamed in
the app, or one an agent named because he asked (`update_project`'s
`mikeAsked`). The prompt marks those, and a name it sends for one anyway
is dropped. Names from the librarian or an agent can be renamed again.

**Icons.** The librarian gives each project an icon and keeps it up to
date. It looks through the project's folders for the picture the project
already has, by file name and place, no model needed: an Xcode
`AppIcon.appiconset`, an `.icns`, an `apple-touch-icon` or `icon-512.png`,
a Chrome extension's or Expo app's manifest icon, a picture named after the
project in an `icons/` folder, then favicons and logos. Wide pictures,
template (menu bar) icons, other image sets, and anything under
`node_modules`, build output, docs or tests are passed over, as is one
under a folder named for something else (`public/inventory/icon.svg` is
the inventory's). The best is copied in, so the app never reads a repo. It
looks again a few seconds after a project is made or its folders change,
and every hour at all of them, copying again when the file has changed or
a better one has turned up. A project with no picture gets an SF Symbol:
one small-model call (feature `projects`, in the budget, not while paused,
never for a private folder) choosing from a fixed list. One Mike or an
agent chose (`projects.setIcon`, `update_project`'s `icon`) is never
changed by the librarian.

**No fix threads.** From 30 Oct to 2 Nov 2026 a look could start a thread
to fix a problem Mike mentioned with his tools. It was removed before going
public: on someone else's Mac it started threads that edited and landed
code they hadn't asked for, and Mike starts those threads himself or has a
schedule look for them. A look gets a message's words but not its images,
so each message with images is marked as having some. An older
`librarian.json` may still hold `fixes`, which is ignored.

**Links.** A project keeps up to 8 links: the places Mike keeps going
back to for it (its live site, admin page, dashboard, store listing), not
one-off pages or pull requests. The app shows them at the top of each of
its threads' Highlights, under the project's icon and title. Agents set
them with `create_project` and `update_project` (`links` replaces them,
`addLinks` adds or retitles by url, `removeLinks` takes some off), and
Mike with `projects.update`. The librarian's look can add ones the
thread's messages give for a project the thread is in (`links` in its
answer): only a url that's in what it was sent, never more than 8, and it
never takes one away. Merging two projects keeps both lots.

**Agents** have tools for projects (see Tools for agents):
`list_projects`, `read_project`, `create_project`, `update_project`,
`join_project` and `leave_project` (each for their own thread by default).
An agent's join is pinned.

### Project tasks

A project can name a Notion page (`notion`) with its task board on it: a
database with a Status column, like a Notion board. The runner reads it
through the Connectors gateway (see Connectors), with the main Claude
login's `connectors` entry in `~/.claude.json` (its URL and its
`headersHelper`, which prints the Authorization header;
`runner.json`'s `connectors.headersHelper` can name another). So it's the
same Notion login the agents use, and the runner keeps no Notion key.

It finds the database on the page (the one called Tasks, else the first;
a database or a `collection://` address is used as it is) and one of its
views with no filter, then reads the rows through that view every 5
minutes, and when the project page asks (`projects.refreshTasks`):
`notion__notion-query-data-sources` in view mode, 100 a page, 300 at
most. Not rows or SQL mode: Notion caps those per workspace, and two dozen
boards used the allowance up in minutes (30 Oct); view queries don't
count. A database with only filtered views is read in rows mode. Boards are read three at a time: the gateway allows 32 calls in flight, agents' included, and 73 boards read together went past it. The
columns (`notion__notion-fetch` of the data source) are read again every
30 minutes, or when a card is in a column they don't have. The last board
is kept in `project-tasks.json` in the data dir, so a restart shows it at
once.

```ts
// On Project
notion?: string        // the page (or database) Mike or an agent set
tasks?: ProjectTasks   // with notion only

type ProjectTasks = {
  url: string          // the database to open in Notion
  columns: { name: string; kind: "todo" | "doing" | "done"; color?: string }[]
                       // the Status options in Notion's order; kind is the
                       // option's group (To do, In progress, Complete)
  items: {
    id: string; title: string; url: string
    status: string     // a column's name
    who: string[]      // a Who / Assignee / Owner multi-select or people
    due?: string; dueEnd?: string // the first date property, ISO
    thread?: string    // a text property called Thread: a thread id or prefix
  }[]
  fetchedAt?: string
  loading?: boolean    // not read yet
  error?: string       // the last read failed; the rest is the last good board
  more?: boolean       // over 300 rows
}
```

A thread's Highlights lists up to 4 open cards under each of its
projects: the one whose Thread is this thread first, then those in an
In progress column, then To do; more opens the project page.

Threadbear only shows the board; cards are moved in Notion, by people
or by agents with the Notion tools. `read_project` lists the open cards,
and a thread's brief has one line saying the board is there and how many
are open. With no gateway, `error` says so.

## Schedules

A schedule sends a message at a set time, once (`at`) or over and over
(`cron`), like Convex's scheduled functions and crons. It either sends to
a thread that already exists or starts a new thread each time. They're
kept in `schedules.json` in the data dir.

- **Cron.** Five fields: minute, hour, day of month, month, day of week
  (0 or 7 is Sunday), with `*`, lists (`1,15`), ranges (`1-5`), steps
  (`*/15`, `9-17/2`) and names (`jan`, `mon`). When both day fields are
  restricted, either one matching is enough, as in standard cron. Read in
  `timezone`, or the Mac's own zone. A time that doesn't exist on a
  daylight-saving day runs at the first minute that does; one that happens
  twice runs once.
- **Sending.** The message starts with a line saying which schedule sent
  it, `[Scheduled: "<title>", <whenText>]`, so the agent knows Mike didn't
  just type it, and its `user.message` has `origin: "schedule"` and
  `scheduleId`. A message for a thread that's busy waits for the running
  turn to end (it doesn't go into it), then starts its own turn. A snoozed
  or archived thread comes back to the inbox, as with any message.
- **New threads** get the schedule's title and settings and are made the
  way `threads.create` makes them. One with a `poolId` starts on that
  pool's pick of its logins at the time (Which login), and stays in the pool.
  Unlike a thread Mike starts, it doesn't change the login or pool the
  next new thread starts on. Their summary's `schedule` says which
  schedule started them, so a client can mark them as scheduled. A repeating schedule whose last thread is
  still starting, running or waiting on Mike skips that run
  (`lastRun.outcome: "skipped"`) rather than pile up threads.
- **Late runs.** The runner checks at least every 30 seconds, so a Mac
  that was asleep (when timers stop) catches up soon after it wakes. A run
  that was due while the runner was stopped or the Mac slept happens once
  as soon as it can, however many were missed; then `nextRunAt` is the
  next time after now. While the runner is restarting, a due run waits for
  the new one.
- **Failures.** A run that can't send (the folder or account has gone)
  records `lastRun.outcome: "failed"` and a `note`, and a repeating
  schedule carries on next time. Deleting a thread deletes the schedules
  that send to it.
- **Runners.** With sync on and a backend of API 9 or later, schedules
  live in the backend's `schedules` table rather than `schedules.json`,
  so every runner sees one list and a schedule can be made for another
  runner (step 6, docs/step6-plan.md). Each row names its `runnerId`, and
  only that runner sends it. The runner keeps a live subscription to the
  table (`sync:schedules`) and a copy in `schedules.json` (`version: 2`)
  for when the backend can't be reached. Its own timer finds a due run,
  as above; before sending it takes the run with `sync:claimSchedule`,
  which says no unless the row is still due at that `nextRunAt` and
  nobody holds it (a claim lasts 2 minutes), so a run is sent once even
  while two runner processes share a `runnerId` in a handover. Then
  `sync:scheduleRan` records it and the next time. Making, changing and
  deleting go straight to the backend and answer once it has them; with
  no backend reachable they fail with `-32000` saying so. Nothing fires
  without the backend. The first time a runner meets a backend of API 9
  it moves its own `schedules.json` up, under its `runnerId`, and from
  then on the file is only the copy. With sync off, or an older backend,
  schedules stay the runner's own file as before.
  From backend API 45 a runner reads the table once with
  `sync:schedulesSince` and then only the rows written since, plus the ids
  gone (`scheduleGone`, kept a day), asking again from 5 seconds before the
  newest row it heard. A claim doesn't count as a write for this. An older
  runner goes on using `sync:schedules`.
- **Agents** make and change schedules with the `threadbear` tools
  (`schedule_message`, `list_schedules`, `update_schedule`,
  `delete_schedule`); `createdBy` is their thread. By default an agent's
  schedule sends to its own thread ("check the deploy again in 20
  minutes"). `schedule_message` takes a `runner` (a name or id from
  `runners.list`); left out, the schedule runs on the agent's own runner.

## Other runners' threads

Step 6 part 2 (docs/step6-plan.md). The Mac app lists every runner's
threads: this runner's from this runner as always, the others' from the
backend. To open one of another runner's threads the app connects to that
runner itself. Runners never talk to each other.

- **The sidebar table.** With a backend of API 12, each runner keeps one
  `threadIndex` row per thread there: `threadId, title, cwd, accountId,
  provider, model?, status, needsYou, unread, preview, createdAt,
  lastActivityAt, snoozedUntil?, archivedAt?, startedBy?, asked?`
  (`startedBy` from API 23, without its `threadId`; `asked` from API 32). It writes a row when any
  of those but `preview` and `lastActivityAt` changes (those two go along
  but never cause a write), and on its first write after starting it
  drops rows for threads it no longer has. A deleted thread's row goes.
- **Watching the others.** The runner subscribes to
  `sync:otherRunnersThreads` (every runner but itself, with its threads)
  and gives the result to clients as `remoteThreads.list` and
  `remoteThreads.updated`. It watches only while a Mac app is connected
  (`hello`'s client `threadbear-mac`), and for two minutes after the last
  one goes, since every re-run reads all the other runners' rows; a
  `remoteThreads.list` starts the watch at once, and the answer follows as
  `remoteThreads.updated`. Until then the list is what was last heard.
  With a backend of API 29 it watches two smaller things instead:
  `sync:otherRunnersList` (the runners, which heartbeats re-run) and
  `sync:threadIndexSince` with, per runner, the newest `updatedMs` it has
  heard (absent at first, for all of that runner's rows). Each answer moves
  that on and it subscribes again, so a re-run reads only rows written since,
  tombstones (`deleted`, kept a day) included. Watching again after a stop
  starts from all rows. The app sees the same `RemoteThreads` either way:

```ts
type RemoteThreads = { runners: RemoteRunner[], threads: RemoteThread[] }
type RemoteRunner = {
  id: string, name: string, icon?: string  // as RunnerInfo
  online: boolean      // heard from in the last 3 minutes
  lastSeenAt: string
  rpcUrl?: string      // how to reach it: that runner's sync.rpcUrl
  tokenFile?: string   // absolute path on this Mac of its runner token,
                       // when one has been copied in
                       // (<home>/secrets/runners/<id>.token); absent means
                       // its threads can be listed but not opened
}
type RemoteThread = { runnerId: string, threadId: string, title, cwd,
  accountId, provider, model?, status: ThreadStatus, needsYou: boolean,
  unread: boolean, preview, createdAt, lastActivityAt, snoozedUntil?,
  archivedAt? }
```

- **Opening one.** The client connects to `rpcUrl` (a `wss://` URL served
  by `tailscale serve` on that Mac, so only the tailnet reaches it) with
  the token in `tokenFile`, exactly as to its own runner, and uses the
  normal methods there for that thread: `threads.events`,
  `threads.subscribe`, `threads.send`, `threads.update`,
  `approvals.respond`, and so on. Paths in its events (images, blobs,
  file links) are that Mac's: the client gets them with `files.read` on
  that runner and keeps its own copy, passing `known` to check it's still
  current. A link to a folder there answers `files.read` with `Not a file`,
  and the client then browses it with `files.list`. A sidebar row's actions (archive, hibernate) don't need it open:
  they connect the same way, and that connection closes a minute later
  unless one of that runner's threads is on screen.
- **The token goes to one host only.** The client proves it has the token
  (Auth) rather than sending it, but it still only dials and proves to the
  host it was told to by hand. `rpcUrl` comes from the backend,
  and the owner key can rewrite any runner's (before runner keys, every
  runner's key could; see Runner keys), so the client
  sends the token only to the host (not the port) in a file beside it
  (`<id>.host` next to `<id>.token`, the host and a newline, owner only),
  copied in from that Mac with the token: `tb pair` there prints both. The
  client never writes the file and never trusts the mirror's host on its
  own, not even the first time. No `.host`, or one it can't read: it
  doesn't dial, and says which file to make and that `tb pair` on that Mac
  prints the line (it never suggests the mirror's host). An `rpcUrl`
  naming another host isn't dialled either: the client says the address
  changed (from which host to which) and that a real move means putting
  the new host from `tb pair` in the `.host` file.
- **New threads on another runner** are a `threads.create` on that
  runner's connection, with its folder (a path on that Mac), account,
  model and effort from that runner's `hello`.
- **`sync.rpcUrl`** in a runner's `runner.json` is the URL it tells the
  backend (in its heartbeat, API 12) for other Macs to reach it by.

## Other runners' threads through the backend

Full Convex step 5 (5 Nov 2026, backend API 44). The Mac app opens and
drives another runner's thread without connecting to that runner: it asks
its own runner, with the normal methods and the thread's id, and this
runner answers from the backend and sends what the app does to the other
runner as a `commands` row, as the phone does. The app has no Convex of its
own and no link to the other Mac; nothing reaches another runner but its
commands. Only the owner key can do this (`convex/relay.ts`, all owner
only in Runner keys), so it's the main Mac's runner that answers; a runner
on a runner key answers `-32000` for another runner's thread. The direct
link above stays beside it while this is new: the app uses it only with
**Settings > Runners > Connect to other machines directly** on (off by
default).

- **Which threads.** A `THREAD_METHODS` request whose `threadId` isn't this
  runner's (nor a draining runner's) but is in its `remoteThreads` list.
  `threads.create` with a `runnerId` that's another runner's, and
  `files.list` with a `runnerId`, go there too.
- **Reading.** `threads.events` and `threads.subscribe` answer from the
  thread's `messages` rows (Sync, Messages) and its `threads` row. The rows'
  seqs are the other runner's, with gaps where events weren't mirrored, and
  events are made up beside them, so each row's seq `s` becomes eight
  **relay seqs**: `8s` a `turn.started` (the first row of a turn), `8s+1`
  the row's own event (`user.message`, `assistant.text`, or a `tool.call`
  with the line as its title and no input), `8s+2` a tool's `tool.result`
  once anything follows it or its turn has ended, and `8s+7`
  `turn.completed` at the last row of a turn that has ended (the next row
  is another turn's, or the thread's row has said for 4 seconds that it
  isn't running, since that runner writes its rows a moment before their
  messages), with the row's `needs`, `asks` and `next` on the newest. An
  open approval, question or secret on the row is placed at `8p+1`, `p`
  being its event's seq (`pendingApproval.seq`, API 44; from an older
  runner, with none, at `8m+3` after the newest row `m` held when it was
  first seen), and its `approval.resolved` one after it once the row no
  longer has it (with the decision if it was answered from this Mac). A
  `threads.subscribe` replays what's past `afterSeq` and, from everything
  given before, what can come late (results, answers, turn ends) again;
  the app takes a seq it already has as nothing. Every page and
  event is in relay seqs, and so are `afterSeq` and `beforeSeq`. A page also
  has `relay: { runnerId, runnerName, atStart? }`; `atStart` says there's
  nothing older. Events can arrive with gaps and late (a tool's result
  when the next row comes, an approval's answer after later rows), so the
  app takes them as they come rather than asking for a catch-up (its
  ThreadFeed's sparse mode). No deltas: a remote thread shows finished
  messages and the working line, not live typing.
- **What's held back.** Tool output, diffs, reasoning, sub-agents and
  pictures aren't in the backend until full sync (step 4). A tool's result
  says `The output is kept on <runner>.` and carries `heldBack: { seq }`,
  the row's own seq, for step 4 to fetch the body by (`sync:remoteBody`,
  planned). `files.read` with a `runnerId` is `-32000`, and the app doesn't ask:
  it says the file is kept on that machine.
- **Reads.** A thread is watched only while a client is subscribed to it,
  through `relay:remoteTail` (its newest 15 rows) and `relay:remoteThread`
  (its one row); a minute after the last subscriber goes, both stop. Older
  rows are read once by page (`relay:remoteMessages`, 50 at a time) and kept
  in this runner for half an hour. A tail that starts past the newest row
  held (the Mac slept) reads the rows between once, by `afterSeq`, rather
  than leave a hole. `runner.status` has `relay: { watching, held, reads, bytes }`:
  threads watched now, rows held, and since start the reads (and live
  updates) and the JSON bytes they brought back, to measure what it costs.
- **Acting.** `threads.send` (text and `answers`; pictures are `-32000`),
  `threads.interrupt`, `approvals.respond`, `secrets.answer` (sealed to the
  other runner's key from its row, as the phone seals it, so the value
  never reaches the backend in the clear), `threads.markSeen` (only when
  the row is unread), `threads.update` (`title`, `archived` with its `verdict`, `starred`,
  `snoozedUntil`; anything else is `-32000`) and `threads.share` each queue
  one command with `relay:queueCommand`, which sends a thread's command to
  the runner whose row the thread is, whatever runner it was asked for, and
  `sync:takeCommand` fails a thread's command (any one's, the phone's too)
  whose thread is another runner's by the time it's taken.
  The runner watches it with `relay:commandState` (a get by id) until it's
  taken (sends, interrupts) or done (the rest), at most 20 seconds, and
  answers with the command's `note` as a `-32000` if it failed. A runner the
  list says is offline is `-32000` at once. Commands from here carry `from:
  "mac"`, so the other runner gives the message no `origin`.
- **New threads there.** `threads.create` with `runnerId` is a `create`
  command (text, `cwd`, `accountId`, `model`, `effort`, `permissionMode`;
  pictures are `-32000`), answered with a summary of the new thread once
  that runner has made it, which this runner then answers for until the
  sidebar list has it. `remoteThreads.logins { runnerId }` gives that runner's
  logins for the pickers, from the backend's `accounts` rows (no pools;
  `defaults.cwd` is the folder of its newest thread).
- **Answers from another runner.** `files.list` with `runnerId` and `path`
  is a `call` command, `{ method: "files.list", params: { path } }`, which
  that runner answers in the command's `result` (at most 500 entries; JSON
  text, at most 256 KB, kept only for a `call`). Only
  methods on the allow-list (`convex/relay.ts` `CALLS`, checked again by
  the runner) can be called, and none that answers with file contents or
  tool output.
- **Everything else** about another runner's thread (editing a message,
  highlights, patches and panels, reviews, explain, hibernate-when, a
  sub-agent, ticking an ask, changing its login or model) is `-32000`
  saying to do it on that Mac or turn the direct link on.

## Sync

The runner mirrors the phone's view of its threads to Threadbear's Convex
project (docs/convex-backend.md, shape A: the runner owns the state,
Convex mirrors it, the phone asks through it). It's best effort: nothing
the runner or the Mac app does waits on it, and the runner never reads
the mirror back as state. The Mac app doesn't use it.

- **On when** `runner.json` has `sync.url` (the deployment's
  `https://<name>.convex.cloud`) and `secrets/convex-key` (0600) holds the
  key the deployment's `RUNNER_KEY` was set to (the main Mac) or this
  runner's own runner key (any other; see Runner keys). `sync.enabled: false`
  turns it off; so does `THREADBEAR_SYNC=off` in the environment, which
  check.sh sets so no test runner writes to the real project.
  `THREADBEAR_SYNC_URL` points a dev or test runner at its own deployment.
  `sync.name` is what the phone calls this runner (default: the Mac's
  hostname without `.local` or `.localdomain`); `sync.runnerId` is made
  once and written back to `runner.json`, so a data dir stays one runner
  across releases. `sync.icon` names an SF Symbol for the runner in lists
  (default: worked out from the Mac's model, see `RunnerInfo`); the
  heartbeat carries it to a backend of API 11 or later, and
  `sync:runnersList` gives it back.
- **Threads.** One `threads` row per thread: `threadId, runnerId, title,
  cwd, accountId, provider, model?, status, needsYou, unread, preview,
  createdAt, lastActivityAt, snoozedUntil?, snoozedUntilRestart?,
  archivedAt?, starredAt?` (API 27; a starred thread that's hibernating
  stays in view `inbox`, so the phone has it without loading Hibernating),
  `costUsd?` (to the cent), `projects?: { id, title }[]`,
  `working?` (the first unfinished background task's description),
  `pendingApproval?` (below), `earliestSeq?` (Messages, below), `share?` (see Sharing; API 8),
  `asks?` and `asksSeq?` (the open card, below; API 14), `next?` (below; API 14),
  `links?: { title, url, icon? }[]` (API 28: the thread's url actions,
  past their `when`, with only an SF Symbol `icon`, so the phone shows
  them and opens them itself) and `view` (`inbox`, `hibernating` or `den`,
  worked out the way the app's lists are). Nothing else from
  `ThreadSummary`: no `lastSeq`, context, panels, other actions, hooks or
  sub-agents, and never a tool result, diff or image. A `thread.updated`
  whose phone view differs from the last one written marks the thread
  dirty; dirty threads are written together, at most once every 2
  seconds, 50 to a mutation. A change only to its preview or unread waits
  until 20 seconds after that row's last write, and goes with anything else
  that changes first. A `thread.deleted` removes the row and its messages.
  What's been written is remembered between starts as hashes
  (`sync-sent.json` in the data folder), so a start writes only what changed
  (comparing 20 seconds in, once patch links have loaded);
  every 3 days, with no such file, or when `sync:heartbeat` answers
  `firstSeen`, it writes everything and prunes.
- **Messages.** Each persisted `user.message` and `assistant.text` goes
  up as a `messages` row (`threadId, seq, role, text, origin?, at`), text
  cut at 8,000 characters with a note; never a delta, with one row per tool
  call (`role: "tool"`, one line). The mirror keeps every one, and each
  thread's whole history goes up once per deployment. A start sends what's
  newer than the last one it wrote (`sync-sent.json`), or asks
  `sync:messageHeads` on a full write. The row's `earliestSeq` is the seq of
  the thread's first text message. A `page` command (an old phone's
  `loadEarlier`, with `beforeSeq`) marks up to 50 text messages before that
  seq as paged (`pagedAt`), so `phone:thread` shows them for a day.
- **Approvals.** An `approval.requested` puts `{ approvalId, kind:
  "approval", name, title, options, inputSummary? }` on the thread's row
  (`inputSummary` is one line: the command, the path, or the first string
  in the input, at most 200 characters, never the whole input); a
  `question.requested` puts `{ approvalId, kind: "question", questions }`.
  `approval.resolved`, or the thread no longer waiting, takes it off.
- **End-of-turn cards** (API 14, 30 Oct 2026). The open card of asks
  (see Needs you) goes on the row as `asks` and `asksSeq`, each ask
  without `where` and with only its `http(s)` links, as the phone can't
  open a file on the Mac. While a thread is idle on a turn that said it
  needs `nothing`, `next` is that `turn.completed`'s follow-ups. An
  `assistant.text` with `summary: true` goes up with `summary: true`, so
  the phone can pick a turn's reply as the Mac does and fold the rest of
  the turn into one "Worked for" line. A `send` command may carry
  `answers` (`AskAnswer[]`), passed to `threads.send`. A backend older
  than 14 gets the rows and messages without them.
- **Projects, schedules, accounts.** Each `projects.updated`,
  `schedules.updated` and `accounts.updated` replaces that runner's rows
  of the table with the whole list (schedules only while they're the
  runner's own file: once they live in the backend, see Schedules,
  "Runners", the runner writes them there directly and these mirrored rows
  are gone) (`Project` with its icon as `icon: {
  symbol?, picture?, by }`, `picture` naming the runner's copy of the
  picture, the file name without its extension; `Schedule` without effort
  and permission mode; `Account` as `id, provider, title, note?, email?,
  plan?, defaultModel?, usage?`, never `configDir`; from backend API 20
  also `models?` (each `id, title, effortLevels?, defaultEffort?`) and
  `defaultEffort?`, for the phone's new thread pickers). The same at start,
  and the accounts again once a heartbeat first says the backend is at 20.
  From backend API 48 each project also has a small row in `projectHeads`
  (no goals, state, notes or folders), written only when what it holds
  changes apart from `updatedAt`, which `phone:projects` reads. Every project
  from before is copied there on the first heartbeat any runner sends, once
  (`backendMarks`); until then `phone:projects` reads `projects`.
  `sync:sharedUsage` takes the caller's `runnerId` and doesn't read that
  runner's rows, so it doesn't re-run for the runner's own writes.
- **Project pictures** (backend API 5). A project's picture goes to the
  deployment's file storage so the phone can show it: the runner asks
  `sync:projectIcons` once for what the mirror has, and for each project
  whose `picture` is new or changed gets an upload URL
  (`sync:iconUploadUrl`), POSTs the bytes and records the storage id
  against the project (`sync:setProjectIcon`), which replaces and deletes
  the old file. PNG, JPEG and WebP go as they are (at most 256 px, as
  the runner stores them); an SVG is drawn to a 256 px PNG with Quick
  Look first, since the phone can't draw SVG. A picture that can't be
  read is skipped with a warning and tried again when the projects next
  change. `sync:setProjects` drops the picture of a project that's gone
  or has a symbol now. Only once a heartbeat has said the backend is at
  API 5 or later; an older backend gets the project rows alone.
- **Runner.** A `runners` row for this runner (`runnerId, name, version,
  release?, startedAt, draining, threadCount, lastSeenAt`), written once a
  minute. On start every thread is written once and rows of this runner
  for threads it no longer has are pruned. A stop for good (not a restart
  or a handover) sets `lastSeenAt` to 0 so the phone shows it offline at
  once; a draining runner just stops, and the new release writes
  everything again under the same `runnerId`.
- **Runner figures** (API 45). While the website's Runners view is open it calls
  `phone:watchRunners` every 30 seconds, keeping a time in the future in
  `runnerWatch`. Each runner subscribes to that (`sync:runnerWatch`), and while
  it's in the future sends its machine's CPU, memory and disk every 10 seconds
  to a row of its own (`sync:setRunnerStats`; `runner/src/runner-stats.ts`).
  The Mac app's runner details do the same through the main Mac's runner
  (API 46, `runners.stats`): `sync:watchRunnersFromMac` and
  `sync:runnerStatsList`, owner key only. With nobody looking nothing's written. The heartbeat carries only `pressure`
  (`memory` or `disk`, looked for every 5 minutes), which rarely changes, as
  every phone's runner list re-runs when that row does.
- **Commands.** The phone's mutations (`convex/phone.ts`) add a row to
  `commands` for a runner (`runnerId`, or `"any"`). The runner holds a
  live query on its pending commands over the Convex client's WebSocket
  (it reconnects by itself), and for each one: takes it
  (`sync:takeCommand`, which says no if it was already taken), applies
  it through the same methods the app's RPCs use (one about a thread a
  draining runner still has goes to that runner, as the app's would),
  then finishes it with
  the outcome and, for a `create` or `quickAsk`, the new thread's id. `send` and
  `create` give the `user.message` `origin: "phone"`. A `create` can name
  `accountId`, `model` and (backend API 20) `effort`, checked as
  `threads.create` checks them; an effort that isn't a level is dropped. Either can carry
  `images: { storageId, url }[]` (backend API 18), photos the phone put in
  file storage (`phone:imageUploadUrl`), when `text` may be empty: the
  runner fetches each, sends it as an ordinary `ImageRef`, and
  `sync:finishCommand` deletes them from storage, whether or not the send
  worked. The phone uploads a photo as soon as it's picked, so one that's
  never sent goes back with `phone:discardImage` (backend API 25). The phone's text can place its photos with `[Picture N]`
  markers, in `images`' order (Pictures in a message). A message row with
  pictures no marker places gets a `[1 picture]` line, as the pictures
  themselves stay on the Mac; the ones a marker places show as chips. `update` takes one
  of `{ snooze: { until?, untilRestart? } }`, `{ wake }`, `{ archive, verdict? }` (`verdict` from API 42),
  `{ unarchive }`, `{ markSeen }`, `{ title }` or `{ star: boolean }` (API 27); `respond` is
  `approvals.respond`'s decision, message and answers; `page` is
  `{ beforeSeq }` (above). `quickAsk` (backend API 10) is
  `{ question, answer, sources: { title, url }[], askedAt }`: a quick
  ask the phone already answered out loud (from Agent Archive's
  `/api/quick/ask`, straight over Tailscale), kept as a thread so Mike
  can carry on in it. The runner makes a thread as a `create` with no
  `cwd` would (the default folder, never a worktree, the login and model
  a new thread gets) but runs no turn: it writes the question as a
  `user.message` with `origin: "phone"`, `turn.started`, the answer as an
  `assistant.text` (the sources after it as markdown links), a
  `system.note` "Answered by Ask from Agent Archive" and a
  `turn.completed` (`completed`, `needs: "nothing"`), all under one
  `turnId`, and marks it seen, since Mike has heard it. The title comes
  from the question, then a model title with the answer as the reply.
  A spoken follow-up wants a quick reply, so the thread is set to Haiku when
  the runner has a Claude login, else GPT-6-Luna at low effort with a Codex
  login, else the account's default.
  The first message sent to it starts a fresh session with a handoff
  note saying the thread began as a quick ask that a fast model answered
  (see `threads.update` for the note). Like `create`, it finishes with
  the new thread's id. `interrupt` (API 44)
  stops the thread's turn, and `call` (API 44) runs one allow-listed method
  and finishes with its answer as `result`; both come only from the main
  Mac's runner (Other runners' threads through the backend). A failed command
  gets `state: "failed"` and a readable `note`. A draining runner takes
  no commands. Finished commands go after a day.
- **Failures.** A write that fails is kept and tried again after 5
  seconds, doubling to 5 minutes, with one log line per distinct error;
  a newer state for the same thread replaces the one waiting. Rows are
  current state, so a long outage costs one write per changed thread
  when it's back.
- **Secrets.** Every mutation goes through the runner's scrubber on its way up
  (`ConvexSync.post`, `src/scrub.ts`), every free-text field at any depth, so a
  new field is covered without anyone remembering to: known values first
  (`src/secret-values.ts`), then the shape rules (`src/redaction.ts`). Identity
  fields aren't touched (`NOT_TEXT` there: ids, `key`, timestamps), the digests
  that decide what's changed are of the row before scrubbing, so a rule changing
  writes nothing by itself, and the runner's own copy never changes. A message
  or tool line is also scrubbed before it's cut short. A string whose check throws
  goes up as `HELD_BACK`, and `sync.scrub.failed` counts them. While the runner
  is still reading `.env` files, mutations other than the heartbeat wait, for up
  to a minute, then fail so the flush tries again; a folder that doesn't answer
  in 5 seconds is left for the next look and counted in `foldersUnread`. Backend API 47
  does the shape check again in every mutation that takes a runner's text, and
  on a command's `note` and a call's `result` (scrubbed as parsed JSON, so it stays
  JSON). A command's `args` are stored word for word only so they reach the runner
  intact, and are dropped when it's over, however it ended, keeping only `images`
  (`relay:queueCommand` skips the runner's scrubbing for the same reason). A
  question's `answers` may name it as
  scrubbed (`matchAnswers`). A schedule that lives in the backend comes back
  scrubbed, so one whose text holds a secret runs with `[REDACTED]`. Pictures
  aren't scrubbed. `src/withhold.ts` says which tool calls' output must never
  upload; no tool output goes up today, so nothing calls it on the way up yet.
- **Status.** `runner.status` has `sync: { state: "off" | "ok" | "error",
  reason?, url?, runnerId?, name?, threads?, messages?, lastSyncAt?,
  lastError?, pending?, retryAt?, commands?: { state: "off" | "on" |
  "error", applied, failed, lastError? }, scrub?: { rulesVersion, knownValues,
  foldersUnread?, changed, failed, lastFailure?, backendChecks? } }`, and `secretCheck: { state:
  "off" | "unsupported" | "unavailable" | "on", reason?, since, checkedText,
  checkedImages, flaggedText, flaggedImages, errors, rulesAndModel, rulesOnly,
  lastRunAt?, skippedOnBattery?, file? }` (`reason` says why it's off;
  `threads` and `messages` are rows written since start; `pending`
  changes waiting), and `tb status` prints it as one line.
- **Convex side.** `convex/` at the repo root (schema, `sync.ts` for the
  runner's mutations and the command queue, `phone.ts` for the phone's
  queries and mutations, `tokens.ts` for phone tokens, `crons.ts` for
  pruning). The phone's API is in docs/convex-backend.md.

## Devices

The phones and browsers that read the mirror (Sync) each hold a phone
token (`convex/tokens.ts`): only its SHA-256 is kept, under a name, a
kind and an expiry, so each can be listed and revoked on its own. The
Settings window's Phone & browser tab issues them through the runner,
so nobody needs the Convex CLI (`ios/scripts/pair-qr.swift` and
`web/scripts/sign-in.swift` still work from a terminal).

```ts
type Device = {
  id: string               // the token's row id, for devices.revoke
  kind: "phone" | "browser"
  name: string             // "iPhone", "Chrome": what the app called it when pairing
  createdAt: string
  expiresAt: string
  expired: boolean
}
```

- `devices.pair` asks the backend (`sync:issueToken`, with the runner
  key) for a token of that kind and name, good for `days`, and hands the
  app the one link that carries it: the pairing link for a phone (the
  app draws it as a QR code for the iPhone app to scan; `url` is
  `sync.url`), or the website's sign-in link for a browser (the token in
  the `#fragment`, which never reaches a server; the app opens it in the
  default browser). The token is in that reply and nowhere else: the
  runner never logs it, never writes it to disk, and no `tb` command
  prints it, since a thread's transcript can command agents. The app
  shows the QR code or opens the link, then forgets it.
- `devices.list` is the backend's live list (`sync:listTokens`), never
  revoked ones; expired ones stay until revoked, so the list says why a
  phone stopped working. Nothing is cached in the runner.
- `devices.revoke` marks the token revoked (`sync:revokeToken`); the
  phone's or browser's next call fails as unauthorised and it shows its
  pairing or sign-in screen. The phone's push registration goes with it,
  so it gets no more notifications (`convex/tokens.ts`).
- With sync off, `devices.list` returns no devices and `reason` (the
  same as `runner.status`'s `sync.reason`), and `pair` and `revoke` are
  `-32000` with that reason. A backend older than API 6 has none of these
  functions: `pair`, `list` and `revoke` are `-32000` saying the backend
  deploys with the runner's next update.

## Runner keys

Added 5 Nov 2026, after a security review kept finding attacks that start
with "a holder of the shared runner key". Until then every runner on a
deployment carried the same `RUNNER_KEY`, so a second Mac (Bruce) could do
anything the main one could: rewrite any thread's runner and secret card
key, replace another runner's `rpcUrl`, read its pending commands, put a
schedule on it, and mint phone tokens. Now there are two kinds of key, and
`convex/runnerAccess.ts` says what each may do (a unit test,
`runner/test/unit/runner-access.test.ts`, checks every function in
`convex/sync.ts` against it and against the table below).

- **The owner key** is the deployment's `RUNNER_KEY`, held by the main Mac's
  runner only. It may do everything, as every key could before. A
  deployment with one runner has only this key, and nothing changes for it.
  While it's being rotated `RUNNER_KEY_NEXT` is an owner key too, so the
  main runner can move to the new one without a gap: `tb runner
  rotate-owner` on the main Mac sets a new key as `RUNNER_KEY_NEXT` (with
  its deploy key) and writes it into its `secrets/convex-key`; once its
  runner has restarted onto it, `--finish` makes it `RUNNER_KEY` and
  removes `RUNNER_KEY_NEXT`, and every copy of the old key is dead. While
  `RUNNER_KEY_NEXT` is set the owner's heartbeat answers
  `ownerKeyRotating: true`, and `tb status` and `tb runner list` say so.
  Both steps refuse, changing nothing, while another runner is still on
  the main key: one `sync:runnersList` has seen in the last 30 days with
  no live runner key (the main key can't act as a runner that has one, so
  it can only be heartbeating on the main key), leaving out one whose key
  was revoked and that hasn't been seen since (a revoked key is refused). The refusal names each,
  with the `tb runner add ... --id <id> --replace` that gives it its own;
  `--lock-out <id,...>` cuts the ones named off on purpose. (The 5 Nov
  2026 rotation stranded the cloud runner this way.)
- **A key turned down.** `runnerAuth` refuses an unknown or revoked key
  with `ConvexError {kind: "auth", message: "bad runner key"}`. A runner
  whose heartbeat gets that says so once: an error in its log, a
  `runner.notice` at error level, and `runner.status`'s `sync` goes to
  `state: "error"` with `keyRejected: true` and a `lastError` saying what
  to run. It keeps heartbeating each minute (and clears if the key works
  again). Once `secrets/convex-key` holds a different key (`tb runner add
  --ssh` wrote one) it asks for a restart when idle, as the key is read at
  start; a heartbeat refused as `forbidden` does the same, as that's what
  a runner moved onto its own key while the main key still works gets.
- **Runner ids** are checked as they arrive, everywhere one does
  (`lib.ts checkRunnerId`): 1 to 64 letters, digits, `-` or `_`, never
  trimmed, and never `"any"`, which is the phone's "whichever runner". `tb
  runner add` checks the same way, so the id it compared is the id the
  key is for.
- **A runner key** (`tbr_` and 64 hex characters) acts as one `runnerId`
  alone. The backend keeps only its SHA-256 (`runnerKeys`: `runnerId,
  keyHash, name, createdAt, revokedAt?`); making another for the same
  runner revokes the one before. A revoked key is refused like a wrong one.
- **Making one.** On the main Mac, `tb runner add <name> --ssh <host>`
  reads that Mac's `runner.json` over ssh, but decides the id itself: it
  refuses the main Mac's own id, an id that isn't one, one that mirrors to
  another deployment, and an id the deployment already knows unless `--id`
  names it; a runner with no id yet gets one picked here. It writes the id
  and the deployment's URL into that `runner.json` when it lacks them, asks
  `sync:addRunnerKey` (with the main Mac's own id, which the backend
  refuses to make a key for) and writes the key into that Mac's
  `secrets/convex-key` over ssh's stdin (owner only, a temp file and a
  rename). The key is never printed, as an agent running `tb` would have
  it in its transcript; if the write fails the key is revoked again. It
  then says if that Mac also has a deploy key, Convex panel keys
  (`secrets/convex-panels/`) or a Convex login, which `tb runner check
  [--ssh <host>]` checks too (failing if it can't look), with what to
  revoke on Convex's side first, by name, before deleting the files and
  rotating. An id the deployment already has needs `--id` and `--replace`,
  after it shows that runner's name and when it was last seen. Every ssh
  turns off agent and port forwarding. `--out <file> --id
  <runnerId>` writes the key to a file instead; `tb runner list` and `tb
  runner revoke <runnerId>` do the rest. A runner reads
  `secrets/convex-key` when it starts, so a new key takes effect on its
  next restart.
- **A joining Mac has no admin power.** A deploy key or a Convex CLI login
  can do anything to the deployment (read `RUNNER_KEY`, issue phone
  tokens, deploy other functions), so a Mac with one has the owner's power
  whatever key its runner holds. `threadbear setup --existing`, or setup
  run again on a Mac whose `secrets/convex-key` is a runner key, makes no
  Convex login or deploy key and deploys nothing; it never writes or sets
  `RUNNER_KEY` (`scripts/runner-key-plan.mjs`), and ends by saying to run
  `tb runner add` on the first Mac. `runner/scripts/deploy-backend.mjs`
  does nothing on a Mac with a runner key, so only the main Mac's runner
  deploys. A Mac set up before this keeps whatever it was given: `tb runner
  check` says what to remove.
- **The owner key and a runner with its own key.** Once a runner id has a
  live runner key, the owner key can't act as that runner (`lib.ts actAs`:
  its heartbeat, lists, commands, or thread rows under that id), so an old
  copy of the owner key left on that Mac can't carry on as it. It can
  still put a schedule on it, and revoking the runner key gives the id
  back.
- **Refusals.** A function a runner key may not call, or a row that isn't
  its runner's, throws `ConvexError({ kind: "forbidden", message })`, the
  message starting "This runner's key can't ...". The runner turns the
  feature off quietly rather than retrying: the other runners' threads
  watch stops for good with one log line (that Mac's app lists only its
  own threads), a heartbeat refused (a key for another runner id) is one
  warning, and pairing a phone, a Pocket card from another Mac or a
  schedule on another runner fail with the backend's words.
- **Thread ids.** A runner key reaches only thread ids whose row is its
  runner's. For an id with no row its messages and pictures are dropped
  (its reads are empty), since they'd show in whatever thread the owner
  later made under that id. It may make a new row only under an id that has
  had nothing but its own runner: no `threadTombstones` row of another
  runner's (every deleted thread row gets one, kept for good), no other
  runner's `threadIndex` row, and nothing left under it (messages,
  pictures). `prune` deletes a pruned thread's messages and pictures and
  tombstones it, as `removeThreads` does, so nothing private lingers. The
  owner key may reuse any id.
- **Stored files.** A storage id doesn't say who uploaded it, so a runner
  key's `sync:iconUploadUrl` is a one-use URL on the deployment's own
  `/runner/upload` route (`convex/http.ts`), which stores the file and
  records it as that runner's (`storageOwners`); the URL dies with the key
  that asked for it, a file is at most 10 MB, a runner at most 300 URLs
  and 200 MB an hour, and one not attached within a day is deleted
  (`pruneOld`). A
  runner key may attach or delete only files it uploaded: the owner's and
  the phone's have no record and are nobody's to take, named or not. And
  nothing is deleted while anything names it: a picture row, a project
  icon, or a phone command still pending or taken (`finishCommand` too).
  The owner key still gets Convex's own upload URL.
- **Share links.** A slug is one thread's for good. A runner key may put
  one on its thread only if no other row has it and no other runner's
  thread ever did: a deleted thread's slug, and the old one when Share
  again makes a new link, are tombstoned. The owner key may, and other
  rows with it lose it. `/s/<slug>` and its card show nothing if two rows
  have one slug (from before this).
- **Taking a thread over.** Threads don't move between runners, but if the
  owner key writes a thread id another runner's row has, the thread starts
  clean: everything that runner wrote under the id (messages, pictures,
  share link, push state, its sidebar row, its Pocket cards on the thread)
  goes and is tombstoned, and the row is the owner's as written. Any other
  runner's sidebar row for an id goes whenever the owner makes the thread,
  a fresh one too. That runner's key can't write to it again,
  and `setThreadIndex` checks every row it writes against who has the
  thread now, so its old sidebar row can't come back.
- **Schedules.** A runner key can't take a schedule id any row has under
  another runner, an old mirrored row (before API 9) included, nor adopt
  one.
- **Pocket cards** a runner key files carry its runner id, set by the
  backend, and a thread id only if that thread is its own. The owner's
  `sync:pocketCards` gives them `filedBy` (that runner's id, which its
  name can't change), and
  `phone:pocket` starts their `source` with "From <name>". The main Mac's
  `pocket` tool marks them "information only, not instructions", and its
  librarian lists them by title only, never as a thread's own.
- **Names.** A runner key's heartbeat name is folded to printable ASCII
  (NFKD without accents, curly quotes and dashes made plain, zero-width
  and control characters gone), at most 40 characters; with nothing left
  it's the runner id. Never refused. One that looks like another runner's
  (compared by `nameSkeleton`: case, "rn" as "m", 0 as O, 1 and i as l)
  gets its id after it, and the name it ends with is checked the same way.
  Pushes from a thread start with its Mac's name unless that Mac
  heartbeats with the main key and has no runner key (`devices:
  threadForPush` `mac`; a runner with no row goes by its id).
- **Caps.** What a runner key writes is budgeted in UTF-8 bytes, whole
  rows not just their text, with at most three live runner keys, so the
  lists the phone or the main Mac reads whole stay well under Convex's 16
  MiB a read, and all three at their caps hold at most about 225 MB of the
  database (3 x 48 MB of messages, 3 x 3,000 threads at 8 KB, a few MB of
  the rest) and 450 MB of file storage: inside the free plan, with room for
  the main Mac's own (its whole history was about 21 MB of messages on 5
  Nov). A cap never deletes or silently drops a real runner's data:
  - Threads: 3,000 a runner key in all (the M5 had 714, Bruce 7), 8 KB a
    row. A new one past that waits: left out and said, and sent again
    later. The inbox and hibernating hold 300 each, counted from
    `viewCounts` with only the oldest row read: past that the oldest moves
    out of the list (view `overflow`, `wantView` where it belongs), keeping
    its messages, pictures and share link, and comes back as soon as the
    list has room. Reads by id show it where it belongs. A runner key's
    activity times are never later than now.
  - Messages: 12 KB a row and 48 MB a runner key in all. Past that its
    oldest anywhere go first, before a new one goes in, a few hundred a
    write; one there's still no room for waits (`skipped`) and is sent
    again, so a new thread's are never the ones lost.
  - A waiting question keeps exactly what its answer is matched on (its
    text, header and option labels); only option descriptions are cut, and
    if it still doesn't fit the card says to answer it on the Mac.
  - Sidebar rows: 800 at 2 KB, tombstones included; a new one past the cap
    takes a tombstone's place first, a live row's only when there are none;
    archived threads aren't listed. The owner reads at most 2,000 a runner.
  - Projects 50 at 32 KB (one row an id; icons only on its own, 1 KB),
    schedules 100 at 16 KB (text 12 KB: the longest real prompt on 5 Nov
    was 2,286 bytes), Pocket cards 50 (title 60, text 2,000), accounts 20 at
    8 KB, pushes 10 a minute.
  - Uploads: 10 MB a file, 200 MB an hour, 150 MB stored. Over an allowance
    is "later" (the upload route's 429): the runner keeps that picture and
    tries again after ten minutes, the rest of its flush going on; only a
    file over the size cap is left out.

  Every path that changes a row keeps it in its cap. What a runner's own
  flush writes is cut to fit or left out and said back (`skipped`), never
  refused; the runner tries a refused write row by row and doesn't count
  rows or messages left out as sent, so they go again. Schedules a runner
  key can't bring up stay in its own `schedules.json`, all of them, and `tb
  status` says how many. What an agent asks for directly (a card, a
  schedule) is refused when too big, so it hears why. The owner key isn't
  capped. `pruneOld` works 1,000 rows (20 messages) a run, finds finished
  commands by when they finished, drops thread tombstones after 30 days (a
  share link's stay), and runs again if there's more.
- **Refusals name nothing a key can't see.** They never say whose a
  thread, command, card or schedule is. Messages, pictures and reads for
  another runner's thread go as for an id with no row (dropped, empty);
  another runner's schedule is as good as missing; and a runner key's
  Pocket titles are its own (keys `<runnerId>:<title>`), so filing one
  never collides with, or reveals, the main Mac's.
- **After a migration.** Rotating the owner key stops the old key working
  wherever a copy is, but not a deploy key or Convex login that can read
  env vars, nor what the old key made. `rotate-owner` asks Convex for the
  deployment's deploy keys (the management API, with a team access token
  given for that run only as `CONVEX_TEAM_TOKEN`, never kept; an answer in
  an unexpected shape is an error) and won't start while it lists one this
  Mac didn't make itself (the names it recorded when it made them, in
  `secrets/made-deploy-keys`), or can't be asked, unless Mike has looked
  and passes `--keys-checked`, after it shows them again. CLI logins can't
  be listed: they're revoked in the dashboard. `tb runner check` flags a
  team token left on disk. `tb runner audit` (and `rotate-owner --finish`,
  which runs it) lists, numbered and a page of one section at a time, live
  phone tokens (which main key issued each, since runner keys), live runner
  keys (flagging one for this Mac's own id, or any the main key has named
  as its own), the main key's runners' schedules, Pocket cards filed with a
  main key, and messages and pictures past each of this runner's threads'
  own last seq, a few at a time; runner keys' own schedules are listed
  apart, unnumbered. `--drop 2,5 --snapshot <hex>` takes out those exact
  rows, each only if it's still the version listed, and only if a fresh
  listing has the same snapshot (rows, ids and versions). A planted message
  at a seq the thread has since reached can't be told from a real one; the
  main runner writes its own over it when it sends that seq again. `tb
  runner revoke <runnerId> --purge` takes out everything a revoked runner
  wrote, a page at a time (a long thread takes a few calls): only for a
  runner that had a key of its own, never this Mac's or one the main key
  has named as its own. The audit's pages are sized to how big their rows
  can be. Every string from another Mac or a runner key that `tb runner`
  prints is stripped of control characters and escape sequences and never
  put in a command it tells you to run; a runner key's schedule ids must be
  UUIDs, and a panel key's name is used only if it looks like one
  Threadbear made. `--finish` refuses unless this Mac's key is the one in
  `RUNNER_KEY_NEXT`, and setup won't copy or set `RUNNER_KEY` while it's set.
- **The main Mac comes first.** A heartbeat with the owner key marks the
  runner's row `byOwner`; making a runner key clears it for that runner at
  once, and a runner with a live key never counts as the main Mac. Nothing
  guesses which runner is the main Mac from its thread count: a key for a
  busy second Mac is fine, and only the asking Mac's own id is refused. A
  phone's new thread with no runner named (`phone:create`,
  `phone:quickAsk`) goes to the online `byOwner` runner with no runner key
  and the most threads, and with none online to `"any"`, which only the
  owner key takes: it waits for the main Mac rather than going to a Mac
  with a runner key. Picking a Mac on the phone still sends it there.
- **What's still trusted from the mirror.** Nothing more than before: the
  phone still keeps runner keys from pairing links only, and the app still
  takes another runner's host only from its `.host` file (Secrets,
  "Trusting the key"; Other runners' threads). Those pins now guard
  against the owner key or the backend itself, not every runner.

Who may call each function in `convex/sync.ts`. "Owner only" is the owner
key; "its own" is any key for its own runner's rows (the owner for
anyone's); "any runner" is any good key. Anything not sorted is owner only.

| Function | Who | What "its own" means |
|---|---|---|
| `heartbeat` | its own | `runner.runnerId` is the key's; a name another runner has gets its id after it |
| `bye` | its own | `runnerId` |
| `setPresence` | its own | `runnerId` |
| `upsertThreads` | its own | each row's `runnerId` is the key's, and so is the row it replaces: no taking or moving another runner's thread, its secret card's key or where its commands go. A new row only under an id that's had nothing but its runner (Thread ids, above) |
| `removeThreads` | its own | the row's runner; for an id with no row a runner key leaves what's there alone |
| `prune` | its own | `runnerId`; each pruned thread's messages and pictures go too, and it gets a tombstone |
| `threadsOf` | its own | `runnerId` |
| `appendMessages` | its own | each message's thread row is the key's runner's; one for an id with no row is dropped |
| `messageHeads` | its own | `runnerId` |
| `replyImages` | its own | the thread's row is its runner's; none: empty |
| `addReplyImage` | its own | the thread's row is its runner's, and the file no other runner's row uses; none: dropped, and the upload deleted if nothing uses it |
| `shareImages` | its own | the thread's row is its runner's; none: empty |
| `addShareImage` | its own | the thread's row is its runner's, and the file no other runner's row uses; none: dropped, and the upload deleted if nothing uses it |
| `dropShareImages` | its own | the thread's row is its runner's; none: nothing |
| `setProjects` | its own | `runnerId` |
| `upsertProjects` | its own | `runnerId` |
| `projectIcons` | its own | `runnerId` |
| `setProjectIcon` | its own | `runnerId`, and the file no other runner's row uses |
| `iconUploadUrl` | any runner | a one-use URL, tied to the key that asked, that records the upload as its runner's; 300 an hour, 10 MB a file, 200 MB an hour |
| `setAccounts` | its own | `runnerId` |
| `upsertAccounts` | its own | `runnerId` |
| `sharedUsage` | its own | readings only for logins its runner has (same provider and email); the owner gets all |
| `pools` | any runner | the shared pools, which every runner follows |
| `savePools` | owner only | pools reach the main Mac's logins and folders |
| `adoptPools` | owner only | as `savePools`; a runner key's runner keeps its own until the main Mac sets them |
| `setSchedules` | owner only | mirrored rows, for a runner on a pre-API 9 schedules.json: no runner key's runner needs it, and it could shadow another runner's ids (its runner stops mirroring, quietly) |
| `schedules` | its own | lists only its runner's schedules; the owner sees all |
| `schedulesSince` | its own | as `schedules`, and hears of only its own runner's rows and ids gone |
| `saveSchedule` | its own | the schedule's `runnerId`, and every row with that id, mirrored ones too: no schedule on another runner; a runner key's ids are UUIDs |
| `deleteSchedule` | its own | the schedule's runner |
| `adoptSchedules` | its own | `runnerId`: replaces only its own old mirrored rows; for a runner key all or nothing (UUID ids no other runner has, within its caps), saying which it held back |
| `claimSchedule` | its own | `runnerId` |
| `releaseSchedule` | its own | the schedule's runner |
| `scheduleRan` | its own | the schedule's runner |
| `runnerWatch` | any runner | a time, nothing about any runner |
| `setRunnerStats` | its own | the `runnerId` it reports for; `machine` and `os` cut to 128 bytes |
| `watchRunnersFromMac` | owner only | wakes every runner to report |
| `runnerStatsList` | owner only | every runner's figures |
| `requestScheduleRun` | its own | the schedule's runner, so only the owner asks another runner to run one |
| `runnersList` | owner only | every runner's id and name, which a Mac posing as another would want; a runner key's scheduler lists only its own runner |
| `pendingCommands` | its own | `runnerId` only: `"any"` commands wait for the owner key |
| `takeCommand` | its own | a command for its runner |
| `finishCommand` | its own | a command for its runner |
| `savePocketCard` | its own | a new card, or one its runner filed (the card keeps `runnerId`, and a `threadId` only of its own thread) |
| `removePocketCard` | its own | a card its runner filed |
| `pocketCards` | its own | lists only the cards its runner filed; the owner sees all, with `filedBy` |
| `setThreadIndex` | its own | `runnerId`; a new row for a thread another runner has or had is left out, so one thread id is one runner's |
| `otherRunnersList` | owner only | other runners' `rpcUrl`s |
| `otherRunnersThreads` | owner only | other runners' sidebars |
| `threadIndexSince` | owner only | other runners' sidebars |
| `issueToken` | owner only | a phone token reads everything and queues commands for every runner |
| `listTokens` | owner only | |
| `revokeToken` | owner only | |
| `addRunnerKey` | owner only | never for `"any"` or the asking Mac's own id (recorded, for the audit); over a live key only with `replace`; at most three live |
| `listRunnerKeys` | owner only | |
| `revokeRunnerKey` | owner only | |
| `audit` | owner only | what the old shared key could have left (`tb runner audit`) |
| `scrubStoredBatch` | owner only | today's secret rules over stored rows, a page at a time (`runner/scripts/scrub-stored.mjs`) |
| `auditRemove` | owner only | takes out the exact rows `tb runner audit --drop` picks, each only if it's still the version listed |
| `purgeRunner` | owner only | `tb runner revoke <runnerId> --purge`: everything a runner with no live key wrote, a batch a call |
| `remoteTail` | owner only | another runner's messages (`convex/relay.ts`, Other runners' threads through the backend) |
| `remoteMessages` | owner only | the same, a page at a time |
| `remoteThread` | owner only | another runner's thread row, its open approval and card |
| `queueCommand` | owner only | work for another runner: a thread's command goes to the runner the backend says has it |
| `commandState` | owner only | |
| `remoteAccounts` | owner only | another runner's logins |

`sync:uploadTicketOk` and `sync:redeemUpload` are internal, for
`/runner/upload`.

## Sharing

A thread can be shared by link on the website (docs/website.md, "Sharing"),
from the share button beside its ... menu, or from the website itself
(a `share` command; see Sync). The runner keeps it on the thread's
record and the mirror carries it to Convex, which serves the link;
nothing about it is decided in Convex.

```ts
type ThreadShare = {
  access: "off" | "link"
  slug: string          // the link is <website>/s/<slug>: 16 random bytes, base64url
  updatedAt: string
}
```

- `"link"`: anyone with the link reads the thread, live as it carries on.
  `"off"` keeps the slug, so sharing again brings the same link back (as
  a doc's sharing does); `newLink` is the way to stop an old link for good.
  (Sharing with specific people, by emailed code, was there on 28 Oct and
  went on 29 Oct; a record that still says `"people"` reads as `"off"`.)
- Readers see the title, the text of each message, one line per tool
  call and the thread's pictures. Never the folder, account, model, cost,
  approvals or a composer, and never tool output.
- Pictures go up only while a thread is shared: a message's attachments,
  what a tool handed back (a screenshot, an image it read or made) and
  pictures the agent wrote into its text as Markdown with a path on the
  Mac (`![alt](/path/to/file.png)`, a `file://` URL or a `~` path).
  When the thread is shared the runner looks through its whole history,
  then sends new ones as they come; each file goes once (`sync:shareImages`
  says what's up), at most 10 MB. Stopping sharing drops them all.
- As the page is public and a path is only what the agent wrote, a file
  goes up only if it's really a PNG, JPEG, GIF or WebP by its bytes (the
  type sent is the one its bytes say, not its name's), isn't itself a
  symlink, and is, by its real path, in the thread's media folder in the
  data dir (`threads/<id>/media`, where attachments and tool pictures are
  copied). Nowhere else: a Markdown path is only text the agent wrote,
  maybe at a repo's or a web page's say, so it can't publish a file from
  the thread's folder, however new (pictures made there since the thread
  started went, and that was still Markdown publishing a local file:
  Daybreak verify-fix, 5 Nov), or from the temp folders, which hold every
  app's screenshots. The file is read through one descriptor opened
  without following a link and checked to be the file at its real path.
  Anything else stays on the Mac with a line in the runner log and shows
  on the page as its alt text. An agent that wants a picture on a shared
  page copies it into the media folder, which every CLI the runner starts
  is told as `THREADBEAR_MEDIA_DIR` (`mkdir -p` it first; it may not be
  there yet), and writes that path in its Markdown.
- The thread's row on the mirror has `share: { access, slug }` (backend
  API 8). An older backend gets the row without it, and gets it once a
  heartbeat says it's new enough.

## Ordering and reconnects

- Persisted events for a thread are delivered in `seq` order with no gaps.
- After a reconnect, the app calls `threads.subscribe` with the last `seq` it
  has; the runner replays the gap, then streams. `inProgress` in
  `threads.events` lets the app show a partially streamed block it missed.
  Deltas sent between a `threads.events` load and the `threads.subscribe`
  never reach the client, so it takes each streaming item's text from the
  subscribe reply's `inProgress` and appends only deltas that arrive after.
- `thread.updated` is level-triggered: the latest summary wins.
- A client that stops reading may miss transient deltas (the persisted
  event replaces them). One that falls far behind is closed with code 4408
  and should reconnect and replay from its last `seq`.

## Tools for agents

Every CLI the runner starts knows which thread it belongs to, two ways: the
`threadbear` MCP server for the agent itself, and environment variables for
the commands it runs (`tb`, the deploy script). Both name the same thread.

Every session, Claude or Codex, gets an MCP server called `threadbear`
(`runner/src/threadbear-mcp.ts`), bound to its own thread, so an agent can
drive Threadbear itself: `list_threads`, `read_thread`, `list_accounts`,
`create_thread`, `send_message`, `update_thread`, `move_thread`,
`interrupt_thread`, `delete_thread`, `schedule_message`,
`list_schedules`, `update_schedule` and `delete_schedule` (see Schedules),
and `list_projects`, `read_project`, `create_project`, `update_project`,
`join_project` and `leave_project` (see Projects), and `pin` and
`unpin` (see Highlights), `show_panel` (see Showing panels), and
`wait_for_app_restart` (see App restarts).
`list_accounts` shows each account's provider, note and room left, then
the pools with their logins and room, and which pool a new thread starts
on; `create_thread` and `move_thread` take Codex accounts, and
`create_thread` and `update_thread` take a `pool` (an id or title;
`update_thread`'s `null` or `"pin"` pins the thread to its login). They call the same runner methods as
the requests above, so once a restart has begun `create_thread` and
`send_message` get its "send again in a moment" too. Messages an agent sends
to another thread (or as a new thread's first message) start with a line
saying which thread sent them, `[Sent by the agent in the thread "<title>"
(<id8>)]` (on one line); the app draws such a message as a card from that
thread rather than as Mike's. The `then` a thread's agent gives
`move_thread` starts with `[Sent by the agent before moving to <folder>]`
instead, and the app draws it as a card from the thread's own agent. The
runner doesn't take either kind for Mike's: they leave reviews open and
don't stop a turn for a waiting login switch, and `read_thread` and the
handoff note label them as the agent's. `delete_thread` always asks for approval,
even in a thread with full access, and no tool can delete, interrupt, snooze
or archive the thread that's calling it; `tb` inside a thread refuses the
same. There's no tool for restarting the runner: that's `runner.restart`.

| Variable | Value |
|---|---|
| `THREADBEAR_THREAD_ID` | the id of the thread the CLI belongs to |
| `THREADBEAR_HOME` | the runner's data dir, where `tb` looks for a runner (agents may point it at a dev runner) |
| `THREADBEAR_RUNNER_HOME` | the runner's data dir too, which agents never change: the scripts' guards against restarting the runner a thread runs on go by it |
| `THREADBEAR_RUNNER_VERSION` | the runner's version, as in `hello` |
| `THREADBEAR_MEDIA_DIR` | the thread's media folder (`<data dir>/threads/<id>/media`): the only place a shared page's pictures come from (see "Sharing") |

The runner also puts its own `bin/` (the release's, or the checkout's for a
runner run from source) at the front of `PATH`, so a bare `tb` in a thread
is the `tb` that matches the runner.

## Older and newer clients

Either side may be upgraded first, so each tolerates the other:

- An app older than Codex support reads `provider: "codex"` as a plain
  string, an unknown tool `kind` (`image`) as `other` and `ultra` as text;
  lists Codex models under its fallback heading; and may still send a
  Claude alias for a Codex thread, which the runner corrects (above).
- A newer app talking to an older runner gets `-32601` from `clis.*` and
  leaves the CLI part out, sees no `usage` on accounts and says the numbers
  need a newer runner, and sees no Codex accounts.
- An app older than Connectors ignores `connectors.updated`, and a
  `show_panel` for `connectors` waits for Mike's next message as an
  unknown panel does. A newer app talking to an older runner gets
  `-32601` from `connectors.status` and leaves the Connectors icon out.
- An app older than Showing panels ignores `panelRequest`, so a request
  waits until Mike's next message clears it, and `show_panel` says it's
  waiting. A newer app never sees one from an older runner.
- An app older than pools sends `accountId` with every `threads.create`,
  so its threads are pinned as before, and it ignores `pools`, `poolId`,
  `waitingForRoom` and `pools.updated`. A newer app talking to a runner
  older than pools sees no `pools` in `hello` (and `-32601` from
  `pools.*`), and shows logins as before.
- An app older than Devices never asks for them. A newer app talking to a
  runner older than Devices gets `-32601` from `devices.*` and says the
  Phone & browser tab needs a newer runner.
