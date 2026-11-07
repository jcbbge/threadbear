#if DEBUG
import AppKit
import ThreadbearCore

/// The automation hook's `dump`: what the window shows, as data. The
/// sidebar's rows by section, the open thread's rows (id, kind, height,
/// open or not, the start of their text, which are on screen), the
/// selection, the composer's text and the banner. `Tools/dev-app.sh dump`
/// prints `text`; `dump --json` the JSON.
struct AppDump: Encodable {
    struct Window: Encodable {
        var width: Int
        var height: Int
        var appearance: String
    }

    struct BannerInfo: Encodable {
        var style: String
        var text: String
        var detail: String?
    }

    struct Thread: Encodable {
        var id: String
        var title: String
        var status: String
        var needsYou: Bool
        var unread: Bool
        var hovered: Bool
        /// What the row says is running in the background, if anything.
        var background: String?
        /// "Waiting for room · 5:00 am", for a pool thread with no login
        /// that has room.
        var waiting: String? = nil
        /// The sub-agent rows under it, as the sidebar shows them.
        var subagents: [SubagentInfo] = []
        /// "On bruce" for another runner's thread ("On bruce, offline").
        var runner: String? = nil
    }

    struct SubagentInfo: Encodable {
        var id: String
        var depth: Int
        var status: String
        var title: String
        var detail: String
        var selected: Bool
    }

    struct Section: Encodable {
        var name: String
        var threads: [Thread]
        /// Inbox and Scheduled sections only: folded away under their heading.
        var collapsed: Bool? = nil
    }

    struct Sidebar: Encodable {
        var mode: String
        var sections: [Section]
        var snoozed: Int
        var archived: Int
    }

    struct Composer: Encodable {
        /// The thread the draft belongs to, or "new".
        var draft: String
        var text: String
        var images: Int
        /// The seq of the message being edited, when the draft is an edit.
        var editing: Int? = nil
        /// Where that thread runs, or where a new one will start: what the
        /// composer's chips and menus show.
        var cwd: String
        var account: String
        /// The model, or "default (...)" saying whose default.
        var model: String
        var ask: Bool
        /// Its permission mode as the composer says it, past "asks".
        var mode: PermissionMode = .full
        /// The effort level, or "default" for the model's own.
        var effort: String = "default"
        /// The pool that picks its login; nil when it's pinned to
        /// `account`, or the runner has no pools.
        var pool: String? = nil
        /// The model chip as it reads ("Claude · Opus 5.5 · High").
        var chip: String = ""
        /// The other runner it runs on ("bruce"); nil for this Mac.
        var runner: String? = nil
    }

    struct Settings {
        var cwd: String
        var account: String
        var model: String
        var ask: Bool
        var mode: PermissionMode = .full
        var effort: String = "default"
        var pool: String? = nil
    }

    /// The runner's pools as the picker's rail shows them, when it has any.
    struct PoolInfo: Encodable {
        var id: String
        var title: String
        var logins: [String]
        var folders: [String]
        /// "3 · 61%".
        var rail: String
        var status: String?
    }

    /// A thread's permission mode as the dump says it.
    static func modeText(_ mode: PermissionMode) -> String {
        switch mode {
        case .ask: "asks before edits"
        case .auto: "auto"
        case .plan: "plan first"
        case .full: "full access"
        }
    }

    /// What a new thread sent from the composer would get, as the
    /// composer's menus show it (`ThreadSettings` in ComposerControls).
    @MainActor
    static func newThreadSettings(_ app: AppModel) -> Settings {
        let account = app.newThreadAccountId
        return Settings(cwd: app.newThreadCwd ?? app.draftLogins.defaults.cwd, account: account,
                        model: app.newThreadModel ?? defaultModel(app, account: account), ask: app.newThreadPermission == .ask,
                        mode: app.newThreadPermission, effort: app.newThreadEffort ?? "default", pool: app.newThreadPoolId)
    }

    /// Whose default a new thread gets, and which model that is when known.
    @MainActor
    static func defaultModel(_ app: AppModel, account: String) -> String {
        if let model = app.defaults.model(for: app.provider(ofAccount: account)) { return "default (the runner's, \(model))" }
        if let model = app.account(account)?.defaultModel { return "default (the account's, \(model))" }
        return "default (the account's)"
    }

    struct Row: Encodable {
        var id: String
        var kind: String
        var height: Int
        /// Nil for a row that doesn't open (a message, a waiting card).
        var expanded: Bool?
        var inGroup: Bool
        var onScreen: Bool
        var seq: Int
        var turn: String?
        var text: String
        /// The reply buttons its text links, as each pill reads with its
        /// id ("✓ Fill in the form [b7k2abcd]"), or "unknown <id>".
        var buttons: [String]? = nil
    }

    struct Transcript: Encodable {
        var threadId: String
        var state: String
        /// Rows above the first one shown (more pages in as you scroll up).
        var hasMoreAbove: Bool
        var atBottom: Bool
        var rows: [Row]
    }

    var instance: String?
    var connection: String
    var runnerVersion: String
    var banner: BannerInfo?
    /// The Archived note with Undo at the top of the thread panel: its thread.
    var archivedNote: String?
    /// The milestone note at the top of the thread panel: its first line.
    var milestoneNote: String?
    var error: String?
    var window: Window?
    var sidebar: Sidebar
    var selection: Thread?
    /// The sub-agent whose transcript is showing, if one is.
    var subagent: String?
    /// The selected thread's panels and the pane (PanelsView).
    var panels: Panels?
    /// Its action chips (ActionChips).
    var actions: [ActionInfo] = []
    var composer: Composer
    /// The open card of asks and what's picked on it, as lines; nil when
    /// there's none.
    var decisions: [String]? = nil
    var transcript: Transcript?
    /// The usage popover's content as lines, and whether it's open.
    var usage: Usage? = nil
    /// The project page showing in place of the thread, if one is.
    var project: ProjectInfo? = nil
    /// The Projects page's cards, while it's showing: "Title: 1 needs
    /// you · 2 working" (or "Title: quiet").
    var projectCards: [String]? = nil
    /// The librarian's state in words ("Looking at ..."), when the runner
    /// has projects.
    var librarian: String? = nil
    /// Empty from a runner older than pools.
    var pools: [PoolInfo] = []
    /// The window's panels and where they are (WindowDock), in one line.
    var dock: String = ""

    struct ProjectInfo: Encodable {
        var id: String
        var title: String
        var folders: [String]
        var threads: [String]
        var patches: [String]
        var archived: Bool
    }

    struct Usage: Encodable {
        var shown: Bool
        var lines: [String]
    }

    struct ActionInfo: Codable {
        var id: String
        var title: String
        var kind: String
        var running: Bool
    }

    struct Panels: Codable {
        struct Item: Codable {
            var id: String
            var title: String
            var kind: String
            var url: String?
            var note: String?
            var active: Bool
        }
        var shown: Bool
        var width: Int
        var items: [Item]
        /// A file or page open over the section: "file /path" or "page <url>".
        var preview: String?
        /// What the Highlights section has: "3 pinned, 2 files, ..." or why not.
        var highlights: String?
    }

    static func connectionName(_ state: ConnectionState) -> String {
        switch state {
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .runnerDown: return "down"
        case .lost: return "lost"
        case .unauthorized: return "unauthorized"
        }
    }

    @MainActor
    static func make(app: AppModel, window: NSWindow?, instance: String?) -> AppDump {
        let now = Date()
        func thread(_ summary: ThreadSummary, section: InboxSection? = nil) -> Thread {
            let look = ThreadRowLook(summary, section: section)
            let selectedSub = app.subagentSelection?.threadId == summary.id ? app.subagentSelection?.subagentId : nil
            // Put-away rows list no sub-agents, as in the sidebar.
            let subagents = section == nil || section?.isPutAway == true ? [] : SubagentRows.visible(summary, threadSelected: app.selection == summary.id, selectedSubagent: selectedSub, now: app.now, finishedShown: section != .inbox).map {
                SubagentInfo(id: $0.id, depth: $0.depth, status: $0.subagent.status.rawValue, title: SubagentRows.title($0.subagent),
                             detail: SubagentRows.detail($0.subagent), selected: $0.id == selectedSub)
            }
            return Thread(id: summary.id, title: summary.title, status: summary.status.rawValue, needsYou: summary.needsYou,
                          unread: look.unread, hovered: app.hoverOverride == summary.id,
                          background: look.status == .background ? BackgroundWork.short(summary.background) : nil,
                          waiting: summary.waitingForRoom.map { Pools.waitingLine($0, now: app.now) } ?? (summary.waitingForNetwork != nil ? "Waiting for connection" : nil),
                          subagents: subagents, runner: app.runnerPlace(of: summary))
        }
        let sections: [Section]
        switch app.sidebarMode {
        case .inbox:
            let built = app.sections
            sections = InboxSection.allCases.map { section in
                Section(name: section.title, threads: built[section].map { thread($0, section: section) },
                        collapsed: app.collapsedSections.contains(section))
            }
        case .projects:
            // A section per project, then the threads in none.
            let built = app.projectSections
            sections = built.sections.map { Section(name: $0.project.title, threads: $0.threads.map { thread($0) }) }
                + [Section(name: "Not in a project", threads: built.unfiled.map { thread($0) })]
        case .librarian:
            // Looks in the thread shape: the queue's reason, or what a look
            // did, is the status.
            let status = app.librarian
            sections = [
                Section(name: "Next", threads: (status?.queue ?? []).map { job in
                    Thread(id: job.threadId, title: job.threadTitle, status: job.reason.rawValue, needsYou: false, unread: false, hovered: false)
                }),
                Section(name: "Recent", threads: (status?.recent ?? []).map { entry in
                    Thread(id: entry.threadId, title: entry.text, status: entry.outcome.rawValue, needsYou: false, unread: false, hovered: false)
                }),
            ]
        case .scheduled:
            // Schedules in the thread shape: their state is the status.
            let groups = ScheduleSection.group(app.schedules)
            sections = ScheduleSection.allCases.map { section in
                Section(name: section.title, threads: (groups[section] ?? []).map { schedule in
                    Thread(id: schedule.id, title: schedule.title, status: schedule.paused ? "paused" : schedule.isFinished ? "finished" : "active",
                           needsYou: false, unread: false, hovered: app.hoverOverride == schedule.id)
                }, collapsed: app.collapsedScheduleSections.contains(section))
            }
        }
        let key = app.selection ?? "new"
        var transcript: Transcript?
        if let session = app.transcript.session {
            let table = app.transcript.tableView
            let visible = table.rows(in: table.visibleRect)
            let rows = (0..<session.displayCount).map { index -> Row in
                let row = session.displayRow(index)
                return Row(id: row.id, kind: row.kind.rawValue, height: Int(table.rect(ofRow: index).height.rounded()),
                           expanded: opens(row) ? app.transcript.isExpanded(row) : nil, inGroup: row.inGroup,
                           onScreen: NSLocationInRange(index, visible), seq: row.seq, turn: row.turnId, text: RowDebug.excerpt(row),
                           buttons: Self.buttons(row))
            }
            let state: String
            switch session.state {
            case .idle: state = "idle"
            case .loading: state = "loading"
            case .loaded: state = "loaded"
            case .failed(let message): state = "failed: \(message)"
            }
            transcript = Transcript(threadId: session.threadId, state: state, hasMoreAbove: session.hasMoreAbove,
                                    atBottom: app.transcript.isAtBottom, rows: rows)
        }
        let appearance = window?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? "dark" : "light"
        return AppDump(
            instance: instance,
            connection: connectionName(app.connection),
            runnerVersion: app.runnerVersion,
            banner: app.banner.map { BannerInfo(style: $0.style.rawValue, text: $0.text, detail: $0.detail) },
            archivedNote: app.archivedNote?.threadId,
            milestoneNote: app.milestoneNote.map { ThreadMilestones.title($0.tier) },
            error: app.errorMessage,
            window: window.map { Window(width: Int(contentSize($0).width), height: Int(contentSize($0).height), appearance: appearance) },
            sidebar: Sidebar(mode: String(describing: app.sidebarMode), sections: sections,
                             snoozed: ThreadSections.snoozed(app.threads.values, now: now).count, archived: app.archivedCount),
            selection: app.selectedThread.map { thread($0) },
            subagent: app.subagentSelection?.subagentId,
            panels: app.selectedThread.flatMap { panels($0, app: app) },
            actions: app.selectedThread.map { thread in
                thread.actions.map { ActionInfo(id: $0.id, title: $0.title, kind: $0.kind.rawValue, running: app.isRunning(action: $0, in: thread.id)) }
            } ?? [],
            composer: composer(app, key: key),
            decisions: app.selectedThread.flatMap { decisions($0, app: app) },
            transcript: transcript,
            usage: Usage(shown: app.usageShown, lines: usageLines(app)),
            project: app.openProject.map { project in
                let threads = ProjectSections.threads(in: project.id, from: app.threads.values)
                return ProjectInfo(id: project.id, title: project.title, folders: project.folders, threads: threads.map(\.id),
                                   patches: PatchGroups.patches(of: project, in: threads).map(\.patch.id), archived: project.archived)
            },
            projectCards: app.openProject == nil && app.showsProjectsHome ? app.projectCards.map { card in
                card.project.title + ": " + (card.status.isQuiet ? "quiet" : card.status.parts.map(\.text).joined(separator: " · "))
            } : nil,
            librarian: app.librarian.map(LibrarianText.state),
            pools: app.usesPools ? app.pools.map { pool in
                PoolInfo(id: pool.id, title: pool.title, logins: pool.accountIds, folders: pool.folders,
                         rail: Pools.railSubtitle(pool, accounts: app.accounts), status: Pools.statusLine(pool, accounts: app.accounts, now: app.now))
            } : [],
            dock: app.dock.layout.summary.replacingOccurrences(of: "threadbear.", with: "")
        )
    }

    @MainActor
    private static func panels(_ thread: ThreadSummary, app: AppModel) -> Panels? {
        let section = app.paneSection(for: thread)
        var items = [Panels.Item(id: PaneSection.highlightsId, title: "Highlights", kind: "highlights", url: nil, note: nil, active: section == .highlights)]
        items += thread.panels.map {
            Panels.Item(id: $0.id, title: $0.title, kind: $0.kind.rawValue, url: $0.url, note: $0.note, active: section == .panel($0.id))
        }
        if !thread.patches.isEmpty {
            let summary = thread.patches.map { $0.id + ($0.error != nil ? " (error)" : "") }.joined(separator: ", ")
            items.append(Panels.Item(id: PaneSection.patchesId, title: "Patches", kind: "patches", url: nil, note: summary, active: section == .patches))
        }
        let preview: String? = app.panePreview[thread.id].map { preview in
            switch preview.target {
            case .file(let path): "file \(path)" + (preview.editing ? " (editing)" : "") + (preview.away.map { " (from \($0)\(preview.cut ? ", cut" : ""))" } ?? "")
            case .folder(let path): "folder \(path)" + (preview.away.map { " (from \($0))" } ?? "") + (FolderPaneView.current.map { " " + $0.summary } ?? "")
            case .page(let url): "page \(url.absoluteString)"
            case .remote(let path, let failed): "fetching \(path)" + (failed.map { " (failed: \($0))" } ?? "")
            case .explain:
                // What was asked and where each answer is up to, for a script.
                "explain " + (app.explainers[thread.id].map { session in
                    session.title + " | " + session.turns.map { $0.answer ?? $0.error.map { "error: \($0)" } ?? "pending" }.joined(separator: " | ")
                } ?? "(none)")
            }
        }
        return Panels(shown: app.showsPanels(for: thread), width: Int(app.dock.frame(of: section.id)?.width ?? 0), items: items, preview: preview,
                      highlights: highlightsLine(app, thread.id))
    }

    @MainActor
    private static func highlightsLine(_ app: AppModel, _ threadId: String) -> String {
        if app.highlightsUnsupported { return "not kept by this runner" }
        guard let fetched = app.highlights[threadId] else { return "not fetched" }
        let sections = HighlightSections.build(fetched)
        if sections.isEmpty { return "empty" }
        let parts = [("pinned", sections.pinned.count), ("files", sections.files.count), ("links", sections.links.count),
                     ("commits", sections.commits.count), ("edited", sections.edited.count)]
        let counts = parts.filter { $0.1 > 0 }.map { "\($0.1) \($0.0)" }
        let folded = app.collapsedHighlights.isEmpty ? [] : ["folded: \(app.collapsedHighlights.sorted().joined(separator: " "))"]
        return ((sections.brief != nil ? ["a brief"] : []) + counts + folded).joined(separator: ", ")
    }

    /// What the Usage panel says: each login's room by pool and provider
    /// (`UsagePanel`), then the CLIs from the Updates panel, as the
    /// automation's `usage` presses their buttons.
    @MainActor
    static func usageLines(_ app: AppModel) -> [String] {
        var lines: [String] = []
        // The spend at the top, as the tiles say it.
        if let stats = app.usageStats {
            let ids = app.accounts.map(\.id)
            var spend = "Today " + UsageStatsMath.tokens(UsageStatsMath.today(stats, accounts: ids, now: app.now).total)
            spend += ", last hour " + UsageStatsMath.tokens(UsageStatsMath.lastHour(stats, accounts: ids, now: app.now))
            if !stats.ready { spend += " (still reading)" }
            lines.append(spend)
        }
        let groups = UsageGroups.build(pools: app.poolsSupported ? app.pools : [], accounts: app.accounts)
        let pooled = groups.contains { $0.pool != nil }
        for group in groups {
            if pooled { lines.append("# " + group.title) }
            for section in group.providers {
            lines.append((pooled ? "## " : "# ") + ModelPicker.providerTitle(section.provider))
            for account in section.accounts {
                var line = AccountName.title(account)
                if let plan = account.plan { line += " (\(plan))" }
                if let note = account.note { line += ", " + note }
                if let usage = account.usage {
                    if usage.blocked { line += ", limit reached" }
                    if usage.stale { line += ", stale" }
                    let windows = usage.windows.map { "\($0.title) \(AccountUsageText.percent($0.remainingPercent))" }
                    if !windows.isEmpty { line += ": " + windows.joined(separator: ", ") }
                    if let notice = usage.notice { line += " [\(notice)]" }
                } else {
                    line += ": nothing known"
                }
                lines.append(line)
            }
            }
        }
        if let source = AccountUsageText.sourceLine(app.accounts, now: app.now) { lines.append(source) }
        lines.append("# CLIs")
        if app.clisSupported == false || (app.clisSupported == nil && app.clis.isEmpty) {
            lines.append("needs a newer runner")
        } else {
            for cli in app.clis {
                var line = CliText.statusLine(cli) + " (" + CliText.policyTitle(cli.policy).lowercased() + ")"
                if let button = CliText.updateTitle(cli) { line += " [\(button)]" }
                if let back = CliText.goBackTitle(cli) { line += " [\(back)]" }
                if CliText.isUpdating(cli), let text = CliText.bannerText(cli) { line += ": " + text }
                lines.append(line)
            }
        }
        return lines
    }

    /// What's in an ask's Something else box, quoted, with its pictures.
    private static func ownAnswer(_ note: AskNote?) -> String {
        let note = note ?? AskNote()
        let pictures = note.images.isEmpty ? "" : " +\(note.images.count) picture\(note.images.count == 1 ? "" : "s")"
        return "\"\(note.text)\"" + pictures
    }

    /// "2 picked", then each ask with its choices, "*" on the agent's
    /// pick, its links and the answer picked.
    @MainActor
    static func decisions(_ thread: ThreadSummary, app: AppModel) -> [String]? {
        guard Decisions.isOpen(thread, card: app.sessions[thread.id]?.openCard) else { return nil }
        let picks = app.picks(for: thread)
        let notes = app.notes(for: thread)
        var lines = ["\(picks.count) picked"]
        for (i, ask) in thread.asks.enumerated() {
            let options = Decisions.choices(for: ask)
            let choices = options.enumerated().map { $0.offset == ask.suggested ? "*\($0.element)" : $0.element }
            let links = ask.links.isEmpty ? "" : " links: " + ask.links.map(\.title).joined(separator: ", ")
            let answer = picks[i] == Decisions.ownAnswer ? "something else: " + ownAnswer(notes[i]) : picks[i].flatMap { options.indices.contains($0) ? options[$0] : nil } ?? "no answer"
            lines.append("  \(i + 1). \(ask.action) [\(choices.joined(separator: " | "))]\(links) -> \(answer)")
        }
        return lines
    }

    @MainActor
    private static func composer(_ app: AppModel, key: String) -> Composer {
        let settings: Settings
        if let thread = app.selectedThread {
            // A thread's model is its own, or what its last turn ran on,
            // or the account's default.
            let model = thread.model ?? thread.modelInUse.map { "default (the account's, \($0))" } ?? defaultModel(app, account: thread.accountId)
            settings = Settings(cwd: thread.cwd, account: thread.accountId, model: model, ask: thread.permissionMode == .ask,
                                mode: thread.permissionMode, effort: thread.effort ?? thread.effortInUse.map { "default (\($0))" } ?? "default",
                                pool: app.usesPools ? thread.poolId : nil)
        } else {
            settings = newThreadSettings(app)
        }
        // Chips as the [Picture N] markers they'll go as, not invisible marks.
        return Composer(draft: key, text: InlinePictures.messageText(app.drafts[key]?.normalized.text ?? ""), images: app.drafts[key]?.images.count ?? 0,
                        editing: app.editing[key]?.seq,
                        cwd: settings.cwd, account: settings.account, model: settings.model, ask: settings.ask, mode: settings.mode, effort: settings.effort,
                        pool: settings.pool, chip: ThreadSettings(app: app, thread: app.selectedThread).modelChipTitle,
                        runner: app.selectedThread.flatMap(app.runnerName(of:)) ?? (app.selectedThread == nil ? app.newThreadRunner?.name : nil))
    }

    /// Rows a click opens: work lines, groups and settled approvals that
    /// have something to show.
    static func opens(_ row: TranscriptRow) -> Bool {
        switch row.content {
        case .group, .tool, .reasoning: return true
        case .approval(let item): return item.resolution != nil && item.opens
        default: return false
        }
    }

    /// The window's content size, as `--window-size` and `resize` set it
    /// (the toolbar included).
    static func contentSize(_ window: NSWindow) -> NSSize {
        window.contentRect(forFrameRect: window.frame).size
    }

    func json(pretty: Bool) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(self)) ?? Data()
        return String(decoding: data, as: UTF8.self) + (pretty ? "\n" : "")
    }

    /// For reading: one thing per line, rows in a table, `>` marking the
    /// rows on screen.
    var text: String {
        var lines: [String] = []
        var head = "\(instance.map { "dev app \($0)" } ?? "app"): \(connection)"
        if !runnerVersion.isEmpty { head += ", runner \(runnerVersion)" }
        if let window { head += ", window \(window.width)x\(window.height) \(window.appearance)" }
        lines.append(head)
        if let banner { lines.append("banner (\(banner.style)): \(banner.text)" + (banner.detail.map { "  [\($0)]" } ?? "")) }
        if let archivedNote { lines.append("archived note: \(archivedNote), with Undo") }
        if let milestoneNote { lines.append("milestone note: \(milestoneNote)") }
        if let error { lines.append("error banner: \(error)") }
        lines.append("")
        lines.append("sidebar, \(sidebar.mode) (\(sidebar.snoozed) snoozed, \(sidebar.archived) archived):")
        // Columns as wide as the longest id: a real runner's ids are 36
        // character UUIDs, and fixed widths pushed every later column out
        // of line.
        let threadWidth = max(12, sidebar.sections.flatMap(\.threads).map(\.id.count).max() ?? 0)
        for section in sidebar.sections where !section.threads.isEmpty {
            lines.append("  \(section.name)" + (section.collapsed == true ? " (collapsed)" : ""))
            for thread in section.threads {
                var flags = [thread.status]
                if thread.unread { flags.append("unread") }
                if thread.hovered { flags.append("hovered") }
                if let background = thread.background { flags.append("bg: " + background) }
                if let waiting = thread.waiting { flags.append(waiting) }
                if let runner = thread.runner { flags.append(runner) }
                let mark = thread.id == selection?.id ? ">" : " "
                lines.append("  \(mark) \(pad(thread.id, threadWidth)) \(pad(flags.joined(separator: " "), 16)) \(thread.title)")
                for sub in thread.subagents {
                    let indent = String(repeating: "  ", count: sub.depth + 1)
                    lines.append("  \(sub.selected ? ">" : " ") \(indent)sub \(sub.id) [\(sub.status)] \(sub.title): \(sub.detail)")
                }
            }
        }
        lines.append("")
        if let selection {
            lines.append("selection: \(selection.id) \"\(selection.title)\" (\(selection.status))" + (subagent.map { ", showing sub-agent \($0)" } ?? ""))
        } else {
            lines.append("selection: none (new thread)")
        }
        if let panels {
            let items = panels.items.map { item in
                var text = item.title + (item.active ? "*" : "") + " (\(item.kind)"
                // A data: URL (the mock's page) is thousands of characters.
                if let url = item.url { text += " " + (url.count > 80 ? String(url.prefix(77)) + "…" : url) }
                text += ")"
                if let note = item.note { text += " \"\(note)\"" }
                return text
            }
            lines.append("panels (\(panels.shown ? "shown, \(panels.width) wide" : "hidden")): " + items.joined(separator: ", "))
            if let preview = panels.preview { lines.append("pane preview: \(preview)") }
            if let highlights = panels.highlights { lines.append("highlights: \(highlights)") }
        }
        if !actions.isEmpty {
            lines.append("actions: " + actions.map { "\($0.id) \"\($0.title)\" (\($0.kind)\($0.running ? ", running" : ""))" }.joined(separator: ", "))
        }
        if let usage, usage.shown {
            lines.append("usage popover:")
            lines += usage.lines.map { "  " + $0 }
        }
        if let decisions { lines.append("decisions: " + decisions[0]); lines += decisions.dropFirst().map { "  " + $0 } }
        lines.append("composer (\(composer.draft)): \"\(composer.text)\"" + (composer.images > 0 ? " and \(composer.images) image(s)" : "")
            + (composer.editing.map { ", editing the message at seq \($0)" } ?? ""))
        let on = composer.pool.map { "pool \($0) (now \(composer.account))" } ?? (pools.isEmpty || composer.runner != nil ? composer.account : "\(composer.account), pinned")
        lines.append("  \(composer.draft == "new" ? "starts" : "runs") in \(composer.cwd)\(composer.runner.map { " on \($0)" } ?? "") on \(on), model \(composer.model), "
            + (composer.effort == "default" ? "" : "effort \(composer.effort), ") + Self.modeText(composer.mode))
        lines.append("  model chip: \(composer.chip)")
        lines.append("dock: \(dock)")
        if !pools.isEmpty {
            lines.append("pools:")
            for pool in pools {
                var line = "  \(pool.id) \"\(pool.title)\" \(pool.rail): " + pool.logins.joined(separator: ", ")
                if !pool.folders.isEmpty { line += " [folders: " + pool.folders.joined(separator: ", ") + "]" }
                if let status = pool.status { line += " (\(status))" }
                lines.append(line)
            }
        }
        if let transcript {
            var about = "\(transcript.rows.count) rows, \(transcript.state)"
            if transcript.hasMoreAbove { about += ", more above" }
            about += transcript.atBottom ? ", at the bottom" : ", scrolled up"
            lines.append("")
            lines.append("transcript \(transcript.threadId): \(about)")
            let ids = transcript.rows.map { ($0.inGroup ? "  " : "") + $0.id }
            let rowWidth = max(12, ids.map(\.count).max() ?? 0)
            for (row, id) in zip(transcript.rows, ids) {
                let open = row.expanded.map { $0 ? "open" : "closed" } ?? ""
                lines.append("\(row.onScreen ? ">" : " ") \(pad(id, rowWidth)) \(pad(row.kind, 10)) \(pad(String(row.height), 5)) \(pad(open, 7)) \(row.text)")
                for button in row.buttons ?? [] { lines.append("  \(pad("", rowWidth)) button     \(button)") }
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// The pills a reply's buttons show as, for `dump`.
    static func buttons(_ row: TranscriptRow) -> [String]? {
        guard case .assistant(let item) = row.content else { return nil }
        let ids = ReplyButtons.ids(in: item.text)
        guard !ids.isEmpty else { return nil }
        return ids.map { id in
            guard let known = ReplyButtons.shared.known(id) else { return "unknown \(id)" }
            let look = ReplyButtons.look(known.button, pressing: ReplyButtons.shared.isPressing(id))
            return "\(ReplyButtons.label(known.button, look: look)) [\(id), \(look.rawValue)]"
        }
    }

    private func pad(_ text: String, _ width: Int) -> String {
        text.count >= width ? text : text + String(repeating: " ", count: width - text.count)
    }
}
#endif
