import ModalGuard
import XCTest

/// The guard itself can't be run in here (a real modal ends the process), so
/// this checks it's linked and in place: the linker dropping its object file
/// would otherwise turn modals back into a frozen check with nothing to show.
final class ModalGuardTests: XCTestCase {
    func testRealModalsAreRefusedInTests() {
        XCTAssertTrue(TBModalGuardInstalled())
    }
}
