import AppKit
import XCTest
@testable import Threadbear
import ThreadbearCore

/// `[title](button:<id>)` in a reply draws as a pill in its button's
/// state, and draws again when the state changes.
@MainActor
final class ReplyButtonRenderTests: XCTestCase {
    private func unique() -> String { "t" + UUID().uuidString.prefix(7).lowercased() }

    private func pill(_ text: NSAttributedString) -> (range: NSRange, id: String, look: String?)? {
        var found: (NSRange, String, String?)?
        text.enumerateAttribute(.tbReplyButton, in: NSRange(location: 0, length: text.length)) { value, range, stop in
            guard let id = value as? String else { return }
            found = (range, id, text.attribute(.tbReplyLook, at: range.location, effectiveRange: nil) as? String)
            stop.pointee = true
        }
        return found
    }

    func testAnUnknownButtonIsItsWordsAlone() {
        let text = MarkdownRenderer.render("Do it: [Fill in the form](button:\(unique()))").string
        XCTAssertEqual(text.string, "Do it: Fill in the form")
        XCTAssertNil(pill(text))
        XCTAssertNil(text.attribute(.link, at: text.length - 1, effectiveRange: nil), "not clickable")
    }

    func testAKnownButtonIsAPillThatFollowsItsState() throws {
        let id = unique()
        let store = ReplyButtons.shared
        let button = ReplyButton(id: id, title: "Fill in the form", start: .init(text: "Fill in the replacement form.", cwd: "/Users/mike/dev/me/misc"))
        store.receive(button, threadId: "th1")
        let markdown = "Pebble wants your address. [Fill in the form](button:\(id))"

        let fresh = MarkdownRenderer.render(markdown).string
        let found = try XCTUnwrap(pill(fresh))
        XCTAssertEqual(found.id, id)
        XCTAssertEqual(found.look, "start")
        XCTAssertEqual((fresh.string as NSString).substring(with: found.range), "\u{25B6}\u{FE0E}\u{00A0}Fill\u{00A0}in\u{00A0}the\u{00A0}form")
        XCTAssertEqual(fresh.attribute(.toolTip, at: found.range.location, effectiveRange: nil) as? String,
                       "Starts a thread in misc: Fill in the replacement form.")
        XCTAssertNil(fresh.attribute(.link, at: found.range.location, effectiveRange: nil), "a pill, not a link")

        store.setPressing(id, true)
        XCTAssertEqual(pill(MarkdownRenderer.render(markdown).string)?.look, "pressing", "the block's cache keys on the buttons")
        var pressed = button
        pressed.pressed = .init(at: "2026-11-07T09:00:00Z", threadId: "th_started")
        store.receive(pressed, threadId: "th1")
        store.setPressing(id, false)
        let done = MarkdownRenderer.render(markdown).string
        XCTAssertEqual(pill(done)?.look, "pressed")
        XCTAssertTrue(done.string.hasSuffix("\u{2713}\u{00A0}Fill\u{00A0}in\u{00A0}the\u{00A0}form"))
    }

    func testARowLinkingAButtonRendersAgainWhenItChanges() {
        let id = unique()
        let row = TranscriptRow(id: "a:m1", seq: 3, turnId: "t1", content: .assistant(TextItem(itemId: "m1", text: "[Go](button:\(id))", isStreaming: false)))
        let plain = TranscriptRow(id: "a:m2", seq: 4, turnId: "t1", content: .assistant(TextItem(itemId: "m2", text: "No buttons here", isStreaming: false)))
        let before = RenderCache.key(row, expanded: false, width: 800)
        let plainBefore = RenderCache.key(plain, expanded: false, width: 800)
        ReplyButtons.shared.receive(ReplyButton(id: id, title: "Go", start: .init(text: "Go", cwd: "/tmp")), threadId: "th1")
        XCTAssertNotEqual(RenderCache.key(row, expanded: false, width: 800), before)
        XCTAssertEqual(RenderCache.key(plain, expanded: false, width: 800), plainBefore, "other rows keep their renders")
        XCTAssertTrue(RenderCache.holdsButtons(row))
        XCTAssertFalse(RenderCache.holdsButtons(plain))
    }
}
