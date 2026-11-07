import XCTest
@testable import ThreadbearCore

/// The arithmetic of dragging a row through a list (Settings > Runners, Mike,
/// 7 Nov): which slot it's over, where the other rows slide to, where the
/// dragged one floats, and the order that comes out.
final class ReorderDragTests: XCTestCase {
    private let drag = ReorderDrag(from: 0, count: 4, rowHeight: 40)

    func testTheSlotChangesAsTheRowPassesHalfwayOverTheNext() {
        XCTAssertEqual(drag.slot(translationY: 0), 0)
        XCTAssertEqual(drag.slot(translationY: 19), 0)
        XCTAssertEqual(drag.slot(translationY: 21), 1)
        XCTAssertEqual(drag.slot(translationY: 90), 2)
    }

    func testTheSlotStopsAtEitherEnd() {
        XCTAssertEqual(drag.slot(translationY: -500), 0)
        XCTAssertEqual(drag.slot(translationY: 5000), 3)
    }

    func testTheOtherRowsSlideToMakeRoomForTheSlot() {
        // Row 0 over slot 2: rows 1 and 2 move up one, row 3 stays.
        XCTAssertEqual(drag.restingY(ofRow: 1, slot: 2), 0)
        XCTAssertEqual(drag.restingY(ofRow: 2, slot: 2), 40)
        XCTAssertEqual(drag.restingY(ofRow: 3, slot: 2), 120)
        // Dragged upwards: the rows it passed move down one.
        let up = ReorderDrag(from: 3, count: 4, rowHeight: 40)
        XCTAssertEqual(up.restingY(ofRow: 0, slot: 1), 0)
        XCTAssertEqual(up.restingY(ofRow: 1, slot: 1), 80)
        XCTAssertEqual(up.restingY(ofRow: 2, slot: 1), 120)
    }

    func testOverItsOwnSlotNothingMoves() {
        let middle = ReorderDrag(from: 2, count: 4, rowHeight: 40)
        for row in [0, 1, 3] { XCTAssertEqual(middle.restingY(ofRow: row, slot: 2), CGFloat(row) * 40) }
    }

    func testTheDraggedRowFollowsThePointerButStaysNearTheList() {
        XCTAssertEqual(drag.draggedY(translationY: 55), 55)
        // A quarter of a row past either end, so a tilted row isn't cut off by the group.
        XCTAssertEqual(drag.draggedY(translationY: -500), -10)
        XCTAssertEqual(drag.draggedY(translationY: 5000), 130)
    }

    func testTheOrderThatComesOut() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(ReorderDrag.moving(ids, from: 0, to: 2), ["b", "c", "a", "d"])
        XCTAssertEqual(ReorderDrag.moving(ids, from: 3, to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(ReorderDrag.moving(ids, from: 1, to: 1), ids)
    }
}
