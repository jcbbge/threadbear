import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// ⌘= and ⌘-: every size comes from TypeScale, scaled by the zoom.
@MainActor
final class TextZoomTests: XCTestCase {
    override func tearDown() {
        TextZoom.shared.reset()
        super.tearDown()
    }

    func testDesignSizesStandAtDefault() {
        TextZoom.shared.reset()
        XCTAssertEqual(TypeScale.body, 15)
        XCTAssertEqual(TypeScale.codeLine, 19.5)
        XCTAssertEqual(Theme.bodyFont.pointSize, 15)
        XCTAssertEqual(RowMetrics.workHeight, 32)
        XCTAssertEqual(ComposerTextField.lineHeight, 23)
    }

    func testStepsScaleEverySizeToWholePoints() {
        let zoom = TextZoom.shared
        zoom.zoomIn()
        XCTAssertEqual(zoom.percent, 110)
        XCTAssertEqual(TypeScale.body, 17) // 16.5 rounded
        XCTAssertEqual(TypeScale.bodyLine, 25)
        XCTAssertEqual(TypeScale.codeLine, 21)
        XCTAssertEqual(Theme.bodyFont.pointSize, 17)
        XCTAssertEqual(Theme.italicFont.pointSize, 17)
        XCTAssertEqual(RowMetrics.workHeight, 35)
        XCTAssertEqual(ComposerTextField.lineHeight, 25)
        XCTAssertEqual(ComposerTextField.font.pointSize, 17)
        zoom.zoomOut()
        zoom.zoomOut()
        XCTAssertEqual(zoom.percent, 90)
        XCTAssertEqual(TypeScale.body, 14) // 13.5 rounded
        zoom.reset()
        XCTAssertEqual(TypeScale.body, 15)
    }

    /// Like a browser's zoom: icons, paddings and the column grow with the
    /// text, not just the text.
    func testLayoutSizesZoomWithTheText() {
        let zoom = TextZoom.shared
        zoom.reset()
        XCTAssertEqual(zoomed(16), 16)
        XCTAssertEqual(ActivityBar.width, 44)
        XCTAssertEqual(SidebarMetrics.leading, 18)
        XCTAssertEqual(Theme.maxContentWidth, 780)
        zoom.set(200)
        XCTAssertEqual(zoomed(16), 32)
        XCTAssertEqual(ActivityBar.width, 88)
        XCTAssertEqual(SidebarMetrics.leading, 36)
        XCTAssertEqual(Theme.maxContentWidth, 1560)
        XCTAssertEqual(RowMetrics.bubblePadH, 28)
        XCTAssertEqual(RowMetrics.workHeight, 64)
        zoom.set(110)
        XCTAssertEqual(zoomed(18), 20) // 19.8 rounded
    }

    func testStopsAtTheEnds() {
        let zoom = TextZoom.shared
        for _ in 0..<20 { zoom.zoomIn() }
        XCTAssertEqual(zoom.percent, TextZoom.steps.last)
        XCTAssertFalse(zoom.canZoomIn)
        XCTAssertTrue(zoom.canZoomOut)
        for _ in 0..<20 { zoom.zoomOut() }
        XCTAssertEqual(zoom.percent, TextZoom.steps.first)
        XCTAssertFalse(zoom.canZoomOut)
    }

    func testRendersAreKeyedByZoomAndGrowWithIt() {
        let zoom = TextZoom.shared
        zoom.reset()
        let row = TranscriptRow(id: "r1", version: 1, seq: 1, content: .assistant(TextItem(itemId: "a1", text: "Hello there, a line of **markdown**.", isStreaming: false)))
        let cache = RenderCache()
        let before = cache.render(row, expanded: false, width: 800)
        let keyBefore = RenderCache.key(row, expanded: false, width: 800)
        zoom.set(160)
        XCTAssertNotEqual(RenderCache.key(row, expanded: false, width: 800), keyBefore)
        let after = cache.render(row, expanded: false, width: 800)
        XCTAssertGreaterThan(after.height, before.height)
        XCTAssertEqual((after.text?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize, 24)
    }

    func testZoomChangeRestylesTheComposer() {
        let zoom = TextZoom.shared
        zoom.reset()
        let composer = ComposerTextField.makeTextView()
        composer.replaceText("Some words")
        zoom.set(140)
        composer.applyTypeScale()
        XCTAssertEqual(composer.font?.pointSize, 21)
        let font = composer.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        XCTAssertEqual(font?.pointSize, 21)
        let style = composer.typingAttributes[.paragraphStyle] as? NSParagraphStyle
        XCTAssertEqual(style?.minimumLineHeight, 32)
    }
}

/// The composer used to be built with no text storage, so typing did nothing.
final class ComposerTests: XCTestCase {
    /// Stands in for whatever's above the box and takes Esc (a SwiftUI
    /// onExitCommand, a panel).
    private final class EscapeCatcher: NSView {
        var caught = 0
        override func cancelOperation(_ sender: Any?) { caught += 1 }
    }

    private func pressEscape(on composer: NSTextView) throws {
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                                   windowNumber: composer.window?.windowNumber ?? 0, context: nil, characters: "\u{1b}",
                                                   charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
        composer.keyDown(with: event)
    }

    private func composerInWindow() -> (NSWindow, EscapeCatcher, ComposerTextView) {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let parent = EscapeCatcher(frame: window.contentLayoutRect)
        window.contentView = parent
        let composer = ComposerTextField.makeTextView()
        composer.frame = parent.bounds
        parent.addSubview(composer)
        window.makeFirstResponder(composer)
        return (window, parent, composer)
    }

    /// NSTextView has no cancelOperation:, so calling super on it threw and
    /// the app died (THREADBEAR-K): Esc with no message being edited.
    func testEscapeWithNothingToCancelDoesNotThrow() throws {
        let (window, parent, composer) = composerInWindow()
        composer.onEscape = { false }
        try pressEscape(on: composer)
        XCTAssertEqual(parent.caught, 1, "Esc the box doesn't want goes on up, to whatever's above it")
        window.close()
    }

    /// With no `onEscape` at all: every Something else box on a card.
    func testEscapeInAnAnswerBoxDoesNotThrow() throws {
        let (window, parent, composer) = composerInWindow()
        composer.onEscape = nil
        composer.cancelOperation(nil)
        XCTAssertEqual(parent.caught, 1)
        window.close()
    }

    /// And with nothing above that wants it: no throw, and no complaint.
    func testEscapeWithNothingAboveIsQuiet() {
        _ = NSApplication.shared
        let composer = ComposerTextField.makeTextView()
        composer.cancelOperation(nil)
    }

    func testEscapeLeavingAnEditStopsAtTheBox() throws {
        let (window, parent, composer) = composerInWindow()
        var left = 0
        composer.onEscape = { left += 1; return true }
        try pressEscape(on: composer)
        XCTAssertEqual(left, 1)
        XCTAssertEqual(parent.caught, 0)
        window.close()
    }

    func testComposerKeepsWhatIsTyped() {
        let composer = ComposerTextView()
        XCTAssertNotNil(composer.textStorage)
        XCTAssertNotNil(composer.layoutManager)
        composer.string = "Hello there"
        XCTAssertEqual(composer.string, "Hello there")
        composer.insertText("!", replacementRange: NSRange(location: composer.string.utf16.count, length: 0))
        XCTAssertEqual(composer.string, "Hello there!")
    }

    /// A file that isn't a picture (a video, a folder) goes in as its full
    /// path where it's pasted or dropped, not turned away (3 Nov).
    func testOtherFilesGoInAsTheirPaths() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("composer-files-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let video = folder.appendingPathComponent("Screen Recording 1.mov")
        try Data("not really a movie".utf8).write(to: video)

        let composer = ComposerTextView()
        composer.replaceText("look at")
        composer.setSelectedRange(NSRange(location: 7, length: 0))
        let board = NSPasteboard(name: NSPasteboard.Name("composer-files-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([video as NSURL, folder as NSURL])

        XCTAssertTrue(composer.takeImages(from: board))
        let expected = "look at `\(video.standardizedFileURL.path)` `\(folder.standardizedFileURL.path)` "
        XCTAssertEqual(composer.string, expected)
        XCTAssertEqual(composer.selectedRange().location, (expected as NSString).length)

        // Plain words on the clipboard are still a normal paste.
        board.clearContents()
        board.setString("hello", forType: .string)
        XCTAssertFalse(composer.takeImages(from: board))
    }

    /// Dropping a video on the box is taken (a copy), and its path lands
    /// in the words. A plain text view turned it away before (3 Nov).
    func testDroppingAVideoPutsItsPathIn() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("composer-drop-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let video = folder.appendingPathComponent("clip.mp4")
        try Data("not really a movie".utf8).write(to: video)

        let (window, _, composer) = composerInWindow()
        defer { window.close() }
        let board = NSPasteboard(name: NSPasteboard.Name("composer-drop-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([video as NSURL])
        let drag = FakeDrag(pasteboard: board, window: window, location: composer.convert(NSPoint(x: 5, y: 5), to: nil))

        XCTAssertEqual(composer.draggingEntered(drag), .copy)
        XCTAssertEqual(composer.draggingUpdated(drag), .copy)
        XCTAssertTrue(composer.performDragOperation(drag))
        XCTAssertEqual(composer.string, "`\(video.standardizedFileURL.path)` ")
    }

    /// Letting a file go anywhere over the thread gives it to the composer,
    /// as only the box took it before (Jamie Turner, 6 Nov).
    @MainActor func testAFileDroppedOnTheTranscriptGoesToTheComposer() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("transcript-drop-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let video = folder.appendingPathComponent("clip.mp4")
        try Data("not really a movie".utf8).write(to: video)
        let board = NSPasteboard(name: NSPasteboard.Name("transcript-drop-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([video as NSURL])

        let (window, parent, composer) = composerInWindow()
        defer { window.close() }
        let handle = ComposerHandle()
        let controller = TranscriptController()
        let host = TranscriptHost(controller: controller, ghost: false)
        host.frame = parent.bounds
        parent.addSubview(host)
        XCTAssertTrue(host.registeredDraggedTypes.contains(.fileURL))
        let outside = FakeDrag(pasteboard: board, window: window, location: .zero)

        // No composer (a sub-agent's transcript): nowhere for it to go.
        XCTAssertEqual(host.draggingEntered(outside), [])
        XCTAssertFalse(host.performDragOperation(outside))

        handle.textView = composer
        controller.composerHandle = handle
        // A file being dragged out of the app, let go back over the thread, stays out.
        let fromThisApp = FakeDrag(pasteboard: board, window: window, location: .zero, source: FileDrag.Source.shared)
        XCTAssertEqual(host.draggingEntered(fromThisApp), [])
        XCTAssertFalse(host.performDragOperation(fromThisApp))
        XCTAssertEqual(composer.string, "")

        XCTAssertEqual(host.draggingEntered(outside), .copy)
        XCTAssertEqual(host.draggingUpdated(outside), .copy)
        XCTAssertEqual(host.subviews.count, 2, "the mark shows over the transcript")
        XCTAssertTrue(host.performDragOperation(outside))
        XCTAssertEqual(host.subviews.count, 1, "and goes with the drop")
        XCTAssertEqual(composer.string, "`\(video.standardizedFileURL.path)` ")
        XCTAssertTrue(window.firstResponder === composer)

        // Words dragged in aren't files, so they aren't for the thread.
        board.clearContents()
        board.setString("hello", forType: .string)
        XCTAssertEqual(host.draggingEntered(outside), [])
    }

    /// A thread dragged out of the sidebar and let go over the open thread
    /// goes into its message as the thread's chip, as pasting its id does
    /// (Mike, 6 Nov). The drag starts in this app, unlike a file's.
    @MainActor func testAThreadDroppedOnTheTranscriptGoesInAsItsChip() throws {
        let id = "th_drag_\(UUID().uuidString.prefix(6))"
        AppModel.shared.threads[id] = ThreadSummary(id: id, title: "Fix the sidebar", accountId: "claude-main")
        defer { AppModel.shared.threads[id] = nil }
        let board = NSPasteboard(name: NSPasteboard.Name("thread-drop-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.setString(id, forType: .string)

        let (window, parent, composer) = composerInWindow()
        defer { window.close() }
        composer.string = "Look at "
        composer.setSelectedRange(NSRange(location: 8, length: 0))
        let handle = ComposerHandle()
        handle.textView = composer
        let controller = TranscriptController()
        controller.composerHandle = handle
        let host = TranscriptHost(controller: controller, ghost: false)
        host.frame = parent.bounds
        parent.addSubview(host)
        XCTAssertTrue(host.registeredDraggedTypes.contains(.string))

        let drag = FakeDrag(pasteboard: board, window: window, location: .zero, source: ThreadDrag.Source(ended: {}))
        XCTAssertEqual(host.draggingEntered(drag), .copy)
        XCTAssertTrue(host.performDragOperation(drag))
        XCTAssertEqual(composer.draftNow.text, "Look at [Fix the sidebar](thread:\(id))")
        XCTAssertTrue(window.firstResponder === composer)

        // An id of a thread this Mac doesn't know is only words.
        board.clearContents()
        board.setString("th_nobody", forType: .string)
        XCTAssertEqual(host.draggingEntered(drag), [])
    }

    /// Nothing in a transcript row signs up for drags, or a file let go over
    /// it would stop there and never reach the transcript. A row's icon (an
    /// NSImageView) did.
    @MainActor func testTranscriptRowsLeaveDropsToTheTranscript() {
        XCTAssertTrue(Symbols.makeView().registeredDraggedTypes.isEmpty, "a row's icon")
        XCTAssertTrue(BackgroundRowCell(frame: .zero).bear.registeredDraggedTypes.isEmpty, "the background-work bear")
        let text = TranscriptTextView()
        text.isEditable = false
        XCTAssertTrue(text.registeredDraggedTypes.isEmpty, "a row's words")
    }

    /// A picture dropped from a temp folder goes to the runner as a copy, as
    /// a screenshot thumbnail's file is deleted as the drop ends (issue #2).
    func testAPictureFromATempFolderIsKept() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("composer-thumb-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let shot = folder.appendingPathComponent("Screenshot.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: shot)

        let composer = ComposerTextView()
        var delivered: [URL] = []
        composer.onImages = { delivered = $0 }
        let board = NSPasteboard(name: NSPasteboard.Name("composer-thumb-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([shot as NSURL])

        XCTAssertTrue(composer.takeImages(from: board))
        let kept = try XCTUnwrap(delivered.first)
        defer { try? FileManager.default.removeItem(at: kept.deletingLastPathComponent()) }
        XCTAssertEqual(kept.lastPathComponent, "Screenshot.png")
        XCTAssertNotEqual(kept.standardizedFileURL, shot.standardizedFileURL)
        try FileManager.default.removeItem(at: shot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
    }

    /// A photo copied in Photos goes in as its image data, even with another
    /// file copied alongside it, which goes in as usual.
    func testAPhotosLibraryPhotoUsesItsImageData() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("composer-photos-\(UUID().uuidString.prefix(6))", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let other = folder.appendingPathComponent("other.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: other)
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])

        let photo = NSPasteboardItem()
        photo.setString(URL(fileURLWithPath: "/Users/me/Pictures/Photos Library.photoslibrary/resources/ABC.jpeg").absoluteString, forType: .fileURL)
        photo.setData(jpeg, forType: NSPasteboard.PasteboardType("public.jpeg"))
        let plain = NSPasteboardItem()
        plain.setString(other.absoluteString, forType: .fileURL)

        let composer = ComposerTextView()
        var delivered: [URL] = []
        composer.onImages = { delivered = $0 }
        let board = NSPasteboard(name: NSPasteboard.Name("composer-photos-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects([photo, plain])

        XCTAssertTrue(composer.takeImages(from: board))
        XCTAssertEqual(delivered.map(\.lastPathComponent), ["ABC.jpeg", "other.png"])
        defer { delivered.forEach { try? FileManager.default.removeItem(at: $0.deletingLastPathComponent()) } }
        XCTAssertEqual(try Data(contentsOf: delivered[0]), jpeg)
    }

    /// The box is two lines tall when empty, grows a line at a time, and
    /// stops at ten lines (the rest scrolls).
    func testComposerGrowsFromTwoLinesToTen() throws {
        let composer = ComposerTextField.makeTextView()
        composer.frame = NSRect(x: 0, y: 0, width: 400, height: 40)
        // The transcript's body line height, so a sent message keeps its rhythm.
        let line = ComposerTextField.lineHeight
        XCTAssertEqual(line, TypeScale.bodyLine)
        func lines(_ count: Int) -> String { (1...count).map { "Line \($0)" }.joined(separator: "\n") }

        composer.replaceText("")
        XCTAssertEqual(ComposerTextField.fittingHeight(of: composer), ceil(line * 2))
        composer.replaceText("One line")
        XCTAssertEqual(ComposerTextField.fittingHeight(of: composer), ceil(line * 2))
        composer.replaceText(lines(4))
        XCTAssertEqual(ComposerTextField.fittingHeight(of: composer), ceil(line * 4), accuracy: 1)
        composer.replaceText(lines(30))
        XCTAssertEqual(ComposerTextField.fittingHeight(of: composer), ceil(line * 10))
    }
}

final class QuestionAnswerTests: XCTestCase {
    let colour = Question(question: "Which colour?", options: [QuestionOption(label: "Blue"), QuestionOption(label: "Green")])
    let size = Question(question: "Which size?", options: [QuestionOption(label: "S"), QuestionOption(label: "L")])

    func testTypedTextReplacesASingleChoice() {
        let request = QuestionRequest(approvalId: "q1", questions: [colour])
        let answers = QuestionRowCell.answers(for: request, chosen: [0: ["Green"]], typed: "Something purple")
        XCTAssertEqual(answers, ["Which colour?": "Something purple"])
    }

    func testTypedTextJoinsMultipleChoices() {
        var multi = colour
        multi.multiSelect = true
        let request = QuestionRequest(approvalId: "q1", questions: [multi])
        let answers = QuestionRowCell.answers(for: request, chosen: [0: ["Blue", "Green"]], typed: "and purple")
        XCTAssertEqual(answers, ["Which colour?": "Blue, Green, and purple"])
    }

    func testTypedTextOnlyAnswersTheLastQuestion() {
        let request = QuestionRequest(approvalId: "q1", questions: [colour, size])
        let answers = QuestionRowCell.answers(for: request, chosen: [:], typed: "Medium")
        XCTAssertEqual(answers, ["Which size?": "Medium"])
    }
}

/// Incremental measuring while a reply streams must give exactly the height
/// a full measure would, or rows would be clipped or padded.
final class StreamingMeasureTests: XCTestCase {
    func testIncrementalHeightsMatchFullMeasure() {
        let source = """
        Here is how the upload pipeline fits together, step by step.

        ## Reading the file

        The app reads the file in **64 KB chunks** so memory stays flat even for large videos. Each chunk is hashed as it goes.

        ```swift
        for try await chunk in reader.chunks(of: 65_536) {
            hasher.update(data: chunk)
        }
        ```

        - Retries use exponential backoff starting at 250 ms.
        - A failed chunk is re-sent on its own, not the whole file.

        Then the server confirms the checksum and `UploadStore` keeps the state.
        """
        let measurer = StreamingMeasurer()
        let full = TextMeasurer()
        var length = 0
        var steps = 0
        while length < source.count {
            length = min(source.count, length + 2 + steps % 11)
            steps += 1
            let rendered = MarkdownRenderer.render(String(source.prefix(length)))
            let incremental = measurer.measure(rowId: "a:m1", rendered, width: 640)
            let whole = full.measure(rendered.string, width: 640)
            XCTAssertEqual(incremental, whole, "at \(length) characters")
        }
        // A different width or row starts again from scratch.
        let rendered = MarkdownRenderer.render(source)
        XCTAssertEqual(measurer.measure(rowId: "a:m1", rendered, width: 400), full.measure(rendered.string, width: 400))
        XCTAssertEqual(measurer.measure(rowId: "a:m2", rendered, width: 400), full.measure(rendered.string, width: 400))
    }
}

final class RenderCacheTests: XCTestCase {
    func streaming(_ text: String, version: Int, streaming: Bool = true) -> TranscriptRow {
        TranscriptRow(id: "a:live", version: version, seq: 1, content: .assistant(TextItem(itemId: "live", text: text, isStreaming: streaming)))
    }

    /// Each streaming flush is a new version; only the newest is kept, so a
    /// long reply doesn't push every other render out of the cache.
    func testOnlyTheNewestVersionOfAStreamingRowIsKept() {
        let cache = RenderCache()
        let first = streaming("Hel", version: 1_000_001)
        let second = streaming("Hello", version: 1_000_002)
        _ = cache.render(first, expanded: false, width: 900)
        XCTAssertNotNil(cache.cached(first, expanded: false, width: 900))
        _ = cache.render(second, expanded: false, width: 900)
        XCTAssertNil(cache.cached(first, expanded: false, width: 900))
        XCTAssertNotNil(cache.cached(second, expanded: false, width: 900))
        let done = streaming("Hello!", version: 1_000_003, streaming: false)
        _ = cache.render(done, expanded: false, width: 900)
        XCTAssertNil(cache.cached(second, expanded: false, width: 900))
        XCTAssertNotNil(cache.cached(done, expanded: false, width: 900))
    }

    /// Renders depend on the reading column's width, so two table widths
    /// with the column at its widest share them (a legacy scroller showing
    /// or not, a sidebar drag).
    func testTableWidthsWithTheSameColumnShareRenders() {
        let cache = RenderCache()
        let row = TranscriptRow(id: "u:1", version: 2_000_001, seq: 1, content: .user(UserMessage(text: "Hi")))
        _ = cache.render(row, expanded: false, width: 982)
        XCTAssertNotNil(cache.cached(row, expanded: false, width: 965))
        XCTAssertNil(cache.cached(row, expanded: false, width: 600))
    }
}

/// Tall text draws through a slice around what's on screen instead of one
/// layer the height of the whole text.
@MainActor
final class SlicedTextTests: XCTestCase {
    func testTallTextOnlyDrawsAroundTheVisiblePart() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let document = FlippedView(frame: NSRect(x: 0, y: 0, width: 800, height: 20_000))
        scroll.documentView = document
        let text = TranscriptTextView()
        document.addSubview(text)
        text.show(NSAttributedString(string: String(repeating: "line\n", count: 1000)), width: 700)
        text.place(NSRect(x: 10, y: 100, width: 700, height: 15_000))
        // At the top: a slice from the text's top, not 15,000 pt.
        XCTAssertLessThanOrEqual(text.frame.height, 600 * 2.5)
        XCTAssertEqual(text.bounds.minY, 0)
        XCTAssertEqual(text.fullFrame.height, 15_000)
        // Scrolled far down, the slice follows and text coordinates stay put.
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 8_000))
        text.updateSlice()
        XCTAssertLessThanOrEqual(text.frame.height, 600 * 2.5)
        XCTAssertLessThanOrEqual(text.frame.minY, 8_000)
        XCTAssertGreaterThanOrEqual(text.frame.maxY, 8_600)
        XCTAssertEqual(text.frame.minY - text.fullFrame.minY, text.bounds.minY, "bounds origin is the slice's offset into the text")
        // Small moves inside the slice don't redraw it.
        let before = text.frame
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 8_050))
        text.updateSlice()
        XCTAssertEqual(text.frame, before)
        // Parked off screen it holds no drawing; placing it back restores it.
        text.park()
        XCTAssertEqual(text.frame.height, 0)
        text.updateSlice(force: true)
        XCTAssertGreaterThan(text.frame.height, 600)
    }

    func testShortTextIsNotSliced() {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let document = FlippedView(frame: NSRect(x: 0, y: 0, width: 800, height: 2_000))
        scroll.documentView = document
        let text = TranscriptTextView()
        document.addSubview(text)
        text.place(NSRect(x: 10, y: 100, width: 700, height: 500))
        XCTAssertEqual(text.frame, NSRect(x: 10, y: 100, width: 700, height: 500))
        XCTAssertEqual(text.bounds.origin, .zero)
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// AppModel keeps a message that wasn't sent.
@MainActor
final class DraftTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // AppModel reads NSApp in places.
        _ = NSApplication.shared
    }

    func testSendingWhileDisconnectedKeepsTheDraft() {
        let app = AppModel()
        app.drafts["th1"] = Draft(text: "This message matters", images: [ImageRef(path: "/tmp/a.png", mediaType: "image/png")])
        app.send(threadId: "th1")
        XCTAssertEqual(app.drafts["th1"]?.text, "This message matters")
        XCTAssertEqual(app.drafts["th1"]?.images.count, 1)
        XCTAssertNotNil(app.errorMessage)
    }

    func testAFailedSendPutsTheDraftBack() async throws {
        let app = AppModel()
        let transport = RefusingTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        app.useClientForTesting(client)
        app.drafts["th1"] = Draft(text: "Keep me")
        app.send(threadId: "th1")
        XCTAssertNil(app.drafts["th1"], "the box empties straight away")
        for _ in 0..<200 where app.drafts["th1"] == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(app.drafts["th1"]?.text, "Keep me")
        XCTAssertEqual(app.errorMessage, "Busy")
    }

    /// The folder, "Ask before edits" and a picked account were for the
    /// one thread; the model and effort are what the next thread starts on
    /// too, and survive a relaunch. The account used becomes the last-used
    /// one, which the next pick starts from.
    func testNewThreadSettingsAfterCreatingOne() async throws {
        defer {
            UserDefaults.standard.removeObject(forKey: AppModel.lastModelKey)
            UserDefaults.standard.removeObject(forKey: AppModel.lastEffortKey)
            UserDefaults.standard.removeObject(forKey: AppModel.lastAccountKey)
        }
        let app = AppModel()
        let transport = RefusingTransport()
        transport.createdThread = true
        let client = RPCClient(transport: transport)
        try await client.start()
        app.useClientForTesting(client)
        app.newThreadCwd = "/tmp/somewhere"
        app.newThreadModel = "haiku"
        app.newThreadEffort = "low"
        app.newThreadPermission = .ask
        app.newThreadAccount = "claude-3"
        app.drafts["new"] = Draft(text: "Start something")
        app.send(threadId: nil)
        for _ in 0..<200 where app.selection == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(app.selection, "th_new")
        XCTAssertNil(app.newThreadCwd)
        XCTAssertEqual(app.newThreadPermission, .full)
        XCTAssertNil(app.newThreadAccount, "a picked account is for that draft only")
        XCTAssertEqual(app.lastAccountId, "claude-3")
        XCTAssertEqual(app.newThreadAccountId, "claude-3", "with no usage known, the last-used one")
        XCTAssertEqual(app.newThreadModel, "haiku", "the model sticks")
        XCTAssertEqual(app.newThreadEffort, "low", "the effort sticks")
        XCTAssertEqual(AppModel().newThreadModel, "haiku", "and is remembered across launches")
        XCTAssertEqual(AppModel().newThreadEffort, "low")
        // Picking on an open thread is a pick too; the default row clears it.
        app.setEffort("th_new", "max")
        app.setModel("th_new", nil)
        XCTAssertEqual(AppModel().newThreadEffort, "max")
        XCTAssertNil(AppModel().newThreadModel)
    }

    /// A Codex pick doesn't become the next Claude thread's model, and the
    /// composer follows the account with the most room until one is picked.
    func testModelMemoryIsPerProviderAndTheAccountFollowsUsage() {
        defer {
            for key in [AppModel.lastModelKey, AppModel.lastEffortKey, AppModel.lastAccountKey, "lastModel.codex", "lastEffort.codex"] {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
        let app = AppModel()
        func room(_ percent: Double) -> AccountUsage {
            AccountUsage(windows: [UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: percent),
                                   UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 90)])
        }
        app.accounts = [
            Account(id: "claude-main", title: "a@x", usage: room(40)),
            Account(id: "claude-3", title: "b@x", usage: room(70)),
            Account(id: "codex-main", provider: "codex", title: "Codex · a@x", usage: room(99)),
        ]
        UserDefaults.standard.set("claude-main", forKey: AppModel.lastAccountKey)
        XCTAssertEqual(app.newThreadAccountId, "claude-3", "most room, same provider")
        app.remember(model: "sonnet", provider: "claude")
        app.remember(model: "gpt-6-luna", provider: "codex")
        app.remember(effort: "ultra", provider: "codex")
        XCTAssertEqual(app.newThreadModel, "sonnet")
        XCTAssertNil(app.newThreadEffort)
        app.newThreadAccount = "codex-main"
        XCTAssertEqual(app.newThreadModel, "gpt-6-luna")
        XCTAssertEqual(app.newThreadEffort, "ultra")
        XCTAssertEqual(AppModel().lastModels, ["claude": "sonnet", "codex": "gpt-6-luna"], "kept across launches")
        // Usage moves: the default moves with it until Mike picks one.
        app.newThreadAccount = nil
        app.accounts[1].usage = room(20)
        XCTAssertEqual(app.newThreadAccountId, "claude-main")
    }
}

/// Answers threads.send with a busy error, and threads.create with a thread.
private final class RefusingTransport: RPCTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    var createdThread = false

    func open() async throws {}

    func send(_ text: String) async throws {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let id = object["id"] as? Int, let method = object["method"] as? String else { return }
        let reply: [String: Any]
        if method == "threads.create" && createdThread {
            reply = ["jsonrpc": "2.0", "id": id, "result": ["thread": ["id": "th_new", "title": "Start something"]]]
        } else {
            reply = ["jsonrpc": "2.0", "id": id, "error": ["code": -32020, "message": "Busy"]]
        }
        push(try JSONSerialization.data(withJSONObject: reply))
    }

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !inbox.isEmpty {
                let data = inbox.removeFirst()
                lock.unlock()
                continuation.resume(returning: data)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func close() {}

    private func push(_ data: Data) {
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(returning: data)
        } else {
            inbox.append(data)
            lock.unlock()
        }
    }
}

/// The runner restart in the window: a quiet banner while it waits, a quiet
/// "Reconnecting" while it's down, then nothing.
@MainActor
final class RestartBannerTests: XCTestCase {
    override func setUp() {
        super.setUp()
        _ = NSApplication.shared
    }

    func testPendingThenRestartingThenBack() {
        let app = AppModel()
        app.connection = .connected
        XCTAssertNil(app.banner)
        app.noticeForTesting("The runner will restart when 2 threads finish.")
        XCTAssertEqual(app.banner, Banner(style: .quiet, icon: "arrow.clockwise", text: "The runner will restart when 2 threads finish."))
        XCTAssertNil(app.errorMessage, "a restart notice isn't an error")
        app.threads["a"] = ThreadSummary(id: "a", title: "Fix the build", status: .running)
        app.restartStatusForTesting(PendingRestart(waitingFor: ["a"]))
        XCTAssertEqual(app.banner?.text, "The runner will restart when 1 thread finishes.")
        XCTAssertEqual(app.banner?.detail, "Waiting for Fix the build")
        app.noticeForTesting("The runner is restarting now.")
        XCTAssertEqual(app.banner?.text, "The runner is restarting now.")
        XCTAssertNil(app.banner?.icon, "a spinner")
        app.connectionLostForTesting()
        XCTAssertEqual(app.banner, Banner(style: .quiet, icon: nil, text: "The runner is restarting. Reconnecting…"))
        // Failed attempts while it's down are part of the restart too.
        app.connection = .runnerDown("refused")
        XCTAssertEqual(app.banner?.style, .quiet)
    }

    func testAPlainDropIsStillAWarning() {
        let app = AppModel()
        app.connectionLostForTesting()
        XCTAssertEqual(app.banner?.style, .warning)
        XCTAssertEqual(app.banner?.text, "Lost the connection to the runner. Reconnecting…")
        app.noticeForTesting(level: "warning", "Release X kept crashing at startup, so the runner went back to Y.")
        XCTAssertEqual(app.errorMessage, "Release X kept crashing at startup, so the runner went back to Y.")
    }

    /// "Start runner" kickstarts the installed runner's LaunchAgent: never
    /// from an app pointed at the mock or a dev runner.
    func testStartRunnerOnlyForTheRealDataFolder() {
        let app = AppModel()
        app.dataDir = RunnerConfig.defaultDataDir
        app.connection = .runnerDown("refused")
        XCTAssertEqual(app.banner?.showStart, true)
        app.dataDir = URL(fileURLWithPath: "/tmp/tb-mock-xyz", isDirectory: true)
        XCTAssertEqual(app.banner?.showStart, false)
        XCTAssertEqual(app.banner?.showRetry, true)
    }

    /// A scripted run's copies go to its own pasteboard, never Mike's.
    func testCopiesGoToTheAppsPasteboard() {
        let app = AppModel()
        let board = NSPasteboard(name: NSPasteboard.Name("com.mikerosoft.threadbear.test.\(UUID().uuidString)"))
        app.pasteboard = board
        app.copyToPasteboard("th_123")
        XCTAssertEqual(board.string(forType: .string), "th_123")
        board.releaseGlobally()
    }
}

/// The resume the runner sends after a restart is a centred note, not a
/// bubble of Mike's.
final class RunnerMessageRenderTests: XCTestCase {
    func testRunnerMessageRendersAsANote() throws {
        let row = TranscriptRow(id: "u:8", version: 3_000_001, seq: 8, content: .user(UserMessage(text: "Check that your change works.", origin: "runner")))
        let render = RowRenderer.render(row, expanded: false, tableWidth: 900, measurer: TextMeasurer())
        let text = try XCTUnwrap(render.text?.string)
        XCTAssertEqual(text, "Sent by the runner after it restarted\nCheck that your change works.")
        let style = try XCTUnwrap(render.text?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        XCTAssertEqual(style.alignment, .center)
        // Shorter than the same words in a bubble, which has the turn's gap above.
        let bubble = RowRenderer.render(TranscriptRow(id: "u:9", version: 3_000_002, seq: 9, content: .user(UserMessage(text: "Check that your change works."))),
                                        expanded: false, tableWidth: 900, measurer: TextMeasurer())
        XCTAssertLessThan(render.height, bubble.height)
    }
}

#if DEBUG
final class AutomationTests: XCTestCase {
    /// Each dev-app instance has its own channel, so commands never reach
    /// another instance (or the installed app).
    @MainActor
    func testChannelsAndLogPaths() {
        XCTAssertEqual(Automation.channel(id: nil), "com.mikerosoft.threadbear.automation")
        XCTAssertEqual(Automation.channel(id: ""), "com.mikerosoft.threadbear.automation")
        XCTAssertEqual(Automation.channel(id: "a3f9"), "com.mikerosoft.threadbear.automation.a3f9")
        XCTAssertEqual(Automation.appLogURL(automationLog: URL(fileURLWithPath: "/tmp/x/drive.log"), arguments: []).path, "/tmp/x/drive.app.log")
        XCTAssertEqual(Automation.appLogURL(automationLog: URL(fileURLWithPath: "/tmp/x/drive.log"), arguments: ["--app-log", "/tmp/y/app.log"]).path, "/tmp/y/app.log")
        XCTAssertEqual(Automation.parseSize("1240x820"), NSSize(width: 1240, height: 820))
        XCTAssertNil(Automation.parseSize("big"))
        XCTAssertEqual(Automation.json("a\nb"), "\"a\\nb\"")
    }

    func testDumpTextMarksSelectionAndRowsOnScreen() {
        let dump = AppDump(
            instance: "a3f9", connection: "connected", runnerVersion: "0.0.0-mock",
            banner: AppDump.BannerInfo(style: "quiet", text: "The runner will restart when 1 thread finishes.", detail: nil),
            error: nil, window: AppDump.Window(width: 1240, height: 820, appearance: "dark"),
            sidebar: AppDump.Sidebar(mode: "inbox", sections: [
                AppDump.Section(name: "Inbox", threads: [AppDump.Thread(id: "th1", title: "Fix it", status: "idle", needsYou: false, unread: true, hovered: false)]),
                AppDump.Section(name: "Running", threads: []),
            ], snoozed: 0, archived: 2),
            selection: AppDump.Thread(id: "th1", title: "Fix it", status: "idle", needsYou: false, unread: false, hovered: false),
            composer: AppDump.Composer(draft: "th1", text: "hello", images: 0, cwd: "/w", account: "claude-3", model: "default (the runner's, claude-haiku-5-5)", ask: true, mode: .ask),
            transcript: AppDump.Transcript(threadId: "th1", state: "loaded", hasMoreAbove: false, atBottom: true, rows: [
                AppDump.Row(id: "u:1", kind: "user", height: 64, expanded: nil, inGroup: false, onScreen: false, seq: 1, turn: "t1", text: "Fix it"),
                AppDump.Row(id: "g:r:r1", kind: "group", height: 32, expanded: true, inGroup: false, onScreen: true, seq: 2, turn: "t1", text: "Ran a command"),
            ])
        )
        let text = dump.text
        XCTAssertTrue(text.hasPrefix("dev app a3f9: connected, runner 0.0.0-mock, window 1240x820 dark\n"))
        XCTAssertTrue(text.contains("banner (quiet): The runner will restart when 1 thread finishes."))
        XCTAssertFalse(text.contains("Running"), "empty sections are left out")
        XCTAssertTrue(text.contains("  > th1"), "the selected thread is marked")
        XCTAssertTrue(text.contains("composer (th1): \"hello\""))
        XCTAssertTrue(text.contains("\n  runs in /w on claude-3, model default (the runner's, claude-haiku-5-5), asks before edits\n"), text)
        XCTAssertTrue(text.contains("> g:r:r1"))
        XCTAssertTrue(text.contains("open    Ran a command"))
        XCTAssertTrue(dump.json(pretty: false).contains("\"onScreen\":true"))
    }

    /// A scripted app never drives Mike's real threads: no --data-dir
    /// means the installed runner's folder, and that's refused.
    @MainActor
    func testRefusesTheLiveRunnerUnlessAllowed() {
        let live = RunnerConfig.defaultDataDir
        let mock = URL(fileURLWithPath: "/tmp/tb-mock-xyz", isDirectory: true)
        XCTAssertTrue(Automation.refusesLiveRunner(dataDir: live, arguments: ["Threadbear", "--automation", "/tmp/a.log"]))
        XCTAssertTrue(Automation.refusesLiveRunner(dataDir: live.appendingPathComponent("."), arguments: ["Threadbear", "--automation", "/tmp/a.log"]))
        XCTAssertFalse(Automation.refusesLiveRunner(dataDir: live, arguments: ["Threadbear", "--automation", "/tmp/a.log", "--automation-allow-live"]))
        XCTAssertFalse(Automation.refusesLiveRunner(dataDir: mock, arguments: ["Threadbear", "--automation", "/tmp/a.log"]))
        XCTAssertFalse(Automation.refusesLiveRunner(dataDir: live, arguments: ["Threadbear"]), "not scripted at all")
    }

    /// What a new thread from the composer would run on, as `dump` and
    /// `options` report it: whose default model it is matters, since an
    /// account's default can be an expensive one.
    @MainActor
    func testNewThreadSettingsSayWhoseDefaultModel() {
        _ = NSApplication.shared
        let app = AppModel()
        // The pick is kept in UserDefaults, which every test run shares:
        // left behind, the next run starts on "sonnet" and fails.
        app.newThreadModel = nil
        defer { app.newThreadModel = nil }
        app.defaults = RunnerDefaults(cwd: "/w", accountId: "claude-3")
        XCTAssertEqual(AppDump.newThreadSettings(app).model, "default (the account's)")
        app.defaults.model = "claude-haiku-5-5"
        XCTAssertEqual(AppDump.newThreadSettings(app).model, "default (the runner's, claude-haiku-5-5)")
        app.newThreadModel = "sonnet"
        app.newThreadPermission = .ask
        let settings = AppDump.newThreadSettings(app)
        XCTAssertEqual(settings.model, "sonnet")
        XCTAssertEqual(settings.cwd, "/w")
        XCTAssertTrue(settings.ask)
    }

    /// `focus` lets a scripted app (never in front) count as looking, so
    /// opening an unread thread marks it read as it would for Mike.
    @MainActor
    func testFocusCountsAsLooking() {
        _ = NSApplication.shared
        let app = AppModel()
        XCTAssertFalse(app.isLooking, "a test process isn't the active app")
        app.actsActive = true
        XCTAssertTrue(app.isLooking)
    }
}
#endif

/// Just enough of a drag for the composer's drop methods.
private final class FakeDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    let draggingLocation: NSPoint
    let draggingSource: Any?
    init(pasteboard: NSPasteboard, window: NSWindow, location: NSPoint, source: Any? = nil) {
        draggingSource = source
        draggingPasteboard = pasteboard
        draggingDestinationWindow = window
        draggingLocation = location
    }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggedImageLocation: NSPoint { draggingLocation }
    var draggedImage: NSImage? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}
