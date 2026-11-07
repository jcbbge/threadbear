import AppKit
import BearDock
import Observation
import ThreadbearCore

// What the user does to threads: new, send, answer, edit, archive, snooze, move.
// Split out of AppModel.swift (4 Nov 2026) as a plain move.
extension AppModel {
    // MARK: Thread actions

    func newThread() {
        // Voice talks with the thread on screen: leaving it ends it.
        if VoiceMode.shared.isOn, VoiceMode.shared.threadId != VoiceMode.newThread { VoiceMode.shared.stop() }
        selection = nil
        openProjectId = nil
        showsProjectsHome = false
        showsLibrarianHome = false
        showsScheduledHome = false
        stopShowingSubagent()
        sidebarMode = .inbox
        focusComposer("new")
    }

    /// Collapses the thread's card of asks, or brings it back. The cursor
    /// goes to the composer, as a Something else box may have just gone.
    func toggleCardCollapsed(threadId: String, seq: Int) {
        collapsedCards[threadId] = collapsedCards[threadId] == seq ? nil : seq
        focusComposer(threadId)
    }

    /// The answers picked on the thread's open card (ask index to option
    /// index), none for a card he hasn't touched.
    func picks(for thread: ThreadSummary) -> [Int: Int] {
        guard Decisions.isOpen(thread, card: sessions[thread.id]?.openCard), let seq = thread.asksSeq, let mine = askPicks[thread.id], mine.asksSeq == seq else { return [:] }
        return mine.picks
    }

    /// What's written and pasted in the open card's Something else boxes,
    /// by ask. A box that's closed again keeps what was in it until the
    /// card is answered.
    func notes(for thread: ThreadSummary) -> [Int: AskNote] {
        guard Decisions.isOpen(thread, card: sessions[thread.id]?.openCard), let seq = thread.asksSeq, let mine = askPicks[thread.id], mine.asksSeq == seq else { return [:] }
        return mine.notes
    }

    /// Picks option `option` on ask `ask` of the open card, or unpicks it
    /// when it's already the pick. It waits in the composer as a chip and
    /// goes with whatever he sends next. Something else opens a box under
    /// the ask, which the transcript puts the cursor in, so the composer
    /// doesn't take it.
    func pickAnswer(thread: ThreadSummary, ask: Int, option: Int) {
        guard Decisions.isOpen(thread, card: sessions[thread.id]?.openCard), let seq = thread.asksSeq else { return }
        var picks = picks(for: thread)
        picks[ask] = picks[ask] == option ? nil : option
        setAnswers(picks: picks, notes: notes(for: thread), seq: seq, threadId: thread.id)
        if picks[ask] != Decisions.ownAnswer { focusComposer(thread.id) }
    }

    /// Mike wrote in an ask's Something else box.
    func setNote(thread: ThreadSummary, ask: Int, note: AskNote) {
        guard Decisions.isOpen(thread, card: sessions[thread.id]?.openCard), let seq = thread.asksSeq else { return }
        var notes = notes(for: thread)
        notes[ask] = note.text.isEmpty && note.images.isEmpty ? nil : note
        setAnswers(picks: picks(for: thread), notes: notes, seq: seq, threadId: thread.id)
    }

    /// Pictures pasted, dropped or chosen in an ask's Something else box,
    /// imported as the composer's are and added to that ask's answer.
    func addNoteImages(thread: ThreadSummary, ask: Int, urls: [URL]) {
        guard !urls.isEmpty else { return }
        // A picture this Mac's runner keeps would be a path another
        // runner hasn't got (as in the composer).
        if let name = runnerName(of: thread) {
            errorMessage = "Pictures can't go to \(name) from this Mac yet."
            return
        }
        let threadId = thread.id
        Task {
            let refs = await importImages(urls)
            guard !refs.isEmpty, let current = threads[threadId] else { return }
            let note = notes(for: current)[ask] ?? AskNote()
            // Each with its chip at the end of the box's words.
            var draft = Draft(text: note.text, images: note.images)
            draft.append(refs)
            setNote(thread: current, ask: ask, note: AskNote(text: draft.text, images: draft.images))
        }
    }

    private func setAnswers(picks: [Int: Int], notes: [Int: AskNote], seq: Int, threadId: String) {
        askPicks[threadId] = picks.isEmpty && notes.isEmpty ? nil : AskPicks(asksSeq: seq, picks: picks, notes: notes)
        sessions[threadId]?.setAskPicks(seq: seq, picks: picks)
        sessions[threadId]?.setAskNotes(seq: seq, notes: notes)
    }

    /// Ticks (or unticks) a follow-up on the done card. Ticked ones wait
    /// in the composer and go with whatever he sends next, so he can pick
    /// several and add his own words. They used to send on one click,
    /// which only ever got one of them and gave no chance to add anything
    /// (Mike, 30 Oct); ticking read as a to-do list back when the card
    /// said "Nothing needed from you", but it says Done now.
    func toggleFollowUp(threadId: String, card: AsksCard, index: Int) {
        guard card.isDone, card.isOpen, card.next.indices.contains(index) else { return }
        var picks = nextPicks[threadId].flatMap { $0.seq == card.seq ? $0 : nil } ?? NextPicks(seq: card.seq, picked: [])
        if picks.picked.remove(index) == nil { picks.picked.insert(index) }
        setNextPicks(picks, threadId: threadId)
    }

    /// The "?" on a done card's follow-up: turns on (or off) asking the
    /// agent what it meant, which goes with his next message like a tick.
    /// It used to send on its own at once, so he couldn't ask about two
    /// of them, or add a word (Mike, 1 Nov).
    func toggleExplain(threadId: String, card: AsksCard, index: Int) {
        guard card.isDone, card.isOpen, card.next.indices.contains(index) else { return }
        var picks = nextPicks[threadId].flatMap { $0.seq == card.seq ? $0 : nil } ?? NextPicks(seq: card.seq, picked: [])
        if picks.explain.remove(index) == nil { picks.explain.insert(index) }
        setNextPicks(picks, threadId: threadId)
    }

    private func setNextPicks(_ picks: NextPicks, threadId: String) {
        nextPicks[threadId] = picks.isEmpty ? nil : picks
        sessions[threadId]?.setNextPicks(seq: picks.seq, picks: picks.picked, explain: picks.explain)
        focusComposer(threadId)
    }

    /// The words of the follow-ups ticked, and of those asked about, on
    /// the thread's open done card, in the card's order.
    func pickedFollowUps(threadId: String) -> FollowUpPicks {
        guard case .asks(let card)? = sessions[threadId]?.openCard?.content, card.isDone, card.isOpen,
              let mine = nextPicks[threadId], mine.seq == card.seq else { return FollowUpPicks() }
        return FollowUpPicks(ticked: card.next.indices.filter { mine.picked.contains($0) }.map { card.next[$0] },
                             explain: card.next.indices.filter { mine.explain.contains($0) }.map { card.next[$0] })
    }

    /// Puts one of Mike's messages in the thread's composer to edit: sending
    /// it then replaces that message and carries on from there.
    func startEditing(threadId: String, seq: Int, text: String, images: [ImageRef]) {
        let before = editing[threadId]?.before ?? drafts[threadId] ?? Draft()
        editing[threadId] = MessageEdit(seq: seq, before: before)
        // Its [Picture N] markers back as chips where they were.
        let back = InlinePictures.draft(text: text, images: images)
        drafts[threadId] = Draft(text: back.text, images: back.images)
        focusComposer(threadId)
    }

    /// Leaves the edit: the box gets back what was in it before.
    func cancelEditing(threadId: String) {
        guard let edit = editing.removeValue(forKey: threadId) else { return }
        drafts[threadId] = edit.before.text.isEmpty && edit.before.images.isEmpty ? nil : edit.before
    }

    /// Sends the edited message. The box keeps it, marked as sending,
    /// until the runner has started the new turn; an error leaves it there
    /// to try again.
    private func sendEdit(threadId: String, edit: MessageEdit) {
        let draft = (drafts[threadId] ?? Draft()).normalized
        let text = draft.words()
        guard !text.isEmpty || !draft.images.isEmpty, !edit.sending else { return }
        guard let client = client(for: threadId), isRemote(threadId) || connection == .connected else {
            showConnectionError(notConnectedText(threadId, "the edit wasn't sent"))
            return
        }
        ActivityRecorder.shared.sent(threadId: threadId, images: draft.images.count, answers: 0, edit: true)
        editing[threadId]?.sending = true
        Task {
            var stopBackground = false
            while true {
                do {
                    try await client.editMessage(threadId: threadId, seq: edit.seq, text: text, images: draft.images, stopBackground: stopBackground)
                    editing[threadId] = nil
                    drafts[threadId] = edit.before.text.isEmpty && edit.before.images.isEmpty ? nil : edit.before
                } catch RPCError.server(RPCError.backgroundRunning, let message) where !stopBackground {
                    // Going back would stop work the agent left running
                    // (an upload was lost that way, 4 Nov), so ask first.
                    if Self.confirmStopBackground(message) {
                        stopBackground = true
                        continue
                    }
                    editing[threadId]?.sending = false
                } catch {
                    editing[threadId]?.sending = false
                    show(error)
                }
                return
            }
        }
    }

    /// Whether Mike wants the edit to go ahead and stop the thread's
    /// background work; `message` is the runner's, saying what's running.
    private static func confirmStopBackground(_ message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Stop the background work?"
        alert.informativeText = message + "\n\nCancel keeps it running; you can send your change as a new message instead."
        alert.addButton(withTitle: "Stop It and Go Back")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Sends the draft for `threadId` (or starts a new thread with the "new"
    /// draft), with any answers picked on the open card. In a thread the
    /// box empties straight away and the message shows at the end of the
    /// transcript, dimmed, until the runner shows it (a busy Mac can keep
    /// the runner from answering for many seconds); the text, images and
    /// picks go back if the runner doesn't take them. A new thread's
    /// draft stays in the box, greyed, with a spinner for Send, until the
    /// thread exists. While disconnected nothing is touched at all.
    func send(threadId: String?) {
        let key = threadId ?? "new"
        if let threadId, let edit = editing[threadId] {
            sendEdit(threadId: threadId, edit: edit)
            return
        }
        let stored = drafts[key] ?? Draft()
        let draft = stored.normalized
        // Answers picked on the open card go first, each question then its
        // answer, and his own words after them (Decisions.message).
        let thread = threadId.flatMap { threads[$0] }
        // self. so Swift 6.3 (Xcode 26) doesn't read picks as the variable being declared.
        let picks = thread.map { self.picks(for: $0) } ?? [:]
        let notes = thread.map { self.notes(for: $0) } ?? [:]
        let asks = thread?.asks ?? []
        let answers = Decisions.answers(asks: asks, picks: picks, notes: notes).map(\.answer)
        // Follow-ups ticked on a done card go first too (it has no asks,
        // so it's one or the other).
        let followUps = threadId.map { pickedFollowUps(threadId: $0) } ?? FollowUpPicks()
        let ticked = threadId.flatMap { nextPicks[$0] }
        // Pictures from the asks' boxes first, numbered as the answers say,
        // then the composer's, whose chips go as [Picture N] markers after
        // the boxes' numbers (docs/protocol.md, "Pictures in a message").
        let boxImages = Decisions.images(asks: asks, picks: picks, notes: notes)
        let words = draft.words(first: boxImages.count + 1)
        let trimmed = !followUps.isEmpty
            ? Decisions.followUpMessage(followUps.ticked, explain: followUps.explain, extra: words)
            : answers.isEmpty
            ? words
            : Decisions.message(asks: asks, picks: picks, notes: notes, extra: words)
        let images = boxImages + draft.images
        guard !trimmed.isEmpty || !images.isEmpty else { return }
        // A second Return while the first new thread is still being made.
        if threadId == nil, creatingThread { return }
        // A new thread on another runner goes over that runner's connection.
        if threadId == nil, let runnerId = newThreadRunnerId {
            return sendNewThread(on: runnerId, text: trimmed, draft: stored)
        }
        guard let client = client(for: threadId), threadId.map(isRemote) == true || connection == .connected else {
            showConnectionError(notConnectedText(threadId, "that wasn't sent"))
            return
        }
        ActivityRecorder.shared.sent(threadId: threadId, images: images.count, answers: answers.count)
        if let threadId {
            drafts[key] = nil
            let seq = thread?.asksSeq
            if let seq, !answers.isEmpty { setAnswers(picks: [:], notes: [:], seq: seq, threadId: threadId) }
            // The card keeps its ticks until his message closes it.
            if !followUps.isEmpty { nextPicks[threadId] = nil }
            post(threadId: threadId, text: trimmed, images: images, answers: answers, client: client) { [self] in
                restoreDraft(draft, key: key)
                if let seq, !answers.isEmpty { setAnswers(picks: picks, notes: notes, seq: seq, threadId: threadId) }
                if !followUps.isEmpty, nextPicks[threadId] == nil { nextPicks[threadId] = ticked }
            }
        } else {
            let account = newThreadAccountId
            let request = newThreadRequest(text: trimmed, images: draft.images)
            creatingThread = true
            Task {
                defer { creatingThread = false }
                do {
                    let thread = try await client.createThread(request)
                    // Only what was sent goes; the box was locked meanwhile.
                    if drafts[key] == stored { drafts[key] = nil }
                    // In a pool the runner picked the login; that's the one
                    // that counts as used.
                    rememberLastAccount(request.poolId == nil ? account : thread.accountId)
                    // The folder, "Ask before edits" and a picked account
                    // or pool were for this thread; the next one starts
                    // from the defaults again, on whichever account then
                    // has the most room. The model and effort stick.
                    newThreadCwd = nil
                    newThreadPermission = .full
                    newThreadAccount = nil
                    newThreadPool = nil
                    newThreadProvider = nil
                    threads[thread.id] = thread
                    select(thread.id)
                    // "This Mac" was for this thread; the next starts on
                    // the default runner again.
                    newThreadRunnerPicked = false
                    applyDefaultRunner()
                } catch {
                    // The draft never left the box.
                    show(error)
                }
            }
        }
    }

    /// What Mike said in Voice mode, sent as his message without touching
    /// whatever is typed in the composer (VoiceMode).
    func sendSpoken(threadId: String, text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard let client = client(for: threadId), isRemote(threadId) || connection == .connected else {
            showConnectionError(notConnectedText(threadId, "that wasn't sent"))
            return
        }
        ActivityRecorder.shared.sent(threadId: threadId, images: 0, answers: 0)
        post(threadId: threadId, text: text, images: [], answers: [], client: client)
    }

    /// Starts a new thread with what Mike said in Voice on the new-thread
    /// composer, with its folder, login and model as the composer has
    /// them. `then` gets its id before it's selected (so Voice carries on
    /// in it), or nil if it couldn't be made.
    func startThreadSpoken(_ text: String, then: @escaping (String?) -> Void) {
        guard let client, connection == .connected, !creatingThread else { then(nil); return }
        let account = newThreadAccountId
        let request = newThreadRequest(text: text, images: [])
        creatingThread = true
        Task {
            defer { creatingThread = false }
            do {
                let thread = try await client.createThread(request)
                // What the new-thread composer's picks were for, as for a
                // typed first message (send): the next one starts afresh.
                rememberLastAccount(request.poolId == nil ? account : thread.accountId)
                newThreadCwd = nil
                newThreadPermission = .full
                newThreadAccount = nil
                newThreadPool = nil
                newThreadProvider = nil
                threads[thread.id] = thread
                then(thread.id)
                select(thread.id)
            } catch {
                then(nil)
                show(error)
            }
        }
    }

    /// Sends a message to a thread, shown dimmed at the end of the
    /// transcript until the runner shows it. `failed` puts back whatever
    /// the send took from the composer, if the runner doesn't take it.
    private func post(threadId: String, text: String, images: [ImageRef], answers: [AskAnswer], client: RPCClient, failed: @escaping () -> Void = {}) {
        let pendingId = UUID().uuidString
        // The thread's own session, open already as its composer is
        // showing; kept by the Task, so a failure finds it.
        let session: ThreadSession? = self.session(for: threadId)
        session?.addPending(id: pendingId, text: text, images: images, answers: answers, summarySeq: threads[threadId]?.lastSeq ?? 0)
        Task {
            do {
                // Sent in the moment a restarting runner lets go of its idle
                // threads, before the new one is up, the old one turns it
                // away (Mike saw "Thread not found", 5 Nov). It goes again,
                // still showing as on its way through the dropped
                // connection, once the new runner is connected.
                _ = try await inRestartOrder(threadId, sentOn: client, waiting: { session?.holdForResend(pendingId) }) { client in
                    try await client.send(threadId: threadId, text: text, images: images, answers: answers)
                }
                // Taken but not shown: it's queued behind the running
                // turn. Its user.message usually comes just before this
                // reply, but is applied on the next frame, so wait a
                // moment rather than flash the clock on every send.
                try? await Task.sleep(for: .milliseconds(600))
                session?.markQueued(pendingId)
                checkQueued(threadId)
            } catch {
                session?.removePending(pendingId)
                failed()
                show(error)
            }
        }
    }

    /// How long a send bounced by a restart waits for the new runner.
    /// A var only so tests can make it short.
    static var restartResendWait: Duration = .seconds(30)

    /// A send (or `threads.update`) the restarting runner refused before
    /// taking it, so sending again can't make two: "Thread not found" from
    /// a runner older than 7 Nov once it has let the idle thread go, or its
    /// handing-over refusal (runner.ts `send` and `mustGet`, whose words
    /// these are). Not a dropped
    /// connection, which might have taken the message first.
    static func turnedAwayByRestart(_ error: Error) -> Bool {
        switch error {
        case RPCError.server(RPCError.threadNotFound, _): return true
        case RPCError.server(RPCError.busy, let message): return message.hasPrefix("The runner is handing over to a new one")
        default: return false
        }
    }

    /// Sends `request` for a local thread. One a restarting runner turns
    /// away goes again on the new runner once it's connected, and while any
    /// is waiting there, later ones go behind it instead of straight out, so
    /// everything lands in the order Mike made it: a pick made once the new
    /// runner is up can't be undone by an older one going again after it,
    /// and a message can't start its turn before the model he picked first
    /// (Codex's review, 7 Nov). `waiting` runs if it has to wait.
    func inRestartOrder<T: Sendable>(_ threadId: String, sentOn client: RPCClient, waiting: () -> Void = {},
                                     _ request: @escaping @MainActor (RPCClient) async throws -> T) async throws -> T {
        if isRemote(threadId) { return try await request(client) }
        if restartQueued > 0 {
            waiting()
            return try await behindRestart {
                // The connection by the time its turn comes. The one ahead
                // may have given up waiting while the old runner still
                // answers, so this one gets its own wait.
                var now = self.client
                if now == nil { now = await self.clientAfterRestart(sentOn: client) }
                guard let now else { throw RPCError.disconnected(nil) }
                do {
                    return try await request(now)
                } catch {
                    return try await self.againAfterRestart(threadId, error, sentOn: now, request)
                }
            }
        }
        do {
            return try await request(client)
        } catch {
            guard Self.turnedAwayByRestart(error), restart.isPending || restart.isRestarting(now: Date()) else { throw error }
            waiting()
            return try await behindRestart { try await self.againAfterRestart(threadId, error, sentOn: client, request) }
        }
    }

    /// `request` once more on the new runner, if `error` is a restart's
    /// refusal and the new runner connects within `restartResendWait`;
    /// otherwise `error`. Inside the queue's step, never through it again,
    /// which would wait on itself.
    private func againAfterRestart<T: Sendable>(_ threadId: String, _ error: Error, sentOn client: RPCClient,
                                                _ request: @MainActor (RPCClient) async throws -> T) async throws -> T {
        guard Self.turnedAwayByRestart(error), restart.isPending || restart.isRestarting(now: Date()),
              let next = await clientAfterRestart(sentOn: client) else { throw error }
        AppLog.write("rpc", "sending again after the restart: \(threadId)")
        return try await request(next)
    }

    /// Runs `step` once everything already in `restartQueue` has gone.
    private func behindRestart<T: Sendable>(_ step: @escaping @MainActor () async throws -> T) async throws -> T {
        let earlier = restartQueue
        restartQueued += 1
        let task = Task { @MainActor in
            defer { self.restartQueued -= 1 }
            await earlier?.value
            return try await step()
        }
        restartQueue = Task { _ = try? await task.value }
        return try await task.value
    }

    /// The new runner's client once it's connected, or nil if there's none
    /// within `restartResendWait`.
    func clientAfterRestart(sentOn old: RPCClient) async -> RPCClient? {
        let deadline = ContinuousClock.now + Self.restartResendWait
        while ContinuousClock.now < deadline {
            if connection == .connected, let client, client !== old { return client }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return nil
    }

    /// Updates panel, From Mike: a new thread in the repo the runner
    /// follows that merges Mike's release in (docs/bringing-in-updates.md),
    /// on the composer's account or pool and model.
    /// Bring Them In, or with `discuss` Let's Discuss: a thread in the
    /// checkout about Mike's newest release, that merges it, or talks it
    /// through first and changes nothing until he says.
    func bringInUpstream(_ upstream: RunnerUpdates.Upstream, discuss: Bool = false) {
        guard let client, let release = upstream.release, !creatingThread else { return }
        var request = newThreadRequest(text: discuss ? UpdatesText.discussPrompt(release) : UpdatesText.bringInPrompt(release), images: [])
        request.cwd = upstream.checkout ?? AppUpdater.shared.running?.checkout ?? request.cwd
        request.permissionMode = .full
        request.title = (discuss ? "Discuss" : "Bring in") + " Mike's release \(UpdatesText.releaseDate(release.tag))"
        creatingThread = true
        Task {
            defer { creatingThread = false }
            do {
                let thread = try await client.createThread(request)
                threads[thread.id] = thread
                select(thread.id)
            } catch {
                show(error)
            }
        }
    }

    /// A queued message starts its own turn once the thread is free, so
    /// one still queued after the thread has sat idle a while was lost on
    /// the way (a disconnect clears them anyway): it goes rather than stay
    /// at the end of the transcript for good.
    func checkQueued(_ threadId: String) {
        guard threads[threadId]?.status.isBusy == false, sessions[threadId]?.hasQueued == true,
              queuedChecks.insert(threadId).inserted else { return }
        Task {
            try? await Task.sleep(for: .seconds(Self.queuedGrace))
            queuedChecks.remove(threadId)
            if threads[threadId]?.status.isBusy == false { sessions[threadId]?.dropQueued() }
        }
    }

    /// Puts an unsent draft back, keeping anything typed since.
    private func restoreDraft(_ draft: Draft, key: String) {
        let current = drafts[key] ?? Draft()
        var restored = draft
        if !current.text.isEmpty {
            restored.text = draft.text.isEmpty ? current.text : draft.text + "\n\n" + current.text
        }
        restored.images += current.images
        drafts[key] = restored
    }

    /// Stops a thread's turn (the open one unless it's told which: a panel's
    /// composer can show another). The turn ends a moment after the runner
    /// takes the stop, so the button keeps its spinner until the thread stops
    /// being busy. `interruptWait` is a little past the runner's own limit
    /// (INTERRUPT_GRACE_MS), and only then can it be pressed again.
    func interrupt(_ threadId: String? = nil) {
        guard let threadId = threadId ?? selection else { return }
        guard let client = client(for: threadId) else {
            let runner = threads[threadId].flatMap { runnerName(of: $0) } ?? "the runner"
            return showConnectionError("Not connected to \(runner), so it wasn't stopped.")
        }
        whileBusy(BusyKey.stop(threadId)) { [self] in
            do {
                try await client.interrupt(threadId: threadId)
                let deadline = ContinuousClock.now + Self.interruptWait
                while threads[threadId]?.status.isBusy == true, ContinuousClock.now < deadline {
                    try? await Task.sleep(for: .milliseconds(100))
                }
            } catch {
                show(error)
            }
        }
    }

    /// A var only so tests can make it short.
    static var interruptWait: Duration = .seconds(12)

    /// Changes a thread on the runner. What can safely be guessed (archived,
    /// snoozed, permission, model, effort) shows at once
    /// (`ThreadUpdate.applied`), so the click does something however slow
    /// the runner is; its reply replaces the guess, and a failure puts back
    /// what was there unless something else has changed it since. What
    /// can't be guessed (a folder, login or pool) has the composer's chip
    /// spin until the reply (`BusyKey.moving`).
    func update(_ threadId: String, _ update: ThreadUpdate) {
        guard isRemote(threadId) || client != nil else { return }
        let before = threads[threadId]
        let guess = before.map { update.applied(to: $0) }
        if let guess, guess != before { threads[threadId] = guess }
        let moving = update.cwd != nil ? BusyKey.movingFolder(threadId)
            : update.accountId != nil || update.poolId != nil ? BusyKey.moving(threadId) : nil
        if let moving { beginBusy(moving) }
        Task {
            defer { if let moving { endBusy(moving) } }
            do {
                // Made as a restarting runner lets go of its idle threads,
                // as a send can be: Mike saw "Thread not found" picking an
                // effort (7 Nov). It goes again on the new runner, still
                // showing.
                let client = try await rowClient(for: threadId)
                threads[threadId] = try await inRestartOrder(threadId, sentOn: client) { client in
                    try await client.updateThread(threadId, update)
                }
            } catch {
                if let before, let guess, threads[threadId] == guess { threads[threadId] = before }
                show(error)
            }
        }
    }

    /// Whether anyone with the link can read a thread on the website
    /// (protocol "Sharing"). The share popover shows a failure itself, so
    /// this throws rather than putting up the banner.
    func share(_ threadId: String, access: ThreadShare.Access, newLink: Bool = false) async throws {
        guard let client = client(for: threadId) else { throw RPCError.disconnected(nil) }
        threads[threadId] = try await client.share(threadId: threadId, access: access, newLink: newLink)
    }

    /// A shared thread's link on the website, while sync is on.
    func shareLink(_ share: ThreadShare) -> URL? {
        websiteURL?.appendingPathComponent("s").appendingPathComponent(share.slug)
    }

    /// A thread's own link on the website, while sync is on. It needs a
    /// signed-in browser, unlike `shareLink`.
    func threadWebLink(_ threadId: String) -> URL? {
        websiteURL?.appendingPathComponent("t").appendingPathComponent(threadId)
    }

    /// Opens the thread if it isn't, and makes its title in the header a field.
    func startRenaming(_ threadId: String? = nil) {
        guard let threadId = threadId ?? selection, threads[threadId] != nil else { return }
        if selection != threadId { select(threadId) }
        renamingThread = threadId
    }

    /// Mike's own name for a thread, from the header. The runner keeps it:
    /// no model title or agent replaces it unless he asks (protocol
    /// `threads.update`, `titleBy`). Shown at once, put back if it fails.
    func rename(_ threadId: String, to title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client = client(for: threadId), let before = threads[threadId], !title.isEmpty, title != before.title else { return }
        threads[threadId]?.title = title
        Task {
            do {
                threads[threadId] = try await client.updateThread(threadId, ThreadUpdate(title: title))
            } catch {
                if threads[threadId]?.title == title { threads[threadId]?.title = before.title }
                show(error)
            }
        }
    }

    /// Stars it, or takes the star off (the Starred section above the Inbox).
    func setStarred(_ threadId: String, _ starred: Bool) {
        update(threadId, ThreadUpdate(starred: starred))
    }

    /// Archive (Mike calls it settling): leaves the inbox, stops its CLI.
    /// Its row slides off first, as a swiped one does;
    /// `slid` is a swipe that's already done that.
    func archive(_ threadId: String? = nil, slid: Bool = false) {
        guard let threadId = threadId ?? selection else { return }
        let next = neighbour(of: threadId)
        if let thread = threads[threadId] {
            archivedNote = ArchivedNote(threadId: threadId, title: thread.title, wasOpen: selection == threadId)
            inboxEndNote = nil
            milestoneNote = nil
        }
        if selection == threadId {
            // The last thread left: the inbox is clear, and the pane goes
            // to the new thread page.
            let sections = sections
            let clears = next == nil && ![sections.inbox, sections.running, sections.needsYou].joined().contains { $0.id != threadId }
            if clears { inboxZeroBear = .due }
            flyToArchive(threadId)
            if clears, !flyingToArchive.contains(threadId) { inboxZeroBear = .shown }
            select(next)
        }
        if slid { return update(threadId, ThreadUpdate(archived: true)) }
        guard !slidingOff.contains(threadId) else { return }
        slideOff(threadId)
        archivesNotSent.insert(threadId)
        Task {
            try? await Task.sleep(for: Self.slideTime)
            // Undone while the row was still on its way: it never leaves.
            guard archivesNotSent.remove(threadId) != nil else { return }
            do {
                let client = try await rowClient(for: threadId)
                threads[threadId] = try await inRestartOrder(threadId, sentOn: client) { client in
                    try await client.updateThread(threadId, ThreadUpdate(archived: true))
                }
                await endSlide(threadId)
            } catch {
                // Still in the inbox: bring the row back.
                slidingOff.remove(threadId)
                if archivedNote?.threadId == threadId { archivedNote = nil }
                show(error)
            }
        }
    }

    /// The archived note's Undo: back in the inbox, and open again if it
    /// was the one open when it went.
    func undoArchive() {
        guard let note = archivedNote else { return }
        archivedNote = nil
        if archivesNotSent.remove(note.threadId) != nil {
            slidingOff.remove(note.threadId)
        } else {
            unarchive(note.threadId)
        }
        if note.wasOpen {
            sidebarMode = .inbox
            select(note.threadId)
        }
    }

    /// A click on the archived note: opens the thread where it now is, in
    /// the Archived section.
    func openArchivedNote() {
        guard let note = archivedNote else { return }
        archivedNote = nil
        openThread(note.threadId)
    }

    /// Takes the note down, unless a newer archive has replaced it.
    func dismissArchivedNote(_ id: UUID) {
        if archivedNote?.id == id { archivedNote = nil }
    }

    /// The open thread's panel drops into the Archived heading while the
    /// next thread fades in under it (`ArchiveFlight`). Only when it's the
    /// transcript being shown: not a sub-agent's, a project's page or a
    /// thread open in a panel of its own.
    private func flyToArchive(_ threadId: String) {
        guard transcript.session?.threadId == threadId, transcript.session?.subagentId == nil else { return }
        noteFlightLeaving(threadId)
        let started = ArchiveFlight.launch(from: transcript.scrollView) { [weak self] in
            self?.flyingToArchive.remove(threadId)
            self?.leavingTheInbox.remove(threadId)
            self?.archiveLandings &+= 1
            if self?.inboxZeroBear == .due { self?.inboxZeroBear = .shown }
        }
        if started { flyingToArchive.insert(threadId) } else { leavingTheInbox.remove(threadId) }
    }

    /// The open thread's panel sinks into the Hibernating heading's moon
    /// while the next thread fades in under it (`ArchiveFlight`). Call it
    /// before the thread changes and the next one opens, as it pictures the
    /// transcript as it is. A row hibernated without being open just leaves,
    /// but the moon still stirs, so the eye knows where it went. A starred
    /// thread stays in Starred however long it sleeps, so it has nowhere to
    /// fly to: the panel changes over as it always did.
    private func tuckIn(_ threadId: String) {
        guard let thread = threads[threadId], !thread.isStarred, !thread.isArchived else { return }
        let showing = selection == threadId && transcript.session?.threadId == threadId && transcript.session?.subagentId == nil
        // Asked before it goes. A thread already asleep (hibernated again, or
        // waiting on a schedule) counts: its heading is there and stays.
        let headingThere = !flyingToHibernate.isEmpty || !sections.hibernating.isEmpty
        if showing { noteFlightLeaving(threadId) }
        let started = showing && ArchiveFlight.launch(from: transcript.scrollView, to: .hibernate, headingThere: headingThere) { [weak self] in
            self?.flyingToHibernate.remove(threadId)
            self?.leavingTheInbox.remove(threadId)
            self?.moonStirs()
        }
        if started { flyingToHibernate.insert(threadId) } else { leavingTheInbox.remove(threadId); moonStirs() }
    }

    private func moonStirs() {
        if !Juice.reduceMotion { hibernateLandings &+= 1 }
    }

    /// As long as a swiped row takes to leave (`RowSwipeController`).
    static var slideTime: Duration { .milliseconds(Juice.reduceMotion ? 100 : 160) }

    /// The row animates it (`ThreadRowView`).
    func slideOff(_ threadId: String) {
        slidingOff.insert(threadId)
    }

    /// The row's normally gone by now. If it's still drawn (a list that
    /// keeps archived threads), it springs back into place.
    func endSlide(_ threadId: String) async {
        try? await Task.sleep(for: .milliseconds(600))
        slidingOff.remove(threadId)
    }

    /// ⌘E: archives the open thread, or brings it back if it's archived.
    func toggleArchive() {
        guard let thread = selectedThread else { return }
        if thread.isArchived { unarchive(thread.id) } else { archive(thread.id) }
    }

    func unarchive(_ threadId: String) {
        update(threadId, ThreadUpdate(archived: false))
    }

    func snooze(_ threadId: String? = nil, until date: Date) {
        guard let threadId = threadId ?? selection else { return }
        let next = neighbour(of: threadId)
        tuckIn(threadId)
        update(threadId, ThreadUpdate(snoozedUntil: .some(date)))
        if selection == threadId { select(next) }
    }

    /// Hibernate until when Mike said, in his words. The runner puts it
    /// away straight off (its row says Thinking… until the time is worked
    /// out); if the model can't say, it comes back and the banner says why.
    /// The row goes at once, and comes back if the runner refuses.
    func hibernateWhen(_ threadId: String, said: String) {
        guard isRemote(threadId) || client != nil else { return }
        let next = neighbour(of: threadId)
        let before = threads[threadId]
        let guess = before?.hibernating(said: said)
        tuckIn(threadId)
        if let guess { threads[threadId] = guess }
        if selection == threadId { select(next) }
        Task {
            do {
                let client = try await rowClient(for: threadId)
                threads[threadId] = try await client.hibernateWhen(threadId: threadId, said: said)
            } catch {
                if let before, threads[threadId] == guess { threads[threadId] = before }
                show(error)
            }
        }
    }

    /// Hibernate until the runner next starts. Offered while a restart is
    /// waiting for threads: one that's holding it up can go away now (its
    /// turn stops, so the restart can go ahead) and come back after.
    func snoozeUntilRestart(_ threadId: String? = nil) {
        guard let threadId = threadId ?? selection else { return }
        let next = neighbour(of: threadId)
        tuckIn(threadId)
        update(threadId, ThreadUpdate(snoozeUntilRestart: true))
        if selection == threadId { select(next) }
    }

    /// A runner restart is waiting for threads to finish.
    var restartPending: Bool {
        if case .pending = restart.phase { return true }
        return false
    }

    func unsnooze(_ threadId: String) {
        update(threadId, ThreadUpdate(snoozedUntil: .some(nil)))
    }

    func setPermission(_ threadId: String, _ mode: PermissionMode) {
        update(threadId, ThreadUpdate(permissionMode: mode))
    }

    /// A model or effort picked on a thread is also what the next new
    /// thread starts on: the picker has no default row, it remembers.
    func setModel(_ threadId: String, _ model: String?) {
        remember(model: model, provider: threads[threadId]?.provider ?? "claude")
        update(threadId, ThreadUpdate(model: .some(model)))
    }

    func setEffort(_ threadId: String, _ effort: String?) {
        remember(effort: effort, provider: threads[threadId]?.provider ?? "claude")
        update(threadId, ThreadUpdate(effort: .some(effort)))
    }

    /// Keeps a last-picked value across launches; nil (the default) clears it.
    static func remember(_ value: String?, forKey key: String) {
        if let value, !value.isEmpty { UserDefaults.standard.set(value, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    func account(_ id: String) -> Account? {
        accounts.first { $0.id == id }
    }

    func setAccount(_ threadId: String, _ accountId: String) {
        rememberLastAccount(accountId)
        update(threadId, ThreadUpdate(accountId: accountId))
    }

    /// A model picked from another provider's column: the account and the
    /// model in one `threads.update`, so they can't arrive in the wrong
    /// order (two calls from two tasks could, and the pick was lost), and
    /// the model remembered under the provider it was picked from, not the
    /// one the thread was on. The provider's remembered effort goes too,
    /// since the runner resets effort on a provider change.
    func moveThread(_ threadId: String, toAccount accountId: String, model: String?) {
        let provider = provider(ofAccount: accountId)
        rememberLastAccount(accountId)
        remember(model: model, provider: provider)
        var change = ThreadUpdate(accountId: accountId, model: .some(model))
        if let effort = lastEfforts[provider] { change.effort = .some(effort) }
        update(threadId, change)
    }

    /// The last account used, overall (what `pickAccount` starts from) and
    /// per provider (which account another provider's column moves to).
    func rememberLastAccount(_ accountId: String) {
        UserDefaults.standard.set(accountId, forKey: Self.lastAccountKey)
        UserDefaults.standard.set(accountId, forKey: Self.memoryKey(Self.lastAccountKey, provider: provider(ofAccount: accountId)) + ".byProvider")
    }

    func lastAccountId(provider: String) -> String? {
        UserDefaults.standard.string(forKey: Self.memoryKey(Self.lastAccountKey, provider: provider) + ".byProvider")
    }

    /// The account a pick in a provider's column moves to: that provider's
    /// account with the most room (`pickAccount` over its accounts alone,
    /// from the last one used there), never a noted, blocked or nearly
    /// empty one while a better one exists; the provider's first account
    /// when nothing is known.
    func accountForProvider(_ provider: String) -> String? {
        let own = accounts.filter { $0.provider == provider }
        return AccountUsageText.pickAccount(own, lastUsedId: lastAccountId(provider: provider)) ?? own.first?.id
    }

    func noteFailedAccounts(from old: [String: ThreadSummary]) {
        for (id, thread) in threads {
            let before = old[id]
            if thread.status == .error {
                if before?.status != .error || failedOnAccount[id] == nil { failedOnAccount[id] = thread.accountId }
            } else if failedOnAccount[id] != nil {
                failedOnAccount[id] = nil
            }
        }
        for id in failedOnAccount.keys where threads[id] == nil { failedOnAccount[id] = nil }
    }

    func setCwd(_ threadId: String, _ cwd: String) {
        update(threadId, ThreadUpdate(cwd: cwd))
    }

    /// The thread below (or above) in the inbox, to select after archiving.
    private func neighbour(of threadId: String) -> String? {
        let ordered = sections.all.map(\.id)
        guard let index = ordered.firstIndex(of: threadId) else { return nil }
        if index + 1 < ordered.count { return ordered[index + 1] }
        return index > 0 ? ordered[index - 1] : nil
    }

    /// The inbox with its Archived section unfolded.
    func showArchive() {
        sidebarMode = .inbox
        collapsedSections.remove(.archived)
        loadArchive()
    }

    /// The inbox with its Hibernating section unfolded.
    func showHibernating() {
        sidebarMode = .inbox
        collapsedSections.remove(.hibernating)
    }

    /// Refreshes the archived threads (the first list already has them).
    func loadArchive() {
        guard let client else { return }
        Task {
            if let list = try? await client.listThreads(include: [.archived]) {
                for thread in list { threads[thread.id] = thread }
            }
        }
    }

    /// Images pasted or dropped somewhere other than the composer (a
    /// decision's box) go into the thread's draft, so they show in the
    /// composer's strip and go with the next send.
    func attachImages(_ urls: [URL], toDraft key: String) {
        guard !urls.isEmpty else { return }
        Task {
            let refs = await importImages(urls)
            drafts[key, default: Draft()].append(refs)
        }
    }

    func importImages(_ urls: [URL]) async -> [ImageRef] {
        guard let client else { return [] }
        var refs: [ImageRef] = []
        for url in urls {
            do {
                refs.append(try await client.importMedia(path: url.path))
            } catch {
                show(error)
            }
        }
        return refs
    }

    /// A reply button's pill was clicked (docs/protocol.md, "Reply
    /// buttons"). Not pressed yet: presses it, dimmed with "…" until the
    /// runner answers, and a second click meanwhile does nothing. Pressed:
    /// opens the thread it started or messaged rather than pressing again.
    func pressReplyButton(_ id: String, from threadId: String?) {
        let store = ReplyButtons.shared
        guard let known = store.known(id) else { return }
        // Only from the transcript of the thread that made it (TextKit's
        // transcriptThreadId): ids are the runner's per thread, and a link
        // copied into another thread's reply mustn't press this one.
        guard known.threadId == threadId else {
            NSSound.beep()
            errorMessage = "That button belongs to another thread, so it can't be pressed from here."
            return
        }
        if let pressed = known.button.pressed {
            if threads[pressed.threadId] != nil {
                openThread(pressed.threadId)
            } else {
                NSSound.beep()
                errorMessage = "The thread that button \(known.button.send != nil ? "messaged" : "started") isn't in your sidebar, so it can't open here. It was deleted, or it's archived on another machine."
            }
            return
        }
        guard let client = client(for: known.threadId) else {
            errorMessage = "Can't reach that thread's runner, so the button can't be pressed yet."
            return
        }
        guard store.setPressing(id, true) else { return }
        AppLog.write("buttons", "press \(id) in \(known.threadId)")
        Task {
            do {
                let button = try await client.pressReplyButton(threadId: known.threadId, buttonId: id)
                store.receive(button, threadId: known.threadId)
            } catch {
                show(error)
            }
            store.setPressing(id, false)
        }
    }

    func show(_ error: Error) {
        AppLog.write("rpc", "error: \(error.localizedDescription)")
        // Its description alone doesn't say which Mac it means.
        if let unreachable = error as? RemoteUnreachable {
            errorMessage = unreachable.headline + " " + unreachable.detail
            return
        }
        switch error as? RPCError {
        case .disconnected?, .timeout?, .connectFailed?:
            showConnectionError(error.localizedDescription)
        default:
            errorMessage = error.localizedDescription
        }
    }

    func showConnectionError(_ message: String) {
        errorMessage = message
        connectionErrorMessage = message
    }

    /// A banner about being disconnected is out of date once connected again.
    func clearConnectionError() {
        if let stale = connectionErrorMessage, errorMessage == stale { errorMessage = nil }
        connectionErrorMessage = nil
    }
}
