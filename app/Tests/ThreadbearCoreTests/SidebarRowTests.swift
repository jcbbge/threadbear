import XCTest
@testable import ThreadbearCore

final class SidebarRowTests: XCTestCase {
    func look(_ status: ThreadStatus, needsYou: Bool = false) -> ThreadRowLook {
        ThreadRowLook(ThreadSummary(id: "t", title: "t", status: status, needsYou: needsYou))
    }

    /// A thread back from hibernating by itself says "Woke up" until it's
    /// opened, with how long it was away in the tip; a turn running on it
    /// shows as working instead (Mike, 30 Oct).
    func testWokenThreadSaysSo() throws {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let woke = ThreadWoke(at: at, since: at.addingTimeInterval(-2 * 86_400))
        var thread = ThreadSummary(id: "t", title: "t", status: .idle, needsYou: true, woke: woke)
        let look = ThreadRowLook(thread)
        XCTAssertTrue(look.woke)
        XCTAssertTrue(look.unread)
        XCTAssertEqual(WokeWords.tip(woke), "Woke up after hibernating for 2 days")
        XCTAssertEqual(WokeWords.tip(ThreadWoke(at: at)), "Woke up from hibernating")
        XCTAssertEqual([30, 60, 45 * 60, 3600, 6000, 30 * 3600, 40 * 3600].map(WokeWords.away),
                       ["a minute", "a minute", "45 minutes", "an hour", "2 hours", "a day", "2 days"])
        thread.status = .running
        XCTAssertFalse(ThreadRowLook(thread).woke)
        // It comes over the protocol as the runner sends it.
        let json = #"{"id":"t","title":"t","woke":{"at":"2026-10-30T02:00:00.000Z","since":"2026-10-29T02:00:00.000Z"}}"#
        let decoded = try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.woke.map(WokeWords.tip), "Woke up after hibernating for a day")
        let back = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(back.woke, decoded.woke)
    }

    /// Between turns with sub-agents or jobs still going, the row says so
    /// (and keeps saying so under the Running heading, since the words are
    /// what's running, not the heading's). An unread reply waits for its
    /// dot until the work's done: a dot by a spinner read as two states at
    /// once (Mike, 27 Oct). The bold title still says there's a reply.
    func testBackgroundWorkShowsOnTheRow() {
        let cubs = [BackgroundTask(kind: .agent, description: "a"), BackgroundTask(kind: .agent, description: "b"), BackgroundTask(kind: .agent, description: "c")]
        let thread = ThreadSummary(id: "t", title: "t", status: .idle, background: cubs)
        XCTAssertEqual(ThreadRowLook(thread), ThreadRowLook(status: .background, unread: false, emphasised: false))
        XCTAssertEqual(ThreadRowLook(thread, section: .running), ThreadRowLook(status: .background, unread: false, emphasised: false, labelled: true))
        var unread = thread
        unread.needsYou = true
        XCTAssertEqual(ThreadRowLook(unread), ThreadRowLook(status: .background, unread: false, emphasised: true))
        unread.background = []
        XCTAssertEqual(ThreadRowLook(unread), ThreadRowLook(status: .time, unread: true, emphasised: true))
        // A running turn is the working line, whatever's in the background.
        var running = thread
        running.status = .running
        XCTAssertEqual(ThreadRowLook(running).status, .working)
        var failed = thread
        failed.status = .error
        XCTAssertEqual(ThreadRowLook(failed).status, .failed)
        XCTAssertEqual(ThreadRowStatus.background.label, "In the background")
    }

    /// Waiting on Mike, the job it left going doesn't show on the row: the
    /// dot when unread, as any other asking thread, and no spinner.
    func testAnOpenAskHidesTheBackgroundSpinner() {
        var thread = ThreadSummary(id: "t", title: "t", status: .idle, needsYou: true, background: [BackgroundTask(kind: .shell, description: "Watch")])
        thread.needs = "you"
        XCTAssertEqual(ThreadRowLook(thread), ThreadRowLook(status: .time, unread: true, emphasised: true))
        thread.needsYou = false
        XCTAssertEqual(ThreadRowLook(thread), ThreadRowLook(status: .time, unread: false, emphasised: false))
    }

    /// Sub-agents still at it: the grey spinner, not a thread for Mike yet.
    func testAnOpenAskKeepsTheSpinnerWhileSubagentsWork() {
        var thread = ThreadSummary(id: "t", title: "t", status: .idle, needsYou: false, background: [BackgroundTask(kind: .agent, description: "Sweep")])
        thread.needs = "you"
        XCTAssertEqual(ThreadRowLook(thread).status, .background)
    }

    func testBackgroundWords() {
        let agent = { (d: String) in BackgroundTask(kind: .agent, description: d) }
        let shell = { (d: String) in BackgroundTask(kind: .shell, description: d) }
        XCTAssertEqual(BackgroundWork.short([agent("a"), agent("b"), agent("c")]), "3 sub-agents")
        XCTAssertEqual(BackgroundWork.short([agent("a")]), "1 sub-agent")
        XCTAssertEqual(BackgroundWork.short([shell("npm test")]), "1 job")
        XCTAssertEqual(BackgroundWork.short([shell("a"), shell("b")]), "2 jobs")
        XCTAssertEqual(BackgroundWork.short([agent("a"), shell("b")]), "2 jobs")
        XCTAssertEqual(BackgroundWork.short([BackgroundTask(kind: .monitor, description: "")]), "1 monitor")
        XCTAssertEqual(BackgroundWork.short([BackgroundTask(kind: .agent, description: "a", finished: true)]), "Finishing")
        XCTAssertEqual(BackgroundWork.short([agent("a"), BackgroundTask(kind: .agent, description: "b", finished: true)]), "1 sub-agent")

        XCTAssertEqual(BackgroundWork.line([agent("a"), agent("b"), agent("c")]), "3 sub-agents working in the background")
        XCTAssertEqual(BackgroundWork.line([shell("npm test")]), "1 job running in the background")
        XCTAssertEqual(BackgroundWork.line([agent("a"), agent("b"), shell("npm test")]), "2 sub-agents and 1 job running in the background")
        XCTAssertEqual(BackgroundWork.line([agent("a"), shell("b"), BackgroundTask(kind: .monitor, description: "c")]), "1 sub-agent, 1 job and 1 monitor running in the background")
        XCTAssertEqual(BackgroundWork.line([agent("a"), BackgroundTask(kind: .agent, description: "b", finished: true)]), "1 sub-agent working in the background, 1 just finished")
        XCTAssertEqual(BackgroundWork.line([BackgroundTask(kind: .agent, description: "b", finished: true)]), "1 sub-agent just finished, about to read its result")
        XCTAssertEqual(BackgroundWork.line([BackgroundTask(kind: .shell, description: "b", finished: true), BackgroundTask(kind: .agent, description: "c", finished: true)]), "2 jobs just finished, about to read their results")

        XCTAssertEqual(BackgroundWork.detail([agent("Rebuild page A"), BackgroundTask(kind: .shell, description: "", finished: true)]), "Rebuild page A\n1 job (finished)")
        XCTAssertEqual(BackgroundWork.lineWithDetail([agent("Rebuild page A"), agent("Rebuild page B")]), "2 sub-agents working in the background · Rebuild page A, Rebuild page B")
        XCTAssertEqual(BackgroundWork.lineWithDetail([BackgroundTask(kind: .other, description: "")]), "1 task running in the background")
        let long = String(repeating: "x", count: 70) + "\nsecond line"
        XCTAssertEqual(BackgroundWork.lineWithDetail([shell(long)]), "1 job running in the background · " + String(repeating: "x", count: 59) + "…")
    }

    func testStatusInWords() {
        XCTAssertEqual(look(.idle), ThreadRowLook(status: .time, unread: false, emphasised: false))
        XCTAssertEqual(look(.running), ThreadRowLook(status: .working, unread: false, emphasised: false))
        XCTAssertEqual(look(.starting).status, .working)
        XCTAssertEqual(look(.error).status, .failed)
        XCTAssertEqual(look(.stopped).status, .stopped)
        XCTAssertEqual(ThreadRowStatus.working.label, "Working")
        XCTAssertEqual(ThreadRowStatus.needsYou.label, "Needs you")
        XCTAssertNil(ThreadRowStatus.time.label)
    }

    /// Waiting on Mike says "Needs you" in words, so it gets no unread dot
    /// as well; a finished, unread thread gets the dot and the time.
    func testUnreadDotOnlyForFinishedThreads() {
        XCTAssertEqual(look(.waiting, needsYou: true), ThreadRowLook(status: .needsYou, unread: true, emphasised: true))
        XCTAssertEqual(look(.waiting), ThreadRowLook(status: .needsYou, unread: true, emphasised: true))
        XCTAssertEqual(look(.idle, needsYou: true), ThreadRowLook(status: .time, unread: true, emphasised: true))
        XCTAssertEqual(look(.error, needsYou: true), ThreadRowLook(status: .failed, unread: true, emphasised: true))
        XCTAssertFalse(look(.running, needsYou: true).unread)
    }

    /// Under "Running" a working row doesn't say "Working" again; a row
    /// whose state differs from its section still says its word. A waiting
    /// row has the dot rather than a word.
    func testSectionWordsAreNotRepeated() {
        func look(_ status: ThreadStatus, needsYou: Bool = false, in section: InboxSection) -> ThreadRowLook {
            ThreadRowLook(ThreadSummary(id: "t", title: "t", status: status, needsYou: needsYou), section: section)
        }
        XCTAssertEqual(look(.running, in: .running), ThreadRowLook(status: .working, unread: false, emphasised: false, labelled: false))
        XCTAssertEqual(look(.starting, in: .running).labelled, false)
        XCTAssertEqual(look(.waiting, in: .inbox), ThreadRowLook(status: .needsYou, unread: true, emphasised: true, labelled: true))
        XCTAssertEqual(look(.idle, needsYou: true, in: .inbox), ThreadRowLook(status: .time, unread: true, emphasised: true))
        XCTAssertTrue(look(.error, needsYou: true, in: .inbox).labelled)
        XCTAssertTrue(look(.stopped, in: .inbox).labelled)
        // Outside the inbox (snoozed, archived) there's no section to lean on.
        XCTAssertTrue(ThreadRowLook(ThreadSummary(id: "t", title: "t", status: .waiting)).labelled)
    }

    func testSectionTitles() {
        XCTAssertEqual(InboxSection.allCases.map(\.title), ["Starred", "Inbox", "Running", "Hibernating", "Archived"])
        let sections = ThreadSections(inbox: [ThreadSummary(id: "b", title: "b")], running: [ThreadSummary(id: "a", title: "a")])
        XCTAssertEqual(sections[.running].map(\.id), ["a"])
        XCTAssertEqual(sections[.inbox].map(\.id), ["b"])
        XCTAssertEqual(sections.all.map(\.id), ["b", "a"])
    }

    func testAccountShortNames() {
        let accounts = [
            Account(id: "claude-main", title: "mike@example.com"),
            Account(id: "claude-3", title: "mike+3@example.com"),
            Account(id: "work", title: "mike@work.example"),
            Account(id: "local", title: "Local"),
        ]
        XCTAssertEqual(AccountName.short("claude-3", accounts: accounts), "mike+3")
        // Two accounts share "mike", so both keep their whole address.
        XCTAssertEqual(AccountName.short("claude-main", accounts: accounts), "mike@example.com")
        XCTAssertEqual(AccountName.short("local", accounts: accounts), "Local")
        XCTAssertEqual(AccountName.short("gone", accounts: accounts), "gone")
    }

    func testProjectMark() {
        XCTAssertEqual(ProjectMark.letter("convex docs"), "C")
        XCTAssertEqual(ProjectMark.letter("  7 day plan"), "7")
        XCTAssertEqual(ProjectMark.letter("🐻 Threadbear"), "T")
        XCTAssertEqual(ProjectMark.letter("🐻"), "?")
        XCTAssertEqual(ProjectMark.letter(""), "?")
    }

    func testProjectMarkForNoneOneAndTwoProjects() {
        var thread = ThreadSummary(id: "t", title: "t", cwd: "/Users/mike/dev/me/misc")
        XCTAssertEqual(ProjectMark.shown(thread), [])
        XCTAssertEqual(ProjectMark.place(thread), "misc", "no project: the folder")
        XCTAssertEqual(ProjectMark.help(thread), "/Users/mike/dev/me/misc")
        thread.projects = [ThreadProject(id: "a", title: "Threadbear")]
        XCTAssertEqual(ProjectMark.place(thread), "Threadbear")
        thread.projects.append(ThreadProject(id: "b", title: ""))
        XCTAssertEqual(ProjectMark.shown(thread).map(\.id), ["a", "b"])
        XCTAssertEqual(ProjectMark.place(thread), "Threadbear, Untitled project")
        XCTAssertEqual(ProjectMark.help(thread), "Threadbear, Untitled project")
        // Under a project's heading the row names only the others, and its
        // folder when there are none.
        XCTAssertEqual(ProjectMark.place(thread, under: "a"), "Untitled project")
        XCTAssertEqual(ProjectMark.shown(thread, under: "b").map(\.id), ["a"])
        thread.projects.removeLast()
        XCTAssertEqual(ProjectMark.place(thread, under: "a"), "misc")
    }

    func testRowLineIsThePlaceWithWhatMikeAskedAsItsTip() throws {
        var thread = ThreadSummary(id: "t", title: "t", cwd: "/Users/mike/dev/me/misc")
        XCTAssertEqual(ProjectMark.lineTip(thread), "misc", "nothing asked: the tip names the place")
        thread.asked = "try the GPU route"
        XCTAssertEqual(ProjectMark.lineTip(thread), "You: try the GPU route")
        // A runner's summary carries it as `asked`.
        let json = #"{"id":"t","title":"t","asked":"ship it"}"#
        let decoded = try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.asked, "ship it")
    }

    func testFolderName() {
        XCTAssertEqual(FolderName.short("/Users/mike/dev/me/misc"), "misc")
        XCTAssertEqual(FolderName.short("~/dev/photo-sync/"), "photo-sync")
        XCTAssertEqual(FolderName.short("~"), "~")
        XCTAssertEqual(FolderName.short("/"), "/")
        XCTAssertEqual(FolderName.short(""), "")
    }

    func testKeyboardOrder() {
        let ids = ["a", "b", "c"]
        XCTAssertEqual(SidebarOrder.neighbour(of: "a", in: ids, step: 1), "b")
        XCTAssertEqual(SidebarOrder.neighbour(of: "c", in: ids, step: 1), "c", "stops at the end")
        XCTAssertEqual(SidebarOrder.neighbour(of: "a", in: ids, step: -1), "a", "stops at the start")
        XCTAssertEqual(SidebarOrder.neighbour(of: nil, in: ids, step: 1), "a")
        XCTAssertEqual(SidebarOrder.neighbour(of: "gone", in: ids, step: -1), "c")
        XCTAssertNil(SidebarOrder.neighbour(of: "a", in: [], step: 1))
    }

    func testNextInInbox() {
        let inbox = ["a", "b", "c"]
        XCTAssertEqual(SidebarOrder.nextInInbox(after: "a", inbox: inbox), "b")
        XCTAssertNil(SidebarOrder.nextInInbox(after: "c", inbox: inbox), "the last one has nothing after it")
        XCTAssertEqual(SidebarOrder.nextInInbox(after: "running", inbox: inbox), "a", "from another section, the first")
        XCTAssertEqual(SidebarOrder.nextInInbox(after: nil, inbox: inbox), "a", "nothing open, the first")
        XCTAssertNil(SidebarOrder.nextInInbox(after: nil, inbox: []), "an empty inbox")
        XCTAssertNil(SidebarOrder.nextInInbox(after: "running", inbox: []))
    }
}

final class ComposerPlacementTests: XCTestCase {
    func testAtTheBottomUnderAThread() {
        XCTAssertEqual(ComposerPlacementMath.composerTop(paneHeight: 700, composerHeight: 110, centred: false), 590)
    }

    /// An empty new thread: the composer's middle about 40% down.
    func testAboutFortyPercentDownForANewThread() {
        let top = ComposerPlacementMath.composerTop(paneHeight: 700, composerHeight: 112, centred: true, headingHeight: 30, noteHeight: 16)
        XCTAssertEqual(top, 224)
        XCTAssertEqual((top + 56) / 700, 0.4, accuracy: 0.01)
    }

    /// Typing grows the composer downwards; its top stays put.
    func testGrowingComposerKeepsItsTop() {
        let empty = ComposerPlacementMath.composerTop(paneHeight: 700, composerHeight: 112, centred: true)
        let tall = ComposerPlacementMath.composerTop(paneHeight: 700, composerHeight: 260, centred: true)
        XCTAssertEqual(empty, tall)
    }

    func testShortWindowsKeepTheHeadingAndTheNoteOnScreen() {
        // The heading needs 30 + 40 above the composer.
        XCTAssertEqual(ComposerPlacementMath.composerTop(paneHeight: 300, composerHeight: 110, centred: true, headingHeight: 30, noteHeight: 16), 70)
        // Too short for everything: the composer and its note stay on screen.
        XCTAssertEqual(ComposerPlacementMath.composerTop(paneHeight: 180, composerHeight: 110, centred: true, headingHeight: 30, noteHeight: 16), 54)
        XCTAssertEqual(ComposerPlacementMath.composerTop(paneHeight: 80, composerHeight: 110, centred: true), 0)
    }
}

final class DockBadgeTests: XCTestCase {
    /// The badge's count is its own loop now, so it must keep agreeing with
    /// the sections it stands in for, on every kind of thread.
    func testCountAgreesWithTheSectionsOnEveryMixOfState() {
        let now = Date()
        let later = now.addingTimeInterval(3600)
        var threads: [ThreadSummary] = []
        for status in [ThreadStatus.idle, .running, .starting, .waiting, .error, .stopped] {
            for needsYou in [false, true] {
                for snoozed in [nil, later, now.addingTimeInterval(-3600)] as [Date?] {
                    for starred in [nil, now] as [Date?] {
                        for archived in [nil, now] as [Date?] {
                            for needs in [nil, "you", "nothing"] as [String?] {
                                for reviews in [nil, 1] as [Int?] {
                                    var thread = ThreadSummary(id: "\(threads.count)", title: "t", status: status, needsYou: needsYou, snoozedUntil: snoozed, archivedAt: archived, needs: needs)
                                    thread.starredAt = starred
                                    thread.pendingReviews = reviews
                                    threads.append(thread)
                                }
                            }
                        }
                    }
                }
            }
        }
        XCTAssertEqual(ThreadSections.needsYouCount(threads, now: now), ThreadSections.build(threads, now: now).needsYou.count)
        for thread in threads {
            XCTAssertEqual(ThreadSections.needsYouCount([thread], now: now), ThreadSections.build([thread], now: now).needsYou.count, "\(thread)")
        }
    }

    #if DEBUG
    /// It runs on every thread update, on the main thread, so no sorting
    /// every thread for a number (THREADBEAR-1B).
    func testBadgeDoesNotBuildTheSections() {
        let threads = [ThreadSummary(id: "a", title: "a", status: .waiting)]
        let before = ThreadSections.buildCount
        XCTAssertEqual(DockBadge.label(for: threads, now: Date()), "1")
        XCTAssertEqual(ThreadSections.buildCount, before)
    }
    #endif

    /// The sorts moved to pulled-out keys: the orders mustn't have changed.
    func testSectionOrdersAreWhatTheyWere() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        func at(_ minutes: Double) -> Date { t0.addingTimeInterval(minutes * 60) }
        var starA = ThreadSummary(id: "starA", title: "", lastActivityAt: at(9)); starA.starredAt = at(2)
        var starB = ThreadSummary(id: "starB", title: "", lastActivityAt: at(1)); starB.starredAt = at(1)
        let threads = [
            starA, starB,
            ThreadSummary(id: "read", title: "", status: .idle, lastActivityAt: at(30)),
            ThreadSummary(id: "unread", title: "", needsYou: true, lastActivityAt: at(5)),
            ThreadSummary(id: "unreadNewer", title: "", needsYou: true, lastActivityAt: at(6)),
            ThreadSummary(id: "brokenUnread", title: "", status: .error, needsYou: true, lastActivityAt: at(1)),
            ThreadSummary(id: "asks", title: "", status: .waiting, lastActivityAt: at(0)),
            ThreadSummary(id: "tieB", title: "", status: .running, lastActivityAt: at(3)),
            ThreadSummary(id: "tieA", title: "", status: .running, lastActivityAt: at(3)),
            ThreadSummary(id: "runNew", title: "", status: .running, lastActivityAt: at(4)),
            ThreadSummary(id: "snoozeLate", title: "", lastActivityAt: at(1), snoozedUntil: at(200)),
            ThreadSummary(id: "snoozeSoon", title: "", lastActivityAt: at(1), snoozedUntil: at(100)),
            ThreadSummary(id: "archOld", title: "", archivedAt: at(1)),
            ThreadSummary(id: "archNew", title: "", archivedAt: at(2)),
        ]
        let needsFirst = ThreadSections.build(threads.shuffled(), now: at(50))
        XCTAssertEqual(needsFirst.starred.map(\.id), ["starB", "starA"])
        XCTAssertEqual(needsFirst.inbox.map(\.id), ["asks", "brokenUnread", "unreadNewer", "unread", "read"])
        XCTAssertEqual(needsFirst.running.map(\.id), ["runNew", "tieA", "tieB"])
        XCTAssertEqual(needsFirst.hibernating.map(\.id), ["snoozeSoon", "snoozeLate"])
        XCTAssertEqual(needsFirst.archived.map(\.id), ["archNew", "archOld"])
        XCTAssertEqual(ThreadSections.build(threads.shuffled(), now: at(50), order: .newest).inbox.map(\.id), ["read", "unreadNewer", "unread", "brokenUnread", "asks"])
        XCTAssertEqual(ThreadSections.build(threads.shuffled(), now: at(50), order: .oldest).inbox.map(\.id), ["asks", "brokenUnread", "unread", "unreadNewer", "read"])
    }

    func testBadgeCountsThreadsThatNeedYouAndNothingElse() {
        let now = Date()
        let waiting = ThreadSummary(id: "a", title: "a", status: .waiting)
        let unread = ThreadSummary(id: "b", title: "b", needsYou: true)
        let running = ThreadSummary(id: "c", title: "c", status: .running)
        let snoozed = ThreadSummary(id: "d", title: "d", needsYou: true, snoozedUntil: now.addingTimeInterval(3600))
        let archived = ThreadSummary(id: "e", title: "e", needsYou: true, archivedAt: now)
        XCTAssertEqual(DockBadge.label(for: [waiting, unread, running, snoozed, archived], now: now), "2")
        XCTAssertNil(DockBadge.label(for: [running], now: now))
        XCTAssertNil(DockBadge.label(needsYou: 0))
    }

    func testAThreadMikeDidNotStartIsMarkedAndStillNamesItsPlace() {
        var thread = ThreadSummary(id: "t", title: "t", cwd: "/x/misc", status: .idle)
        XCTAssertNil(ThreadByline.line(thread), "his own row doesn't change")

        thread.startedBy = ThreadStartedBy(kind: "tool", label: "Sentry", icon: "ladybug", why: "1 event, 0 users")
        XCTAssertEqual(ThreadByline.line(thread), .init(symbol: "ladybug", text: "misc", tip: "Started by Sentry (1 event, 0 users)"))

        thread.startedBy = ThreadStartedBy(kind: "thread", label: "Agent", threadTitle: "Poddle fix")
        XCTAssertEqual(ThreadByline.line(thread), .init(symbol: "pawprint", text: "misc", tip: "Started by another thread: Poddle fix"))

        thread.startedBy = ThreadStartedBy(kind: "librarian", label: "Librarian", why: "")
        XCTAssertEqual(ThreadByline.line(thread)?.tip, "Started by the librarian", "an empty why adds nothing")

        // A tool with no symbol, and a kind from a newer runner.
        thread.startedBy = ThreadStartedBy(kind: "someday", label: "Thing")
        XCTAssertEqual(ThreadByline.line(thread)?.symbol, ThreadByline.toolSymbol)

        // A schedule's thread from before startedBy.
        thread.startedBy = nil
        thread.schedule = ThreadSchedule(id: "s", title: "Nightly")
        XCTAssertEqual(ThreadByline.line(thread), .init(symbol: "clock", text: "misc", tip: "Started by Schedule"))
    }

    func testStartedByDecodesFromTheRunnerAndABadOneIsIgnored() throws {
        func decode(_ startedBy: String) throws -> ThreadSummary {
            try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"t","title":"t","startedBy":\#(startedBy)}"#.utf8))
        }
        XCTAssertEqual(try decode(#"{"kind":"tool","label":"Sentry","why":"2 events"}"#).startedBy, ThreadStartedBy(kind: "tool", label: "Sentry", why: "2 events"))
        XCTAssertNil(try decode(#""nonsense""#).startedBy)
    }
}
