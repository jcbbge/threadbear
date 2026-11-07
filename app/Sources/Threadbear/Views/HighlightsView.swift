import AppKit
import AVKit
import Quartz
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

/// The pane's Highlights section: what the thread has made, shared and
/// pinned, so it doesn't scroll away with the transcript. The librarian's
/// line on where it's up to, the projects it's in (why, behind an ⓘ, and
/// their links: live site, admin page, and Notion board), its schedules and sub-agents, then pins, files, links
/// and commits, each under a grey heading like the sidebar's, and left out
/// when empty. A click on a heading folds its rows away, for every thread.
struct HighlightsView: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    @State private var editedOpen = false
    /// "Show all" on Links and Changes, for the thread on show.
    @State private var allLinks = false
    @State private var allCommits = false
    @State private var allSubagents = false
    @State private var allStarted = false

    var body: some View {
        if app.highlightsUnsupported {
            PaneNote(text: "This runner doesn't keep highlights yet.")
        } else if let fetched = app.highlights[thread.id] {
            let sections = HighlightSections.build(fetched)
            let projects = HighlightProjects.build(thread: thread, project: app.project)
            if sections.isEmpty && openAsks == nil && projects.isEmpty && toolPanels.isEmpty && schedules.isEmpty && thread.subagents.isEmpty && startedThreads.isEmpty {
                PaneNote(text: "Nothing here yet. Files, links and commits from this thread show up here as it works.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        content(sections, projects: projects)
                    }
                    .padding(.bottom, zoomed(16))
                }
            }
        } else {
            // The first fetch is quick; a spinner would only flash.
            Color.clear
        }
    }

    /// The panels of the thread's tool patches (appliesTo: Tandem's in a
    /// video folder), each a card at the top, so a tool's state is where
    /// Mike already looks rather than only on the rail (Mike picked this,
    /// 28 Oct).
    private var toolPanels: [Panel] {
        let tools = Set(thread.patches.filter { !($0.matched ?? []).isEmpty }.map(\.id))
        return thread.panels.filter { tools.contains($0.patch) }
    }

    @ViewBuilder
    private func content(_ sections: HighlightSections, projects: [HighlightProjects.Row]) -> some View {
        ForEach(toolPanels) { panel in
            ToolCard(panel: panel) { app.choosePanel(panel.id, in: thread.id) }
                .padding(.horizontal, SidebarMetrics.outerInset)
                .padding(.top, zoomed(10))
        }
        if let brief = sections.brief {
            let points = HighlightSections.points(brief)
            VStack(alignment: .leading, spacing: zoomed(4)) {
                ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                    HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                        // An old paragraph brief is one point: no bullet.
                        if points.count > 1 { Text("•") }
                        Text(point)
                            .lineSpacing(zoomed(2))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .font(.system(size: TypeScale.label))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .padding(.horizontal, SidebarMetrics.leading)
            .padding(.top, zoomed(14))
            .padding(.bottom, zoomed(2))
        }
        // The last turn's asks while its card is open, ticked here or in
        // the transcript alike (the same `threads.tickAsk`).
        if let asksSeq = openAsks {
            // Folded, the count is what's still to do, not what's been ticked.
            SectionHeading(title: "Needs you", icon: "hand.raised", fold: fold(HighlightFold.needsYou, count: thread.asks.filter { !$0.ticked }.count))
            if !isFolded(HighlightFold.needsYou) {
                ForEach(Array(thread.asks.enumerated()), id: \.offset) { index, ask in
                    AskRow(ask: ask) {
                        app.session(for: thread.id).tickAsk(asksSeq: asksSeq, index: index, ticked: !ask.ticked)
                    }
                }
            }
        }
        // The thread's projects, each under its own icon with why it's
        // there behind an ⓘ (Mike asked 30 Oct), then the places Mike keeps
        // going back to for it, so the live site is one click from any of
        // its threads (28 Oct).
        ForEach(projects) { row in
            // Its Notion board, so what's next for the project is in the
            // pane that's open by default (Mike asked 30 Oct; a board since
            // 3 Nov, when he picked columns over a list).
            let tasks = row.project.tasks.flatMap { $0.loading ? nil : $0 }
            let key = HighlightFold.project(row.project.id)
            // A project with no links or open cards has nothing to fold.
            let count = row.project.links.count + (tasks?.openCount ?? 0)
            SectionHeading(title: row.project.title, project: row.project, fold: count > 0 ? fold(key, count: count) : nil) {
                ProjectWhyButton(row: row, threadId: thread.id)
            }
            if !isFolded(key) {
                ForEach(row.project.links, id: \.url) { projectLink($0) }
                if let tasks { HighlightsBoard(tasks: tasks, thread: thread) }
            }
        }
        // What will message the thread later, and the helpers it started:
        // they were a line over the composer and only the sidebar's rows
        // under the thread, and Mike wanted them here (29 Oct).
        let scheduled = schedules
        if !scheduled.isEmpty {
            SectionHeading(title: "Scheduled", icon: "clock", fold: fold(HighlightFold.scheduled, count: scheduled.count))
            if !isFolded(HighlightFold.scheduled) {
                ForEach(scheduled) { scheduleRow($0) }
            }
        }
        if !thread.subagents.isEmpty {
            let all = SubagentRows.highlights(thread)
            SectionHeading(title: "Sub-agents", icon: "person.2", fold: fold(HighlightFold.subagents, count: all.count))
            if !isFolded(HighlightFold.subagents) {
                let subagents = HighlightSections.capped(all, limit: HighlightSections.subagentLimit, showAll: allSubagents)
                ForEach(subagents.shown) { subagentRow($0) }
                if subagents.more > 0 { showAll(all.count) { allSubagents = true } }
            }
        }
        // The threads it handed work to, or is waiting on, with where each
        // is up to (StartedThreadRows says why it's here).
        let started = startedThreads
        if !started.isEmpty {
            SectionHeading(title: "Threads it started", icon: "pawprint", fold: fold(HighlightFold.startedThreads, count: started.count))
            if !isFolded(HighlightFold.startedThreads) {
                let shown = HighlightSections.capped(started, limit: HighlightSections.subagentLimit, showAll: allStarted)
                ForEach(shown.shown) { startedRow($0) }
                if shown.more > 0 { showAll(started.count) { allStarted = true } }
            }
        }
        if !sections.pinned.isEmpty {
            SectionHeading(title: "Pinned", icon: "pin", fold: fold(HighlightFold.pinned, count: sections.pinned.count))
            if !isFolded(HighlightFold.pinned) {
                ForEach(sections.pinned) { row($0) }
            }
        }
        if !sections.files.isEmpty {
            SectionHeading(title: "Files", icon: "doc", fold: fold(HighlightFold.files, count: sections.files.count))
            if !isFolded(HighlightFold.files) {
                ForEach(sections.files) { row($0) }
            }
        }
        if !sections.links.isEmpty {
            SectionHeading(title: "Links", icon: "link", fold: fold(HighlightFold.links, count: sections.links.count))
            if !isFolded(HighlightFold.links) {
                let links = HighlightSections.capped(sections.links, limit: HighlightSections.linkLimit, showAll: allLinks)
                ForEach(links.shown) { row($0) }
                if links.more > 0 { showAll(sections.links.count) { allLinks = true } }
            }
        }
        if !sections.commits.isEmpty || !sections.edited.isEmpty {
            SectionHeading(title: "Changes", icon: "arrow.triangle.branch", fold: fold(HighlightFold.changes, count: sections.commits.count + sections.edited.count))
            if !isFolded(HighlightFold.changes) {
                let commits = HighlightSections.capped(sections.commits, limit: HighlightSections.commitLimit, showAll: allCommits)
                ForEach(commits.shown) { row($0) }
                if commits.more > 0 { showAll(sections.commits.count) { allCommits = true } }
                if !sections.edited.isEmpty { edited(sections.edited) }
            }
        }
    }

    private func isFolded(_ key: String) -> Bool {
        app.collapsedHighlights.contains(key)
    }

    /// A heading's fold, the same as the sidebar's.
    private func fold(_ key: String, count: Int) -> SectionFold {
        let folded = isFolded(key)
        return .init(collapsed: folded, count: count) {
            withAnimation(.snappy(duration: 0.2)) {
                if folded { app.collapsedHighlights.remove(key) } else { app.collapsedHighlights.insert(key) }
            }
        }
    }

    private var schedules: [ScheduleRows.Row] {
        ScheduleRows.rows(for: thread, in: app.schedules, now: app.now, target: app.scheduleTarget)
    }

    private func scheduleRow(_ row: ScheduleRows.Row) -> some View {
        PaneRow(icon: row.paused ? "pause.circle" : "clock", title: row.title, trailing: row.when, detail: row.detail, titleTruncation: .tail, detailTruncation: .tail) {
            app.editSchedule(row.id)
        }
        .tip("Edit the schedule")
        .iconContextMenu {
            Button("Edit", systemImage: "pencil") { app.editSchedule(row.id) }
            Button("Show all schedules", systemImage: "clock") { app.showSchedules() }
        }
    }

    /// Like its row under the thread in the sidebar: how it's doing, what
    /// it's up to or found, and how long it took. Opens its transcript.
    private func subagentRow(_ subagent: Subagent) -> some View {
        let (icon, color): (String, Color?) = switch subagent.status {
        case .running: ("circle.dashed", nil)
        case .completed: ("checkmark", nil)
        case .failed: ("xmark", Color(nsColor: Theme.failed))
        case .stopped: ("minus", nil)
        }
        return PaneRow(icon: icon, iconColor: color, title: SubagentRows.title(subagent),
                       trailing: SubagentRows.duration(subagent, now: app.now), detail: SubagentRows.detail(subagent),
                       titleTruncation: .tail, detailTruncation: .tail) {
            app.selectSubagent(threadId: thread.id, subagentId: subagent.id)
        }
        .tip("\(SubagentRows.statusText(subagent)). Click to read its transcript.")
    }

    private var startedThreads: [StartedThreadRows.Row] {
        StartedThreadRows.rows(for: thread, in: app.threads, now: app.now)
    }

    /// Opens the thread itself, as a thread chip in a reply does.
    private func startedRow(_ row: StartedThreadRows.Row) -> some View {
        let color: Color? = switch row.state {
        case .needsYou: Color.accentColor
        case .failed: Color(nsColor: Theme.failed)
        default: nil
        }
        return PaneRow(icon: StartedThreadRows.icon(row.state), iconColor: color, title: row.thread.title,
                       detail: StartedThreadRows.detail(row, now: app.now),
                       titleTruncation: .tail, detailTruncation: .tail) {
            app.openThread(row.thread.id)
        }
        .tip("Open this thread")
        .iconContextMenu {
            Button("Open", systemImage: "arrow.up.forward") { app.openThread(row.thread.id) }
            Button("Open in New Panel", systemImage: "rectangle.split.2x1") { app.openThreadInPanel(row.thread.id) }
        }
    }

    /// The open card's seq, when the thread has asks on it.
    private var openAsks: Int? {
        thread.asks.isEmpty ? nil : thread.asksSeq
    }

    /// Under a long group: the rest of it, newest first like the rest.
    private func showAll(_ count: Int, action: @escaping () -> Void) -> some View {
        PaneRow(icon: "ellipsis", title: "Show all \(count)", quiet: true) {
            withAnimation(.easeOut(duration: 0.15)) { action() }
        }
    }

    private func row(_ item: Highlight) -> some View {
        let isCommit = item.kind == .commit
        let detail: String? = if let path = item.path {
            HighlightText.folder(of: path, cwd: thread.cwd)
        } else if isCommit {
            HighlightText.commitLine(item)
        } else {
            // Not when it says the same as the title (a bare localhost link).
            item.url.map(HighlightText.address).flatMap { $0 == item.title ? nil : $0 }
        }
        // A pin says why in its note; the rest say how they turned up.
        let how = item.isPinned || isCommit ? nil : item.how.word
        return PaneRow(icon: FileIcon.symbol(for: item), title: item.title, lead: isCommit ? item.sha : nil,
                       trailing: how.flatMap { $0.isEmpty ? nil : $0 }, note: item.note, detail: detail,
                       titleTruncation: item.path == nil ? .tail : .middle,
                       action: isCommit ? nil : { app.open(item, in: thread, external: false) })
            .fileDrag(item.path.map(URL.init(fileURLWithPath:)) ?? item.link, in: thread)
            .iconContextMenu {
                if let path = item.path {
                    FileMenu(path: path, thread: thread, title: item.title)
                } else if let url = item.link {
                    LinkMenu(url: url, thread: thread, title: item.title)
                } else if let sha = item.sha {
                    Button("Copy sha", systemImage: "number") { app.copyToPasteboard(sha) }
                }
                Divider()
                Button("Remove", systemImage: "pin.slash") { app.removeHighlight(item, in: thread.id) }
            }
    }

    private func projectLink(_ link: ProjectLink) -> some View {
        let address = HighlightText.address(link.url)
        return PaneRow(icon: "globe", title: link.title, detail: address == link.title ? nil : address, titleTruncation: .tail) {
            if let url = link.link { app.openLink(url, title: link.title, in: thread) }
        }
        .tip("Open \(address)")
        .iconContextMenu {
            if let url = link.link { LinkMenu(url: url, thread: thread, title: link.title) }
        }
    }

    /// "4 files edited", which opens to the files; a click opens one in
    /// its own app, since it's code to read in an editor, not to review.
    @ViewBuilder
    private func edited(_ paths: [String]) -> some View {
        PaneRow(icon: editedOpen ? "chevron.down" : "chevron.right", title: HighlightText.editedCount(paths.count), quiet: true) {
            withAnimation(.easeOut(duration: 0.15)) { editedOpen.toggle() }
        }
        if editedOpen {
            ForEach(paths, id: \.self) { path in
                PaneRow(icon: FileIcon.symbol(forPath: path), title: (path as NSString).lastPathComponent,
                        detail: HighlightText.folder(of: path, cwd: thread.cwd), indent: true) {
                    if thread.isRemote {
                        app.openRemoteFile(URL(fileURLWithPath: path), .app, in: thread)
                    } else {
                        app.openExternally(URL(fileURLWithPath: path))
                    }
                }
                .tip("Open in its app")
                .fileDrag(URL(fileURLWithPath: path), in: thread)
                .iconContextMenu { FileMenu(path: path, thread: thread, title: (path as NSString).lastPathComponent) }
            }
        }
    }
}

/// The ⓘ on a project's heading in Highlights: who put the thread there
/// and why, and Keep, Take out and Open project, so a wrong guess of the
/// librarian's is undone where it's seen.
private struct ProjectWhyButton: View {
    @Environment(AppModel.self) private var app
    let row: HighlightProjects.Row
    let threadId: String

    private var shown: Binding<Bool> {
        Binding { app.projectWhyShown == row.project.id } set: { app.projectWhyShown = $0 ? row.project.id : nil }
    }

    var body: some View {
        Button { shown.wrappedValue.toggle() } label: {
            Image(systemName: "info.circle").font(.system(size: zoomed(11)))
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .tip("Why it's in \(row.project.title)")
        .popover(isPresented: shown, arrowEdge: .bottom) { card }
    }

    private var card: some View {
        let (who, reason) = HighlightProjects.why(row.membership)
        return VStack(alignment: .leading, spacing: zoomed(8)) {
            if let reason {
                Text(reason)
                    .font(.system(size: zoomed(13)))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(who)
                .font(.system(size: zoomed(12)))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: zoomed(8)) {
                if HighlightProjects.canKeep(row.membership) {
                    Button("Keep") {
                        app.setProjects(threadId, add: [row.project.id])
                        app.projectWhyShown = nil
                    }
                    .tip("Keep it in \(row.project.title), so the librarian never takes it out")
                }
                Button("Take out") {
                    app.setProjects(threadId, remove: [row.project.id])
                    app.projectWhyShown = nil
                }
                .tip("Take it out of \(row.project.title); the librarian won't put it back")
                Spacer(minLength: 0)
                Button("Open project") {
                    app.openProjectPage(row.project.id)
                    app.projectWhyShown = nil
                }
                .buttonStyle(.link)
                .tip("Open \(row.project.title)'s page")
            }
            .controlSize(.small)
        }
        .padding(zoomed(14))
        .frame(width: zoomed(280), alignment: .leading)
    }
}

extension View {
    /// Drags a row's file or link out of the app (FileDrag): a file as the
    /// file itself, for X or the Finder. Nothing for a file that's gone,
    /// and for another Mac's thread only this Mac's whole copy of it,
    /// never the file here that has the same path (Daybreak, 7 Nov).
    @ViewBuilder
    func fileDrag(_ url: URL?, in thread: ThreadSummary) -> some View {
        if let url {
            onDrag {
                guard let url = MainActor.assumeIsolated({ AppModel.shared.localCopy(of: url, in: thread) }),
                      FileDrag.writer(for: url) != nil else { return NSItemProvider() }
                // A page's ?query isn't part of its file.
                return NSItemProvider(object: (url.isFileURL ? URL(fileURLWithPath: url.path) : url) as NSURL)
            }
        } else {
            self
        }
    }
}

/// One row in the pane's lists (Highlights, a list panel): a grey icon, the
/// title with a word at its end, then a note and a grey line under it.
/// Shaped like the sidebar's rows, with the same hover.
struct PaneRow: View {
    var icon: String?
    var iconColor: Color?
    let title: String
    /// Before the title, monospaced: a commit's sha.
    var lead: String?
    /// At the end of the title's line, faint: "Written", "Opened".
    var trailing: String?
    var trailingSymbol: String?
    var note: String?
    var detail: String?
    /// Secondary title, for a row that's a control (the edited files' disclosure).
    var quiet = false
    var indent = false
    /// Keeps the icon's room with no icon, so a list where some rows have
    /// one still lines its titles up.
    var reservesIcon = false
    /// A file name keeps its extension (middle); a sentence its start.
    var titleTruncation: Text.TruncationMode = .middle
    /// A path keeps both ends; a sub-agent's report its start.
    var detailTruncation: Text.TruncationMode = .middle
    /// A list panel's sentence gets two; a path or a sha one.
    var detailLines = 1
    var action: (() -> Void)?
    @State private var hovering = false

    var body: some View {
        // A row with nothing to open (a commit) isn't a button: a disabled
        // one greyed it out as if it were unavailable.
        Group {
            if let action {
                Button(action: action) { label }
                    .buttonStyle(.plain)
            } else {
                label
            }
        }
        .padding(.horizontal, SidebarMetrics.outerInset)
        .onHover { hovering = $0 }
    }

    private var label: some View {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: zoomed(12)))
                        .foregroundStyle(iconColor.map(AnyShapeStyle.init) ?? AnyShapeStyle(Color(nsColor: Theme.faintIcon)))
                        .frame(width: zoomed(16))
                } else if reservesIcon {
                    Color.clear.frame(width: zoomed(16), height: 1)
                }
                VStack(alignment: .leading, spacing: zoomed(2)) {
                    HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                        if let lead {
                            Text(lead)
                                .font(.system(size: TypeScale.detail, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                        Text(title)
                            .font(.system(size: TypeScale.label))
                            .foregroundStyle(quiet ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                            .lineLimit(1)
                            .truncationMode(titleTruncation)
                        Spacer(minLength: zoomed(4))
                        if let trailing {
                            Text(trailing)
                                .font(.system(size: TypeScale.small))
                                .foregroundStyle(SidebarMetrics.faint)
                                .fixedSize()
                        }
                        if let trailingSymbol {
                            Image(systemName: trailingSymbol)
                                .font(.system(size: zoomed(11), weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let note, !note.isEmpty {
                        Text(note)
                            .font(.system(size: TypeScale.detail))
                            .foregroundStyle(.secondary)
                            .lineLimit(4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: TypeScale.small))
                            .foregroundStyle(SidebarMetrics.faint)
                            .lineLimit(detailLines)
                            .truncationMode(detailTruncation)
                            .fixedSize(horizontal: false, vertical: detailLines > 1)
                    }
                }
            }
            .padding(.leading, SidebarMetrics.leading - SidebarMetrics.outerInset + (indent ? zoomed(24) : 0))
            .padding(.trailing, SidebarMetrics.trailing)
            .padding(.vertical, zoomed(6))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering && action != nil ? SidebarMetrics.hover : .clear, in: RoundedRectangle(cornerRadius: SidebarMetrics.corner))
            .contentShape(Rectangle())
    }
}

/// One ask on the open card: a tick box, what Mike has to do, and where.
/// A ticked one is struck through and grey, as on the transcript's card.
private struct AskRow: View {
    let ask: Ask
    let tick: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            Button(action: tick) {
                Image(systemName: ask.ticked ? "checkmark.square.fill" : "square")
                    .font(.system(size: zoomed(13)))
                    .foregroundStyle(ask.ticked ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color(nsColor: Theme.faintIcon)))
                    .frame(width: zoomed(16))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .tip(ask.ticked ? "Not done" : "Done")
            VStack(alignment: .leading, spacing: zoomed(2)) {
                Text(ask.plainAction)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(ask.ticked ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .strikethrough(ask.ticked)
                    .fixedSize(horizontal: false, vertical: true)
                if let place = ask.plainWhere {
                    Text(place)
                        .font(.system(size: TypeScale.small))
                        .foregroundStyle(SidebarMetrics.faint)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, SidebarMetrics.leading)
        .padding(.trailing, SidebarMetrics.trailing + SidebarMetrics.outerInset)
        .padding(.vertical, zoomed(6))
    }
}

/// A file row's menu.
struct FileMenu: View {
    @Environment(AppModel.self) private var app
    let path: String
    let thread: ThreadSummary
    let title: String

    var body: some View {
        Button("Preview here", systemImage: "sidebar.right") { app.preview(path: path, title: title, in: thread) }
        if thread.isRemote {
            // On that Mac: its copy here, once it's fetched.
            Button("Open", systemImage: "arrow.up.forward.app") { app.openRemoteFile(URL(fileURLWithPath: path), .app, in: thread, title: title) }
        } else {
            Button("Open", systemImage: "arrow.up.forward.app") { app.openExternally(URL(fileURLWithPath: path)) }
            Button("Reveal in Finder", systemImage: "folder") { app.revealInFinder(path) }
        }
        Button("Copy path", systemImage: "doc.on.doc") { app.copyToPasteboard(path) }
    }
}

/// A link row's menu: the browser or the panel, and "Default", the
/// same choice as a web link's menu in the transcript (WebLinkMenu). The
/// panel works for any page, but a site that needs a sign-in won't have
/// Mike's there.
struct LinkMenu: View {
    @Environment(AppModel.self) private var app
    @AppStorage(WebLinkAction.clickKey) private var click: WebLinkAction = .browser
    let url: URL
    let thread: ThreadSummary
    let title: String

    var body: some View {
        if url.isFileURL {
            Button("Preview here", systemImage: "sidebar.right") { app.preview(path: url.path, title: title, in: thread) }
            Button("Open", systemImage: "arrow.up.forward.app") { app.openLink(url, title: title, in: thread, external: true) }
        } else {
            let profiles = ChromeProfiles.open()
            if profiles.isEmpty {
                Button(WebLinkAction.browser.title, systemImage: WebLinkAction.browser.symbol) { app.openExternally(url) }
            }
            // One per open Chrome profile, as in the transcript's WebLinkMenu.
            ForEach(profiles, id: \.directory) { profile in
                Button { ChromeProfiles.open(url, in: profile) } label: {
                    Label {
                        Text(ChromeProfiles.title(profile))
                    } icon: {
                        if let icon = ChromeProfiles.icon(profile) { Image(nsImage: icon) } else { Image(systemName: WebLinkAction.browser.symbol) }
                    }
                }
            }
            if PreviewRules.isWebPage(url) {
                Button(WebLinkAction.panel.title, systemImage: WebLinkAction.panel.symbol) { app.preview(page: url, title: title, in: thread) }
            }
        }
        Button("Copy link", systemImage: "link") { app.copyToPasteboard(url.absoluteString) }
        if PreviewRules.isWebPage(url) {
            Divider()
            Picker(selection: $click) {
                ForEach(WebLinkAction.allCases, id: \.self) { Label($0.title, systemImage: $0.symbol).labelStyle(.titleAndIcon).tag($0) }
            } label: {
                Label("Default", systemImage: "cursorarrow.click")
            }
        }
    }
}

// MARK: - Preview

/// A file or page in the pane in place of its section, with Back to that
/// section. An `.html` file or a local page is a web view (from the pool,
/// so it's kept while Mike looks at something else); text (Markdown,
/// code, plain) is the pane's own text view; anything else is Quick Look.
struct PreviewBody: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    let preview: PanePreview

    var body: some View {
        switch preview.target {
        case .page(let url) where url.isFileURL:
            LocalPagePreview(url: url, opened: preview.opened)
                .id(url)
        case .page(let url):
            WebPanel(url: url)
        case .remote(_, let failed):
            // Being fetched from that Mac, or why it couldn't be.
            if let failed {
                PaneNote(text: "Couldn't get it from \(preview.away ?? "that Mac")")
                    .tip(failed)
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .tip("Getting it from \(preview.away ?? "that Mac")")
            }
        case .file(let path) where preview.cut:
            // Over the size cap: what came, with a word that it's cut.
            VStack(spacing: 0) {
                Text("Only the start of this file came from \(preview.away ?? "that Mac").")
                    .font(.system(size: TypeScale.small))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, zoomed(6))
                    .frame(maxWidth: .infinity)
                fileBody(path)
            }
        case .file(let path):
            fileBody(path)
        case .folder(let path):
            FolderBrowser(thread: thread, path: path, preview: preview)
                .id("\(thread.id) \(path)")
        case .explain:
            ExplainPane(thread: thread)
        }
    }

    @ViewBuilder
    private func fileBody(_ path: String) -> some View {
        if !FileManager.default.fileExists(atPath: path) {
            PaneNote(text: "This file isn't there any more.")
        } else if PreviewRules.viewer(forPath: path) == .web {
            LocalPagePreview(url: URL(fileURLWithPath: path), opened: preview.opened)
                .id(path)
        } else if TextFileView.shows(path) {
            TextFileView(url: URL(fileURLWithPath: path), opened: preview.opened, editing: preview.editing, threadId: thread.id,
                         stayedEditing: { [thread] in app.setPreviewEditing(true, in: thread.id) })
                // The thread too: its links are followed in that thread, and
                // two threads on one runner can show the same copy.
                .id("\(thread.id) \(path)")
        } else {
            QuickLookView(url: URL(fileURLWithPath: path), opened: preview.opened)
        }
    }
}

/// A local HTML file in the pane. Its scripts are off (WebPanelPool,
/// Daybreak finding 6), so a page that draws itself would show as empty
/// boxes with nothing to say why. One with scripts gets a bar over it
/// asking: Run them reloads it in a view of its own with JavaScript on and
/// every other guard kept, for those exact bytes only, remembered until the
/// file changes (PreviewScriptConsent). Mike asked for it on 6 Nov 2026.
struct LocalPagePreview: View {
    let url: URL
    let opened: Int
    /// What the scan found, for the file it was of: the pane keeps this
    /// view (and its state) when another file opens in it, so nothing here
    /// counts unless it's this file's (Codex review: a page allowed first
    /// handed its digest to the next file with the same bytes).
    @State private var scan: (path: String, scripts: Bool, digest: String, allowed: Bool)?

    private var current: (scripts: Bool, digest: String, allowed: Bool)? {
        guard let scan, scan.path == url.path else { return nil }
        return (scan.scripts, scan.digest, scan.allowed)
    }

    static let explanation = "Pages open here with their scripts off, as a script could read the files the page names. Run them turns them on for this version of the page, still with no network and nothing read but what it names. If the file changes, you'll be asked again."

    var body: some View {
        VStack(spacing: 0) {
            if let scan = current, scan.scripts, !scan.allowed {
                HStack(spacing: zoomed(6)) {
                    Text("This page has scripts")
                        .font(.system(size: TypeScale.small))
                        .foregroundStyle(.secondary)
                    InfoTip(Self.explanation)
                    Spacer(minLength: 0)
                    Button("Run them") {
                        PreviewScriptConsent().allow(path: url.path, digest: scan.digest)
                        self.scan?.allowed = true
                    }
                    .controlSize(.small)
                    .tip("Reload this page with its scripts on")
                }
                .padding(.horizontal, zoomed(10))
                .padding(.vertical, zoomed(6))
                Divider()
            }
            WebPanel(url: url, scriptsFor: current.flatMap { $0.allowed ? $0.digest : nil })
        }
        .task(id: "\(url) \(opened)") {
            let path = url.path
            let found = await Task.detached(priority: .utility) {
                LocalPreviewSite.scan(atPath: path)
            }.value
            // A scan for the page before can finish after this one's.
            if Task.isCancelled { return }
            scan = found.map { (path, $0.scripts, $0.digest, $0.scripts && PreviewScriptConsent().allows(path: path, digest: $0.digest)) }
        }
    }
}

/// A preview's buttons in its panel's bar: Back to the section it came
/// from, Edit (then Done) for a text file, Reveal in Finder for a file,
/// and Open.
struct PreviewButtons: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    let preview: PanePreview

    var body: some View {
        PaneHeaderButton(symbol: "chevron.left", help: "Back to \(preview.back.last?.title ?? PreviewBody.name(of: preview.from, in: thread))") {
            app.previewBack(in: thread.id)
        }
        if preview.folderPath != nil { FolderModeButton() }
        // A copy of another Mac's file: not edited here (only the copy
        // would change), and its folder is just the cache.
        if let file = preview.fileURL, preview.away == nil {
            if preview.editing {
                PaneHeaderButton(symbol: "checkmark", help: "Done. What you typed is saved.") { app.setPreviewEditing(false, in: thread.id) }
            } else if TextFileView.shows(file.path), TextFileView.canEdit(file.path) {
                PaneHeaderButton(symbol: "pencil", help: "Edit the file here. It's saved as you type.") { app.setPreviewEditing(true, in: thread.id) }
            }
            PaneHeaderButton(symbol: "folder", help: "Reveal in Finder") { app.revealInFinder(file.path) }
        }
        if let url = preview.externalURL {
            PaneHeaderButton(symbol: "arrow.up.right", help: preview.folderPath != nil ? "Open in Finder" : preview.fileURL == nil ? "Open in browser" : "Open in its app") {
                // Another Mac's copy is never opened as a program.
                app.openExternally(url, from: preview.away == nil ? .thisMac : app.copyOrigin(of: thread))
            }
        }
    }
}

extension PreviewBody {
    static func name(of section: PaneSection, in thread: ThreadSummary) -> String {
        switch section {
        case .highlights: "Highlights"
        case .patches: "Patches"
        case .panel(let id): thread.panels.first { $0.id == id }?.title ?? "the panel"
        }
    }
}

/// A file in the pane that isn't text or a page: a picture or video in
/// the app's own views, so it drags out (FilePreviewView), and anything
/// else (a PDF, a Keynote) in Quick Look, as the Finder's space bar shows it.
struct QuickLookView: NSViewRepresentable {
    let url: URL
    /// Bumped by each open, so the same file opened again is read again.
    let opened: Int

    final class Coordinator {
        var shown: (URL, Int)?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> FilePreviewView { FilePreviewView() }

    func updateNSView(_ view: FilePreviewView, context: Context) {
        if let shown = context.coordinator.shown, shown.0 == url, shown.1 == opened { return }
        view.show(url)
        context.coordinator.shown = (url, opened)
    }

    static func dismantleNSView(_ view: FilePreviewView, coordinator: Coordinator) {
        view.close()
    }
}

/// Shows one file for QuickLookView, and lets a picture or video drag out
/// as the file (FileDrag), to drop on X or the Finder. Quick Look draws
/// those in another process (an NSRemoteView), which takes presses on
/// the picture itself before the app sees them (Mike found the video
/// wouldn't drag, 29 Oct), so they're an NSImageView and an AVPlayerView
/// here instead. A press that's let go without moving is a click as
/// before, and the video's controls keep their own presses.
final class FilePreviewView: NSView {
    // Clicks count while Threadbear isn't the app in front (FirstClick.swift).
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private enum Content {
        case picture(NSImageView)
        case video(AVPlayerView)
        case quickLook(QLPreviewView)

        var view: NSView {
            switch self {
            case .picture(let view): view
            case .video(let view): view
            case .quickLook(let view): view
            }
        }
    }

    private var content: Content?
    private var url: URL?
    /// Kept for the next file Quick Look shows; closing it would end it for good.
    private var quickLook: QLPreviewView?

    /// Reads `url` afresh, even when it's the file already shown.
    func show(_ url: URL) {
        self.url = url
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .audiovisualContent) == true {
            let player: AVPlayerView
            if case .video(let shown) = content { player = shown } else {
                player = AVPlayerView()
                player.controlsStyle = .floating
                // Live Text over a paused frame would take the press too.
                player.allowsVideoFrameAnalysis = false
            }
            player.player?.pause()
            player.player = AVPlayer(url: url)
            install(.video(player))
            fitPlayer(to: url)
        } else if type?.conforms(to: .image) == true, let image = NSImage(contentsOf: url) {
            let view: NSImageView
            if case .picture(let shown) = content { view = shown } else {
                view = NSImageView()
                view.imageScaling = .scaleProportionallyDown
                view.animates = true
            }
            view.image = image
            install(.picture(view))
        } else {
            // .normal draws no frame of its own around the item.
            let view = quickLook ?? QLPreviewView(frame: .zero, style: .normal) ?? QLPreviewView()
            view.shouldCloseWithWindow = false
            quickLook = view
            if case .quickLook = content, (view.previewItem as? URL) == url {
                view.refreshPreviewItem()
            } else {
                view.previewItem = url as NSURL
            }
            install(.quickLook(view))
        }
    }

    /// Content is placed by hand (layout), not by constraints: an image
    /// view's own size would push the pane to fit the picture, and crop it.
    private func install(_ next: Content) {
        if let old = content?.view, old !== next.view {
            if case .video(let player)? = content { player.player?.pause() }
            old.removeFromSuperview()
        }
        content = next
        if next.view.superview !== self { addSubview(next.view) }
        needsLayout = true
    }

    /// The video's shape once it's known: the player is that shape in the
    /// middle, so there are no black bars where Quick Look showed the pane
    /// behind it. It fills the pane until then.
    private var videoSize: CGSize?

    private func fitPlayer(to url: URL) {
        videoSize = nil
        Task { @MainActor [weak self] in
            let asset = AVURLAsset(url: url)
            guard let track = try? await asset.loadTracks(withMediaType: .video).first,
                  let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) else { return }
            let shown = size.applying(transform)
            guard let self, self.url == url, shown.width != 0, shown.height != 0 else { return }
            self.videoSize = CGSize(width: abs(shown.width), height: abs(shown.height))
            self.needsLayout = true
        }
    }

    override func layout() {
        super.layout()
        guard let view = content?.view else { return }
        if case .video = content, let videoSize {
            view.frame = AVMakeRect(aspectRatio: videoSize, insideRect: bounds).integral
        } else {
            view.frame = bounds
        }
    }

    func close() {
        if case .video(let player)? = content { player.player?.pause() }
        quickLook?.close()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // A right-click on a picture is taken here too, for Copy Image
        // (menu(for:)); anywhere else it goes on to the panel's own menu.
        if NSApp.currentEvent?.type == .rightMouseDown, case .picture = content {
            return pressTarget(at: point)
        }
        // Only a left press is taken here, so scrolling, pinching and
        // hovering (which shows the video's controls) still reach the view.
        guard NSApp.currentEvent?.type == .leftMouseDown else { return super.hitTest(point) }
        return pressTarget(at: point)
    }

    /// A picture's right-click menu: Copy Image, to paste the picture
    /// itself into Slack or X (Mike, 3 Nov). Copy path and Reveal in
    /// Finder are on its Highlights row and the panel's bar already.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard case .picture = content else { return super.menu(for: event) }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Copy Image", symbol: "doc.on.doc", action: #selector(copyImageItem), target: self))
        return menu
    }

    @objc private func copyImageItem() { copyImage() }

    /// Puts the picture on `pasteboard` as the file's own bytes (a PNG
    /// stays a PNG, a GIF keeps its frames) and as TIFF, which every app
    /// that takes a pasted picture reads. Not the file's URL: that pastes
    /// as a file, or as its path in a text box. False when there's no picture.
    @discardableResult
    func copyImage(to pasteboard: NSPasteboard = .general) -> Bool {
        guard case .picture(let view) = content, let url else { return false }
        let item = NSPasteboardItem()
        if let type = UTType(filenameExtension: url.pathExtension), let data = try? Data(contentsOf: url) {
            item.setData(data, forType: NSPasteboard.PasteboardType(type.identifier))
        }
        if let tiff = view.image?.tiffRepresentation { item.setData(tiff, forType: .tiff) }
        guard !item.types.isEmpty else { return false }
        pasteboard.clearContents()
        return pasteboard.writeObjects([item])
    }

    /// Where a left press at `point` (in the superview) goes: here, to be
    /// a drag or a click, or the view under it.
    func pressTarget(at point: NSPoint) -> NSView? {
        guard let inner = super.hitTest(point) else { return nil }
        switch content {
        case .picture:
            return self
        case .video(let player):
            // The picture fills the player; its controls are smaller
            // panels over it (the play bar, volume), left to the player.
            let frame = inner.convert(inner.bounds, to: player)
            return frame.width >= player.bounds.width - 1 && frame.height >= player.bounds.height - 1 ? self : inner
        case .quickLook, nil:
            return inner
        }
    }

    /// Set while a click is handed to the view under the mouse.
    private var passingClick = false

    override func mouseDown(with event: NSEvent) {
        // The click handed on below came back: a view that doesn't take
        // presses (the picture's NSImageView) passes them up its
        // responders, which is here. Handing it down again looped until
        // the stack ran out (THREADBEAR-N, 5 Nov), so it goes on up to
        // the pane, as it did before this view took presses.
        if passingClick {
            super.mouseDown(with: event)
            return
        }
        // A Control-click is a right-click.
        if event.modifierFlags.contains(.control), let menu = menu(for: event) {
            NSMenu.popUpContextMenu(menu, with: event, for: self)
            return
        }
        if let url, FileDrag.isDrag(from: event) {
            FileDrag.begin(url, from: self, event: event)
            return
        }
        // A click: the view under the mouse gets it, and the mouse-up
        // still waiting in the queue.
        guard let view = content?.view else { return }
        let target = view.hitTest(convert(event.locationInWindow, from: nil)) ?? view
        passingClick = true
        defer { passingClick = false }
        target.mouseDown(with: event)
    }
}

/// A tool patch's panel as a card at the top of Highlights: the tool's
/// icon and the panel's title, its summary (or note) under them, and its
/// count. Opens the panel.
private struct ToolCard: View {
    let panel: Panel
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: zoomed(6)) {
                HStack(spacing: zoomed(8)) {
                    if let image = PatchImage.image(panel.iconFile) {
                        Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).frame(width: zoomed(18), height: zoomed(18))
                    } else {
                        Image(systemName: PanelIcon.symbol(for: panel))
                            .font(.system(size: zoomed(13)))
                            .foregroundStyle(.secondary)
                    }
                    Text(panel.title)
                        .font(.system(size: TypeScale.label, weight: .semibold))
                    Spacer(minLength: zoomed(4))
                    Image(systemName: "chevron.right")
                        .font(.system(size: zoomed(10), weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                if let text = panel.summary ?? panel.note {
                    Text(text)
                        .font(.system(size: TypeScale.detail))
                        .foregroundStyle(.secondary)
                        .lineSpacing(zoomed(2))
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(zoomed(12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: zoomed(10)).fill(Color.primary.opacity(hovering ? 0.08 : 0.05)))
            .overlay(RoundedRectangle(cornerRadius: zoomed(10)).strokeBorder(Color(nsColor: Theme.cardBorder), lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: zoomed(10)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip("Open \(panel.title)")
    }
}
