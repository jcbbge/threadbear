import AppKit
@testable import Threadbear
import ThreadbearCore
import XCTest

/// Settings > Keyboard: the file behind it, the recorder, and that the menus
/// and hints read their keys from the one list rather than having their own.
@MainActor
final class AppShortcutsTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("shortcuts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private var file: URL { folder.appendingPathComponent("shortcuts.json") }
    private func key(_ text: String) -> ShortcutKey { ShortcutKey(string: text)! }
    private func make() -> AppShortcuts { AppShortcuts(file: file, watching: false) }

    private func source(_ path: String) throws -> String {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/Threadbear")
        return try String(contentsOf: sources.appendingPathComponent(path), encoding: .utf8)
    }

    // MARK: The file

    func testNoFileMeansTheDefaultsAndNoProblem() {
        let shortcuts = make()
        XCTAssertEqual(shortcuts.bindings, ShortcutBindings())
        XCTAssertNil(shortcuts.problem)
        XCTAssertEqual(shortcuts.display(.archive), "⌘E")
        XCTAssertNil(shortcuts.display(.hibernate))
    }

    func testAChangeIsSavedAndReadBack() {
        let shortcuts = make()
        shortcuts.change { $0.set(.archive, to: self.key("ctrl+e")) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(make().display(.archive), "⌃E", "another launch reads it")
    }

    func testPuttingEverythingBackRemovesTheFile() {
        let shortcuts = make()
        shortcuts.change { $0.set(.archive, to: self.key("ctrl+e")) }
        shortcuts.change { $0.resetAll() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testAnAgentsEditIsPickedUp() throws {
        let shortcuts = make()
        try Data(#"{"archive": "ctrl+e"}"#.utf8).write(to: file)
        shortcuts.load()
        XCTAssertEqual(shortcuts.display(.archive), "⌃E")

        try FileManager.default.removeItem(at: file)
        shortcuts.load()
        XCTAssertEqual(shortcuts.display(.archive), "⌘E", "the file going is back to the defaults")
    }

    func testAFileMidEditKeepsTheLastKeysThatWorked() throws {
        let shortcuts = make()
        try Data(#"{"archive": "ctrl+e"}"#.utf8).write(to: file)
        shortcuts.load()
        try Data(#"{"archive": "ctr"#.utf8).write(to: file)
        shortcuts.load()
        XCTAssertEqual(shortcuts.display(.archive), "⌃E")
        XCTAssertNotNil(shortcuts.problem)

        try Data(#"{"archive": "ctrl+r"}"#.utf8).write(to: file)
        shortcuts.load()
        XCTAssertEqual(shortcuts.display(.archive), "⌃R")
        XCTAssertNil(shortcuts.problem)
    }

    func testAWatchedFileChangesTheKeysByItself() async throws {
        let shortcuts = AppShortcuts(file: file, watching: true)
        // By replacing it, as an agent's atomic write does: the folder's watch
        // has to see it, as there's no file yet to watch.
        try Data(#"{"archive": "ctrl+e"}"#.utf8).write(to: file, options: .atomic)
        for _ in 0..<60 where shortcuts.display(.archive) != "⌃E" {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(shortcuts.display(.archive), "⌃E")

        // And by writing into it in place, as an editor can.
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: Data(#"{"archive": "ctrl+r"}"#.utf8))
        try handle.close()
        for _ in 0..<60 where shortcuts.display(.archive) != "⌃R" {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(shortcuts.display(.archive), "⌃R")
    }

    func testATipCarriesTheKeyOnlyIfThereIsOne() {
        let shortcuts = make()
        XCTAssertEqual(shortcuts.tip("Archive", .archive), "Archive (⌘E)")
        shortcuts.change { $0.set(.archive, to: nil) }
        XCTAssertEqual(shortcuts.tip("Archive", .archive), "Archive")
    }

    // MARK: Recording

    func testPressingAFreeKeyUsesIt() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.nextInboxThread)
        recorder.press(key("ctrl+j"))
        XCTAssertEqual(shortcuts.display(.nextInboxThread), "⌃J")
        XCTAssertNil(recorder.command, "and it's done")
        recorder.cancel()
    }

    func testAKeyThatWouldTypeIsRefusedAndItKeepsListening() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.archive)
        recorder.press(ShortcutKey("j", command: false))
        XCTAssertEqual(recorder.outcome, .typesInstead)
        XCTAssertEqual(recorder.command, .archive)
        XCTAssertEqual(shortcuts.display(.archive), "⌘E", "nothing changed yet")
        recorder.press(key("ctrl+j"))
        XCTAssertEqual(shortcuts.display(.archive), "⌃J", "another press is another go")
        recorder.cancel()
    }

    func testAKeyAnotherCommandHasAsksFirst() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.nextInboxThread)
        recorder.press(key("cmd+e"))
        XCTAssertEqual(recorder.outcome, .takenByCommand(key("cmd+e"), .archive))
        XCTAssertEqual(shortcuts.display(.archive), "⌘E", "nothing changes until you say")

        recorder.useTakenKey()
        XCTAssertEqual(shortcuts.display(.nextInboxThread), "⌘E")
        XCTAssertNil(shortcuts.display(.archive))
        XCTAssertNil(recorder.command)
        recorder.cancel()
    }

    func testCancellingAQuestionChangesNothing() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.nextInboxThread)
        recorder.press(key("cmd+e"))
        recorder.cancel()
        XCTAssertEqual(shortcuts.bindings, ShortcutBindings())
        XCTAssertNil(recorder.command)
    }

    func testPressingTheKeyItAlreadyHasIsNoChange() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.archive)
        recorder.press(key("cmd+e"))
        XCTAssertNil(recorder.command)
        XCTAssertEqual(shortcuts.bindings, ShortcutBindings())
        recorder.cancel()
    }

    func testAKeyTypingNeedsIsRefused() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.archive)
        recorder.press(key("cmd+left"))
        XCTAssertEqual(recorder.outcome, .takenOutside(key("cmd+left"), "Moving the Cursor"))
        XCTAssertEqual(shortcuts.display(.archive), "⌘E")
        recorder.cancel()
    }

    // MARK: A real key press

    private func keyDown(code: UInt16, _ characters: String, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil,
                         characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
    }

    func testAKeyPressGoesNoFurtherWhileListeningAndIsLeftAloneOtherwise() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        XCTAssertFalse(recorder.swallows(keyDown(code: 14, "e", .command)), "with nothing listening, ⌘E still reaches the menus")

        recorder.start(.nextInboxThread)
        XCTAssertTrue(recorder.swallows(keyDown(code: 14, "e", .command)), "or it would archive the open thread")
        XCTAssertEqual(recorder.outcome, .takenByCommand(key("cmd+e"), .archive))
        recorder.cancel()
    }

    func testEscapeCancelsAndDeleteRemoves() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        recorder.start(.archive)
        XCTAssertTrue(recorder.swallows(keyDown(code: 53, "\u{1B}")), "Esc goes no further")
        XCTAssertNil(recorder.command)
        XCTAssertEqual(shortcuts.bindings, ShortcutBindings())

        recorder.start(.archive)
        XCTAssertTrue(recorder.swallows(keyDown(code: 51, "\u{7F}")))
        XCTAssertNil(recorder.command)
        XCTAssertNil(shortcuts.display(.archive))
    }

    func testAClickElsewhereCancelsButNotWithAQuestionUp() {
        let shortcuts = make()
        let recorder = ShortcutRecorder(shortcuts: shortcuts)
        let click = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        recorder.start(.archive)
        XCTAssertFalse(recorder.swallows(click), "the click still lands")
        XCTAssertNil(recorder.command)

        recorder.start(.nextInboxThread)
        recorder.press(key("cmd+e"))
        XCTAssertFalse(recorder.swallows(click))
        XCTAssertEqual(recorder.command, .nextInboxThread, "its buttons need that click")
        recorder.cancel()
    }

    // MARK: One list

    /// A key set on a menu item directly wouldn't show on the Keyboard page or
    /// follow a change there.
    func testTheMenusGetEveryKeyFromTheList() throws {
        let app = try source("ThreadbearApp.swift")
        let lines = app.components(separatedBy: "\n").filter { $0.contains(".keyboardShortcut(") }
        XCTAssertEqual(lines, [], "use .shortcut(.yourCommand), and add the command to ShortcutCommand")
    }

    private func menu(_ titles: String...) -> NSMenu {
        let top = NSMenu()
        let holder = NSMenuItem(title: "Thread", action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for title in titles { submenu.addItem(NSMenuItem(title: title, action: nil, keyEquivalent: "")) }
        holder.submenu = submenu
        top.addItem(holder)
        return top
    }

    /// SwiftUI leaves a menu's keys alone until it opens, so a change has to
    /// reach the items itself, or the old key keeps working and the new one doesn't.
    func testAChangedKeyGoesOnTheMenuItemItself() throws {
        let shortcuts = make()
        let top = menu("Next Inbox Thread", "Unarchive", "Copy")
        let submenu = try XCTUnwrap(top.items.first?.submenu)
        submenu.item(withTitle: "Copy")?.keyEquivalent = "c"

        shortcuts.updateKeys(in: top)
        let next = try XCTUnwrap(submenu.item(withTitle: "Next Inbox Thread"))
        XCTAssertEqual(ShortcutKey(menuItem: next), key("cmd+opt+down"))
        XCTAssertEqual(ShortcutKey(menuItem: try XCTUnwrap(submenu.item(withTitle: "Unarchive"))), key("cmd+e"), "Archive by its other name")

        shortcuts.change { $0.set(.nextInboxThread, to: self.key("ctrl+j")) }
        shortcuts.updateKeys(in: top)
        XCTAssertEqual(ShortcutKey(menuItem: next), key("ctrl+j"))

        shortcuts.change { $0.set(.nextInboxThread, to: nil) }
        shortcuts.updateKeys(in: top)
        XCTAssertEqual(next.keyEquivalent, "", "no key means no key")
        XCTAssertEqual(ShortcutKey(menuItem: try XCTUnwrap(submenu.item(withTitle: "Copy"))), key("cmd+c"), "what's not on the list stays as it was")
    }

    func testEveryMenuTitleIsInTheMenus() throws {
        let app = try source("ThreadbearApp.swift")
        for command in ShortcutCommand.allCases {
            for title in command.menuTitles {
                XCTAssertTrue(app.contains("\"\(title)\""), "\(command.rawValue)'s key can't find a menu item called \(title)")
            }
        }
    }

    func testEveryCommandIsInTheMenus() throws {
        let app = try source("ThreadbearApp.swift")
        for command in ShortcutCommand.allCases {
            XCTAssertTrue(app.contains(".shortcut(.\(command.rawValue))"), "\(command.rawValue) is on the Keyboard page but no menu item uses it")
        }
    }

    /// Text that names a key has to change when the key does.
    func testHintsAndTipsDontSpellOutAKeyTheListHas() throws {
        let files = ["Views/ActivityBar.swift", "Views/SidebarView.swift", "Views/ComposerControls.swift", "Views/SetupChecklist.swift"]
        let keys = ShortcutCommand.allCases.compactMap(\.defaultKey?.display)
        for file in files {
            let lines = try source(file).components(separatedBy: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            for line in lines {
                for key in keys where line.contains("\"\(key)\"") || line.contains("(\(key))") {
                    XCTFail("\(file) spells out \(key): \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
        }
    }

    func testTheKeysMenusShowComeBackFromAMenuItem() {
        func round(_ text: String) -> ShortcutKey? {
            let wanted = key(text)
            let item = NSMenuItem(title: "x", action: nil, keyEquivalent: "")
            guard let shortcut = wanted.keyboardShortcut else { return nil }
            // SwiftUI's own conversion isn't reachable from here, so this
            // spells the common cases out the way AppKit stores them.
            switch wanted.key {
            case "down": item.keyEquivalent = String(Character(Unicode.Scalar(NSDownArrowFunctionKey)!))
            case "f5": item.keyEquivalent = String(Character(Unicode.Scalar(NSF1FunctionKey + 4)!))
            default: item.keyEquivalent = String(shortcut.key.character)
            }
            var flags: NSEvent.ModifierFlags = []
            if wanted.command { flags.insert(.command) }
            if wanted.option { flags.insert(.option) }
            if wanted.control { flags.insert(.control) }
            if wanted.shift { flags.insert(.shift) }
            item.keyEquivalentModifierMask = flags
            return ShortcutKey(menuItem: item)
        }
        for text in ["cmd+e", "cmd+opt+down", "cmd+shift+c", "ctrl+cmd+s", "f5"] {
            XCTAssertEqual(round(text), key(text), text)
        }
        XCTAssertNil(ShortcutKey(menuItem: NSMenuItem(title: "No key", action: nil, keyEquivalent: "")))
        let capital = NSMenuItem(title: "x", action: nil, keyEquivalent: "E")
        XCTAssertEqual(ShortcutKey(menuItem: capital), key("cmd+shift+e"), "a capital means Shift")
    }
}
