import AppKit
import BearDock
import SwiftUI
import ThreadbearCore

/// The window is a dock of panels (BearDock, in /dock): the sidebar, the
/// main panel, the pane sections (Highlights, a project's panels, Patches)
/// and any threads opened in panels of their own, each of which Mike can
/// drag anywhere, tab together, close and reopen. A pane section's panel id
/// is its `PaneSection.id`.
///
/// The main panel follows the context: it shows whatever's picked in the
/// sidebar (a thread, a new thread, a project's page). Panels opened for
/// that context, like a review, open as tabs beside it and close when the
/// context changes, unless Mike drags them out of its group: then they
/// stay where he put them (AppModel.mainTabs). A thread opened in a panel
/// of its own (`threadPanel`) stays put too.
enum WindowDock {
    static let threads = "threadbear.threads"
    /// The main panel. The id is from when it was "the thread" panel, and
    /// stays so saved layouts still have it.
    static let main = "threadbear.thread"
    /// The design review being answered (show_options), a tab beside the
    /// main panel.
    /// Every account's limits and the CLIs' versions (the activity bar's
    /// Usage), open until Mike closes it.
    static let usage = "threadbear.usage"
    static let usageSymbol = "gauge.with.dots.needle.33percent"
    /// The app's, the runner's and the CLIs' updates (the activity bar's
    /// updates icon), open until Mike closes it.
    static let updates = "threadbear.updates"
    static let updatesSymbol = "arrow.down.circle"
    /// Finish setting up (SetupChecklist), open until Mike closes it.
    static let setup = "threadbear.setup"
    static let setupSymbol = "checklist"
    /// Which of the Connectors gateway's services are signed in (the
    /// activity bar's Connectors icon), open until Mike closes it.
    static let connectors = "threadbear.connectors"
    static let connectorsSymbol = "powerplug"
    /// Each runner, whether it's up and what's running there (the
    /// activity bar's Runners icon), open until Mike closes it.
    static let runners = "threadbear.runners"
    static let runnersSymbol = "server.rack"
    static let layoutKey = "dockLayout"
    static let threadPanelPrefix = "threadbear.thread:"

    /// The panel for a thread opened on its own, beside the main panel.
    static func threadPanel(_ threadId: String) -> PanelID { threadPanelPrefix + threadId }

    /// The thread a panel opened on its own shows, or nil for any other panel.
    static func pinnedThread(_ panel: PanelID) -> String? {
        panel.hasPrefix(threadPanelPrefix) ? String(panel.dropFirst(threadPanelPrefix.count)) : nil
    }

    /// Option 2 of the layout pass (28 Oct): the sidebar without a title,
    /// the thread, and Highlights, side by side.
    static var defaultLayout: DockLayout {
        DockLayout(root: .split(DockSplit(id: "window", axis: .horizontal, children: [
            .group(DockGroup(id: "sidebar", panels: [threads])),
            .group(DockGroup(id: "main", panels: [main])),
            .group(DockGroup(id: "pane", panels: [PaneSection.highlightsId])),
        ], fractions: [0.29, 0.47, 0.24])), hiddenTitles: [threads])
    }

    @MainActor
    static func makeController(defaults: UserDefaults = .standard) -> DockController {
        var layout = defaults.data(forKey: layoutKey).flatMap { try? JSONDecoder().decode(DockLayout.self, from: $0) } ?? defaultLayout
        // Without the thread there's nothing to type in: a layout saved
        // that way (or by an older build) gets it back.
        if !layout.contains(main) { layout.add(main, .window(.right)) }
        // Reviews were a dock panel until 30 Oct. No layout was saved with one
        // in, but an older build's might have been, and nothing draws it now.
        if layout.contains("threadbear.review") { layout.close("threadbear.review") }
        let dock = DockController(layout: layout)
        dock.onChange = { next in
            ActivityRecorder.shared.panels(next)
            defaults.set(try? JSONEncoder().encode(next), forKey: layoutKey)
        }
        return dock
    }

    /// A pane section's panel, or nil for the sidebar, the main panel and a
    /// thread's own panel.
    static func section(_ panel: PanelID) -> PaneSection? {
        panel == threads || panel == main || panel == usage || panel == updates || panel == setup || panel == connectors || panel == runners || pinnedThread(panel) != nil ? nil : PaneSection(id: panel)
    }

    @MainActor
    static func title(of panel: PanelID, app: AppModel) -> String {
        switch panel {
        case threads: return "Threads"
        case main:
            if let project = app.openProject { return project.title }
            if app.showsProjectsHome { return "Projects" }
            if app.showsLibrarianHome { return "Librarian" }
            if app.showsScheduledHome { return "Scheduled" }
            guard let thread = app.selectedThread else { return "New thread" }
            return thread.title.isEmpty ? "Untitled" : thread.title
        case usage: return "Usage"
        case updates: return "Updates"
        case setup: return "Finish setting up"
        case connectors: return "Connectors"
        case runners: return "Runners"
        default:
            break
        }
        if let id = pinnedThread(panel) {
            let title = app.threads[id]?.title ?? ""
            return title.isEmpty ? "Untitled" : title
        }
        // A file or page open over the section: its name, with Back to the
        // section in the bar.
        if let thread = app.paneThread, let preview = app.panePreview[thread.id], preview.from.id == panel {
            return preview.title
        }
        switch panel {
        case PaneSection.highlightsId: return "Highlights"
        case AgentBrowser.panelId: return "Browser"
        case BuiltinPanels.files: return "Files"
        case PaneSection.patchesId: return "Patches"
        default:
            // The selected thread's panel by that id, else any thread's, as
            // a panel stays in the layout when Mike moves to a thread
            // without it.
            if let hit = app.paneThread?.panels.first(where: { $0.id == panel }) { return hit.title }
            return app.threadOwning(panel: panel)?.panels.first { $0.id == panel }?.title ?? panel
        }
    }

    /// A patch panel's picture (its tool's icon), when it has one.
    @MainActor
    static func image(of panel: PanelID, app: AppModel) -> NSImage? {
        let hit = app.paneThread?.panels.first { $0.id == panel } ?? app.threadOwning(panel: panel)?.panels.first { $0.id == panel }
        return PatchImage.image(hit?.iconFile)
    }

    /// A patch panel's tab gets the rail button's badge for where it came
    /// from (PanelOriginBadge), smaller to suit the tab's icon.
    @MainActor
    static func badge(of panel: PanelID, app: AppModel) -> AnyView? {
        let owner = app.selectedThread.flatMap { $0.panels.contains { $0.id == panel } ? $0 : nil }
            ?? app.threadOwning(panel: panel)
        guard let owner, let hit = owner.panels.first(where: { $0.id == panel }) else { return nil }
        return AnyView(PanelOriginBadge(panel: hit, thread: owner, app: app, side: 10))
    }

    @MainActor
    static func symbol(of panel: PanelID, app: AppModel) -> String? {
        switch panel {
        case threads: return "bubble.left.and.bubble.right"
        case main: return "text.alignleft"
        case usage: return usageSymbol
        case updates: return updatesSymbol
        case setup: return setupSymbol
        case connectors: return connectorsSymbol
        case runners: return runnersSymbol
        case PaneSection.highlightsId: return "pin"
        case AgentBrowser.panelId: return "globe"
        case BuiltinPanels.files: return "folder"
        case PaneSection.patchesId: return "square.dashed"
        default:
            if pinnedThread(panel) != nil { return "text.alignleft" }
            let hit = app.paneThread?.panels.first { $0.id == panel } ?? app.threadOwning(panel: panel)?.panels.first { $0.id == panel }
            return hit.map(PanelIcon.symbol(for:))
        }
    }
}

// MARK: - The pane, through the dock

extension AppModel {
    /// Whose panels and patches the pane shows: the selected thread's, or
    /// on a project's page the project's, as one of its threads has them
    /// (ProjectPane). Nil on a project page when none of its threads has
    /// any.
    var paneThread: ThreadSummary? {
        guard let project = openProject else { return selectedThread }
        return ProjectPane.standIn(for: project, threads: threads.values)
    }

    /// The pane sections open in the dock, in layout order.
    var openPanes: [PanelID] {
        dock.layout.panels.filter { WindowDock.section($0) != nil }
    }

    /// Opens a section's panel or brings it to the front: beside another
    /// pane section if one's open, else down the right of the window.
    func showPane(_ section: PaneSection) {
        dock.show(section.id, near: openPanes, fallback: .window(.right))
    }

    /// The Usage panel is up. Setting it opens it under the threads list,
    /// by the activity bar's icon that opens it (Mike's pick, 28 Oct), and
    /// clearing it closes it.
    var usageShown: Bool {
        get { dock.isShowing(WindowDock.usage) }
        set { setShownUnderThreads(WindowDock.usage, newValue) }
    }

    /// The same for the Updates panel.
    var updatesShown: Bool {
        get { dock.isShowing(WindowDock.updates) }
        set { setShownUnderThreads(WindowDock.updates, newValue) }
    }

    /// The same for Finish setting up.
    var setupShown: Bool {
        get { dock.isShowing(WindowDock.setup) }
        set { setShownUnderThreads(WindowDock.setup, newValue) }
    }

    /// The same for the Connectors panel.
    var connectorsShown: Bool {
        get { dock.isShowing(WindowDock.connectors) }
        set { setShownUnderThreads(WindowDock.connectors, newValue) }
    }

    /// The same for the Runners panel.
    var runnersShown: Bool {
        get { dock.isShowing(WindowDock.runners) }
        set { setShownUnderThreads(WindowDock.runners, newValue) }
    }

    /// Opens one of the activity bar's panels: as a tab beside another
    /// if one's open (Usage, Updates, Finish setting up, Connectors and Runners share the space under
    /// the threads), else under the threads list, else down the left if
    /// the threads aren't in the dock.
    private func setShownUnderThreads(_ panel: PanelID, _ shown: Bool) {
        guard shown else { return dock.close(panel) }
        let under = dock.layout.group(containing: WindowDock.threads).map { DockDrop.edge(group: $0.id, .bottom) }
        dock.show(panel, near: [WindowDock.usage, WindowDock.updates, WindowDock.setup, WindowDock.connectors, WindowDock.runners].filter { $0 != panel }, fallback: under ?? .window(.left))
    }
}

/// The window's content: the dock, with the activity bar down the left and
/// the rail of the thread's pane sections down the right.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        @Bindable var app = app
        HStack(spacing: 0) {
            // Drawn over the dock: its keys hang out to the right while ⌘
            // is held (ShortcutHints).
            ActivityBar()
                .zIndex(1)
            DockView(controller: app.dock, options: Self.options, content: content)
            if let thread = app.paneThread {
                PanelRail(thread: thread, project: app.openProject)
            }
        }
        // The tour's frames are in this space, and its overlay covers it.
        .coordinateSpace(.named(Tour.space))
        // Back and forward's arrow while a trackpad swipe is under way.
        .overlay { SwipeNavigationArrow() }
        .overlay { TourOverlay().animation(.easeOut(duration: 0.2), value: Tour.shared.step == nil) }
        // Up under where the title bar was: the panels' bars take its place.
        .ignoresSafeArea(.container, edges: .top)
        // The window's title (Window menu, Mission Control); nothing shows
        // it, as the window has no title bar.
        .navigationTitle(windowTitle)
        .sheet(item: $app.scheduleEditor) { state in
            ScheduleEditor(state: state)
        }
        // The automation's `settings` opens the Settings window; only a
        // SwiftUI view can (AppKit's showSettingsWindow: does nothing now).
        .onChange(of: app.settingsRequest) { openSettings() }
        // A view's own intro the first time it's opened (Tour.intros),
        // once its page is drawn for the card to point at.
        .onChange(of: app.sidebarMode) { _, mode in introduceSoon(TourIntro.of(mode)) }
        .onChange(of: app.usageShown) { _, shown in if shown { introduceSoon(.usage) } }
        .onChange(of: app.updatesShown) { _, shown in if shown { introduceSoon(.updates) } }
        .onChange(of: app.connectorsShown) { _, shown in if shown { introduceSoon(.connectors) } }
        .onChange(of: app.pools) { _, pools in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { Tour.shared.introducePools(pools) }
        }
        // Saves where the window is, so the next launch opens it there.
        .background(MainWindowFrameTracker())
    }

    /// Once the page or panel is drawn, for the card to point at.
    private func introduceSoon(_ intro: TourIntro?) {
        guard let intro else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { Tour.shared.introduce(intro) }
    }

    private var windowTitle: String {
        if let project = app.openProject { return project.title }
        if app.showsProjectsHome { return "Projects" }
        if app.showsLibrarianHome { return "Librarian" }
        if app.showsScheduledHome { return "Scheduled" }
        return app.selectedThread.map { $0.title.isEmpty ? "Untitled" : $0.title } ?? "New thread"
    }

    /// The window has no title bar (ThreadbearApp): the panels' bars are the
    /// top of the window, with room for the traffic lights in the corner.
    static var options: DockOptions {
        var o = DockOptions()
        o.headerHeight = PaneHeader<EmptyView, EmptyView>.height
        o.titleSize = TypeScale.label
        // The traffic lights take 78 points from the left edge; the
        // activity bar under them has the first of those.
        o.trafficLights = max(0, 78 - ActivityBar.width)
        o.cornerMovesWindow = true
        o.barsMoveWindow = true
        o.tip = { view, text in AnyView(view.tip(text)) }
        // A panel dragged out into a window of its own: the same model as
        // the main window's views.
        o.windowContent = { AnyView($0.environment(AppModel.shared)) }
        #if DEBUG
        // A scripted run's panel windows stay behind Mike's, as its main one does.
        o.prepareWindow = { if Automation.instanceId != nil { $0.tuckBehind() } }
        #endif
        return o
    }

    private var content: DockContent {
        DockContent(
            title: { WindowDock.title(of: $0, app: app) },
            symbol: { WindowDock.symbol(of: $0, app: app) },
            image: { WindowDock.image(of: $0, app: app) },
            badge: { WindowDock.badge(of: $0, app: app) },
            header: { panel in
                // The thread's own title line (folder, title, projects)
                // in place of its name.
                if panel == WindowDock.main { return AnyView(ThreadHeader()) }
                if let id = WindowDock.pinnedThread(panel) { return AnyView(HeaderTitle(thread: app.threads[id])) }
                return nil
            },
            accessory: { panel in
                if panel == WindowDock.main { return AnyView(HStack(spacing: 0) { ShareButton(); ThreadMenuButton() }) }
                if let id = WindowDock.pinnedThread(panel) { return AnyView(HStack(spacing: 0) { ShareButton(pinned: id); ThreadMenuButton(pinned: id) }) }
                if let section = WindowDock.section(panel) { return AnyView(DockPaneButtons(section: section)) }
                return nil
            },
            // Without the main panel there's nowhere to type.
            closable: { $0 != WindowDock.main },
            // A project's panel or Patches only for a thread that has them;
            // the dock keeps their place for the next one that does.
            available: { panel in
                if let id = WindowDock.pinnedThread(panel) { return app.threads[id] != nil }
                // A project's page has no Highlights (they're a thread's),
                // and only the panels its folders give.
                if app.openProject != nil, WindowDock.section(panel) != nil, app.paneThread == nil { return false }
                guard let thread = app.paneThread else { return true }
                switch WindowDock.section(panel) {
                case .highlights: return app.openProject == nil
                case .panel(AgentBrowser.panelId): return true
                case .panel(BuiltinPanels.files): return app.openProject == nil
                case .panel(let id): return thread.panels.contains { $0.id == id }
                case .patches: return !thread.patches.isEmpty
                default: return true
                }
            },
            view: { panel in
                switch panel {
                case WindowDock.threads: AnyView(SidebarView().tourTarget(.threads, withBar: true))
                case WindowDock.usage: AnyView(UsagePanel().tourTarget(.panel("usage"), withBar: true))
                case WindowDock.updates: AnyView(UpdatesPanel().tourTarget(.panel("updates"), withBar: true))
                case WindowDock.setup: AnyView(SetupPanel().tourTarget(.setupPanel, withBar: true))
                case WindowDock.connectors: AnyView(ConnectorsPanel().tourTarget(.panel("connectors"), withBar: true))
                case WindowDock.runners: AnyView(RunnersPanel())
                case WindowDock.main: AnyView(DetailView().tourTarget(.mainPanel, withBar: true))
                case let id where WindowDock.pinnedThread(id) != nil:
                    AnyView(PinnedThreadView(threadId: WindowDock.pinnedThread(id)!).id(id))
                case PaneSection.highlightsId: AnyView(DockPane(section: .highlights).tourTarget(.highlights, withBar: true))
                default: AnyView(DockPane(section: PaneSection(id: panel)))
                }
            }
        )
    }
}
