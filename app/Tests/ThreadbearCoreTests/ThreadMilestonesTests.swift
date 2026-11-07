import XCTest
@testable import ThreadbearCore

/// When the "That's 1,000 threads" note is due. Mike's installed app only
/// gets a new build when it next restarts, so he may already be past a
/// milestone when this code first runs, and that must still show it; nobody
/// else's first run may fire old ones.
final class ThreadMilestonesTests: XCTestCase {
    func testCrossingAMilestoneShowsIt() {
        XCTAssertEqual(ThreadMilestones.decide(count: 999, shown: 100), .nothing)
        XCTAssertEqual(ThreadMilestones.decide(count: 1000, shown: 100), .show(1000))
    }

    func testAlreadyPastItWhenTheBuildArrivesStillShowsIt() {
        // No memory yet: the first run of this build, on Mike's Mac.
        XCTAssertEqual(ThreadMilestones.decide(count: 1004, shown: nil), .show(1000))
        XCTAssertEqual(ThreadMilestones.decide(count: 1004, shown: 100), .show(1000))
    }

    func testOnceShownItNeverRepeats() {
        XCTAssertEqual(ThreadMilestones.decide(count: 1000, shown: 1000), .nothing)
        XCTAssertEqual(ThreadMilestones.decide(count: 1999, shown: 1000), .nothing)
        // Deleting threads and coming back up doesn't count as a second time.
        XCTAssertEqual(ThreadMilestones.decide(count: 998, shown: 1000), .nothing)
        XCTAssertEqual(ThreadMilestones.decide(count: 1000, shown: 1000), .nothing)
    }

    func testFirstRunBelowAThousandStaysQuiet() {
        // Mike today: 951 threads shouldn't get "That's 100 threads".
        XCTAssertEqual(ThreadMilestones.decide(count: 951, shown: nil), .remember(100))
        XCTAssertEqual(ThreadMilestones.decide(count: 100, shown: nil), .remember(100))
        // Someone starting fresh: nothing to say, and nothing skipped later.
        XCTAssertEqual(ThreadMilestones.decide(count: 0, shown: nil), .remember(0))
        XCTAssertEqual(ThreadMilestones.decide(count: 99, shown: nil), .remember(0))
    }

    func testSomeoneStartingFreshGetsTheirHundredth() {
        XCTAssertEqual(ThreadMilestones.decide(count: 99, shown: 0), .nothing)
        XCTAssertEqual(ThreadMilestones.decide(count: 100, shown: 0), .show(100))
    }

    func testALongJumpIsOneNoteNotABurst() {
        XCTAssertEqual(ThreadMilestones.decide(count: 5000, shown: nil), .show(5000))
        XCTAssertEqual(ThreadMilestones.decide(count: 5400, shown: nil), .show(5000))
        XCTAssertEqual(ThreadMilestones.decide(count: 5400, shown: 1000), .show(5000))
        // And after that one, the rest are behind it.
        XCTAssertEqual(ThreadMilestones.decide(count: 5400, shown: 5000), .nothing)
    }

    func testTheCopy() {
        XCTAssertEqual(ThreadMilestones.title(1000), "That's 1,000 threads")
        XCTAssertEqual(ThreadMilestones.line(1000), "The bear needs a lie down")
        XCTAssertEqual(ThreadMilestones.title(100), "That's 100 threads")
        XCTAssertEqual(ThreadMilestones.title(12000), "That's 12,000 threads")
        // Every milestone has something to say, however far it goes.
        for tier in stride(from: 1000, through: 20000, by: 1000) {
            XCTAssertFalse(ThreadMilestones.line(tier).isEmpty)
            XCTAssertFalse(ThreadMilestones.line(tier).contains("—"))
        }
    }
}
