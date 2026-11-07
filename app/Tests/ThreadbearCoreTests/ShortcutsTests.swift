import Foundation
import ThreadbearCore
import XCTest

/// Settings > Keyboard and the shortcuts.json behind it.
final class ShortcutsTests: XCTestCase {
    private func key(_ text: String) -> ShortcutKey { ShortcutKey(string: text)! }

    // MARK: Keys

    func testAKeyReadsAndWritesTheWayTheFileSaysIt() {
        XCTAssertEqual(ShortcutKey("n"), key("cmd+n"))
        XCTAssertEqual(key("cmd+opt+down").string, "cmd+opt+down")
        XCTAssertEqual(key("shift+cmd+c").string, "cmd+shift+c", "the same order however it was written")
        XCTAssertEqual(key("CTRL+J").string, "ctrl+j")
        XCTAssertEqual(key("command+option+control+shift+x").string, "cmd+ctrl+opt+shift+x")
        XCTAssertEqual(key("alt+cmd+p"), key("opt+cmd+p"))
        XCTAssertEqual(key("cmd++").key, "+", "a plus sign is a key too")
    }

    func testNonsenseIsntAKey() {
        for text in ["", "cmd", "cmd+", "banana+n", "cmd+banana", "cmd+n+m", "+"] {
            XCTAssertNil(ShortcutKey(string: text), text)
        }
    }

    func testAKeyShowsTheWayMacOSMenusDo() {
        XCTAssertEqual(key("cmd+n").display, "⌘N")
        XCTAssertEqual(key("cmd+opt+down").display, "⌥⌘↓")
        XCTAssertEqual(key("cmd+shift+c").display, "⇧⌘C")
        XCTAssertEqual(key("ctrl+cmd+s").display, "⌃⌘S")
        XCTAssertEqual(key("cmd+.").display, "⌘.")
        XCTAssertEqual(key("cmd+[").display, "⌘[")
        XCTAssertEqual(key("ctrl+return").display, "⌃↩")
        XCTAssertEqual(key("f5").display, "F5")
    }

    func testAPressedKeyBecomesAShortcutKey() {
        XCTAssertEqual(ShortcutKey(keyCode: 14, characters: "e", command: true), key("cmd+e"))
        XCTAssertEqual(ShortcutKey(keyCode: 14, characters: "E", command: true, shift: true), key("cmd+shift+e"), "the letter, not its capital")
        XCTAssertEqual(ShortcutKey(keyCode: 125, characters: "\u{F701}", command: true, option: true), key("cmd+opt+down"), "by the key, not its odd character")
        XCTAssertEqual(ShortcutKey(keyCode: 76, characters: "\u{3}", control: true), key("ctrl+return"), "the keypad's Enter is Return")
        XCTAssertEqual(ShortcutKey(keyCode: 96, characters: "\u{F708}"), key("f5"))
        XCTAssertNil(ShortcutKey(keyCode: 200, characters: nil, command: true), "nothing to call it")
        XCTAssertNil(ShortcutKey(keyCode: 200, characters: "ab", command: true))
    }

    func testAKeyHasToBeMoreThanSomethingYoudType() {
        XCTAssertFalse(key("cmd+e").typesInstead)
        XCTAssertFalse(key("ctrl+e").typesInstead)
        XCTAssertFalse(key("f5").typesInstead, "function keys don't type")
        XCTAssertTrue(ShortcutKey("e", command: false).typesInstead)
        XCTAssertTrue(ShortcutKey("e", command: false, shift: true).typesInstead)
        XCTAssertTrue(ShortcutKey("e", command: false, option: true).typesInstead, "⌥E types an accent")
        XCTAssertTrue(ShortcutKey("down", command: false, option: true).typesInstead, "moves through text")
    }

    func testKeysTextFieldsNeedAreSpokenFor() {
        XCTAssertNotNil(key("cmd+left").takenByTyping)
        XCTAssertNotNil(key("cmd+shift+down").takenByTyping)
        XCTAssertNotNil(key("cmd+delete").takenByTyping)
        XCTAssertNil(key("cmd+opt+down").takenByTyping, "Next Inbox Thread's own key")
        XCTAssertNil(key("cmd+e").takenByTyping)
    }

    // MARK: Commands

    func testEveryCommandHasItsOwnDefaultKey() {
        let keys = ShortcutCommand.allCases.compactMap(\.defaultKey)
        XCTAssertEqual(keys.count, Set(keys).count, "two commands can't start on one key")
        for command in ShortcutCommand.allCases {
            XCTAssertFalse(command.title.isEmpty)
            XCTAssertFalse(command.defaultKey?.typesInstead ?? false, command.title)
            XCTAssertNil(command.defaultKey?.takenByTyping, command.title)
        }
    }

    /// What the menus had before there was a Keyboard page. Nobody's keys
    /// should change by updating.
    func testTheDefaultsAreTheKeysPeopleAlreadyKnow() {
        let expected: [ShortcutCommand: String] = [
            .newThread: "⌘N", .archive: "⌘E", .stop: "⌘.", .copyTranscript: "⇧⌘C",
            .back: "⌘[", .forward: "⌘]", .nextInboxThread: "⌥⌘↓",
            .showInbox: "⌘1", .showScheduled: "⌘2", .showProjects: "⌘3", .showLibrarian: "⌘4",
            .zoomIn: "⌘=", .zoomOut: "⌘-", .actualSize: "⌘0",
            .toggleThreads: "⌃⌘S", .togglePanels: "⌥⌘P",
            .settings: "⌘,",
        ]
        for command in ShortcutCommand.allCases {
            XCTAssertEqual(command.defaultKey?.display, expected[command], command.title)
        }
    }

    // MARK: Changing them

    func testChangingAKeyAndPuttingItBack() {
        var bindings = ShortcutBindings()
        XCTAssertEqual(bindings.key(for: .archive), key("cmd+e"))
        XCTAssertFalse(bindings.isChanged(.archive))

        bindings.set(.archive, to: key("ctrl+e"))
        XCTAssertEqual(bindings.key(for: .archive), key("ctrl+e"))
        XCTAssertTrue(bindings.isChanged(.archive))

        bindings.set(.archive, to: key("cmd+e"))
        XCTAssertFalse(bindings.isChanged(.archive), "the same key as the default isn't a change")
        XCTAssertEqual(bindings, ShortcutBindings())
    }

    func testAKeyCanBeRemovedOrAddedToACommandWithNone() {
        var bindings = ShortcutBindings()
        bindings.set(.archive, to: nil)
        XCTAssertNil(bindings.key(for: .archive))
        XCTAssertTrue(bindings.isChanged(.archive))

        XCTAssertNil(bindings.key(for: .hibernate))
        bindings.set(.hibernate, to: key("cmd+opt+h"))
        XCTAssertEqual(bindings.key(for: .hibernate), key("cmd+opt+h"))
    }

    func testFindingWhatUsesAKey() {
        let bindings = ShortcutBindings()
        XCTAssertEqual(bindings.command(using: key("cmd+e")), .archive)
        XCTAssertNil(bindings.command(using: key("cmd+e"), except: .archive))
        XCTAssertNil(bindings.command(using: key("ctrl+j")))
    }

    func testTakingAKeyLeavesItsOldCommandWithNone() {
        var bindings = ShortcutBindings()
        bindings.take(key("cmd+e"), for: .nextInboxThread)
        XCTAssertEqual(bindings.key(for: .nextInboxThread), key("cmd+e"))
        XCTAssertNil(bindings.key(for: .archive), "never two commands on one key")
        XCTAssertTrue(bindings.isChanged(.archive))
    }

    func testResetGoesBackToTheDefaultWithoutMakingATwin() {
        var bindings = ShortcutBindings()
        bindings.take(key("cmd+e"), for: .nextInboxThread)
        bindings.reset(.archive)
        XCTAssertEqual(bindings.key(for: .archive), key("cmd+e"))
        XCTAssertNil(bindings.key(for: .nextInboxThread), "⌘E went back to Archive, so it can't stay here too")

        bindings.reset(.nextInboxThread)
        XCTAssertEqual(bindings, ShortcutBindings(), "and everything's back as it was")
    }

    func testResetAllKeepsWhatItDoesntKnow() throws {
        var bindings = try ShortcutBindings(json: Data(#"{"archive": "ctrl+e", "aForksCommand": "ctrl+k"}"#.utf8))
        bindings.resetAll()
        XCTAssertEqual(bindings.key(for: .archive), key("cmd+e"))
        XCTAssertTrue(String(decoding: try XCTUnwrap(bindings.json()), as: UTF8.self).contains("aForksCommand"))
    }

    func testTwinsFromAHandEditedFileAreFound() throws {
        let bindings = try ShortcutBindings(json: Data(#"{"nextInboxThread": "cmd+e"}"#.utf8))
        XCTAssertEqual(bindings.key(for: .nextInboxThread), key("cmd+e"))
        XCTAssertEqual(bindings.command(using: key("cmd+e"), except: .nextInboxThread), .archive)
    }

    // MARK: The file

    func testNothingChangedWritesNoFile() {
        XCTAssertNil(ShortcutBindings().json())
    }

    func testTheFileHoldsOnlyWhatsChangedAndReadsBackTheSame() throws {
        var bindings = ShortcutBindings()
        bindings.set(.nextInboxThread, to: key("ctrl+j"))
        bindings.set(.archive, to: nil)
        let data = try XCTUnwrap(bindings.json())
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains(#""nextInboxThread" : "ctrl+j""#), text)
        XCTAssertTrue(text.contains(#""archive" : null"#), text)
        XCTAssertFalse(text.contains("newThread"), "what's still the default stays out of it")
        XCTAssertEqual(try ShortcutBindings(json: data), bindings)
    }

    func testABadLineInTheFileIsReportedAndTheRestStillWorks() throws {
        let bindings = try ShortcutBindings(json: Data(#"{"archive": "banana", "stop": 7, "newThread": "e", "back": "ctrl+b"}"#.utf8))
        XCTAssertEqual(bindings.key(for: .back), key("ctrl+b"))
        XCTAssertEqual(bindings.key(for: .archive), key("cmd+e"), "the default, not nothing")
        XCTAssertEqual(bindings.key(for: .stop), key("cmd+."))
        XCTAssertEqual(bindings.key(for: .newThread), key("cmd+n"), "a key that would type instead isn't taken from the file either")
        XCTAssertEqual(bindings.problems.count, 3, "\(bindings.problems)")
    }

    func testAFileThatIsntJSONThrowsSoTheLastGoodKeysStay() {
        XCTAssertThrowsError(try ShortcutBindings(json: Data("not json".utf8)))
        XCTAssertThrowsError(try ShortcutBindings(json: Data("[1, 2]".utf8)))
    }
}
