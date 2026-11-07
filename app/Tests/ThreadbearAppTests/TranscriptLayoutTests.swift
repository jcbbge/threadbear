import AppKit
import SwiftUI
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// The heights the renderer measures off screen must be the heights the
/// text views lay out, or the last line of a reply gets clipped.
@MainActor
final class TranscriptLayoutTests: XCTestCase {
    static let reply = """
    Here is how the upload pipeline fits together, step by step.

    ## Reading the file

    The app reads the file in **64 KB chunks** so memory stays flat even for large videos. Each chunk is hashed as it goes, which means the final checksum is ready the moment the last byte is read.

    ```swift
    for try await chunk in reader.chunks(of: 65_536) {
        hasher.update(data: chunk)
    }
    ```

    - Retries use exponential backoff starting at 250 ms.
    - A failed chunk is re-sent on its own, not the whole file.
    - Progress is reported per chunk.

    Then the server confirms the checksum and `UploadStore` keeps the state.
    """

    func testMeasuredHeightMatchesTheTextView() {
        for text in [Self.reply, Self.reply + "\n\n- One more\n- And another", "```\ncode first\n```\n\nThen text.", Self.table, Self.table + "\n\nAfter the table."] {
            let rendered = MarkdownRenderer.render(text)
            let measured = TextMeasurer().measure(rendered.string, width: 700)
            let view = TranscriptTextView()
            view.show(rendered.string, width: 700)
            XCTAssertEqual(view.usedHeight, measured.height, "for \(text.prefix(20))")
        }
    }

    static let table = """
    | Case | Before | After |
    | --- | --- | --- |
    | Quit at 60% of 1 GB | 1 GB re-sent | 400 MB re-sent, and a long note that has to wrap inside its own column rather than under the first one |
    | Network drop | Restart | |
    """

    /// Each cell is its own paragraph in a grid: a long cell wraps inside
    /// its column, and the empty last cell still has its place.
    func testATableCellWrapsInsideItsColumn() {
        let rendered = MarkdownRenderer.render(Self.table).string
        let storage = NSTextStorage(attributedString: rendered)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        let note = (rendered.string as NSString).range(of: "400 MB")
        let glyphs = layout.glyphRange(forCharacterRange: NSRange(location: note.location, length: rendered.length - note.location - 30), actualCharacterRange: nil)
        var lefts = Set<CGFloat>()
        layout.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, range, _ in
            if NSLocationInRange(note.location, range) || range.location > note.location { lefts.insert(used.minX) }
        }
        XCTAssertGreaterThan(lefts.min() ?? 0, 100, "the third column's lines all start in the third column")
        let blocks = (rendered.attribute(.paragraphStyle, at: rendered.length - 1, effectiveRange: nil) as? NSParagraphStyle)?.textBlocks
        XCTAssertEqual((blocks?.first as? NSTextTableBlock)?.startingColumn, 2, "the empty last cell is still a cell")
    }

    /// A tall reply draws through a slice whose bounds start part way down
    /// the text. Its text must still start at the view's (0, 0), or the
    /// slice draws the wrong part of the reply.
    func testASlicedReplyKeepsItsTextOriginWhenTheTextIsReplaced() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let document = FlippedDocument(frame: NSRect(x: 0, y: 0, width: 800, height: 20_000))
        scroll.documentView = document
        let text = TranscriptTextView()
        document.addSubview(text)
        let long = MarkdownRenderer.render(Array(repeating: Self.reply, count: 12).joined(separator: "\n\n")).string
        text.show(long, width: 700)
        let height = TextMeasurer().measure(long, width: 700).height
        text.place(NSRect(x: 10, y: 0, width: 700, height: height))
        scroll.contentView.scroll(to: NSPoint(x: 0, y: height - 600))
        text.updateSlice()
        XCTAssertGreaterThan(text.bounds.minY, 0, "drawn through a slice")
        text.replaceTail(from: 0, with: long)
        text.layoutManager?.ensureLayout(for: text.textContainer!)
        XCTAssertEqual(text.textContainerOrigin, .zero)
    }

    /// A failed tool's output stays ordinary text; only the lines that say
    /// what went wrong are red.
    func testFailedOutputMarksOnlyItsErrorLines() {
        let tool = ToolItem(itemId: "c1", call: ToolCall(itemId: "c1", name: "Bash", kind: .command, title: "Build", input: .object(["command": .string("make")])),
                            result: ToolResult(itemId: "c1", ok: false, text: "Building...\nstep 2\nerror: no identity\nfatal: stopped\ndone"))
        let body = RowRenderer.toolBody(tool)
        let string = body.string as NSString
        func colour(of text: String) -> NSColor? {
            body.attribute(.foregroundColor, at: string.range(of: text).location, effectiveRange: nil) as? NSColor
        }
        XCTAssertTrue(body.string.hasSuffix("Building...\nstep 2\nerror: no identity\nfatal: stopped\ndone"))
        XCTAssertEqual(colour(of: "Building"), Theme.quietText)
        XCTAssertEqual(colour(of: "step 2"), Theme.quietText)
        XCTAssertEqual(colour(of: "error: no"), Theme.failed)
        XCTAssertEqual(colour(of: "fatal:"), Theme.failed)
        XCTAssertEqual(colour(of: "done"), Theme.quietText)
    }

    /// Tool input fields put their values in one column after a tab.
    func testFieldsLineUpAfterATab() {
        let text = RowRenderer.fieldsText([.init(key: "owner", value: "mike"), .init(key: "pullNumber", value: "48")])
        XCTAssertEqual(text.string, "owner:\tmike\npullNumber:\t48")
        let style = text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertEqual(style?.tabStops.first?.location, style?.headIndent, "wrapped values hang under the value column")
    }

    /// One reply's answers say what they do, so they're rows: a circle,
    /// the label, "my pick" on the agent's, the note under it, the whole
    /// row the click; in one box, with "Something else…" last (docs/
    /// reply-card-design, A). Asks without notes keep their buttons.
    func testAnswersWithNotesAreRowsInABox() {
        let ask = Ask(action: "Deploy main to production?", options: ["Deploy it", "Hold off"], optionNotes: ["I deploy and check it went out", ""], suggested: 0)
        let text = RowRenderer.asksText(AsksCard(seq: 1, asks: [ask]))
        let string = text.string as NSString
        let deploy = string.range(of: "Deploy it")
        XCTAssertNotEqual(deploy.location, NSNotFound, text.string)
        XCTAssertNil(text.attribute(.tbButton, at: deploy.location, effectiveRange: nil), "a row, not a button")
        var row = NSRange()
        XCTAssertEqual(text.attribute(.tbRow, at: deploy.location, longestEffectiveRange: &row, in: NSRange(location: 0, length: text.length)) as? String, "pick:0:0")
        let note = string.range(of: "I deploy and check it went out")
        XCTAssertTrue(NSLocationInRange(note.location, row), "the note is part of its row")
        XCTAssertLessThan((text.attribute(.font, at: note.location, effectiveRange: nil) as? NSFont)?.pointSize ?? 99, Theme.bodyFont.pointSize)
        XCTAssertTrue(text.string.contains("Deploy it  my pick"), text.string)
        XCTAssertFalse(text.string.contains("Hold off  my pick"), text.string)
        let own = string.range(of: "Something else…")
        XCTAssertEqual(text.attribute(.tbRow, at: own.location, effectiveRange: nil) as? String, "pick:0:-1")
        // One box from the first row to the last, a rule above each row but the first.
        var box = NSRange()
        XCTAssertNotNil(text.attribute(.tbBlockBackground, at: deploy.location, longestEffectiveRange: &box, in: NSRange(location: 0, length: text.length)))
        XCTAssertTrue(NSLocationInRange(own.location, box))
        XCTAssertFalse(NSLocationInRange(string.range(of: "Deploy main").location, box), "the question stays out of it")
        XCTAssertNil(text.attribute(.tbRowRule, at: deploy.location, effectiveRange: nil))
        XCTAssertNotNil(text.attribute(.tbRowRule, at: string.range(of: "Hold off").location, effectiveRange: nil))
        // Plain options stay buttons.
        let plain = RowRenderer.asksText(AsksCard(seq: 2, asks: [Ask(action: "Merge?", options: ["Merge", "Wait"])]))
        XCTAssertNotNil(plain.attribute(.tbButton, at: (plain.string as NSString).range(of: "Merge\u{00A0}").location, effectiveRange: nil) ?? plain.attribute(.tbButton, at: (plain.string as NSString).range(of: "Merge", options: .backwards).location, effectiveRange: nil))
    }

    /// An open card draws each ask the way the agent would have written it
    /// in its message: one paragraph, the why at the body size and colour,
    /// numbered when there are several, its buttons in under the text.
    func testAnAsksWhyIsMessageTextInOneParagraph() {
        let card = AsksCard(seq: 1, asks: [
            Ask(action: "Walk away with your phone", why: "I picked the cutoff, so tell me if it locked.", options: ["It locked", "It didn't"]),
            Ask(action: "Pair the 15 Pro Max when it's back", why: "Only paired phones count, `~/notes.md` says which."),
        ])
        let text = RowRenderer.asksText(card)
        let string = text.string as NSString
        XCTAssertTrue(text.string.contains("1.\tWalk away with your phone. I picked the cutoff, so tell me if it locked."), text.string)
        XCTAssertTrue(text.string.contains("2.\tPair the 15 Pro Max when it's back. Only paired phones count, ~/notes.md says which."), text.string)
        let why = string.range(of: "I picked").location
        XCTAssertEqual((text.attribute(.font, at: why, effectiveRange: nil) as? NSFont)?.pointSize, Theme.bodyFont.pointSize)
        XCTAssertEqual(text.attribute(.foregroundColor, at: why, effectiveRange: nil) as? NSColor, NSColor.labelColor)
        XCTAssertEqual((text.attribute(.font, at: why, effectiveRange: nil) as? NSFont)?.fontDescriptor.symbolicTraits.contains(.bold), false)
        // Wrapped lines and the buttons sit in line with the text, past the number.
        let paragraph = text.attribute(.paragraphStyle, at: why, effectiveRange: nil) as? NSParagraphStyle
        // A button's spaces are no-break ones, so its title stays in one piece.
        let button = text.attribute(.paragraphStyle, at: string.range(of: "It\u{00A0}locked").location, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertGreaterThan(paragraph?.headIndent ?? 0, 0)
        XCTAssertEqual(button?.firstLineHeadIndent, paragraph?.headIndent)
        // One ask: no number.
        let one = RowRenderer.asksText(AsksCard(seq: 2, asks: [Ask(action: "Merge #48?", why: "Checks pass.")])).string
        XCTAssertTrue(one.contains("\nMerge #48? Checks pass."), one)
        // No asks: the done card, Done with Archive on the same line.
        let done = RowRenderer.asksText(AsksCard(seq: 3, asks: []))
        XCTAssertTrue(done.string.contains("Done\t"), done.string)
        XCTAssertFalse(done.string.contains("\n"), "one line: \(done.string)")
        let archive = (done.string as NSString).range(of: "Archive")
        XCTAssertEqual(done.attribute(.tbAction, at: archive.location, effectiveRange: nil) as? String, "archive")
        // Suggested follow-ups: under "Or carry on", each a whole-row click
        // target that ticks it, with its circle; gone once it's closed.
        let next = RowRenderer.asksText(AsksCard(seq: 4, asks: [], next: ["Show Bruce pictures", "Start Bruce threads"]))
        let nextString = next.string as NSString
        let suggestion = nextString.range(of: "Show Bruce pictures")
        XCTAssertNotEqual(suggestion.location, NSNotFound, next.string)
        XCTAssertEqual(next.attribute(.tbAction, at: suggestion.location, effectiveRange: nil) as? String, "next:0")
        var row = NSRange()
        XCTAssertEqual(next.attribute(.tbRow, at: suggestion.location, longestEffectiveRange: &row, in: NSRange(location: 0, length: next.length)) as? String, "next:0")
        XCTAssertEqual(NSMaxRange(row), NSMaxRange(suggestion), "the row is its circle and its own words")
        XCTAssertNotNil(next.attribute(.attachment, at: row.location, effectiveRange: nil), "the tick circle starts the row")
        let heading = nextString.range(of: "Or carry on").location
        XCTAssertLessThan(nextString.range(of: "Archive").location, heading)
        XCTAssertLessThan(heading, suggestion.location)
        // A row, not a button, so a long one wraps, in line with its words.
        XCTAssertNil(next.attribute(.tbButton, at: suggestion.location, effectiveRange: nil))
        let style = next.attribute(.paragraphStyle, at: suggestion.location, effectiveRange: nil) as? NSParagraphStyle
        XCTAssertGreaterThan(style?.headIndent ?? 0, style?.firstLineHeadIndent ?? 0)
        // A ticked one has a different circle from an unticked one.
        let ticked = RowRenderer.asksText(AsksCard(seq: 4, asks: [], next: ["Show Bruce pictures", "Start Bruce threads"], pickedNext: [1]))
        let image = { (text: NSAttributedString, words: String) -> NSImage? in
            var range = NSRange()
            _ = text.attribute(.tbRow, at: (text.string as NSString).range(of: words).location, longestEffectiveRange: &range, in: NSRange(location: 0, length: text.length))
            return (text.attribute(.attachment, at: range.location, effectiveRange: nil) as? NSTextAttachment)?.image
        }
        XCTAssertEqual(image(ticked, "Show Bruce pictures")?.tiffRepresentation, image(next, "Show Bruce pictures")?.tiffRepresentation)
        XCTAssertNotEqual(image(ticked, "Start Bruce threads")?.tiffRepresentation, image(next, "Start Bruce threads")?.tiffRepresentation)
        let start = nextString.range(of: "Start Bruce threads").location
        XCTAssertEqual(next.attribute(.tbRow, at: start, effectiveRange: nil) as? String, "next:1")
        XCTAssertFalse(done.string.contains("carry on"), done.string)
        let closed = RowRenderer.asksText(AsksCard(seq: 4, asks: [], isOpen: false, next: ["Show Bruce pictures"]))
        XCTAssertFalse(closed.string.contains("Bruce"), closed.string)
    }

    /// The open card has a heading saying what's wanted, and a tall one
    /// shows its asks one page at a time, ‹ 2 of 3 › on the heading's line,
    /// each page as tall as the tallest so the composer stays still.
    func testATallAsksCardIsPaged() {
        let why = String(repeating: "This one needs a proper explanation so it wraps over a few lines. ", count: 3)
        let asks = (1...3).map { Ask(action: "Pick number \($0)", why: why, options: ["Yes", "No"]) }
        let row = TranscriptRow(id: "ak:1", seq: 1, turnId: "t1", content: .asks(AsksCard(seq: 1, asks: asks, picks: [0: 0])))
        let heading = RowRenderer.asksText(AsksCard(seq: 1, asks: asks)).string
        XCTAssertTrue(heading.contains("Decisions needed"), heading)
        XCTAssertTrue(RowRenderer.asksText(AsksCard(seq: 1, asks: [Ask(action: "Add the key", why: "Settings.")])).string.contains("Needed from you"))
        let first = ComposerCardHost.render(row, width: 600, page: 0)
        let second = ComposerCardHost.render(row, width: 600, page: 1)
        XCTAssertEqual(first.height, second.height)
        let text = second.text!
        let string = text.string as NSString
        XCTAssertTrue(text.string.contains("2.\tPick number 2"), text.string)
        XCTAssertFalse(text.string.contains("Pick number 1"), text.string)
        XCTAssertFalse(text.string.contains("Pick number 3"), text.string)
        XCTAssertTrue(text.string.contains("2 of 3"), text.string)
        XCTAssertEqual(text.attribute(.tbAction, at: string.range(of: "‹").location, effectiveRange: nil) as? String, "page:0")
        XCTAssertEqual(text.attribute(.tbAction, at: string.range(of: "›").location, effectiveRange: nil) as? String, "page:2")
        // Past the last page, › does nothing.
        let last = ComposerCardHost.render(row, width: 600, page: 2).text!
        XCTAssertNil(last.attribute(.tbAction, at: (last.string as NSString).range(of: "›").location, effectiveRange: nil))
        // A short card stays one list.
        let short = TranscriptRow(id: "ak:2", seq: 2, turnId: "t1", content: .asks(AsksCard(seq: 2, asks: [Ask(action: "Merge?", why: "Checks pass."), Ask(action: "Tag it?", why: "Yes.")])))
        let shortText = ComposerCardHost.render(short, width: 600, page: 1).text!.string
        XCTAssertTrue(shortText.contains("Merge?") && shortText.contains("Tag it?") && !shortText.contains("of 2"), shortText)
    }

    /// Collapsed, a card of asks is its heading alone, with no pager, and
    /// the pager of an open paged card leaves room for the chevron.
    func testACollapsedCardIsItsHeadingAlone() {
        let why = String(repeating: "This one needs a proper explanation so it wraps over a few lines. ", count: 3)
        let asks = (1...3).map { Ask(action: "Pick number \($0)", why: why, options: ["Yes", "No"]) }
        let row = TranscriptRow(id: "ak:1", seq: 1, turnId: "t1", content: .asks(AsksCard(seq: 1, asks: asks)))
        let open = ComposerCardHost.render(row, width: 600, page: 1)
        let collapsed = ComposerCardHost.render(row, width: 600, page: 1, collapsed: true)
        XCTAssertLessThan(collapsed.height, 40)
        XCTAssertGreaterThanOrEqual(collapsed.height, ComposerCardHost.toggleSize)
        XCTAssertLessThan(collapsed.height, open.height)
        XCTAssertTrue(collapsed.text!.string.contains("Decisions needed"), collapsed.text!.string)
        XCTAssertFalse(collapsed.text!.string.contains("Pick number"), collapsed.text!.string)
        XCTAssertFalse(collapsed.text!.string.contains("of 3"), collapsed.text!.string)
        let style = open.text!.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as! NSParagraphStyle
        XCTAssertLessThanOrEqual(style.tabStops[0].location, 600 - ComposerCardHost.toggleSize)
    }

    /// Collapsing belongs to the card: the next one opens.
    func testCollapsingLastsForThatCardOnly() {
        let app = AppModel()
        app.toggleCardCollapsed(threadId: "t", seq: 4)
        XCTAssertEqual(app.collapsedCards["t"], 4)
        // A newer card isn't collapsed by the older one's entry.
        XCTAssertNotEqual(app.collapsedCards["t"], 9)
        app.toggleCardCollapsed(threadId: "t", seq: 4)
        XCTAssertNil(app.collapsedCards["t"])
        app.toggleCardCollapsed(threadId: "t", seq: 4)
        app.toggleCardCollapsed(threadId: "t", seq: 9)
        XCTAssertEqual(app.collapsedCards["t"], 9)
    }

    /// SwiftUI asks the composer's card its size many times a pass, once
    /// per stack it's nested in and for each probe, and a card of asks
    /// built and measured on every one (each page of it, with its symbol
    /// images) froze the app for 5 to 19 seconds a time (5 Nov,
    /// THREADBEAR-X and -Y). The card has to answer them from what it
    /// built last, and build again only when it changes.
    func testTheComposerCardIsBuiltOncePerChangeNotPerSizeQuestion() {
        let why = String(repeating: "This one needs a proper explanation so it wraps over a few lines. ", count: 3)
        let asks = (1...3).map { Ask(action: "Pick number \($0)", why: why, options: ["Yes", "No", "Maybe"], optionNotes: ["Does it", "Doesn't", "Waits"]) }
        let row = TranscriptRow(id: "ak:1", seq: 1, turnId: "t1", content: .asks(AsksCard(seq: 1, asks: asks)))
        let controller = TranscriptController()
        let nested = { (row: TranscriptRow) in
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        ComposerCard(row: row, controller: controller)
                            .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 10)
                        Rectangle().frame(height: 0.5)
                        Text("The message box")
                    }
                    .padding(12)
                }
                .frame(maxWidth: 780)
                .padding(.horizontal, 20)
            }
        }
        let host = NSHostingView(rootView: AnyView(nested(row)))
        host.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        ComposerCardHost.renderCount = 0
        host.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(ComposerCardHost.renderCount, 0)
        XCTAssertLessThanOrEqual(ComposerCardHost.renderCount, 2, "built \(ComposerCardHost.renderCount) times for one layout")
        // Laid out again with nothing changed: nothing to build.
        ComposerCardHost.renderCount = 0
        host.frame.size.height = 640
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(ComposerCardHost.renderCount, 0)
        // A pick changes the card, so it's built again.
        var picked = row
        picked.content = .asks(AsksCard(seq: 1, asks: asks, picks: [0: 1]))
        host.rootView = AnyView(nested(picked))
        host.layoutSubtreeIfNeeded()
        XCTAssertGreaterThan(ComposerCardHost.renderCount, 0)
        XCTAssertLessThanOrEqual(ComposerCardHost.renderCount, 2)
    }

    /// The open card is drawn in the composer (ComposerCard), so its row
    /// in the transcript takes no room.
    func testTheOpenCardTakesNoRoomInTheTranscript() {
        let open = TranscriptRow(id: "ak:1", seq: 1, turnId: "t1", content: .asks(AsksCard(seq: 1, asks: [Ask(action: "Merge?", why: "Checks pass.")])))
        let render = RowRenderer.render(open, expanded: false, tableWidth: 700, measurer: TextMeasurer())
        XCTAssertEqual(render.height, 0)
        XCTAssertNil(render.text)
        let card = ComposerCardHost.render(open, width: 600)
        XCTAssertGreaterThan(card.height, 40)
        XCTAssertTrue(card.text?.string.contains("Merge?") == true)
    }
}

private final class FlippedDocument: NSView {
    override var isFlipped: Bool { true }
}

/// Asks sliding like a deck.
extension TranscriptLayoutTests {
    private func pagedHost() -> (NSWindow, ComposerCardHost, TranscriptController) {
        let why = String(repeating: "This one needs a proper explanation so it wraps over a few lines. ", count: 3)
        let asks = (1...3).map { Ask(action: "Pick number \($0)", why: why, options: ["Yes", "No", "Maybe"], optionNotes: ["Does it", "Doesn't", "Waits"]) }
        let row = TranscriptRow(id: "ak:1", seq: 1, turnId: "t1", content: .asks(AsksCard(seq: 1, asks: asks)))
        let controller = TranscriptController()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = ComposerCardHost(controller: controller)
        host.frame = NSRect(x: 0, y: 0, width: 600, height: 400)
        host.wantsLayer = true
        window.contentView?.addSubview(host)
        host.show(row)
        host.layoutSubtreeIfNeeded()
        return (window, host, controller)
    }

    /// The real card moves to the new page straight away, under the pictures,
    /// so a click lands on it, and it's back once the slide is over.
    func testPagingShowsTheNewPageAtOnceAndSlidesOverIt() async throws {
        let (window, host, controller) = pagedHost()
        defer { window.close(); _ = controller }
        let before = host.subviews.count
        host.showPage(1)
        XCTAssertEqual(host.page, 1)
        XCTAssertEqual(host.subviews.count, before + 1, "the pictures are up")
        // Paging on before it's over goes straight to the page after.
        host.showPage(2)
        XCTAssertEqual(host.page, 2)
        XCTAssertEqual(host.subviews.count, before + 1, "and there's only ever one lot")
        for _ in 0..<200 where host.subviews.count != before { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(host.subviews.count, before, "they've gone")
        XCTAssertTrue(host.subviews.allSatisfy { $0.alphaValue == 1 }, "and the real card is back")
    }

    func testThePageNumberIsFoundInTheHeadingNotInAnAsk() {
        let text = "Decisions needed\t\u{00A0}\u{00A0}\u{00A0}\u{00A0}12 of 13\u{00A0}\u{00A0}\nIs 2 of 3 enough?"
        let range = RowRenderer.pageNumberRange(in: text)
        XCTAssertEqual(range.map { (text as NSString).substring(with: $0) }, "12")
        XCTAssertNil(RowRenderer.pageNumberRange(in: "Is 2 of 3 enough?"))
    }

    func testTheHeadingIsCutAroundTheNumber() {
        let parts = CardDeck.around(NSRect(x: 40, y: 0, width: 10, height: 20), in: NSRect(x: 0, y: 0, width: 100, height: 38))
        XCTAssertEqual(parts, [NSRect(x: 0, y: 0, width: 40, height: 38), NSRect(x: 50, y: 0, width: 50, height: 38)])
        XCTAssertEqual(CardDeck.around(nil, in: NSRect(x: 0, y: 0, width: 100, height: 38)), [NSRect(x: 0, y: 0, width: 100, height: 38)])
    }
}
