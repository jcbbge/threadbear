import BearDock
#if DEBUG
import AppKit
import BearDock
import ThreadbearCore

/// Debug builds only, and only when launched with `--automation <log file>`:
/// lets a script or an agent drive the app through its own UI code paths
/// (the composer, the transcript's buttons and menus, archive and snooze)
/// without the window having to be in front. macOS gives an agent's process
/// no accessibility access to this window, and taking focus from whatever
/// Mike is typing into is worse, so the commands arrive as distributed
/// notifications instead. `Tools/dev-app.sh` and `Tools/drive.sh` post them.
///
/// Each command is a JSON object in the notification's `object` string;
/// each result is one line in the log file: `<cmd> ok ...` or
/// `<cmd> error ...`, starting `#<rid> ` when the command carried a `rid`
/// (dev-app.sh waits for its own). `--automation-id <id>` gives an instance
/// its own notification name and pasteboard, so several can run at once.
@MainActor
enum Automation {
    static let baseName = "com.mikerosoft.threadbear.automation"
    private(set) static var instanceId: String?
    static var logURL: URL?
    private static var observer: NSObjectProtocol?
    /// When the last command came in, for `--automation-idle-quit`.
    private static var lastCommandAt = Date()
    /// A transcript cell drawn as hovered by `hover`, to clear later.
    static weak var hoveredCell: RowCellView?

    /// The notification name and the private pasteboard's name for an
    /// instance (or the shared ones `drive.sh` uses).
    static func channel(id: String?) -> String {
        guard let id, !id.isEmpty else { return baseName }
        return "\(baseName).\(id)"
    }

    /// This instance's pasteboard: images pasted in and anything the app
    /// copies go through it, so Mike's clipboard is never touched.
    static var pasteboard: NSPasteboard { NSPasteboard(name: NSPasteboard.Name(channel(id: instanceId))) }

    static func argument(after flag: String, in arguments: [String] = CommandLine.arguments) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    /// Where the app's own log goes: `--app-log`, else beside the automation
    /// log (`drive.log` gives `drive.app.log`).
    static func appLogURL(automationLog: URL, arguments: [String] = CommandLine.arguments) -> URL {
        if let path = argument(after: "--app-log", in: arguments) { return URL(fileURLWithPath: path) }
        return automationLog.deletingPathExtension().appendingPathExtension("app.log")
    }

    /// A scripted app pointed at the installed runner's data folder would
    /// send, approve, archive and snooze in Mike's real threads (and the
    /// installed app is itself a debug build). It needs `--data-dir` (the
    /// mock or a dev runner), or `--automation-allow-live` from Mike.
    static func refusesLiveRunner(dataDir: URL, arguments: [String] = CommandLine.arguments) -> Bool {
        guard argument(after: "--automation", in: arguments) != nil, !arguments.contains("--automation-allow-live") else { return false }
        return dataDir.resolvingSymlinksInPath().standardizedFileURL.path
            == RunnerConfig.defaultDataDir.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Says why in the automation log (where the script waits for "ready")
    /// and on stderr, then exits before the app connects to anything.
    static func refuseLiveRunner() -> Never {
        let message = "error refusing to be scripted against the live runner's data folder: pass --data-dir (the mock or a dev runner; Tools/dev-app.sh does), or --automation-allow-live if Mike asked for it"
        if let path = argument(after: "--automation") {
            FileManager.default.createFile(atPath: path, contents: Data((message + "\n").utf8))
        }
        FileHandle.standardError.write(Data(("Threadbear: " + message + "\n").utf8))
        exit(2)
    }

    static func startIfAsked(app: AppModel) {
        guard let path = argument(after: "--automation") else { return }
        instanceId = argument(after: "--automation-id")
        // A dev-app.sh instance stays out of the Dock and the app switcher:
        // Mike Cmd-Tabbing into one by mistake and typing into its composer
        // would start a real turn on a dev runner. (dev-app.sh also marks
        // its bundle LSUIElement, so it's never there even at launch.)
        if instanceId != nil { NSApp.setActivationPolicy(.accessory) }
        let logURL = URL(fileURLWithPath: path)
        self.logURL = logURL
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        AppLog.writeFile(to: appLogURL(automationLog: logURL))
        AppLog.write("automation", "listening on \(channel(id: instanceId))")
        // Beside the log, so a scripted run can see HangWatch work (`stall`)
        // and never adds to the installed app's folder.
        HangWatch.start(folder: logURL.deletingLastPathComponent().appendingPathComponent("hangs"), build: nil) { frames, _ in
            AppLog.write("hang", "would report \(HangSample.deepestAppFrame(frames) ?? frames.last ?? "unknown")")
        }
        app.pasteboard = pasteboard
        if let mode = argument(after: "--appearance") { setAppearance(mode) }
        observer = DistributedNotificationCenter.default().addObserver(forName: Notification.Name(channel(id: instanceId)), object: nil, queue: .main) { note in
            let text = note.object as? String ?? ""
            MainActor.assumeIsolated { handle(text, app: app) }
        }
        Task {
            await keepBehind()
            log("ready")
        }
        // dev-app.sh passes it so an instance an agent never stopped (an
        // interrupted turn, a thread that ran out of context) doesn't sit
        // behind Mike's windows for good. Its mock runner exits with it.
        if let seconds = argument(after: "--automation-idle-quit").flatMap(Double.init), seconds > 0 {
            Task {
                while true {
                    try? await Task.sleep(for: .seconds(min(60, seconds)))
                    let idle = Date().timeIntervalSince(lastCommandAt)
                    guard idle >= seconds else { continue }
                    AppLog.write("automation", "quitting: no command for \(Int(idle)) s (--automation-idle-quit)")
                    log("quit idle for \(Int(idle)) s")
                    NSApp.terminate(nil)
                    return
                }
            }
        }
    }

    /// The window goes behind everything as soon as it's there, and is sized
    /// from `--window-size WxH`: a scripted run happens while Mike is
    /// working, and `screencapture -l` captures a covered window anyway.
    private static func keepBehind() async {
        for _ in 0..<200 where mainWindow == nil {
            try? await Task.sleep(for: .milliseconds(15))
        }
        guard let window = mainWindow else { return }
        window.tuckBehind()
        // Sizes set by a script aren't the user's: never saved as the
        // window's frame (a bundle that shares the installed app's id would
        // otherwise reopen Mike's window at them).
        window.setFrameAutosaveName("")
        if let size = argument(after: "--window-size").flatMap(parseSize) {
            window.setContentSize(size)
        }
    }

    static func parseSize(_ text: String) -> NSSize? {
        let parts = text.lowercased().split(separator: "x").compactMap { Double($0) }
        guard parts.count == 2, parts[0] > 0, parts[1] > 0 else { return nil }
        return NSSize(width: parts[0], height: parts[1])
    }

    static var mainWindow: NSWindow? {
        NSApp.windows.first { $0.isVisible && $0.contentView != nil && $0.frame.width > 600 && !($0 is DockPanelWindow) }
    }

    private static func handle(_ text: String, app: AppModel) {
        guard let data = text.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = command["cmd"] as? String else {
            log("error bad command \(text)")
            AppLog.write("automation", "bad command \(text)")
            return
        }
        let prefix = (command["rid"] as? String).map { "#\($0) " } ?? ""
        lastCommandAt = Date()
        AppLog.write("automation", text)
        Task {
            let result = await run(name, command, app: app)
            AppLog.write("automation", "\(name) \(result.count > 300 ? String(result.prefix(300)) + "…" : result)")
            log("\(prefix)\(name) \(result)")
            if name == "quit", result.hasPrefix("ok") {
                // After the result is written: terminate doesn't return.
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        }
    }

    /// Opens the Settings window on a tab (`tab`: general, models), kept
    /// behind Mike's windows like the main one, or closes it (`close`).
    /// Says the tab and what the window shows.
    private static func settings(_ c: [String: Any], app: AppModel) async -> String {
        if c["close"] as? Bool == true {
            SettingsWindow.current?.close()
            return "ok closed"
        }
        if let name = c["tab"] as? String {
            guard let tab = SettingsTab(rawValue: name) else {
                return "error tab must be one of \(SettingsTab.allCases.map(\.rawValue).joined(separator: ", "))"
            }
            app.settingsTab = tab
        }
        if SettingsWindow.current?.isVisible != true { app.settingsRequest += 1 }
        for _ in 0..<200 where SettingsWindow.current?.isVisible != true {
            try? await Task.sleep(for: .milliseconds(15))
        }
        guard let window = SettingsWindow.current, window.isVisible else { return "error the Settings window didn't open" }
        // {"front": true}: in front and key, for real events on a desktop
        // nobody's using (Tinker Desk). Says its number and where it is, top
        // left, in screen points. A gesture of SwiftUI's own ignores a window
        // that isn't key, so `point` can't reach those behind Mike's windows.
        if c["front"] as? Bool == true {
            // Floating: macOS can refuse a script's activate, and then a
            // normal window stays under whatever's in front.
            window.level = .floating
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
            window.orderFrontRegardless()
            let top = (NSScreen.screens.first?.frame.height ?? 0) - window.frame.maxY
            return "ok front \(window.windowNumber) \(Int(window.frame.minX)) \(Int(top))"
        }
        window.tuckBehind()
        // Let the tab switch and the window's new height settle.
        try? await Task.sleep(for: .milliseconds(400))
        // {"pair": true}: the Phone & browser tab's pairing code, as a sheet
        // over the window (capture it with `shot --settings --sheet`).
        if c["pair"] as? Bool == true {
            guard app.settingsTab == .devices else { return "error pair needs the devices tab" }
            app.pairRequest += 1
            for _ in 0..<200 where window.attachedSheet == nil {
                try? await Task.sleep(for: .milliseconds(15))
            }
            guard window.attachedSheet != nil else { return "error the pairing code didn't open: \(app.devicesError ?? "no error")" }
            try? await Task.sleep(for: .milliseconds(300))
        }
        let shown: String
        if let settings = app.runnerSettings {
            shown = json([
                "tab": app.settingsTab.rawValue,
                "defaultCwd": settings.defaultCwd,
                "idleMinutes": settings.idleMinutes,
                "maxLiveCLIs": settings.maxLiveCLIs,
                "followMain": settings.followMain,
                "bulletReplies": settings.bulletReplies,
                "oneReply": settings.oneReply,
                // "" is none (small jobs off), or an older runner with no pools.
                "smallJobsPool": settings.models.pool ?? "",
                "privateFolders": settings.models.privateFolders,
                "error": app.settingsError ?? "",
                "pools": app.pools.map { "\($0.id) \"\($0.title)\": " + $0.accountIds.joined(separator: ", ") + ($0.folders.isEmpty ? "" : " [" + $0.folders.joined(separator: ", ") + "]") },
                "poolsError": app.poolsError ?? "",
                // The Phone & browser tab: each paired device as one line,
                // the website, and why nothing can pair when sync is off.
                "devices": app.devices.map { "\($0.kind.rawValue) \"\($0.name)\": \(DeviceText.detail($0))" },
                "devicesSite": app.devicesSite ?? "",
                "devicesReason": app.devicesReason ?? "",
                "devicesError": app.devicesError ?? "",
                "pairingShown": SettingsWindow.current?.attachedSheet != nil,
            ] as [String: Any])
        } else {
            shown = json(["tab": app.settingsTab.rawValue, "unsupported": app.settingsUnsupported] as [String: Any])
        }
        return "ok \(window.windowNumber) " + shown
    }

    /// Milliseconds from `start` until the main run loop next goes idle:
    /// the SwiftUI update, layout and Core Animation commit a change sets
    /// off. The observer runs last of the run loop's, after SwiftUI's and
    /// Core Animation's own.
    private static func untilIdle(since start: CFAbsoluteTime) async -> Int {
        await withCheckedContinuation { (done: CheckedContinuation<Int, Never>) in
            nonisolated(unsafe) var observer: CFRunLoopObserver?
            observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, CFIndex.max) { _, _ in
                CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
                done.resume(returning: Int(((CFAbsoluteTimeGetCurrent() - start) * 1000).rounded()))
            }
            CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        }
    }

    private static func run(_ name: String, _ c: [String: Any], app: AppModel) async -> String {
        let window = mainWindow
        switch name {
        case "select":
            let match = thread(c["id"], app)
            guard let id = match.id else { return match.error }
            app.select(id)
            return "ok \(id)"
        case "open":
            // Select and wait until the thread's rows are on screen.
            let match = thread(c["id"], app)
            guard let id = match.id else { return match.error }
            if let thread = app.threads[id] {
                if thread.isArchived { app.showArchive() } else if thread.isSnoozed(at: Date()), !thread.isStarred { app.showHibernating() } else { app.sidebarMode = .inbox }
            }
            app.select(id)
            let session = app.session(for: id)
            let deadline = Date().addingTimeInterval(number(c["timeout"]) ?? 10)
            while Date() < deadline, session.state != .loaded || app.transcript.session !== session {
                if case .failed(let message) = session.state { return "error couldn't load: \(message)" }
                try? await Task.sleep(for: .milliseconds(20))
            }
            guard session.state == .loaded else { return "error timed out loading \(id)" }
            // A beat for the table to lay out and draw.
            try? await Task.sleep(for: .milliseconds(150))
            return "ok \(id) \(session.displayCount) rows"
        case "refusal":
            guard let id = app.selection, let thread = app.threads[id] else { return "error no thread selected" }
            guard let account = app.refusalTarget(for: thread) else { return "ok none" }
            if c["continue"] as? Bool == true { app.continueRefusal(id) }
            return "ok \(account.id) \(RefusalRecovery.model)"
        case "signin":
            // The selected thread's Sign in… line (SignInBanner): which
            // login it names, and with sendAgain its Send again button.
            guard let id = app.selection, let thread = app.threads[id] else { return "error no thread selected" }
            guard let account = app.signInAccount(for: thread) else { return "ok none" }
            if c["sendAgain"] as? Bool == true {
                app.sendAgain(id)
                return "ok sent again for \(account.id)"
            }
            return "ok \(account.id) \(account.provider)"
        case "subagent":
            // Show a sub-agent's transcript, as a click on its sidebar row
            // does: {"thread": id or prefix, "id": the sub-agent's id}.
            let match = thread(c["thread"] ?? app.selection, app)
            guard let threadId = match.id else { return match.error }
            guard let subagentId = c["id"] as? String, !subagentId.isEmpty else { return "error id is the sub-agent's id" }
            app.sidebarMode = .inbox
            app.selectSubagent(threadId: threadId, subagentId: subagentId)
            let session = app.subagentSession(for: SubagentRef(threadId: threadId, subagentId: subagentId))
            let deadline = Date().addingTimeInterval(number(c["timeout"]) ?? 10)
            while Date() < deadline, session.state != .loaded || app.transcript.session !== session {
                if case .failed(let message) = session.state { return session.missing ? "ok \(subagentId) no record" : "error couldn't load: \(message)" }
                try? await Task.sleep(for: .milliseconds(20))
            }
            guard session.state == .loaded else { return "error timed out loading \(subagentId)" }
            try? await Task.sleep(for: .milliseconds(150))
            return "ok \(subagentId) \(session.displayCount) rows"
        case "new":
            app.newThread()
            return "ok"
        case "open-panel":
            // A thread in a panel of its own, as the row's Open in New Panel.
            let match = thread(c["id"], app)
            guard let id = match.id else { return match.error }
            app.openThreadInPanel(id)
            try? await Task.sleep(for: .milliseconds(300))
            return "ok \(id)"
        case "dock-move":
            // A panel dragged to a side of the window, as a drag there does:
            // {"panel": "usage" (or a full id), "edge": "right"}.
            guard let name = c["panel"] as? String else { return "error panel is a panel id" }
            let panel = app.dock.layout.panels.first { $0 == name || $0 == "threadbear." + name } ?? name
            guard app.dock.layout.contains(panel) else { return "error \(name) isn't in the layout" }
            guard let edge = DockEdge(rawValue: c["edge"] as? String ?? "right") else { return "error edge is left, right, top or bottom" }
            app.dock.layout.move(panel, .window(edge))
            return "ok " + app.dock.layout.summary
        case "point":
            // Real events at a spot in the window, for SwiftUI controls with
            // nothing to find them by: {"cmd":"point","x":956,"y":265} clicks
            // (points from the window's top left), with "toX" and "toY" drags there,
            // and "scrollX"/"scrollY" is a wheel, in lines. They go straight
            // to the window, so Mike's pointer stays where it is.
            // {"review": id}: in that review's own window. {"settings": true}:
            // in the Settings window. "holdMs" waits with the button still
            // down at the end of a drag, for a `shot` of it mid-drag.
            let reviewWindow = (c["review"] as? String).flatMap { id in app.reviewWindows.values.first { $0.session.review.id == id }?.window }
            let settingsWindow = c["settings"] as? Bool == true ? SettingsWindow.current : nil
            guard let window = reviewWindow ?? settingsWindow ?? window, let x = c["x"] as? Double, let y = c["y"] as? Double else { return "error point needs x and y" }
            let at = { (px: Double) in NSPoint(x: px, y: window.frame.height - y) }
            // Anywhere on the way from the start to (toX, toY), `t` from 0 to 1.
            let endY = (c["toY"] as? Double) ?? y
            let along = { (t: Double, endX: Double) in NSPoint(x: x + (endX - x) * t, y: window.frame.height - (y + (endY - y) * t)) }
            if c["scrollX"] != nil || c["scrollY"] != nil {
                let lines = (Int32(c["scrollY"] as? Double ?? 0), Int32(c["scrollX"] as? Double ?? 0))
                guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: lines.0, wheel2: lines.1, wheel3: 0) else { return "error no event" }
                // A made-up wheel event has no window, so its location means
                // nothing to `sendEvent`: hand it to the view under the spot.
                guard let event = NSEvent(cgEvent: cg), let frame = window.contentView?.superview,
                      let view = frame.hitTest(at(x)) else { return "error nothing there" }
                view.scrollWheel(with: event)
                try? await Task.sleep(for: .milliseconds(300))
                // Says where each scroll view around the spot ended up, so a
                // caller can see which of them took it.
                var scrolls: [String] = []
                var ancestor: NSView? = view
                while let current = ancestor {
                    if let scroll = current as? NSScrollView, let document = scroll.documentView {
                        let clip = scroll.contentView.bounds
                        scrolls.append("at \(Int(clip.minX)),\(Int(clip.minY)) of \(Int(document.frame.width))x\(Int(document.frame.height)) in \(Int(clip.width))x\(Int(clip.height))")
                    }
                    ancestor = current.superview
                }
                return "ok " + scrolls.joined(separator: "; ")
            }
            let mouse = { (type: NSEvent.EventType, point: NSPoint) in
                NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            }
            guard let down = mouse(.leftMouseDown, at(x)) else { return "error no event" }
            let end = (c["toX"] as? Double) ?? x
            // A text view's mouseDown waits in its own loop for the button to
            // come up, so a click on its words (a link, a chip) has the up
            // queued first, or the main thread sits there for good.
            if end == x, endY == y, window.contentView?.superview?.hitTest(at(x)) is NSTextView, let up = mouse(.leftMouseUp, at(x)) {
                NSApp.postEvent(up, atStart: false)
                window.sendEvent(down)
                try? await Task.sleep(for: .milliseconds(350))
                return "ok"
            }
            window.sendEvent(down)
            try? await Task.sleep(for: .milliseconds(40))
            if end != x || endY != y {
                for step in 1...8 {
                    if let drag = mouse(.leftMouseDragged, along(Double(step) / 8, end)) { window.sendEvent(drag) }
                    try? await Task.sleep(for: .milliseconds(16))
                }
            }
            if let hold = c["holdMs"] as? Double { try? await Task.sleep(for: .milliseconds(hold)) }
            if let up = mouse(.leftMouseUp, along(1, end)) { window.sendEvent(up) }
            try? await Task.sleep(for: .milliseconds(350))
            return "ok"
        case "mouse-button":
            // A mouse's back or forward button over the window, as the
            // event AppKit gives MouseNavigation's monitor. A made-up event
            // has no window of its own, so it's handed the main one.
            guard let window else { return "error no window" }
            let number: Int64
            switch c["button"] as? String {
            case "back": number = 3
            case "forward": number = 4
            default: return "error button is back or forward"
            }
            guard let cg = CGEvent(mouseEventSource: nil, mouseType: .otherMouseDown, mouseCursorPosition: .zero,
                                   mouseButton: CGMouseButton(rawValue: UInt32(number)) ?? .center) else { return "error no event" }
            guard let event = NSEvent(cgEvent: cg) else { return "error no event" }
            guard MouseNavigation.handle(event, in: window, app: app) else { return "error not taken (not the main window?)" }
            let place = app.place
            return "ok \(place.mode) \(place.threadId ?? "new") back=\(app.canGoBack) forward=\(app.canGoForward)"
        case "menu-key":
            // A key equivalent through the main menu, as a press of it
            // would go: {"key": "down", "modifiers": ["cmd", "opt"]}. Says
            // whether a menu item took it, the open thread and any
            // end-of-inbox note.
            guard let key = c["key"] as? String else { return "error key missing" }
            let named: [String: Int] = ["down": NSDownArrowFunctionKey, "up": NSUpArrowFunctionKey,
                                        "left": NSLeftArrowFunctionKey, "right": NSRightArrowFunctionKey]
            let chars = named[key].map { String(Character(UnicodeScalar($0)!)) } ?? key
            var flags: NSEvent.ModifierFlags = []
            for m in c["modifiers"] as? [String] ?? [] {
                switch m {
                case "cmd": flags.insert(.command)
                case "opt": flags.insert(.option)
                case "ctrl": flags.insert(.control)
                case "shift": flags.insert(.shift)
                default: return "error modifier is cmd, opt, ctrl or shift"
                }
            }
            if named[key] != nil { flags.formUnion([.numericPad, .function]) }
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                               windowNumber: window?.windowNumber ?? 0, context: nil, characters: chars,
                                               charactersIgnoringModifiers: chars, isARepeat: false, keyCode: 0) else { return "error no event" }
            let taken = NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false
            try? await Task.sleep(for: .milliseconds(150))
            let note = app.inboxEndNote.map { $0.empty ? " note=empty" : " note=end" } ?? ""
            return "ok taken=\(taken) selection=\(app.selection ?? "none")\(note)"
        case "options":
            return options(c, app: app)
        case "review":
            return await designReview(c, app: app)
        case "type":
            // `"focused": true` types where the cursor is instead (a card's
            // Something else box, say), as keys would.
            if c["focused"] as? Bool == true {
                guard let field = window?.firstResponder as? NSTextView, field.isEditable else { return "error the cursor isn't in a text box" }
                field.insertText(c["text"] as? String ?? "", replacementRange: field.selectedRange())
                return "ok " + ((field as? ComposerTextView)?.inAnswerBox == true ? "answer box" : "text box")
            }
            guard let composer = findComposer(in: window?.contentView) else { return "error no composer" }
            window?.makeFirstResponder(composer)
            // `replace` takes the text view's whole text: clearing only the
            // draft reaches the view on SwiftUI's next update, after this
            // insert, and the old text would come back.
            let range = c["replace"] as? Bool == true ? NSRange(location: 0, length: (composer.string as NSString).length) : composer.selectedRange()
            composer.insertText(c["text"] as? String ?? "", replacementRange: range)
            return "ok"
        case "paste":
            // `text` pasted into the composer as ⌘V would, through a private
            // pasteboard so Mike's clipboard is left alone.
            guard let composer = findComposer(in: window?.contentView) else { return "error no composer" }
            window?.makeFirstResponder(composer)
            let board = NSPasteboard(name: .init("com.mikerosoft.threadbear.automation-paste"))
            board.clearContents()
            board.setString(c["text"] as? String ?? "", forType: .string)
            defer { board.releaseGlobally() }
            // The type-less call, as ⌘V makes it: it picks the type itself,
            // which isn't `.string` (ComposerTextView.isPlainText).
            return composer.readSelection(from: board) ? "ok" : "error paste refused"
        case "return":
            // `"shift": true` for Shift-Return (a new line, carrying a list on).
            // `"focused": true` presses it where the cursor is, as `type` does,
            // with `"command": true` for ⌘Return.
            if c["focused"] as? Bool == true {
                return pressAtCursor(window, characters: "\r", keyCode: 36, modifiers: c["command"] as? Bool == true ? .command : [])
            }
            return pressReturn(window, shift: c["shift"] as? Bool == true)
        case "escape":
            // The Escape key, where the cursor is.
            return pressAtCursor(window, characters: "\u{1b}", keyCode: 53)
        case "arrow":
            // {"cmd":"arrow","dir":"down"} (or "up"), where the cursor is:
            // the composer's slash command palette moves its pick.
            let up = c["dir"] as? String == "up"
            return pressAtCursor(window, characters: String(UnicodeScalar(up ? 0xF700 : 0xF701)!), keyCode: up ? 126 : 125)
        case "tab":
            // The Tab key, where the cursor is.
            return pressAtCursor(window, characters: "\t", keyCode: 48)
        case "rename":
            // No title: the open thread's title becomes a field, as a click
            // does. With one: saves it, as Return in that field does.
            guard let id = app.selection else { return "error no thread open" }
            if let title = c["title"] as? String {
                app.renamingThread = nil
                app.rename(id, to: title)
            } else {
                app.startRenaming(id)
            }
            return "ok"
        case "send":
            // Types `text` (if given, replacing the draft with `replace` as
            // `type` does) and presses Return, as Mike would.
            if let text = c["text"] as? String {
                guard let composer = findComposer(in: window?.contentView) else { return "error no composer" }
                window?.makeFirstResponder(composer)
                let range = c["replace"] as? Bool == true ? NSRange(location: 0, length: (composer.string as NSString).length) : composer.selectedRange()
                composer.insertText(text, replacementRange: range)
            }
            let fromNew = app.selection == nil
            let known = Set(app.threads.keys)
            let pressed = pressReturn(window)
            guard pressed == "ok" else { return pressed }
            guard fromNew else { return "ok \(app.selection ?? "")" }
            // From the new-thread composer: wait for the thread it made, so
            // its id is there for tb show, tb export or waitFor's thread.
            let wait = number(c["timeout"]) ?? 10
            let deadline = Date().addingTimeInterval(wait)
            while Date() < deadline {
                if let id = app.selection, !known.contains(id) { return "ok \(id)" }
                // A refused send puts the text back in the box with a banner.
                if let message = app.errorMessage, app.drafts["new"].map({ !$0.text.isEmpty }) == true { return "error not sent: \(message)" }
                try? await Task.sleep(for: .milliseconds(50))
            }
            return "error sent, but no new thread showed up within \(Int(wait)) s"
        case "paste-image":
            // `"focused": true` pastes where the cursor is (an ask's box), as `type` does.
            let target = c["focused"] as? Bool == true ? window?.firstResponder as? ComposerTextView : findComposer(in: window?.contentView)
            guard let path = c["path"] as? String, let composer = target else { return "error no composer" }
            let board = pasteboard
            board.clearContents()
            board.writeObjects([URL(fileURLWithPath: path) as NSURL])
            return composer.takeImages(from: board) ? "ok" : "error not an image"
        case "drop":
            // {"cmd":"drop","path":…,"x":,"y":} drops a file at that spot in
            // the window (points from its top left), on the view AppKit would
            // pick: the deepest one under it signed up for a type it has. `"hover":
            // true` stops before the drop, so a shot shows the mark;
            // `"leave": true` drags back off. Errors list the views under it.
            guard let window = mainWindow, let content = window.contentView,
                  let x = c["x"] as? Double, let y = c["y"] as? Double else { return "error drop needs x and y" }
            let board = pasteboard
            if let path = c["path"] as? String {
                board.clearContents()
                board.writeObjects([URL(fileURLWithPath: path) as NSURL])
            }
            let point = NSPoint(x: x, y: window.frame.height - y)
            let hit = content.superview?.hitTest(point) ?? content.hitTest(point)
            var view = hit
            // As AppKit does: the first view up from the one under the
            // pointer signed up for any type the drag has.
            let types = Set(board.types ?? [])
            while let v = view, types.isDisjoint(with: v.registeredDraggedTypes) { view = v.superview }
            guard let target = view else {
                var chain: [String] = []
                var v = hit
                while let each = v { chain.append("\(type(of: each))\(each.registeredDraggedTypes.isEmpty ? "" : "\(each.registeredDraggedTypes.map(\.rawValue))")"); v = each.superview }
                return "error nothing takes files there: \(chain.joined(separator: " < "))"
            }
            // AppKit's own views (an image view, say) want more of a drag
            // than this stand-in has, so those are only named.
            guard target is ComposerDropView || target is ComposerTextView else {
                return "error \(type(of: target)) would get it, not the composer"
            }
            let drag = AutomationDrag(pasteboard: board, window: window, location: point)
            if c["leave"] as? Bool == true {
                target.draggingExited(drag)
                return "ok left \(type(of: target))"
            }
            let operation = target.draggingEntered(drag)
            _ = target.draggingUpdated(drag)
            if c["hover"] as? Bool == true { return "ok \(type(of: target)) \(operation.rawValue)" }
            let dropped = target.performDragOperation(drag)
            target.concludeDragOperation(drag)
            target.draggingEnded(drag)
            return dropped ? "ok dropped on \(type(of: target))" : "error \(type(of: target)) turned it away"
        case "browser":
            // {"cmd":"browser","do":"click|right|scroll|key|type","x":,"y":,...}: real
            // NSEvents to the Browser panel's page, in the page's own points,
            // through the window as Mike's would go, without the pointer.
            guard let window = mainWindow, let content = window.contentView,
                  let view = all(AgentSurfaceView.self, in: content).last(where: { !$0.isHiddenOrHasHiddenAncestor })
            else { return "error no browser panel" }
            return view.automate(c, in: window)
        case "click":
            // A visible, enabled button in the transcript with this title,
            // or this accessibility label for an icon-only one. `tip` instead
            // presses a SwiftUI control with that tooltip, through the window
            // as a real click would go, without moving the pointer.
            if let tip = c["tip"] as? String {
                // {"settings": true}: in the Settings window (open it with `settings`).
                guard let window = c["settings"] as? Bool == true ? SettingsWindow.current : mainWindow, let content = window.contentView,
                      let anchor = all(TipAnchorView.self, in: content).last(where: { $0.text == tip && !$0.isHiddenOrHasHiddenAncestor })
                else { return "error no control with the tip \(tip)" }
                let center = anchor.convert(NSPoint(x: anchor.bounds.midX, y: anchor.bounds.midY), to: nil)
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    guard let event = NSEvent.mouseEvent(with: type, location: center, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                         windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
                    else { return "error no event" }
                    window.sendEvent(event)
                }
                return "ok"
            }
            guard let title = c["title"] as? String else { return "error no title" }
            let buttons = all(NSButton.self, in: app.transcript.tableView)
                .filter { ($0.title == title || $0.accessibilityLabel() == title) && $0.isEnabled && !$0.isHiddenOrHasHiddenAncestor }
            guard let button = buttons.last else { return "error no button \(title)" }
            button.performClick(nil)
            return "ok"
        case "click-at":
            // A click at a point in the main window, in points from its
            // top left, through the window as a real one goes, without moving
            // the pointer. For what has no tooltip to find it by.
            guard let window, let x = c["x"] as? Double, let y = c["y"] as? Double else { return "error needs x and y" }
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: window.frame.height - y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
                else { return "error no event" }
                window.sendEvent(event)
            }
            return "ok"
        case "press-button":
            // {"cmd":"press-button","id":"b7k2abcd"} (or "title":"Fill in the
            // form") clicks a reply button in the open thread as its pill
            // would: presses it, or opens the thread a pressed one started.
            let ids = (app.transcript.session?.model.rows ?? []).flatMap { row -> [String] in
                if case .assistant(let item) = row.content { return ReplyButtons.ids(in: item.text) }
                return []
            }
            let id = (c["id"] as? String).flatMap { want in ids.last { $0 == want } }
                ?? (c["title"] as? String).flatMap { want in ids.last { ReplyButtons.shared.known($0)?.button.title == want } }
            guard let id else { return "error no reply button like that in the open thread" }
            guard ReplyButtons.shared.known(id) != nil else { return "error button \(id) isn't known" }
            app.pressReplyButton(id, from: app.transcript.session?.threadId)
            return "ok"
        case "ask":
            // {"cmd":"ask","row":"ak:6","action":"pick:0:1"} clicks an open
            // asks card's button: "pick:<ask>:<choice>" or "link:<ask>:<link>",
            // 0-based, "page:<n>" on a paged card, "collapse", or the done card's "next:<n>", "explain:<n>" or "archive".
            guard let id = c["row"] as? String, let action = c["action"] as? String,
                  case .asks(let card)? = app.transcript.session?.model.row(id: id)?.content else { return "error no asks card" }
            guard card.isOpen else { return "error that card is closed" }
            app.transcript.askAction(card, action: action)
            return "ok"
        case "archive":
            // `id`, else the open thread. These used to ignore `id` and act
            // on whatever was open, which against a dev runner archived (and
            // interrupted) a thread the agent never named.
            let target = target(c, app)
            guard let id = target.id else { return target.error }
            app.archive(id)
            return "ok \(id)"
        case "star", "unstar":
            let target = target(c, app)
            guard let id = target.id else { return target.error }
            app.setStarred(id, name == "star")
            return "ok \(id)"
        case "milestone":
            // Scripted runs never earn the note, so this is how to see it.
            app.milestoneNote = MilestoneNote(tier: c["tier"] as? Int ?? 1000)
            return "ok"
        case "undo-archive":
            // The Archived note's Undo.
            guard let id = app.archivedNote?.threadId else { return "error no archived note" }
            app.undoArchive()
            return "ok \(id)"
        case "open-archived":
            // A click on the Archived note.
            guard let id = app.archivedNote?.threadId else { return "error no archived note" }
            app.openArchivedNote()
            return "ok \(id)"
        case "unarchive":
            let target = target(c, app)
            guard let id = target.id else { return target.error }
            app.unarchive(id)
            return "ok \(id)"
        case "snooze":
            let target = target(c, app)
            guard let id = target.id else { return target.error }
            // {"cmd":"snooze","said":"at the weekend"} is Wake when… without its text box.
            if let said = c["said"] as? String {
                app.hibernateWhen(id, said: said)
                return "ok \(id)"
            }
            app.snooze(id, until: Date().addingTimeInterval(number(c["seconds"]) ?? 3600))
            return "ok \(id)"
        case "panel":
            // {"cmd":"panel","id":"convex.dashboard"} shows that section of
            // the selected thread's pane (threadbear.highlights and
            // threadbear.patches are the rail's own); {"cmd":"panel","show":false}
            // hides the pane, {"cmd":"panel","show":true} shows it;
            // {"cmd":"panel"} toggles. On a project's page, the project's.
            guard let thread = app.paneThread else { return "error no thread selected" }
            if let id = c["id"] as? String {
                let ids = (app.openProject == nil ? [PaneSection.highlightsId, AgentBrowser.panelId, BuiltinPanels.files] : []) + thread.panels.map(\.id) + (thread.patches.isEmpty ? [] : [PaneSection.patchesId])
                guard ids.contains(id) else { return "error no panel \(id); this thread has \(ids.joined(separator: ", "))" }
                app.choosePanel(id, in: thread.id)
            } else if let show = c["show"] as? Bool {
                app.panelsShown = show
            } else {
                app.togglePanels()
            }
            // A beat for the pane (and a web view) to appear.
            try? await Task.sleep(for: .milliseconds(200))
            return "ok \(app.showsPanels(for: thread) ? "showing \(app.paneSection(for: thread).id)" : "hidden")"
        case "stall":
            // Blocks the main thread, to try what a freeze does: `seconds`.
            usleep(UInt32((c["seconds"] as? Double ?? 6) * 1_000_000))
            return "ok"
        case "convex":
            // Select through the same model as the panel's deployment menu.
            guard let thread = app.selectedThread,
                  let panel = thread.panels.first(where: { $0.convex != nil }),
                  let configured = panel.convex else { return "error no Convex cloud panel" }
            if let deployment = c["deployment"] as? String {
                switch await app.convexPanelDeployments(threadId: thread.id, panelId: panel.id) {
                case .success(let listed):
                    guard listed.deployments.contains(where: { $0.deployment == deployment }) else { return "error unknown deployment" }
                    WebPanelPool.shared.selectConvex(deployment, for: configured)
                case .failure(let error): return "error \(error.localizedDescription)"
                }
                try? await Task.sleep(for: .milliseconds(200))
            }
            return "ok \(WebPanelPool.shared.selectedConvex(configured)) browser=\(WebPanelPool.shared.convexBrowserURL(configured)?.absoluteString ?? "none")"
        case "float":
            // {"cmd":"float","id":"threadbear.highlights"} opens a panel in a
            // window of its own, as its menu's Open in New Window does;
            // {"cmd":"float","id":…,"back":true} puts it back in the dock.
            guard let id = c["id"] as? String else { return "error float needs an id" }
            if c["back"] as? Bool == true {
                guard app.dock.layout.isFloating(id) else { return "error \(id) isn't in a window of its own" }
                app.dock.putBack(id)
            } else {
                guard app.dock.layout.canFloat(id) else { return "error \(id) can't go into a window of its own (not in the dock, or the last panel there)" }
                app.dock.openInWindow(id)
            }
            try? await Task.sleep(for: .milliseconds(300))
            return "ok \(app.dock.layout.summary)"
        case "preview":
            // {"cmd":"preview","path":"/abs/file.md"} or {"cmd":"preview",
            // "url":"http://localhost:3000"} opens it in the selected
            // thread's pane, as "Preview here" does; {"cmd":"preview",
            // "close":true} goes back to the section. Over a text file,
            // "edit" true or false is the bar's pencil or Done, "insert"
            // types text at the end of the editor (and waits for the
            // save, unless "wait" is false), "save" true is ⌘S, and
            // "resolve" ("file" or "mine") is the conflict bar's button.
            guard let thread = app.selectedThread else { return "error no thread selected" }
            if c["save"] as? Bool == true {
                guard let controller = TextFileController.current, app.panePreview[thread.id]?.editing == true else {
                    return "error nothing is being edited"
                }
                controller.saveNow()
                return "ok \(controller.conflict != nil ? "changed on disk, so not saved; " : "")file ends \(((try? String(contentsOf: controller.url, encoding: .utf8)) ?? "").suffix(40).debugDescription)"
            }
            if c["close"] as? Bool == true {
                app.closePreview(in: thread.id)
            } else if c["back"] as? Bool == true {
                app.previewBack(in: thread.id)
            } else if let editing = c["edit"] as? Bool {
                guard app.panePreview[thread.id]?.fileURL != nil else { return "error no file is open in the pane" }
                app.setPreviewEditing(editing, in: thread.id)
            } else if let text = c["insert"] as? String {
                guard let controller = TextFileController.current, app.panePreview[thread.id]?.editing == true else {
                    return "error nothing is being edited"
                }
                controller.insertAtEnd(text)
                if c["wait"] as? Bool != false { try? await Task.sleep(for: .seconds(1.2)) }
                return "ok editor ends \(String(controller.textView.string.suffix(40)).debugDescription), file ends \(((try? String(contentsOf: controller.url, encoding: .utf8)) ?? "").suffix(40).debugDescription)"
            } else if let side = c["resolve"] as? String {
                guard let controller = TextFileController.current, let fileText = controller.conflict else { return "error no conflict to resolve" }
                if side == "file" { controller.useFile(fileText) } else { controller.keepMine() }
                try? await Task.sleep(for: .milliseconds(300))
                return "ok editor ends \(String(controller.textView.string.suffix(40)).debugDescription), file ends \(((try? String(contentsOf: controller.url, encoding: .utf8)) ?? "").suffix(40).debugDescription)"
            } else if let path = c["path"] as? String {
                app.preview(path: path, in: thread)
            } else if let text = c["url"] as? String, let url = URL(string: text) {
                app.preview(page: url, title: HighlightText.address(url.absoluteString), in: thread)
            } else {
                return "error preview needs path, url or close"
            }
            try? await Task.sleep(for: .milliseconds(300))
            return "ok \(app.panePreview[thread.id].map { "showing \($0.title)" } ?? "no preview")"
        case "folder":
            // {"cmd":"folder","open":"name"} is a double-click on that row of
            // the folder showing in the pane, "select" a click, "expand" its
            // triangle; "up" true is ⌘↑, "mode" "list" or "icons" the bar's
            // button, "sort" a column ("name", "modified", "size", with
            // "ascending"), "hidden" true or false is ⌘⇧., "quickLook" true
            // says what the space bar would show. "click" is a press on a row
            // through the window ("count" 2 for a double-click), "key" a key code ("command",
            // "shift", "characters"), "crumb" a path bar folder, "pathBar" true
            // its words, "menu" a row's right-click menu ("" the empty space's),
            // "choose" one of its items (with "row", or the empty space's).
            // Each says what's showing.
            guard let pane = FolderPaneView.current else { return "error no folder is showing in the pane" }
            if let mode = c["mode"] as? String {
                guard let mode = FolderViewMode(rawValue: mode) else { return "error mode is list or icons" }
                FolderViewMode.current = mode
            }
            if let key = (c["sort"] as? String).flatMap(FolderSort.Key.init(rawValue:)) {
                pane.setSort(FolderSort(key: key, ascending: c["ascending"] as? Bool ?? true))
            }
            if let hidden = c["hidden"] as? Bool { pane.setShowHidden(hidden) }
            if let name = c["expand"] as? String, !pane.expand(name: name) { return "error no folder called \(name)" }
            if let name = c["select"] as? String, !pane.select(name: name) { return "error no row called \(name)" }
            if c["quickLook"] as? Bool == true {
                try? await Task.sleep(for: .milliseconds(300))
                return "ok would look at \(pane.quickLookPaths())"
            }
            if let name = c["open"] as? String, !pane.open(name: name) { return "error no row called \(name)" }
            if let name = c["click"] as? String, !pane.debugClick(name: name, count: (c["count"] as? Int) ?? 1) { return "error no row called \(name)" }
            if let code = c["key"] as? Int {
                var modifiers: NSEvent.ModifierFlags = []
                if c["command"] as? Bool == true { modifiers.insert(.command) }
                if c["shift"] as? Bool == true { modifiers.insert(.shift) }
                pane.debugKey(UInt16(code), characters: c["characters"] as? String ?? "", modifiers: modifiers)
            }
            if let name = c["crumb"] as? String, !pane.debugPickCrumb(name) { return "error no folder called \(name) in the path bar" }
            if c["pathBar"] as? Bool == true { return "ok \(pane.debugPathBar)" }
            if let title = c["choose"] as? String, !pane.debugChoose(title, name: c["row"] as? String) { return "error no menu item \(title)" }
            if let name = c["menu"] as? String { return "ok \(pane.debugMenu(name: name.isEmpty ? nil : name).joined(separator: " | "))" }
            if c["up"] as? Bool == true { pane.goUp() }
            try? await Task.sleep(for: .milliseconds(500))
            return "ok \(app.panePreview[app.selectedThread?.id ?? ""].map { "showing \($0.title)" } ?? "no preview"); \(FolderPaneView.current?.summary ?? "no folder")"
        case "action":
            // {"cmd":"action","id":"reseed.reseed-dev-db"} runs that action of
            // the selected thread and waits for a command to finish.
            guard let thread = app.selectedThread else { return "error no thread selected" }
            guard let id = c["id"] as? String, let action = thread.actions.first(where: { $0.id == id }) else {
                return "error no action \(c["id"] ?? ""); this thread has \(thread.actions.map(\.id).joined(separator: ", "))"
            }
            app.runAction(action, in: thread.id)
            let deadline = Date().addingTimeInterval(number(c["timeout"]) ?? 60)
            while Date() < deadline, app.isRunning(action: action, in: thread.id) {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if app.isRunning(action: action, in: thread.id) { return "error \(id) still running after the timeout" }
            try? await Task.sleep(for: .milliseconds(150))
            return "ok ran \(id)"
        case "running":
            // Shows `count` threads as running, in this app only (the runner
            // isn't told), as Mike's sidebar has on a busy day, and says how
            // much of the main thread `seconds` of doing nothing then takes.
            let count = c["count"] as? Int ?? 10
            let idle = app.threads.values.filter { !$0.isArchived && $0.status == .idle }.sorted { $0.lastActivityAt > $1.lastActivityAt }
            for var thread in idle.prefix(count) {
                thread.status = .running
                thread.lastActivityAt = Date().addingTimeInterval(-Double.random(in: 5...300))
                app.threads[thread.id] = thread
            }
            let seconds = c["seconds"] as? Double ?? 5
            try? await Task.sleep(for: .seconds(1))
            let start = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1_000_000
            try? await Task.sleep(for: .seconds(seconds))
            let used = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1_000_000 - start
            let running = app.threads.values.filter { $0.status == .running }.count
            return String(format: "ok %d running, main thread %.0f%% busy doing nothing", running, used / (seconds * 10))
        case "bump":
            // Stands in for thread.updated from a running thread (its preview
            // and activity change), `count` times `gap` ms apart (default 20,
            // 150), and says the main thread's CPU time a bump, less what the
            // same wait costs with no bumps. For checking what one update
            // costs the window.
            let ids = app.threads.keys.sorted()
            let id = c["id"] as? String
            guard let key = id.map({ id in ids.first { $0.hasPrefix(id) } }) ?? ids.first, app.threads[key] != nil else { return "error no such thread" }
            let count = max(1, c["count"] as? Int ?? 20)
            let gap = c["gap"] as? Int ?? 150
            func cpu() -> Double { Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1_000_000 }
            var start = cpu()
            for _ in 0..<count { try? await Task.sleep(for: .milliseconds(gap)) }
            let idle = (cpu() - start) / Double(count)
            start = cpu()
            for n in 0..<count {
                guard var thread = app.threads[key] else { break }
                thread.preview = "Working on it \(n)"
                thread.lastActivityAt = Date()
                app.threads[key] = thread
                try? await Task.sleep(for: .milliseconds(gap))
            }
            let busy = (cpu() - start) / Double(count)
            return String(format: "ok %.1f ms a bump (%.1f ms with none)", busy - idle, idle)
        case "page-scroll":
            // Scrolls the detail area's scroll view `dy` points a frame for
            // `steps` frames, down then back up (only down with "back":
            // false), moving its clip view as a trackpad would, and says how
            // the frames went. Only means something with the window in front.
            guard let window, let content = window.contentView else { return "error no window" }
            let point = content.convert(NSPoint(x: content.bounds.width * 0.55, y: content.bounds.height * 0.5), to: nil)
            func scrollViews(in view: NSView) -> [NSScrollView] {
                view.subviews.flatMap { scrollViews(in: $0) } + ((view as? NSScrollView).map { [$0] } ?? [])
            }
            // The innermost one under the point: the page's, not the window's.
            guard let scroll = scrollViews(in: content).first(where: { $0.convert($0.bounds, to: nil).contains(point) && ($0.documentView?.frame.height ?? 0) > $0.bounds.height }) else { return "error no scroll view there" }
            let dy = c["dy"] as? Double ?? 14
            let steps = c["steps"] as? Int ?? 120
            let clip = scroll.contentView
            let top = clip.bounds.minY
            // "updates": n stands in for n thread.updated a second from
            // running threads (as `bump`), to see what they cost mid-scroll.
            let updates = c["updates"] as? Double ?? 0
            let busy = Array(app.threads.keys.sorted().prefix(8))
            var step = 0
            let watch = FrameWatch(view: content)
            watch?.start()
            for direction in (c["back"] as? Bool == false ? [1.0] : [1.0, -1.0]) {
                for _ in 0..<steps {
                    step += 1
                    if updates > 0, !busy.isEmpty, step % max(1, Int((60 / updates).rounded())) == 0, var thread = app.threads[busy[step % busy.count]] {
                        thread.preview = "Working on it \(step)"
                        thread.lastActivityAt = Date()
                        app.threads[thread.id] = thread
                    }
                    let maxY = (scroll.documentView?.frame.height ?? 0) - clip.bounds.height
                    let y = min(max(top, clip.bounds.minY + direction * dy * (clip.isFlipped ? 1 : -1)), max(top, maxY))
                    clip.scroll(to: NSPoint(x: clip.bounds.minX, y: y))
                    scroll.reflectScrolledClipView(clip)
                    try? await Task.sleep(for: .milliseconds(16))
                }
                try? await Task.sleep(for: .milliseconds(200))
            }
            return "ok " + (watch?.stop() ?? "no frames") + String(format: ", ended at %.0f", clip.bounds.minY)
        case "front":
            // Brings the window in front of everything, for frame timings.
            guard let window else { return "error no window" }
            // Out of tuckBehind's level first: ordering front within it
            // left the window under every normal one, so nobody saw it.
            window.level = .normal
            NSApp.activate()
            window.orderFrontRegardless()
            return "ok"
        case "mode":
            let started = CFAbsoluteTimeGetCurrent()
            switch c["mode"] as? String {
            case "archive": app.showArchive()
            case "snoozed": app.showHibernating()
            case "scheduled": app.showSchedules()
            case "projects":
                guard app.projectsSupported else { return "error this runner has no projects" }
                app.showProjects()
            case "librarian":
                guard app.projectsSupported else { return "error this runner has no projects" }
                app.showLibrarian()
            default: app.sidebarMode = .inbox
            }
            // "time": true says how long the switch held up the main thread,
            // for checking the Projects page opens quickly.
            // With "frames": true it also watches the next second of frames
            // (the slide and the page drawing in): how many, the longest
            // gap and how many missed a 60 Hz frame. Only means something
            // with the window on screen ("front").
            if c["time"] as? Bool == true {
                let watch = c["frames"] as? Bool == true ? window.flatMap { FrameWatch(view: $0.contentView) } : nil
                watch?.start()
                let ms = await untilIdle(since: started)
                guard let watch else { return "ok \(ms) ms" }
                try? await Task.sleep(for: .seconds(1))
                return "ok \(ms) ms; " + watch.stop()
            }
            return "ok"
        case "schedule":
            // The schedule editor: {"id": "sc_…"} edits one; without an id
            // it's a new one, from the open thread's composer (its draft
            // too) unless {"from": "none"}, as the Scheduled view's button.
            if let id = c["id"] as? String {
                guard app.schedule(id) != nil else { return "error no schedule \(id)" }
                app.editSchedule(id)
            } else if c["from"] as? String == "none" {
                app.newSchedule(from: nil)
            } else {
                app.newSchedule(from: app.selectedThread, draftKey: app.selection ?? "new")
            }
            // {"runner": "bruce"}: a new schedule's Runs on, by name or id,
            // as picking it would set it. Set before the sheet first draws,
            // since the editor takes its state once.
            if let runner = c["runner"] as? String, var state = app.scheduleEditor, state.isNew {
                guard let match = app.runners.first(where: { $0.id == runner || $0.name == runner }) else {
                    app.scheduleEditor = nil
                    return "error no runner \(runner); there are \(app.runners.map(\.name).joined(separator: ", "))"
                }
                if !match.isSelf {
                    state.threadId = nil
                    state.runnerId = match.id
                    state.cwd = ""
                    app.scheduleEditor = state
                }
            }
            try? await Task.sleep(for: .milliseconds(400))
            return "ok"
        case "project":
            // {"cmd":"project","id":"p_…"} opens a project's page in the
            // detail area; {"cmd":"project","close":true} closes it.
            if c["close"] as? Bool == true {
                app.openProjectId = nil
                return "ok"
            }
            guard let id = c["id"] as? String else {
                return "error give an id: \(app.projects.map(\.id).joined(separator: ", "))"
            }
            guard app.project(id) != nil else { return "error no project \(id); there are \(app.projects.map(\.id).joined(separator: ", "))" }
            app.openProjectPage(id)
            try? await Task.sleep(for: .milliseconds(200))
            return "ok"
        case "close-schedule":
            app.scheduleEditor = nil
            return "ok"
        case "sort":
            // The Inbox heading's sort menu.
            guard let order = (c["order"] as? String).flatMap(InboxOrder.init(rawValue:)) else {
                return "error order must be one of \(InboxOrder.allCases.map(\.rawValue).joined(separator: ", "))"
            }
            app.inboxOrder = order
            return "ok"
        case "search":
            // The search at the top of the inbox, as typing in it does; ""
            // clears it. "projects": true is the Projects page's search
            // instead, and answers with the cards it leaves, in order.
            if c["projects"] as? Bool == true {
                app.projectSearchQuery = c["text"] as? String ?? ""
                return "ok " + json(ProjectCard.matching(app.projectCards, app.projectSearchQuery).map(\.project.title))
            }
            app.searchQuery = c["text"] as? String ?? ""
            return "ok"
        case "expand", "collapse":
            if let key = c["highlightSection"] as? String {
                // A Highlights heading, as clicking it does (`HighlightFold`).
                if name == "expand" { app.collapsedHighlights.remove(key) } else { app.collapsedHighlights.insert(key) }
                return "ok"
            }
            if let raw = c["scheduleSection"] as? String {
                // A Scheduled heading, as clicking it does.
                guard let section = ScheduleSection(rawValue: raw) else {
                    return "error scheduleSection must be one of \(ScheduleSection.allCases.map(\.rawValue).joined(separator: ", "))"
                }
                if name == "expand" { app.collapsedScheduleSections.remove(section) } else { app.collapsedScheduleSections.insert(section) }
                return "ok"
            }
            if let raw = c["section"] as? String {
                // An inbox heading, as clicking it does.
                guard let section = InboxSection(rawValue: raw) else {
                    return "error section must be one of \(InboxSection.allCases.map(\.rawValue).joined(separator: ", "))"
                }
                if name == "expand" { app.collapsedSections.remove(section) } else { app.collapsedSections.insert(section) }
                return "ok"
            }
            return setExpanded(c, open: name == "expand", app: app)
        case "scroll":
            switch c["to"] as? String {
            case "top":
                app.transcript.scroll(toRow: 0, offset: 0)
                return "ok"
            case "bottom":
                app.transcript.scrollToBottom()
                return "ok"
            default:
                return scroll(toRow: c["row"] as? String, offset: number(c["offset"]) ?? 0, app: app)
            }
        case "scroll-to":
            return scroll(toRow: c["row"] as? String, offset: number(c["offset"]) ?? 0, app: app)
        case "bottom":
            app.transcript.scrollToBottom()
            return "ok"
        case "resize", "size":
            guard var window else { return "error no window" }
            // {"review": id}: that review's own window instead (the site's clips record it at the
            // main window's size).
            if let id = c["review"] as? String {
                guard let review = app.reviewWindows.values.first(where: { $0.session.review.id == id })?.window else { return "error that review isn't open" }
                window = review
            }
            window.setContentSize(NSSize(width: number(c["w"]) ?? 1240, height: number(c["h"]) ?? 820))
            let size = AppDump.contentSize(window)
            return "ok \(Int(size.width))x\(Int(size.height))"
        case "appearance":
            guard let mode = c["mode"] as? String, ["light", "dark", "system"].contains(mode) else { return "error mode is light, dark or system" }
            setAppearance(mode)
            // Layer colours and cached renders are resolved for a look;
            // give AppKit a moment to redraw in the new one.
            try? await Task.sleep(for: .milliseconds(200))
            return "ok \(mode)"
        case "voice-stage":
            // Shows Voice mode's bear in a phase, with no microphone or
            // engine (screenshots of the avatar); "off" puts it away.
            guard let id = app.selection else { return "error no thread is open" }
            // The experiment, for this look only: the mock's hello hasn't it.
            app.experiments.insert(VoiceMode.experiment)
            let words = c["text"] as? String ?? ""
            let level = Float(number(c["level"]) ?? 0)
            switch c["phase"] as? String {
            case "listening": VoiceMode.shared.stage(.listening, threadId: id, level: level)
            case "hearing": VoiceMode.shared.stage(.hearing(words), threadId: id, level: level)
            case "thinking": VoiceMode.shared.stage(.thinking, threadId: id, level: level)
            case "speaking": VoiceMode.shared.stage(.speaking, threadId: id, level: level)
            case "starting": VoiceMode.shared.stage(.starting(words.isEmpty ? "Getting ready…" : words), threadId: id, level: level)
            case "off": VoiceMode.shared.stage(.off, threadId: nil, level: 0)
            default: return "error phase is listening, hearing, thinking, speaking, starting or off"
            }
            try? await Task.sleep(for: .milliseconds(300))
            return "ok"
        case "zoom":
            // What ⌘=, ⌘- and ⌘0 do, or a percent from TextZoom.steps.
            let zoom = TextZoom.shared
            switch c["to"] as? String {
            case "in": zoom.zoomIn()
            case "out": zoom.zoomOut()
            case "reset": zoom.reset()
            case nil:
                if let percent = number(c["percent"]).map({ Int($0) }) {
                    guard TextZoom.steps.contains(percent) else { return "error percent is one of \(TextZoom.steps)" }
                    zoom.set(percent)
                }
            default: return "error to is in, out or reset"
            }
            try? await Task.sleep(for: .milliseconds(100))
            return "ok \(zoom.percent)"
        case "hover":
            return hover(c, app: app)
        case "activity":
            return await activity(c, app: app)
        case "edit-message":
            // Clicks the pencil by one of Mike's messages (`row`: its row id
            // or a prefix), as he would, which loads it into the composer
            // to edit. `{"cmd":"edit-message","cancel":true}` leaves the edit.
            if c["cancel"] as? Bool == true {
                guard let id = app.selection else { return "error no thread open" }
                app.cancelEditing(threadId: id)
                return "ok"
            }
            guard let prefix = c["row"] as? String, let row = displayedRow(prefix, app),
                  let index = app.transcript.session?.displayIndex(of: row.id) else { return "error no such row" }
            app.transcript.scroll(toRow: index, offset: 120)
            guard let cell = app.transcript.tableView.view(atColumn: 0, row: index, makeIfNecessary: true) as? TextRowCell else { return "error row isn't drawn" }
            guard !cell.edit.isHidden || cell.debugHover(true) else { return "error \(row.id) can't be edited" }
            cell.edit.performClick(nil)
            _ = cell.debugHover(false)
            try? await Task.sleep(for: .milliseconds(100))
            guard let id = app.selection, let edit = app.editing[id] else { return "error the edit didn't start" }
            return "ok editing seq \(edit.seq)"
        case "swipe":
            return await swipe(c, app: app)
        case "page-swipe":
            return await pageSwipe(c, app: app)
        case "decide":
            return decide(c, app: app)
        case "hints":
            ShortcutHints.shared.setShowing(c["on"] as? Bool ?? true)
            try? await Task.sleep(for: .milliseconds(100))
            return "ok \(ShortcutHints.shared.showing)"
        case "setup":
            // Finish setting up: {"show": true|false} opens or closes its
            // panel, {"hidden": true|false} as Hide this list and Help's
            // Finish Setting Up set it. Says each item, [x] when done.
            if let hidden = c["hidden"] as? Bool { SetupState.shared.hidden = hidden }
            if let show = c["show"] as? Bool { app.setupShown = show }
            try? await Task.sleep(for: .milliseconds(300))
            let checklist = app.setupChecklist
            let items = checklist.items.map { "[\($0.done ? "x" : " ")] \($0.item.rawValue)" }.joined(separator: ", ")
            return "ok \(checklist.left) left, icon \(app.setupShowsIcon ? "shown" : "hidden"), panel \(app.setupShown ? "open" : "closed"): \(items)"
        case "tour":
            // {"do": "start"|"next"|"back"|"end"}, or nothing to just read
            // where it's at. Says the step, its title and what it lights up.
            let tour = Tour.shared
            // {"intros": true}: the views' first-open intros, off in a
            // scripted app so its pages aren't covered.
            if let on = c["intros"] as? Bool { tour.introsEnabled = on }
            switch c["do"] as? String {
            // A scripted start is the first-run one (no Skip) unless
            // {"skippable": true}, as Help's replay is.
            case "start": tour.start(skippable: c["skippable"] as? Bool ?? false)
            case "next": tour.next()
            case "back": tour.back()
            case "end": tour.finish()
            // What a change to the runner's pools does: the pools card,
            // if a pool has a second login and the tour's been seen.
            case "pools": tour.introducePools(app.pools)
            case nil: break
            default: return "error do is start, next, back, end or pools"
            }
            // The card and spotlight's move to settle before a shot.
            try? await Task.sleep(for: .milliseconds(400))
            guard let step = tour.step, let current = tour.current else { return "ok off" }
            let lit = tour.frame(for: current).map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? "nothing"
            return "ok \(step + 1)/\(tour.shown.count) \(current.title)\(current.task == nil ? "" : tour.taskDone ? " (done)" : " (to do)") lit: \(lit)"
        case "trust":
            // {"cmd":"trust"} does what Patches' Trust button does for every
            // patch the selected thread has waiting; {"cmd":"trust","id":"tools"}
            // for one.
            guard let thread = app.selectedThread else { return "error no thread selected" }
            let waiting = thread.patches.filter { $0.untrusted != nil && (c["id"] == nil || $0.id == c["id"] as? String) }
            guard !waiting.isEmpty else { return "error nothing waiting to be trusted" }
            app.trustPatches(waiting, in: thread.id)
            return "ok " + waiting.map(\.id).joined(separator: " ")
        case "chip":
            return chip(c, app: app)
        case "link":
            // A work:, thread: or review: link in a row's text, followed as a click
            // on it would be (TranscriptController.openThreadLink).
            // Escaped after the scheme only, as the markdown's would be.
            guard let row = c["row"] as? String, let raw = c["url"] as? String, let colon = raw.firstIndex(of: ":"),
                  let url = URL(string: raw[...colon] + (raw[raw.index(after: colon)...].addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")) else { return "error link needs row and a work:, thread: or review: url" }
            app.transcript.openThreadLink(url, fromRow: row)
            return "ok"
        case "peek":
            return peek(c, app: app)
        case "composer-peek":
            guard let composer = findComposer(in: window?.contentView) else { return "error no composer" }
            guard let number = c["number"] as? Int else {
                composer.debugEndHover()
                return "ok"
            }
            return composer.debugHoverChip(number).map { "ok window \($0)" } ?? "error no chip \(number) with a card"
        case "select-text":
            return select(c, app: app)
        case "den":
            // Threadbear > About Threadbear, through the menu item itself.
            guard let menu = NSApp.mainMenu?.items.first?.submenu,
                  let index = menu.items.firstIndex(where: { $0.title == "About Threadbear" }) else { return "error no About Threadbear in the app menu" }
            menu.update()
            menu.performActionForItem(at: index)
            try? await Task.sleep(for: .milliseconds(200))
            return DenWindow.current?.isVisible == true ? "ok " + menu.items.prefix(3).map(\.title).joined(separator: " | ") : "error the Den didn't open"
        case "room":
            // Every login's room, as the honey pot and Usage see it:
            // {"percent": 44}. Lasts until the runner next says otherwise.
            guard let percent = c["percent"] as? Double else { return "error needs percent" }
            app.accounts = app.accounts.map {
                var account = $0
                account.usage = AccountUsage(windows: [UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: percent)])
                return account
            }
            return "ok"
        case "account-ids":
            // For screenshots: accounts are titled by their email address,
            // so show their ids instead. Lasts until the next reconnect.
            app.accounts = app.accounts.map {
                Account(id: $0.id, provider: $0.provider, title: $0.id, configDir: $0.configDir, defaultModel: $0.defaultModel, models: $0.models)
            }
            return "ok"
        case "status":
            return "ok " + status(app)
        case "streaming":
            // The text of every row still streaming, as the table has it.
            guard let session = app.transcript.session else { return "error no thread open" }
            var out: [String: String] = [:]
            for index in 0..<session.displayCount {
                let row = session.displayRow(index)
                switch row.content {
                case .assistant(let item) where item.isStreaming: out[item.itemId] = item.text
                case .reasoning(let item) where item.isStreaming: out[item.itemId] = item.text
                default: break
                }
            }
            return "ok " + json(out)
        case "sidebar":
            // The inbox's rows by section, as the sidebar lists them: only
            // the search's matches while it has text.
            let sections = app.sections.matching(app.searchQuery)
            let object: [String: Any] = [
                "starred": sections.starred.map(\.id), "needsYou": sections.needsYou.map(\.id), "running": sections.running.map(\.id),
                "inbox": sections.inbox.map(\.id), "snoozed": sections.hibernating.count, "archived": sections.archived.count,
                "hover": app.hoverOverride ?? "", "search": app.searchQuery,
            ]
            return "ok " + json(object)
        case "dump":
            let dump = AppDump.make(app: app, window: window, instance: instanceId)
            let text = c["format"] as? String == "text" ? dump.text : dump.json(pretty: c["out"] != nil)
            guard let out = c["out"] as? String else { return "ok " + dump.json(pretty: false) }
            if let refused = refusesToWrite(out) { return refused }
            do {
                try text.write(toFile: out, atomically: true, encoding: .utf8)
            } catch {
                return "error couldn't write \(out): \(error.localizedDescription)"
            }
            return "ok \(out)"
        case "screenshot":
            guard let path = c["path"] as? String, path.hasPrefix("/") else { return "error path must be absolute" }
            if let refused = refusesToWrite(path) { return refused }
            guard var window else { return "error no window" }
            // {"den": true}: About Threadbear (open it with `den`).
            if c["den"] as? Bool == true, let den = DenWindow.current { window = den }
            // {"review": id}: its own window.
            if let id = c["review"] as? String {
                if let review = app.reviewWindows.values.first(where: { $0.session.review.id == id })?.window {
                    window = review
                } else {
                    return "error that review isn't open"
                }
            }
            // The Settings window first, so {"settings": true, "sheet": true}
            // is the sheet over it (the pairing code).
            if c["settings"] as? Bool == true {
                guard let settings = SettingsWindow.current, settings.isVisible else { return "error the Settings window isn't open" }
                window = settings
            }
            if c["sheet"] as? Bool == true {
                guard let sheet = window.attachedSheet else { return "error no sheet" }
                window = sheet
            }
            // A dev-app.sh instance never runs screencapture itself: its temp
            // bundle has no Screen Recording permission (the capture is
            // refused, and macOS may ask Mike for it). dev-app.sh's shot runs
            // screencapture from the agent's shell first, with this window's
            // id from `window`, and asks for the in-process drawing only
            // when that gives no image.
            let tryScreencapture = instanceId == nil && c["inProcess"] as? Bool != true
            guard let method = await ScreenshotRunner.save(window, to: URL(fileURLWithPath: path), tryScreencapture: tryScreencapture) else { return "error couldn't capture the window" }
            return "ok \(path) (\(method.rawValue))"
        case "window":
            // The window's id for `screencapture -l`, once anything pending
            // has been drawn (as `screenshot` waits).
            guard var window else { return "error no window" }
            // {"review": id}: its own window.
            if let id = c["review"] as? String {
                if let review = app.reviewWindows.values.first(where: { $0.session.review.id == id })?.window {
                    window = review
                } else {
                    return "error that review isn't open"
                }
            }
            // {"settings": true}: the Settings window (open it with `settings`).
            if c["settings"] as? Bool == true {
                guard let settings = SettingsWindow.current, settings.isVisible else { return "error the Settings window isn't open" }
                window = settings
            }
            // {"sheet": true}: the sheet over it (the schedule editor, or the
            // pairing code over Settings), a window of its own that a
            // capture of the one under it leaves out.
            if c["sheet"] as? Bool == true {
                guard let sheet = window.attachedSheet else { return "error no sheet" }
                window = sheet
            }
            // {"panel": id}: a panel's window of its own (see `float`).
            if let id = c["panel"] as? String {
                guard let panel = NSApp.windows.first(where: { ($0 as? DockPanelWindow)?.panel == id && $0.isVisible }) else { return "error \(id) has no window of its own" }
                window = panel
            }
            // {"popover": true}: the popover that's up (an ⓘ's, say), a window
            // of its own that a capture of the one under it leaves out.
            if c["popover"] as? Bool == true {
                guard let popover = NSApp.windows.last(where: { $0.isVisible && String(describing: type(of: $0)).contains("Popover") }) else { return "error no popover" }
                window = popover
            }
            window.displayIfNeeded()
            try? await Task.sleep(for: .milliseconds(300))
            let size = AppDump.contentSize(window)
            return "ok \(window.windowNumber) \(Int(size.width))x\(Int(size.height))"
        case "settings":
            return await settings(c, app: app)
        case "shortcuts":
            return await shortcuts(c)
        case "focus":
            // The app acts as if it were in front, so a thread that's open
            // gets marked read the way it does when Mike looks at it. It is
            // never activated: a scripted app stays behind his windows.
            let on = c["on"] as? Bool ?? true
            app.actsActive = on
            if on { app.appBecameActive() }
            return "ok \(on ? "on" : "off")"
        case "error":
            // Puts text in the error bar, as a failure would (its
            // Investigate button needs one to show); no text clears it.
            if let text = c["text"] as? String {
                app.showError(text, in: c["threadId"] as? String, doing: c["doing"] as? String)
            } else {
                app.errorMessage = nil
            }
            return "ok"
        case "waitFor":
            return await waitFor(c, app: app)
        case "menu":
            return menu(c, app: app)
        case "composer-menu":
            return composerMenu(c, app: app)
        case "menu-popover":
            return menuPopover(c, app: app)
        case "realMenu":
            return realMenu(c, window: window)
        case "drag-space":
            return dragSpace(c)
        case "usage":
            // The Usage panel: {"show": true} opens it ({"show": false}
            // closes it), {"click": "Update"} presses one of the Updates
            // panel's buttons for a CLI ({"provider": "codex"}), and
            // with neither it lists what it says.
            return usage(c, app: app)
        case "share":
            // The selected thread's sharing (protocol "Sharing"):
            // {"access": "off" | "link"} sets it through the same call as the
            // popover, {"open": true} opens the popover (false closes it).
            // Says the access and link.
            guard let thread = app.selectedThread else { return "error no thread is open" }
            if let raw = c["access"] as? String {
                guard let access = ThreadShare.Access(rawValue: raw) else { return "error access is off or link" }
                do {
                    try await app.share(thread.id, access: access)
                } catch {
                    return "error \(error.localizedDescription)"
                }
            }
            if let open = c["open"] as? Bool {
                app.sharePopoverThread = open ? thread.id : nil
                try? await Task.sleep(for: .milliseconds(400))
            }
            let share = app.threads[thread.id]?.share
            let link = share.flatMap { $0.isOn ? app.shareLink($0)?.absoluteString : nil } ?? "none"
            let web = app.threadWebLink(thread.id)?.absoluteString ?? "none"
            return "ok access \(share?.access.rawValue ?? "off") link \(link) popover \(app.sharePopoverThread == thread.id ? "shown" : "closed") web \(web)"
        case "updates":
            // The Updates panel: {"show": true} opens it ({"show": false}
            // closes it). {"rightClick": true} right-clicks the icon, which
            // opens or closes the app's update popover ({"popover": false}
            // closes it). {"preview": "staged" | "building" | "failed" |
            // "none"} makes up the app's update first, for screenshots.
            // With nothing, whether the icon has its dot, its tooltip,
            // whether the popover is up and what it says, and what the
            // panel says about the app and runner.
            if let state = c["preview"] as? String {
                guard ["staged", "building", "failed", "none"].contains(state) else { return "error preview is staged, building, failed or none" }
                AppUpdater.shared.previewUpdate(state)
            }
            if c["rightClick"] as? Bool == true {
                // A made-up right-click through the app's own event
                // dispatch, so it's the icon's monitor that takes it.
                guard let window,
                      let icon = all(RightClickView.self, in: window.contentView).first(where: { $0.identifier?.rawValue == "updates" })
                else { return "error no updates icon" }
                let center = icon.convert(NSPoint(x: icon.bounds.midX, y: icon.bounds.midY), to: nil)
                guard let event = NSEvent.mouseEvent(with: .rightMouseDown, location: center, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
                else { return "error no event" }
                NSApp.sendEvent(event)
                try? await Task.sleep(for: .milliseconds(500))
                return "ok popover \(app.updatePopoverShown ? "shown" : "closed")"
            }
            if let popover = c["popover"] as? Bool {
                app.updatePopoverShown = popover
                try? await Task.sleep(for: .milliseconds(300))
                return "ok popover \(app.updatePopoverShown ? "shown" : "closed")"
            }
            if let show = c["show"] as? Bool {
                app.updatesShown = show
                guard show else { return "ok closed" }
                RunLoop.main.run(until: Date().addingTimeInterval(0.5))
                return app.updatesShown ? "ok shown" : "error the panel didn't open"
            }
            let side = UpdatesPanel.appSide(AppUpdater.shared)
            let shown = UpdatesText.shown(app: side, runner: app.runnerUpdates)
            let tip = UpdatesText.iconTooltip(app: side, runner: app.runnerUpdates, clis: app.clis)
            let popover = "popover: " + (app.updatePopoverShown ? "shown, " : "closed, ") + UpdatesText.popoverLine(side)
            return "ok " + json(["shown: \(shown)", "tip: " + tip.replacingOccurrences(of: "\n", with: " / "), popover, UpdatesText.appLine(side)] + UpdatesText.runnerLines(app.runnerUpdates))
        case "project-why":
            // The ⓘ popover on a project's heading in the open thread's
            // Highlights: {"id": "<project id>"} opens it, {"id": null}
            // closes it. Says who put the thread there and why.
            guard let id = c["id"] as? String else {
                app.projectWhyShown = nil
                return "ok closed"
            }
            guard let thread = app.selectedThread,
                  let m = thread.projects.first(where: { $0.id.hasPrefix(id) }) else { return "error the open thread isn't in \(id)" }
            app.projectWhyShown = m.id
            let (who, reason) = HighlightProjects.why(m)
            return "ok " + json([reason ?? "(no reason)", who] + (HighlightProjects.canKeep(m) ? ["Keep"] : []) + ["Take out", "Open project"])
        case "runners":
            // The Runners panel: {"show": true} opens it ({"show": false}
            // closes it), {"open": "<runner id or name>"} opens or closes
            // that runner's details. With neither, the icon's tooltip and
            // each runner's line.
            // {"stats": true} asks for the figures now, as the panel does
            // every 10 s while it can be seen (a scripted window can't).
            if c["stats"] as? Bool == true {
                app.loadRunnerStats()
                try? await Task.sleep(for: .milliseconds(500))
                return "ok " + json(app.runnerStats.values.sorted { $0.runnerId < $1.runnerId }.map { s in
                    "\(s.runnerId): " + RunnersText.gauges(s).map { "\($0.title) \($0.text)" }.joined(separator: ", ")
                })
            }
            if let which = c["open"] as? String {
                guard let r = app.runners.first(where: { $0.id == which || $0.name == which }) else { return "error no runner \(which)" }
                var ids = Set((UserDefaults.standard.string(forKey: "runnersPanelOpen") ?? "").split(separator: ",").map(String.init))
                if ids.contains(r.id) { ids.remove(r.id) } else { ids.insert(r.id) }
                UserDefaults.standard.set(ids.sorted().joined(separator: ","), forKey: "runnersPanelOpen")
                return "ok " + (ids.contains(r.id) ? "open" : "closed")
            }
            if let show = c["show"] as? Bool {
                app.runnersShown = show
                guard show else { return "ok closed" }
                try? await Task.sleep(for: .milliseconds(500))
                return app.runnersShown ? "ok shown" : "error the panel didn't open"
            }
            let running = app.sections.running
            return "ok " + json([RunnersText.tooltip(app.runners)] + app.runners.map { r in
                let count = RunnersText.running(on: r, in: running).count
                return "\(r.name): \(RunnersText.stateLine(r, now: Date()))\(RunnersText.build(r).map { ", " + $0 } ?? "")\(count > 0 ? ", \(count) running" : "")"
            })
        case "connectors":
            // The Connectors panel: {"show": true} opens it ({"show":
            // false} closes it), {"click": "<service id>"} presses its
            // Connect button (which opens the page in the browser). With
            // neither, the icon's dots and tooltip and each service's line.
            if let show = c["show"] as? Bool {
                app.connectorsShown = show
                guard show else { return "ok closed" }
                try? await Task.sleep(for: .milliseconds(500))
                return app.connectorsShown ? "ok shown" : "error the panel didn't open"
            }
            let status = app.connectors
            if let id = c["click"] as? String {
                guard let service = status?.services.first(where: { $0.id == id }) else { return "error no service \(id)" }
                guard ConnectorsText.buttonTitle(service) != nil else { return "error \(id) has no button" }
                app.openConnect(service)
                return "ok opened \(service.connectUrl ?? "")"
            }
            guard let status else { return "error the runner has no connectors" }
            let lines = status.services.map { s in "\(s.id): \(ConnectorsText.stateLine(s))" + (ConnectorsText.buttonTitle(s).map { " [\($0)]" } ?? "") }
            return "ok " + json(["state: \(status.state)", "dot: \(ConnectorsText.needsYou(status))", "quietDot: \(ConnectorsText.quiet(status))",
                                 "tip: " + ConnectorsText.tooltip(status).replacingOccurrences(of: "\n", with: " / ")]
                                + (ConnectorsText.emptyLine(status).map { [$0] } ?? []) + lines)
        case "handover":
            // Starts a second copy of this bundle that takes over from this
            // one, as a restart into an update does (Handover). This
            // instance quits once it's done; the new one answers after.
            return AppUpdater.shared.previewHandover(app: app) ? "ok handing over" : "error the window can't be handed over"
        case "debug-info":
            // What the row menu's "Copy debug info" copies, copied the same
            // way (to this instance's pasteboard).
            guard let id = displayedRow(c["row"] as? String, app)?.id, let text = app.transcript.debugInfo(rowId: id) else { return "error no such row" }
            app.copyToPasteboard(text)
            return "ok " + json(text)
        case "copy-thread-id":
            // What the ... menu's "Copy thread id" does.
            let target = target(c, app)
            guard let id = target.id else { return target.error }
            app.copyToPasteboard(id)
            return "ok \(id)"
        case "clipboard":
            // This instance's pasteboard, where its Copy items went.
            return "ok " + json(pasteboard.string(forType: .string) ?? "")
        case "mock":
            return await mock(c, app: app)
        case "quit":
            return "ok"
        default:
            return "error unknown command \(name)"
        }
    }
}

extension Automation {
    /// The open thread's card of asks, picked as its buttons pick:
    /// `pick` is "ask:option", both 1-based ("2:1" picks the second ask's
    /// first choice, or unpicks it if it was), `clear` drops every pick,
    /// `write` is "ask:text" for an ask's Something else box (picking
    /// Something else on it if it isn't), `picture` "ask:path" adds a
    /// picture to that box, and `send` sends the composer with them. Says
    /// where it is after, as `dump` does.
    @MainActor
    static func decide(_ c: [String: Any], app: AppModel) -> String {
        guard let thread = app.selectedThread else { return "error no thread open" }
        guard Decisions.isOpen(thread, card: app.sessions[thread.id]?.openCard) else { return "error the open thread has no card of asks to answer" }
        if c["clear"] as? Bool == true {
            for (ask, option) in app.picks(for: thread) { app.pickAnswer(thread: thread, ask: ask, option: option) }
        }
        if let pick = c["pick"] as? String {
            let parts = pick.split(separator: ":").compactMap { Int($0) }
            // Choice 0 is "Something else".
            guard parts.count == 2, thread.asks.indices.contains(parts[0] - 1),
                  parts[1] == 0 || Decisions.choices(for: thread.asks[parts[0] - 1]).indices.contains(parts[1] - 1) else { return "error no choice \(pick)" }
            app.pickAnswer(thread: thread, ask: parts[0] - 1, option: parts[1] == 0 ? Decisions.ownAnswer : parts[1] - 1)
        }
        for key in ["write", "picture"] {
            guard let value = c[key] as? String else { continue }
            guard let colon = value.firstIndex(of: ":"), let n = Int(value[..<colon]), thread.asks.indices.contains(n - 1) else { return "error no ask in \(value)" }
            let ask = n - 1
            let rest = String(value[value.index(after: colon)...])
            if app.picks(for: thread)[ask] != Decisions.ownAnswer { app.pickAnswer(thread: thread, ask: ask, option: Decisions.ownAnswer) }
            guard let current = app.threads[thread.id] else { continue }
            if key == "write" {
                var note = app.notes(for: current)[ask] ?? AskNote()
                note.text = rest
                app.setNote(thread: current, ask: ask, note: note)
            } else {
                app.addNoteImages(thread: current, ask: ask, urls: [URL(fileURLWithPath: (rest as NSString).expandingTildeInPath)])
            }
        }
        if c["send"] as? Bool == true {
            app.send(threadId: thread.id)
            return "ok sent"
        }
        return "ok " + (AppDump.decisions(thread, app: app) ?? []).joined(separator: "\n")
    }
}

/// Frame gaps from the window's display link, for `mode` with "frames".
@MainActor
private final class FrameWatch: NSObject {
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var gaps: [Double] = []

    init?(view: NSView?) {
        super.init()
        guard let view else { return nil }
        link = view.displayLink(target: self, selector: #selector(tick(_:)))
    }

    func start() { link?.add(to: .main, forMode: .common) }

    @objc private func tick(_ link: CADisplayLink) {
        if last > 0 { gaps.append((link.timestamp - last) * 1000) }
        last = link.timestamp
    }

    func stop() -> String {
        link?.invalidate()
        let worst = gaps.max() ?? 0
        let missed = gaps.filter { $0 > 20 }.count
        // A frame more than half again as long as the display's own was dropped.
        let frame = gaps.sorted()[gaps.count / 2]
        let dropped = gaps.filter { $0 > frame * 1.5 }.count
        return String(format: "%d frames at %.1f ms, %d dropped, worst %.0f ms, %d over 20 ms", gaps.count + 1, frame, dropped, worst, missed)
    }
}

/// Just enough of a drag for `drop`: a file at a spot in the window.
private final class AutomationDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    let draggingLocation: NSPoint
    init(pasteboard: NSPasteboard, window: NSWindow, location: NSPoint) {
        draggingPasteboard = pasteboard
        draggingDestinationWindow = window
        draggingLocation = location
    }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggedImageLocation: NSPoint { draggingLocation }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}
#endif
