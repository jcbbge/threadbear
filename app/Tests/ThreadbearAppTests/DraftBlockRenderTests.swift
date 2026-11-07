import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// ```slack, ```email and ```draft blocks in replies: a box with a header
/// (DraftBlockCell) and every line of the draft kept as its own line.
@MainActor
final class DraftBlockRenderTests: XCTestCase {
    private func header(_ text: NSAttributedString) -> (DraftBlockCell, NSRange)? {
        var found: (DraftBlockCell, NSRange)?
        text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, range, stop in
            if let cell = (value as? NSTextAttachment)?.attachmentCell as? DraftBlockCell { found = (cell, range); stop.pointee = true }
        }
        return found
    }

    func testASlackDraftKeepsItsLinesAndDrawsItsFormatting() throws {
        let text = MarkdownRenderer.render("Here's the post:\n\n```slack\n*Threadbear, 6 Nov*\n• one <https://x.dev|link>\n• two\n```\n\nPost it?").string
        let (cell, range) = try XCTUnwrap(header(text))
        XCTAssertEqual(cell.draft.kind, .slack)
        let string = text.string as NSString
        // One paragraph per line: the bullets don't run together.
        XCTAssertTrue(text.string.contains("Threadbear, 6 Nov\n• one link\n• two\n"), text.string)
        let bold = string.range(of: "Threadbear, 6 Nov")
        let font = try XCTUnwrap(text.attribute(.font, at: bold.location, effectiveRange: nil) as? NSFont)
        XCTAssertTrue(font.fontDescriptor.symbolicTraits.contains(.bold))
        let link = string.range(of: "link")
        XCTAssertEqual((text.attribute(.link, at: link.location, effectiveRange: nil) as? URL)?.absoluteString, "https://x.dev")
        // The box runs from the header to the last line, and no further.
        var box = NSRange()
        XCTAssertNotNil(text.attribute(.tbBlockBackground, at: range.location, longestEffectiveRange: &box, in: NSRange(location: 0, length: text.length)))
        XCTAssertTrue(NSLocationInRange(string.range(of: "• two").location, box))
        XCTAssertFalse(NSLocationInRange(string.range(of: "Post it?").location, box))
        XCTAssertEqual(text.attribute(.tbCopyText, at: range.location, effectiveRange: nil) as? String, "")
    }

    func testAnEmailDraftLinksBareAddressesAndKeepsBlankLines() throws {
        let text = MarkdownRenderer.render("```email\nHi Sam,\n\nSee https://x.dev/a for *this*.\n\nMike\n```").string
        XCTAssertNotNil(header(text))
        XCTAssertTrue(text.string.contains("Hi Sam,\n\nSee https://x.dev/a for *this*.\n\nMike"), text.string)
        let at = (text.string as NSString).range(of: "https://x.dev/a").location
        XCTAssertEqual((text.attribute(.link, at: at, effectiveRange: nil) as? URL)?.absoluteString, "https://x.dev/a")
    }

    func testAFenceStillStreamingInStaysCode() {
        XCTAssertNil(header(MarkdownRenderer.render("```slack\n• one\n• tw").string))
        XCTAssertNil(header(MarkdownRenderer.render("```text\n• one\n```").string))
        // Cross-lab review, 6 Nov: a closing line has to match the opening one.
        XCTAssertNil(header(MarkdownRenderer.render("```slack\nhello\n~~~").string))
        XCTAssertNil(header(MarkdownRenderer.render("````slack\nhello\n```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("````slack\nhello\n`````").string))
        // Code that only looks like a closing fence.
        XCTAssertNil(header(MarkdownRenderer.render("```slack\nhello\n> ```").string))
    }

    func testAQuotedOrCRLFDraftIsStillADraft() {
        XCTAssertNotNil(header(MarkdownRenderer.render("> ```slack\n> hello\n> ```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("Here:\r\n\r\n```slack\r\nhello\r\n```\r\n").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("- ```slack\n  hello\n  ```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("```slack\none\u{2028}two\n```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("> - ```slack\n>   héllo\n>   ```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("  ```slack\n  hello\n```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("1. ```slack\n   hello\n   ```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render(">```slack\n>hello\n>```").string))
        XCTAssertNotNil(header(MarkdownRenderer.render("- parent\n  - child\n\n    ```slack\n    hello\n    ```").string))
    }

    func testCopyPutsPlainTextAndHTMLOnTheClipboardAndSaysCopied() throws {
        let cell = DraftBlockCell(draft: DraftBlock(kind: .slack, source: "*Hi* <https://x.dev|there> \(UUID())"))
        let board = NSPasteboard(name: NSPasteboard.Name("DraftBlockRenderTests-\(UUID())"))
        XCTAssertFalse(cell.wasJustCopied())
        cell.copyDraft(to: board)
        XCTAssertTrue(cell.wasJustCopied())
        XCTAssertFalse(cell.wasJustCopied(now: Date().addingTimeInterval(DraftBlockCell.copiedFor + 0.1)))
        XCTAssertTrue(try XCTUnwrap(board.string(forType: .string)).hasPrefix("*Hi* there (https://x.dev) "))
        XCTAssertTrue(try XCTUnwrap(board.string(forType: .html)).contains("<b>Hi</b> <a href=\"https://x.dev\">there</a>"))
        board.releaseGlobally()

        let frame = NSRect(x: 0, y: 0, width: 500, height: DraftBlockCell.height)
        let button = cell.button(in: frame)
        XCTAssertTrue(cell.isButton(at: NSPoint(x: button.midX, y: button.midY), in: frame))
        XCTAssertFalse(cell.isButton(at: NSPoint(x: 10, y: frame.midY), in: frame))
    }

    /// The click itself, through the text view: Copy once called NSCell's
    /// own copy() and crashed the app (7 Nov).
    func testClickingCopyInTheTranscriptCopiesTheDraft() throws {
        let board = NSPasteboard(name: NSPasteboard.Name("DraftBlockRenderTests-\(UUID())"))
        DraftBlockCell.pasteboard = board
        addTeardownBlock { DraftBlockCell.pasteboard = .general; board.releaseGlobally() }
        let source = "*Hi* <https://x.dev|there> \(UUID())"
        let view = TranscriptTextView(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        view.show(MarkdownRenderer.render("Draft:\n\n```slack\n\(source)\n```").string, width: 500)
        let storage = try XCTUnwrap(view.textStorage)
        let index = (storage.string as NSString).range(of: "\u{FFFC}").location
        XCTAssertNotEqual(index, NSNotFound)
        let layout = try XCTUnwrap(view.layoutManager)
        let glyph = layout.glyphIndexForCharacter(at: index)
        let line = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        // Inside the header's line, at its right-hand end where Copy is.
        let point = NSPoint(x: view.textContainerOrigin.x + line.maxX - 30, y: view.textContainerOrigin.y + line.maxY - DraftBlockCell.height / 2)
        let header = try XCTUnwrap(view.draftHeader(at: point))
        XCTAssertTrue(header.cell.isButton(at: point, in: header.frame))
        let click = try XCTUnwrap(NSEvent.mouseEvent(with: .leftMouseDown, location: view.convert(point, to: nil), modifierFlags: [], timestamp: 0,
                                                     windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
        view.mouseDown(with: click)
        XCTAssertEqual(board.string(forType: .string), "*Hi* there (https://x.dev) " + source.components(separatedBy: " ").last!)
        XCTAssertTrue(header.cell.wasJustCopied())
        // And says so: the green-tick bubble, just above the button.
        let bubble = try XCTUnwrap(view.subviews.first { $0 is CopiedBubble })
        let button = header.cell.button(in: header.frame)
        XCTAssertLessThanOrEqual(bubble.frame.maxY, button.minY)
        XCTAssertEqual(bubble.frame.midX, button.midX, accuracy: bubble.frame.width)
        if let out = ProcessInfo.processInfo.environment["DRAFT_SHOT"], let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
        }
    }
}
