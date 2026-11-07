import Foundation
import Testing
@testable import ThreadbearKit

/// What makes the inbox animate: a thread changing heading is news, so its row
/// glides. A title or a working line changing isn't, or a busy inbox would never
/// sit still under his thumb.
@Suite struct InboxMovesTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    private func thread(_ id: String, status: ThreadStatus = .idle, working: String? = nil, starred: Bool = false, title: String? = nil, ago: Double = 60) -> PhoneThread {
        PhoneThread(threadId: id, title: title ?? id, status: status, lastActivityAt: now.addingTimeInterval(-ago),
                    starredAt: starred ? now : nil, working: working)
    }
    private func sections(_ threads: PhoneThread...) -> InboxSections { InboxSections.build(threads, now: now) }

    @Test func aFinishedTurnMovesFromRunningToInbox() {
        let before = sections(thread("a", status: .running, working: "Running npm test"), thread("b"))
        let after = sections(thread("a"), thread("b"))
        #expect(before.changedHeadings(to: after))
    }

    @Test func aStarElsewhereMoves() {
        #expect(sections(thread("a")).changedHeadings(to: sections(thread("a", starred: true))))
    }

    @Test func aThreadTurningUpOrLeavingCounts() {
        #expect(sections(thread("a")).changedHeadings(to: sections(thread("a"), thread("b"))))
        #expect(sections(thread("a"), thread("b")).changedHeadings(to: sections(thread("a"))))
    }

    @Test func aFieldChangingStaysStill() {
        let before = sections(thread("a", status: .running, working: "Running npm test"), thread("b"))
        let after = sections(thread("a", status: .running, working: "Reading a file", title: "A new title"), thread("b", ago: 5))
        #expect(!before.changedHeadings(to: after))
    }

    @Test func aReorderInsideAHeadingStaysStill() {
        let before = sections(thread("a", ago: 10), thread("b", ago: 20))
        let after = sections(thread("a", ago: 30), thread("b", ago: 20))
        #expect(before.inbox.map(\.threadId) != after.inbox.map(\.threadId))
        #expect(!before.changedHeadings(to: after))
    }

    @Test func theRowsThatLandedAreTheOnesInANewHeading() {
        let before = sections(thread("a", status: .running, working: "Busy"), thread("b"), thread("c", starred: true))
        let after = sections(thread("a"), thread("b"), thread("c", starred: true), thread("d"))
        #expect(before.landed(in: after) == ["a", "d"])
        #expect(after.landed(in: after).isEmpty)
    }

    /// The first three headings and their rows are one flat run of list rows, so
    /// a row's id is the same under any heading and the List moves it, rather
    /// than fading it out of one section and into another.
    @Test func linesKeepARowsIdAcrossHeadings() {
        let before = sections(thread("a", status: .running, working: "Busy"), thread("b"))
        let after = sections(thread("a"), thread("b"))
        let unfolded: (PhoneSection) -> Bool = { _ in false }
        #expect(before.lines(folded: unfolded).map(\.id) == ["heading:inbox", "b", "heading:running", "a"])
        #expect(after.lines(folded: unfolded).map(\.id).contains("a"))
        #expect(!after.lines(folded: unfolded).map(\.id).contains("heading:running"))
    }

    @Test func aFoldedHeadingKeepsItsLineAndHidesItsRows() {
        let list = sections(thread("a", status: .running, working: "Busy"), thread("b", starred: true), thread("c"))
        let lines = list.lines(folded: { $0 == .running })
        #expect(lines.map(\.id) == ["heading:starred", "b", "heading:inbox", "c", "heading:running"])
    }

    @Test func anEmptyInboxHasTheEmptyLineWhereItsHeadingWas() {
        let list = sections(thread("a", status: .running, working: "Busy"))
        #expect(list.lines(folded: { _ in false }).map(\.id) == ["inbox-zero", "heading:running", "a"])
        // Under a star that needs him, nothing says the inbox is empty.
        let starred = sections(PhoneThread(threadId: "s", title: "s", needsYou: true, lastActivityAt: now, starredAt: now))
        #expect(starred.lines(folded: { _ in false }).map(\.id) == ["heading:starred", "s"])
    }
}
