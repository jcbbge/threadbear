# Threadbear's Convex backend

Research and build notes, 27 Oct 2026, thread 89b52654. Sections 1 to 4
are the research Mike said yes to ("A", and make the project now).
Section 5 is what's built and how to work on it; section 6 the phone's
API as agreed with the iPhone thread (f5247e5b).

## 1. What exists today

Nothing. Checked on 27 Oct:

- `git log --all` and `git grep` over every branch (main, pools, step4
  and its pieces, project-icons, rename, thread-worktrees, the design
  branches) and the 17 worktrees under `~/dev/me/threadbear-*` and
  `~/dev/me/threadbear-rename`. Every hit for "convex" is one of: the
  built-in Convex dashboard panel (`runner/src/patches.ts`), the "Convex
  work only" note on the claude-2 account, or the schedules doc saying
  cron works "like Convex's scheduled functions".
- `~/dev/me/threadbear-notes` holds only the step 4 plan, spikes and
  recorder scripts.
- No `convex/` folder, no Convex dependency, no deployment, no
  `.env.local` anywhere in the repo.

The runner keeps everything as files under
`~/Library/Application Support/Threadbear/`: `threads/<id>/thread.json`
(the summary), `events.ndjson` (every event), `media/`, `blobs/`, plus
`projects.json`, `schedules.json`, `usage.json` and `librarian.json`. The
Mac app is a client of the runner over a loopback WebSocket and holds no
state of its own.

### Where the Convex idea came from

From Agent Archive, in order:

1. **26 Oct, the original plan.** Mike's agreed build order put Convex at
   step 5: "thread state in Convex + a Threads tab in Quick Ask (his
   iPhone app) with a push when a thread needs him", then step 6 "Tinker
   Desk as a second runner, then cloud sandboxes". `docs/plan.md` still
   says this under "Later steps".
2. **27 Oct, morning (archive thread jx7dzqk862, items 585 to 600).**
   Mike: "I think I want this to be a Convex project. So I think I want
   everything to get synced to Convex. And in theory, this could just
   become new agent archive potentially. But let's think about that. If we
   were to sync everything to Convex, that's going to be a lot of data,
   isn't it?" He added that Agent Archive's Convex costs were why it had
   moved to Bruce. The reply measured his transcripts (about 10 GB a
   month, 52% base64 images, 5% tool output, about 1% conversation text,
   about 110 MB a month) and offered three sizes. Mike answered "A for
   now": live shared state only, written on change and never per token,
   full transcripts staying on the runner's machine, Agent Archive on
   Bruce staying the search layer, Sydney region.
3. **27 Oct, afternoon (thread f5247e5b).** Asked for the phone app, Mike
   said Threadbear "was supposed to be backed by a convex project so that
   there was kind of like a real-time convex nature in there, potentially
   synced to convex", and wanted that sorted first.

Thread 6eecd8a8 ("thread digests for archive search and the phone") is
related but separate: it proposed a model-written digest per thread stored
in `thread.json`, for Archive search, the sidebar and the phone list. It
doesn't touch Convex, and its conclusion was that Agent Archive already
indexes every Threadbear transcript, so Threadbear shouldn't build its own
search. If digests get built they're one more field the mirror below
carries up.

## 2. What "Convex-backed" could mean

Two honest readings of what Mike has asked for, and a third I'd rule out.

### A. The runner owns the state, Convex mirrors it (and carries the phone's requests back)

The runner stays the source of truth for everything it has today. When
something the phone would care about changes, the runner writes the new
value to Convex. The phone reads Convex with live queries and writes its
requests (send a message, approve, answer, hibernate, start a thread) to
a `commands` table that the owning runner subscribes to and applies
through the same code paths the Mac app uses. The Mac app keeps talking
to the runner over loopback and doesn't know Convex exists.

This is the "A for now" Mike picked on 27 Oct, plus the command queue
that any phone app needs anyway.

### B. Convex is the source of truth for shared state; runners hold transcripts and processes

Projects, notes, schedules, thread summaries, usage and runner presence
live in Convex. The runner and the Mac app both subscribe to it. The
runner keeps `events.ndjson`, media and the CLI processes, and writes a
summary document after each change the way it writes `thread.json` now.
The Mac app's sidebar, Projects view, Scheduled view and Librarian view
read Convex.

### C. Everything in Convex, including transcripts

Mike's first instinct on 27 Oct ("everything gets synced"). About 10 GB
a month at today's pace, half of it base64 images, with every streamed
token a write. Already ruled out in that conversation and I agree: it's
the exact pattern that put Agent Archive at 137 GB of database I/O in a
month and tripped the team's spending limit. Not discussed further.

### Weighing A against B

**Cost.** Convex bills database I/O, not storage, and a live query re-runs
and re-reads every document it touched each time one of them changes. So
the question is how many subscribers sit on the thread list all day.

Measured on the live runner on 27 Oct (64 threads, 2 days):

| | per day |
|---|---|
| events persisted | about 6,300 |
| turns | about 115 |
| user and assistant text messages | about 600, 250 KB |
| `thread.updated` notifications | several thousand (every status, preview, background and context change, coalesced per tick) |

A mirror that writes only phone-relevant fields (title, status, needs
you, preview, last activity, put away, projects, cost) and coalesces to
one write per thread every couple of seconds while a turn runs comes to
roughly 2,000 summary writes a day of about 1 KB each, plus about 600
message documents. Writes: a few MB a day. The phone's inbox query reads
about 60 documents (60 KB) each time any of them changes. If the phone
subscribed all day that's about 120 MB a day, 3 to 4 GB a month; a phone
that's open for a few minutes a day is a rounding error. Under A the Mac
app isn't a subscriber, so this is the whole bill: well inside the team's
50 GB of included I/O even at Sydney's 1.3x, and nowhere near the US$80
limit.

Under B the Mac app subscribes all day to the thread list, projects,
schedules and the rest, on every machine Threadbear is open on. Each
`thread.updated` then costs a re-read of the list on the Mac as well as
the phone, and the Mac's reads happen whether or not anyone's looking.
Call it 4 GB a month per always-on client, and more as the thread count
and turn rate grow. Still affordable on its own, but it's the same
"re-read on every change" shape that got Agent Archive, and a mistake in
one query (reading all events, or all archived threads) takes every
project on the `mikec` team down together, as on 22 Oct.

**Offline and asleep.** Under A the Mac works with no internet: the runner
owns the state, and the mirror just writes "the current value of this
document" when the connection is back, so nothing is lost or queued. When
the laptop sleeps the runner stops, Convex keeps the last state, the
phone shows "Mac offline since 10:42" from the runner's heartbeat, and
anything Mike does on the phone waits in `commands` until the runner
wakes and applies it. That's the thing a phone talking straight to the
runner over Tailscale can't do (and Tailscale on the 15 Pro Max was last
seen 43 days ago).

Under B the Mac app's sidebar needs Convex to load. The Swift client
caches the last snapshot, so it would still open, but every change
Mike makes to a project, note or schedule with no internet either fails
or needs an outbox that doesn't exist in `convex-swift` today. The
runner would also need to keep working while Convex is unreachable,
which means a local copy of projects and schedules anyway. So B ends up
with the local files plus Convex, not instead of them.

**Latency.** The app's bar is cold start to a usable window under a
second and thread switches that feel instant. Loopback to the runner is
under a millisecond; Sydney is about 80 ms and US East about 285 ms. A
round trip on open is fine; one on every sidebar interaction is not
what Mike built a native app for.

**Tinker Desk as a second runner (plan step 6).** Under A each runner
registers itself (`runners` table: name, version, last heartbeat) and
mirrors its own threads, so the phone sees one list across machines
with a machine label, and a command carries the `runnerId` it's for. A
thread started from the phone names a runner, or goes to the main Mac
(docs/protocol.md, "Runner keys"). No new Convex work is needed for step 6. The
Mac app still has to reach the second runner somehow for transcripts
and sends: either a second socket over Tailscale, or, later, by reading
remote runners' summaries from Convex and opening a socket only for the
transcript. That later piece is the one place B's idea earns its keep,
for remote runners only, and it can wait for step 6.

Under B multi-runner comes for free on the list, but every runner still
needs its own socket for transcripts and sends, so the saving is small.

**Schedules.** One real advantage of B: a Convex cron could be the clock,
and fire into whichever runner is online, so a schedule isn't lost while
the laptop's lid is shut. Worth doing later, as a targeted change: keep
`schedules.json` as the runner's own, mirror it, and let Convex re-fire
a missed one on another runner. Not needed for the phone.

**How much changes.** A is one new runner module and a `convex/` folder.
It hooks the places the runner already notifies from (`flush()` for
summaries, the persisted-event path for text messages and approvals,
`projects.updated`, `schedules.updated`, `accounts.updated`) and adds a
subscription for commands that calls the existing `send`, `respond`,
`update` and `create` methods. The protocol gains a `sync` status field,
an `origin: "phone"` on `user.message`, and nothing else. The Mac app
doesn't change.

B rewrites `projects.ts`, `schedules.ts`, `librarian.ts` and the
summary save path to treat Convex as the store, adds `convex-swift` to
the Mac app with a second data source beside the runner socket, and
changes the protocol's "kept in `projects.json`" and "kept in
`schedules.json`" contracts. Weeks, not days, and it moves the Mac app
off the loopback path that makes it fast.

**Agent Archive.** Stays on Bruce as the search and memory layer under
both. It already ingests every Threadbear session, because Threadbear
runs the real CLIs and they write the same JSONL the archive reads.
Mike's "could become the new agent archive" is the C shape and the
answer's the same as on 27 Oct: no. If Threadbear wants search over its
own threads, it should ask Bruce.

## 3. Recommendation: A, as "runner owns, Convex mirrors, phone asks"

Build A. It is what Mike agreed on 27 Oct, it gives the phone everything
it needs, it costs almost nothing, the Mac stays fast and offline-safe,
and Tinker Desk fits without more Convex work. Revisit two pieces of B
later and on their own: Convex as the clock for schedules, and the Mac
app reading remote runners' summaries from Convex at step 6.

### Shape

**One Convex project**, `threadbear`, on the `mikec` team, Sydney region,
in `convex/` at the repo root with its own `package.json` (which also
lights up the built-in Convex dashboard panel for threads in this repo).
Tables:

| table | written by | holds |
|---|---|---|
| `runners` | each runner, every 60 s | id, name (M5, Tinker Desk), version, release, `lastSeenAt`, `draining` |
| `threads` | the owning runner, on change | the phone's view of `ThreadSummary`: id, runnerId, title, cwd, account, provider, model, status, needsYou, preview, timestamps, snoozedUntil, archivedAt, costUsd, projects (ids and titles), `pendingApproval` (the open approval or question, with its options), the working line (what `background` shows) |
| `messages` | the owning runner | the last 20 `user.message` and `assistant.text` per thread: threadId, seq, role, text, origin, at. Older ones are deleted as new ones arrive |
| `commands` | the phone | `send` (text, optional new-thread fields), `respond` (approvalId, decision, answers), `update` (snooze, archive, title), `create`; `runnerId` or "any"; `state: pending / taken / done / failed`, `note` |
| `projects` | the owning runner | id, title, folders, goals, state, notes, archived, lastActivityAt |
| `schedules` | the owning runner | the `Schedule` list, for reading on the phone |
| `accounts` | each runner | per account: title, provider, note, blocked, usage windows (the usage popover's numbers) |
| `devices` | the phone | APNs token and environment, like Poddle's `devices:register` |
| `tokens` | by hand | hashed phone tokens with expiry, as Quick Ask does it |

Rules the runner follows, so the bill stays small and Convex never
becomes a dependency:

- **Fail soft.** The mirror is best effort. If Convex is unreachable or
  the team is over its limit, the runner logs once, keeps a "dirty" set,
  and retries with backoff. Nothing the Mac app does waits on it.
- **Write values, not events.** Each table row is "the current state of
  X". A reconnect writes the dirty rows once; there's no queue of
  deltas to replay, so a long outage costs one write per changed row.
- **Coalesce.** At most one `threads` write per thread every 2 seconds
  while a turn runs, and only when a phone-relevant field changed.
  `contextTokens`, per-task `background` churn and `lastSeq` are not
  mirrored. Messages are written when an `assistant.text` item
  completes, never per delta.
- **Never per token.** No streaming text goes to Convex. The phone shows
  the working line and waits for the finished message.
- **Kill switch.** `runner.json` `sync.enabled: false` stops it; `tb
  status` and the Settings view show the sync state and the last error.
- **Handovers.** A draining runner stops mirroring and stops taking
  commands; the new release writes every thread once on start so Convex
  can't be left showing the old runner's last state.
- **Auth.** The runner holds a key in `secrets/convex-key` (0600) and
  passes it to its mutations, which compare it to a deployment env var.
  Phone queries and mutations carry a phone token checked against the
  hashed `tokens` table, issued by `tb phone-token` and delivered by the
  one-off LAN page and QR code Quick Ask uses, never the clipboard.
  Convex Auth can come later if this ever has a second user.

**Push**: a Convex Node action that calls APNs with the team's existing
key, copied from `poddle/convex/apns.ts`, scheduled with `runAfter(0)`
from the mutation that flips `needsYou` to true or marks a turn
finished, with a per-thread cooldown so a flapping status doesn't spam.

**Full transcripts on the phone**: not in v1. When Mike taps "earlier
messages", the phone writes a `page` command and the runner uploads the
next 50 text messages of that thread into `messages` with a `pagedAt`
stamp; a cron deletes paged rows after a day. That keeps the phone off
Tailscale and keeps the steady-state table small. Tool output and diffs
stay on the Mac.

**Pictures on the phone (API 24, 1 Nov).** An agent writing
`![alt](/path/on/the/mac.png)` or pinning an image file showed nothing on
the phone, which can't read the Mac's disk. So those two kinds, what an
agent put in front of Mike on purpose, go to file storage from every
thread (`replyImages`, `runner/src/share-images.ts`), at most 10 MB each and
only if the file really is a picture. `phone:messages` hands them over in
`images`: one with `src` replaces that image in the text, a `pinned` one
goes under the turn's reply. They go as they're written, and each runner
start looks through unarchived threads active in the last 14 days, so an
older thread's pictures stay on the Mac and the phone says so. They're
deleted with the thread. Mike's attachments and tools' screenshots stay on
the Mac unless the thread is shared (`shareImages`), as they're many and big.

They go as the file is, so a GIF keeps its frames; the phone's 1400 pixel limit
is only on what it decodes for the column. MP4 and MOV files an agent writes
the same way or pins go through the same rows (`.mp4`, `.m4v`, `.mov`, under
the same 10 MB), which took no backend change as the phone tells a video from
a picture by its bytes. Shared pages still get only pictures.

### Build order

1. **Project and summaries.** `convex/` with the schema above, the runner
   module (`runner/src/sync/`), `runners` heartbeat, `threads` mirror from
   `flush()`, the kill switch, `tb status` output, protocol note. Tests
   with a fake client; one real e2e against a dev deployment. About half
   a day. The phone can start on its inbox against this.
2. **Messages, approvals, projects, schedules, accounts.** The rest of
   the read side.
3. **Commands.** The phone's writes, applied by the owning runner;
   `origin: "phone"` on `user.message` so the transcript shows where it
   came from (the Mac app already draws `origin: "schedule"`). Creating a
   thread from the phone uses the same defaults as `threads.create`.
4. **Push.** APNs action, `devices` table, the cooldown.
5. **Paged older messages**, when the phone's thread view wants them.

Then, when step 6 of the main plan comes: Tinker Desk runs the same
release with its own runner name, and the Mac app learns to read remote
runners' summaries from Convex. Separately, if Mike wants it: schedules
re-fired by a Convex cron on whichever runner is up, and option B's
"full conversation text" (about 110 MB a month, written once) as a flag
on the mirror.

### What the iPhone app needs first

In order, matching the build order above:

1. `threads` and `runners`, for the inbox with needs-you first, running
   ones with their working line, and "Mac offline since" when the
   heartbeat is stale. Read-only; this is enough to start the app.
2. `messages` and `pendingApproval` on the thread, for the thread view
   and the approval or question card.
3. `commands`, for reply, approve, answer, hibernate, den and new thread.
4. `devices` and the push action.

Quick Ask stays as it is on Bruce. Folding it into the Threadbear phone
app is a later decision and doesn't depend on any of this.

## 4. Decisions

Mike, 27 Oct: shape A, and make the project now. Full conversation text
(the 27 Oct option B) stays a later flag.

## 5. What's built (steps 1 to 5) and how to work on it

**The Convex project** is `threadbear` on team `mikec`
(https://dashboard.convex.dev/t/mikec/threadbear). Its code is `convex/`
at the repo root, with the root `package.json` holding the `convex`
dependency; `convex/_generated` is committed so `./check.sh` can typecheck
the functions without a deployment (`npm run convex:typecheck`). Having a
`convex/` folder here also gives threads in this repo the built-in Convex
dashboard panel.

- `convex/schema.ts`: `runners`, `threads`, `messages`, `commands`,
  `projects`, `schedules`, `accounts`, `tokens`, `devices`, `runnerKeys`,
  `threadTombstones`, `runnerLogins` (docs/protocol.md, "Runner keys").
- `convex/sync.ts`: the runner's mutations (`upsertThreads`,
  `removeThreads`, `prune`, `heartbeat`, `bye`, `appendMessages`,
  `setProjects`, `upsertProjects`, `setSchedules`, `setAccounts`, `takeCommand`,
  `finishCommand`), its queries (`threadsOf`, `runnersList`,
  `messageHeads`, `pendingCommands`, which it holds as a live query) and
  `pruneOld` for `crons.ts`. `convex/relay.ts` (API 44) is the main Mac's
  runner reading another runner's thread (`remoteTail`, `remoteMessages`,
  `remoteThread`) and queueing work for it (`queueCommand`, `commandState`,
  `remoteAccounts`), owner key only, so the Mac app opens other Macs'
  threads with no link to them (docs/protocol.md, "Other runners' threads
  through the backend"). Each takes `key`: the deployment's
  `RUNNER_KEY` (the owner key, the main Mac's), or a runner key from
  `runnerKeys`, which acts as its own runner alone (`convex/lib.ts`
  `runnerAuth`, `convex/runnerAccess.ts`; the table of who may call what
  is docs/protocol.md, "Runner keys"). `tb runner add` on the main Mac
  makes one for another Mac.
- `convex/phone.ts`: the phone's API (section 6).
- `convex/push.ts` (Node action) and `convex/devices.ts`: APNs over
  HTTP/2 with the team's token-based key, copied from Poddle's `apns.ts`.
  `sync:upsertThreads` schedules `push:notify` when a thread's `needsYou`
  goes from false to true (at most once per thread every 30 seconds,
  `pushedAt` on the row); the action re-reads the row, skips it if the
  Mac has seen it meanwhile, and sends `pushText`'s title and body
  (`convex/pushText.ts`: the question, the approval and its input line,
  "Failed: …", or the reply) to every registered phone, sandbox and
  production installs each to their APNs host. A token Apple reports gone
  is dropped. Only phones whose token is still good get one: each
  `devices` row keeps the token it registered with (`tokenId`, since
  5 Nov 2026), revoking a token deletes its phones' rows, and
  `devices:targets` skips an expired or revoked token's
  (`convex/pushTargets.ts`). Older rows only have the token's name, which
  isn't unique, so they get no pushes and go when a token of that name is
  revoked (`devices:dropUnlinked` clears them all); a paired phone makes
  itself a new row by registering again each time the app starts. A backend without its own Apple key goes
  through the push relay (`docs/push-relay.md`), and registers with it
  once, proving it's this deployment through `/relay/verify` in
  `convex/http.ts` and the `relayChecks` table. Env on both deployments: `APNS_KEY_P8`, `APNS_KEY_ID`,
  `APNS_TEAM_ID` (Poddle's key, copied 28 Oct and again on 6 Nov 2026
  after Poddle's old key was revoked) and `APNS_TOPIC`
  (`com.mikecann.threadbear`). Each send's outcome goes in the
  `pushHealth` row (`convex/pushHealth.ts`); while none get through, the
  owner runner's heartbeat answers `pushFailing` and `tb status` says so. `npx convex run push:test '{"body":"hi"}'
  --prod` sends a test; `npx convex run devices:list --prod` shows the
  phones.
- `convex/tokens.ts`: the token helpers, and `issue`, `revoke`, `list` to
  run from a terminal with `npx convex run tokens:issue
  '{"name":"iphone","days":90}'` (add `--prod` for the Sydney prod
  deployment). Only the SHA-256 of a token is stored, with a name and a
  kind (`phone` or `browser`). Since API 6 the Mac app issues them through
  the runner instead: `sync:issueToken`, `sync:listTokens` and
  `sync:revokeToken` take the runner key (docs/protocol.md "Devices"), so
  pairing needs no Convex CLI.
- `runner/src/sync.ts`: the mirror, documented in docs/protocol.md
  ("Sync"): on with `sync.url` in `runner.json` and `secrets/convex-key`;
  threads, messages (all of them, backfilled once), the pending
  approval on a row, projects, schedules and accounts; coalesced writes,
  batches, backoff, prune on start, bye on a stop for good; the phone's
  commands applied through the runner's own methods (`origin: "phone"` on
  the message); `runner.status.sync` and a `tb status` line.
- Tests: `runner/test/unit/sync.test.ts` (fake deployment) and
  `runner/test/e2e/sync.e2e.test.ts`, which starts `npx convex dev` on
  the repo's local deployment, points a runner at it with its own key and
  reads back through the HTTP API and the phone queries. It skips
  without a local deployment in `.env.local`.

**Deployments** (made 28 Oct, after Mike freed the team's deployment
quota by deleting its 41 `temp-*`/`tmp-*` projects), all in Sydney
(`aws-ap-southeast-2`):

| | name | URL |
|---|---|---|
| prod | `opulent-moose-249` | `https://opulent-moose-249.ap-southeast-2.convex.cloud` |
| dev | `earnest-puffin-640` | `https://earnest-puffin-640.ap-southeast-2.convex.cloud` |
| local (e2e only) | `local-mikec-threadbear-1` | `http://127.0.0.1:3210` |

`.env.local` at the repo root (gitignored) selects the dev deployment, so
`npx convex dev` pushes there and `npx convex deploy` ships prod.
`.env.e2e` names the local one for `runner/test/e2e/sync.e2e.test.ts`,
which passes `--env-file .env.e2e` to every convex command it runs. Both
cloud deployments have `RUNNER_KEY` set to the key in the M5's runner's
`secrets/convex-key`, and the live `runner.json` has `sync.url` pointing
at prod, so the mirror is on from the runner's next start. Bruce has a
runner key of its own on prod (`tb runner add bruce --ssh bruce --id
cb921b2447ea --replace`), not a copy of `RUNNER_KEY`, and so has the
Hetzner box (`cloud`, runner `befe8df8975c`, since 07:03 UTC 5 Nov),
which that day's rotation had cut off while it still had the old shared
key. To rotate `RUNNER_KEY` with no gap, `tb runner
rotate-owner` on the M5, restart its runner, then `tb runner rotate-owner
--finish` (docs/protocol.md, "Runner keys").

**Working on it.** `npx convex dev` at the repo root runs the local
backend and pushes `convex/` as it changes; `npx convex env set RUNNER_KEY
<key>` on it once, and a dev runner with `THREADBEAR_SYNC_URL` set to the
local URL and the same key in its secrets mirrors there. `./check.sh`
sets `THREADBEAR_SYNC=off` so no test runner ever writes to the real
project.

**Deploying (since 28 Oct).** Nobody runs `npx convex deploy` for prod by
hand any more. `runner/scripts/deploy-backend.mjs` deploys `convex/` and
`web/` at a commit, from a clean `git archive` in a temp folder, whenever
they've changed since what `<data>/backend.json` records. It uses the deploy
key in `<data>/secrets/convex-deploy.env` (`CONVEX_DEPLOY_KEY=`, made with
`npx convex deployment token create threadbear-runner --prod --save-env
<file>`, never printed) and refuses a key for any deployment but the one
`runner.json`'s `sync.url` names. The runner's updater runs it for each new
commit of main before it builds a runner release, and holds the runner back
(state `failed`, a notice) if it fails; `deploy-runner.sh` runs it as step 4
(`--skip-backend` to leave it out). `--status`, `--dry-run` and `--force`
do what they say. Log: `<data>/runner/update/backend.log`.

**Notifications and presence (API 3, 28 Oct).** Mike was getting pushes
while sitting at the Mac. Now each runner works out whether he's at its Mac
(`runner/src/presence.ts`: the Mac app connected and the keyboard or mouse
used in the last two minutes, from IOKit's `HIDIdleTime`), checks every 15
seconds and sends `sync:setPresence` when it changes. Each phone has a
setting (`devices.notify`, set with `phone:setNotifications` from the app's
Settings › Notify me): `away` (the default) only gets a push while he isn't
at the Mac, `always` gets every one, `off` none. A push that's held back
while he's there marks the thread `pushHeldAt`; leaving the Mac sends it to
the `away` phones if the thread still needs him. A runner that hasn't
checked in for 3 minutes (a sleeping Mac) counts as away.

**Keeping old and new working together.** For a while after any change,
an older runner, a newer backend and an App Store phone app from weeks ago
all meet. So:

- Change the backend so it still takes what the old runner sends and still
  returns what the old phone reads (new fields optional, nothing removed or
  renamed), and only later stop accepting the old shape.
- `convex/version.ts` has `API_VERSION`, returned by `sync:heartbeat` and
  `phone:me`. Bump it when a client starts relying on something new, along
  with `BACKEND_API_VERSION` in `runner/src/sync.ts` (a unit test keeps them
  equal). The runner shows an older backend in `tb status`; the phone app
  says "Update it on the Mac" when the backend is below
  `BackendCompatibility.minimumAPIVersion` (ThreadbearKit).

## 6. The phone's API

Agreed with thread f5247e5b on 27 Oct. All in `convex/phone.ts`. Every
function takes `token` (a phone token from `tokens:issue`) and throws
`ConvexError({ kind: "auth" })` for a bad, expired or revoked one;
`{ kind: "notFound" }` for a thread or command that isn't there.

Queries:

- `phone:me({ token })` → `{ name, expiresAt, apiVersion, pushOff? }`.
  `pushOff` is true when this backend can't send notifications (a
  self-hosted one, docs/self-hosting.md); the phone's Settings says so in
  place of the Notify me picker.
- `phone:runners({ token })` → `[{ runnerId, name, version, lastSeenAt,
  draining }]`. Offline is `lastSeenAt` older than 3 minutes (a runner
  that stopped for good has `lastSeenAt` of 1970).
  Since API 45 also `release?, startedAt?, threadCount?, pressure?`
  (`memory` or `disk` while one's running low).
  Since API 56 in Mike's order (`phone:setRunnerOrder`): the runners he's
  placed as he placed them, then the rest, the main Mac first and the others
  in the order they first heartbeated (never by thread count, which a
  runner says of itself), with `placed: true` on the ones in the saved order
  and `main: true` on the main Mac (owner key, no runner key of its own).
  The phone's automatic pick is the first placed one online, else the main
  Mac, else none (it sends no `runnerId`), so a runner key's Mac is only
  picked for Mike once he's placed it.
- `phone:wakes({ token })` (API 45) → `[{ scheduleId, threadId?, nextRunAt? }]`,
  a small row per active schedule, from `scheduleWakes`: what a sidebar needs
  all the time. `phone:schedules` costs about 150 KB and re-runs on every claim
  and run, so it's for a schedules view that's open.
- `phone:runnerStats({ token })` (API 45) → each runner's machine figures, last
  reported while someone was watching, and `phone:watchRunners({ token })` says
  someone is (docs/protocol.md, Sync, "Runner figures").
- `phone:threads({ token, view: "inbox" | "hibernating" | "den" })` →
  rows, newest `lastActivityAt` first; the den is capped at 100. A row is
  `threadId, runnerId, title, cwd, accountId, provider, model?, status,
  needsYou, unread, preview, createdAt, lastActivityAt, lastActivityMs,
  snoozedUntil?, snoozedUntilRestart?, archivedAt?, costUsd?, projects?:
  [{ id, title }], working?, pendingApproval?, asks?, asksSeq?, next?,
  needs?, pendingReviews?, waitingForRoom?, links?, view`. `links` (API 28) are the thread's patch link buttons (`{ title, url, icon? }`, web pages only), which the phone shows over its message box and opens itself. `asks` and `asksSeq`
  (API 14) are the open card of the agent's
  end_turn asks (`{ action, why?, reply?, options?, suggested?, links?,
  ticked? }`, web links only), and `next` a finished turn's suggested
  follow-ups, for the done card. `needs` (`you` | `nothing`),
  `pendingReviews` and `waitingForRoom` (`{ until, accountId? }`) (API 15)
  are what the phone needs to sort threads into the Mac sidebar's
  sections: with `phone:schedules` it puts an idle thread a schedule will
  message under Hibernating, by the same rules as app ThreadSections. `pendingApproval`
  (from step 2) is `{ approvalId, kind: "approval", name, title, options:
  ("allow" | "allowAlways" | "deny")[], inputSummary? }` or `{ approvalId,
  kind: "question", questions: Question[] }` with the protocol's
  `Question` shape.
- `phone:counts({ token })` → `{ hibernating, den }` (API 17): how many
  threads are in each, uncapped. The phone shows them on its folded
  Hibernating and Archived headings and subscribes to `phone:threads` for
  those views only while their section is open or a search is on.
- `phone:thread({ token, threadId })` → `{ thread, messages: [{ seq, role,
  text, origin?, at, pagedAt? }] }`, oldest first: the newest 20 text
  messages plus any paged ones (`origin` is `"phone"` for one sent from
  the phone, `"schedule"` or `"runner"` as in the protocol). The row's
  `earliestSeq` is the seq of the thread's first text message: while the
  oldest message the phone has is newer than that, there's more to load.
- `phone:messages({ token, threadId, beforeSeq?, limit?, tools? })` (since
  API 2, 28 Oct) → `{ messages, hasMore }`, oldest first: the newest `limit`
  (default 50, at most 2000; NaN or an infinity is refused, here and in every
  `limit`) or the `limit` before `beforeSeq`. Without `tools` it looks past at
  most 4,000 tool rows for the page's text ones, then says `hasMore`. Every message
  is kept since API 2, and with `tools: true` there's one row per tool call
  too (`role: "tool"`, a one-line `text` such as "Run the unit tests" or
  "Edited ~/dev/x.ts", and `toolKind`). It reads Convex alone, so it works
  while the Mac is asleep. The website watches only the newest 30 with it and
  reads older pages once, with `beforeSeq` (`web/src/transcript.ts`); the
  iPhone still raises `limit` as you scroll back. `phone:thread` stays as API 1 had it (newest 20 text messages plus
  any paged ones, never tool rows), for phone apps built before.
- `phone:threadsAt({ token, view })` (API 43) → `{ rows, at }`, a list once;
  `phone:threadsSince({ token, since })` → `{ rows, gone, more? }`, every row
  written at or after `since` in any view, each with `updatedMs`, and threads
  gone or out of the lists. The client merges them and asks again from the
  newest `updatedMs` less 5 seconds (a mutation can commit just after one stamped
  later), so each run reads only what changed; `more` says to load the list
  again. The website and the iPhone follow the inbox this way; hibernating and
  archived stay on `phone:threads`, as they're rarely written.
- `phone:threadRow({ token, threadId })` (API 37) → the thread's row alone,
  for a client that reads messages with `phone:messages`.
- `phone:images({ token, threadId, from })` (API 37) → the thread's pictures
  from that seq on, for a client passing `noImages: true` to `phone:messages`.
- `phone:command({ token, commandId })` → `{ state: "pending" | "taken" |
  "done" | "failed", note?, threadId? }`.
- `phone:waiting({ token, threadId })` (API 57) → the thread's `send`
  commands not yet finished, oldest first: `{ commandId, state: "pending" |
  "taken", text, photos, createdAt }`. The phone shows each as a faded
  message under the transcript, so several sent while the runner is asleep
  don't look lost.
- `phone:cancel({ token, commandId })` (API 57) → `true` if the send was
  still pending and is now `failed` with note "Cancelled" (its photos
  deleted), `false` once the runner has taken it. `sync:takeCommand` checks
  `pending` in its own transaction, so only one of the two wins.

Since API 16, `phone:search({ token, text })` returns up to 30 archived
thread rows whose title or last reply has those words (Convex full-text
search, the last word as a prefix), for the phone's search: `phone:threads`
gives it only the newest 100 of the den.

Also `phone:projects({ token, archived? })`, `phone:schedules({ token })`
and `phone:accounts({ token })`, the runner's lists as it last sent them
(docs/protocol.md "Sync" says which fields). Since API 48 `phone:projects`
reads `projectHeads` and returns `goals`, `state`, `notes` and `folders` empty;
`phone:project({ token, runnerId, id })` is one project whole, or null, read
only when its page is open. Since API 5 a project row
has `icon?: { symbol?, url?, by }`: the Mac's `ProjectIcon` with the
picture as a URL into file storage (the runner uploads it, docs/protocol.md
"Sync", "Project pictures") in place of a path on the Mac. The phone draws
the picture, else the symbol, else the title's first letter, as the Mac
sidebar does; a runner before API 5 sends projects without `icon`.

Mutations, each returning a `commandId`. The owning runner takes it
within a second or two while it's online (state `taken`, then `done` or
`failed` with a `note`); while it's offline the command waits as
`pending`, for up to 14 days (then `failed`, `sync:pruneFiles`). At most
200 commands, or 8 MB of them, wait for one runner; past that the next is
refused with `{ kind: "tooMany" }` until it takes some. A `runnerId` the
phone names must be one that has heartbeated (or `"any"`), else
`{ kind: "notFound" }`:

- `phone:send({ token, threadId, text, answers? })` (`answers`, API 14: the card's asks it answers, `{ action, answer }[]`)
- `phone:press({ token, threadId, buttonId })` (API 59) → commandId: a
  reply button's press (docs/protocol.md, "Reply buttons"), queued as a
  `press` command with `{ buttonId }`. Its `resultThreadId` is the thread
  the button started or messaged. `phone:messages` rows carry `buttons`,
  the state of the buttons an assistant message links, since API 59.
- `phone:respond({ token, threadId, approvalId, decision: "allow" |
  "allowAlways" | "deny", message? })`
- `phone:answer({ token, threadId, approvalId, answers: Record<string,
  string>, message? })`: one answer per question keyed by its text, as
  the runner's `approvals.respond` with decision `answered` takes it;
  `message` is the answers in one line for the transcript (default: joined
  with "; ").
- `phone:secret({ token, threadId, approvalId, sealed?: { epk, nonce,
  box }, decline? })` (API 35): the answer to a `pendingApproval` of kind
  `secret`, sealed to that card's `key` so only the runner can open it
  (docs/protocol.md, "Secrets"). `sealed` is dropped from the command
  once the runner has finished it.
- `phone:update({ token, threadId, change })` where `change` is one of
  `{ snooze: { until?, untilRestart? } }`, `{ wake: true }`, `{ archive:
  true }`, `{ unarchive: true }`, `{ markSeen: true }`, `{ title }`.
- `phone:setRunnerOrder({ token, runnerIds })` (API 56): Mike's order for
  his runners, from the phone's Settings (or the Mac's, through its runner:
  `sync:runnerOrder` and `sync:setRunnerOrder`, API 58, the owner key only), at most 50 ids, kept in the one
  `runnerOrder` row. The phone's new thread sheet offers a runner, starting
  on the first one online in it.
- `phone:create({ token, text, runnerId?, cwd?, accountId?, model? })`.
  With no `runnerId`, the first runner online and not draining in Mike's
  order (API 56); with no order, or none of it online, of the runners
  heartbeating with the owner key
  (`byOwner`) seen in the last 3 minutes, the one with the most threads (the
  Mac Mike works on), or `"any"`, which only the owner key takes, so it waits
  for that Mac (docs/protocol.md, "Runner keys").
- `phone:quickAsk({ token, question, answer, sources?, askedAt, runnerId? })`
  (API 10): a quick ask the phone has already answered out loud, kept as a
  thread. `question` is 1 to 2,000 characters once trimmed, `answer` 1 to
  20,000, `sources` at most 10 `{ title, url }`, `askedAt` ms since 1970.
  Targets a runner as `phone:create` does. The runner makes the thread
  with the exchange in it and no turn (docs/protocol.md, Sync,
  `quickAsk`), so a message sent to it later is an ordinary follow-up;
  `phone:command` gives its `threadId` once `done`.
- `phone:loadEarlier({ token, threadId, beforeSeq })`: the runner writes
  up to 50 text messages before `beforeSeq` as paged rows, then the
  command is `done`; `phone:thread` then returns them too. Paged rows go
  after a day, so the phone should ask again rather than expect them to
  stay.
- `phone:registerDevice({ token, apnsToken, environment: "sandbox" |
  "production" })`. `apnsToken` is the device token in hex. A phone token
  keeps at most 5 registrations; a new one past that replaces its oldest.
  Revoking a token takes effect in that one small write (its phones get no
  more pushes at once, `devices:targets`); their rows are deleted after, 100
  a run (`tokens:dropDevices`). A push arrives when a thread starts needing Mike,
  as `{ aps: { alert: { title, body }, sound: "default", "thread-id":
  threadId }, threadId }` for bundle id `com.mikecann.threadbear`; the
  title is the thread's title and the body the question, the approval
  with its input line, or the reply.

Changes from the proposal: `answers` values are strings, not arrays (a
multi-select question's choices go in one string, comma-joined, which is
what the Mac app sends); `view` and `lastActivityMs` are on every row; a
`title` change was added to `update`.

## Secret scrubbing (API 47, 5 Nov 2026)

Threadbear had none until now. Today's mirror was nearly clean only because it
sends one-line tool rows: on 5 Nov the rules would have changed 2 of prod's 83,924
message rows and nothing in its other tables. Full sync would be a different
story (about 220 of Mike's 200,000 events, tool output mostly), so this came
first. The lessons are Agent Archive's:

- **Patterns alone fail, and on the worst leaks.** `sed`, `cut`, `sort` and
  truncation mangled keys past each version of its rules (Poddle's APNs key, a
  whole Google key). So there are three layers on the runner: where it came from
  (`runner/src/withhold.ts`, for the output of `env list`, `.env`, `.p8` and the
  like, unused until tool output goes up), values it knows
  (`runner/src/secret-values.ts`) and shapes (`runner/src/redaction.ts`, copied
  from Agent Archive with its tests).
- **Scrub on both ends.** An older runner sends what it sends, so the backend
  runs the same rules (`convex/redaction.ts`, a byte-identical copy a unit test
  keeps equal).
- **One way up.** Agent Archive's tool output over 64 KB took a path the backend
  didn't scrub, and was never replaced. Here it's one wrapper on `ConvexSync.post`
  and a generic walk over every field, and the backend's `clean()` in each mutation.
- **New rules need old rows rewritten, without re-sending everything.** A bump
  made every Agent Archive daemon recheck about 3,600 files. Here nothing re-sends:
  bump `SCRUB_RULES_VERSION` and run `node runner/scripts/scrub-stored.mjs`, a dry
  run unless `--apply`, which prints ids and counts only.
- **Cleaning up isn't undoing.** That cleanup also had to reach backups and
  exports, and the keys had been to the AI providers already. So the docs say to
  rotate, and never that the data is secret-free.

- **Scrub before cutting.** Titles, previews, ask lines, the wake note, tool
  titles, quoted replies and check output are cut short on the runner, and a
  rule that needs a secret's end (a connection URL's `@`, a closing quote, a
  length) misses half of one: on 6 Nov Daybreak found a wake note cut through
  `postgres://alice:password@host` with the password intact. So a cut never
  lands inside anything the scrub would take out (`runner/src/safe-cut.ts`,
  with the runner's known values too); it moves back to before it, leaving the
  runner's own copy unscrubbed. Taking a first line, a first sentence or the
  last part of something counts as a cut too. The wake note is scrubbed whole
  on the way up and only then cut.

Not scrubbed, on purpose: a command's words while it's on its way (a message from
the phone or another Mac has to reach the runner as typed). Once a command is over,
however it ended, its words are dropped from the row rather than scrubbed, so a
value only the sender knew doesn't stay. One that's never taken stays as typed
until a runner takes it. A value only the sending runner knows still goes up in the
message row once the other runner has it, as that runner can't know to take it out.
Identity fields aren't scrubbed either. A title or preview is cut before it gets here, so the
rules and known values also take out a key's start at the very end of a text, and
what's left of a key cut shorter than that is a few characters. A title that holds
two different secrets can come out the same for two Pocket cards, so the second
replaces the first, and likewise two pictures on one event whose file names
hold secrets. That loses a card or a picture and leaks nothing, so it stays.

The on-device check (`runner/src/secret-check.ts`, `runner/src/secret-check/`)
is an experiment, off by default, that changes nothing. In a fake test on 5 Nov,
Apple's model caught what the rules can't (9 of 9 values with no known prefix) but
raised 6 false alarms in 19, and on a sample of Mike's real data it flagged 4.4%
of tool outputs and 8% of screenshots, so it counts first. If it's ever trusted,
it may only hold things back, never clear them: tool output is untrusted and can
tell the model to answer "clean". Linux has no such model, so a Linux runner has
the rules and the withhold list, and `tb status` says so.

## Full sync (API 52, 6 Nov 2026)

Tool output, input and diffs for a runner with `sync.full` on (docs/full-convex.md
step 4; docs/protocol.md "Sync" has the fields). Convex charges a read for the whole
document, so they're in `eventBodies`, not `messages`: no list ever reads one, and
each is fetched once, by seq, when someone opens that tool. Writes are the cost, plus
reading each row again to delete it after 30 days (`pruneBodies`), so about twice what
comes up. Bumping the rules re-sends nothing; `scrub-stored.mjs` covers this table,
but it's the one table where a run over everything costs real I/O.

## The Pocket (API 19)

The phone's deck of cards for when Mike's out (`pocketCards`, the `pocket`
tool in `runner/src/threadbear-mcp.ts`, `ios/Threadbear/PocketView.swift`).
Unlike the other lists, this table is the only copy: the tool writes to it
directly through `sync:savePocketCard`, and the phone removes cards directly
with `phone:removePocketCard`, not through a command. Both runners then share
one deck, and removing a card works while the Macs sleep. With sync off the
tool isn't offered. The phone saves what it last saw in `pocket.json`
(`PocketStore`), which is what makes the deck work with no signal.

The librarian keeps cards current too (`pocketChanges` in
`runner/src/librarian.ts`): each look sees the thread's own cards and can
update or remove them, or add one if the thread has none. What it can do is
checked in code, not left to the model: only that thread's cards, one added
card per thread and five a day, and no digits or codes that weren't in what
the look was shown. A thread with cards, or a message saying the user's going
out, is never skipped as a quiet catch-up, since "posted it" is short.

## Usage and the free plan (2 Nov 2026)

Measured for release card 6b (thread 4b8626ed) before the repo goes public,
since every fork runs its own deployment and most will be on the free plan.

### The free plan

From convex.dev/pricing and docs.convex.dev/production/state/limits, read on
2 Nov 2026. The limits are per team, not per deployment.

| | Free | Note |
|---|---|---|
| Function calls | 1M a month | |
| Action compute | 20 GB-hours a month | |
| Database storage | 0.5 GB | a total, not monthly |
| Database I/O | 1 GB a month | "document and index data transferred between Convex functions and the underlying database" |
| File storage | 1 GB | a total |
| Data egress | 1 GB a month | |

On the free plan the limits are hard: past them, "new mutations that attempt
to commit more insertions or updates may fail", so the mirror stops. Starter
has the same included amounts and then charges as it goes ($0.22 a GB of
I/O, $2.20 a million calls, 1.3 times that outside US regions).

### What Mike's prod used

Dashboard, team usage page filtered to `threadbear`, last 7 days (26 Oct to
2 Nov; the mirror went live on 28 Oct, so it's about 5 days), with
per-call numbers from `npx convex logs --deployment mikec:threadbear:prod
--success --jsonl`, whose `usageStats` give each call's database bytes.
That's two runners (the M5 with about 500 threads and Bruce with 6), about
330 turns a day on the M5 alone, and the phone in daily use.

| | last 7 days | steady rate | a month at that rate | free limit |
|---|---|---|---|---|
| Function calls | 131K | 25K to 30K a day | about 850K | 1M |
| Database I/O | 4.78 GB | 1.2 to 1.4 GB a day | about 40 GB | 1 GB |
| Database storage | 67.7 MB | grows 8 to 10 MB a day | | 0.5 GB |
| File storage | 16.2 MB | | | 1 GB |
| Data egress | 46 MB | | about 200 MB | 1 GB |
| Action compute | 0.099 GB-hours | | about 0.4 | 20 |

Database I/O by function, last 7 days: `sync:otherRunnersThreads` 3.48 GB
(73%), `sync:setProjects` 446 MB, `sync:upsertThreads` 182 MB,
`phone:counts` 96 MB, `phone:threads` 80 MB, `sync:messageHeads` 69 MB,
`sync:setThreadIndex` 68 MB, `sync:appendMessages` 63 MB,
`sync:setAccounts` 63 MB, `sync:setPresence` 59 MB, `phone:projects` 53 MB,
everything else under 31 MB each. Calls: `sync:appendMessages` 31K,
`sync:otherRunnersThreads` 27K, `sync:upsertThreads` 22K, `sync:heartbeat`
13K, `sync:setThreadIndex` 6.3K, `sync:setAccounts` 5.9K, `phone:threads`
4.5K, `sync:setProjects` 1.6K, the rest under 1.5K each. Storage is 93%
`messages` (55K rows; every message is kept). Push relay, Pocket, schedule
lease polling (`sync:schedules`, `sync:claimSchedule`) and project task
reads are all small: Notion reads never touch Convex.

What each cost comes from:

- **`otherRunnersThreads`**: the live query a runner holds on the other
  runners' `threadIndex` rows. Every re-run reads all of them. Bruce's
  re-read the M5's 500 rows (about 220 KB) on every M5 index write and
  every heartbeat from either runner, about 400 times an hour, though
  nothing on Bruce shows them: it has no Mac app. That was 99% of this
  function's I/O. Fixed (below).
- **`setProjects`**: any project change (a thread's activity moves its
  project's `lastActivityAt`) rewrites every project row. Mike's 70-odd
  projects with long notes are about 460 KB a call. Small for a typical user.
- **Per turn**, from the log sample: about 20 `appendMessages` (1 KB each),
  10 `upsertThreads` (3.4 KB), 5 `setThreadIndex` (1.7 KB), 2
  `setAccounts` and 1 `setProjects`. That's about 38 calls and, with a
  typical user's handful of small projects and one or two logins, about
  80 KB of I/O.
- **Always**, per runner: a heartbeat a minute (1.1 KB) and, while it
  watches, a re-run of the other-runners query on each heartbeat. That's
  about 2,900 calls a day whether or not anything happens.
- **Growing with the thread count**: `setPresence` reads every thread row of
  the runner (about 4 KB each) each time Mike walks away from the Mac,
  looking for held pushes; `phone:counts` reads every hibernating and
  den row on each re-run; `prune` reads every row on each runner start.

### A typical user: one Mac, a few threads a day

Assumed: one runner with the Mac app open all day, 5 threads and 15 turns a
day, three small projects, one or two logins, a phone opened now and then,
about 10 pushes a day.

| | a month | share of the free limit |
|---|---|---|
| Function calls | about 110K (2,900 a day fixed, 600 from turns, 200 from the phone and pushes) | 11% |
| Database I/O, first month | about 250 MB (fixed 2.5 MB a day, turns 1.3 MB, phone about 2 MB, presence 2.5 MB) | 25% |
| Database I/O, after 6 months | about 650 MB, as presence and phone counts read 900 thread rows | 65% |
| Database storage | grows about 10 MB a month | half the limit after 2 years |
| File storage | a few MB (project pictures, shared and reply images) | under 1% |
| Data egress | about 10 MB | 1% |
| Action compute | about 0.03 GB-hours (pushes) | 0.2% |

It fits on day one with room to spare. The one thing that doesn't stay
comfortable is database I/O creeping up with the number of threads kept,
from `setPresence` and `phone:counts` reading every row; the backend cuts
below take that away.

**A heavy single Mac** (Mike's M5 on its own): about 450K calls a month
(45%), about 5.5 GB of I/O (5.5 times the limit) and 300 MB more storage a
month. Someone using it like that needs Starter, where that's about US$1.50
a month.

**Two Macs, each with the app open** didn't fit before API 29: each one's
watch re-read all the other's index rows on every heartbeat and every index
write, about 0.5 GB a day with 300 threads each. Now a change reads only the
rows it touched (cut 2 below).

### Cuts

Done (runner only, 3506d3b): a runner watches `otherRunnersThreads` only
while a Mac app is connected, and for two minutes after it goes
(`thread-index.ts`). Bruce stops watching altogether. On last week's
numbers that takes Mike's prod from about 1.25 GB of I/O a day to about
0.2 GB, and about 18K calls a week off.

Backend changes (these deploy prod when they land on main; Mike said yes to
1 and 2 on 2 Nov, and 3 and 4 on 3 Nov):

1. Done: `setPresence` finds held pushes with an index on `pushHeldAt`
   instead of reading every thread row. Takes the growth out of a typical
   user's I/O.
2. Done (API 29): the runners list is its own query
   (`sync:otherRunnersList`), so a heartbeat doesn't re-run the read of the
   rows, and the rows are watched from where the last answer left off
   (`sync:threadIndexSince` on an index of `updatedMs`, with a day's
   tombstones for deleted threads). A change now reads only the rows it
   touched, so two Macs fit as well as one.
3. Done (API 30): `phone:counts` adds up a `viewCounts` row per runner,
   which `upsertThreads` and `removeThreads` keep as threads move between
   views, rather than counting every hibernating and den thread. A runner's
   `prune` (each start) counts again from scratch, so a count that drifted
   puts itself right, and a heartbeat makes a runner's first row.
4. Done (API 30): after the whole list once per start, the runner sends only
   the projects that changed and the ones gone, with
   `sync:upsertProjects`. Mostly Mike's own cost: his 70-odd projects with
   long notes were about 460 KB each time a turn moved one.
5. Done (API 40): a project's page reads its threads through
   `projectThreads`, a small row per thread per project kept by
   `upsertThreads` (only when a thread is new, taken over or changes
   projects), `removeThreads` and `prune`, with `phone:projectThreads`
   taking the ones that joined last by an index on `projectId` and sorting
   that page by activity. The first version kept each link's
   `lastActivityMs` current, a patch on every turn, which took
   `upsertThreads` from about 4.1 KB to 7 KB a call (35 MB a day). A thread's projects are an array on
   its row, which can't be indexed, so the alternative was reading every
   thread, archived ones included. Threads from before API 40 are linked
   once per runner by `sync:linkProjects`, a page at a time, which a
   heartbeat starts (`viewCounts.projectsLinked`). The "22 threads" on a
   project is still the runner's own count, sent on its project row.

### The restart cost (5 Nov 2026, API 37)

Once the cuts above were in, Mike's prod ran at about 215 MB a day (dashboard,
3 and 4 Nov, cumulative totals subtracted), and most of it was runner starts,
not live reads. The M5 started 12 to 15 times a day following main, and each
start rewrote all 710 thread rows and sidebar rows, read them all again to
prune, and read a row and a message per thread for message heads: about 9 MB a
start, over half of the total. What's sent is now remembered as hashes between
starts (`runner/src/sync-cache.ts`, `sync-sent.json`), with a full write every
3 days.

Also since then: a row whose only change is its preview or unread waits 20
seconds (73% of row changes on the M5, each re-running a 30 to 40 KB
`phone:threads` for every open client); a project moving only by
`lastActivityAt` goes every 10 minutes; `sync:upsertAccounts` writes one login
rather than all of them, and a new reading time alone isn't a change; the
website watches a 30-row tail, reads older pages once, watches pictures apart
(`phone:images`) and lets go of its live queries after a minute hidden. The
iPhone app still raises `limit` and uses `phone:thread`, which costs about
70 KB for each message that arrives while a thread is open.

Since measured below: the inbox follows only what changed (API 43), and a
reading copied from another runner goes up at most every 10 minutes, or at once
if the login is blocked. The runner that made a reading still writes it at once.

Measured from `npx convex logs --success --jsonl` on 5 Nov. A runner start: 9.6
MB before, 0.39 MB after (5 rows written), though every 3 days one is still a
full write. The functions this changed fell from about 375 to 178 MB a day at
the rate of each hour's sample (0.86 h and 1.05 h, the second with more
starts), but these are busy daytime samples, not daily figures. By then most
I/O was live reads for open clients: `phone:threads` about 390 MB a day at that
rate (39 KB per re-run), `phone:projects` 165 MB (190 KB), `phone:schedules` 68
MB (157 KB). Those cost nothing with no client open. Also new that day: `sync:sharedUsage` (API 39) reads every login's row, and one
reading gets copied to the other runners' rows, so one change is three writes
and nine re-runs, about 70 MB a day at that rate.

Then, API 48. Measured from the logs on 5 Nov before the change: `sync:schedules`
168 KB a run, `sync:sharedUsage` 16 KB a run. A runner key's `sync:schedules` now
reads only its own rows, so Bruce and Hetzner no longer pay for, or re-run on, the
M5's claims, and every runner of 45 follows only the rows written since (`sync:schedulesSince`), so a run costs a row or two rather than the table. Finished one-offs already go after 7 days (`KEEP_FINISHED_MS`), and they're now read only when a runner starts. `phone:projects` reads
`projectHeads` rather than `projects`: 79 projects are 199 KB in `projects`, 143 KB
of it notes, and the fields a list needs are about 30 KB. Editing notes no longer
re-runs the list. `sync:sharedUsage` leaves out the caller's rows. A day's real
rate after this hasn't been measured yet.

Measured after API 48 landed (20 minutes of prod logs, 5 Nov, late at night with
almost no client open, so not comparable with the samples above): `phone:projects`
37 KB a run, `sync:schedulesSince` one whole read at 178 KB and then little,
`sync:sharedUsage` still 12 KB a run and the biggest at 78 runs, and about 184 MB/day
overall. A full day's rate is still to come. On 6 Nov `sync:sharedUsage` became a
query every 5 minutes instead of a subscription (each runner's watch re-ran on
every other runner's login write): 12 runs an hour per runner, about 14 MB a day
for four runners whatever they write.

Then, API 50 (6 Nov). The daily check's 15-minute samples had
`sync:upsertProjects` at 55 KB a call, 11 to 16 calls a quarter hour while
threads were busy: each `update_project` (or a project's thread count moving)
rewrote the whole row, and 16 KB of the Threadbear project's 17.7 KB is notes,
so each was about 34 KB read and 17 KB written. Notes now live in
`projectNotes` (`convex/projectNotes.ts`) and a runner of 50 sends them only
when they change, so a state update writes the small row alone. An older row's
notes move out the first time it's written; `phone:project` reads either.
`phone:projectSearch` and `setProjectIcon` read the smaller rows too.

An estimate for one Mac with the app open, 300 threads, 15 turns and half an
hour of phone use a day: about 6 MB a day, 185 MB a month, under a fifth of the
free 1 GB. Heartbeats are 2.4 MB of that and the three-day full write 1.3 MB,
which grows with threads kept (about 13 KB a thread).

Confirmed live on 5 Nov: `phone:threadsSince` costs 2.4 KB a run against
`phone:threadsAt`'s 37.5 KB. Next: `sync:schedules`, 160 KB a run, as each
schedule write makes every runner read all 113 rows, 61 of them finished
one-offs. It could follow only what changed, as the inbox does.

Not urgent: messages are kept forever, so storage grows about 10 MB a month
for a typical user. Dropping the messages of threads archived more than a
month ago would hold it flat if it ever matters.
