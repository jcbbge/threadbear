#if DEBUG
import AppKit
import BearDock
import ThreadbearCore

// The commands' implementations, as `run` dispatches them.
// Split out of Automation.swift (4 Nov 2026) as a plain move. Debug builds only,
// like the rest of Automation.
extension Automation {
    // MARK: Commands

    /// Settings > Keyboard from a script: `record` starts listening for a
    /// command, `press` is a key through the recorder ("cmd+e"), `answer` is
    /// `use` or `cancel`, `reset` is a command or `all`. `post` is a real key
    /// press, {"keyCode": 14, "characters": "e", "modifiers": ["cmd"]}, sent
    /// through this app's own event queue, so its monitors and menus see it as
    /// they would a press while nothing reaches any other app. Says what's
    /// listening and what's changed.
    static func shortcuts(_ c: [String: Any]) async -> String {
        let shortcuts = AppShortcuts.shared
        let recorder = ShortcutRecorder.shared
        if let name = c["record"] as? String {
            guard let command = ShortcutCommand(rawValue: name) else { return "error no command \(name)" }
            recorder.start(command)
        }
        if let text = c["press"] as? String {
            guard let key = ShortcutKey(string: text) else { return "error not a key: \(text)" }
            recorder.press(key)
        }
        switch c["answer"] as? String {
        case "use": recorder.useTakenKey()
        case "cancel": recorder.cancel()
        case nil: break
        case let other?: return "error answer is use or cancel, not \(other)"
        }
        if let name = c["reset"] as? String {
            if name == "all" {
                shortcuts.change { $0.resetAll() }
            } else if let command = ShortcutCommand(rawValue: name) {
                shortcuts.change { $0.reset(command) }
            } else {
                return "error no command \(name)"
            }
        }
        if let post = c["post"] as? [String: Any] {
            guard let code = post["keyCode"] as? Int, let characters = post["characters"] as? String else { return "error post needs keyCode and characters" }
            var flags: NSEvent.ModifierFlags = []
            for modifier in post["modifiers"] as? [String] ?? [] {
                switch modifier {
                case "cmd": flags.insert(.command)
                case "opt": flags.insert(.option)
                case "ctrl": flags.insert(.control)
                case "shift": flags.insert(.shift)
                default: return "error modifier is cmd, opt, ctrl or shift"
                }
            }
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                               windowNumber: NSApp.mainWindow?.windowNumber ?? NSApp.windows.first?.windowNumber ?? 0,
                                               context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                               isARepeat: false, keyCode: UInt16(code)) else { return "error no event" }
            NSApp.postEvent(event, atStart: false)
            try? await Task.sleep(for: .milliseconds(250))
        }
        let changed = ShortcutCommand.allCases.filter { shortcuts.bindings.isChanged($0) }
            .map { "\($0.rawValue):\(shortcuts.key($0)?.string ?? "none")" }
        // A moment for a change to reach the menus, as the next line checks they did.
        try? await Task.sleep(for: .milliseconds(100))
        let drift = shortcuts.menusOutOfStep()
        return "ok listening=\(recorder.command?.rawValue ?? "nothing") outcome=\(recorder.outcome) changed=[\(changed.joined(separator: ","))] menus=\(drift.isEmpty ? "in step" : drift.joined(separator: ","))"
    }

    /// What the new-thread composer's folder, account, model and "Ask
    /// before edits" menus set. Anything else is an error rather than a
    /// silent "ok" (a typo like "models" would leave the account's default
    /// model in place), and the answer says what's set now.
    static func options(_ c: [String: Any], app: AppModel) -> String {
        let known: Set<String> = ["cmd", "rid", "cwd", "account", "model", "effort", "ask", "pool", "provider"]
        let unknown = c.keys.filter { !known.contains($0) }.sorted()
        guard unknown.isEmpty else { return "error options takes cwd, account, pool, provider, model, effort and ask, not \(unknown.joined(separator: ", "))" }
        // A pool picked for the draft (null: back to the folder's or the
        // last one), and which of a mixed pool's providers. Both unpin it.
        if let value = c["pool"] {
            if value is NSNull { app.newThreadPool = nil } else {
                guard let pool = value as? String, app.pool(pool) != nil else {
                    return "error pool is one of \(app.pools.map(\.id).joined(separator: ", ")), or null"
                }
                app.newThreadPool = pool
            }
            app.newThreadAccount = nil
        }
        if let value = c["provider"] {
            if value is NSNull { app.newThreadProvider = nil } else {
                guard let provider = value as? String else { return "error provider is claude or codex, or null" }
                app.newThreadProvider = provider
            }
        }
        if let value = c["cwd"] {
            guard let cwd = value as? String, !cwd.isEmpty else { return "error cwd is a folder path" }
            app.newThreadCwd = cwd
        }
        if let value = c["account"] {
            guard let account = value as? String else { return "error account is an account id" }
            if !app.accounts.isEmpty, !app.accounts.contains(where: { $0.id == account }) {
                return "error no account \(account) (the runner has \(app.accounts.map(\.id).joined(separator: ", ")))"
            }
            app.newThreadAccount = account
        }
        if let value = c["model"] {
            // null goes back to the default.
            if value is NSNull { app.newThreadModel = nil } else {
                guard let model = value as? String, !model.isEmpty else { return "error model is a model name, or null for the default" }
                app.newThreadModel = model
            }
        }
        if let value = c["effort"] {
            // null goes back to the model's own level.
            if value is NSNull { app.newThreadEffort = nil } else {
                guard let effort = value as? String, ComposerChips.codexEffortLevels.contains(effort)
                else { return "error effort is one of \(ComposerChips.codexEffortLevels.joined(separator: ", ")), or null for the default" }
                app.newThreadEffort = effort
            }
        }
        if let value = c["ask"] {
            guard let ask = value as? Bool else { return "error ask is true or false" }
            app.newThreadPermission = ask ? .ask : .full
        }
        let settings = AppDump.newThreadSettings(app)
        return "ok cwd=\(settings.cwd) account=\(settings.account)" + (settings.pool.map { " pool=\($0)" } ?? "")
            + " model=\(settings.model) effort=\(settings.effort) ask=\(settings.ask)"
    }

    static func pressReturn(_ window: NSWindow?, shift: Bool = false) -> String {
        // The same key event the Return key sends.
        guard let composer = findComposer(in: window?.contentView),
              let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: shift ? .shift : [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window?.windowNumber ?? 0, context: nil, characters: "\r",
                                           charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)
        else { return "error no composer" }
        composer.keyDown(with: event)
        return "ok"
    }

    /// A key event the text box with the cursor gets, as a real key press
    /// would reach it, without the app coming to the front.
    static func pressAtCursor(_ window: NSWindow?, characters: String, keyCode: UInt16, modifiers: NSEvent.ModifierFlags = []) -> String {
        guard let field = window?.firstResponder as? NSTextView else { return "error the cursor isn't in a text box" }
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window?.windowNumber ?? 0, context: nil, characters: characters,
                                           charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)
        else { return "error no event" }
        field.keyDown(with: event)
        return "ok"
    }

    static func setAppearance(_ mode: String) {
        switch mode {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }

    /// The thread `value` names, by id or the start of one, or why not as
    /// an error result. A start that matches several is an error, as in tb
    /// and the threadbear tools: it used to take the first in sorted order.
    static func thread(_ value: Any?, in threads: some Collection<String>) -> (id: String?, error: String) {
        guard let prefix = value as? String, !prefix.isEmpty else { return (nil, "error id is a thread id or the start of one") }
        if threads.contains(prefix) { return (prefix, "") }
        let hits = threads.filter { $0.hasPrefix(prefix) }
        if hits.count == 1 { return (hits.first, "") }
        return (nil, hits.isEmpty ? "error no such thread \(prefix)" : "error \(prefix) matches \(hits.count) threads")
    }

    static func thread(_ value: Any?, _ app: AppModel) -> (id: String?, error: String) {
        thread(value, in: app.threads.keys)
    }

    /// The thread a command acts on: `id` when it's given (an error if it
    /// doesn't name exactly one), else the open one.
    static func target(_ c: [String: Any], threads: some Collection<String>, selection: String?) -> (id: String?, error: String) {
        if let value = c["id"], !(value is NSNull) { return thread(value, in: threads) }
        guard let selection else { return (nil, "error no thread: pass id, or open one first") }
        return (selection, "")
    }

    static func target(_ c: [String: Any], _ app: AppModel) -> (id: String?, error: String) {
        target(c, threads: app.threads.keys, selection: app.selection)
    }

    /// The temp bundle has no privacy permissions, so writing into Desktop,
    /// Documents or Downloads would put a macOS access prompt in front of
    /// Mike's work (again for every instance). dev-app.sh's shot and dump
    /// have the app write into the instance's folder and move the file from
    /// the agent's shell.
    static func refusesToWrite(_ path: String, home: String = NSHomeDirectory()) -> String? {
        let full = URL(fileURLWithPath: path).standardizedFileURL.path
        for folder in ["Desktop", "Documents", "Downloads"] {
            let protected = URL(fileURLWithPath: home).appendingPathComponent(folder).standardizedFileURL.path
            if full == protected || full.hasPrefix(protected + "/") {
                return "error won't write into ~/\(folder): macOS would ask Mike to let this dev app in. Use a temp folder (dev-app.sh shot and dump move the file for you)"
            }
        }
        return nil
    }

    /// A row on screen in the open thread, by id or the start of one.
    static func displayedRow(_ prefix: String?, _ app: AppModel) -> TranscriptRow? {
        guard let prefix, let session = app.transcript.session else { return nil }
        if let index = session.displayIndex(of: prefix) { return session.displayRow(index) }
        return (0..<session.displayCount).lazy.map { session.displayRow($0) }.first { $0.id.hasPrefix(prefix) }
    }

    static func scroll(toRow prefix: String?, offset: Double, app: AppModel) -> String {
        guard let row = displayedRow(prefix, app), let index = app.transcript.session?.displayIndex(of: row.id) else { return "error no such row" }
        app.transcript.scroll(toRow: index, offset: offset)
        return "ok \(row.id)"
    }

    /// Opens or closes a row: a group, a tool, a thinking block, a settled
    /// approval, or (with `file`) a file in a changes card. A row folded in
    /// a closed group opens the group first. `all` shows all of a diff.
    static func setExpanded(_ c: [String: Any], open: Bool, app: AppModel) -> String {
        guard let session = app.transcript.session, let prefix = c["row"] as? String else { return "error no row" }
        var row = displayedRow(prefix, app)
        if row == nil, open, let item = session.model.items.first(where: { $0.id == prefix }) ?? session.model.items.first(where: { $0.id.hasPrefix(prefix) }),
           let group = (0..<session.displayCount).lazy.map({ session.displayRow($0) }).first(where: { candidate in
               if case .group(let group) = candidate.content { return group.memberIds.contains(item.id) }
               return false
           }) {
            session.setModelExpanded(group.id, true)
            row = displayedRow(item.id, app)
        }
        guard let row else { return "error no such row" }
        if case .changes(let card) = row.content {
            let file: ChangedFile?
            if let index = c["file"] as? Int {
                file = card.files.indices.contains(index) ? card.files[index] : nil
            } else if let path = c["file"] as? String {
                file = card.files.first { $0.path == path } ?? card.files.first { $0.path.hasSuffix(path) }
            } else {
                return "error a changes card needs \"file\": a path or an index"
            }
            guard let file else { return "error no such file in \(row.id)" }
            let key = ChangedFiles.expansionKey(turnId: card.turnId, path: file.path)
            session.setModelExpanded(c["all"] as? Bool == true && open ? DiffPreview.allKey(key) : key, open)
            return "ok \(row.id) \(file.path)"
        }
        if case .group = row.content {
            session.setModelExpanded(row.id, open)
            return "ok \(row.id)"
        }
        guard [.tool, .diff, .reasoning, .approval].contains(row.kind) else { return "error \(row.id) doesn't open" }
        if app.transcript.isExpanded(row) != open { app.transcript.toggleExpanded(rowId: row.id) }
        if open, c["all"] as? Bool == true, row.kind == .diff { app.transcript.showAllLines(DiffPreview.allKey(row.id)) }
        return "ok \(row.id)"
    }

    /// `{"id": thread}` shows a sidebar row's hover buttons; `{"row": id}`
    /// draws a transcript row as hovered; neither clears both.
    /// The activity log (ActivityRecorder). `"on": true | false` sets the
    /// Settings switch. `"click": "<tip>"` gives the recorder a click on the
    /// control with that tooltip (without pressing it), and `"key": "n"`
    /// with `"command": true` presses a key through the app's own event
    /// dispatch, so a menu's shortcut comes back as its item. Says whether
    /// it's on, how many lines today has and the last few (`"last": N`).
    static func activity(_ c: [String: Any], app: AppModel) async -> String {
        if let on = c["on"] as? Bool { UserDefaults.standard.set(on, forKey: ActivityRecorder.enabledKey) }
        if let tip = c["click"] as? String {
            guard let window = mainWindow, let content = window.contentView,
                  let anchor = all(TipAnchorView.self, in: content).last(where: { $0.text == tip && !$0.isHiddenOrHasHiddenAncestor })
            else { return "error no control with the tip \(tip)" }
            let center = anchor.convert(NSPoint(x: anchor.bounds.midX, y: anchor.bounds.midY), to: nil)
            let type: NSEvent.EventType = c["button"] as? String == "right" ? .rightMouseDown : .leftMouseDown
            guard let event = NSEvent.mouseEvent(with: type, location: center, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
            else { return "error no event" }
            ActivityRecorder.shared.click(event)
        }
        if let key = c["key"] as? String {
            guard let window = mainWindow,
                  let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: c["command"] as? Bool == true ? .command : [],
                                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                                               characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: UInt16(number(c["keyCode"]) ?? 45))
            else { return "error no event" }
            NSApp.sendEvent(event)
        }
        // The writer's queue and the main queue's next turn (a key waits one).
        try? await Task.sleep(for: .milliseconds(300))
        let file = ActivityFiles.folder(in: app.dataDir).appendingPathComponent(ActivityFiles.fileName(for: Date()))
        let lines = ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n")
        // On one line, as every result is: the lines after " | ".
        let last = lines.suffix(number(c["last"]).map { Int($0) } ?? 3).map { " | " + $0 }.joined()
        return "ok \(ActivityRecorder.isOn ? "on" : "off") \(lines.count) lines today" + last
    }

    static func hover(_ c: [String: Any], app: AppModel) -> String {
        if let prefix = c["row"] as? String {
            // The open card is in the composer.
            if let card = app.transcript.session?.openCard, card.id.hasPrefix(prefix), let host = app.transcript.composerCard {
                _ = hoveredCell?.debugHover(false)
                hoveredCell = nil
                return host.debugHover(true) ? "ok \(card.id)" : "error \(card.id) has no hover state"
            }
            guard let row = displayedRow(prefix, app), let index = app.transcript.session?.displayIndex(of: row.id) else { return "error no such row" }
            app.transcript.scroll(toRow: index, offset: 120)
            guard let cell = app.transcript.tableView.view(atColumn: 0, row: index, makeIfNecessary: true) as? RowCellView else { return "error row isn't drawn" }
            _ = hoveredCell?.debugHover(false)
            guard cell.debugHover(true) else { return "error \(row.id) has no hover state" }
            hoveredCell = cell
            return "ok \(row.id)"
        }
        guard let value = c["id"] else {
            app.hoverOverride = nil
            _ = hoveredCell?.debugHover(false)
            hoveredCell = nil
            _ = app.transcript.composerCard?.debugHover(false)
            return "ok"
        }
        // A schedule's row in the Scheduled view, by its id.
        if let id = value as? String, app.schedule(id) != nil {
            app.hoverOverride = id
            return "ok \(id)"
        }
        let match = thread(value, app)
        guard let id = match.id else { return match.error }
        app.hoverOverride = id
        return "ok \(id)"
    }

    /// Two fingers across a sidebar row (`{"id": thread, "dx": -150}`, left
    /// negative): synthetic trackpad events posted to the app, so they go
    /// through the same monitor as a real swipe. `"lift": false` leaves the
    /// fingers down, for a shot of the row part way along; a later swipe
    /// with `"lift": true` (and any `dx`, 0 included) carries on and lets go.
    /// Says where the row ended up and whether it's past the line.
    static func swipe(_ c: [String: Any], app: AppModel) async -> String {
        let match = Self.thread(c["id"], app)
        guard let id = match.id else { return match.error }
        app.hoverOverride = id
        try? await Task.sleep(for: .milliseconds(100))
        guard let row = RowSwipeController.listening else { return "error \(id) has no swipe here (is its row drawn?)" }
        let dx = number(c["dx"]) ?? 0
        let steps = max(1, Int(number(c["steps"]) ?? 8))
        let fresh = row.swipe.phase == .idle
        if fresh { post(RowSwipeEvents.event(dx: 0, phase: .began)) }
        for _ in 0..<steps {
            post(RowSwipeEvents.event(dx: dx / Double(steps), phase: .changed))
            try? await Task.sleep(for: .milliseconds(16))
        }
        let along = "offset \(Int(row.offset)) armed \(row.swipe.armed)"
        guard c["lift"] as? Bool ?? true else { return "ok \(along)" }
        post(RowSwipeEvents.event(dx: 0, phase: .ended))
        try? await Task.sleep(for: .milliseconds(500))
        app.hoverOverride = nil
        return "ok \(along), let go: \(app.threads[id]?.isArchived == true ? "archived" : "not archived")"
    }

    /// Two fingers across the middle of the window (`{"dx": 150, "dy": 0}`,
    /// right and down positive; right is Back), through the handler
    /// SwipeNavigation's monitor calls. A made-up event has no window of its
    /// own, so, as for `mouse-button`, it's handed the main one. `"lift":
    /// false` leaves the fingers down, for a shot of the arrow; a later
    /// page-swipe carries on. Says how far it got and where the window is after.
    static func pageSwipe(_ c: [String: Any], app: AppModel) async -> String {
        guard let window = MainWindowFrame.window else { return "error no window" }
        let dx = number(c["dx"]) ?? 0, dy = number(c["dy"]) ?? 0
        let steps = max(1, Int(number(c["steps"]) ?? 8))
        func page(_ x: Double, _ y: Double, _ phase: RowSwipeEvents.Phase) {
            guard let event = RowSwipeEvents.event(dx: x, dy: y, phase: phase, middle: true) else { return }
            _ = SwipeNavigation.shared.handle(event, in: window)
        }
        if SwipeNavigation.shared.swipe.phase == .idle { page(0, 0, .began) }
        for _ in 0..<steps {
            page(dx / Double(steps), dy / Double(steps), .changed)
            try? await Task.sleep(for: .milliseconds(16))
        }
        let swipe = SwipeNavigation.shared.swipe
        let along = "\(swipe.direction.map { "\($0)" } ?? "no swipe") progress \(String(format: "%.2f", swipe.progress)) armed \(swipe.armed)"
        guard c["lift"] as? Bool ?? true else { return "ok \(along)" }
        page(0, 0, .ended)
        try? await Task.sleep(for: .milliseconds(300))
        return "ok \(along), let go: \(app.selection ?? "new") back=\(app.canGoBack) forward=\(app.canGoForward)"
    }

    static func post(_ event: NSEvent?) {
        guard let event else { return }
        NSApp.postEvent(event, atStart: false)
    }

    /// Selects `words` in a message row's text and shows the selection bar
    /// (`{"row": id, "words": "…"}`, which says the bar's window number);
    /// with `"action": "explain" | "quote" | "copy"`, clicks that instead.
    static func select(_ c: [String: Any], app: AppModel) -> String {
        guard let prefix = c["row"] as? String, let words = c["words"] as? String else { return "error row and words are required" }
        guard let row = displayedRow(prefix, app), let index = app.transcript.session?.displayIndex(of: row.id) else { return "error no such row" }
        app.transcript.scroll(toRow: index, offset: 120)
        guard let cell = app.transcript.tableView.view(atColumn: 0, row: index, makeIfNecessary: true) as? TextRowCell else {
            return "error \(row.id) isn't a text row"
        }
        let action: SelectionBarWindow.Action?
        switch c["action"] as? String {
        case nil: action = nil
        case "explain": action = .explain
        case "quote": action = .quote
        case "copy": action = .copy
        case let other?: return "error unknown action \(other)"
        }
        guard cell.textView.selectionMessage != nil else { return "error \(row.id) isn't a message" }
        guard cell.textView.debugSelect(words, then: action) else { return "error \(words) isn't in \(row.id)" }
        if action != nil { return "ok" }
        return cell.textView.debugSelectionBarWindow.map { "ok window \($0)" } ?? "error the bar didn't show"
    }

    /// Thread chips in a transcript row's text: `{"row": id}` lists them
    /// (word, then the thread it opens); with `"word"`, `"show": true`
    /// shows that chip's hover card (and says its window number, for
    /// `screencapture -l`), `false` closes it, and `"click": true` clicks it.
    static func chip(_ c: [String: Any], app: AppModel) -> String {
        guard let prefix = c["row"] as? String else { return "error row is required" }
        guard let row = displayedRow(prefix, app), let index = app.transcript.session?.displayIndex(of: row.id) else { return "error no such row" }
        app.transcript.scroll(toRow: index, offset: 120)
        guard let cell = app.transcript.tableView.view(atColumn: 0, row: index, makeIfNecessary: true) as? TextRowCell else {
            return "error \(row.id) isn't a text row"
        }
        let chips = cell.textView.debugChips()
        guard let word = c["word"] as? String else {
            return chips.isEmpty ? "ok none" : "ok " + chips.map { "\($0.word)=\($0.threadId)" }.joined(separator: " ")
        }
        guard chips.contains(where: { $0.word == word }) else { return "error \(word) isn't a chip in \(row.id)" }
        if c["click"] as? Bool == true {
            cell.textView.debugClickChip(word)
            return "ok opened \(app.selection ?? "nothing")"
        }
        if c["show"] as? Bool == false {
            cell.textView.closeChipCard()
            return "ok"
        }
        guard let window = cell.textView.debugShowChip(word) else { return "error the card didn't show" }
        return "ok window \(window)"
    }

    /// Links with a hover card in a transcript row's text (an asks card's
    /// link buttons too): `{"row": id}` lists them (words, then where they
    /// go); with `"words"` (part of a link's words), shows that link's
    /// card and says its window number, and `"show": false` closes it;
    /// `"middle": true` middle-clicks it instead.
    static func peek(_ c: [String: Any], app: AppModel) -> String {
        guard let prefix = c["row"] as? String else { return "error row is required" }
        guard let row = displayedRow(prefix, app), let index = app.transcript.session?.displayIndex(of: row.id) else { return "error no such row" }
        app.transcript.scroll(toRow: index, offset: 120)
        guard let cell = app.transcript.tableView.view(atColumn: 0, row: index, makeIfNecessary: true) as? TextRowCell else {
            return "error \(row.id) isn't a text row"
        }
        if c["show"] as? Bool == false {
            cell.textView.closeChipCard()
            return "ok"
        }
        if let words = c["words"] as? String, c["press"] as? Bool == true {
            guard let opened = cell.textView.debugClickPictureChip(words) else { return "error no picture chip \(words) opened in \(row.id)" }
            return "ok quicklook \(opened.index) of " + json(opened.paths)
        }
        if let words = c["words"] as? String, c["middle"] as? Bool == true {
            // A middle click on the link, through the window as a real one goes.
            guard cell.textView.debugMiddleClick(words) else { return "error no link with \(words) in \(row.id), or no middle-button event" }
            return "ok selection \(app.selection ?? "nothing")"
        }
        if let words = c["words"] as? String, c["menu"] as? Bool == true || c["click"] != nil {
            guard let menu = cell.textView.debugLinkMenu(words) else { return "error no link with \(words) in \(row.id)" }
            let items = menu.items.filter { !$0.isSeparatorItem }
            guard let title = c["click"] as? String else { return "ok " + json(items.map(\.title)) }
            guard let item = items.first(where: { $0.title == title }), let action = item.action else { return "error no item \(title)" }
            NSApp.sendAction(action, to: item.target, from: item)
            return "ok"
        }
        guard let words = c["words"] as? String else {
            let peeks = cell.textView.debugPeeks()
            return peeks.isEmpty ? "ok none" : "ok " + peeks.map { "\($0.words)=\($0.url.isFileURL ? $0.url.path : $0.url.absoluteString)" }.joined(separator: " | ")
        }
        guard let window = cell.textView.debugShowPeek(words) else { return "error no link with \(words) in \(row.id)" }
        return "ok window \(window)"
    }

    /// A row's context menu: `{"row": id}` lists its items, and with
    /// `"click": title` chooses one (copies land on this instance's
    /// pasteboard; read it back with `clipboard`).
    static func menu(_ c: [String: Any], app: AppModel) -> String {
        guard let row = displayedRow(c["row"] as? String, app), let index = app.transcript.session?.displayIndex(of: row.id),
              let menu = app.transcript.menu(forRow: index) else { return "error no such row" }
        let items = menu.items.filter { !$0.isSeparatorItem }
        guard let title = c["click"] as? String else { return "ok " + json(items.map(\.title)) }
        guard let item = items.first(where: { $0.title == title }), let action = item.action else { return "error no item \(title)" }
        NSApp.sendAction(action, to: item.target, from: item)
        return "ok"
    }

    /// The composer's model picker, or its account, permission or folder
    /// menu, as the open thread (or a new one) would get it, a JSON list
    /// of lines: `[x]` for the ticked one, `*` for the default, the
    /// subtitle after a dash, submenus and older models indented, `#` on
    /// a section (a provider column, Effort). `click` picks an item by
    /// title, as a click on it would.
    static func composerMenu(_ c: [String: Any], app: AppModel) -> String {
        let settings = ThreadSettings(app: app, thread: app.selectedThread)
        let menu: NSMenu
        // Opens a chip's popover, and says its window number so a
        // screencapture -l can take just it.
        func show(_ bump: () -> Void) -> String {
            bump()
            RunLoop.main.run(until: Date().addingTimeInterval(0.4))
            let popover = NSApp.windows.first { String(describing: type(of: $0)).contains("Popover") && $0.isVisible }
            return popover.map { "ok window \($0.windowNumber)" } ?? "error the picker didn't open"
        }
        switch c["menu"] as? String ?? "model" {
        case "model":
            if let title = c["click"] as? String {
                // With pools, `pool` says which pool's column to pick from.
                return settings.pickerClick(title, column: c["pool"] as? String) ? "ok" : "error no item \(title)"
            }
            if c["show"] as? Bool == true { return show { app.modelPickerRequest += 1 } }
            return "ok " + json(settings.pickerLines())
        case "context":
            // The context ring's popover; only on a thread that has one.
            guard let thread = app.selectedThread, let meter = ContextMeter(thread) else { return "error no context meter on this thread" }
            if c["show"] as? Bool == true { return show { app.contextMeterRequest += 1 } }
            return "ok " + json([meter.amount, "\(meter.percent)%"])
        case "account":
            // An account by its email (as the picker shows it) or its id.
            if let title = c["click"] as? String {
                guard let item = settings.accountSections.flatMap(\.items).first(where: { $0.title == title || $0.id == title }) else { return "error no item \(title)" }
                settings.setAccount(item.id)
                return "ok"
            }
            if c["show"] as? Bool == true { return show { app.accountPickerRequest += 1 } }
            return "ok " + json(settings.accountLines())
        case "pin":
            // Pinning, which the picker no longer offers (28 Oct): a login
            // by its email or id pins the thread (or the draft) to it;
            // "Unpin" unpins.
            guard settings.usesPools else { return "error the runner has no pools; use menu account" }
            if let title = c["click"] as? String {
                if title == "Unpin" { return settings.pickerClick("Unpin") ? "ok" : "error it isn't pinned" }
                guard let item = settings.pinSections.flatMap(\.items).first(where: { $0.title == title || $0.id == title }) else { return "error no item \(title)" }
                settings.pin(item.id)
                return "ok"
            }
            return "ok " + json(AccountMenu.lines(settings.pinSections, footer: settings.pinnedLine))
        case "permission": menu = settings.permissionMenu()
        case "folder": menu = settings.folderMenu()
        case "runner":
            // Runs on, on the new-thread composer only.
            guard app.selectedThread == nil else { return "error runner is for a new thread" }
            menu = settings.runnerMenu()
        default: return "error menu is model, account, pin, permission, folder or runner"
        }
        if let title = c["click"] as? String {
            guard let item = allItems(menu).first(where: { $0.title == title }), let action = item.action else { return "error no item \(title)" }
            NSApp.sendAction(action, to: item.target, from: item)
            return "ok"
        }
        return "ok " + json(describe(menu, indent: ""))
    }

    /// Opens a real menu for `dev-app.sh menu` to photograph, as nothing
    /// else can see what a menu draws: SwiftUI's items report an image even
    /// while they hide it, which is how icons went missing for a week
    /// (IconMenu). `{"x","y"}` (in the window, from its top left) clicks
    /// there, `right: true` to right-click; `{"main": "Thread"}` opens that
    /// menu of the menu bar; `sub` opens one of its submenus instead, once
    /// the menu's read. The menu's window number goes in the file `idFile`,
    /// and it stays up `hold` seconds so the shell can capture it (this temp
    /// app has no Screen Recording permission). Says the items it found.
    static func realMenu(_ c: [String: Any], window: NSWindow?) -> String {
        guard let window, let view = window.contentView else { return "error no window" }
        var titles: [String] = []
        let idFile = c["idFile"] as? String
        let hold = c["hold"] as? Double ?? 0.2
        let sub = c["sub"] as? String
        var submenu: NSMenu?
        let watch = NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: nil) { note in
            guard let menu = note.object as? NSMenu else { return }
            let isSub = menu === submenu
            if !isSub {
                titles = menu.items.map { $0.isSeparatorItem ? "---" : $0.title + ($0.submenu != nil ? " >" : "") }
                if let sub { submenu = menu.items.first { $0.title == sub }?.submenu }
            }
            // Timers: the main queue can't break into a menu's tracking.
            let opened = Timer(timeInterval: 0.15, repeats: false) { _ in
                MainActor.assumeIsolated {
                    guard let idFile, sub == nil || isSub else { return }
                    // Of the pair it opens, the larger has the menu and its shadow.
                    let open = NSApp.windows.filter { $0.level.rawValue >= NSWindow.Level.popUpMenu.rawValue && $0.isVisible }
                    if let top = open.max(by: { $0.frame.width < $1.frame.width }) {
                        try? String(top.windowNumber).write(toFile: idFile, atomically: true, encoding: .utf8)
                    }
                }
            }
            RunLoop.main.add(opened, forMode: .common)
            let close = Timer(timeInterval: sub != nil && !isSub ? 0.2 : hold, repeats: false) { _ in
                MainActor.assumeIsolated { menu.cancelTrackingWithoutAnimation() }
            }
            RunLoop.main.add(close, forMode: .common)
        }
        defer { NotificationCenter.default.removeObserver(watch) }
        if let name = c["main"] as? String {
            guard let menu = NSApp.mainMenu?.items.first(where: { $0.title == name })?.submenu else { return "error no menu \(name)" }
            menu.update()
            menu.popUp(positioning: nil, at: NSPoint(x: view.bounds.midX, y: view.bounds.midY), in: view)
        } else {
            guard let x = c["x"] as? Double, let y = c["y"] as? Double else { return "error realMenu needs x and y, or main" }
            let right = c["right"] as? Bool == true
            let point = NSPoint(x: x, y: view.bounds.height - y)
            func event(_ type: NSEvent.EventType, _ number: Int) -> NSEvent? {
                NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: window.windowNumber, context: nil, eventNumber: number, clickCount: 1, pressure: 1)
            }
            guard let down = event(right ? .rightMouseDown : .leftMouseDown, 1), let up = event(right ? .rightMouseUp : .leftMouseUp, 2) else { return "error no event" }
            NSApp.postEvent(up, atStart: false)
            window.sendEvent(down)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        if let submenu { submenu.popUp(positioning: nil, at: NSPoint(x: view.bounds.midX, y: view.bounds.midY), in: view) }
        else if sub != nil { return "error no submenu \(sub ?? "") in " + json(titles) }
        // Menus stuck (MenuWatch): the click opened a popover, no menu to cancel.
        if titles.isEmpty { MenuPopover.close() }
        return titles.isEmpty ? "error no menu opened" : "ok " + json(titles)
    }

    /// The popover menus stand in for once macOS stops showing the app's
    /// menus (MenuWatch): `stuck` true makes this run behave as if it had;
    /// `show` (`permission`, `folder`, `plus` or `hibernate`, with `id` for
    /// a thread) draws that menu as a popover over the window and says its
    /// window number; `popup` opens it as a real menu instead (stuck, the
    /// popover should take its place); `click` picks a row by its title, as a click would.
    /// With none of them, lists the rows on show.
    static func menuPopover(_ c: [String: Any], app: AppModel) -> String {
        if c["stuck"] as? Bool == true { MenuWatch.forceStuck() }
        if let title = c["click"] as? String {
            func find(_ rows: [MenuPopoverRow]) -> MenuPopoverRow? {
                for row in rows { if row.title == title { return row }; if let child = find(row.children) { return child } }
                return nil
            }
            guard MenuPopover.isShown, let row = find(MenuPopover.rows) else { return "error no row \(title)" }
            MenuPopover.pick(row)
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            return "ok"
        }
        if let name = (c["show"] ?? c["popup"]) as? String {
            let settings = ThreadSettings(app: app, thread: app.selectedThread)
            let menu: NSMenu
            switch name {
            case "permission": menu = settings.permissionMenu()
            case "folder": menu = settings.folderMenu()
            case "plus": menu = settings.plusMenu(attach: {}, schedule: {})
            case "hibernate":
                guard let id = c["id"] as? String ?? app.selection else { return "error hibernate needs id" }
                menu = SnoozeNSMenu.make(threadId: id, app: app)
            default: return "error show is permission, folder, plus or hibernate"
            }
            guard let view = mainWindow?.contentView else { return "error no window" }
            let spot = NSRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            if c["fromView"] as? Bool == true {
                // As the moon's fallback: from a small plain view that's then
                // removed and freed, as SwiftUI frees the moon once the row
                // stops being hovered. Says whether the popover stayed, and
                // whether it sits below where the view was.
                var anchorOnScreen = NSRect.zero
                autoreleasepool {
                    let moon = NSView(frame: NSRect(x: view.bounds.midX - 11, y: view.bounds.midY - 11, width: 22, height: 22))
                    view.addSubview(moon)
                    anchorOnScreen = view.window!.convertToScreen(moon.convert(moon.bounds, to: nil))
                    MenuPopover.show(menu, relativeTo: moon.bounds, of: moon, edge: moon.isFlipped ? .maxY : .minY)
                    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
                    moon.removeFromSuperview()
                }
                RunLoop.main.run(until: Date().addingTimeInterval(0.4))
                let popover = NSApp.windows.first { String(describing: type(of: $0)).contains("Popover") && $0.isVisible }
                let below = popover.map { $0.frame.maxY <= anchorOnScreen.minY + 2 } ?? false
                return "ok shown \(MenuPopover.isShown) below \(below) popover \(popover.map { NSStringFromRect($0.frame) } ?? "none") anchor \(NSStringFromRect(anchorOnScreen))"
            }
            if c["popup"] != nil {
                // A real menu, as a right-click opens one: MenuWatch has to
                // see it and, if menus are stuck, swap in the popover.
                // Never left up on Mike's screen if the swap doesn't happen.
                // A timer: this runs in a main-queue block, so the queue
                // can't break in while the menu is up.
                let safety = Timer(timeInterval: 2, repeats: false) { _ in menu.cancelTrackingWithoutAnimation() }
                RunLoop.main.add(safety, forMode: .common)
                menu.popUp(positioning: nil, at: NSPoint(x: spot.minX, y: spot.minY), in: view)
            } else {
                MenuPopover.show(menu, relativeTo: spot, of: view, edge: .maxY)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.4))
            let window = NSApp.windows.first { String(describing: type(of: $0)).contains("Popover") && $0.isVisible }
            return window.map { "ok window \($0.windowNumber)" } ?? "error the popover didn't open"
        }
        func lines(_ rows: [MenuPopoverRow], _ indent: String) -> [String] {
            rows.flatMap { row -> [String] in
                let line: String
                switch row.kind {
                case .separator: line = indent + "---"
                case .header: line = indent + "# " + row.title
                case .item: line = indent + (row.checked ? "[x] " : "") + row.title + (row.subtitle.map { " - " + $0 } ?? "") + (row.enabled ? "" : " (disabled)")
                }
                return [line] + lines(row.children, indent + "  ")
            }
        }
        return "ok stuck \(MenuWatch.stuck) shown \(MenuPopover.isShown) " + json(lines(MenuPopover.rows, ""))
    }

    /// The drag Space bug (DragSpace): `add` puts the main window on that
    /// Space (31 on Mike's Mac), as a drag on macOS 27.2 leaves it, so a menu
    /// opened next comes up unseen; `misfile` files it under another
    /// display's current Space instead of its own, as an update restart in
    /// the background did; `repair` runs the repair now. Says the window's
    /// Spaces and frame, the displays' own, how many repairs and refiles have
    /// run, and whether menus are stuck for another reason.
    static func dragSpace(_ c: [String: Any]) -> String {
        guard let window = mainWindow else { return "error no window" }
        guard SkyLight.available else { return "error the window server calls aren't there" }
        if let space = c["add"] as? Int { SkyLight.add(window.windowNumber, to: [space]) }
        if c["misfile"] as? Bool == true {
            let displays = SkyLight.displays()
            guard let screen = window.screen, let id = SkyLight.identifier(of: screen),
                  let own = displays.first(where: { $0.identifier == id }),
                  let other = displays.first(where: { $0.identifier != id }),
                  let otherCurrent = other.spaces.sorted().first else { return "error needs two displays" }
            let mine = SkyLight.spaces(of: window.windowNumber).filter(own.spaces.contains)
            SkyLight.add(window.windowNumber, to: [otherCurrent])
            SkyLight.remove(window.windowNumber, from: mine)
        }
        if c["repair"] as? Bool == true { DragSpace.repair("automation") }
        return "ok spaces \(SkyLight.spaces(of: window.windowNumber)) frame \(NSStringFromRect(window.frame)) on \(window.screen?.localizedName ?? "-") display spaces \(SkyLight.displaySpaces().sorted()) repairs \(DragSpace.repairs) refiles \(DragSpace.refiles) stuck \(MenuWatch.stuck)"
    }

    static func usage(_ c: [String: Any], app: AppModel) -> String {
        if let show = c["show"] as? Bool {
            app.usageShown = show
            guard show else { return "ok closed" }
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            return app.usageShown ? "ok shown" : "error the panel didn't open"
        }
        if let title = c["click"] as? String {
            if title == "Check now" { app.checkClis(); return "ok" }
            guard let provider = c["provider"] as? String, let cli = app.clis.first(where: { $0.provider == provider }) else { return "error provider is claude or codex" }
            if title == CliText.updateTitle(cli) {
                app.updateCli(provider, force: cli.status == "held")
            } else if title == CliText.goBackTitle(cli), let previous = cli.previousVersion {
                app.updateCli(provider, version: previous)
            } else if let policy = CliText.policies.first(where: { CliText.policyTitle($0) == title }) {
                app.setCliPolicy(provider, policy)
            } else {
                return "error no button \(title) for \(provider)"
            }
            return "ok"
        }
        return "ok " + json(AppDump.usageLines(app))
    }

    static func allItems(_ menu: NSMenu) -> [NSMenuItem] {
        menu.items.flatMap { [$0] + ($0.submenu.map(allItems) ?? []) }
    }

    static func describe(_ menu: NSMenu, indent: String) -> [String] {
        menu.items.flatMap { item -> [String] in
            if item.isSeparatorItem { return [indent + "---"] }
            if item.isSectionHeader { return [indent + "# " + item.title] }
            var line = indent + (item.state == .on ? "[x] " : "[ ] ") + item.title
            if item.image?.accessibilityDescription == "Default" { line += " *" }
            if let subtitle = item.subtitle, !subtitle.isEmpty { line += " - " + subtitle }
            return [line] + (item.submenu.map { describe($0, indent: indent + "    ") } ?? [])
        }
    }

    /// Mock runner helpers (`mock.restartPending`, `mock.restart`, ...),
    /// through the app's own connection. Only `mock.` methods: anything the
    /// real runner answers belongs to `tb`.
    static func mock(_ c: [String: Any], app: AppModel) async -> String {
        guard let method = c["method"] as? String, !method.isEmpty else { return "error no method" }
        guard let params = mockParams(c["params"]) else { return "error params is an object" }
        guard let client = app.client else { return "error not connected" }
        do {
            let result = try await client.call("mock." + method, params, as: JSONValue.self)
            let data = (try? JSONEncoder().encode(result)) ?? Data()
            return "ok " + String(decoding: data, as: UTF8.self)
        } catch {
            return "error \(error.localizedDescription)"
        }
    }

    /// `params` for a mock call: an object, or nothing (null counts as
    /// nothing). Anything else is refused here: JSONSerialization raises an
    /// Objective-C exception for a top level that isn't an array or an
    /// object, which `try?` can't catch, and that crashed the app.
    static func mockParams(_ raw: Any?) -> JSONValue? {
        guard let raw, !(raw is NSNull) else { return .object([:]) }
        guard raw is [String: Any], JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        return value
    }
}
#endif
