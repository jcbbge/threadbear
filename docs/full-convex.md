# Threadbear: full Convex by default

Written 5 Nov 2026 in thread 3a33a492, after Jamie Turner's DM. Numbers are from
Mike's M5 unless they say otherwise, and estimates say so.

## What we're doing and why

Every finished thread event goes to the person's own Convex deployment, on by
default with an off switch. Other machines' threads are then read and steered
through Convex, so the Tailscale link, runner tokens and `tb pair` can go.

Two reasons:

- **Jamie's:** securing Convex should be the only message bus to worry about,
  especially for people who don't know what Tailscale is.
- **Mike's:** a cloud runner that has to spin up, or has gone away, can't serve
  a transcript when you open it, so the transcript has to live somewhere else.

## Decided so far

| Question | Decision |
|---|---|
| Default | Full sync on, with an off switch |
| Order | Cut reads first, scrubbing before any tool output goes up |
| Tool screenshots | Stay on the runner, fetched on tap, uploaded for a day |
| Pasted pictures | Sync by default, own line in the docs that they can't be scrubbed (lands after the launch video, thread 531a6ae0) |
| Pictures agents post or pin | Sync as they do today |
| Runner with no on-device model | Tool output uploads after the rules and withhold list, and `tb status` and setup say so |
| Secret check on Macs | Runs silently first, and can only ever hold things back |
| Tool output in Convex | Kept 30 days, then falls back to fetching from the runner (Mike, 5 Nov) |
| Other machines' threads | Show finished messages and the working line, with no streaming writes (Mike, 5 Nov) |

## What it costs

Measured over about 10 days, 244 MB of events:

| Event | MB | Goes up as |
|---|---|---|
| Tool results | 130 | Body |
| Tool calls | 60 | One line (already synced), full input as a body |
| Reasoning | 27 | Body |
| Message text | 12 | Already synced, cut at 8,000 characters |
| Diffs | 7 | Body |
| Other | 8 | Only what the thread view needs |

- **Writes (estimate):** about 22 MB a day of new bodies, so about 0.7 GB a
  month, or about 1 GB with Sydney's 1.3x. Pro includes 50 GB of I/O.
- **Storage (estimate):** the same 0.7 GB a month, before any expiry. Pro
  includes 50 GB, Starter and Free 0.5 GB.
- **Light user (estimate):** 15 turns a day against Mike's roughly 355 is about
  4% of this, so about 35 MB a month on top of the I/O thread's 185 MB. Full
  sync alone would take over a year to fill 0.5 GB of storage.
- **Not counted:** Bruce and the cloud runner, index overhead, and reads when
  someone opens tool output. Step 3 measures all of them.

Reads are the real risk. Today's biggest live costs are `phone:threads` at
389 MB/day and `phone:projects` at 165 MB/day with a client open (thread
9b6113da, rates from one hour's sample, not a full day).

## Read rules for anything new

From the I/O thread's report (9b6113da):

1. Keep large output out of the row lists are read from. Convex charges for
   whole documents, so bodies get their own table and are fetched once by seq.
2. Events never change: watch a tail of 20 to 30 rows, read older pages once,
   and keep them on the client. If a tail starts past what's held, start over
   rather than leave a hole (`web/src/transcript.ts` does this).
3. Thread lists subscribe to rows changed since a time, with tombstones
   (`threadIndexSince`), not the whole inbox.
4. Never write streaming deltas, only finished events, in batches.
5. Starts use a local record of what's up and never scan. No backfill unless
   someone asks for it.
6. Clients drop subscriptions when hidden.
7. Anything that writes on a thread change compares first.

A machine's own threads stay on loopback, so most of Mike's reading costs
nothing.

## The build, in order

Each step lands on its own and is useful without the next.

### 1. Finish the read fixes

- Move the website's thread list to the rule 3 pattern, and add it to the phone
  app as an optional path, as App Store builds stay on `phone:threads` for a
  while.
- `phone:projects` reads 190 KB a run: split out the notes and state it doesn't
  need for a list.
- `sync:sharedUsage` writes one reading to all three runners' rows: write it
  once.
- **Done when:** a full day's real rate is known, and it's below the current
  one with a client open.
- **Status, 5 Nov:** the inbox and usage writes landed in ee0b2dbd (thread
  9b6113da), and the projects list and schedules in 58d8907d (API 48). 20 minutes
  of prod logs afterwards: `phone:projects` 37 KB a run (was 178), `sync:schedulesSince`
  a whole read once at 178 KB and then little (`sync:schedules` was 148 KB on every
  change), and 184 MB/day overall at that rate, late at night with almost no client
  open, so it doesn't compare with the earlier hourly samples. **Still to come:** a
  full day's real rate, from the daily 09:00 Perth usage check. Left: `sync:sharedUsage`
  (12 KB a run but 78 runs in 20 minutes, the biggest cost now), `phone:schedules`
  (113 to 171 KB a run, the iPhone still uses it) and `sync:upsertProjects` (about
  56 KB a run). `phone:projectSearch` reads 186 KB a run, only while someone's
  searching.

### 2. Secret scrubbing

**Done 5 Nov** in fc6d404a (backend API 47; "Secret scrubbing" in
docs/convex-backend.md). Rules, known-value masking, withhold list, a second pass
in the backend, `runner/scripts/scrub-stored.mjs` to rewrite stored rows (run on
prod, 2 rows), the silent check (`secretCheck` in runner.json, on Mike's M5 only),
and wording in `tb status` and setup. Nothing calls the withhold list on the way up
until step 4. A command's words are dropped from its row once it's over.

### 3. Per-runner keys

**Done 5 Nov** in 035d23a3 (backend API 41, "Runner keys" in docs/protocol.md),
from thread 913a6699. RUNNER_KEY is the owner key, on the M5 only; every other
runner has its own `tbr_` key (`tb runner add <name> --ssh <host>`), limited by
convex/runnerAccess.ts. Bruce and Hetzner Cloud (befe8df8975c, keyed 07:03 UTC)
have both moved, and the owner key rotation finished at 06:49 UTC. The original
plan for this step follows.


One shared `RUNNER_KEY` on a Hetzner box can read everything, and the Daybreak
scan already flagged it. Each runner gets its own key, so its mutations can only
write its own rows, and a stolen one can be revoked alone. Old runners keep
working on the shared key until they've moved. Needed before step 4 reaches
anyone but Mike.

### 4. Full sync, off by default, on for Mike first

**Built and on for Mike's four runners, 6 Nov** (8b18a30e, backend API 52; "Full
sync" in docs/protocol.md and docs/convex-backend.md; `sync.full` in each runner's
runner.json, off for everyone else). Being watched for about a week.

- **Measured** (25 minutes of prod logs, 05:21 to 05:46 UTC on a busy morning, M5
  doing nearly all of it; Bruce, Hetzner and the Pixel had almost no threads running):
  `sync:appendBodies` 108.7 MB/day at that rate, 3.9 KB a call, 1.9 MB written and 6 KB
  read. That's about 98 MB/day of rows, against the 22 MB/day this plan estimated from
  a quieter 10 days, so the rate is an upper end for now. Overall 599 MB/day, against
  297 MB/day in the 20 minutes before, though `appendMessages` alone went from 46 to
  159 MB/day at the same time, which body rows don't touch, so more was running.
- **Budget:** 100 MB/day across all four, set from 5 Nov's 581 MB (about 390 MB
  without one-offs). It's at the top of that on a busy morning. **The real figure is
  the daily usage check's**: at this rate writes are about 3.3 GB a month, and from day
  31 deleting reads the same rows again, for about 5 GB a month in all, within the 50 GB.
- **Withheld:** 91 of 1,617 rows (5.6%), 76 of them reading a background job's output.
- **Left out:** the iPhone (old phones keep working, and it needs a release to open a
  tool). The Mac shows no reasoning, and its pictures stay "kept" (website only). A
  thread's first tool in flight across a handover shows as kept on the runner.
- **Known limits:** a background tool that finishes across a restart stays input-only;
  a subagent's reply goes up scrubbed like any agent message; the withhold list can't
  know every command; setup says nothing yet as it's off for new installs (step 6).

The original plan for this step follows.

- New table of bodies by thread and seq, with the small `messages` rows as they
  are. Bodies go through scrubbing and withheld items become a stub saying
  "kept on the runner".
- Forward only from the moment it's on: no backfill unless asked.
- Website and phone expand a tool row by fetching its body once.
- Screenshots: a stub, and a tap sends a command for the runner to upload it for
  a day.
- Expiry: a body is kept 30 days, then falls back to fetching from the runner,
  the same as a screenshot.
- Replaces `sync.pastedPictures` with one `sync.full` switch, with the pictures
  setting still honoured.
- **Watch for about a week:** real I/O, storage, what's withheld and what the
  silent check flags. Stop and rethink if I/O goes up by more than a few GB a
  month.
- **When this is on for Mike:** whoever turns it on sends thread 1d9689e6 (Linux
  runner and sandbox models) a message with the commit and the backend API
  version, so it can pick up the sandbox-per-thread work.

### 5. The Mac reaches other runners through Convex

**Built 5 Nov** from thread 48ea37bc, ahead of step 4 (main f0e3fb14 to
ee2c4c43, backend API 44, "Other runners' threads through the backend" in
docs/protocol.md). The M5's runner answers the app for another runner's
thread from Convex (`convex/relay.ts`, owner key only) and sends what the
app does as `commands` rows: read, send, approve, answer a question or a
secret (sealed to that runner's key), stop, rename, snooze, archive, star,
share, a new thread there, and a folder list (an allow-listed `call`).
Tool output, diffs, pictures and sub-agents show as "kept on <runner>",
with `heldBack: { seq }` on each tool result for step 4's
`sync:remoteBody`. Editing a message, highlights, patches and changing a
thread's login or model stay on that machine or the direct link, which
is Settings > Runners > Connect to other machines directly (off by
default). Checked on bruce and Hetzner Cloud through the live M5 runner:
a new thread made, read and sent to on each. Codex reviewed it twice;
16 findings fixed. `runner.status`'s `relay` counts reads and bytes.
The original plan for this step follows.


- The app keeps talking only to its own runner. That runner handles a remote
  thread through Convex: tail and bodies for reading, `commands` for sends,
  approvals and updates, which the phone already does. The Mac app needs no
  Convex dependency.
- The app's `RemoteClients` already sits behind `client(for:)`
  (`app/Sources/Threadbear/RemoteRunners.swift:92`), with 34 call sites to go
  through. The first job is listing which of the methods the app uses need to
  work on a remote thread, and which stay local-only.
- Anything that needs an answer from the runner, like a folder list, uses a
  `commands` row with a result, allow-listed by method.
- Keep the direct link beside it behind a setting until this has been used for
  a while, then remove it with `tb pair`, tokens and host pins. That also removes
  a good part of the Daybreak findings' surface.
- Ask (the quick question feature) still talks to the archive server directly.
  `quickAsk` commands exist, so moving it is a small separate job.

### 6. On by default

**Free accounts, worked out 6 Nov** from 1.52 hours of real rows: 2,797 bodies, 5.21 MB, 221 M5
turns, so about 24 KB of body rows a turn. Writes plus 30-day deletion make about 48 KB a turn of
I/O, and storage levels off at 30 days' writes. These are estimates, before index overhead.

| Turns a day | I/O a month | Storage held |
|---|---|---|
| 15 | about 20 MB | about 11 MB |
| 100 | about 140 MB | about 70 MB |
| 500 | about 720 MB | about 350 MB |

Free is 1 GB of I/O and 0.5 GB of storage, and they're the team's, shared with other projects. On Free,
going over means new writes may fail; on Starter it bills at $0.22 a GB. So full sync fits at light and
ordinary use, and 500 turns a day, a heavy user, is what gets close, on top of the mirror's own reads.
Mike's real rate is the check: this morning's "3.3 GB a month" assumed a busy morning's pace all day.

**The silent check, reviewed 6 Nov** with every value masked: 32 flagged of 722 checked (4.4%), and none
looks like a real credential: code and docs about secrets, status text, logs, `ps` output, a public deploy
key, screenshots of sign-in fields. So holding back on its word would hide about 1 output in 25 for
nothing today. Keep it counting. It's not ready to hold anything back, and how much it misses on real
data is still unknown, as nothing in the sample hit the rules either.

- Only once 2, 3 and 4 have run on Mike's runners, and step 5 works.
- New installs: on, and setup says in plain words what goes up, what can't be
  scrubbed, and where the switch is.
- Existing installs: asked once, never switched silently.
- Update `docs/on-your-mac.md`, the README, the guide and the landing page's
  "What goes up to Convex?" and "Where your stuff lives" (`site/`) in the same
  landing.

### Later, on their own

- Linux model: not yet. The Hetzner test (5 Nov, on 2 cores, fake data,
  `~/dev/me/misc/secret-check-spike/RESULTS.md`) found nothing good enough to
  check all tool output: Qwen3 1.7B needs 2.7 GB and 39 hours a day of compute
  at Mike's volume, and found 1 of 4 secrets in long output. Linux stays on rules
  and the withhold list. If it needs more, try a small trained classifier on
  pre-filtered lines, which wasn't tested. Sandboxes shouldn't run a check at all.
- Disposable sandboxes: screenshots and bodies when the runner might vanish.
- Whether this replaces Agent Archive. Its search and embeddings are a different
  job, so it isn't assumed here.

## What happens when something fails

| Situation | What happens |
|---|---|
| The rules fail | Nothing uploads for that item |
| Runner too old to scrub | Backend pass still runs the rules but not the withhold list. Flagged in setup and `tb status` |
| Model busy, timing out or crashed | Hold and retry. Item stays on the runner and opens on tap |
| Model gone (Apple Intelligence turned off) | Treated as no model, shown in `tb status` |
| No model at all | Rules and withhold list, then upload, and say so |
| Convex unreachable or over limit | Mirror stops, runner carries on, retries with backoff. Nothing the app does waits on it |
| Off switch used | Today's mirror: text and one-line tool rows. Other machines' threads show the phone-style view, or the direct link while it exists |

## Limits to say out loud

- Scrubbing is not a guarantee, and a leaked key has to be rotated: copies have
  already gone to the AI provider, and Convex backups keep old rows.
- Convex limits are per team, so a stranger's other projects share them. On Free,
  going over stops writes and can later stop function calls. On Starter it bills
  $0.22 per GB of I/O (Convex docs, via thread 9b6113da).
- A remote thread shows finished events and the working line, not live typing.
