import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Every click shows something the moment it's made, however long the runner
/// takes (AGENTS.md, "Assume every action is slow to land"): a guess that a
/// refusal takes back, or a spinner that stops more clicks until it lands.
/// The transport holds each request until the test answers it.
@MainActor
final class ClickFeedbackTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    private func connected(thread json: String = #"{"id":"th1","title":"Fix it","lastSeq":12,"status":"running"}"#) async throws -> (AppModel, HoldingTransport) {
        let app = AppModel()
        app.notificationsEnabled = false
        let transport = HoldingTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        app.useClientForTesting(client)
        app.threads["th1"] = try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
        return (app, transport)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<400 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(condition(), "never happened")
    }

    // MARK: Stop

    func testStopSpinsUntilTheTurnHasEndedAndCanOnlyBePressedOnce() async throws {
        let (app, transport) = try await connected()
        let key = BusyKey.stop("th1")
        app.interrupt("th1")
        XCTAssertTrue(app.isBusy(key), "it shows the moment it's pressed")
        app.interrupt("th1")
        try await until { transport.waiting("threads.interrupt") }
        XCTAssertEqual(transport.count("threads.interrupt"), 1, "a second press doesn't go")
        transport.answer("threads.interrupt", [:])
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(app.isBusy(key), "the runner has it, but the turn's still running")
        app.threads["th1"]?.status = .idle
        try await until { !app.isBusy(key) }
        XCTAssertNil(app.errorMessage)
    }

    func testAStopTheRunnerRefusesSaysSoAndCanBePressedAgain() async throws {
        let (app, transport) = try await connected()
        app.interrupt("th1")
        try await until { transport.waiting("threads.interrupt") }
        transport.fail("threads.interrupt", message: "Nope")
        try await until { !app.isBusy(BusyKey.stop("th1")) }
        XCTAssertEqual(app.errorMessage, "Nope")
    }

    /// The runner's own limit can leave a thread looking busy, so the button
    /// must come back rather than spin for good.
    func testStopLetsGoEvenIfTheThreadStaysBusy() async throws {
        let (app, transport) = try await connected()
        let wait = AppModel.interruptWait
        AppModel.interruptWait = .milliseconds(50)
        defer { AppModel.interruptWait = wait }
        app.interrupt("th1")
        try await until { transport.waiting("threads.interrupt") }
        transport.answer("threads.interrupt", [:])
        try await until { !app.isBusy(BusyKey.stop("th1")) }
    }

    // MARK: Moving a thread

    /// A login, pool or folder can't be guessed, so its chip spins; a model
    /// on its own can, so nothing spins.
    func testALoginPickSpinsUntilTheReplyAndAModelPickDoesnt() async throws {
        let (app, transport) = try await connected()
        let thread: [String: Any] = ["thread": ["id": "th1", "title": "Fix it", "accountId": "b"]]
        app.update("th1", ThreadUpdate(accountId: "b"))
        XCTAssertTrue(app.isBusy(BusyKey.moving("th1")))
        try await until { transport.waiting("threads.update") }
        transport.answer("threads.update", thread)
        try await until { !app.isBusy(BusyKey.moving("th1")) }
        XCTAssertEqual(app.threads["th1"]?.accountId, "b")

        app.update("th1", ThreadUpdate(model: .some("m")))
        XCTAssertFalse(app.isBusy(BusyKey.moving("th1")))
        XCTAssertEqual(app.threads["th1"]?.model, "m")

        app.update("th1", ThreadUpdate(poolId: .some("p")))
        XCTAssertTrue(app.isBusy(BusyKey.moving("th1")))
        app.update("th1", ThreadUpdate(cwd: "/x"))
        XCTAssertTrue(app.isBusy(BusyKey.movingFolder("th1")))
    }

    func testAMoveThatFailsStopsSpinningAndSaysWhy() async throws {
        let (app, transport) = try await connected()
        app.update("th1", ThreadUpdate(accountId: "b"))
        try await until { transport.waiting("threads.update") }
        transport.fail("threads.update", message: "No such login")
        try await until { !app.isBusy(BusyKey.moving("th1")) }
        XCTAssertEqual(app.errorMessage, "No such login")
    }

    // MARK: Go ahead

    func testGoAheadSpinsLikeAnApprovalAndComesBackOnAFailure() async throws {
        let (app, transport) = try await connected()
        let session = app.session(for: "th1")
        session.approvePlan(itemId: "plan1")
        XCTAssertTrue(session.answering.contains("plan1"))
        session.approvePlan(itemId: "plan1")
        try await until { transport.waiting("plans.approve") }
        XCTAssertEqual(transport.count("plans.approve"), 1)
        transport.fail("plans.approve", message: "Gone")
        try await until { !session.answering.contains("plan1") }
        XCTAssertEqual(app.errorMessage, "Gone")
    }

    /// The card normally leaves the waiting state by itself. If it doesn't,
    /// Go ahead must come back rather than spin for good.
    func testGoAheadLetsGoAfterItLands() async throws {
        let (app, transport) = try await connected()
        let session = app.session(for: "th1")
        let letGo = ThreadSession.planLetGo
        ThreadSession.planLetGo = .milliseconds(20)
        defer { ThreadSession.planLetGo = letGo }
        session.approvePlan(itemId: "plan1")
        try await until { transport.waiting("plans.approve") }
        transport.answer("plans.approve", [:])
        try await until { !session.answering.contains("plan1") }
        XCTAssertNil(app.errorMessage)
    }

    // MARK: Wake when

    func testWakeWhenPutsItAwayAtOnceAndARefusalBringsItBack() async throws {
        let (app, transport) = try await connected()
        app.hibernateWhen("th1", said: "after the deploy")
        let shown = app.threads["th1"]
        XCTAssertEqual(shown?.wakeWhen?.pending, true)
        XCTAssertEqual(shown?.wakeWhen?.said, "after the deploy")
        XCTAssertNotNil(shown?.snoozedUntil)
        try await until { transport.waiting("threads.hibernateWhen") }
        transport.fail("threads.hibernateWhen", message: "Can't")
        try await until { app.errorMessage != nil }
        XCTAssertNil(app.threads["th1"]?.snoozedUntil)
        XCTAssertNil(app.threads["th1"]?.wakeWhen)
    }

    // MARK: Hibernate

    /// A row hibernated without being open has no flight, but the moon
    /// stirs at once so the eye knows where it went.
    func testHibernatingARowThatIsntOpenStirsTheMoon() async throws {
        let (app, _) = try await connected()
        XCTAssertEqual(app.hibernateLandings, 0)
        app.snooze("th1", until: Date().addingTimeInterval(3600))
        XCTAssertEqual(app.hibernateLandings, 1)
        XCTAssertNotNil(app.threads["th1"]?.snoozedUntil, "and it's put away at once")
        XCTAssertTrue(app.flyingToHibernate.isEmpty)
        app.snoozeUntilRestart("th1")
        XCTAssertEqual(app.hibernateLandings, 2)
        app.hibernateWhen("th1", said: "at the weekend")
        XCTAssertEqual(app.hibernateLandings, 3)
    }

    /// A starred thread stays in Starred however long it sleeps, so nothing
    /// tells him it went to the moon.
    func testAStarredThreadDoesntStirTheMoon() async throws {
        let (app, _) = try await connected()
        app.threads["th1"]?.starredAt = Date()
        app.snooze("th1", until: Date().addingTimeInterval(3600))
        XCTAssertEqual(app.hibernateLandings, 0)
    }

    /// While a row animates away its marker is still in the window beside
    /// the new one, and SwiftUI makes, updates and attaches the two in no
    /// fixed order. The newest in the window wins whatever the order: the
    /// old one holding on, or nothing once it goes, landed the flight a row
    /// short of its heading.
    func testTheNewestMarkerInTheWindowWins() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let old = FlightMarkerView(kind: .openRow)
        window.contentView?.addSubview(old)
        ArchiveFlight.register(old)
        XCTAssertTrue(ArchiveFlight.openRow === old)
        // The new one is made before it has a window, then the old one is
        // updated, then the new one goes on screen.
        let new = FlightMarkerView(kind: .openRow)
        ArchiveFlight.register(new)
        XCTAssertTrue(ArchiveFlight.openRow === old, "not in a window yet")
        window.contentView?.addSubview(new)
        XCTAssertTrue(ArchiveFlight.openRow === new)
        old.removeFromSuperview()
        XCTAssertTrue(ArchiveFlight.openRow === new)
        new.removeFromSuperview()
        XCTAssertNil(ArchiveFlight.openRow)
    }

    /// Hibernating aims at Archived's box only when there's no Hibernating
    /// heading yet. One that's there but scrolled out of sight sends the
    /// page off the bottom of the list, not into the wrong heading.
    func testHibernatingWithItsHeadingOutOfSightDoesntAimAtArchived() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 400), styleMask: [], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        // A sidebar that scrolls, its top in view: what's below 400 isn't.
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 200, height: 400))
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 200, height: 1200))
        scroll.documentView = content
        window.contentView?.addSubview(scroll)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 800))
        let list = FlightMarkerView(kind: .inboxList), archived = FlightMarkerView(kind: .archiveBox)
        list.frame = NSRect(x: 0, y: 0, width: 200, height: 1200)
        archived.frame = NSRect(x: 10, y: 1100, width: 14, height: 14)
        for view in [list, archived] {
            content.addSubview(view)
            ArchiveFlight.register(view)
        }
        XCTAssertEqual(ArchiveFlight.target(in: window, to: .hibernate, headingThere: false)?.onHeading, true, "no Hibernating heading yet, so its moon will come where Archived's box is")
        XCTAssertEqual(ArchiveFlight.target(in: window, to: .hibernate, headingThere: true)?.onHeading, false, "there, but the lazy list hasn't drawn it")
        let moon = FlightMarkerView(kind: .hibernateBox)
        moon.frame = NSRect(x: 10, y: 200, width: 14, height: 14)
        content.addSubview(moon)
        ArchiveFlight.register(moon)
        XCTAssertEqual(ArchiveFlight.target(in: window, to: .hibernate, headingThere: true)?.onHeading, false, "drawn, but scrolled out of sight")
        XCTAssertEqual(ArchiveFlight.target(in: window, to: .archive)?.onHeading, true)
        scroll.removeFromSuperview()
    }

    /// The empty-inbox bear waits for a page leaving the Inbox, but not for a
    /// starred or sleeping thread's, which leaves a bear that's already there
    /// alone.
    func testOnlyAFlightLeavingTheInboxHoldsUpTheBear() async throws {
        let (app, _) = try await connected()
        app.threads["th2"] = ThreadSummary(id: "th2", title: "Starred")
        app.threads["th2"]?.starredAt = Date()
        app.threads["th3"] = ThreadSummary(id: "th3", title: "Asleep")
        app.threads["th3"]?.snoozedUntil = Date().addingTimeInterval(3600)
        app.noteFlightLeaving("th2")
        app.noteFlightLeaving("th3")
        XCTAssertFalse(app.flightLeavingTheInbox)
        app.noteFlightLeaving("th1")
        XCTAssertTrue(app.flightLeavingTheInbox)
    }

    // MARK: Inbox zero in the pane

    /// Archiving the last thread from its own pane brings the bear to the
    /// new thread page (straight away here, as there's no window for the
    /// page to fly in).
    func testArchivingTheLastThreadFromItsPaneBringsTheBear() async throws {
        let (app, _) = try await connected()
        app.selection = "th1"
        app.archive("th1")
        XCTAssertNil(app.selection)
        XCTAssertEqual(app.inboxZeroBear, .shown)
    }

    func testArchivingWithOthersLeftOrFromTheSidebarDoesnt() async throws {
        let (app, _) = try await connected()
        app.threads["th2"] = ThreadSummary(id: "th2", title: "Another")
        app.selection = "th1"
        app.archive("th1")
        XCTAssertNil(app.inboxZeroBear, "th2 is still in the inbox")
        app.selection = nil
        app.archive("th2")
        XCTAssertNil(app.inboxZeroBear, "archived from its row, with no pane on it")
    }

    // MARK: The card settling in

    /// Rises and fades on its layer, so it runs whatever the main thread's
    /// doing as a turn ends, and it's over quickly.
    func testTheCardSettlesInOnItsLayer() throws {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        view.wantsLayer = true
        ComposerCardHost.settle(view)
        let animation = try XCTUnwrap(view.layer?.animation(forKey: ComposerCardHost.settleKey))
        XCTAssertEqual(animation.duration, 0.2, accuracy: 0.05)
    }

    /// The done tick drawn over the text's sits exactly where the text's
    /// was, and that goes see-through while it draws, then comes back.
    func testTheDoneTickDrawsOverTheTextsOwnThenGoesAway() async throws {
        let card = AsksCard(seq: 7, asks: [], next: ["Carry on"])
        let row = TranscriptRow(id: "ak:7", seq: 7, turnId: "t1", content: .asks(card))
        let cell = TextRowCell()
        cell.bare = true
        let render = ComposerCardHost.render(row, width: 500)
        cell.frame = NSRect(x: 0, y: 0, width: 500, height: render.height)
        cell.configure(row: row, render: render, tableWidth: 500, expanded: false)
        let storage = try XCTUnwrap(cell.textView.textStorage)
        let before = try XCTUnwrap(storage.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment)
        let views = cell.subviews.count
        cell.drawDoneTickOn()
        XCTAssertEqual(cell.subviews.count, views + 1)
        let during = storage.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment
        XCTAssertFalse(during === before)
        XCTAssertEqual(during?.bounds, before.bounds, "the same size, so nothing moves")
        try await until { cell.subviews.count == views }
        XCTAssertTrue(storage.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment === before)
    }

    // MARK: Projects

    func testAProjectEditShowsAtOnceAndARefusalPutsItBack() async throws {
        let (app, transport) = try await connected()
        app.projects = [Project(id: "p1", title: "One", goals: "old")]
        app.updateProject("p1", ProjectUpdate(goals: "new"))
        XCTAssertEqual(app.project("p1")?.goals, "new")
        try await until { transport.waiting("projects.update") }
        transport.fail("projects.update", message: "Refused")
        try await until { app.project("p1")?.goals == "old" }
        XCTAssertEqual(app.errorMessage, "Refused")
    }

    func testAProjectChangedSinceIsntPutBack() async throws {
        let (app, transport) = try await connected()
        app.projects = [Project(id: "p1", title: "One", goals: "old")]
        app.updateProject("p1", ProjectUpdate(goals: "new"))
        app.projects = [Project(id: "p1", title: "One", goals: "the librarian's")]
        try await until { transport.waiting("projects.update") }
        transport.fail("projects.update", message: "Refused")
        try await until { app.errorMessage != nil }
        XCTAssertEqual(app.project("p1")?.goals, "the librarian's")
    }

    func testDeletingAProjectGoesAtOnceAndARefusalPutsItBackWhereItWas() async throws {
        let (app, transport) = try await connected()
        app.projects = [Project(id: "p1", title: "One"), Project(id: "p2", title: "Two")]
        app.openProjectId = "p1"
        app.confirmedDelete("p1", client: try XCTUnwrap(app.client))
        XCTAssertNil(app.project("p1"))
        XCTAssertNil(app.openProjectId)
        try await until { transport.waiting("projects.delete") }
        transport.fail("projects.delete", message: "Refused")
        try await until { app.project("p1") != nil }
        XCTAssertEqual(app.projects.map(\.id), ["p1", "p2"])
        XCTAssertEqual(app.openProjectId, "p1")
    }

    func testMergingShowsTheResultAtOnceAndARefusalPutsBothBack() async throws {
        let (app, transport) = try await connected()
        let into = Project(id: "p2", title: "Two", folders: ["/a"], threadCount: 1)
        app.projects = [Project(id: "p1", title: "One", folders: ["/a", "/b"], threadCount: 2), into]
        app.openProjectId = "p1"
        app.confirmedMerge("p1", into: "p2", client: try XCTUnwrap(app.client))
        XCTAssertNil(app.project("p1"))
        XCTAssertEqual(app.openProjectId, "p2")
        XCTAssertEqual(app.project("p2")?.folders, ["/a", "/b"])
        XCTAssertEqual(app.project("p2")?.threadCount, 3)
        try await until { transport.waiting("projects.merge") }
        transport.fail("projects.merge", message: "Refused")
        try await until { app.project("p1") != nil }
        XCTAssertEqual(app.projects.map(\.id), ["p1", "p2"])
        XCTAssertEqual(app.project("p2"), into)
        XCTAssertEqual(app.openProjectId, "p1")
    }

    /// A delete whose reply was lost may have gone through, so the list is
    /// read again rather than trusting the rollback (Codex's review, 7 Nov).
    func testARefusedDeleteReadsTheListAgain() async throws {
        let (app, transport) = try await connected()
        app.projects = [Project(id: "p1", title: "One")]
        app.confirmedDelete("p1", client: try XCTUnwrap(app.client))
        try await until { transport.waiting("projects.delete") }
        transport.fail("projects.delete", message: "Timed out")
        try await until { transport.waiting("projects.list") }
        transport.answer("projects.list", ["projects": []])
        try await until { app.project("p1") == nil }
    }

    func testPuttingAThreadInAProjectShowsAtOnceAndARefusalTakesItOut() async throws {
        let (app, transport) = try await connected()
        app.projects = [Project(id: "p1", title: "One")]
        app.setProjects("th1", add: ["p1"])
        XCTAssertEqual(app.threads["th1"]?.projects.map(\.title), ["One"])
        XCTAssertEqual(app.threads["th1"]?.projects.first?.pinned, true)
        try await until { transport.waiting("threads.setProjects") }
        transport.fail("threads.setProjects", message: "Refused")
        try await until { app.threads["th1"]?.projects.isEmpty == true }
        XCTAssertEqual(app.errorMessage, "Refused")
    }

    // MARK: Needs you

    /// A second click used to send the same value again, as the box hadn't
    /// changed yet.
    func testATickShowsAtOnceSoASecondClickMeansTheOpposite() async throws {
        let (app, transport) = try await connected(thread: #"{"id":"th1","title":"Fix it","lastSeq":12,"asksSeq":3,"asks":[{"action":"Check it"}]}"#)
        let session = app.session(for: "th1")
        let ticked = { app.threads["th1"]?.asks.first?.ticked }
        session.tickAsk(asksSeq: 3, index: 0, ticked: ticked() == false)
        XCTAssertEqual(ticked(), true)
        try await until { transport.waiting("threads.tickAsk") }
        transport.fail("threads.tickAsk", message: "Refused")
        try await until { ticked() == false }
        XCTAssertEqual(app.errorMessage, "Refused")
    }

    /// A double click stays ticked, and two can't overlap (Codex's review, 7
    /// Nov: if both failed, the second's rollback left the first's guess).
    func testAClickWhileATickIsOnItsWayDoesNothing() async throws {
        let (app, transport) = try await connected(thread: #"{"id":"th1","title":"Fix it","lastSeq":12,"asksSeq":3,"asks":[{"action":"Check it"}]}"#)
        let session = app.session(for: "th1")
        session.tickAsk(asksSeq: 3, index: 0, ticked: true)
        session.tickAsk(asksSeq: 3, index: 0, ticked: false)
        XCTAssertEqual(app.threads["th1"]?.asks.first?.ticked, true)
        try await until { transport.waiting("threads.tickAsk") }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(transport.count("threads.tickAsk"), 1)
    }

    /// The card it was ticked on has gone: another card's ask mustn't change.
    func testATickOnAnOldCardLeavesTheNewCardAlone() async throws {
        let (app, _) = try await connected(thread: #"{"id":"th1","title":"Fix it","lastSeq":12,"asksSeq":4,"asks":[{"action":"Check it"}]}"#)
        app.session(for: "th1").tickAsk(asksSeq: 3, index: 0, ticked: true)
        XCTAssertEqual(app.threads["th1"]?.asks.first?.ticked, false)
    }

    // MARK: Schedules

    private func schedule(paused: Bool = false) throws -> Schedule {
        try JSONDecoder().decode(Schedule.self, from: Data(#"{"id":"s1","title":"Daily","text":"hi","paused":\#(paused)}"#.utf8))
    }

    func testPausingAScheduleShowsAtOnceAndARefusalPutsItBack() async throws {
        let (app, transport) = try await connected()
        app.schedules = [try schedule()]
        app.setSchedulePaused("s1", true)
        XCTAssertEqual(app.schedule("s1")?.paused, true)
        try await until { transport.waiting("schedules.update") }
        transport.fail("schedules.update", message: "Refused")
        try await until { app.schedule("s1")?.paused == false }
        XCTAssertEqual(app.errorMessage, "Refused")
    }

    func testAPauseWaitsForTheOneOnItsWay() async throws {
        let (app, transport) = try await connected()
        app.schedules = [try schedule()]
        app.setSchedulePaused("s1", true)
        app.setSchedulePaused("s1", false)
        XCTAssertEqual(app.schedule("s1")?.paused, true)
        try await until { transport.waiting("schedules.update") }
        transport.fail("schedules.update", message: "Refused")
        try await until { app.schedule("s1")?.paused == false }
        XCTAssertEqual(transport.count("schedules.update"), 1)
    }

    func testDeletingAScheduleGoesAtOnceAndARefusalPutsItBack() async throws {
        let (app, transport) = try await connected()
        app.schedules = [try schedule()]
        app.confirmedDeleteSchedule("s1", client: try XCTUnwrap(app.client))
        XCTAssertNil(app.schedule("s1"))
        try await until { transport.waiting("schedules.delete") }
        transport.fail("schedules.delete", message: "Refused")
        try await until { app.schedule("s1") != nil }
    }

    func testRunNowSpinsAndCanOnlyBePressedOnce() async throws {
        let (app, transport) = try await connected()
        app.schedules = [try schedule()]
        app.runSchedule("s1")
        XCTAssertTrue(app.isBusy(BusyKey.runSchedule("s1")))
        app.runSchedule("s1")
        try await until { transport.waiting("schedules.run") }
        XCTAssertEqual(transport.count("schedules.run"), 1)
        transport.fail("schedules.run", message: "Refused")
        try await until { !app.isBusy(BusyKey.runSchedule("s1")) }
        XCTAssertEqual(app.errorMessage, "Refused")
    }

    // MARK: The librarian

    func testPausingTheLibrarianShowsAtOnceAndARefusalPutsItBack() async throws {
        let (app, transport) = try await connected()
        app.librarian = LibrarianStatus()
        app.setLibrarianPaused(true)
        XCTAssertEqual(app.librarian?.paused, true)
        XCTAssertEqual(app.librarian?.state, .paused)
        try await until { transport.waiting("librarian.update") }
        transport.fail("librarian.update", message: "Refused")
        try await until { app.librarian?.paused == false }
        XCTAssertEqual(app.librarian?.state, .idle)
    }

    /// From a thread's menu there's no button, so the banner says it.
    func testAskingTheLibrarianFromAMenuShowsInTheBanner() async throws {
        let (app, transport) = try await connected()
        app.runLibrarian(threadId: "th1")
        XCTAssertEqual(app.banner?.text, "Asking the librarian to look…")
        try await until { transport.waiting("librarian.run") }
        transport.fail("librarian.run", message: "Refused")
        try await until { app.banner == nil }
    }

    // MARK: CLIs

    func testAPolicyShowsAtOnceAndARefusalPutsItBack() async throws {
        let (app, transport) = try await connected()
        app.clis = [try JSONDecoder().decode(CliStatus.self, from: Data(#"{"provider":"claude","policy":"auto"}"#.utf8))]
        app.setCliPolicy("claude", "manual")
        XCTAssertEqual(app.clis.first?.policy, "manual")
        XCTAssertTrue(app.isBusy(BusyKey.cliPolicy("claude")))
        try await until { transport.waiting("clis.setPolicy") }
        transport.fail("clis.setPolicy", message: "Refused")
        try await until { app.clis.first?.policy == "auto" }
        XCTAssertFalse(app.isBusy(BusyKey.cliPolicy("claude")))
    }

    func testCheckNowSpinsUntilTheReply() async throws {
        let (app, transport) = try await connected()
        app.checkClis()
        XCTAssertTrue(app.isBusy(BusyKey.checkClis))
        app.checkClis()
        try await until { transport.waiting("clis.check") }
        XCTAssertEqual(transport.count("clis.check"), 1)
        transport.answer("clis.check", ["clis": []])
        try await until { !app.isBusy(BusyKey.checkClis) }
    }

    // MARK: Copy transcript

    /// It reads older pages first, so it says so, then says it's done. A page
    /// that can't be read leaves the clipboard alone, rather than copying
    /// part of the thread as if it were all of it.
    func testCopyingSaysSoAndAFailedPageLeavesTheClipboardAlone() async throws {
        let (app, transport) = try await connected()
        let session = app.session(for: "th1")
        session.open(width: 800)
        try await until { transport.waiting("threads.events") }
        // Starts at seq 5, so there are older pages to read.
        transport.answer("threads.events", ["events": [["seq": 5, "ts": "", "threadId": "th1", "type": "x", "payload": [:]]]])
        try await until { session.state == .loaded }
        // Its own pasteboard: a test mustn't touch Mike's clipboard.
        app.pasteboard = NSPasteboard(name: NSPasteboard.Name("ClickFeedbackTests-\(UUID().uuidString)"))
        app.pasteboard.clearContents()
        app.pasteboard.setString("kept", forType: .string)
        session.copyTranscript()
        XCTAssertEqual(app.banner?.text, "Copying the transcript…")
        try await until { transport.waiting("threads.events") }
        transport.fail("threads.events", message: "Lost it")
        try await until { !app.isBusy(BusyKey.copying("th1")) }
        XCTAssertEqual(app.errorMessage, "Lost it")
        XCTAssertEqual(app.pasteboard.string(forType: .string), "kept")
    }

    // MARK: The helper

    func testBusyKeysCountSoOverlappingWorkDoesntClearEachOther() async throws {
        let (app, _) = try await connected()
        app.beginBusy("k")
        app.beginBusy("k")
        app.endBusy("k")
        XCTAssertTrue(app.isBusy("k"))
        app.endBusy("k")
        XCTAssertFalse(app.isBusy("k"))
        XCTAssertTrue(app.busyKeys.isEmpty)
    }
}
