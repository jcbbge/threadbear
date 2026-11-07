import XCTest
@testable import ThreadbearCore

final class ProjectTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: What a click shows before the runner answers

    func testAProjectUpdateGuessesWhatItChanges() {
        let now = Date(timeIntervalSince1970: 100)
        let tasks = ProjectTasks(url: "https://n/1")
        let project = Project(id: "p", title: "T", folders: ["/a"], goals: "g", state: "s", notes: "n", archived: false, notion: "https://n/1", tasks: tasks)
        XCTAssertEqual(ProjectUpdate(goals: "G").applied(to: project).goals, "G")
        XCTAssertEqual(ProjectUpdate(notes: "N").applied(to: project).notes, "N")
        XCTAssertEqual(ProjectUpdate(folders: []).applied(to: project).folders, [])
        XCTAssertEqual(ProjectUpdate(archived: true).applied(to: project).archived, true)
        let state = ProjectUpdate(state: "S").applied(to: project, now: now)
        XCTAssertEqual(state.state, "S")
        XCTAssertEqual(state.stateUpdatedAt, now)
        XCTAssertEqual(ProjectUpdate(title: "").applied(to: project).title, "T", "the runner keeps a title on an empty one")
        XCTAssertEqual(ProjectUpdate().applied(to: project), project)
    }

    func testANotionChangeDropsTheOldBoardButTheSamePageKeepsIt() {
        let tasks = ProjectTasks(url: "https://n/1")
        let project = Project(id: "p", title: "T", notion: "https://n/1", tasks: tasks)
        let other = ProjectUpdate(notion: "https://n/2").applied(to: project)
        XCTAssertEqual(other.notion, "https://n/2")
        XCTAssertNil(other.tasks)
        let off = ProjectUpdate(notion: "").applied(to: project)
        XCTAssertNil(off.notion)
        XCTAssertNil(off.tasks)
        XCTAssertEqual(ProjectUpdate(notion: "https://n/1").applied(to: project).tasks, tasks)
    }

    func testChangingAThreadsProjectsPinsWhatsAddedAndDropsWhatsRemoved() {
        let now = Date(timeIntervalSince1970: 100)
        let projects = [ThreadProject(id: "a", title: "A"), ThreadProject(id: "b", title: "B")]
        let titles = ["c": "C"]
        let changed = projects.changing(add: ["a", "c", "unknown"], remove: ["b"], title: { titles[$0] }, now: now)
        XCTAssertEqual(changed.map(\.id), ["a", "c"], "one it can't name waits for the reply")
        XCTAssertEqual(changed.map(\.pinned), [true, true])
        XCTAssertEqual(changed[1].by, .mike)
        XCTAssertEqual(changed[1].at, now)
    }

    func testPausingTheLibrarianKeepsWhyItsOff() {
        XCTAssertEqual(LibrarianStatus().setting(paused: true).state, .paused)
        XCTAssertEqual(LibrarianStatus(state: .paused, paused: true).setting(paused: false).state, .idle)
        XCTAssertEqual(LibrarianStatus(state: .paused, paused: true, current: LibrarianJob(threadId: "t")).setting(paused: false).state, .working)
        let off = LibrarianStatus(state: .off, reason: "No login").setting(paused: true)
        XCTAssertEqual(off.state, .off)
        XCTAssertEqual(off.paused, true)
    }

    // MARK: Decoding

    func testPatchInfoDecodesAnUntrustedPatch() throws {
        let patch = try decode(PatchInfo.self, """
        {"id":"release","source":"project","file":"/w/.threadbear/patches/release.ts","untrusted":"changed","hash":"\(String(repeating: "a", count: 64))"}
        """)
        XCTAssertEqual(patch.untrusted, "changed")
        XCTAssertEqual(patch.hash?.count, 64)
        let loaded = try decode(PatchInfo.self, #"{"id":"tools","source":"project"}"#)
        XCTAssertNil(loaded.untrusted)
        XCTAssertNil(loaded.hash)
    }

    func testProjectDecodesFullAndToleratesUnknownFields() throws {
        let project = try decode(Project.self, """
        {"id":"p_3b1d9e20","title":"Threadbear","folders":["/Users/mike/dev/me/threadbear",5,"/Users/mike/dev/me/notes"],
         "goals":"Mike's own agent app.","state":"Projects next.","notes":"# Notes","createdBy":"librarian",
         "createdByThread":"th1","createdAt":"2026-10-20T10:00:00Z","updatedAt":"2026-10-27T10:00:00Z",
         "stateUpdatedAt":"2026-10-27T09:00:00Z","archived":false,"threadCount":"7","lastActivityAt":"2026-10-27T11:00:00Z",
         "colour":"teal"}
        """)
        XCTAssertEqual(project.title, "Threadbear")
        XCTAssertEqual(project.folders, ["/Users/mike/dev/me/threadbear", "/Users/mike/dev/me/notes"], "a folder that isn't a string is skipped")
        XCTAssertEqual(project.createdBy, .librarian)
        XCTAssertEqual(project.createdByThread, "th1")
        XCTAssertEqual(project.threadCount, 7)
        XCTAssertEqual(project.lastActivityAt, ISO8601.parse("2026-10-27T11:00:00Z"))
        XCTAssertFalse(project.archived)
    }

    func testProjectTasksDecodeLeniently() throws {
        let project = try decode(Project.self, """
        {"id":"p_1","title":"Port Geo","notion":"https://www.notion.so/abc","tasks":{"url":"https://www.notion.so/db",
         "fetchedAt":"2026-10-30T05:00:00Z","error":"",
         "columns":[{"name":"To do","kind":"todo","color":"gray"},{"name":"Blocked","kind":"stuck"},{"name":"Done","kind":"done"}],
         "items":[{"id":"t1","title":"Eventbrite link","url":"https://www.notion.so/t1","status":"To do","who":["Zaran",3],"due":"2026-11-29","thread":"60f772ab"},
                  {"id":"t2","url":"https://www.notion.so/t2","status":"Done"},{"title":"no id"}]}}
        """)
        XCTAssertEqual(project.notion, "https://www.notion.so/abc")
        let tasks = try XCTUnwrap(project.tasks)
        XCTAssertEqual(tasks.columns.map(\.kind), [.todo, .todo, .done], "an unknown kind reads as to do")
        XCTAssertEqual(tasks.items.count, 2, "a card without an id is skipped")
        XCTAssertEqual(tasks.items[0].who, ["Zaran"])
        XCTAssertEqual(tasks.items[0].thread, "60f772ab")
        XCTAssertEqual(tasks.items[1].title, "Untitled")
        XCTAssertNil(tasks.error, "an empty error is none")
        XCTAssertFalse(tasks.loading)
        XCTAssertEqual(tasks.openCount, 1)
        XCTAssertEqual(tasks.items(in: tasks.columns[2]).map(\.id), ["t2"])
        let none = try decode(Project.self, #"{"id":"p_2","title":"No board","notion":""}"#)
        XCTAssertNil(none.notion)
        XCTAssertNil(none.tasks)
    }

    func testBoardPutsWhatsUnderWayFirstAndThisThreadsCardsFirstInAColumn() {
        let todo = TaskColumn(name: "To do", kind: .todo), doing = TaskColumn(name: "Doing", kind: .doing)
        let waiting = TaskColumn(name: "Waiting", kind: .doing), empty = TaskColumn(name: "Blocked", kind: .doing)
        let done = TaskColumn(name: "Done", kind: .done)
        let card = { (id: String, status: String, thread: String?) in ProjectTask(id: id, title: id, url: "https://n/\(id)", status: status, thread: thread) }
        let tasks = ProjectTasks(url: "https://n", columns: [todo, doing, empty, waiting, done], items: [
            card("a", "To do", nil), card("b", "To do", "85046057"), card("c", "Waiting", nil),
            card("d", "Doing", nil), card("e", "Done", "85046057"), card("f", "To do", "abc"),
        ])
        let board = tasks.board(threadId: "85046057-1df7-4169-bb7d-fca554331b4c")
        XCTAssertEqual(board.map(\.id), ["Doing", "Waiting", "To do", "Done"], "under way, then to do, then done, and no empty columns")
        XCTAssertEqual(board[2].cards.map(\.task.id), ["b", "a", "f"], "its own card first, the rest in Notion's order")
        XCTAssertEqual(board[2].cards.map(\.mine), [true, false, false])
        XCTAssertFalse(card("x", "To do", "abc").isWorked(by: "abcdef12"), "a short Thread value matches nothing")
    }

    func testBoardIsEmptyWithNothingOpen() {
        let done = TaskColumn(name: "Done", kind: .done)
        let tasks = ProjectTasks(url: "https://n", columns: [TaskColumn(name: "To do", kind: .todo), done], items: [
            ProjectTask(id: "a", title: "a", url: "https://n/a", status: "Done"),
        ])
        XCTAssertEqual(tasks.board(threadId: "t").count, 0)
    }

    func testBoardLayoutFillsThePanelOrScrollsAtTheNarrowestColumn() {
        // Two columns and a folded strip fit a 340 panel: they share it.
        let fits = BoardLayout.columnWidth(available: 340, columns: 2, folded: 1, spacing: 6, foldedWidth: 28, minimum: 146)
        XCTAssertEqual(fits, 150)
        // Three don't, so each stays at the narrowest and the board scrolls.
        let scrolls = BoardLayout.columnWidth(available: 340, columns: 3, folded: 1, spacing: 6, foldedWidth: 28, minimum: 146)
        XCTAssertEqual(scrolls, 146)
        // Before the panel has been measured.
        XCTAssertEqual(BoardLayout.columnWidth(available: 0, columns: 2, folded: 0, spacing: 6, foldedWidth: 28, minimum: 146), 146)
    }

    func testBoardLayoutPagesAColumnAtATimeAndStopsAtTheEnds() {
        // Columns 146 wide with 6 between, so 152 a column.
        XCTAssertEqual(BoardLayout.page(from: 0, by: 1, step: 152, maximum: 300), 152)
        XCTAssertEqual(BoardLayout.page(from: 152, by: 1, step: 152, maximum: 300), 300, "stops at the end, not past it")
        XCTAssertEqual(BoardLayout.page(from: 300, by: -1, step: 152, maximum: 300), 152, "back from the end lands on a column")
        XCTAssertEqual(BoardLayout.page(from: 40, by: -1, step: 152, maximum: 300), 0)
        XCTAssertEqual(BoardLayout.page(from: 160, by: 1, step: 152, maximum: 500), 304, "a part-scrolled board snaps to the next column")
    }

    func testCardReferenceIsALinkTheAgentCanRead() {
        let card = ProjectTask(id: "a", title: "Fix [the] button", url: "https://notion.so/a", status: "Doing")
        XCTAssertEqual(card.reference, "[Fix \\[the\\] button](https://notion.so/a)")
        XCTAssertEqual(ProjectTask(id: "b", title: "No link", url: "", status: "Doing").reference, "No link")
    }

    func testCardMentionsAreNotionLinksInAMessage() {
        let text = "Look at [Fix \\[the\\] button](https://app.notion.com/p/abc123) and [Docs](https://example.com/x) please"
        let found = CardMentions.find(in: text)
        XCTAssertEqual(found.map(\.title), ["Fix [the] button"], "only Notion links, with the brackets back")
        XCTAssertEqual(found.first?.url, "https://app.notion.com/p/abc123")
        XCTAssertEqual((text as NSString).substring(with: found[0].range), "[Fix \\[the\\] button](https://app.notion.com/p/abc123)")
        XCTAssertEqual(CardMentions.find(in: "[a](https://www.notion.so/t3) [b](https://x.notion.site/y)").map(\.title), ["a", "b"])
        XCTAssertEqual(CardMentions.find(in: "![a picture](https://www.notion.so/t3)").count, 0, "a picture isn't a card")
        XCTAssertEqual(CardMentions.find(in: "[a](https://notnotion.so/t3) [b](http://www.notion.so/t3) [c](https://notion.so.evil.com/t3)").count, 0, "only real Notion addresses")
        XCTAssertEqual(CardMentions.find(in: "no links here").count, 0)
    }

    func testThreadLinksAreMentionsToo() {
        let ref = CardMentions.threadReference(id: "0cf430ac-f429", title: "Fix [the]\nchip")
        XCTAssertEqual(ref, "[Fix \\[the\\] chip](thread:0cf430ac-f429)", "one line, brackets escaped")
        let found = CardMentions.find(in: "See \(ref) and [card](https://notion.so/a)")
        XCTAssertEqual(found.map(\.kind), [.thread, .card])
        XCTAssertEqual(found.first?.title, "Fix [the] chip")
        XCTAssertEqual(found.first?.url, "thread:0cf430ac-f429")
        XCTAssertEqual(CardMentions.threadReference(id: "a", title: "  "), "[Thread](thread:a)")
        XCTAssertEqual(CardMentions.find(in: "[x](thread:a b) [y](threads:a) ![z](thread:a)").count, 0)
    }

    func testAPastedThreadIdOfAKnownThread() {
        let known: (String) -> Bool = { $0 == "0cf430ac-f429-4ed9" }
        XCTAssertEqual(CardMentions.pastedThreadId(" 0cf430ac-f429-4ed9\n", known: known), "0cf430ac-f429-4ed9")
        XCTAssertEqual(CardMentions.pastedThreadId("0CF430AC-F429-4ED9", known: known), "0cf430ac-f429-4ed9")
        XCTAssertEqual(CardMentions.pastedThreadId("threadbear://thread/0cf430ac-f429-4ed9", known: known), "0cf430ac-f429-4ed9")
        XCTAssertEqual(CardMentions.pastedThreadId("thread:0cf430ac-f429-4ed9", known: known), "0cf430ac-f429-4ed9")
        XCTAssertNil(CardMentions.pastedThreadId("11111111-2222", known: known), "an unknown id stays words")
        XCTAssertNil(CardMentions.pastedThreadId("see 0cf430ac-f429-4ed9", known: known), "only an id on its own")
    }

    func testACardsReferenceIsFoundAsAMention() {
        let card = ProjectTask(id: "a", title: "Fix [the] button (soon)", url: "https://www.notion.so/a", status: "Doing")
        let found = CardMentions.find(in: "See \(card.reference) next")
        XCTAssertEqual(found.first?.title, card.title)
        XCTAssertEqual(found.first?.url, card.url)
    }

    func testAddingACardToADraft() {
        let ref = "[Card](https://n/a)"
        XCTAssertEqual(BoardLayout.adding(ref, to: ""), "[Card](https://n/a) ")
        XCTAssertEqual(BoardLayout.adding(ref, to: "  \n"), "[Card](https://n/a) ", "only whitespace counts as empty")
        XCTAssertEqual(BoardLayout.adding(ref, to: "Look at"), "Look at [Card](https://n/a) ")
        XCTAssertEqual(BoardLayout.adding(ref, to: "Look at "), "Look at [Card](https://n/a) ")
        XCTAssertEqual(BoardLayout.adding(ref, to: "One\n"), "One\n[Card](https://n/a) ")
        XCTAssertEqual(BoardLayout.adding(ref, to: "See [Card](https://n/a) now"), "See [Card](https://n/a) now", "a second click doesn't add it twice")
    }

    func testProjectIcons() throws {
        let picture = try decode(Project.self, """
        {"id":"p_1","icon":{"image":{"path":"/d/project-icons/p_1-ab.png","mediaType":"image/png","width":256,"height":256},
         "from":"/r/App/AppIcon.png","by":"librarian","updatedAt":"2026-10-27T10:00:00Z","shade":"new"}}
        """)
        XCTAssertEqual(picture.icon?.image?.path, "/d/project-icons/p_1-ab.png")
        XCTAssertEqual(picture.icon?.from, "/r/App/AppIcon.png")
        XCTAssertEqual(picture.icon?.isChosen, false)
        let symbol = try decode(Project.self, #"{"id":"p_2","icon":{"symbol":"film","by":"mike"}}"#)
        XCTAssertEqual(symbol.icon?.symbol, "film")
        XCTAssertEqual(symbol.icon?.isChosen, true)
        let broken = try decode(Project.self, #"{"id":"p_3","icon":"film"}"#)
        XCTAssertNil(broken.icon, "an icon that isn't an object is dropped, not the project")
        XCTAssertNil(try decode(Project.self, #"{"id":"p_4"}"#).icon)
    }

    func testProjectWithOnlyAnId() throws {
        let project = try decode(Project.self, #"{"id":"p_1","createdBy":"someone-new"}"#)
        XCTAssertEqual(project.title, "Untitled project")
        XCTAssertEqual(project.folders, [])
        XCTAssertEqual(project.goals, "")
        XCTAssertEqual(project.createdBy, .agent, "an author from a newer runner reads as an agent")
        XCTAssertEqual(project.threadCount, 0)
        XCTAssertNil(project.lastActivityAt)
    }

    func testProjectLinks() throws {
        let project = try decode(Project.self, """
        {"id":"p_1","links":[{"title":"Live site","url":"https://cruise.example/"},{"url":"https://www.cruise.example/admin/"},
         {"title":"no url"},"https://loose.example"]}
        """)
        XCTAssertEqual(project.links, [
            ProjectLink(title: "Live site", url: "https://cruise.example/"),
            ProjectLink(title: "cruise.example/admin", url: "https://www.cruise.example/admin/"),
        ], "a link without a title is named by its address; a broken one is skipped")
        XCTAssertEqual(try decode(Project.self, #"{"id":"p_2"}"#).links, [], "none from a runner before links")
    }

    func testHighlightProjectsFollowTheThreadAndSkipArchived() throws {
        let thread = try decode(ThreadSummary.self, """
        {"id":"th1","projects":[{"id":"p_b","title":"B","why":"Edits B's repo"},{"id":"p_a","title":"A"},{"id":"p_none","title":"N"},
         {"id":"p_old","title":"Old"},{"id":"p_gone","title":"Gone"}]}
        """)
        let link = [ProjectLink(title: "Site", url: "https://x.example")]
        let all = [
            Project(id: "p_a", title: "A", links: link),
            Project(id: "p_b", title: "B", links: link),
            Project(id: "p_none", title: "N"),
            Project(id: "p_old", title: "Old", links: link, archived: true),
        ]
        let rows = HighlightProjects.build(thread: thread) { id in all.first { $0.id == id } }
        XCTAssertEqual(rows.map(\.id), ["p_b", "p_a", "p_none"], "one with no links still shows, so a wrong guess can be seen")
        XCTAssertEqual(rows[0].membership.why, "Edits B's repo")
        XCTAssertNil(rows[1].membership.why)
    }

    func testHighlightProjectsSayWhoAndWhy() {
        let guess = ThreadProject(id: "p", title: "P", by: .librarian, why: "Shortlists photos")
        XCTAssertEqual(HighlightProjects.why(guess).who, "The librarian put it here.")
        XCTAssertEqual(HighlightProjects.why(guess).reason, "Shortlists photos")
        XCTAssertTrue(HighlightProjects.canKeep(guess))
        var kept = guess
        kept.pinned = true
        XCTAssertEqual(HighlightProjects.why(kept).who, "The librarian put it here, and you kept it.")
        XCTAssertFalse(HighlightProjects.canKeep(kept))
        XCTAssertEqual(HighlightProjects.why(ThreadProject(id: "p", title: "P", by: .mike, pinned: true)).who, "You put it here.")
        XCTAssertFalse(HighlightProjects.canKeep(ThreadProject(id: "p", title: "P", by: .agent, pinned: true)))
    }

    func testThreadSummaryProjects() throws {
        let thread = try decode(ThreadSummary.self, """
        {"id":"th1","projects":[{"id":"p_a","title":"Threadbear","by":"mike","pinned":true,"at":"2026-10-27T10:00:00Z"},
         {"title":"no id"},{"id":"p_b","title":"Poddle","by":"librarian"}]}
        """)
        XCTAssertEqual(thread.projects.map(\.id), ["p_a", "p_b"])
        XCTAssertTrue(thread.projects[0].pinned)
        XCTAssertEqual(thread.projects[0].by, .mike)
        XCTAssertFalse(thread.projects[1].pinned)
        XCTAssertEqual(try decode(ThreadSummary.self, #"{"id":"old"}"#).projects, [], "a runner from before projects sends none")
        // Exports round-trip (`tb export`, the fixtures).
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(thread))
        XCTAssertEqual(again.projects, thread.projects)
    }

    func testPatchItemsCarryFolderAndProject() throws {
        let thread = try decode(ThreadSummary.self, """
        {"id":"th1",
         "actions":[{"id":"poddle:tools.check","title":"Check","kind":"command","command":"npm test","patch":"poddle:tools","folder":"/p","projectId":"p_b"}],
         "hooks":[{"id":"tools.tsc","title":"Typecheck","command":"tsc","patch":"tools","folder":"/p","projectId":"p_b"}],
         "panels":[{"id":"convex.dashboard","title":"Convex","url":"https://x","patch":"convex","projectId":"p_b"}],
         "patches":[{"id":"convex","source":"builtin","folder":"/p","projectId":"p_b"},{"id":"tools","source":"project"}]}
        """)
        XCTAssertEqual(thread.actions.first?.folder, "/p")
        XCTAssertEqual(thread.actions.first?.projectId, "p_b")
        XCTAssertEqual(thread.hooks.first?.projectId, "p_b")
        XCTAssertEqual(thread.panels.first?.projectId, "p_b")
        XCTAssertEqual(thread.patches.map(\.projectId), ["p_b", nil])
        XCTAssertEqual(thread.patches.first?.folder, "/p")
    }

    func testLibrarianStatusDecodes() throws {
        let status = try decode(LibrarianStatus.self, """
        {"state":"working","paused":false,
         "current":{"threadId":"th1","threadTitle":"Rename the tabs","reason":"first-turn","why":"Its first turn ended","dueAt":"2026-10-27T10:00:00Z","startedAt":"2026-10-27T10:00:05Z"},
         "queue":[{"threadId":"th2","threadTitle":"Poster","reason":"new-folder","why":"Edited files in ~/dev/poddle","dueAt":"2026-10-27T10:01:00Z"},
                  {"threadId":"th3","reason":"teleported"},{"reason":"moved"}],
         "recent":[{"id":"e1","at":"2026-10-27T09:00:00Z","threadId":"th4","threadTitle":"CI","reason":"catch-up","outcome":"updated","text":"Photo sync's state","projectIds":["p_a"],"costUsd":0.0004},
                   {"id":"e2","threadId":"th5","outcome":"exploded","text":"?"}],
         "looksToday":14,"spentTodayUsd":0.031}
        """)
        XCTAssertEqual(status.state, .working)
        XCTAssertEqual(status.current?.threadTitle, "Rename the tabs")
        XCTAssertEqual(status.current?.startedAt, ISO8601.parse("2026-10-27T10:00:05Z"))
        XCTAssertEqual(status.queue.map(\.threadId), ["th2", "th3"], "a job with no thread is skipped")
        XCTAssertEqual(status.queue[1].reason, .asked, "an unknown reason reads as asked")
        XCTAssertEqual(status.recent.map(\.outcome), [.updated, .other])
        XCTAssertEqual(status.recent.first?.projectIds, ["p_a"])
        XCTAssertEqual(status.pendingCount, 3)
        XCTAssertEqual(status.looksToday, 14)
        XCTAssertEqual(status.spentTodayUsd, 0.031, accuracy: 0.0001)
    }

    func testLibrarianStatusWithAlmostNothing() throws {
        let paused = try decode(LibrarianStatus.self, #"{"paused":true}"#)
        XCTAssertEqual(paused.state, .paused)
        XCTAssertEqual(paused.queue, [])
        XCTAssertEqual(try decode(LibrarianStatus.self, #"{"state":"dreaming"}"#).state, .idle)
    }

    func testNotifications() async throws {
        let transport = FakeTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        transport.push(E.json(["jsonrpc": "2.0", "method": "projects.updated",
                               "params": ["projects": [["id": "p_a", "title": "Threadbear"], ["title": "no id"]]]]))
        transport.push(E.json(["jsonrpc": "2.0", "method": "librarian.updated",
                               "params": ["librarian": ["state": "off", "reason": "Needs a Claude pool to run on", "paused": false, "queue": [], "recent": []]]]))
        var iterator = client.notifications.makeAsyncIterator()
        guard case .projectsUpdated(let projects)? = await iterator.next() else { return XCTFail("no projects.updated") }
        XCTAssertEqual(projects.map(\.id), ["p_a"])
        guard case .librarianUpdated(let librarian)? = await iterator.next() else { return XCTFail("no librarian.updated") }
        XCTAssertEqual(librarian.state, .off)
        XCTAssertEqual(LibrarianText.state(librarian), "Off: Needs a Claude pool to run on")
    }

    // MARK: Requests

    func testUpdateParamsOnlyWhatChanged() {
        XCTAssertEqual(ProjectUpdate(archived: true).params, ["archived": .bool(true)])
        let params = ProjectUpdate(folders: ["/a", "/b"], notes: "").params
        XCTAssertEqual(params["folders"], .array([.string("/a"), .string("/b")]))
        XCTAssertEqual(params["notes"], .string(""), "an emptied field is sent, so it's cleared")
        XCTAssertNil(params["title"])
    }

    func testSetProjectsAndCreateParams() {
        XCTAssertEqual(SetProjectsRequest(threadId: "th1", remove: ["p_a"]).params,
                       ["threadId": .string("th1"), "remove": .array([.string("p_a")])])
        let create = NewProjectRequest(title: "Poddle", threadIds: ["th1"]).params
        XCTAssertEqual(create["title"], .string("Poddle"))
        XCTAssertEqual(create["threadIds"], .array([.string("th1")]))
        XCTAssertNil(create["folders"])
    }

    // MARK: The Projects view

    private func thread(_ id: String, minutesAgo: Double, projects: [String] = [], archived: Bool = false, snoozed: Bool = false) -> ThreadSummary {
        let now = Date(timeIntervalSince1970: 1_000_000)
        return ThreadSummary(
            id: id, title: id, lastActivityAt: now.addingTimeInterval(-minutesAgo * 60),
            snoozedUntil: snoozed ? now.addingTimeInterval(3600) : nil, archivedAt: archived ? now : nil,
            projects: projects.map { ThreadProject(id: $0, title: $0.uppercased()) }
        )
    }

    func testSectionsNewestFirstWithAThreadInTwoAndUnfiledLast() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let projects = [
            Project(id: "a", title: "A", updatedAt: now.addingTimeInterval(-86_400)),
            Project(id: "b", title: "B", updatedAt: now.addingTimeInterval(-86_400)),
            Project(id: "gone", title: "Gone", archived: true),
            Project(id: "quiet", title: "Quiet", updatedAt: now.addingTimeInterval(-7 * 86_400)),
        ]
        let threads = [
            thread("t1", minutesAgo: 30, projects: ["a"]),
            thread("t2", minutesAgo: 5, projects: ["b", "a"]),
            thread("t3", minutesAgo: 1, projects: ["b"], archived: true),
            thread("t4", minutesAgo: 2),
            thread("t5", minutesAgo: 3, projects: ["gone"]),
            thread("t6", minutesAgo: 4, projects: ["a"], snoozed: true),
        ]
        let built = ProjectSections.build(projects: projects, threads: threads, now: now)
        XCTAssertEqual(built.sections.map(\.project.id), ["b", "a", "quiet"], "b's archived thread is its newest activity; archived projects are left out")
        XCTAssertEqual(built.sections[0].threads.map(\.id), ["t2"], "archived threads aren't listed")
        XCTAssertEqual(built.sections[1].threads.map(\.id), ["t2", "t1"], "a thread in two projects is under both; hibernating ones aren't")
        XCTAssertEqual(built.sections[2].threads, [])
        XCTAssertEqual(built.sections[0].archived.map(\.id), ["t3"], "archived ones are kept apart, for the sidebar's fold")
        XCTAssertEqual(built.sections[1].archived, [], "hibernating isn't archived")
        XCTAssertEqual(built.unfiled.map(\.id), ["t4", "t5"], "a thread only in an archived project counts as in none")
        XCTAssertEqual(built.order, ["t2", "t1", "t4", "t5"])
        XCTAssertEqual(ProjectSections.threads(in: "b", from: threads).map(\.id), ["t3", "t2"], "the page lists put away ones too")
    }

    // MARK: The Projects page's cards

    func testCardsCountWhatEachProjectsThreadsAreDoing() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let projects = [
            Project(id: "a", title: "A", updatedAt: now.addingTimeInterval(-86_400)),
            Project(id: "quiet", title: "Quiet", updatedAt: now.addingTimeInterval(-7 * 86_400)),
            Project(id: "gone", title: "Gone", archived: true),
        ]
        let at = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let inA = [ThreadProject(id: "a", title: "A")]
        let threads = [
            ThreadSummary(id: "run", title: "Running", status: .running, lastActivityAt: at(1), projects: inA),
            ThreadSummary(id: "bg", title: "", lastActivityAt: at(2),
                          background: [BackgroundTask(kind: .shell, description: "npm test")], projects: inA),
            ThreadSummary(id: "wait", title: "Waiting", status: .waiting, needsYou: true, lastActivityAt: at(3), projects: inA),
            ThreadSummary(id: "new", title: "Finished", needsYou: true, lastActivityAt: at(4), projects: inA),
            ThreadSummary(id: "bad", title: "Broke", status: .error, lastActivityAt: at(5), projects: inA),
            ThreadSummary(id: "old", title: "Old", lastActivityAt: at(6), projects: inA),
            ThreadSummary(id: "away", title: "Away", status: .waiting, lastActivityAt: at(7), archivedAt: now, projects: inA),
        ]
        let cards = ProjectCard.build(ProjectSections.build(projects: projects, threads: threads, now: now))
        XCTAssertEqual(cards.map(\.id), ["a", "quiet"], "archived projects get no card")
        XCTAssertEqual(cards[0].status, ProjectCardStatus(working: 2, needsYou: 1, failed: 1, unread: 1, open: 6),
                       "background work counts as working; archived threads aren't counted")
        XCTAssertEqual(cards[0].status.parts.map(\.text), ["1 needs you", "2 working", "1 failed", "1 new"])
        XCTAssertEqual(cards[0].recent, ["Running", "Untitled", "Waiting"])
        XCTAssertEqual(cards[0].lastActivityAt, at(1))
        XCTAssertTrue(cards[1].status.isQuiet)
        XCTAssertEqual(cards[1].status.parts, [])
        XCTAssertEqual(cards[1].recent, [])

        let both = [ThreadSummary(id: "x", title: "x", status: .running, projects: [ThreadProject(id: "a", title: "A"), ThreadProject(id: "quiet", title: "Quiet")])]
        let sections = ProjectSections.build(projects: projects, threads: both, now: now)
        XCTAssertEqual(ProjectCard.build(sections).map(\.status.working), [1, 1], "on both cards")
        XCTAssertEqual(ProjectCard.overall(sections).working, 1, "but one thread working")
    }

    func testSearchingCardsLooksThroughWhatAProjectIsAbout() {
        let card = { (project: Project) in
            ProjectCard(project: project, status: ProjectCardStatus(), lastActivityAt: .distantPast, recent: [])
        }
        let cards = [
            card(Project(id: "state", title: "Sammy Cam", state: "The deterrent speaks through a Pi")),
            card(Project(id: "folder", title: "Podcast site", folders: ["/Users/mike/dev/me/mike-pod-site"])),
            card(Project(id: "goals", title: "Café", goals: "Sell coffee")),
            card(Project(id: "notes", title: "Boat", notes: "Moored by the café")),
            card(Project(id: "link", title: "Shop", links: [ProjectLink(title: "Admin", url: "https://example.com/x")])),
            card(Project(id: "title", title: "The Deterrent")),
        ]
        let ids = { (query: String) -> [String] in ProjectCard.matching(cards, query).map(\.id) }

        XCTAssertEqual(ids(""), cards.map(\.id), "nothing typed leaves every card, in order")
        XCTAssertEqual(ids("  \n"), cards.map(\.id))
        XCTAssertEqual(ids("deterrent"), ["title", "state"], "a title match goes above one in the state")
        XCTAssertEqual(ids("DETERRENT sammy"), ["state"], "every word has to match, in any field")
        XCTAssertEqual(ids("cafe"), ["goals", "notes"], "case and accents don't count")
        XCTAssertEqual(ids("mike-pod"), ["folder"])
        XCTAssertEqual(ids("users"), [], "a folder's name counts, not the path every project shares")
        XCTAssertEqual(ids("admin"), ["link"])
        XCTAssertEqual(ids("nothing like this"), [])
    }

    func testProjectsSummarySaysHowManyMatchWhileSearching() {
        XCTAssertEqual(ProjectCard.matchCount(3, of: 76), "3 of 76 projects")
        XCTAssertEqual(ProjectCard.matchCount(0, of: 1), "0 of 1 project")
    }

    // MARK: The Patches tab

    func testPatchGroupsOwnFolderFirstThenEachProject() {
        var thread = ThreadSummary(id: "th1", title: "t", projects: [ThreadProject(id: "p_a", title: "Threadbear"), ThreadProject(id: "p_b", title: "Poddle")])
        thread.patches = [
            PatchInfo(id: "convex", source: "builtin", folder: "/poddle", projectId: "p_b"),
            PatchInfo(id: "tools", source: "project"),
            PatchInfo(id: "checks", source: "project", folder: "/tb", projectId: "p_a"),
            PatchInfo(id: "old", source: "project", folder: "/x", projectId: "p_gone"),
        ]
        let groups = PatchGroups.group(thread) { $0 == "p_gone" ? "Gone" : nil }
        XCTAssertEqual(groups.map(\.title), [nil, "Threadbear", "Poddle", "Gone"])
        XCTAssertEqual(groups.map { $0.patches.map(\.id) }, [["tools"], ["checks"], ["convex"], ["old"]])
        thread.patches = [PatchInfo(id: "tools")]
        XCTAssertEqual(PatchGroups.group(thread).count, 1)
        XCTAssertNil(PatchGroups.group(thread).first?.title, "no headings when nothing came from a project")
        thread.patches = []
        XCTAssertEqual(PatchGroups.group(thread), [])
    }

    func testProjectPatchesAcrossThreadsEachOnce() {
        let project = Project(id: "p_b", title: "Poddle", folders: ["/p"])
        var one = ThreadSummary(id: "th1", title: "one")
        one.patches = [PatchInfo(id: "convex", source: "builtin", folder: "/p", projectId: "p_b"), PatchInfo(id: "tools")]
        var two = ThreadSummary(id: "th2", title: "two")
        two.patches = [PatchInfo(id: "convex", source: "builtin", folder: "/p", projectId: "p_b"),
                       PatchInfo(id: "poddle:tools", source: "project", folder: "/p", projectId: "p_b")]
        // In the project's folder: its patches are its own, untagged.
        var three = ThreadSummary(id: "th3", title: "three", cwd: "/p/app")
        three.patches = [PatchInfo(id: "xcode", source: "builtin"), PatchInfo(id: "mine", source: "home", file: "/p/x.ts")]
        let found = PatchGroups.patches(of: project, in: [one, two, three])
        XCTAssertEqual(found.map(\.patch.id), ["convex", "poddle:tools", "xcode"], "home patches aren't the project's")
        XCTAssertEqual(found.map(\.thread.id), ["th1", "th2", "th3"])
    }

    // MARK: A project's page in the pane

    func testProjectPaneBorrowsTheNewestOpenThreadsPanels() {
        let project = Project(id: "p_w", title: "Walkies", folders: ["/walkies"])
        let inW = [ThreadProject(id: "p_w", title: "Walkies")]
        let at = { (minutes: Double) in Date(timeIntervalSince1970: 1_000_000 - minutes * 60) }
        // Elsewhere, put in the project: the project's patches are tagged.
        var misc = ThreadSummary(id: "misc", title: "misc", cwd: "/misc", lastActivityAt: at(10), projects: inW)
        misc.patches = [PatchInfo(id: "checks", source: "project", file: "/misc/.threadbear/patches/checks.ts"),
                        PatchInfo(id: "walkies:convex", source: "builtin", folder: "/walkies", projectId: "p_w")]
        misc.panels = [Panel(id: "worktrees", title: "Worktrees", kind: .list, patch: "checks"),
                       Panel(id: "walkies:convex", title: "Convex", patch: "walkies:convex", projectId: "p_w")]
        // In a subfolder of the project's: the same, untagged.
        var inside = ThreadSummary(id: "inside", title: "inside", cwd: "/walkies-threads/x", lastActivityAt: at(1), projects: inW)
        inside.patches = [PatchInfo(id: "convex", source: "builtin")]
        inside.panels = [Panel(id: "convex", title: "Convex", patch: "convex")]
        let newer = ThreadSummary(id: "bare", title: "nothing", cwd: "/elsewhere", lastActivityAt: at(0), projects: inW)
        var away = ThreadSummary(id: "away", title: "away", cwd: "/walkies", lastActivityAt: at(0), archivedAt: at(0), projects: inW)
        away.patches = [PatchInfo(id: "xcode", source: "builtin")]
        away.panels = [Panel(id: "simulator", title: "Simulator", kind: .image, patch: "xcode")]
        let other = ThreadSummary(id: "other", title: "other", cwd: "/walkies", lastActivityAt: at(0))

        let pane = ProjectPane.standIn(for: project, threads: [misc, inside, newer, away, other])
        XCTAssertEqual(pane?.id, "misc", "a worktree outside the folder isn't inside it; nothing, archived or not in the project lose")
        XCTAssertEqual(pane?.patches.map(\.id), ["walkies:convex"], "only what came from the project")
        XCTAssertEqual(pane?.panels.map(\.id), ["walkies:convex"])

        var home = ThreadSummary(id: "home", title: "home", cwd: "/walkies/ios", lastActivityAt: at(5), projects: inW)
        home.patches = [PatchInfo(id: "convex", source: "builtin"), PatchInfo(id: "notes", source: "home", file: "/h/.threadbear/patches/notes.ts")]
        home.panels = [Panel(id: "convex", title: "Convex", patch: "convex"), Panel(id: "notes", title: "Notes", patch: "notes")]
        let mine = ProjectPane.standIn(for: project, threads: [misc, home])
        XCTAssertEqual(mine?.id, "home", "a thread in the folder has the project's patches as its own")
        XCTAssertEqual(mine?.panels.map(\.id), ["convex"], "not a home patch's panel")

        XCTAssertEqual(ProjectPane.standIn(for: project, threads: [newer, away])?.id, "away", "an archived thread when no open one has any")
        XCTAssertNil(ProjectPane.standIn(for: project, threads: [newer, other]))
        XCTAssertTrue(ProjectPane.isInside("/walkies", "/walkies/"))
        XCTAssertFalse(ProjectPane.isInside("/walkies2", "/walkies"))
    }

    func testPanelOriginForTheRailBadge() {
        var thread = ThreadSummary(id: "th1", title: "t", projects: [ThreadProject(id: "p_a", title: "Threadbear")])
        thread.patches = [
            PatchInfo(id: "convex", source: "builtin"),
            PatchInfo(id: "threadbear:convex", source: "builtin", folder: "/tb", projectId: "p_a"),
            PatchInfo(id: "tandem", source: "home", matched: ["/videos/James/edit.tandem"]),
            PatchInfo(id: "storybook", source: "home"),
            PatchInfo(id: "checks", source: "project"),
        ]
        let origin = { (patch: String, projectId: String?) in
            PanelOrigin.of(Panel(id: patch + ".p", title: "P", patch: patch, projectId: projectId), in: thread)
        }
        XCTAssertEqual(origin("convex", nil), .builtin)
        XCTAssertEqual(origin("threadbear:convex", nil), .project(id: "p_a"), "the patch's project")
        XCTAssertEqual(origin("convex", "p_a"), .project(id: "p_a"), "the panel's own project wins")
        XCTAssertEqual(origin("tandem", nil), .tool(matched: ["/videos/James/edit.tandem"]))
        XCTAssertEqual(origin("storybook", nil), .home)
        XCTAssertEqual(origin("checks", nil), .folder)
        XCTAssertEqual(origin("gone", nil), .folder, "a summary a moment behind")
        XCTAssertNil(PanelOrigin.project(id: "p_a").symbol, "drawn with the project's icon")
        XCTAssertEqual(PanelOrigin.project(id: "p_a").tip("Convex", projectTitle: "Threadbear"), "Convex, from the Threadbear project")
        XCTAssertEqual(PanelOrigin.project(id: "p_a").tip("Convex", projectTitle: nil), "Convex, from a project")
        XCTAssertEqual(origin("tandem", nil).tip("Timeline", projectTitle: nil), "Timeline, for edit.tandem")
    }

    /// The composer's shelves: one per place the chips came from, each
    /// holding its chips by patch, in the order they arrived.
    func testActionShelvesGroupChipsByWhereTheyCameFrom() {
        var thread = ThreadSummary(id: "th1", title: "t", projects: [ThreadProject(id: "p_a", title: "Threadbear")])
        thread.patches = [
            PatchInfo(id: "checks", source: "project", projectId: "p_a"),
            PatchInfo(id: "releases", source: "project", projectId: "p_a"),
            PatchInfo(id: "mine", source: "home"),
        ]
        let actions = [
            Action(id: "quick", title: "Quick check", patch: "checks"),
            Action(id: "note", title: "Note", patch: "mine"),
            Action(id: "app", title: "App check", patch: "checks"),
            Action(id: "rel", title: "Releases", patch: "releases"),
        ]
        let shelves = ActionShelf.shelves(actions, in: thread)
        XCTAssertEqual(shelves.map(\.origin), [.project(id: "p_a"), .home])
        XCTAssertEqual(shelves[0].patches.map { $0.map(\.id) }, [["quick", "app"], ["rel"]])
        XCTAssertEqual(shelves[1].patches.map { $0.map(\.id) }, [["note"]])
        XCTAssertEqual(ActionShelf.shelves([], in: thread), [])
    }

    // MARK: Words

    func testLibrarianWords() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(LibrarianText.state(LibrarianStatus(state: .working, current: LibrarianJob(threadId: "t", threadTitle: "Rename the tabs"))),
                       "Looking at \u{201C}Rename the tabs\u{201D}")
        XCTAssertEqual(LibrarianText.state(LibrarianStatus(state: .off)), "Off")
        XCTAssertEqual(LibrarianText.state(LibrarianStatus(state: .idle, paused: true)), "Paused")
        XCTAssertEqual(LibrarianText.today(LibrarianStatus(looksToday: 1)), "1 look today")
        XCTAssertEqual(LibrarianText.today(LibrarianStatus(looksToday: 208, skippedToday: 40, tokensToday: 768_951, notionalTodayUsd: 0.153)),
                       "208 looks today · 40 skipped · 769k tokens", "no money: looks run on a Claude login")
        XCTAssertEqual(LibrarianText.tokens(820), "820")
        XCTAssertEqual(LibrarianText.tokens(1_234_567), "1.2M")
        XCTAssertEqual(LibrarianText.due(now.addingTimeInterval(240), now: now), "in 4m")
        XCTAssertEqual(LibrarianText.due(now.addingTimeInterval(-10), now: now), "now")
        XCTAssertEqual(LibrarianText.due(now.addingTimeInterval(-600), now: now), "waiting")
        XCTAssertEqual(LibrarianText.why(LibrarianJob(threadId: "t", reason: .moved)), "Moved to another folder")
        XCTAssertEqual(LibrarianText.why(LibrarianJob(threadId: "t", reason: .moved, why: "Moved to ~/dev/poddle")), "Moved to ~/dev/poddle")
    }
}
