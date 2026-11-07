import AppKit
import ThreadbearCore

/// Where the window is: the sidebar's view and what the detail area shows.
struct NavigationPlace: Equatable, Sendable {
    var mode: SidebarMode
    var threadId: String?
    var subagent: SubagentRef?
    var projectId: String?
    /// The Projects page of cards (`showsProjectsHome`).
    var projectsHome = false
    /// The Librarian's page (`showsLibrarianHome`).
    var librarianHome = false
    /// The Scheduled page (`showsScheduledHome`).
    var scheduledHome = false
}

/// Back and forward, like a browser's: ⌘[ and ⌘] in the Go menu, the
/// side buttons on a mouse, and trackpad swipes (SwipeNavigation).
extension AppModel {
    var place: NavigationPlace {
        NavigationPlace(mode: sidebarMode, threadId: selection, subagent: subagentSelection, projectId: openProjectId, projectsHome: showsProjectsHome, librarianHome: showsLibrarianHome, scheduledHome: showsScheduledHome)
    }

    /// Called by the didSet of each property that makes up `place`. One
    /// click often changes several of them in turn (picking a thread closes
    /// the project page and any sub-agent too), so the step is recorded
    /// once they've all changed, not for each half-way state.
    func noteNavigation() {
        guard !navigationPending else { return }
        navigationPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.navigationPending = false
            self.history.record(self.place)
            ActivityRecorder.shared.view(self.place)
        }
    }

    /// Records a pending step straight away, so going back from it works
    /// even before the main queue has had its turn.
    private func flushNavigation() {
        guard navigationPending else { return }
        navigationPending = false
        history.record(place)
        ActivityRecorder.shared.view(place)
    }

    var canGoBack: Bool { history.canGoBack }
    var canGoForward: Bool { history.canGoForward }

    func goBack() {
        flushNavigation()
        if let place = history.back(where: canShow) { show(place) }
    }

    func goForward() {
        flushNavigation()
        if let place = history.forward(where: canShow) { show(place) }
    }

    /// A deleted thread, a merged project or a view the runner no longer
    /// has is skipped rather than shown empty.
    private func canShow(_ place: NavigationPlace) -> Bool {
        if let id = place.threadId, threads[id] == nil { return false }
        if let id = place.projectId, project(id) == nil { return false }
        switch place.mode {
        case .scheduled: return schedulesSupported
        case .projects, .librarian: return projectsSupported
        default: return true
        }
    }

    /// Puts the window back at `place`. The history's index has already
    /// moved, so the step this records is where it is now and adds nothing.
    private func show(_ place: NavigationPlace) {
        sidebarMode = place.mode
        if let subagent = place.subagent {
            selectSubagent(threadId: subagent.threadId, subagentId: subagent.subagentId)
        } else if selection != place.threadId || subagentSelection != nil {
            select(place.threadId)
        }
        openProjectId = place.projectId
        showsProjectsHome = place.projectsHome
        showsLibrarianHome = place.librarianHome
        showsScheduledHome = place.scheduledHome
    }
}

/// The mouse's back and forward buttons (buttons 4 and 5, which AppKit
/// numbers 3 and 4). SwiftUI has nothing for them, so a local monitor
/// catches them over the main window; other windows keep theirs.
@MainActor
enum MouseNavigation {
    private static var monitor: Any?

    static func install(app: AppModel) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .otherMouseDown) { event in
            handle(event, in: event.window, app: app) ? nil : event
        }
    }

    /// True when the click was back or forward over the main window, and
    /// so has been dealt with.
    static func handle(_ event: NSEvent, in window: NSWindow?, app: AppModel) -> Bool {
        guard let window, window === MainWindowFrame.window else { return false }
        switch event.buttonNumber {
        case 3: app.goBack()
        case 4: app.goForward()
        default: return false
        }
        return true
    }
}
