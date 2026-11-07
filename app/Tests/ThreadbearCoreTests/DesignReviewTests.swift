import XCTest
@testable import ThreadbearCore

final class DesignReviewTests: XCTestCase {
    private static var sample: [String: Any] { [
        "id": "review-1", "title": "Account picker", "status": "pending", "revision": 1,
        "createdAt": "2026-10-27T10:00:00Z", "updatedAt": "2026-10-27T10:00:00Z",
        "options": [
            ["id": "A", "title": "Auto account", "image": ["path": "/tmp/a.png", "mediaType": "image/png", "width": 2200, "height": 1520]],
            ["id": "B", "title": "One picker", "image": ["path": "/tmp/b.png", "mediaType": "image/png"]],
            ["id": "D", "title": "Moving mid-thread", "reference": true, "image": ["path": "/tmp/d.png", "mediaType": "image/png"]],
        ],
        "draft": ["notes": [:]],
    ] }

    private static func event(_ seq: Int, revision: Int = 1, status: String = "pending", draft: [String: Any] = ["notes": [:]]) -> Event {
        var review = sample
        review["revision"] = revision
        review["status"] = status
        review["draft"] = draft
        if status == "answered" { review["response"] = draft }
        return E.event(seq, "review.updated", ["review": review])
    }

    func testReviewCardNeverFoldsIntoToolsAndUpdatesInPlace() {
        var model = TranscriptModel(events: [E.call(1, "c1"), E.call(2, "c2"), Self.event(3), E.call(4, "c3"), E.call(5, "c4")])
        XCTAssertEqual(model.rows.map(\.id), ["g:t:c1", "review:review-1", "g:t:c3"])
        let oldVersion = model.row(id: "review:review-1")?.version
        let change = model.apply([Self.event(6, revision: 2, status: "answered", draft: ["pickedId": "B", "notes": ["D": "Keep this behaviour"]])])
        XCTAssertTrue(change.inserted.isEmpty)
        XCTAssertFalse(change.updated.isEmpty)
        XCTAssertNotEqual(oldVersion, model.row(id: "review:review-1")?.version)
        guard case .review(let review)? = model.row(id: "review:review-1")?.content else { return XCTFail("review card missing") }
        XCTAssertEqual(review.response?.pickedId, "B")
        XCTAssertEqual(review.response?.notes["D"], "Keep this behaviour")
        XCTAssertFalse(review.isPending)
        XCTAssertEqual(model.sourceSeqs(of: "review:review-1"), [3, 6])
    }

    func testLatestSnapshotWorksWhenCreationIsOnOlderPage() {
        var model = TranscriptModel(events: [Self.event(20, revision: 3, status: "answered", draft: ["notes": ["A": "Try a wider menu"]]), E.done(21)])
        XCTAssertEqual(model.rows.filter { $0.kind == .review }.count, 1)
        model.prepend(olderEvents: [Self.event(2), E.call(3, "c1"), Self.event(4, revision: 2), E.text(5, "answer", "Review when ready")])
        let reviews = model.rows.filter { $0.kind == .review }
        XCTAssertEqual(reviews.count, 1)
        XCTAssertEqual(reviews.first?.seq, 2)
        guard case .review(let review)? = reviews.first?.content else { return XCTFail() }
        XCTAssertEqual(review.revision, 3)
        XCTAssertEqual(review.status, "answered")
        XCTAssertEqual(review.response?.notes["A"], "Try a wider menu")
        let rebuilt = TranscriptModel(events: model.events)
        XCTAssertEqual(rebuilt.items.map(\.content), model.items.map(\.content))
    }

    func testUnknownStatusIsReadOnlyAndFutureFieldsSurviveDecode() throws {
        var object = Self.sample
        object["status"] = "superseded"
        object["futureField"] = true
        let review = try JSONDecoder().decode(DesignReview.self, from: Data(E.json(object).utf8))
        XCTAssertFalse(review.isPending)
        XCTAssertEqual(review.status, "superseded")
        XCTAssertEqual(review.options.map(\.id), ["A", "B", "D"])
        XCTAssertEqual(review.options.first?.image.width, 2200)
        XCTAssertTrue(review.options.last?.reference == true)
        XCTAssertEqual(try JSONDecoder().decode(DesignReview.self, from: JSONEncoder().encode(review)), review)
    }

    func testDraftResponseAllowsNotesWithoutAPickAndRejectsReferencePick() throws {
        let review = try JSONDecoder().decode(DesignReview.self, from: Data(E.json(Self.sample).utf8))
        XCTAssertFalse(ReviewDraft().canSubmit(options: review.options))
        XCTAssertFalse(ReviewDraft(notes: ["A": " \n "]).canSubmit(options: review.options))
        XCTAssertTrue(ReviewDraft(notes: ["D": "Works with every option"]).canSubmit(options: review.options))
        XCTAssertTrue(ReviewDraft(pickedId: "B").canSubmit(options: review.options))
        XCTAssertFalse(ReviewDraft(pickedId: "D").canSubmit(options: review.options))
        XCTAssertFalse(ReviewDraft(pickedId: "missing").canSubmit(options: review.options))
        XCTAssertFalse(ReviewDraft(notes: ["missing": "Note"]).canSubmit(options: review.options))
        XCTAssertFalse(ReviewDraft(notes: ["A": String(repeating: "x", count: 4001)]).canSubmit(options: review.options))
    }

    func testPendingCountAndReviewMessageFieldsAreTolerated() throws {
        let summary = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"t","pendingReviews":2,"needsYou":true}"#.utf8))
        XCTAssertEqual(summary.pendingReviews, 2)
        XCTAssertTrue(summary.needsYou)
        let older = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"old"}"#.utf8))
        XCTAssertNil(older.pendingReviews)
        let again = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(summary))
        XCTAssertEqual(again.pendingReviews, 2)
        let message = E.event(1, "user.message", ["text": "Picked B", "images": [], "reviewId": "review-1", "reviewResponse": ["pickedId": "B", "notes": [:]]])
        let model = TranscriptModel(events: [message])
        XCTAssertEqual(RowDebug.text(model.rows[0]), "Picked B")
    }

    func testPendingReviewWaitsForTheThreadToFinishWorking() {
        let now = Date()
        let tests = [BackgroundTask(kind: .agent, description: "Running tests")]
        for (status, background) in [(ThreadStatus.running, [BackgroundTask]()), (.starting, []), (.idle, tests)] {
            let thread = ThreadSummary(id: "reviewing", title: "Choose a design", status: status,
                                       needsYou: false, background: background, pendingReviews: 1)
            let sections = ThreadSections.build([thread], now: now)
            XCTAssertEqual(sections.running.map(\.id), [thread.id], "\(status): still working, so not in the inbox yet")
            XCTAssertTrue(sections.needsYou.isEmpty)
            XCTAssertNotEqual(ThreadRowLook(thread, section: .running).status, .needsYou)
            XCTAssertNil(DockBadge.label(for: [thread], now: now))
        }
    }

    func testPendingReviewNeedsAttentionEvenWhenRead() {
        let now = Date()
        for status in [ThreadStatus.idle, .error, .stopped] {
            let thread = ThreadSummary(id: "reviewing", title: "Choose a design", status: status,
                                       needsYou: false, lastSeq: 20, lastSeenSeq: 20, pendingReviews: 2)
            let sections = ThreadSections.build([thread], now: now)
            XCTAssertEqual(sections.needsYou.map(\.id), [thread.id], "\(status): a review is still waiting after mark-read")
            XCTAssertTrue(sections.running.isEmpty)
            XCTAssertEqual(ThreadSections.urgency(thread), 0)
            XCTAssertEqual(ThreadRowLook(thread, section: .inbox),
                           ThreadRowLook(status: .needsYou, unread: true, emphasised: true, labelled: true))
            XCTAssertEqual(DockBadge.label(for: [thread], now: now), "1", "the badge counts threads, not pending reviews")
        }
        let archived = ThreadSummary(id: "archived", title: "Archived review", archivedAt: now, pendingReviews: 1)
        let snoozed = ThreadSummary(id: "snoozed", title: "Later review", snoozedUntil: now.addingTimeInterval(60), pendingReviews: 1)
        XCTAssertTrue(ThreadSections.build([archived, snoozed], now: now).needsYou.isEmpty)
        XCTAssertNil(DockBadge.label(for: [archived, snoozed], now: now))
    }

    func testRPCHelpersCarryReviewIDsRevisionsAndDraftTogether() async throws {
        let transport = FakeTransport()
        transport.onSend = { request in
            [E.json(["jsonrpc": "2.0", "id": request["id"]!, "result": ["review": Self.sample, "reviews": [Self.sample], "turnId": "reply-turn"]])]
        }
        let client = RPCClient(transport: transport)
        try await client.start()
        let draft = ReviewDraft(notes: ["D": "Works for all options"])
        _ = try await client.review(threadId: "thread", reviewId: "review-1")
        _ = try await client.saveReview(threadId: "thread", reviewId: "review-1", revision: 1, draft: draft)
        let reply = try await client.respondReview(threadId: "thread", reviewId: "review-1", revision: 2, draft: draft)
        _ = try await client.cancelReview(threadId: "thread", reviewId: "review-1", revision: 3)
        let pending = try await client.pendingReviews(threadId: "thread")
        XCTAssertEqual(pending.map(\.id), ["review-1"])
        XCTAssertEqual(reply.turnId, "reply-turn")
        XCTAssertEqual(transport.sent.compactMap { $0["method"] as? String }, ["reviews.get", "reviews.save", "reviews.respond", "reviews.cancel", "reviews.list"])
        XCTAssertEqual((transport.sent[4]["params"] as? [String: String])?["threadId"], "thread")
        let params = transport.sent[2]["params"] as! [String: Any]
        XCTAssertEqual(params["threadId"] as? String, "thread")
        XCTAssertEqual(params["reviewId"] as? String, "review-1")
        XCTAssertEqual(params["revision"] as? Int, 2)
        XCTAssertEqual((params["draft"] as? [String: Any])?["notes"] as? [String: String], draft.notes)
        XCTAssertNil((params["draft"] as? [String: Any])?["pickedId"])
    }

    // MARK: Mike's answer in his bubble

    private static let id = "74d1e391-cbc6-4b23-bd6b-cfed7cb79488"

    func testReviewReplyShowsThePickNotTheId() {
        let text = "Review: End of turn: summary + what's next (\(Self.id))\n\nPicked A. A: summary is the agent's last message."
        let reply = ReviewAnswer.parse(text, reviewId: Self.id, response: ReviewDraft(pickedId: "A"))
        XCTAssertEqual(reply?.lines, [.init(label: "End of turn: summary + what's next", text: "Picked A: summary is the agent's last message")])
    }

    func testReviewReplyNotesKeepTheirWordsAndOrder() {
        let text = "Review: Picker (r1)\n\nPicked B. One picker.\n\nNotes on A (Auto (smart)): Too clever.\n\nWith a gap): there\n\nNotes on B (One picker): Ship it"
        let reply = ReviewAnswer.parse(text, reviewId: "r1", response: ReviewDraft(pickedId: "B", notes: ["B": "Ship it", "A": "Too clever.\n\nWith a gap): there"]))
        XCTAssertEqual(reply?.lines, [
            .init(label: "Picker", text: "Picked B: One picker"),
            .init(label: "Notes on A: Auto (smart)", text: "Too clever.\n\nWith a gap): there"),
            .init(label: "Notes on B: One picker", text: "Ship it"),
        ])
    }

    func testReviewReplyWithOnlyNotesPutsTheTitleOverThem() {
        let reply = ReviewAnswer.parse("Review: Picker (r1)\n\nNotes on D (Moving): Keep this", reviewId: "r1", response: ReviewDraft(notes: ["D": "Keep this"]))
        XCTAssertEqual(reply?.lines, [.init(label: "Picker\nNotes on D: Moving", text: "Keep this")])
    }

    func testReviewReplyInOtherWordsIsLeftAlone() {
        let draft = ReviewDraft(pickedId: "A")
        XCTAssertNil(ReviewAnswer.parse("Picked A. Thing.", reviewId: "r1", response: draft))
        XCTAssertNil(ReviewAnswer.parse("Review: Picker (r1)\n\nPicked B. Thing.", reviewId: "r1", response: draft))
        XCTAssertNil(ReviewAnswer.parse("Review: Picker (r1)\n\nPicked A. Thing.", reviewId: nil, response: draft))
        XCTAssertNil(ReviewAnswer.parse("Review: Picker (r1)\n\nPicked A. Thing.\n\nNotes on B (X): y", reviewId: "r1", response: draft))
    }

    // The runner's wording for several picks, none, and a reply (reviewReply).
    func testReviewReplyWithSeveralPicksAndAReply() {
        let text = "Review: Diagrams (r1)\n\nPicked A + D. Entity board + Sandbox.\n\nThe board for the app.\n\nThe sandbox for the video."
        let reply = ReviewAnswer.parse(text, reviewId: "r1", response: ReviewDraft(pickedIds: ["A", "D"], reply: "The board for the app.\n\nThe sandbox for the video."))
        XCTAssertEqual(reply?.lines, [
            .init(label: "Diagrams", text: "Picked A + D: Entity board + Sandbox"),
            .init(label: "", text: "The board for the app.\n\nThe sandbox for the video."),
        ])
    }

    func testReviewReplyWithNoneOrOnlyWords() {
        let none = ReviewAnswer.parse("Review: Diagrams (r1)\n\nPicked none of them.", reviewId: "r1", response: ReviewDraft(none: true))
        XCTAssertEqual(none?.lines, [.init(label: "Diagrams", text: "None of them")])
        let words = ReviewAnswer.parse("Review: Diagrams (r1)\n\nWhat are these for?", reviewId: "r1", response: ReviewDraft(reply: "What are these for?"))
        XCTAssertEqual(words?.lines, [.init(label: "Diagrams", text: "What are these for?")])
    }

    func testADraftWithSeveralPicksRoundTripsAndOneStaysAsItWas() throws {
        let several = ReviewDraft(pickedIds: ["A", "D"], reply: "Both", none: false)
        XCTAssertEqual(try JSONDecoder().decode(ReviewDraft.self, from: JSONEncoder().encode(several)), several)
        let one = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"pickedId":"B","notes":{}}"#.utf8))
        XCTAssertEqual(one.pickedIds, ["B"], "a runner from before several picks")
        let options = ["A", "B"].map { ReviewOption(id: $0, title: $0, image: ImageRef(path: "/\($0).png", mediaType: "image/png")) }
        XCTAssertFalse(ReviewDraft(pickedIds: ["A"], none: true).canSubmit(options: options), "picks or none, not both")
        XCTAssertTrue(ReviewDraft(reply: "Hmm").canSubmit(options: options))
        XCTAssertFalse(ReviewDraft(reply: "  ").canSubmit(options: options))
    }

    func testOptionShotsDecodeAndOneImageIsOneShot() throws {
        let json = #"{"id":"A","title":"Board","image":{"path":"/a.png","mediaType":"image/png"},"shots":[{"image":{"path":"/a.png","mediaType":"image/png"}},{"title":"Mid-drag","image":{"path":"/a2.png","mediaType":"image/png"}}],"url":"http://localhost:5190"}"#
        let option = try JSONDecoder().decode(ReviewOption.self, from: Data(json.utf8))
        XCTAssertEqual(option.allShots.map(\.title), [nil, "Mid-drag"])
        XCTAssertEqual(option.url, "http://localhost:5190")
        let plain = try JSONDecoder().decode(ReviewOption.self, from: Data(#"{"id":"B","title":"B","image":{"path":"/b.png","mediaType":"image/png"}}"#.utf8))
        XCTAssertEqual(plain.allShots.map(\.image.path), ["/b.png"])
    }

    func testAShotCanBeAVideoOrAPageWithItsStill() throws {
        let json = #"{"id":"A","title":"Clips","image":{"path":"/a.png","mediaType":"image/png"},"shots":[{"image":{"path":"/a.png","mediaType":"image/png"},"media":{"path":"/a.mp4","mediaType":"video/mp4","width":1280,"height":720}},{"image":{"path":"/p.png","mediaType":"image/png"},"media":{"path":"/p/index.html","mediaType":"text/html"}},{"image":{"path":"/s.png","mediaType":"image/png"}}]}"#
        let shots = try JSONDecoder().decode(ReviewOption.self, from: Data(json.utf8)).allShots
        XCTAssertEqual(shots.map(\.video?.path), ["/a.mp4", nil, nil])
        XCTAssertEqual(shots.map(\.page?.path), [nil, "/p/index.html", nil])
        XCTAssertEqual(shots.map(\.image.path), ["/a.png", "/p.png", "/s.png"], "the still stays the image, for thumbnails")
    }

    func testReviewReplyEventReachesTheBubble() {
        let text = "Review: Picker (r1)\n\nPicked A. Auto account."
        let event = E.event(4, "user.message", ["text": text, "images": [], "reviewId": "r1", "reviewResponse": ["pickedId": "A", "notes": [:]]])
        let model = TranscriptModel(events: [event])
        guard case .user(let message)? = model.rows.first?.content else { return XCTFail("no bubble") }
        XCTAssertEqual(message.text, text)
        XCTAssertEqual(message.review?.lines, [.init(label: "Picker", text: "Picked A: Auto account")])
    }

    // MARK: How the images share the stage

    func testPhonesGoInOneRowSoTheyAreAsBigAsCanBe() {
        let phones = Array(repeating: 940.0 / 1800.0, count: 3)
        let layout = ReviewGalleryLayout.best(aspects: phones, width: 1200, height: 900, spacing: 12)
        XCTAssertEqual(layout.columns, 3)
        XCTAssertEqual(layout.rows, 1)
    }

    func testWideMockupsGoInTwoRows() {
        let wide = Array(repeating: 2200.0 / 1520.0, count: 4)
        let layout = ReviewGalleryLayout.best(aspects: wide, width: 1200, height: 900, spacing: 12)
        XCTAssertEqual(layout.columns, 2)
        XCTAssertEqual(layout.rows, 2)
    }

    func testOneImageGetsTheWholeStage() {
        let layout = ReviewGalleryLayout.best(aspects: [1.5], width: 1200, height: 900, spacing: 12)
        XCTAssertEqual(layout.columns, 1)
        XCTAssertEqual(layout.cellWidth, 1200)
        XCTAssertEqual(layout.cellHeight, 900)
    }

    func testAStageWithNoRoomYetDoesntGoNegative() {
        let layout = ReviewGalleryLayout.best(aspects: [1, 1], width: 0, height: 0, spacing: 12, chromeWidth: 16, chromeHeight: 36)
        XCTAssertEqual(layout.cellWidth, 0)
        XCTAssertEqual(layout.cellHeight, 0)
    }

    func testFitKeepsTheImagesShape() {
        let tall = ReviewGalleryLayout.fit(aspect: 0.5, width: 400, height: 400)
        XCTAssertEqual(tall.width, 200)
        XCTAssertEqual(tall.height, 400)
        let wide = ReviewGalleryLayout.fit(aspect: 2, width: 400, height: 400)
        XCTAssertEqual(wide.width, 400)
        XCTAssertEqual(wide.height, 200)
    }
}
