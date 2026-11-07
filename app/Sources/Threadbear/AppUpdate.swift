import AppKit
import Observation

/// What a bundle was built from. `build-app.sh` writes it to
/// Contents/Resources/build.json.
struct BuildInfo: Codable, Equatable {
    var commit: String
    var short: String
    /// The tree hashes of app/ and dock/ at that commit, joined by "+"
    /// (`git rev-parse <commit>:app <commit>:dock`). Only a change under
    /// those changes what runs, so this, not the commit, says whether a
    /// build would be any different. Builds from before BearDock have only
    /// app/'s, so they're rebuilt once.
    var appTree: String
    var builtAt: String
    /// The checkout it was built from, whose main the updater follows.
    var checkout: String
    var configuration: String
    /// The checkout's origin remote when it was built (builds before 30 Oct
    /// 2026 have none). Only Mike's own repo reports to his Sentry.
    var origin: String?

    /// github.com/mikecann/threadbear, however the URL was written.
    var isMikesRepo: Bool {
        guard let origin else { return false }
        var key = origin.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if key.hasPrefix("git@") { key = String(key.dropFirst(4)).replacingOccurrences(of: ":", with: "/") }
        if let scheme = key.range(of: "://") { key = String(key[scheme.upperBound...]) }
        if let at = key.firstIndex(of: "@"), !key[..<at].contains("/") { key = String(key[key.index(after: at)...]) }
        if key.hasSuffix("/") { key.removeLast() }
        if key.hasSuffix(".git") { key.removeLast(4) }
        return key == "github.com/mikecann/threadbear"
    }

    static func read(bundle: URL) -> BuildInfo? {
        guard let data = try? Data(contentsOf: bundle.appendingPathComponent("Contents/Resources/build.json")) else { return nil }
        return try? JSONDecoder().decode(BuildInfo.self, from: data)
    }
}

/// The file moves and decisions of the self-update, with no app state, so
/// the tests can run them on temp folders.
enum AppUpdate {
    /// `git rev-parse` output, one hash a line, as BuildInfo.appTree:
    /// joined by "+", as build-app.sh writes it.
    /// Main's app/ and dock/ trees in a checkout. Not `--verify`: that
    /// takes one name only, and with two it failed every check from
    /// 1a4317c (28 Oct), so the app stopped following main without a word.
    static func revParseArguments(checkout: String) -> [String] {
        ["-C", checkout, "rev-parse", "refs/heads/main:app", "refs/heads/main:dock"]
    }

    static func tree(fromRevParse output: String) -> String {
        output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "+")
    }

    enum Action: Equatable {
        case nothing
        /// Main's app/ differs from what's running and nothing staged or
        /// being built matches it.
        case build(appTree: String)
        /// What's staged no longer matches main, and main is what's
        /// running already: drop it.
        case dropStaged
    }

    static func decide(mainTree: String, running: BuildInfo, staged: BuildInfo?, building: String?, failed: String?) -> Action {
        if mainTree == running.appTree {
            return staged != nil ? .dropStaged : .nothing
        }
        if staged?.appTree == mainTree || building == mainTree || failed == mainTree { return .nothing }
        return .build(appTree: mainTree)
    }

    /// Puts the staged bundle in the installed one's place, in two renames
    /// so the app is gone for an instant and never half there. The old
    /// bundle (the running one, when this is done on quit) goes to `old`,
    /// to be deleted at the next launch.
    static func swap(install: URL, next: URL, old: URL) throws {
        let files = FileManager.default
        if files.fileExists(atPath: old.path) { try files.removeItem(at: old) }
        if files.fileExists(atPath: install.path) { try files.moveItem(at: install, to: old) }
        try files.moveItem(at: next, to: install)
    }

    /// Swaps a staged bundle in if it would change anything, and returns
    /// what was swapped in. A staged bundle that matches what's running (a
    /// build that finished after the same commit was installed another way)
    /// is dropped. Leftovers of an earlier swap are deleted first.
    @discardableResult
    static func applyStaged(install: URL, next: URL, old: URL, running: BuildInfo?) -> BuildInfo? {
        let files = FileManager.default
        if files.fileExists(atPath: old.path) { try? files.removeItem(at: old) }
        guard files.fileExists(atPath: next.path) else { return nil }
        guard let staged = BuildInfo.read(bundle: next), staged.appTree != running?.appTree else {
            try? files.removeItem(at: next)
            return nil
        }
        do {
            try swap(install: install, next: next, old: old)
            AppLog.write("update", "swapped in \(staged.short) (built \(staged.builtAt))")
            return staged
        } catch {
            AppLog.write("update", "couldn't swap \(next.lastPathComponent) in: \(error.localizedDescription)")
            return nil
        }
    }

    /// Whether to restart on its own to take a staged build: nothing typed
    /// would be lost, and Mike isn't in the app (another app is in front, or
    /// he hasn't touched this one for a while). Running threads don't hold
    /// it up: the runner owns the turns and the app replays what it missed
    /// when it reconnects.
    ///
    /// There's no warning first (Mike, 29 Oct: the countdown card went once
    /// restarts were handovers), so with the app in front it only goes when
    /// a handover would go unseen (`inPlace`: the main window is on screen
    /// and the one he's in). A full-screen or minimised window restarts the
    /// old way, and Settings or a panel's own window would close, so those
    /// wait for Restart to Update or for him to be in another app.
    static func shouldAutoRestart(staged: Bool, loaded: Bool, hasDrafts: Bool, active: Bool, idleFor: TimeInterval, inPlace: Bool) -> Bool {
        guard staged, loaded, !hasDrafts else { return false }
        return !active || (inPlace && idleFor >= AppUpdater.autoRestartIdleTime)
    }

    /// Opens `bundle` again once this process has exited: a shell that
    /// waits for the pid, then `open`. Children of a GUI app outlive it.
    /// `inBackground` opens it without bringing it in front (`open -g`),
    /// for a restart Mike didn't ask for while he's in another app.
    static func relaunchAfterExit(_ bundle: URL, inBackground: Bool = false) {
        let open = inBackground ? "/usr/bin/open -g" : "/usr/bin/open"
        let script = "while /bin/kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do /bin/sleep 0.2; done; \(open) \"$0\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, bundle.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            AppLog.write("update", "couldn't start the relaunch: \(error.localizedDescription)")
        }
    }
}

/// The installed app keeps itself current with the checkout it was built
/// from. Every few minutes it reads main's tree hash for app/ there, and
/// when that differs from what's running it builds that commit (release,
/// in the background, from its own clone and build folder under
/// ~/Library/Caches/Threadbear/update, so nothing an agent does in the
/// checkout is built or disturbed) into ~/Applications/.Threadbear.app.next.
/// Quitting swaps the staged bundle in, so the next launch is the new app;
/// a launch that finds one staged (the app was killed rather than quit)
/// swaps it in and relaunches. "Restart to Update" in the app menu does it
/// now, and the app does it by itself once nothing typed would be lost
/// and Mike isn't using it (see `shouldAutoRestart`),
/// reopening the thread he had open. Only the installed app does any of this: a debug app from
/// Tools/dev-app.sh, a perf run or a screenshot run has another bundle
/// path or a scripted flag, and a bundle with no build.json (built before
/// this existed) stays as it is until install.sh or restart.sh is run once.
@MainActor @Observable
final class AppUpdater {
    static let shared = AppUpdater()
    static let checkInterval: TimeInterval = 5 * 60
    /// After launch, once the app has connected and settled.
    static let firstCheckDelay: TimeInterval = 20
    /// How often a staged build is weighed against what's going on. Cheap
    /// (a few comparisons), so often, to restart soon after the idle time.
    nonisolated static let autoRestartInterval: TimeInterval = 1
    /// With the app in front, this long without a key or a click counts as
    /// not using it. Short: a restart takes a second or two and puts the
    /// open thread back, so there's little to wait for (Mike, 28 Oct).
    nonisolated static let autoRestartIdleTime: TimeInterval = 5
    static let logPath = NSHomeDirectory() + "/Library/Logs/threadbear-update.log"
    /// Where the app was (the thread and sidebar list) when it restarted
    /// itself, put back once the threads have loaded.
    static let restoreKey = "updateRestore"

    nonisolated static var installDir: URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["THREADBEAR_APP_DIR"] ?? NSHomeDirectory() + "/Applications/Threadbear.app")
    }
    nonisolated static var nextDir: URL { installDir.deletingLastPathComponent().appendingPathComponent(".Threadbear.app.next") }
    nonisolated static var oldDir: URL { installDir.deletingLastPathComponent().appendingPathComponent(".Threadbear.app.old") }

    /// True for the installed app in an ordinary launch.
    nonisolated static var isInstalledApp: Bool {
        let arguments = CommandLine.arguments
        let scripted = arguments.contains("--perf-run") || arguments.contains("--screenshots") || arguments.contains("--automation")
        guard !scripted, !arguments.contains("--no-update") else { return false }
        return Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath().path == installDir.standardizedFileURL.resolvingSymlinksInPath().path
    }

    /// A staged update found at launch: swapped in, with a relaunch on the
    /// way. The caller exits. Before anything else in the app starts.
    nonisolated static func applyStagedAtLaunch() -> Bool {
        // A handover's incoming app is the new build already, and `.old`
        // is the outgoing app, still running.
        guard isInstalledApp, Handover.incomingFrom == nil else { return false }
        let running = BuildInfo.read(bundle: Bundle.main.bundleURL)
        guard AppUpdate.applyStaged(install: installDir, next: nextDir, old: oldDir, running: running) != nil else { return false }
        AppUpdate.relaunchAfterExit(installDir)
        return true
    }

    /// The bundle waiting to be swapped in, for the app menu.
    private(set) var staged: BuildInfo?
    /// The running bundle's build, or nil when there's nothing to follow.
    private(set) var running: BuildInfo?
    /// Why updates are off, for the log.
    private(set) var disabledReason: String?
    /// main's app/ tree being built, and the one whose build failed (not
    /// tried again until main moves on), for the updates popover.
    private(set) var building: String?
    private(set) var failed: String?
    @ObservationIgnored private var mainWatch: MainRefWatch?
    @ObservationIgnored private var soonCheck: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var restartTimer: Timer?
    @ObservationIgnored private var build: Process?
    @ObservationIgnored private var lastInput = Date()
    @ObservationIgnored private var inputMonitor: Any?
    @ObservationIgnored private var restarting = false
    /// The staged build was swapped in before quitting, for a handover.
    @ObservationIgnored private var swappedEarly = false

    var enabled: Bool { running != nil && disabledReason == nil }

    func start() {
        guard Self.isInstalledApp else {
            disabledReason = "not the installed app"
            return
        }
        guard let info = BuildInfo.read(bundle: Bundle.main.bundleURL), !info.appTree.isEmpty else {
            disabledReason = "no build.json in the bundle; run app/install.sh (or restart.sh) once to get a build that updates itself"
            AppLog.write("update", disabledReason!)
            return
        }
        guard FileManager.default.fileExists(atPath: info.checkout + "/.git") else {
            disabledReason = "the checkout it was built from, \(info.checkout), is gone"
            AppLog.write("update", disabledReason!)
            return
        }
        guard Bundle.main.url(forResource: "stage-update", withExtension: "sh") != nil else {
            disabledReason = "no stage-update.sh in the bundle"
            AppLog.write("update", disabledReason!)
            return
        }
        running = info
        staged = BuildInfo.read(bundle: Self.nextDir)
        AppLog.write("update", "running \(info.short) (\(info.configuration)) from \(info.checkout); following main" + (staged.map { "; \($0.short) is staged" } ?? ""))
        timer = Timer.scheduledTimer(withTimeInterval: Self.checkInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.check() }
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.firstCheckDelay))
            self?.check()
        }
        // A merge to main is built within seconds, not at the next
        // five-minute look (the runner does the same).
        mainWatch = MainRefWatch(checkout: info.checkout) { [weak self] in
            Task { @MainActor in self?.checkSoon() }
        }
        restartTimer = Timer.scheduledTimer(withTimeInterval: Self.autoRestartInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.considerAutoRestart(app: AppModel.shared) }
        }
        inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { [weak self] event in
            self?.lastInput = Date()
            return event
        }
    }

    /// Restarts into the staged build as soon as that wouldn't interrupt
    /// anything (`shouldAutoRestart`). Called every second
    /// (`autoRestartInterval`), so it goes soon after the idle time.
    func considerAutoRestart(app: AppModel) {
        guard !restarting, let staged else { return }
        // An open schedule editor, or words or pictures in a card's
        // Something else box, count as something typed: a restart would
        // throw away what's in them.
        let hasDrafts = app.drafts.values.contains { !$0.text.isEmpty || !$0.images.isEmpty } || app.scheduleEditor != nil
            || app.askPicks.values.contains { $0.notes.values.contains { !$0.isEmpty } }
        let loaded = app.threadsLoaded && app.connection == .connected
        let active = NSApp.isActive
        // A handover only keeps the main window: with Settings, a panel's
        // own window or a dialog in front of it, he'd see that one close.
        let main = Handover.windowToHandOver()
        let inPlace = main != nil && (NSApp.keyWindow == nil || NSApp.keyWindow === main)
        guard AppUpdate.shouldAutoRestart(staged: true, loaded: loaded, hasDrafts: hasDrafts, active: active,
                                          idleFor: Date().timeIntervalSince(lastInput), inPlace: inPlace) else { return }
        AppLog.write("update", "restarting into \(staged.short): nothing typed, " + (active ? "no input for a while" : "the app isn't in front"))
        restart(app: app, inBackground: !active)
    }

    #if DEBUG
    /// Hands over to a new copy of this same bundle, as a restart into an
    /// update does, for a scripted app (Automation's `handover`).
    func previewHandover(app: AppModel) -> Bool {
        guard let window = Handover.windowToHandOver() else { return false }
        Self.saveRestore(app: app)
        Handover.shared.handOver(to: Bundle.main.bundleURL, window: window, app: app) {
            AppLog.write("handover", "the scripted handover couldn't start the new app")
        }
        return true
    }

    /// Makes up an app update that's "staged", "building" or "failed" (or
    /// none, on abc1234), for a scripted app's screenshots of the updates
    /// popover and panel (Automation's `updates` with `preview`). Restart
    /// to Update does nothing with it: a debug app isn't the installed one.
    func previewUpdate(_ state: String) {
        func build(_ short: String) -> BuildInfo {
            BuildInfo(commit: short, short: short, appTree: short, builtAt: "", checkout: "", configuration: "debug")
        }
        running = build("abc1234")
        staged = state == "staged" ? build("def5678") : nil
        building = state == "building" ? "def5678" : nil
        failed = state == "failed" ? "def5678" : nil
    }
    #endif

    private func restart(app: AppModel, inBackground: Bool) {
        restarting = true
        Self.saveRestore(app: app)
        let classic = {
            AppUpdate.relaunchAfterExit(Self.installDir, inBackground: inBackground)
            NSApp.terminate(nil)
        }
        // With the window on screen, the new build is swapped in now and
        // started beside this one, which quits once it's showing
        // (Handover), so the window never goes away.
        if let window = Handover.windowToHandOver(),
           AppUpdate.applyStaged(install: Self.installDir, next: Self.nextDir, old: Self.oldDir, running: running) != nil {
            swappedEarly = true
            staged = nil
            Handover.shared.handOver(to: Self.installDir, window: window, app: app, fallback: classic)
            return
        }
        classic()
    }

    /// The list and the thread showing, as saved for a restart.
    static func restoreState(app: AppModel) -> (mode: String, selection: String) {
        let mode = switch app.sidebarMode {
        case .inbox: "inbox"
        case .scheduled: "scheduled"
        case .projects: "projects"
        case .librarian: "librarian"
        }
        return (mode, app.selection ?? "")
    }

    private static func saveRestore(app: AppModel) {
        let state = restoreState(app: app)
        var saved: [String: String] = ["selection": state.selection, "mode": state.mode]
        // Where the open thread was scrolled to, so it doesn't jump to the
        // bottom (a handover shows it in place of the old window).
        if !state.selection.isEmpty, let memory = app.loadedSession(state.selection)?.view?.captureMemory(), !memory.pinned, let anchor = memory.anchorId {
            saved["anchor"] = anchor
            saved["offset"] = String(Double(memory.offset))
        }
        UserDefaults.standard.set(saved, forKey: restoreKey)
    }

    /// After a restart the app made itself: back to the thread and list
    /// that were open. Called once the threads have loaded.
    static func restoreAfterRestart(app: AppModel) {
        guard let saved = UserDefaults.standard.dictionary(forKey: restoreKey) as? [String: String] else { return }
        UserDefaults.standard.removeObject(forKey: restoreKey)
        let scroll = saved["anchor"].map { ScrollMemory(pinned: false, anchorId: $0, offset: CGFloat(Double(saved["offset"] ?? "") ?? 0)) }
        restore(mode: saved["mode"] ?? "inbox", selection: saved["selection"] ?? "", scroll: scroll, app: app)
    }

    /// Puts the list and the thread back. Only what differs is changed, so
    /// a handover's "go" that matches what's showing does nothing.
    static func restore(mode: String, selection: String, scroll: ScrollMemory?, app: AppModel) {
        if restoreState(app: app).mode != mode {
            switch mode {
            // Saved by a build from before these were inbox sections.
            case "snoozed": app.showHibernating()
            case "archive": app.showArchive()
            case "scheduled": app.showSchedules()
            // Before projects.list has answered; an older runner's -32601 puts
            // it back on the inbox.
            case "projects": app.showProjects()
            case "librarian": app.showLibrarian()
            default: app.sidebarMode = .inbox
            }
        }
        if !selection.isEmpty, app.selection != selection, app.threads[selection] != nil {
            if let scroll { app.session(for: selection).scrollMemory = scroll }
            app.select(selection)
        }
    }

    /// main moved: check in a few seconds. A burst of ref writes (a merge,
    /// then packed-refs) makes one check.
    func checkSoon() {
        soonCheck?.cancel()
        soonCheck = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.check()
        }
    }

    /// Reads main's app/ and dock/ trees in the checkout and starts a build
    /// if they're new.
    func check() {
        guard let running, build == nil else { return }
        // followMain: false in runner.json stops the runner rebuilding, and
        // the app too (on-your-mac.md promises both). Only an explicit false
        // stops it: before the runner has said, it's the default, on.
        guard AppModel.shared.runnerSettings?.followMain != false else { return }
        Task { @MainActor in
            let result = await Self.run("/usr/bin/git", AppUpdate.revParseArguments(checkout: running.checkout))
            guard result.status == 0 else {
                AppLog.write("update", "git rev-parse main:app main:dock failed in \(running.checkout): \(result.output)")
                return
            }
            let mainTree = AppUpdate.tree(fromRevParse: result.output)
            // What's staged may have been swapped in or dropped by hand.
            staged = BuildInfo.read(bundle: Self.nextDir)
            switch AppUpdate.decide(mainTree: mainTree, running: running, staged: staged, building: building, failed: failed) {
            case .nothing:
                break
            case .dropStaged:
                try? FileManager.default.removeItem(at: Self.nextDir)
                staged = nil
                AppLog.write("update", "dropped the staged build; main is what's running again")
            case .build(let appTree):
                startBuild(appTree: appTree, checkout: running.checkout)
            }
        }
    }

    /// The build takes every core for a minute or two, so it runs at
    /// macOS's background priority (`taskpolicy -b`, as Mike asks of every
    /// build on his M5): throttled CPU and disk, off the cores he's using,
    /// and inherited by swift build and everything else it starts. `nice`
    /// only lowered its CPU priority.
    nonisolated static func buildCommand(script: String, checkout: String, next: String) -> (String, [String]) {
        ("/usr/sbin/taskpolicy", ["-b", "/bin/bash", script, checkout, "--next", next])
    }

    private func startBuild(appTree: String, checkout: String) {
        guard let script = Bundle.main.url(forResource: "stage-update", withExtension: "sh") else { return }
        let process = Process()
        let (executable, arguments) = Self.buildCommand(script: script.path, checkout: checkout, next: Self.nextDir.path)
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let log = Self.openLog()
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            Task { @MainActor in self?.buildFinished(appTree: appTree, status: status) }
        }
        do {
            try process.run()
            build = process
            building = appTree
            Self.log("Building main's app/ \(appTree.prefix(12)) (running \(running?.short ?? "?"))")
            AppLog.write("update", "building main (app/ \(appTree.prefix(12))); log: \(Self.logPath)")
        } catch {
            AppLog.write("update", "couldn't start the build: \(error.localizedDescription)")
        }
    }

    private func buildFinished(appTree: String, status: Int32) {
        build = nil
        building = nil
        if status == 0, let info = BuildInfo.read(bundle: Self.nextDir) {
            staged = info
            failed = nil
            AppLog.write("update", "\(info.short) is staged; it's swapped in when the app quits or is relaunched")
            considerAutoRestart(app: AppModel.shared)
        } else {
            // Not tried again until main moves on or the app is relaunched.
            failed = appTree
            AppLog.write("update", "the build failed (exit \(status)); see \(Self.logPath)")
        }
    }

    /// On quit: the staged bundle takes the installed one's place, so the
    /// next launch is the new app. The running binary stays in `.old`
    /// until then.
    func applyAtQuit() {
        // A handover swapped it in already, and the bundle in `.old` is
        // this app's own, still running.
        guard enabled, !swappedEarly else { return }
        build?.terminate()
        AppUpdate.applyStaged(install: Self.installDir, next: Self.nextDir, old: Self.oldDir, running: running)
    }

    /// "Restart to Update": quit (which swaps the staged bundle in) and
    /// open the app again. Only in the installed app: a debug app showing
    /// a made-up update would otherwise quit and open Mike's.
    func restartToUpdate() {
        guard staged != nil, enabled else { return }
        restart(app: AppModel.shared, inBackground: false)
    }

    // MARK: Helpers

    private static func openLog() -> FileHandle {
        let files = FileManager.default
        if !files.fileExists(atPath: logPath) { files.createFile(atPath: logPath, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath)) else { return .nullDevice }
        handle.seekToEndOfFile()
        return handle
    }

    private static func log(_ line: String) {
        let handle = openLog()
        handle.write(Data("\(ISO8601DateFormatter().string(from: Date())) \(line)\n".utf8))
        try? handle.close()
    }

    nonisolated private static func run(_ executable: String, _ arguments: [String]) async -> (status: Int32, output: String) {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { process in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: (process.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: (-1, error.localizedDescription))
            }
        }
    }
}

/// Watches a checkout's main ref (refs/heads/main, written through
/// main.lock, and packed-refs) in the repository's common dir, which
/// worktrees share, and calls `changed` when it moves. Directory watches:
/// git replaces the files rather than writing them in place.
final class MainRefWatch {
    private var sources: [DispatchSourceFileSystemObject] = []

    init?(checkout: String, changed: @escaping @Sendable () -> Void) {
        let git = Process()
        let pipe = Pipe()
        git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        git.arguments = ["-C", checkout, "rev-parse", "--git-common-dir"]
        git.standardOutput = pipe
        git.standardError = FileHandle.nullDevice
        guard (try? git.run()) != nil else { return nil }
        git.waitUntilExit()
        guard git.terminationStatus == 0,
              let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !out.isEmpty else { return nil }
        let common = out.hasPrefix("/") ? out : (checkout as NSString).appendingPathComponent(out)
        for dir in [(common as NSString).appendingPathComponent("refs/heads"), common] {
            let fd = open(dir, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
            source.setEventHandler { changed() }
            source.setCancelHandler { close(fd) }
            source.resume()
            sources.append(source)
        }
        if sources.isEmpty { return nil }
    }

    deinit {
        for s in sources { s.cancel() }
    }
}
