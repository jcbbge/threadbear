import Foundation

/// A key and the modifiers held with it: a command's shortcut in Settings >
/// Keyboard, written "cmd+opt+down" in shortcuts.json so a person or an agent
/// can read and change it there.
public struct ShortcutKey: Hashable, Sendable {
    /// One lowercase character ("n", "["), or a name from `named` ("down").
    public let key: String
    public let command: Bool
    public let option: Bool
    public let control: Bool
    public let shift: Bool

    public init(_ key: String, command: Bool = true, option: Bool = false, control: Bool = false, shift: Bool = false) {
        self.key = key
        self.command = command
        self.option = option
        self.control = control
        self.shift = shift
    }

    /// Keys with a name, what menus show for them, and their key codes.
    private static let named: [String: (symbol: String, code: UInt16)] = {
        var keys: [String: (symbol: String, code: UInt16)] = [
            "down": ("↓", 125), "up": ("↑", 126), "left": ("←", 123), "right": ("→", 124),
            "return": ("↩", 36), "tab": ("⇥", 48), "space": ("Space", 49),
            "delete": ("⌫", 51), "forwarddelete": ("⌦", 117), "escape": ("Esc", 53),
            "home": ("Home", 115), "end": ("End", 119), "pageup": ("Page Up", 116), "pagedown": ("Page Down", 121),
        ]
        let functionKeys: [UInt16] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        for (index, code) in functionKeys.enumerated() {
            keys["f\(index + 1)"] = ("F\(index + 1)", code)
        }
        return keys
    }()

    /// "cmd+opt+down". Nil for anything that isn't a key.
    public init?(string: String) {
        // "cmd++" is ⌘ and the plus sign, which a split alone would lose.
        var text = string.lowercased().trimmingCharacters(in: .whitespaces)
        var parts: [String]
        if text.hasSuffix("++") {
            text.removeLast(2)
            parts = text.split(separator: "+").map(String.init) + ["+"]
        } else {
            parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        }
        guard let last = parts.popLast(), last.count == 1 || Self.named[last] != nil else { return nil }
        var command = false, option = false, control = false, shift = false
        for part in parts {
            switch part {
            case "cmd", "command": command = true
            case "opt", "option", "alt": option = true
            case "ctrl", "control": control = true
            case "shift": shift = true
            default: return nil
            }
        }
        self.init(last, command: command, option: option, control: control, shift: shift)
    }

    /// A key press. `characters` is what the key types with no modifiers;
    /// the key code decides for keys with a name, whose characters are odd
    /// private-use ones. Nil when there's nothing to call it.
    public init?(keyCode: UInt16, characters: String?, command: Bool = false, option: Bool = false, control: Bool = false, shift: Bool = false) {
        // The keypad's Enter does what Return does.
        let code = keyCode == 76 ? 36 : keyCode
        if let name = Self.named.first(where: { $0.value.code == code })?.key {
            self.init(name, command: command, option: option, control: control, shift: shift)
        } else if let characters, characters.count == 1, let lowered = characters.lowercased().first, !lowered.isWhitespace, !lowered.isNewline {
            self.init(String(lowered), command: command, option: option, control: control, shift: shift)
        } else {
            return nil
        }
    }

    /// As shortcuts.json writes it, always in the same order.
    public var string: String {
        var parts: [String] = []
        if command { parts.append("cmd") }
        if control { parts.append("ctrl") }
        if option { parts.append("opt") }
        if shift { parts.append("shift") }
        return (parts + [key]).joined(separator: "+")
    }

    /// As menus show it: "⌥⌘↓".
    public var display: String {
        ActivityKeys.modifiers(command: command, control: control, option: option, shift: shift)
            + (Self.named[key]?.symbol ?? key.uppercased())
    }

    public var isFunctionKey: Bool {
        key.count > 1 && key.hasPrefix("f") && key.dropFirst().allSatisfy(\.isNumber)
    }

    /// True for a press that's text, not a command: a shortcut without ⌘ or
    /// ⌃ would take the key away from typing it, so ⌥E could never type an
    /// accent again. Function keys don't type anything.
    public var typesInstead: Bool {
        !command && !control && !isFunctionKey
    }

    /// What this key already does in every text field, which a shortcut
    /// would take over (key equivalents go first). Nil for keys that are free.
    public var takenByTyping: String? {
        guard command, !control, !option else { return nil }
        switch key {
        case "left", "right", "up", "down": return shift ? "Selecting Text" : "Moving the Cursor"
        case "delete" where !shift: return "Deleting to the Start of the Line"
        case "return" where !shift: return "Save"
        default: return nil
        }
    }
}

/// The headings on Settings > Keyboard, named for the menus they're in.
public enum ShortcutGroup: String, CaseIterable, Sendable {
    case threads, go, view

    public var title: String {
        switch self {
        case .threads: "Threads"
        case .go: "Go"
        case .view: "View"
        }
    }

    public var commands: [ShortcutCommand] {
        ShortcutCommand.allCases.filter { $0.group == self }
    }
}

/// Everything in the menu bar that can have a key. A new menu command with a
/// key belongs here rather than on its own `.keyboardShortcut` (AppShortcutsTests
/// checks), so it shows on the Keyboard page and people can change it. The
/// raw values are shortcuts.json's names: leave them alone once they've shipped.
public enum ShortcutCommand: String, CaseIterable, Sendable {
    case newThread, archive, hibernate, stop, copyTranscript
    case back, forward, nextInboxThread, showInbox, showScheduled, showProjects, showLibrarian, showHibernating, showArchived
    case zoomIn, zoomOut, actualSize, toggleThreads, togglePanels, resetPanelLayout
    case settings

    public var group: ShortcutGroup {
        switch self {
        case .newThread, .archive, .hibernate, .stop, .copyTranscript: .threads
        case .back, .forward, .nextInboxThread, .showInbox, .showScheduled, .showProjects, .showLibrarian, .showHibernating, .showArchived: .go
        case .zoomIn, .zoomOut, .actualSize, .toggleThreads, .togglePanels, .resetPanelLayout: .view
        // The app menu's Settings…, which opens the Settings window.
        case .settings: .go
        }
    }

    public var title: String {
        switch self {
        case .newThread: "New Thread"
        case .archive: "Archive"
        case .hibernate: "Hibernate"
        case .stop: "Stop"
        case .copyTranscript: "Copy Transcript as Markdown"
        case .back: "Back"
        case .forward: "Forward"
        case .nextInboxThread: "Next Inbox Thread"
        case .showInbox: "Show Inbox"
        case .showScheduled: "Show Scheduled"
        case .showProjects: "Show Projects"
        case .showLibrarian: "Show Librarian"
        case .showHibernating: "Show Hibernating"
        case .showArchived: "Show Archived"
        case .settings: "Settings…"
        case .zoomIn: "Zoom In"
        case .zoomOut: "Zoom Out"
        case .actualSize: "Actual Size"
        case .toggleThreads: "Show Threads"
        case .togglePanels: "Show Panels"
        case .resetPanelLayout: "Reset Panel Layout"
        }
    }

    /// What its menu item can be called, as some change with what's selected
    /// or showing, and Hibernate's key sits on the one item in its submenu
    /// that always makes sense. AppShortcuts finds the item by these.
    public var menuTitles: [String] {
        switch self {
        case .archive: ["Archive", "Unarchive"]
        case .hibernate: ["Pick a time…"]
        case .toggleThreads: ["Show Threads", "Hide Threads"]
        case .togglePanels: ["Show Panels", "Hide Panels"]
        default: [title]
        }
    }

    public var defaultKey: ShortcutKey? {
        switch self {
        case .newThread: ShortcutKey("n")
        case .settings: ShortcutKey(",")
        case .archive: ShortcutKey("e")
        case .stop: ShortcutKey(".")
        case .copyTranscript: ShortcutKey("c", shift: true)
        case .back: ShortcutKey("[")
        case .forward: ShortcutKey("]")
        case .nextInboxThread: ShortcutKey("down", option: true)
        case .showInbox: ShortcutKey("1")
        case .showScheduled: ShortcutKey("2")
        case .showProjects: ShortcutKey("3")
        case .showLibrarian: ShortcutKey("4")
        // ⌘= is the key under the + sign, so ⌘+ works without shift.
        case .zoomIn: ShortcutKey("=")
        case .zoomOut: ShortcutKey("-")
        case .actualSize: ShortcutKey("0")
        case .toggleThreads: ShortcutKey("s", control: true)
        case .togglePanels: ShortcutKey("p", option: true)
        case .hibernate, .showHibernating, .showArchived, .resetPanelLayout: nil
        }
    }
}

/// The keys in use: the defaults, with whatever's been changed on top. Only
/// the changes are kept, so a default that changes in an update reaches
/// everyone who hasn't picked their own.
public struct ShortcutBindings: Equatable, Sendable {
    public struct NotAnObject: Error {}

    /// A command's key, or no key at all (`.some(nil)`).
    private var changes: [ShortcutCommand: ShortcutKey?] = [:]
    /// Entries for commands this build doesn't have (a newer build's, or a
    /// fork's), kept so saving from here doesn't lose them. NSNull for none.
    private var others: [String: String?] = [:]
    /// Lines of the file that couldn't be used, to show on the page.
    public private(set) var problems: [String] = []

    public init() {}

    /// Reads shortcuts.json. Throws if it isn't a JSON object at all, so the
    /// keys in use can stay as they are through an agent's half-done edit. A
    /// bad line only loses that line.
    public init(json data: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NotAnObject() }
        for (name, value) in object.sorted(by: { $0.key < $1.key }) {
            guard let command = ShortcutCommand(rawValue: name) else {
                if value is NSNull { others[name] = .some(nil) } else if let text = value as? String { others[name] = text }
                continue
            }
            if value is NSNull {
                set(command, to: nil)
            } else if let text = value as? String, let key = ShortcutKey(string: text), !key.typesInstead {
                set(command, to: key)
            } else {
                problems.append("\(name): \(value)")
            }
        }
    }

    /// What goes in shortcuts.json: only what's changed. Nil when nothing
    /// is, so the file can go.
    public func json() -> Data? {
        guard !changes.isEmpty || !others.isEmpty else { return nil }
        var object: [String: Any] = [:]
        for (command, key) in changes { object[command.rawValue] = key.map { $0.string as Any } ?? NSNull() }
        for (name, value) in others { object[name] = value.map { $0 as Any } ?? NSNull() }
        return try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }

    public func key(for command: ShortcutCommand) -> ShortcutKey? {
        if let change = changes[command] { return change }
        return command.defaultKey
    }

    public func isChanged(_ command: ShortcutCommand) -> Bool {
        changes[command] != nil
    }

    public var anyChanged: Bool {
        !changes.isEmpty
    }

    /// The command on this key, other than `command`.
    public func command(using key: ShortcutKey, except command: ShortcutCommand? = nil) -> ShortcutCommand? {
        ShortcutCommand.allCases.first { $0 != command && self.key(for: $0) == key }
    }

    public mutating func set(_ command: ShortcutCommand, to key: ShortcutKey?) {
        if key == command.defaultKey {
            changes[command] = nil
        } else {
            changes[command] = .some(key)
        }
    }

    /// Gives `key` to `command`, leaving whatever had it with none, so two
    /// commands are never on one key.
    public mutating func take(_ key: ShortcutKey, for command: ShortcutCommand) {
        while let other = self.command(using: key, except: command) {
            set(other, to: nil)
        }
        set(command, to: key)
    }

    /// Back to its default, taking that key back if something else has it.
    public mutating func reset(_ command: ShortcutCommand) {
        if let key = command.defaultKey {
            take(key, for: command)
        } else {
            set(command, to: nil)
        }
    }

    public mutating func resetAll() {
        changes = [:]
    }
}
