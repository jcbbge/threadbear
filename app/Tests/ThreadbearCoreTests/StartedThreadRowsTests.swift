import XCTest
@testable import ThreadbearCore

final class StartedThreadRowsTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func child(_ id: String, of parent: String?, status: ThreadStatus = .idle, ago: TimeInterval = 60) -> ThreadSummary {
        var thread = ThreadSummary(id: id, title: id, cwd: "/x/misc", status: status)
        thread.lastActivityAt = now.addingTimeInterval(-ago)
        if let parent { thread.startedBy = ThreadStartedBy(kind: "thread", label: "Agent", threadId: parent, threadTitle: "Parent") }
        return thread
    }

    func testListsTheThreadsItStartedAndWaitsOnNeedsYouFirst() {
        var parent = ThreadSummary(id: "p", title: "Parent", cwd: "/x/misc", status: .idle)
        parent.waitingOn = [WaitingOn(threadId: "other", title: "other")]

        let done = child("done", of: "p", ago: 10)
        let working = child("working", of: "p", status: .running, ago: 300)
        var asking = child("asking", of: "p", ago: 600)
        asking.needs = "you"
        var archived = child("archived", of: "p", ago: 5)
        archived.archivedAt = now
        var asleep = child("asleep", of: "p")
        asleep.snoozedUntil = now.addingTimeInterval(3600)
        let failed = child("failed", of: "p", status: .error)
        let waitedOn = child("other", of: nil, status: .running)
        let someoneElses = child("elsewhere", of: "q")
        var byTool = child("tool", of: nil)
        byTool.startedBy = ThreadStartedBy(kind: "tool", label: "Sentry", threadId: "p")

        let all = [parent, done, working, asking, archived, asleep, failed, waitedOn, someoneElses, byTool]
        let rows = StartedThreadRows.rows(for: parent, in: Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) }), now: now)

        XCTAssertEqual(rows.map(\.id), ["asking", "failed", "other", "working", "asleep", "done", "archived"],
                       "needs you, failed, working (newest first), hibernating, done, archived; not another thread's, a tool's or itself")
        XCTAssertEqual(rows.first { $0.id == "other" }?.started, false)
        XCTAssertEqual(StartedThreadRows.detail(rows[0], now: now), "Needs you")
        XCTAssertEqual(StartedThreadRows.detail(rows.first { $0.id == "other" }!, now: now).hasPrefix("Waiting on it · Working"), true)
        XCTAssertEqual(StartedThreadRows.detail(rows.first { $0.id == "archived" }!, now: now), "Archived")
    }

    func testAThreadThatStartedNothingHasNoRows() {
        let parent = ThreadSummary(id: "p", title: "Parent", cwd: "/x/misc", status: .idle)
        XCTAssertTrue(StartedThreadRows.rows(for: parent, in: ["p": parent, "x": child("x", of: nil)], now: now).isEmpty)
    }
}
