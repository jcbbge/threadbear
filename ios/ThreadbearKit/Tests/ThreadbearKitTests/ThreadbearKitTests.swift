import Foundation
import CoreGraphics
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import ThreadbearKit

@Suite struct DecodingTests {
    @Test func identityCarriesTheBackendVersionAndOldBackendsAreSaidToBeOld() throws {
        let current = try JSONDecoder().decode(PhoneIdentity.self, from: Data(#"{"name":"iphone","expiresAt":"2027-01-26T00:00:00.000Z","apiVersion":1}"#.utf8))
        #expect(current.apiVersion == 1)
        #expect(BackendCompatibility.problem(current) == nil)
        // A backend deployed before convex/version.ts has no apiVersion at all.
        let old = try JSONDecoder().decode(PhoneIdentity.self, from: Data(#"{"name":"iphone","expiresAt":"2027-01-26T00:00:00.000Z"}"#.utf8))
        #expect(old.apiVersion == nil)
        #expect(BackendCompatibility.problem(old) != nil)
    }

    @Test func messagePageDecodesToolLinesAndGroupsThem() throws {
        let json = #"""
        {"hasMore":true,"messages":[
          {"seq":10.0,"role":"user","text":"Ship it","at":"2026-10-28T00:00:00.000Z"},
          {"seq":11.0,"role":"tool","text":"Run the unit tests","toolKind":"command","at":"2026-10-28T00:00:01.000Z"},
          {"seq":12.0,"role":"tool","text":"Edited ~/dev/x.ts","toolKind":"edit","at":"2026-10-28T00:00:02.000Z"},
          {"seq":13.0,"role":"assistant","text":"Done.","at":"2026-10-28T00:00:03.000Z"},
          {"seq":14.0,"role":"tool","text":"Read README.md","toolKind":"read","at":"2026-10-28T00:00:04.000Z"}
        ]}
        """#
        let page = try JSONDecoder().decode(MessagePage.self, from: Data(json.utf8))
        #expect(page.hasMore)
        #expect(page.messages[1].role == .tool && page.messages[1].toolKind == "command")
        let items = ThreadItem.group(page.messages)
        #expect(items.count == 4)
        guard case let .tools(run) = items[1] else { Issue.record("expected a tool run"); return }
        #expect(run.map(\.seq) == [11, 12])
        guard case .tools = items[3] else { Issue.record("expected a trailing run"); return }
        #expect(items.map(\.id) == [10, 11, 13, 14])
    }

    /// Sealed in Node the way convex/push.ts seal() does, with a key of 32
    /// sevens: the phone must open what the backend seals.
    @Test func pushSealOpensWhatTheBackendSealed() {
        let key = Data(repeating: 7, count: 32)
        let opened = PushSeal.open("AiSVcm4cKdtZwL3c/Uwy7/xLI/glgedZynZE0KGAPg1kAmJEyB2VjF4/jTFQARFe9Fvu853UYEiuEU6uMrlKm9HezW8YilUyjUeS13rAMw==", key: key)
        #expect(opened?.title == "Fix the dock")
        #expect(opened?.body == "Should I push it?")
        #expect(PushSeal.open("AiSVcm4cKdtZwL3c/Uwy7/xLI/glgedZynZE0KGAPg1kAmJEyB2VjF4/jTFQARFe9Fvu853UYEiuEU6uMrlKm9HezW8YilUyjUeS13rAMw==", key: Data(repeating: 8, count: 32)) == nil, "the wrong key opens nothing")
    }

    @Test func wokenThreadSaysSoUntilOpened() throws {
        let json = """
        {"threadId":"t1","runnerId":"m5","title":"A","cwd":"/x","accountId":"claude-3","provider":"claude",
         "status":"idle","needsYou":true,"unread":true,"preview":"","lastActivityAt":"2026-10-27T08:23:19.962Z",
         "woke":{"at":"2026-10-30T02:24:21.575Z","since":"2026-10-30T02:23:21.575Z"}}
        """
        var row = try JSONDecoder().decode(PhoneThread.self, from: Data(json.utf8))
        #expect(row.woke?.since != nil)
        #expect(RowStatus.text(row, now: Date()) == "Woke up")
        row.woke = nil
        #expect(RowStatus.text(row, now: row.lastActivityAt) == "now")
        // A turn running on it says so instead.
        row.woke = Woke(at: Date())
        row.status = .running
        #expect(RowStatus.text(row, now: Date()) == "Working")
    }

    @Test func threadRowDecodesWithISOAndMillisecondDates() throws {
        let json = """
        [{"threadId":"t1","runnerId":"m5","title":"A","cwd":"/Users/m/dev/me/misc","accountId":"claude-3",
          "provider":"claude","status":"running","needsYou":false,"unread":true,"preview":"hi",
          "lastActivityAt":"2026-10-27T08:23:19.962Z","snoozedUntil":1761553399962,"working":"Running npm test",
          "projects":[{"id":"p1","title":"Threadbear"}]},
         {"threadId":"t2","runnerId":"m5","title":"B","cwd":"/x","accountId":"a","provider":"codex",
          "status":"somethingNew","needsYou":true,"unread":false,"preview":"","lastActivityAt":1761553399962,
          "pendingApproval":{"approvalId":"ap","kind":"approval","name":"Bash","title":"Run","options":["allow","deny","later"],"inputSummary":"ls"}}]
        """
        let rows = try JSONDecoder().decode([PhoneThread].self, from: Data(json.utf8))
        #expect(rows.count == 2)
        #expect(rows[0].status == .running)
        #expect(rows[0].snoozedUntil != nil)
        #expect(rows[0].archivedAt == nil)
        #expect(rows[0].woke == nil)
        #expect(rows[0].placeText == "Threadbear")
        #expect(rows[1].status == .unknown)
        #expect(rows[1].folderName == "x")
        guard case let .approval(_, _, _, options, summary) = rows[1].pendingApproval else {
            Issue.record("expected an approval")
            return
        }
        #expect(options == [.allow, .deny])
        #expect(summary == "ls")
    }

    @Test func questionAndMessagesDecode() throws {
        let json = """
        {"thread":{"threadId":"t","runnerId":"m5","title":"Q","cwd":"/","accountId":"a","provider":"claude",
          "status":"waiting","needsYou":true,"unread":false,"preview":"","lastActivityAt":0,
          "pendingApproval":{"approvalId":"q","kind":"question","questions":[{"question":"Which?","multiSelect":false,"options":[{"label":"A"}]}]}},
         "messages":[{"seq":3.0,"role":"user","text":"go","origin":"phone","at":1000}]}
        """
        let detail = try JSONDecoder().decode(ThreadDetail.self, from: Data(json.utf8))
        #expect(detail.messages.first?.seq == 3)
        #expect(detail.messages.first?.origin == "phone")
        guard case let .question(id, questions) = detail.thread.pendingApproval else {
            Issue.record("expected a question")
            return
        }
        #expect(id == "q")
        #expect(questions.first?.options.first?.label == "A")
    }

    @Test func nullDetailDecodes() throws {
        let detail = try JSONDecoder().decode(ThreadDetail?.self, from: Data("null".utf8))
        #expect(detail == nil)
    }
}

@Suite struct InboxTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func thread(_ id: String, _ minutesAgo: Double, status: ThreadStatus = .idle, needsYou: Bool = false,
                approval: Bool = false, working: String? = nil, snoozed: Bool = false) -> PhoneThread {
        PhoneThread(threadId: id, title: id, status: status, needsYou: needsYou,
                    lastActivityAt: now.addingTimeInterval(-minutesAgo * 60),
                    snoozedUntil: snoozed ? now.addingTimeInterval(600) : nil, working: working,
                    pendingApproval: approval ? .approval(id: "x", name: "", title: "", options: [.allow], inputSummary: nil) : nil)
    }

    @Test func ordersByUrgencyThenNewest() {
        let sections = InboxSections.build([
            thread("done", 1),
            thread("unread", 5, needsYou: true),
            thread("asking", 30, status: .waiting, approval: true),
            thread("failed", 2, status: .error, needsYou: true),
            thread("busy", 0, status: .running, working: "Bear with me"),
            thread("background", 3, working: "1 sub-agent"),
            thread("snoozed", 0, snoozed: true),
        ], now: now)
        #expect(sections.inbox.map(\.threadId) == ["asking", "failed", "unread", "done"])
        #expect(sections.running.map(\.threadId) == ["busy", "background"])
        #expect(sections.needsYouCount == 3)
    }

    /// The Mac's ThreadSectionsTests.testStarredThreadsStayAtTheTop, on the phone.
    @Test func starredThreadsStayAtTheTop() {
        func starred(_ thread: PhoneThread, _ minutesAgo: Double) -> PhoneThread {
            var thread = thread
            thread.starredAt = now.addingTimeInterval(-minutesAgo * 60)
            return thread
        }
        var archived = starred(thread("archived", 0), 40)
        archived.archivedAt = now
        let sections = InboxSections.build([
            starred(thread("second", 0), 10),
            starred(thread("asleep", 0, needsYou: true, snoozed: true), 20),
            starred(thread("first", 9, status: .running), 30),
            starred(thread("asks", 0, needsYou: true), 5),
            archived,
            thread("plain", 0),
        ], now: now)
        #expect(sections.starred.map(\.threadId) == ["first", "asleep", "second", "asks"], "stays in the order they were starred")
        #expect(sections.inbox.map(\.threadId) == ["plain"])
        #expect(sections.running.isEmpty)
        #expect(sections.needsYouCount == 1, "asks counts; asleep doesn't, as it's hibernating")
        #expect(ThreadSearch("asks", sections: sections, hibernating: [], archived: []).starred.map(\.threadId) == ["asks"])
    }

    @Test func foldsLeaveStarredOpen() {
        #expect(!SectionFolds(saved: nil).isFolded(.starred))
        #expect(!SectionFolds(saved: ["running"]).isFolded(.starred))
    }

    /// The Mac's ThreadSectionsTests.testBookedThreadsWait, on the phone: a
    /// thread that has booked itself a message for later, and has nothing
    /// for Mike, goes under Hibernating with the snoozed ones, soonest to
    /// wake first, rather than sitting in the inbox. Anything it still wants
    /// from him keeps it in the inbox.
    @Test func bookedThreadsWait() {
        var said = thread("said-done-unread", 1)
        said.needs = "nothing"
        said.unread = true
        var asked = thread("asked-read", 2)
        asked.needs = "you"
        var review = thread("review", 10)
        review.pendingReviews = 1
        var noRoom = thread("no-room", 11)
        noRoom.waitingForRoom = PhoneWaitingForRoom(until: "2026-10-30T12:00:00.000Z")
        let threads = [
            thread("read", 5),
            said,
            asked,
            thread("unread", 3, needsYou: true),
            thread("question", 4, status: .waiting, approval: true),
            thread("failed", 6, status: .error),
            thread("running", 7, status: .running),
            thread("no-wake", 8),
            thread("woken", 9),
            review,
            noRoom,
        ]
        let schedules = [
            PhoneSchedule(id: "1", threadId: "read", nextRunAt: now.addingTimeInterval(600)),
            PhoneSchedule(id: "2", threadId: "said-done-unread", nextRunAt: now.addingTimeInterval(120)),
            // A later one for the same thread: the soonest counts.
            PhoneSchedule(id: "3", threadId: "said-done-unread", nextRunAt: now.addingTimeInterval(9000)),
            PhoneSchedule(id: "4", threadId: "asked-read", nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "5", threadId: "unread", nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "6", threadId: "question", nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "7", threadId: "failed", nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "8", threadId: "running", nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "9", threadId: "no-wake", paused: true, nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "10", threadId: "woken", nextRunAt: now.addingTimeInterval(60), finishedAt: now),
            PhoneSchedule(id: "12", threadId: "review", nextRunAt: now.addingTimeInterval(60)),
            PhoneSchedule(id: "13", threadId: "no-room", nextRunAt: now.addingTimeInterval(60)),
            // Starts new threads: nobody waits on it.
            PhoneSchedule(id: "11", nextRunAt: now.addingTimeInterval(30)),
        ]
        let wakes = InboxSections.wakes(schedules)
        #expect(wakes["said-done-unread"]?.id == "2")
        #expect(wakes["no-wake"] == nil)
        #expect(wakes["woken"] == nil)
        let sections = InboxSections.build(threads, now: now, wakes: wakes)
        #expect(sections.scheduled.map(\.threadId) == ["said-done-unread", "read"])
        // Snoozed by Mike, from the backend's hibernating list: in among
        // them by when it wakes, and once only if it's mid-move.
        var snoozed = thread("snoozed", 12)
        snoozed.snoozedUntil = now.addingTimeInterval(300)
        var restart = thread("restart", 13)
        restart.snoozedUntilRestart = true
        let rows = InboxSections.hibernating(scheduled: sections.scheduled, snoozed: [restart, snoozed, sections.scheduled[1]], wakes: wakes)
        #expect(rows.map(\.threadId) == ["said-done-unread", "snoozed", "read", "restart"])
        let search = ThreadSearch("e", sections: sections, hibernating: [snoozed], archived: [], wakes: wakes)
        #expect(search.hibernating.map(\.threadId) == ["said-done-unread", "snoozed", "read"])
        #expect(Set(sections.inbox.map(\.threadId)) == ["asked-read", "unread", "question", "failed", "no-wake", "woken", "review", "no-room"])
        #expect(sections.running.map(\.threadId) == ["running"])
    }

    /// A design review waiting on Mike counts as a question once the
    /// thread has finished working, as on the Mac (reviewWaiting).
    @Test func aWaitingReviewNeedsYou() {
        var review = thread("review", 30)
        review.pendingReviews = 1
        var busy = thread("busy", 1, status: .running)
        busy.pendingReviews = 1
        let sections = InboxSections.build([thread("unread", 1, needsYou: true), review, busy], now: now)
        #expect(sections.inbox.map(\.threadId) == ["review", "unread"])
        #expect(sections.running.map(\.threadId) == ["busy"])
        #expect(RowStatus.kind(review) == .needsYou)
    }

    /// Everything but Inbox starts folded, and a folded put-away section
    /// isn't loaded, unless a search wants it.
    @Test func foldedSectionsAreNotLoaded() {
        var folds = SectionFolds(saved: nil)
        #expect(!folds.isFolded(.inbox))
        #expect(PhoneSection.allCases.filter(folds.isFolded) == [.running, .hibernating, .archived])
        #expect(folds.views(searching: false) == [.inbox])
        #expect(folds.views(searching: true) == [.inbox, .hibernating, .den])
        folds.toggle(.archived)
        folds.toggle(.inbox)
        #expect(folds.views(searching: false) == [.inbox, .den])
        #expect(!folds.isFolded(.inbox))
        let back = SectionFolds(saved: folds.saved + ["someday"])
        #expect(back == folds)
        #expect(SectionFolds(saved: []).views(searching: false) == [.inbox, .hibernating, .den])
    }

    @Test func countsDecode() throws {
        let counts = try JSONDecoder().decode(PhoneCounts.self, from: Data(#"{"hibernating":3,"den":309.0}"#.utf8))
        #expect(counts == PhoneCounts(hibernating: 3, den: 309))
    }

    @Test func scheduleRowsDecode() throws {
        let json = #"""
        [{"runnerId":"r1","id":"s1","title":"Check","text":"look","whenText":"Every day at 8:00","threadId":"t1","paused":false,
          "createdAt":"2026-10-30T08:00:00.000Z","updatedAt":"2026-10-30T08:00:00.000Z","nextRunAt":"2026-10-31T08:00:00.000Z","runs":3},
         {"runnerId":"r1","id":"s2","title":"New","text":"x","whenText":"Once","cwd":"~/x","paused":true,
          "createdAt":"2026-10-30T08:00:00.000Z","updatedAt":"2026-10-30T08:00:00.000Z","runs":0}]
        """#
        let rows = try JSONDecoder().decode([PhoneSchedule].self, from: Data(json.utf8))
        #expect(rows.map(\.id) == ["s1", "s2"])
        #expect(rows[0].threadId == "t1" && rows[0].isActive && rows[0].nextRunAt != nil)
        #expect(rows[1].threadId == nil && !rows[1].isActive)
    }

    @Test func aQuestionStaysInTheInboxWhileBackgroundWorkRuns() {
        let sections = InboxSections.build([thread("q", 1, status: .waiting, approval: true, working: "1 sub-agent")], now: now)
        #expect(sections.inbox.map(\.threadId) == ["q"])
    }

    @Test func anOpenAskStaysInTheInboxWhileBackgroundWorkRuns() {
        func asking(_ id: String, ticked: Bool = false) -> PhoneThread {
            var t = thread(id, 1, working: "1 job")
            t.needs = "you"
            t.asks = [PhoneAsk(action: "Put the card back", ticked: ticked)]
            return t
        }
        var said = thread("said-nothing", 1, working: "1 job")
        said.needs = "nothing"
        var underway = asking("underway")
        underway.status = .running
        let sections = InboxSections.build([asking("open"), asking("ticked", ticked: true), said, underway], now: now)
        #expect(sections.inbox.map(\.threadId) == ["open"])
        #expect(Set(sections.running.map(\.threadId)) == ["ticked", "said-nothing", "underway"])
    }

    @Test func searchLooksThroughEveryListLikeTheMac() {
        var dates = thread("Dates on small screens", 1)
        dates.preview = "The **picker** fits now"
        var garden = thread("Release 1.2", 2)
        garden.projects = [ProjectRef(id: "p", title: "Garden planner")]
        let sections = InboxSections.build([dates, garden, thread("Busy picker", 0, status: .running)], now: now)
        let asleep = thread("Old picker work", 50)
        let archived = thread("Rename the settings screen", 90)

        let picker = ThreadSearch("  PICKER ", sections: sections, hibernating: [asleep], archived: [archived])
        #expect(picker.inbox.map(\.threadId) == ["Dates on small screens"])
        #expect(picker.running.map(\.threadId) == ["Busy picker"])
        #expect(picker.hibernating.map(\.threadId) == ["Old picker work"])
        #expect(picker.archived.isEmpty)

        #expect(ThreadSearch("garden", sections: sections, hibernating: [], archived: []).inbox.map(\.threadId) == ["Release 1.2"])
        #expect(ThreadSearch("séttings", sections: sections, hibernating: [], archived: [archived]).archived.count == 1)
        #expect(ThreadSearch("nothing like it", sections: sections, hibernating: [asleep], archived: [archived]).isEmpty)
        // What phone:search found past the den's 100 comes after the phone's
        // own archived matches, once each, as Convex matched it (whole words).
        let old = thread("Picker from last year", 9000)
        let withOlder = ThreadSearch("picker", sections: sections, hibernating: [], archived: [archived, asleep], olderArchived: [asleep, old])
        #expect(withOlder.archived.map(\.threadId) == ["Old picker work", "Picker from last year"])
        // Mid-move, in the inbox and hibernating at once: shown once.
        #expect(ThreadSearch("dates", sections: sections, hibernating: [dates], archived: []).hibernating.isEmpty)
    }

    @Test func rowStatusText() {
        #expect(RowStatus.text(thread("a", 1, status: .waiting, approval: true), now: now) == "Needs you")
        #expect(RowStatus.kind(thread("a", 1, status: .waiting, approval: true)) == .needsYou)
        #expect(RowStatus.text(thread("b", 1, status: .running), now: now) == "Working")
        #expect(RowStatus.text(thread("c", 5), now: now) == "5m")
        #expect(RowStatus.kind(thread("c", 5)) == .time)
        #expect(RowStatus.text(thread("d", 1, status: .error), now: now) == "Failed")
        var offline = thread("e", 1, status: .error)
        offline.waitingForNetwork = PhoneWaitingForNetwork(since: "2026-11-03T03:59:55.000Z")
        #expect(RowStatus.kind(offline) == .waitingForConnection)
        #expect(RowStatus.text(offline, now: now) == "Waiting for connection")
        let decoded = try? JSONDecoder().decode(PhoneWaitingForNetwork.self, from: Data(#"{"since":"2026-11-03T03:59:55.000Z"}"#.utf8))
        #expect(decoded?.since == "2026-11-03T03:59:55.000Z")
        #expect(RowStatus.workingLabel(since: now.addingTimeInterval(-53), now: now) == "53s")
        #expect(RowStatus.workingLabel(since: now.addingTimeInterval(-62 * 60), now: now) == "1h 2m")
    }

    @Test func projectRowsDecodeWithAndWithoutIcons() throws {
        let json = #"""
        [{"id":"p1","runnerId":"r1","title":"Garden","archived":false,"icon":{"symbol":"leaf","url":"https://x.convex.cloud/api/storage/abc","by":"librarian"}},
         {"id":"p2","runnerId":"r1","title":"Site","archived":false,"icon":{"url":"not a url","by":"mike"}},
         {"id":"p3","runnerId":"r1","title":"Old","archived":false}]
        """#
        let rows = try JSONDecoder().decode([PhoneProject].self, from: Data(json.utf8))
        #expect(rows[0].icon?.symbol == "leaf")
        #expect(rows[0].icon?.url?.host() == "x.convex.cloud")
        #expect(rows[1].icon?.url == nil)
        #expect(rows[2].icon == nil)
        #expect(ProjectMark.letter("7 day plan") == "7")
        #expect(ProjectMark.letter("🐻") == "?")
    }

    /// Every project a sample thread is in has a sample project, so the
    /// demo's rows show icons.
    @Test func sampleProjectsCoverTheSampleThreads() {
        let sample = FakeBackend.sample(now: .now)
        let ids = Set(FakeBackend.sampleProjects.map(\.id))
        for thread in sample.threads {
            for ref in thread.projects ?? [] { #expect(ids.contains(ref.id), "no sample project \(ref.id)") }
        }
    }

    @Test func previewIsPlain() {
        #expect(PreviewText.plain("**Merged** as `4700e57`, see [the PR](https://x)") == "Merged as 4700e57, see the PR")
    }
}

@Suite struct AnswersTests {
    let questions = [
        Question(question: "Which?", header: "Pick", options: [.init(label: "A"), .init(label: "B")]),
        Question(question: "Extras?", header: "Extras", multiSelect: true, options: [.init(label: "X"), .init(label: "Y")]),
    ]

    @Test func buildsAnswersLikeTheMac() {
        let answers = Answers.build(questions, chosen: [0: ["B"], 1: ["X", "Y"]], typed: "Z")
        #expect(answers == ["Which?": "B", "Extras?": "X, Y, Z"])
        #expect(Answers.summary(questions, answers: answers) == "Pick B · Extras X, Y, Z")
    }

    @Test func typedReplacesASingleChoiceOnTheLastQuestion() {
        let one = [Question(question: "Which?", options: [.init(label: "A")])]
        #expect(Answers.build(one, chosen: [0: ["A"]], typed: "something else") == ["Which?": "something else"])
    }
}

@Suite struct PairingTests {
    @Test func parsesAPairLink() throws {
        let url = URL(string: "threadbear://pair?url=https://happy-bear-123.convex.cloud&token=tb_abc")!
        let pairing = try #require(Pairing.parse(url))
        #expect(pairing.deploymentURL.absoluteString == "https://happy-bear-123.convex.cloud")
        #expect(pairing.token == "tb_abc")
        #expect(Pairing.parse(pairing.link) == pairing)
    }

    /// A self-hosted backend on the tailnet (docs/self-hosting.md): its port
    /// is kept, and anything else in the URL turns the link down.
    @Test func pairsWithATailnetBackend() throws {
        let url = URL(string: "threadbear://pair?url=https%3A%2F%2FMac.tail9ef766.ts.net%3A3210&token=tb_abc")!
        let pairing = try #require(Pairing.parse(url))
        #expect(pairing.deploymentURL.absoluteString == "https://mac.tail9ef766.ts.net:3210")
        #expect(Pairing.parse(pairing.link) == pairing)
        for bad in ["http://mac.tail9ef766.ts.net:3210", "https://user@mac.tail9ef766.ts.net:3210", "https://mac.tail9ef766.ts.net:3210/api", "https://mac.tail9ef766.ts.net:3210?x=1", "https://ts.net", "https://evil.ts.net.example.com", "https://tail9ef766.ts.net"] {
            let link = URL(string: "threadbear://pair?url=\(bad.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)&token=t")!
            #expect(Pairing.parse(link) == nil, "\(bad)")
        }
    }

    /// An older backend leaves pushOff out, and that means it can send.
    @Test func onlyABackendThatSaysSoCantNotify() {
        #expect(PhoneIdentity(name: "p", expiresAt: nil).sendsNotifications)
        #expect(PhoneIdentity(name: "p", expiresAt: nil, pushOff: false).sendsNotifications)
        #expect(!PhoneIdentity(name: "p", expiresAt: nil, pushOff: true).sendsNotifications)
    }

    @Test func siteURLBecomesCloud() throws {
        let url = URL(string: "threadbear://pair?url=https://happy-bear-123.convex.site&token=t")!
        #expect(try #require(Pairing.parse(url)).deploymentURL.host() == "happy-bear-123.convex.cloud")
    }

    /// The runner ids and keys the Mac put in the link (runner/src/devices.ts),
    /// escaped as URLSearchParams does, and back out of `link`.
    @Test func carriesRunnerKeys() throws {
        let key = "pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk="
        let url = URL(string: "threadbear://pair?url=https%3A%2F%2Fx.convex.cloud&token=tb_1&key=0a1b2c%3ApOCSkrZRwni5dyxWn1%2BpuxPZBrRqtoyd%2BdwrRAn4ogk%3D&key=bad%3AAAAA&key=nocolon")!
        let pairing = try #require(Pairing.parse(url))
        #expect(pairing.runnerKeys == ["0a1b2c": key])
        #expect(Pairing.parse(pairing.link) == pairing)
        // Unescaped, as someone typing a link might.
        let loose = try #require(Pairing.parse(URL(string: "threadbear://pair?url=https://x.convex.cloud&token=t&key=r1:\(key)")!))
        #expect(loose.runnerKeys == ["r1": key])
        // A link from before keys: pairs as ever, with none.
        #expect(try #require(Pairing.parse(URL(string: "threadbear://pair?url=https://x.convex.cloud&token=t")!)).runnerKeys.isEmpty)
    }

    @Test func refusesOtherHosts() {
        #expect(Pairing.parse(URL(string: "threadbear://pair?url=https://evil.example.com&token=t")!) == nil)
        #expect(Pairing.parse(URL(string: "threadbear://pair?url=http://a.convex.cloud&token=t")!) == nil)
    }
}

@Suite struct FakeBackendTests {
    @Test func sendRunsATurnAndReplies() async throws {
        let backend = FakeBackend(turnDelay: .milliseconds(10))
        _ = try await backend.send(threadId: "a3", text: "thanks")
        try await Task.sleep(for: .milliseconds(100))
        var iterator = backend.thread("a3").makeAsyncIterator()
        let detail = try #require(try await iterator.next() ?? nil)
        #expect(detail.messages.suffix(2).map(\.role) == [.user, .assistant])
        #expect(detail.thread.status == .idle)
        #expect(detail.thread.unread)
    }

    /// The sample threads are what App Review and the App Store screenshots
    /// see (the pair screen's "Look around with sample threads"), so none of
    /// Mike's own projects, machines or folders can be in them.
    @Test func sampleDataHasNothingPersonal() throws {
        let sample = FakeBackend.sample(now: .now)
        let encoder = JSONEncoder()
        let text = (String(decoding: try encoder.encode(sample.threads), as: UTF8.self)
            + String(decoding: try encoder.encode(sample.messages), as: UTF8.self)
            + String(decoding: try encoder.encode(FakeBackend.sampleProjects), as: UTF8.self)).lowercased()
        for word in ["poddle", "walkies", "quick ask", "stash it", "cannvas", "bruce", "tinker", "backblaze",
                     "shed", "juice", "mike", "dev/me", "/users/", "convex.cloud"] {
            #expect(!text.contains(word), "the sample data mentions \(word)")
        }
    }

    /// The demo (and App Review) shouldn't be told to update a Mac it doesn't have.
    @Test func fakeBackendIsNeverTooOld() async throws {
        #expect(BackendCompatibility.problem(try await FakeBackend().me()) == nil)
    }

    @Test func archiveMovesToTheDen() async throws {
        let backend = FakeBackend()
        _ = try await backend.update(threadId: "a4", change: .archive)
        var den = backend.threads(.den).makeAsyncIterator()
        #expect(try await den.next()?.contains { $0.threadId == "a4" } == true)
    }

    @Test func archiveWithAVerdictMovesToTheDen() async throws {
        let backend = FakeBackend()
        _ = try await backend.update(threadId: "a4", change: .archiveWithVerdict(.worked))
        var den = backend.threads(.den).makeAsyncIterator()
        #expect(try await den.next()?.contains { $0.threadId == "a4" } == true)
    }

    /// phone:update's shape (convex/phone.ts): a plain archive stays
    /// `{archive: true}` for older backends; the verdict rides beside it.
    @Test func archiveVerdictEncoding() {
        #expect(ThreadChange.archive.json == ["archive": true])
        #expect(ThreadChange.archiveWithVerdict(.worked).json == ["archive": true, "verdict": "worked"])
        #expect(ThreadChange.archiveWithVerdict(.didntWork).json == ["archive": true, "verdict": "didntWork"])
        #expect(ThreadChange.archiveWithVerdict(.notNeeded).json == ["archive": true, "verdict": "notNeeded"])
    }
}

@Suite struct LocalAndErrorTests {
    @Test func localBackendOnlyWhenAllowed() {
        let url = URL(string: "threadbear://pair?url=http://127.0.0.1:3210&token=t")!
        #expect(Pairing.parse(url) == nil)
        #expect(Pairing.parse(url, allowLocal: true)?.deploymentURL.absoluteString == "http://127.0.0.1:3210")
    }

    @Test func anUnreadableOptionalDateIsAbsent() throws {
        let json = """
        {"threadId":"t","runnerId":"m5","title":"A","cwd":"/","accountId":"a","provider":"claude","status":"idle",
         "needsYou":false,"unread":false,"preview":"","lastActivityAt":"2026-10-27T08:23:19.962Z","lastActivityMs":1,
         "view":"inbox","createdAt":"2026-10-27T08:00:00Z","snoozedUntil":"restart"}
        """
        let row = try JSONDecoder().decode(PhoneThread.self, from: Data(json.utf8))
        #expect(row.snoozedUntil == nil)
    }

    @Test func notFoundBecomesNilForAThread() async throws {
        let backend = ConvexBackend(transport: FailingTransport(error: .notFound("no such thread")), token: "t")
        var iterator = backend.thread("x").makeAsyncIterator()
        let first = try await iterator.next()
        #expect(first == .some(nil))
    }
}

struct FailingTransport: ConvexTransport {
    var error: TransportError
    func mutation(_ name: String, _ args: [String: JSONValue]) async throws -> Data { throw error }
    func query(_ name: String, _ args: [String: JSONValue]) async throws -> Data { throw error }
    func subscribe(_ name: String, _ args: [String: JSONValue]) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish(throwing: error) }
    }
    func connectionStates() -> AsyncStream<Bool> { AsyncStream { $0.yield(true) } }
}

@Suite struct EarlierMessagesTests {
    @Test func hasEarlierFollowsEarliestSeq() {
        var thread = PhoneThread(threadId: "t", title: "t", lastActivityAt: .now)
        #expect(!thread.hasEarlier(than: 50))
        thread.earliestSeq = 3
        #expect(thread.hasEarlier(than: 50))
        #expect(!thread.hasEarlier(than: 3))
        #expect(!thread.hasEarlier(than: nil))
    }

    @Test func fakeLoadEarlierPrependsOlderMessages() async throws {
        let backend = FakeBackend(turnDelay: .milliseconds(20))
        _ = try await backend.loadEarlier(threadId: "a3", beforeSeq: 120)
        try await Task.sleep(for: .milliseconds(100))
        var iterator = backend.thread("a3").makeAsyncIterator()
        let detail = try #require(try await iterator.next() ?? nil)
        #expect(detail.messages.first?.seq == 70)
        #expect(detail.messages.map(\.seq) == detail.messages.map(\.seq).sorted())
        #expect(detail.thread.hasEarlier(than: detail.messages.first?.seq))
    }
}

/// A red PNG, `width` by `height`, with a GPS tag if asked, as ImageIO writes one.
private func samplePhoto(width: Int, height: Int, gps: Bool = false) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let out = NSMutableData()
    let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    let properties: [CFString: Any] = gps ? [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 31.9, kCGImagePropertyGPSLatitudeRef: "S", kCGImagePropertyGPSLongitude: 115.8, kCGImagePropertyGPSLongitudeRef: "E"]] : [:]
    CGImageDestinationAddImage(destination, context.makeImage()!, properties as CFDictionary)
    CGImageDestinationFinalize(destination)
    return out as Data
}

private func properties(of data: Data) -> [CFString: Any] {
    let source = CGImageSourceCreateWithData(data as CFData, nil)!
    return CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
}

@Suite struct PhotoPrepTests {
    @Test func aBigPhotoShrinksAndLosesItsLocation() throws {
        let big = samplePhoto(width: 4000, height: 3000, gps: true)
        #expect(properties(of: big)[kCGImagePropertyGPSDictionary] != nil, "the sample has a location to lose")
        let out = try #require(PhotoPrep.jpeg(from: big))
        let props = properties(of: out)
        #expect(props[kCGImagePropertyPixelWidth] as? Int == 2048)
        #expect(props[kCGImagePropertyPixelHeight] as? Int == 1536)
        #expect(props[kCGImagePropertyGPSDictionary] == nil)
    }

    @Test func aSmallPhotoIsNotBlownUp() throws {
        let props = properties(of: try #require(PhotoPrep.jpeg(from: samplePhoto(width: 300, height: 200))))
        #expect(props[kCGImagePropertyPixelWidth] as? Int == 300)
    }

    @Test func somethingElseIsNotAPhoto() {
        #expect(PhotoPrep.jpeg(from: Data("hello".utf8)) == nil)
    }

    @Test func aPreparedPhotoHasASmallThumbnail() throws {
        let prepared = try #require(PhotoPrep.prepared(from: samplePhoto(width: 4000, height: 3000)))
        #expect(properties(of: prepared.jpeg)[kCGImagePropertyPixelWidth] as? Int == 2048)
        #expect(prepared.thumbnail.width == PhotoPrep.thumbnailPixels)
        #expect(prepared.thumbnail.height == PhotoPrep.thumbnailPixels * 3 / 4)
    }
}

@Suite struct PhotoUploadTests {
    /// Waits for a discard, as dropping an upload takes its copy back in the background.
    private func firstDiscard(_ stream: AsyncStream<String>) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            group.addTask { await stream.first { _ in true } }
            group.addTask {
                try? await Task.sleep(for: .milliseconds(300))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    @Test func aPhotoNeverSentIsTakenBack() async throws {
        let (discards, sink) = AsyncStream.makeStream(of: String.self)
        var upload: PhotoUpload? = PhotoUpload(upload: { "id1" }, discard: { sink.yield($0) })
        #expect(try await upload?.storageId == "id1")
        upload = nil
        #expect(await firstDiscard(discards) == "id1")
    }

    @Test func aSentPhotoIsLeftForTheBackend() async throws {
        let (discards, sink) = AsyncStream.makeStream(of: String.self)
        var upload: PhotoUpload? = PhotoUpload(upload: { "id1" }, discard: { sink.yield($0) })
        _ = try await upload?.storageId
        upload?.keep()
        upload = nil
        #expect(await firstDiscard(discards) == nil)
    }

    @Test func aFailedUploadHasNothingToTakeBack() async {
        let (discards, sink) = AsyncStream.makeStream(of: String.self)
        var upload: PhotoUpload? = PhotoUpload(upload: { throw TransportError.server("no signal") }, discard: { sink.yield($0) })
        await #expect(throws: (any Error).self) { _ = try await upload?.storageId }
        upload = nil
        #expect(await firstDiscard(discards) == nil)
    }
}

@Test func aThreadMikeDidNotStartSaysWhoDid() {
    let decoder = JSONDecoder()
    let json = { (startedBy: String) in
        #"{"threadId":"t","runnerId":"r","title":"t","cwd":"/x/misc","accountId":"a","provider":"claude","status":"idle","needsYou":false,"unread":false,"preview":"","createdAt":"2026-11-01T00:00:00.000Z","lastActivityAt":"2026-11-01T00:00:00.000Z"\#(startedBy)}"#
    }
    let mine = try? decoder.decode(PhoneThread.self, from: Data(json("").utf8))
    #expect(mine != nil)
    #expect(mine?.bylineText == nil)
    let sentry = try? decoder.decode(PhoneThread.self, from: Data(json(#","startedBy":{"kind":"tool","label":"Sentry","icon":"ladybug","why":"1 event"}"#).utf8))
    #expect(sentry?.bylineText == "Started by Sentry (1 event)")
    #expect(sentry?.placeText == "misc", "the line names its place, as Mike's own do")
    #expect(sentry?.startedBy?.symbol == "ladybug")
    let agent = try? decoder.decode(PhoneThread.self, from: Data(json(#","startedBy":{"kind":"thread","label":"Agent"}"#).utf8))
    #expect(agent?.bylineText == "Started by Agent")
    #expect(agent?.startedBy?.symbol == "pawprint")
}

@Test func aThreadsLinkButtonsOnlyOpenWebPages() throws {
    let json = #"{"threadId":"t","runnerId":"r","title":"t","cwd":"/x","accountId":"a","provider":"claude","status":"idle","needsYou":false,"unread":false,"preview":"","createdAt":"2026-11-01T00:00:00.000Z","lastActivityAt":"2026-11-01T00:00:00.000Z","links":[{"title":"Website","url":"https://walkies.mikecann.app/","icon":"safari"},{"title":"Bad","url":"file:///etc/passwd"}]}"#
    let thread = try JSONDecoder().decode(PhoneThread.self, from: Data(json.utf8))
    #expect(thread.links?.count == 2)
    #expect(thread.links?[0].page?.absoluteString == "https://walkies.mikecann.app/")
    #expect(thread.links?[0].icon == "safari")
    // Never a file or another app, even if one came through.
    #expect(thread.links?[1].page == nil)
    #expect(PhoneLink(title: "x", url: "javascript:alert(1)").page == nil)
}

@Test func agentMessagesAreToldApartFromMikes() {
    let at = Date(timeIntervalSince1970: 0)
    let fromThread = PhoneMessage(seq: 1, role: .user, text: "[Sent by the agent in the thread \"Fix \"it\" (now)\" (c4c2389d)]\nWork the card.", at: at)
    #expect(fromThread.agentHeader?.title == "Fix \"it\" (now)")
    #expect(fromThread.agentHeader?.threadId == "c4c2389d")
    #expect(fromThread.agentHeader?.body == "Work the card.")
    let move = PhoneMessage(seq: 2, role: .user, text: "[Sent by the agent before moving to ~/dev/me/x]\nCarry on.", at: at)
    #expect(move.agentHeader?.movedTo == "~/dev/me/x")
    #expect(move.agentHeader?.body == "Carry on.")
    // Mike's own words, a schedule's and the assistant's never are.
    #expect(PhoneMessage(seq: 3, role: .user, text: "Ship it", at: at).agentHeader == nil)
    #expect(PhoneMessage(seq: 4, role: .user, text: move.text, origin: "schedule", at: at).agentHeader == nil)
    #expect(PhoneMessage(seq: 5, role: .assistant, text: move.text, at: at).agentHeader == nil)
}

@Test func aHibernatingRowSaysWhatItWaitsFor() throws {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var t = PhoneThread(threadId: "t", title: "Plan", lastActivityAt: now, snoozedUntil: now.addingTimeInterval(86_400))
    #expect(InboxSections.wakeLine(t, now: now) == nil)
    t.wakeNote = "\"Convex I/O\" finishes"
    #expect(InboxSections.wakeLine(t, now: now) == "Until \"Convex I/O\" finishes")
    // From the backend's JSON, and gone once it's awake again.
    let json = #"{"threadId":"t","runnerId":"mac","title":"Plan","cwd":"~","accountId":"a","provider":"claude","status":"idle","needsYou":false,"unread":false,"preview":"","lastActivityAt":"2026-11-05T00:00:00Z","snoozedUntilRestart":true,"wakeNote":"the runner updates","view":"hibernating"}"#
    let decoded = try JSONDecoder().decode(PhoneThread.self, from: Data(json.utf8))
    #expect(InboxSections.wakeLine(decoded, now: now) == "Until the runner updates")
    t.snoozedUntil = nil
    #expect(InboxSections.wakeLine(t, now: now) == nil)
}
