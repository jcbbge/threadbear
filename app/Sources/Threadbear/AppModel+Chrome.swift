import AppKit
import BearDock
import Observation
import ThreadbearCore

// Runner restarts, the banner, copying, the Dock badge and panels.
// Split out of AppModel.swift (4 Nov 2026) as a plain move.
extension AppModel {
    // MARK: Runner restarts

    /// A restart notice moves the banner along straight away. Returns false
    /// for any other notice.
    func restart(notice message: String) -> Bool {
        var handled = false
        updateRestart { handled = $0.notice(message, now: Date()) }
        return handled
    }

    func updateRestart(_ change: (inout RunnerRestart) -> Void) {
        let before = restart
        var after = before
        change(&after)
        guard after != before else { return }
        restart = after
        if case .restarting = after.phase, !(before.phase.isRestarting) {
            AppLog.write("restart", "the runner is restarting")
            // The banner goes back to "Can't reach the runner" if it doesn't
            // come back; `now` changing is what makes the view look again.
            restartExpiry?.cancel()
            restartExpiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(RunnerRestart.patience + 1))
                guard !Task.isCancelled else { return }
                self?.now = Date()
            }
        } else if let text = after.pendingText, text != before.pendingText {
            AppLog.write("restart", text)
        } else if after.phase == .none {
            restartExpiry?.cancel()
        }
    }

    /// Asks `runner.status` which threads a restart waits for. Coalesced:
    /// a burst of thread updates asks once.
    func refreshRunnerStatus() {
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self, let client = self.client, self.connection == .connected else { return }
            do {
                let status = try await client.runnerStatus()
                guard !Task.isCancelled, self.client === client else { return }
                self.updateRestart { $0.status(status.pendingRestart, now: Date()) }
                if self.websiteURL != status.websiteURL { self.websiteURL = status.websiteURL }
                if self.pushOff != status.pushOff { self.pushOff = status.pushOff }
            } catch RPCError.server(let code, _) where code == -32601 {
                // A runner older than runner.status: its notices are all there is.
            } catch {
                AppLog.write("rpc", "runner.status failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Banner

    /// The line under the toolbar about the runner, if there's anything to
    /// say: a restart waiting or under way (quiet), or a connection problem.
    var banner: Banner? {
        let restarting = restart.isRestarting(now: max(now, Date()))
        switch connection {
        case .connected:
            // Mike's own click comes first: he's looking for it.
            if let note = busyNotes.last { return Banner(style: .quiet, icon: nil, text: note.text) }
            if let doneNote { return Banner(style: .quiet, icon: "checkmark", text: doneNote) }
            if restarting {
                return Banner(style: .quiet, icon: nil, text: "The runner is restarting now.")
            }
            if let text = restart.pendingText(isWaitingOnYou: { self.threads[$0]?.status == .waiting }) {
                return Banner(style: .quiet, icon: "arrow.clockwise", text: text,
                              detail: restart.waitingForText { self.threads[$0]?.title })
            }
            // A CLI update under way (a spinner), or one that failed, which
            // stays until it's dismissed.
            if let cli = cliBanner {
                return Banner(style: .quiet, icon: cli.failedKey == nil ? nil : "exclamationmark.triangle", text: cli.text, dismissKey: cli.failedKey)
            }
            return nil
        case .connecting, .lost, .runnerDown:
            // While a restart is under way the runner is meant to be down
            // for a moment: say so quietly, with no buttons to press.
            if restarting {
                return Banner(style: .quiet, icon: nil, text: "The runner is restarting. Reconnecting…")
            }
            switch connection {
            case .runnerDown(let reason):
                // One plain sentence; the raw reason is in the tooltip.
                return Banner(style: .warning, icon: "bolt.horizontal.circle", text: "Can't reach the runner.", detail: reason,
                              showStart: canStartRunner, showRetry: true)
            case .lost:
                return Banner(style: .warning, icon: "bolt.horizontal", text: "Lost the connection to the runner. Reconnecting…", showRetry: true)
            default:
                return Banner(style: .warning, icon: "bolt.horizontal", text: "Connecting to the runner…", showRetry: true)
            }
        case .unauthorized:
            return Banner(style: .warning, icon: "lock", text: "The runner didn't accept the token in secrets/runner-token.", showRetry: true)
        }
    }

    /// "Start runner" kickstarts the installed runner's LaunchAgent, which
    /// only helps an app pointed at that runner's data folder. A debug app
    /// against the mock or a dev runner must never start the live one.
    var canStartRunner: Bool {
        dataDir.standardizedFileURL.path == RunnerConfig.defaultDataDir.standardizedFileURL.path
    }

    /// What "Copy debug info" says to run for a row's events: a bare `tb`
    /// for the installed runner, a dev runner's own `<home>/tb`
    /// (dev-runner.sh writes one), the data folder in front of `tb` for any
    /// other runner, and the fixture's lines for the mock.
    var eventsSource: RowDebug.EventsSource {
        if runnerVersion.hasPrefix("0.0.0-mock") { return .fixture }
        if canStartRunner { return .tb("tb") }
        let own = dataDir.appendingPathComponent("tb").path
        if FileManager.default.isExecutableFile(atPath: own) { return .tb(Self.shellQuoted(own)) }
        return .tb("THREADBEAR_HOME=\(Self.shellQuoted(dataDir.path)) tb")
    }

    /// As a shell would need it typed: the default data folder has a space.
    static func shellQuoted(_ text: String) -> String {
        if text.range(of: #"^[A-Za-z0-9_@%+=:,./-]+$"#, options: .regularExpression) != nil { return text }
        return "'" + text.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }

    // MARK: Copying

    func copyToPasteboard(_ text: String) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    // MARK: Dock

    /// The Dock badge is the number of threads that need you (DockBadge).
    /// Scripted runs (dev apps, perf and screenshot runs) show none, like
    /// notifications.
    func refreshDockBadge() {
        guard notificationsEnabled else { return }
        let label = DockBadge.label(for: threads.values, now: now)
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    // MARK: Panels

    /// Whether the section remembered for this thread is open in the dock.
    func showsPanels(for thread: ThreadSummary) -> Bool { dock.layout.contains(paneSection(for: thread).id) }

    func activePanel(for thread: ThreadSummary) -> Panel? {
        PanelChoice.active(in: thread.panels, remembered: panelChoice[thread.id])
    }

    /// The thread's pane section: the one last chosen while it's still
    /// there, else Highlights. Previews open over it.
    func paneSection(for thread: ThreadSummary) -> PaneSection {
        PanelChoice.section(panels: thread.panels, hasPatches: !thread.patches.isEmpty, remembered: panelChoice[thread.id])
    }

    /// Shows a section's panel (the automation's `panel`), closing any
    /// preview over another one.
    func choosePanel(_ panelId: String, in threadId: String) {
        if panePreview[threadId]?.from.id != panelId { panePreview[threadId] = nil }
        panelChoice[threadId] = panelId
        showPane(PaneSection(id: panelId))
    }

    /// A rail button, VS Code's way: closes the section's panel if it's
    /// showing, else brings it up (WindowDock).
    func clickRail(_ section: PaneSection, in thread: ThreadSummary) {
        if panePreview[thread.id].map({ $0.from != section }) ?? false { panePreview[thread.id] = nil }
        panelChoice[thread.id] = section.id
        if dock.isShowing(section.id) { dock.close(section.id) } else { showPane(section) }
    }

    func togglePanels() { panelsShown.toggle() }

    /// The sidebar's panel, from the View menu: closed, or opened down the
    /// left of the window.
    func toggleThreadsPanel() {
        if dock.layout.contains(WindowDock.threads) { dock.close(WindowDock.threads) } else { dock.open(WindowDock.threads, .window(.left)) }
    }

    static func actionKey(threadId: String, actionId: String) -> String { "\(threadId)/\(actionId)" }

    func isRunning(action: Action, in threadId: String) -> Bool {
        runningActions.contains(Self.actionKey(threadId: threadId, actionId: action.id))
    }

    /// Runs an action chip: the runner sends a prompt action as a message,
    /// or runs a command action and puts its output in the transcript. A
    /// url action opens its page in the browser here, without the runner.
    func runAction(_ action: Action, in threadId: String) {
        if action.kind == .url {
            if let page = action.webPage {
                OpenGate.openWeb(page)
            } else {
                errorMessage = "\(action.title) has no web page to open."
            }
            return
        }
        let key = Self.actionKey(threadId: threadId, actionId: action.id)
        guard !runningActions.contains(key), let client = client(for: threadId) else { return }
        runningActions.insert(key)
        Task {
            do {
                _ = try await client.runAction(threadId: threadId, actionId: action.id)
            } catch {
                showError("\(action.title) didn't run: \(error.localizedDescription)", in: threadId, doing: "running the \(action.title) action chip")
            }
            runningActions.remove(key)
        }
    }

    /// Trusts patch files waiting in a thread's folder, as the Patches
    /// panel showed them; the runner then loads them.
    func trustPatches(_ patches: [PatchInfo], in threadId: String) {
        let files = patches.compactMap { p in p.file.flatMap { f in p.hash.map { (file: f, hash: $0) } } }
            .filter { !trustingPatches.contains(Self.trustKey($0.file, $0.hash)) }
        guard !files.isEmpty, let client = client(for: threadId) else { return }
        let keys = Set(files.map { Self.trustKey($0.file, $0.hash) })
        trustingPatches.formUnion(keys)
        Task {
            do {
                try await client.trustPatches(threadId: threadId, files: files)
                // The row stops waiting when the thread's update says it's
                // trusted. Let go a little later in case that never comes
                // (the runner trusted nothing), so it can be pressed again.
                try? await Task.sleep(for: .seconds(5))
                trustingPatches.subtract(keys)
            } catch {
                trustingPatches.subtract(keys)
                showError("Couldn't trust \(patches.count == 1 ? patches[0].id : "the patches"): \(error.localizedDescription)", in: threadId,
                          doing: "pressing Trust on \(patches.count == 1 ? "a patch" : "patches") in the Patches panel")
            }
        }
    }

    /// A patch version's key in `trustingPatches`.
    static func trustKey(_ file: String, _ hash: String) -> String { file + " " + hash }

    /// Whether `patch`'s Trust has been pressed and hasn't landed yet.
    func isTrusting(_ patch: PatchInfo) -> Bool {
        guard let file = patch.file, let hash = patch.hash else { return false }
        return trustingPatches.contains(Self.trustKey(file, hash))
    }

    /// Shows `message` in the error bar, saying which thread it was about
    /// and what he was doing, for its Investigate button.
    func showError(_ message: String, in threadId: String?, doing: String?) {
        nextErrorThread = threadId
        nextErrorDoing = doing
        errorMessage = message
    }

    /// The checkout this app follows, where a thread can fix it: the
    /// running build's, the runner's, or for a debug build the one it was
    /// compiled from. Nil when there's none to work in.
    var ownCheckout: String? {
        if let checkout = AppUpdater.shared.running?.checkout ?? runnerUpdates?.upstream?.checkout { return checkout }
        #if DEBUG
        // Sources/Threadbear/AppModel+Chrome.swift, four folders down from the repo.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return FileManager.default.fileExists(atPath: url.appendingPathComponent("AGENTS.md").path) ? url.path : nil
        #else
        return nil
        #endif
    }

    /// What the error bar's Investigate hands its new thread.
    func errorReport() -> InvestigateText.Report? {
        guard let message = errorMessage else { return nil }
        let shown = errorShown
        let thread = shown?.threadId.flatMap { threads[$0] }
        return InvestigateText.Report(
            message: message, at: shown?.at ?? Date(),
            threadId: shown?.threadId, threadTitle: thread?.title, threadFolder: thread?.cwd,
            doing: shown?.doing,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            appCommit: AppUpdater.shared.running?.short,
            runnerVersion: runnerVersion.isEmpty ? nil : runnerVersion)
    }

    /// The error bar's Investigate: a new thread in the app's own checkout
    /// that finds the error's cause and fixes it, made as Bring In makes
    /// its thread. The bar goes and the new thread opens once it's made;
    /// a failure says so in the bar instead.
    func investigateError() {
        guard let report = errorReport(), let checkout = ownCheckout, let client, !creatingThread else { return }
        var request = newThreadRequest(text: InvestigateText.prompt(report), images: [])
        request.cwd = checkout
        request.permissionMode = .full
        request.title = InvestigateText.title(report)
        creatingThread = true
        Task {
            defer { creatingThread = false }
            do {
                let thread = try await client.createThread(request)
                if errorMessage == report.message { errorMessage = nil }
                threads[thread.id] = thread
                select(thread.id)
            } catch {
                show(error)
            }
        }
    }

    /// An image panel's latest picture or a list panel's rows, or nil when
    /// the runner can't be asked (not connected). `failure` is the note
    /// when it couldn't answer.
    func renderPanel(threadId: String, panelId: String, failure: String) async -> PanelRender? {
        guard let client = client(for: threadId) else { return nil }
        do {
            return try await client.renderPanel(threadId: threadId, panelId: panelId)
        } catch {
            AppLog.write("panels", "render \(panelId) failed: \(error)")
            return PanelRender(note: failure)
        }
    }

    /// Available cloud deployments for the panel's project.
    func convexPanelDeployments(threadId: String, panelId: String, refresh: Bool = false) async -> Result<ConvexDeployments, Error> {
        guard let client = client(for: threadId) else { return .failure(RPCError.disconnected(nil)) }
        do {
            return .success(try await client.convexPanelDeployments(threadId: threadId, panelId: panelId, refresh: refresh))
        } catch {
            return .failure(error)
        }
    }

    /// Signs the thread's runner's Convex CLI in (`panels.convexLogin`).
    func convexPanelLogin(threadId: String, panelId: String, check: Bool = false, force: Bool = false) async -> Result<ConvexLogin, Error> {
        guard let client = client(for: threadId) else { return .failure(RPCError.disconnected(nil)) }
        do {
            return .success(try await client.convexPanelLogin(threadId: threadId, panelId: panelId, check: check, force: force))
        } catch {
            AppLog.write("panels", "convex sign-in for \(panelId) failed: \(error.localizedDescription)")
            return .failure(error)
        }
    }

    /// A deploy key for the selected deployment, or the CLI's reason when
    /// it couldn't make one.
    func convexPanelKey(threadId: String, panelId: String, deployment: String? = nil, renew: Bool = false) async -> Result<ConvexPanelKey, Error> {
        guard let client = client(for: threadId) else { return .failure(RPCError.disconnected(nil)) }
        do {
            return .success(try await client.convexPanelKey(threadId: threadId, panelId: panelId, deployment: deployment, renew: renew))
        } catch {
            AppLog.write("panels", "convex key for \(panelId) failed: \(error.localizedDescription)")
            return .failure(error)
        }
    }
}

private extension RunnerRestart.Phase {
    var isRestarting: Bool {
        if case .restarting = self { return true }
        return false
    }
}
