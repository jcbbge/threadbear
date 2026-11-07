import Foundation
import Testing
@testable import ThreadbearKit

/// Reply buttons (docs/protocol.md, "Reply buttons"): a daily brief's
/// `[Fill in the form](button:<id>)` drawn as a button that starts a thread.
@Suite struct ReplyButtonsTests {
    let start = MessageButton(id: "abcd1234", title: "Fill in the form", kind: .start, target: "pebble")

    @Test func aButtonLinkIsATarget() {
        #expect(ThreadLinks.target(of: URL(string: "button:abcd1234")!) == .button("abcd1234"))
        #expect(ThreadLinks.target(of: URL(string: "button:")!) == nil)
    }

    @Test func buttonsAtTheEndOfALineArePeeledOff() {
        let line = "The Pebble form is due Friday. [Fill in the form](button:abcd1234) · [Not now](button:efgh5678)"
        let (text, links) = ReplyButtons.trailing(in: line)
        #expect(text == "The Pebble form is due Friday.")
        #expect(links == [.init(id: "abcd1234", title: "Fill in the form"), .init(id: "efgh5678", title: "Not now")])
    }

    @Test func aButtonWithWordsAfterItStaysInTheText() {
        let line = "Press [Go](button:abcd1234) when you're ready."
        #expect(ReplyButtons.trailing(in: line).links.isEmpty)
        #expect(ReplyButtons.trailing(in: "No buttons here.").text == "No buttons here.")
    }

    @Test func aButtonTheRowDoesNotCarryIsItsTitle() {
        let text = "[Go](button:abcd1234) and [Old](button:zzzz0000) and [web](https://x.y)"
        #expect(ReplyButtons.unlinking(text, except: ["abcd1234"]) == "[Go](button:abcd1234) and Old and [web](https://x.y)")
        #expect(ReplyButtons.unlinking(text, except: []) == "Go and Old and [web](https://x.y)")
    }

    @Test func aPressShowsAsPressingThenPressed() {
        #expect(ReplyButtons.look(start, status: nil, asking: false) == .ready)
        #expect(ReplyButtons.look(start, status: nil, asking: true) == .pressing)
        #expect(ReplyButtons.look(start, status: CommandStatus(state: .taken), asking: false) == .pressing)
        #expect(ReplyButtons.look(start, status: CommandStatus(state: .done, threadId: "t2"), asking: false) == .pressed(threadId: "t2"))
    }

    @Test func theRowSayingPressedWinsAndAFailureCanBePressedAgain() {
        var pressed = start
        pressed.pressedThreadId = "t3"
        #expect(ReplyButtons.look(pressed, status: CommandStatus(state: .failed, note: "x"), asking: false) == .pressed(threadId: "t3"))
        #expect(ReplyButtons.look(start, status: CommandStatus(state: .failed, note: "Folder not found"), asking: false) == .failed("Folder not found"))
        var failed = start
        failed.failed = "gone"
        #expect(ReplyButtons.look(failed, status: nil, asking: false) == .failed("gone"))
    }

    @Test func aRowDecodesItsButtonsAndAnOldRowHasNone() throws {
        let json = #"{"seq":4.0,"role":"assistant","text":"x","buttons":[{"id":"abcd1234","title":"Go","kind":"send","target":"Meetup","pressedThreadId":"t9"}],"at":"2026-11-07T00:00:00.000Z"}"#
        let m = try JSONDecoder().decode(PhoneMessage.self, from: Data(json.utf8))
        #expect(m.buttons == [MessageButton(id: "abcd1234", title: "Go", kind: .send, target: "Meetup", pressedThreadId: "t9")])
        let old = try JSONDecoder().decode(PhoneMessage.self, from: Data(#"{"seq":4,"role":"assistant","text":"x","at":"2026-11-07T00:00:00.000Z"}"#.utf8))
        #expect(old.buttons == nil)
    }
}
