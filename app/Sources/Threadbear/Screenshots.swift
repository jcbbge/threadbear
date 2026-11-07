import AppKit
import ThreadbearCore

/// `--screenshots <dir>`: opens the synthetic demo threads from the mock
/// runner and saves window-only screenshots (`screencapture -l` with this
/// window's id, never the full screen). Used for PRs and design checks.
@MainActor
enum ScreenshotRunner {
    static func start(app: AppModel) {
        Task { await run(app: app) }
    }

    static func run(app: AppModel) async {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--screenshots"), index + 1 < arguments.count else {
            NSApp.terminate(nil)
            return
        }
        let dir = URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for _ in 0..<400 where app.connection != .connected || app.threads.isEmpty {
            try? await Task.sleep(for: .milliseconds(25))
        }
        guard let window = NSApp.windows.first(where: { $0.isVisible }) else {
            NSApp.terminate(nil)
            return
        }
        // `--appearance light|dark` checks both looks whatever the Mac is set to.
        if let index = arguments.firstIndex(of: "--appearance"), index + 1 < arguments.count {
            NSApp.appearance = NSAppearance(named: arguments[index + 1] == "light" ? .aqua : .darkAqua)
        }
        // Never saved as the window's frame (see freshSidebar).
        window.setFrameAutosaveName("")
        window.setContentSize(NSSize(width: 1240, height: 820))
        window.center()
        freshSidebar(in: window, app: app)
        // Behind every other window and never activated: these runs happen
        // while Mike is working, and `screencapture -l` captures a window by
        // id even when it's covered.
        window.tuckBehind()
        try? await Task.sleep(for: .milliseconds(500))

        let only = arguments.firstIndex(of: "--only").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        func wanted(_ name: String) -> Bool { only == nil || name.hasPrefix(only!) }

        // 1. The demo thread at the bottom: images, a footer and an approval card.
        let demo = "demo_upload_resume"
        await open(app, demo)
        if wanted("1") {
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("1-thread-bottom.png"))
        }
        // 2. Further up: the plan, a new file and an edit as diffs.
        if wanted("2") {
            await scroll(app, toRow: "p:", offset: 20)
            await capture(window, dir.appendingPathComponent("2-plan-and-diffs.png"))
        }
        // 2b. A message with an image attached: the image above the bubble,
        // right-aligned, with no box behind it.
        if wanted("2b"), let session = app.transcript.session,
           let index = (0..<session.displayCount).first(where: { index in
               if case .user(let message) = session.displayRow(index).content { return !message.images.isEmpty }
               return false
           }) {
            app.transcript.scroll(toRow: index, offset: 140)
            try? await Task.sleep(for: .milliseconds(400))
            await capture(window, dir.appendingPathComponent("2b-user-image.png"))
        }
        // 3. Top of the thread with its first work group open and the file
        // read in it expanded.
        if wanted("3") {
            let session = app.session(for: demo)
            session.expanded.insert("t:c2")
            session.setModelExpanded("g:r:r1", true)
            app.transcript.show(nil)
            app.transcript.show(session)
            await scroll(app, toRow: "u:1", offset: 0)
            await capture(window, dir.appendingPathComponent("3-top-tool-expanded.png"))
            session.setModelExpanded("g:r:r1", false)
        }
        // 4. A thread waiting on a question.
        if wanted("4") {
            await open(app, "demo_button_colour")
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("4-question.png"))
        }
        // 5. The archive, with the pointer over the other row (Unarchive).
        if wanted("5") {
            app.showArchive()
            try? await Task.sleep(for: .milliseconds(400))
            await open(app, "demo_tunnel")
            app.hoverOverride = "demo_quick_ask_readme"
            await capture(window, dir.appendingPathComponent("5-archive.png"))
            app.hoverOverride = nil
        }
        // 6. A long reply (the mock's synthetic stream text): taller than
        // the window, so its text is drawn through a slice. Captured at the
        // end, in the middle, and while it streams pinned to the bottom.
        if wanted("6") {
            app.sidebarMode = .inbox
            let thread = "demo_dark_mode"
            await open(app, thread)
            app.transcript.scrollToBottom()
            _ = try? await app.client?.call("mock.stream", .object([
                "threadId": .string(thread), "seconds": .number(12), "hz": .number(90),
            ]), as: EmptyResult.self)
            try? await Task.sleep(for: .seconds(8))
            await capture(window, dir.appendingPathComponent("6a-long-reply-streaming.png"))
            try? await Task.sleep(for: .seconds(5))
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("6b-long-reply-end.png"))
            if let session = app.transcript.session, let index = (0..<session.displayCount).last(where: { session.displayRow($0).kind == .assistant }) {
                let rect = app.transcript.tableView.rect(ofRow: index)
                print("long reply row: \(Int(rect.height)) pt tall in a \(Int(app.transcript.scrollView.contentView.bounds.height)) pt window")
                app.transcript.scroll(toRow: index, offset: -rect.height / 2)
                try? await Task.sleep(for: .milliseconds(400))
                await capture(window, dir.appendingPathComponent("6c-long-reply-middle.png"))
                if let cell = app.transcript.tableView.view(atColumn: 0, row: index, makeIfNecessary: false) as? TextRowCell {
                    print("long reply text view: drawn \(Int(cell.textView.frame.height)) pt of \(Int(cell.textView.fullFrame.height)) pt")
                }
            }
        }
        // 8. A turn that's still running (the working line and a live
        // group), then the demo's edits: the group open with its new file
        // and its edit opened, and a file opened in the changes card.
        if wanted("8") {
            app.sidebarMode = .inbox
            await open(app, "demo_ci_slow")
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("8a-live-turn.png"))
            await open(app, demo)
            let session = app.session(for: demo)
            // The new file and the edit in the group opened, so the shot
            // shows both kinds of opened diff.
            session.expanded.formUnion(["t:c3", "t:c4"])
            if let group = (0..<session.displayCount).map({ session.displayRow($0) }).first(where: { row in
                if case .group(let group) = row.content { return group.memberIds.contains("t:c3") }
                return false
            }) {
                session.setModelExpanded(group.id, true)
            }
            session.setModelExpanded(ChangedFiles.expansionKey(turnId: "turn_1", path: "/Users/mike/dev/photo-sync/Sources/Upload/UploadTask.swift"), true)
            await scroll(app, toRow: "t:c3", offset: 60)
            await capture(window, dir.appendingPathComponent("8b-group-and-diffs.png"))
            await scroll(app, toRow: "cf:", offset: 120)
            await capture(window, dir.appendingPathComponent("8c-changes-card.png"))
        }
        // 7. Typing into the composer reaches the draft (it used to be dropped).
        if wanted("7") {
            app.select(nil)
            try? await Task.sleep(for: .milliseconds(300))
            if let composer = findComposer(in: window.contentView) {
                window.makeFirstResponder(composer)
                composer.insertText("Hello from the composer", replacementRange: composer.selectedRange())
                try? await Task.sleep(for: .milliseconds(300))
                print("composer: typed text, draft is now \"\(app.drafts["new"]?.text ?? "")\"")
                await capture(window, dir.appendingPathComponent("7-composer-typed.png"))
                // 7b. An image from the demo thread attached the way "+",
                // paste and drop attach one, with its remove badge showing.
                if let image = demoImage(app, "demo_upload_resume") {
                    let refs = await app.importImages([URL(fileURLWithPath: image)])
                    app.drafts["new", default: Draft()].images += refs
                    AttachmentThumbnail.debugShowRemove = true
                    try? await Task.sleep(for: .milliseconds(400))
                    await capture(window, dir.appendingPathComponent("7b-composer-image.png"))
                    AttachmentThumbnail.debugShowRemove = false
                }
                // 7c. A long draft: the box stops growing at ten lines and scrolls.
                app.drafts["new"] = Draft(text: (1...14).map { "Line \($0) of a long message" }.joined(separator: "\n"))
                try? await Task.sleep(for: .milliseconds(400))
                await capture(window, dir.appendingPathComponent("7c-composer-long.png"))
                app.drafts["new"] = nil
            } else {
                print("composer: not found")
            }
        }
        // 9. The pointer over an inbox row: Snooze and Archive in place of
        // its time.
        if wanted("9") {
            app.sidebarMode = .inbox
            await open(app, "demo_upload_resume")
            app.hoverOverride = "demo_settings_tabs"
            await capture(window, dir.appendingPathComponent("9-sidebar-hover.png"))
            app.hoverOverride = nil
        }
        // 10. What the other threads don't show, from an archived one: a
        // group with a failed tool, open, with its command and its key/value
        // tool opened; then a Write and the approval that allowed it (a line
        // in the group that doesn't open: the Write, opened, shows the file)
        // and an answered question.
        if wanted("10") {
            let thread = "demo_build_scripts"
            await open(app, thread)
            let session = app.session(for: thread)
            session.expanded.formUnion(["t:ls", "t:pr", "t:rel", "t:w"])
            session.setModelExpanded("g:t:ls", true)
            app.transcript.show(nil)
            app.transcript.show(session)
            await scroll(app, toRow: "u:", offset: 0)
            await capture(window, dir.appendingPathComponent("10a-tool-details.png"))
            await scroll(app, toRow: "t:w", offset: 20)
            await capture(window, dir.appendingPathComponent("10b-answered-cards.png"))
        }
        // 12. A Codex thread: the plan and the pictures it looked at and
        // made, its sub-agent's picture under the agent's line, and the end:
        // the turn that hit the usage limit with the line offering another
        // account, and footers with the time only.
        if wanted("12") {
            app.sidebarMode = .inbox
            let codex = "demo_codex_poster"
            await open(app, codex)
            await scroll(app, toRow: "p:", offset: 10)
            await capture(window, dir.appendingPathComponent("12a-codex-plan-and-images.png"))
            let session = app.session(for: codex)
            session.setModelExpanded("g:t:sa_1", true)
            await scroll(app, toRow: "g:t:sa_1", offset: 10)
            await capture(window, dir.appendingPathComponent("12b-codex-subagent-image.png"))
            session.setModelExpanded("g:t:sa_1", false)
            // 12d. The patch opened, each file named over its lines, and the
            // generated image opened to its prompt.
            session.expanded.formUnion(["t:call_patch", "t:ig_1"])
            session.setModelExpanded("g:t:call_patch", true)
            app.transcript.show(nil)
            app.transcript.show(session)
            await scroll(app, toRow: "t:call_patch", offset: 10)
            await capture(window, dir.appendingPathComponent("12d-codex-patch-and-prompt-open.png"))
            session.expanded.subtract(["t:call_patch", "t:ig_1"])
            session.setModelExpanded("g:t:call_patch", false)
            app.transcript.scrollToBottom()
            try? await Task.sleep(for: .milliseconds(400))
            await capture(window, dir.appendingPathComponent("12c-codex-limit-and-footers.png"))
        }
        // 13. The composer's pickers for a new thread with a runner older
        // than pools: the accounts with the room each has, then the model
        // picker on Claude and on Codex (its models, efforts up to Ultra).
        if wanted("13") {
            app.sidebarMode = .inbox
            app.select(nil)
            let hadPools = app.poolsSupported
            app.poolsSupported = false
            defer { app.poolsSupported = hadPools }
            try? await Task.sleep(for: .milliseconds(400))
            await capturePopover(window, dir.appendingPathComponent("13a-account-picker.png")) { app.accountPickerRequest += 1 }
            await capturePopover(window, dir.appendingPathComponent("13b-model-picker-claude.png")) { app.modelPickerRequest += 1 }
            // GPT-6.1-Sol at Ultra, the level only Codex has. Kept in this
            // run's own settings, which screenshots.sh throws away.
            app.newThreadAccount = "codex-main"
            app.remember(model: "gpt-6.1-sol", provider: "codex")
            app.remember(effort: "ultra", provider: "codex")
            try? await Task.sleep(for: .milliseconds(300))
            await capture(window, dir.appendingPathComponent("13c-composer-on-codex.png"))
            await capturePopover(window, dir.appendingPathComponent("13d-model-picker-codex.png")) { app.modelPickerRequest += 1 }
            app.remember(model: nil, provider: "codex")
            app.remember(effort: nil, provider: "codex")
            app.newThreadAccount = nil
        }
        // 15. Pools (docs/pools-plan.md). The new-thread composer on the
        // Claude pool and its picker, the picker on a mixed pool (models
        // under each provider), a thread pinned to one login with the
        // picker's login list open, a thread waiting for room, and
        // Settings › Pools and › Models.
        if wanted("15") {
            app.sidebarMode = .inbox
            app.select(nil)
            try? await Task.sleep(for: .milliseconds(400))
            await capture(window, dir.appendingPathComponent("15a-composer-on-a-pool.png"))
            await capturePopover(window, dir.appendingPathComponent("15b-picker-claude-pool.png")) { app.modelPickerRequest += 1 }
            app.newThreadPool = "side-projects"
            try? await Task.sleep(for: .milliseconds(300))
            await capturePopover(window, dir.appendingPathComponent("15c-picker-mixed-pool.png")) { app.modelPickerRequest += 1 }
            app.newThreadPool = nil
            await open(app, "demo_sqlite_vs_files")
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("15d-pinned-thread.png"))
            await capturePopover(window, dir.appendingPathComponent("15e-picker-pinned.png")) {
                app.modelPickerRequest += 1
            }
            await open(app, "demo_release_notes")
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("15f-waiting-for-room.png"))
            app.settingsTab = .pools
            app.settingsRequest += 1
            await waitUntil(5) { SettingsWindow.current?.isVisible == true }
            if let settings = SettingsWindow.current {
                settings.orderBack(nil)
                try? await Task.sleep(for: .milliseconds(600))
                await capture(settings, dir.appendingPathComponent("15g-settings-pools.png"))
                // Settings › Models: small jobs on the Claude pool.
                app.settingsTab = .models
                try? await Task.sleep(for: .milliseconds(600))
                await capture(settings, dir.appendingPathComponent("15h-settings-models.png"))
                // Settings › Runners: every runner in Mike's order, which
                // the phone shares, each with its drag handle.
                app.settingsTab = .runners
                try? await Task.sleep(for: .milliseconds(600))
                await capture(settings, dir.appendingPathComponent("15i-settings-runners.png"))
                // The top runner mid-drag, over the third slot, as nothing
                // can hold a real drag still to photograph it.
                app.settingsTab = .general
                app.runnerDragPreview = CGSize(width: 24, height: 84)
                try? await Task.sleep(for: .milliseconds(300))
                app.settingsTab = .runners
                try? await Task.sleep(for: .milliseconds(700))
                await capture(settings, dir.appendingPathComponent("15j-settings-runners-dragging.png"))
                // And past the top of the list, the nearest it gets to the group's edge.
                app.settingsTab = .general
                app.runnerDragPreview = CGSize(width: -40, height: -60)
                try? await Task.sleep(for: .milliseconds(300))
                app.settingsTab = .runners
                try? await Task.sleep(for: .milliseconds(700))
                await capture(settings, dir.appendingPathComponent("15k-settings-runners-drag-top.png"))
                app.runnerDragPreview = nil
                settings.close()
            } else {
                print("settings: the window didn't open")
            }
        }
        // 14. The Usage panel from the activity bar, under the threads:
        // every account's room, then the CLIs (Claude behind, Codex held
        // back).
        if wanted("14") {
            app.usageShown = true
            try? await Task.sleep(for: .milliseconds(600))
            await capture(window, dir.appendingPathComponent("14-usage-panel.png"))
            // 14b. After going back from a Codex version: it's held, with
            // that as the reason, and there's no "Go back" to it.
            _ = try? await app.client?.call("mock.clis", .object(["wentBack": .bool(true)]), as: JSONValue.self)
            try? await Task.sleep(for: .milliseconds(600))
            await capture(window, dir.appendingPathComponent("14b-usage-went-back.png"))
            app.usageShown = false
            try? await Task.sleep(for: .milliseconds(300))
        }
        // 15. The sidebar's Projects view: rows under a project's heading
        // name only the thread's other projects, or its folder.
        if wanted("15") {
            app.sidebarMode = .projects
            await open(app, "demo_ci_slow")
            try? await Task.sleep(for: .milliseconds(400))
            await capture(window, dir.appendingPathComponent("15-projects-view.png"))
            app.sidebarMode = .inbox
        }
        // 16. A durable design review, using the four actual account-picker
        // concepts. Its modeless window stays behind Mike's work as well.
        if wanted("16") {
            await open(app, "demo_design_review")
            app.transcript.scrollToBottom()
            await capture(window, dir.appendingPathComponent("16a-design-review-card.png"))
            if let review = app.session(for: "demo_design_review").model.items.compactMap({ row -> DesignReview? in
                if case .review(let review) = row.content { return review }
                return nil
            }).first {
                // In its own window, as a click on the card opens it.
                app.openReview(threadId: "demo_design_review", review: review)
                if let controller = app.reviewWindows["demo_design_review/" + review.id], let compare = controller.window {
                    let session = controller.session
                    compare.tuckBehind()
                    await capture(compare, dir.appendingPathComponent("16b-design-review-all.png"))
                    session.pick("B")
                    session.setNote("Keep the account override easy to find.", for: "B")
                    await session.saveNow()
                    await capture(compare, dir.appendingPathComponent("16c-design-review-picked.png"))
                    session.enlarge(1)
                    await capture(compare, dir.appendingPathComponent("16d-design-review-enlarged.png"))
                    session.zoom(.actual)
                    await capture(compare, dir.appendingPathComponent("16e-design-review-100-percent.png"))
                    controller.close()
                }
            }
        }
        // 17. The pane on the right: a thread's Highlights (a pin, files,
        // links, commits and the edited files), the pinned mockup previewed
        // in the pane, a Markdown file in Quick Look, and a list panel.
        if wanted("17") {
            app.sidebarMode = .inbox
            let thread = "demo_landing_pages"
            await open(app, thread)
            app.choosePanel(PaneSection.highlightsId, in: thread)
            await waitUntil(5) { app.highlights[thread] != nil }
            try? await Task.sleep(for: .milliseconds(400))
            await capture(window, dir.appendingPathComponent("17a-highlights.png"))
            if let summary = app.threads[thread], let fetched = app.highlights[thread] {
                if let pin = fetched.highlights.first(where: \.isPinned) {
                    app.open(pin, in: summary, external: false)
                    // The web view loads the file after the pane appears.
                    try? await Task.sleep(for: .milliseconds(1500))
                    await capture(window, dir.appendingPathComponent("17b-preview-mockup.png"))
                }
                if let doc = fetched.highlights.first(where: { $0.path?.hasSuffix(".md") == true }) {
                    app.open(doc, in: summary, external: false)
                    try? await Task.sleep(for: .milliseconds(1500))
                    await capture(window, dir.appendingPathComponent("17c-preview-markdown.png"))
                }
                app.closePreview(in: thread)
                if let list = summary.panels.first(where: { $0.kind == .list }) {
                    app.choosePanel(list.id, in: thread)
                    try? await Task.sleep(for: .milliseconds(1000))
                    await capture(window, dir.appendingPathComponent("17d-list-panel.png"))
                }
                app.choosePanel(PaneSection.highlightsId, in: thread)
            }
            // 17e. A thread whose last turn asked Mike for things: they
            // lead its Highlights, with the tick boxes the card has.
            await open(app, "demo_testflight_beta")
            app.choosePanel(PaneSection.highlightsId, in: "demo_testflight_beta")
            await waitUntil(5) { app.highlights["demo_testflight_beta"] != nil }
            try? await Task.sleep(for: .milliseconds(400))
            await capture(window, dir.appendingPathComponent("17e-needs-you.png"))
        }
        // 11. A runner restart: the quiet banner while it waits for threads
        // to finish, the reconnecting line while the runner is down, and
        // the thread it carried on, with the runner's message as a centred
        // note. Last, since it restarts the mock.
        if wanted("11") {
            app.sidebarMode = .inbox
            let thread = "demo_settings_tabs"
            await open(app, thread)
            app.transcript.scrollToBottom()
            let resume: JSONValue = .object(["threadId": .string(thread)])
            _ = try? await app.client?.call("mock.restartPending", .object(["resume": resume]), as: JSONValue.self)
            // The count comes with the notice; the threads' names (the
            // tooltip) with runner.status a moment later.
            await waitUntil(5) { app.banner?.detail != nil }
            await capture(window, dir.appendingPathComponent("11a-restart-pending.png"))
            _ = try? await app.client?.call("mock.restart", .object(["downMs": .number(3000)]), as: JSONValue.self)
            await waitUntil(5) { app.connection != .connected }
            await capture(window, dir.appendingPathComponent("11b-restart-reconnecting.png"))
            let before = app.threads[thread]?.lastSeq ?? 0
            // Mike would be looking at the thread it carries on, so it's read
            // when its turn ends; a scripted app never is in front, and the
            // shot showed it jump to Needs you with an unread dot.
            app.actsActive = true
            await waitUntil(20) {
                guard app.connection == .connected, let summary = app.threads[thread] else { return false }
                return summary.lastSeq > before && summary.status == .idle && !summary.needsYou
            }
            try? await Task.sleep(for: .milliseconds(400))
            app.transcript.scrollToBottom()
            await scroll(app, toRow: "n:", offset: 140)
            await capture(window, dir.appendingPathComponent("11c-restart-resumed.png"))
        }
        NSApp.terminate(nil)
    }

    /// A composer chip's popover, opened by `open` (a request the chip
    /// watches) and closed again the same way. It's a window of its own,
    /// so it's captured by its own id.
    private static func capturePopover(_ window: NSWindow, _ url: URL, after: (() -> Void)? = nil, open: () -> Void) async {
        open()
        try? await Task.sleep(for: .milliseconds(600))
        if let after {
            after()
            try? await Task.sleep(for: .milliseconds(600))
        }
        guard let popover = popoverWindow() else { return print("could not save \(url.path): the popover didn't open") }
        await capture(popover, url)
        open()
        try? await Task.sleep(for: .milliseconds(300))
    }

    private static func popoverWindow() -> NSWindow? {
        NSApp.windows.first { String(describing: type(of: $0)).contains("Popover") && $0.isVisible }
    }

    private static func waitUntil(_ seconds: Double, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    /// A fresh window's sidebar width, not saved back. screenshots.sh gives
    /// the build its own bundle id (so its own, empty defaults: it used to
    /// share Mike's and leave its window size in them); this keeps the
    /// shots right for a build run some other way.
    private static func freshSidebar(in window: NSWindow, app: AppModel) {
        // The dock's default layout, not saved back over the build's own.
        let onChange = app.dock.onChange
        app.dock.onChange = nil
        app.dock.layout = WindowDock.defaultLayout
        app.dock.onChange = onChange
    }

    /// The first image a demo thread's messages carry, if it's loaded.
    private static func demoImage(_ app: AppModel, _ id: String) -> String? {
        let session = app.session(for: id)
        for index in 0..<session.displayCount {
            switch session.displayRow(index).content {
            case .user(let message) where !message.images.isEmpty: return message.images[0].path
            case .images(_, let images, _) where !images.isEmpty: return images[0].path
            default: continue
            }
        }
        return nil
    }

    private static func findComposer(in view: NSView?) -> ComposerTextView? {
        guard let view else { return nil }
        if let composer = view as? ComposerTextView, !composer.inAnswerBox { return composer }
        for sub in view.subviews {
            if let found = findComposer(in: sub) { return found }
        }
        return nil
    }

    private static func open(_ app: AppModel, _ id: String) async {
        app.select(id)
        let session = app.session(for: id)
        for _ in 0..<200 where session.state != .loaded || app.transcript.session !== session {
            try? await Task.sleep(for: .milliseconds(20))
        }
        try? await Task.sleep(for: .milliseconds(500))
    }

    private static func scroll(_ app: AppModel, toRow prefix: String, offset: CGFloat) async {
        guard let session = app.transcript.session else { return }
        for index in 0..<session.displayCount where session.displayRow(index).id.hasPrefix(prefix) {
            app.transcript.scroll(toRow: index, offset: offset)
            break
        }
        try? await Task.sleep(for: .milliseconds(400))
    }

    private static func capture(_ window: NSWindow, _ url: URL) async {
        switch await save(window, to: url) {
        case .screencapture: print("saved \(url.path)")
        case .inProcess: print("saved \(url.path) (drawn in-process: screencapture gave no image, so the screen is locked or asleep, or this shell has no Screen Recording permission)")
        case nil: print("could not save \(url.path)")
        }
    }

    enum CaptureMethod: String {
        case screencapture
        case inProcess = "drawn in-process"
    }

    /// The window alone as a PNG: `screencapture -l` with its id (covered or
    /// not), or AppKit's own drawing of it when the window server has no
    /// image to give. Also the automation hook's `screenshot`.
    /// screencapture needs Screen Recording permission for whoever started
    /// this process: a shell that has it (screenshots.sh runs the binary from
    /// one), not an app launched with `open` (a dev-app.sh instance, which
    /// runs screencapture from the shell instead and passes false here).
    static func save(_ window: NSWindow, to url: URL, tryScreencapture: Bool = true) async -> CaptureMethod? {
        window.displayIfNeeded()
        try? await Task.sleep(for: .milliseconds(300))
        // A shot left from an earlier run would pass for this one below.
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !tryScreencapture { return drawInProcess(window, to: url) ? .inProcess : nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-o", "-x", "-l", String(window.windowNumber), url.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        // Off the main thread: waiting here held up the run loop.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in continuation.resume() }
            do { try process.run() } catch { continuation.resume() }
        }
        if FileManager.default.fileExists(atPath: url.path) { return .screencapture }
        // With the screen locked (or the display asleep) the window server
        // has no image of the window to give, and without the permission
        // screencapture writes nothing. AppKit can still draw it, with the
        // sidebar's glass as a flat fill.
        return drawInProcess(window, to: url) ? .inProcess : nil
    }

    /// The whole window (title bar and toolbar too) drawn by AppKit into a
    /// bitmap at the window's scale.
    private static func drawInProcess(_ window: NSWindow, to url: URL) -> Bool {
        guard let frameView = window.contentView?.superview else { return false }
        frameView.layoutSubtreeIfNeeded()
        // A label (NSTextField) draws its text twice in this pass: its own
        // cell, and the private subview that draws it on screen. Text in a
        // translucent colour came out far too bright (the work lines'
        // secondary label colour at 0.55 drew at about 0.8), so the
        // subviews sit this pass out. Shown again in the same run loop
        // turn, so the window on screen never changes.
        let doubled = descendants(of: frameView).filter { !$0.isHidden && String(describing: type(of: $0)) == "NSTextFieldSimpleLabel" }
        doubled.forEach { $0.isHidden = true }
        defer { doubled.forEach { $0.isHidden = false } }
        guard let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) else { return false }
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        redrawGlass(in: frameView, onto: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: url)) != nil
    }

    /// AppKit's own drawing of the window leaves a Liquid Glass panel (the
    /// sidebar) blank white: the panel's content sits under a plain layer
    /// that the caching pass skips. So each panel's content is drawn again
    /// on its own, over a flat fill with the glass's corners, in the grey it
    /// showed in real captures of the demo (pixel values, as this bitmap
    /// stores them), with the window's background around it.
    /// The title bar controls over a panel (the window buttons, the sidebar
    /// toggle) are skipped the same way, so they're drawn again on top.
    private static func redrawGlass(in frameView: NSView, onto rep: NSBitmapImageRep) {
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        func draw(_ view: NSView) {
            guard let viewRep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
            view.cacheDisplay(in: view.bounds, to: viewRep)
            viewRep.draw(in: view.convert(view.bounds, to: frameView), from: .zero, operation: .sourceOver,
                         fraction: 1, respectFlipped: false, hints: nil)
        }
        let views = descendants(of: frameView)
        var panels: [NSRect] = []
        // Dynamic colours (the window's background) in the window's look,
        // not the Mac's, for `--appearance`.
        frameView.effectiveAppearance.performAsCurrentDrawingAppearance {
            for case let glass as NSGlassEffectView in views {
                guard let content = glass.contentView else { continue }
                let frame = glass.convert(glass.bounds, to: frameView)
                if let around = glass.superview {
                    // The window's corners (26 pt on macOS 26) are cleared below.
                    frameView.window?.backgroundColor.setFill()
                    around.convert(around.bounds, to: frameView).fill()
                }
                let dark = glass.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                NSColor(white: dark ? 0.157 : 0.969, alpha: 1).setFill()
                NSBezierPath(roundedRect: frame, xRadius: 18, yRadius: 18).fill()
                draw(content)
                panels.append(frame)
            }
        }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { frameView.window?.standardWindowButton($0) }
        let toolbarItems = views.filter { String(describing: type(of: $0)) == "NSToolbarItemViewer" }
        for view in buttons + toolbarItems {
            let frame = view.convert(view.bounds, to: frameView)
            if panels.contains(where: { $0.intersects(frame) }) { draw(view) }
        }
        // Clear outside the window's rounded corners, as screencapture
        // leaves them: the glass's backdrop filled them in black.
        let outside = NSBezierPath(rect: frameView.bounds)
        outside.append(NSBezierPath(roundedRect: frameView.bounds, xRadius: 26, yRadius: 26))
        outside.windingRule = .evenOdd
        context.compositingOperation = .copy
        NSColor.clear.setFill()
        outside.fill()
    }

    private static func descendants(of view: NSView) -> [NSView] {
        view.subviews + view.subviews.flatMap { descendants(of: $0) }
    }
}
