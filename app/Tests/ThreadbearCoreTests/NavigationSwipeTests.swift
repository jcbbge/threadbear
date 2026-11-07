import XCTest
@testable import ThreadbearCore

final class NavigationSwipeTests: XCTestCase {
    private func swiped(_ moves: [(Double, Double)], allowed: Set<NavigationSwipe.Direction> = [.back, .forward], holds: Bool = true) -> NavigationSwipe {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: allowed, holds: holds)
        for (dx, dy) in moves { _ = swipe.move(dx: dx, dy: dy) }
        return swipe
    }

    /// Fingers right go back and left go forward, as in Safari, once
    /// they're past the line.
    func testRightGoesBackAndLeftForward() {
        var back = swiped([(8, 0), (60, 0), (60, 0)])
        XCTAssertEqual(back.direction, .back)
        XCTAssertTrue(back.armed)
        XCTAssertEqual(back.end(), .back)
        XCTAssertEqual(back.phase, .idle)

        var forward = swiped([(-8, 0), (-120, 0)])
        XCTAssertEqual(forward.end(), .forward)
    }

    func testAcrossIsASwipeWithinAFewPoints() {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: [.back])
        XCTAssertEqual(swipe.move(dx: 2, dy: 0), .wait)
        XCTAssertEqual(swipe.move(dx: 4, dy: 1), .swipe)
        XCTAssertEqual(swipe.move(dx: 20, dy: 0), .swipe)
        XCTAssertEqual(swipe.travel, 26)
    }

    /// A real swipe drifts up or down: still a swipe, as long as it's more
    /// across than up and down. Wanting half as much again across let a
    /// long thread scroll instead (6 Nov).
    func testASwipeThatDriftsIsStillASwipe() {
        XCTAssertEqual(swiped([(2, 1), (2, 1), (2, 1)]).direction, .back)
    }

    /// Up and down is a scroll within a few points, and stays one even if
    /// it drifts sideways.
    func testUpAndDownScrolls() {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: [.back, .forward])
        XCTAssertEqual(swipe.move(dx: 1, dy: -4), .scroll)
        XCTAssertEqual(swipe.move(dx: 200, dy: 0), .scroll)
        XCTAssertNil(swipe.end())
    }

    /// A wobble of a point at the start doesn't make a swipe a scroll, where
    /// the view would then have the whole gesture.
    func testAWobbleAtTheStartDoesntDecideIt() {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: [.back])
        XCTAssertEqual(swipe.move(dx: 0, dy: 1), .wait)
        XCTAssertEqual(swipe.move(dx: 8, dy: 0), .swipe)
    }

    /// A start that's just more across, then a long way down: a scroll that
    /// started sideways, which goes nowhere however far across it got.
    func testAGestureThatTurnsMostlyVerticalGoesNowhere() {
        var swipe = swiped([(5, 4), (20, 100), (20, 100)])
        XCTAssertEqual(swipe.direction, .back)
        XCTAssertNil(swipe.end())
        var far = swiped([(5, 4), (120, 200)])
        XCTAssertFalse(far.armed)
        XCTAssertNil(far.end())
    }

    func testASidewaysStartThatTurnsIntoAScrollScrolls() {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: [.back])
        XCTAssertEqual(swipe.move(dx: 2, dy: 0), .wait)
        XCTAssertEqual(swipe.move(dx: 1, dy: 4), .scroll)
    }

    /// Short of the line, or brought back, goes nowhere.
    func testShortOrBroughtBackGoesNowhere() {
        var short = swiped([(8, 0), (10, 0), (10, 0), (10, 0), (10, 0)])
        XCTAssertFalse(short.armed)
        XCTAssertNil(short.end())

        var back = swiped([(8, 0), (150, 0), (-100, 0), (-3, 0)])
        XCTAssertFalse(back.armed)
        XCTAssertNil(back.end())
    }

    /// A quick flick goes even short of the line.
    func testFlickGoes() {
        var swipe = swiped([(8, 0), (30, 0), (20, 0)])
        XCTAssertFalse(swipe.armed)
        XCTAssertEqual(swipe.end(), .back)
    }

    /// It's speed that makes a flick, not how the trackpad batches events:
    /// the same movement in twice as many events is the same flick.
    func testAFlickDoesntDependOnHowEventsAreBatched() {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: [.back])
        _ = swipe.move(dx: 8, dy: 0, elapsed: 1.0 / 120)
        for _ in 0..<4 { _ = swipe.move(dx: 10, dy: 0, elapsed: 1.0 / 120) }
        XCTAssertEqual(swipe.end(), .back)

        var slow = NavigationSwipe()
        slow.begin(allowed: [.back])
        _ = slow.move(dx: 8, dy: 0, elapsed: 0.05)
        for _ in 0..<4 { _ = slow.move(dx: 10, dy: 0, elapsed: 0.05) }
        XCTAssertNil(slow.end())
    }

    /// A quick move, a pause to look at the arrow, then a lift: not a flick.
    func testAPauseBeforeLiftingIsntAFlick() {
        var swipe = swiped([(8, 0), (30, 0), (20, 0)])
        XCTAssertNil(swipe.end(stillMoving: false))
        var past = swiped([(8, 0), (120, 0)])
        XCTAssertEqual(past.end(stillMoving: false), .back, "past the line goes however slowly")
    }

    func testNowhereToGoThatWayIsLeftAlone() {
        var nowhere = swiped([(-8, 0), (-200, 0)], allowed: [.back])
        XCTAssertEqual(nowhere.phase, .ignoring)
        XCTAssertNil(nowhere.end())
        XCTAssertEqual(swiped([(8, 0)], allowed: []).phase, .ignoring)
    }

    /// Over a row nothing's held back, and it decides by the row's own
    /// rule, so a row and Back never both take a gesture.
    func testOverARowItDecidesByTheRowsRule() {
        var swipe = NavigationSwipe()
        swipe.begin(allowed: [.back], holds: false)
        XCTAssertEqual(swipe.move(dx: 5, dy: 0), .wait)
        XCTAssertEqual(swipe.move(dx: 2, dy: 0), .swipe)
        XCTAssertEqual(swiped([(5, 4), (1, 1)], allowed: [.back], holds: false).phase, .ignoring, "too diagonal for a row")
        // The wobble the row waits out too: neither would take it otherwise.
        var wobble = NavigationSwipe()
        wobble.begin(allowed: [.back], holds: false)
        XCTAssertEqual(wobble.move(dx: 0, dy: 1), .wait)
        XCTAssertEqual(wobble.move(dx: 8, dy: 0), .swipe)
    }

    /// The two rules agree on what's across, for any first moves.
    func testItAndARowAlwaysAgreeWhetherItsAcross() {
        for (dx, dy) in [(8.0, 0.0), (7, 4), (6, 4), (9, 6), (5, 5), (0, 9), (3, 8), (6, 1)] {
            var row = RowSwipe()
            row.begin(rightTaken: false)
            _ = row.move(dx: dx, dy: dy)
            var page = NavigationSwipe()
            page.begin(allowed: [.back], holds: false)
            _ = page.move(dx: dx, dy: dy)
            XCTAssertEqual(row.isSwiping, page.direction != nil, "\(dx), \(dy)")
        }
    }

    func testProgressRunsFromNothingToTheLine() {
        XCTAssertEqual(swiped([(8, 0)]).progress, 8 / NavigationSwipe.threshold, accuracy: 0.001)
        XCTAssertEqual(swiped([(8, 0), (400, 0)]).progress, 1)
        XCTAssertEqual(swiped([(2, -8)]).progress, 0)
    }
}
