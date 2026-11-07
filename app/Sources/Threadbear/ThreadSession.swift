import AppKit
import Observation
import ThreadbearCore
import os

let perfLog = OSSignposter(subsystem: "com.mikerosoft.threadbear", category: "perf")

/// One open thread: its loaded events and rows, the subscription that keeps
/// them live, and the slice of rows the table shows (the newest ~200 at
/// first, growing as you scroll up).
@MainActor
@Observable
final class ThreadSession {
    enum LoadState: Equatable {
        case idle, loading, loaded
        case failed(String)
    }

    nonisolated static let initialRows = 200
    nonisolated static let pageRows = 200
    nonisolated static let eventsPage = 500

    let threadId: String
    /// Mike opened this thread with it still saying "Woke up", so the bear on
    /// its newest wake note plays its waking up, the first time it's shown.
    @ObservationIgnored var wakeUpPending = false
    /// Set for a sub-agent's transcript: read-only, read whole from
    /// `threads.subagent` (again for more while it runs), never subscribed.
    let subagentId: String?
    private(set) var state: LoadState = .idle
    /// What the failure says first, in place of "Couldn't load this
    /// thread.": "Can't reach bruce from this Mac." for another runner's
    /// thread that couldn't be opened (`RemoteUnreachable`).
    private(set) var failureHeadline: String?
    /// The runner has no record of the sub-agent (-32006), so there's
    /// nothing to show rather than something that failed.
    private(set) var missing = false
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private(set) var feed = ThreadFeed() {
        didSet { syncOpenCard() }
    }
    /// First model row the table shows.
    @ObservationIgnored private(set) var displayStart = 0
    @ObservationIgnored var expanded = Set<String>()
    @ObservationIgnored var scrollMemory: ScrollMemory?
    @ObservationIgnored weak var view: TranscriptController?
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored var lastUsed = Date()
    @ObservationIgnored private var flushScheduled = false
    @ObservationIgnored private var lastFlush: CFTimeInterval = 0
    @ObservationIgnored private var loadingOlder = false
    /// Where to page back from after an older page came back with nothing
    /// usable: the runner pages by seq range and skips corrupt lines, so a
    /// whole page of them is empty, though older events may lie beyond it.
    /// Asking from the first loaded seq again would get the same empty page,
    /// and since paging starts by itself on a short first page
    /// (`loadOlderIfNearTop` after a reload), it would ask forever. Only
    /// counts while the model still starts at `firstSeq`; a new model
    /// (reopened, trimmed) pages from its own start.
    @ObservationIgnored private var olderSkip: (firstSeq: Int, before: Int)?
    /// Older-page fetches that failed in a row, for a few retries: a short
    /// first page can't scroll, so nothing else would ask again.
    @ObservationIgnored private var olderFailures = 0
    @ObservationIgnored private var rebuilding = false
    @ObservationIgnored private(set) var subscribed = false
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    /// Perf counters.
    @ObservationIgnored var flushCount = 0
    @ObservationIgnored var flushTime: CFTimeInterval = 0
    @ObservationIgnored var olderFetchMs: [Double] = []
    @ObservationIgnored var olderMergeMs: [Double] = []
    @ObservationIgnored var onLoaded: (() -> Void)?
    /// Messages sent from this thread's composer that the runner hasn't
    /// shown yet (`PendingMessage`), kept here so they outlive the model
    /// being built again (opening, older pages). The model drops each one
    /// as its `user.message` is applied, and this follows it after a flush.
    @ObservationIgnored private(set) var pending: [PendingMessage] = []
    @ObservationIgnored var onOlderLoaded: ((Int) -> Void)?
    /// The open card (TranscriptModel.openCard), observed, so the composer
    /// it's drawn in follows its picks and notes and drops it once it closes.
    private(set) var openCard: TranscriptRow?
    /// Observed by recovery controls outside the AppKit transcript. The
    /// rows themselves aren't observed, so a refusal arriving after its
    /// thread summary must still redraw the offer.
    private(set) var latestCompletion: TurnCompletion?

    init(threadId: String, subagentId: String? = nil, app: AppModel) {
        self.threadId = threadId
        self.subagentId = subagentId
        self.app = app
    }

    var model: TranscriptModel { feed.model }
    var displayCount: Int { max(0, feed.model.rows.count - displayStart) }
    func displayRow(_ index: Int) -> TranscriptRow { feed.model.rows[displayStart + index] }

    func displayIndex(of rowId: String) -> Int? {
        guard let index = feed.model.indexOf(id: rowId), index >= displayStart else { return nil }
        return index - displayStart
    }

    var hasMoreAbove: Bool { displayStart > 0 || feed.model.hasOlderEvents && olderBefore > 1 }

    /// The seq the next older page ends before.
    private var olderBefore: Int {
        if let olderSkip, olderSkip.firstSeq == feed.model.firstSeq { return olderSkip.before }
        return feed.model.firstSeq
    }

    // MARK: Loading

    /// Loads the newest page, renders the rows it will show off the main
    /// thread, then hands them to the view and subscribes.
    func open(width: CGFloat) {
        guard state == .idle || state.isFailed, loadTask == nil, let appModel = app else { return }
        // Another runner's thread connects to its runner first, in the load
        // below; this Mac's waits for the app's own connection, which
        // opens it once it's up.
        let remote = appModel.isRemote(threadId)
        guard remote || appModel.client != nil else { return }
        if let subagentId {
            guard let client = appModel.client(for: threadId) else { return }
            openSubagent(subagentId, client: client, width: width)
            return
        }
        state = .loading
        failureHeadline = nil
        let threadId = threadId
        let expanded = expanded
        // Another Mac's thread draws no pictures from this Mac (MarkdownRenderer.localPictures).
        let localPictures = !(app?.isRemote(threadId) ?? false)
        // File rows name folders from the thread's folder.
        let root = app?.threads[threadId]?.cwd
        let signpost = perfLog.beginInterval("open", id: perfLog.makeSignpostID(), "\(threadId)")
        loadTask = Task {
            defer { loadTask = nil }
            do {
                let debug = CommandLine.arguments.contains("--perf-debug")
                if debug { print(String(format: "    open %@: before fetch %.0f MB", threadId, memoryMB())) }
                let client = try await appModel.openClient(for: threadId)
                // Buttons made in turns older than the page: asked for
                // alongside it (an older runner has no buttons.list).
                let buttonList = Task { try? await client.replyButtons(threadId: threadId) }
                let page = try await client.events(threadId: threadId, limit: Self.eventsPage)
                // Known before the rows render, so a reply's pills are
                // right the first time. The list is waited for only when
                // the page links a button its events don't have.
                let buttons = ReplyButtons.shared
                buttons.fold(page.events, threadId: threadId)
                let unknown = page.events.contains { event in
                    guard case .assistantText(_, let text, _, _, _, _) = event.payload else { return false }
                    return ReplyButtons.ids(in: text).contains { buttons.known($0) == nil }
                }
                if unknown {
                    if let list = await buttonList.value { buttons.receive(list, threadId: threadId) }
                } else {
                    Task { if let list = await buttonList.value { buttons.receive(list, threadId: threadId) } }
                }
                if debug { print(String(format: "    after fetch %.0f MB", memoryMB())) }
                // What the thread's summary says is running in the
                // background, for the line at the end.
                let background = app?.threads[threadId]?.background ?? []
                let looseEnds = app?.threads[threadId]?.looseEnds
                // Answers picked on the open card before it was last shown.
                let picks = app?.askPicks[threadId]
                let nextPicks = app?.nextPicks[threadId]
                let prepared = await Task.detached(priority: .userInitiated) { () -> (TranscriptModel, Int) in
                    var model = TranscriptModel(root: root)
                    if let picks {
                        _ = model.setAskPicks(picks.asksSeq, picks.picks)
                        _ = model.setAskNotes(picks.asksSeq, picks.notes)
                    }
                    if let nextPicks { _ = model.setNextPicks(nextPicks.seq, nextPicks.picked, explain: nextPicks.explain) }
                    _ = model.setLooseEnds(looseEnds)
                    model.load(events: page.events, inProgress: page.inProgress)
                    model.knownStart = page.atStart
                    _ = model.setBackground(background)
                    if debug { print(String(format: "    after model %.0f MB", memoryMB())) }
                    let start = max(0, model.rows.count - Self.initialRows)
                    TranscriptController.renders.prepare(Array(model.rows[start...]), expanded: expanded, width: width, localPictures: localPictures)
                    if debug { print(String(format: "    after prepare %.0f MB", memoryMB())) }
                    return (model, start)
                }.value
                var model = prepared.0
                // Sent while it loaded, or before it was last let go.
                if !pending.isEmpty {
                    _ = model.setPending(pending)
                    pending = model.pending
                }
                feed = ThreadFeed(model: model)
                // Another runner's thread through Convex: its seqs have gaps.
                feed.sparse = appModel.viaRelay(threadId)
                displayStart = prepared.1
                state = .loaded
                perfLog.endInterval("open", signpost)
                view?.reloadAll()
                onLoaded?()
                await subscribe()
            } catch {
                perfLog.endInterval("open", signpost)
                AppLog.write("rpc", "couldn't load \(threadId): \(error.localizedDescription)")
                failureHeadline = (error as? RemoteUnreachable)?.headline
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// A sub-agent's transcript: every event it has so far, in one read.
    private func openSubagent(_ subagentId: String, client: RPCClient, width: CGFloat) {
        state = .loading
        missing = false
        let threadId = threadId
        let expanded = expanded
        // Another Mac's thread draws no pictures from this Mac (MarkdownRenderer.localPictures).
        let localPictures = !(app?.isRemote(threadId) ?? false)
        let root = app?.threads[threadId]?.cwd
        loadTask = Task {
            defer { loadTask = nil }
            do {
                let reply = try await client.subagent(threadId: threadId, subagentId: subagentId)
                let live = (app?.threads[threadId]?.subagents.first { $0.id == subagentId } ?? reply.subagent).flatMap { $0.isRunning ? $0.startedAt : nil }
                let prepared = await Task.detached(priority: .userInitiated) { () -> (TranscriptModel, Int) in
                    var model = TranscriptModel(root: root)
                    model.load(events: reply.events, inProgress: [])
                    if let live { _ = model.setLiveTurn("", startedAt: live) }
                    let start = max(0, model.rows.count - Self.initialRows)
                    TranscriptController.renders.prepare(Array(model.rows[start...]), expanded: expanded, width: width, localPictures: localPictures)
                    return (model, start)
                }.value
                feed = ThreadFeed(model: prepared.0)
                displayStart = prepared.1
                state = .loaded
                view?.reloadAll()
                onLoaded?()
            } catch RPCError.server(let code, _) where code == RPCError.subagentNotFound {
                missing = true
                state = .failed("There's no record of what this sub-agent did.")
            } catch {
                AppLog.write("rpc", "couldn't load sub-agent \(subagentId) of \(threadId): \(error.localizedDescription)")
                state = .failed(error.localizedDescription)
            }
        }
    }

    /// Reads a running sub-agent's transcript again and adds what's new, as
    /// a live update would. The runner numbers its events from 1 on every
    /// read, and the CLI only ever adds to its record, so new ones are the
    /// ones past the last seq shown.
    func refreshSubagent() {
        guard let subagentId, state == .loaded, !refreshing, let client = app?.client(for: threadId) else { return }
        refreshing = true
        let threadId = threadId
        Task {
            defer { refreshing = false }
            guard let reply = try? await client.subagent(threadId: threadId, subagentId: subagentId) else { return }
            let fresh = reply.events.filter { $0.seq > feed.acceptedSeq }
            if !fresh.isEmpty {
                handle(feed.catchUp(fresh))
                flush()
            }
            // Its working line goes once it has finished.
            let subagent = app?.threads[threadId]?.subagents.first { $0.id == subagentId } ?? reply.subagent
            let running = subagent?.isRunning ?? false
            guard !rebuilding, (feed.model.openTurn != nil) != running else { return }
            let oldStart = displayStart
            let change = feed.setLiveTurn(running ? "" : nil, startedAt: subagent?.startedAt)
            if !change.isEmpty { show(change, oldStart: oldStart) }
        }
    }

    func subscribe() async {
        guard subagentId == nil, let client = app?.client(for: threadId), state == .loaded else { return }
        feed.beginSubscribe()
        do {
            let reply = try await client.subscribe(threadId: threadId, afterSeq: feed.acceptedSeq)
            subscribed = true
            ReplyButtons.shared.fold(reply.events, threadId: threadId)
            handle(feed.finishSubscribe(reply.events, inProgress: reply.inProgress))
            // An older page that failed while the connection was down,
            // retries used up on a short page that can't scroll: ask again
            // now it's back.
            olderFailures = 0
            view?.loadOlderIfNearTop()
        } catch {
            // The next connection subscribes again from the same seq.
            feed.catchUpFailed()
        }
    }

    /// The connection dropped; the next connection re-subscribes from the
    /// last seq we have and the runner replays the gap. Messages still on
    /// their way go: one in flight fails its send, which puts the draft
    /// back, and one the runner had queued comes back with its turn.
    func connectionLost() {
        subscribed = false
        // A message a restart turned away is still on its way: it goes again
        // once the new runner is up (AppModel.clientAfterRestart).
        let resending = resending
        updatePending { $0.removeAll { !resending.contains($0.id) } }
    }

    /// Pending messages waiting to go again on the new runner after a
    /// restart turned them away; a dropped connection keeps them showing.
    @ObservationIgnored private var resending: Set<String> = []

    func holdForResend(_ id: String) {
        if hasPending(id) { resending.insert(id) }
    }

    /// Reads the thread again from scratch, when the way it's reached has
    /// changed (the direct link went on or off).
    func reload(width: CGFloat) {
        guard subagentId == nil, loadTask == nil else { return }
        // The caller has let the old subscription go, over the old way.
        subscribed = false
        feed = ThreadFeed()
        displayStart = 0
        state = .idle
        view?.reloadAll()
        open(width: width)
    }

    /// Another runner's thread whose runner can't be reached any more: the
    /// transcript goes and the reason shows in its place, with Try again,
    /// rather than an old transcript that's quietly stopped updating.
    func markUnreachable(_ error: Error) {
        guard subagentId == nil, loadTask == nil else { return }
        subscribed = false
        updatePending { $0.removeAll() }
        feed = ThreadFeed()
        displayStart = 0
        failureHeadline = (error as? RemoteUnreachable)?.headline
        state = .failed(error.localizedDescription)
        view?.reloadAll()
    }

    func unsubscribe() {
        guard subscribed, let client = app?.client(for: threadId) else { return }
        subscribed = false
        let threadId = threadId
        Task { try? await client.unsubscribe(threadId: threadId) }
    }

    // MARK: Live events

    func receive(_ event: Event) {
        guard state == .loaded else { return }
        if subagentId == nil { VoiceMode.shared.receive(event) }
        handle(feed.receive(event))
    }

    private func handle(_ action: ThreadFeed.Action) {
        switch action {
        case .none:
            break
        case .scheduleFlush:
            scheduleFlush()
        case .needsCatchUp(let afterSeq):
            // A sub-agent's events come whole from threads.subagent; the
            // next read fills any gap.
            if subagentId != nil {
                feed.catchUpFailed()
                return
            }
            guard let client = app?.client(for: threadId) else {
                feed.catchUpFailed()
                return
            }
            let threadId = threadId
            // A catch-up that didn't fill the gap waits a little before the
            // next try (and the feed gives up on the hole after a few), so
            // one bad page can't spin the app.
            let stalls = feed.stalledCatchUps
            Task {
                if stalls > 0 { try? await Task.sleep(for: .milliseconds(250 << min(stalls, 3))) }
                do {
                    let page = try await client.events(threadId: threadId, afterSeq: afterSeq, limit: 2000)
                    ReplyButtons.shared.fold(page.events, threadId: threadId)
                    handle(feed.catchUp(page.events))
                } catch {
                    feed.catchUpFailed()
                }
            }
        }
    }

    /// Coalesces updates to at most 30 a second.
    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        let wait = max(0, 1.0 / 30 - (CACurrentMediaTime() - lastFlush))
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    func flush() {
        flushScheduled = false
        // An older page is being merged off the main thread; wait for it.
        if rebuilding {
            scheduleFlush()
            return
        }
        let started = CACurrentMediaTime()
        lastFlush = started
        let oldStart = displayStart
        let change = feed.flush()
        // A user.message may have taken one of the messages on their way.
        if pending != feed.model.pending, state == .loaded { pending = feed.model.pending }
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
        flushCount += 1
        flushTime += CACurrentMediaTime() - started
    }

    /// The thread's summary changed what's running in the background. The
    /// line at the end comes, goes or changes in place, like a live update.
    func setBackground(_ tasks: [BackgroundTask]) {
        guard state == .loaded, !rebuilding else { return }
        let oldStart = displayStart
        let change = feed.setBackground(tasks)
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    /// The summary's loose-ends check for the done card changed.
    func setLooseEnds(_ check: LooseEnds?) {
        guard state == .loaded, !rebuilding else { return }
        let oldStart = displayStart
        let change = feed.setLooseEnds(check)
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    // MARK: Messages on their way

    /// Shows a message Mike just sent at the end of the transcript, dimmed,
    /// until the runner shows it. `afterSeq` is worked out here: the last
    /// event this app knows of for the thread.
    func addPending(id: String, text: String, images: [ImageRef], answers: [AskAnswer], summarySeq: Int) {
        let message = PendingMessage(id: id, text: text, images: images, answers: answers, afterSeq: max(feed.acceptedSeq, summarySeq))
        updatePending { $0.append(message) }
        // Sent from further up the thread: go down to it, as it's what
        // shows the click did something.
        if state == .loaded, !rebuilding { view?.scrollToBottom() }
    }

    /// The runner took it but hasn't shown it: it's queued behind the
    /// running turn.
    func markQueued(_ id: String) {
        resending.remove(id)
        updatePending { list in
            if let index = list.firstIndex(where: { $0.id == id }) { list[index].queued = true }
        }
    }

    /// The send failed (its draft goes back in the box).
    func removePending(_ id: String) {
        resending.remove(id)
        updatePending { $0.removeAll { $0.id == id } }
    }

    func hasPending(_ id: String) -> Bool { pending.contains { $0.id == id } }

    var hasQueued: Bool { pending.contains(where: \.queued) }

    /// The thread has sat idle with a message still queued: the runner
    /// dropped it somewhere (it would have started its turn), so it goes
    /// rather than wait here for good.
    func dropQueued() {
        updatePending { $0.removeAll(where: \.queued) }
    }

    private func updatePending(_ body: (inout [PendingMessage]) -> Void) {
        var list = pending
        body(&list)
        guard list != pending else { return }
        pending = list
        syncPending()
    }

    /// Hands the list to the model and the table, once it's loaded and no
    /// older page is being merged (the flush after that merge brings it).
    private func syncPending() {
        guard state == .loaded, !rebuilding, pending != feed.model.pending else { return }
        let oldStart = displayStart
        let change = feed.setPending(pending)
        pending = feed.model.pending
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    /// Shows the answers picked on the card from `seq` as picked. Before
    /// the transcript has loaded, the model is built with them instead
    /// (AppModel.askPicks is read when it is).
    func setAskPicks(seq: Int, picks: [Int: Int]) {
        guard state == .loaded, !rebuilding else { return }
        let oldStart = displayStart
        let change = feed.setAskPicks(seq, picks)
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    /// Shows what's in the card's Something else boxes, so it makes room
    /// for them (picked before the transcript loaded, they come with
    /// AppModel.askPicks as the picks do).
    func setAskNotes(seq: Int, notes: [Int: AskNote]) {
        guard state == .loaded, !rebuilding else { return }
        let oldStart = displayStart
        let change = feed.setAskNotes(seq, notes)
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    /// Shows the follow-ups ticked on the done card from `seq` as ticked
    /// (before it's loaded, the model is built with AppModel.nextPicks).
    func setNextPicks(seq: Int, picks: Set<Int>, explain: Set<Int>) {
        guard state == .loaded, !rebuilding else { return }
        let oldStart = displayStart
        let change = feed.setNextPicks(seq, picks, explain: explain)
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    /// Opens or closes a work group or a changed file. Its rows are
    /// inserted or removed in place, like a live update.
    func setModelExpanded(_ key: String, _ open: Bool) {
        guard state == .loaded, !rebuilding else { return }
        let oldStart = displayStart
        let change = feed.setExpanded(key, open)
        guard !change.isEmpty else { return }
        show(change, oldStart: oldStart)
    }

    /// Moves `displayStart` past rows that came or went above it and hands
    /// the table the rest in its own indices. Removed rows are indices in
    /// the old row list; inserted and updated ones in the new list.
    private func show(_ change: TranscriptChange, oldStart: Int) {
        var start = oldStart - change.removed.count(in: 0..<oldStart)
        for index in change.inserted {
            guard index < start else { break }
            start += 1
        }
        displayStart = min(start, feed.model.rows.count)
        let removed = IndexSet(change.removed.compactMap { $0 >= oldStart ? $0 - oldStart : nil })
        let inserted = IndexSet(change.inserted.compactMap { $0 >= start ? $0 - start : nil })
        let updated = IndexSet(change.updated.compactMap { $0 >= start ? $0 - start : nil })
        view?.apply(removed: removed, inserted: inserted, updated: updated)
    }

    private static func cardSeq(_ row: TranscriptRow?) -> Int? {
        if case .asks(let card)? = row?.content { return card.seq }
        return nil
    }

    /// The card that's just turned up, until the composer has settled it in.
    @ObservationIgnored var arrivingCard: Int?

    private func syncOpenCard() {
        if feed.model.openTurn == nil {
            let latest = feed.model.rows.reversed().lazy.compactMap { row -> TurnCompletion? in
                if case .footer(let completion) = row.content { return completion }
                return nil
            }.first
            if latest != latestCompletion { latestCompletion = latest }
        } else if latestCompletion != nil {
            latestCompletion = nil
        }
        let card = feed.model.openCard
        guard card != openCard else { return }
        // A card turning up as he watches, rather than one that was there
        // when the thread opened: only this one settles in (`ComposerCard`).
        if let seq = Self.cardSeq(card), seq != Self.cardSeq(openCard), state == .loaded, !rebuilding, view != nil { arrivingCard = seq }
        openCard = card
        app?.relayCardChanged(threadId)
    }

    // MARK: Older rows

    /// Shows up to 200 more rows above, fetching an older page first if the
    /// loaded events are used up.
    func loadOlder() {
        guard state == .loaded, !loadingOlder, hasMoreAbove else { return }
        loadingOlder = true
        let width = view?.width ?? 800
        let expanded = expanded
        // Another Mac's thread draws no pictures from this Mac (MarkdownRenderer.localPictures).
        let localPictures = !(app?.isRemote(threadId) ?? false)
        if displayStart > 0 {
            let newStart = max(0, displayStart - Self.pageRows)
            let rows = Array(feed.model.rows[newStart..<displayStart])
            Task {
                await Task.detached(priority: .userInitiated) {
                    TranscriptController.renders.prepare(rows, expanded: expanded, width: width, localPictures: localPictures)
                }.value
                // Where the reader is, read while the table and `displayStart`
                // still agree (a flush may have landed during the await).
                let memory = view?.captureMemory()
                reveal(to: newStart, changedIds: [], memory: memory)
            }
            return
        }
        guard subagentId == nil, let client = app?.client(for: threadId) else {
            loadingOlder = false
            return
        }
        let threadId = threadId
        let before = olderBefore
        let firstSeq = feed.model.firstSeq
        Task {
            do {
                let fetchStart = CACurrentMediaTime()
                let page = try await client.events(threadId: threadId, beforeSeq: before, limit: Self.eventsPage)
                olderFetchMs.append((CACurrentMediaTime() - fetchStart) * 1000)
                // An older snapshot never undoes a newer one (ReplyButton.supersedes).
                ReplyButtons.shared.fold(page.events, threadId: threadId)
                olderFailures = 0
                guard page.events.contains(where: { !$0.isTransient && $0.seq < before }) else {
                    // Step back past the range the page covered and go on.
                    olderSkip = (firstSeq, max(1, before - Self.eventsPage))
                    loadingOlder = false
                    view?.loadOlderIfNearTop()
                    return
                }
                let mergeStart = CACurrentMediaTime()
                // Merge off the main thread; hold flushes until it's swapped in.
                rebuilding = true
                var copy = feed.model
                let result = await Task.detached(priority: .userInitiated) { () -> (TranscriptModel, PrependResult) in
                    let result = copy.prepend(olderEvents: page.events)
                    if page.atStart { copy.knownStart = true }
                    let newStart = max(0, result.added - Self.pageRows)
                    TranscriptController.renders.prepare(Array(copy.rows[newStart..<result.added]), expanded: expanded, width: width, localPictures: localPictures)
                    return (copy, result)
                }.value
                // Read the scroll anchor before the model changes under the
                // table: afterwards a table row index no longer names the
                // row that's on screen, and the "restored" anchor would be
                // an older row (the review saw jumps of 6,000 to 33,000 pt).
                let memory = view?.captureMemory()
                feed.replaceModel(result.0)
                rebuilding = false
                defer { syncPending() }
                olderMergeMs.append((CACurrentMediaTime() - mergeStart) * 1000)
                let newStart = max(0, result.1.added - Self.pageRows)
                if result.1.keepsOrder {
                    // The rows we showed are now `added` rows further down.
                    displayStart = result.1.added
                    reveal(to: newStart, changedIds: result.1.changedIds, memory: memory)
                } else {
                    // A row moved across the old first row (a result whose
                    // call was on the older page), so the table can't just
                    // gain rows at the top. Reload it around the anchor.
                    displayStart = newStart
                    view?.reload(keeping: memory)
                    finishOlder(count: result.1.added - newStart)
                }
            } catch {
                rebuilding = false
                loadingOlder = false
                // Try again a few times, further apart each time.
                olderFailures += 1
                guard olderFailures <= 3 else { return }
                let delay = Double(olderFailures) * 2
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    self?.view?.loadOlderIfNearTop()
                }
            }
        }
    }

    private func reveal(to newStart: Int, changedIds: [String], memory: ScrollMemory?) {
        let count = displayStart - newStart
        displayStart = newStart
        view?.insertAtTop(count: count, changedIds: changedIds, memory: memory)
        finishOlder(count: count)
    }

    private func finishOlder(count: Int) {
        loadingOlder = false
        onOlderLoaded?(count)
        view?.loadOlderIfNearTop()
    }

    /// Lets go of older pages when the thread is left scrolled to the
    /// bottom, so a long thread that was paged all the way up costs no more
    /// than a fresh open. Only while it isn't on screen.
    func trimToNewest() {
        guard state == .loaded, !loadingOlder, !rebuilding, view == nil,
              feed.model.events.count > Self.eventsPage + Self.eventsPage / 2 else { return }
        var model = feed.model
        model.trim(keepingLast: Self.eventsPage)
        feed.replaceModel(model)
        displayStart = max(0, model.rows.count - Self.initialRows)
    }

    // MARK: Actions

    /// Ticks an ask on the open card. The box changes at once and goes back
    /// if the runner refuses. A click while one's on its way does nothing, so
    /// a double click doesn't undo itself, and two can't overlap: if both
    /// failed, the second's rollback would leave the first's guess showing.
    /// The runner's thread.updated and asks.ticked event bring the change back.
    func tickAsk(asksSeq: Int, index: Int, ticked: Bool) {
        guard let app, let client = app.client(for: threadId) else { return }
        let threadId = threadId
        let key = BusyKey.tickAsk(threadId, asksSeq: asksSeq, index: index)
        guard !app.isBusy(key) else { return }
        if askShown(asksSeq: asksSeq, index: index) != nil { app.threads[threadId]?.asks[index].ticked = ticked }
        app.whileBusy(key) { [self] in
            do {
                _ = try await client.tickAsk(threadId: threadId, asksSeq: asksSeq, index: index, ticked: ticked)
            } catch {
                if askShown(asksSeq: asksSeq, index: index) == ticked { app.threads[threadId]?.asks[index].ticked = !ticked }
                app.show(error)
            }
        }
    }

    /// Whether the ask is ticked now, or nil if that card has gone: a newer
    /// card's ask at the same place mustn't be changed.
    private func askShown(asksSeq: Int, index: Int) -> Bool? {
        guard let thread = app?.threads[threadId], thread.asksSeq == asksSeq, thread.asks.indices.contains(index) else { return nil }
        return thread.asks[index].ticked
    }

    /// Requests being read for their cards (docs/protocol.md, "Asking
    /// another runner"), so a card drawn again doesn't ask again.
    private var startRequestsLoading: Set<String> = []

    /// Reads another runner's request for a thread from this Mac's own
    /// runner (the only one that can), and puts it on its card.
    func loadStartRequest(_ approvalId: String) {
        guard !startRequestsLoading.contains(approvalId), let client = app?.client else { return }
        startRequestsLoading.insert(approvalId)
        let threadId = threadId
        Task { [weak self] in
            let info: StartRequest
            do {
                info = try await client.startRequest(threadId: threadId, approvalId: approvalId)
            } catch {
                info = .failed(error.localizedDescription)
            }
            // Loaded or not, it may be asked for again: a reload (the direct
            // link turned on or off) builds the card afresh without it.
            self?.startRequestsLoading.remove(approvalId)
            guard let self, self.state == .loaded, !self.rebuilding else { return }
            let oldStart = self.displayStart
            let change = self.feed.setStartRequest(approvalId, info)
            if !change.isEmpty { self.show(change, oldStart: oldStart) }
        }
    }

    /// Start it or Don't on another runner's request: this Mac's runner
    /// starts it and answers the card (requests.answer), never the
    /// thread's own runner, which may not start threads elsewhere.
    private func answerStartRequest(approvalId: String, allow: Bool) -> Bool {
        guard case .approval(let item)? = feed.model.item(id: "ap:" + approvalId)?.content, item.isStartRequest else { return false }
        // Only what Mike has read can be started: never one still loading
        // or that failed to load. The fingerprint ties the answer to what
        // the card showed, so a request filed again under the same id with
        // other words isn't started on the strength of the old card.
        guard let client = app?.client else { return true }
        let shown = item.startRequest
        if allow, shown == nil || shown?.error != nil || shown?.fingerprint == nil { return true }
        let threadId = threadId
        let runnerId = shown?.startsOn?.id
        let fingerprint = shown?.fingerprint
        ActivityRecorder.shared.answered(threadId: threadId, decision: allow ? .allow : .deny)
        startAnswering(approvalId)
        Task {
            do {
                try await client.answerStartRequest(threadId: threadId, approvalId: approvalId, allow: allow, runnerId: allow ? runnerId : nil, fingerprint: fingerprint)
            } catch {
                self.stopAnswering(approvalId)
                app?.show(error)
            }
        }
        return true
    }

    /// Cards whose answer is on its way. Another runner's thread takes a
    /// moment or more to hear it (relay.ts waits for that runner to take
    /// the command), so the card shows a spinner, its buttons stop taking
    /// clicks, and a second click or Return does nothing. Once the answer
    /// lands the card turns into its answered line by itself; on a failure
    /// the buttons come back with the error.
    private(set) var answering: Set<String> = []

    private func startAnswering(_ approvalId: String) {
        answering.insert(approvalId)
        view?.refreshCard(approvalId)
    }

    private func stopAnswering(_ approvalId: String) {
        answering.remove(approvalId)
        view?.refreshCard(approvalId)
    }

    func respond(approvalId: String, decision: ApprovalDecision, answers: [String: String]?, message: String?) {
        guard !answering.contains(approvalId) else { return }
        if decision != .answered, answerStartRequest(approvalId: approvalId, allow: decision != .deny) { return }
        guard let client = app?.client(for: threadId) else { return }
        let threadId = threadId
        ActivityRecorder.shared.answered(threadId: threadId, decision: decision)
        startAnswering(approvalId)
        Task {
            do {
                try await client.respond(threadId: threadId, approvalId: approvalId, decision: decision, message: message, answers: answers)
            } catch {
                self.stopAnswering(approvalId)
                app?.show(error)
            }
        }
    }

    /// The approval card as this thread shows it now, nil once it's settled
    /// or not there (Voice checks a spoken answer against it).
    func openApproval(_ approvalId: String) -> ApprovalRequest? {
        guard !answering.contains(approvalId),
              case .approval(let item)? = feed.model.item(id: "ap:\(approvalId)")?.content,
              item.resolution == nil else { return nil }
        return item.request
    }

    /// Go ahead on a "Plan first" plan card (docs/protocol.md).
    /// The card spins like an approval's until the answer lands.
    func approvePlan(itemId: String) {
        guard !answering.contains(itemId), let client = app?.client(for: threadId) else { return }
        let threadId = threadId
        ActivityRecorder.shared.answered(threadId: threadId, decision: .allow)
        startAnswering(itemId)
        Task {
            do {
                try await client.approvePlan(threadId: threadId, itemId: itemId)
                // The card turns into its approved state by itself. Let go
                // a little later in case that never comes, so it can be
                // pressed again.
                try? await Task.sleep(for: Self.planLetGo)
            } catch {
                app?.show(error)
            }
            self.stopAnswering(itemId)
        }
    }

    /// A var only so tests can make it short.
    static var planLetGo: Duration = .seconds(5)

    /// Sends a secret card's answer (docs/protocol.md, "Secrets") to the
    /// thread's own runner, this Mac's or another's. Nil once it's gone,
    /// else what to say under the field. The value is in this call only:
    /// no log line, activity entry or banner ever has it.
    func answerSecret(approvalId: String, _ answer: SecretAnswer) async -> String? {
        guard let client = app?.client(for: threadId) else { return "Not connected to this thread's runner." }
        let declined: Bool
        if case .decline = answer { declined = true } else { declined = false }
        ActivityRecorder.shared.answered(threadId: threadId, decision: declined ? .deny : .answered)
        do {
            try await client.answerSecret(threadId: threadId, approvalId: approvalId, answer)
            return nil
        } catch let unreachable as RemoteUnreachable {
            return unreachable.headline + " " + unreachable.detail
        } catch {
            AppLog.write("rpc", "secrets.answer failed: \(error.localizedDescription)")
            return error.localizedDescription
        }
    }

    /// Copies the whole thread, fetching any older pages first, which takes
    /// a while on a long one: the banner says so until it's on the clipboard.
    /// A page that can't be read leaves the clipboard alone and says why,
    /// rather than copying part of the thread as if it were all of it.
    func copyTranscript() {
        guard let app, let client = app.client(for: threadId) else { return }
        let threadId = threadId
        let title = app.threads[threadId]?.title ?? ""
        let newest = feed.model.events
        app.whileBusy(BusyKey.copying(threadId), note: "Copying the transcript…") {
            var events = newest
            var first = events.first?.seq ?? 0
            do {
                while first > 1 {
                    let page = try await client.events(threadId: threadId, beforeSeq: first, limit: 2000)
                    guard !page.events.isEmpty else { break }
                    events = page.events + events
                    first = page.events.first?.seq ?? 1
                }
            } catch {
                app.show(error)
                return
            }
            let all = events
            // Items, not rows: nothing folded in a group is left out.
            let text = await Task.detached { MarkdownExport.transcript(title: title, rows: TranscriptModel(events: all).items) }.value
            app.copyToPasteboard(text)
            app.flashDone("Transcript copied")
        }
    }
}

extension ThreadSession.LoadState {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}
