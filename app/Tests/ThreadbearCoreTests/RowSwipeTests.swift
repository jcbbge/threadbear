import XCTest
@testable import ThreadbearCore

final class RowSwipeTests: XCTestCase {
    func swiped(_ moves: [(Double, Double)], width: Double = 300) -> RowSwipe {
        var swipe = RowSwipe(width: width)
        swipe.begin()
        for (dx, dy) in moves { _ = swipe.move(dx: dx, dy: dy) }
        return swipe
    }

    /// Mostly across: the row follows the fingers, and the events after
    /// it's decided are the row's, so the list doesn't scroll as well.
    func testAcrossTracksAndTakesTheEvents() {
        var swipe = RowSwipe(width: 300)
        swipe.begin()
        XCTAssertFalse(swipe.move(dx: -3, dy: 0), "too small to call yet")
        XCTAssertTrue(swipe.move(dx: -4, dy: 1))
        XCTAssertTrue(swipe.isSwiping)
        XCTAssertEqual(swipe.offset, -7)
        XCTAssertTrue(swipe.move(dx: -20, dy: 5))
        XCTAssertEqual(swipe.offset, -27)
    }

    /// Up and down is a scroll: none of it goes to the row, all the way
    /// to the fingers lifting, even if it drifts sideways later.
    func testUpAndDownIsLeftToTheList() {
        var swipe = RowSwipe()
        swipe.begin()
        XCTAssertFalse(swipe.move(dx: 2, dy: -8))
        XCTAssertEqual(swipe.phase, .ignoring)
        XCTAssertFalse(swipe.move(dx: -200, dy: 0))
        XCTAssertEqual(swipe.offset, 0)
        XCTAssertFalse(swipe.end())
    }

    /// A mouse dragging a row: left is the swipe to archive, any other way
    /// is the thread being dragged out to drop into a message (6 Nov).
    func testAMouseDragLeftSwipesAndAnyOtherWayDragsTheThreadOut() {
        XCTAssertFalse(RowSwipe.dragsOut(dx: 3, dy: 2), "too small to call yet")
        XCTAssertFalse(RowSwipe.dragsOut(dx: -8, dy: 1), "left is the swipe")
        XCTAssertTrue(RowSwipe.dragsOut(dx: 8, dy: 1), "right, towards the thread")
        XCTAssertTrue(RowSwipe.dragsOut(dx: 0, dy: -8))
        XCTAssertTrue(RowSwipe.dragsOut(dx: 1, dy: 8))
        XCTAssertTrue(RowSwipe.dragsOut(dx: -6, dy: -5), "a diagonal isn't a swipe either")
        // Whichever the swipe would have tracked, it isn't a drag out.
        for (dx, dy) in [(-6.0, 0.0), (-7, 4), (-30, -12)] {
            XCTAssertEqual(RowSwipe.dragsOut(dx: dx, dy: dy), !swiped([(dx, dy)]).isSwiping, "\(dx), \(dy)")
        }
    }

    /// A diagonal scroll isn't a swipe: across has to clearly lead.
    func testDiagonalScrolls() {
        let swipe = swiped([(-6, -5)])
        XCTAssertEqual(swipe.phase, .ignoring)
    }

    /// Past a third of the row (70 points at least) letting go archives;
    /// short of it, the row springs back.
    func testLetGoPastTheLineArchives() {
        var short = swiped(Array(repeating: (-10, 0), count: 6))
        XCTAssertFalse(short.armed)
        XCTAssertFalse(short.end())

        var far = swiped([(-10, 0), (-50, 0), (-50, 0)])
        XCTAssertTrue(far.armed)
        XCTAssertTrue(far.end())
        XCTAssertEqual(far.phase, .idle)
    }

    func testThresholdHasAFloor() {
        XCTAssertEqual(RowSwipe(width: 120).threshold, 70)
        XCTAssertEqual(RowSwipe(width: 400).threshold, 140)
    }

    /// Back under the line before letting go changes its mind.
    func testComingBackDisarms() {
        var swipe = swiped([(-10, 0), (-100, 0), (60, 0)])
        XCTAssertFalse(swipe.armed)
        XCTAssertFalse(swipe.end())
    }

    /// A quick flick archives short of the line; a slow drag there doesn't.
    func testFlickArchives() {
        var flick = swiped([(-10, 0), (-10, 0), (-20, 0)])
        XCTAssertTrue(flick.end())
        var slow = swiped([(-10, 0), (-10, 0), (-5, 0), (-5, 0), (-5, 0)])
        XCTAssertFalse(slow.end())
    }

    /// Right has nothing behind it: the row gives a little and stops, and
    /// the row never goes further left than its own width.
    func testOffsetLimits() {
        XCTAssertEqual(swiped([(10, 0), (40, 0)]).offset, 10)
        XCTAssertEqual(swiped([(10, 0), (400, 0)]).offset, 24)
        XCTAssertEqual(swiped([(-10, 0), (-900, 0)], width: 300).offset, -300)
    }

    func testCancelNeverArchives() {
        var swipe = swiped([(-10, 0), (-200, 0)])
        swipe.cancel()
        XCTAssertFalse(swipe.end())
        XCTAssertEqual(swipe.offset, 0)
    }

    /// While a swipe right goes Back, it isn't the row's: the row lets it
    /// go, and still takes a swipe left to archive.
    func testASwipeRightIsLeftToBackWhenItsTaken() {
        var right = RowSwipe()
        right.begin(rightTaken: true)
        XCTAssertFalse(right.move(dx: 8, dy: 0))
        XCTAssertEqual(right.phase, .ignoring)
        var left = RowSwipe()
        left.begin(rightTaken: true)
        XCTAssertTrue(left.move(dx: -8, dy: 0))
        XCTAssertTrue(left.isSwiping)
    }
}
