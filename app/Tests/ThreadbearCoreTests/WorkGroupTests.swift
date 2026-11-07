import XCTest
@testable import ThreadbearCore

/// Folding runs of work into group rows, the working line and the changed
/// files card.
final class WorkGroupTests: XCTestCase {
    // MARK: Helpers

    static func started(_ seq: Int, turn: String = "t1", ts: String = "2026-10-26T10:00:00.250Z") -> Event {
        E.event(seq, "turn.started", ["ts": ts], turn: turn)
    }

    static func reasoning(_ seq: Int, _ item: String, _ text: String = "Looking at it", turn: String = "t1") -> Event {
        E.event(seq, "reasoning", ["itemId": item, "text": text], turn: turn)
    }

    static func edit(_ seq: Int, _ item: String, path: String, old: String = "a", new: String = "b", name: String = "Edit") -> Event {
        E.call(seq, item, name: name, kind: name == "Write" ? "write" : "edit", title: "\(name) \(path)",
               input: name == "Write" ? ["file_path": path, "content": new] : ["file_path": path, "old_string": old, "new_string": new])
    }

    /// Plays a change onto a list of ids the way a table does (removals at
    /// old indices, then inserts at new ones) and checks it ends up as the
    /// model's rows, and that updates point at real rows.
    static func replay(_ change: TranscriptChange, onto table: inout [String], model: TranscriptModel, file: StaticString = #filePath, line: UInt = #line) {
        for index in change.removed.reversed() { table.remove(at: index) }
        for index in change.inserted { table.insert(model.rows[index].id, at: index) }
        XCTAssertEqual(table, model.rows.map(\.id), "replayed change", file: file, line: line)
        XCTAssertTrue(change.updated.allSatisfy { $0 < model.rows.count }, file: file, line: line)
        XCTAssertTrue(change.updated.intersection(change.inserted).isEmpty, file: file, line: line)
    }

    // MARK: Grouping rules

    func testARunOfOneIsShownAsItself() {
        let model = TranscriptModel(events: [E.user(1, "Go"), E.call(2, "c1"), E.result(3, "c1"), E.text(4, "m1", "Done")])
        XCTAssertEqual(Array(model.rows.map(\.id).prefix(3)), ["u:1", "t:c1", "a:m1"])
    }

    /// A finished turn is Mike's message, one line of work with everything
    /// the agent did, its reply and its cards, like Codex desktop (Mike,
    /// 29 Oct): its progress notes fold away too.
    func testAFinishedTurnFoldsAllItsWorkIntoOneLine() {
        let model = TranscriptModel(events: [
            E.user(1, "Go"), E.text(2, "m0", "Looking."), E.call(3, "c1"), E.result(4, "c1"),
            E.text(5, "m1", "Found it, fixing."), E.call(6, "c2"), E.result(7, "c2"), E.text(8, "m2", "Fixed."), E.done(9),
        ])
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:a:m0", "a:m2", "f:t1"])
        guard case .group(let group)? = model.row(id: "g:a:m0")?.content else { return XCTFail("a group") }
        XCTAssertEqual(group.memberIds, ["a:m0", "t:c1", "a:m1", "t:c2"])
        XCTAssertEqual(group.summary, "Worked for 4s")
        // Opening it shows everything, in order, above the reply.
        var open = model
        _ = open.setExpanded("g:a:m0", true)
        XCTAssertEqual(open.rows.map(\.id), ["u:1", "g:a:m0", "a:m0", "t:c1", "a:m1", "t:c2", "a:m2", "f:t1"])
        // Live, the turn's lines become the one as it finishes.
        var live = TranscriptModel(events: Array(model.events.dropLast()))
        var table = live.rows.map(\.id)
        Self.replay(live.apply([E.done(9)]), onto: &table, model: live)
        XCTAssertEqual(live.rows.map(\.id), model.rows.map(\.id))
    }

    func testMessagesCardsPlansImagesAndErrorsEndARun() {
        let model = TranscriptModel(events: [
            E.user(1, "Go"),
            Self.reasoning(2, "r1"), E.call(3, "c1"), E.result(4, "c1"),
            E.text(5, "m1", "First look done."),
            E.call(6, "c2"), E.event(7, "plan.updated", ["entries": [["text": "A", "status": "pending"]]]),
            E.call(8, "c3"), E.call(9, "c4"), E.result(10, "c4", images: [["path": "/tmp/a.png", "mediaType": "image/png"]]),
            E.call(11, "c5"), E.event(12, "error", ["message": "Oops"]),
            E.call(13, "c6"), E.event(14, "system.note", ["text": "Compacted the conversation"]),
            E.event(15, "approval.requested", ["approvalId": "ap1", "name": "Bash", "title": "rm x", "input": [:], "options": ["allow"]]),
        ])
        XCTAssertEqual(model.rows.map(\.id), [
            "u:1", "g:r:r1", "a:m1", "t:c2", "p:7", "g:t:c3", "i:c4", "t:c5", "e:12", "g:t:c6", "ap:ap1",
        ])
        guard case .group(let group)? = model.row(id: "g:t:c6")?.content else { return XCTFail() }
        XCTAssertEqual(group.memberIds, ["t:c6", "n:14"], "system notes fold in with the work")
    }

    func testRunsDoNotCrossTurns() {
        let model = TranscriptModel(events: [
            E.call(1, "c1"), E.result(2, "c1"),
            E.call(3, "c2", title: "pwd").withTurn("t2"), E.call(4, "c3").withTurn("t2"),
        ])
        XCTAssertEqual(model.rows.map(\.id), ["t:c1", "g:t:c2"])
    }

    // MARK: Approvals in runs

    static func asked(_ seq: Int, _ id: String, name: String = "Bash") -> Event {
        E.event(seq, "approval.requested", ["approvalId": id, "name": name, "title": "rm x", "input": ["command": "rm x"], "options": ["allow", "deny"]])
    }

    static func resolved(_ seq: Int, _ id: String, _ decision: String) -> Event {
        E.event(seq, "approval.resolved", ["approvalId": id, "decision": decision])
    }

    /// An approval Mike allowed is a step of the work: it folds into the
    /// run with the tool it let run. Waiting, denied and expired ones stay
    /// cards between runs.
    func testAllowedApprovalsFoldIntoTheRun() {
        let allowed = TranscriptModel(events: [
            E.user(1, "Go"), E.call(2, "c1"), E.result(3, "c1"),
            Self.asked(4, "ap1"), Self.resolved(5, "ap1", "allow"), E.call(6, "c2", title: "rm x"), E.result(7, "c2"),
            E.text(8, "m1", "Done"),
        ])
        XCTAssertEqual(allowed.rows.map(\.id), ["u:1", "g:t:c1", "a:m1"])
        guard case .group(let group)? = allowed.row(id: "g:t:c1")?.content else { return XCTFail() }
        XCTAssertEqual(group.memberIds, ["t:c1", "ap:ap1", "t:c2"])
        XCTAssertEqual(group.summary, "Ran 2 commands", "the approval isn't counted on top of the command it allowed")

        for decision in ["deny", "expired"] {
            let model = TranscriptModel(events: [
                E.user(1, "Go"), E.call(2, "c1"), Self.asked(3, "ap1"), Self.resolved(4, "ap1", decision), E.call(5, "c2"),
            ])
            XCTAssertEqual(model.rows.map(\.id), ["u:1", "t:c1", "ap:ap1", "t:c2"], decision)
        }
        let waiting = TranscriptModel(events: [E.user(1, "Go"), E.call(2, "c1"), Self.asked(3, "ap1")])
        XCTAssertEqual(waiting.rows.map(\.id), ["u:1", "t:c1", "ap:ap1"])
    }

    func testARunOfOnlyAnAllowedApprovalIsShownAsItself() {
        let model = TranscriptModel(events: [E.user(1, "Go"), Self.asked(2, "ap1"), Self.resolved(3, "ap1", "allowAlways")])
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "ap:ap1"])
        let two = TranscriptModel(events: [E.user(1, "Go"), Self.asked(2, "ap1"), Self.resolved(3, "ap1", "allow"),
                                           Self.asked(4, "ap2"), Self.resolved(5, "ap2", "allow")])
        guard case .group(let group)? = two.row(id: "g:ap:ap1")?.content else { return XCTFail() }
        XCTAssertEqual(group.summary, "Allowed 2 requests")
    }

    /// Allowing the card between two runs joins them into the first one's
    /// group, through the same incremental change as any other update: the
    /// first group keeps its id, the card and the second group go.
    func testAllowingACardMergesTheRunsAroundIt() {
        var model = TranscriptModel(events: [
            E.user(1, "Go"), Self.started(2), E.call(3, "c1"), E.call(4, "c2"), Self.asked(5, "ap1"),
        ])
        // A tool that ran in the background while the card waited.
        _ = model.apply([E.call(6, "c3"), E.call(7, "c4")])
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:t:c1", "ap:ap1", "g:t:c3"])
        var table = model.rows.map(\.id)
        let groupVersion = model.row(id: "g:t:c1")?.version

        let change = model.apply([Self.resolved(8, "ap1", "allow")])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:t:c1", "w:t1"])
        XCTAssertEqual(change.removed, [2, 3], "the card and the second group go")
        XCTAssertEqual(change.updated, [1])
        XCTAssertNotEqual(model.row(id: "g:t:c1")?.version, groupVersion)
        guard case .group(let group)? = model.row(id: "g:t:c1")?.content else { return XCTFail() }
        XCTAssertEqual(group.memberIds, ["t:c1", "t:c2", "ap:ap1", "t:c3", "t:c4"])
        XCTAssertTrue(group.isLive)
    }

    static func askedFor(_ seq: Int, _ id: String, tool: String?) -> Event {
        var fields: [String: Any] = ["approvalId": id, "name": "Write", "title": "Write /a.sh", "input": ["file_path": "/a.sh", "content": "x"],
                                     "options": ["allow", "deny"]]
        if let tool { fields["itemId"] = tool }
        return E.event(seq, "approval.requested", fields)
    }

    func approval(_ model: TranscriptModel, _ id: String) -> ApprovalItem? {
        if case .approval(let item)? = model.item(id: id)?.content { return item }
        return nil
    }

    /// A settled approval whose tool call has its own row doesn't open: that
    /// row opens to the same file or command. The runner sends the call
    /// first; the approval can also come first (an older page, the mock).
    func testASettledApprovalWithItsToolsRowDoesNotOpen() {
        let callFirst = TranscriptModel(events: [
            E.user(1, "Go"), Self.edit(2, "w", path: "/a.sh", name: "Write"), Self.askedFor(3, "ap1", tool: "w"),
            Self.resolved(4, "ap1", "allow"), E.result(5, "w"),
        ])
        XCTAssertEqual(approval(callFirst, "ap:ap1")?.toolShown, true)
        XCTAssertEqual(approval(callFirst, "ap:ap1")?.opens, false)

        var approvalFirst = TranscriptModel(events: [E.user(1, "Go"), Self.started(2), Self.askedFor(3, "ap1", tool: "w")])
        XCTAssertEqual(approval(approvalFirst, "ap:ap1")?.opens, true, "a waiting card always shows what it asks")
        _ = approvalFirst.apply([Self.resolved(4, "ap1", "allow")])
        XCTAssertEqual(approval(approvalFirst, "ap:ap1")?.opens, true, "nothing else shows the file yet")
        let version = approvalFirst.item(id: "ap:ap1")?.version
        _ = approvalFirst.apply([Self.edit(5, "w", path: "/a.sh", name: "Write")])
        XCTAssertEqual(approval(approvalFirst, "ap:ap1")?.opens, false)
        XCTAssertNotEqual(approvalFirst.item(id: "ap:ap1")?.version, version, "the line is measured again without its chevron")
        // The result after it changes nothing more on the approval.
        let settled = approvalFirst.item(id: "ap:ap1")?.version
        _ = approvalFirst.apply([E.result(6, "w")])
        XCTAssertEqual(approvalFirst.item(id: "ap:ap1")?.version, settled)

        // A subagent's tool has no item id and no row: its approval still opens.
        let subagent = TranscriptModel(events: [E.user(1, "Go"), Self.askedFor(2, "ap1", tool: nil), Self.resolved(3, "ap1", "allow")])
        XCTAssertEqual(approval(subagent, "ap:ap1")?.opens, true)
        // Denied with its tool shown: the line is the record, the tool row the detail.
        let denied = TranscriptModel(events: [
            E.user(1, "Go"), Self.edit(2, "w", path: "/a.sh", name: "Write"), Self.askedFor(3, "ap1", tool: "w"), Self.resolved(4, "ap1", "deny"),
        ])
        XCTAssertEqual(approval(denied, "ap:ap1")?.opens, false)
    }

    /// An open group shows the allowed approval as one of its lines.
    func testAnOpenGroupListsItsAllowedApproval() {
        var model = TranscriptModel(events: [E.call(1, "c1"), Self.asked(2, "ap1"), Self.resolved(3, "ap1", "allow"), E.call(4, "c2")])
        _ = model.setExpanded("g:t:c1", true)
        XCTAssertEqual(model.rows.map(\.id), ["g:t:c1", "t:c1", "ap:ap1", "t:c2"])
        XCTAssertEqual(model.row(id: "ap:ap1")?.inGroup, true)
    }

    // MARK: Summaries

    func testSummaryCountsWorkInTheOrderItHappened() {
        let model = TranscriptModel(events: [
            E.call(1, "c1", name: "Read", kind: "read", title: "Read a", input: ["file_path": "/a.swift"]),
            E.call(2, "c2", name: "Read", kind: "read", title: "Read b", input: ["file_path": "/b.swift"]),
            E.call(3, "c3", name: "Read", kind: "read", title: "Read a again", input: ["file_path": "/a.swift"]),
            E.call(4, "c4", name: "Grep", kind: "search", title: "Search"),
            E.call(5, "c5", name: "Glob", kind: "search", title: "Find"),
            Self.edit(6, "c6", path: "/a.swift"),
            Self.edit(7, "c7", path: "/b.swift", name: "Write"),
            Self.edit(8, "c8", path: "/a.swift"),
            E.call(9, "c9", title: "npm test"), E.call(10, "c10", title: "npm run lint"),
            E.result(11, "c10", ok: false, text: "lint failed"),
            Self.reasoning(12, "r1"),
        ])
        guard case .group(let group)? = model.rows.first?.content else { return XCTFail() }
        XCTAssertEqual(group.summary, "Read 2 files, searched twice, edited 2 files, ran 2 commands")
        XCTAssertEqual(group.failedCount, 1)
        XCTAssertEqual(group.memberIds.count, 11)
    }

    func testSummaryWordsForOtherWork() {
        func summary(_ events: [Event]) -> String {
            guard case .group(let group)? = TranscriptModel(events: events).rows.first?.content else { return "" }
            return group.summary
        }
        XCTAssertEqual(summary([Self.reasoning(1, "r1"), Self.reasoning(2, "r2")]), "Thought")
        XCTAssertEqual(summary([E.call(1, "c1", name: "Task", kind: "task", title: "Explore"), Self.reasoning(2, "r1")]), "Ran an agent")
        XCTAssertEqual(summary([
            E.call(1, "c1", name: "WebFetch", kind: "web", title: "Fetch a"), E.call(2, "c2", name: "WebFetch", kind: "web", title: "Fetch b"),
            E.call(3, "c3", name: "WebSearch", kind: "web", title: "Search the web"),
        ]), "Fetched 2 pages, searched once")
        XCTAssertEqual(summary([
            E.call(1, "c1", name: "mcp__notion__search", kind: "mcp", title: "Notion"), E.call(2, "c2", name: "Mystery", kind: "other", title: "?"),
            E.call(3, "c3", title: "ls"),
        ]), "Used 2 tools, ran a command")
        XCTAssertEqual(summary([
            E.event(1, "system.note", ["text": "Resumed session"]), E.event(2, "system.note", ["text": "Compacted"]),
        ]), "Resumed session")
    }

    // MARK: Live updates

    /// The group keeps its id (the first item's) as it grows, so its
    /// expansion and cached height survive streaming; each step is a small
    /// change, never a reload.
    func testAGroupKeepsItsIdAsItGrows() {
        var model = TranscriptModel(events: [E.user(1, "Go"), Self.started(2)])
        var table = model.rows.map(\.id)
        XCTAssertEqual(table, ["u:1", "w:t1"])

        var change = model.apply([Self.reasoning(3, "r1")])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "r:r1", "w:t1"])
        XCTAssertEqual(change.inserted, [1])

        // A second item turns the lone row into a group in its place.
        change = model.apply([E.call(4, "c1", title: "npm test", input: ["command": "npm test"])])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:r:r1", "w:t1"])
        XCTAssertEqual(change.removed, [1])
        XCTAssertEqual(change.inserted, [1])
        XCTAssertEqual(change.updated, [], "the working line is left as it is")

        let version = model.rows[1].version
        change = model.apply([E.result(5, "c1"), E.call(6, "c2", name: "Read", kind: "read", title: "Read a.swift")])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:r:r1", "w:t1"])
        XCTAssertEqual(change, TranscriptChange(updated: [1]))
        XCTAssertGreaterThan(model.rows[1].version, version)
        guard case .group(let group) = model.rows[1].content else { return XCTFail() }
        XCTAssertEqual(group.summary, "Ran a command, read a file")
        XCTAssertTrue(group.isLive)
        XCTAssertEqual(group.currentAction, "Read a.swift")

        // Text after it ends the run: the group is no longer the live one.
        change = model.apply([E.result(7, "c2"), E.delta(7, "m1", "Found")])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:r:r1", "a:m1", "w:t1"])
        XCTAssertEqual(change.inserted, [2])
        XCTAssertEqual(change.updated, [1], "only the group, no longer live")
        guard case .group(let finished) = model.rows[1].content else { return XCTFail() }
        XCTAssertFalse(finished.isLive)
        XCTAssertNil(finished.currentAction)

        // Streaming text only touches its own row.
        change = model.apply([E.delta(7, "m1", " it.")])
        XCTAssertEqual(change, TranscriptChange(updated: [2]))
    }

    func testAClosedGroupIgnoresOutputFromItsTools() {
        var model = TranscriptModel(events: [Self.started(1), E.call(2, "c1"), E.result(3, "c1"), E.call(4, "c2", title: "npm test")])
        XCTAssertEqual(model.rows.map(\.id), ["g:t:c1", "w:t1"])
        let change = model.apply([E.event(4, "tool.output.delta", ["itemId": "c2", "text": "PASS a.test.ts\n"])])
        XCTAssertTrue(change.isEmpty, "nothing on screen changed")
        guard case .tool(let tool)? = model.item(id: "t:c2")?.content else { return XCTFail() }
        XCTAssertEqual(tool.liveOutput, "PASS a.test.ts\n")
    }

    func testOpeningAGroupInsertsItsItemsUnderIt() {
        var model = TranscriptModel(events: [
            E.user(1, "Go"), Self.reasoning(2, "r1"), E.call(3, "c1"), E.result(4, "c1"), E.text(5, "m1", "Done"),
        ])
        var table = model.rows.map(\.id)
        let version = model.rows[1].version
        var change = model.setExpanded("g:r:r1", true)
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:r:r1", "r:r1", "t:c1", "a:m1"])
        XCTAssertEqual(change.inserted, [2, 3])
        XCTAssertEqual(change.updated, [1], "the chevron turns")
        XCTAssertEqual(model.rows.filter(\.inGroup).map(\.id), ["r:r1", "t:c1"])
        XCTAssertNotEqual(model.rows[1].version, version)
        guard case .group(let group) = model.rows[1].content else { return XCTFail() }
        XCTAssertTrue(group.isExpanded)

        // A tool that finishes inside an open group updates its own row.
        change = model.apply([E.result(6, "c1", text: "changed")])
        XCTAssertTrue(change.updated.contains(3))
        XCTAssertTrue(change.inserted.isEmpty && change.removed.isEmpty)

        // Opening it again is nothing; closing takes its items out.
        XCTAssertTrue(model.setExpanded("g:r:r1", true).isEmpty)
        change = model.setExpanded("g:r:r1", false)
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(change.removed, [2, 3])
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:r:r1", "a:m1"])
    }

    func testAnOpenGroupGainsNewItemsInPlace() {
        var model = TranscriptModel(events: [Self.started(1), E.call(2, "c1"), E.call(3, "c2")])
        _ = model.setExpanded("g:t:c1", true)
        var table = model.rows.map(\.id)
        let change = model.apply([E.call(4, "c3")])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["g:t:c1", "t:c1", "t:c2", "t:c3", "w:t1"])
        XCTAssertEqual(change.inserted, [3])
        XCTAssertEqual(change.updated, [0])
    }

    func testOpenGroupsStayOpenWhenOlderEventsArePrepended() {
        var model = TranscriptModel(events: [E.user(5, "Go"), E.call(6, "c1"), E.call(7, "c2"), E.text(8, "m1", "Done")])
        _ = model.setExpanded("g:t:c1", true)
        let result = model.prepend(olderEvents: [E.user(3, "Earlier"), E.text(4, "m0", "Hi")])
        XCTAssertTrue(result.keepsOrder)
        XCTAssertEqual(result.added, 2)
        XCTAssertEqual(model.rows.map(\.id), ["u:3", "a:m0", "u:5", "g:t:c1", "t:c1", "t:c2", "a:m1"])
        XCTAssertEqual(result.changedIds, [], "the group's content and version are unchanged")
    }

    /// Whatever order events arrive in, applying them one at a time ends
    /// with the rows a fresh load makes, and every change replays exactly.
    func testIncrementalRowsMatchAFreshLoad() {
        let events: [Event] = [
            E.user(1, "Fix it"), Self.started(2), Self.reasoning(3, "r1"),
            E.call(4, "c1", name: "Grep", kind: "search", title: "Search"), E.result(5, "c1"),
            E.call(6, "c2", name: "Read", kind: "read", title: "Read a", input: ["file_path": "/a"]), E.result(7, "c2"),
            E.text(8, "m1", "Found it."),
            Self.edit(9, "c3", path: "/a"), E.result(10, "c3"),
            E.call(11, "c4", title: "Screenshot"), E.result(12, "c4", images: [["path": "/tmp/s.png", "mediaType": "image/png"]]),
            E.call(13, "c5", title: "npm test"), E.result(14, "c5"),
            E.event(15, "approval.requested", ["approvalId": "ap1", "name": "Bash", "title": "rm x", "input": [:], "options": ["allow"]]),
            E.event(16, "approval.resolved", ["approvalId": "ap1", "decision": "allow"]),
            E.call(17, "c6", title: "rm x"), E.result(18, "c6"),
            E.text(19, "m2", "All done."),
            E.done(20),
        ]
        for open in [false, true] {
            var model = TranscriptModel()
            var table: [String] = []
            for (step, event) in events.enumerated() {
                let change = model.apply([event])
                Self.replay(change, onto: &table, model: model)
                if open {
                    for row in model.rows where row.kind == .group && !model.isExpanded(row.id) {
                        Self.replay(model.setExpanded(row.id, true), onto: &table, model: model)
                    }
                }
                var fresh = TranscriptModel()
                fresh.load(events: Array(events.prefix(step + 1)))
                for key in model.expanded { _ = fresh.setExpanded(key, true) }
                XCTAssertEqual(model.rows.map(\.id), fresh.rows.map(\.id), "after event \(step + 1)")
                XCTAssertEqual(model.rows.map(\.content), fresh.rows.map(\.content), "after event \(step + 1)")
            }
        }
    }

    // MARK: Working line

    func testTheWorkingLineShowsWhileATurnRunsAndNotWhileItWaits() {
        var model = TranscriptModel(events: [E.user(1, "Go"), Self.started(2), E.call(3, "c1")])
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "t:c1", "w:t1"])
        guard case .working(let status)? = model.rows.last?.content else { return XCTFail() }
        XCTAssertEqual(status.turnId, "t1")
        XCTAssertEqual(status.startedAt, Date(timeIntervalSince1970: 1_793_008_800.25))
        var table = model.rows.map(\.id)

        var change = model.apply([E.event(4, "approval.requested", ["approvalId": "ap1", "name": "Bash", "title": "rm x", "input": [:], "options": ["allow"]])])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "t:c1", "ap:ap1"], "waiting on Mike isn't working")

        change = model.apply([E.event(5, "approval.resolved", ["approvalId": "ap1", "decision": "allow"])])
        Self.replay(change, onto: &table, model: model)
        // Allowed, the card folds into the run with the command before it.
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:t:c1", "w:t1"])

        change = model.apply([E.done(6)])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:t:c1", "f:t1"])
        XCTAssertNil(model.openTurn)
    }

    /// The working line is the turn's one spinner wherever it sits, so it
    /// doesn't change (or re-render) as a live group above it comes, opens
    /// and finishes.
    func testTheWorkingLineKeepsItsVersionAsWorkComesAndGoes() {
        func working(_ model: TranscriptModel) -> TranscriptRow? { model.rows.last { $0.kind == .working } }
        var model = TranscriptModel(events: [E.user(1, "Go"), Self.started(2), E.call(3, "c1")])
        let version = working(model)?.version
        XCTAssertNotNil(version)
        _ = model.apply([E.call(4, "c2")])
        XCTAssertEqual(model.rows.map(\.id), ["u:1", "g:t:c1", "w:t1"])
        XCTAssertEqual(working(model)?.version, version, "under the live group")
        _ = model.setExpanded("g:t:c1", true)
        XCTAssertEqual(working(model)?.version, version, "under the open group")
        _ = model.apply([E.text(5, "m1", "Found it")])
        XCTAssertEqual(working(model)?.version, version, "under a reply")
    }

    func testATurnThatStartedOnAnOlderPageIsStillRunning() {
        let model = TranscriptModel(events: [E.call(600, "c1"), E.result(601, "c1")])
        XCTAssertEqual(model.openTurn, "t1")
        guard case .working(let status)? = model.rows.last?.content else { return XCTFail("no working line") }
        XCTAssertNil(status.startedAt, "the start is on a page we haven't loaded")

        // A page that starts with the turn's message would have had its start.
        let finished = TranscriptModel(events: [E.user(600, "Go"), E.call(601, "c1")])
        XCTAssertNil(finished.openTurn)
    }

    // MARK: Changed files card

    func testAChangedFilesCardComesBeforeTheFooter() {
        var model = TranscriptModel(events: [
            E.user(1, "Change things"), Self.started(2),
            Self.edit(3, "c1", path: "/repo/Sources/A.swift", old: "a\nb", new: "a\nc\nd"), E.result(4, "c1"),
            Self.edit(5, "c2", path: "/repo/README.md", new: "# Hi\n\nText\n", name: "Write"), E.result(6, "c2"),
            Self.edit(7, "c3", path: "/repo/Sources/A.swift", old: "d", new: "e"), E.result(8, "c3"),
            Self.edit(9, "c4", path: "/repo/Sources/B.swift"), E.result(10, "c4", ok: false, text: "old_string not found"),
            E.text(11, "m1", "Done."),
        ])
        XCTAssertNil(model.rows.first { $0.kind == .changes }, "no card until the turn ends")
        var table = model.rows.map(\.id)
        var change = model.apply([E.done(12)])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(Array(model.rows.map(\.id).suffix(3)), ["a:m1", "cf:t1", "f:t1"])
        guard case .changes(let card)? = model.row(id: "cf:t1")?.content else { return XCTFail() }
        XCTAssertEqual(card.title, "Edited 2 files")
        XCTAssertEqual(card.files.map(\.path), ["/repo/Sources/A.swift", "/repo/README.md"])
        XCTAssertEqual(card.files.map(\.added), [3, 3])
        XCTAssertEqual(card.files.map(\.removed), [2, 0])
        XCTAssertEqual(card.files[0].diffs.count, 2, "both edits to A.swift")
        XCTAssertEqual(card.files[0].name, "A.swift")
        XCTAssertEqual(card.files[0].folder, "repo/Sources")

        let version = model.row(id: "cf:t1")!.version
        change = model.setExpanded(ChangedFiles.expansionKey(turnId: "t1", path: "/repo/README.md"), true)
        XCTAssertEqual(change, TranscriptChange(updated: [model.indexOf(id: "cf:t1")!]))
        guard case .changes(let opened)? = model.row(id: "cf:t1")?.content else { return XCTFail() }
        XCTAssertEqual(opened.files.map(\.isExpanded), [false, true])
        XCTAssertNotEqual(model.row(id: "cf:t1")?.version, version)
    }

    /// A file opened in the card shows the first lines of its diff; "Show N
    /// more lines" opens the rest through its own key, and closing the file
    /// forgets that, so it opens short again.
    func testShowingAllOfAChangedFilesDiffRoundTrips() {
        var model = TranscriptModel(events: [
            E.user(1, "Write it"), Self.edit(2, "c1", path: "/repo/Long.swift", new: (1...40).map { "line \($0)" }.joined(separator: "\n"), name: "Write"),
            E.result(3, "c1"), E.done(4),
        ])
        func file() -> ChangedFile? {
            guard case .changes(let card)? = model.row(id: "cf:t1")?.content else { return nil }
            return card.files.first
        }
        let key = ChangedFiles.expansionKey(turnId: "t1", path: "/repo/Long.swift")
        let all = DiffPreview.allKey(key)
        XCTAssertEqual(all, "cf:t1|/repo/Long.swift|all")
        _ = model.setExpanded(key, true)
        XCTAssertEqual(file()?.isExpanded, true)
        XCTAssertEqual(file()?.showsAll, false)

        let version = model.row(id: "cf:t1")!.version
        let change = model.setExpanded(all, true)
        XCTAssertEqual(change, TranscriptChange(updated: [model.indexOf(id: "cf:t1")!]), "only the card changes")
        XCTAssertNotEqual(model.row(id: "cf:t1")?.version, version, "so its height is measured again")
        XCTAssertEqual(file()?.showsAll, true)
        XCTAssertTrue(model.isExpanded(all))

        _ = model.setExpanded(key, false)
        XCTAssertEqual(file()?.isExpanded, false)
        XCTAssertEqual(file()?.showsAll, false)
        XCTAssertFalse(model.isExpanded(all))
        _ = model.setExpanded(key, true)
        XCTAssertEqual(file()?.showsAll, false, "opens short again")
    }

    func testADiffIsOnlyShortenedWhenThatHidesEnough() {
        XCTAssertEqual(DiffPreview.shown(of: 5), 5)
        XCTAssertEqual(DiffPreview.shown(of: 15), 15, "not 12 and \"Show 3 more lines\"")
        XCTAssertEqual(DiffPreview.shown(of: 18), 18)
        XCTAssertEqual(DiffPreview.shown(of: 19), 12)
        XCTAssertEqual(DiffPreview.shown(of: 400), 12)
    }

    /// Tool rows keep their open state in the app's own set, by the same rule.
    func testDiffPreviewKeysInASet() {
        var open: Set<String> = []
        DiffPreview.set("t:c1", open: true, in: &open)
        DiffPreview.set(DiffPreview.allKey("t:c1"), open: true, in: &open)
        XCTAssertEqual(open, ["t:c1", "t:c1|all"])
        DiffPreview.set("t:c1", open: false, in: &open)
        XCTAssertEqual(open, [])
    }

    func testAThoughtIsSummedUpByItsFirstSentence() {
        XCTAssertEqual(WorkSummary.thought("Uploads are chunked already, so the missing piece is remembering which chunks the server confirmed. I should look at UploadTask first."),
                       "Uploads are chunked already, so the missing piece is remembering which chunks the server confirmed.")
        XCTAssertEqual(WorkSummary.thought("Hmm. Let me look at the logs first and then decide."), "Hmm. Let me look at the logs first and then decide.", "too short a sentence to stand alone")
        XCTAssertEqual(WorkSummary.thought("One long line with no full stop at all"), "One long line with no full stop at all")
        XCTAssertEqual(WorkSummary.thought("First line only.\nSecond line"), "First line only.")
        XCTAssertEqual(WorkSummary.thought(""), "")
    }

    /// A diff that lands after its turn finished updates the turn's card,
    /// and only the rows for that turn change.
    func testALateDiffUpdatesItsTurnsCard() {
        var model = TranscriptModel(events: [
            E.user(1, "Edit it"), Self.edit(2, "c1", path: "/a.swift"), E.result(3, "c1"), E.text(4, "m1", "Done"), E.done(5),
            E.user(6, "Thanks").withTurn("t2"), E.text(7, "m2", "Any time").withTurn("t2"), E.done(8, turn: "t2"),
        ])
        var table = model.rows.map(\.id)
        let after = model.rows.suffix(3).map(\.version)
        let change = model.apply([E.event(9, "edit.diff", ["itemId": "c1", "path": "/a.swift", "hunks": [
            ["oldStart": 40, "oldLines": 1, "newStart": 40, "newLines": 2, "lines": ["-a", "+b", "+c"]],
        ]])])
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(change.updated, [3], "its turn's card; the edit is folded in the turn's line")
        XCTAssertEqual(model.rows.suffix(3).map(\.version), after, "the next turn's rows are untouched")
        guard case .changes(let card)? = model.row(id: "cf:t1")?.content else { return XCTFail() }
        XCTAssertEqual(card.files.first?.added, 2)
    }

    /// Opening a group near the top of a long thread only touches that
    /// group's rows; everything after it keeps its version.
    func testOpeningAnEarlyGroupLeavesLaterRowsAlone() {
        var events: [Event] = []
        var seq = 0
        for turn in 0..<20 {
            let id = "t\(turn)"
            seq += 1; events.append(E.user(seq, "Go \(turn)").withTurn(id))
            seq += 1; events.append(E.call(seq, "a\(turn)").withTurn(id))
            seq += 1; events.append(E.call(seq, "b\(turn)").withTurn(id))
            seq += 1; events.append(E.text(seq, "m\(turn)", "Done").withTurn(id))
            seq += 1; events.append(E.done(seq, turn: id))
        }
        var model = TranscriptModel(events: events)
        var table = model.rows.map(\.id)
        let later = model.rows.dropFirst(4).map { "\($0.id)|\($0.version)" }
        let change = model.setExpanded("g:t:a0", true)
        Self.replay(change, onto: &table, model: model)
        XCTAssertEqual(change, TranscriptChange(inserted: [2, 3], updated: [1]))
        XCTAssertEqual(model.rows.dropFirst(6).map { "\($0.id)|\($0.version)" }, later)
        XCTAssertEqual(model.indexOf(id: "f:t19"), model.rows.count - 1, "rows after the group moved down in the index too")
    }

    func testASummarizedTurnHasNoCard() {
        let model = TranscriptModel(events: [
            E.user(1, "Change things"), Self.started(2),
            Self.edit(3, "c1", path: "/repo/Sources/A.swift", old: "a", new: "b"), E.result(4, "c1"),
            E.event(5, "assistant.text", ["itemId": "m1", "text": "- Changed A", "summary": true], turn: "t1"),
            E.done(6),
        ])
        XCTAssertNotNil(model.row(id: "a:m1"))
        XCTAssertNil(model.rows.first { $0.kind == .changes })
    }

    /// One reply: the final message is the reply, as the summary was, so
    /// the turn has no card either (it came back once One reply was on).
    func testAOneReplyTurnHasNoCard() {
        let model = TranscriptModel(events: [
            E.user(1, "Change things"), Self.started(2),
            Self.edit(3, "c1", path: "/repo/Sources/A.swift", old: "a", new: "b"), E.result(4, "c1"),
            E.event(5, "assistant.text", ["itemId": "m1", "text": "Changed A.", "final": true], turn: "t1"),
            E.done(6),
        ])
        XCTAssertNotNil(model.row(id: "a:m1"))
        XCTAssertNil(model.rows.first { $0.kind == .changes })
    }

    /// A sign-off shorter than the bullets loses to them, unless the summary
    /// was written with bullet replies off (docs/protocol.md, "The summary").
    func testASummaryThatGivesWayLosesToAShortMessage() {
        func model(givesWay: Bool) -> TranscriptModel {
            var summary: [String: Any] = ["itemId": "e1.summary", "text": "- Fixed the loader bug and the tests pass", "summary": true]
            if givesWay { summary["givesWay"] = true }
            return TranscriptModel(events: [
                E.user(1, "Fix it"), Self.started(2),
                E.call(3, "c1").withTurn("t1"), E.result(4, "c1").withTurn("t1"),
                E.text(5, "m1", "Fixed it.").withTurn("t1"),
                E.call(6, "e1", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
                E.result(7, "e1", text: "Noted: this thread is done.").withTurn("t1"),
                E.event(8, "assistant.text", summary, turn: "t1"),
                E.done(9),
            ])
        }
        XCTAssertNotNil(model(givesWay: false).row(id: "a:e1.summary"))
        XCTAssertNil(model(givesWay: false).row(id: "a:m1"), "folded into the work")
        XCTAssertNotNil(model(givesWay: true).row(id: "a:m1"))
        XCTAssertNil(model(givesWay: true).row(id: "a:e1.summary"), "folded into the work")
    }

    /// One reply (docs/protocol.md, "One reply"): the message after
    /// end_turn is the reply, even under a longer message before it (a
    /// narration block or a draft), which folds into the work.
    func testOneReplysFinalMessageIsTheReply() {
        let model = TranscriptModel(events: [
            E.user(1, "Why is the bundle so big?"), Self.started(2),
            E.call(3, "c1").withTurn("t1"), E.result(4, "c1").withTurn("t1"),
            E.event(5, "assistant.text", ["itemId": "m1", "text": String(repeating: "A long draft of the answer. ", count: 20), "narration": true], turn: "t1"),
            E.call(6, "e1", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(7, "e1", text: "Noted: this thread is done. Now write your reply: it's the only text the user sees from this turn.").withTurn("t1"),
            E.event(8, "assistant.text", ["itemId": "m2", "text": "It's moment's locales.", "final": true], turn: "t1"),
            E.done(9),
        ])
        XCTAssertNotNil(model.row(id: "a:m2"))
        XCTAssertNil(model.row(id: "a:m1"), "folded into the work")
    }

    /// Thread 46de9389 (7 Nov 2026): a background `tb land` finished
    /// around end_turn, and the agent carried on and gave a second card.
    /// The report before that card is the reply, not "still landing".
    func testAfterAWakeTheLastCardsMessageIsTheReply() {
        let model = TranscriptModel(events: [
            E.user(1, "Land it"), Self.started(2),
            E.call(3, "c1").withTurn("t1"), E.result(4, "c1").withTurn("t1"),
            E.event(5, "system.note", ["text": "Background command \"Land\" completed (exit code 0)", "wake": true], turn: "t1"),
            E.text(6, "m1", "Still landing.").withTurn("t1"),
            E.call(7, "e1", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(8, "e1", text: "Noted: this thread is done.").withTurn("t1"),
            E.call(9, "c2").withTurn("t1"), E.result(10, "c2").withTurn("t1"),
            E.text(11, "m2", "Landed on main and pushed.").withTurn("t1"),
            E.call(12, "e2", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(13, "e2", text: "Noted: this thread is done.").withTurn("t1"),
            E.done(14),
        ])
        XCTAssertNotNil(model.row(id: "a:m2"))
        XCTAssertNil(model.row(id: "a:m1"), "folded into the work")
    }

    /// One reply: a reply to the card a wake replaced folds away too.
    func testAfterAWakeAnEarlierFinalReplyGivesWay() {
        let model = TranscriptModel(events: [
            E.user(1, "Land it"), Self.started(2),
            E.call(3, "e1", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(4, "e1", text: "Noted: this thread is done. Now write your reply.").withTurn("t1"),
            E.event(5, "assistant.text", ["itemId": "m1", "text": "Still landing.", "final": true], turn: "t1"),
            E.event(6, "system.note", ["text": "Background command \"Land\" completed (exit code 0)", "wake": true], turn: "t1"),
            E.call(7, "c2").withTurn("t1"), E.result(8, "c2").withTurn("t1"),
            E.text(9, "m2", "Landed on main and pushed.").withTurn("t1"),
            E.call(10, "e2", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(11, "e2", text: "Noted: this thread is done. Stop here: your message above is the reply.").withTurn("t1"),
            E.done(12),
        ])
        XCTAssertNotNil(model.row(id: "a:m2"))
        XCTAssertNil(model.row(id: "a:m1"), "folded into the work")
    }

    /// From Codex's review: the replaced card's long summary doesn't beat
    /// the short report under the card after the wake.
    func testAfterAWakeAReplacedSummaryGivesWay() {
        let model = TranscriptModel(events: [
            E.user(1, "Land it"), Self.started(2),
            E.call(3, "c1").withTurn("t1"), E.result(4, "c1").withTurn("t1"),
            E.call(5, "e1", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(6, "e1", text: "Noted: this thread is done.").withTurn("t1"),
            E.event(7, "assistant.text", ["itemId": "e1.summary", "text": "- Still building, and landing once the check on Tinker Desk passes", "summary": true], turn: "t1"),
            E.event(8, "system.note", ["text": "Background command \"Land\" completed (exit code 0)", "wake": true], turn: "t1"),
            E.call(9, "c2").withTurn("t1"), E.result(10, "c2").withTurn("t1"),
            E.text(11, "m2", "Landed and pushed.").withTurn("t1"),
            E.call(12, "e2", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(13, "e2", text: "Noted: this thread is done.").withTurn("t1"),
            E.done(14),
        ])
        XCTAssertNotNil(model.row(id: "a:m2"))
        XCTAssertNil(model.row(id: "a:e1.summary"), "folded into the work")
    }

    /// From Codex's review: one reply, woken, and stopped with no new card
    /// while other work runs. The report shows, beside the earlier reply.
    func testAfterAWakeWithNoNewCardTheReportShows() {
        let model = TranscriptModel(events: [
            E.user(1, "Land it"), Self.started(2),
            E.call(3, "e1", name: "mcp__threadbear__end_turn", kind: "mcp", title: "end_turn").withTurn("t1"),
            E.result(4, "e1", text: "Noted: this thread is done. Now write your reply.").withTurn("t1"),
            E.event(5, "assistant.text", ["itemId": "m1", "text": "Still landing.", "final": true], turn: "t1"),
            E.event(6, "system.note", ["text": "Background command \"Land\" completed (exit code 0)", "wake": true], turn: "t1"),
            E.call(7, "c2").withTurn("t1"), E.result(8, "c2").withTurn("t1"),
            E.event(9, "assistant.text", ["itemId": "m2", "text": "Landed on main and pushed.", "final": true], turn: "t1"),
            E.done(10),
        ])
        XCTAssertNotNil(model.row(id: "a:m2"))
    }

    func testATurnWithNoEditsHasNoCard() {
        let model = TranscriptModel(events: [E.user(1, "Hi"), E.call(2, "c1"), E.text(3, "m1", "Hello"), E.done(4)])
        XCTAssertNil(model.rows.first { $0.kind == .changes })
    }
}

extension Event {
    func withTurn(_ turn: String) -> Event {
        var copy = self
        copy.turnId = turn
        return copy
    }
}
