import AppKit
import SwiftUI
import ThreadbearCore

/// The thread panel: the transcript and composer, or a project's page or
/// the Projects page in their place. Its title line and menu are in the
/// panel's bar (ThreadHeader, ThreadMenuButton).
struct DetailView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let thread = app.selectedThread
        // A sub-agent's transcript, read-only, in place of its thread's.
        let subagentRef = app.subagentSelection
        let session = subagentRef.map { app.subagentSession(for: $0) } ?? app.selection.map { app.session(for: $0) }
        let isNew = app.selection == nil
        // A project's page takes the place of the thread until a thread is
        // picked again.
        let project = app.openProject
        // The Projects page of cards, from the activity bar's Projects.
        let projectsHome = project == nil && app.showsProjectsHome
        // The Librarian's page, from the activity bar's Librarian.
        let librarianHome = project == nil && app.showsLibrarianHome
        // The Scheduled page, from the activity bar's Scheduled.
        let scheduledHome = project == nil && app.showsScheduledHome
        Group {
        if let project {
            VStack(spacing: 0) {
                ConnectionBanner()
                ErrorBanner()
                ProjectPage(project: project)
            }
        } else if projectsHome {
            VStack(spacing: 0) {
                ConnectionBanner()
                ErrorBanner()
                ProjectsHome()
            }
        } else if librarianHome {
            VStack(spacing: 0) {
                ConnectionBanner()
                ErrorBanner()
                LibrarianHome()
            }
        } else if scheduledHome {
            VStack(spacing: 0) {
                ConnectionBanner()
                ErrorBanner()
                ScheduledHome()
            }
        } else if let id = app.selection, app.dock.layout.contains(WindowDock.threadPanel(id)) {
            // One transcript can only be drawn in one place.
            OpenElsewhereNote(threadId: id)
        } else {
            VStack(spacing: 0) {
            ConnectionBanner()
            ErrorBanner()
            if let thread { LimitBanner(thread: thread) }
            if let thread { SignInBanner(thread: thread) }
            if let thread, thread.hasPendingReviews, subagentRef == nil {
                PendingReviewsButton(thread: thread)
            }
            if let subagentRef {
                SubagentHeader(ref: subagentRef)
            }
            ComposerPlacement(centred: isNew) {
                ZStack {
                    TranscriptView(session: session, controller: app.transcript)
                    if let session, session.state == .loading, session.displayCount == 0 {
                        ProgressView().controlSize(.small)
                    } else if let session, session.missing {
                        Text("There's no record of what this sub-agent did.")
                            .foregroundStyle(.secondary)
                    } else if let session, session.subagentId != nil, session.state == .loaded, session.displayCount == 0 {
                        Text("Nothing yet.").foregroundStyle(.secondary)
                    } else if let session, session.subagentId != nil, case .failed(let message) = session.state {
                        VStack(spacing: zoomed(8)) {
                            Text("Couldn't load this sub-agent.").font(.headline)
                            Text(message).foregroundStyle(.secondary)
                            Button("Try again") { app.selectSubagent(threadId: session.threadId, subagentId: session.subagentId ?? "") }
                                .tip("Load the sub-agent's transcript again")
                        }
                    } else if let session, case .failed(let message) = session.state {
                        VStack(spacing: zoomed(8)) {
                            Text(session.failureHeadline ?? "Couldn't load this thread.").font(.headline)
                            Text(message).foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                            Button("Try again") { app.select(session.threadId) }
                                .tip("Load the thread again")
                        }
                    }
                }
                .layoutValue(key: PaneRole.self, value: .transcript)
                // A sub-agent can't be written to: it takes its brief from
                // the agent that started it.
                if subagentRef == nil {
                    ComposerView(thread: thread, session: session, controller: app.transcript)
                        .tourTarget(.composer)
                        .layoutValue(key: PaneRole.self, value: .composer)
                }
                if isNew {
                    NewThreadHeading()
                        .layoutValue(key: PaneRole.self, value: .heading)
                    NewThreadNote()
                        .layoutValue(key: PaneRole.self, value: .note)
                }
            }
            }
            .frame(maxWidth: .infinity)
        }
        }
        .overlay(alignment: .top) {
            ArchivedToast()
            InboxEndToast()
            MilestoneToast()
        }
    }
}

/// "Archived" and the thread's name, floating at the top of the thread
/// panel for a few seconds after Mike archives one, with Undo. A click
/// anywhere else on it opens the thread in the Archived section. Stays
/// while the pointer's over it.
private struct ArchivedToast: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false

    static let shownFor: Duration = .seconds(6)

    var body: some View {
        ZStack {
            if let note = app.archivedNote {
                toast(note)
                    .id(note.id)
                    .transition(Juice.reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .task(id: note.id) {
                        try? await Task.sleep(for: Self.shownFor)
                        while hovering, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(300)) }
                        guard !Task.isCancelled else { return }
                        app.dismissArchivedNote(note.id)
                    }
            }
        }
        .animation(Juice.reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.3), value: app.archivedNote?.id)
    }

    private func toast(_ note: ArchivedNote) -> some View {
        let dark = colorScheme == .dark
        let shape = Capsule(style: .continuous)
        return HStack(spacing: zoomed(10)) {
            Button { app.openArchivedNote() } label: {
                HStack(spacing: zoomed(7)) {
                    Image(systemName: "archivebox").foregroundStyle(.secondary)
                    Text("Archived").foregroundStyle(.secondary)
                    Text(note.title.isEmpty ? "Untitled" : note.title)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: zoomed(280), alignment: .leading)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .tip("Open this thread")
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 0.5, height: zoomed(14))
            Button("Undo") { app.undoArchive() }
                .buttonStyle(.plain)
                .foregroundStyle(Color(nsColor: .controlAccentColor))
                .fontWeight(.medium)
                .tip("Put it back in the inbox")
        }
        .font(.system(size: TypeScale.label))
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(7))
        .background {
            shape
                .fill(.regularMaterial)
                .shadow(color: .black.opacity(dark ? 0.4 : 0.12), radius: zoomed(10), y: zoomed(3))
        }
        .overlay(shape.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        .onHover { hovering = $0 }
        .padding(.top, zoomed(10))
    }
}

/// Floats where `ArchivedToast` does when Next Inbox Thread (⌥⌘↓) has
/// nowhere to go: past the Inbox's last thread, or with nothing in it.
/// A click takes it down; otherwise it goes after a few seconds.
private struct InboxEndToast: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false

    static let shownFor: Duration = .seconds(3)

    var body: some View {
        ZStack {
            if let note = app.inboxEndNote {
                toast(note)
                    .id(note.id)
                    .transition(Juice.reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .task(id: note.id) {
                        try? await Task.sleep(for: Self.shownFor)
                        while hovering, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(300)) }
                        guard !Task.isCancelled else { return }
                        app.dismissInboxEndNote(note.id)
                    }
            }
        }
        .animation(Juice.reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.3), value: app.inboxEndNote?.id)
    }

    private func toast(_ note: InboxEndNote) -> some View {
        let dark = colorScheme == .dark
        let shape = Capsule(style: .continuous)
        return Button { app.dismissInboxEndNote(note.id) } label: {
            HStack(spacing: zoomed(7)) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(note.empty ? "Inbox clear" : "That's the end of the inbox")
                Text(note.empty ? "Nothing's waiting on you" : "You're all caught up").foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tip("Dismiss")
        .font(.system(size: TypeScale.label))
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(7))
        .background {
            shape
                .fill(.regularMaterial)
                .shadow(color: .black.opacity(dark ? 0.4 : 0.12), radius: zoomed(10), y: zoomed(3))
        }
        .overlay(shape.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        .onHover { hovering = $0 }
        .padding(.top, zoomed(10))
    }
}

/// Floats where `ArchivedToast` does, once, when the thread count passes a
/// milestone (`ThreadMilestones`), with the little bear waving. A click takes
/// it down; otherwise it goes after a few seconds, once he's seen to be there.
private struct MilestoneToast: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false
    @State private var waves = 0

    static let shownFor: Duration = .seconds(5)

    var body: some View {
        ZStack {
            if let note = app.milestoneNote {
                toast(note)
                    .id(note.id)
                    .transition(Juice.reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .onAppear { if !Juice.reduceMotion { waves += 1 } }
                    .task(id: note.id) {
                        try? await Task.sleep(for: Self.shownFor)
                        // It's rare, and he may have stepped away just as it
                        // came: it stays until he's back.
                        while hovering || MilestoneWatch.secondsIdle() > 5, !Task.isCancelled {
                            try? await Task.sleep(for: .milliseconds(300))
                        }
                        guard !Task.isCancelled else { return }
                        app.dismissMilestoneNote(note.id)
                    }
            }
        }
        .animation(Juice.reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.3), value: app.milestoneNote?.id)
    }

    private func toast(_ note: MilestoneNote) -> some View {
        let dark = colorScheme == .dark
        let shape = Capsule(style: .continuous)
        return Button { app.dismissMilestoneNote(note.id) } label: {
            HStack(spacing: zoomed(7)) {
                Image(nsImage: Bear.image(.wave, side: zoomed(17)))
                    .renderingMode(.template)
                    // InboxZero's wave: a beat, then tilts from its feet.
                    .keyframeAnimator(initialValue: 0.0, trigger: waves) { bear, angle in
                        bear.rotationEffect(.degrees(angle), anchor: .bottom)
                    } keyframes: { _ in
                        KeyframeTrack {
                            CubicKeyframe(0, duration: 0.25)
                            CubicKeyframe(-9, duration: 0.14)
                            CubicKeyframe(7, duration: 0.16)
                            CubicKeyframe(-5, duration: 0.14)
                            CubicKeyframe(0, duration: 0.2)
                        }
                    }
                    .accessibilityHidden(true)
                Text(ThreadMilestones.title(note.tier))
                Text(ThreadMilestones.line(note.tier)).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .tip("Dismiss")
        .font(.system(size: TypeScale.label))
        .padding(.leading, zoomed(11))
        .padding(.trailing, zoomed(14))
        .padding(.vertical, zoomed(7))
        .background {
            shape
                .fill(.regularMaterial)
                .shadow(color: .black.opacity(dark ? 0.4 : 0.12), radius: zoomed(10), y: zoomed(3))
        }
        .overlay(shape.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        .onHover { hovering = $0 }
        .padding(.top, zoomed(10))
    }
}

/// The thread panel's title line, in its bar: the thread's, the project's,
/// or nothing over the Projects page (the selected thread isn't what's
/// showing there).
struct ThreadHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if let project = app.openProject {
                ProjectHeaderTitle(project: project)
            } else {
                HeaderTitle(thread: app.showsHomePage ? nil : app.selectedThread)
            }
        }
    }
}

/// The thread panel's ... menu, at the end of its bar. Out of sight with
/// nothing to act on: a dimmed "..." alone over an empty new thread looked
/// broken.
struct ThreadMenuButton: View {
    @Environment(AppModel.self) private var app
    /// For a thread open in a panel of its own; nil for the main panel's.
    var pinned: String? = nil

    var body: some View {
        let project = pinned == nil ? app.openProject : nil
        let thread = pinned.map { app.threads[$0] } ?? app.selectedThread
        let homePage = project == nil && pinned == nil && app.showsHomePage
        let session = (pinned ?? app.selection).map { app.session(for: $0) }
        let hasMenu = (thread != nil && !homePage) || project != nil
        IconMenu {
            if let project {
                ProjectMenu(project: project)
            } else if let thread, !homePage {
                ThreadMenu(thread: thread)
                Divider()
                Button("Copy transcript as Markdown", systemImage: "doc.plaintext") { session?.copyTranscript() }
                    .disabled(app.isBusy(BusyKey.copying(thread.id)))
                // So Mike can point an agent at this thread (`tb show <id>`).
                Button("Copy thread id", systemImage: "number") { app.copyToPasteboard(thread.id) }
                // Only while there's a website to go to, as with the share
                // button beside this menu. No copy-link or share items here:
                // the share button sits right beside this menu, and the web
                // page has its own Copy link and share controls.
                if let link = app.threadWebLink(thread.id) {
                    Button("Open on the web", systemImage: "safari") { OpenGate.openWeb(link) }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: TypeScale.label, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: zoomed(26), height: zoomed(26))
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .tip("More")
        .disabled(!hasMenu)
        .opacity(hasMenu ? 1 : 0)
    }
}

/// One line: the thread's projects as icons (a folder glyph when it's in
/// none), its title, which a click renames, and "Archived" and the like
/// after. The folder is in the icon's tooltip; the slash and folder name
/// that used to lead read as clutter.
struct HeaderTitle: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary?

    var body: some View {
        if let thread {
            HStack(spacing: zoomed(6)) {
                if app.projectsSupported, !thread.projects.isEmpty {
                    HStack(spacing: zoomed(3)) {
                        ForEach(thread.projects) { membership in
                            ProjectIconButton(thread: thread, membership: membership)
                        }
                    }
                    .layoutPriority(1)
                } else if let place = app.runnerPlace(of: thread) {
                    // Another runner's thread: its Mac, where the folder would be.
                    Image(systemName: app.runnerIcon(of: thread))
                        .font(.system(size: TypeScale.detail))
                        .foregroundStyle(.secondary)
                        .tip("\(place), in \(thread.cwd.abbreviatingHome)")
                        .layoutPriority(1)
                } else {
                    Image(systemName: "folder")
                        .font(.system(size: TypeScale.detail))
                        .foregroundStyle(.secondary)
                        .tip("In \(thread.cwd.abbreviatingHome)")
                        .layoutPriority(1)
                }
                ThreadTitleField(thread: thread)
                if thread.isArchived {
                    // A quiet word here rather than a full-width band under
                    // the header, which nothing else in the window had.
                    // Unarchive is in the ... menu, ⌘E and the row's hover
                    // button.
                    Text("·  Archived").foregroundStyle(Color(nsColor: Theme.faintText)).layoutPriority(1)
                }
                if thread.onOldRunner {
                    // A handover (protocol "Handovers"): this turn began
                    // before the runner updated, so a fix just merged isn't
                    // in it yet. The flag goes when the turn ends.
                    Text("·  Finishing on the previous version")
                        .foregroundStyle(Color(nsColor: Theme.faintText))
                        .layoutPriority(1)
                        .tip("This turn started before the runner updated, so it runs on the previous version. The thread moves to the new one when the turn ends.")
                }
                if let worktree = thread.worktree {
                    // Its own worktree (protocol "Worktrees"): the branch,
                    // quietly.
                    Text("·  \(worktree.branch)")
                        .foregroundStyle(Color(nsColor: Theme.faintText))
                        .layoutPriority(1)
                        .tip("Works on its own branch in a worktree. tb land, or the Land chip, puts it on main in \(worktree.mainCheckout.abbreviatingHome).")
                }
                if let origin = thread.schedule {
                    ScheduleChip(origin: origin)
                        .padding(.leading, zoomed(4))
                        .layoutPriority(1)
                }
            }
            .font(.system(size: TypeScale.header))
            .lineLimit(1)
            .padding(.leading, zoomed(6))
        } else {
            Color.clear.frame(width: 1, height: 1)
        }
    }
}

/// The title in the header, which turns into a field on a click. Return or
/// clicking away saves, Escape puts it back. A name given here is Mike's,
/// so the runner won't let a model or an agent rename it after.
private struct ThreadTitleField: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    @State private var draft = ""
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var editing: Bool { app.renamingThread == thread.id }

    var body: some View {
        if editing {
            TextField("Title", text: $draft, prompt: Text("Thread title"))
                .labelsHidden()
                .textFieldStyle(.plain)
                .fontWeight(.semibold)
                .focused($focused)
                .frame(minWidth: zoomed(160))
                .onSubmit { finish(save: true) }
                .onExitCommand { finish(save: false) }
                .onChange(of: focused) { _, now in
                    if !now { finish(save: true) }
                }
                .onAppear {
                    draft = thread.title
                    focused = true
                }
                .tip("Return saves, Escape cancels")
        } else {
            Text(thread.title.isEmpty ? "Untitled" : thread.title)
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
                .padding(.horizontal, zoomed(4))
                .padding(.vertical, zoomed(1))
                .background(Color.primary.opacity(hovering ? 0.06 : 0), in: RoundedRectangle(cornerRadius: zoomed(5), style: .continuous))
                .padding(.horizontal, zoomed(-4))
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .onTapGesture { app.startRenaming(thread.id) }
                .tip("Click to rename")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction(named: "Rename") { app.startRenaming(thread.id) }
        }
    }

    private func finish(save: Bool) {
        guard editing else { return }
        app.renamingThread = nil
        if save { app.rename(thread.id, to: draft) }
    }
}

/// "Projects / Threadbear" while a project's page is open.
struct ProjectHeaderTitle: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        HStack(spacing: zoomed(5)) {
            Button("Projects") { app.showProjects() }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .tip("Show the Projects view")
                .layoutPriority(1)
            Text("/")
                .foregroundStyle(Color(nsColor: Theme.faintText))
                .layoutPriority(1)
            ProjectIconView(project: project, size: 14)
                .accessibilityHidden(true)
                .layoutPriority(1)
            Text(project.title)
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
            if project.archived {
                Text("·  Archived").foregroundStyle(Color(nsColor: Theme.faintText)).layoutPriority(1)
            }
        }
        .font(.system(size: TypeScale.header))
        .lineLimit(1)
        .padding(.leading, zoomed(6))
    }
}

/// "Scheduled" after the title of a thread a schedule started, as a chip
/// like the projects'. A click opens the schedule's editor while the
/// schedule's still there.
private struct ScheduleChip: View {
    @Environment(AppModel.self) private var app
    let origin: ThreadSchedule
    @State private var hovering = false

    var body: some View {
        let current = app.schedule(origin.id)
        Button { app.editSchedule(origin.id) } label: {
            HStack(spacing: zoomed(4)) {
                Image(systemName: "clock")
                    .accessibilityHidden(true)
                Text("Scheduled")
            }
            .font(.system(size: TypeScale.detail))
            .foregroundStyle(hovering && current != nil ? .primary : .secondary)
            .padding(.leading, zoomed(5))
            .padding(.trailing, zoomed(7))
            .padding(.vertical, zoomed(2))
            .background(Color.primary.opacity(hovering && current != nil ? 0.08 : 0.05), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(current == nil)
        .onHover { hovering = $0 }
        .tip(StartedBySchedule.tip(origin, current: current))
    }
}

/// One of the thread's projects, as its icon before the title. A click opens
/// the project's page; the context menu takes the thread out, keeps it there
/// (for one the librarian put it in), or adds it to another. A dashed ring
/// is the librarian's guess that no one has confirmed yet.
private struct ProjectIconButton: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    let membership: ThreadProject
    @State private var hovering = false

    private var guessed: Bool { membership.by == .librarian && !membership.pinned }
    private var title: String { app.project(membership.id)?.title ?? membership.title }

    var body: some View {
        Button { app.openProjectPage(membership.id) } label: {
            ProjectIconView(project: app.project(membership.id), title: title, size: 16)
                .accessibilityLabel(title)
                .padding(zoomed(2))
                .background(Color.primary.opacity(hovering ? 0.08 : 0), in: RoundedRectangle(cornerRadius: zoomed(5), style: .continuous))
                .overlay {
                    if guessed {
                        RoundedRectangle(cornerRadius: zoomed(5), style: .continuous)
                            .strokeBorder(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 0.75, dash: [2.5, 2]))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip(guessed ? "The librarian put this thread in \(title). Right-click to keep it there or take it out. In \(thread.cwd.abbreviatingHome)" : "\(title), in \(thread.cwd.abbreviatingHome). Click to open the project")
        .iconContextMenu {
            Button("Open \(title)", systemImage: "arrow.right.circle") { app.openProjectPage(membership.id) }
            Divider()
            if !membership.pinned {
                Button("Keep it in \(title)", systemImage: "pin") { app.setProjects(thread.id, add: [membership.id]) }
            }
            Button("Take it out of \(title)", systemImage: "minus.circle") { app.setProjects(thread.id, remove: [membership.id]) }
            let others = app.projectsToAdd(thread)
            if !others.isEmpty {
                IconMenu("Add to another project", systemImage: "plus.square.on.square") {
                    ForEach(others) { project in
                        Button(project.title, systemImage: "square.stack") { app.setProjects(thread.id, add: [project.id]) }
                    }
                }
            }
        }
    }
}

enum PaneRole: LayoutValueKey {
    static let defaultValue = Role.transcript

    enum Role {
        case transcript, composer, heading, note
    }
}

/// Lays out the pane under the banners: the transcript, then the composer
/// at the bottom. For a new thread the composer sits about 40% of the way
/// down instead, with a heading above it and where the thread will start
/// below it, as Codex and Claude do.
///
/// One layout for both, rather than two views, so the composer is the same
/// view (and keeps its text view and its focus) when the first message
/// creates the thread and it drops to the bottom. The transcript's frame is
/// the same either way, so showing that first thread doesn't resize it.
struct ComposerPlacement: Layout {
    var centred: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        func find(_ role: PaneRole.Role) -> LayoutSubview? { subviews.first { $0[PaneRole.self] == role } }
        let width = ProposedViewSize(width: bounds.width, height: nil)
        // The whole pane either way: the transcript's scroller is an
        // overlay, so its reading column is centred in the pane too.
        let composerWidth = bounds.width
        let composerHeight = find(.composer)?.sizeThatFits(ProposedViewSize(width: composerWidth, height: nil)).height ?? 0
        let transcriptHeight = max(0, bounds.height - composerHeight)
        find(.transcript)?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: transcriptHeight))

        let heading = centred ? find(.heading) : nil
        let note = centred ? find(.note) : nil
        let composerY = bounds.minY + ComposerPlacementMath.composerTop(
            paneHeight: bounds.height, composerHeight: composerHeight, centred: centred,
            headingHeight: Double(heading?.sizeThatFits(width).height ?? 0), noteHeight: Double(note?.sizeThatFits(width).height ?? 0)
        )
        heading?.place(at: CGPoint(x: bounds.minX, y: composerY - zoomed(18)), anchor: .bottomLeading, proposal: width)
        note?.place(at: CGPoint(x: bounds.minX, y: composerY + composerHeight - zoomed(2)), proposal: width)
        // Centred in its width: the composer caps its own width.
        find(.composer)?.place(
            at: CGPoint(x: bounds.minX + composerWidth / 2, y: composerY), anchor: .top,
            proposal: ProposedViewSize(width: composerWidth, height: composerHeight)
        )
    }
}

private struct NewThreadHeading: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let typing = !(app.drafts["new"]?.text.isEmpty ?? true)
        Text("What should we work on?")
            .font(.system(size: zoomed(24), weight: .semibold))
            .foregroundStyle(.primary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, zoomed(24))
            .frame(maxWidth: .infinity)
            // Over the heading rather than in the layout, so nothing moves
            // to make room for it.
            .overlay(alignment: .top) {
                if app.inboxZeroBear == .shown, !InboxZero.isBedtime(BearGeometry.date()) {
                    PaneBear()
                        .offset(y: -(PaneBear.side + zoomed(12)))
                        .transition(.opacity)
                }
            }
            .onChange(of: typing) { _, typing in
                if typing { withAnimation(.easeOut(duration: 0.15)) { app.inboxZeroBear = nil } }
            }
            .onDisappear { app.inboxZeroBear = nil }
    }
}

/// "Starts in misc on bearworks": the folder and account the composer's
/// menus are set to (with pools, "on the Claude pool", or the login a
/// pinned draft is on). Then each login as a card with the room it has
/// left: the pool's logins, or every one when the draft isn't in a pool.
/// A click pins the draft to that login, like the picker's "Pin to a
/// login".
private struct NewThreadNote: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        // This Mac's logins, or the chosen runner's for a thread on it.
        let logins = app.draftLogins
        let runner = app.newThreadRunner
        let cwd = app.newThreadCwd ?? logins.defaults.cwd
        let account = app.newThreadAccountId
        let pool = app.newThreadPoolId.flatMap(logins.pool)
        let on = pool.map { "the \($0.title) pool" }
            ?? (app.newThreadUsesPools ? AccountName.login(account, accounts: logins.accounts) : AccountName.short(account, accounts: logins.accounts))
        let title = logins.account(account).map(AccountName.title) ?? account
        VStack(spacing: zoomed(14)) {
            if let runner, app.newThreadLogins == nil {
                // Its logins and folders come with its hello.
                Text("Starts on \(runner.name)")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            } else if let runner {
                Text("Starts in \(FolderName.short(cwd)) on \(runner.name), with \(on)")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
                    .tip("\(cwd) on \(runner.name), with " + (pool.map { "the \($0.title) pool, which picks the login" } ?? title))
            } else {
                Text("Starts in \(FolderName.short(cwd)) on \(on)")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(Color(nsColor: Theme.faintText))
                    .tip("\(cwd.abbreviatingHome) on " + (pool.map { "the \($0.title) pool, which picks the login" } ?? title))
            }
            // Only once there's something to compare: an older runner sends
            // no usage, and one account has nothing to choose between.
            let accounts = UsageGroups.byProvider(logins.accounts).flatMap(\.accounts)
                .filter { item in pool.map { $0.accountIds.contains(item.id) } ?? true }
            if accounts.count > 1, accounts.contains(where: { $0.usage != nil }) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: zoomed(140), maximum: zoomed(200)), spacing: zoomed(8), alignment: .top)], spacing: zoomed(8)) {
                    ForEach(accounts) { item in
                        // In a pool none is ringed: the pool picks. A click pins.
                        AccountRoomCard(account: item, accounts: logins.accounts, selected: pool == nil && item.id == account, now: app.now) {
                            app.newThreadPool = nil
                            app.newThreadProvider = nil
                            app.newThreadAccount = item.id
                        }
                    }
                }
                .frame(maxWidth: Theme.maxContentWidth)
                .padding(.horizontal, zoomed(24))
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// One account on the new-thread page: its name (the domain when two
/// share the part before the @), a bar of the
/// tighter window, and "5h 89% · week 78% left".
private struct AccountRoomCard: View {
    let account: Account
    let accounts: [Account]
    let selected: Bool
    let now: Date
    let pick: () -> Void
    @State private var hovering = false

    var body: some View {
        let usage = account.usage
        let tight = AccountUsageText.tightest(usage)
        Button(action: pick) {
            VStack(alignment: .leading, spacing: zoomed(5)) {
                // The note ("Convex work only") beside the name rather than
                // under it, so every card is the same height.
                HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                    Text(AccountName.label(account.id, accounts: accounts))
                        .font(.system(size: zoomed(12), weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let note = account.note, !note.isEmpty {
                        Text(note).font(.system(size: zoomed(11))).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    GeometryReader { geometry in
                        Capsule().fill(fill(usage, tight))
                            .frame(width: max(0, geometry.size.width * (tight?.remainingPercent ?? 0) / 100))
                    }
                }
                .frame(height: zoomed(3))
                Text(AccountUsageText.roomLine(usage) ?? "Nothing known yet")
                    .font(.system(size: zoomed(11)))
                    .monospacedDigit()
                    .foregroundStyle(usage?.blocked == true ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .padding(.horizontal, zoomed(10))
            .padding(.vertical, zoomed(8))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(selected ? 0.07 : hovering ? 0.05 : 0.025), in: RoundedRectangle(cornerRadius: zoomed(8)))
            .overlay {
                RoundedRectangle(cornerRadius: zoomed(8))
                    .strokeBorder(selected ? Color.accentColor.opacity(0.7) : Color.primary.opacity(0.06), lineWidth: selected ? 1 : 0.5)
            }
            .contentShape(RoundedRectangle(cornerRadius: zoomed(8)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip(AccountUsageText.tooltip(account, fallback: AccountName.title(account), now: now))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The same colours as the usage popover: grey with room, orange under
    /// a quarter, red at the limit.
    private func fill(_ usage: AccountUsage?, _ tight: UsageWindow?) -> Color {
        guard let tight else { return .clear }
        if usage?.blocked == true || tight.remainingPercent < 1 { return .red }
        if tight.remainingPercent < AccountUsageText.chipWarning { return .orange }
        return Color.primary.opacity(0.4)
    }
}

struct ConnectionBanner: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let banner = app.banner {
            switch banner.style {
            case .quiet: quiet(banner)
            case .warning: warning(banner)
            }
        }
    }

    /// A runner restart: grey words on the window's own background with a
    /// hairline under them, so it reads as information, not a problem.
    private func quiet(_ banner: Banner) -> some View {
        HStack(spacing: zoomed(8)) {
            if let icon = banner.icon {
                Image(systemName: icon).foregroundStyle(.secondary)
            } else {
                SpinnerMark(color: .secondaryLabelColor).frame(width: zoomed(13), height: zoomed(13))
            }
            Text(banner.text).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 0)
            if let key = banner.dismissKey {
                Button("Dismiss") { app.dismissCliFailure(key) }
                    .buttonStyle(.borderless)
                    .tip("Hide this until it happens again")
            }
        }
        .font(.system(size: TypeScale.label))
        .tip(banner.detail ?? "")
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(7))
        .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: Theme.hairline)).frame(height: 0.5) }
    }

    private func warning(_ banner: Banner) -> some View {
        HStack(spacing: zoomed(8)) {
            Image(systemName: banner.icon ?? "bolt.horizontal").foregroundStyle(.secondary)
            Text(banner.text).lineLimit(2).tip(banner.detail ?? "")
            Spacer()
            if banner.showStart {
                Button("Start runner") { app.startRunner() }
                    .busy(app.isBusy(BusyKey.startRunner))
                    .tip("Start the runner's background service")
            }
            if banner.showRetry {
                Button("Try again") { app.reconnectNow() }
                    .tip("Try to reach the runner now rather than waiting")
            }
        }
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(8))
        .background(.yellow.opacity(0.12))
    }
}

/// The open thread's account is at its limit (or its last turn failed on
/// it): says so, with a button to move the thread to the account with the
/// most room. Here rather than in the transcript's error row, whose drawing
/// is cached and knows nothing of accounts, so the name and the room it
/// offers stay current as usage changes.
struct LimitBanner: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary

    var body: some View {
        if let advice = app.limitAdvice(for: thread) {
            // A pool thread waiting for room carries on by itself: a quiet
            // clock rather than the red limit gauge, and the button pins it
            // to a login outside the pool, so it says so.
            let waiting = thread.waitingForRoom != nil && app.usesPools
            HStack(spacing: zoomed(8)) {
                if waiting {
                    Image(systemName: "clock").foregroundStyle(.secondary)
                } else {
                    Image(systemName: "gauge.with.dots.needle.100percent").foregroundStyle(.red)
                }
                Text(advice.text).lineLimit(1).tip(advice.text)
                Spacer(minLength: zoomed(6))
                if let target = advice.target {
                    let title = AccountUsageText.switchTitle(target, accounts: app.accounts)
                    Button(waiting ? title.replacingOccurrences(of: "Switch to", with: "Pin to") : title) {
                        app.switchAccount(thread.id, to: target.id)
                    }
                    .busy(app.isBusy(BusyKey.moving(thread.id)))
                    .tip("Carry on this thread on that account, from where it is")
                }
            }
            .font(.system(size: TypeScale.label))
            .padding(.horizontal, zoomed(14))
            .padding(.vertical, zoomed(7))
            .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: Theme.hairline)).frame(height: 0.5) }
        }
    }
}

/// The open thread's last turn failed because its login was refused:
/// says so, with Sign in… (Terminal, on the CLI's own sign-in) and Send
/// again for once that's done. Like LimitBanner, here rather than in the
/// cached error row, which knows nothing of accounts.
struct SignInBanner: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary

    var body: some View {
        if let account = app.signInAccount(for: thread) {
            let name = account.provider == "codex" ? "Codex" : "Claude"
            HStack(spacing: zoomed(8)) {
                Image(systemName: "person.crop.circle.badge.exclamationmark").foregroundStyle(.orange)
                Text("\(name) needs you to sign in again.").lineLimit(1)
                    .tip("The login \(account.title) was refused: signed out, or its session ran out")
                Spacer(minLength: zoomed(6))
                Button("Sign in…") { app.signIn(account) }
                    .tip("Opens Terminal on \(name)'s own sign-in for this login")
                Button("Send again") { app.sendAgain(thread.id) }
                    .tip("Send your last message again, once you've signed in")
            }
            .font(.system(size: TypeScale.label))
            .padding(.horizontal, zoomed(14))
            .padding(.vertical, zoomed(7))
            .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: Theme.hairline)).frame(height: 0.5) }
        } else if let runner = app.remoteSignInRunner(for: thread) {
            // Another Mac's login: signed in on that Mac, not from here.
            let name = thread.provider == "codex" ? "Codex" : "Claude"
            HStack(spacing: zoomed(8)) {
                Image(systemName: "person.crop.circle.badge.exclamationmark").foregroundStyle(.orange)
                Text("\(name) on \(runner) needs you to sign in again.").lineLimit(1)
                    .tip("Sign in on \(runner) itself: \(name == "Codex" ? "codex login" : "claude auth login") in its Terminal")
                Spacer(minLength: zoomed(6))
                Button("Send again") { app.sendAgain(thread.id) }
                    .tip("Send your last message again, once you've signed in")
            }
            .font(.system(size: TypeScale.label))
            .padding(.horizontal, zoomed(14))
            .padding(.vertical, zoomed(7))
            .overlay(alignment: .bottom) { Rectangle().fill(Color(nsColor: Theme.hairline)).frame(height: 0.5) }
        }
    }
}

private struct ErrorBanner: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let message = app.errorMessage {
            HStack {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(message).lineLimit(2).tip(message)
                Spacer()
                if app.ownCheckout != nil {
                    // Spins until the thread is made (it can take a second),
                    // so it can't be pressed twice.
                    if app.creatingThread {
                        SpinnerMark(color: .secondaryLabelColor).frame(width: zoomed(13), height: zoomed(13))
                            .tip("Starting a thread to look into it")
                    }
                    Button("Investigate") { app.investigateError() }
                        .buttonStyle(.borderless)
                        .disabled(app.creatingThread)
                        .tip("Start a thread in Threadbear's own repo to find what caused this and fix it")
                }
                Button("Dismiss") { app.errorMessage = nil }
                    .buttonStyle(.borderless)
                    .tip("Hide this message")
            }
            .padding(.horizontal, zoomed(14))
            .padding(.vertical, zoomed(7))
            .background(.orange.opacity(0.1))
        }
    }
}
