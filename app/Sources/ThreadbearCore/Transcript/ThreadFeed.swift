import Foundation

/// Keeps a thread's transcript in step with the runner: buffers live events,
/// orders persisted ones by seq, spots gaps that need a catch-up fetch, and
/// hands batches to the reducer when the view asks (at most 30 times a second).
public struct ThreadFeed: Sendable {
    public enum Action: Sendable, Equatable {
        case none
        /// Something is ready to apply; flush on the next frame tick.
        case scheduleFlush
        /// A persisted event skipped ahead. Fetch `threads.events(afterSeq:)`.
        case needsCatchUp(afterSeq: Int)
    }

    public private(set) var model: TranscriptModel
    /// Events ready to apply, in arrival order with persisted ones contiguous.
    private var pending: [Event] = []
    /// Persisted events that arrived ahead of a gap, keyed by seq.
    private var ahead: [Int: Event] = [:]
    /// Highest persisted seq accepted into `pending` or the model.
    public private(set) var acceptedSeq: Int
    public private(set) var isCatchingUp = false
    /// A `threads.subscribe` is in flight. Deltas pushed meanwhile come
    /// after the reply's in-progress text, so they're held until it lands.
    private var subscribing = false
    private var held: [Event] = []
    /// Catch-up fetches in a row that didn't move `acceptedSeq` on.
    public private(set) var stalledCatchUps = 0
    /// After this many fruitless catch-ups the hole is skipped: the runner
    /// doesn't have those seqs (or keeps sending ones that can't be read),
    /// and waiting for them would freeze the thread for good.
    public static let maxStalledCatchUps = 3
    /// Another runner's thread read through Convex (docs/protocol.md, "Other
    /// runners' threads through the backend"): its seqs have gaps by design
    /// and an event can come late (an approval's answer after later rows), so
    /// every persisted event is taken as it comes, never waited on, and the
    /// model places a late one where it belongs.
    public var sparse = false {
        didSet { model.sparse = sparse }
    }

    public init(model: TranscriptModel = TranscriptModel()) {
        self.model = model
        acceptedSeq = model.lastSeq
    }

    public var hasPending: Bool { !pending.isEmpty }

    public mutating func receive(_ event: Event) -> Action {
        if event.isTransient && subscribing {
            held.append(event)
            return .none
        }
        if event.isTransient {
            pending.append(event)
            return .scheduleFlush
        }
        if sparse {
            pending.append(event)
            acceptedSeq = max(acceptedSeq, event.seq)
            return .scheduleFlush
        }
        if event.seq <= acceptedSeq { return .none }
        if event.seq == acceptedSeq + 1 {
            accept(event)
            drainAhead()
            return .scheduleFlush
        }
        ahead[event.seq] = event
        if isCatchingUp { return .none }
        isCatchingUp = true
        return .needsCatchUp(afterSeq: acceptedSeq)
    }

    public mutating func receive(_ events: [Event]) -> Action {
        var result = Action.none
        for event in events {
            switch receive(event) {
            case .none: break
            case .scheduleFlush: if result == .none { result = .scheduleFlush }
            case .needsCatchUp(let seq): result = .needsCatchUp(afterSeq: seq)
            }
        }
        return result
    }

    /// Call before `threads.subscribe`: events pushed while it's in flight are
    /// held until its reply arrives through `finishSubscribe`, instead of
    /// starting a second fetch.
    public mutating func beginSubscribe() {
        isCatchingUp = true
        subscribing = true
        held = []
    }

    /// Feeds a `threads.subscribe` reply. Its `inProgress` is what was
    /// streamed before the subscription started, including deltas that went
    /// out between the `threads.events` load and the subscribe, which this
    /// app never got; it replaces each streaming row's text, then the deltas
    /// held since `beginSubscribe` carry on from it.
    public mutating func finishSubscribe(_ events: [Event], inProgress: [EventsPage.InProgress]) -> Action {
        subscribing = false
        var action = catchUp(events)
        for item in inProgress {
            pending.append(Event(seq: acceptedSeq, threadId: "", type: "inProgress",
                                 payload: .streamingText(itemId: item.itemId, isReasoning: item.type == "reasoning", text: item.text)))
        }
        pending += held
        held = []
        if action == .none && !pending.isEmpty { action = .scheduleFlush }
        return action
    }

    /// Feeds the result of a catch-up fetch (or a subscribe replay). Returns another catch-up if a
    /// gap is still open (the page was limited).
    public mutating func catchUp(_ events: [Event]) -> Action {
        isCatchingUp = false
        if sparse {
            for event in events.sorted(by: { $0.seq < $1.seq }) where !event.isTransient {
                pending.append(event)
                acceptedSeq = max(acceptedSeq, event.seq)
            }
            return pending.isEmpty ? .none : .scheduleFlush
        }
        let before = acceptedSeq
        for event in events.sorted(by: { $0.seq < $1.seq }) where !event.isTransient && event.seq > acceptedSeq {
            if event.seq == acceptedSeq + 1 {
                accept(event)
                drainAhead()
            } else {
                ahead[event.seq] = event
            }
        }
        if !ahead.isEmpty {
            stalledCatchUps = acceptedSeq == before ? stalledCatchUps + 1 : 0
            if stalledCatchUps >= Self.maxStalledCatchUps, let next = ahead.keys.min() {
                stalledCatchUps = 0
                acceptedSeq = next - 1
                drainAhead()
            }
        }
        if !ahead.isEmpty {
            isCatchingUp = true
            return .needsCatchUp(afterSeq: acceptedSeq)
        }
        stalledCatchUps = 0
        return pending.isEmpty ? .none : .scheduleFlush
    }

    /// A catch-up fetch failed (the connection dropped, say). Doesn't count
    /// as a stall; the next subscribe replays from `acceptedSeq`.
    public mutating func catchUpFailed() {
        isCatchingUp = false
        // A failed subscribe: the next one brings fresh in-progress text.
        subscribing = false
        held = []
    }

    /// Applies everything pending to the model.
    public mutating func flush() -> TranscriptChange {
        guard !pending.isEmpty else { return TranscriptChange() }
        let batch = pending
        pending = []
        return model.apply(batch)
    }

    /// Opens or closes a group or a changed file (see
    /// `TranscriptModel.setExpanded`). Queued events stay queued.
    public mutating func setExpanded(_ key: String, _ open: Bool) -> TranscriptChange {
        model.setExpanded(key, open)
    }

    /// Mike picked answers on a card (see `TranscriptModel.setAskPicks`).
    public mutating func setAskPicks(_ seq: Int, _ picks: [Int: Int]) -> TranscriptChange {
        model.setAskPicks(seq, picks)
    }

    /// Another runner's request was read (see `TranscriptModel.setStartRequest`).
    public mutating func setStartRequest(_ approvalId: String, _ request: StartRequest) -> TranscriptChange {
        model.setStartRequest(approvalId, request)
    }

    /// Mike wrote in a card's Something else boxes (see `TranscriptModel.setAskNotes`).
    public mutating func setAskNotes(_ seq: Int, _ notes: [Int: AskNote]) -> TranscriptChange {
        model.setAskNotes(seq, notes)
    }

    /// Mike ticked follow-ups on a done card (see `TranscriptModel.setNextPicks`).
    public mutating func setNextPicks(_ seq: Int, _ picks: Set<Int>, explain: Set<Int> = []) -> TranscriptChange {
        model.setNextPicks(seq, picks, explain: explain)
    }

    /// The done card's loose ends changed (see `TranscriptModel.setLooseEnds`).
    public mutating func setLooseEnds(_ check: LooseEnds?) -> TranscriptChange {
        model.setLooseEnds(check)
    }

    /// The thread's background work changed (see
    /// `TranscriptModel.setBackground`). Queued events stay queued.
    public mutating func setBackground(_ tasks: [BackgroundTask]) -> TranscriptChange {
        model.setBackground(tasks)
    }

    /// Messages sent and not shown yet (see `TranscriptModel.setPending`).
    /// Queued events stay queued.
    public mutating func setPending(_ list: [PendingMessage]) -> TranscriptChange {
        model.setPending(list)
    }

    /// A sub-agent started or stopped running (see
    /// `TranscriptModel.setLiveTurn`). Queued events stay queued.
    public mutating func setLiveTurn(_ turn: String?, startedAt: Date? = nil) -> TranscriptChange {
        model.setLiveTurn(turn, startedAt: startedAt)
    }

    /// Swaps in a model that had an older page prepended off the main thread.
    /// Only valid if nothing was flushed since the copy was taken.
    public mutating func replaceModel(_ newModel: TranscriptModel) {
        model = newModel
    }

    /// Replaces the model (after a reload) and forgets queued events that it covers.
    public mutating func reset(_ newModel: TranscriptModel) {
        model = newModel
        model.sparse = sparse
        acceptedSeq = newModel.lastSeq
        pending.removeAll { !$0.isTransient && $0.seq <= acceptedSeq }
        ahead = ahead.filter { $0.key > acceptedSeq }
        isCatchingUp = false
        drainAhead()
    }

    private mutating func accept(_ event: Event) {
        pending.append(event)
        acceptedSeq = event.seq
    }

    private mutating func drainAhead() {
        while let next = ahead.removeValue(forKey: acceptedSeq + 1) {
            accept(next)
        }
    }
}
