import Foundation

/// The inbox's sections, top to bottom. Inbox comes first because it's
/// what Mike acts on; Running sits below it, since there's nothing to do
/// with those threads until they finish (Mike asked 27 Oct).
/// Hibernating and Archived come last: threads put away. They were views of
/// their own in the activity bar until Mike asked for them as sections
/// here (29 Oct). The heading says Archived, not Archive, so it names a
/// state like Running and Hibernating (Mike asked 29 Oct). Hibernating also
/// holds the threads that have booked themselves a message for later and
/// have nothing for him until then: they had a Waiting section of their
/// own above it (29 Oct) until Mike merged the two (3 Nov), as either way
/// it's a thread asleep until a time.
/// Starred is above them all: threads Mike wants in reach whatever they're
/// doing (1 Nov).
public enum InboxSection: String, Sendable, CaseIterable {
    case starred, inbox, running, hibernating, archived

    public var title: String {
        switch self {
        case .starred: return "Starred"
        case .inbox: return "Inbox"
        case .running: return "Running"
        case .hibernating: return "Hibernating"
        case .archived: return "Archived"
        }
    }

    /// Hibernating and Archived: threads put away rather than live ones.
    public var isPutAway: Bool { self == .hibernating || self == .archived }
}

/// How the Inbox section is ordered, from the sort menu on its heading.
/// Mike has a long inbox and wanted the oldest at the top to work through
/// it from there (29 Oct), so newest and oldest ignore `urgency` and go by
/// last activity alone.
public enum InboxOrder: String, Sendable, CaseIterable {
    case needsYou, newest, oldest

    public var title: String {
        switch self {
        case .needsYou: return "Needs you first"
        case .newest: return "Newest first"
        case .oldest: return "Oldest first"
        }
    }

    public var symbol: String {
        switch self {
        case .needsYou: return "hand.raised"
        case .newest: return "arrow.down"
        case .oldest: return "arrow.up"
        }
    }
}

/// The sidebar's sections.
public struct ThreadSections: Sendable, Equatable {
    /// Oldest star first, so they stay put while Mike goes back and forth.
    public var starred: [ThreadSummary] = []
    public var inbox: [ThreadSummary] = []
    public var running: [ThreadSummary] = []
    /// Hibernated threads and ones waiting on a schedule, soonest to wake
    /// first.
    public var hibernating: [ThreadSummary] = []
    /// Most recently archived first.
    public var archived: [ThreadSummary] = []

    public init(starred: [ThreadSummary] = [], inbox: [ThreadSummary] = [], running: [ThreadSummary] = [],
                hibernating: [ThreadSummary] = [], archived: [ThreadSummary] = []) {
        self.starred = starred
        self.inbox = inbox
        self.running = running
        self.hibernating = hibernating
        self.archived = archived
    }

    /// Running: a turn is underway, or background sub-agents or jobs are
    /// still going (an unread reply waits there with its dot until they're
    /// done: the thread isn't finished yet). Hibernating: snoozed, or idle
    /// with a schedule due to message it (`wakes`) and nothing for Mike: no
    /// question, no unread reply that didn't say "nothing", no open asks.
    /// Soonest wake first. A pending design review counts once the thread has finished
    /// working (`reviewWaiting`). Inbox: everything else, by `order`: by default what most
    /// needs Mike first (see `urgency`), newest first within that. A question or approval goes in
    /// the inbox even with background work going, since the thread is stuck
    /// until he answers, and so does a turn that ended asking him for
    /// something (`waitingOnMike`), unless sub-agents are still at it.
    /// Running is newest activity first. Snoozed and
    /// archived threads go in Hibernating and Archived, whatever their state.
    /// Starred takes a starred thread from all of these but Archived: Mike
    /// archived it, so it's done with.
    public static func build(_ threads: some Sequence<ThreadSummary>, now: Date, wakes: [String: Schedule] = [:], order: InboxOrder = .needsYou) -> ThreadSections {
        #if DEBUG
        buildCount += 1
        #endif
        var sections = ThreadSections()
        for thread in threads {
            switch section(of: thread, now: now, wakes: wakes) {
            case .starred: sections.starred.append(thread)
            case .inbox: sections.inbox.append(thread)
            case .running: sections.running.append(thread)
            case .hibernating: sections.hibernating.append(thread)
            case .archived: sections.archived.append(thread)
            }
        }
        // Each sort pulls its keys out first. A summary has dozens of fields,
        // most of them counted references, and comparing summaries copied two
        // of them per comparison: with 877 archived threads that was most of
        // what a thread update cost the main thread (THREADBEAR-1B).
        typealias Activity = (Date, String)
        let activity: (ThreadSummary) -> Activity = { ($0.lastActivityAt, $0.id) }
        let newestFirst: (Activity, Activity) -> Bool = { $0.0 != $1.0 ? $0.0 > $1.0 : $0.1 < $1.1 }
        let starredAt: (ThreadSummary) -> Activity = { ($0.starredAt ?? .distantFuture, $0.id) }
        let oldestStarFirst: (Activity, Activity) -> Bool = { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
        sections.starred.sort(key: starredAt, by: oldestStarFirst)
        switch order {
        case .needsYou:
            let urgent: (ThreadSummary) -> (Int, Activity) = { (urgency($0), activity($0)) }
            let mostUrgent: ((Int, Activity), (Int, Activity)) -> Bool = { $0.0 != $1.0 ? $0.0 < $1.0 : newestFirst($0.1, $1.1) }
            sections.inbox.sort(key: urgent, by: mostUrgent)
        case .newest:
            sections.inbox.sort(key: activity, by: newestFirst)
        case .oldest:
            let oldestFirst: (Activity, Activity) -> Bool = { newestFirst($1, $0) }
            sections.inbox.sort(key: activity, by: oldestFirst)
        }
        sections.running.sort(key: activity, by: newestFirst)
        // A snooze's time, or for one waiting on a schedule its next run.
        // Back on restart has no time, so it goes last with the topics.
        let wakesAt: (ThreadSummary) -> (Date, Activity) = { ($0.snoozedUntil ?? wakes[$0.id]?.nextRunAt ?? .distantFuture, activity($0)) }
        let soonestToWake: ((Date, Activity), (Date, Activity)) -> Bool = { $0.0 != $1.0 ? $0.0 < $1.0 : newestFirst($0.1, $1.1) }
        sections.hibernating.sort(key: wakesAt, by: soonestToWake)
        let archivedAt: (ThreadSummary) -> Date = { $0.archivedAt ?? .distantPast }
        let lastArchived: (Date, Date) -> Bool = { $0 > $1 }
        sections.archived.sort(key: archivedAt, by: lastArchived)
        return sections
    }

    #if DEBUG
    /// How many times `build` has run, for tests that hold a thread update
    /// to one sort of every thread.
    nonisolated(unsafe) public static var buildCount = 0
    #endif

    /// Where `build` puts a thread.
    private static func section(of thread: ThreadSummary, now: Date, wakes: [String: Schedule]) -> InboxSection {
        if thread.isArchived { return .archived }
        if thread.isStarred { return .starred }
        if thread.isSnoozed(at: now) { return .hibernating }
        if thread.reviewWaiting || thread.status == .waiting || thread.waitingOnMike || (thread.needsYou && !thread.isWorkingInBackground) { return .inbox }
        if thread.status == .running || thread.status == .starting || thread.isWorkingInBackground { return .running }
        if thread.status == .idle, thread.needs != "you", thread.waitingForRoom == nil, wakes[thread.id] != nil { return .hibernating }
        return .inbox
    }

    /// `build(...).needsYou.count` without sorting anything: the Dock badge
    /// asks on every thread update and only wants the number.
    public static func needsYouCount(_ threads: some Sequence<ThreadSummary>, now: Date) -> Int {
        var count = 0
        for thread in threads where wantsYou(thread) {
            switch section(of: thread, now: now, wakes: [:]) {
            case .inbox: count += 1
            case .starred where thread.snoozedUntil == nil: count += 1
            default: break
            }
        }
        return count
    }

    private static func wantsYou(_ thread: ThreadSummary) -> Bool {
        thread.reviewWaiting || thread.status == .waiting || thread.needsYou
    }

    /// For each thread a schedule will message by itself, the one due
    /// soonest. Paused and finished ones don't count, nor ones that start
    /// a new thread.
    public static func wakes(_ schedules: some Sequence<Schedule>) -> [String: Schedule] {
        var soonest: [String: Schedule] = [:]
        for schedule in schedules where schedule.isActive {
            guard let threadId = schedule.threadId, let next = schedule.nextRunAt else { continue }
            if let current = soonest[threadId]?.nextRunAt, current <= next { continue }
            soonest[threadId] = schedule
        }
        return soonest
    }

    /// How much an inbox thread wants Mike, lowest first. 0: stuck on his
    /// answer to a question or approval. 1: finished unread with a failure
    /// or cut-off turn. 2: finished unread. 3: read, but its last turn
    /// failed or was stopped, so it's still not done. 4: read and done.
    public static func urgency(_ thread: ThreadSummary) -> Int {
        let broken = thread.status == .error || thread.status == .stopped
        if thread.reviewWaiting || thread.status == .waiting { return 0 }
        if thread.needsYou { return broken ? 1 : 2 }
        return broken ? 3 : 4
    }

    /// The threads waiting on Mike or not read yet (the Dock badge): a star
    /// doesn't take one out of it, unless it's hibernating (the runner clears
    /// `snoozedUntil` when it wakes), which it wouldn't count for either.
    public var needsYou: [ThreadSummary] {
        (starred.filter { $0.snoozedUntil == nil } + inbox).filter(Self.wantsYou)
    }

    /// The live threads, not the ones put away.
    public var all: [ThreadSummary] { starred + inbox + running }

    public subscript(section: InboxSection) -> [ThreadSummary] {
        switch section {
        case .starred: return starred
        case .inbox: return inbox
        case .running: return running
        case .hibernating: return hibernating
        case .archived: return archived
        }
    }

    private static func soonestToWake(_ a: ThreadSummary, _ b: ThreadSummary) -> Bool {
        (a.snoozedUntil ?? .distantFuture) < (b.snoozedUntil ?? .distantFuture)
    }

    /// Each section cut down to the threads a search matches, in the same
    /// order: the search at the top of the sidebar.
    public func matching(_ query: String) -> ThreadSections {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return self }
        let keep: ([ThreadSummary]) -> [ThreadSummary] = { $0.filter { Self.matches($0, trimmed) } }
        return ThreadSections(starred: keep(starred), inbox: keep(inbox), running: keep(running),
                              hibernating: keep(hibernating), archived: keep(archived))
    }

    public var isEmpty: Bool { InboxSection.allCases.allSatisfy { self[$0].isEmpty } }

    public static func snoozed(_ threads: some Sequence<ThreadSummary>, now: Date) -> [ThreadSummary] {
        threads
            .filter { !$0.isArchived && $0.isSnoozed(at: now) }
            .sorted(by: soonestToWake)
    }

    /// Title or preview, case and accent insensitive.
    public static func matches(_ thread: ThreadSummary, _ query: String) -> Bool {
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        return thread.title.range(of: query, options: options) != nil
            || thread.preview.range(of: query, options: options) != nil
    }
}

private extension Array {
    /// Sorts by keys pulled out once each, moving each element only at the
    /// end, for elements too big to copy on every comparison.
    mutating func sort<Key>(key: (Element) -> Key, by inOrder: (Key, Key) -> Bool) {
        let keys = map(key)
        let order = indices.sorted { inOrder(keys[$0], keys[$1]) }
        self = order.map { self[$0] }
    }
}

/// Short relative times for the sidebar: "now", "5m", "3h", "Mon", "12 Oct".
public enum RelativeTime {
    public static func short(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(saturating: seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(saturating: seconds / 3600))h" }
        if seconds < 6 * 86_400 {
            return date.formatted(Date.FormatStyle(calendar: calendar).weekday(.abbreviated))
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        var style = Date.FormatStyle(calendar: calendar).day().month(.abbreviated)
        if !sameYear { style = style.year() }
        return date.formatted(style)
    }

    /// "in 3h", "tomorrow 9:00" style text for snoozed rows.
    public static func until(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(Date.FormatStyle(calendar: calendar).hour().minute())
        }
        return date.formatted(Date.FormatStyle(calendar: calendar).weekday(.abbreviated).hour().minute())
    }

    /// "1m 12s", "850 ms", "2h 4m".
    public static func duration(milliseconds: Double) -> String {
        if milliseconds < 1000 { return "\(Int(saturating: milliseconds)) ms" }
        let total = Int(saturating: milliseconds / 1000)
        if total < 60 { return "\(total)s" }
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3600)h \((total % 3600) / 60)m"
    }
}

/// A thread's model for the composer menu. The menu's aliases ("haiku")
/// read as words; a full id ("claude-haiku-5-5") is shown as it is, since
/// capitalising it gave "Claude-Haiku-5-5".
public enum ModelName {
    public static func display(_ model: String) -> String {
        model.allSatisfy(\.isLetter) ? model.capitalized : model
    }
}

/// A turn's cost for its footer. Small models cost well under a cent a
/// turn, which two decimals showed as "$0.00".
public enum CostText {
    public static func format(_ cost: Double?) -> String? {
        guard let cost, cost > 0 else { return nil }
        if cost >= 0.01 { return String(format: "$%.2f", cost) }
        if cost >= 0.001 { return String(format: "$%.3f", cost) }
        return "<$0.001"
    }
}

/// The runner's preview is the start of the last assistant text, which is
/// markdown. The sidebar shows it as plain words.
public enum PreviewText {
    public static func plain(_ text: String) -> String {
        var line = text
        // [label](url) reads as the label.
        // A `[` with no link after it uses up what it was tried against,
        // rather than every `[` being tried to the end again, which was
        // quadratic (cross-lab review, 7 Nov 2026). The same links match.
        line = line.replacing(/!?\[([^\]]*)(?:\]\([^)]*(\))?)?/) { $0.2 == nil ? String($0.0) : String($0.1) }
        // Heading and quote markers wherever a line started (the preview has
        // its newlines folded into spaces, so look after any whitespace too).
        line = line.replacingOccurrences(of: #"(^|\s)(#{1,6}|>)\s+"#, with: "$1", options: .regularExpression)
        for marker in ["**", "__", "~~", "`"] {
            line = line.replacingOccurrences(of: marker, with: "")
        }
        line = line.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return line.trimmingCharacters(in: .whitespaces)
    }
}
