import XCTest
@testable import ThreadbearCore

final class HoneyLevelTests: XCTestCase {
    func testFollowsTheRoomLeftOnTheTighterWindow() {
        let usage = AccountUsage(windows: [
            UsageWindow(kind: "five_hour", title: "5h", remainingPercent: 80),
            UsageWindow(kind: "weekly", title: "Week", remainingPercent: 44),
        ], blocked: false)
        XCTAssertEqual(HoneyLevel.level(usage), 0.44, accuracy: 0.001)
    }

    func testUnknownOrBlockedIsAnEmptyPot() {
        XCTAssertEqual(HoneyLevel.level(nil), 0)
        XCTAssertEqual(HoneyLevel.level(AccountUsage(windows: [], blocked: false)), 0)
        let blocked = AccountUsage(windows: [UsageWindow(kind: "weekly", title: "Week", remainingPercent: 60)], blocked: true)
        XCTAssertEqual(HoneyLevel.level(blocked), 0)
    }

    func testAResetOnTheSameLoginRefills() {
        XCTAssertTrue(HoneyLevel.refilled(from: 0.3, to: 1, sameLogin: true))
        XCTAssertTrue(HoneyLevel.refilled(from: 0.8, to: 0.97, sameLogin: true))
    }

    func testAnythingElseIsJustAChangeOfLevel() {
        XCTAssertFalse(HoneyLevel.refilled(from: 0.3, to: 1, sameLogin: false), "the pot moved to another login")
        XCTAssertFalse(HoneyLevel.refilled(from: 0.97, to: 1, sameLogin: true), "a small rise near the top")
        XCTAssertFalse(HoneyLevel.refilled(from: 0.5, to: 0.7, sameLogin: true), "an old 5-hour window sliding off")
        XCTAssertFalse(HoneyLevel.refilled(from: 1, to: 0.9, sameLogin: true))
    }
}
