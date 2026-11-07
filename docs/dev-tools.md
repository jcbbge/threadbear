# Dev tools for working on Threadbear from inside Threadbear

Mike develops Threadbear from Threadbear threads, so the runner a thread
runs under is the thing being changed. Today that's fragile:

- The LaunchAgent runs `runner/src/main.ts` straight from the main
  checkout. Any merge to main changes the live runner the next time it
  restarts, and a runner that won't start takes every thread down,
  including the one that could fix it.
- Restarting the runner kills the turn that asked for it, and nothing
  carries on afterwards.
- An agent can't see the runner's state, read a thread as text, or
  reproduce a rendering bug from one of Mike's real threads without
  hand-made fixtures.

The built-in `threadbear` MCP server every session gets (create, update,
delete and move threads; `runner/src/threadbear-mcp.ts`) was built
separately and merged alongside this. Both are bound to the same thread
(see "Tools for agents" in `docs/protocol.md`). A `restart_runner` MCP
tool would be a thin wrapper over `runner.restart` below; it isn't built,
since from a thread runner changes go out through the deploy script.

## Phase 1: runner side

### 1. Runner releases

The live runner runs from a snapshot, never from a checkout. Layout under
the data dir (`<home>`, normally `~/Library/Application Support/Threadbear`):

```
~/Applications/Threadbear Runner.app
                       the LaunchAgent's program: a small signed app that
                       runs `node launch.mjs` as its child, so macOS's
                       privacy prompts for the runner and its agents say
                       "Threadbear Runner", not "node", and the grants stay
                       with the app across Node updates and runner releases
                       (runner/launcher/; a sandbox's lives in its
                       <home>/runner/)
<home>/runner/
  launch.mjs           the runners' supervisor, started by the app:
                       small, no dependencies
  releases/<id>/       src/, bin/, package.json, package-lock.json,
                       node_modules/ (production only), release.json
  current -> releases/<id>
  state.json           { current, previous, lastGood, boots, rolledBack? }
```

- **Release id:** `<UTC yyyymmddThhmmssZ>-<short commit>`, plus `-dirty`
  when built from uncommitted files. `release.json` is
  `{ id, commit, dirty, builtAt, node }`.
- **state.json** (atomic writes: temp file then rename):
  `{ "current": id, "previous": id|null, "lastGood": id|null,
  "boots": [{ "release": id, "at": iso }], "rolledBack": { "from", "to",
  "at" }? }`. Keep the last 20 boots.
- **launch.mjs** records a boot. If `current` has booted 3 times in the
  last 2 minutes without being marked good (since built: 10 minutes, with
  clean stops not counted and a 90 s startup watchdog, so planned restarts
  never trip it and a hang does; see `runner/README.md`), and `lastGood`
  is a different
  release that still exists, it points `current` at `lastGood`, records
  `rolledBack`, and logs it. Then it starts `current/src/main.ts` as a
  child process (Node 24 runs TypeScript directly) with
  `THREADBEAR_SUPERVISED=1` and an IPC channel, and supervises it (below).
  Before 27 Oct it imported main.ts into its own process; a LaunchAgent
  installed before then still does, and can't hand over until Mike runs
  `install-runner.sh` once.
- **The supervisor** (launch.mjs since 27 Oct). A child counts as up when
  it sends `{ type: "listening" }` or prints `threadbear-runner listening
  on <port>` (older releases only print it), within 90 s or it's stopped
  and counts as a failed start. The newest child exiting 0 after it
  listened is a planned restart: it starts `current` again within a
  second. Any other exit is a failed start: with no other child running
  the supervisor exits 1 and launchd starts it again, as before; with one
  it tries again itself after 5 s. SIGTERM (launchctl, a reboot) goes to
  every child, which get 20 s before SIGKILL (the plist's ExitTimeOut is
  30). A child that loses its IPC channel stops.
- **Handovers** (docs/protocol.md, "Handovers"). An idle restart with busy
  threads (a deploy, the runner following main) doesn't wait for them.
  The runner lets go of its idle threads and the port, writes
  `run/drain-<pid>.json`, and sends `{ type: "handover" }`; the
  supervisor starts `current` beside it and answers `{ type: "handover",
  ok, pid }`. The new runner connects to the old one and passes it
  requests about the threads it kept; each moves across when its turn
  ends, and the old runner exits when it has none left. Its exit isn't a
  restart. `tb status` shows it as "Old runner ..., finishing N threads".
  If the supervisor refuses, the runner restarts the old way.
- **main.ts** reports `RUNNER_VERSION` as `<package version>+<release id>`
  when a `release.json` sits next to its `src/`, else `+source`. Once it
  has been listening for 60 seconds it sets `lastGood` to its own release.
  If `state.rolledBack` is set and hasn't been reported, it sends a
  `runner.notice` warning at startup and to every client that says hello
  ("Release X kept crashing at startup, so the runner went back to Y."),
  then marks it reported.
- **`runner/scripts/deploy-runner.sh`**
  `[--skip-checks] [--allow-dirty] [--now [--force]] [--wait 30m]
  [--resume "text"] [--rollback] [--list] [--home DIR] [--label LABEL]
  [--dry-run]`:
  1. Checks: typecheck and unit tests with the pinned Node.
  2. Snapshot of the committed `runner/` at HEAD (refuse uncommitted
     changes under `runner/` unless `--allow-dirty`), then
     `npm ci --omit=dev` inside the release.
  3. Smoke test: start the release with a temp `THREADBEAR_HOME` and
     `THREADBEAR_PORT=0`, say hello over the WebSocket, check the version
     carries the new id, stop it.
  4. Activate: swap the `current` symlink atomically, record `previous`.
  5. Restart (section 2).
  6. Health: within 30 s of the restart, hello must report the new release
     id. If not, point `current` back at `previous`, restart, print the
     tail of the runner log and exit nonzero.
  7. Keep the newest 5 releases plus `lastGood`.
- **`install-runner.sh`** installs `launch.mjs`, builds the first release
  through `deploy-runner.sh`, and points the plist at
  `Threadbear Runner.app/Contents/MacOS/Threadbear Runner node
  <home>/runner/launch.mjs`. It builds the app (`launcher/build-launcher.sh`,
  one `swiftc`, signed like the Mac app) only when it's missing or
  `runner/launcher/` changed since, so a launcher change ships by running
  `install-runner.sh` again, which only Mike can do for the real runner;
  releases and Node updates never touch it. The runner can't reinstall
  the launchd job it runs in, so when it follows main it says instead:
  each check compares main's `launch.mjs` with the installed one, and
  main's `runner/launcher/` hash with the app's `build.json` (the app named
  by `THREADBEAR_RUNNER_APP` in the plist, else the process above
  launch.mjs), and a runner with neither still runs node as the program.
  Any of those sets `launcherChanged` and `launcherReason`, which
  `tb status` and the app's Updates panel show with the command
  (`launchAgentBehind` in `src/update.ts`). `--uninstall` leaves the app
  where it is. `--from-source` keeps today's run-from-the-checkout mode for
  debugging. `--home`, `--label` and `--port` allow a sandbox install next
  to the real one (the plist then sets `THREADBEAR_HOME` and
  `THREADBEAR_PORT`).

### 2. Restarting without killing the turn

- **Protocol** (update `docs/protocol.md` first):
  - `runner.restart { when?: "idle" | "now", resume?: { threadId, text },
    reason?: string }` returns `{ scheduled: boolean, waitingFor: string[] }`
    (`waitingFor`: the ids of threads keeping it from restarting).
  - `runner.status {}` returns `{ version, release?, pid, startedAt, home,
    liveClis, running: string[], pendingRestart?: { when, reason?,
    resumeThreadId?, requestedAt } }`.
  - `user.message` gains an optional `origin: "runner"` for messages the
    runner sends by itself. Old apps ignore it.
- **Idle** means no thread is running, starting, or waiting on an approval
  or a question. A pending restart is saved in `<home>/restart.json` so a
  crash doesn't lose it, and clients get a `runner.notice` ("The runner
  will restart when 2 threads finish."). A new `threads.send` while a
  restart is pending still works; the restart waits for that turn too.
- **When idle**, the runner shuts down the same way it does on SIGTERM and
  exits 0; launchd's KeepAlive starts it again. `when: "now"` does it
  straight away (threads mid-turn become `stopped`, as today).
- **On the next start**, if `restart.json` has a resume less than 15
  minutes old: append a `system.note` "Runner restarted: <old version> to
  <new version>" to that thread, then send the resume text as a new turn
  with `origin: "runner"`. At most 3 automatic resumes per thread per
  hour; past that, only the note. Delete `restart.json` once handled.
- **Environment:** every CLI the runner starts gets `THREADBEAR_THREAD_ID`,
  `THREADBEAR_HOME`, `THREADBEAR_RUNNER_VERSION` and `THREADBEAR_MEDIA_DIR`.
- **deploy-runner.sh's restart step:** by default it calls
  `runner.restart { when: "idle", resume }`. Inside a thread
  (`THREADBEAR_THREAD_ID` set) the resume defaults to "The runner restarted
  on release <id>. Check that your change works, then carry on." `--now`
  kickstarts the LaunchAgent, and is refused inside a thread unless
  `--force`. If the live runner is older and doesn't know `runner.restart`
  (method not found), poll until idle (`--wait`, default 30m) and then
  kickstart; inside a thread, print the command for Mike instead.

### 3. `tb` additions

- `tb status [--json]`: `runner.status`, readable.
- `tb self [--json]`: the calling thread, from `THREADBEAR_THREAD_ID`.
- `tb restart [--now] [--resume "text"] [--reason "text"]`.
- `tb show <id> [--last N] [--tools]`: the thread as plain text: user and
  assistant messages, one line per tool call (with `--tools`, results
  too), approvals, notes, turn footers. A call's diff, approval and result
  go under it, so parallel calls' results don't land under the wrong one.
- `tb events <id> [--from N] [--to M] [--json]`: events by seq, each line
  starting with its seq (Copy debug info gives the command). Every tb
  command refuses flags it doesn't read, and `tb <command> --help` shows
  just that one.
- `tb logs [-f] [-n 200] [--thread ID]`: the runner log, optionally
  filtered to one thread.
- `tb export <id> [--out DIR]`: `thread.json`, `events.ndjson` and
  `media/` in the mock runner's fixture format, by default under
  `app/.fixtures/threads/<id>` (private and gitignored), so a rendering bug
  in one of Mike's threads can be reproduced against the mock runner.
- `tb rpc <method> [json]`: a raw call, printing the result.

### 4. Dev runner and one check command

- `runner/scripts/dev-runner.sh [--home DIR] [--port N]`: runs the working
  tree's runner in the foreground on a temp data dir (refuses the real
  one) and prints the `<home>/tb` for `tb` and the `dev-app.sh start
  --home` line for the app. A new data dir's `runner.json` defaults threads
  to `<home>/work`, claude-main (or `TB_E2E_ACCOUNT`) and claude-haiku-5-5 (`defaults.model`, which
  the runner applies to a `threads.create` with no model).
- `./check.sh [--quick | --app] [--e2e] [--shots DIR]` at the repo root:
  runner typecheck, unit tests and deploy tests, app `swift build` and
  `swift test` (with the mock runner's packages installed and its tests
  required). `--app` is the app's part alone. `--e2e`
  adds the runner's real-model e2e (cheapest model, temp dirs); `--shots`
  runs `app/Tools/screenshots.sh`. One line per step, nonzero exit if
  anything failed, pinned Node 24.

### 5. Docs

`AGENTS.md` ("Working on Threadbear from inside Threadbear", kept short),
`runner/README.md`, `docs/protocol.md`.

## Phase 2: app side

Built on 2026-10-27. How to use it is in `app/README.md` ("Seeing and
driving it from a script") and in AGENTS.md ("Seeing and driving the app").

- `app/Tools/dev-app.sh start [--mock [--fixtures DIR]...] [--home DIR]
  [--appearance light|dark] [--size WxH] [--id NAME]`, then `do
  '<json>'...`, `shot <file>`, `dump [--json]`, `rebuild`, `log`,
  `stop [--all | --everyone]`, `status`. Each instance is a debug build in
  a temp bundle with its own bundle id (its own settings), data folder,
  automation notification name and pasteboard (`--automation-id`), so
  several run at once. Instances belong to the thread and checkout that
  started them: commands take `--id`, defaulting to the caller's newest,
  never another thread's, and `stop --all` stops only the caller's. An
  instance quits after an hour with no command and its mock exits with it;
  `start` and `status` clean up after ones that quit. `shot` runs
  screencapture from the caller's shell (the temp bundle has no Screen
  Recording permission) and falls back to the app's own drawing. It
  launches with `open -g` and the app orders its window to the back as soon
  as it exists. `do` tags each command with a request id and waits for that
  result line; an error result or a timeout exits 1. `--fixtures` takes
  `tb export` folders; `--home` a dev runner's data dir (never the live
  one). `stop` quits the app, stops its mock and deletes the bundle, the
  data, the logs and the bundle id's preferences.
- The scripted app refuses the installed runner's data folder unless
  `--automation-allow-live`, never saves window sizes, and has `focus`
  (counts as looking, so threads get marked read) and `window` (its id for
  screencapture); `options` refuses unknown keys and reports what's set,
  and `dump` shows what a send from the composer would run on.
- Automation commands added or rounded out: `open` (waits for the rows),
  `screenshot` (in-process when the screen is locked), `dump` (sidebar
  rows by section; transcript rows with id, kind, height, open or not, on
  screen or not, an excerpt; selection, composer text, banner), `hover`
  (sidebar or transcript rows), `expand` and `collapse` (groups, tools,
  changed files, whole diffs), `scroll`, `appearance`, `resize`,
  `waitFor` (row, kind, status, text, banner, connection, ready, with
  `not` and a timeout), `new`, `type`, `send`, `menu` (a row's context menu,
  or one of its items), `debug-info`, `copy-thread-id`, `clipboard` and
  `mock` (`mock.*` methods only). Still debug builds only.
- The app's own log (connection, RPC errors, runner notices, automation
  commands) goes to the unified log, and with `--automation` to a file
  beside the automation log too (`--app-log`); `dev-app.sh log` tails it.
- A pending runner restart is a quiet grey line under the toolbar ("The
  runner will restart when 2 threads finish.", or "when 1 thread finishes
  and you answer 2." when some wait on Mike; the threads in its tooltip),
  from `runner.notice` and `runner.status`; while the runner is down it
  says "The runner is restarting. Reconnecting…" with a spinner and the
  app retries every half second. A `user.message` with `origin: "runner"`
  is a centred note, "Sent by the runner after it restarted" over its text.
  The mock has `runner.status`, `mock.restartPending` and `mock.restart`,
  and `Tools/screenshots.sh --only 11` shoots all three states.
- A thread whose turn ended with background sub-agents or shell jobs
  still going (`ThreadSummary.background`) sits under Running with a grey
  spinner and what's running ("3 sub-agents"), and its transcript ends
  with the bear and "3 sub-agents working in the background · ...", until
  the CLI has read every result. The demo thread "Rebuild the three
  landing pages" starts that way; `mock.background` sets it on any thread.
- "Copy debug info" on every transcript row (thread, row, kind, turn, the
  seqs of the events it came from, the runner's version) and "Copy thread
  id" in the ... menu. A scripted app copies to its own pasteboard.
- "Start runner" only shows when the app uses the installed runner's data
  folder, so a debug app against the mock or a dev runner can't kickstart
  the live one.

## After the phase 2 reviews

Three reviewers used the tools to fix planted bugs, read the code, and ran
everything in a sandbox. What changed (2026-10-27):

- tb's suggested commands (`restart --cancel`, `events`) name the tb that
  was run: a dev runner's `<home>/tb` sets `THREADBEAR_TB`, and the deploy
  script puts `THREADBEAR_HOME=<home>` in front for a sandbox. A bare tb
  pasted in a thread reached the live runner, where `restart --cancel`
  withdrew the deploy waiting for that very turn. `tb restart --cancel` now
  only withdraws the calling thread's own restart on its own runner;
  `tb rpc runner.restart` is always refused, `tb rpc threads.update` won't
  snooze or archive its own thread, and flag errors never list `--force`.
- The deploy watches a new release for 20 s (or until it's marked good)
  before saying it's up, `runner.status` and `tb status` say when the
  runner went back to its release after a crash, `launch.mjs` logs an
  unclean exit, a redeploy of a commit that crashed gets a note, and
  pruning drops crashed releases first.
- A crash rollback's resume replaces the crashed release's in the hourly
  count, and `runner.restart` returns `noResume` when the resume won't be
  sent, so the deploy script and tb say so instead of promising it.
- dev-app.sh's mock runs in its own session (a live runner restart used to
  stop it), `status` and the commands notice a stopped runner, `rebuild`
  can't lose the mock, the bundle is `LSUIElement`, and in-process shots
  are moved from the agent's shell. Automation commands that act on a
  thread take `id` or the open thread and refuse an ambiguous one, `send`
  prints a new thread's id, `debug-info` copies, `mock` refuses params
  that aren't an object (they crashed the app), and dump's columns fit
  real ids. Copy debug info names the runner the app is on.
- `./check.sh` prints what failed before the end of the log;
  `screenshots.sh` takes `--help` and options in any order; dev-runner.sh
  deletes the temp home it made when it stops; the mock moves the demo
  threads' times to now and finishes the threads a restart waited for.

## Safety during the build

- Nothing touches the live runner, its LaunchAgent
  (`com.mikerosoft.threadbear.runner`), `~/Library/Application
  Support/Threadbear` or `~/Applications/Threadbear.app`. Trials use a temp
  `--home`, a free port and a test label such as
  `com.mikerosoft.threadbear.runner.devtest`, booted out and removed
  afterwards.
- The real switch to releases happens after review, when no thread is
  running, through the deferred restart itself.

## The app updating itself

Added 2026-10-27. The runner has releases and a deploy script; the app
needed Mike to run `restart.sh`, which also threw away his composer. Now
the installed app follows main on its own (`app/AppUpdate.swift`,
`app/stage-update.sh`, the README's "Build and run" section): it notices a
change under `app/` on main within five minutes, builds it in the
background from a clone (never the working tree), and swaps the bundle in
on quit, at the next launch, from "Restart to Update" in the app menu, or
by restarting itself once nothing is running, nothing is typed and Mike
isn't in the app (reopening the thread he had open).
Only `app/` counts: a runner or docs commit doesn't rebuild the app. The
build is `nice`d and uses its own scratch folder, so it never waits on or
disturbs an agent's `swift build` in the checkout.

## The runner updating itself

Added 2026-10-27, the same day. A runner that runs from a release follows
main too (`runner/src/update.ts`). Starting 30 seconds after its release
is marked good, and every five minutes after that, it brings its own clone
of the checkout it was built from (`release.json`'s `checkout`, under
`<home>/runner/update/src`) to main and compares what a release holds of
`runner/` there (`src`, `bin`, `package.json`, `package-lock.json`: the
`tree` in `release.json`, the joined `git ls-tree` hashes) with what's
running. A commit that only touches tests, scripts or docs changes nothing.
When main differs it runs `deploy.mjs --no-restart` from the clone, which
is the deploy script's own steps (typecheck and unit tests in the clone,
snapshot, smoke test, point `current` at the release) and nothing from
the working tree, then asks `runner.restart` for the usual restart once no
thread is busy (background work holds it 30 minutes at most; under
`launch.mjs` it's a handover instead, see protocol.md) with the
reason "Updating to main at <short>: <subject>". `launch.mjs`'s crash
rollback covers a release that doesn't come up.

- A build that fails starts a thread in the background to fix it
  (`runner/src/fix-update.ts`; Mike, 6 Nov: the old banner came up often,
  mostly for tests that flaked on a busy Mac, and told him nothing he could
  act on). The thread reads the output, fixes the cause on main (or clears
  `update.json` when a rerun is all it takes), watches `tb status` until
  main goes through and archives itself, so Mike only sees it when it needs
  him. One at a time: a failure at a newer commit goes to the open thread.
  A failed backend deploy does the same. Only when no thread can be started
  (a release that doesn't record its checkout) is it a `runner.notice`
  warning instead. Either way `tb status` shows it. The failure is
  kept in `<home>/runner/update.json`, and not tried again until
  something under `runner/` changes on main. That includes a fix to a
  test alone, though it changes nothing that runs: a failure in the checks
  is often fixed that way. Its output is in `<home>/runner/update.log`. A tree whose
  release crashed at startup isn't built again either. A deploy that
  couldn't run (another deploy holds the lock) is just tried next time.
- Nothing happens while a restart is pending, while `current` names a
  release that hasn't started yet, from a runner run from a checkout, or
  from a release built before `release.json` recorded its checkout (deploy
  once by hand, or reinstall, to get one that does).
- The updater passes `--follow <checkout>` to deploy.mjs, so each release
  it builds records the checkout it was following, not its own clone. A
  release that names the clone (built before 27 Oct's fix) can't see main
  and says so in `tb status`; one deploy by hand from the checkout fixes it.
- `followMain: false` in `runner.json`, or `THREADBEAR_FOLLOW_MAIN=0`,
  switches it off. `runner.status` reports it as `update`; `tb status`
  shows the line.
- `deploy-runner.sh` still works as before, for a deploy that shouldn't wait
  five minutes, a branch, or a dirty build; the updater sees the release
  waiting and stays out of the way until it's running.
