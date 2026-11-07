# Agent guidance for threadbear

The app was called Threadbare until 27 Oct 2026. Everything was renamed then
(repo, folders, data dir `~/Library/Application Support/Threadbear`, the
`com.mikerosoft.threadbear.*` labels and bundle id, `THREADBEAR_*`
variables). The old `THREADBARE_*` names still work as stand-ins for the
new ones, and threads still get both, for skills written before.

Threadbear is Mike's own agent app: a TypeScript runner daemon (`runner/`)
that drives the official Claude Code (and later Codex) CLIs, and a native
SwiftUI + AppKit Mac app (`app/`) that talks to it over the protocol in
`docs/protocol.md`. Read `docs/plan.md` and `docs/protocol.md` before changing
anything. The Convex mirror, the iPhone app (`ios/`) and the website (`web/`)
are in `docs/convex-backend.md` and `docs/website.md`. The public landing
page (threadbear.mikecann.app) is `site/`, a separate
static site with its own `package.json`; its comments say how to build it.

This file is written for Mike's own copy. The machines it names (the M5,
`bruce`, `cloud`, `tinker-desk`) and paths under `~/dev/me` are his: in
anyone else's copy (`origin` isn't mikecann/threadbear), skip those steps
and ask the user what they use instead, rather than trying to reach them.

## Rules

- Test first for anything non-trivial. While you work, run the one test
  file or test you're on: `node --test test/unit/<name>.test.ts` in
  `runner/`, `swift test --filter <Tests>` in `app/`. Whole suites go
  through `./check.sh`, which runs them on a check host (Tinker Desk, or
  the cloud box for a `--quick` run, `checkHosts` in runner.json), not on his Mac: three threads' suites
  at once took it to a load of 75, and a test window came up over his
  browser (6 Nov). A hook blocks `npm test` and `check.sh --local` here.
- Changing a threadbear tool's arguments: keep taking the old ones. A resumed
  Claude session keeps a tool's definition from when it first loaded it, and
  ToolSearch shows that one too, so it goes on calling the old form
  (docs/protocol.md, "One reply"; `end_turn` handles this).
- What every agent is handed (the threadbear tools' names, descriptions
  and arguments, and the standing instructions) has a byte budget,
  `runner/context-budget.json`, checked by
  `test/unit/context-budget.test.ts`. A change that alters it fails until
  you run `npm run context-budget` in `runner/` and commit the file with
  it, so the size change is in the diff. Mike wants agents' tools and
  standing context kept lean: before accepting growth, see if it can be
  shorter or go behind something agents look up.
- The protocol is the contract. Change `docs/protocol.md` first, then both
  sides, and keep both sides tolerant of unknown fields and event types.
- Only ever spawn the official `claude` (and later `codex`) binaries under
  Mike's own logins. Never read or copy OAuth tokens or Keychain credentials.
- Tests that hit a real model use the cheapest model, tiny prompts, a temp
  working folder and a temp runner data dir, never the real one.
- Never kill processes you didn't start; T3 Code runs the same CLIs.
- Screenshots: capture the app window only (by window id), never the full
  screen, and delete them when done unless they're for a PR. Pictures of the
  app for anyone else to see (README, the site, PRs, the App Store) are dark
  mode unless Mike asks for light: `screenshots.sh --appearance dark`,
  `sim-shots.sh --dark`, `dev-app.sh start --appearance dark`.
- UI copy: plain words, no eyebrow or kicker labels, no em dashes.
- A menu that picks one of several things with a default (a machine, a
  file link's action, the browser) also sets the default from that same
  menu, and marks the default with a star. Mike asked for it on the
  runner menu on 5 Nov with "Again... like we have done for other menus".
- A commit that other people's copies should bring in soon (a security or
  data fix) gets an `Important: <why, in a few plain words>` trailer. Their
  runners start a thread to bring in the release that has it straight away
  rather than on their 5-day timer (`runner/src/bring-in.ts`), and the why is
  what they read. Use it rarely, or it stops meaning anything.
- `docs/guide.md` is the user guide, and every thread's agent is pointed at
  it (`guideLine` in `runner/src/threadbear-mcp.ts`). Keep it true when a
  change alters what someone using the app sees or does.
- `docs/on-your-mac.md` lists everything Threadbear installs, runs in the
  background, reads and talks to. A stranger's agent checks the code
  against it before installing (README's prompt), so anything missing
  from it looks like something hidden. Keep it true when a change adds a
  file outside the repo, a timer, something it reads, or a network call.
- `docs/forking.md` says where each feature lives, how to take it out,
  and every value that's Mike's own (bundle ids, team id, keys, Sentry,
  the push relay, his repo's checks). Keep it true when a change adds a
  feature, moves one, or adds anything of Mike's to the code; anything
  of his that only his setup needs belongs in his runner.json, not in
  the code.
  This repo's own patches (`.threadbear/patches`) show in every fork:
  `test/unit/fork-view.test.ts` lists what a stranger's copy shows, so a
  chip for one of Mike's accounts needs a `when` that only his Mac passes.
- The first-run tour (app/Sources/Threadbear/Views/Tour.swift), its sample
  threads (`threads.samples`) or anything a step points at: run
  `node app/Tools/tour-e2e.mjs` before landing. It plays the whole tour
  against a real dev runner and debug app, checks each step, and saves a
  shot of each; look at the shots too. The mock fakes patches and trust,
  and tours that passed on it were broken on a real install (30 Oct).
- Building a design Mike picked (show_options): before landing, put a
  shot of the build beside the mockup he picked and check the layout
  matches, not just the wording. The done card shipped as a card in the
  transcript when he'd picked one joined to the composer (30 Oct).
- Animations: hand anything longer than a hover fade to Core Animation
  (keyframes, `animator()`, SwiftUI's own animations), never step it from
  the main thread each frame, and before landing try it with the main
  thread busy (a temporary sleep after the click). The archive flight
  stepped from a display link showed Mike a couple of frames, as the
  same click opens the next thread (30 Oct). The perf run
  (`app/Tools/perf-run.sh`) times archiving too.
- On Mike's Hetzner Cloud runner (and sandboxes to come), git pushes with a
  one-hour token his main Mac hands over (`~/dev/me/misc/github-app` there),
  and the repo's rulesets let it write only `cloud/**` branches: push your
  work as `cloud/<topic>` and say so. `main`, other branches and tags are
  refused; landing happens from the main Mac.
- Assume every action is slow to land. Another runner's thread goes
  through Convex and that runner taking the command (a second or more),
  and the main Mac's runner can be busy. Anything Mike clicks either shows
  the result straight away (an optimistic update the real answer then
  confirms or rolls back, with the error) or shows a spinner and stops
  taking clicks until it lands. Never leave a button that looks idle and
  can be clicked twice. Mike, 6 Nov, after Start it on a cloud thread's
  card sat for a second with nothing happening. The pieces:
  `whileBusy(BusyKey...)` and `isBusy` (`AppModel+Busy.swift`) with `.busy(_:)`
  on the control, `note:` for a click from a menu (it shows in the banner),
  a guess with rollback like `update` and `updateProject`, and in the
  transcript `ThreadSession.answering` with `Spinner` in Cells.swift.
  `EveryClickShowsTests` fails on a new call that changes something on the
  runner until you've done that and listed where it shows.
- Every control gets a tooltip, with `.tip("…")` (SwiftUI) or `setTip` (AppKit).
  `.help` and `toolTip` never show in this app; TipsTests fails on them.
- Transcript files and fixtures made from real sessions are private: keep them
  out of git (`.fixtures/` is ignored).
- Errors go to Sentry (project `threadbear`, tag `component` mac, runner or
  ios) only from what Mike really runs: the installed release app
  (`app/Sources/Threadbear/CrashReporting.swift`), the installed runner's
  release on the real data dir (`runner/src/sentry.ts`) and App Store
  iPhone builds. Debug builds, dev runners, tests, sandboxes and scripted
  runs never report; keep it that way. `THREADBEAR_SENTRY=off` turns it off.
  Never add user text to what's sent. Convex reports through its own log
  stream, so convex/ has no Sentry.
- The Mac app freezing: read `~/Library/Logs/Threadbear/hangs` first
  (`HangWatch.swift`). Each stall of 4 seconds or more has a `sample` of the
  stuck main thread, and one of 15 or more reaches Sentry as "Main thread
  stuck in ...". Fix the frame it names rather than guessing from logs.
- Mike's own repo: work goes to main once tests pass. A thread started in
  this repo has a worktree of its own and lands with `tb land` (below).
  Anywhere several threads share a checkout (the main one, a worktree made
  by hand), stage your own paths by name, never `git add -A`.
- A project can give Threadbear threads panels and action chips through
  `.threadbear/patches/*.ts` (docs/protocol.md, "Patches"). When Mike
  asks for a button or a panel for a project, write one of those there.
  A panel with an `items` function is a native list (rows, no page to
  serve); `.threadbear/patches/checks.ts` has one, Worktrees. Write
  patch files with Edit or Write, not the shell: the runner trusts what
  a Full access thread's Edit and Write calls leave in its own folder,
  and makes Mike trust anything else before it runs (docs/protocol.md,
  "Trusting a folder's patches").
- After landing a change to the Mac app, don't ask Mike to Restart to
  Update or to check it for you: the app restarts onto the new build by
  itself once he leaves it idle. Call `wait_for_app_restart` with what to
  check and end the turn with needs "nothing". The runner messages this
  thread when the app is back on the new build (docs/protocol.md, "App
  restarts"); check it then yourself, with `tb export` of the thread and
  the scripted app (below), and ask him only for a judgement he has to make.
- While Mike has the activity log on (Settings > General; off by
  default, so other people's copies never record), `tb activity` shows
  what he's clicked, opened, chosen and sent in the app lately, and
  `tb activity --summary` what he uses most. Look before changing how
  something works, to see how he really uses it. It's his private
  activity: keep it out of git and out of anything posted or sent.
- Files and links an agent makes for Mike to look at belong in the
  thread's Highlights (the pin on the right-hand rail): use the `pin`
  tool, with `show: true` to open it in the side pane, rather than `open`.
  To put one of the app's own panels in front of him (this thread's
  Highlights or Patches, a patch panel, Usage, Updates), use
  `show_panel`: it opens the panel, or brings it forward where he has it,
  once he's looking at the thread (docs/protocol.md, "Showing panels").

## Tests that need the real screen

A real drag, or anything else needing the pointer or a window in front, doesn't
run on the Mac Mike's working on: it takes his pointer and pulls windows forward,
and a stray drop lands in whatever's on top (6 Nov). Debug apps are kept behind
everything for that reason, so stick to `dev-app.sh`'s automation commands there.
For the real thing, use Tinker Desk's desktop from a throwaway copy, through
`ssh tinker-desk '~/.local/bin/desk "<cmd>"'`, and remove the copy after. A
scripted drag does start from a window of your own. It doesn't start from a
screenshot's floating thumbnail, so that one still takes a person.

Trackpad gestures are the same. Made-up events handed to a handler never meet a
scroll view, and a scroll view that gets any of a gesture takes the rest itself,
so swipes passed every test here and failed on Mike's trackpad twice (7 Nov).
`app/Tools/post-gesture.swift` sends them through the window server. Someone
else may be using that desktop: first check nothing's recording it
(`pgrep -fl ffmpeg`) and that your window really is in front (`front`, then a
look at the screen). Wake its screen with `caffeinate -u`, or the events go nowhere.

## Other people's PRs

The repo's public, so people send fixes. Before starting on a GitHub issue, run
`gh pr list -R mikecann/threadbear` again: someone may have opened a PR for it
since you last looked, as Tyler did for #2 while a thread was writing its own
fix (6 Nov). Their hand test may know more than you can find out. Merge with
`gh pr merge --rebase` so it shows as merged and stays theirs, and put anything
of your own in a commit on top. A comment to them goes past Mike first.

A commit on someone's fork isn't an offer, however good it looks: they haven't
asked for it to go anywhere. Don't suggest bringing one in, and don't take one,
unless Mike asks for that one by name or they've opened a PR. Mike, 6 Nov: "I
don't think you should be pulling in anybody's stuff willy nilly." Telling him
what people have built is fine, and that's all the fork watch schedule does.

## Experiments

Other people run Threadbear since the repo went public (5 Nov 2026), so a
new feature Mike is still trying out lands as an experiment: off by
default, on for him (Mike asked 6 Nov).

- Give it a file of its own, `runner/src/experiments/<id>.md` (copy
  one that's there): its id, name, title, `added` date, `on: false` and
  `reminder`, then what it does (for the guide), where it lives and how
  to take it out (for forks). Check `experimentOn(home, '<id>')` where
  it starts. Put `"experiments": { "<id>": true }` in Mike's
  `runner.json` (`~/Library/Application Support/Threadbear/runner.json`)
  so it's on for him.
- Run `npm run experiment-docs` in `runner/` and commit
  `docs/experiments.md` with it: the guide and the forking table point
  there, and `experiment-docs.test.ts` fails while it's out of date. Edit
  the experiment's file, never the generated doc. One file each and a
  union merge on the doc mean two threads adding experiments at once
  don't collide when they land.
- Book the check-in when it lands: `schedule_message` with `new_thread`
  in this repo, about four days out, telling that thread to look at how
  the experiment has gone and ask Mike whether to turn it on for
  everyone, keep trying it, or take it out. Its id is the file's
  `reminder`; `experiments.test.ts` fails without one.
- When Mike says to make it standard, take the flag out entirely: its
  file, the `experimentOn` check, its key in his runner.json files (the
  M5, `ssh bruce`, `ssh cloud`), then `npm run experiment-docs`. Its
  "What it does" text moves to where the feature belongs in the guide.
  Don't leave a default-on switch behind: every flag
  left in is another path through the code to keep working. If people
  might really want it off, make it a normal setting instead. When he
  says take it out, delete the feature with its flag.
- Not everything needs one: bug fixes and polish go straight in. An
  experiment is for new behaviour that changes what threads do, what
  they cost, or what the runner does to the machine.

## Working on Threadbear from inside Threadbear

Mike may be running this thread in Threadbear itself, through the installed
runner (`com.mikerosoft.threadbear.runner`). Then you have the `threadbear`
MCP tools (list, read, start, message, move and delete threads), and
`THREADBEAR_THREAD_ID` is set, so `tb self` and `tb status` show your thread
and the runner. Both are bound to this thread, and neither will delete,
interrupt, snooze or archive it. The runner puts its own `tb` on your PATH;
if `tb` isn't found (an older runner, or outside a thread), use
`runner/bin/tb`. `tb --help` lists the rest.

- `./check.sh` runs every check (`--quick`: the runner's typecheck and
  unit tests, about a minute; `--app`: the app's build and tests, for a
  change outside `runner/`). With a check host set it copies the checkout
  there, runs it, brings back failed steps' logs and deletes the copy
  (`scripts/check-remote.sh`); one run at a time, so it may say it's
  waiting for another thread's. A host short of disk is passed over (8 GiB
  free for Swift, 2 otherwise), and if none has room the check fails and
  names them. If the host can't be reached it runs here
  at low priority. `--e2e` always runs here, as it needs the claude login. It skips the deploy tests and BearDock's
  unless something they cover changed from main (`--all` runs them
  anyway). The app's part is under a minute with a warm `app/.build` and
  5 to 10 minutes in a folder that has never built, so run it in the
  background. Nothing in it touches the live runner. A failure prints
  what failed and keeps the logs; it says where, so delete them when
  you're done.
- A thread started in this repo (from the app, `create_thread` or a
  schedule) gets a worktree of its own before its first turn:
  `<parent>/threadbear-threads/slot-<n>` on the branch `thread/<id8>`,
  made from main, with `node_modules` linked to the main checkout's
  (`worktree-setup.sh`). The folder is usually an earlier thread's,
  reused with its Swift build caches so the app builds warm. Your system prompt says where. Commit there. When
  the work is done and checked, `tb land` rebases it on main, runs
  `./check.sh --quick` and fast-forwards main in the main checkout
  (`--dry-run` first if you like; it never pushes). Mike's Land chip does
  the same. If it refuses, it says why and what to fix: commit your
  changes, sort out the conflicting files, fix the check, or wait for
  whoever has uncommitted changes in main's checkout. You can carry on
  after landing; the next `tb land` lands only what's new. Changing a
  `package.json`? Replace the link first: `rm runner/node_modules` (no
  trailing slash, so only the link goes), then `npm ci` there. When the
  thread is archived with everything landed, its branch is deleted and
  the worktree kept as a spare for the next thread (or removed, past six).
  docs/thread-worktrees.md has the details.
- A thread started somewhere else (like `~/dev/me/misc`) still needs a
  worktree of its own, as another thread may be editing the main
  checkout. Borrow a spare: `./borrow-worktree.sh` in the main checkout
  prints one, detached at main and set up, with warm build caches. Don't
  `git worktree add` a fresh one: its first app build takes 5 to 10
  minutes. Commit there, then land while holding the same repo lock as
  `tb land`: `threadbear-land.lock` in `git rev-parse --git-common-dir`.
  On a Mac, run a script under `/usr/bin/lockf -k <lockfile>` (Linux:
  `flock -x <lockfile>`). That script must rebase, run the required check
  on the combined revision, and fast-forward main, all while holding the
  lock. A plain `git merge` bypasses queued landings and wastes their
  checks. Don't call a lock-taking `tb land` inside that script. Then run
  `./borrow-worktree.sh --give-back <dir>` so the next thread gets it.
- The live runner runs a release, a snapshot, so editing `runner/` doesn't
  change it. To try a runner change, start `runner/scripts/dev-runner.sh` in
  the background and use the `<dev home>/tb` it prints (a bare `tb` reaches
  the live runner unless `THREADBEAR_HOME` is set in that same command).
  Its threads start in `<dev home>/work` on claude-main (or
  `TB_E2E_ACCOUNT`) and claude-haiku-5-5 (its `runner.json` defaults), from `tb` or a debug app's composer alike.
  Leave `--home` out, or keep it and any extra work folders under
  `$TMPDIR`: Agent Archive skips transcripts from there, but not from
  `/tmp`, so a try-out thread in `/tmp` ends up in Mike's archive.
  Stop it with the `kill <pid>` it prints, never
  `pkill`, and before you deploy or end your turn: the live runner's restart
  waits for it. Its temp data dir goes with it (`--keep` keeps it).
- To ship a runner change, merge it to main (`tb land` from a thread's
  own worktree). The live runner follows main
  by itself: within about five minutes it builds a release of main
  (`src/update.ts`, the deploy script's steps from its own clone) and
  restarts onto it once no thread is busy, which ends your turn if it's
  still running then (`tb status` shows the update's state and the
  pending restart; `tb logs` the result). To ship it sooner, or to get a
  resume into this thread afterwards, run from main
  `runner/scripts/deploy-runner.sh --dry-run` and
  `runner/scripts/deploy-runner.sh`, which ships HEAD of this checkout.
  When it says so, end your turn: the runner restarts once no thread is
  busy and resumes this thread so you can check the change (if it says it
  won't resume this thread, tell Mike in your reply)
  (`deploy-runner.sh --list` shows what's running). If the message that
  resumes you says your release isn't running, read `tb logs` before doing
  anything else. To undo a deploy, `deploy-runner.sh --rollback`; after an
  automatic crash rollback there's nothing to undo. A release that failed
  to build from main is said once in the app and in `tb status`, with its
  output in `<home>/runner/update.log`; fix it on main and it tries again.
- Until `deploy-runner.sh --list` shows releases, the live runner still runs
  from the main checkout and only Mike can switch it (one
  `install-runner.sh` from a terminal). Runner changes wait for him.
- Once launch.mjs supervises the runner (since Mike's `install-runner.sh`
  after 27 Oct), a restart with busy threads is a handover: the new release
  takes over at once, and busy threads (yours included) finish their turns
  on the old runner, then move across. `deploy-runner.sh` says which
  happened. Otherwise a restart waits for other threads' turns and
  background jobs (tests, builds, subagents; background ones for 30
  minutes at most). `tb status` shows what it's waiting for, or the old
  runner and what it's finishing; don't try to hurry either.
- The LaunchAgent's program is `~/Applications/Threadbear Runner.app`
  (`runner/launcher/`), a small app that runs `node launch.mjs` so macOS's
  privacy prompts say "Threadbear Runner", not "node". Releases never
  rebuild it: a change under `runner/launcher/` only ships when Mike runs
  `install-runner.sh` from a terminal. `tb status` and the app's Updates
  panel tell him once it's on main, but say so in your end_turn too.
- Never pass `--now`, run `install-runner.sh`, `tb restart` the live runner,
  `launchctl kickstart` it or stop its node process: each ends your own turn
  and stops other threads' work. If one is needed, finish and tell Mike the
  exact command. `tb restart` is for dev runners and sandboxes.
- Never run `app/restart.sh` or `app/install.sh` yourself: they replace and
  relaunch Mike's own app, in front of his work, and throw away whatever
  he's typed but not sent. To see an app change, use `app/Tools/dev-app.sh`
  (below). His installed app updates itself: a few minutes after `app/`
  changes on main it builds that commit in the background
  (`app/stage-update.sh`, from its own clone under
  `~/Library/Caches/Threadbear/update`, never the working tree) and swaps
  it in when he next quits or relaunches, from "Restart to Update" in the
  app menu, or by itself once nothing's typed and he isn't using the app
  (running threads don't hold it up; the runner keeps the turn). So merge an app change to main and tell him it's waiting;
  `~/Library/Logs/threadbear-update.log` has the build output if it
  doesn't turn up.
- After landing a change to the iPhone app (`ios/`), install it on Mike's
  phone yourself: `taskpolicy -b ios/scripts/install-phone.sh` from the
  landed commit, without asking, so he always has the latest to look at
  (Mike asked 30 Oct). It takes ten minutes or more, so run it in the
  background, and don't `tb land` or rebase while it builds: files
  changing under the compile broke the first try. Say in your reply that
  it's installed, or why it couldn't be (the phone off the wifi, asleep,
  or needing a restart for "cryptexd"). "Unable to launch ... could not
  be unlocked" at the end is fine: it's installed, just not opened.
  That's his own phone only: uploading to App Store Connect still needs
  him to ask.
- The iOS simulator: only ever use your worktree's own,
  `ios/scripts/sim.sh boot` (it prints the id; `stop` when you're done),
  never one picked from `simctl list`. It may be another thread's: on 1 Nov
  one thread installed over another's repro and shut it down, and nothing
  said so.
- `tb show <id>` reads a thread as text (`--tools` for results, each under
  its own call), `tb events <id> --from N --to M` a range of events by seq,
  `tb logs` the runner log, and `tb export <id>` copies a thread into
  `app/.fixtures/threads/<id>` so a rendering bug can be reproduced in a
  debug app (it prints the command). `tb <command> --help` explains one.
- `app/Tools/perf-run.sh` and `app/Tools/run-mock.sh` bring a window to the
  front of Mike's work, so ask him before running them.

## Seeing and driving the app

`app/Tools/dev-app.sh` runs a debug build in a temp bundle, against the
mock runner or a dev runner, with its window kept behind Mike's. Never use
`~/Applications/Threadbear.app` for this. Instances belong to the thread
and checkout that started them: without `--id`, a command means your
newest one, never another thread's, and `stop --all` stops only yours.
`start` prints the id; pass `--id` to every command once you have more
than one, and use `status` to see whose is whose.

- A UI change: `app/Tools/dev-app.sh start --mock` (the demo threads; add
  `--appearance light` for the other look), then drive it with
  `do '{"cmd":"open","id":"demo_upload"}' '{"cmd":"expand","row":"g:"}'`,
  read it with `dump` (rows with ids, kinds and heights, the composer and
  what a send would run on, the banner) and look at it with
  `shot <file.png>`. After an edit, `rebuild` restarts it on the new build
  with the same thread open. Look at the images before saying it works,
  then `stop`. An instance quits after an hour with no command. The
  commands are in `app/README.md` ("Seeing and driving it from a script").
- A cursor bug only shows with the real pointer: unit tests, `dump` and
  `shot` can't see it, and two fixes for the done card's "?" passed them
  and changed nothing Mike could see. Read `NSCursor.currentSystem` from a
  small separate process that moves the pointer with CGEvent, and only once
  `HIDIdleTime` says Mike has been away, putting his pointer and front app
  back afterwards. The dev window sits behind his, so float it first (a
  temporary `window.level`), or you're reading whichever app is on top, and
  check its log shows the moves arriving. Rest about a second as well as
  moving: a tip coming up makes AppKit work the cursor out again, and
  SwiftUI's view behind AppKit content answers with the arrow. Run it with
  the fix taken out too, to see it fail.
- `shot` runs screencapture from your shell. If it says the image was drawn
  in-process (the screen is locked, or your shell has no Screen Recording
  permission), the sidebar's glass is a flat fill; the rest is right.
- A scripted app is never in front, so opening a thread doesn't mark it
  read until you send `{"cmd":"focus"}`.
- A bug in one of Mike's real threads: `tb export <id>`, then
  `app/Tools/dev-app.sh start --mock --fixtures app/.fixtures/threads/<id>`
  and `open` it. Exports are his private conversations: keep shots of them
  out of git and delete them when done.
- A runner change seen in the app: start `runner/scripts/dev-runner.sh`,
  then `dev-app.sh start --home <dev home>` (it prints that line). A
  message sent from that app's composer is a real turn; `dump` shows the
  model it would use.
- `dev-app.sh log` shows the app's own log (connection, RPC errors, the
  commands it ran). Mike can right-click a row for "Copy debug info" or use
  "Copy thread id" in the ... menu to point you at what he's seeing.
- For the full design set, `app/Tools/screenshots.sh <dir>` (`--only 11`
  for one scene).
