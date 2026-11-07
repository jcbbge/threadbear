import Foundation
import Testing
@testable import ThreadbearKit

/// Hibernating from the phone: the row goes at once, the heading's count goes
/// up at once, and both then wait for the backend without jumping.
@Suite struct TucksTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    private func thread(_ id: String, snoozed: Bool = false) -> PhoneThread {
        var thread = PhoneThread(threadId: id, title: id, lastActivityAt: now)
        if snoozed { thread.snoozedUntil = now.addingTimeInterval(3600) }
        return thread
    }

    @Test func aTuckHidesTheRowCountsItAndBouncesTheMoonOnce() {
        var tucks = Tucks()
        tucks.tuck("a")
        #expect(tucks.hidden == ["a"])
        #expect(tucks.uncounted == 1)
        #expect(tucks.bounces == 1)
    }

    @Test func staysHiddenUntilTheListSaysItsAsleepOrGone() {
        var tucks = Tucks()
        tucks.tuck("a")
        tucks.tuck("b")
        tucks.tuck("c")
        // An unrelated update, from before the runner got to them.
        tucks.inboxArrived([thread("a"), thread("b"), thread("c")], now: now)
        #expect(tucks.hidden == ["a", "b", "c"])
        // Gone from the inbox list, or still there but asleep (a star keeps
        // a hibernating thread in the list). Kept hidden, either would stay
        // hidden for good and not come back when it wakes.
        tucks.inboxArrived([thread("b", snoozed: true), thread("c")], now: now)
        #expect(tucks.hidden == ["c"])
    }

    @Test func theCountDoesNotAddOneTwiceWhenTheBackendCatchesUp() {
        var tucks = Tucks()
        tucks.tuck("a")
        // Counts first, the list a moment later.
        tucks.countsArrived(old: 2, new: 3)
        #expect(tucks.uncounted == 0)
        #expect(tucks.hidden == ["a"])
    }

    @Test func theCountDoesNotDropWhenTheListCatchesUpFirst() {
        var tucks = Tucks()
        tucks.tuck("a")
        tucks.inboxArrived([], now: now)
        // The row has gone but phone:counts hasn't said yet: still one more.
        #expect(tucks.uncounted == 1)
        tucks.countsArrived(old: 2, new: 3)
        #expect(tucks.uncounted == 0)
    }

    @Test func aFreshCountWithNothingHiddenIsTheWholeTruth() {
        var tucks = Tucks()
        tucks.tuck("a")
        tucks.inboxArrived([], now: now)
        // Something else woke in the same breath, so the count never rose.
        tucks.countsArrived(old: 2, new: 2)
        #expect(tucks.uncounted == 0)
    }

    @Test func aRefusedTuckComesBack() {
        var tucks = Tucks()
        tucks.tuck("a")
        tucks.undo("a")
        #expect(tucks.hidden.isEmpty)
        #expect(tucks.uncounted == 0)
        // Undoing one the list had already cleared takes nothing below nought.
        tucks.undo("a")
        #expect(tucks.uncounted == 0)
    }
}
