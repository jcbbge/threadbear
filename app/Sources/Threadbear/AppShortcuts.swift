import AppKit
import Observation
import SwiftUI
import ThreadbearCore

/// The keys in use, for the menus, the hold-⌘ hints, tooltips and Settings >
/// Keyboard. They're kept in shortcuts.json in the data folder, holding only
/// what's been changed, rather than in the app's defaults, so an agent can
/// read and change them too; a change to the file shows straight away.
@MainActor
@Observable
final class AppShortcuts {
    static let shared = AppShortcuts(file: RunnerConfig.dataDir().appendingPathComponent("shortcuts.json"))

    private(set) var bindings = ShortcutBindings()
    /// Why the file couldn't be used, or which lines of it couldn't, for the page.
    private(set) var problem: String?

    @ObservationIgnored let file: URL
    @ObservationIgnored private var lastRead: Data?
    @ObservationIgnored private var fileWatch: DispatchSourceFileSystemObject?
    @ObservationIgnored private var folderWatch: DispatchSourceFileSystemObject?
    @ObservationIgnored private var pendingLoad: DispatchWorkItem?

    init(file: URL, watching: Bool = true) {
        self.file = file
        load()
        if watching { watch() }
    }

    func key(_ command: ShortcutCommand) -> ShortcutKey? {
        bindings.key(for: command)
    }

    /// "⌘N", for a hint; nil with no key, which a hint takes as nothing to show.
    func display(_ command: ShortcutCommand) -> String? {
        key(command)?.display
    }

    /// A tooltip with the command's key at the end, if it has one.
    func tip(_ text: String, _ command: ShortcutCommand) -> String {
        display(command).map { "\(text) (\($0))" } ?? text
    }

    func keyboardShortcut(_ command: ShortcutCommand) -> KeyboardShortcut? {
        key(command)?.keyboardShortcut
    }

    func change(_ edit: (inout ShortcutBindings) -> Void) {
        var changed = bindings
        edit(&changed)
        guard changed != bindings else { return }
        bindings = changed
        save()
        updateMenusSoon()
    }

    /// What a menu item outside the list already uses this key for, like
    /// Copy or Quit, or what typing needs it for. Nil if it's free. Read from
    /// the menu itself, so it's right about whatever macOS and SwiftUI put there.
    func takenOutsideTheList(_ key: ShortcutKey) -> String? {
        if let typing = key.takenByTyping { return typing }
        func search(_ menu: NSMenu) -> String? {
            for item in menu.items {
                if let submenu = item.submenu, let found = search(submenu) { return found }
                guard let itemKey = ShortcutKey(menuItem: item), itemKey == key else { continue }
                return item.title.replacingOccurrences(of: "…", with: "")
            }
            return nil
        }
        return NSApp?.mainMenu.flatMap(search)
    }

    // MARK: The file

    private func save() {
        guard let data = bindings.json() else {
            try? FileManager.default.removeItem(at: file)
            lastRead = nil
            problem = nil
            return
        }
        lastRead = data
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            problem = nil
        } catch {
            problem = "Couldn't save your shortcuts: \(error.localizedDescription)"
        }
    }

    /// Reads the file if it's changed. One that won't parse leaves the keys
    /// in use alone: an agent may be halfway through editing it.
    func load() {
        guard let data = try? Data(contentsOf: file) else {
            if lastRead != nil || bindings != ShortcutBindings() {
                lastRead = nil
                bindings = ShortcutBindings()
                problem = nil
                updateMenusSoon()
            }
            return
        }
        guard data != lastRead else { return }
        lastRead = data
        guard let read = try? ShortcutBindings(json: data) else {
            problem = "shortcuts.json isn't valid JSON, so these are the last keys that worked."
            return
        }
        bindings = read
        problem = read.problems.isEmpty ? nil : "shortcuts.json has lines that couldn't be used: \(read.problems.joined(separator: ", "))"
        updateMenusSoon()
    }

    // MARK: The menus

    /// SwiftUI only re-reads a menu's keys when that menu opens, so on its own
    /// a changed key wouldn't work, and the old one wouldn't stop, until
    /// someone happened to open it (found testing this on 6 Nov). So the items
    /// get their keys here as well; `.shortcut` says the same thing, so
    /// SwiftUI's next look at them changes nothing.
    private func updateMenusSoon() {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let menu = NSApp?.mainMenu else { return }
                self.updateKeys(in: menu)
            }
        }
    }

    /// Puts the keys in use on a menu's items, and its submenus' items.
    func updateKeys(in menu: NSMenu) {
        for item in menu.items {
            if let submenu = item.submenu { updateKeys(in: submenu) }
            guard let command = ShortcutCommand.allCases.first(where: { $0.menuTitles.contains(item.title) }) else { continue }
            let key = bindings.key(for: command)
            item.keyEquivalent = key?.menuCharacter ?? ""
            item.keyEquivalentModifierMask = key?.menuModifiers ?? []
        }
    }

    /// Commands whose menu item has a different key from the list, for the
    /// automation to catch this ever drifting: "archive:cmd+e".
    func menusOutOfStep() -> [String] {
        guard let menu = NSApp?.mainMenu else { return [] }
        var found: [String] = []
        func look(_ menu: NSMenu) {
            for item in menu.items {
                if let submenu = item.submenu { look(submenu) }
                guard let command = ShortcutCommand.allCases.first(where: { $0.menuTitles.contains(item.title) }) else { continue }
                let shown = ShortcutKey(menuItem: item)
                if shown != bindings.key(for: command) {
                    found.append("\(command.rawValue):\(shown?.string ?? "none")")
                }
            }
        }
        look(menu)
        return found
    }

    // Two watches: the file for an edit in place, and its folder for one that
    // arrives by replacing it (an atomic write) or creating it. The folder's
    // own watch only fires for files directly in it, so a busy runner writing
    // inside threads/ doesn't wake this.
    private func watch() {
        folderWatch = source(for: file.deletingLastPathComponent().path, mask: [.write])
        watchFile()
    }

    private func watchFile() {
        fileWatch?.cancel()
        fileWatch = source(for: file.path, mask: [.write, .extend, .rename, .delete])
    }

    private func source(for path: String, mask: DispatchSource.FileSystemEvent) -> DispatchSourceFileSystemObject? {
        let descriptor = open(path, O_EVTONLY)
        guard descriptor >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: mask, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.scheduleLoad() }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        return source
    }

    private func scheduleLoad() {
        pendingLoad?.cancel()
        // After the write's settled, as an editor's save is several events.
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.load()
                self?.watchFile()
            }
        }
        pendingLoad = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150), execute: work)
    }
}

extension ShortcutKey {
    /// What SwiftUI's menus take. Nil only for a key it has no way to say.
    var keyboardShortcut: KeyboardShortcut? {
        guard let equivalent = keyEquivalent else { return nil }
        var modifiers: EventModifiers = []
        if command { modifiers.insert(.command) }
        if option { modifiers.insert(.option) }
        if control { modifiers.insert(.control) }
        if shift { modifiers.insert(.shift) }
        return KeyboardShortcut(equivalent, modifiers: modifiers)
    }

    /// An NSMenuItem's `keyEquivalent`.
    var menuCharacter: String {
        keyEquivalent.map { String($0.character) } ?? ""
    }

    var menuModifiers: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if command { flags.insert(.command) }
        if option { flags.insert(.option) }
        if control { flags.insert(.control) }
        if shift { flags.insert(.shift) }
        return flags
    }

    private var keyEquivalent: KeyEquivalent? {
        switch key {
        case "down": return .downArrow
        case "up": return .upArrow
        case "left": return .leftArrow
        case "right": return .rightArrow
        case "return": return .return
        case "tab": return .tab
        case "space": return .space
        case "delete": return .delete
        case "forwarddelete": return .deleteForward
        case "escape": return .escape
        case "home": return .home
        case "end": return .end
        case "pageup": return .pageUp
        case "pagedown": return .pageDown
        default:
            if isFunctionKey, let number = Int(key.dropFirst()), let scalar = Unicode.Scalar(NSF1FunctionKey + number - 1) {
                return KeyEquivalent(Character(scalar))
            }
            return key.first.map { KeyEquivalent($0) }
        }
    }

    /// A menu item's key, or nil if it has none.
    init?(menuItem item: NSMenuItem) {
        guard let first = item.keyEquivalent.first, item.keyEquivalent.count == 1 else { return nil }
        let flags = item.keyEquivalentModifierMask
        // A capital in a key equivalent means Shift, whatever the mask says.
        let shift = flags.contains(.shift) || (first.isUppercase && first.isLetter)
        let name: String
        switch first.unicodeScalars.first.map({ Int($0.value) }) ?? 0 {
        case NSDownArrowFunctionKey: name = "down"
        case NSUpArrowFunctionKey: name = "up"
        case NSLeftArrowFunctionKey: name = "left"
        case NSRightArrowFunctionKey: name = "right"
        case 0x0D, 0x03: name = "return"
        case 0x09: name = "tab"
        case 0x20: name = "space"
        case 0x08, 0x7F: name = "delete"
        case NSDeleteFunctionKey: name = "forwarddelete"
        case 0x1B: name = "escape"
        case NSHomeFunctionKey: name = "home"
        case NSEndFunctionKey: name = "end"
        case NSPageUpFunctionKey: name = "pageup"
        case NSPageDownFunctionKey: name = "pagedown"
        case let code where code >= NSF1FunctionKey && code <= NSF35FunctionKey: name = "f\(code - NSF1FunctionKey + 1)"
        default: name = String(first).lowercased()
        }
        self.init(name, command: flags.contains(.command), option: flags.contains(.option), control: flags.contains(.control), shift: shift)
    }
}

extension View {
    /// The key this command has now. Nothing without one.
    @MainActor
    func shortcut(_ command: ShortcutCommand) -> some View {
        keyboardShortcut(AppShortcuts.shared.keyboardShortcut(command))
    }
}

/// Listens for the new key on Settings > Keyboard. It takes key presses
/// before the menus do, so pressing ⌘E here doesn't archive the open thread.
/// After a key that can't be used it keeps listening, so another press is
/// another go.
@MainActor
@Observable
final class ShortcutRecorder {
    static let shared = ShortcutRecorder(shortcuts: .shared)

    enum Outcome: Equatable {
        /// Nothing pressed yet.
        case waiting
        /// A key that would type instead of being a shortcut.
        case typesInstead
        /// Another command has it, which it can give up if asked.
        case takenByCommand(ShortcutKey, ShortcutCommand)
        /// Something outside the list has it, which can't change.
        case takenOutside(ShortcutKey, String)
    }

    private(set) var command: ShortcutCommand?
    private(set) var outcome = Outcome.waiting

    @ObservationIgnored private let shortcuts: AppShortcuts
    @ObservationIgnored private var monitor: Any?
    @ObservationIgnored private var resignObserver: NSObjectProtocol?

    init(shortcuts: AppShortcuts) {
        self.shortcuts = shortcuts
    }

    func start(_ command: ShortcutCommand) {
        self.command = command
        outcome = .waiting
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { [weak self] event in
            let swallowed = MainActor.assumeIsolated { self?.swallows(event) ?? false }
            return swallowed ? nil : event
        }
        resignObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.cancel() }
        }
    }

    func cancel() {
        command = nil
        outcome = .waiting
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        resignObserver = nil
    }

    /// Takes an event while listening. True means it goes no further, so
    /// the key doesn't also do what it does in the menus.
    func swallows(_ event: NSEvent) -> Bool {
        guard command != nil else { return false }
        if event.type == .leftMouseDown {
            // A click anywhere else means never mind. Not with a question on
            // screen, whose buttons need that click.
            if outcome == .waiting { cancel() }
            return false
        }
        guard event.type == .keyDown, !event.isARepeat else { return true }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        if flags.isEmpty {
            switch event.keyCode {
            case 53:
                cancel()
                return true
            case 51, 117:
                remove()
                return true
            default:
                break
            }
        }
        // What the key types with nothing held: ⇧⌘[ is "[", not "{".
        let characters = event.characters(byApplyingModifiers: []) ?? event.charactersIgnoringModifiers
        if let key = ShortcutKey(keyCode: event.keyCode, characters: characters, command: flags.contains(.command), option: flags.contains(.option), control: flags.contains(.control), shift: flags.contains(.shift)) {
            press(key)
        }
        return true
    }

    func press(_ key: ShortcutKey) {
        guard let command else { return }
        if shortcuts.key(command) == key {
            cancel()
        } else if key.typesInstead {
            outcome = .typesInstead
        } else if let other = shortcuts.bindings.command(using: key, except: command) {
            outcome = .takenByCommand(key, other)
        } else if let outside = shortcuts.takenOutsideTheList(key) {
            outcome = .takenOutside(key, outside)
        } else {
            shortcuts.change { $0.set(command, to: key) }
            cancel()
        }
    }

    /// Yes to giving the key to this command instead.
    func useTakenKey() {
        guard let command, case .takenByCommand(let key, _) = outcome else { return }
        shortcuts.change { $0.take(key, for: command) }
        cancel()
    }

    private func remove() {
        guard let command else { return }
        shortcuts.change { $0.set(command, to: nil) }
        cancel()
    }
}
