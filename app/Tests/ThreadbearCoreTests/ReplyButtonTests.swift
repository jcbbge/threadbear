import XCTest
@testable import ThreadbearCore

/// Reply buttons (docs/protocol.md, "Reply buttons"): the event, keeping
/// the latest snapshot per id, and finding the links in a reply.
final class ReplyButtonTests: XCTestCase {
    private static func start(_ id: String = "b7k2abcd", pressed: Bool = false, failedAt: String? = nil) -> [String: Any] {
        var button: [String: Any] = [
            "id": id, "title": "Fill in the form", "createdAt": "2026-11-07T08:00:00Z", "turnId": "t1",
            "start": ["text": "Fill in the Silver 11 replacement form in my Chrome.", "cwd": "/Users/mike/dev/me/misc",
                      "permissionMode": "full", "effort": "high", "somethingNew": 1],
            "aFieldFromLater": ["x": 1],
        ]
        if pressed { button["pressed"] = ["at": "2026-11-07T09:00:00Z", "threadId": "th_started"] }
        if let failedAt { button["failed"] = ["at": failedAt, "error": "Folder not found: /Users/mike/gone"] }
        return button
    }

    private static func event(_ seq: Int, _ button: [String: Any]) -> Event {
        E.event(seq, "button.updated", ["button": button])
    }

    func testDecodesButtonUpdatedToleratingUnknownFields() throws {
        guard case .buttonUpdated(let button) = Self.event(3, Self.start()).payload else { return XCTFail("not a button.updated") }
        XCTAssertEqual(button.id, "b7k2abcd")
        XCTAssertEqual(button.title, "Fill in the form")
        XCTAssertEqual(button.turnId, "t1")
        XCTAssertEqual(button.start?.cwd, "/Users/mike/dev/me/misc")
        XCTAssertEqual(button.start?.permissionMode, "full")
        XCTAssertNil(button.send)
        XCTAssertNil(button.pressed)

        let send: [String: Any] = ["id": "q9m4wxyz", "title": "Ask that thread", "createdAt": "",
                                   "send": ["threadId": "th_meetup", "threadTitle": "Meetup message", "text": "Post it now"],
                                   "pressed": ["at": "2026-11-07T09:00:00Z", "threadId": "th_meetup"]]
        guard case .buttonUpdated(let sent) = Self.event(4, send).payload else { return XCTFail("not a button.updated") }
        XCTAssertEqual(sent.send?.threadTitle, "Meetup message")
        XCTAssertEqual(sent.pressed?.threadId, "th_meetup")
    }

    func testABrokenButtonIsAnUnknownEventNotAFailure() {
        XCTAssertEqual(Self.event(5, ["title": "no id"]).payload, .unknown)
        XCTAssertEqual(Self.event(5, ["title": "no id"]).seq, 5)
    }

    func testButtonEventsMakeNoRows() {
        let model = TranscriptModel(events: [E.user(1, "brief"), Self.event(2, Self.start()), E.text(3, "m1", "Do it: [Fill in the form](button:b7k2abcd)")])
        XCTAssertEqual(model.rows.map(\.kind), [.user, .assistant])
    }

    /// Made, failed (any number of times), pressed: a snapshot never goes
    /// back, whatever order they arrive in.
    func testLaterStateWinsWhateverOrderSnapshotsArrive() throws {
        let store = ReplyButtons()
        func button(_ fields: [String: Any]) throws -> ReplyButton {
            guard case .buttonUpdated(let b) = Self.event(1, fields).payload else { throw XCTSkip("no button") }
            return b
        }
        let made = try button(Self.start())
        let failed1 = try button(Self.start(failedAt: "2026-11-07T08:30:00Z"))
        let failed2 = try button(Self.start(failedAt: "2026-11-07T08:40:00Z"))
        let pressed = try button(Self.start(pressed: true))

        XCTAssertTrue(store.receive(pressed, threadId: "th1"))
        // The older page's events, folded after the live press.
        XCTAssertFalse(store.fold([Self.event(2, Self.start()), Self.event(3, Self.start(failedAt: "2026-11-07T08:30:00Z"))], threadId: "th1"))
        XCTAssertEqual(store.known("b7k2abcd")?.button.pressed?.threadId, "th_started")
        XCTAssertEqual(store.known("b7k2abcd")?.threadId, "th1")

        let other = ReplyButtons()
        let generation = other.generation
        other.receive(made, threadId: "th1")
        other.receive(failed2, threadId: "th1")
        XCTAssertFalse(other.receive(failed1, threadId: "th1"), "an older failure doesn't replace a newer one")
        XCTAssertFalse(other.receive(made, threadId: "th1"), "nor does the button as made")
        XCTAssertEqual(other.known("b7k2abcd")?.button.failed?.at, "2026-11-07T08:40:00Z")
        XCTAssertTrue(other.receive(pressed, threadId: "th1"))
        XCTAssertEqual(other.generation, generation + 3)
    }

    func testOnePressAtATime() {
        let store = ReplyButtons()
        XCTAssertTrue(store.setPressing("b7k2abcd", true))
        XCTAssertFalse(store.setPressing("b7k2abcd", true), "a second click while the first is out does nothing")
        XCTAssertTrue(store.isPressing("b7k2abcd"))
        XCTAssertTrue(store.setPressing("b7k2abcd", false))
        XCTAssertFalse(store.isPressing("b7k2abcd"))
    }

    func testFindsTheLinksInAReply() {
        let text = "- Pebble wants your address. [Email](https://mail.google.com) [Fill in the form](button:b7k2abcd)\n- The meetup [Ask that thread](button:q9m4wxyz)"
        XCTAssertEqual(ReplyButtons.ids(in: text), ["b7k2abcd", "q9m4wxyz"])
        XCTAssertTrue(ReplyButtons.mayHold(text))
        XCTAssertFalse(ReplyButtons.mayHold("A [thread](thread:5f1c2a90) and button: words"))
        XCTAssertEqual(ReplyButtons.id(of: URL(string: "button:b7k2abcd")!), "b7k2abcd")
        XCTAssertNil(ReplyButtons.id(of: URL(string: "thread:b7k2abcd")!))
        XCTAssertNil(ReplyButtons.id(of: URL(string: "button:")!))
    }

    func testLabelsAndTips() throws {
        guard case .buttonUpdated(var button) = Self.event(1, Self.start()).payload else { return XCTFail() }
        XCTAssertEqual(ReplyButtons.look(button, pressing: false), .start)
        XCTAssertEqual(ReplyButtons.look(button, pressing: true), .pressing)
        XCTAssertEqual(ReplyButtons.label(button, look: .start), "\u{25B6}\u{FE0E} Fill in the form")
        XCTAssertEqual(ReplyButtons.tip(button, look: .start), "Starts a thread in misc: Fill in the Silver 11 replacement form in my Chrome.")

        button.start?.text = String(repeating: "word ", count: 100)
        let tip = ReplyButtons.tip(button, look: .start)
        XCTAssertTrue(tip.hasSuffix("\u{2026}"))
        XCTAssertLessThan(tip.count, 240)

        button.failed = .init(at: "2026-11-07T08:30:00Z", error: "Folder not found")
        XCTAssertEqual(ReplyButtons.look(button, pressing: false), .failed)
        XCTAssertTrue(ReplyButtons.tip(button, look: .failed).hasPrefix("That didn't work: Folder not found. Click to try again."))
        button.pressed = .init(at: "2026-11-07T09:00:00Z", threadId: "th_started")
        XCTAssertEqual(ReplyButtons.look(button, pressing: true), .pressed, "pressed is final")
        XCTAssertEqual(ReplyButtons.label(button, look: .pressed), "\u{2713} Fill in the form")

        let send = ReplyButton(id: "q9m4wxyz", title: "Ask that thread", send: .init(threadId: "th_meetup", threadTitle: "Meetup message", text: "Post the meetup message now"))
        XCTAssertEqual(ReplyButtons.look(send, pressing: false), .send)
        XCTAssertEqual(ReplyButtons.tip(send, look: .send), "Sends to \"Meetup message\": Post the meetup message now")
        XCTAssertTrue(ReplyButtons.label(send, look: .send).hasPrefix("\u{21AA}\u{FE0E} "))
    }
}
