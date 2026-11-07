# Forking Threadbear: what to change and what to take out

Everyone runs their own fork (README, `scripts/setup.mjs`). For a fork
that just runs Threadbear and takes Mike's releases, there's nothing to
change: setup makes your own Convex deployment, pins Mike's release key
and points `upstream` at `mikecann/threadbear`. Read on if you want to
publish your own build (your own App Store app, your own crash reports,
your own releases for others) or take features out.

## 1. What's Mike's, and where

These only matter if you ship your own build to other people. Leave them
alone otherwise: several are checks that keep a fork *from* acting as
Mike's copy (reporting to his Sentry, uploading his debug symbols).

| What | Where | Notes |
|---|---|---|
| Mike's repo checks | `runner/src/sentry.ts` (`MIKES_REPO`), `app/Sources/Threadbear/AppUpdate.swift` (`isMikesRepo`), `app/build-app.sh` (`is_mikes_repo`), `scripts/setup.mjs` (`MIKES_REPO`), `runner/src/upstream.ts` | Crash reports and symbol uploads only happen when `origin` is `mikecann/threadbear`, so a fork never sends anything. setup.mjs uses it to tell a fork from a clone and to set `upstream`. Point these at your repo only if you want your copies to report to you, or others to follow your releases. |
| Release signing key | `scripts/release-signers` | Mike's public SSH key. Setup pins it into each install's data folder, and only release tags signed with it count as upstream releases. Replace it with your own if others will follow your fork; `releases.publish: true` in your runner.json then makes your runner tag them, with plain-words notes Opus writes from the commits through its Claude pool. |
| Sentry DSN | `runner/src/sentry.ts`, `app/Sources/Threadbear/CrashReporting.swift`, `ios/Threadbear/CrashReporting.swift` | The Mac app and runner only report from Mike's repo (above). **The iPhone app reports from any App Store build**, so a fork that ships its own phone app must change or remove the iOS DSN. `THREADBEAR_SENTRY=off` turns reporting off everywhere. |
| Mac bundle ids | `app/Resources/Info.plist`, `app/build-app.sh` (`BUNDLE_ID`), the runner's LaunchAgent label in `runner/scripts/install-runner.sh` and `runner/launcher/Info.plist`, the log subsystem in `app/Sources/Threadbear/AppLog.swift` | All `com.mikerosoft.threadbear*`. Changing them on an existing install leaves the old LaunchAgent and preferences behind, so change them before you install, or uninstall first. `docs/on-your-mac.md` lists every label. |
| iPhone bundle ids, app group, team | `ios/Threadbear.xcodeproj/project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER`, `DEVELOPMENT_TEAM = 4DTAZSZL6B`), `ios/Config/*.entitlements` and `ios/NotificationService/NotificationService.swift` (`group.com.mikecann.threadbear`), `ios/scripts/appstore-upload.sh` (`TEAM_ID`) | Needed for anything that builds the phone app on your own Apple account. `ios/appstore/` is Mike's App Store listing. |
| Push relay | `convex/push.ts` (`RELAY_URL`), `relay/`, `docs/push-relay.md` | Backends without an Apple key send notifications through Mike's relay, which only reaches Mike's phone app. A fork shipping its own phone app sets `APNS_*` on its own Convex deployment (`docs/convex-backend.md`), or runs `relay/` itself and changes `RELAY_URL`. `PUSH_RELAY=off` stops using it. The relay checks a new backend's registration by calling its `/relay/verify` (`convex/http.ts`), which only matters while you use a relay. |
| Website and links | `site/site.mjs` (`GITHUB_URL`), `app/Sources/Threadbear/Views/Tour.swift` (`docsSite`, the tour's ⓘ links), `README.md`, `.threadbear/patches/app-store.ts` | threadbear.mikecann.app and the App Store listing. The patch's App Store Connect and Sentry chips only show on Mike's Mac; `runner/test/unit/fork-view.test.ts` checks what this repo's patches show in anyone else's copy. |
| Mike's deployments in docs | `docs/convex-backend.md`, `docs/website.md`, `docs/push-relay.md` | Names of Mike's Convex deployments, for his own use. The code never reads them; yours come from setup. |

Code comments that say "Mike's releases" or tell a story from Mike's
setup are kept on purpose, as the history of why a line is there.

## 2. Where each feature lives, and how to take it out

The shared files most features hook into:

- `runner/src/main.ts`: builds every service, holds the RPC method table
  (`const methods = {...}`), and stops each service in `stop()` and
  `handOver()`.
- `runner/src/threadbear-mcp.ts`: the agent tools (`buildThreadbearTools`)
  and the instructions agents get (`SHOWING_THE_USER`, `FILING_PROJECTS`).
- `runner/src/runner.ts`: the thread engine. `runner/src/rpc.ts`: method
  names. `runner/src/config.ts`: every runner.json key and `THREADBEAR_*`
  variable.
- App: `AppModel.swift` (state; its notification handling is in
  `AppModel+Connection.swift`), `ThreadbearApp.swift` (menus, startup),
  `Views/ActivityBar.swift` (the left rail), `Views/SettingsView.swift`,
  `Automation.swift` (debug-only script commands).
- Convex: `convex/schema.ts` (tables), `convex/version.ts` (the API
  version; never lower it), `convex/http.ts`, `convex/crons.ts`.

Before cutting anything, check whether a switch already turns it off;
most of the optional ones have one. Removing code is for when you want it
gone from your fork, not just quiet.

**Rules when removing a feature**

- Remove an agent tool and resumed Claude sessions still have it in their
  tool list (AGENTS.md, "Changing a threadbear tool's arguments"). They
  get an unknown-tool error, which is fine, but take its mention out of
  the instructions in `threadbear-mcp.ts` too.
- Protocol fields are optional on both sides, so the app copes with a
  runner that no longer sends one. Leave a field's decoding in place if
  you still run an older app or phone build.
- A Convex table that has rows can't simply be dropped from the schema:
  empty it in the dashboard first.
- Update `docs/guide.md` (what the user sees) and `docs/on-your-mac.md`
  (what it installs, reads and talks to).
- Then `./check.sh` (`--app` when you touched `app/`). To run it on
  another Mac over ssh, put `"checkHost": "<ssh host>"` in your
  runner.json, or `"checkHosts"` with a list of them (Mike's is
  `["tinker-desk", "cloud"]`; a Linux one only takes `--quick` runs that
  don't touch `ios/`); without either, it runs on yours. On your Mac it
  keeps one ssh connection per host through a socket in `~/.ssh/tbc`, and
  the lock on each checkout's copy in `~/.cache/threadbear-check-locks`,
  both folders only you can use (mode 700, yours; one that's anything else
  is never used: ssh then connects afresh each time, and the lock refuses
  to run). The folder the host reports for its copies must be a plain
  absolute path (letters, digits, `.`, `_`, `/`, `-`), or that host is
  passed over.

### Optional, with a switch

| Feature | Lives in | Switch | Taking it out |
|---|---|---|---|
| Secret scrubbing | `runner/src/scrub.ts`, `redaction.ts`, `secret-values.ts`, `withhold.ts`, `convex/redaction.ts`; on-device check `secret-check.ts`, `secret-check/`; `runner/scripts/scrub-stored.mjs` | `secretCheck.enabled` in `runner.json` for the check, off by default; none for the scrubbing | Keep the scrubbing if you keep the mirror: it's the only thing between a thread's words and your deployment. The check can go alone: `main.ts`, `formatSecrets` in `tb-dev.ts`. |
| Phone, browser and Convex mirror | `runner/src/sync.ts`, `devices.ts`; `convex/`, `web/`, `ios/`, `relay/`; app `DevicesModel.swift`, `Views/DevicesSettings.swift` | `THREADBEAR_SYNC=off`, or no `sync` in runner.json | Woven in: Pocket, sharing, Quick Ask, remote runners, push and Convex schedules all ride on it. Leave it in and switch it off. |
| Runners panel | app `Views/RunnersPanel.swift`; Core `RunnersText.swift`, `RunnerStats.swift`; the extra `runners.list` fields in `runner/src/schedules.ts`; the figures through `runners.stats` (`runnerStats()` in `runner/src/sync.ts`, `sync:watchRunnersFromMac` and `sync:runnerStatsList` in `convex/sync.ts`) | Shows only with more than one runner | Self-contained: delete the app files and the panel's lines in `WindowDock.swift`, `ActivityBar.swift` and `Automation.swift`; `runners.stats` and its two backend functions can stay. |
| Pocket (cards on the phone) | `runner/src/pocket-icons.ts`; the `pocket` tool in `threadbear-mcp.ts`; the librarian's Pocket part; `pocketCards` in `runner/src/sync.ts`, `convex/sync.ts`, `convex/phone.ts`, `convex/schema.ts`; `ios/Threadbear/PocketView.swift`, ThreadbearKit `Pocket.swift`, `PocketIcon.swift`; the inbox button | Off with sync | Self-contained. Section 3 walks through it. |
| Quick Ask (Ask on the phone) | `ios/Threadbear/QuickAsk/`, `ios/Threadbear/QuickAskCore/` (ThreadbearKit's `QuickAskCore` target); `quickAsk` in `convex/phone.ts`, `runner/src/sync.ts` and `runner.ts` | The Ask shortcut and Settings › Ask always show, in plain words with a link to `docs/ask-server.md`; nothing is sent until a server is set on the phone | Self-contained on the phone. The server isn't in this repo (`docs/ask-server.md`). |
| Sharing (public links) | `convex/share.ts`, the `/s/` route in `convex/http.ts`, `runner/src/share-images.ts`, `web/src/share.tsx`, app `Views/ShareButton.swift`; `threads.share` in `rpc.ts` | Off with sync | Medium. Keep `web/`: it's also the signed-in browser view. |
| Remote runners (a second Mac) | app `RemoteRunners.swift`, `RemoteFiles.swift`; `runner/src/files.ts`, `thread-index.ts`; `remoteThreads` in `sync.ts` | Needs sync and `sync.rpcUrl` on the other Mac | Medium. Not the same as `handover.ts` (one Mac, release to release), which stays. |
| Runner keys (a second Mac's own backend key) | `convex/runnerAccess.ts` (who may call what), `runnerAuth` in `convex/lib.ts`, the `runnerKeys` table, `sync:addRunnerKey` and friends in `convex/sync.ts`; `runner/src/runner-keys.ts` (`tb runner`); `joining` in `scripts/setup.mjs` and `scripts/runner-key-plan.mjs`; `/runner/upload` in `convex/http.ts`; the runner-key check in `runner/scripts/deploy-backend.mjs` | None needed: with one Mac there's only `RUNNER_KEY`, which does everything | Woven into every function in `convex/sync.ts`. To have every Mac use `RUNNER_KEY` again, copy it into their `secrets/convex-key`. |
| Connectors gateway | `runner/src/connectors.ts`; app `ConnectorsModel.swift`, `Views/ConnectorsPanel.swift`; Core `Connectors.swift`, `ConnectorsText.swift` | `THREADBEAR_CONNECTORS_URL=off`, or no gateway configured | Self-contained, but Notion task boards read through it. |
| Notion task boards | `runner/src/notion-tasks.ts`; `useTaskBoards` and `refreshTasks` in `projects.ts`; the board in `Views/ProjectPage.swift` and `HighlightsBoard.swift` | Nothing happens without a gateway and a project with a Notion page | Medium. |
| Sentry | `runner/src/sentry.ts`, app and iOS `CrashReporting.swift`, `app/SentryBinary/`, dSYM upload in `app/build-app.sh` | `THREADBEAR_SENTRY=off`; a fork never reports from the Mac (section 1) | Self-contained: drop the start calls in `main.ts` and both `ThreadbearApp.swift`, the logger handlers in `main.ts`, the `@sentry/node` dependency and the Swift package references. `HangWatch.swift` keeps its local logs. |
| The ding when a thread finishes | app `DingPlayer.swift`, Core `Support/CompletionSound.swift` (the sounds, made in code), one call in `AppModel+Connection.swift`, the Notifications section in `Views/SettingsView.swift` | Off by default (Settings > General > Notifications) | Self-contained: drop the two files, the call and the section. |
| The activity log | `runner/src/activity.ts` (`tb activity`), app `ActivityRecorder.swift`, Core `Support/Activity.swift` | Off by default (Settings > General) | Self-contained: about a dozen `ActivityRecorder.shared` calls in the app. |
| Following main, upstream releases | `runner/src/update.ts`, `upstream.ts`, `bring-in.ts`, `scripts/release-signers`; app `AppUpdate.swift`, `Views/UpdatesPanel.swift`, `app/stage-update.sh` | `followMain: false` (or `THREADBEAR_FOLLOW_MAIN=0`); upstream is off with no `upstream` remote; `releases.bringIn: "off"` stops the update threads | Medium. Keep `release.ts` and `restart.ts`: handovers and crash rollback use them. |
| The Xcode 26 build check | `.github/workflows/xcode-26.yml` | GitHub doesn't run a fork's workflows until you turn Actions on for it | Self-contained: delete the file. It builds the Mac and iPhone apps on GitHub's macos-26 runner, as Mike's own Macs only have a newer Xcode. |
| Thread worktrees, `tb land` | `runner/src/worktrees.ts`, `worktree-setup.sh`, `borrow-worktree.sh`, `docs/thread-worktrees.md` | Only repos whose patch sets `worktree` get them | Medium; AGENTS.md's workflow assumes them. |
| Experiments | One file each, `runner/src/experiments/<id>.md`, read by `runner/src/experiments.ts`; [docs/experiments.md](experiments.md) lists where each lives and how to take it out | `experiments.<id>` in `runner.json`, off by default | Each one: what docs/experiments.md says, then delete its file and run `npm run experiment-docs` in `runner/`. `experiments.ts` stays. |
| Codex | `runner/src/adapters/codex/`, `runner/src/updates/codex.ts` | No Codex login, and `cliUpdates: { codex: "off" }` | Woven in, but keep `'codex'` decodable as a provider. |
| BrowserBear link hand-off | `app/Sources/Threadbear/BrowserBear.swift`, called from `PaneModel.swift` | Inert unless BrowserBear (Mike's own tool) is running | Self-contained: one file, one call. |
| The Browser panel | `app/Sources/Threadbear/Views/AgentBrowserPanel.swift`, and `BrowserBearPipe.swift`, with cases in `PanelsView.swift`, `WindowDock.swift`, `PanelRequests.swift` and `Automation.swift` | Inert without BrowserBear; existing profiles use its private socket, separate agent Chrome retains its CDP path | Self-contained. |

### Core, no switch

These are part of how threads work. Taking one out means changes across
runner, app and phone; it's usually better to hide its entry point.

| Feature | Lives in |
|---|---|
| The librarian (titles, filing threads into projects, waking hibernating threads by topic) | `runner/src/librarian.ts`, app `Views/LibrarianHome.swift`, `LibrarianView.swift`. Pause it on its page, or set no `models.pool`. |
| Projects | `runner/src/projects.ts`, `project-icons.ts`; app `Projects.swift`, `Views/Projects*.swift`, `ProjectPage.swift`; the project tools in `threadbear-mcp.ts` |
| Keyboard shortcuts | Core `Support/Shortcuts.swift` (the commands and their default keys, which a new menu command with a key joins); app `AppShortcuts.swift`, `Views/KeyboardSettings.swift`, and `.shortcut(...)` on the menu items in `ThreadbearApp.swift`; yours in `shortcuts.json` in the data folder |
| Schedules | `runner/src/schedules.ts`, `cron.ts`; app `Schedules.swift`, `Views/Schedule*.swift`, `ScheduledHome.swift`, `ScheduledList.swift` |
| Pools and Usage | `runner/src/pools.ts`, `usage*.ts`, `token-tally.ts`, `accounts.ts`; app `PoolsModel.swift`, `Usage.swift`, `Views/UsagePanel.swift` |
| Claude refusal recovery | App `RefusalRecovery.swift`, `Views/RefusalOffer.swift`, called from `Views/ComposerView.swift`. Offers a user-initiated switch to Codex Sol using the existing provider handoff. Remove the offer from the composer to leave switching to the model picker. |
| Patches (project buttons and panels), and trusting a folder's Claude Code hooks | `runner/src/patches.ts`, `patch-trust.ts`, `script-trust.ts`, `claude-trust.ts`, `panel-requests.ts`; app `Views/PanelsView.swift`, `ThreadPanels.swift`, `ActionChips.swift` |
| Design reviews (`show_options`) | `runner/src/reviews.ts`, `runner/src/review-media.ts` (videos and pages); app `ReviewSession.swift`, `Views/ReviewWindow.swift` |
| Secrets (`ask_secret` and its card) | `runner/src/secrets.ts`, `runner/src/runner/approvals.ts` (`requestSecret`, `answerSecret`), the tool in `threadbear-mcp.ts`; app `Transcript/Cells.swift` (the card); phone `Threadbear/SecretCard.swift`, `ThreadbearKit/Secrets.swift`; `convex/phone.ts` (`secret`). Leave the tool out of `buildThreadbearTools` to switch it off. |
| Plan first (the plan card) | `runner/src/runner/approvals.ts` (`approvePlan`, `leavePlan`), `planProposed` in `runner.ts`, `ExitPlanMode` in `adapters/claude/adapter.ts`, the `plan` item and `collaborationMode` in `adapters/codex/`; app `PlanCardCell` in `Transcript/Cells.swift`, the plan card in `TranscriptReducer.swift`. To hide it, take `.plan` out of the composer's permission menu (`ComposerControls.swift`) |
| Highlights and `pin` | `runner/src/highlights.ts`; app `Views/HighlightsView.swift`, `HighlightsBoard.swift` |
| Slash commands and their palette | `runner/src/slash-commands.ts`, `runner/src/runner/commands.ts`, the Codex mappings in `adapters/codex/adapter.ts` (`commandOrTurn`); app `Views/SlashPaletteView.swift`, `ThreadbearCore/Threads/SlashCommands.swift`. Take the palette out by dropping its overlay in `ComposerView.swift`; typed commands still work. |
| Folder browser in the side pane | `Views/FolderBrowser.swift`, `ThreadbearCore/Threads/FolderListing.swift`; `files.list` in `runner/src/files.ts` |
| First-run tour and sample threads | app `Views/Tour.swift`, `runner/src/samples.ts`, `app/Tools/tour-e2e.mjs`. It only runs once, for a new user. |

## 3. Worked example: taking Pocket out

Pocket touches every layer (runner, Convex, phone, docs) without being
woven into threads, so it's the one to try first.

Tried on a throwaway branch on 4 Nov 2026, following this section: 26 files,
about 1,300 lines gone, and `./check.sh --quick`, the ThreadbearKit tests,
the Convex and web typechecks and an iPhone build all passed afterwards.

**Runner**

1. Delete `runner/src/pocket-icons.ts`, `runner/test/unit/pocket.test.ts`
   and `pocket-librarian.test.ts`.
2. `runner/src/threadbear-mcp.ts`: the `POCKET_ICONS` import, the
   `PocketControl` type and the `ConvexSync` import it needed, the `pocket`
   option of `buildThreadbearTools`, the `pocketTools` block and
   `...pocketTools`, the Pocket sentence at the end of `SHOWING_THE_USER`,
   and the `pocket` parameter of `threadbearMcpServer`. That parameter is
   positional, so its callers shift: `main.ts` and
   `test/unit/threadbear-tools.test.ts` (`mcpClient`).
3. `runner/src/main.ts`: `pocketControl`, and where it's passed
   (`mcpServersFor`, `toolsFor`, `new Librarian`).
4. `runner/src/librarian.ts`, the most woven-in part: the imports,
   `LibrarianPocket`, `POCKET_ADDS_PER_DAY` and its keep time, `HEADING_OUT`,
   `PocketAdded` and the saved `pocketAdded`, `Answer.pocket`, the `pocket`
   dependency, the `cards` read and `applyPocket` in `look()`, the `cards`
   parameter of `quiet()` and `prompt()` (and their Pocket lines),
   `pocketCards()`, `applyPocket()`, `pocketChanges()`, and in `SYSTEM` the
   `"pocket"` answer field and the Pocket paragraph.
5. `runner/src/sync.ts`: the `PocketCard*` types and `savePocketCard`,
   `removePocketCard`, `pocketCards`.
6. `runner/test/unit/projects.test.ts`: the Pocket imports, `setup()`'s
   `pocket` option, and `fakePocket` with the three tests after it.

**Convex**

7. `convex/sync.ts` (the pocket section), `convex/phone.ts` (`pocket`,
   `removePocketCard`), `convex/schema.ts` (`pocketCards`). A deployment
   with cards in the table needs them deleted before the schema will push.
8. `convex/version.ts`: keep `API_VERSION`, and add a note that the Pocket
   functions are gone. A phone build that still has the Pocket gets an
   error opening it, so ship the phone change with it.

**iPhone**

9. Delete `ios/Threadbear/PocketView.swift`, ThreadbearKit's `Pocket.swift`
   and `PocketIcon.swift`, and `PocketTests.swift`. The groups are synced
   folders, so the project file needs no file entries changed.
10. `ios/Threadbear/InboxView.swift`: `PocketBadge`, the `pocketOpen` and
    `afterPocket` state, `pocketValue`, the wallet toolbar button, and the
    `.fullScreenCover` with the `opensPocketAtLaunch` `.onAppear`.
11. `ios/Threadbear/AppModel.swift`: `pocket`, `showsPocket`,
    `pocketSeenUpTo`, `pocketHasNew`, `opensPocketAtLaunch` and the
    `-ThreadbearPocket` argument in `init`, `markPocketSeen`,
    `removePocketCard`, the Pocket lines in `leaveDemo` and `unpair`, the
    `PocketStore` load in `connect`, and the `backend.pocket()` follow.
12. ThreadbearKit: the two Pocket members of `Backend` and their
    implementations, `FakeBackend`'s `pocketCards`, its two methods and
    `samplePocket`, and `BackendCompatibility.pocketAPIVersion`.
13. `ios/Threadbear.xcodeproj/project.pbxproj`: the two
    `INFOPLIST_KEY_NSLocationWhenInUseUsageDescription` lines (only the
    Pocket asks for location), and the location paragraph of the review
    notes in `ios/appstore/metadata.json`.
14. Check: `swift test` in `ios/ThreadbearKit`, then build the app for the
    simulator. Off the Mac you work on if it's busy; `ARCHS=arm64` keeps
    xcodebuild from trying an x86_64 link the Convex package can't do.

**Docs**

15. `docs/guide.md`: the Pocket paragraph under the phone, and the sentence
    saying the librarian looks after cards. `docs/convex-backend.md`: "The
    Pocket (API 19)" and its mention in the usage notes.
    `docs/on-your-mac.md` and `docs/protocol.md` have nothing on it.

What a first list of the cuts missed and the trial found: the `-ThreadbearPocket`
launch argument, the positional parameter shifting the tools test, and the
App Store review notes. Expect a few like that in any feature: after the
listed cuts, `git grep -i <feature>` across the repo finds the rest.
