import XCTest
import ThreadbearCore
@testable import Threadbear

/// The milestone note has to be seen. The installed app restarts itself onto
/// a new build while Mike's away, so a note that fires then would be spent on
/// an empty room and never come back.
@MainActor
final class MilestoneNoteTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!
    private var here = true

    override func setUp() async throws {
        suite = "milestones-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        here = true
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func app(threads count: Int, shown: Int? = nil) -> AppModel {
        if let shown { defaults.set(shown, forKey: MilestoneWatch.shownKey) }
        let app = AppModel()
        app.milestones = MilestoneWatch(defaults: defaults, delay: .milliseconds(1), watchesInput: false) { [unowned self] in self.here }
        // All at once: one by one, each insert wakes observers and 1,000 of them take seconds.
        app.threads = Dictionary(uniqueKeysWithValues: (0..<count).map { ("t\($0)", ThreadSummary(id: "t\($0)", title: "", status: .idle)) })
        app.threadsLoaded = true
        return app
    }

    private func settle(_ app: AppModel) async throws {
        for _ in 0..<300 where app.milestones?.showing != nil { try await Task.sleep(for: .milliseconds(2)) }
    }

    func testFiresOnceAndRemembers() async throws {
        let first = app(threads: 1000, shown: 100)
        first.considerMilestone()
        try await settle(first)
        XCTAssertEqual(first.milestoneNote?.tier, 1000)
        XCTAssertEqual(defaults.object(forKey: MilestoneWatch.shownKey) as? Int, 1000)
        // The next launch, with the same memory.
        let second = app(threads: 1003)
        second.considerMilestone()
        try await settle(second)
        XCTAssertNil(second.milestoneNote)
    }

    func testWaitsUntilHesThereAndOnlyThenRemembers() async throws {
        here = false
        let app = app(threads: 1040)
        app.considerMilestone()
        try await settle(app)
        XCTAssertNil(app.milestoneNote, "the app restarted itself with nobody at the Mac")
        XCTAssertNil(defaults.object(forKey: MilestoneWatch.shownKey), "not spent on an empty room")
        here = true
        app.considerMilestone()
        try await settle(app)
        XCTAssertEqual(app.milestoneNote?.tier, 1000)
    }

    func testGoingAwayDuringTheBeatKeepsItForLater() async throws {
        let app = app(threads: 1000, shown: 100)
        app.milestones = MilestoneWatch(defaults: defaults, delay: .milliseconds(40), watchesInput: false) { [unowned self] in self.here }
        app.considerMilestone()
        here = false
        try await settle(app)
        XCTAssertNil(app.milestoneNote)
        XCTAssertEqual(defaults.object(forKey: MilestoneWatch.shownKey) as? Int, 100)
    }

    func testQueuesBehindTheArchivedNote() async throws {
        let app = app(threads: 1000, shown: 100)
        app.archivedNote = ArchivedNote(threadId: "t1", title: "x", wasOpen: false)
        app.considerMilestone()
        try await settle(app)
        XCTAssertNil(app.milestoneNote, "two notes never stack")
        app.archivedNote = nil
        app.considerMilestone()
        try await settle(app)
        XCTAssertEqual(app.milestoneNote?.tier, 1000)
    }

    func testFreshInstallIsQuietThenCountsArchivedOnesButNotSamples() async throws {
        let app = app(threads: 99)
        app.considerMilestone()
        try await settle(app)
        XCTAssertNil(app.milestoneNote)
        XCTAssertEqual(defaults.object(forKey: MilestoneWatch.shownKey) as? Int, 0)
        // The tour's made-up threads aren't ones you started.
        var sample = ThreadSummary(id: "sample", title: "", status: .idle)
        sample.sample = true
        app.threads["sample"] = sample
        app.considerMilestone()
        try await settle(app)
        XCTAssertNil(app.milestoneNote)
        // An archived thread counts like any other.
        var archived = ThreadSummary(id: "old", title: "", status: .idle)
        archived.archivedAt = Date()
        app.threads["old"] = archived
        app.considerMilestone()
        try await settle(app)
        XCTAssertEqual(app.milestoneNote?.tier, 100)
    }

    func testANewThreadFromTheRunnerSetsItOff() async throws {
        let app = app(threads: 999, shown: 100)
        app.receive(ThreadSummary(id: "new", title: "", status: .idle))
        try await settle(app)
        XCTAssertEqual(app.milestoneNote?.tier, 1000)
    }

    func testScriptedRunsAndTestsHaveItOffByDefault() {
        XCTAssertNil(AppModel().milestones)
    }

    func testDismissTakesItDown() async throws {
        let app = app(threads: 1000, shown: 100)
        app.considerMilestone()
        try await settle(app)
        let note = try XCTUnwrap(app.milestoneNote)
        app.dismissMilestoneNote(UUID())
        XCTAssertNotNil(app.milestoneNote, "an old note's timer doesn't take down a newer one")
        app.dismissMilestoneNote(note.id)
        XCTAssertNil(app.milestoneNote)
    }
}
