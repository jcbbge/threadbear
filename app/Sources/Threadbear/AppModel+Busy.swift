import Foundation

/// What's waiting on the runner, so a control can show it. Every click shows
/// something at once (AGENTS.md, "Assume every action is slow to land"): an
/// optimistic change, or, for what can't be guessed, a spinner and no more
/// clicks until it lands. A control asks `isBusy(key)` and wears `.busy(_:)`
/// (Views/BusyControl.swift).
enum BusyKey {
    static func stop(_ threadId: String) -> String { "stop/\(threadId)" }
    /// A login or pool change on its way: the composer's chips spin.
    static func moving(_ threadId: String) -> String { "moving/\(threadId)" }
    /// A folder change on its way: the composer's + spins, as its menu has it.
    static func movingFolder(_ threadId: String) -> String { "movingFolder/\(threadId)" }
    static func copying(_ threadId: String) -> String { "copying/\(threadId)" }
    /// The same path on two Macs is two files.
    static func fetching(_ path: String, runner: String?, action: FileLinkAction) -> String { "fetching/\(action)/\(runner ?? "")/\(path)" }
    static func projectIcon(_ id: String) -> String { "projectIcon/\(id)" }
    static func projectTasks(_ id: String) -> String { "projectTasks/\(id)" }
    static func runSchedule(_ id: String) -> String { "runSchedule/\(id)" }
    static func pauseSchedule(_ id: String) -> String { "pauseSchedule/\(id)" }
    static func tickAsk(_ threadId: String, asksSeq: Int, index: Int) -> String { "tickAsk/\(threadId)/\(asksSeq)/\(index)" }
    static func runLibrarian(_ threadId: String?) -> String { "runLibrarian/\(threadId ?? "")" }
    static func updateCli(_ provider: String) -> String { "updateCli/\(provider)" }
    static func cliPolicy(_ provider: String) -> String { "cliPolicy/\(provider)" }
    static let newProject = "newProject"
    static let pauseLibrarian = "pauseLibrarian"
    static let checkClis = "checkClis"
    static let refreshRunners = "refreshRunners"
    static let refreshConnectors = "refreshConnectors"
    static let startRunner = "startRunner"
}

/// A busy key's words, for the banner.
struct BusyNote: Equatable {
    var key: String
    var text: String
}

extension AppModel {
    func isBusy(_ key: String) -> Bool { busyKeys[key] != nil }

    /// Marks `key` busy until `endBusy`. They count, so overlapping calls
    /// don't clear each other. `whileBusy` is the one to use, unless the
    /// work's own shape (a change that's not always a move) says otherwise.
    func beginBusy(_ key: String, note: String? = nil) {
        busyKeys[key, default: 0] += 1
        if let note { busyNotes.append(BusyNote(key: key, text: note)) }
    }

    func endBusy(_ key: String) {
        guard let count = busyKeys[key] else { return }
        busyKeys[key] = count > 1 ? count - 1 : nil
        if let index = busyNotes.lastIndex(where: { $0.key == key }) { busyNotes.remove(at: index) }
    }

    /// Runs `work` with `key` busy, or does nothing and says false if it
    /// already is, so a second click or a repeated shortcut can't send it
    /// twice. `note` says what's happening in the banner, for a click from
    /// somewhere that can't show a spinner (a menu, a row).
    @discardableResult
    func whileBusy(_ key: String, note: String? = nil, _ work: @escaping @MainActor () async -> Void) -> Bool {
        guard !isBusy(key) else { return false }
        beginBusy(key, note: note)
        Task {
            await work()
            endBusy(key)
        }
        return true
    }

    /// Says something's done in the banner for a moment.
    func flashDone(_ text: String) {
        doneNote = text
        Task {
            try? await Task.sleep(for: .seconds(2))
            if doneNote == text { doneNote = nil }
        }
    }
}
