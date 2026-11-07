import Foundation
import Testing
@testable import ThreadbearKit

/// The bear's wave is a reward for clearing the inbox, so it plays only when he
/// has just taken the last row away, and only the once.
@Suite struct InboxZeroTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    private func thread(_ id: String, status: ThreadStatus = .idle, working: String? = nil, needsYou: Bool = false, starred: Bool = false) -> PhoneThread {
        PhoneThread(threadId: id, title: id, status: status, needsYou: needsYou, lastActivityAt: now, starredAt: starred ? now : nil, working: working)
    }
    private func sections(_ threads: PhoneThread...) -> InboxSections { InboxSections.build(threads, now: now) }
    private func take(_ cleared: inout InboxCleared, at: Date? = nil) -> Bool { cleared.take(now: at ?? now) }

    @Test func runningOrQuietStarredThreadsDontStopIt() {
        #expect(sections().isInboxZero)
        #expect(sections(thread("a", status: .running, working: "Busy")).isInboxZero)
        #expect(sections(thread("a", starred: true)).isInboxZero)
        #expect(!sections(thread("a")).isInboxZero)
        // A star doesn't hide a thread that needs him.
        #expect(!sections(thread("a", needsYou: true, starred: true)).isInboxZero)
    }

    @Test func clearingTheLastRowWavesOnce() {
        var cleared = InboxCleared()
        cleared.note(before: sections(thread("a")), after: sections(), now: now)
        #expect(cleared.isPending(now: now))
        #expect(take(&cleared))
        #expect(!cleared.isPending(now: now))
        #expect(!take(&cleared))
    }

    @Test func anInboxAlreadyEmptyNeverWaves() {
        // Launch, or an archive from a heading that isn't the inbox.
        var cleared = InboxCleared()
        #expect(!take(&cleared))
        cleared.note(before: sections(), after: sections(), now: now)
        #expect(!take(&cleared))
    }

    @Test func aRowLeftBehindDoesntWave() {
        var cleared = InboxCleared()
        cleared.note(before: sections(thread("a"), thread("b")), after: sections(thread("b")), now: now)
        #expect(!take(&cleared))
    }

    @Test func tooLateIsNotAWave() {
        // Cleared while a search was on, so the empty view only shows once
        // the search is closed, long after.
        var cleared = InboxCleared()
        cleared.note(before: sections(thread("a")), after: sections(), now: now)
        #expect(!cleared.isPending(now: now.addingTimeInterval(3)))
        #expect(!take(&cleared, at: now.addingTimeInterval(3)))
    }
}
