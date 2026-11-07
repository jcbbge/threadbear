// The backend's API version: what the runner and the phone app can expect
// from these functions. Bump it when a change adds something a client relies
// on, and change clients to cope with the old number first, since a phone
// from the App Store and an older runner can both meet a newer backend (and
// the other way round) while an update rolls out.
// docs/setup-and-updates.md section 2.3.
//
// The runner checks it against its own BACKEND_API_VERSION (runner/src/sync.ts;
// a unit test keeps the two equal) and says so when its backend is older.
//
// 1: the phone API of 27 Oct (docs/convex-backend.md section 6), plus this
//    number on sync:heartbeat and phone:me.
// 2: every message is kept, with one line per tool call (role "tool");
//    phone:messages pages through them. phone:thread is unchanged for API 1
//    phones and never returns tool rows.
// 3: presence (sync:setPresence from the runner) and each phone's
//    notification setting (phone:setNotifications): "away" phones only get
//    a push while Mike isn't at the Mac.
// 4: phone:registerDevice takes the phone's pushKey; a backend without its
//    own Apple key sends pushes through the push relay, encrypted with it.
// 5: project icons. phone:projects rows carry `icon` ({ symbol?, url?, by }),
//    the url a picture in file storage the runner uploads (sync:iconUploadUrl,
//    sync:setProjectIcon); a runner before 5 sends projects without icons.
// 6: sync:issueToken, sync:listTokens and sync:revokeToken, so the Mac app
//    pairs phones and signs browsers in through the runner (docs/protocol.md,
//    "Devices") with no Convex CLI; tokens carry a kind.
// 7: sharing (docs/website.md, "Sharing"). Thread rows carry `share`
//    ({ access, slug, people? }), and share:view, share:sendCode and
//    share:verifyCode serve /s/<slug> without a phone token. A runner sends
//    `share` only to a backend of 7 or later.
// 8: sharing is a public link or nothing (specific people and their email
//    codes are gone). `share.access` can be "off", so Mike's page keeps
//    its controls; phone:share queues a "share" command; and a shared
//    thread's pictures go to file storage (sync:addShareImage), shown by
//    share:view. A runner sends `share` only to a backend of 8 or later.
// 9: schedules can live here rather than in each runner's schedules.json
//    (step 6; docs/protocol.md, Schedules, "Runners"): sync:schedules,
//    sync:saveSchedule, sync:deleteSchedule, sync:adoptSchedules,
//    sync:claimSchedule, sync:releaseSchedule, sync:scheduleRan and
//    sync:requestScheduleRun. A runner moves its schedules here only from 9.
// 10: phone:quickAsk queues a "quickAsk" command: a quick ask the phone
//    answered itself, which the runner keeps as a thread with no turn run.
// 11: a runner's heartbeat can carry `icon`, an SF Symbol for its Mac
//    (sync.icon, or worked out from the model), and sync:runnersList
//    returns it. A runner sends it only to a backend of 11 or later.
// 12: Bruce's threads in the Mac app (step 6, part 2): the threadIndex
//    table (sync:setThreadIndex, sync:otherRunnersThreads), and a runner's
//    heartbeat can carry rpcUrl, how a Mac app reaches it. A runner writes
//    the index and sends rpcUrl only to a backend of 12 or later.
// 13: thread rows can carry `woke` ({ at, since? }): back from hibernating
//    by itself and not opened yet, for the phone's "Woke up". A runner
//    sends it only to a backend of 13 or later.
// 14: the phone sees end-of-turn cards: thread rows carry the open card's
//    `asks` and `asksSeq` and a finished turn's `next`, a message row can be
//    `summary` (end_turn's bullets, the turn's reply), and phone:send takes
//    `answers`. A runner sends them only to a backend of 14 or later.
// 15: thread rows can carry `needs`, `pendingReviews` and `waitingForRoom`,
//    so the phone sorts threads into the Mac's sections (Waiting: idle
//    threads a schedule will message). A runner sends them only to a
//    backend of 15 or later.
// 16: phone:search({ token, text }) finds archived threads by the words in
//    their title or last reply, past the newest 100 phone:threads gives the
//    den. Nothing changes for runners.
// 17: phone:counts says how many threads are hibernating and archived, so
//    the phone can fold those sections without loading them.
// 18: photos from the phone. phone:imageUploadUrl gives somewhere to put one,
//    phone:send and phone:create take `images` (storage ids), and the command's
//    args carry each with its URL for the runner, which fetches it;
//    sync:finishCommand deletes them. Nothing changes for an older runner
//    until a phone sends a photo, which it only does from 18.
// 19: the Pocket. phone:pocket and phone:removePocketCard for the phone,
//    sync:savePocketCard, sync:removePocketCard and sync:pocketCards for the
//    runner's `pocket` tool. Nothing else changes for older clients.
// 20: the phone's new thread pickers. Account rows carry `models` ({ id,
//    title, effortLevels?, defaultEffort? }) and `defaultEffort`, and
//    phone:create takes `effort`. A runner sends models only to a backend
//    of 20 or later; an older runner ignores an effort.
// 21: a Pocket card can have an `icon`; filing one again without keeps it.
// 22: thread rows can carry `startedBy` ({ kind, label, icon?, why? }): who
//    started it when Mike didn't, for the phone's byline. A runner sends it
//    only to a backend of 22 or later; an older phone ignores it.
// 23: threadIndex rows can carry `startedBy` too, so the Mac's sidebar shows
//    the byline on another runner's threads. A runner sends it only to a
//    backend of 23 or later.
// 24: pictures for the phone, from every thread. sync:replyImages and
//    sync:addReplyImage take the pictures in agents' replies and pinned
//    pictures, and phone:messages' `images` carries them (a pinned one with
//    `pinned`). Nothing changes for an older runner or phone, which just
//    doesn't have them.
// 25: phone:discardImage, for a photo the phone uploaded and never sent. A
//    phone only ever calls it on a best-effort basis, so on an older backend
//    the photo just stays in file storage, and an older phone never calls it.
// 26: a message row can carry `turn`, which turn it's from, and phone:messages
//    returns it, so the phone can tell a turn the CLI started itself from the
//    one before. A runner sends it only to a backend of 26 or later, and a
//    phone without it reads the rows as it always did.
// 27: stars. Thread and threadIndex rows can carry `starredAt`, a starred
//    thread that's hibernating stays in view "inbox", and phone:update takes
//    `star`. A runner sends them only to a backend of 27 or later; an older
//    phone doesn't show the section, and misses a thread that's both
//    starred and hibernating until it's updated.
// 28: thread rows can carry `links` ({ title, url, icon? }[]): the thread's
//    patch link buttons (url actions), which the phone shows and opens
//    itself. A runner sends them only to a backend of 28 or later; an older
//    phone ignores them.
// 29: watching only what changed. threadIndex rows carry `updatedMs` and a
//    gone thread's row stays a day as a `deleted` tombstone;
//    sync:otherRunnersList and sync:threadIndexSince let a runner watch the
//    other runners and only their rows changed since its last answer.
//    sync:otherRunnersThreads skips tombstones, so an older runner sees no
//    change.
// 30: fewer reads. sync:upsertProjects takes only the projects that changed
//    (and the ones gone), so a turn no longer rewrites every project; the
//    runner still sends the whole list with setProjects once after it
//    starts. phone:counts reads a viewCounts row per runner, kept by the
//    thread writes, rather than every hibernating and den thread. Nothing
//    changes for a phone or an older runner.
// 31: thread rows can carry `asked`, what Mike last said to the thread in
//    one line, which the phone shows under the title as "You: ...". A
//    runner sends it only to a backend of 31 or later; an older phone
//    ignores it and shows the thread's place as before.
// 32: threadIndex rows can carry `asked` too, so a Mac's sidebar shows
//    "You: ..." under another runner's threads. A runner sends it only to a
//    backend of 32 or later; an older app ignores it.
// 33: the first message row of a turn the agent started by itself, as a
//    sub-agent or background job finished, can carry `wokeBy` (what
//    finished), and phone:messages passes it on, so the phone marks the
//    wait as "6 min later · Mine the repo finished". A runner sends it
//    only to a backend of 33 or later; an older phone ignores it.
// 34: thread rows can carry `waitingForNetwork` ({ since }): its last turn
//    couldn't reach the API and it carries on by itself once the runner
//    can, so the phone's row says "Waiting for connection", not Failed. A
//    runner sends it only to a backend of 34 or later; an older phone
//    ignores it and shows Failed.
// 35: secrets (docs/protocol.md, "Secrets"). A thread row's
//    pendingApproval can be `kind: "secret"` with the card's label, reason
//    and the runner's public key; phone:secret queues the phone's sealed
//    answer (or a decline) as a respond command, and finishCommand drops
//    the sealed answer from the row. A runner sends a secret card only to a
//    backend of 35 or later; an older phone shows the thread waiting.
// 36: an owned schedule can carry `poolId`, the pool that picks the login
//    each of its threads starts on, instead of `accountId`. A runner sends
//    it only to a backend of 36 or later; an older runner ignores it and
//    starts the thread on its folder's pool.
// 37: less database I/O (docs/convex-backend.md, "Usage and the free plan").
//    sync:upsertAccounts writes only the logins that changed; sync:heartbeat
//    can say firstSeen, so a runner that remembers what it has written
//    between starts writes it again for a deployment that's never met it;
//    phone:threadRow is a thread's row without its messages, and phone:images
//    a thread's pictures, with phone:messages' noImages. A runner uses
//    upsertAccounts only with a backend of 37 or later and ignores firstSeen
//    from none; an older phone goes on using phone:thread.
// 38: pools shared between runners (docs/protocol.md, "Pools"): the
//    `pools` table, sync:pools, sync:savePools and sync:adoptPools. A runner
//    follows it only with a backend of 38 or later; before, each keeps its
//    own runner.json pools.
// 39: sync:sharedUsage, every runner's latest usage reading of each login
//    with an email, so a login signed in on several machines shows the
//    newest reading on each (docs/protocol.md, Accounts, "Shared
//    readings"). A runner subscribes only with a backend of 39 or later.
// 40: projectThreads, a row per thread per project kept by the thread
//    writes, and phone:projectThreads, a project's threads newest first,
//    archived ones included, so the website's project page can list all of
//    them. The backend links the threads it already has by itself
//    (sync:linkProjects); nothing changes on the runner.
// 41: runner keys (docs/protocol.md, "Runner keys"). Besides the owner
//    key (RUNNER_KEY), a key per runner (runnerKeys, sync:addRunnerKey),
//    which acts as that runnerId alone: its own heartbeat, threads,
//    messages, schedules, commands and Pocket cards, and none of the
//    owner-only functions (phone tokens, runner keys, other runners'
//    threads). The owner key does everything, as before. A runner's
//    heartbeat with the owner key marks its row byOwner, and a phone's new
//    thread goes to that runner first. Runner keys come only from a runner
//    of 41 or later (tb runner add); older runners just use the owner key.
//    A runner key's iconUploadUrl is a one-use /runner/upload URL that
//    answers as Convex's own does, so any runner's uploader works with it;
//    the owner's heartbeat can carry ownerKeyRotating, which older runners
//    ignore.
// 42: phone:update's archive takes a verdict ("worked", "didntWork" or
//    "notNeeded"), the pick from the done card's Archive menu, which the
//    runner keeps as the thread's archiveVerdict (docs/protocol.md, "Who
//    archived a thread"). A phone sends it only to a backend of 42 or
//    later; an older runner ignores it and just archives.
// 43: phone:threadsAt and phone:threadsSince, a list read once and then only
//    the rows written since. Thread rows carry updatedMs. An older phone goes
//    on using phone:threads, and an older runner's writes go through the same
//    upsertThreads, which stamps them.
// 44: other runners' threads through the backend (docs/protocol.md, "Other
//    runners' threads through the backend"): relay.ts, owner only, for the
//    main Mac's runner to read another runner's thread (remoteTail,
//    remoteMessages, remoteThread) and ask it to act (queueCommand,
//    commandState, remoteAccounts). Commands gain kinds `interrupt` and
//    `call` (allow-listed methods, answered in the command's `result`), and
//    a pending approval its event's `seq`. A runner older than 44 fails an
//    interrupt or a call as an unknown command, and its approvals have no
//    seq, so the main Mac's transcript has no card for them (the
//    thread still shows it needs you).
// 45: the website's rail (docs/website.md). scheduleWakes and phone:wakes, a
//    sidebar's small view of the schedules; runnerStats, phone:runnerStats,
//    phone:watchRunners, sync:runnerWatch and sync:setRunnerStats, a machine's
//    figures, written only while someone's looking; `pressure` on the
//    heartbeat; phone:schedule and a `schedule` command, for Pause and Run now.
//    A runner sends these only to a backend of 45 or later, and a runner from
//    before fails a schedule command with "unknown command".
// 46: sync:watchRunnersFromMac and sync:runnerStatsList, the Mac app's Runners
//    panel's figures through the main Mac's runner (runners.stats). Owner key
//    only.
// 47: the backend scrubs secrets from what a runner sends before storing it
//    (convex/redaction.ts), and sync:scrubStoredBatch rewrites stored rows
//    with today's rules. Nothing a client sends or reads changes shape; the
//    runner's `tb status` says the backend checks too from this version.
// 48: phone:projects reads projectHeads, a small row per project, and returns
//    goals, state, notes and folders empty; phone:project has one whole. No
//    iPhone app has ever read those four. sync:sharedUsage takes the caller's
//    runnerId and leaves its rows out of what it reads; an older runner sends
//    none and is told about everyone's, as before. sync:schedules reads only a
//    runner key's own rows. sync:schedulesSince is the table once and then only
//    the rows written since; an older runner goes on using sync:schedules.
// 49: a thread row can carry wakeNote, what a hibernating thread waits for when
//    it's more than a time ("\"Convex I/O\" finishes", "the runner updates"), for
//    the phone's and the website's rows. An older runner sends none.
// 50: a project's notes live in projectNotes, apart from its row, and
//    sync:upsertProjects takes a project without `notes` when they haven't
//    changed. A Convex write costs the whole document, and notes were most of
//    a project's, so each state update rewrote them. A runner sends `notes`
//    only to a backend of 50 or later; an older runner always sends them, as
//    before. phone:project still returns them whole.
// 51: an owned schedule can carry `check`, a shell command its runner runs
//    before each run (experiment scheduleChecks). An older runner sends none.
// 52: full sync (docs/full-convex.md step 4). eventBodies, sync:appendBodies,
//    sync:remoteBody and phone:eventBody: a tool's output, input and diffs under
//    the seq of its row, only from a runner with sync.full on. heldPictures,
//    phone:requestPicture, phone:heldPicture and a `picture` command: one tool
//    picture uploaded for a day when it's tapped. An older runner fails a picture
//    command as unknown, and an older phone never asks for any of it.
// 53: sync:sharedUsage goes by who wrote each reading. A runner key gets only
//    the owner key's readings, of the logins the owner has listed for its
//    runner (runnerLogins, sync:setRunnerLogins and sync:runnerLogins, owner
//    key only), with no runnerId, marked `byOwnerKey`; nobody gets a runner
//    key's readings, the owner included. A runner key's account readings are
//    stored read no later than now. sync:pools gives a runner key no member
//    named by another runner's id. An older runner takes the rows it's given
//    as before.
// 54: a runner key's archived threads stay in threadIndex (within its cap,
//    archived rows giving way first), so the main Mac's Archived list has
//    other machines' archived threads and can open and unarchive them
//    (docs/protocol.md, "Other runners' threads"). A runner sends the
//    archived rows an older backend dropped once, on first hearing 54.
// 55: an owned schedule can carry `checkTimeoutSecs`, how long its check may
//    take (60 s without). An older runner sends none.
// 56: runners have an order Mike sets on the phone (runnerOrder,
//    phone:setRunnerOrder). phone:runners lists them in it, and a new thread
//    or quick ask that names no runner goes to the first one online in it
//    before falling back to the main Mac as before. An older phone gets the
//    list in that order and still sends no runner.
// 57: phone:waiting, a thread's sends its runner hasn't applied yet, and
//    phone:cancel, which takes back one still pending. An older phone
//    never asks for either.
// 58: sync:runnerOrder and sync:setRunnerOrder, the main Mac's key only:
//    the same runner order the phone sets (API 56), for the Mac's Settings >
//    Runners. An older runner sends the Mac no order, and its Settings list
//    the runners as before.
// 59: reply buttons (docs/protocol.md, "Reply buttons"). A message row can
//    carry `buttons`, the state of the buttons its text links ([title](button:<id>)),
//    which the runner sends again when one is pressed (appendMessages patches
//    just them); phone:messages returns them, and phone:press queues a `press`
//    command with { buttonId }. An older runner sends none and fails a press
//    as unknown; an older phone shows the link as text.
// 60: sync:sharedThreads, the ids of a runner's rows shared by link, which a
//    runner checks against its own threads on every start and every hour,
//    removing ones it deleted and rewriting ones it stopped sharing. And a
//    runner key can't save a schedule under an id gone from another runner
//    within the day (scheduleGone). An older runner never asks, and does
//    as before.
export const API_VERSION = 60;
