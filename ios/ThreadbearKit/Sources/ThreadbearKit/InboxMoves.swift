import Foundation

public extension InboxSections {
    /// Whether any thread is now under a different heading, or has turned up
    /// or gone. The inbox animates only for this: a list update that changes a
    /// title or a working line leaves it still, as they can come in bursts.
    func changedHeadings(to new: InboxSections) -> Bool {
        placements != new.placements
    }

    /// The threads under a heading they weren't under before: the rows to give
    /// a done tick or unread dot to as they land, not with them.
    func landed(in new: InboxSections) -> Set<String> {
        let old = placements
        return Set(new.placements.filter { old[$0.key] != $0.value }.keys)
    }

    /// Starred, Inbox and Running as one flat run of list rows, not sections. A
    /// List fades a row out of one section and into another, even with the same
    /// id, where one flat run moves it, and a row gliding up from Running is the
    /// whole point (Mike's mockup, 7 Nov).
    func lines(folded: (PhoneSection) -> Bool) -> [InboxLine] {
        var lines: [InboxLine] = []
        func add(_ section: PhoneSection, _ threads: [PhoneThread]) {
            guard !threads.isEmpty else { return }
            lines.append(.heading(section))
            if !folded(section) { lines += threads.map { .thread($0, under: section) } }
        }
        add(.starred, starred)
        add(.inbox, inbox)
        if inbox.isEmpty, isInboxZero { lines.append(.inboxZero) }
        add(.running, running)
        return lines
    }

    private var placements: [String: PhoneSection] {
        var all: [String: PhoneSection] = [:]
        for thread in starred { all[thread.threadId] = .starred }
        for thread in inbox { all[thread.threadId] = .inbox }
        for thread in running { all[thread.threadId] = .running }
        for thread in scheduled { all[thread.threadId] = .hibernating }
        return all
    }

    /// Nothing for Mike to do: what the empty view says. A thread still running
    /// or waiting on a schedule, or a star on one that doesn't need him, doesn't
    /// stop it, as they each have a heading of their own under it.
    var isInboxZero: Bool { inbox.isEmpty && needsYouCount == 0 }
}

/// One row in the flat top of the inbox (`InboxSections.lines`).
public enum InboxLine: Identifiable, Sendable {
    case heading(PhoneSection)
    case thread(PhoneThread, under: PhoneSection)
    /// "Nothing in the inbox", in the Inbox heading's place.
    case inboxZero

    /// A thread's is its own, whichever heading it's under, so it moves.
    public var id: String {
        switch self {
        case let .heading(section): "heading:\(section.rawValue)"
        case let .thread(thread, _): thread.threadId
        case .inboxZero: "inbox-zero"
        }
    }
}

/// He's just cleared the inbox (AppModel, the moment a row he took away was the
/// last), for the empty view to wave when it appears. Never on launch.
public struct InboxCleared: Sendable, Equatable {
    private var at: Date?
    /// The row's collapse comes first, and this is a moment or nothing: cleared
    /// behind a search, the view that shows later shouldn't wave at him.
    private static let lasts: TimeInterval = 2

    public init() {}

    public mutating func note(before: InboxSections, after: InboxSections, now: Date) {
        if !before.isInboxZero, after.isInboxZero { at = now }
    }

    public func isPending(now: Date) -> Bool {
        guard let at else { return false }
        return now.timeIntervalSince(at) < Self.lasts
    }

    /// Whether to wave, once.
    public mutating func take(now: Date) -> Bool {
        defer { at = nil }
        return isPending(now: now)
    }
}
