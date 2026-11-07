import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Editing a text file in the pane (TextFileController): line numbers
/// while editing, ⌘S writes straight away rather than after the pause, and
/// a save never writes over a change on disk it hasn't heard about yet.
@MainActor
final class TextFileEditingTests: XCTestCase {
    private var file: URL!

    override func setUp() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("text-editing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("hello.ts")
        try "let a = 1;\n".write(to: file, atomically: true, encoding: .utf8)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    private func onDisk() -> String { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }

    private func editor(editing: Bool) -> (TextFileController, NSWindow) {
        let controller = TextFileController(url: file)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = controller.scroll
        controller.start(editing: editing, dark: false)
        window.makeFirstResponder(controller.textView)
        return (controller, window)
    }

    /// Files open read only, as before; the pencil brings the numbers.
    func testLineNumbersOnlyWhileEditing() {
        let (controller, window) = editor(editing: false)
        defer { controller.stop(); window.close() }
        XCTAssertFalse(controller.textView.isEditable)
        XCTAssertFalse(controller.scroll.rulersVisible)
        controller.setEditing(true)
        XCTAssertTrue(controller.textView.isEditable)
        XCTAssertTrue(controller.scroll.rulersVisible)
        controller.setEditing(false)
        XCTAssertFalse(controller.scroll.rulersVisible)
    }

    /// Opened again while it was being edited: it takes typing straight away.
    func testReopenedWhileEditingTakesTyping() {
        let (controller, window) = editor(editing: true)
        defer { controller.stop(); window.close() }
        XCTAssertTrue(controller.textView.isEditable)
        XCTAssertTrue(controller.scroll.rulersVisible)
    }

    func testCommandSSavesStraightAway() throws {
        let (controller, window) = editor(editing: true)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("let b = 2;\n")
        XCTAssertEqual(onDisk(), "let a = 1;\n", "not yet: the pause hasn't passed")
        let commandS = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                                      windowNumber: window.windowNumber, context: nil, characters: "s",
                                                      charactersIgnoringModifiers: "s", isARepeat: false, keyCode: 1))
        XCTAssertTrue(window.performKeyEquivalent(with: commandS))
        XCTAssertEqual(onDisk(), "let a = 1;\nlet b = 2;\n")
    }

    /// ⌘S over a file that's only being read is left for the menus.
    func testCommandSWhileReadingDoesNothing() throws {
        let (controller, window) = editor(editing: false)
        defer { controller.stop(); window.close() }
        let commandS = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                                      windowNumber: window.windowNumber, context: nil, characters: "s",
                                                      charactersIgnoringModifiers: "s", isARepeat: false, keyCode: 1))
        XCTAssertFalse(controller.textView.performKeyEquivalent(with: commandS))
    }

    /// An agent rewrites the file just before a save: it isn't written
    /// over, and the conflict bar asks. Keep mine then writes it.
    func testAnOutsideChangeIsntWrittenOver() throws {
        let (controller, window) = editor(editing: true)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("// mine\n")
        try "let a = 99;\n".write(to: file, atomically: false, encoding: .utf8)
        controller.saveNow()
        XCTAssertEqual(onDisk(), "let a = 99;\n")
        XCTAssertEqual(controller.conflict, "let a = 99;\n", "the bar asks")
        controller.keepMine()
        XCTAssertNil(controller.conflict)
        XCTAssertEqual(onDisk(), "let a = 1;\n// mine\n")
    }

    /// Done with an outside change waiting: it stays in editing, with what
    /// was typed, so the bar can ask and Keep mine writes it.
    func testKeepMineAfterDoneStillSaves() throws {
        let markdown = file.deletingLastPathComponent().appendingPathComponent("notes.md")
        try "# Notes\n".write(to: markdown, atomically: true, encoding: .utf8)
        let controller = TextFileController(url: markdown)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = controller.scroll
        controller.start(editing: true, dark: false)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("mine\n")
        try "# Theirs\n".write(to: markdown, atomically: false, encoding: .utf8)
        controller.setEditing(false)
        XCTAssertTrue(controller.editing, "Done didn't take")
        XCTAssertEqual(controller.textView.string, "# Notes\nmine\n")
        XCTAssertEqual(controller.conflict, "# Theirs\n")
        XCTAssertEqual(try String(contentsOf: markdown, encoding: .utf8), "# Theirs\n")
        controller.keepMine()
        XCTAssertNil(controller.conflict)
        XCTAssertEqual(try String(contentsOf: markdown, encoding: .utf8), "# Notes\nmine\n")
    }

    /// Replaced by something that isn't UTF-8 just before a save: it turns
    /// read only, what was typed stays on screen, and nothing is written.
    func testAFileThatIsNoLongerTextIsNeverWritten() throws {
        let (controller, window) = editor(editing: true)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("// mine\n")
        let bytes = Data([0x68, 0x69, 0xFF, 0xFE])
        try bytes.write(to: file)
        XCTAssertFalse(controller.saveNow())
        XCTAssertFalse(controller.textView.isEditable)
        XCTAssertEqual(controller.textView.string, "let a = 1;\n// mine\n")
        // Done again: still there, still not written.
        controller.setEditing(false)
        XCTAssertTrue(controller.editing)
        XCTAssertFalse(controller.saveNow())
        XCTAssertEqual(controller.textView.string, "let a = 1;\n// mine\n")
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    /// The file can't be read back to check it: nothing is written.
    func testASaveThatCantCheckTheFileWritesNothing() throws {
        let (controller, window) = editor(editing: true)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
            controller.stop(); window.close()
        }
        controller.insertAtEnd("// mine\n")
        try "let a = 99;\n".write(to: file, atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o200], ofItemAtPath: file.path)
        XCTAssertFalse(controller.saveNow())
        XCTAssertNotNil(controller.note)
        controller.setEditing(false)
        XCTAssertTrue(controller.editing, "what's typed isn't dropped")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        XCTAssertEqual(onDisk(), "let a = 99;\n")
    }

    /// A conflict, then what was typed is taken back out: Done takes the
    /// file's rather than staying stuck in editing.
    func testUndoingBackClearsAConflict() throws {
        let (controller, window) = editor(editing: true)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("// mine\n")
        try "let a = 99;\n".write(to: file, atomically: false, encoding: .utf8)
        XCTAssertFalse(controller.saveNow())
        XCTAssertNotNil(controller.conflict)
        controller.textView.selectAll(nil)
        controller.textView.insertText("let a = 1;\n", replacementRange: controller.textView.selectedRange())
        controller.setEditing(false)
        XCTAssertFalse(controller.editing)
        XCTAssertNil(controller.conflict)
        XCTAssertEqual(onDisk(), "let a = 99;\n")
    }

    /// The save as you type still lands by itself.
    func testTypingIsStillSavedAfterThePause() {
        let (controller, window) = editor(editing: true)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("let c = 3;\n")
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        XCTAssertEqual(onDisk(), "let a = 1;\nlet c = 3;\n")
    }
}
