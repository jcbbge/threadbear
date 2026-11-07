import Foundation
import Testing
@testable import ThreadbearKit

/// Pull down on the inbox and the bear's head comes up over the top of the list,
/// as far as the pull goes, up to the whole head.
@Suite struct PullPeekTests {
    @Test func theHeadRisesWithThePullUpToItsHeight() {
        #expect(PullPeek.shown(gap: 0) == 0)
        // A little give first, so a list settling doesn't show an ear.
        #expect(PullPeek.shown(gap: 8) == 0)
        #expect(PullPeek.shown(gap: 48) == 22)
        #expect(PullPeek.shown(gap: 200) == PullPeek.head)
    }

    @Test func theGapIsHowFarPastTheTopTheListHasGone() {
        var peek = PullPeek()
        // At rest: what the top inset is, so a refresh's extra inset isn't mistaken for it.
        peek.scrolled(offset: -150, topInset: 150, refreshing: false)
        #expect(peek.gap == 0)
        peek.scrolled(offset: -210, topInset: 150, refreshing: false)
        #expect(peek.gap == 60)
        // Held open while it reconnects: the inset grows, the gap stays.
        peek.scrolled(offset: -210, topInset: 210, refreshing: true)
        #expect(peek.gap == 60)
        // Scrolled down the list is no gap at all.
        peek.scrolled(offset: 400, topInset: 150, refreshing: false)
        #expect(peek.gap == 0)
    }

    @Test func pastTheRefreshPointOnceAndLetGoRefreshes() {
        var peek = PullPeek()
        peek.scrolled(offset: -150, topInset: 150, refreshing: false)
        let early = peek.pulling(gap: 60), crossed = peek.pulling(gap: 90), further = peek.pulling(gap: 120)
        #expect(!early)
        #expect(crossed, "crossing it is the moment to blink")
        #expect(!further, "and only the once")
        let first = peek.letGo(), second = peek.letGo()
        #expect(first)
        #expect(!second, "one refresh a pull")
    }

    @Test func comingBackAboveItBeforeLettingGoDoesNothing() {
        var peek = PullPeek()
        _ = peek.pulling(gap: 90)
        _ = peek.pulling(gap: 40)
        let refreshes = peek.letGo()
        #expect(!refreshes)
    }
}
