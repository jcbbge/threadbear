import Foundation
import Synchronization

/// Row versions are unique across all models and rebuilds, so a cache keyed
/// by (row id, version) can never return a stale render.
enum RowVersion {
    private static let counter = Atomic<Int>(0)

    static func next() -> Int {
        counter.wrappingAdd(1, ordering: .relaxed).newValue
    }
}

public struct PrependResult: Sendable, Equatable {
    /// Rows that appeared above the previous first row.
    public var added: Int
    /// Rows that were already there but changed (a tool call that met its
    /// result across the page boundary, say).
    public var changedIds: [String]
    /// True when the rows from `added` on are exactly the previous rows, in
    /// order, so a view can insert `added` rows at the top. False when a row
    /// moved above the old first row (a result on the newer page whose call
    /// is on the older one) or an older event's row landed below it; the
    /// view then has to reload instead.
    public var keepsOrder: Bool

    public init(added: Int, changedIds: [String], keepsOrder: Bool = true) {
        self.added = added
        self.changedIds = changedIds
        self.keepsOrder = keepsOrder
    }
}

/// What changed in the row list after applying events or opening a group.
/// `removed` are indices in the list before the change; `inserted` and
/// `updated` in the list after it. A table removes, then inserts, then
/// reloads.
public struct TranscriptChange: Sendable, Equatable {
    public var removed: IndexSet = []
    public var inserted: IndexSet = []
    public var updated: IndexSet = []
    /// Persisted events arrived with a seq gap; refetch after `lastSeq`.
    public var gapDetected = false

    public init(removed: IndexSet = [], inserted: IndexSet = [], updated: IndexSet = [], gapDetected: Bool = false) {
        self.removed = removed
        self.inserted = inserted
        self.updated = updated
        self.gapDetected = gapDetected
    }

    public var isEmpty: Bool { removed.isEmpty && inserted.isEmpty && updated.isEmpty }
}

/// Turns protocol events into transcript rows. Live events are applied
/// incrementally; loading an older page rebuilds from the stored events,
/// which is cheap (a few ms for thousands of rows) and keeps merging simple.
///
/// There are two lists. `items` has one row per thing the agent did (a
/// message, a tool call with its result, a thinking block). `rows` is what
/// the table shows: each run of work inside a turn folded into a group row
/// (with its items under it when it's open), plus the derived rows: the
/// "Edited 3 files" card before a turn's footer and the "Working for 12s"
/// line while a turn runs. Live changes only rebuild `rows` from the first
/// run they touch to the end, which is nearly always the current turn.
public struct TranscriptModel: Sendable {
    public private(set) var rows: [TranscriptRow] = []
    public private(set) var items: [TranscriptRow] = []
    /// Persisted events we hold, in seq order.
    public private(set) var events: [Event] = []
    public private(set) var firstSeq: Int = 0
    public private(set) var lastSeq: Int = 0
    /// Open groups (`g:` ids) and open files in changed-files cards
    /// (`ChangedFiles.expansionKey`). Kept across rebuilds.
    public private(set) var expanded: Set<String> = []
    /// The turn that has started and not finished, if any.
    public private(set) var openTurn: String?
    /// Text streamed by deltas for items with no persisted event yet.
    private var streaming: [String: (kind: RowKind, text: String)] = [:]
    private var itemIndex: [String: Int] = [:]
    private var index: [String: Int] = [:]
    /// For each row, the index of the first item it stands for. Never
    /// decreases, so the rows for items from `n` on are a binary search away.
    private var rowStarts: [Int] = []
    private var planRowForTurn: [String: String] = [:]
    /// "Plan first": the approved plan card that takes the steps the agent
    /// then works through (plan.updated), and the turn it does so in (nil
    /// until it starts: Codex's goes ahead in the next turn). Approval
    /// requests for a plan card's ExitPlanMode call, which get no row.
    private var planTakingSteps: String?
    private var planStepsTurn: String?
    private var planApprovals: Set<String> = []
    /// Rows of commands Mike ran from a chip (an action.run with no
    /// trigger): left out of the turn's line of work before them, so what
    /// he pressed shows where he pressed it. A hook's run (a trigger) folds
    /// in with the turn it followed. The tour's Roll a die vanished into a
    /// collapsed "Worked for 4s" above the answer (30 Oct).
    private var pressedRuns: Set<String> = []
    /// Cards of asks by the seq of their turn.completed, and the open one
    /// (the last finished turn's), if it has asks.
    private var asksRowForSeq: [Int: String] = [:]
    private var openAsksRow: String?
    /// The option Mike picked on each card's asks (ask index to option
    /// index), by the card's seq. Kept here rather than in the rows, so a
    /// rebuild keeps them; only the app sets them.
    public private(set) var askPicks: [Int: [Int: Int]] = [:]
    /// What Mike has written in each card's Something else boxes, by the
    /// card's seq, kept here for the same reason.
    public private(set) var askNotes: [Int: [Int: AskNote]] = [:]
    /// Other runners' requests for a thread, read by approval id, so a
    /// rebuild keeps them on their cards.
    public private(set) var startRequests: [String: StartRequest] = [:]
    /// The follow-ups Mike ticked on each done card, by the card's seq,
    /// kept here for the same reason.
    public private(set) var nextPicks: [Int: Set<Int>] = [:]
    /// The follow-ups with their "?" on, by card seq.
    public private(set) var nextExplains: [Int: Set<Int>] = [:]
    /// The runner's loose-ends check for a done card (protocol "Loose
    /// ends"), from the thread's summary, kept here for the same reason.
    public private(set) var looseEnds: LooseEnds?
    /// Each turn's last error row, to learn the turn's `errorKind`.
    private var errorRowForTurn: [String: String] = [:]
    private var turnStarts: [String: Date] = [:]
    /// When the last turn ended, and the turns Mike's (or anyone's) message
    /// started: a turn with no message is one the agent started itself,
    /// and the wait before it gets a divider (`TurnGap`).
    private var lastTurnEnd: Date?
    private var messagedTurns: Set<String> = []
    /// Turns whose `turn.started` has been seen: a message after it went
    /// into that turn, so it can't be edited on its own.
    private var startedTurns: Set<String> = []
    /// The seqs edits cut (`thread.rewound`), from every rewind event held.
    /// Their events stay in `events` but make no rows.
    public private(set) var hidden: [ClosedRange<Int>] = []
    private var completedTurns: Set<String> = []
    /// Turns with a summary from end_turn: their other messages are work.
    private var summarizedTurns: Set<String> = []
    /// Turns with a One reply final message: like a summary, it's the
    /// reply, so the turn gets no changes card either.
    private var repliedTurns: Set<String> = []
    /// Edit and Write tool items per turn, in order, for the changes card.
    private var editsByTurn: [String: [String]] = [:]
    /// The seq each tool row's result came at, by row id: a message written
    /// while a step was still running isn't after it (reply(of:)).
    private var resultSeqs: [String: Int] = [:]
    /// Approval and question rows still waiting, and their turn. A turn
    /// waiting on Mike isn't "working".
    private var pendingCards: [String: String] = [:]
    /// Approval rows by the `t:` row of the tool call they asked about, so
    /// one learns when that tool gets a row (`ApprovalItem.toolShown`).
    private var approvalForTool: [String: String] = [:]
    /// The first item changed in place, and the first item added, since
    /// `rows` was last brought up to date.
    private var dirtyUpdate: Int?
    private var dirtyInsert: Int?
    /// One past the last item changed in place (and a changed edit's turn
    /// footer, whose card counts its lines). Changes in place only rebuild
    /// the rows up to here: opening a group near the top of a long thread
    /// rebuilt every row after it, 30 ms a click.
    private var dirtyUpdateEnd = 0
    /// Something the working line depends on changed (an approval or
    /// question came or went, the background work changed), so the rows to
    /// the end need rebuilding.
    private var tailDirty = false
    /// The thread's background sub-agents and jobs, from its summary. Shown
    /// as the last row while no turn runs.
    public private(set) var background: [BackgroundTask] = []
    /// The thread's working folder. File rows and the changes card name
    /// folders relative to it, so they don't repeat the project's name.
    public private(set) var root: String?
    /// Messages sent from this app that the runner hasn't shown yet, as
    /// the last rows (`PendingMessage`). Each goes as its `user.message`
    /// is applied, in the same change that adds the real row, so the
    /// bubble never blinks out and back.
    public private(set) var pending: [PendingMessage] = []

    public init(root: String? = nil) {
        self.root = root
    }

    public init(events: [Event], root: String? = nil) {
        self.init(root: root)
        load(events: events)
    }

    public var hasOlderEvents: Bool { firstSeq > 1 && !knownStart }
    /// The runner said there's nothing before the first event (a page's
    /// `relay.atStart`): another runner's thread through Convex, whose first
    /// seq is rarely 1.
    public var knownStart = false
    /// Takes persisted events that arrive behind ones already applied, and
    /// puts them in order (`ThreadFeed.sparse`).
    public var sparse = false

    /// A row in `rows` (shown in the table).
    public func row(id: String) -> TranscriptRow? {
        index[id].map { rows[$0] }
    }

    public func indexOf(id: String) -> Int? { index[id] }

    /// The last finished turn's card while it's open (Needs you or Done):
    /// the app draws it in the composer, not the transcript, so the two
    /// read as one box (Mike, 30 Oct). A message on its way is his reply
    /// already, so the card goes as soon as he sends it, not when the runner
    /// shows it, which behind a turn or a handover can be a good while. It
    /// comes back if the send fails.
    public var openCard: TranscriptRow? { pending.isEmpty ? openAsksRow.flatMap { row(id: $0) } : nil }

    /// An item, shown or folded away in a closed group.
    public func item(id: String) -> TranscriptRow? {
        itemIndex[id].map { items[$0] }
    }

    public func isExpanded(_ key: String) -> Bool { expanded.contains(key) }

    /// Approval cards (not questions) still waiting on Mike, oldest first.
    /// Return in an empty composer allows the one there is.
    public var pendingApprovalIds: [String] {
        pendingCards.keys
            .filter { $0.hasPrefix("ap:") }
            .sorted { (itemIndex[$0] ?? 0) < (itemIndex[$1] ?? 0) }
            .map { String($0.dropFirst(3)) }
    }

    /// Replaces everything with this page of events (oldest first).
    public mutating func load(events newEvents: [Event], inProgress: [EventsPage.InProgress] = []) {
        events = newEvents.filter { !$0.isTransient }.sorted { $0.seq < $1.seq }
        firstSeq = events.first?.seq ?? 0
        lastSeq = events.last?.seq ?? 0
        PendingMessage.remove(landedIn: events, from: &pending)
        streaming = [:]
        for item in inProgress {
            streaming[item.itemId] = (item.type == "reasoning" ? .reasoning : .assistant, item.text)
        }
        rebuild()
    }

    /// Adds an older page in front. Returns how many rows appeared above the
    /// previous first row, so the view can keep its scroll anchor.
    @discardableResult
    public mutating func prepend(olderEvents: [Event]) -> PrependResult {
        let older = olderEvents.filter { !$0.isTransient && (firstSeq == 0 || $0.seq < firstSeq) }
        guard !older.isEmpty else { return PrependResult(added: 0, changedIds: []) }
        let previousIds = rows.map(\.id)
        let previous = Dictionary(rows.map { ($0.id, $0.version) }, uniquingKeysWith: { first, _ in first })
        events = older.sorted { $0.seq < $1.seq } + events
        firstSeq = events.first?.seq ?? 0
        rebuild()
        let changed = rows.compactMap { row -> String? in
            guard let version = previous[row.id] else { return nil }
            return version == row.version ? nil : row.id
        }
        guard let previousFirstId = previousIds.first else {
            return PrependResult(added: 0, changedIds: changed, keepsOrder: true)
        }
        guard let newIndex = index[previousFirstId] else {
            // The old first row is gone: a group grew backwards over the page
            // boundary and took a new id, or swallowed a lone item. Anchor on
            // the first old row that's still there; the view reloads.
            let survivor = previousIds.first(where: { index[$0] != nil }).flatMap { index[$0] } ?? 0
            return PrependResult(added: survivor, changedIds: changed, keepsOrder: false)
        }
        let keepsOrder = rows.count - newIndex == previousIds.count
            && zip(rows[newIndex...], previousIds).allSatisfy { $0.id == $1 }
        return PrependResult(added: newIndex, changedIds: changed, keepsOrder: keepsOrder)
    }

    /// Drops all but the newest `count` persisted events (and their rows),
    /// keeping anything still streaming. Used when a long thread that was
    /// paged all the way up is left at the bottom; older pages come back
    /// through `prepend` if they're scrolled to again.
    public mutating func trim(keepingLast count: Int) {
        guard events.count > count else { return }
        events = Array(events.suffix(count))
        // What's gone can be read again.
        knownStart = false
        firstSeq = events.first?.seq ?? 0
        rebuild()
    }

    /// Applies live events (persisted or transient) and reports what changed.
    public mutating func apply(_ incoming: [Event]) -> TranscriptChange {
        var gap = false
        var rewound = false
        var late: [Event] = []
        for event in incoming {
            if !event.isTransient {
                if event.seq <= lastSeq && lastSeq != 0 {
                    if sparse, event.seq >= firstSeq, !events.contains(where: { $0.seq == event.seq }) { late.append(event) }
                    continue
                }
                if lastSeq != 0 && event.seq > lastSeq + 1 { gap = true }
                events.append(event)
                if firstSeq == 0 { firstSeq = event.seq }
                lastSeq = event.seq
                if case .threadRewound = event.payload { rewound = true }
                if PendingMessage.remove(landedIn: CollectionOfOne(event), from: &pending) { tailDirty = true }
            }
            reduce(event)
        }
        // An edit cut rows that are already showing, or events came late:
        // build them all again and have the table reload, rather than work
        // out what moved.
        if !late.isEmpty {
            events = (events + late).sorted { $0.seq < $1.seq }
            let before = rows.count
            rebuild()
            return TranscriptChange(removed: IndexSet(integersIn: 0..<before), inserted: IndexSet(integersIn: 0..<rows.count))
        }
        if rewound {
            // The runner drops messages queued behind an edited one
            // (docs/protocol.md, "Editing a message").
            pending.removeAll(where: \.queued)
            let before = rows.count
            rebuild()
            var change = TranscriptChange(removed: IndexSet(integersIn: 0..<before), inserted: IndexSet(integersIn: 0..<rows.count))
            change.gapDetected = gap
            return change
        }
        var change = refreshRows()
        change.gapDetected = gap
        return change
    }

    /// Whether an edit has cut the event at `seq`.
    public func isHidden(_ seq: Int) -> Bool {
        hidden.contains { $0.contains(seq) }
    }

    /// The seqs cut by the `thread.rewound` events among `events`, merged.
    /// A later edit can cut back over an earlier one's marker; its range
    /// still counts.
    static func hiddenRanges(_ events: [Event]) -> [ClosedRange<Int>] {
        var ranges: [ClosedRange<Int>] = []
        for event in events {
            if case .threadRewound(let rewind) = event.payload, let range = rewind.range { ranges.append(range) }
        }
        return ranges.sorted { $0.lowerBound < $1.lowerBound }
    }

    /// Opens or closes a group (`g:` id) or a file in a changes card
    /// (`ChangedFiles.expansionKey`, or its `DiffPreview.allKey` to show all
    /// of the file's diff). Opening a group inserts its items under it; the
    /// group keeps its id, so its cached height survives.
    /// The thread's summary said what's running in the background. The
    /// line at the end comes or goes (or changes its words) in place.
    public mutating func setBackground(_ tasks: [BackgroundTask]) -> TranscriptChange {
        guard tasks != background else { return TranscriptChange() }
        background = tasks
        tailDirty = true
        return refreshRows()
    }

    /// The messages sent from this app that the runner hasn't shown yet.
    /// Any that the events held already show are left out (a reload can
    /// bring one in).
    public mutating func setPending(_ list: [PendingMessage]) -> TranscriptChange {
        var list = list
        if let earliest = list.map(\.afterSeq).min() {
            PendingMessage.remove(landedIn: events.reversed().prefix { $0.seq > earliest }.reversed(), from: &list)
        }
        guard list != pending else { return TranscriptChange() }
        pending = list
        tailDirty = true
        return refreshRows()
    }

    /// Marks the transcript as having a turn underway with no
    /// `turn.started` for it: a sub-agent's events (from `threads.subagent`)
    /// carry no turns, but while it runs it should read like one, with its
    /// last group live and the working line after it. `turn` "" matches
    /// events with no turnId. Nil ends it.
    public mutating func setLiveTurn(_ turn: String?, startedAt: Date? = nil) -> TranscriptChange {
        guard turn != openTurn else { return TranscriptChange() }
        openTurn = turn
        if let turn, let startedAt { turnStarts[turn] = startedAt }
        tailDirty = true
        // The last run of work becomes (or stops being) the live group.
        if !items.isEmpty { markInserted(items.count - 1) }
        return refreshRows()
    }

    private mutating func closeOpenAsks() {
        guard let open = openAsksRow else { return }
        update(open) { content in
            if case .asks(var card) = content {
                card.isOpen = false
                content = .asks(card)
            }
        }
        openAsksRow = nil
    }

    /// Mike picked (or unpicked) answers on the card from `seq`.
    public mutating func setAskPicks(_ seq: Int, _ picks: [Int: Int]) -> TranscriptChange {
        guard askPicks[seq, default: [:]] != picks else { return TranscriptChange() }
        askPicks[seq] = picks.isEmpty ? nil : picks
        guard let cardId = asksRowForSeq[seq] else { return TranscriptChange() }
        update(cardId) { content in
            if case .asks(var card) = content {
                card.picks = picks
                content = .asks(card)
            }
        }
        return refreshRows()
    }

    /// Another runner's request was read for the card `approvalId`.
    public mutating func setStartRequest(_ approvalId: String, _ request: StartRequest) -> TranscriptChange {
        guard startRequests[approvalId] != request else { return TranscriptChange() }
        startRequests[approvalId] = request
        let id = "ap:\(approvalId)"
        guard itemIndex[id] != nil else { return TranscriptChange() }
        update(id) { content in
            if case .approval(var item) = content {
                item.startRequest = request
                content = .approval(item)
            }
        }
        return refreshRows()
    }

    /// Mike wrote or pasted in the Something else boxes on the card from `seq`.
    public mutating func setAskNotes(_ seq: Int, _ notes: [Int: AskNote]) -> TranscriptChange {
        guard askNotes[seq, default: [:]] != notes else { return TranscriptChange() }
        askNotes[seq] = notes.isEmpty ? nil : notes
        guard let cardId = asksRowForSeq[seq] else { return TranscriptChange() }
        update(cardId) { content in
            if case .asks(var card) = content {
                card.notes = notes
                content = .asks(card)
            }
        }
        return refreshRows()
    }

    /// The thread's summary has a new loose-ends check (or none): it goes
    /// on the done card it's for.
    public mutating func setLooseEnds(_ check: LooseEnds?) -> TranscriptChange {
        guard check != looseEnds else { return TranscriptChange() }
        let old = looseEnds
        looseEnds = check
        var touched = false
        for seq in Set([old?.seq, check?.seq].compactMap { $0 }) {
            guard let cardId = asksRowForSeq[seq] else { continue }
            update(cardId) { content in
                if case .asks(var card) = content, card.isDone {
                    card.looseEnds = check?.seq == seq ? check?.ends : nil
                    content = .asks(card)
                }
            }
            touched = true
        }
        return touched ? refreshRows() : TranscriptChange()
    }

    /// Mike ticked (or unticked) follow-ups on the done card from `seq`.
    public mutating func setNextPicks(_ seq: Int, _ picks: Set<Int>, explain: Set<Int> = []) -> TranscriptChange {
        guard nextPicks[seq, default: []] != picks || nextExplains[seq, default: []] != explain else { return TranscriptChange() }
        nextPicks[seq] = picks.isEmpty ? nil : picks
        nextExplains[seq] = explain.isEmpty ? nil : explain
        guard let cardId = asksRowForSeq[seq] else { return TranscriptChange() }
        update(cardId) { content in
            if case .asks(var card) = content {
                card.pickedNext = picks
                card.explainNext = explain
                content = .asks(card)
            }
        }
        return refreshRows()
    }

    public mutating func setExpanded(_ key: String, _ open: Bool) -> TranscriptChange {
        guard expanded.contains(key) != open else { return TranscriptChange() }
        DiffPreview.set(key, open: open, in: &expanded)
        let rowId = key.hasPrefix("cf:") ? String(key[..<(key.firstIndex(of: "|") ?? key.endIndex)]) : key
        guard let position = index[rowId] else { return TranscriptChange() }
        markUpdated(rowStarts[position])
        return refreshRows()
    }

    // MARK: - Items

    private mutating func rebuild() {
        // Items and rows whose content comes out the same keep their
        // version, so their cached renders and heights stay valid. The old
        // rows stay in place until the new ones are built: derived rows
        // (groups, cards) look their old versions up there.
        let previous = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        items = []
        itemIndex = [:]
        planRowForTurn = [:]
        planTakingSteps = nil
        planStepsTurn = nil
        planApprovals = []
        pressedRuns = []
        asksRowForSeq = [:]
        openAsksRow = nil
        errorRowForTurn = [:]
        turnStarts = [:]
        lastTurnEnd = nil
        messagedTurns = []
        startedTurns = []
        hidden = Self.hiddenRanges(events)
        completedTurns = []
        summarizedTurns = []
        repliedTurns = []
        editsByTurn = [:]
        resultSeqs = [:]
        pendingCards = [:]
        approvalForTool = [:]
        openTurn = nil
        items.reserveCapacity(events.count)
        // Set aside what's streaming now before replaying history: a
        // `turn.completed` in the history (any earlier turn) would otherwise
        // end it, and the live text would vanish.
        let pending = streaming
        streaming = [:]
        for event in events where !isHidden(event.seq) {
            reduce(event)
        }
        streaming = [:]
        // Re-add anything still streaming, unless the history now has its
        // persisted text. Reducing a delta puts it back in `streaming`.
        for (itemId, item) in pending.sorted(by: { $0.key < $1.key }) {
            if itemIndex[(item.kind == .reasoning ? "r:" : "a:") + itemId] != nil { continue }
            let deltaPayload: EventPayload = item.kind == .reasoning
                ? .reasoningDelta(itemId: itemId, text: item.text)
                : .assistantTextDelta(itemId: itemId, text: item.text)
            reduce(Event(seq: lastSeq, threadId: "", type: "", payload: deltaPayload))
        }
        for i in items.indices {
            if let old = previous[items[i].id], old.content == items[i].content {
                items[i].version = old.version
            }
        }
        // A turn whose start is on an older page (a long run of more than
        // a page of events) still counts as running if nothing in this page
        // finished it. A page that has the turn's message would have its
        // start too.
        if openTurn == nil, hasOlderEvents, let first = events.first?.turnId,
           events.last(where: { $0.turnId != nil })?.turnId == first, !completedTurns.contains(first),
           !events.contains(where: { event in
               if case .userMessage = event.payload { return event.turnId == first }
               return false
           }) {
            openTurn = first
        }
        let built = buildRows(from: 0)
        rows = built.rows
        rowStarts = built.starts
        index = Dictionary(rows.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        dirtyUpdate = nil
        dirtyInsert = nil
        dirtyUpdateEnd = 0
        tailDirty = false
    }

    private mutating func markUpdated(_ itemIndex: Int) {
        guard itemIndex < items.count else { return markInserted(itemIndex) }
        dirtyUpdate = min(dirtyUpdate ?? itemIndex, itemIndex)
        dirtyUpdateEnd = max(dirtyUpdateEnd, runEnd(itemIndex))
        // An edit in a finished turn changes its changes card too.
        if case .tool(let tool) = items[itemIndex].content, !tool.diffs.isEmpty || tool.call.map(DiffBuilder.isEditTool) == true,
           let footer = self.itemIndex["f:" + (items[itemIndex].turnId ?? "")] {
            dirtyUpdateEnd = max(dirtyUpdateEnd, footer + 1)
        }
    }

    private mutating func markInserted(_ itemIndex: Int) {
        dirtyInsert = min(dirtyInsert ?? itemIndex, itemIndex)
    }

    private mutating func append(_ row: TranscriptRow) {
        var row = row
        row.version = RowVersion.next()
        markInserted(items.count)
        itemIndex[row.id] = items.count
        items.append(row)
    }

    /// Inserts right after the item with `afterId` (used for a tool's images).
    private mutating func insert(_ row: TranscriptRow, after afterId: String) {
        guard let anchor = itemIndex[afterId], anchor < items.count - 1 else {
            append(row)
            return
        }
        var row = row
        row.version = RowVersion.next()
        items.insert(row, at: anchor + 1)
        for i in (anchor + 1)..<items.count { itemIndex[items[i].id] = i }
        markInserted(anchor + 1)
    }

    private mutating func update(_ id: String, _ body: (inout RowContent) -> Void) {
        guard let i = itemIndex[id] else { return }
        body(&items[i].content)
        items[i].version = RowVersion.next()
        markUpdated(i)
    }

    /// A tool call got its row (`t:` id): the approval that asked about it,
    /// if any, stops opening to the same thing once it's settled. The
    /// runner sends the call first, but an older page can bring the
    /// approval after it.
    private mutating func noteToolRow(_ id: String) {
        guard let approval = approvalForTool[id],
              case .approval(let existing)? = item(id: approval)?.content, !existing.toolShown else { return }
        update(approval) { content in
            if case .approval(var item) = content {
                item.toolShown = true
                content = .approval(item)
            }
        }
    }

    private mutating func noteEdit(_ itemId: String, turnId: String?) {
        let key = turnId ?? ""
        if editsByTurn[key]?.contains(itemId) != true { editsByTurn[key, default: []].append(itemId) }
    }

    static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    static let iso = Date.ISO8601FormatStyle()

    static func date(_ ts: String) -> Date? {
        guard !ts.isEmpty else { return nil }
        return (try? Date(ts, strategy: isoFractional)) ?? (try? Date(ts, strategy: iso))
    }

    private mutating func reduce(_ event: Event) {
        let seq = event.seq
        let turnId = event.turnId
        switch event.payload {
        case .userMessage(let text, let images, let origin, let answers, let editOf, let review):
            // Mike's reply answers the open card, so it goes, picked or not.
            if origin != "runner" { closeOpenAsks() }
            var message = UserMessage(text: text, images: images, origin: origin, answers: answers, editOf: editOf, review: review)
            // Only one that started its own turn can be cut back to; one
            // sent into a running turn went into that turn.
            message.editable = message.isMike && turnId.map { !startedTurns.contains($0) } == true
            if let turnId { messagedTurns.insert(turnId) }
            append(TranscriptRow(id: "u:\(seq)", seq: seq, turnId: turnId, content: .user(message)))

        case .threadRewound(let rewind):
            // Mike's edit closes the card the cut turns left, as his reply would.
            closeOpenAsks()
            append(TranscriptRow(id: "rw:\(seq)", seq: seq, turnId: turnId, content: .note(rewind.summary)))

        case .assistantText(let itemId, let text, let summary, _, let givesWay, _) where summary:
            // The turn's summary is its reply: what the agent wrote before it
            // folds into the work, so the turn reads as one line of work,
            // the bullets, then the card (docs/protocol.md, "The summary").
            let id = "a:\(itemId)"
            guard itemIndex[id] == nil, !text.isEmpty else { break }
            if let turnId, !summarizedTurns.contains(turnId) {
                summarizedTurns.insert(turnId)
                if let first = items.firstIndex(where: { $0.turnId == turnId }) { markInserted(first) }
            }
            append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .assistant(TextItem(itemId: itemId, text: text, isSummary: true, givesWay: givesWay))))

        case .assistantText(let itemId, let text, _, let narration, _, let final):
            streaming[itemId] = nil
            if final, let turnId { repliedTurns.insert(turnId) }
            let id = "a:\(itemId)"
            let thought = "r:\(itemId)"
            if itemIndex[id] == nil, let i = itemIndex[thought], case .reasoning(let live) = items[i].content, live.isStreaming {
                // A reply the CLI sent as a thinking block signed as
                // narration (runner: isNarration in normalize.ts) streams as
                // reasoning and lands as text: it takes that row's place.
                var row = TranscriptRow(id: id, seq: items[i].seq, turnId: items[i].turnId, content: .assistant(TextItem(itemId: itemId, text: text, isNarration: narration, isFinal: final)))
                row.version = RowVersion.next()
                items[i] = row
                itemIndex[thought] = nil
                itemIndex[id] = i
                markInserted(i)
            } else if itemIndex[id] != nil {
                update(id) { $0 = .assistant(TextItem(itemId: itemId, text: text, isNarration: narration, isFinal: final)) }
            } else if !text.isEmpty {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .assistant(TextItem(itemId: itemId, text: text, isNarration: narration, isFinal: final))))
            }

        case .reasoning(let itemId, let text):
            streaming[itemId] = nil
            let id = "r:\(itemId)"
            if itemIndex[id] != nil {
                update(id) { $0 = .reasoning(TextItem(itemId: itemId, text: text)) }
            } else if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .reasoning(TextItem(itemId: itemId, text: text))))
            }

        case .assistantTextDelta(let itemId, let text):
            let id = "a:\(itemId)"
            if itemIndex[id] != nil {
                update(id) { content in
                    if case .assistant(var item) = content {
                        item.text += text
                        item.isStreaming = true
                        content = .assistant(item)
                    }
                }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .assistant(TextItem(itemId: itemId, text: text, isStreaming: true))))
            }
            if case .assistant(let item)? = self.item(id: id)?.content { streaming[itemId] = (.assistant, item.text) }

        case .reasoningDelta(let itemId, let text):
            let id = "r:\(itemId)"
            if itemIndex[id] != nil {
                update(id) { content in
                    if case .reasoning(var item) = content {
                        item.text += text
                        item.isStreaming = true
                        content = .reasoning(item)
                    }
                }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .reasoning(TextItem(itemId: itemId, text: text, isStreaming: true))))
            }
            if case .reasoning(let item)? = self.item(id: id)?.content { streaming[itemId] = (.reasoning, item.text) }

        case .streamingText(let itemId, let isReasoning, let text):
            let kind: RowKind = isReasoning ? .reasoning : .assistant
            let id = (isReasoning ? "r:" : "a:") + itemId
            let make: (String) -> RowContent = { text in
                let item = TextItem(itemId: itemId, text: text, isStreaming: true)
                return isReasoning ? .reasoning(item) : .assistant(item)
            }
            if let i = itemIndex[id] {
                // A row with persisted text is final; leave it alone.
                switch items[i].content {
                case .assistant(let item) where item.isStreaming, .reasoning(let item) where item.isStreaming:
                    update(id) { $0 = make(text) }
                    streaming[itemId] = (kind, text)
                default:
                    break
                }
            } else if !text.isEmpty {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: make(text)))
                streaming[itemId] = (kind, text)
            }

        case .toolCall(let call):
            let id = "t:\(call.itemId)"
            if itemIndex[id] != nil {
                // The result arrived first (it was on a newer page); fill in the call.
                update(id) { content in
                    if case .tool(var tool) = content {
                        tool.call = call
                        content = .tool(tool)
                    }
                }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .tool(ToolItem(itemId: call.itemId, call: call, root: root))))
                noteToolRow(id)
            }
            if DiffBuilder.isEditTool(call) { noteEdit(id, turnId: turnId) }

        case .toolResult(let result):
            let id = "t:\(result.itemId)"
            resultSeqs[id] = seq
            if itemIndex[id] != nil {
                update(id) { content in
                    if case .tool(var tool) = content {
                        tool.result = result
                        tool.liveOutput = ""
                        content = .tool(tool)
                    }
                }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .tool(ToolItem(itemId: result.itemId, result: result, root: root))))
                noteToolRow(id)
            }
            if !result.images.isEmpty {
                let imagesId = "i:\(result.itemId)"
                var generated = false
                if case .tool(let tool)? = item(id: id)?.content { generated = tool.toolKind == .image }
                let content = RowContent.images(itemId: result.itemId, images: result.images, generated: generated)
                if itemIndex[imagesId] != nil {
                    update(imagesId) { $0 = content }
                } else {
                    insert(TranscriptRow(id: imagesId, seq: seq, turnId: turnId, content: content), after: id)
                }
            }

        case .toolOutputDelta(let itemId, let text):
            update("t:\(itemId)") { content in
                if case .tool(var tool) = content, tool.result == nil {
                    tool.liveOutput += text
                    // Keep only the tail; it's a live peek, not the record.
                    if tool.liveOutput.utf8.count > 32_768 {
                        tool.liveOutput = String(tool.liveOutput.suffix(16_384))
                    }
                    content = .tool(tool)
                }
            }

        case .editDiff(let diff):
            // Nothing to attach a diff with no item to, and nothing to show
            // for one with no hunks.
            guard !diff.itemId.isEmpty, !diff.hunks.isEmpty else { break }
            let id = "t:\(diff.itemId)"
            if itemIndex[id] != nil {
                update(id) { content in
                    if case .tool(var tool) = content {
                        tool.add(diff)
                        content = .tool(tool)
                    }
                }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .tool(ToolItem(itemId: diff.itemId, diffs: [diff], root: root))))
                noteToolRow(id)
            }
            noteEdit(id, turnId: turnId)

        case .approvalRequested(let request) where request.name == "ExitPlanMode" && itemIndex["pl:" + (request.itemId ?? "")] != nil:
            // Claude's plan waiting on its ExitPlanMode call: the plan card
            // is its card. Still pending, so Return in an empty composer
            // approves it and the turn reads as waiting on Mike.
            pendingCards["ap:\(request.approvalId)"] = turnId ?? ""
            planApprovals.insert(request.approvalId)
            tailDirty = true

        case .approvalRequested(let request):
            let id = "ap:\(request.approvalId)"
            // A subagent's tools have no item id, and no row of their own.
            let toolId = request.itemId.flatMap { $0.isEmpty ? nil : "t:" + $0 }
            if let toolId { approvalForTool[toolId] = id }
            let shown = toolId.map { itemIndex[$0] != nil } ?? false
            append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .approval(ApprovalItem(request: request, root: root, toolShown: shown, startRequest: startRequests[request.approvalId]))))
            pendingCards[id] = turnId ?? ""
            tailDirty = true

        case .questionRequested(let request):
            let id = "q:\(request.approvalId)"
            append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .question(QuestionItem(request: request))))
            pendingCards[id] = turnId ?? ""
            tailDirty = true

        case .secretRequested(let request):
            // `s:` keeps it out of pendingApprovalIds: Return in an empty
            // composer must never answer a secret card.
            let id = "s:\(request.approvalId)"
            append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .secret(SecretItem(request: request))))
            pendingCards[id] = turnId ?? ""
            tailDirty = true

        case .reviewUpdated(let review):
            let id = "review:\(review.id)"
            if let existing = item(id: id), case .review(let previous) = existing.content {
                // A stale snapshot must not turn an answered review back
                // into a pending request after reconnecting.
                if review.revision > previous.revision {
                    update(id) { $0 = .review(review) }
                }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .review(review)))
            }

        case .approvalResolved(let resolution):
            if planApprovals.remove(resolution.approvalId) != nil {
                pendingCards["ap:\(resolution.approvalId)"] = nil
                tailDirty = true
            }
            for id in ["ap:\(resolution.approvalId)", "q:\(resolution.approvalId)", "s:\(resolution.approvalId)"] where itemIndex[id] != nil {
                pendingCards[id] = nil
                tailDirty = true
                update(id) { content in
                    switch content {
                    case .approval(var item):
                        item.resolution = resolution
                        content = .approval(item)
                    case .question(var item):
                        item.resolution = resolution
                        content = .question(item)
                    case .secret(var item):
                        item.resolution = resolution
                        content = .secret(item)
                    default:
                        break
                    }
                }
            }

        case .planProposed(let itemId, let text):
            let id = "pl:\(itemId)"
            planTakingSteps = nil
            if itemIndex[id] != nil {
                update(id) { $0 = .planCard(PlanCard(itemId: itemId, text: text)) }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .planCard(PlanCard(itemId: itemId, text: text))))
            }

        case .planResolved(let itemId, let go):
            let id = "pl:\(itemId)"
            update(id) { content in
                if case .planCard(var card) = content {
                    card.state = go ? .approved : .sentBack
                    content = .planCard(card)
                }
            }
            if go, itemIndex[id] != nil {
                planTakingSteps = id
                planStepsTurn = turnId
            }

        case .planUpdated(let entries):
            let key = turnId ?? "seq\(seq)"
            if let id = planTakingSteps, itemIndex[id] != nil {
                // The approved plan's own steps: its card becomes the checklist.
                planRowForTurn[key] = id
                update(id) { content in
                    if case .planCard(var card) = content {
                        card.entries = entries
                        content = .planCard(card)
                    }
                }
            } else if let id = planRowForTurn[key], itemIndex[id] != nil {
                update(id) { $0 = .plan(entries) }
            } else {
                let id = "p:\(seq)"
                planRowForTurn[key] = id
                append(TranscriptRow(id: id, seq: seq, turnId: turnId, content: .plan(entries)))
            }

        case .turnStarted(let wokeBy):
            let key = turnId ?? ""
            if planTakingSteps != nil, planStepsTurn == nil { planStepsTurn = key }
            openTurn = key
            startedTurns.insert(key)
            if let date = Self.date(event.ts) { turnStarts[key] = date }
            // A turn nobody's message started: the agent picked up again
            // as background work finished. Mark how long it was away.
            if !messagedTurns.contains(key), let from = lastTurnEnd, let to = turnStarts[key], itemIndex["gap:\(key)"] == nil {
                append(TranscriptRow(id: "gap:\(key)", seq: seq, turnId: turnId, content: .gap(TurnGap(from: from, to: to, wokeBy: wokeBy))))
            }
            // Nothing new to show but the working line (and a live group).
            markInserted(items.count)

        case .turnCompleted(let completion):
            // A turn that ends leaves nothing streaming.
            finishStreaming()
            let key = completion.turnId.isEmpty ? (turnId ?? "seq\(seq)") : completion.turnId
            completedTurns.insert(key)
            if planTakingSteps != nil, planStepsTurn == key {
                planTakingSteps = nil
                planStepsTurn = nil
            }
            if let date = Self.date(event.ts) { lastTurnEnd = date }
            if let turnId { completedTurns.insert(turnId) }
            if let open = openTurn, open == key || open == turnId || completion.turnId.isEmpty {
                openTurn = nil
            }
            // The error row just before says why, once the runner knows.
            if let kind = completion.errorKind, let errorId = errorRowForTurn[key] ?? turnId.flatMap({ errorRowForTurn[$0] }) {
                update(errorId) { content in
                    if case .error(let message, _) = content { content = .error(message, kind: kind) }
                }
            }
            let id = "f:\(key)"
            if itemIndex[id] != nil {
                update(id) { $0 = .footer(completion) }
            } else {
                append(TranscriptRow(id: id, seq: seq, turnId: turnId ?? completion.turnId, content: .footer(completion)))
                // Any finished turn closes the last card; one that needs
                // Mike opens the next, under its footer.
                closeOpenAsks()
                // The card sits under the turn's footer, its answers
                // picked there and sent from the composer (Mike, 28 Oct).
                if completion.outcome == .completed, completion.needs == "you", !completion.asks.isEmpty {
                    let cardId = "ak:\(seq)"
                    append(TranscriptRow(id: cardId, seq: seq, turnId: turnId ?? completion.turnId, content: .asks(AsksCard(seq: seq, asks: completion.asks, ticked: Set(completion.asks.indices.filter { completion.asks[$0].ticked }), picks: askPicks[seq] ?? [:], notes: askNotes[seq] ?? [:]))))
                    asksRowForSeq[seq] = cardId
                    openAsksRow = cardId
                } else if completion.outcome == .completed, completion.needs == "nothing" {
                    // The done card: goes, as an asks card does, once Mike
                    // replies or the next turn ends.
                    let cardId = "ak:\(seq)"
                    append(TranscriptRow(id: cardId, seq: seq, turnId: turnId ?? completion.turnId, content: .asks(AsksCard(seq: seq, asks: [], next: completion.next, pickedNext: nextPicks[seq] ?? [], explainNext: nextExplains[seq] ?? [], looseEnds: looseEnds?.seq == seq ? looseEnds?.ends : nil))))
                    asksRowForSeq[seq] = cardId
                    openAsksRow = cardId
                }
            }

        case .asksTicked(let asksSeq, let ticked):
            if let cardId = asksRowForSeq[asksSeq] {
                update(cardId) { content in
                    if case .asks(var card) = content {
                        card.ticked = Set(ticked)
                        content = .asks(card)
                    }
                }
            }

        case .systemNote(let text):
            append(TranscriptRow(id: "n:\(seq)", seq: seq, turnId: turnId, content: .note(text)))

        case .error(let message):
            append(TranscriptRow(id: "e:\(seq)", seq: seq, turnId: turnId, content: .error(message)))
            if let turnId { errorRowForTurn[turnId] = "e:\(seq)" }

        case .actionRun(let run):
            // A finished command, drawn like a tool call with its output.
            let itemId = run.itemId(seq: seq)
            var (call, result) = run.asToolCall
            call.itemId = itemId
            result.itemId = itemId
            if run.trigger == nil { pressedRuns.insert("t:\(itemId)") }
            append(TranscriptRow(id: "t:\(itemId)", seq: seq, turnId: turnId, content: .tool(ToolItem(itemId: itemId, call: call, result: result, root: root))))

        case .buttonUpdated:
            // No row: the reply that links it draws it (ReplyButtons).
            break

        case .unknown:
            break
        }
    }

    private mutating func finishStreaming() {
        guard !streaming.isEmpty else { return }
        for (itemId, item) in streaming {
            let id = (item.kind == .reasoning ? "r:" : "a:") + itemId
            update(id) { content in
                switch content {
                case .assistant(var text):
                    text.isStreaming = false
                    content = .assistant(text)
                case .reasoning(var text):
                    text.isStreaming = false
                    content = .reasoning(text)
                default:
                    break
                }
            }
        }
        streaming = [:]
    }

    // MARK: - Rows

    /// Work that folds into groups: thinking, tool calls, system notes and
    /// approvals Mike allowed. Everything else (messages, plans, images,
    /// errors, footers, and cards still waiting or turned down) ends a run
    /// and is never hidden in one. In "Ask before edits" threads every
    /// allowed edit used to split the turn's work into a card, the edit
    /// and a second group.
    static func isWork(_ row: TranscriptRow) -> Bool {
        switch row.content {
        case .tool(let tool): return !isTakenEndTurn(tool)
        case .note where row.content.isWakeNote: return false
        case .reasoning, .note: return true
        case .approval(let item): return item.isAllowed
        default: return false
        }
    }

    /// An end_turn call the runner took (or hasn't answered yet). It isn't
    /// shown: the card under the turn's footer says what it said, and its
    /// result ("Noted: this thread is done. Stop here...") is for the
    /// agent (Mike, 29 Oct). A refused one stays, as work, since the turn
    /// carried on because of it.
    static func isTakenEndTurn(_ tool: ToolItem) -> Bool {
        guard let name = tool.call?.name, name.hasPrefix("mcp__threadbear"), name.hasSuffix("__end_turn") else { return false }
        return tool.result?.ok ?? true
    }

    /// `isWork`, plus a summarized turn's own messages, which fold into
    /// its work under the summary.
    private func isWork(_ row: TranscriptRow) -> Bool {
        if case .assistant(let text) = row.content, !text.isSummary, let turn = row.turnId, summarizedTurns.contains(turn) { return true }
        return Self.isWork(row)
    }

    /// The items of the finished stretch (`doneBlock`) or, while a later
    /// turn in its stretch still runs, the finished turn item `i` is in (a
    /// turn's items are together). A finished turn shows as Mike's
    /// messages, one line of work, its reply and its cards, like Codex
    /// desktop (Mike, 29 Oct): the agent's notes, thinking and tools all
    /// fold into that line.
    private func doneTurn(_ i: Int) -> Range<Int>? {
        if let block = doneBlock(i) { return block }
        guard i >= 0, i < items.count, let turn = items[i].turnId, completedTurns.contains(turn) else { return nil }
        var low = i
        while low > 0, items[low - 1].turnId == turn { low -= 1 }
        var high = i + 1
        while high < items.count, items[high].turnId == turn { high += 1 }
        return low..<high
    }

    /// A message from Mike (or a schedule, or another thread's agent) that
    /// started a turn of its own. The runner's messages (the app restarted,
    /// a hook ran, the resume after a restart) carry on from the turn
    /// before, and one Mike sent into a running turn went into that turn.
    private func startsBlock(_ k: Int) -> Bool {
        guard case .user(let message) = items[k].content, !message.isFromRunner else { return false }
        guard let turn = items[k].turnId else { return true }
        var j = k - 1
        while j >= 0, items[j].turnId == nil { j -= 1 }
        return j < 0 || items[j].turnId != turn
    }

    /// The first item of the stretch item `i` is in: the message that
    /// started it, or the first item held.
    private func blockStart(_ i: Int) -> Int {
        var low = min(i, items.count - 1)
        while low > 0, !startsBlock(low) { low -= 1 }
        return max(0, low)
    }

    /// The finished part of item `i`'s stretch: from the message that
    /// started it up to the next one, or to the first item of a turn still
    /// going. Mike's message, the turn it started, the runner's turns after
    /// it and the notes between show as one line of work and one reply.
    /// Mike, 29 Oct: an agent that waited for the app to restart and
    /// checked its change left two summaries with the restart notes between
    /// them, and he couldn't tell which to read.
    private func doneBlock(_ i: Int) -> Range<Int>? {
        guard i >= 0, i < items.count else { return nil }
        // An item of a running turn is never in a finished stretch, and
        // this is most of what's asked while a turn streams.
        if let turn = items[i].turnId, !isFinished(turn) { return nil }
        let low = blockStart(i)
        var high = low
        while high < items.count, high == low || !startsBlock(high) {
            if let turn = items[high].turnId, !isFinished(turn) { break }
            high += 1
        }
        guard i < high, items[low..<high].contains(where: { $0.turnId != nil }) else { return nil }
        return low..<high
    }

    private func isFinished(_ turn: String) -> Bool {
        completedTurns.contains(turn) && turn != openTurn
    }

    /// A finished turn's reply (`reply(of:)`). In a stretch with the
    /// runner's turns in it, each turn from the one with the last summary
    /// on (each turn, without one) has a reply, so a turn that ended on a
    /// line rather than a summary isn't folded away behind the one before.
    /// Only a turn with a message of its own can take over like that: the
    /// runner's are told their summary covers the stretch, but a wake-up
    /// (the CLI's own turn, as a background job ended) isn't, and on 1 Nov
    /// 2026 what one said was "still waiting on you".
    private func replies(in turn: Range<Int>) -> Set<Int> {
        // Items with no turn id (live text not yet given one) are a turn
        // of their own, "".
        var turns: [String] = []
        for k in turn where !turns.contains(items[k].turnId ?? "") { turns.append(items[k].turnId ?? "") }
        let messaged = Set(turn.compactMap { k -> String? in
            if case .user = items[k].content { return items[k].turnId ?? "" }
            return nil
        })
        let summary = turn.last { textItem($0)?.isSummary == true && messaged.contains(items[$0].turnId ?? "") }
        let from = summary.flatMap { turns.firstIndex(of: items[$0].turnId ?? "") } ?? 0
        var out: Set<Int> = []
        for id in turns[from...] { out.formUnion(reply(of: turn.filter { (items[$0].turnId ?? "") == id })) }
        return out
    }

    /// One turn's reply: the messages it wrote after its last real step
    /// and before its end_turn, when they say more than its summary; else
    /// its summary; else its last message.
    ///
    /// The summary alone hid the answer twice on 29 Oct 2026: a turn that
    /// only explained something to Mike showed "Explained the choice
    /// above" over a folded explanation, and a Sentry triage turn's full
    /// report folded away under four bullets that didn't say what was
    /// broken. Mike: everything before the last step is the work, what
    /// comes after it is what he should see. A sign-off line ("Landed.")
    /// is shorter than the bullets, so they still win over it. Text after
    /// end_turn counts only in a turn with no words of its own before it:
    /// otherwise it's a repeat of the card (an agent wrote "What I need
    /// from you" there and it took the answer's place), or Codex's final
    /// answer, which follows its end_turn by design. With no words before,
    /// it's the message the bullets stood for, which end_turn asked for
    /// and the runner kept: on 30 Oct 2026 the details for a call to
    /// Qantas came after "Put together the details you'll need" (runner
    /// needs.ts, BULLETS_ONLY).
    private func reply(of turn: [Int]) -> Set<Int> {
        let text = textItem
        // A message sent into the turn (the runner's "the app restarted")
        // starts a fresh answer, so only an end_turn after it ends this
        // one: on 30 Oct 2026 a restart landed between end_turn and the
        // message it asked for, and everything after it folded away
        // under the narration it was meant to replace.
        let fresh = (turn.lastIndex { k in
            if case .user = items[k].content { return true }
            return false
        }).map { $0 + 1 } ?? 0
        // The last end_turn that gave a card, not one that only added
        // archive or snooze ("Added: ..."). A second card after the same
        // message only comes once a background task finishing has woken
        // the agent (runner needs.ts, WakeRead), and the work after it is
        // the turn's latest: on 7 Nov 2026 the report after a backgrounded
        // `tb land` was refused, under a "landing now" card (thread 46de9389).
        let end = turn[fresh...].lastIndex { k in
            if case .tool(let tool) = items[k].content { return Self.isTakenEndTurn(tool) && tool.result?.text.hasPrefix("Added:") != true }
            return false
        } ?? turn[fresh...].firstIndex { k in
            if case .tool(let tool) = items[k].content { return Self.isTakenEndTurn(tool) }
            return false
        } ?? turn.count
        // One reply: the agent's message after end_turn is the reply, and
        // nothing else the turn wrote competes with it (docs/protocol.md,
        // "One reply"). So a reply can't be lost to a narration block or a
        // length rule, the reasons for everything below. One between the
        // fresh answer's start and its last card belongs to a card that
        // was replaced after a wake.
        let finals = turn.indices.filter { p in text(turn[p])?.isFinal == true && !(fresh..<end).contains(p) }.map { turn[$0] }
        if !finals.isEmpty { return Set(finals) }
        let beforeEnd = turn[..<end]
        // After the last step's row and after its result, as a message can
        // land between a call and its result. A message sent into the
        // running turn starts a new answer too; it counts by place, as live
        // text carries the seq of the event before it.
        let steps = beforeEnd.filter { k in
            if case .user = items[k].content { return true }
            return Self.isRealStep(items[k])
        }
        let lastResult = steps.compactMap { resultSeqs[items[$0].id] }.max() ?? Int.min
        let final = beforeEnd.filter { k in
            text(k).map { !$0.isSummary } == true && k > (steps.last ?? Int.min) && items[k].seq > lastResult
        }
        // The last card's own summary: one a wake replaced says what was
        // true before it (from Codex's review).
        if let summary = turn[(end < turn.count ? end : 0)...].last(where: { text($0)?.isSummary == true }) {
            // A narration block is only a paraphrase of what the agent
            // wrote, so it never beats the bullets: one about a list of 13
            // names for Paws showed instead of them (30 Oct 2026).
            var words = final.filter { text($0)?.isNarration == false }
            if words.isEmpty {
                words = turn[end...].filter { text($0).map { !$0.isSummary && !$0.isNarration } == true }
            }
            let said = words.reduce(0) { $0 + (text($1)?.text.count ?? 0) }
            // With bullet replies off, a sign-off line wins too: the agent
            // was told its message is the reply (needs.ts).
            let bar = text(summary)?.givesWay == true ? 0 : (text(summary)?.text.count ?? 0)
            return said > bar ? Set(words) : [summary]
        }
        // Words win over a narration paraphrase of them.
        let words = final.filter { text($0)?.isNarration == false }
        if !words.isEmpty { return Set(words) }
        if !final.isEmpty { return Set(final) }
        return (turn.last { text($0) != nil }).map { [$0] } ?? []
    }

    private func textItem(_ k: Int) -> TextItem? {
        if case .assistant(let text) = items[k].content { return text }
        return nil
    }

    /// A step that did something: a tool call outside Threadbear's own
    /// tools (pin, update_project, end_turn) and ToolSearch, which only
    /// loads a tool. A message after a pin is still the agent's last word.
    static func isRealStep(_ row: TranscriptRow) -> Bool {
        guard case .tool(let tool) = row.content else { return false }
        guard let name = tool.call?.name else { return true }
        return !name.hasPrefix("mcp__threadbear") && name != "ToolSearch"
    }

    /// What stays out of a finished turn's line of work: Mike's messages,
    /// the reply, errors, reviews waiting on him, pictures the agent made
    /// (the poster it was asked for is the answer), the footer and the card.
    /// The runner's messages fold in: they're how the work carried on. The
    /// note an edit of Mike's leaves stays, as it says what he did.
    /// A background subagent's card still waiting (no tool of the agent's to
    /// point at). It's drawn at the end of the transcript rather than where
    /// it came in: it stays open across turns, so that spot can be folded
    /// into a finished turn or scrolled far above the latest reply, and the
    /// thread would sit in Needs you with nothing to answer in sight (7 Nov
    /// 2026). Once answered it goes back to its place. In the turn it came
    /// in, while that's running, its place is fine, and floating it would
    /// split the run of work around it.
    private func isFloatingCard(_ k: Int) -> Bool {
        guard pendingCards[items[k].id] != nil else { return false }
        if let turn = items[k].turnId, turn == openTurn { return false }
        switch items[k].content {
        case .approval(let item): return (item.request.itemId ?? "").isEmpty
        case .question(let item): return (item.request.itemId ?? "").isEmpty
        default: return false
        }
    }

    private func staysOut(_ k: Int, replies: Set<Int>) -> Bool {
        if replies.contains(k) || items[k].id.hasPrefix("rw:") || items[k].content.isWakeNote { return true }
        switch items[k].content {
        case .user(let message): return !message.isFromRunner
        case .error, .footer, .asks, .review, .gap, .planCard: return true
        case .images(_, _, let generated): return generated
        case .tool(let tool): return Self.isTakenEndTurn(tool) || pressedRuns.contains(items[k].id)
        default: return false
        }
    }

    /// The waits in a finished stretch that get a divider, by item: only
    /// one with something of the agent's shown above and below it, as the
    /// work between folds into one line above the replies. Waits with
    /// nothing shown between them are one divider, from the first one's
    /// start to the last one's end.
    private func dividers(in turn: Range<Int>, replies: Set<Int>) -> [Int: TurnGap] {
        var out: [Int: TurnGap] = [:]
        var shownBefore = false
        var waiting: (k: Int, gap: TurnGap)?
        for k in turn {
            if case .gap(let gap) = items[k].content {
                guard shownBefore else { continue }
                if let earlier = waiting?.gap {
                    waiting = (k, TurnGap(from: earlier.from, to: gap.to, wokeBy: earlier.wokeBy + gap.wokeBy))
                } else {
                    waiting = (k, gap)
                }
                continue
            }
            guard showsInStretch(k, replies: replies) else { continue }
            if let w = waiting { out[w.k] = w.gap }
            waiting = nil
            shownBefore = true
        }
        return out
    }

    /// Something of the agent's that a finished stretch shows on its own
    /// (not Mike's message, the footer or a card that's gone).
    private func showsInStretch(_ k: Int, replies: Set<Int>) -> Bool {
        guard staysOut(k, replies: replies) else { return false }
        switch items[k].content {
        case .user, .footer, .gap: return false
        case .asks(let card): return card.isOpen
        case .tool(let tool): return !Self.isTakenEndTurn(tool)
        default: return true
        }
    }

    /// The first item of the run of work that item `i` is in (or `i`); a
    /// finished turn is one run.
    private func runStart(_ i: Int) -> Int {
        if let turn = doneTurn(i) { return turn.lowerBound }
        guard i >= 0, i < items.count, isWork(items[i]) else { return max(0, i) }
        let turn = items[i].turnId
        var j = i
        while j > 0, isWork(items[j - 1]), items[j - 1].turnId == turn { j -= 1 }
        return j
    }

    /// One past the last item of the run that item `i` is in (or `i + 1`).
    private func runEnd(_ i: Int) -> Int {
        if let turn = doneTurn(i) { return turn.upperBound }
        guard i >= 0, i < items.count, isWork(items[i]) else { return min(items.count, i + 1) }
        let turn = items[i].turnId
        var j = i + 1
        while j < items.count, isWork(items[j]), items[j].turnId == turn { j += 1 }
        return j
    }

    /// The step a work: link in turn `turnId` means (WorkLinks.step), and
    /// the group row it's folded into, nil when it's shown as itself.
    public func workStep(_ quote: String, turn turnId: String) -> (rowId: String, groupId: String?)? {
        let turnItems = items.lazy.filter { $0.turnId == turnId }
        var found = WorkLinks.step(for: quote, in: turnItems)
        // A runner's turn's summary covers its whole stretch, so it can
        // point at a step from the turn Mike's message started.
        if found == nil, let first = items.firstIndex(where: { $0.turnId == turnId }), let block = doneBlock(first) {
            found = WorkLinks.step(for: quote, in: items[block])
        }
        guard let row = found, let i = itemIndex[row.id] else { return nil }
        if let turn = doneTurn(i) {
            let replies = replies(in: turn)
            if staysOut(i, replies: replies) { return (row.id, nil) }
            return (row.id, turn.first { !staysOut($0, replies: replies) }.map { "g:" + items[$0].id })
        }
        let start = runStart(i)
        return (row.id, runEnd(i) - start > 1 ? "g:" + items[start].id : nil)
    }

    /// The first row standing for item `item` or a later one.
    private func firstRow(atOrAfter item: Int) -> Int {
        var low = 0, high = rowStarts.count
        while low < high {
            let mid = (low + high) / 2
            if rowStarts[mid] < item { low = mid + 1 } else { high = mid }
        }
        return low
    }

    /// Brings `rows` up to date with the items changed since the last call
    /// and says what changed. New items rebuild from the first run they
    /// touch to the end (nearly always just the current turn); changes in
    /// place only rebuild the runs they're in.
    private mutating func refreshRows() -> TranscriptChange {
        guard dirtyUpdate != nil || dirtyInsert != nil || tailDirty else { return TranscriptChange() }
        var start = items.count
        var end = items.count
        // A changed item can change its group's summary.
        if let changed = dirtyUpdate { start = min(start, runStart(changed)) }
        // A new item can join the run before it, or end it (so it's no longer
        // the live group).
        if let added = dirtyInsert {
            start = min(start, runStart(added), runStart(added - 1))
            // A new turn or a note can join a finished stretch or end it
            // (doneBlock), which changes rows back to its first message.
            if added > 0, added < items.count, items[added].turnId != items[added - 1].turnId {
                start = min(start, blockStart(added))
            }
        }
        let bounded = dirtyInsert == nil && !tailDirty
        if bounded { end = min(items.count, dirtyUpdateEnd) }
        dirtyUpdate = nil
        dirtyInsert = nil
        dirtyUpdateEnd = 0
        tailDirty = false

        let first = firstRow(atOrAfter: start)
        // Rows from `last` on stand for items past the change (and the
        // working line) and stay as they are.
        let last = bounded ? firstRow(atOrAfter: end) : rows.count
        let built = buildRows(from: start, to: end, workingLine: !bounded)

        var change = TranscriptChange()
        var kept = Set<String>(minimumCapacity: built.rows.count)
        for (offset, row) in built.rows.enumerated() {
            kept.insert(row.id)
            if let old = index[row.id], old >= first, old < last {
                let previous = rows[old]
                if previous.version != row.version || previous.inGroup != row.inGroup {
                    change.updated.insert(first + offset)
                }
            } else {
                change.inserted.insert(first + offset)
            }
        }
        for old in first..<last where !kept.contains(rows[old].id) {
            change.removed.insert(old)
            index[rows[old].id] = nil
        }
        rows.replaceSubrange(first..<last, with: built.rows)
        rowStarts.replaceSubrange(first..<last, with: built.starts)
        let shifted = built.rows.count != last - first ? rows.count : first + built.rows.count
        for position in first..<shifted { index[rows[position].id] = position }
        return change
    }

    /// The rows for items from `start` (a run boundary) up to `end`, with
    /// the working line after them while a turn runs.
    private func buildRows(from start: Int, to end: Int? = nil, workingLine: Bool = true) -> (rows: [TranscriptRow], starts: [Int]) {
        let end = end ?? items.count
        var out: [TranscriptRow] = []
        var starts: [Int] = []
        out.reserveCapacity(max(0, end - start) + 2)
        starts.reserveCapacity(out.capacity)

        // Derived rows keep their old version while their content is the same.
        func derived(_ id: String, seq: Int, turnId: String?, _ content: RowContent) -> TranscriptRow {
            if let old = index[id], rows[old].content == content {
                return rows[old]
            }
            return TranscriptRow(id: id, version: RowVersion.next(), seq: seq, turnId: turnId, content: content)
        }

        var i = start
        while i < end {
            let item = items[i]
            if let turn = doneTurn(i), i == turn.lowerBound {
                // Every row of a finished turn starts at its first item, so
                // a change anywhere in it rebuilds it whole (runStart).
                let replies = replies(in: turn)
                let folded = turn.filter { !staysOut($0, replies: replies) && !isFloatingCard($0) }
                // The line of work goes above the reply, even when the reply
                // came first: a turn that only answered has its summary
                // folded under it (reply(of:)).
                let groupAt = folded.first.map { first in min(first, replies.min() ?? first) }
                // A stretch with the runner's turns in it has a footer for
                // each: the last one stands for them all, with their time
                // and cost added up, and the changes card has every turn's
                // edits.
                let footers: [(index: Int, done: TurnCompletion)] = turn.compactMap {
                    if case .footer(let done) = items[$0].content { return ($0, done) }
                    return nil
                }
                let worked = footers.reduce(0) { $0 + $1.done.durationMs }
                let gaps = dividers(in: turn, replies: replies)
                for k in turn {
                    let row = items[k]
                    if isFloatingCard(k) { continue }
                    if k == groupAt, let first = folded.first {
                        let lead = items[first]
                        let id = "g:" + lead.id
                        let open = expanded.contains(id)
                        var group = WorkGroup(members: ArraySlice(folded.map { items[$0] }), isExpanded: open, isLive: false)
                        if worked > 0 {
                            group.summary = "Worked for " + RelativeTime.duration(milliseconds: worked)
                        }
                        out.append(derived(id, seq: lead.seq, turnId: lead.turnId, .group(group)))
                        starts.append(turn.lowerBound)
                        if open {
                            for m in folded {
                                var member = items[m]
                                member.inGroup = true
                                out.append(member)
                                starts.append(turn.lowerBound)
                            }
                        }
                        if replies.contains(k) {
                            out.append(row)
                            starts.append(turn.lowerBound)
                        }
                    } else if !staysOut(k, replies: replies) {
                        continue
                    } else if case .asks(let card) = row.content, !card.isOpen {
                        continue
                    } else if case .tool(let tool) = row.content, Self.isTakenEndTurn(tool) {
                        continue
                    } else if case .gap = row.content {
                        guard let gap = gaps[k] else { continue }
                        out.append(derived(row.id, seq: row.seq, turnId: row.turnId, .gap(gap)))
                        starts.append(turn.lowerBound)
                    } else if case .footer(var done) = row.content {
                        guard k == footers.last?.index else { continue }
                        let stretch = footers.map { items[$0.index].turnId ?? "" }
                        // A turn that ended with a summary has no changes
                        // card: the summary says what changed, and the
                        // edits are still in the folded work (Mike, 30 Oct).
                        // One reply's final message counts too: it replaced
                        // the summary, and the card came back with it (6 Nov).
                        if !stretch.contains(where: { summarizedTurns.contains($0) || repliedTurns.contains($0) }), let card = changedFiles(turns: stretch) {
                            out.append(derived("cf:" + card.turnId, seq: row.seq, turnId: row.turnId, .changes(card)))
                            starts.append(turn.lowerBound)
                        }
                        if footers.count > 1 {
                            done.durationMs = worked
                            let costs = footers.compactMap(\.done.costUsd)
                            done.costUsd = costs.isEmpty ? nil : costs.reduce(0, +)
                            out.append(derived(row.id, seq: row.seq, turnId: row.turnId, .footer(done)))
                        } else {
                            out.append(row)
                        }
                        starts.append(turn.lowerBound)
                    } else {
                        out.append(row)
                        starts.append(turn.lowerBound)
                    }
                }
                i = turn.upperBound
                continue
            }
            if isFloatingCard(i) {
                i += 1
                continue
            }
            if isWork(item) {
                let runEnd = runEnd(i)
                // A summarized turn's one message still folds away: the
                // summary is the reply.
                var foldedText = false
                if case .assistant = item.content { foldedText = true }
                if runEnd - i == 1, !foldedText {
                    // A run of one is shown as itself.
                    out.append(item)
                    starts.append(i)
                } else {
                    let id = "g:" + item.id
                    let open = expanded.contains(id)
                    let live = runEnd == items.count && openTurn != nil && (item.turnId ?? "") == openTurn
                    let group = WorkGroup(members: items[i..<runEnd], isExpanded: open, isLive: live)
                    out.append(derived(id, seq: item.seq, turnId: item.turnId, .group(group)))
                    starts.append(i)
                    if open {
                        for k in i..<runEnd {
                            var member = items[k]
                            member.inGroup = true
                            out.append(member)
                            starts.append(k)
                        }
                    }
                }
                i = runEnd
            } else if case .asks(let card) = item.content, !card.isOpen {
                // A card that's been answered or moved past isn't shown: the
                // answers bubble says what was picked (Mike, 28 Oct).
                i += 1
            } else if case .tool(let tool) = item.content, Self.isTakenEndTurn(tool) {
                i += 1
            } else {
                if case .footer = item.content, let card = changedFiles(turn: item.turnId ?? "") {
                    out.append(derived("cf:" + card.turnId, seq: item.seq, turnId: item.turnId, .changes(card)))
                    starts.append(i)
                }
                out.append(item)
                starts.append(i)
                i += 1
            }
        }
        let floating = workingLine ? pendingCards.keys.compactMap { itemIndex[$0] }.filter(isFloatingCard).sorted() : []
        for k in floating {
            out.append(items[k])
            starts.append(items.count)
        }
        if workingLine, let turn = openTurn, !pendingCards.values.contains(turn) {
            let status = WorkingStatus(turnId: turn, startedAt: turnStarts[turn])
            out.append(derived("w:" + turn, seq: lastSeq, turnId: turn, .working(status)))
            starts.append(items.count)
        } else if workingLine, openTurn == nil, !background.isEmpty, floating.isEmpty {
            // Between turns with sub-agents or jobs still going: the thread
            // is still being worked on, and this says so where the working
            // line would be. Not under a card a sub-agent is waiting on,
            // where "working" would be wrong.
            out.append(derived("bg:", seq: lastSeq, turnId: nil, .background(BackgroundStatus(tasks: background))))
            starts.append(items.count)
        }
        // Mike's messages on their way, last: under the working line, as a
        // queued one waits for that turn to end.
        if workingLine {
            for message in pending {
                out.append(derived("p:" + message.id, seq: lastSeq, turnId: nil, message.row.content))
                starts.append(items.count)
            }
        }
        return (out, starts)
    }

    /// The files a turn changed, from its Edit and Write calls that didn't
    /// fail, each with its edits' line counts added up.
    /// Claude's plan mode writes its plan to ~/.claude/plans/<name>.md. That's
    /// the CLI's own note, shown as the plan card; "Edited 1 file" for it,
    /// in a turn that changed nothing of the project's, read as a change.
    static func isPlanFile(_ path: String) -> Bool {
        path.contains("/.claude/plans/") && path.hasSuffix(".md")
    }

    private func changedFiles(turn: String) -> ChangedFiles? {
        changedFiles(turns: [turn])
    }

    /// The same for a finished stretch's turns, as one card under the
    /// last one's footer.
    private func changedFiles(turns: [String]) -> ChangedFiles? {
        guard let turn = turns.last else { return nil }
        let ids = turns.flatMap { editsByTurn[$0] ?? [] }
        guard !ids.isEmpty else { return nil }
        var order: [String] = []
        var files: [String: ChangedFile] = [:]
        for id in ids {
            guard let i = itemIndex[id], case .tool(let tool) = items[i].content, !tool.failed else { continue }
            // Every file a tool changed: a Codex patch can touch several.
            for diff in tool.effectiveDiffs where !diff.hunks.isEmpty && !Self.isPlanFile(diff.path) {
                let path = diff.path.isEmpty ? tool.title : diff.path
                let stats = DiffBuilder.stats(diff)
                if var file = files[path] {
                    file.added += stats.added
                    file.removed += stats.removed
                    file.diffs.append(diff)
                    files[path] = file
                } else {
                    order.append(path)
                    let key = ChangedFiles.expansionKey(turnId: turn, path: path)
                    files[path] = ChangedFile(path: path, added: stats.added, removed: stats.removed, diffs: [diff],
                                              isExpanded: expanded.contains(key), showsAll: expanded.contains(DiffPreview.allKey(key)), root: root)
                }
            }
        }
        guard !order.isEmpty else { return nil }
        return ChangedFiles(turnId: turn, files: order.compactMap { files[$0] })
    }
}
