import XCTest
@testable import ThreadbearCore

/// docs/protocol.md, "Needs you": a finished turn's asks as a card, the
/// thread's summary fields, and how its sidebar row looks.
final class NeedsYouTests: XCTestCase {
    private func done(_ seq: Int, turn: String, needs: String? = nil, asks: [[String: Any]] = [], next: [Any] = [], outcome: String = "completed") -> Event {
        var fields: [String: Any] = ["turnId": turn, "outcome": outcome, "durationMs": 1000]
        if let needs { fields["needs"] = needs }
        if !asks.isEmpty { fields["asks"] = asks }
        if !next.isEmpty { fields["next"] = next }
        return E.event(seq, "turn.completed", fields, turn: turn)
    }

    private func card(_ model: TranscriptModel, _ id: String) -> AsksCard? {
        guard case .asks(let card)? = model.row(id: id)?.content else { return nil }
        return card
    }

    /// A turn that needs Mike gets its card under its footer, open until
    /// the next turn closes it, and keeps the picks the app gives it,
    /// through a rebuild too.
    func testATurnThatNeedsYouGetsACardThatKeepsItsPicksUntilHeReplies() {
        var model = TranscriptModel(events: [
            E.event(1, "turn.started", ["turnId": "t1"], turn: "t1"),
            E.text(2, "m1", "Built it."),
            done(3, turn: "t1", needs: "you", asks: [
                ["action": "Log in", "links": [["title": "Open login", "url": "https://hf.co/login"]], "options": ["Done", "Can't"]],
                ["action": "Pick a budget"],
            ]),
        ])
        guard case .footer(let footer)? = model.row(id: "f:t1")?.content else { return XCTFail() }
        XCTAssertEqual(footer.needs, "you")
        XCTAssertEqual(model.rows.last?.id, "ak:3")
        XCTAssertEqual(card(model, "ak:3")?.isOpen, true)
        XCTAssertEqual(card(model, "ak:3")?.asks.first?.links, [AskLink(title: "Open login", url: "https://hf.co/login")])
        XCTAssertFalse(model.setAskPicks(3, [0: 0]).isEmpty)
        XCTAssertEqual(card(model, "ak:3")?.picks, [0: 0])
        XCTAssertTrue(model.setAskPicks(3, [0: 0]).isEmpty, "the same picks change nothing")
        // A message from the runner (a resume) leaves it; Mike's reply closes
        // it, and a closed card isn't shown (the bubble has the answers).
        _ = model.apply([E.event(4, "user.message", ["text": "Carry on", "images": [], "origin": "runner"], turn: "t2")])
        XCTAssertEqual(card(model, "ak:3")?.isOpen, true)
        _ = model.apply([E.event(5, "user.message", ["text": "Log in\nDone", "images": []], turn: "t2"), E.event(6, "turn.started", ["turnId": "t2"], turn: "t2"), done(7, turn: "t2")])
        XCTAssertNil(model.row(id: "ak:3"))
        XCTAssertEqual(TranscriptModel(events: model.events).row(id: "ak:3"), nil, "nor after a reload")
    }

    /// A background job the agent left (a script waiting for his phone to
    /// unlock) wakes it with a runner message, which leaves the card open,
    /// and the summary keeps its asks while that turn runs. Every click on
    /// the card did nothing then, as a running thread counted as having
    /// nothing to answer (Mike, 7 Nov). Running, it takes the transcript's
    /// word: once his own reply (the phone's too) closed the card, a pick
    /// left unsent on this Mac mustn't go with his next message.
    func testACardLeftOpenByABackgroundWakeCanBeAnsweredWhileItRuns() {
        let asks: [[String: Any]] = [["action": "Unlock your iPhone", "options": ["Unlocked", "Later"]]]
        var model = TranscriptModel(events: [done(3, turn: "t1", needs: "you", asks: asks)])
        let ask = Ask(action: "Unlock your iPhone", options: ["Unlocked", "Later"])
        let idle = ThreadSummary(id: "t1", title: "Walkies pushes", status: .idle, needs: "you", asks: [ask], asksSeq: 3)
        var running = idle
        running.status = .running
        XCTAssertTrue(Decisions.isOpen(idle), "idle needs no transcript")
        XCTAssertFalse(Decisions.isOpen(running), "running with no transcript to say the card's open")

        _ = model.apply([E.event(4, "user.message", ["text": "The phone unlocked", "images": [], "origin": "runner"], turn: "t2"), E.event(5, "turn.started", ["turnId": "t2"], turn: "t2")])
        XCTAssertTrue(Decisions.isOpen(running, card: model.openCard), "the woken turn left the card open")
        var older = running
        older.asksSeq = 2
        XCTAssertFalse(Decisions.isOpen(older, card: model.openCard), "another card's seq")

        _ = model.apply([E.event(6, "user.message", ["text": "No, cancel that", "images": []], turn: "t2")])
        XCTAssertFalse(Decisions.isOpen(running, card: model.openCard), "his reply closed it, though the summary still has the asks")
        XCTAssertFalse(Decisions.isOpen(ThreadSummary(id: "t1", title: "Done", status: .idle, needs: "nothing", asks: [ask], asksSeq: 3)))
    }

    /// Picks the app had before the transcript loaded are on the card it builds.
    func testPicksSetBeforeTheEventsLoad() {
        var model = TranscriptModel()
        _ = model.setAskPicks(1, [0: 1])
        model.load(events: [done(1, turn: "t1", needs: "you", asks: [["action": "a", "options": ["x", "y"]]])])
        XCTAssertEqual(card(model, "ak:1")?.picks, [0: 1])
    }

    /// A message that answered asks keeps them for its bubble.
    func testAUserMessageKeepsItsAnswers() {
        let model = TranscriptModel(events: [E.event(1, "user.message", ["text": "Log in\nDone", "images": [], "answers": [["action": "Log in", "answer": "Done"], ["bad": 1]]], turn: "t1")])
        guard case .user(let message)? = model.row(id: "u:1")?.content else { return XCTFail() }
        XCTAssertEqual(message.answers, [AskAnswer(action: "Log in", answer: "Done")])
    }

    /// A turn that needs nothing gets the done card in place of its end_turn
    /// call, which isn't shown once the runner takes it; a refused one is.
    func testADoneTurnGetsTheDoneCardAndHidesItsEndTurn() {
        var model = TranscriptModel(events: [
            E.event(1, "turn.started", ["turnId": "t1"], turn: "t1"),
            E.call(2, "c1", name: "mcp__threadbear__end_turn", kind: "other", title: "end_turn", input: ["needs": "nothing"]),
            E.result(3, "c1", ok: false, text: "Not ended: Mike hasn't had a reply this turn."),
            E.text(4, "m1", "Built it."),
            E.call(5, "c2", name: "mcp__threadbear__end_turn", kind: "other", title: "end_turn", input: ["needs": "nothing"]),
            E.result(6, "c2", text: "Noted: this thread is done."),
            done(7, turn: "t1", needs: "nothing"),
        ])
        guard case .group(let work)? = model.row(id: "g:t:c1")?.content else { return XCTFail("the turn's line of work") }
        XCTAssertEqual(work.memberIds, ["t:c1"], "the refused call is in the turn's work; the taken one isn't shown")
        XCTAssertNil(model.row(id: "t:c2"))
        XCTAssertEqual(model.rows.last?.id, "ak:7")
        XCTAssertEqual(card(model, "ak:7")?.isDone, true)
        XCTAssertEqual(card(model, "ak:7")?.isOpen, true)
        // Mike's next message puts it away, as it does an asks card.
        _ = model.apply([E.event(8, "user.message", ["text": "One more thing", "images": []], turn: "t2")])
        XCTAssertNil(model.row(id: "ak:7"))
    }

    /// end_turn's follow-ups ride on the done card (Mike, 30 Oct: they got
    /// lost in the closing prose); one that isn't a string is dropped.
    func testTheDoneCardCarriesTheSuggestedNextSteps() {
        let model = TranscriptModel(events: [done(1, turn: "t1", needs: "nothing", next: ["Show Bruce pictures", 7, "Start Bruce threads"])])
        XCTAssertEqual(card(model, "ak:1")?.isDone, true)
        XCTAssertEqual(card(model, "ak:1")?.next, ["Show Bruce pictures", "Start Bruce threads"])
    }

    /// Ticking follow-ups shows on the done card, and survives a rebuild
    /// of the rows; several go as a list, with anything he typed after.
    func testFollowUpsAreTickedOnTheDoneCard() {
        var model = TranscriptModel(events: [done(1, turn: "t1", needs: "nothing", next: ["Check the nightly", "Refresh the cache"])])
        _ = model.setNextPicks(1, [0, 1])
        XCTAssertEqual(card(model, "ak:1")?.pickedNext, [0, 1])
        _ = model.setNextPicks(1, [1])
        XCTAssertEqual(card(model, "ak:1")?.pickedNext, [1])
        // Picks made before the events load (a transcript opened again).
        var later = TranscriptModel()
        _ = later.setNextPicks(1, [0])
        later.load(events: [done(1, turn: "t1", needs: "nothing", next: ["Check the nightly"])])
        XCTAssertEqual(card(later, "ak:1")?.pickedNext, [0])
        XCTAssertEqual(Decisions.followUpMessage(["Check the nightly"]), "Check the nightly")
        XCTAssertEqual(Decisions.followUpMessage(["Check the nightly", "Refresh the cache"], extra: " and be quick \n"),
                       "- Check the nightly\n- Refresh the cache\n\nand be quick")
        XCTAssertEqual(Decisions.explainMessage("Check the nightly"), "What do you mean by \"Check the nightly\"? Please explain.")
    }

    /// The runner's loose-ends check (protocol "Loose ends") rides on the
    /// done card it's for, follows the summary, survives a reload, and a
    /// summary decodes it, dropping an end it can't read.
    func testLooseEndsGoOnTheirOwnDoneCard() throws {
        var model = TranscriptModel(events: [done(1, turn: "t1", needs: "nothing")])
        XCTAssertNil(card(model, "ak:1")?.looseEnds, "not checked")
        let open = LooseEnds(seq: 1, ends: [LooseEnd(kind: "unlanded", text: "1 commit on thread/x isn't on main")])
        XCTAssertFalse(model.setLooseEnds(open).isEmpty)
        XCTAssertEqual(card(model, "ak:1")?.looseEnds?.map(\.kind), ["unlanded"])
        XCTAssertTrue(open.anyOpen)
        _ = model.setLooseEnds(LooseEnds(seq: 1, ends: []))
        XCTAssertEqual(card(model, "ak:1")?.looseEnds, [], "checked, nothing left")
        // For another card: this one shows none.
        _ = model.setLooseEnds(LooseEnds(seq: 9, ends: []))
        XCTAssertNil(card(model, "ak:1")?.looseEnds)
        var later = TranscriptModel()
        _ = later.setLooseEnds(open)
        later.load(events: [done(1, turn: "t1", needs: "nothing")])
        XCTAssertEqual(card(later, "ak:1")?.looseEnds?.count, 1)
        XCTAssertFalse(LooseEnds(seq: 1, ends: [LooseEnd(kind: "scheduled", text: "Review the week", at: "2026-11-13T01:30:00Z")]).anyOpen)
        let json = #"{"id":"a","title":"t","cwd":"/","accountId":"c","provider":"claude","permissionMode":"full","status":"idle","live":false,"needsYou":false,"createdAt":"2026-11-07T00:00:00Z","updatedAt":"2026-11-07T00:00:00Z","lastActivityAt":"2026-11-07T00:00:00Z","preview":"","lastSeq":1,"lastSeenSeq":1,"looseEnds":{"seq":1,"at":"2026-11-07T00:00:00Z","ends":[{"kind":"thread","text":"x","threadId":"b"},{"bad":1},{"kind":"later","text":"y"}]}}"#
        let summary = try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.looseEnds?.ends.map(\.kind), ["thread", "later"])
        XCTAssertEqual(summary.looseEnds?.ends.first?.threadId, "b")
    }

    /// A follow-up's "?" toggles like its tick and goes with the ticks:
    /// one question each, or one over a list for several.
    func testFollowUpsAskedAboutGoWithTheTicks() {
        var model = TranscriptModel(events: [done(1, turn: "t1", needs: "nothing", next: ["Check the nightly", "Refresh the cache", "Bump Node"])])
        _ = model.setNextPicks(1, [0], explain: [1, 2])
        XCTAssertEqual(card(model, "ak:1")?.pickedNext, [0])
        XCTAssertEqual(card(model, "ak:1")?.explainNext, [1, 2])
        _ = model.setNextPicks(1, [0], explain: [])
        XCTAssertEqual(card(model, "ak:1")?.explainNext, [])
        var later = TranscriptModel()
        _ = later.setNextPicks(1, [], explain: [0])
        later.load(events: [done(1, turn: "t1", needs: "nothing", next: ["Check the nightly"])])
        XCTAssertEqual(card(later, "ak:1")?.explainNext, [0])
        XCTAssertEqual(Decisions.followUpMessage([], explain: ["Bump Node"]), "What do you mean by \"Bump Node\"? Please explain.")
        XCTAssertEqual(Decisions.followUpMessage(["Check the nightly"], explain: ["Refresh the cache", "Bump Node"], extra: "thanks"),
                       "Check the nightly\n\nWhat do you mean by these? Please explain.\n- Refresh the cache\n- Bump Node\n\nthanks")
    }

    /// The open card is what the composer draws at its top (ComposerCard),
    /// with its picks; Mike's reply takes it out of the composer as well.
    func testTheOpenCardIsTheLastTurnsUntilHeReplies() {
        var model = TranscriptModel(events: [done(1, turn: "t1", needs: "nothing", next: ["Tidy notes"])])
        XCTAssertEqual(model.openCard?.id, "ak:1")
        _ = model.apply([E.event(2, "user.message", ["text": "Tidy notes", "images": []], turn: "t2"), E.event(3, "turn.started", ["turnId": "t2"], turn: "t2"),
                         done(4, turn: "t2", needs: "you", asks: [["action": "Merge?", "options": ["Yes", "No"]]])])
        XCTAssertEqual(model.openCard?.id, "ak:4")
        _ = model.setAskPicks(4, [0: 1])
        guard case .asks(let card)? = model.openCard?.content else { return XCTFail() }
        XCTAssertEqual(card.picks, [0: 1])
        _ = model.apply([E.event(5, "user.message", ["text": "Merge?\nNo", "images": []], turn: "t3")])
        XCTAssertNil(model.openCard)
        // A turn that ends without saying (an older session) has none.
        _ = model.apply([E.event(6, "turn.started", ["turnId": "t3"], turn: "t3"), done(7, turn: "t3")])
        XCTAssertNil(model.openCard)
    }

    /// Another runner's thread read through Convex has the sidebar row for
    /// its summary, with no asks, so its card drew but every pick on it
    /// did nothing (Mike, 6 Nov, a Hetzner thread). The card it shows
    /// fills them in, in its own seq, and takes them away once answered.
    func testARelayedThreadsCardCanBeAnswered() {
        let row = ThreadSummary(id: "t1", title: "On Hetzner", status: .idle)
        XCTAssertFalse(Decisions.isOpen(row), "the row alone can't be answered")

        var model = TranscriptModel(events: [done(9, turn: "t1", needs: "you", asks: [["action": "Start the spike?", "options": ["Start the spike", "Not yet"]]])])
        let open = Decisions.withCard(row, model.openCard)
        XCTAssertTrue(Decisions.isOpen(open))
        XCTAssertEqual(open.asksSeq, 9)
        XCTAssertEqual(open.asks.map(\.action), ["Start the spike?"])
        XCTAssertEqual(Decisions.answers(asks: open.asks, picks: [0: 0]).map(\.answer.answer), ["Start the spike"])

        // Asks ticked off on that runner come ticked (the relay keeps
        // `ticked` on them), so a finished checklist isn't outstanding.
        let checklist = TranscriptModel(events: [done(3, turn: "t1", needs: "you", asks: [["action": "Plug in the drive", "ticked": true], ["action": "Say done"]])])
        guard case .asks(let card)? = checklist.openCard?.content else { return XCTFail() }
        XCTAssertEqual(card.ticked, [0])
        XCTAssertEqual(Decisions.withCard(row, checklist.openCard).asks.map(\.ticked), [true, false])

        // Answered: nothing left to pick.
        _ = model.apply([E.event(10, "user.message", ["text": "Start the spike?\nStart the spike", "images": []], turn: "t2")])
        XCTAssertFalse(Decisions.isOpen(Decisions.withCard(open, model.openCard)))
        // A done card has nothing to answer either.
        let finished = TranscriptModel(events: [done(1, turn: "t1", needs: "nothing", next: ["Tidy notes"])])
        XCTAssertFalse(Decisions.isOpen(Decisions.withCard(row, finished.openCard)))
    }

    /// Sent is answered: the card doesn't wait for the runner to show the
    /// message, which can sit queued for a while. A failed send brings it back.
    func testTheOpenCardGoesOnceHisReplyIsOnItsWay() {
        var model = TranscriptModel(events: [done(1, turn: "t1", needs: "you", asks: [["action": "Merge?", "options": ["Yes", "No"]]])])
        XCTAssertEqual(model.openCard?.id, "ak:1")
        let reply = PendingMessage(text: "Merge?\nYes", answers: [AskAnswer(action: "Merge?", answer: "Yes")], afterSeq: 1, queued: true)
        _ = model.setPending([reply])
        XCTAssertNil(model.openCard)
        _ = model.setPending([])
        XCTAssertEqual(model.openCard?.id, "ak:1")
    }

    func testSummaryDecodesNeedsAndAsks() throws {
        let json = #"{"id":"a","title":"T","needsYou":true,"needs":"you","asksSeq":12,"asks":[{"action":"Paste the key","where":"Settings","reply":"done","ticked":true},{"action":"Pick one"},{"bad":1}]}"#
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
        XCTAssertEqual(thread.needs, "you")
        XCTAssertEqual(thread.asksSeq, 12)
        XCTAssertEqual(thread.asks, [Ask(action: "Paste the key", where_: "Settings", reply: "done", ticked: true), Ask(action: "Pick one")])
        XCTAssertEqual(thread.firstOpenAsk?.action, "Pick one")
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(thread))
        XCTAssertEqual(again.asks, thread.asks)
        XCTAssertEqual(again.needs, "you")
        // An older runner sends none of it.
        let old = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"a","preview":"Last line"}"#.utf8))
        XCTAssertNil(old.needs)
        XCTAssertNil(old.firstOpenAsk)
    }

    func testADoneThreadIsUnreadWithATickNotNeedingYou() {
        var thread = ThreadSummary(id: "t", title: "t", status: .idle, needsYou: false, lastSeq: 9, lastSeenSeq: 4, needs: "nothing")
        XCTAssertEqual(ThreadRowLook(thread), ThreadRowLook(status: .time, unread: true, emphasised: true, done: true))
        XCTAssertEqual(ThreadSections.build([thread], now: Date()).inbox.map(\.id), ["t"])
        thread.lastSeenSeq = 9
        XCTAssertEqual(ThreadRowLook(thread), ThreadRowLook(status: .time, unread: false, emphasised: false))
    }
}
